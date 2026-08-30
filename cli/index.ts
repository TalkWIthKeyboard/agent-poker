#!/usr/bin/env bun

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import packageJson from "../package.json";
import {
  ActionType,
  type Membership,
  type TableSnapshot,
} from "../src/gen/poker/v1/entity_pb.js";
import {
  ClientFrameSchema,
  ServerFrameSchema,
  type ClientFrame,
  type TableEvent,
  type ServerFrame,
} from "../src/gen/poker/v1/event_pb.js";
import { AuthService, ManagementService, PokerService } from "../src/gen/poker/v1/http_pb.js";

interface Options {
  server: string;
  home: string;
  name?: string;
  table: string;
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

class WebSocketDisconnected extends Error {}

const help = `Usage: poker [options] <command>

Commands:
  config  Show the server's game and table parameters
  tables  List tables and live seats
  create  Create an empty table
  membership  Show this identity's current table
  join --table <id>
  leave  Fold immediately and leave after the hand
  status
  score
  wait [--after <seq>] [--timeout <ms>]
  say --message <text>
  act <fold|check|call|raise> --decision <id> [--to <amount>] [--reason <text>]
  start  Start the game (requires POKER_ADMIN_TOKEN)
  stop  Stop the game and clear every table (requires POKER_ADMIN_TOKEN)

Options:
  -s, --server <url>  Server URL; the config command saves it
  --home <path>       Identity and session directory
  --name <name>       Display name for a new identity
  -t, --table <id>    Table ID; required for join
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
      table: { type: "string", short: "t", default: process.env.POKER_TABLE_ID ?? "" },
      after: { type: "string", default: "0" },
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
  if (!["config", "tables", "create", "membership", "join", "leave", "status", "score", "wait", "say", "act", "start", "stop"].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  if (command === "act" && !actionName) throw new Error("missing action");
  if (command === "act" && !values.decision) throw new Error("missing --decision <id>");
  if (command === "say" && !values.message) throw new Error("missing --message <text>");
  if (command === "join" && !values.table) {
    throw new Error("missing --table <id>; run tables first");
  }

  const options: Options = {
    server: values.server
      ? normalizeServer(values.server)
      : process.env.POKER_SERVER_URL
        ? normalizeServer(process.env.POKER_SERVER_URL)
        : loadServerConfig() ?? "http://localhost:8787",
    home: values.home,
    name: values.name,
    table: values.table,
  };
  const poker = createClient(PokerService, transport(options.server));
  if (command === "config") {
    const response = await poker.getConfig({});
    if (values.server) saveServerConfig(options.server);
    return print(response);
  }
  if (command === "tables") {
    return print({ tables: (await poker.getLobby({})).tables });
  }
  if (command === "start" || command === "stop") {
    const adminToken = process.env.POKER_ADMIN_TOKEN;
    if (!adminToken) throw new Error("POKER_ADMIN_TOKEN is required");
    const response = await createClient(ManagementService, transport(options.server)).switchGame(
      { enabled: command === "start" },
      { headers: { "X-Admin-Token": adminToken } },
    );
    return print(response);
  }
  if (command === "membership") {
    const me = await withSession(options, (token) => poker.getMe({}, authorization(token)));
    return print({ membership: me.membership });
  }
  if (command === "score") {
    const me = await withSession(options, (token) => poker.getMe({}, authorization(token)));
    return print({ score: me.player?.lifetimeScore ?? 0n });
  }
  const socket = await PokerConnection.open(options.server);
  try {
    let sessionToken = await authenticate(options);
    try {
      await socket.authenticate(sessionToken);
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.startsWith("UNAUTHENTICATED:")) throw cause;
      sessionToken = await authenticate(options, true);
      await socket.authenticate(sessionToken);
    }
    if (command === "create") {
      await socket.request({ case: "createTable", value: {} }, "ack");
      return print({ tableId: (await socket.nextTable()).tableId });
    }
    if (command === "join") {
      await socket.request({ case: "joinTable", value: { tableId: options.table } }, "ack");
      return print({ table: await socket.nextTable(options.table) });
    }
    if (command === "leave") {
      await socket.request({ case: "leaveTable", value: {} }, "ack");
      return print({ left: true });
    }
    if (command === "status") {
      const tableId = options.table || requireMembership(
        (await poker.getMe({}, authorization(sessionToken))).membership,
      ).tableId;
      return print({ table: await socket.nextTable(tableId, 30_000, true) });
    }
    if (command === "wait") {
      const tableId = options.table || requireMembership(
        (await poker.getMe({}, authorization(sessionToken))).membership,
      ).tableId;
      return print(await waitForTurn(socket, tableId, BigInt(values.after), Number(values.timeout)));
    }
    if (command === "say") {
      await socket.request({ case: "chat", value: { text: values.message! } }, "ack");
      return print({ accepted: true });
    }
    if (command === "act") {
      await socket.request({
        case: "act",
        value: {
          decisionId: values.decision!,
          action: parseAction(actionName!),
          amount: BigInt(values.to),
          reason: values.reason,
        },
      }, "ack");
      return print({ table: await socket.nextTable() });
    }
  } finally {
    socket.close();
  }
}

type ServerPayloadCase = Exclude<ServerFrame["payload"]["case"], undefined>;
type ClientPayload = NonNullable<Parameters<typeof create<typeof ClientFrameSchema>>[1]>["payload"];
type ServerFrameWith<C extends ServerPayloadCase> = ServerFrame & {
  payload: Extract<ServerFrame["payload"], { case: C }>;
};

class PokerConnection {
  private readonly frames: ServerFrame[] = [];
  private sessionToken?: string;
  private waiting?: {
    accept: (frame: ServerFrame) => boolean;
    resolve: (frame: ServerFrame) => void;
    reject: (cause: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  private constructor(
    private readonly server: string,
    private socket: WebSocket,
  ) {
    this.listen(socket);
  }

  private listen(socket: WebSocket): void {
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      const frame = fromBinary(ServerFrameSchema, new Uint8Array(event.data as ArrayBuffer));
      if (this.waiting?.accept(frame)) {
        const waiting = this.waiting;
        this.waiting = undefined;
        clearTimeout(waiting.timer);
        waiting.resolve(frame);
      } else {
        this.frames.push(frame);
      }
    };
    socket.onclose = () => {
      if (socket === this.socket) this.fail(new WebSocketDisconnected("WebSocket closed"));
    };
    socket.onerror = () => {
      if (socket === this.socket) this.fail(new WebSocketDisconnected("WebSocket connection failed"));
    };
  }

  static async open(server: string): Promise<PokerConnection> {
    return new PokerConnection(server, await PokerConnection.connect(server));
  }

  private static async connect(server: string): Promise<WebSocket> {
    const url = new URL("/ws", server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new WebSocketDisconnected(`Could not connect to ${url}`));
    });
    return socket;
  }

  async authenticate(sessionToken: string, timeout = 30_000): Promise<void> {
    await this.request({ case: "authenticate", value: { sessionToken } }, "ack", timeout);
    this.sessionToken = sessionToken;
  }

  async request<C extends ServerPayloadCase>(
    payload: ClientPayload,
    expected: C,
    timeout = 30_000,
  ): Promise<ServerFrameWith<C>> {
    const requestId = crypto.randomUUID();
    this.socket.send(toBinary(ClientFrameSchema, create(ClientFrameSchema, { requestId, payload })));
    const frame = await this.next((candidate) => (
      candidate.requestId === requestId
      && (candidate.payload.case === expected || candidate.payload.case === "error")
    ), timeout);
    if (frame.payload.case === "error") {
      throw new Error(`${frame.payload.value.code}: ${frame.payload.value.message}`);
    }
    return frame as ServerFrameWith<C>;
  }

  nextTable(tableId = "", timeout = 30_000, reconnect = false): Promise<TableSnapshot> {
    return this.next((frame) => (
      frame.payload.case === "tableSnapshot" && (!tableId || frame.payload.value.tableId === tableId)
    ), timeout, reconnect).then((frame) => (frame as ServerFrameWith<"tableSnapshot">).payload.value);
  }

  async next(
    accept: (frame: ServerFrame) => boolean,
    timeout = 30_000,
    reconnect = false,
  ): Promise<ServerFrame> {
    const deadline = Date.now() + timeout;
    while (true) {
      if (reconnect && this.socket.readyState !== WebSocket.OPEN) {
        await this.reconnect(deadline);
      }
      try {
        return await this.nextFrame(accept, Math.max(1, deadline - Date.now()));
      } catch (cause) {
        if (!reconnect || !(cause instanceof WebSocketDisconnected)) throw cause;
        await this.reconnect(deadline);
      }
    }
  }

  private nextFrame(accept: (frame: ServerFrame) => boolean, timeout: number): Promise<ServerFrame> {
    const index = this.frames.findIndex(accept);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]);
    if (this.waiting) throw new Error("Only one WebSocket response may be awaited at a time");
    return new Promise((resolve, reject) => {
      this.waiting = {
        accept,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiting = undefined;
          reject(new Error("DEADLINE_EXCEEDED: wait timed out"));
        }, timeout),
      };
    });
  }

  private async reconnect(deadline: number): Promise<void> {
    if (!this.sessionToken) throw new WebSocketDisconnected("WebSocket closed before authentication");
    this.socket.close();
    let lastError = new WebSocketDisconnected("Could not reconnect WebSocket");
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      try {
        const socket = await PokerConnection.connect(this.server);
        this.socket = socket;
        this.listen(socket);
        await this.authenticate(this.sessionToken, Math.max(1, deadline - Date.now()));
        return;
      } catch (cause) {
        if (!(cause instanceof WebSocketDisconnected)) throw cause;
        lastError = cause;
      }
    }
    throw lastError;
  }

  close(): void {
    this.socket.close();
  }

  private fail(cause: Error): void {
    if (!this.waiting) return;
    const waiting = this.waiting;
    this.waiting = undefined;
    clearTimeout(waiting.timer);
    waiting.reject(cause);
  }
}

function requireMembership(membership: Membership | undefined) {
  if (!membership) throw new Error("FAILED_PRECONDITION: Player is not seated or queued");
  return membership;
}

async function waitForTurn(
  socket: PokerConnection,
  tableId: string,
  afterEventSeq: bigint,
  timeoutMs: number,
): Promise<{ yourTurn: boolean; changed: boolean; table?: TableSnapshot; events: TableEvent[] }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeout must be a positive integer");
  const events: TableEvent[] = [];
  let table: TableSnapshot | undefined;
  while (true) {
    try {
      const frame = await socket.next((candidate) => (
        (candidate.payload.case === "event" || candidate.payload.case === "tableSnapshot")
        && candidate.payload.value.tableId === tableId
      ), timeoutMs, true);
      if (frame.payload.case === "event") {
        events.push(frame.payload.value);
      } else if (frame.payload.case === "tableSnapshot") {
        table = frame.payload.value;
      }
      if (!table) continue;
      if (table.viewerQueuePosition > 0) continue;
      if (table.decisionId || table.latestEventSeq > afterEventSeq) {
        return { yourTurn: Boolean(table.decisionId), changed: true, table, events };
      }
    } catch (cause) {
      if (table?.viewerQueuePosition) continue;
      if (cause instanceof Error && cause.message.startsWith("DEADLINE_EXCEEDED")) {
        return { yourTurn: Boolean(table?.decisionId), changed: false, table, events };
      }
      throw cause;
    }
  }
}

function transport(server: string) {
  return createConnectTransport({ baseUrl: server, httpVersion: "1.1" });
}

function authorization(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function withSession<T>(options: Options, operation: (token: string) => Promise<T>): Promise<T> {
  try {
    return await operation(await authenticate(options));
  } catch (cause) {
    if (!(cause instanceof ConnectError) || cause.code !== Code.Unauthenticated) throw cause;
    return operation(await authenticate(options, true));
  }
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

async function authenticate(options: Options, refresh = false): Promise<string> {
  mkdirSync(options.home, { recursive: true, mode: 0o700 });
  const strategyPath = join(options.home, "strategy.md");
  if (!existsSync(strategyPath)) {
    writeFileSync(strategyPath, "", { flag: "wx", mode: 0o600 });
    process.stderr.write(`Created ${strategyPath}. Add your poker strategy before playing.\n`);
  }
  const sessionPath = join(options.home, "session.json");
  if (!refresh && existsSync(sessionPath)) {
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
