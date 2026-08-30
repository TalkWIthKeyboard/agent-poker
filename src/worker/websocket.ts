import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ActionType,
  Street,
  TableStatus,
} from "../gen/poker/v1/entity_pb.js";
import {
  ClientFrameSchema,
  ServerFrameSchema,
  type ClientFrame,
} from "../gen/poker/v1/event_pb.js";
import type { EventData, TableData } from "./domains/texas-holdem/service.js";
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

export function decodeClientFrame(message: string | ArrayBuffer): ClientFrame {
  if (typeof message === "string") {
    throw new DomainError("INVALID_ARGUMENT", "WebSocket frames must be binary Protobuf");
  }
  return fromBinary(ClientFrameSchema, new Uint8Array(message));
}

export function attachment(webSocket: WebSocket): ConnectionAttachment {
  return webSocket.deserializeAttachment() ?? { lobby: false };
}

export function sendAck(webSocket: WebSocket, requestId: string, command: string): void {
  send(webSocket, {
    requestId,
    payload: { case: "ack", value: { command } },
  });
}

export function sendError(webSocket: WebSocket, requestId: string, code: string, message: string): void {
  send(webSocket, {
    requestId,
    payload: { case: "error", value: { code, message } },
  });
}

export function sendLobbyChanged(webSocket: WebSocket): void {
  send(webSocket, {
    payload: { case: "lobbyChanged", value: {} },
  });
}

export function sendTable(webSocket: WebSocket, tableId: string, table: TableData): void {
  send(webSocket, {
    payload: { case: "tableSnapshot", value: rpcTable(tableId, table) },
  });
}

export function sendEvent(webSocket: WebSocket, event: EventData): void {
  send(webSocket, {
    payload: {
      case: "event",
      value: {
        tableId: event.tableId,
        seq: BigInt(event.seq),
        handNumber: event.handNumber,
        kind: event.kind,
        agentId: event.agentId,
        message: event.message,
        createdAt: BigInt(event.createdAt),
      },
    },
  });
}

function send(webSocket: WebSocket, frame: Parameters<typeof create<typeof ServerFrameSchema>>[1]): void {
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.send(toBinary(ServerFrameSchema, create(ServerFrameSchema, {
      requestId: "",
      ...frame,
    })));
  }
}

function rpcTable(tableId: string, table: TableData) {
  return {
    tableId,
    status: tableStatus(table.status),
    capacity: table.capacity,
    handNumber: table.handNumber,
    street: Street[table.street],
    pot: BigInt(table.pot),
    currentBet: BigInt(table.currentBet),
    dealerSeat: table.dealerSeat,
    actingSeat: table.actingSeat,
    actingAgentId: table.actingAgentId,
    decisionId: table.decisionId,
    decisionDeadline: BigInt(table.decisionDeadline),
    communityCards: table.communityCards,
    viewerHoleCards: table.viewerHoleCards,
    players: table.players.map((player) => ({
      ...player,
      stack: BigInt(player.stack),
      streetBet: BigInt(player.streetBet),
      totalBet: BigInt(player.totalBet),
      lifetimeScore: BigInt(player.lifetimeScore),
    })),
    legalActions: table.legalActions && {
      actions: table.legalActions.actions.map((action) => actionType[action]),
      callAmount: BigInt(table.legalActions.callAmount),
      minRaiseTo: BigInt(table.legalActions.minRaiseTo),
      maxRaiseTo: BigInt(table.legalActions.maxRaiseTo),
    },
    latestEventSeq: BigInt(table.latestEventSeq),
    result: table.result,
    queueSize: table.queueSize,
    viewerSeated: table.viewerSeated,
    viewerQueuePosition: table.viewerQueuePosition,
    paused: false,
  };
}

function tableStatus(status: TableData["status"]): TableStatus {
  return status === "PLAYING" ? TableStatus.PLAYING : TableStatus.WAITING_FOR_PLAYERS;
}
