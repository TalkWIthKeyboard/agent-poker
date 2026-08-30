import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { LobbyRepository } from "../domains/lobby/repository.js";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./0001_initial.sql", import.meta.url), "utf8"));
  return db;
}

describe("worker schema", () => {
  it("keeps all state in one database with ids and timestamps", () => {
    const db = database();
    for (const table of [
      "agents", "auth_challenges", "sessions", "game", "tables", "memberships",
      "table_states", "game_events", "player_scores", "score_ledger",
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
      "INSERT INTO tables (table_id, display_name, created_by_agent_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
    ).run("table-1", "Player One's table", "agent-1");
    db.prepare(
      "INSERT INTO memberships (agent_id, table_id, status, created_at, updated_at) VALUES (?, ?, 'SEATED', 1, 1)",
    ).run("agent-1", "table-1");
    expect(() => db.prepare(
      "INSERT INTO memberships (agent_id, table_id, status, created_at, updated_at) VALUES (?, ?, 'QUEUED', 2, 2)",
    ).run("agent-1", "table-1")).toThrow(/UNIQUE/);
  });

  it("syncs memberships for due tables in batches", () => {
    const db = database();
    const insertAgent = db.prepare(
      `INSERT INTO agents
       (agent_id, public_key, display_name, last_authenticated_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, 1)`,
    );
    for (let index = 1; index <= 3; index++) {
      insertAgent.run(`agent-${index}`, new Uint8Array([index]), `Player ${index}`);
    }
    const insertTable = db.prepare(
      `INSERT INTO tables
       (table_id, display_name, created_by_agent_id, created_at, updated_at)
       VALUES (?, ?, 'agent-1', 1, 1)`,
    );
    insertTable.run("table-1", "Table 1");
    insertTable.run("table-2", "Table 2");
    const insertMembership = db.prepare(
      `INSERT INTO memberships
       (agent_id, table_id, status, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`,
    );
    insertMembership.run("agent-1", "table-1", "SEATED");
    insertMembership.run("agent-2", "table-1", "QUEUED");
    insertMembership.run("agent-3", "table-2", "SEATED");

    const storage = {
      sql: {
        exec(query: string, ...bindings: Array<string | number>) {
          const rows = db.prepare(query).all(...bindings);
          return { toArray: () => rows };
        },
      },
    } as unknown as DurableObjectStorage;
    new LobbyRepository(storage).syncMemberships(
      ["table-1"],
      [{ agentId: "agent-2", tableId: "table-1", status: "SEATED" }],
      2,
    );

    expect(db.prepare(
      "SELECT agent_id, table_id, status FROM memberships ORDER BY agent_id",
    ).all()).toEqual([
      { agent_id: "agent-2", table_id: "table-1", status: "SEATED" },
      { agent_id: "agent-3", table_id: "table-2", status: "SEATED" },
    ]);
  });
});
