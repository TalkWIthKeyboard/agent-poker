import type { GameState } from "../game.js";
import type { EventData } from "./app.js";
import initialMigration from "./migrations/0001_initial.sql";

export interface AgentRow {
  [key: string]: SqlStorageValue;
  agent_id: string;
  display_name: string;
  created_at: number;
}

export interface ChallengeRow {
  [key: string]: SqlStorageValue;
  public_key: ArrayBuffer;
  challenge: ArrayBuffer;
  expires_at: number;
  consumed_at: number | null;
}

interface StateRow {
  [key: string]: SqlStorageValue;
  state_json: string;
  state_version: number;
}

export class PokerRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  migrate(initialState: string): void {
    this.storage.sql.exec(initialMigration);
    const now = Date.now();
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO schema_metadata
       (id, version, created_at, updated_at) VALUES (1, 1, ?, ?)`,
      now,
      now,
    );
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO room_state
       (id, state_version, state_json, created_at, updated_at) VALUES (1, 0, ?, ?, ?)`,
      initialState,
      now,
      now,
    );
  }

  transaction<T>(work: () => T): T {
    return this.storage.transactionSync(work);
  }

  insertChallenge(
    challengeId: string,
    publicKey: Uint8Array,
    challenge: Uint8Array,
    expiresAt: number,
    now: number,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO auth_challenges
       (challenge_id, public_key, challenge, expires_at, consumed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      challengeId,
      publicKey,
      challenge,
      expiresAt,
      now,
      now,
    );
  }

  challenge(challengeId: string): ChallengeRow | undefined {
    return this.storage.sql.exec<ChallengeRow>(
      `SELECT public_key, challenge, expires_at, consumed_at
       FROM auth_challenges WHERE challenge_id = ?`,
      challengeId,
    ).toArray()[0];
  }

  completeAuth(input: {
    challengeId: string;
    agentId: string;
    publicKey: Uint8Array;
    displayName: string;
    now: number;
    tokenHash: string;
    expiresAt: number;
  }): AgentRow {
    return this.transaction(() => {
      const consumed = this.storage.sql.exec(
        `UPDATE auth_challenges SET consumed_at = ?, updated_at = ?
         WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        input.now,
        input.now,
        input.challengeId,
        input.now,
      );
      if (consumed.rowsWritten !== 1) throw new Error("FAILED_PRECONDITION: challenge was already consumed");

      const existing = this.storage.sql.exec<AgentRow>(
        "SELECT agent_id, display_name, created_at FROM agents WHERE agent_id = ?",
        input.agentId,
      ).toArray()[0];
      if (existing) {
        this.storage.sql.exec(
          "UPDATE agents SET last_authenticated_at = ?, updated_at = ? WHERE agent_id = ?",
          input.now,
          input.now,
          input.agentId,
        );
      } else {
        this.storage.sql.exec(
          `INSERT INTO agents
           (agent_id, public_key, display_name, last_authenticated_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          input.agentId,
          input.publicKey,
          input.displayName,
          input.now,
          input.now,
          input.now,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO sessions
         (token_hash, agent_id, expires_at, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
        input.tokenHash,
        input.agentId,
        input.expiresAt,
        input.now,
        input.now,
      );
      return existing ?? {
        agent_id: input.agentId,
        display_name: input.displayName,
        created_at: input.now,
      };
    });
  }

  agentForSession(tokenHash: string, now: number): AgentRow | undefined {
    return this.storage.sql.exec<AgentRow>(
      `SELECT agents.agent_id, agents.display_name, agents.created_at
       FROM sessions JOIN agents ON agents.agent_id = sessions.agent_id
       WHERE sessions.token_hash = ?
         AND sessions.expires_at > ?
         AND sessions.revoked_at IS NULL`,
      tokenHash,
      now,
    ).toArray()[0];
  }

  loadState(): { state: GameState; version: number } {
    const row = this.storage.sql.exec<StateRow>(
      "SELECT state_json, state_version FROM room_state WHERE id = 1",
    ).one();
    return { state: JSON.parse(row.state_json) as GameState, version: row.state_version };
  }

  saveState(input: {
    state: GameState;
    expectedVersion: number;
    events: EventData[];
    privateKind: string;
    decisionId?: string;
    privatePayload: object;
    now: number;
  }): void {
    const { state } = input;
    this.storage.sql.exec(
      `INSERT INTO game_events
       (public_seq, decision_id, event_json, created_at, updated_at)
       VALUES (NULL, ?, ?, ?, ?)`,
      input.decisionId ?? null,
      JSON.stringify({
        kind: input.privateKind,
        decisionId: input.decisionId,
        ...input.privatePayload,
        state,
      }),
      input.now,
      input.now,
    );

    if (state.decision) {
      this.storage.sql.exec(
        `INSERT INTO game_events
         (public_seq, decision_id, event_json, created_at, updated_at)
         VALUES (NULL, NULL, ?, ?, ?)`,
        JSON.stringify({
          kind: "DECISION_OPENED",
          decisionId: state.decision.id,
          agentId: state.players.find((player) => player.seat === state.decision?.seat)?.agentId,
          decision: state.decision,
        }),
        input.now,
        input.now,
      );
    }

    for (const event of input.events) {
      this.storage.sql.exec(
        `INSERT INTO game_events
         (public_seq, decision_id, event_json, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?)`,
        event.seq,
        JSON.stringify(event),
        input.now,
        input.now,
      );
    }

    const updated = this.storage.sql.exec(
      `UPDATE room_state SET state_version = ?, state_json = ?, updated_at = ?
       WHERE id = 1 AND state_version = ?`,
      input.expectedVersion + 1,
      JSON.stringify(state),
      input.now,
      input.expectedVersion,
    );
    if (updated.rowsWritten !== 1) throw new Error("FAILED_PRECONDITION: room state changed concurrently");
  }

  eventsAfter(after: number): EventData[] {
    return this.storage.sql.exec<{ event_json: string }>(
      `SELECT event_json
       FROM game_events WHERE public_seq > ? ORDER BY public_seq LIMIT 100`,
      after,
    ).toArray().map((row) => JSON.parse(row.event_json) as EventData);
  }
}
