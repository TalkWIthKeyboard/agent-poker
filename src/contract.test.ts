import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  PlayerViewSchema,
  TableSnapshotSchema,
} from "./gen/poker/v1/entity_pb.js";
import {
  ClientFrameSchema,
  ServerFrameSchema,
  TableEventSchema,
} from "./gen/poker/v1/event_pb.js";
import {
  AuthService,
  ManagementService,
  PokerService,
  SystemService,
} from "./gen/poker/v1/http_pb.js";

describe("generated ConnectRPC contract", () => {
  it("contains the health endpoint used by Web and CLI", () => {
    expect(SystemService.method.health.methodKind).toBe("unary");
  });

  it("contains challenge-based agent authentication", () => {
    expect(Object.keys(AuthService.method)).toEqual(["beginAuth", "finishAuth"]);
  });

  it("keeps player HTTP queries separate from management", () => {
    expect(Object.keys(PokerService.method)).toEqual([
      "getConfig", "getLobby", "getLeaderboard", "getMe",
    ]);
    expect(Object.keys(ManagementService.method)).toEqual(["switchGame"]);
  });

  it("keeps public player data in table snapshots", () => {
    expect(PlayerViewSchema.fields.map((field) => field.name)).toContain("lifetime_score");
  });

  it("defines the V2 WebSocket command and event envelopes", () => {
    expect(ClientFrameSchema.fields.map((field) => field.name)).toEqual([
      "request_id", "authenticate", "subscribe", "create_table", "join_table",
      "leave_table", "act", "chat",
    ]);
    expect(ServerFrameSchema.fields.map((field) => field.name)).toEqual([
      "request_id", "ack", "error", "table_snapshot", "event", "lobby_changed",
    ]);
    expect(TableSnapshotSchema.fields.map((field) => field.name)).toContain("table_id");
    expect(TableEventSchema.fields.map((field) => field.name)).toContain("table_id");
  });

  it("carries an optional authenticated replay cursor", () => {
    const encoded = toBinary(ClientFrameSchema, create(ClientFrameSchema, {
      requestId: "resume",
      payload: {
        case: "authenticate",
        value: { sessionToken: "token", afterEventSeq: 42n },
      },
    }));
    const decoded = fromBinary(ClientFrameSchema, encoded);
    expect(decoded.payload.case).toBe("authenticate");
    if (decoded.payload.case === "authenticate") {
      expect(decoded.payload.value.afterEventSeq).toBe(42n);
    }
  });
});
