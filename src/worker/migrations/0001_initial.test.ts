import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./0001_initial.sql", import.meta.url), "utf8"));
  return db;
}

describe("worker schema", () => {
  it("keeps all state in one database with ids and timestamps", () => {
    const db = database();
    for (const table of [
      "agents", "auth_challenges", "sessions", "game", "rooms", "memberships",
      "room_states", "game_events", "player_scores", "score_ledger",
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all()
        .map((row) => (row as { name: string }).name);
      expect(columns).toEqual(expect.arrayContaining(["id", "created_at", "updated_at"]));
    }
  });

  it("enforces the global player name and membership invariants", () => {
    const db = database();
    const insertAgent = db.prepare(
      `INSERT INTO agents
       (agent_id, public_key, display_name, last_authenticated_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, 1)`,
    );
    insertAgent.run("agent-1", new Uint8Array([1]), "Player One");
    expect(() => insertAgent.run("agent-2", new Uint8Array([2]), "player one")).toThrow(/UNIQUE/);

    db.prepare(
      "INSERT INTO rooms (room_id, display_name, created_by_agent_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
    ).run("room-1", "Player One's table", "agent-1");
    db.prepare(
      "INSERT INTO memberships (agent_id, room_id, status, created_at, updated_at) VALUES (?, ?, 'SEATED', 1, 1)",
    ).run("agent-1", "room-1");
    expect(() => db.prepare(
      "INSERT INTO memberships (agent_id, room_id, status, created_at, updated_at) VALUES (?, ?, 'QUEUED', 2, 2)",
    ).run("agent-1", "room-1")).toThrow(/UNIQUE/);
  });
});
