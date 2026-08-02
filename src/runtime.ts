import type { AgentTeam, TaskRequest } from "./agents.js";
import type { ContextRecord, ContextStore } from "./context.js";

export type RunResult =
  | { status: "approval_required"; message: string }
  | { status: "completed"; message: string; candidate: ContextRecord }
  | { status: "rejected"; message: string };

export class DistillRuntime {
  constructor(
    private readonly team: AgentTeam,
    private readonly context: ContextStore,
  ) {}

  async run(request: TaskRequest): Promise<RunResult> {
    const relevant = await this.context.search(request.text, request.scope);
    const plan = await this.team.planner.plan(request, relevant);

    if (request.risk !== "low" && !request.approved) {
      return {
        status: "approval_required",
        message: `需要确认：${plan.goal}\n计划：${plan.steps.join(" → ")}`,
      };
    }

    const result = await this.team.worker.execute(request, plan);
    const review = await this.team.reviewer.review(request, result);
    if (!result.ok || !review.approved) {
      return { status: "rejected", message: review.summary || result.summary };
    }

    const now = new Date().toISOString();
    const candidate: ContextRecord = {
      id: `context-${request.id}`,
      kind: "task",
      scope: request.scope,
      status: "needs_review",
      value: result,
      summary: result.summary,
      sources: [{ type: "task", ref: request.id, observedAt: now }],
      createdAt: now,
      updatedAt: now,
    };
    await this.context.save(candidate);
    return {
      status: "completed",
      message: `${result.summary}\n审核：${review.summary}\n证据：${result.evidence.join("、") || "无"}`,
      candidate,
    };
  }
}
