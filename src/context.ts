export type ContextStatus =
  | "generated_draft"
  | "needs_review"
  | "confirmed"
  | "stale"
  | "rejected";

export type ContextScope = {
  tenantId: string;
  chatId?: string;
  userId?: string;
  projectId?: string;
};

export type ContextSource = {
  type: "message" | "document" | "sheet" | "slides" | "task" | "manual";
  ref: string;
  revision?: string;
  observedAt: string;
};

export type ContextRecord<T = unknown> = {
  id: string;
  kind: "project" | "workflow" | "decision" | "person" | "task" | "fact";
  scope: ContextScope;
  status: ContextStatus;
  value: T;
  summary: string;
  sources: ContextSource[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};

export interface ContextStore {
  search(query: string, scope: ContextScope): Promise<ContextRecord[]>;
  save(record: ContextRecord): Promise<void>;
}

export class MemoryContextStore implements ContextStore {
  private readonly records = new Map<string, ContextRecord>();

  async search(query: string, scope: ContextScope): Promise<ContextRecord[]> {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.records.values()]
      .filter((record) => canUseContext(record, scope).usable)
      .map((record) => ({
        record,
        score: tokens.filter((token) => record.summary.toLowerCase().includes(token)).length,
      }))
      .filter(({ score }) => tokens.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score)
      .map(({ record }) => record);
  }

  async save(record: ContextRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }
}

export function canUseContext(
  record: ContextRecord,
  requestedScope: ContextScope,
  now = new Date(),
): { usable: boolean; reason: string } {
  if (!scopeContains(record.scope, requestedScope)) {
    return { usable: false, reason: "scope_mismatch" };
  }
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) {
    return { usable: false, reason: "expired" };
  }
  if (record.status !== "confirmed") {
    return { usable: false, reason: record.status };
  }
  return { usable: true, reason: "confirmed" };
}

function scopeContains(record: ContextScope, requested: ContextScope): boolean {
  if (record.tenantId !== requested.tenantId) return false;
  for (const key of ["chatId", "userId", "projectId"] as const) {
    if (record[key] && record[key] !== requested[key]) return false;
  }
  return true;
}
