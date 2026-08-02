# Distill Agent for Feishu

[简体中文](README.md) | [English](README.en.md)

一个飞书原生的多 Agent Runtime：把可治理的团队 Context 转化为可核验的工作结果。

> 让开发者用少量代码，在飞书里部署一个可审批、可审核、能持续理解团队 Context 的 Agent 团队。

Distill Agent 是一个面向飞书/Lark 开发者的开源多 Agent 框架。它把 Planner、Worker 和独立 Reviewer 连接到飞书消息入口，并提供 Context 范围隔离、生命周期管理和人工确认门。

项目目前处于 Alpha 阶段，适合学习、实验和二次开发。真实业务写入前，请根据自己的工作流补齐持久化、权限、幂等和目标系统读回。

## 为什么做 Distill Agent

普通机器人通常只完成两步：收到消息，然后调用一次大模型。

Distill Agent 面向完整的工作闭环：

```text
飞书请求
  → 检索已确认的 Context
  → Planner 制定计划
  → 必要时等待人工确认
  → Worker 执行任务
  → Reviewer 独立审核
  → 返回带证据的结果
  → 生成新的 Context 待确认候选
```

它不只关心“Agent 回答了什么”，还关心：

- Agent 为什么这样判断；
- 使用了哪些工作背景；
- 这些背景是否已确认、是否过期；
- 高风险操作是否经过用户授权；
- Worker 是否提供了可核验的证据；
- Reviewer 是否独立确认了结果。

## 核心能力

### 1. 可治理的 Context

Context 不是无限增长的聊天记录，也不是执行授权。

每条 Context 都可以携带：

- 来源类型和来源引用；
- 可选的来源 revision；
- tenant、chat、user、project 范围；
- 明确的生命周期状态；
- 可选的过期时间；
- 人工评审边界。

当前支持五种状态：

```text
generated_draft → needs_review → confirmed → stale
                         └──────→ rejected
```

只有同时满足以下条件的 Context 才能进入任务检索结果：

1. 状态为 `confirmed`；
2. 没有过期；
3. 与当前 tenant/chat/user/project scope 兼容。

任务执行结果不会自动污染长期记忆，而是先生成 `needs_review` 候选。

### 2. 真实的多 Agent 边界

- **Planner**：理解请求，结合 Context 生成目标和步骤；
- **Worker**：执行任务并返回结果证据；
- **Reviewer**：独立检查结果和证据；
- **Runtime**：控制 Context 检索、人工确认和状态流转。

Worker 不能自己审核自己。只有执行成功且 Reviewer 通过，任务才会形成完成结果。

### 3. 人工确认门

任务风险分为：

- `low`：可以直接执行；
- `medium`：需要人工确认；
- `high`：需要人工确认。

当前 Alpha 版提供运行时确认暂停能力。后续将增加飞书交互卡片、可恢复确认和确认输入指纹。

### 4. 飞书原生入口

当前示例支持：

- 飞书/Lark 自建应用；
- 长连接接收消息；
- 单聊和群聊文本消息；
- 自动移除消息中的机器人 `@` 标签；
- 将 Agent 最终结果发送回原会话。

## 快速开始

### 环境要求

- Node.js 20 或更高版本；
- pnpm；
- 一个飞书或 Lark 自建应用；
- 已开启机器人能力；
- 已通过长连接订阅 `im.message.receive_v1` 事件。

### 1. 下载项目

```bash
git clone https://github.com/pumpppkin277/distill-agent.git
cd distill-agent
pnpm install
```

### 2. 配置飞书应用

```bash
cp .env.example .env
```

在 `.env` 中填写自己的应用凭证：

```dotenv
FEISHU_APP_ID=cli_your_app_id
FEISHU_APP_SECRET=your_app_secret
```

不要把 `.env`、App Secret 或访问令牌提交到 GitHub。

### 3. 启动

```bash
pnpm dev
```

启动后，在飞书中向机器人发送消息。示例 Worker 不会执行真实外部操作，只会生成演示结果和本地任务证据。

## 定义自己的 Agent 团队

```ts
import type { AgentTeam } from "./src/agents.js";

const team: AgentTeam = {
  planner: {
    async plan(request, context) {
      return {
        goal: request.text,
        steps: ["调研", "生成草稿", "审核"],
        contextIds: context.map((item) => item.id),
      };
    },
  },

  worker: {
    async execute(request, plan) {
      return {
        ok: true,
        summary: "草稿已经创建",
        evidence: ["feishu-doc:document-token"],
      };
    },
  },

  reviewer: {
    async review(request, result) {
      return {
        approved: result.ok && result.evidence.length > 0,
        summary: "已经核验结果证据",
      };
    },
  },
};
```

你可以把 Planner、Worker 和 Reviewer 分别连接到不同的模型、工具或 Agent Runtime。

## Context 示例

```ts
await contextStore.save({
  id: "workflow-publish-review",
  kind: "workflow",
  scope: {
    tenantId: "tenant-a",
    projectId: "project-a",
  },
  status: "confirmed",
  summary: "所有对外发布内容都需要独立审核",
  value: {
    rule: "review before publish",
  },
  sources: [
    {
      type: "document",
      ref: "document-token",
      revision: "3",
      observedAt: new Date().toISOString(),
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
```

如果任务来自另一个 tenant 或 project，这条 Context 不会被召回。

## 项目结构

```text
src/
  agents.ts        Agent 团队协议
  context.ts       Context 类型、scope 和生命周期门
  runtime.ts       Planner/Worker/Reviewer 执行流程
  feishu.ts        飞书长连接消息适配器
  example-bot.ts   可运行示例
  index.ts         公共导出入口

tests/
  context.test.mjs Context 隔离和确认状态测试
  runtime.test.mjs 审批和 Reviewer 流程测试
```

## 运行测试

```bash
pnpm typecheck
pnpm test
```

测试重点覆盖：

- Context 不跨 tenant/project 泄漏；
- 未确认的 Context 不能进入任务检索；
- 中高风险任务在执行前暂停；
- 通过 Reviewer 的结果只生成待确认 Context 候选。

## 当前状态与 Roadmap

当前已经提供：

- 飞书/Lark 长连接消息适配；
- Planner → Worker → Reviewer Runtime；
- tenant/chat/user/project Context scope；
- Context 生命周期和过期判断；
- 中高风险人工确认暂停；
- 证据检查和任务后 Context 候选；
- 自动测试和 GitHub Actions。

计划中的能力：

- SQLite Context 与任务持久化；
- 飞书交互式审批卡片；
- 可恢复的人工确认；
- 文档、Sheet、Slides、多维表格、日历和任务工具包；
- Durable checkpoint、幂等键和外部状态对账；
- 可插拔模型与 Agent Adapter；
- Context 增量同步、评审界面和召回质量评测。

## 安全原则

> Context 是信息，不是权限。

接入真实业务写操作前，建议至少实现：

1. 明确的用户确认；
2. 确认输入指纹；
3. 外部写入幂等键；
4. 目标系统状态读回；
5. 独立 Reviewer；
6. 可追溯的执行证据。

请勿提交：

- App Secret 和访问令牌；
- 真实 tenant、user、chat 标识；
- 公司内部文档链接；
- 原始飞书消息；
- 生产环境 Context Store；
- 业务后台凭证和 Cookie。

## 参与贡献

欢迎提交 Issue 和 Pull Request。修改 Context 行为时，请同时添加 scope、生命周期、过期和审批边界测试。

详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)

Distill Agent 是社区开源项目，不是飞书或 Lark 官方产品。
