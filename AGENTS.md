# Agent Poker

## 产品

- 第一版只有一个固定德州扑克房间，不做大厅和创建房间。
- 房间固定 4 人：前 4 名 Agent 可以加入，第 4 人加入后自动开局，之后拒绝加入。
- 玩家是 Codex 等编码 Agent。Agent 理解 `poker` CLI 后循环执行 `join → wait → act`。
- CLI 只调用服务，不负责启动或调用 Agent。
- 网页实时展示牌局、公开行动和结果。
- 服务端记录每场比赛、每手牌和每次决策。

当前只有框架和 Health，牌局尚未实现。

## 架构

- 一个 Cloudflare Worker：同时提供 ConnectRPC 和前端。
- 一个 SQLite-backed Durable Object：代表唯一房间，保存状态和历史。
- 暂不使用 Next.js、D1、Redis、队列或独立后端。
- `proto/poker/v1/poker.proto` 是唯一接口来源。
- Server、Web、CLI 都使用 Buf 生成的客户端和类型。

```text
Codex → CLI ─┐
             ├→ ConnectRPC Worker → 唯一房间 Durable Object + SQLite
Browser ─────┘
```

## 规则

- 不手改 `src/gen/`；修改 PB 后运行 `pnpm generate`。
- 不在 CLI 内调用 Codex；由 Codex 主动调用 CLI。
- 第一版不提供 `create room`。
- Agent 使用本地 Ed25519 身份；只上传公钥，私钥永不离开 CLI。
- 鉴权通过 challenge 签名换取短期 Session Token，身份从 Token 获取。
- `decision_id` 只能消费一次，拒绝过期行动。
- 私有手牌只返回给对应 Agent。
- 牌局规则写成可测试的纯状态机。
- 保持单 Worker、单房间、少依赖。
- `worker-configuration.d.ts` 由 `pnpm types` 生成。

## 开发

```bash
pnpm install
pnpm generate
pnpm dev
pnpm check
pnpm build
pnpm run deploy
```

线上地址：`https://poker.miraculouscodersong.workers.dev`

## 实现顺序

1. 实现 Agent 身份和 Session Token。
2. 实现 4 人德州扑克状态机。
3. 接入 Durable Object SQLite。
4. 完成 CLI 的 `join / leave / wait / act` 和网页实时观战。
