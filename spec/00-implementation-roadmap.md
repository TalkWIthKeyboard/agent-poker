# Agent Poker 第一版实现路线（讨论稿）

> 状态：Draft  
> 目标：把当前只有 Health 的框架，逐步实现为一个可由 4 个编码 Agent 完整游玩的固定德州扑克房间。  
> 本文先确定模块边界、交付顺序和验收方式；仍有分歧的产品规则集中列在文末讨论。

## 1. 第一版的完成定义

第一版完成时，应当能够：

1. 4 个 Agent 分别在本地生成并持有 Ed25519 身份，通过 challenge 签名取得短期 Session Token。
2. 前 4 个不同身份依次加入唯一房间；第 4 人加入后自动开始比赛，此后拒绝新玩家。
3. 每个 Agent 通过 CLI 重复执行 `wait → act`，直到比赛结束。
4. 服务端正确执行多手 4 人无限注德州扑克，包括盲注、下注轮、全押、边池、摊牌和淘汰。
5. `decision_id` 只能成功消费一次，旧决策、重复决策和超时决策都被拒绝。
6. Agent 只能看到自己的底牌；匿名网页只能看到公共状态、公共行动、摊牌和结果。
7. 网页无需刷新即可持续看到牌局变化。
8. SQLite 中可以追溯每场比赛、每手牌、每次决策和公共事件。

暂不包含大厅、创建房间、多房间、聊天、充值、断线托管策略配置和水平扩展。

## 2. 建议的代码边界

牌局规则不能依赖 Cloudflare、SQLite、ConnectRPC、系统时间或随机数。建议拆成以下层次：

```text
src/domain/            纯状态机、牌型判断、下注规则、公开/私有视图
src/worker/            ConnectRPC、鉴权、唯一 DO 路由、错误映射
src/worker/storage/    SQLite schema、状态装载、原子提交、历史查询
cli/                   本地身份、Session、join/wait/act 命令
src/web/               公共快照、事件流和牌桌展示
proto/                 所有外部接口的唯一来源
```

核心状态机可采用类似下面的接口：

```ts
type Transition =
  | { ok: true; state: MatchState; events: DomainEvent[] }
  | { ok: false; error: RuleError };

function reduce(
  state: MatchState,
  command: GameCommand,
): Transition;
```

时间和随机性由外层明确输入：

- 开始一手牌时传入已经洗好的 52 张牌，而不是在状态机里调用随机数。
- 超时由外层发出 `ExpireDecision { decisionId, now }` 命令。
- 新的 `decision_id`、时间戳和 deadline 由应用层生成后作为命令参数传入。

这样可以对任意牌局进行确定性重放，也便于用固定牌堆覆盖边池和牌型测试。

## 3. 请求如何进入唯一 Durable Object

建议让顶层 Worker 只负责静态资源、Health 和 RPC 分流：

```text
/poker.v1.AuthService/*  ─┐
/poker.v1.PokerService/* ─┼→ POKER_MATCHES.idFromName("main") → PokerMatch
/poker.v1.SystemService/* ┘  （Health 也可继续留在顶层）
```

Auth 和 Poker 的 ConnectRPC handler 直接运行在 `PokerMatch` 内。这样有几个好处：

- challenge、session、座位和牌局都由同一个串行执行点管理；
- 第 4 人加入、行动校验和状态提交不会跨 Worker 实例竞态；
- `WaitForTurn` 和 `WatchRoom` 可以直接等待该 DO 内的新事件；
- 不需要额外的内部 RPC 协议或独立后端。

固定使用 `idFromName("main")`，不从用户输入获取房间 ID。

## 4. 分阶段实现

### M0：先冻结第一版规则和接口

在写状态机前先回答文末的产品问题，并据此检查 `poker.proto`。重点确认：

- 比赛何时结束；
- 初始筹码、盲注和盲注是否增长；
- 行动超时后的默认动作；
- 开局后 `leave` 的含义；
- 是否公开 Agent 提交的 `reason`；
- 网页首次加载和事件断线重连的语义。

接口一旦调整，运行 `pnpm generate`，只提交 proto 和生成结果，不手改 `src/gen/`。

验收：proto 能完整表达已确认的第一版规则，contract test 覆盖所有 RPC 和关键字段。

### M1：身份、challenge 和 Session Token

#### 本地身份

- CLI 第一次运行时生成 Ed25519 密钥对，之后复用。
- 私钥只保存在本地配置目录，文件权限设为仅当前用户可读写。
- 上传 raw 32-byte 公钥；`agent_id = base64url(SHA-256(raw_public_key))`。
- display name 只在公钥第一次注册时写入，后续认证不能借此改名。

#### Challenge

- `BeginAuth` 校验公钥长度，生成不可预测的 challenge 和 `challenge_id`。
- challenge 绑定协议域、challenge ID、公钥和过期时间，避免签名被挪作他用。
- challenge 短期有效、只能成功消费一次；无论成功、过期还是签名错误达到限制，都不能重放。
- `FinishAuth` 使用 Web Crypto 验证 Ed25519 签名。

#### Session

第一版建议使用随机 opaque bearer token，而不是引入 JWT 依赖：

- 返回给 CLI 原始 token；
- SQLite 只保存 token 的 SHA-256、agent ID 和过期时间；
- 每个受保护 RPC 从 `Authorization: Bearer <token>` 恢复 agent ID；
- token 短期有效，CLI 可缓存；失效时自动重新 challenge 登录；
- 日志和错误中绝不输出 token、签名或私钥。

建议表：

```text
agents
auth_challenges
sessions
```

验收：首次注册、再次登录、伪造签名、challenge 重放、过期 challenge、过期 session、改名尝试都有测试。

### M2：纯德州扑克状态机

先完全脱离 Durable Object 开发，按以下顺序实现：

1. 牌、牌堆、座位、按钮位、大小盲位置。
2. 开始一手牌、发底牌、收取盲注。
3. preflop / flop / turn / river 的行动顺序和换街。
4. fold / check / call / raise 的合法动作与金额。
5. 全押、最小加注、未达到完整加注时是否重新开放行动。
6. 所有人弃牌时直接结算。
7. 主池、任意数量边池和不可争夺筹码的返还。
8. 7 选 5 牌型比较、平局分池和奇数筹码分配。
9. 摊牌、筹码更新、淘汰、按钮移动和下一手。
10. 最终胜者与比赛结束。

建议不要一开始把整个流程写成一个大 reducer。可以保留一个公开的 `reduce` 入口，内部拆成：

- `legalActions(state, seat)`
- `applyAction(state, action)`
- `advanceStreetOrSettle(state)`
- `buildPots(players)`
- `evaluateBestHand(cards)`
- `startNextHand(state, deck, metadata)`
- `toPublicView(state)` / `toAgentView(state, agentId)`

测试应至少覆盖：

- 4 人正常走完一手；
- preflop 大盲 check；
- 小筹码 call 导致全押；
- 短码 all-in raise 不重新开放已行动玩家；
- 多次 full raise 后的最小加注；
- 一人未弃牌提前获胜；
- 两层及以上边池且赢家不同；
- 平分底池和奇数筹码；
- 同花、顺子、葫芦等容易比较错误的牌型；
- 多人淘汰后 3 人和 heads-up 的按钮及盲注规则；
- 固定牌堆重放产生完全相同的状态与事件。

验收：状态机测试不导入任何 Cloudflare 或数据库模块；固定输入得到固定输出。

### M3：SQLite 持久化与原子决策

第一版使用精简的“当前状态快照 + 追加事件”模型，详细设计见
[01-database-schema.md](./01-database-schema.md)：

```text
room_state       唯一一行，保存完整当前状态和版本
game_events      追加保存比赛、手牌、决策和公共观战事件
```

一次有效 `Act` 必须在同一个 DO 存储事务中完成：

1. 从 Session Token 得到 agent ID。
2. 读取当前状态，确认正轮到该 Agent。
3. 确认 `decision_id` 正是当前未消费且未过期的决策。
4. 用纯状态机验证并执行 action。
5. 写入唯一的 decision 消费事件、新状态和公共事件。
6. 提交后唤醒 `WaitForTurn` / `WatchRoom` 的等待者。

Durable Object 的串行执行减少了并发面，但不能只依赖内存：重启或驱逐后仍要从 SQLite 恢复。建议状态增加递增 `version`，更新时带预期版本，防止未来重构引入静默覆盖。

每当创建当前决策时设置 alarm。deadline 到达后：

- 如果 check 合法，自动 check；
- 否则自动 fold；
- 仍然写入一条 decision 和公共事件；
- alarm 中用同一个 `decision_id` 再校验，旧 alarm 不得影响新回合。

验收：DO 重建后牌局继续；并发提交同一 decision 只有一个成功；旧 action、重复 action 和 alarm/action 竞态都有测试。

### M4：接通 PokerService

按最短可玩链路接入：

1. `JoinRoom`
2. `GetRoom`
3. `WaitForTurn`
4. `Act`
5. `LeaveRoom`
6. `WatchRoom`

视图构造必须集中处理，不能让 handler 随手删除字段：

- 匿名 `GetRoom`：只返回公共快照；
- 已认证 `GetRoom`：若是玩家，额外返回自己的底牌和轮到自己时的 legal actions；
- `WaitForTurn` / `Act`：只返回调用者视图；
- `WatchRoom`：事件内永远使用公共快照，即使请求带有玩家 token；
- 未摊牌玩家的底牌绝不进入公共事件 JSON、日志或错误。

ConnectRPC 错误建议稳定映射：

```text
Unauthenticated     token 缺失、无效或过期
PermissionDenied    身份无权执行该操作
FailedPrecondition  房间状态或行动阶段不允许
InvalidArgument     action/amount/timeout 参数错误
AlreadyExists       已入座或房间已满
DeadlineExceeded    decision 已过期
NotFound            decision/challenge 不存在
```

`WaitForTurn(after_event_seq, timeout_ms)` 使用有上限的长轮询：

- 已有更新时立即返回；
- 已轮到调用者时立即返回；
- 否则等待新事件或超时；
- 超时是正常响应，不用 RPC error；
- 客户端带回最新 seq，避免无意义地重复获取。

`WatchRoom(after_event_seq)` 先补发 SQLite 中缺失的公共事件，再持续推送新事件。断线后浏览器用最后收到的 seq 重连。

验收：用生成的客户端完成一手牌；公共响应经过自动化泄密检查。

### M5：CLI 可玩闭环

CLI 每个命令都应输出稳定、适合 Agent 读取的 JSON，并用非零退出码表示失败。建议命令：

```bash
poker join
poker leave
poker status
poker wait --after <seq> --timeout <ms>
poker act --decision <id> fold
poker act --decision <id> check
poker act --decision <id> call
poker act --decision <id> raise --to <amount> --reason "..."
```

用户要求的循环仍然是：

```text
join → wait → act → wait → act → ... → complete
```

认证应是 CLI 的透明前置步骤：读取/创建身份，复用未过期 session，必要时重新登录。CLI 不启动、不发现、也不调用任何编码 Agent。

`wait` 的输出要直接包含：

- 是否轮到自己；
- 最新 event seq；
- public room snapshot；
- 自己的底牌；
- legal actions、call amount、min/max raise-to；
- 当前 `decision_id` 和 deadline。

验收：4 个独立配置目录模拟 4 个 Agent，仅通过 CLI 打完比赛；私钥文件从未离开各自目录。

### M6：网页实时观战

网页分两步做：

1. 先用 `GetRoom + WatchRoom` 显示房间状态、座位、筹码、公共牌、底池、当前行动者和事件时间线。
2. 再补充摊牌动画、每手结果、比赛结果和断线重连状态。

网页只使用生成的 ConnectRPC 客户端和类型。第一版不提供网页入座或操作能力。

验收：刷新后能从快照恢复；流断开后从 event seq 续传；页面和网络响应中没有未公开底牌。

### M7：端到端与上线

建立一个可重复的四玩家冒烟脚本，但脚本只调用 CLI，不内嵌 Agent：

1. 使用 4 份临时身份目录。
2. 依次 join，确认第 4 人触发开局、第 5 人被拒绝。
3. 根据 legal actions 选择确定的合法动作。
4. 打到比赛结束或覆盖一组规定场景。
5. 校验 SQLite/公开事件/私有视图的一致性。

每个里程碑都保持：

```bash
pnpm generate
pnpm check
pnpm build
```

全部通过后再部署，并对线上 Health、认证、加入、等待、行动和观战分别做一次冒烟验证。

## 5. 建议的提交切片

每个切片都应可测试、可审阅，避免一次同时改完所有层：

1. proto 冻结与错误语义。
2. CLI Ed25519 身份模块。
3. AuthService + SQLite challenge/session。
4. domain 基础类型与发牌/行动顺序。
5. betting reducer 与 legal actions。
6. 牌型、边池和结算。
7. 多手比赛生命周期。
8. room SQLite repository 与 schema migration。
9. Join/Get/Wait/Act。
10. timeout alarm、Leave 和 Watch。
11. CLI 完整命令。
12. Web 观战。
13. E2E、泄密检查和线上冒烟。

## 6. 横向约束

### 安全

- 私钥、Session Token、未公开底牌不进入日志。
- display name、reason 和所有字符串都设长度上限，网页按普通文本渲染。
- `timeout_ms`、raise amount、event replay 数量都设服务端上限。
- challenge/session 定期惰性清理，避免 SQLite 无界增长。
- 随机 token、challenge、洗牌使用密码学安全随机源。

### 可观测性

日志只记录安全的结构化字段：

```text
request_id, rpc, agent_id, match_id, hand_number,
decision_id, event_seq, result_code, duration_ms
```

不要记录 Authorization header、签名原文、底牌或完整私有 snapshot。

### 数据演进

- 使用显式 schema version 和向前 migration。
- 不修改已经发布的 migration。
- SQLite 历史是审计记录；当前 `room_state` 是恢复入口。
- Domain event 和 state JSON 都带版本，避免未来无法读取旧比赛。

## 7. 需要先讨论并拍板的问题

下面给出偏向“规则简单且能尽快玩起来”的默认建议：

1. **比赛形式**：建议锦标赛式 freezeout；每人 1,000 筹码，最后一名有筹码的玩家获胜。
2. **盲注**：建议第一版固定 5/10，不自动增长，先减少定时器和赛制复杂度。
3. **行动时限**：建议 60 秒；超时能 check 就 check，否则 fold。
4. **等待玩家时 leave**：建议允许并立即释放座位，之后来的玩家补位。
5. **开局后 leave**：建议视为永久离桌；当前手立即 fold，之后不再发牌，但筹码如何处理需要明确。更简单的选择是第一版开局后禁止 leave，只能等待超时托管。
6. **比赛结束后的房间**：固定唯一房间无法自然开始第二场。建议第一版结束后保持只读 COMPLETE，运维重置；若产品需要连续比赛，则 proto 和状态机要增加明确的 reset/rematch 规则。
7. **reason 是否公开**：建议完整保存用于审计，但网页默认公开展示；需要限制长度并明确 Agent 不应放入秘密。如果只想公开动作，可让 reason 仅服务端保存。
8. **摊牌规则**：建议进入 showdown 的所有未弃牌玩家都公开底牌，避免复杂的 muck 选择。
9. **奇数筹码**：建议从按钮左侧开始，按顺时针依次分配。
10. **Session 有效期**：建议 15 分钟，CLI 自动续登；challenge 有效期 60 秒。
11. **历史保留**：建议第一版永久保存 match/hand/decision/event，不提供删除 API。
12. **重置方式**：若需要开发期反复测试，建议只提供本地/测试环境的管理脚本，不加入公开 PokerService。

## 8. 当前建议

先不要直接从 `JoinRoom` 开写。下一步应当先确认第 7 节，随后完成 M0 和 M1。与此同时可以为 M2 建好纯 domain 测试骨架，但在盲注、leave、超时和比赛结束语义确定前，不实现完整比赛生命周期。
