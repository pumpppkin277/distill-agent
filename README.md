# Distill Agent for Feishu

[简体中文](README.md) | [English](README.en.md)

一个飞书原生、可恢复、可验证的多 Agent Harness。

> 把 Codex 等 Agent 的能力组织成团队可共享、可暂停恢复、可核验和可治理的工作系统。

Distill Agent 不是另一个聊天机器人。它解决的是任务开始之后的工程问题：执行到了哪里、能否继续、是否会重复写入、外部操作是否真的成功，以及 Reviewer 能否独立核验结果。

## 五层架构

```text
交互层：飞书消息、回复关系、确认与结果回写
   ↓
认知层：主 Agent 两阶段 Context 规划与 Grounded Plan
   ↓
能力层：Ability Registry、Skill、执行契约与验证契约
   ↓
执行层：LangGraph、Worker、Verifier、Reviewer、SQLite 状态
   ↓
治理层：健康探针、Context 积压与 Reconcile 告警
```

一项任务的默认执行图：

```text
Preflight → Execute → Verify → Review → Finalize
                 └── uncertain → Reconcile → STOP
```

模型或 Agent 负责理解和执行，确定性代码负责能力准入、确认、幂等、状态转换和结果验收。

## v0.2 已实现

- **LangGraph Durable Harness**：显式实现 Preflight、Execute、Verify、Review、Finalize 和 Reconcile 节点，并使用 SQLite Checkpoint 保存图状态。
- **持久化任务状态**：SQLite 保存 Task Snapshot、Confirmation、Attempt、Lease、Artifact 和消息幂等记录。
- **高风险确认门**：中高风险任务暂停执行；Confirmation 与任务输入指纹绑定并具有有效期。
- **防重复执行**：每次外部执行生成幂等键，Worker 获取写 Lease 后才能运行；已存在 Attempt 时进入 Reconcile，不盲目重放。
- **确定性验证**：Ability 声明必填事实、外部读回和回写要求；Reviewer 不能覆盖 Verifier 的拒绝结果。
- **独立 Reviewer 协议**：Worker 和 Reviewer 使用不同接口，通过持久化结果与证据交接。
- **SQLite Context Store**：Context 保留来源、Revision、Scope、生命周期和历史版本，只有 confirmed、未过期且范围匹配的记录可以召回。
- **Context Ingestor**：提供可插拔 Connector，并内置 Markdown 目录 Connector；每次采集先保存原始 Run，再生成 needs_review 候选。
- **两阶段认知接口**：先生成最多 4 个 Context Query，再基于召回证据生成 Grounded Plan。
- **飞书原生入口**：支持长连接、单聊/群聊、@ 清理、parent/root 回复关系和 message_id 幂等。
- **P0 运维观测**：`/healthz` 暴露任务数、Context 数、待确认 Context 和 uncertain Attempt；出现待对账执行时 fail closed。

## 快速开始

环境要求：Node.js 20+、pnpm，以及已开启机器人和长连接事件订阅的飞书/Lark 自建应用。

```bash
git clone https://github.com/pumpppkin277/distill-agent.git
cd distill-agent
pnpm install
cp .env.example .env
pnpm dev
```

在 `.env` 中填写自己的凭证：

```dotenv
FEISHU_APP_ID=cli_your_app_id
FEISHU_APP_SECRET=your_app_secret
HEALTH_PORT=8787
```

示例能力是一个不会写外部系统的 Medium Risk Skill。第一次发送消息后，Bot 会返回 Task ID；确认执行：

```text
confirm <task-id>
```

任务将经过完整的 LangGraph Harness，并把状态写入：

```text
data/harness.sqlite
data/context.sqlite
data/checkpoints.sqlite
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

## 注册业务能力

```ts
const abilities = new AbilityRegistry().register({
  name: "create_document",
  description: "Create and verify a Feishu document",
  risk: "medium",
  triggers: [/创建.*文档/],
  executionContract: "Create one document in the approved folder.",
  verificationContract: {
    requiredFacts: ["documentId", "readbackTitle"],
    requireExternalReadback: true,
  },
  reviewerChecklist: [
    "The title matches the request",
    "The returned document is accessible",
  ],
  async execute(task) {
    // 调用自己的 Skill 或工具，并重新读取目标系统。
    return {
      ok: true,
      summary: "Document created",
      evidence: ["https://example.feishu.cn/docx/xxx"],
      externalState: "verified",
      externalReferences: ["document:xxx"],
      writebackState: "not_applicable",
      facts: { documentId: "xxx", readbackTitle: "Project brief" },
    };
  },
  async review(task) {
    // 生产环境中应使用独立线程或只读 Reviewer Runtime。
    return {
      ok: Boolean(task.execution?.externalReferences?.length),
      summary: "Reviewer confirmed the read-back evidence",
      evidence: task.execution?.evidence ?? [],
    };
  },
});
```

## Context 采集与确认

```ts
const context = new SqliteContextStore("data/context.sqlite");
const ingestor = new ContextIngestor(context);

const run = await ingestor.ingest(
  new MarkdownDirectoryConnector("./knowledge"),
  { tenantId: "tenant-a", projectId: "project-a" },
);

// 自动采集只生成候选，必须审核后才能影响任务。
await context.review(run.candidateIds[0], "confirmed");
```

Context Connector 只负责读取来源。Ingestor 负责保存原始 Run、生成稳定 ID 和 needs_review 候选；Context Store 负责版本、Scope 与审核状态；Grounded Planner 负责在任务开始时召回证据。

## 可靠执行保证

| 问题 | Harness 行为 |
|---|---|
| 中高风险任务未确认 | Preflight 拒绝执行 |
| 用户确认后修改任务输入 | 输入指纹变化，原确认失效 |
| 相同任务重复触发 | 命中相同幂等 Attempt，进入 Reconcile |
| 多个 Worker 同时执行 | 只有持有 Lease 的 Worker 可以运行 |
| Worker 抛错或外部状态未知 | 状态持久化为 reconciling，禁止自动重试 |
| 缺少必填事实或读回证据 | Verifier 拒绝，Reviewer 无权升级为成功 |
| 业务成功但回写未完成 | 状态独立收口为 writeback_pending |
| 服务重启 | 使用 LangGraph Checkpoint 查看并恢复流程位置 |

## 项目结构

```text
src/
  abilities.ts      Ability Registry 与确定性验证契约
  cognitive.ts      两阶段 Context 查询与 Grounded Plan
  context.ts        Memory/SQLite Context Store 与审核状态
  ingest.ts         Context Connector 与原始 Run
  harness.ts        LangGraph Durable Execution Harness
  store.ts          Task、Confirmation、Attempt、Artifact、Lease
  orchestrator.ts   认知、确认与 Harness 编排
  feishu.ts         飞书长连接与消息标准化
  ops.ts            P0 健康探针
  protocol.ts       稳定任务与证据协议
  example-bot.ts    可运行的安全示例
```

## 测试

```bash
pnpm typecheck
pnpm test
```

测试覆盖：

- Confirmation 持久化与输入指纹绑定；
- Medium Risk 任务确认前暂停；
- 同一任务只执行一次；
- 状态不明进入 Reconcile；
- Verifier 拒绝不能被 Reviewer 覆盖；
- SQLite Context Scope 和审核状态；
- Context 原始 Run 与候选生成；
- uncertain Attempt 触发运维健康失败。

## 下一步

- 飞书交互式审批卡片和可恢复 Interrupt；
- 飞书 Doc、Sheet、Slides、Base Connector；
- 可插拔 LLM/Codex/Claude Worker 与 Reviewer Adapter；
- 能力专属 Reconcile 只读对账；
- Context 相关性、串线、负例和新鲜度评测包；
- P1 影子巡检、问题账本和版本化 Skill 指纹；
- Docker、CLI Scaffold 和更多端到端示例。

## 安全原则

Context 是信息，不是权限。生产写操作至少应具备人工确认、输入指纹、幂等键、外部状态读回、独立 Reviewer 和可追溯证据。

请勿提交真实 App Secret、访问令牌、租户/用户标识、内部文档链接、原始公司消息或生产 Context Store。

## License

[MIT](LICENSE)。社区开源项目，不是飞书或 Lark 官方产品。
