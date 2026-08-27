import { describe, expect, it } from "vitest";
import { act, legalActions, startMatch } from "./game.js";

const players = Array.from({ length: 4 }, (_, seat) => ({
  agentId: `agent-${seat}`,
  displayName: `Player ${seat}`,
  seat,
}));

describe("poker game", () => {
  it("posts blinds and starts with the seat after the big blind", () => {
    const { state } = startMatch(players, orderedDeck(), 1_000, "match-1", "decision-1");

    expect(state.dealerSeat).toBe(0);
    expect(state.players[1].streetBet).toBe(5);
    expect(state.players[2].streetBet).toBe(10);
    expect(state.decision?.seat).toBe(3);
    expect(legalActions(state, 3)).toEqual({
      actions: ["fold", "call", "raise"],
      callAmount: 10,
      minRaiseTo: 20,
      maxRaiseTo: 100,
    });
  });

  it("finishes a four-way all-in match and conserves chips", () => {
    let state = startMatch(players, winningDeck(), 1_000, "match-1", "decision-1").state;
    state = act(state, "decision-1", "raise", 100, 1_001, "decision-2", orderedDeck()).state;
    state = act(state, "decision-2", "call", 0, 1_002, "decision-3", orderedDeck()).state;
    state = act(state, "decision-3", "call", 0, 1_003, "decision-4", orderedDeck()).state;
    state = act(state, "decision-4", "call", 0, 1_004, "decision-5", orderedDeck()).state;

    expect(state.status).toBe("COMPLETE");
    expect(state.players.reduce((sum, player) => sum + player.stack + player.totalBet, 0)).toBe(400);
    expect(state.players.filter((player) => player.stack > 0)).toHaveLength(1);
    expect(state.players.reduce((sum, player) => sum + player.totalBet, 0)).toBe(0);
    expect(Object.keys(state.lastRevealed)).toHaveLength(4);
  });

  it("rejects a consumed decision", () => {
    const state = startMatch(players, orderedDeck(), 1_000, "match-1", "decision-1").state;
    const next = act(state, "decision-1", "call", 0, 1_001, "decision-2", orderedDeck()).state;

    expect(() => act(next, "decision-1", "call", 0, 1_002, "decision-3", orderedDeck()))
      .toThrow("decision is no longer current");
  });

  it("starts the next hand when three players fold", () => {
    let state = startMatch(players, orderedDeck(), 1_000, "match-1", "decision-1").state;
    state = act(state, "decision-1", "fold", 0, 1_001, "decision-2", winningDeck()).state;
    state = act(state, "decision-2", "fold", 0, 1_002, "decision-3", winningDeck()).state;
    const completed = act(state, "decision-3", "fold", 0, 1_003, "decision-4", winningDeck());
    state = completed.state;

    expect(state.status).toBe("PLAYING");
    expect(state.handNumber).toBe(2);
    expect(state.players.reduce((sum, player) => sum + player.stack + player.totalBet, 0)).toBe(400);
    expect(state.result).toBe("");
    expect(state.players.filter((player) => player.stack > 0).every((player) => !player.folded)).toBe(true);
    expect(completed.events.some((event) => event.message.includes("won 15"))).toBe(true);
    expect(state.lastRevealed).toEqual({});
  });

  it("does not mutate the input state", () => {
    const state = startMatch(players, orderedDeck(), 1_000, "match-1", "decision-1").state;
    const before = structuredClone(state);
    act(state, "decision-1", "call", 0, 1_001, "decision-2", winningDeck());
    expect(state).toEqual(before);
  });

  it("settles multiple all-in side pots without losing chips", () => {
    let state = startMatch(players, winningDeck(), 1_000, "match-1", "decision-1").state;
    state.players[3].stack = 20;
    state.players[0].stack = 40;
    state.players[1].stack = 55;
    state.players[2].stack = 270;

    state = act(state, "decision-1", "raise", 20, 1_001, "decision-2", orderedDeck()).state;
    state = act(state, "decision-2", "raise", 40, 1_002, "decision-3", orderedDeck()).state;
    state = act(state, "decision-3", "call", 0, 1_003, "decision-4", orderedDeck()).state;
    state = act(state, "decision-4", "raise", 280, 1_004, "decision-5", orderedDeck()).state;
    const completed = act(state, "decision-5", "call", 0, 1_005, "decision-6", orderedDeck());
    state = completed.state;

    expect(state.players.reduce((sum, player) => sum + player.stack + player.totalBet, 0)).toBe(400);
    expect(state.result).toBe("");
    expect(completed.events.some((event) => event.message.includes("won"))).toBe(true);
    expect(state.handNumber).toBeGreaterThanOrEqual(1);
  });

  it("keeps a full big-blind opening bet when the big blind is short", () => {
    let state = startMatch(players, orderedDeck(), 1_000, "match-1", "decision-1").state;
    state.players[3].stack = 3;
    state.players[0].stack = 197;
    state = act(state, "decision-1", "fold", 0, 1_001, "decision-2", winningDeck()).state;
    state = act(state, "decision-2", "fold", 0, 1_002, "decision-3", winningDeck()).state;
    state = act(state, "decision-3", "fold", 0, 1_003, "decision-4", winningDeck()).state;

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
