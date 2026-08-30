import { TableStatus } from "../gen/poker/v1/entity_pb.js";

export type PlayerDisplayState =
  | "winner"
  | "busted"
  | "all-in"
  | "eliminated"
  | "folded"
  | "thinking"
  | "ready";

interface PlayerStateInput {
  stack: bigint;
  folded: boolean;
  allIn: boolean;
}

export function playerDisplayState(
  tableStatus: TableStatus | undefined,
  player: PlayerStateInput,
  acting: boolean,
): PlayerDisplayState {
  if (tableStatus === TableStatus.COMPLETE) {
    return player.stack > 0n ? "winner" : "busted";
  }
  if (tableStatus === TableStatus.PLAYING) {
    if (player.allIn) return "all-in";
    if (player.stack === 0n) return "eliminated";
    if (player.folded) return "folded";
    if (acting) return "thinking";
  }
  return "ready";
}

export function playerStateLabel(state: PlayerDisplayState): string {
  return {
    winner: "WINNER",
    busted: "BUSTED",
    "all-in": "ALL IN",
    eliminated: "OUT OF MATCH",
    folded: "OUT OF THIS HAND",
    thinking: "THINKING",
    ready: "READY",
  }[state];
}
