import { describe, expect, it } from "vitest";
import { TableStatus } from "../gen/poker/v1/entity_pb.js";
import { playerDisplayState, playerStateLabel } from "./player-state.js";

describe("player display state", () => {
  it.each([
    { player: { stack: 0n, folded: false, allIn: true }, expected: "all-in", label: "ALL IN" },
    { player: { stack: 0n, folded: false, allIn: false }, expected: "eliminated", label: "OUT OF MATCH" },
    { player: { stack: 50n, folded: false, allIn: false }, expected: "ready", label: "READY" },
    { player: { stack: 50n, folded: true, allIn: false }, expected: "folded", label: "OUT OF THIS HAND" },
  ])("maps $expected", ({ player, expected, label }) => {
    const state = playerDisplayState(TableStatus.PLAYING, player, false);
    expect(state).toBe(expected);
    expect(playerStateLabel(state)).toBe(label);
  });
});
