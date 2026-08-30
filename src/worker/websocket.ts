import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ActionType,
  ClientFrameSchema,
  MembershipStatus,
  RoomStatus,
  ServerFrameSchema,
  Street,
  type ClientFrame,
} from "../gen/poker/v1/event_pb.js";
import type { AgentRow } from "./domains/player/service.js";
import type { EventData, RoomData } from "./domains/texas-holdem/service.js";
import type { ParticipationData } from "./domains/texas-holdem/service.js";
import { GAME_CONFIG } from "../config.js";
import { DomainError } from "./domain-error.js";

const actionType: Record<"fold" | "check" | "call" | "raise", ActionType> = {
  fold: ActionType.FOLD,
  check: ActionType.CHECK,
  call: ActionType.CALL,
  raise: ActionType.RAISE,
};

interface ConnectionAttachment {
  agentId?: string;
  sessionExpiresAt?: number;
  lobby: boolean;
  tableId?: string;
}

interface LobbyData {
  tables: Array<{
    tableId: string;
    displayName: string;
    room: RoomData;
  }>;
  leaderboard: AgentRow[];
  membership?: { tableId: string; status: "SEATED" | "QUEUED"; queuePosition: number };
  player?: AgentRow;
  gameEnabled: boolean;
}

export function decodeClientFrame(message: string | ArrayBuffer): ClientFrame {
  if (typeof message === "string") {
    throw new DomainError("INVALID_ARGUMENT", "WebSocket frames must be binary Protobuf");
  }
  return fromBinary(ClientFrameSchema, new Uint8Array(message));
}

export function attachment(webSocket: WebSocket): ConnectionAttachment {
  return webSocket.deserializeAttachment() ?? { lobby: false };
}

export function sendAck(webSocket: WebSocket, requestId: string, command: string, tableId = ""): void {
  send(webSocket, {
    requestId,
    tableId,
    payload: { case: "ack", value: { command } },
  });
}

export function sendError(webSocket: WebSocket, requestId: string, code: string, message: string): void {
  send(webSocket, {
    requestId,
    payload: { case: "error", value: { code, message } },
  });
}

export function sendLobby(webSocket: WebSocket, data: LobbyData): void {
  send(webSocket, {
    payload: {
      case: "lobbySnapshot",
      value: {
        tables: data.tables.map(({ tableId, displayName, room }) => ({
          tableId,
          displayName,
          status: roomStatus(room.status),
          capacity: room.capacity,
          emptySeats: Math.max(0, room.capacity - room.players.length),
          queueSize: room.queueSize,
          players: rpcRoom(room).players,
          paused: !data.gameEnabled,
        })),
        leaderboard: data.leaderboard.map((player) => ({
          agentId: player.agent_id,
          displayName: player.display_name,
          score: BigInt(player.score),
        })),
        membership: data.membership && {
          tableId: data.membership.tableId,
          status: data.membership.status === "SEATED" ? MembershipStatus.SEATED : MembershipStatus.QUEUED,
          queuePosition: data.membership.queuePosition,
        },
        player: data.player && {
          agentId: data.player.agent_id,
          displayName: data.player.display_name,
          lifetimeScore: BigInt(data.player.score),
          createdAt: BigInt(data.player.created_at),
        },
        gameEnabled: data.gameEnabled,
      },
    },
  });
}

export function sendRoom(webSocket: WebSocket, tableId: string, room: RoomData): void {
  send(webSocket, {
    eventSeq: BigInt(room.latestEventSeq),
    tableId,
    payload: { case: "roomSnapshot", value: rpcRoom(room) },
  });
}

export function sendEvent(webSocket: WebSocket, event: EventData, room: RoomData): void {
  send(webSocket, {
    eventSeq: BigInt(event.seq),
    tableId: event.roomId,
    payload: {
      case: "event",
      value: {
        seq: BigInt(event.seq),
        handNumber: event.handNumber,
        kind: event.kind,
        agentId: event.agentId,
        message: event.message,
        createdAt: BigInt(event.createdAt),
        room: rpcRoom(room),
      },
    },
  });
}

export function sendConfig(webSocket: WebSocket, requestId: string): void {
  send(webSocket, {
    requestId,
    payload: {
      case: "gameConfig",
      value: {
        game: GAME_CONFIG.game,
        playerCount: GAME_CONFIG.playerCount,
        startingStack: BigInt(GAME_CONFIG.startingStack),
        smallBlind: BigInt(GAME_CONFIG.smallBlind),
        bigBlind: BigInt(GAME_CONFIG.bigBlind),
        actionTimeoutMs: BigInt(GAME_CONFIG.actionTimeoutMs),
        showdownDelayMs: BigInt(GAME_CONFIG.showdownDelayMs),
        maxQueueSize: GAME_CONFIG.maxQueueSize,
      },
    },
  });
}

export function sendLogs(webSocket: WebSocket, requestId: string, logs: ParticipationData[]): void {
  send(webSocket, {
    requestId,
    payload: {
      case: "logsSnapshot",
      value: {
        logs: logs.map((log) => ({
          id: BigInt(log.id),
          handNumber: log.handNumber,
          kind: log.kind,
          decisionId: log.decisionId,
          action: log.action ? actionType[log.action] : ActionType.UNSPECIFIED,
          amount: BigInt(log.amount),
          reason: log.reason,
          createdAt: BigInt(log.createdAt),
        })),
      },
    },
  });
}

function send(webSocket: WebSocket, frame: Parameters<typeof create<typeof ServerFrameSchema>>[1]): void {
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.send(toBinary(ServerFrameSchema, create(ServerFrameSchema, {
      requestId: "",
      eventSeq: 0n,
      tableId: "",
      ...frame,
    })));
  }
}

function rpcRoom(room: RoomData) {
  return {
    status: roomStatus(room.status),
    capacity: room.capacity,
    handNumber: room.handNumber,
    street: Street[room.street],
    pot: BigInt(room.pot),
    currentBet: BigInt(room.currentBet),
    dealerSeat: room.dealerSeat,
    actingSeat: room.actingSeat,
    actingAgentId: room.actingAgentId,
    decisionId: room.decisionId,
    decisionDeadline: BigInt(room.decisionDeadline),
    communityCards: room.communityCards,
    viewerHoleCards: room.viewerHoleCards,
    players: room.players.map((player) => ({
      ...player,
      stack: BigInt(player.stack),
      streetBet: BigInt(player.streetBet),
      totalBet: BigInt(player.totalBet),
      lifetimeScore: BigInt(player.lifetimeScore),
    })),
    legalActions: room.legalActions && {
      actions: room.legalActions.actions.map((action) => actionType[action]),
      callAmount: BigInt(room.legalActions.callAmount),
      minRaiseTo: BigInt(room.legalActions.minRaiseTo),
      maxRaiseTo: BigInt(room.legalActions.maxRaiseTo),
    },
    latestEventSeq: BigInt(room.latestEventSeq),
    result: room.result,
    queueSize: room.queueSize,
    viewerSeated: room.viewerSeated,
    viewerQueuePosition: room.viewerQueuePosition,
    paused: false,
  };
}

function roomStatus(status: RoomData["status"]): RoomStatus {
  return status === "PLAYING" ? RoomStatus.PLAYING : RoomStatus.WAITING_FOR_PLAYERS;
}
