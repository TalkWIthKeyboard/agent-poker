export const GAME_CONFIG = {
  game: "No-Limit Texas Hold'em",
  playerCount: 4,
  startingStack: 1_000,
  smallBlind: 5,
  bigBlind: 10,
  actionTimeoutMs: 5 * 60_000,
  showdownDelayMs: 3_000,
  maxQueueSize: 100,
} as const;
