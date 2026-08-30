import {
  type HandlerContext,
  Code,
  ConnectError,
  createContextKey,
  createContextValues,
} from "@connectrpc/connect";
import { connectWorkersAdapter } from "@depot/connectrpc-workers";
import { Hono } from "hono";
import packageJson from "../../package.json";
import { GAME_CONFIG } from "../config.js";
import { MembershipStatus, TableStatus } from "../gen/poker/v1/entity_pb.js";
import {
  AuthService,
  ManagementService,
  PokerService,
  SystemService,
} from "../gen/poker/v1/http_pb.js";
import type { PokerServer } from "./poker-server.js";

type PokerServerStub = DurableObjectStub<PokerServer>;
const stubKey = createContextKey<PokerServerStub | undefined>(undefined);

const rpc = connectWorkersAdapter<Env>({
  routes(router) {
    router.service(SystemService, {
      health() {
        return {
          status: "ok",
          service: packageJson.name,
          version: packageJson.version,
          checkedAt: BigInt(Date.now()),
        };
      },
    });
    router.service(AuthService, {
      async beginAuth(request, context) {
        const response = await toConnectError(context.values.get(stubKey)!.beginAuth(request.publicKey));
        return {
          challengeId: response.challengeId,
          challenge: response.challenge,
          expiresAt: BigInt(response.expiresAt),
        };
      },
      async finishAuth(request, context) {
        const response = await toConnectError(context.values.get(stubKey)!.finishAuth({
          challengeId: request.challengeId,
          publicKey: request.publicKey,
          signature: request.signature,
          displayName: request.displayName,
        }));
        return {
          agent: {
            agentId: response.agent.agent_id,
            displayName: response.agent.display_name,
            lifetimeScore: BigInt(response.agent.score),
            createdAt: BigInt(response.agent.created_at),
          },
          sessionToken: response.sessionToken,
          expiresAt: BigInt(response.expiresAt),
        };
      },
    });
    router.service(PokerService, {
      getConfig(_request, context) {
        context.responseHeader.set("Cache-Control", "public, max-age=3600");
        return {
          game: GAME_CONFIG.game,
          playerCount: GAME_CONFIG.playerCount,
          startingStack: BigInt(GAME_CONFIG.startingStack),
          smallBlind: BigInt(GAME_CONFIG.smallBlind),
          bigBlind: BigInt(GAME_CONFIG.bigBlind),
          actionTimeoutMs: BigInt(GAME_CONFIG.actionTimeoutMs),
          showdownDelayMs: BigInt(GAME_CONFIG.showdownDelayMs),
          maxQueueSize: GAME_CONFIG.maxQueueSize,
        };
      },
      async getLobby(_request, context) {
        const data = await toConnectError(context.values.get(stubKey)!.getLobby());
        return {
          tables: data.tables.map(({ tableId, displayName, table }) => ({
            tableId,
            displayName,
            status: table.status === "PLAYING" ? TableStatus.PLAYING : TableStatus.WAITING_FOR_PLAYERS,
            capacity: table.capacity,
            emptySeats: Math.max(0, table.capacity - table.players.length),
            queueSize: table.queueSize,
            players: table.players,
            paused: !data.gameEnabled,
          })),
          gameEnabled: data.gameEnabled,
        };
      },
      async getLeaderboard(_request, context) {
        const players = await toConnectError(context.values.get(stubKey)!.getLeaderboard());
        return {
          entries: players.map((player) => ({
            agentId: player.agent_id,
            displayName: player.display_name,
            score: BigInt(player.score),
          })),
        };
      },
      async getMe(_request, context) {
        const data = await toConnectError(context.values.get(stubKey)!.getMe(bearerToken(context)));
        return {
          player: {
            agentId: data.player.agent_id,
            displayName: data.player.display_name,
            lifetimeScore: BigInt(data.player.score),
            createdAt: BigInt(data.player.created_at),
          },
          membership: data.membership && {
            tableId: data.membership.tableId,
            status: data.membership.status === "SEATED" ? MembershipStatus.SEATED : MembershipStatus.QUEUED,
            queuePosition: data.membership.queuePosition,
          },
        };
      },
    });
    router.service(ManagementService, {
      async switchGame(request, context) {
        return toConnectError(context.values.get(stubKey)!.switchGame(
          adminToken(context),
          request.enabled,
        ));
      },
    });
  },
  contextValues(_request, env) {
    return createContextValues().set(stubKey, env.POKER.getByName("global"));
  },
  fallback() {
    return new Response("Not found", { status: 404 });
  },
});

const app = new Hono<{ Bindings: Env }>();

app.on(["GET", "POST"], [
  "/poker.v1.SystemService/*",
  "/poker.v1.AuthService/*",
  "/poker.v1.PokerService/*",
  "/poker.v1.ManagementService/*",
], (context) => (
  rpc(
    context.req.raw as Parameters<typeof rpc>[0],
    context.env,
    context.executionCtx as Parameters<typeof rpc>[2],
  )
));
app.get("/ws", (context) => context.env.POKER.getByName("global").fetch(context.req.raw));
app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export default app;

function bearerToken(context: HandlerContext): string {
  const header = context.requestHeader.get("Authorization") ?? "";
  if (header.slice(0, 7).toLowerCase() !== "bearer " || header.length === 7) {
    throw new ConnectError("Bearer token is required", Code.Unauthenticated);
  }
  return header.slice(7);
}

function adminToken(context: HandlerContext): string {
  const token = context.requestHeader.get("X-Admin-Token");
  if (!token) throw new ConnectError("Admin token is required", Code.Unauthenticated);
  return token;
}

async function toConnectError<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const separator = message.indexOf(":");
    const code = separator < 0 ? "" : message.slice(0, separator);
    throw new ConnectError(separator < 0 ? message : message.slice(separator + 1).trim(), {
      ALREADY_EXISTS: Code.AlreadyExists,
      FAILED_PRECONDITION: Code.FailedPrecondition,
      INVALID_ARGUMENT: Code.InvalidArgument,
      NOT_FOUND: Code.NotFound,
      PERMISSION_DENIED: Code.PermissionDenied,
      RESOURCE_EXHAUSTED: Code.ResourceExhausted,
      UNAUTHENTICATED: Code.Unauthenticated,
      UNAVAILABLE: Code.Unavailable,
    }[code] ?? Code.Internal);
  }
}
