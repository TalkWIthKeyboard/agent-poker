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
  type GameAction,
  type GameEvent,
  type GameState,
  type WaitingPlayer,
} from "./game.js";
import { DomainError } from "../../domain-error.js";

type StateRow = { room_id: string; state_json: string };
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

export interface RoomData {
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
  seq: number;
  roomId: string;
  handNumber: number;
  kind: string;
  agentId: string;
  message: string;
  createdAt: number;
}

export interface ParticipationData {
  id: number;
  handNumber: number;
  kind: string;
  decisionId: string;
  action?: GameAction;
  amount: number;
  reason: string;
  createdAt: number;
}

export class TexasHoldemService {
  constructor(private readonly storage: DurableObjectStorage) {}

  createRoom(roomId: string, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO room_states
       (room_id, state_version, state_json, next_wake_at, created_at, updated_at)
       VALUES (?, 0, ?, NULL, ?, ?)`,
      roomId,
      JSON.stringify(emptyGame()),
      now,
      now,
    );
  }

  joinRoom(roomId: string, player: WaitingPlayer): { room: RoomData; events: EventData[]; queued: boolean } {
    const state = this.requireState(roomId);
    if (player.stack <= 0) {
      throw new DomainError("FAILED_PRECONDITION", "Score must be greater than zero to join");
    }
    if (state.players.some((candidate) => candidate.agentId === player.agentId)) {
      return { room: this.roomView(state, player.agentId), events: [], queued: false };
    }
    if (state.waitingPlayers.some((candidate) => candidate.agentId === player.agentId)) {
      return { room: this.roomView(state, player.agentId), events: [], queued: true };
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
    const events = this.save(roomId, state, drafts);
    return {
      room: this.roomView(state, player.agentId),
      events,
      queued: state.waitingPlayers.some((candidate) => candidate.agentId === player.agentId),
    };
  }

  leaveRoom(roomId: string, agentId: string, displayName: string): {
    room: RoomData;
    events: EventData[];
    released: boolean;
  } {
    const state = this.requireState(roomId);
    const queued = state.waitingPlayers.findIndex((candidate) => candidate.agentId === agentId);
    if (queued >= 0) {
      state.waitingPlayers.splice(queued, 1);
      const events = this.save(roomId, state, [{
        kind: "PLAYER_LEFT_QUEUE",
        agentId,
        message: `${displayName} left the waiting queue.`,
      }]);
      return { room: this.roomView(state, agentId), events, released: true };
    }

    const seated = state.players.find((candidate) => candidate.agentId === agentId);
    if (!seated) throw new DomainError("NOT_FOUND", "Player is not at this table");
    if (state.status === "PLAYING") {
      const result = leaveGame(state, agentId, Date.now(), crypto.randomUUID());
      const events = this.save(roomId, result.state, result.events);
      return { room: this.roomView(result.state, agentId), events, released: false };
    }
    state.players = state.players.filter((candidate) => candidate.agentId !== agentId);
    const events = this.save(roomId, state, [{
      kind: "PLAYER_LEFT",
      agentId,
      message: `${displayName} left seat ${seated.seat}.`,
    }]);
    return { room: this.roomView(state, agentId), events, released: true };
  }

  act(
    roomId: string,
    agentId: string,
    decisionId: string,
    action: GameAction,
    amount: number,
    reason: string,
  ): { room: RoomData; events: EventData[] } {
    if (reason.length > 2_000) throw new DomainError("INVALID_ARGUMENT", "Reason is too long");
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new DomainError("INVALID_ARGUMENT", "Amount must be a non-negative integer");
    }
    const state = this.requireState(roomId);
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
    this.recordParticipation(roomId, agentId, played.state.handNumber, "DECISION_ACTED", decisionId, {
      action,
      amount,
      reason,
    });
    const events = this.save(roomId, played.state, played.events);
    return { room: this.roomView(played.state, agentId), events };
  }

  chat(roomId: string, agentId: string, displayName: string, text: string): EventData[] {
    const message = text.trim();
    if (message.length === 0 || [...message].length > 280) {
      throw new DomainError("INVALID_ARGUMENT", "Chat message must contain 1 to 280 characters");
    }
    const now = Date.now();
    const lastChatAt = this.lastChatAt(agentId);
    if (lastChatAt !== undefined && now - lastChatAt < 10_000) {
      throw new DomainError("RESOURCE_EXHAUSTED", "Wait 10 seconds between chat messages");
    }
    const state = this.requireState(roomId);
    if (!state.players.some((candidate) => candidate.agentId === agentId && !candidate.leaving)) {
      throw new DomainError("FAILED_PRECONDITION", "Only seated players can chat");
    }
    return this.save(roomId, state, [{
      kind: "CHAT_MESSAGE",
      agentId,
      message: `${displayName}: ${message}`,
    }]);
  }

  processTimeout(roomId: string, now: number): EventData[] {
    const state = this.requireState(roomId);
    if (state.resumeAt > 0 && state.resumeAt <= now) {
      const refilled = refillTable(state);
      Object.assign(state, refilled.state);
      const drafts = [...refilled.events];
      if (state.players.length === GAME_CONFIG.playerCount) {
        const started = startNextHand(state, shuffledDeck(), now, crypto.randomUUID());
        Object.assign(state, started.state);
        drafts.push(...started.events);
      }
      return this.save(roomId, state, drafts);
    }
    if (!state.decision || state.decision.deadline > now) return [];
    const decisionId = state.decision.id;
    const acting = state.players.find((candidate) => candidate.seat === state.decision?.seat)!;
    const played = playAction(state, decisionId, "fold", 0, now, crypto.randomUUID(), true);
    this.recordParticipation(roomId, acting.agentId, state.handNumber, "DECISION_TIMED_OUT", decisionId, {
      action: "fold",
    });
    return this.save(roomId, played.state, played.events);
  }

  room(roomId: string, viewerAgentId?: string): RoomData {
    return this.roomView(this.requireState(roomId), viewerAgentId);
  }

  summaries(): Array<{ roomId: string; room: RoomData }> {
    return this.states().map(({ roomId, state }) => ({
      roomId,
      room: this.roomView(state),
    }));
  }

  memberships(roomId: string): Array<{ agentId: string; status: "SEATED" | "QUEUED" }> {
    const state = this.requireState(roomId);
    return [
      ...state.players.filter((player) => !player.leaving)
        .map((player) => ({ agentId: player.agentId, status: "SEATED" as const })),
      ...state.waitingPlayers.map((player) => ({ agentId: player.agentId, status: "QUEUED" as const })),
    ];
  }

  replay(after: number, roomId: string): EventData[] {
    return this.tableEventsAfter(after, roomId)
      .map(({ payload }) => JSON.parse(decoder.decode(payload)) as EventData);
  }

  participation(agentId: string, before: number, requestedLimit: number): ParticipationData[] {
    const limit = requestedLimit === 0 ? 20 : requestedLimit;
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("INVALID_ARGUMENT", "before_id and limit are invalid");
    }
    return this.playerEvents(agentId, before, limit).map((row) => {
      const detail = JSON.parse(decoder.decode(row.payload)) as {
        action?: GameAction;
        amount?: number;
        reason?: string;
      };
      return {
        id: row.id,
        handNumber: row.hand_number ?? 0,
        kind: row.kind,
        decisionId: row.decision_id ?? "",
        action: detail.action,
        amount: detail.amount ?? 0,
        reason: detail.reason ?? "",
        createdAt: row.created_at,
      };
    });
  }

  dueRoomIds(now: number): string[] {
    return this.storage.sql.exec<{ room_id: string }>(
      `SELECT room_id FROM room_states
       WHERE next_wake_at IS NOT NULL AND next_wake_at <= ? ORDER BY next_wake_at, id`,
      now,
    ).toArray().map((row) => row.room_id);
  }

  nextWakeAt(): number | undefined {
    return this.storage.sql.exec<{ next_wake_at: number | null }>(
      "SELECT MIN(next_wake_at) AS next_wake_at FROM room_states",
    ).one().next_wake_at ?? undefined;
  }

  private requireState(roomId: string) {
    const state = this.state(roomId);
    if (!state) throw new DomainError("NOT_FOUND", "Table not found");
    return state;
  }

  private state(roomId: string): GameState | undefined {
    const row = this.storage.sql.exec<StateRow>(
      "SELECT room_id, state_json FROM room_states WHERE room_id = ?",
      roomId,
    ).toArray()[0];
    return row && normalizeState(JSON.parse(row.state_json) as GameState);
  }

  private states(): Array<{ roomId: string; state: GameState }> {
    return this.storage.sql.exec<StateRow>(
      "SELECT room_id, state_json FROM room_states ORDER BY id",
    ).toArray().map((row) => ({
      roomId: row.room_id,
      state: normalizeState(JSON.parse(row.state_json) as GameState),
    }));
  }

  private saveState(roomId: string, state: GameState, now: number): void {
    this.storage.sql.exec(
      `UPDATE room_states
       SET state_json = ?, next_wake_at = ?, updated_at = ?
       WHERE room_id = ?`,
      JSON.stringify(state),
      state.decision?.deadline ?? (state.resumeAt || null),
      now,
      roomId,
    );
  }

  private insertEvent(input: {
    scope: "TABLE" | "PLAYER";
    scopeId: string;
    roomId: string;
    agentId?: string;
    handNumber?: number;
    kind: string;
    decisionId?: string;
    payload: Uint8Array;
    now: number;
  }): number {
    return this.storage.sql.exec<{ id: number }>(
      `INSERT INTO game_events
       (scope, scope_id, room_id, agent_id, hand_number, kind, decision_id,
        payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      input.scope,
      input.scopeId,
      input.roomId,
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

  private tableEventsAfter(after: number, roomId: string): Array<{ seq: number; payload: Uint8Array }> {
    return this.storage.sql.exec<EventRow>(
      `SELECT id, payload FROM game_events
       WHERE id > ? AND scope = 'TABLE' AND room_id = ? ORDER BY id LIMIT 100`,
      after,
      roomId,
    ).toArray().map((row) => ({ seq: row.id, payload: new Uint8Array(row.payload) }));
  }

  private playerEvents(agentId: string, before: number, limit: number): EventRow[] {
    return this.storage.sql.exec<EventRow>(
      `SELECT id, hand_number, kind, decision_id, payload, created_at FROM game_events
       WHERE scope = 'PLAYER' AND scope_id = ? AND (? = 0 OR id < ?)
       ORDER BY id DESC LIMIT ?`,
      agentId,
      before,
      before,
      limit,
    ).toArray();
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

  private settle(roomId: string, handNumber: number, deltas: Readonly<Record<string, number>>, now: number): void {
    for (const [agentId, delta] of Object.entries(deltas)) {
      const inserted = this.storage.sql.exec<{ id: number }>(
        `INSERT OR IGNORE INTO score_ledger
         (room_id, hand_number, agent_id, delta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        roomId,
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

  private roomView(state: GameState, viewerAgentId?: string): RoomData {
    return roomView(
      state,
      viewerAgentId,
      this.scores(state.players.map((player) => player.agentId)),
    );
  }

  private save(roomId: string, state: GameState, drafts: GameEvent[]): EventData[] {
    const now = Date.now();
    const pending = drafts.map((draft) => ({
      draft,
      seq: this.insertEvent({
        scope: "TABLE",
        scopeId: roomId,
        roomId,
        agentId: draft.agentId,
        handNumber: state.handNumber,
        kind: draft.kind,
        payload: new Uint8Array(),
        now,
      }),
    }));
    if (pending.length > 0) state.eventSeq = pending.at(-1)!.seq;
    for (const { draft } of pending) {
      if (draft.scoreDeltas) this.settle(roomId, state.handNumber, draft.scoreDeltas, now);
    }
    this.saveState(roomId, state, now);

    const events = pending.map(({ draft, seq }) => ({
      seq,
      roomId,
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
    roomId: string,
    agentId: string,
    handNumber: number,
    kind: string,
    decisionId: string,
    detail: object,
  ): void {
    this.insertEvent({
      scope: "PLAYER",
      scopeId: agentId,
      roomId,
      agentId,
      handNumber,
      kind,
      decisionId,
      payload: encoder.encode(JSON.stringify({ type: kind, roomId, handNumber, decisionId, ...detail })),
      now: Date.now(),
    });
  }
}

function normalizeState(state: GameState): GameState {
  state.waitingPlayers ??= [];
  state.resumeAt ??= 0;
  for (const player of state.players) player.leaving ??= false;
  return state;
}

function roomView(state: GameState, viewerAgentId: string | undefined, scores: Map<string, number>): RoomData {
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
