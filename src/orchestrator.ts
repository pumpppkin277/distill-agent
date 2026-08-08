import { randomUUID } from "node:crypto";
import { AbilityRegistry } from "./abilities.js";
import { GroundedPlanner } from "./cognitive.js";
import type { ContextScope } from "./context.js";
import { DurableHarness, fingerprintTask } from "./harness.js";
import type { Confirmation, TaskRecord } from "./protocol.js";
import { HarnessStore } from "./store.js";

export type OrchestratorResult =
  | { status: "unsupported"; message: string }
  | { status: "approval_required"; task: TaskRecord; message: string }
  | { status: "finished"; task: TaskRecord; message: string };

export class DistillOrchestrator {
  constructor(
    private readonly abilities: AbilityRegistry,
    private readonly planner: GroundedPlanner,
    private readonly harness: DurableHarness,
    private readonly store: HarnessStore,
  ) {}

  async start(input: {
    text: string;
    scope: ContextScope;
    taskId?: string;
    replyTo?: string;
  }): Promise<OrchestratorResult> {
    const ability = this.abilities.match(input.text);
    if (!ability) return { status: "unsupported", message: "No registered ability matched this request." };
    const now = new Date().toISOString();
    const plan = await this.planner.plan({
      text: input.text,
      scope: input.scope,
      replyTo: input.replyTo,
      abilityNames: this.abilities.list().map((item) => item.name),
    });
    const task: TaskRecord = {
      id: input.taskId ?? randomUUID(), ability: ability.name, text: input.text,
      scope: input.scope, risk: ability.risk,
      status: ability.risk === "low" ? "received" : "needs_confirmation",
      plan, createdAt: now, updatedAt: now,
    };
    this.store.saveTask(task);
    if (ability.risk !== "low") {
      return {
        status: "approval_required",
        task,
        message: `Approval required for task ${task.id}: ${plan.goal}\n${plan.steps.join(" → ")}`,
      };
    }
    return this.finish(await this.harness.run(task));
  }

  async confirm(taskId: string, sourceMessageId?: string, ttlMs = 15 * 60_000): Promise<OrchestratorResult> {
    const task = this.store.task(taskId);
    if (!task) throw new Error(`task_not_found:${taskId}`);
    if (task.status !== "needs_confirmation") throw new Error(`task_not_waiting_confirmation:${task.status}`);
    const now = new Date();
    const confirmation: Confirmation = {
      id: randomUUID(), taskId, inputFingerprint: fingerprintTask(task),
      confirmedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      sourceMessageId,
    };
    this.store.saveConfirmation(confirmation);
    return this.finish(await this.harness.run(task));
  }

  private finish(task: TaskRecord): OrchestratorResult {
    return {
      status: "finished",
      task,
      message: task.status === "completed"
        ? `${task.execution?.summary ?? "Completed"}\nReview: ${task.review?.summary ?? "passed"}`
        : `Task stopped with status ${task.status}: ${task.execution?.summary ?? "unknown"}`,
    };
  }
}
