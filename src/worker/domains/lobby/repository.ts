type RoomRow = {
  room_id: string;
  display_name: string;
};

type MembershipRow = {
  agent_id: string;
  room_id: string;
  status: "SEATED" | "QUEUED";
};

export class LobbyRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  gameEnabled(): boolean {
    return this.storage.sql.exec<{ enabled: number }>(
      "SELECT enabled FROM game WHERE id = 1",
    ).one().enabled === 1;
  }

  setGameEnabled(enabled: boolean, now: number): void {
    this.storage.sql.exec(
      "UPDATE game SET enabled = ?, updated_at = ? WHERE id = 1",
      enabled ? 1 : 0,
      now,
    );
  }

  rooms(): RoomRow[] {
    return this.storage.sql.exec<RoomRow>(
      `SELECT room_id, display_name
       FROM rooms ORDER BY created_at, room_id`,
    ).toArray();
  }

  room(roomId: string): RoomRow | undefined {
    return this.storage.sql.exec<RoomRow>(
      `SELECT room_id, display_name
       FROM rooms WHERE room_id = ?`,
      roomId,
    ).toArray()[0];
  }

  insertRoom(roomId: string, displayName: string, creatorAgentId: string, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO rooms
       (room_id, display_name, created_by_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      roomId,
      displayName,
      creatorAgentId,
      now,
      now,
    );
  }

  membership(agentId: string): MembershipRow | undefined {
    return this.storage.sql.exec<MembershipRow>(
      "SELECT agent_id, room_id, status FROM memberships WHERE agent_id = ?",
      agentId,
    ).toArray()[0];
  }

  membershipsForRoom(roomId: string): MembershipRow[] {
    return this.storage.sql.exec<MembershipRow>(
      "SELECT agent_id, room_id, status FROM memberships WHERE room_id = ?",
      roomId,
    ).toArray();
  }

  setMembership(
    agentId: string,
    roomId: string,
    status: MembershipRow["status"],
    now: number,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO memberships (agent_id, room_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         room_id = excluded.room_id, status = excluded.status, updated_at = excluded.updated_at`,
      agentId,
      roomId,
      status,
      now,
      now,
    );
  }

  deleteMembership(agentId: string): void {
    this.storage.sql.exec("DELETE FROM memberships WHERE agent_id = ?", agentId);
  }

  clearTables(): void {
    this.storage.sql.exec("DELETE FROM memberships");
    this.storage.sql.exec("DELETE FROM game_events WHERE room_id IS NOT NULL");
    this.storage.sql.exec("DELETE FROM room_states");
    this.storage.sql.exec("DELETE FROM rooms");
  }
}
