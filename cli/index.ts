#!/usr/bin/env bun

import { ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import packageJson from "../package.json";
import { ActionType, AuthService, PokerService } from "../src/gen/poker/v1/poker_pb.js";

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

const help = `Usage: poker [options] <command>

Commands:
  join
  leave
  status
  logs [--before <id>] [--limit <count>]
  wait [--after <seq>] [--timeout <ms>]
  act <fold|check|call|raise> --decision <id> [--to <amount>] [--reason <text>]

Options:
  -s, --server <url>  Server URL
  --home <path>       Identity and session directory
  --name <name>       Display name for a new identity
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
      server: { type: "string", short: "s", default: process.env.POKER_SERVER_URL ?? "http://localhost:8787" },
      home: { type: "string", default: process.env.POKER_HOME ?? join(homedir(), ".poker") },
      name: { type: "string", default: process.env.POKER_NAME },
      after: { type: "string", default: "0" },
      before: { type: "string", default: "0" },
      limit: { type: "string", default: "20" },
      timeout: { type: "string", default: "25000" },
      decision: { type: "string", short: "d" },
      to: { type: "string", default: "0" },
      reason: { type: "string", default: "" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
    },
  });

  if (values.version) return void process.stdout.write(`${packageJson.version}\n`);
  if (values.help || positionals.length === 0) return void process.stdout.write(help);

  const [command, actionName, ...extra] = positionals;
  if (extra.length > 0) throw new Error(`unexpected argument: ${extra[0]}`);
  if (command !== "act" && actionName) throw new Error(`unexpected argument: ${actionName}`);
  if (!["join", "leave", "status", "logs", "wait", "act"].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  if (command === "act" && !actionName) throw new Error("missing action");
  if (command === "act" && !values.decision) throw new Error("missing --decision <id>");

  const options: Options = {
    server: values.server.replace(/\/$/, ""),
    home: values.home,
    name: values.name,
  };
  const client = createClient(PokerService, transport(options.server));
  const headers = { authorization: `Bearer ${await authenticate(options)}` };

  if (command === "join") return print(await client.joinRoom({}, { headers }));
  if (command === "leave") return print(await client.leaveRoom({}, { headers }));
  if (command === "status") return print(await client.getRoom({}, { headers }));
  if (command === "logs") {
    return print(await client.getMyLogs({
      beforeId: BigInt(values.before),
      limit: Number(values.limit),
    }, { headers }));
  }
  if (command === "wait") {
    let afterEventSeq = BigInt(values.after);
    while (true) {
      const response = await client.waitForTurn({
        afterEventSeq,
        timeoutMs: Number(values.timeout),
      }, { headers });
      if (!response.room || response.room.viewerQueuePosition === 0) return print(response);
      afterEventSeq = response.room.latestEventSeq;
    }
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
    if (session.server === options.server && session.expiresAt > Date.now() + 5_000) return session.token;
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
