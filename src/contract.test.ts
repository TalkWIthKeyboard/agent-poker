import { describe, expect, it } from "vitest";
import { AuthService, PokerService, SystemService } from "./gen/poker/v1/poker_pb.js";

describe("generated ConnectRPC contract", () => {
  it("contains the health endpoint used by Web and CLI", () => {
    expect(SystemService.method.health.methodKind).toBe("unary");
  });

  it("contains challenge-based agent authentication", () => {
    expect(Object.keys(AuthService.method)).toEqual(["beginAuth", "finishAuth"]);
  });

  it("keeps the future poker surface in the protobuf contract", () => {
    expect(Object.keys(PokerService.method)).toEqual([
      "joinRoom",
      "leaveRoom",
      "getRoom",
      "waitForTurn",
      "act",
      "watchRoom",
    ]);
    expect(PokerService.method.watchRoom.methodKind).toBe("server_streaming");
  });
});
