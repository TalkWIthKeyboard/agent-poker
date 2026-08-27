import { describe, expect, it } from "vitest";
import { RoomStatus } from "../gen/poker/v1/poker_pb.js";
import { playerDisplayState, playerStateLabel } from "./player-state.js";

describe("player display state", () => {
  it("shows a zero-stack player as all-in until the hand is settled", () => {
    const state = playerDisplayState(
      RoomStatus.PLAYING,
      { stack: 0n, folded: false, allIn: true },
      false,
    );

    expect(state).toBe("all-in");
    expect(playerStateLabel(state)).toBe("ALL IN");
  });

  it("shows a zero-stack player as eliminated after the hand", () => {
    const state = playerDisplayState(
      RoomStatus.PLAYING,
      { stack: 0n, folded: false, allIn: false },
      false,
    );

    expect(state).toBe("eliminated");
    expect(playerStateLabel(state)).toBe("OUT OF MATCH");
  });

  it("restores an all-in winner to the normal next-hand state", () => {
    expect(playerDisplayState(
      RoomStatus.PLAYING,
      { stack: 50n, folded: false, allIn: false },
      false,
    )).toBe("ready");
  });

  it("keeps fold scoped to the current hand", () => {
    expect(playerDisplayState(
      RoomStatus.PLAYING,
      { stack: 50n, folded: true, allIn: false },
      false,
    )).toBe("folded");
    expect(playerDisplayState(
      RoomStatus.PLAYING,
      { stack: 50n, folded: false, allIn: false },
      false,
    )).toBe("ready");
  });
});
