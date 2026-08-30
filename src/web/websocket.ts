import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import packageJson from "../../package.json";
import {
  ClientFrameSchema,
  ServerFrameSchema,
  type ServerFrame,
} from "../gen/poker/v1/event_pb.js";

type Subscription = { lobby: boolean; tableId?: string; afterEventSeq?: bigint };

export function subscribe(
  initial: Subscription,
  receive: (frame: ServerFrame) => void,
  status: (value: string) => void,
  current: () => Subscription = () => initial,
): () => void {
  let closed = false;
  let socket: WebSocket;
  let retry: number | undefined;
  const connect = () => {
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      status("live");
      socket.send(toBinary(ClientFrameSchema, create(ClientFrameSchema, {
        requestId: crypto.randomUUID(),
        clientVersion: packageJson.version,
        payload: { case: "subscribe", value: current() },
      })));
    };
    socket.onmessage = (event) => receive(fromBinary(ServerFrameSchema, new Uint8Array(event.data as ArrayBuffer)));
    socket.onerror = () => status("reconnecting");
    socket.onclose = () => {
      if (!closed) retry = window.setTimeout(connect, 1_000);
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry !== undefined) window.clearTimeout(retry);
    socket.close();
  };
}
