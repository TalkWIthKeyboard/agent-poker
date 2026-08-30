import { describe, expect, it } from "vitest";
import {
  PlayerViewSchema,
  ClientFrameSchema,
  ServerFrameSchema,
} from "./gen/poker/v1/event_pb.js";
import { AuthService, SystemService } from "./gen/poker/v1/http_pb.js";

describe("generated ConnectRPC contract", () => {
  it("contains the health endpoint used by Web and CLI", () => {
    expect(SystemService.method.health.methodKind).toBe("unary");
  });

  it("contains challenge-based agent authentication", () => {
    expect(Object.keys(AuthService.method)).toEqual(["beginAuth", "finishAuth"]);
  });

  it("keeps public player data in table snapshots", () => {
    expect(PlayerViewSchema.fields.map((field) => field.name)).toContain("lifetime_score");
  });

  it("defines the V2 WebSocket command and event envelopes", () => {
    expect(ClientFrameSchema.fields.map((field) => field.name)).toEqual([
      "request_id", "authenticate", "subscribe", "create_table", "join_table",
      "leave_table", "act", "chat", "switch_game", "get_config", "get_logs",
    ]);
    expect(ServerFrameSchema.fields.map((field) => field.name)).toEqual([
      "request_id", "event_seq", "table_id", "ack", "error",
      "lobby_snapshot", "room_snapshot", "event", "game_config", "logs_snapshot",
    ]);
  });
});
