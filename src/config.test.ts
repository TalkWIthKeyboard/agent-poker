import { describe, expect, it } from "vitest";
import { GAME_CONFIG } from "./config.js";
import { startMatch } from "./game.js";

describe("production game configuration", () => {
  it("starts a seven-player game with a two-minute decision deadline", () => {
    const now = 1_000;
    const players = Array.from({ length: GAME_CONFIG.playerCount }, (_, seat) => ({
      agentId: `agent-${seat}`,
      displayName: `Player ${seat}`,
      seat,
    }));
    const state = startMatch(
      players,
      Array.from({ length: 52 }, (_, card) => card),
      now,
      "match-1",
      "decision-1",
    ).state;

    expect(state.players).toHaveLength(7);
    expect(state.decision?.deadline).toBe(now + 2 * 60_000);
  });
});
