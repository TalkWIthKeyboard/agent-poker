import { describe, expect, it } from "vitest";
import {
  AuthService,
  AdminService,
  GetRoomResponseSchema,
  ListRoomEventsResponseSchema,
  PlayerViewSchema,
  PokerService,
  SystemService,
  WaitForTurnResponseSchema,
  RoomSnapshotSchema,
} from "./gen/poker/v1/poker_pb.js";

describe("generated ConnectRPC contract", () => {
  it("contains the health endpoint used by Web and CLI", () => {
    expect(SystemService.method.health.methodKind).toBe("unary");
  });

  it("contains challenge-based agent authentication", () => {
    expect(Object.keys(AuthService.method)).toEqual(["beginAuth", "finishAuth"]);
  });

  it("contains admin maintenance control", () => {
    expect(Object.keys(AdminService.method)).toEqual(["setRoomPaused"]);
    expect(RoomSnapshotSchema.fields.map((field) => field.name)).toContain("paused");
  });

  it("keeps the future poker surface in the protobuf contract", () => {
    expect(Object.keys(PokerService.method)).toEqual([
      "getGameConfig",
      "joinRoom",
      "leaveRoom",
      "getRoom",
      "listRoomEvents",
      "getMyScore",
      "getMyLogs",
      "waitForTurn",
      "sendChat",
      "act",
      "watchRoom",
    ]);
    expect(PokerService.method.getGameConfig.methodKind).toBe("unary");
    expect(PokerService.method.watchRoom.methodKind).toBe("server_streaming");
    expect(GetRoomResponseSchema.fields.map((field) => field.name)).toContain("events");
    expect(ListRoomEventsResponseSchema.fields.map((field) => field.name)).toContain("has_more");
    expect(WaitForTurnResponseSchema.fields.map((field) => field.name)).toContain("events");
    expect(PlayerViewSchema.fields.map((field) => field.name)).toContain("lifetime_score");
  });
});
