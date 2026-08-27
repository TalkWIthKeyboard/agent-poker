import {
  Code,
  ConnectError,
  createContextKey,
  createContextValues,
  type ConnectRouter,
} from "@connectrpc/connect";
import { connectWorkersAdapter } from "@depot/connectrpc-workers";
import packageJson from "../../package.json";
import { GAME_CONFIG } from "../config.js";
import {
  ActionType,
  AuthService,
  PokerService,
  SystemService,
} from "../gen/poker/v1/poker_pb.js";
import type { EventData, PokerMatch, RoomData } from "./app.js";
import type { ParticipationLogData } from "./repository.js";

type PokerStub = DurableObjectStub<PokerMatch>;
const pokerStubKey = createContextKey<PokerStub | undefined>(undefined);

function requireStub(context: { values: { get<T>(key: ReturnType<typeof createContextKey<T>>): T } }): PokerStub {
  const stub = context.values.get(pokerStubKey);
  if (!stub) throw new ConnectError("Poker room is unavailable", Code.Unavailable);
  return stub;
}

function bearer(headers: Headers, required = true): string | undefined {
  const value = headers.get("authorization");
  if (!value) {
    if (required) throw new ConnectError("Missing session token", Code.Unauthenticated);
    return undefined;
  }
  if (!value.startsWith("Bearer ")) throw new ConnectError("Invalid authorization header", Code.Unauthenticated);
  return value.slice(7);
}

async function fromRoom<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const separator = message.indexOf(":");
    const name = separator < 0 ? "" : message.slice(0, separator);
    const detail = separator < 0 ? message : message.slice(separator + 1).trim();
    const codes: Record<string, Code> = {
      UNAUTHENTICATED: Code.Unauthenticated,
      PERMISSION_DENIED: Code.PermissionDenied,
      INVALID_ARGUMENT: Code.InvalidArgument,
      FAILED_PRECONDITION: Code.FailedPrecondition,
      ALREADY_EXISTS: Code.AlreadyExists,
      RESOURCE_EXHAUSTED: Code.ResourceExhausted,
      DEADLINE_EXCEEDED: Code.DeadlineExceeded,
      NOT_FOUND: Code.NotFound,
    };
    throw new ConnectError(detail, codes[name] ?? Code.Internal);
  }
}

function rpcRoom(room: RoomData) {
  return {
    ...room,
    pot: BigInt(room.pot),
    currentBet: BigInt(room.currentBet),
    decisionDeadline: BigInt(room.decisionDeadline),
    players: room.players.map((player) => ({
      ...player,
      stack: BigInt(player.stack),
      streetBet: BigInt(player.streetBet),
      totalBet: BigInt(player.totalBet),
    })),
    legalActions: room.legalActions && {
      ...room.legalActions,
      callAmount: BigInt(room.legalActions.callAmount),
      minRaiseTo: BigInt(room.legalActions.minRaiseTo),
      maxRaiseTo: BigInt(room.legalActions.maxRaiseTo),
    },
    latestEventSeq: BigInt(room.latestEventSeq),
  };
}

function rpcEvent(event: EventData) {
  return {
    seq: BigInt(event.seq),
    handNumber: event.handNumber,
    kind: event.kind,
    agentId: event.agentId,
    message: event.message,
    createdAt: BigInt(event.createdAt),
    room: rpcRoom(event.room),
  };
}

function rpcLog(log: ParticipationLogData) {
  return {
    id: BigInt(log.id),
    handNumber: log.handNumber,
    kind: log.kind,
    decisionId: log.decisionId,
    action: log.action ? {
      fold: ActionType.FOLD,
      check: ActionType.CHECK,
      call: ActionType.CALL,
      raise: ActionType.RAISE,
    }[log.action] : ActionType.UNSPECIFIED,
    amount: BigInt(log.amount),
    reason: log.reason,
    createdAt: BigInt(log.createdAt),
  };
}

function routes(router: ConnectRouter): void {
  router.service(SystemService, {
    health() {
      return {
        status: "ok",
        service: "agent-poker",
        version: packageJson.version,
        checkedAt: BigInt(Date.now()),
      };
    },
  });

  router.service(AuthService, {
    async beginAuth(request, context) {
      const response = await fromRoom(requireStub(context).beginAuth(request.publicKey));
      return {
        challengeId: response.challengeId,
        challenge: response.challenge,
        expiresAt: BigInt(response.expiresAt),
      };
    },
    async finishAuth(request, context) {
      const response = await fromRoom(requireStub(context).finishAuth({
        challengeId: request.challengeId,
        publicKey: request.publicKey,
        signature: request.signature,
        displayName: request.displayName,
      }));
      return {
        agent: {
          agentId: response.agentId,
          displayName: response.displayName,
          createdAt: BigInt(response.createdAt),
        },
        sessionToken: response.sessionToken,
        expiresAt: BigInt(response.expiresAt),
      };
    },
  });

  router.service(PokerService, {
    getGameConfig() {
      return {
        ...GAME_CONFIG,
        startingStack: BigInt(GAME_CONFIG.startingStack),
        smallBlind: BigInt(GAME_CONFIG.smallBlind),
        bigBlind: BigInt(GAME_CONFIG.bigBlind),
        actionTimeoutMs: BigInt(GAME_CONFIG.actionTimeoutMs),
        showdownDelayMs: BigInt(GAME_CONFIG.showdownDelayMs),
      };
    },
    async joinRoom(_request, context) {
      const room = await fromRoom(requireStub(context).joinRoom(bearer(context.requestHeader)!));
      return { room: rpcRoom(room) };
    },
    async leaveRoom(_request, context) {
      const room = await fromRoom(requireStub(context).leaveRoom(bearer(context.requestHeader)!));
      return { room: rpcRoom(room) };
    },
    async getRoom(_request, context) {
      const room = await fromRoom(requireStub(context).getRoom(bearer(context.requestHeader, false)));
      return { room: rpcRoom(room) };
    },
    async getMyScore(_request, context) {
      const score = await fromRoom(requireStub(context).getMyScore(bearer(context.requestHeader)!));
      return { score: BigInt(score) };
    },
    async getMyLogs(request, context) {
      const logs = await fromRoom(requireStub(context).getMyLogs(
        bearer(context.requestHeader)!,
        Number(request.beforeId),
        request.limit,
      ));
      return { logs: logs.map(rpcLog) };
    },
    async waitForTurn(request, context) {
      const response = await fromRoom(requireStub(context).waitForTurn(
        bearer(context.requestHeader)!,
        Number(request.afterEventSeq),
        request.timeoutMs,
      ));
      return {
        yourTurn: response.yourTurn,
        changed: response.changed,
        room: rpcRoom(response.room),
      };
    },
    async act(request, context) {
      const response = await fromRoom(requireStub(context).act(
        bearer(context.requestHeader)!,
        request.decisionId,
        request.action,
        Number(request.amount),
        request.reason,
      ));
      return {
        room: rpcRoom(response.room),
        acceptedEvent: rpcEvent(response.event),
      };
    },
    async *watchRoom(request, context) {
      const stub = requireStub(context);
      let after = Number(request.afterEventSeq);
      while (!context.signal.aborted) {
        const events = await fromRoom(stub.waitForEvents(after, 25_000));
        for (const event of events) {
          after = event.seq;
          yield { event: rpcEvent(event) };
        }
      }
    },
  });
}

const rpcHandler = connectWorkersAdapter<Env>({
  routes,
  contextValues(_request, env) {
    return createContextValues().set(pokerStubKey, env.POKER_MATCHES.getByName("main"));
  },
  async fallback(request, unknownEnv) {
    const env = unknownEnv as Env;
    return env.ASSETS.fetch(request);
  },
});

export default {
  async fetch(request, env, context) {
    console.log(JSON.stringify({
      event: "request",
      method: request.method,
      path: new URL(request.url).pathname,
    }));
    return rpcHandler(request, env, context);
  },
} satisfies ExportedHandler<Env>;
