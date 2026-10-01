/**
 * T-0089.5.2 Part A end to end: a real recall through the Worker logs a sampled
 * recall_log row only when RECALL_LOG is opted on, and never changes what the
 * caller sees.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { CONFIG_KEY } from "../../src/config";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";
import type { Env } from "../../src/env";

describe("sampled recall log", () => {
  let sqlite: SqliteD1 | undefined;
  afterEach(() => sqlite?.close());

  async function recallOnce(recallLogOn: boolean) {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const kv = makeMemoryKV();
    const bootEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv }));
    await initializeDatabase(bootEnv);
    const roots = await ensureTenantBootstrap(bootEnv);
    sqlite.seed({ id: "m1", content: "atlas ledger note", createdAt: 1000, tags: ["work"] });
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(roots.ownerPersonalWorkspaceId, "m1").run();
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    if (recallLogOn) await kv.put(CONFIG_KEY, JSON.stringify({ RECALL_LOG: "on" }));

    const env: Env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "m1", score: 0.9, metadata: { parentId: "m1", created_at: 1000 } }] }),
      }),
    }));
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("http://localhost/recall", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify({ query: "atlas ledger note", topK: 5 }) }),
      env, ctx,
    );
    await Promise.all(deferred);
    const body = await res.json() as { results: { id: string }[] };
    return { body, db: sqlite.db, workspaceId: roots.ownerPersonalWorkspaceId };
  }

  it("writes no recall_log row when RECALL_LOG is off (the default)", async () => {
    const { body, db } = await recallOnce(false);
    expect(body.results.map(r => r.id)).toEqual(["m1"]);
    const rows = (await db.prepare(`SELECT * FROM recall_log`).all()).results;
    expect(rows).toHaveLength(0);
  });

  it("writes one recall_log row when RECALL_LOG is on, without changing the response", async () => {
    const { body, db, workspaceId } = await recallOnce(true);
    expect(body.results.map(r => r.id)).toEqual(["m1"]);
    const rows = (await db.prepare(`SELECT * FROM recall_log`).all()).results as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(workspaceId);
    expect(rows[0].channel).toBe("rest");
    expect(rows[0].query).toContain("atlas ledger note");
    expect(JSON.parse(rows[0].returned_ids as string)).toEqual(["m1"]);
    expect(rows[0].followed_ids).toBe("[]");
  });
});
