# Distill Agent for Feishu

[简体中文](README.md) | [English](README.en.md)

A Feishu-native, recoverable, and verifiable multi-agent harness.

Distill Agent organizes messaging, grounded Context, registered abilities, durable execution, verification, independent review, and basic operations into one work system.

```text
Interaction → Cognition → Ability → Execution
      ↑                         ↓
      └──────── Governance ─────┘
```

The v0.2 execution graph is:

```text
Preflight → Execute → Verify → Review → Finalize
                 └── uncertain → Reconcile → STOP
```

## Included in v0.2

- LangGraph state graph with SQLite checkpoints;
- persistent Tasks, Confirmations, Attempts, Leases, Artifacts, and message deduplication;
- confirmation fingerprints and expiration;
- idempotent execution and fail-closed reconciliation;
- Ability Registry with execution and verification contracts;
- deterministic Verifier that cannot be overridden by Reviewer;
- SQLite Context Store with scope, revision, lifecycle, and review gates;
- pluggable Context Ingestor with immutable raw runs;
- two-phase grounded planning interface;
- Feishu/Lark WebSocket adapter and reply metadata;
- `/healthz` P0 operations check.

## Quick start

```bash
git clone https://github.com/pumpppkin277/distill-agent.git
cd distill-agent
pnpm install
cp .env.example .env
pnpm dev
```

Fill in your own Feishu/Lark app credentials. The bundled example ability is safe and performs no external writes. Send a message, then approve the returned task with:

```text
confirm <task-id>
```

Run verification locally:

```bash
pnpm typecheck
pnpm test
```

See the [Chinese README](README.md) for architecture, Ability SDK, Context ingestion, reliability guarantees, and roadmap details.

## Safety

Context is information, not permission. Production writes should require explicit confirmation, an input fingerprint, idempotency, external read-back, independent review, and auditable evidence.

MIT licensed. This is a community project and is not an official Feishu or Lark product.
