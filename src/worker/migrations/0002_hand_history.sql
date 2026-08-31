CREATE TABLE IF NOT EXISTS hands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL,
  hand_number INTEGER NOT NULL CHECK (hand_number > 0),
  small_blind INTEGER NOT NULL CHECK (small_blind > 0),
  big_blind INTEGER NOT NULL CHECK (big_blind >= small_blind),
  dealer_seat INTEGER NOT NULL,
  small_blind_seat INTEGER NOT NULL,
  big_blind_seat INTEGER NOT NULL,
  board_json TEXT NOT NULL CHECK (json_valid(board_json)),
  result TEXT NOT NULL,
  pots_json TEXT NOT NULL CHECK (json_valid(pots_json)),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL CHECK (ended_at >= started_at),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (table_id, hand_number)
);

CREATE TABLE IF NOT EXISTS hand_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hand_id INTEGER NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  seat INTEGER NOT NULL,
  starting_stack INTEGER NOT NULL CHECK (starting_stack >= 0),
  ending_stack INTEGER NOT NULL CHECK (ending_stack >= 0),
  hole_cards_json TEXT NOT NULL CHECK (json_valid(hole_cards_json)),
  revealed INTEGER NOT NULL CHECK (revealed IN (0, 1)),
  showdown_rank TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (hand_id, agent_id),
  UNIQUE (hand_id, seat)
);

CREATE INDEX IF NOT EXISTS hand_players_agent_hand
ON hand_players(agent_id, hand_id DESC);

CREATE TABLE IF NOT EXISTS hand_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hand_id INTEGER NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  street TEXT NOT NULL CHECK (street IN ('PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN')),
  action TEXT NOT NULL CHECK (action IN (
    'POST_SMALL_BLIND', 'POST_BIG_BLIND', 'CHECK', 'CALL', 'RAISE', 'FOLD', 'PAYOUT'
  )),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  bet_to INTEGER NOT NULL CHECK (bet_to >= 0),
  pot_after INTEGER NOT NULL CHECK (pot_after >= 0),
  stack_after INTEGER NOT NULL CHECK (stack_after >= 0),
  automatic INTEGER NOT NULL CHECK (automatic IN (0, 1)),
  pot_before INTEGER CHECK (pot_before >= 0),
  stack_before INTEGER CHECK (stack_before >= 0),
  legal_actions_json TEXT CHECK (legal_actions_json IS NULL OR json_valid(legal_actions_json)),
  call_amount INTEGER CHECK (call_amount >= 0),
  min_raise_to INTEGER CHECK (min_raise_to >= 0),
  max_raise_to INTEGER CHECK (max_raise_to >= 0),
  reason TEXT,
  response_time_ms INTEGER CHECK (response_time_ms >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (hand_id, seq)
);
