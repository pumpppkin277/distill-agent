import type { ContextRecord, ContextScope } from "./context.js";

export type RiskLevel = "low" | "medium" | "high";

export type TaskRequest = {
  id: string;
  text: string;
  scope: ContextScope;
  risk: RiskLevel;
  approved?: boolean;
};

export type Plan = {
  goal: string;
  steps: string[];
  contextIds: string[];
};

export type ExecutionResult = {
  ok: boolean;
  summary: string;
  evidence: string[];
};

export type ReviewResult = {
  approved: boolean;
  summary: string;
};

export type AgentTeam = {
  planner: {
    plan(request: TaskRequest, context: ContextRecord[]): Promise<Plan>;
  };
  worker: {
    execute(request: TaskRequest, plan: Plan): Promise<ExecutionResult>;
  };
  reviewer: {
    review(request: TaskRequest, result: ExecutionResult): Promise<ReviewResult>;
  };
};
