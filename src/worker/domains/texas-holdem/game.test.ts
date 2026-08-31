import { describe, expect, it, vi } from "vitest";
import { GAME_CONFIG } from "../../../config.js";
import { act, leaveGame, legalActions, refillTable, startMatch, startNextHand, timeout } from "./game.js";

vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return { GAME_CONFIG: { ...actual.GAME_CONFIG, playerCount: 4 } };
});

const players = Array.from({ length: 4 }, (_, seat) => ({
  agentId: `agent-${seat}`,
  displayName: `Player ${seat}`,
  seat,
  stack: GAME_CONFIG.startingStack,
}));
const totalChips = GAME_CONFIG.playerCount * GAME_CONFIG.startingStack;

describe("poker game", () => {
  it("posts blinds and starts with the seat after the big blind", () => {
    const { state } = startMatch(players, orderedDeck(), 1_000, "decision-1");

    expect(state.dealerSeat).toBe(0);
    expect(state.players[1].streetBet).toBe(5);
    expect(state.players[2].streetBet).toBe(10);
    expect(state.decision?.seat).toBe(3);
    expect(legalActions(state, 3)).toEqual({
      actions: ["fold", "call", "raise"],
      callAmount: 10,
      minRaiseTo: 20,
      maxRaiseTo: GAME_CONFIG.startingStack,
    });
  });

  it("finishes a four-way all-in match and conserves chips", () => {
    let state = startMatch(players, winningDeck(), 1_000, "decision-1").state;
    state = act(state, "decision-1", "raise", GAME_CONFIG.startingStack, 1_001, "decision-2").state;
    state = act(state, "decision-2", "call", 0, 1_002, "decision-3").state;
    state = act(state, "decision-3", "call", 0, 1_003, "decision-4").state;
    const completed = act(state, "decision-4", "call", 0, 1_004, "decision-5");
    state = completed.state;

    expect(state.status).toBe("PLAYING");
    expect(state.street).toBe("SHOWDOWN");
    expect(state.players.reduce((sum, player) => sum + player.stack + player.totalBet, 0)).toBe(totalChips);
    expect(state.players.filter((player) => player.stack > 0)).toHaveLength(1);
    expect(state.players.reduce((sum, player) => sum + player.totalBet, 0)).toBe(0);
    expect(Object.keys(state.lastRevealed)).toHaveLength(4);
    const scoreDeltas = completed.events.find((event) => event.kind === "HAND_COMPLETED")?.scoreDeltas;
    expect(Object.values(scoreDeltas ?? {}).reduce((sum, delta) => sum + delta, 0)).toBe(0);
  });

  it("removes busted players and fills their seats from the queue in FIFO order", () => {
    let state = startMatch(players, winningDeck(), 1_000, "decision-1").state;
    state.waitingPlayers = [
      { agentId: "queued-1", displayName: "Queued 1", stack: 750 },
      { agentId: "queued-2", displayName: "Queued 2", stack: GAME_CONFIG.startingStack },
      { agentId: "queued-3", displayName: "Queued 3", stack: GAME_CONFIG.startingStack },
    ];
    state = act(state, "decision-1", "raise", GAME_CONFIG.startingStack, 1_001, "decision-2").state;
    state = act(state, "decision-2", "call", 0, 1_002, "decision-3").state;
    state = act(state, "decision-3", "call", 0, 1_003, "decision-4").state;
    state = act(state, "decision-4", "call", 0, 1_004, "decision-5").state;

    expect(state.street).toBe("SHOWDOWN");
    expect(state.resumeAt).toBeGreaterThan(1_004);
    const survivor = state.players.find((player) => player.stack > 0)!;
    const refilled = refillTable(state);

    expect(refilled.state.players).toHaveLength(4);
    expect(refilled.state.players.find((player) => player.agentId === survivor.agentId)?.stack).toBe(totalChips);
    expect(refilled.state.players.filter((player) => player.agentId.startsWith("queued-")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: "queued-1", stack: 750 }),
        expect.objectContaining({ agentId: "queued-2", stack: GAME_CONFIG.startingStack }),
        expect.objectContaining({ agentId: "queued-3", stack: GAME_CONFIG.startingStack }),
      ]));
    expect(refilled.state.waitingPlayers).toEqual([]);
    expect(refilled.events.filter((event) => event.kind === "PLAYER_ELIMINATED")).toHaveLength(3);
    expect(refilled.events.filter((event) => event.kind === "PLAYER_SEATED")).toHaveLength(3);
  });

  it("folds a leaving player and fills the seat after the hand", () => {
    let state = startMatch(players, orderedDeck(), 1_000, "decision-1").state;
    state.waitingPlayers = [{ agentId: "queued-1", displayName: "Queued 1", stack: GAME_CONFIG.startingStack }];

    const left = leaveGame(state, "agent-3", 1_001, "decision-2");
    state = left.state;
    expect(state.players[3]).toMatchObject({ stack: 0, folded: true, leaving: true });
    expect(state.decision).toMatchObject({ id: "decision-2", seat: 0 });
    expect(left.events[0].message).toContain("folded and is leaving");

    state = act(state, "decision-2", "fold", 0, 1_002, "decision-3").state;
    state = act(state, "decision-3", "fold", 0, 1_003, "decision-4").state;
    const refilled = refillTable(state);

    expect(refilled.state.players.find((player) => player.agentId === "agent-3")).toBeUndefined();
    expect(refilled.state.players.find((player) => player.agentId === "queued-1"))
      .toMatchObject({ seat: 3, stack: GAME_CONFIG.startingStack });
    expect(refilled.events).toContainEqual(expect.objectContaining({ kind: "PLAYER_LEFT", agentId: "agent-3" }));
  });

  it("allows a player to leave before their turn without changing the current decision", () => {
    const state = startMatch(players, orderedDeck(), 1_000, "decision-1").state;
    const left = leaveGame(state, "agent-1", 1_001, "decision-2").state;

    expect(left.players[1]).toMatchObject({ stack: 0, folded: true, leaving: true });
    expect(left.decision).toEqual(state.decision);
  });

  it("does not settle the hand twice when a folded player leaves during showdown", () => {
    let state = startMatch(players, orderedDeck(), 1_000, "decision-1").state;
    state = act(state, "decision-1", "fold", 0, 1_001, "decision-2").state;
    state = act(state, "decision-2", "fold", 0, 1_002, "decision-3").state;
    state = act(state, "decision-3", "fold", 0, 1_003, "decision-4").state;
    const result = state.result;

    const left = leaveGame(state, "agent-3", 1_004, "decision-5").state;

    expect(left.result).toBe(result);
    expect(left.resumeAt).toBe(state.resumeAt);
  });

  it("rejects a consumed decision", () => {
    const state = startMatch(players, orderedDeck(), 1_000, "decision-1").state;
    const next = act(state, "decision-1", "call", 0, 1_001, "decision-2").state;

    expect(() => act(next, "decision-1", "call", 0, 1_002, "decision-3"))
      .toThrow("decision is no longer current");
  });

  it("kicks a player after ten consecutive timeouts and resets the count after acting", () => {
    let state = startMatch(players, orderedDeck(), 1_000, "decision-1").state;
    state.players[3].consecutiveTimeouts = 9;
    const kicked = timeout(state, state.decision!.deadline, "decision-2");

    expect(kicked).toMatchObject({ kicked: true, consecutiveTimeouts: 10 });
    expect(kicked.state.players[3]).toMatchObject({ folded: true, leaving: true, stack: 0 });
    expect(kicked.events).toContainEqual(expect.objectContaining({ kind: "PLAYER_KICKED", agentId: "agent-3" }));

    state = startMatch(players, orderedDeck(), 1_000, "decision-3").state;
    state.players[3].consecutiveTimeouts = 9;
    const acted = act(state, "decision-3", "call", 0, 1_001, "decision-4");
    expect(acted.state.players[3].consecutiveTimeouts).toBe(0);
  });

  it("starts the next hand when three players fold", () => {
    let state = startMatch(players, orderedDeck(), 1_000, "decision-1").state;
    state = act(state, "decision-1", "fold", 0, 1_001, "decision-2").state;
    state = act(state, "decision-2", "fold", 0, 1_002, "decision-3").state;
    const completed = act(state, "decision-3", "fold", 0, 1_003, "decision-4");
    state = completed.state;

    expect(state.status).toBe("PLAYING");
    expect(state.street).toBe("SHOWDOWN");
    expect(state.handNumber).toBe(1);
    expect(state.players.reduce((sum, player) => sum + player.stack + player.totalBet, 0)).toBe(totalChips);
    expect(state.result).toContain("won 15");
    expect(completed.events.some((event) => event.message.includes("won 15"))).toBe(true);
    expect(completed.events.find((event) => event.kind === "HAND_COMPLETED")?.scoreDeltas).toEqual({
      "agent-0": 0,
      "agent-1": -5,
      "agent-2": 5,
      "agent-3": 0,
    });
    expect(state.lastRevealed).toEqual({});

    state = startNextHand(refillTable(state).state, winningDeck(), 2_000, "decision-5").state;
    expect(state.handNumber).toBe(2);
    expect(state.result).toBe("");
    expect(state.players.every((player) => !player.folded)).toBe(true);
  });

  it("does not mutate the input state", () => {
    const state = startMatch(players, orderedDeck(), 1_000, "decision-1").state;
    const before = structuredClone(state);
    act(state, "decision-1", "call", 0, 1_001, "decision-2");
    expect(state).toEqual(before);
  });

  it("settles multiple all-in side pots without losing chips", () => {
    let state = startMatch(players, winningDeck(), 1_000, "decision-1").state;
    state.players[3].stack = 20;
    state.players[0].stack = 40;
    state.players[1].stack = 55;
    state.players[2].stack = 270;

    state = act(state, "decision-1", "raise", 20, 1_001, "decision-2").state;
    state = act(state, "decision-2", "raise", 40, 1_002, "decision-3").state;
    state = act(state, "decision-3", "call", 0, 1_003, "decision-4").state;
    state = act(state, "decision-4", "raise", 280, 1_004, "decision-5").state;
    const completed = act(state, "decision-5", "call", 0, 1_005, "decision-6");
    state = completed.state;

    expect(state.players.reduce((sum, player) => sum + player.stack + player.totalBet, 0)).toBe(400);
    expect(state.result).toContain("won");
    expect(completed.events.some((event) => event.message.includes("won"))).toBe(true);
    expect(state.handNumber).toBeGreaterThanOrEqual(1);
  });

  it("keeps a full big-blind opening bet when the big blind is short", () => {
    let state = startMatch(players, orderedDeck(), 1_000, "decision-1").state;
    state.players[3].stack = 3;
    state.players[0].stack = 197;
    state = act(state, "decision-1", "fold", 0, 1_001, "decision-2").state;
    state = act(state, "decision-2", "fold", 0, 1_002, "decision-3").state;
    state = act(state, "decision-3", "fold", 0, 1_003, "decision-4").state;
    state = startNextHand(refillTable(state).state, winningDeck(), 2_000, "decision-5").state;

    expect(state.handNumber).toBe(2);
    expect(state.players[3].totalBet).toBe(3);
    expect(state.currentBet).toBe(10);
    expect(legalActions(state, state.decision!.seat)).toMatchObject({
      callAmount: 10,
      minRaiseTo: 20,
    });
  });
});

function orderedDeck(): number[] {
  return Array.from({ length: 52 }, (_, index) => index);
}

function winningDeck(): number[] {
  const firstCards = [2, 7, 48, 11, 15, 19, 44, 23, 40, 36, 32, 1, 6];
  return [...firstCards, ...orderedDeck().filter((card) => !firstCards.includes(card))];
}
