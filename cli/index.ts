#!/usr/bin/env bun

import { ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import packageJson from "../package.json";
import { ActionType, AdminService, AuthService, PokerService } from "../src/gen/poker/v1/poker_pb.js";

interface Options {
  server: string;
  home: string;
  name?: string;
}

interface Identity {
  publicKey: string;
  privateKeyPem: string;
  displayName: string;
}

interface Session {
  server: string;
  token: string;
  expiresAt: number;
}

interface CliConfig {
  server: string;
}

const help = `Usage: poker [options] <command>

Commands:
  config  Show the server's game and table parameters
  join
  leave  Fold immediately and leave after the hand
  status
  score
  logs [--before <id>] [--limit <count>]
  wait [--after <seq>] [--timeout <ms>]
  say --message <text>
  act <fold|check|call|raise> --decision <id> [--to <amount>] [--reason <text>]
  pause  Clear the room and reject joins (requires POKER_ADMIN_TOKEN)
  resume  Allow joins again (requires POKER_ADMIN_TOKEN)

Options:
  -s, --server <url>  Server URL; the config command saves it
  --home <path>       Identity and session directory
  --name <name>       Display name for a new identity
  --message <text>    Table chat message
  -h, --help          Show help
  -V, --version       Show version
`;

try {
  await main();
} catch (cause) {
  const error = cause instanceof ConnectError
    ? { error: cause.rawMessage, code: cause.code }
    : { error: cause instanceof Error ? cause.message : String(cause) };
  process.stderr.write(`${JSON.stringify(error)}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string", short: "s" },
      home: { type: "string", default: process.env.POKER_HOME ?? join(homedir(), ".poker") },
      name: { type: "string", default: process.env.POKER_NAME },
      after: { type: "string", default: "0" },
      before: { type: "string", default: "0" },
      limit: { type: "string", default: "20" },
      timeout: { type: "string", default: "25000" },
      decision: { type: "string", short: "d" },
      to: { type: "string", default: "0" },
      reason: { type: "string", default: "" },
      message: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
    },
  });

  if (values.version) return void process.stdout.write(`${packageJson.version}\n`);
  if (values.help || positionals.length === 0) return void process.stdout.write(help);

  const [command, actionName, ...extra] = positionals;
  if (extra.length > 0) throw new Error(`unexpected argument: ${extra[0]}`);
  if (command !== "act" && actionName) throw new Error(`unexpected argument: ${actionName}`);
  if (!["config", "join", "leave", "status", "score", "logs", "wait", "say", "act", "pause", "resume"].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  if (command === "act" && !actionName) throw new Error("missing action");
  if (command === "act" && !values.decision) throw new Error("missing --decision <id>");
  if (command === "say" && !values.message) throw new Error("missing --message <text>");

  const options: Options = {
    server: values.server
      ? normalizeServer(values.server)
      : process.env.POKER_SERVER_URL
        ? normalizeServer(process.env.POKER_SERVER_URL)
        : loadServerConfig() ?? "http://localhost:8787",
    home: values.home,
    name: values.name,
  };
  const client = createClient(PokerService, transport(options.server));
  if (command === "config") {
    const response = await client.getGameConfig({});
    if (values.server) saveServerConfig(options.server);
    return print(response);
  }
  if (command === "pause" || command === "resume") {
    const token = process.env.POKER_ADMIN_TOKEN;
    if (!token) throw new Error("POKER_ADMIN_TOKEN is required");
    const admin = createClient(AdminService, transport(options.server));
    return print(await admin.setRoomPaused(
      { paused: command === "pause" },
      { headers: { authorization: `Bearer ${token}` } },
    ));
  }
  const headers = { authorization: `Bearer ${await authenticate(options)}` };

  if (command === "join") return print(await client.joinRoom({}, { headers }));
  if (command === "leave") return print(await client.leaveRoom({}, { headers }));
  if (command === "status") return print(await client.getRoom({}, { headers }));
  if (command === "score") return print(await client.getMyScore({}, { headers }));
  if (command === "logs") {
    return print(await client.getMyLogs({
      beforeId: BigInt(values.before),
      limit: Number(values.limit),
    }, { headers }));
  }
  if (command === "wait") {
    let afterEventSeq = BigInt(values.after);
    while (true) {
      headers.authorization = `Bearer ${await authenticate(options)}`;
      const response = await client.waitForTurn({
        afterEventSeq,
        timeoutMs: Number(values.timeout),
      }, { headers });
      if (!response.room || response.room.viewerQueuePosition === 0) return print(response);
      afterEventSeq = response.room.latestEventSeq;
    }
  }
  if (command === "say") {
    return print(await client.sendChat({ text: values.message! }, { headers }));
  }
  if (command === "act") {
    return print(await client.act({
      decisionId: values.decision,
      action: parseAction(actionName!),
      amount: BigInt(values.to),
      reason: values.reason,
    }, { headers }));
  }
}

function transport(server: string) {
  return createConnectTransport({ baseUrl: server, httpVersion: "1.1" });
}

function configPath(): string {
  return join(homedir(), ".pocker", "config.json");
}

function loadServerConfig(): string | undefined {
  const path = configPath();
  if (!existsSync(path)) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`invalid JSON in ${path}`);
  }
  if (!config || typeof config !== "object" || typeof (config as Partial<CliConfig>).server !== "string") {
    throw new Error(`missing server in ${path}`);
  }
  return normalizeServer((config as CliConfig).server);
}

function saveServerConfig(server: string): void {
  const path = configPath();
  mkdirSync(join(homedir(), ".pocker"), { recursive: true, mode: 0o700 });
  writePrivateJson(path, { server });
}

function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid server URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("server URL must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

async function authenticate(options: Options): Promise<string> {
  mkdirSync(options.home, { recursive: true, mode: 0o700 });
  const strategyPath = join(options.home, "strategy.md");
  if (!existsSync(strategyPath)) {
    writeFileSync(strategyPath, "", { flag: "wx", mode: 0o600 });
    process.stderr.write(`Created ${strategyPath}. Add your poker strategy before playing.\n`);
  }
  const sessionPath = join(options.home, "session.json");
  if (existsSync(sessionPath)) {
    const session = JSON.parse(readFileSync(sessionPath, "utf8")) as Session;
    if (session.server === options.server && session.expiresAt > Date.now() + 30_000) return session.token;
  }

  const identity = loadIdentity(options);
  const client = createClient(AuthService, transport(options.server));
  const publicKey = Buffer.from(identity.publicKey, "base64url");
  const started = await client.beginAuth({ publicKey });
  const finished = await client.finishAuth({
    challengeId: started.challengeId,
    publicKey,
    signature: sign(null, Buffer.from(started.challenge), createPrivateKey(identity.privateKeyPem)),
    displayName: identity.displayName,
  });
  const session: Session = {
    server: options.server,
    token: finished.sessionToken,
    expiresAt: Number(finished.expiresAt),
  };
  writePrivateJson(sessionPath, session);
  return session.token;
}

function loadIdentity(options: Options): Identity {
  const path = join(options.home, "identity.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Identity;

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  if (!publicJwk.x) throw new Error("Node did not export the Ed25519 public key");
  const identity: Identity = {
    publicKey: publicJwk.x,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    displayName: options.name?.trim() || `Agent-${publicJwk.x.slice(0, 8)}`,
  };
  writePrivateJson(path, identity);
  return identity;
}

function writePrivateJson(path: string, value: object): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function parseAction(value: string): ActionType {
  const action = {
    fold: ActionType.FOLD,
    check: ActionType.CHECK,
    call: ActionType.CALL,
    raise: ActionType.RAISE,
  }[value.toLowerCase()];
  if (!action) throw new Error("action must be fold, check, call, or raise");
  return action;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, (key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (key === "action" && typeof item === "number") {
      return item === ActionType.UNSPECIFIED ? undefined : ActionType[item].toLowerCase();
    }
    if (key === "actions" && Array.isArray(item)) {
      return item.map((action) => ActionType[action as ActionType].toLowerCase());
    }
    return item;
  }, 2)}\n`);
}
