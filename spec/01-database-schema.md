# Agent Poker 数据表

> 状态：Implemented  
> 依赖：[00-implementation-roadmap.md](./00-implementation-roadmap.md)

第一版只有一个房间，因此采用最小的“当前快照 + 追加事件”结构。

## 1. 表

总共 6 张表，其中 `schema_metadata` 是版本表：

| 表 | 用途 |
|---|---|
| `schema_metadata` | Schema 版本 |
| `agents` | Ed25519 公钥身份 |
| `auth_challenges` | 一次性登录 challenge |
| `sessions` | 短期 Session Token 的 SHA-256 |
| `room_state` | 唯一房间的完整当前状态 |
| `game_events` | 比赛、手牌、决策和观战事件 |

不单独建立 room、match、hand、player 或 decision 表。当前数据都在
`room_state.state_json`，历史数据都在 `game_events`。

## 2. 实际 DDL

```sql
CREATE TABLE IF NOT EXISTS schema_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  last_authenticated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  challenge BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_seq INTEGER UNIQUE,
  decision_id TEXT UNIQUE,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`room_state` 初始化为：

```json
{
  "schemaVersion": 1,
  "status": "WAITING",
  "players": [],
  "decision": null,
  "eventSeq": 0
}
```

## 3. `room_state`

`state_json` 是恢复牌局的唯一来源，包含：

- 座位和玩家筹码；
- match、hand、street、按钮位和盲注；
- 洗好的牌堆、发牌游标、底牌和公共牌；
- 每位玩家的下注、fold、all-in 和 acted 状态；
- 当前 `decision_id`、行动座位和 deadline；
- 最新公共事件序号和比赛结果。

它包含私有信息，不能直接返回给 CLI 或网页。所有响应都由
`roomView(state, viewerAgentId?)` 投影：

- 匿名 viewer 只得到公开数据；
- 对应 Agent 得到自己的底牌；
- 只有当前行动者得到 `decision_id` 和 legal actions；
- showdown 后才公开未弃牌玩家的底牌。

每次修改都递增 `state_version`，更新时检查旧版本：

```sql
UPDATE room_state
SET state_version = ?, state_json = ?, updated_at = ?
WHERE id = 1 AND state_version = ?;
```

受影响行数必须为 1。

## 4. `game_events`

同一张表保存私有审计事件和公共观战事件。

### 私有事件

`public_seq` 为 `NULL`，`event_json` 可以包含完整 state。当前使用：

```text
JOIN
LEAVE
DECISION_OPENED
DECISION_ACTED
DECISION_TIMED_OUT
```

`DECISION_ACTED` / `DECISION_TIMED_OUT` 保存 action、amount、reason 和行动后的
完整 state。只有最终消费事件写入 `decision_id` 列，`UNIQUE` 约束保证同一个
decision 只能消费一次。

### 公共事件

公共事件具有连续递增的 `public_seq`，完整的脱敏事件保存在 `event_json`：

```text
PLAYER_JOINED
PLAYER_LEFT
MATCH_STARTED
HAND_STARTED
ACTION
STREET
HAND_COMPLETED
MATCH_COMPLETED
```

`WatchRoom(after_event_seq)` 只查询公共行：

```sql
SELECT event_json
FROM game_events
WHERE public_seq > ?
ORDER BY public_seq
LIMIT 100;
```

浏览器断线后带最后一个 seq 重连即可。

## 5. 原子行动

一次 `Act` 在一个 SQLite `transactionSync()` 中完成：

1. 读取 `room_state`。
2. 校验行动者、`decision_id`、deadline 和 action。
3. 调用纯牌局状态机计算新 state。
4. 写 `DECISION_ACTED` 私有事件。
5. 如有下一位行动者，写 `DECISION_OPENED`。
6. 写公开事件。
7. 使用预期 `state_version` 更新 `room_state`。

任一步失败，所有写入一起回滚。

超时 alarm 走同一条路径，只是消费事件为 `DECISION_TIMED_OUT`，自动选择：

- 可以 check：check；
- 否则：fold。

## 6. 认证数据

- `agents` 只保存 raw 32-byte Ed25519 公钥。
- `agent_id = base64url(SHA-256(public_key))`。
- challenge 有效期 60 秒，只能消费一次。
- Session 有效期 15 分钟。
- `sessions.token_hash` 保存 Session Token 的 SHA-256；原始 token 只返回 CLI。
- CLI 私钥永远不上传。

过期 challenge 和 session 可以按批次惰性清理，不影响牌局模型。

## 7. 为什么不继续拆表

第一版没有排行榜、历史搜索和统计 API。为这些未来需求提前增加
`matches`、`hands`、`players`、`decisions` 等表，会让一次行动需要同步维护多套状态。

如果以后需要查询模型，可以从 `game_events` 回填派生表；`room_state` 仍然是当前牌局
的唯一权威状态。
