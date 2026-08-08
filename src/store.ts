import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Artifact, Attempt, Confirmation, TaskRecord } from "./protocol.js";

export class HarnessStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_snapshots (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        status TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS confirmations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, input_fingerprint TEXT NOT NULL,
        expires_at TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, idempotency_key TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node TEXT NOT NULL,
        hash TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        resource TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL
      );
    `);
  }

  saveTask(task: TaskRecord): void {
    const json = JSON.stringify(task);
    const transaction = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO task_snapshots(task_id,status,record_json,created_at) VALUES(?,?,?,?)`,
      ).run(task.id, task.status, json, task.updatedAt);
      this.db.prepare(
        `INSERT INTO tasks(id,status,record_json,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status,
         record_json=excluded.record_json,updated_at=excluded.updated_at`,
      ).run(task.id, task.status, json, task.updatedAt);
    });
    transaction();
  }

  task(id: string): TaskRecord | undefined {
    return parse<TaskRecord>(this.db.prepare("SELECT record_json FROM tasks WHERE id=?").get(id));
  }

  saveConfirmation(confirmation: Confirmation): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO confirmations(id,task_id,input_fingerprint,expires_at,record_json)
       VALUES(?,?,?,?,?)`,
    ).run(
      confirmation.id,
      confirmation.taskId,
      confirmation.inputFingerprint,
      confirmation.expiresAt,
      JSON.stringify(confirmation),
    );
  }

  validConfirmation(taskId: string, fingerprint: string, now = Date.now()): boolean {
    const row = this.db.prepare(
      `SELECT expires_at FROM confirmations WHERE task_id=? AND input_fingerprint=?
       ORDER BY expires_at DESC LIMIT 1`,
    ).get(taskId, fingerprint) as { expires_at?: string } | undefined;
    return Boolean(row?.expires_at && Date.parse(row.expires_at) > now);
  }

  attemptByKey(key: string): Attempt | undefined {
    return parse<Attempt>(this.db.prepare("SELECT record_json FROM attempts WHERE idempotency_key=?").get(key));
  }

  createAttempt(taskId: string, key: string, fingerprint: string): Attempt {
    const attempt: Attempt = {
      id: randomUUID(), taskId, idempotencyKey: key, inputFingerprint: fingerprint,
      status: "created", startedAt: new Date().toISOString(),
    };
    this.db.prepare(
      "INSERT INTO attempts(id,task_id,idempotency_key,status,record_json) VALUES(?,?,?,?,?)",
    ).run(attempt.id, taskId, key, attempt.status, JSON.stringify(attempt));
    return attempt;
  }

  updateAttempt(attempt: Attempt): void {
    this.db.prepare("UPDATE attempts SET status=?,record_json=? WHERE id=?")
      .run(attempt.status, JSON.stringify(attempt), attempt.id);
  }

  recordArtifact(taskId: string, node: string, content: unknown, references: string[] = []): Artifact {
    const serialized = JSON.stringify(content);
    const artifact: Artifact = {
      id: randomUUID(), taskId, node,
      hash: createHash("sha256").update(serialized).digest("hex"),
      content, references, createdAt: new Date().toISOString(),
    };
    this.db.prepare(
      "INSERT INTO artifacts(id,task_id,node,hash,record_json,created_at) VALUES(?,?,?,?,?,?)",
    ).run(artifact.id, taskId, node, artifact.hash, JSON.stringify(artifact), artifact.createdAt);
    return artifact;
  }

  acquireLease(resource: string, owner: string, ttlMs = 60_000, now = Date.now()): boolean {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM leases WHERE resource=? AND expires_at<=?").run(resource, now);
      const result = this.db.prepare(
        "INSERT OR IGNORE INTO leases(resource,owner,expires_at) VALUES(?,?,?)",
      ).run(resource, owner, now + ttlMs);
      return result.changes === 1;
    });
    return transaction();
  }

  releaseLease(resource: string, owner: string): void {
    this.db.prepare("DELETE FROM leases WHERE resource=? AND owner=?").run(resource, owner);
  }

  markMessageProcessed(messageId: string): boolean {
    const result = this.db.prepare(
      "INSERT OR IGNORE INTO processed_messages(message_id,processed_at) VALUES(?,?)",
    ).run(messageId, new Date().toISOString());
    return result.changes === 1;
  }

  health(): { tasks: number; uncertainAttempts: number } {
    const tasks = (this.db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count;
    const uncertainAttempts = (this.db.prepare(
      "SELECT COUNT(*) AS count FROM attempts WHERE status='uncertain'",
    ).get() as { count: number }).count;
    return { tasks, uncertainAttempts };
  }
}

function parse<T>(row: unknown): T | undefined {
  const value = row as { record_json?: string } | undefined;
  return value?.record_json ? JSON.parse(value.record_json) as T : undefined;
}
