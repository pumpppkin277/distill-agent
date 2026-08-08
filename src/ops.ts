import { createServer, type Server } from "node:http";
import type { SqliteContextStore } from "./context.js";
import { HarnessStore } from "./store.js";

export type OpsIssue = {
  id: string;
  severity: "info" | "warn" | "fail";
  summary: string;
};

export function runOpsCheck(
  store: HarnessStore,
  context?: SqliteContextStore,
  now = new Date(),
): { healthy: boolean; checkedAt: string; issues: OpsIssue[]; metrics: Record<string, number | string> } {
  const taskState = store.health();
  const contextState = context?.health();
  const issues: OpsIssue[] = [];
  if (taskState.uncertainAttempts > 0) {
    issues.push({
      id: "uncertain-execution-attempts",
      severity: "fail",
      summary: `${taskState.uncertainAttempts} execution attempt(s) require reconciliation.`,
    });
  }
  if (contextState?.pendingReview) {
    issues.push({
      id: "context-review-backlog",
      severity: "warn",
      summary: `${contextState.pendingReview} Context candidate(s) await review.`,
    });
  }
  return {
    healthy: !issues.some((issue) => issue.severity === "fail"),
    checkedAt: now.toISOString(),
    issues,
    metrics: {
      tasks: taskState.tasks,
      uncertainAttempts: taskState.uncertainAttempts,
      contextRecords: contextState?.total ?? 0,
      pendingContextReview: contextState?.pendingReview ?? 0,
      latestContextUpdate: contextState?.latestUpdatedAt ?? "missing",
    },
  };
}

export function startHealthServer(
  store: HarnessStore,
  options: { host?: string; port?: number; context?: SqliteContextStore } = {},
): Server {
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404).end("not found");
      return;
    }
    const report = runOpsCheck(store, options.context);
    response.writeHead(report.healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(report));
  });
  server.listen(options.port ?? 8787, options.host ?? "127.0.0.1");
  return server;
}
