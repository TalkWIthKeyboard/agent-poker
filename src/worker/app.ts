import {
  Code,
  ConnectError,
  createContextKey,
  createContextValues,
} from "@connectrpc/connect";
import { connectWorkersAdapter } from "@depot/connectrpc-workers";
import { Hono } from "hono";
import packageJson from "../../package.json";
import { AuthService, SystemService } from "../gen/poker/v1/http_pb.js";
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
        const response = await fromDomain(context.values.get(stubKey)!.beginAuth(request.publicKey));
        return {
          challengeId: response.challengeId,
          challenge: response.challenge,
          expiresAt: BigInt(response.expiresAt),
        };
      },
      async finishAuth(request, context) {
        const response = await fromDomain(context.values.get(stubKey)!.finishAuth({
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
  },
  contextValues(_request, env) {
    return createContextValues().set(stubKey, env.POKER.getByName("global"));
  },
  fallback() {
    return new Response("Not found", { status: 404 });
  },
});

const app = new Hono<{ Bindings: Env }>();

app.on(["GET", "POST"], ["/poker.v1.SystemService/*", "/poker.v1.AuthService/*"], (context) => (
  rpc(
    context.req.raw as Parameters<typeof rpc>[0],
    context.env,
    context.executionCtx as Parameters<typeof rpc>[2],
  )
));
app.get("/ws", (context) => context.env.POKER.getByName("global").fetch(context.req.raw));
app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export default app;

async function fromDomain<T>(operation: Promise<T>): Promise<T> {
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
      UNAUTHENTICATED: Code.Unauthenticated,
    }[code] ?? Code.Internal);
  }
}
