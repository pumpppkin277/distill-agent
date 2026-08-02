import assert from "node:assert/strict";
import test from "node:test";

import { MemoryContextStore } from "../dist/context.js";
import { DistillRuntime } from "../dist/runtime.js";

const team = {
  planner: { async plan() { return { goal: "publish", steps: ["write", "review"], contextIds: [] }; } },
  worker: { async execute() { return { ok: true, summary: "done", evidence: ["ref-1"] }; } },
  reviewer: { async review() { return { approved: true, summary: "verified" }; } },
};

test("medium-risk work pauses until approved", async () => {
  const runtime = new DistillRuntime(team, new MemoryContextStore());
  const result = await runtime.run({
    id: "task-1",
    text: "publish",
    scope: { tenantId: "tenant-a" },
    risk: "medium",
  });
  assert.equal(result.status, "approval_required");
});

test("verified work creates a reviewable Context candidate", async () => {
  const runtime = new DistillRuntime(team, new MemoryContextStore());
  const result = await runtime.run({
    id: "task-1",
    text: "publish",
    scope: { tenantId: "tenant-a" },
    risk: "medium",
    approved: true,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.candidate.status, "needs_review");
});
