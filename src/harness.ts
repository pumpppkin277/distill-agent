import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { AbilityRegistry, verifyAbilityResult } from "./abilities.js";
import type { AgentResult, Attempt, TaskRecord, TaskStatus } from "./protocol.js";
import { HarnessStore } from "./store.js";

const HarnessState = Annotation.Root({
  task: Annotation<TaskRecord>(),
  attempt: Annotation<Attempt | undefined>(),
  execution: Annotation<AgentResult | undefined>(),
  verification: Annotation<(AgentResult & { state: "verified" | "rejected" | "uncertain" }) | undefined>(),
  reviewResult: Annotation<AgentResult | undefined>(),
  route: Annotation<"verify" | "review" | "reconcile" | undefined>(),
});

type State = typeof HarnessState.State;

export class DurableHarness {
  private readonly graph;

  constructor(
    private readonly store: HarnessStore,
    private readonly abilities: AbilityRegistry,
    checkpointPath: string,
  ) {
    mkdirSync(dirname(checkpointPath), { recursive: true });
    this.graph = new StateGraph(HarnessState)
      .addNode("preflight", (state) => this.preflight(state))
      .addNode("execute", (state) => this.execute(state))
      .addNode("verify", (state) => this.verify(state))
      .addNode("review", (state) => this.review(state))
      .addNode("reconcile", (state) => this.reconcile(state))
      .addNode("finalize", (state) => this.finalize(state))
      .addEdge(START, "preflight")
      .addEdge("preflight", "execute")
      .addConditionalEdges("execute", (state) => state.route ?? "review", {
        verify: "verify", review: "review", reconcile: "reconcile",
      })
      .addEdge("verify", "review")
      .addEdge("review", "finalize")
      .addEdge("reconcile", END)
      .addEdge("finalize", END)
      .compile({ checkpointer: SqliteSaver.fromConnString(checkpointPath) });
  }

  async run(task: TaskRecord): Promise<TaskRecord> {
    const result = await this.graph.invoke(
      { task, attempt: undefined, execution: undefined, verification: undefined, reviewResult: undefined, route: undefined },
      { configurable: { thread_id: task.id } },
    );
    return result.task;
  }

  async resume(taskId: string): Promise<TaskRecord> {
    const result = await this.graph.invoke(null as never, {
      configurable: { thread_id: taskId },
    });
    if (!result.task) throw new Error(`missing_checkpoint:${taskId}`);
    return result.task;
  }

  async snapshot(taskId: string): Promise<{ next: readonly string[]; task?: TaskRecord }> {
    const snapshot = await this.graph.getState({ configurable: { thread_id: taskId } });
    const values = snapshot.values as Partial<State>;
    return { next: snapshot.next, task: values.task };
  }

  private async preflight(state: State): Promise<Partial<State>> {
    const ability = this.abilities.get(state.task.ability);
    const task = this.persist(state.task, "preflight", "preflight");
    if (ability.risk !== "low") {
      const fingerprint = fingerprintTask(task);
      if (!this.store.validConfirmation(task.id, fingerprint)) {
        throw new Error(`missing_or_expired_confirmation:${task.id}`);
      }
    }
    return { task };
  }

  private async execute(state: State): Promise<Partial<State>> {
    const ability = this.abilities.get(state.task.ability);
    const fingerprint = fingerprintTask(state.task);
    const idempotencyKey = sha256(`${state.task.id}:${state.task.ability}:${fingerprint}`);
    const existing = this.store.attemptByKey(idempotencyKey);
    if (existing) {
      const artifactTask = this.persist(state.task, "reconciling", "reconcile");
      return {
        task: artifactTask,
        attempt: existing,
        execution: uncertain("An execution attempt already exists; read external state before retry."),
        route: "reconcile",
      };
    }
    const attempt = this.store.createAttempt(state.task.id, idempotencyKey, fingerprint);
    const owner = `${process.pid}:${attempt.id}`;
    const lease = `task-write:${state.task.id}`;
    if (!this.store.acquireLease(lease, owner)) {
      attempt.status = "uncertain";
      this.store.updateAttempt(attempt);
      return {
        task: this.persist(state.task, "reconciling", "reconcile"),
        attempt,
        execution: uncertain("Another worker holds the task write lease."),
        route: "reconcile",
      };
    }
    attempt.status = "running";
    this.store.updateAttempt(attempt);
    const task = this.persist(state.task, "executing", "execute");
    try {
      const execution = await ability.execute(task);
      const artifact = this.store.recordArtifact(task.id, "execute", execution, execution.evidence);
      attempt.artifactId = artifact.id;
      attempt.completedAt = new Date().toISOString();
      attempt.status = execution.externalState === "unknown"
        ? "uncertain" : execution.ok ? "succeeded" : "failed";
      this.store.updateAttempt(attempt);
      return {
        task: { ...task, execution }, attempt, execution,
        route: attempt.status === "uncertain" ? "reconcile" : execution.ok ? "verify" : "review",
      };
    } catch (error) {
      const execution = uncertain(error instanceof Error ? error.message : String(error));
      this.store.recordArtifact(task.id, "execute", execution);
      attempt.status = "uncertain";
      attempt.completedAt = new Date().toISOString();
      this.store.updateAttempt(attempt);
      return { task: { ...task, execution }, attempt, execution, route: "reconcile" };
    } finally {
      this.store.releaseLease(lease, owner);
    }
  }

  private async verify(state: State): Promise<Partial<State>> {
    const execution = required(state.execution, "execution");
    const task = this.persist({ ...state.task, execution }, "verifying", "verify");
    const verification = verifyAbilityResult(this.abilities.get(task.ability), execution);
    this.store.recordArtifact(task.id, "verify", verification, verification.evidence);
    return { task: { ...task, verification }, verification };
  }

  private async review(state: State): Promise<Partial<State>> {
    const execution = required(state.execution, "execution");
    const task = this.persist({ ...state.task, execution, verification: state.verification }, "reviewing", "review");
    const review = state.verification?.state === "rejected"
      ? { ok: false, summary: "Deterministic verification rejected the result.", evidence: state.verification.evidence, blockers: state.verification.blockers }
      : await this.abilities.get(task.ability).review(task);
    this.store.recordArtifact(task.id, "review", review, review.evidence);
    return { task: { ...task, review }, reviewResult: review };
  }

  private async reconcile(state: State): Promise<Partial<State>> {
    const execution = state.execution ?? uncertain("External state is unknown.");
    const task = this.persist({ ...state.task, execution }, "reconciling", "reconcile");
    this.store.recordArtifact(task.id, "reconcile", {
      reason: execution.blockers, nextAction: "read_external_state_before_retry",
    }, execution.evidence);
    return { task };
  }

  private async finalize(state: State): Promise<Partial<State>> {
    const execution = required(state.execution, "execution");
    const review = required(state.reviewResult, "review");
    const status: TaskStatus = state.verification?.blockers?.includes("writeback_pending")
      ? "writeback_pending"
      : execution.ok && review.ok && state.verification?.state !== "rejected"
        ? "completed" : "failed";
    const task = this.persist({ ...state.task, execution, verification: state.verification, review }, status, "finalize");
    return { task };
  }

  private persist(task: TaskRecord, status: TaskStatus, currentNode: string): TaskRecord {
    const next = { ...task, status, currentNode, updatedAt: new Date().toISOString() };
    this.store.saveTask(next);
    return next;
  }
}

export function fingerprintTask(task: Pick<TaskRecord, "id" | "ability" | "text" | "scope">): string {
  return sha256(JSON.stringify({ id: task.id, ability: task.ability, text: task.text, scope: task.scope }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uncertain(message: string): AgentResult {
  return { ok: false, summary: message, evidence: [], blockers: ["external_state_unknown"], externalState: "unknown" };
}

function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`missing_${name}`);
  return value;
}
