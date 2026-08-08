import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ContextRecord, ContextScope, ContextSource, ContextStore } from "./context.js";

export type ContextSourceItem = {
  ref: string;
  type: ContextSource["type"];
  title: string;
  content: string;
  revision?: string;
  observedAt: string;
};

export interface ContextConnector {
  name: string;
  read(): Promise<ContextSourceItem[]>;
}

export class ContextIngestor {
  constructor(
    private readonly store: ContextStore,
    private readonly rawRunDirectory = "data/context-runs",
  ) {}

  async ingest(connector: ContextConnector, scope: ContextScope): Promise<{
    runId: string;
    sourceCount: number;
    candidateIds: string[];
  }> {
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const items = await connector.read();
    await mkdir(this.rawRunDirectory, { recursive: true });
    await writeFile(
      join(this.rawRunDirectory, `${runId}.json`),
      JSON.stringify({ runId, connector: connector.name, items }, null, 2),
      "utf8",
    );
    const candidateIds: string[] = [];
    for (const item of items) {
      const id = `ctx-${sha256(`${item.type}:${item.ref}:${item.revision ?? sha256(item.content)}`)}`;
      const now = new Date().toISOString();
      const record: ContextRecord = {
        id,
        kind: "fact",
        scope,
        status: "needs_review",
        value: { title: item.title, content: item.content },
        summary: `${item.title}\n${item.content.slice(0, 500)}`,
        sources: [{
          type: item.type,
          ref: item.ref,
          revision: item.revision,
          observedAt: item.observedAt,
        }],
        createdAt: now,
        updatedAt: now,
      };
      await this.store.save(record);
      candidateIds.push(id);
    }
    return { runId, sourceCount: items.length, candidateIds };
  }
}

export class MarkdownDirectoryConnector implements ContextConnector {
  readonly name = "markdown-directory";

  constructor(private readonly directory: string) {}

  async read(): Promise<ContextSourceItem[]> {
    const files = await markdownFiles(this.directory);
    return Promise.all(files.map(async (path) => {
      const content = await readFile(path, "utf8");
      return {
        ref: path,
        type: "document" as const,
        title: basename(path, ".md"),
        content,
        revision: sha256(content),
        observedAt: new Date().toISOString(),
      };
    }));
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files.sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
