import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AbilityRegistry } from "../dist/abilities.js";
import { GroundedPlanner } from "../dist/cognitive.js";
import { SqliteContextStore } from "../dist/context.js";
import { DurableHarness } from "../dist/harness.js";
import { ContextIngestor, MarkdownDirectoryConnector } from "../dist/ingest.js";
import { runOpsCheck } from "../dist/ops.js";
import { DistillOrchestrator } from "../dist/orchestrator.js";
import { HarnessStore } from "../dist/store.js";

test("medium-risk task pauses, persists confirmation, and completes once", async () => {
  const fixture = await createFixture();
  const started = await fixture.orchestrator.start({
    text: "create demo",
    scope: { tenantId: "t1", chatId: "c1" },
    taskId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(started.status, "approval_required");
  const finished = await fixture.orchestrator.confirm(started.task.id, "message-confirm");
  assert.equal(finished.task.status, "completed");
  assert.equal(fixture.executions.count, 1);
  assert.equal(finished.task.verification.state, "verified");
  assert.equal(fixture.store.health().tasks, 1);
});

test("uncertain execution enters reconcile and is not replayed", async () => {
  const fixture = await createFixture({ uncertain: true });
  const started = await fixture.orchestrator.start({
    text: "create demo",
    scope: { tenantId: "t1" },
    taskId: "22222222-2222-4222-8222-222222222222",
  });
  const first = await fixture.orchestrator.confirm(started.task.id);
  assert.equal(first.task.status, "reconciling");
  assert.equal(fixture.executions.count, 1);
  await assert.rejects(() => fixture.orchestrator.confirm(started.task.id), /not_waiting_confirmation/);
  assert.equal(fixture.executions.count, 1);
  assert.equal(fixture.store.health().uncertainAttempts, 1);
});

test("deterministic verifier cannot be overridden by Reviewer", async () => {
  const fixture = await createFixture({ omitFact: true });
  const started = await fixture.orchestrator.start({
    text: "create demo",
    scope: { tenantId: "t1" },
    taskId: "33333333-3333-4333-8333-333333333333",
  });
  const finished = await fixture.orchestrator.confirm(started.task.id);
  assert.equal(finished.task.status, "failed");
  assert.equal(finished.task.verification.state, "rejected");
  assert.match(finished.task.review.summary, /Deterministic verification rejected/);
});

test("SQLite Context only returns reviewed records in the same scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "distill-context-"));
  const context = new SqliteContextStore(join(root, "context.sqlite"));
  const now = new Date().toISOString();
  await context.save({
    id: "ctx-1", kind: "workflow", scope: { tenantId: "t1", projectId: "p1" },
    status: "needs_review", summary: "create demo workflow", value: {},
    sources: [{ type: "document", ref: "doc-1", revision: "1", observedAt: now }],
    createdAt: now, updatedAt: now,
  });
  assert.equal((await context.search("create demo", { tenantId: "t1", projectId: "p1" })).length, 0);
  await context.review("ctx-1", "confirmed");
  assert.equal((await context.search("create demo", { tenantId: "t1", projectId: "p1" })).length, 1);
  assert.equal((await context.search("create demo", { tenantId: "t2", projectId: "p1" })).length, 0);
});

test("Context ingestor keeps a raw run and creates review candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "distill-ingest-"));
  const docs = join(root, "docs");
  const { mkdir, writeFile, access } = await import("node:fs/promises");
  await mkdir(docs);
  await writeFile(join(docs, "workflow.md"), "# Publish\nReview before publish.");
  const context = new SqliteContextStore(join(root, "context.sqlite"));
  const result = await new ContextIngestor(context, join(root, "runs")).ingest(
    new MarkdownDirectoryConnector(docs),
    { tenantId: "t1", projectId: "p1" },
  );
  assert.equal(result.sourceCount, 1);
  assert.equal(context.health().pendingReview, 1);
  await access(join(root, "runs", `${result.runId}.json`));
});

test("P0 ops check fails closed when an execution needs reconciliation", async () => {
  const fixture = await createFixture({ uncertain: true });
  const started = await fixture.orchestrator.start({
    text: "create demo", scope: { tenantId: "t1" },
    taskId: "44444444-4444-4444-8444-444444444444",
  });
  await fixture.orchestrator.confirm(started.task.id);
  const report = runOpsCheck(fixture.store, fixture.context);
  assert.equal(report.healthy, false);
  assert.equal(report.issues[0].id, "uncertain-execution-attempts");
});

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "distill-harness-"));
  const store = new HarnessStore(join(root, "harness.sqlite"));
  const context = new SqliteContextStore(join(root, "context.sqlite"));
  const executions = { count: 0 };
  const abilities = new AbilityRegistry().register({
    name: "demo", description: "demo", risk: "medium", triggers: [/create demo/],
    executionContract: "safe demo",
    verificationContract: { requiredFacts: ["resultId"], requireExternalReadback: false },
    reviewerChecklist: ["evidence exists"],
    async execute(task) {
      executions.count += 1;
      if (options.uncertain) {
        return { ok: false, summary: "timeout", evidence: [], externalState: "unknown" };
      }
      return {
        ok: true, summary: "created", evidence: [`task:${task.id}`],
        externalState: "not_applicable", writebackState: "not_applicable",
        facts: options.omitFact ? {} : { resultId: "demo-1" },
      };
    },
    async review(task) {
      return { ok: true, summary: "review passed", evidence: task.execution?.evidence ?? [] };
    },
  });
  const harness = new DurableHarness(store, abilities, join(root, "checkpoint.sqlite"));
  const orchestrator = new DistillOrchestrator(
    abilities, new GroundedPlanner(context), harness, store,
  );
  return { store, context, abilities, harness, orchestrator, executions };
}
