import { evaluate, rank, rankDescription } from "@pokertools/evaluator";

export const INITIAL_STACK = 100;
export const SMALL_BLIND = 5;
export const BIG_BLIND = 10;
export const TURN_MS = 60_000;

export type GameAction = "fold" | "check" | "call" | "raise";
export type GameStatus = "WAITING" | "PLAYING" | "COMPLETE";
export type GameStreet = "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN";

export interface GamePlayer {
  agentId: string;
  displayName: string;
  seat: number;
  stack: number;
  streetBet: number;
  totalBet: number;
  hole: number[];
  folded: boolean;
  allIn: boolean;
  acted: boolean;
}

export interface Decision {
  id: string;
  seat: number;
  deadline: number;
}

export interface GameState {
  schemaVersion: 1;
  status: GameStatus;
  matchId: string;
  handNumber: number;
  street: GameStreet;
  dealerSeat: number;
  community: number[];
  deck: number[];
  deckCursor: number;
  currentBet: number;
  minRaise: number;
  players: GamePlayer[];
  decision: Decision | null;
  eventSeq: number;
  result: string;
  lastRevealed: Record<string, number[]>;
}

export interface GameEvent {
  kind: string;
  agentId?: string;
  message: string;
}

export interface LegalActions {
  actions: GameAction[];
  callAmount: number;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export function emptyGame(): GameState {
  return {
    schemaVersion: 1,
    status: "WAITING",
    matchId: "",
    handNumber: 0,
    street: "PREFLOP",
    dealerSeat: -1,
    community: [],
    deck: [],
    deckCursor: 0,
    currentBet: 0,
    minRaise: BIG_BLIND,
    players: [],
    decision: null,
    eventSeq: 0,
    result: "",
    lastRevealed: {},
  };
}

export function shuffledDeck(): number[] {
  const deck = Array.from({ length: 52 }, (_, index) => index);
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const swapWith = random[0] % (index + 1);
    [deck[index], deck[swapWith]] = [deck[swapWith], deck[index]];
  }
  return deck;
}

export function startMatch(
  seatedPlayers: Array<Pick<GamePlayer, "agentId" | "displayName" | "seat">>,
  deck: number[],
  now: number,
  matchId: string,
  decisionId: string,
): { state: GameState; events: GameEvent[] } {
  const state = emptyGame();
  state.status = "PLAYING";
  state.matchId = matchId;
  state.players = seatedPlayers.map((player) => ({
    ...player,
    stack: INITIAL_STACK,
    streetBet: 0,
    totalBet: 0,
    hole: [],
    folded: false,
    allIn: false,
    acted: false,
  }));
  const events: GameEvent[] = [{ kind: "MATCH_STARTED", message: "Four players joined. Match started." }];
  startHand(state, deck, now, decisionId, events);
  return { state, events };
}

export function legalActions(state: GameState, seat: number): LegalActions {
  const player = state.players.find((candidate) => candidate.seat === seat);
  if (!player || player.folded || player.allIn || state.decision?.seat !== seat) {
    return { actions: [], callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 };
  }

  const callAmount = Math.min(state.currentBet - player.streetBet, player.stack);
  const maxRaiseTo = player.streetBet + player.stack;
  const minRaiseTo = Math.min(state.currentBet + state.minRaise, maxRaiseTo);
  const actions: GameAction[] = ["fold"];

  if (player.streetBet === state.currentBet) actions.push("check");
  if (player.streetBet < state.currentBet) actions.push("call");
  if (!player.acted && maxRaiseTo > state.currentBet) actions.push("raise");

  return { actions, callAmount, minRaiseTo, maxRaiseTo };
}

export function act(
  current: GameState,
  decisionId: string,
  action: GameAction,
  amount: number,
  now: number,
  nextDecisionId: string,
  nextDeck: number[],
  allowExpired = false,
): { state: GameState; events: GameEvent[] } {
  const state = structuredClone(current);
  const decision = state.decision;
  if (!decision || decision.id !== decisionId) throw new Error("decision is no longer current");
  if (!allowExpired && decision.deadline <= now) throw new Error("decision has expired");

  const player = state.players.find((candidate) => candidate.seat === decision.seat);
  if (!player) throw new Error("acting player does not exist");

  const legal = legalActions(state, player.seat);
  if (!legal.actions.includes(action)) throw new Error(`${action} is not legal`);

  if (action === "fold") {
    player.folded = true;
    player.acted = true;
  } else if (action === "check") {
    player.acted = true;
  } else if (action === "call") {
    moveChips(player, legal.callAmount);
    player.acted = true;
  } else {
    if (!Number.isSafeInteger(amount) || amount <= state.currentBet || amount > legal.maxRaiseTo) {
      throw new Error("raise-to amount is outside the legal range");
    }
    if (amount < state.currentBet + state.minRaise && amount !== legal.maxRaiseTo) {
      throw new Error("raise is below the minimum");
    }

    const raiseSize = amount - state.currentBet;
    moveChips(player, amount - player.streetBet);
    state.currentBet = amount;

    if (raiseSize >= state.minRaise) {
      state.minRaise = raiseSize;
      for (const other of state.players) {
        if (!other.folded && !other.allIn) other.acted = false;
      }
    }
    player.acted = true;
  }

  const events: GameEvent[] = [{
    kind: "ACTION",
    agentId: player.agentId,
    message: action === "raise"
      ? `${player.displayName} raised to ${amount}.`
      : `${player.displayName} ${action}ed.`,
  }];

  const remaining = state.players.filter((candidate) => !candidate.folded);
  if (remaining.length === 1) {
    finishHand(state, now, nextDecisionId, nextDeck, events);
  } else if (bettingRoundComplete(state)) {
    advanceStreet(state, now, nextDecisionId, nextDeck, events);
  } else {
    openDecision(state, nextSeatNeedingAction(state, player.seat), now, nextDecisionId);
  }

  return { state, events };
}

function startHand(
  state: GameState,
  deck: number[],
  now: number,
  decisionId: string,
  events: GameEvent[],
): void {
  const active = state.players.filter((player) => player.stack > 0);
  state.handNumber += 1;
  state.street = "PREFLOP";
  state.dealerSeat = state.dealerSeat < 0
    ? active[0].seat
    : nextActiveSeat(state, state.dealerSeat);
  state.community = [];
  state.deck = deck;
  state.deckCursor = 0;
  state.currentBet = 0;
  state.minRaise = BIG_BLIND;
  state.decision = null;
  state.result = "";

  for (const player of state.players) {
    player.streetBet = 0;
    player.totalBet = 0;
    player.hole = [];
    player.folded = player.stack === 0;
    player.allIn = false;
    player.acted = false;
  }

  const dealOrder = orderedActiveSeats(state, state.dealerSeat);
  for (let round = 0; round < 2; round += 1) {
    for (const seat of dealOrder) playerAt(state, seat).hole.push(draw(state));
  }

  const smallBlindSeat = active.length === 2
    ? state.dealerSeat
    : nextActiveSeat(state, state.dealerSeat);
  const bigBlindSeat = nextActiveSeat(state, smallBlindSeat);
  moveChips(playerAt(state, smallBlindSeat), SMALL_BLIND);
  moveChips(playerAt(state, bigBlindSeat), BIG_BLIND);
  state.currentBet = BIG_BLIND;

  const firstToAct = active.length === 2
    ? smallBlindSeat
    : nextActiveSeat(state, bigBlindSeat);
  openDecision(state, nextSeatNeedingAction(state, (firstToAct + 3) % 4), now, decisionId);
  events.push({ kind: "HAND_STARTED", message: `Hand ${state.handNumber} started.` });
}

function advanceStreet(
  state: GameState,
  now: number,
  decisionId: string,
  nextDeck: number[],
  events: GameEvent[],
): void {
  for (const player of state.players) {
    player.streetBet = 0;
    player.acted = false;
  }
  state.currentBet = 0;
  state.minRaise = BIG_BLIND;

  if (state.street === "RIVER") {
    finishHand(state, now, decisionId, nextDeck, events);
    return;
  }

  if (state.street === "PREFLOP") {
    state.street = "FLOP";
    state.community.push(draw(state), draw(state), draw(state));
  } else if (state.street === "FLOP") {
    state.street = "TURN";
    state.community.push(draw(state));
  } else {
    state.street = "RIVER";
    state.community.push(draw(state));
  }
  events.push({ kind: "STREET", message: `${state.street.toLowerCase()} dealt.` });

  const canAct = state.players.filter((player) => !player.folded && !player.allIn);
  if (canAct.length <= 1) {
    advanceStreet(state, now, decisionId, nextDeck, events);
    return;
  }
  openDecision(state, nextSeatNeedingAction(state, state.dealerSeat), now, decisionId);
}

function finishHand(
  state: GameState,
  now: number,
  decisionId: string,
  nextDeck: number[],
  events: GameEvent[],
): void {
  while (state.community.length < 5 && state.players.filter((player) => !player.folded).length > 1) {
    state.community.push(draw(state));
  }
  state.street = "SHOWDOWN";
  state.decision = null;

  const payouts = new Map<number, number>();
  const contributions = [...new Set(
    state.players.map((player) => player.totalBet).filter((amount) => amount > 0),
  )].sort((left, right) => left - right);
  let previous = 0;

  for (const level of contributions) {
    const contributors = state.players.filter((player) => player.totalBet >= level);
    const pot = (level - previous) * contributors.length;
    const eligible = contributors.filter((player) => !player.folded);
    const winners = eligible.length > 1 ? bestPlayers(eligible, state.community) : eligible;
    const orderedWinners = orderedSeatsFromDealer(state, winners.map((player) => player.seat));
    const share = Math.floor(pot / orderedWinners.length);
    let remainder = pot % orderedWinners.length;
    for (const seat of orderedWinners) {
      payouts.set(seat, (payouts.get(seat) ?? 0) + share + (remainder > 0 ? 1 : 0));
      remainder -= remainder > 0 ? 1 : 0;
    }
    previous = level;
  }

  for (const player of state.players) player.stack += payouts.get(player.seat) ?? 0;
  const showdownPlayers = state.players.filter((player) => !player.folded && player.hole.length === 2);
  state.lastRevealed = showdownPlayers.length > 1
    ? Object.fromEntries(showdownPlayers.map((player) => [player.agentId, player.hole]))
    : {};

  const paid = state.players
    .filter((player) => (payouts.get(player.seat) ?? 0) > 0)
    .map((player) => `${player.displayName} won ${payouts.get(player.seat)}`)
    .join(", ");
  const description = showdownPlayers.length === 1
    ? ""
    : ` (${showdownPlayers.map((player) => `${player.displayName}: ${rankDescription(rank([...player.hole, ...state.community]))}`).join(", ")})`;
  state.result = `${paid}.${description}`;
  events.push({ kind: "HAND_COMPLETED", message: `Hand ${state.handNumber}: ${state.result}` });

  const survivors = state.players.filter((player) => player.stack > 0);
  if (survivors.length === 1) {
    for (const player of state.players) {
      player.streetBet = 0;
      player.totalBet = 0;
      player.allIn = player.stack === 0;
    }
    state.status = "COMPLETE";
    state.result = `${survivors[0].displayName} won the match with ${survivors[0].stack} chips.`;
    events.push({
      kind: "MATCH_COMPLETED",
      agentId: survivors[0].agentId,
      message: state.result,
    });
    return;
  }

  startHand(state, nextDeck, now, decisionId, events);
}

function bestPlayers(players: GamePlayer[], community: number[]): GamePlayer[] {
  const scores = players.map((player) => ({
    player,
    score: evaluate([...player.hole, ...community]),
  }));
  const best = Math.min(...scores.map(({ score }) => score));
  return scores.filter(({ score }) => score === best).map(({ player }) => player);
}

function moveChips(player: GamePlayer, amount: number): void {
  const paid = Math.min(amount, player.stack);
  player.stack -= paid;
  player.streetBet += paid;
  player.totalBet += paid;
  player.allIn = player.stack === 0;
}

function bettingRoundComplete(state: GameState): boolean {
  return state.players
    .filter((player) => !player.folded && !player.allIn)
    .every((player) => player.acted && player.streetBet === state.currentBet);
}

function openDecision(state: GameState, seat: number, now: number, id: string): void {
  state.decision = { id, seat, deadline: now + TURN_MS };
}

function nextSeatNeedingAction(state: GameState, afterSeat: number): number {
  for (let offset = 1; offset <= 4; offset += 1) {
    const seat = (afterSeat + offset + 4) % 4;
    const player = state.players.find((candidate) => candidate.seat === seat);
    if (
      player
      && !player.folded
      && !player.allIn
      && (!player.acted || player.streetBet < state.currentBet)
    ) return seat;
  }
  throw new Error("no player needs an action");
}

function nextActiveSeat(state: GameState, afterSeat: number): number {
  for (let offset = 1; offset <= 4; offset += 1) {
    const seat = (afterSeat + offset + 4) % 4;
    if (state.players.some((player) => player.seat === seat && player.stack > 0)) return seat;
  }
  throw new Error("no active seat");
}

function orderedActiveSeats(state: GameState, afterSeat: number): number[] {
  const seats: number[] = [];
  for (let offset = 1; offset <= 4; offset += 1) {
    const seat = (afterSeat + offset + 4) % 4;
    if (state.players.some((player) => player.seat === seat && player.stack > 0)) seats.push(seat);
  }
  return seats;
}

function orderedSeatsFromDealer(state: GameState, seats: number[]): number[] {
  return Array.from({ length: 4 }, (_, offset) => (state.dealerSeat + offset + 1) % 4)
    .filter((seat) => seats.includes(seat));
}

function playerAt(state: GameState, seat: number): GamePlayer {
  const player = state.players.find((candidate) => candidate.seat === seat);
  if (!player) throw new Error(`seat ${seat} is empty`);
  return player;
}

function draw(state: GameState): number {
  const card = state.deck[state.deckCursor];
  if (card === undefined) throw new Error("deck is empty");
  state.deckCursor += 1;
  return card;
}
