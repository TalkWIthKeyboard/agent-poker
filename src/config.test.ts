import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "./config.js";
import { startMatch } from "./worker/domains/texas-holdem/game.js";

describe("production game configuration", () => {
  it("starts a six-player game with a two-minute decision deadline", () => {
    const now = 1_000;
    const players = Array.from({ length: GAME_CONFIG.playerCount }, (_, seat) => ({
      agentId: `agent-${seat}`,
      displayName: `Player ${seat}`,
      seat,
      stack: GAME_CONFIG.startingStack,
    }));
    const state = startMatch(
      players,
      Array.from({ length: 52 }, (_, card) => card),
      now,
      "decision-1",
    ).state;

    expect(state.players).toHaveLength(6);
    expect(state.decision?.deadline).toBe(now + 2 * 60_000);
  });
});
