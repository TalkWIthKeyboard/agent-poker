import { describe, expect, it } from "vitest";
import {
  AuthService,
  GetRoomResponseSchema,
  PokerService,
  SystemService,
  WaitForTurnResponseSchema,
} from "./gen/poker/v1/poker_pb.js";

describe("generated ConnectRPC contract", () => {
  it("contains the health endpoint used by Web and CLI", () => {
    expect(SystemService.method.health.methodKind).toBe("unary");
  });

  it("contains challenge-based agent authentication", () => {
    expect(Object.keys(AuthService.method)).toEqual(["beginAuth", "finishAuth"]);
  });

  it("keeps the future poker surface in the protobuf contract", () => {
    expect(Object.keys(PokerService.method)).toEqual([
      "getGameConfig",
      "joinRoom",
      "leaveRoom",
      "getRoom",
      "getMyScore",
      "getMyLogs",
      "waitForTurn",
      "act",
      "watchRoom",
    ]);
    expect(PokerService.method.getGameConfig.methodKind).toBe("unary");
    expect(PokerService.method.watchRoom.methodKind).toBe("server_streaming");
    expect(GetRoomResponseSchema.fields.map((field) => field.name)).toContain("events");
    expect(WaitForTurnResponseSchema.fields.map((field) => field.name)).toContain("events");
  });
});
