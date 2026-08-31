import { stringifyCardCode } from "@pokertools/evaluator";
import { GAME_CONFIG } from "../../../config.js";
import {
  act as playAction,
  emptyGame,
  leaveGame,
  legalActions,
  refillTable,
  seatPlayer,
  shuffledDeck,
  startMatch,
  startNextHand,
  timeout as timeoutPlayer,
  type GameAction,
  type GameEvent,
  type GameState,
  type WaitingPlayer,
} from "./game.js";
import { DomainError } from "../../domain-error.js";

type StateRow = { table_id: string; state_json: string };
type EventRow = {
  id: number;
  hand_number: number | null;
  kind: string;
  decision_id: string | null;
  payload: ArrayBuffer;
  created_at: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TableData {
  status: GameState["status"];
  capacity: number;
  handNumber: number;
  street: GameState["street"];
  pot: number;
  currentBet: number;
  dealerSeat: number;
  actingSeat: number;
  actingAgentId: string;
  decisionId: string;
  decisionDeadline: number;
  communityCards: Array<{ rank: string; suit: string }>;
  viewerHoleCards: Array<{ rank: string; suit: string }>;
  players: Array<{
    agentId: string;
    displayName: string;
    seat: number;
    stack: number;
    streetBet: number;
    totalBet: number;
    folded: boolean;
    allIn: boolean;
    revealedCards: Array<{ rank: string; suit: string }>;
    lifetimeScore: number;
  }>;
  legalActions?: {
    actions: GameAction[];
    callAmount: number;
    minRaiseTo: number;
    maxRaiseTo: number;
  };
  latestEventSeq: number;
  result: string;
  queueSize: number;
  viewerSeated: boolean;
  viewerQueuePosition: number;
}

export interface EventData {
  scope: "TABLE";
  seq: number;
  tableId: string;
  handNumber: number;
  kind: string;
  agentId: string;
  message: string;
  createdAt: number;
}

export const LOBBY_CHANGED_EVENT = { scope: "LOBBY", kind: "CHANGED" } as const;
export type BroadcastEventData = EventData | typeof LOBBY_CHANGED_EVENT;

export class TexasHoldemService {
  constructor(private readonly storage: DurableObjectStorage) {}

  createTable(tableId: string, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO table_states
       (table_id, state_version, state_json, next_wake_at, created_at, updated_at)
       VALUES (?, 0, ?, NULL, ?, ?)`,
      tableId,
      JSON.stringify(emptyGame()),
      now,
      now,
    );
  }

  joinTable(tableId: string, player: WaitingPlayer): { table: TableData; events: EventData[]; queued: boolean } {
    const state = this.requireState(tableId);
    if (player.stack <= 0) {
      throw new DomainError("FAILED_PRECONDITION", "Score must be greater than zero to join");
    }
    if (state.players.some((candidate) => candidate.agentId === player.agentId)) {
      return { table: this.tableView(state, player.agentId), events: [], queued: false };
    }
    if (state.waitingPlayers.some((candidate) => candidate.agentId === player.agentId)) {
      return { table: this.tableView(state, player.agentId), events: [], queued: true };
    }

    const drafts: GameEvent[] = [];
    if (state.status !== "WAITING" || state.players.length >= GAME_CONFIG.playerCount) {
      if (state.waitingPlayers.length >= GAME_CONFIG.maxQueueSize) {
        throw new DomainError("RESOURCE_EXHAUSTED", "Waiting queue is full");
      }
      state.waitingPlayers.push(player);
      drafts.push({
        kind: "PLAYER_QUEUED",
        agentId: player.agentId,
        message: `${player.displayName} joined the waiting queue.`,
      });
    } else {
      const seat = Array.from({ length: GAME_CONFIG.playerCount }, (_, candidate) => candidate)
        .find((candidate) => !state.players.some((seated) => seated.seat === candidate))!;
      state.players.push(seatPlayer(player, seat));
      drafts.push({
        kind: "PLAYER_JOINED",
        agentId: player.agentId,
        message: `${player.displayName} joined seat ${seat}.`,
      });
      if (state.players.length === GAME_CONFIG.playerCount) {
        const started = state.handNumber === 0
          ? startMatch(state.players, shuffledDeck(), Date.now(), crypto.randomUUID())
          : startNextHand(state, shuffledDeck(), Date.now(), crypto.randomUUID());
        started.state.eventSeq = state.eventSeq;
        started.state.waitingPlayers = state.waitingPlayers;
        Object.assign(state, started.state);
        drafts.push(...started.events);
      }
    }
    const events = this.save(tableId, state, drafts);
    return {
      table: this.tableView(state, player.agentId),
      events,
      queued: state.waitingPlayers.some((candidate) => candidate.agentId === player.agentId),
    };
  }

  leaveTable(tableId: string, agentId: string, displayName: string): {
    table: TableData;
    events: EventData[];
    released: boolean;
  } {
    const state = this.requireState(tableId);
    const queued = state.waitingPlayers.findIndex((candidate) => candidate.agentId === agentId);
    if (queued >= 0) {
      state.waitingPlayers.splice(queued, 1);
      const events = this.save(tableId, state, [{
        kind: "PLAYER_LEFT_QUEUE",
        agentId,
        message: `${displayName} left the waiting queue.`,
      }]);
      return { table: this.tableView(state, agentId), events, released: true };
    }

    const seated = state.players.find((candidate) => candidate.agentId === agentId);
    if (!seated) throw new DomainError("NOT_FOUND", "Player is not at this table");
    if (state.status === "PLAYING") {
      const result = leaveGame(state, agentId, Date.now(), crypto.randomUUID());
      const events = this.save(tableId, result.state, result.events);
      return { table: this.tableView(result.state, agentId), events, released: false };
    }
    state.players = state.players.filter((candidate) => candidate.agentId !== agentId);
    const events = this.save(tableId, state, [{
      kind: "PLAYER_LEFT",
      agentId,
      message: `${displayName} left seat ${seated.seat}.`,
    }]);
    return { table: this.tableView(state, agentId), events, released: true };
  }

  act(
    tableId: string,
    agentId: string,
    decisionId: string,
    action: GameAction,
    amount: number,
    reason: string,
  ): { table: TableData; events: EventData[] } {
    if (reason.length > 2_000) throw new DomainError("INVALID_ARGUMENT", "Reason is too long");
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new DomainError("INVALID_ARGUMENT", "Amount must be a non-negative integer");
    }
    const state = this.requireState(tableId);
    const acting = state.players.find((candidate) => candidate.seat === state.decision?.seat);
    if (!acting || acting.agentId !== agentId) {
      throw new DomainError("PERMISSION_DENIED", "It is not this player's turn");
    }
    let played;
    try {
      played = playAction(state, decisionId, action, amount, Date.now(), crypto.randomUUID());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new DomainError(
        message.includes("expired") ? "DEADLINE_EXCEEDED" : "FAILED_PRECONDITION",
        message,
      );
    }
    this.recordParticipation(tableId, agentId, played.state.handNumber, "DECISION_ACTED", decisionId, {
      action,
      amount,
      reason,
    });
    const events = this.save(tableId, played.state, played.events);
    return { table: this.tableView(played.state, agentId), events };
  }

  chat(tableId: string, agentId: string, displayName: string, text: string): EventData[] {
    const message = text.trim();
    if (message.length === 0 || [...message].length > 280) {
      throw new DomainError("INVALID_ARGUMENT", "Chat message must contain 1 to 280 characters");
    }
    const now = Date.now();
    const lastChatAt = this.lastChatAt(agentId);
    if (lastChatAt !== undefined && now - lastChatAt < 10_000) {
      throw new DomainError("RESOURCE_EXHAUSTED", "Wait 10 seconds between chat messages");
    }
    const state = this.requireState(tableId);
    if (!state.players.some((candidate) => candidate.agentId === agentId && !candidate.leaving)) {
      throw new DomainError("FAILED_PRECONDITION", "Only seated players can chat");
    }
    return this.save(tableId, state, [{
      kind: "CHAT_MESSAGE",
      agentId,
      message: `${displayName}: ${message}`,
    }]);
  }

  processTimeout(tableId: string, now: number): BroadcastEventData[] {
    const state = this.requireState(tableId);

    // A completed hand remains visible until resumeAt. Once that delay expires,
    // remove players who left or were eliminated and fill open seats from the queue.
    if (state.resumeAt > 0 && state.resumeAt <= now) {
      const refilled = refillTable(state);
      Object.assign(state, refilled.state);
      const drafts = [...refilled.events];

      // Start the next hand immediately when refilling leaves the table at capacity;
      // otherwise persist the waiting table and let a future join start the game.
      if (state.players.length === GAME_CONFIG.playerCount) {
        const started = startNextHand(state, shuffledDeck(), now, crypto.randomUUID());
        Object.assign(state, started.state);
        drafts.push(...started.events);
      }
      const events: BroadcastEventData[] = this.save(tableId, state, drafts);
      if (refilled.events.length > 0) events.push(LOBBY_CHANGED_EVENT);
      return events;
    }

    // Nothing is due when the table has no active decision or its deadline is still ahead.
    if (!state.decision || state.decision.deadline > now) {
      return [];
    }

    // An expired decision is resolved as an automatic fold. Record the timeout in the
    // player's private participation log, then persist and return the resulting table events.
    const decisionId = state.decision.id;
    const acting = state.players.find((candidate) => candidate.seat === state.decision?.seat)!;
    const played = timeoutPlayer(state, now, crypto.randomUUID());
    this.recordParticipation(tableId, acting.agentId, state.handNumber, "DECISION_TIMED_OUT", decisionId, {
      action: "fold",
      consecutiveTimeouts: played.consecutiveTimeouts,
      kicked: played.kicked,
    });
    const events: BroadcastEventData[] = this.save(tableId, played.state, played.events);
    if (played.kicked) events.push(LOBBY_CHANGED_EVENT);
    return events;
  }

  table(tableId: string, viewerAgentId?: string): TableData {
    return this.tableView(this.requireState(tableId), viewerAgentId);
  }

  summaries() {
    return this.states().map(({ tableId, state }) => ({
      tableId,
      table: {
        status: state.status,
        capacity: GAME_CONFIG.playerCount,
        queueSize: state.waitingPlayers.length,
        players: state.players.map((player) => ({
          agentId: player.agentId,
          displayName: player.displayName,
          seat: player.seat,
        })),
      },
    }));
  }

  memberships(tableId: string): Array<{ agentId: string; status: "SEATED" | "QUEUED" }> {
    const state = this.requireState(tableId);
    return [
      ...state.players.filter((player) => !player.leaving)
        .map((player) => ({ agentId: player.agentId, status: "SEATED" as const })),
      ...state.waitingPlayers.map((player) => ({ agentId: player.agentId, status: "QUEUED" as const })),
    ];
  }

  replay(after: number, tableId: string): EventData[] {
    return this.tableEventsAfter(after, tableId)
      .map(({ payload }) => JSON.parse(decoder.decode(payload)) as EventData);
  }

  dueTableIds(now: number): string[] {
    return this.storage.sql.exec<{ table_id: string }>(
      `SELECT table_id FROM table_states
       WHERE next_wake_at IS NOT NULL AND next_wake_at <= ? ORDER BY next_wake_at, id`,
      now,
    ).toArray().map((row) => row.table_id);
  }

  nextWakeAt(): number | undefined {
    return this.storage.sql.exec<{ next_wake_at: number | null }>(
      "SELECT MIN(next_wake_at) AS next_wake_at FROM table_states",
    ).one().next_wake_at ?? undefined;
  }

  private requireState(tableId: string) {
    const row = this.storage.sql.exec<Pick<StateRow, "state_json">>(
      "SELECT state_json FROM table_states WHERE table_id = ?",
      tableId,
    ).toArray()[0];
    if (!row) throw new DomainError("NOT_FOUND", "Table not found");
    return normalizeState(JSON.parse(row.state_json) as GameState);
  }

  private states(): Array<{ tableId: string; state: GameState }> {
    return this.storage.sql.exec<StateRow>(
      "SELECT table_id, state_json FROM table_states ORDER BY id",
    ).toArray().map((row) => ({
      tableId: row.table_id,
      state: normalizeState(JSON.parse(row.state_json) as GameState),
    }));
  }

  private saveState(tableId: string, state: GameState, now: number): void {
    this.storage.sql.exec(
      `UPDATE table_states
       SET state_json = ?, next_wake_at = ?, updated_at = ?
       WHERE table_id = ?`,
      JSON.stringify(state),
      state.decision?.deadline ?? (state.resumeAt || null),
      now,
      tableId,
    );
  }

  private insertEvent(input: {
    scope: "TABLE" | "PLAYER";
    scopeId: string;
    tableId: string;
    agentId?: string;
    handNumber?: number;
    kind: string;
    decisionId?: string;
    payload: Uint8Array;
    now: number;
  }): number {
    return this.storage.sql.exec<{ id: number }>(
      `INSERT INTO game_events
       (scope, scope_id, table_id, agent_id, hand_number, kind, decision_id,
        payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      input.scope,
      input.scopeId,
      input.tableId,
      input.agentId ?? null,
      input.handNumber ?? null,
      input.kind,
      input.decisionId ?? null,
      input.payload,
      input.now,
      input.now,
    ).one().id;
  }

  private updateEvent(id: number, payload: Uint8Array): void {
    this.storage.sql.exec(
      "UPDATE game_events SET payload = ?, updated_at = ? WHERE id = ?",
      payload,
      Date.now(),
      id,
    );
  }

  private tableEventsAfter(after: number, tableId: string): Array<{ seq: number; payload: Uint8Array }> {
    return this.storage.sql.exec<EventRow>(
      `SELECT id, payload FROM game_events
       WHERE id > ? AND scope = 'TABLE' AND table_id = ? ORDER BY id LIMIT 100`,
      after,
      tableId,
    ).toArray().map((row) => ({ seq: row.id, payload: new Uint8Array(row.payload) }));
  }

  private lastChatAt(agentId: string): number | undefined {
    return this.storage.sql.exec<{ created_at: number }>(
      `SELECT created_at FROM game_events
       WHERE kind = 'CHAT_MESSAGE' AND agent_id = ? ORDER BY id DESC LIMIT 1`,
      agentId,
    ).toArray()[0]?.created_at;
  }

  private scores(agentIds: readonly string[]): Map<string, number> {
    if (agentIds.length === 0) return new Map();
    const unique = [...new Set(agentIds)];
    const rows = this.storage.sql.exec<{ agent_id: string; score: number }>(
      `SELECT agent_id, score FROM player_scores
       WHERE agent_id IN (${unique.map(() => "?").join(",")})`,
      ...unique,
    ).toArray();
    return new Map(rows.map((row) => [row.agent_id, row.score]));
  }

  private settle(tableId: string, handNumber: number, deltas: Readonly<Record<string, number>>, now: number): void {
    for (const [agentId, delta] of Object.entries(deltas)) {
      const inserted = this.storage.sql.exec<{ id: number }>(
        `INSERT OR IGNORE INTO score_ledger
         (table_id, hand_number, agent_id, delta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        tableId,
        handNumber,
        agentId,
        delta,
        now,
        now,
      ).toArray()[0];
      if (inserted) {
        this.storage.sql.exec(
          "UPDATE player_scores SET score = score + ?, updated_at = ? WHERE agent_id = ?",
          delta,
          now,
          agentId,
        );
      }
    }
  }

  private tableView(state: GameState, viewerAgentId?: string): TableData {
    return tableView(
      state,
      viewerAgentId,
      this.scores(state.players.map((player) => player.agentId)),
    );
  }

  private save(tableId: string, state: GameState, drafts: GameEvent[]): EventData[] {
    const now = Date.now();
    const pending = drafts.map((draft) => ({
      draft,
      seq: this.insertEvent({
        scope: "TABLE",
        scopeId: tableId,
        tableId,
        agentId: draft.agentId,
        handNumber: state.handNumber,
        kind: draft.kind,
        payload: new Uint8Array(),
        now,
      }),
    }));
    if (pending.length > 0) state.eventSeq = pending.at(-1)!.seq;
    for (const { draft } of pending) {
      if (draft.scoreDeltas) this.settle(tableId, state.handNumber, draft.scoreDeltas, now);
    }
    this.saveState(tableId, state, now);

    const events = pending.map(({ draft, seq }) => ({
      scope: "TABLE" as const,
      seq,
      tableId,
      handNumber: state.handNumber,
      kind: draft.kind,
      agentId: draft.agentId ?? "",
      message: draft.message,
      createdAt: now,
    }));
    for (const event of events) {
      this.updateEvent(event.seq, encoder.encode(JSON.stringify(event)));
    }
    return events;
  }

  private recordParticipation(
    tableId: string,
    agentId: string,
    handNumber: number,
    kind: string,
    decisionId: string,
    detail: object,
  ): void {
    this.insertEvent({
      scope: "PLAYER",
      scopeId: agentId,
      tableId,
      agentId,
      handNumber,
      kind,
      decisionId,
      payload: encoder.encode(JSON.stringify({ type: kind, tableId, handNumber, decisionId, ...detail })),
      now: Date.now(),
    });
  }
}

function normalizeState(state: GameState): GameState {
  state.waitingPlayers ??= [];
  state.resumeAt ??= 0;
  for (const player of state.players) {
    player.leaving ??= false;
    player.consecutiveTimeouts ??= 0;
  }
  return state;
}

function tableView(state: GameState, viewerAgentId: string | undefined, scores: Map<string, number>): TableData {
  const decisionPlayer = state.players.find((player) => player.seat === state.decision?.seat);
  const viewer = state.players.find((player) => player.agentId === viewerAgentId && !player.leaving);
  const viewerCanAct = viewer && state.decision?.seat === viewer.seat;
  const legal = viewerCanAct ? legalActions(state, viewer.seat) : undefined;
  return {
    status: state.status,
    capacity: GAME_CONFIG.playerCount,
    handNumber: state.handNumber,
    street: state.street,
    pot: state.players.reduce((sum, player) => sum + player.totalBet, 0),
    currentBet: state.currentBet,
    dealerSeat: state.dealerSeat,
    actingSeat: state.decision?.seat ?? -1,
    actingAgentId: decisionPlayer?.agentId ?? "",
    decisionId: viewerCanAct ? state.decision?.id ?? "" : "",
    decisionDeadline: state.decision?.deadline ?? 0,
    communityCards: state.community.map(cardData),
    viewerHoleCards: viewer?.hole.map(cardData) ?? [],
    players: state.players.map((player) => ({
      agentId: player.agentId,
      displayName: player.displayName,
      seat: player.seat,
      stack: player.stack,
      streetBet: player.streetBet,
      totalBet: player.totalBet,
      folded: player.folded && player.stack > 0,
      allIn: player.allIn,
      revealedCards: (state.lastRevealed[player.agentId] ?? []).map(cardData),
      lifetimeScore: scores.get(player.agentId) ?? 0,
    })),
    legalActions: legal,
    latestEventSeq: state.eventSeq,
    result: state.result,
    queueSize: state.waitingPlayers.length,
    viewerSeated: Boolean(viewer),
    viewerQueuePosition: viewerAgentId
      ? state.waitingPlayers.findIndex((player) => player.agentId === viewerAgentId) + 1
      : 0,
  };
}

function cardData(code: number) {
  const card = stringifyCardCode(code);
  return { rank: card[0], suit: card[1] };
}
