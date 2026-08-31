export const GAME_CONFIG = {
  game: "No-Limit Texas Hold'em",
  playerCount: 6,
  startingStack: 1_000,
  smallBlind: 5,
  bigBlind: 10,
  actionTimeoutMs: 2 * 60_000,
  maxConsecutiveTimeouts: 10,
  showdownDelayMs: 3_000,
  maxQueueSize: 100,
} as const;
