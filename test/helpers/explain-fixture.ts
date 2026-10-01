import { vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "./sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "./make-env";
import { req } from "./make-request";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import worker from "../../src/index";
import type { Env } from "../../src/env";

export const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const DAY = 86_400_000;
const deferred: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { deferred.push(p); } } as ExecutionContext;

export interface ExplainFixture { env: Env; sqlite: SqliteD1; close(): void }

/** A small real-SQL brain with a frozen clock: three memories, a link from e1 to e4, dense hits on e1, e2, e3. */
export async function makeExplainFixture(): Promise<ExplainFixture> {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const match = (id: string, score: number, ageDays: number, tags: string[]) =>
    ({ id, score, metadata: { parentId: id, isUpdate: false, created_at: NOW - ageDays * DAY, tags } });
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [
        match("e1", 0.9, 2, ["status:canonical", "work"]),
        match("e2", 0.8, 100, ["idea"]),
        match("e3", 0.7, 10, []),
      ] }),
    }),
  }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const ws = roots.ownerPersonalWorkspaceId;
  const seed = (id: string, content: string, tags: string[], ageDays: number, recallCount: number, importance: number) =>
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, recall_count, importance_score)
       VALUES (?, ?, ?, 'api', ?, ?, '[]', ?, ?, ?, ?)`,
    ).bind(id, content, JSON.stringify(tags), NOW - ageDays * DAY, NOW - ageDays * DAY, ws, roots.ownerUserId, recallCount, importance).run();
  await seed("e1", "Atlas ledger decision for gatewright", ["status:canonical", "work"], 2, 2, 4);
  await seed("e2", "A second memory about ledgers", ["idea"], 100, 0, 0);
  await seed("e3", "Atlas planning notes", [], 10, 0, 0);
  await seed("e4", "Rollout checklist and owners", [], 30, 0, 0);
  await sqlite.db.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
     VALUES ('ed1', 'e1', 'e4', 'relates_to', 0.9, 'explicit', '{}', ?, ?, ?)`,
  ).bind(NOW - DAY, NOW - DAY, ws).run();
  return { env: sqlite.admitEnv(env), sqlite, close: () => { sqlite.close(); vi.restoreAllMocks(); } };
}

export async function restRecall(env: Env, qs: string): Promise<any> {
  const res = await worker.fetch(req("POST", `/recall?${qs}`), env, ctx);
  await Promise.all(deferred.splice(0));
  const body = await res.json();
  if (!res.ok) throw new Error(`REST recall failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

export async function mcpRecall(env: Env, args: Record<string, unknown>): Promise<string> {
  const identity = (await resolveIdentityFromToken("test-token", env))!;
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const res: any = await client.callTool({ name: "recall", arguments: args });
    await Promise.all(deferred.splice(0));
    return String(res.content[0].text);
  } finally { await client.close(); }
}
