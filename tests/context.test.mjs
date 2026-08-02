import assert from "node:assert/strict";
import test from "node:test";

import { canUseContext, MemoryContextStore } from "../dist/context.js";

const confirmed = {
  id: "ctx-1",
  kind: "workflow",
  scope: { tenantId: "tenant-a", projectId: "project-a" },
  status: "confirmed",
  value: { rule: "review before publish" },
  summary: "review before publish",
  sources: [{ type: "document", ref: "doc-1", observedAt: "2026-01-01T00:00:00Z" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

test("Context is tenant and project scoped", () => {
  assert.equal(canUseContext(confirmed, confirmed.scope).usable, true);
  assert.equal(
    canUseContext(confirmed, { tenantId: "tenant-b", projectId: "project-a" }).usable,
    false,
  );
});

test("only confirmed and unexpired Context is retrievable", async () => {
  const store = new MemoryContextStore();
  await store.save(confirmed);
  await store.save({ ...confirmed, id: "ctx-2", status: "needs_review" });
  const result = await store.search("review publish", confirmed.scope);
  assert.deepEqual(result.map((item) => item.id), ["ctx-1"]);
});
