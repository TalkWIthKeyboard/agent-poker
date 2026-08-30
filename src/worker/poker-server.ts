import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { ActionType } from "../gen/poker/v1/entity_pb.js";
import type { ClientFrame } from "../gen/poker/v1/event_pb.js";
import { DomainError } from "./domain-error.js";
import { LobbyRepository } from "./domains/lobby/repository.js";
import { PlayerService } from "./domains/player/service.js";
import type { GameAction } from "./domains/texas-holdem/game.js";
import {
  type BroadcastEventData,
  LOBBY_CHANGED_EVENT,
  TexasHoldemService,
  type EventData,
} from "./domains/texas-holdem/service.js";
import schema from "./migrations/0001_initial.sql";
import {
  attachment,
  decodeClientFrame,
  sendAck,
  sendError,
  sendEvent,
  sendLobbyChanged,
  sendTable,
} from "./websocket.js";

export class PokerServer extends DurableObject<Env> {
  private readonly players: PlayerService;
  private readonly lobbyRepository: LobbyRepository;
  private readonly texasHoldem: TexasHoldemService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.players = new PlayerService(ctx.storage);
    this.lobbyRepository = new LobbyRepository(ctx.storage);
    this.texasHoldem = new TexasHoldemService(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(schema);
    });
  }

  async beginAuth(publicKey: Uint8Array) {
    return this.toRpcError(() => this.players.beginAuth(publicKey));
  }

  async finishAuth(input: {
    challengeId: string;
    publicKey: Uint8Array;
    signature: Uint8Array;
    displayName: string;
  }) {
    return this.toRpcError(() => this.players.finishAuth(input));
  }

  async getLobby() {
    return this.toRpcError(() => {
      const live = new Map(
        this.texasHoldem.summaries().map((summary) => [summary.tableId, summary.table]),
      );
      return {
        tables: this.lobbyRepository.tables().flatMap((table) => {
          const state = live.get(table.table_id);
          return state ? [{ tableId: table.table_id, displayName: table.display_name, table: state }] : [];
        }),
        gameEnabled: this.lobbyRepository.gameEnabled(),
      };
    });
  }

  async getLeaderboard() {
    return this.toRpcError(() => this.players.leaderboard());
  }

  async getMe(sessionToken: string) {
    return this.toRpcError(async () => {
      const player = await this.players.authenticate(sessionToken);
      const membership = this.lobbyRepository.membership(player.agent_id);
      return {
        player,
        membership: membership && {
          tableId: membership.table_id,
          status: membership.status,
          queuePosition: membership.status === "QUEUED"
            ? this.texasHoldem.table(membership.table_id, player.agent_id).viewerQueuePosition
            : 0,
        },
      };
    });
  }

  async switchGame(adminToken: string, enabled: boolean) {
    return this.toRpcError(async () => {
      if (!this.env.POKER_ADMIN_TOKEN)
        throw new DomainError("UNAVAILABLE", "Admin operations are unavailable");
      const encoder = new TextEncoder();
      const [providedHash, expectedHash] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(adminToken)),
        crypto.subtle.digest("SHA-256", encoder.encode(this.env.POKER_ADMIN_TOKEN)),
      ]);
      if (!timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash))) {
        throw new DomainError("PERMISSION_DENIED", "Invalid admin token");
      }
      this.ctx.storage.transactionSync(() => {
        this.lobbyRepository.switchGame(enabled, Date.now());
        if (!enabled) this.lobbyRepository.clearTables();
      });
      if (enabled) await this.scheduleAlarm();
      else await this.ctx.storage.deleteAlarm();
      this.broadcast([LOBBY_CHANGED_EVENT]);
      return { enabled };
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // Attach per-connection metadata that survives Durable Object hibernation.
    // `lobby: false` initializes the socket as not subscribed to lobby updates.
    server.serializeAttachment({ lobby: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    let frame: ClientFrame | undefined;
    try {
      frame = decodeClientFrame(message);
      if (!frame.requestId || frame.requestId.length > 128) {
        throw new DomainError(
          "INVALID_ARGUMENT",
          "request_id must contain 1 to 128 characters",
        );
      }
      await this.handleFrame(webSocket, frame);
    } catch (cause) {
      if (cause instanceof DomainError) {
        sendError(webSocket, frame?.requestId ?? "", cause.code, cause.message);
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(
        JSON.stringify({ event: "websocket_command_failed", error: message }),
      );
      sendError(
        webSocket,
        frame?.requestId ?? "",
        "INTERNAL",
        "Internal server error",
      );
    }
  }

  async alarm(): Promise<void> {
    const events = this.ctx.storage.transactionSync(() => {
      // Find all tables due for this wake-up and process them one by one.
      const now = Date.now();
      const due = this.texasHoldem.dueTableIds(now);
      const memberships: Array<{
        agentId: string;
        tableId: string;
        status: "SEATED" | "QUEUED";
      }> = [];
      const events = due.flatMap((tableId) => {
        const events = this.texasHoldem.processTimeout(tableId, now);
        memberships.push(...this.texasHoldem.memberships(tableId).map((membership) => ({
          ...membership,
          tableId,
        })));
        return events;
      });
      this.lobbyRepository.syncMemberships(due, memberships, now);
      return events;
    });
    await this.scheduleAlarm();
    this.broadcast(events);
  }

  private async handleFrame(
    webSocket: WebSocket,
    frame: ClientFrame,
  ): Promise<void> {
    switch (frame.payload.case) {
      // Authenticate after the WebSocket upgrade so anonymous spectators can use
      // the same connection. Browser WebSockets cannot set an Authorization
      // header, and putting the session token in the URL may expose it in logs.
      case "authenticate": {
        const command = frame.payload.value;
        const player = await this.players.authenticate(command.sessionToken);
        const current = attachment(webSocket);
        const membership = this.lobbyRepository.membership(player.agent_id);
        const table = membership
          ? this.texasHoldem.table(membership.table_id, player.agent_id)
          : undefined;
        const after = command.afterEventSeq === undefined
          ? undefined
          : eventCursor(command.afterEventSeq);
        if (after !== undefined && table && after > table.latestEventSeq) {
          throw new DomainError("INVALID_ARGUMENT", "after_event_seq exceeds the current table sequence");
        }
        webSocket.serializeAttachment({
          ...current,
          agentId: player.agent_id,
          sessionExpiresAt: player.expires_at,
          tableId: membership?.table_id,
        });
        sendAck(webSocket, frame.requestId, "authenticate");
        if (membership && table) {
          if (after !== undefined) {
            let cursor = after;
            while (true) {
              const replayed = this.texasHoldem.replay(cursor, membership.table_id);
              if (replayed.length === 0) break;
              for (const event of replayed) sendEvent(webSocket, event);
              cursor = replayed[replayed.length - 1].seq;
            }
          }
          sendTable(webSocket, membership.table_id, table);
        }
        return;
      }
      case "subscribe": {
        const command = frame.payload.value;
        const current = attachment(webSocket);
        if (current.agentId) {
          throw new DomainError(
            "FAILED_PRECONDITION",
            "Authenticated players follow their table membership automatically",
          );
        }
        const after = eventCursor(command.afterEventSeq);
        if (command.tableId && !this.lobbyRepository.table(command.tableId)) {
          throw new DomainError("NOT_FOUND", "Table not found");
        }
        webSocket.serializeAttachment({
          ...current,
          lobby: command.lobby,
          tableId: command.tableId || undefined,
        });
        sendAck(webSocket, frame.requestId, "subscribe");
        if (command.tableId) {
          const table = this.texasHoldem.table(command.tableId, current.agentId);
          for (const replayed of this.texasHoldem.replay(
            after,
            command.tableId,
          ))
            sendEvent(webSocket, replayed);
          sendTable(webSocket, command.tableId, table);
        }
        return;
      }
      case "createTable": {
        const player = this.authenticated(webSocket);
        const tableId = this.ctx.storage.transactionSync(() => {
          const now = Date.now();
          if (!this.lobbyRepository.gameEnabled())
            throw new DomainError("UNAVAILABLE", "Game is stopped");
          const tableId = crypto.randomUUID();
          this.lobbyRepository.insertTable(
            tableId,
            `${player.display_name}'s table`,
            player.agent_id,
            now,
          );
          this.texasHoldem.createTable(tableId, now);
          return tableId;
        });
        const current = attachment(webSocket);
        webSocket.serializeAttachment({ ...current, tableId: tableId });
        sendAck(webSocket, frame.requestId, "create_table");
        sendTable(
          webSocket,
          tableId,
          this.texasHoldem.table(tableId, player.agent_id),
        );
        this.broadcast([LOBBY_CHANGED_EVENT]);
        return;
      }
      case "joinTable": {
        const player = this.authenticated(webSocket);
        const tableId = frame.payload.value.tableId;
        const result = this.ctx.storage.transactionSync(() => {
          if (!this.lobbyRepository.gameEnabled())
            throw new DomainError("UNAVAILABLE", "Game is stopped");
          if (!this.lobbyRepository.table(tableId))
            throw new DomainError("NOT_FOUND", "Table not found");
          const membership = this.lobbyRepository.membership(player.agent_id);
          if (membership && membership.table_id !== tableId) {
            throw new DomainError(
              "ALREADY_EXISTS",
              "Player is already seated or queued at another table",
            );
          }
          const joined = this.texasHoldem.joinTable(tableId, {
            agentId: player.agent_id,
            displayName: player.display_name,
            stack: player.score,
          });
          const status = joined.queued ? "QUEUED" : "SEATED";
          if (!membership || membership.status !== status) {
            this.lobbyRepository.setMembership(
              player.agent_id,
              tableId,
              status,
              Date.now(),
            );
          }
          return joined;
        });
        const current = attachment(webSocket);
        webSocket.serializeAttachment({
          ...current,
          tableId: frame.payload.value.tableId,
        });
        await this.scheduleAlarm();
        sendAck(webSocket, frame.requestId, "join_table");
        this.broadcast(result.events.length > 0
          ? [...result.events, LOBBY_CHANGED_EVENT]
          : result.events);
        return;
      }
      case "leaveTable": {
        const player = this.authenticated(webSocket);
        const result = this.ctx.storage.transactionSync(() => {
          const membership = this.membership(player.agent_id);
          const left = this.texasHoldem.leaveTable(
            membership.table_id,
            player.agent_id,
            player.display_name,
          );
          if (left.released) this.lobbyRepository.deleteMembership(player.agent_id);
          return left;
        });
        await this.scheduleAlarm();
        sendAck(webSocket, frame.requestId, "leave_table");
        this.broadcast(result.released
          ? [...result.events, LOBBY_CHANGED_EVENT]
          : result.events);
        return;
      }
      case "act": {
        const player = this.authenticated(webSocket);
        const command = frame.payload.value;
        const result = this.ctx.storage.transactionSync(() => {
          if (!this.lobbyRepository.gameEnabled())
            throw new DomainError("UNAVAILABLE", "Game is stopped");
          const membership = this.membership(player.agent_id);
          const action: Partial<Record<ActionType, GameAction>> = {
            [ActionType.FOLD]: "fold",
            [ActionType.CHECK]: "check",
            [ActionType.CALL]: "call",
            [ActionType.RAISE]: "raise",
          };
          const gameAction = action[command.action];
          if (!gameAction)
            throw new DomainError("INVALID_ARGUMENT", "Action is required");
          return this.texasHoldem.act(
            membership.table_id,
            player.agent_id,
            command.decisionId,
            gameAction,
            Number(command.amount),
            command.reason,
          );
        });
        await this.scheduleAlarm();
        const tableId = result.events[0]?.tableId ?? "";
        sendAck(webSocket, frame.requestId, "act");
        this.broadcast(result.events);
        if (attachment(webSocket).tableId !== tableId) {
          sendTable(webSocket, tableId, result.table);
        }
        return;
      }
      case "chat": {
        const player = this.authenticated(webSocket);
        const command = frame.payload.value;
        const events = this.ctx.storage.transactionSync(() => {
          if (!this.lobbyRepository.gameEnabled())
            throw new DomainError("UNAVAILABLE", "Game is stopped");
          const membership = this.membership(player.agent_id);
          return this.texasHoldem.chat(
            membership.table_id,
            player.agent_id,
            player.display_name,
            command.text,
          );
        });
        sendAck(webSocket, frame.requestId, "chat");
        this.broadcast(events);
        return;
      }
      default:
        throw new DomainError(
          "INVALID_ARGUMENT",
          "Command payload is required",
        );
    }
  }

  private authenticated(webSocket: WebSocket) {
    const current = attachment(webSocket);
    if (
      !current.agentId ||
      !current.sessionExpiresAt ||
      current.sessionExpiresAt <= Date.now()
    ) {
      throw new DomainError(
        "UNAUTHENTICATED",
        "Authenticate this connection first",
      );
    }
    const player = this.players.profile(current.agentId);
    if (!player)
      throw new DomainError("UNAUTHENTICATED", "Player no longer exists");
    return player;
  }

  private membership(agentId: string) {
    const membership = this.lobbyRepository.membership(agentId);
    if (!membership) {
      throw new DomainError("FAILED_PRECONDITION", "Player is not seated or queued");
    }
    return membership;
  }

  private broadcast(events: BroadcastEventData[]): void {
    const tableEvents = events.filter(
      (event): event is EventData => event.scope === "TABLE",
    );
    const lobbyChanged = events.some((event) => event.scope === "LOBBY");
    for (const webSocket of this.ctx.getWebSockets()) {
      const current = attachment(webSocket);
      const subscribed = tableEvents.filter((event) => current.tableId === event.tableId);
      if (current.tableId && subscribed.length > 0) {
        const table = this.texasHoldem.table(current.tableId, current.agentId);
        for (const event of subscribed) sendEvent(webSocket, event);
        sendTable(webSocket, current.tableId, table);
      }
      if (lobbyChanged && current.lobby) sendLobbyChanged(webSocket);
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const nextWakeAt = this.texasHoldem.nextWakeAt();
    if (nextWakeAt === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(nextWakeAt);
  }

  private async toRpcError<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      if (cause instanceof DomainError) {
        throw new Error(`${cause.code}: ${cause.message}`);
      }
      throw cause;
    }
  }
}

function eventCursor(value: bigint): number {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "after_event_seq must be a non-negative safe integer",
    );
  }
  return cursor;
}
