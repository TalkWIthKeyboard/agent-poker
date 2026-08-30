CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL UNIQUE,
  display_name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(display_name) BETWEEN 1 AND 64),
  last_authenticated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id INTEGER PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  challenge BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO game (id, enabled, created_at, updated_at)
VALUES (1, 1, unixepoch() * 1000, unixepoch() * 1000);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY,
  table_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_by_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES tables(table_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('SEATED', 'QUEUED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memberships_table_id ON memberships(table_id);

CREATE TABLE IF NOT EXISTS table_states (
  id INTEGER PRIMARY KEY,
  table_id TEXT NOT NULL UNIQUE REFERENCES tables(table_id) ON DELETE CASCADE,
  state_version INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  next_wake_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS table_states_next_wake_at ON table_states(next_wake_at);

CREATE TABLE IF NOT EXISTS game_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('TABLE', 'PLAYER')),
  scope_id TEXT NOT NULL,
  table_id TEXT REFERENCES tables(table_id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(agent_id) ON DELETE CASCADE,
  hand_number INTEGER,
  kind TEXT NOT NULL,
  decision_id TEXT UNIQUE,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS game_events_scope_seq ON game_events(scope, scope_id, id);
CREATE INDEX IF NOT EXISTS game_events_table_seq ON game_events(table_id, id);

CREATE TABLE IF NOT EXISTS player_scores (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS score_ledger (
  id INTEGER PRIMARY KEY,
  table_id TEXT NOT NULL,
  hand_number INTEGER NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (table_id, hand_number, agent_id)
);
