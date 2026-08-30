import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { GAME_CONFIG } from "../../../config.js";
import { DomainError } from "../../domain-error.js";

interface Row {
  [key: string]: SqlStorageValue;
}

export interface AgentRow extends Row {
  agent_id: string;
  display_name: string;
  score: number;
  created_at: number;
}

interface ChallengeRow extends Row {
  public_key: ArrayBuffer;
  challenge: ArrayBuffer;
  expires_at: number;
  consumed_at: number | null;
}

export interface SessionAgent extends AgentRow {
  expires_at: number;
}

const encoder = new TextEncoder();

export class PlayerService {
  constructor(private readonly storage: DurableObjectStorage) {}

  beginAuth(publicKey: Uint8Array): { challengeId: string; challenge: Uint8Array; expiresAt: number } {
    if (publicKey.byteLength !== 32) {
      throw new DomainError("INVALID_ARGUMENT", "Ed25519 public key must be 32 bytes");
    }
    const challengeId = crypto.randomUUID();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const now = Date.now();
    const expiresAt = now + 60_000;
    this.storage.sql.exec(
      `INSERT INTO auth_challenges
       (challenge_id, public_key, challenge, expires_at, consumed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      challengeId, publicKey, challenge, expiresAt, now, now,
    );
    return { challengeId, challenge, expiresAt };
  }

  async finishAuth(input: {
    challengeId: string;
    publicKey: Uint8Array;
    signature: Uint8Array;
    displayName: string;
  }): Promise<{ agent: AgentRow; sessionToken: string; expiresAt: number }> {
    const challenge = this.storage.sql.exec<ChallengeRow>(
      `SELECT public_key, challenge, expires_at, consumed_at
       FROM auth_challenges WHERE challenge_id = ?`,
      input.challengeId,
    ).toArray()[0];
    if (!challenge) throw new DomainError("NOT_FOUND", "Challenge not found");
    const now = Date.now();
    if (challenge.consumed_at !== null || challenge.expires_at <= now) {
      throw new DomainError("FAILED_PRECONDITION", "Challenge is expired or already used");
    }
    if (input.publicKey.byteLength !== 32 || challenge.public_key.byteLength !== input.publicKey.byteLength
      || !timingSafeEqual(new Uint8Array(challenge.public_key), input.publicKey)) {
      throw new DomainError("PERMISSION_DENIED", "Public key does not match challenge");
    }
    const publicKey = Uint8Array.from(input.publicKey).buffer;
    const key = await crypto.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
    if (!await crypto.subtle.verify("Ed25519", key, Uint8Array.from(input.signature).buffer, challenge.challenge)) {
      throw new DomainError("PERMISSION_DENIED", "Invalid signature");
    }
    const displayName = input.displayName.trim();
    if ([...displayName].length < 1 || [...displayName].length > 64) {
      throw new DomainError("INVALID_ARGUMENT", "Display name must contain 1 to 64 characters");
    }

    const agentId = base64Url(await crypto.subtle.digest("SHA-256", publicKey));
    const sessionToken = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = now + 15 * 60_000;
    const agent = this.completeAuth({
      challengeId: input.challengeId,
      agentId,
      publicKey: input.publicKey,
      displayName,
      tokenHash: await hashToken(sessionToken),
      expiresAt,
      now,
    });
    return { agent, sessionToken, expiresAt };
  }

  async authenticate(sessionToken: string): Promise<SessionAgent> {
    const agent = this.storage.sql.exec<SessionAgent>(
      `SELECT agents.agent_id, agents.display_name, player_scores.score,
              agents.created_at, sessions.expires_at
       FROM sessions
       JOIN agents ON agents.agent_id = sessions.agent_id
       JOIN player_scores ON player_scores.agent_id = agents.agent_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND sessions.revoked_at IS NULL`,
      await hashToken(sessionToken), Date.now(),
    ).toArray()[0];
    if (!agent) throw new DomainError("UNAUTHENTICATED", "Session token is invalid or expired");
    return agent;
  }

  profile(agentId: string): AgentRow | undefined {
    return this.storage.sql.exec<AgentRow>(
      `SELECT agents.agent_id, agents.display_name, player_scores.score, agents.created_at
       FROM agents JOIN player_scores ON player_scores.agent_id = agents.agent_id
       WHERE agents.agent_id = ?`,
      agentId,
    ).toArray()[0];
  }

  leaderboard(): AgentRow[] {
    return this.storage.sql.exec<AgentRow>(
      `SELECT agents.agent_id, agents.display_name, player_scores.score, agents.created_at
       FROM agents JOIN player_scores ON player_scores.agent_id = agents.agent_id
       ORDER BY player_scores.score DESC, agents.created_at, agents.agent_id LIMIT 100`,
    ).toArray();
  }

  private completeAuth(input: {
    challengeId: string;
    agentId: string;
    publicKey: Uint8Array;
    displayName: string;
    tokenHash: string;
    expiresAt: number;
    now: number;
  }): AgentRow {
    return this.storage.transactionSync(() => {
      const consumed = this.storage.sql.exec<{ id: number } & Row>(
        `UPDATE auth_challenges SET consumed_at = ?, updated_at = ?
         WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING id`,
        input.now, input.now, input.challengeId, input.now,
      ).toArray()[0];
      if (!consumed) throw new DomainError("FAILED_PRECONDITION", "Challenge is expired or already used");

      if (!this.profile(input.agentId)) {
        const owner = this.storage.sql.exec<{ agent_id: string } & Row>(
          "SELECT agent_id FROM agents WHERE display_name = ? COLLATE NOCASE",
          input.displayName,
        ).toArray()[0];
        if (owner) throw new DomainError("ALREADY_EXISTS", "Display name is already taken");
        this.storage.sql.exec(
          `INSERT INTO agents
           (agent_id, public_key, display_name, last_authenticated_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          input.agentId, input.publicKey, input.displayName, input.now, input.now, input.now,
        );
        this.storage.sql.exec(
          `INSERT INTO player_scores (agent_id, score, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          input.agentId, GAME_CONFIG.startingStack, input.now, input.now,
        );
      } else {
        this.storage.sql.exec(
          "UPDATE agents SET last_authenticated_at = ?, updated_at = ? WHERE agent_id = ?",
          input.now, input.now, input.agentId,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO sessions
         (token_hash, agent_id, expires_at, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
        input.tokenHash, input.agentId, input.expiresAt, input.now, input.now,
      );
      return this.profile(input.agentId)!;
    });
  }
}

function base64Url(value: ArrayBuffer | Uint8Array): string {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64url");
}

async function hashToken(token: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}
