import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { ActionType, type ClientFrame } from "../gen/poker/v1/event_pb.js";
import { DomainError } from "./domain-error.js";
import { LobbyRepository } from "./domains/lobby/repository.js";
import { PlayerService } from "./domains/player/service.js";
import type { GameAction } from "./domains/texas-holdem/game.js";
import {
  TexasHoldemService,
  type EventData,
} from "./domains/texas-holdem/service.js";
import schema from "./migrations/0001_initial.sql";
import {
  attachment,
  decodeClientFrame,
  sendAck,
  sendConfig,
  sendError,
  sendEvent,
  sendLobby,
  sendLogs,
  sendRoom,
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
    return this.fromDomain(() => this.players.beginAuth(publicKey));
  }

  async finishAuth(input: {
    challengeId: string;
    publicKey: Uint8Array;
    signature: Uint8Array;
    displayName: string;
  }) {
    return this.fromDomain(() => this.players.finishAuth(input));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
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
      const due = this.texasHoldem.dueRoomIds(Date.now());
      return due.flatMap((roomId) => {
        const roomEvents = this.texasHoldem.processTimeout(roomId, Date.now());
        const expected = new Map(
          this.texasHoldem
            .memberships(roomId)
            .map((row) => [row.agentId, row.status]),
        );
        for (const current of this.lobbyRepository.membershipsForRoom(roomId)) {
          const status = expected.get(current.agent_id);
          if (!status) this.lobbyRepository.deleteMembership(current.agent_id);
          else if (status !== current.status) {
            this.lobbyRepository.setMembership(
              current.agent_id,
              roomId,
              status,
              Date.now(),
            );
          }
          expected.delete(current.agent_id);
        }
        for (const [agentId, status] of expected) {
          this.lobbyRepository.setMembership(
            agentId,
            roomId,
            status,
            Date.now(),
          );
        }
        return roomEvents;
      });
    });
    await this.scheduleAlarm();
    this.broadcast(events);
  }

  private async handleFrame(
    webSocket: WebSocket,
    frame: ClientFrame,
  ): Promise<void> {
    switch (frame.payload.case) {
      case "authenticate": {
        const player = await this.players.authenticate(
          frame.payload.value.sessionToken,
        );
        const current = attachment(webSocket);
        webSocket.serializeAttachment({
          ...current,
          agentId: player.agent_id,
          sessionExpiresAt: player.expires_at,
        });
        sendAck(webSocket, frame.requestId, "authenticate");
        return;
      }
      case "subscribe": {
        const command = frame.payload.value;
        const after = Number(command.afterEventSeq);
        if (!Number.isSafeInteger(after) || after < 0) {
          throw new DomainError(
            "INVALID_ARGUMENT",
            "after_event_seq must be a non-negative safe integer",
          );
        }
        if (command.tableId && !this.lobbyRepository.room(command.tableId)) {
          throw new DomainError("NOT_FOUND", "Table not found");
        }
        const current = attachment(webSocket);
        webSocket.serializeAttachment({
          ...current,
          lobby: command.lobby,
          tableId: command.tableId || undefined,
        });
        sendAck(webSocket, frame.requestId, "subscribe", command.tableId);
        if (command.tableId) {
          const room = this.texasHoldem.room(command.tableId, current.agentId);
          for (const replayed of this.texasHoldem.replay(
            after,
            command.tableId,
          ))
            sendEvent(webSocket, replayed, room);
          sendRoom(webSocket, command.tableId, room);
        }
        if (command.lobby)
          sendLobby(webSocket, this.lobbyData(current.agentId));
        return;
      }
      case "createTable": {
        const player = this.authenticated(webSocket);
        const roomId = this.ctx.storage.transactionSync(() => {
          const now = Date.now();
          if (!this.lobbyRepository.gameEnabled())
            throw new DomainError("UNAVAILABLE", "Game is stopped");
          const roomId = crypto.randomUUID();
          this.lobbyRepository.insertRoom(
            roomId,
            `${player.display_name}'s table`,
            player.agent_id,
            now,
          );
          this.texasHoldem.createRoom(roomId, now);
          return roomId;
        });
        const current = attachment(webSocket);
        webSocket.serializeAttachment({ ...current, tableId: roomId });
        sendAck(webSocket, frame.requestId, "create_table", roomId);
        sendRoom(
          webSocket,
          roomId,
          this.texasHoldem.room(roomId, player.agent_id),
        );
        this.broadcast();
        return;
      }
      case "joinTable": {
        const player = this.authenticated(webSocket);
        const roomId = frame.payload.value.tableId;
        const result = this.ctx.storage.transactionSync(() => {
          if (!this.lobbyRepository.gameEnabled())
            throw new DomainError("UNAVAILABLE", "Game is stopped");
          if (!this.lobbyRepository.room(roomId))
            throw new DomainError("NOT_FOUND", "Table not found");
          const membership = this.lobbyRepository.membership(player.agent_id);
          if (membership && membership.room_id !== roomId) {
            throw new DomainError(
              "ALREADY_EXISTS",
              "Player is already seated or queued at another table",
            );
          }
          const joined = this.texasHoldem.joinRoom(roomId, {
            agentId: player.agent_id,
            displayName: player.display_name,
            stack: player.score,
          });
          const status = joined.queued ? "QUEUED" : "SEATED";
          if (!membership || membership.status !== status) {
            this.lobbyRepository.setMembership(
              player.agent_id,
              roomId,
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
        sendAck(
          webSocket,
          frame.requestId,
          "join_table",
          frame.payload.value.tableId,
        );
        this.broadcast(result.events);
        sendRoom(webSocket, frame.payload.value.tableId, result.room);
        return;
      }
      case "leaveTable": {
        const player = this.authenticated(webSocket);
        const result = this.ctx.storage.transactionSync(() => {
          const membership = this.membership(player.agent_id);
          const left = this.texasHoldem.leaveRoom(
            membership.room_id,
            player.agent_id,
            player.display_name,
          );
          if (left.released) this.lobbyRepository.deleteMembership(player.agent_id);
          return left;
        });
        await this.scheduleAlarm();
        sendAck(
          webSocket,
          frame.requestId,
          "leave_table",
          result.events[0]?.roomId,
        );
        this.broadcast(result.events);
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
            membership.room_id,
            player.agent_id,
            command.decisionId,
            gameAction,
            Number(command.amount),
            command.reason,
          );
        });
        await this.scheduleAlarm();
        sendAck(webSocket, frame.requestId, "act", result.events[0]?.roomId);
        this.broadcast(result.events);
        sendRoom(webSocket, result.events[0]?.roomId ?? "", result.room);
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
            membership.room_id,
            player.agent_id,
            player.display_name,
            command.text,
          );
        });
        sendAck(webSocket, frame.requestId, "chat", events[0]?.roomId);
        this.broadcast(events);
        return;
      }
      case "switchGame": {
        const command = frame.payload.value;
        if (!this.env.POKER_ADMIN_TOKEN)
          throw new DomainError("UNAVAILABLE", "Admin operations are unavailable");
        const encoder = new TextEncoder();
        const [providedHash, expectedHash] = await Promise.all([
          crypto.subtle.digest("SHA-256", encoder.encode(command.adminToken)),
          crypto.subtle.digest(
            "SHA-256",
            encoder.encode(this.env.POKER_ADMIN_TOKEN),
          ),
        ]);
        if (
          !timingSafeEqual(
            new Uint8Array(providedHash),
            new Uint8Array(expectedHash),
          )
        ) {
          throw new DomainError("PERMISSION_DENIED", "Invalid admin token");
        }
        this.ctx.storage.transactionSync(() => {
          this.lobbyRepository.setGameEnabled(command.enabled, Date.now());
          if (!command.enabled) this.lobbyRepository.clearTables();
        });
        if (command.enabled) await this.scheduleAlarm();
        else await this.ctx.storage.deleteAlarm();
        sendAck(webSocket, frame.requestId, "switch_game");
        this.broadcast();
        return;
      }
      case "getConfig":
        sendConfig(webSocket, frame.requestId);
        return;
      case "getLogs": {
        const player = this.authenticated(webSocket);
        const before = Number(frame.payload.value.beforeId);
        sendLogs(
          webSocket,
          frame.requestId,
          this.texasHoldem.participation(
            player.agent_id,
            before,
            frame.payload.value.limit,
          ),
        );
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

  private lobbyData(agentId?: string) {
    const live = new Map(
      this.texasHoldem
        .summaries()
        .map((summary) => [summary.roomId, summary.room]),
    );
    const player = agentId ? this.players.profile(agentId) : undefined;
    const membership = agentId
      ? this.lobbyRepository.membership(agentId)
      : undefined;
    const membershipRoom =
      membership && this.texasHoldem.room(membership.room_id, agentId);
    return {
      tables: this.lobbyRepository.rooms().flatMap((room) => {
        const state = live.get(room.room_id);
        return state
          ? [
              {
                tableId: room.room_id,
                displayName: room.display_name,
                room: state,
              },
            ]
          : [];
      }),
      leaderboard: this.players.leaderboard(),
      membership: membership && {
        tableId: membership.room_id,
        status: membership.status,
        queuePosition:
          membership.status === "QUEUED"
            ? (membershipRoom?.viewerQueuePosition ?? 0)
            : 0,
      },
      player,
      gameEnabled: this.lobbyRepository.gameEnabled(),
    };
  }

  private broadcast(events: EventData[] = []): void {
    for (const webSocket of this.ctx.getWebSockets()) {
      const current = attachment(webSocket);
      const subscribed = events.filter((event) => current.tableId === event.roomId);
      if (current.tableId && subscribed.length > 0) {
        const room = this.texasHoldem.room(current.tableId, current.agentId);
        for (const event of subscribed) sendEvent(webSocket, event, room);
      }
      if (current.lobby) sendLobby(webSocket, this.lobbyData(current.agentId));
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const nextWakeAt = this.texasHoldem.nextWakeAt();
    if (nextWakeAt === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(nextWakeAt);
  }

  private async fromDomain<T>(operation: () => T | Promise<T>): Promise<T> {
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
