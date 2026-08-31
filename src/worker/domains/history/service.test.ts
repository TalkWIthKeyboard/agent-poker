import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HistoryService } from "./service.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../migrations/0001_initial.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../migrations/0002_hand_history.sql", import.meta.url), "utf8"));
  const insertAgent = db.prepare(
    `INSERT INTO agents
     (agent_id, public_key, display_name, last_authenticated_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1, 1)`,
  );
  insertAgent.run("hero", new Uint8Array([1]), "Hero");
  insertAgent.run("villain", new Uint8Array([2]), "Villain");
  db.prepare(
    `INSERT INTO tables
     (table_id, display_name, created_by_agent_id, created_at, updated_at)
     VALUES ('table-1', 'Table 1', 'hero', 1, 1)`,
  ).run();
  const insertHand = db.prepare(
    `INSERT INTO hands
     (table_id, hand_number, small_blind, big_blind,
      dealer_seat, small_blind_seat, big_blind_seat, board_json, result,
      pots_json, started_at, ended_at, created_at, updated_at)
     VALUES ('table-1', ?, 5, 10, 0, 0, 1, '["Ah","7c","2s"]', ?,
             '[{"amount":20,"winners":[{"agentId":"hero","amount":20}]}]',
             ?, ?, ?, ?)`,
  );
  insertHand.run(1, "Hero won 20", 10, 20, 20, 20);
  insertHand.run(2, "Hero won 20", 30, 40, 40, 40);

  const insertPlayer = db.prepare(
    `INSERT INTO hand_players
     (hand_id, agent_id, seat, starting_stack, ending_stack, hole_cards_json,
      revealed, showdown_rank, created_at, updated_at)
     VALUES (?, ?, ?, 100, ?, ?, ?, NULL, 1, 1)`,
  );
  for (const handId of [1, 2]) {
    insertPlayer.run(handId, "hero", 0, 110, '["As","Kd"]', 0);
    insertPlayer.run(handId, "villain", 1, 90, '["Qh","Qs"]', 0);
  }

  const insertAction = db.prepare(
    `INSERT INTO hand_actions
     (hand_id, seq, agent_id, street, action, amount, bet_to, pot_after,
      stack_after, automatic, pot_before, stack_before, legal_actions_json,
      call_amount, min_raise_to, max_raise_to, reason, response_time_ms,
      created_at, updated_at)
     VALUES (2, ?, ?, 'PREFLOP', ?, 10, 10, ?, 90, 0, 10, 100,
             '["FOLD","CALL","RAISE"]', 10, 20, 100, ?, 500, ?, ?)`,
  );
  insertAction.run(1, "hero", "CALL", 20, "Hero reason", 31, 31);
  insertAction.run(2, "villain", "RAISE", 30, "Villain reason", 32, 32);

  const service = new HistoryService({
    sql: {
      exec<T extends Record<string, SqlStorageValue>>(
        query: string,
        ...bindings: SqlStorageValue[]
      ) {
        const rows = db.prepare(query).all(
          ...bindings as Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>,
        ) as T[];
        return { toArray: () => rows };
      },
    },
  } as unknown as Pick<DurableObjectStorage, "sql">);
  return { service };
}

describe("HistoryService", () => {
  it("pages complete hands while hiding opponent private data", () => {
    const { service } = setup();
    const first = service.myHistory("hero", undefined, 1);

    expect(first.hands).toHaveLength(1);
    expect(first.hands[0].hand.handNumber).toBe(2);
    expect(first.hands[0].players.find((player) => player.agentId === "hero")?.holeCards)
      .toEqual([{ rank: "A", suit: "s" }, { rank: "K", suit: "d" }]);
    expect(first.hands[0].players.find((player) => player.agentId === "villain")?.holeCards)
      .toEqual([]);
    expect(first.hands[0].actions[0].decision?.reason).toBe("Hero reason");
    expect(first.hands[0].actions[1].decision).toBeUndefined();

    expect(service.myHistory("hero", Number(first.nextCursor), 1).hands[0].hand.handNumber).toBe(1);
  });

  it("bounds the requested page size", () => {
    expect(() => setup().service.myHistory("hero", undefined, 21)).toThrow(/1 to 20/);
  });
});
