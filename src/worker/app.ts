import { Code, ConnectError } from "@connectrpc/connect";
import { stringifyCardCode } from "@pokertools/evaluator";
import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import {
  ActionType,
  RoomStatus,
  Street,
} from "../gen/poker/v1/poker_pb.js";
import {
  act as playAction,
  emptyGame,
  leaveGame,
  legalActions,
  refillTable,
  shuffledDeck,
  startMatch,
  startNextHand,
  type GameAction,
  type GameEvent,
  type GameState,
} from "../game.js";
import { GAME_CONFIG } from "../config.js";
import {
  PokerRepository,
  type AgentRow,
  type LeaderboardEntryData,
  type ParticipationLogData,
} from "./repository.js";

export type RoomData = ReturnType<typeof roomView>;

export interface EventData {
  seq: number;
  handNumber: number;
  kind: string;
  agentId: string;
  message: string;
  createdAt: number;
  room: RoomData;
  scoreDeltas?: Record<string, number>;
}

export class PokerMatch extends DurableObject<Env> {
  private readonly repository: PokerRepository;
  private waiters = new Set<() => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.repository = new PokerRepository(ctx.storage);
    ctx.blockConcurrencyWhile(async () => this.repository.migrate(JSON.stringify(emptyGame())));
  }

  async beginAuth(publicKey: Uint8Array): Promise<{
    challengeId: string;
    challenge: Uint8Array;
    expiresAt: number;
  }> {
    if (publicKey.byteLength !== 32) fail("INVALID_ARGUMENT", "Ed25519 public key must be 32 bytes");
    const challenge = randomBytes(32);
    const challengeId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 60_000;
    this.repository.insertChallenge(challengeId, publicKey, challenge, expiresAt, now);
    return { challengeId, challenge, expiresAt };
  }

  async finishAuth(input: {
    challengeId: string;
    publicKey: Uint8Array;
    signature: Uint8Array;
    displayName: string;
  }): Promise<{
    agentId: string;
    displayName: string;
    createdAt: number;
    sessionToken: string;
    expiresAt: number;
  }> {
    const challenge = this.repository.challenge(input.challengeId);
    if (!challenge) fail("NOT_FOUND", "challenge not found");
    if (challenge.consumed_at !== null || challenge.expires_at <= Date.now()) {
      fail("FAILED_PRECONDITION", "challenge is expired or already used");
    }
    if (toBase64Url(challenge.public_key) !== toBase64Url(input.publicKey)) {
      fail("PERMISSION_DENIED", "public key does not match challenge");
    }

    const publicKeyBuffer = new Uint8Array(input.publicKey).buffer;
    const signatureBuffer = new Uint8Array(input.signature).buffer;
    const key = await crypto.subtle.importKey("raw", publicKeyBuffer, "Ed25519", false, ["verify"]);
    const valid = await crypto.subtle.verify("Ed25519", key, signatureBuffer, challenge.challenge);
    if (!valid) fail("PERMISSION_DENIED", "invalid signature");

    const displayName = input.displayName.trim();
    if (displayName.length < 1 || displayName.length > 64) {
      fail("INVALID_ARGUMENT", "display name must contain 1 to 64 characters");
    }

    const now = Date.now();
    const agentId = toBase64Url(await crypto.subtle.digest("SHA-256", publicKeyBuffer));
    const sessionToken = toBase64Url(randomBytes(32));
    const tokenHash = await hashText(sessionToken);
    const expiresAt = now + 15 * 60_000;

    const agent = this.repository.completeAuth({
      challengeId: input.challengeId,
      agentId,
      publicKey: input.publicKey,
      displayName,
      now,
      tokenHash,
      expiresAt,
    });
    return {
      agentId,
      displayName: agent.display_name,
      createdAt: agent.created_at,
      sessionToken,
      expiresAt,
    };
  }

  async joinRoom(token: string): Promise<RoomData> {
    const agent = await this.agentForToken(token);
    const now = Date.now();

    const result = this.repository.transaction(() => {
      const { state, version } = this.repository.loadState();
      if (state.paused) fail("UNAVAILABLE", "room is paused");
      const score = this.repository.score(agent.agent_id);
      if (score === undefined) this.repository.ensureScore(agent.agent_id, GAME_CONFIG.startingStack, now);
      else if (score <= 0) fail("FAILED_PRECONDITION", "score must be greater than zero to join");
      const entryStack = score ?? GAME_CONFIG.startingStack;
      let events: GameEvent[] = [];

      // Recover pre-upgrade completed state before automatic seat refill ran.
      if (state.status === "COMPLETE" && state.resumeAt === 0) {
        const refilled = refillTable(state);
        Object.assign(state, refilled.state);
        events.push(...refilled.events);
      }

      const alreadyJoined = state.players.some((player) => player.agentId === agent.agent_id)
        || state.waitingPlayers.some((player) => player.agentId === agent.agent_id);
      if (alreadyJoined) {
        return events.length > 0
          ? this.saveState(state, version, events, "JOIN", undefined, { agentId: agent.agent_id })
          : { state, events: [] as EventData[] };
      }

      if (state.status !== "WAITING" || state.players.length >= GAME_CONFIG.playerCount) {
        if (state.waitingPlayers.length >= GAME_CONFIG.maxQueueSize) {
          fail("RESOURCE_EXHAUSTED", "waiting queue is full");
        }
        state.waitingPlayers.push({
          agentId: agent.agent_id,
          displayName: agent.display_name,
          stack: entryStack,
        });
        events.push({
          kind: "PLAYER_QUEUED",
          agentId: agent.agent_id,
          message: `${agent.display_name} joined the waiting queue.`,
        });
        return this.saveState(state, version, events, "JOIN", undefined, { agentId: agent.agent_id });
      }

      const seat = Array.from({ length: GAME_CONFIG.playerCount }, (_, candidate) => candidate)
        .find((candidate) => !state.players.some((player) => player.seat === candidate))!;
      state.players.push({
        agentId: agent.agent_id,
        displayName: agent.display_name,
        seat,
        stack: entryStack,
        streetBet: 0,
        totalBet: 0,
        hole: [],
        folded: false,
        allIn: false,
        acted: false,
        leaving: false,
      });
      events.push({
        kind: "PLAYER_JOINED",
        agentId: agent.agent_id,
        message: `${agent.display_name} joined seat ${seat}.`,
      });

      if (state.players.length === GAME_CONFIG.playerCount) {
        const started = state.handNumber === 0
          ? startMatch(state.players, shuffledDeck(), now, crypto.randomUUID(), crypto.randomUUID())
          : startNextHand(state, shuffledDeck(), now, crypto.randomUUID());
        started.state.eventSeq = state.eventSeq;
        started.state.waitingPlayers = state.waitingPlayers;
        Object.assign(state, started.state);
        events = [...events, ...started.events];
      }
      return this.saveState(state, version, events, "JOIN", undefined, { agentId: agent.agent_id });
    });

    await this.scheduleAlarm(result.state);
    if (result.events.length > 0) this.notifyWaiters();
    return this.roomView(result.state, agent.agent_id);
  }

  async leaveRoom(token: string): Promise<RoomData> {
    const agent = await this.agentForToken(token);
    const now = Date.now();
    const result = this.repository.transaction(() => {
      const { state, version } = this.repository.loadState();
      const queued = state.waitingPlayers.findIndex((candidate) => candidate.agentId === agent.agent_id);
      if (queued >= 0) {
        state.waitingPlayers.splice(queued, 1);
        return this.saveState(state, version, [{
          kind: "PLAYER_LEFT_QUEUE",
          agentId: agent.agent_id,
          message: `${agent.display_name} left the waiting queue.`,
        }], "LEAVE", undefined, { agentId: agent.agent_id });
      }
      const player = state.players.find((candidate) => candidate.agentId === agent.agent_id);
      if (!player) fail("NOT_FOUND", "agent is not seated");
      if (state.status === "PLAYING") {
        const decisionId = state.decision?.seat === player.seat ? state.decision.id : undefined;
        const left = leaveGame(state, agent.agent_id, now, crypto.randomUUID());
        return left.events.length > 0
          ? this.saveState(
              left.state,
              version,
              left.events,
              "LEAVE",
              decisionId,
              { agentId: agent.agent_id, action: "fold" },
            )
          : { state: left.state, events: [] as EventData[] };
      }
      state.players = state.players.filter((candidate) => candidate.agentId !== agent.agent_id);
      return this.saveState(state, version, [{
        kind: "PLAYER_LEFT",
        agentId: agent.agent_id,
        message: `${agent.display_name} left seat ${player.seat}.`,
      }], "LEAVE", undefined, { agentId: agent.agent_id });
    });
    await this.scheduleAlarm(result.state);
    this.notifyWaiters();
    return this.roomView(result.state, agent.agent_id);
  }

  async getRoom(token?: string, omitEvents = false): Promise<{ room: RoomData; events: EventData[] }> {
    const agent = token ? await this.agentForToken(token) : undefined;
    const state = this.repository.loadState().state;
    return {
      room: this.roomView(state, agent?.agent_id),
      events: omitEvents ? [] : this.repository.eventsForHand(state.handNumber),
    };
  }

  listRoomEvents(before: number, limit: number): { events: EventData[]; hasMore: boolean } {
    if (!Number.isSafeInteger(before) || before < 0) {
      fail("INVALID_ARGUMENT", "before_event_seq must be a non-negative safe integer");
    }
    if (!Number.isInteger(limit) || limit < 0 || limit > 100) {
      fail("INVALID_ARGUMENT", "limit must be between 0 and 100");
    }
    return this.repository.eventPage(before, limit || 20);
  }

  getLeaderboard(): LeaderboardEntryData[] {
    return this.repository.leaderboard();
  }

  async getMyScore(token: string): Promise<number> {
    const agent = await this.agentForToken(token);
    return this.repository.score(agent.agent_id) ?? 0;
  }

  async getMyLogs(token: string, beforeId: number, limit: number): Promise<ParticipationLogData[]> {
    const agent = await this.agentForToken(token);
    if (!Number.isSafeInteger(beforeId) || beforeId < 0) {
      fail("INVALID_ARGUMENT", "before_id must be a non-negative safe integer");
    }
    if (!Number.isInteger(limit) || limit < 0 || limit > 100) {
      fail("INVALID_ARGUMENT", "limit must be between 0 and 100");
    }
    return this.repository.participationLogs(agent.agent_id, beforeId, limit || 20);
  }

  async waitForTurn(token: string, afterEventSeq: number, timeoutMs: number): Promise<{
    yourTurn: boolean;
    changed: boolean;
    room: RoomData;
    events: EventData[];
  }> {
    const agent = await this.agentForToken(token);
    let state = this.repository.loadState().state;
    if (state.eventSeq <= afterEventSeq && state.decision?.seat !== seatFor(state, agent.agent_id)) {
      await this.waitForSignal(Math.max(0, Math.min(timeoutMs, 25_000)));
      state = this.repository.loadState().state;
    }
    const events = this.readEvents(afterEventSeq);
    return {
      yourTurn: state.decision?.seat === seatFor(state, agent.agent_id),
      changed: events.length > 0,
      room: this.roomView(state, agent.agent_id),
      events,
    };
  }

  async sendChat(token: string, text: string): Promise<EventData> {
    const agent = await this.agentForToken(token);
    const message = text.trim();
    if (message.length === 0 || [...message].length > 280) {
      fail("INVALID_ARGUMENT", "chat message must contain 1 to 280 characters");
    }
    const now = Date.now();
    const result = this.repository.transaction(() => {
      const { state, version } = this.repository.loadState();
      if (state.paused) fail("UNAVAILABLE", "room is paused");
      const player = state.players.find((candidate) => (
        candidate.agentId === agent.agent_id && !candidate.leaving
      ));
      if (!player) fail("FAILED_PRECONDITION", "only seated players can chat");
      const lastChatAt = this.repository.lastChatAt(agent.agent_id);
      if (lastChatAt !== undefined && now - lastChatAt < 10_000) {
        fail("RESOURCE_EXHAUSTED", "wait 10 seconds between chat messages");
      }
      return this.saveState(state, version, [{
        kind: "CHAT_MESSAGE",
        agentId: agent.agent_id,
        message: `${player.displayName}: ${message}`,
      }]);
    });
    this.notifyWaiters();
    return result.events[0];
  }

  async act(
    token: string,
    decisionId: string,
    actionType: ActionType,
    amount: number,
    reason: string,
  ): Promise<{ room: RoomData; event: EventData }> {
    const agent = await this.agentForToken(token);
    const action = gameAction(actionType);
    if (reason.length > 2_000) fail("INVALID_ARGUMENT", "reason is too long");
    if (!Number.isSafeInteger(amount) || amount < 0) fail("INVALID_ARGUMENT", "amount must be a non-negative integer");

    const now = Date.now();
    const newDecisionId = crypto.randomUUID();
    const result = this.repository.transaction(() => {
      const { state, version } = this.repository.loadState();
      const acting = state.players.find((player) => player.seat === state.decision?.seat);
      if (!acting || acting.agentId !== agent.agent_id) fail("PERMISSION_DENIED", "it is not this agent's turn");
      let played;
      try {
        played = playAction(state, decisionId, action, amount, now, newDecisionId);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        fail(message.includes("expired") ? "DEADLINE_EXCEEDED" : "FAILED_PRECONDITION", message);
      }
      return this.saveState(
        played.state,
        version,
        played.events,
        "DECISION_ACTED",
        decisionId,
        { agentId: agent.agent_id, action, amount, reason },
      );
    });

    await this.scheduleAlarm(result.state);
    this.notifyWaiters();
    const accepted = result.events.find((event) => event.kind === "ACTION") ?? result.events[0];
    return { room: this.roomView(result.state, agent.agent_id), event: accepted };
  }

  async waitForEvents(after: number, timeoutMs: number): Promise<EventData[]> {
    let events = this.readEvents(after);
    if (events.length === 0) {
      await this.waitForSignal(Math.max(0, Math.min(timeoutMs, 25_000)));
      events = this.readEvents(after);
    }
    return events;
  }

  async setRoomPaused(paused: boolean): Promise<RoomData> {
    const result = this.repository.transaction(() => {
      const { state: current, version } = this.repository.loadState();
      if (current.paused === paused) return { state: current, events: [] as EventData[] };
      const state = paused
        ? {
            ...emptyGame(),
            matchId: current.matchId,
            handNumber: current.handNumber,
            dealerSeat: current.dealerSeat,
            eventSeq: current.eventSeq,
            paused: true,
          }
        : { ...current, paused: false };
      return this.saveState(state, version, [{
        kind: paused ? "ROOM_PAUSED" : "ROOM_RESUMED",
        message: paused ? "The room was paused." : "The room resumed.",
      }], paused ? "ROOM_PAUSED" : "ROOM_RESUMED");
    });
    if (paused) await this.ctx.storage.deleteAlarm();
    else await this.scheduleAlarm(result.state);
    if (result.events.length > 0) this.notifyWaiters();
    return this.roomView(result.state);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const result = this.repository.transaction(() => {
      const { state, version } = this.repository.loadState();
      if (state.paused) return undefined;

      if (state.resumeAt > 0 && state.resumeAt <= now) {
        const refilled = refillTable(state);
        Object.assign(state, refilled.state);
        let events = refilled.events;
        if (state.players.length === GAME_CONFIG.playerCount) {
          const started = startNextHand(state, shuffledDeck(), now, crypto.randomUUID());
          Object.assign(state, started.state);
          events = [...events, ...started.events];
        }
        return this.saveState(state, version, events, "TABLE_RESUMED");
      }

      if (!state.decision || state.decision.deadline > now) return undefined;
      const decisionId = state.decision.id;
      const acting = state.players.find((player) => player.seat === state.decision?.seat)!;
      const action = "fold" as const;
      const played = playAction(state, decisionId, action, 0, now, crypto.randomUUID(), true);
      return this.saveState(
        played.state,
        version,
        played.events,
        "DECISION_TIMED_OUT",
        decisionId,
        { agentId: acting.agentId, action },
      );
    });
    if (!result) {
      await this.scheduleAlarm(this.repository.loadState().state);
      return;
    }
    await this.scheduleAlarm(result.state);
    this.notifyWaiters();
  }

  private async agentForToken(token: string): Promise<AgentRow> {
    const tokenHash = await hashText(token);
    const row = this.repository.agentForSession(tokenHash, Date.now());
    if (!row) fail("UNAUTHENTICATED", "session token is invalid or expired");
    return row;
  }

  private saveState(
    state: GameState,
    expectedVersion: number,
    drafts: GameEvent[],
    privateKind?: string,
    decisionId?: string,
    privatePayload: object = {},
  ): { state: GameState; events: EventData[] } {
    const now = Date.now();
    const events: EventData[] = [];
    for (const draft of drafts) {
      for (const [agentId, delta] of Object.entries(draft.scoreDeltas ?? {})) {
        this.repository.addScore(agentId, delta, GAME_CONFIG.startingStack, now);
      }
    }
    for (const draft of drafts) {
      state.eventSeq += 1;
      const room = this.roomView(state);
      const event: EventData = {
        seq: state.eventSeq,
        handNumber: state.handNumber,
        kind: draft.kind,
        agentId: draft.agentId ?? "",
        message: draft.message,
        createdAt: now,
        room,
        scoreDeltas: draft.scoreDeltas,
      };
      events.push(event);
    }
    this.repository.saveState({
      state,
      expectedVersion,
      events,
      privateKind,
      decisionId,
      privatePayload,
      now,
    });
    return { state, events };
  }

  private readEvents(after: number): EventData[] {
    return this.repository.eventsAfter(after);
  }

  private roomView(state: GameState, viewerAgentId?: string): RoomData {
    const scores = new Map(state.players.map((player) => [
      player.agentId,
      this.repository.score(player.agentId) ?? 0,
    ]));
    return roomView(state, scores, viewerAgentId);
  }

  private async scheduleAlarm(state: GameState): Promise<void> {
    const scheduledAt = state.decision?.deadline ?? state.resumeAt;
    if (scheduledAt > 0) await this.ctx.storage.setAlarm(scheduledAt);
    else await this.ctx.storage.deleteAlarm();
  }

  private waitForSignal(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  private notifyWaiters(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}

function roomView(state: GameState, scores: ReadonlyMap<string, number>, viewerAgentId?: string) {
  const decisionPlayer = state.players.find((player) => player.seat === state.decision?.seat);
  const viewer = state.players.find((player) => player.agentId === viewerAgentId && !player.leaving);
  const viewerCanAct = viewer && state.decision?.seat === viewer.seat;
  const legal = viewerCanAct ? legalActions(state, viewer.seat) : undefined;
  return {
    status: state.status === "WAITING"
      ? RoomStatus.WAITING_FOR_PLAYERS
      : state.status === "PLAYING"
        ? RoomStatus.PLAYING
        : RoomStatus.COMPLETE,
    capacity: GAME_CONFIG.playerCount,
    handNumber: state.handNumber,
    street: {
      PREFLOP: Street.PREFLOP,
      FLOP: Street.FLOP,
      TURN: Street.TURN,
      RIVER: Street.RIVER,
      SHOWDOWN: Street.SHOWDOWN,
    }[state.street],
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
    legalActions: legal && {
      actions: legal.actions.map(actionType),
      callAmount: legal.callAmount,
      minRaiseTo: legal.minRaiseTo,
      maxRaiseTo: legal.maxRaiseTo,
    },
    latestEventSeq: state.eventSeq,
    result: state.result,
    queueSize: state.waitingPlayers.length,
    viewerSeated: Boolean(viewer),
    viewerQueuePosition: viewerAgentId
      ? state.waitingPlayers.findIndex((player) => player.agentId === viewerAgentId) + 1
      : 0,
    paused: state.paused,
  };
}

function cardData(code: number) {
  const card = stringifyCardCode(code);
  return { rank: card[0], suit: card[1] };
}

function actionType(action: GameAction): ActionType {
  return {
    fold: ActionType.FOLD,
    check: ActionType.CHECK,
    call: ActionType.CALL,
    raise: ActionType.RAISE,
  }[action];
}

function gameAction(action: ActionType): GameAction {
  if (action === ActionType.FOLD) return "fold";
  if (action === ActionType.CHECK) return "check";
  if (action === ActionType.CALL) return "call";
  if (action === ActionType.RAISE) return "raise";
  fail("INVALID_ARGUMENT", "unknown action");
}

function seatFor(state: GameState, agentId: string): number {
  return state.players.find((player) => player.agentId === agentId)?.seat ?? -1;
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hashText(value: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

export function requireAdmin(headers: Headers, expected?: string): void {
  if (!expected) throw new ConnectError("Admin operations are unavailable", Code.Unavailable);
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new ConnectError("Missing admin token", Code.Unauthenticated);
  }
  const provided = new TextEncoder().encode(authorization.slice(7));
  const secret = new TextEncoder().encode(expected);
  if (provided.byteLength !== secret.byteLength || !timingSafeEqual(provided, secret)) {
    throw new ConnectError("Invalid admin token", Code.PermissionDenied);
  }
}
