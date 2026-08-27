import { stringifyCardCode } from "@pokertools/evaluator";
import { DurableObject } from "cloudflare:workers";
import {
  ActionType,
  RoomStatus,
  Street,
} from "../gen/poker/v1/poker_pb.js";
import {
  act as playAction,
  emptyGame,
  INITIAL_STACK,
  legalActions,
  shuffledDeck,
  startMatch,
  type GameAction,
  type GameEvent,
  type GameState,
} from "../game.js";
import { PokerRepository, type AgentRow } from "./repository.js";

export type RoomData = ReturnType<typeof roomView>;

export interface EventData {
  seq: number;
  handNumber: number;
  kind: string;
  agentId: string;
  message: string;
  createdAt: number;
  room: RoomData;
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
    const matchId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    // 第四名玩家加入时会立刻开局；未满四人时这副预洗牌不会被使用。
    const deck = shuffledDeck();
    const now = Date.now();

    const result = this.repository.transaction(() => {
      const { state, version } = this.repository.loadState();
      if (state.status !== "WAITING") fail("FAILED_PRECONDITION", "match has already started");
      if (state.players.some((player) => player.agentId === agent.agent_id)) {
        return { state, events: [] as EventData[] };
      }
      if (state.players.length >= 4) fail("ALREADY_EXISTS", "room is full");

      const seat = [0, 1, 2, 3].find((candidate) => !state.players.some((player) => player.seat === candidate))!;
      state.players.push({
        agentId: agent.agent_id,
        displayName: agent.display_name,
        seat,
        stack: INITIAL_STACK,
        streetBet: 0,
        totalBet: 0,
        hole: [],
        folded: false,
        allIn: false,
        acted: false,
      });
      let events: GameEvent[] = [{
        kind: "PLAYER_JOINED",
        agentId: agent.agent_id,
        message: `${agent.display_name} joined seat ${seat}.`,
      }];

      if (state.players.length === 4) {
        const started = startMatch(state.players, deck, now, matchId, decisionId);
        started.state.eventSeq = state.eventSeq;
        Object.assign(state, started.state);
        events = [...events, ...started.events];
      }
      return this.saveState(state, version, events, "JOIN", undefined, { agentId: agent.agent_id });
    });

    await this.scheduleAlarm(result.state);
    if (result.events.length > 0) this.notifyWaiters();
    return roomView(result.state, agent.agent_id);
  }

  async leaveRoom(token: string): Promise<RoomData> {
    const agent = await this.agentForToken(token);
    const result = this.repository.transaction(() => {
      const { state, version } = this.repository.loadState();
      if (state.status !== "WAITING") fail("FAILED_PRECONDITION", "players cannot leave after the match starts");
      const player = state.players.find((candidate) => candidate.agentId === agent.agent_id);
      if (!player) fail("NOT_FOUND", "agent is not seated");
      state.players = state.players.filter((candidate) => candidate.agentId !== agent.agent_id);
      return this.saveState(state, version, [{
        kind: "PLAYER_LEFT",
        agentId: agent.agent_id,
        message: `${agent.display_name} left seat ${player.seat}.`,
      }], "LEAVE");
    });
    this.notifyWaiters();
    return roomView(result.state, agent.agent_id);
  }

  async getRoom(token?: string): Promise<RoomData> {
    const agent = token ? await this.agentForToken(token) : undefined;
    return roomView(this.repository.loadState().state, agent?.agent_id);
  }

  async waitForTurn(token: string, afterEventSeq: number, timeoutMs: number): Promise<{
    yourTurn: boolean;
    changed: boolean;
    room: RoomData;
  }> {
    const agent = await this.agentForToken(token);
    let state = this.repository.loadState().state;
    if (state.eventSeq <= afterEventSeq && state.decision?.seat !== seatFor(state, agent.agent_id)) {
      await this.waitForSignal(Math.max(0, Math.min(timeoutMs, 25_000)));
      state = this.repository.loadState().state;
    }
    return {
      yourTurn: state.decision?.seat === seatFor(state, agent.agent_id),
      changed: state.eventSeq > afterEventSeq,
      room: roomView(state, agent.agent_id),
    };
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
    // 本次行动可能结束当前手牌并在同一事务内开下一手；只有该分支会使用它。
    const nextDeck = shuffledDeck();
    const result = this.repository.transaction(() => {
      const { state, version } = this.repository.loadState();
      const acting = state.players.find((player) => player.seat === state.decision?.seat);
      if (!acting || acting.agentId !== agent.agent_id) fail("PERMISSION_DENIED", "it is not this agent's turn");
      let played;
      try {
        played = playAction(state, decisionId, action, amount, now, newDecisionId, nextDeck);
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
        { action, amount, reason },
      );
    });

    await this.scheduleAlarm(result.state);
    this.notifyWaiters();
    const accepted = result.events.find((event) => event.kind === "ACTION") ?? result.events[0];
    return { room: roomView(result.state, agent.agent_id), event: accepted };
  }

  async waitForEvents(after: number, timeoutMs: number): Promise<EventData[]> {
    let events = this.readEvents(after);
    if (events.length === 0) {
      await this.waitForSignal(Math.max(0, Math.min(timeoutMs, 25_000)));
      events = this.readEvents(after);
    }
    return events;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const newDecisionId = crypto.randomUUID();
    // 超时行动也可能结束当前手牌，nextDeck 的使用时机与普通 act 相同。
    const nextDeck = shuffledDeck();
    const result = this.repository.transaction(() => {
      const { state, version } = this.repository.loadState();
      if (!state.decision || state.decision.deadline > now) return undefined;
      const decisionId = state.decision.id;
      const legal = legalActions(state, state.decision.seat);
      const action: GameAction = legal.actions.includes("check") ? "check" : "fold";
      const played = playAction(state, decisionId, action, 0, now, newDecisionId, nextDeck, true);
      return this.saveState(
        played.state,
        version,
        played.events,
        "DECISION_TIMED_OUT",
        decisionId,
        { action },
      );
    });
    if (!result) return;
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
    privateKind: string,
    decisionId?: string,
    privatePayload: object = {},
  ): { state: GameState; events: EventData[] } {
    const now = Date.now();
    const events: EventData[] = [];
    for (const draft of drafts) {
      state.eventSeq += 1;
      const room = roomView(state);
      const event: EventData = {
        seq: state.eventSeq,
        handNumber: state.handNumber,
        kind: draft.kind,
        agentId: draft.agentId ?? "",
        message: draft.message,
        createdAt: now,
        room,
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

  private async scheduleAlarm(state: GameState): Promise<void> {
    if (state.decision) await this.ctx.storage.setAlarm(state.decision.deadline);
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

function roomView(state: GameState, viewerAgentId?: string) {
  const decisionPlayer = state.players.find((player) => player.seat === state.decision?.seat);
  const viewer = state.players.find((player) => player.agentId === viewerAgentId);
  const viewerCanAct = viewer && state.decision?.seat === viewer.seat;
  const legal = viewerCanAct ? legalActions(state, viewer.seat) : undefined;
  return {
    status: state.status === "WAITING"
      ? RoomStatus.WAITING_FOR_PLAYERS
      : state.status === "PLAYING"
        ? RoomStatus.PLAYING
        : RoomStatus.COMPLETE,
    capacity: 4,
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
    decisionDeadline: viewerCanAct ? state.decision?.deadline ?? 0 : 0,
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
    })),
    legalActions: legal && {
      actions: legal.actions.map(actionType),
      callAmount: legal.callAmount,
      minRaiseTo: legal.minRaiseTo,
      maxRaiseTo: legal.maxRaiseTo,
    },
    latestEventSeq: state.eventSeq,
    result: state.result,
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
