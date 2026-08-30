type TableRow = {
  table_id: string;
  display_name: string;
};

type MembershipRow = {
  agent_id: string;
  table_id: string;
  status: "SEATED" | "QUEUED";
};

export class LobbyRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  gameEnabled(): boolean {
    return this.storage.sql.exec<{ enabled: number }>(
      "SELECT enabled FROM game WHERE id = 1",
    ).one().enabled === 1;
  }

  switchGame(enabled: boolean, now: number): void {
    this.storage.sql.exec(
      "UPDATE game SET enabled = ?, updated_at = ? WHERE id = 1",
      enabled ? 1 : 0,
      now,
    );
  }

  tables(): TableRow[] {
    return this.storage.sql.exec<TableRow>(
      `SELECT table_id, display_name
       FROM tables ORDER BY created_at, table_id`,
    ).toArray();
  }

  table(tableId: string): TableRow | undefined {
    return this.storage.sql.exec<TableRow>(
      `SELECT table_id, display_name
       FROM tables WHERE table_id = ?`,
      tableId,
    ).toArray()[0];
  }

  insertTable(tableId: string, displayName: string, creatorAgentId: string, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO tables
       (table_id, display_name, created_by_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      tableId,
      displayName,
      creatorAgentId,
      now,
      now,
    );
  }

  membership(agentId: string): MembershipRow | undefined {
    return this.storage.sql.exec<MembershipRow>(
      "SELECT agent_id, table_id, status FROM memberships WHERE agent_id = ?",
      agentId,
    ).toArray()[0];
  }

  setMembership(
    agentId: string,
    tableId: string,
    status: MembershipRow["status"],
    now: number,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO memberships (agent_id, table_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         table_id = excluded.table_id, status = excluded.status, updated_at = excluded.updated_at`,
      agentId,
      tableId,
      status,
      now,
      now,
    );
  }

  deleteMembership(agentId: string): void {
    this.storage.sql.exec("DELETE FROM memberships WHERE agent_id = ?", agentId);
  }

  syncMemberships(
    tableIds: string[],
    memberships: Array<{
      agentId: string;
      tableId: string;
      status: MembershipRow["status"];
    }>,
    now: number,
  ): void {
    if (tableIds.length === 0) return;
    const expected = JSON.stringify(memberships);
    // Timeout processing can remove players from a table, so delete stale membership rows
    // that are absent from the latest game state before upserting the current memberships.
    this.storage.sql.exec(
      `DELETE FROM memberships
       WHERE table_id IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?)
           WHERE json_extract(value, '$.agentId') = memberships.agent_id
             AND json_extract(value, '$.tableId') = memberships.table_id
         )`,
      JSON.stringify(tableIds),
      expected,
    );
    this.storage.sql.exec(
      `INSERT INTO memberships (agent_id, table_id, status, created_at, updated_at)
       SELECT json_extract(value, '$.agentId'),
              json_extract(value, '$.tableId'),
              json_extract(value, '$.status'), ?, ?
       FROM json_each(?) WHERE true
       ON CONFLICT(agent_id) DO UPDATE SET
         table_id = excluded.table_id, status = excluded.status, updated_at = excluded.updated_at`,
      now,
      now,
      expected,
    );
  }

  clearTables(): void {
    this.storage.sql.exec("DELETE FROM memberships");
    this.storage.sql.exec("DELETE FROM game_events WHERE table_id IS NOT NULL");
    this.storage.sql.exec("DELETE FROM table_states");
    this.storage.sql.exec("DELETE FROM tables");
  }
}
