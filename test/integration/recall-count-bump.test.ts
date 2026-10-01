/**
 * Recall bumps recall_count for every presented row in ONE statement, so its
 * D1 cost stays flat in the number of results (one subrequest, not one per id).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";
import type { Env } from "../../src/env";

describe("recall_count bump", () => {
  let sqlite: SqliteD1 | undefined;
  afterEach(() => sqlite?.close());

  async function recallN(n: number) {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const kv = makeMemoryKV();
    const bootEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv }));
    await initializeDatabase(bootEnv);
    const roots = await ensureTenantBootstrap(bootEnv);
    const ids = Array.from({ length: n }, (_, i) => `m${i}`);
    for (const [i, id] of ids.entries()) {
      sqlite.seed({ id, content: `atlas ledger note ${i}`, createdAt: 1000 + i, tags: ["work"] });
      await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`)
        .bind(roots.ownerPersonalWorkspaceId, id).run();
    }
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    const env: Env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: ids.map((id, i) => ({ id, score: 0.9 - i * 0.01, metadata: { parentId: id, created_at: 1000 } })),
        }),
      }),
    }));
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;
    sqlite.issued.length = 0;
    const res = await worker.fetch(
      new Request("http://localhost/recall", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify({ query: "atlas ledger note", topK: n, synthesize: false }) }),
      env, ctx,
    );
    await Promise.all(deferred);
    const body = await res.json() as { results: { id: string }[] };
    return { presented: body.results.map(r => r.id), issued: sqlite.issued.slice(), db: sqlite.db };
  }

  it.each([1, 5, 20])("bumps %i presented rows with a single UPDATE", async (n) => {
    const { presented, issued, db } = await recallN(n);
    expect(presented.length).toBe(n);
    expect(issued.filter(s => s.includes("UPDATE entries SET recall_count"))).toHaveLength(1);
    const rows = (await db.prepare(`SELECT id, recall_count, last_recalled_at FROM entries`).all()).results as { id: string; recall_count: number }[];
    for (const r of rows) {
      expect(r.recall_count).toBe(presented.includes(r.id) ? 1 : 0);
      if (presented.includes(r.id)) expect((r as any).last_recalled_at).toEqual(expect.any(Number));
    }
  });

  it("issues no bump statement when nothing is presented", async () => {
    const { presented, issued } = await recallN(0);
    expect(presented).toHaveLength(0);
    expect(issued.filter(s => s.includes("UPDATE entries SET recall_count"))).toHaveLength(0);
  });
});
