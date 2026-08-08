import type { ContextScope } from "./context.js";

export type RiskLevel = "low" | "medium" | "high";
export type TaskStatus =
  | "received"
  | "needs_confirmation"
  | "preflight"
  | "executing"
  | "verifying"
  | "reviewing"
  | "reconciling"
  | "writeback_pending"
  | "completed"
  | "failed";

export type AgentResult = {
  ok: boolean;
  summary: string;
  evidence: string[];
  blockers?: string[];
  externalState?: "verified" | "unknown" | "not_applicable";
  externalReferences?: string[];
  writebackState?: "verified" | "pending" | "not_applicable";
  facts?: Record<string, string | number | boolean | string[]>;
};

export type TaskRecord = {
  id: string;
  ability: string;
  text: string;
  scope: ContextScope;
  risk: RiskLevel;
  status: TaskStatus;
  plan?: { goal: string; steps: string[]; contextIds: string[] };
  execution?: AgentResult;
  verification?: AgentResult & { state: "verified" | "rejected" | "uncertain" };
  review?: AgentResult;
  currentNode?: string;
  createdAt: string;
  updatedAt: string;
};

export type Confirmation = {
  id: string;
  taskId: string;
  inputFingerprint: string;
  confirmedAt: string;
  expiresAt: string;
  sourceMessageId?: string;
};

export type Attempt = {
  id: string;
  taskId: string;
  idempotencyKey: string;
  inputFingerprint: string;
  status: "created" | "running" | "succeeded" | "failed" | "uncertain";
  startedAt: string;
  completedAt?: string;
  artifactId?: string;
};

export type Artifact = {
  id: string;
  taskId: string;
  node: string;
  hash: string;
  content: unknown;
  references: string[];
  createdAt: string;
};
