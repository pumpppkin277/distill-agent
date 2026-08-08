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

export class SqliteContextStore implements ContextStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_records (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, tenant_id TEXT NOT NULL,
        status TEXT NOT NULL, summary TEXT NOT NULL, record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_revisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL,
        record_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
  }

  async save(record: ContextRecord): Promise<void> {
    const json = JSON.stringify(record);
    const transaction = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO context_revisions(context_id,record_json,created_at) VALUES(?,?,?)",
      ).run(record.id, json, record.updatedAt);
      this.db.prepare(
        `INSERT INTO context_records(id,kind,tenant_id,status,summary,record_json,updated_at)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
         kind=excluded.kind,tenant_id=excluded.tenant_id,status=excluded.status,
         summary=excluded.summary,record_json=excluded.record_json,updated_at=excluded.updated_at`,
      ).run(record.id, record.kind, record.scope.tenantId, record.status, record.summary, json, record.updatedAt);
    });
    transaction();
  }

  async search(query: string, scope: ContextScope): Promise<ContextRecord[]> {
    const rows = this.db.prepare(
      "SELECT record_json FROM context_records WHERE tenant_id=? AND status='confirmed'",
    ).all(scope.tenantId) as Array<{ record_json: string }>;
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return rows
      .map((row) => JSON.parse(row.record_json) as ContextRecord)
      .filter((record) => canUseContext(record, scope).usable)
      .map((record) => ({
        record,
        score: tokens.filter((token) => record.summary.toLowerCase().includes(token)).length,
      }))
      .filter(({ score }) => tokens.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ record }) => record);
  }

  async review(id: string, decision: "confirmed" | "rejected", now = new Date()): Promise<ContextRecord> {
    const row = this.db.prepare("SELECT record_json FROM context_records WHERE id=?").get(id) as
      | { record_json: string }
      | undefined;
    if (!row) throw new Error(`context_not_found:${id}`);
    const current = JSON.parse(row.record_json) as ContextRecord;
    if (!['generated_draft', 'needs_review', 'stale'].includes(current.status)) {
      throw new Error(`invalid_context_review_transition:${current.status}`);
    }
    const next = { ...current, status: decision, updatedAt: now.toISOString() } satisfies ContextRecord;
    await this.save(next);
    return next;
  }

  health(): { total: number; pendingReview: number; latestUpdatedAt?: string } {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status='needs_review' THEN 1 ELSE 0 END) AS pending,
       MAX(updated_at) AS latest FROM context_records`,
    ).get() as { total: number; pending: number | null; latest: string | null };
    return {
      total: row.total,
      pendingReview: row.pending ?? 0,
      latestUpdatedAt: row.latest ?? undefined,
    };
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
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
