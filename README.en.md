# Distill Agent for Feishu

[简体中文](README.md) | [English](README.en.md)

A Feishu-native multi-agent runtime that turns governed team context into verified work.

> 让开发者用少量代码，在飞书里部署一个可审批、可审核、能持续理解团队 Context 的 Agent 团队。

Distill Agent is an early open-source starter for building production-minded Feishu/Lark assistants. It combines a Planner, Worker, and independent Reviewer with scoped Context and human approval gates.

## Why Distill Agent

Most bot frameworks stop after receiving a message and calling an LLM. Distill Agent models the complete work loop:

```text
Feishu request
  -> retrieve confirmed Context
  -> Planner
  -> human approval when required
  -> Worker
  -> independent Reviewer
  -> evidence-backed reply
  -> new Context candidate for review
```

### Governed Context

Context is not treated as an unlimited chat transcript or as authorization. Every record has:

- provenance and an optional source revision;
- tenant, chat, user, or project scope;
- an explicit lifecycle state;
- optional expiration;
- a review boundary before it can influence execution.

Only `confirmed`, unexpired, scope-compatible Context is retrieved for a task. New task outcomes become `needs_review` candidates instead of silently rewriting long-term memory.

### Real multi-agent boundaries

- **Planner** understands the request and builds a grounded plan.
- **Worker** performs the task and returns evidence.
- **Reviewer** independently decides whether the result is acceptable.
- **Runtime** enforces approval before medium- or high-risk execution.

## Quick start

Requirements: Node.js 20+, pnpm, and a Feishu/Lark custom app with bot capability and the `im.message.receive_v1` event enabled through long connection.

```bash
git clone https://github.com/pumpppkin277/distill-agent.git
cd distill-agent
pnpm install
cp .env.example .env
pnpm dev
```

Fill in your own app credentials in `.env`. The included Worker is deliberately harmless: it echoes a result and emits a local evidence reference. Replace the example team in `src/example-bot.ts` with your own model and tools.

## Define a team

```ts
const team = {
  planner: {
    async plan(request, context) {
      return {
        goal: request.text,
        steps: ["research", "draft", "review"],
        contextIds: context.map(item => item.id),
      };
    },
  },
  worker: {
    async execute(request, plan) {
      return {
        ok: true,
        summary: "Draft created",
        evidence: ["feishu-doc:document-token"],
      };
    },
  },
  reviewer: {
    async review(request, result) {
      return {
        approved: result.ok && result.evidence.length > 0,
        summary: "Evidence verified",
      };
    },
  },
};
```

## Current status

This is an alpha starter extracted from a larger internal reference implementation. It currently includes:

- Feishu/Lark long-connection message adapter;
- Planner → Worker → Reviewer runtime;
- tenant/chat/user/project Context scoping;
- Context lifecycle and expiration gates;
- approval pause for non-low-risk tasks;
- evidence requirement and post-task Context candidates;
- tests and GitHub Actions.

The following are intentionally left for upcoming releases:

- persistent SQLite Context and task stores;
- interactive approval cards and resumable approvals;
- document, Sheet, Slides, Base, Calendar, and Task tool packages;
- durable checkpoints, idempotency keys, and external-state reconciliation;
- pluggable model and agent adapters;
- Context ingestion, review UI, and recall evaluation packs.

## Safety model

Context is information, not permission. External writes should require explicit approval, an idempotency key, target-system read-back, and independent review. Never commit app secrets, access tokens, raw company messages, private document URLs, or production Context stores.

## License

MIT. This is a community project and is not an official Feishu or Lark product.
