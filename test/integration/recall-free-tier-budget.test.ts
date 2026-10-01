import { resetStandingIsolateState } from "../../src/standing/cache";
import worker from "../../src/index";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { snapshotRecallBudget } from "../helpers/recall-budget";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { readDerivedStateGeneration } from "../../src/migration/write-lock";

describe("recall stays within the Cloudflare Free operation envelope", () => {
  const open: SqliteD1[] = [];
  afterEach(() => open.splice(0).forEach(sqlite => sqlite.close()));

  async function setup(hops: 0 | 1) {
    resetStandingIsolateState();
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    sqlite.seed({ id: "root", content: "atlas ledger changed", createdAt: 1000, tags: ["work"] });
    if (hops) {
      sqlite.seed({ id: "neighbor", content: "reconciliation rationale", createdAt: 1001, tags: ["work"] });
      await sqlite.db.prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("edge", "root", "neighbor", "decided", 1, "explicit", "{}", 1, 1).run();
    }

    const kv = makeMemoryKV();
    const vectorQuery = vi.fn().mockResolvedValue({
      matches: [{ id: "root", score: .9, metadata: { parentId: "root", created_at: 1000 } }],
    });
    const env: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({
      tags: ["work"],
      rebuiltAt: Date.now(),
      generation: await readDerivedStateGeneration(env),
    }));
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => deferred.push(promise) } as unknown as ExecutionContext;
    const diagnostics: RecallDiagnostics = {};

    return { env: sqlite.admitEnv(env), ctx, diagnostics, deferred };
  }

  async function run(hops: 0 | 1) {
    resetFtsReadyMemo();
    const { env, ctx, diagnostics, deferred } = await setup(hops);
    const result = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops, synthesize: false },
      env,
      ctx,
      DEFAULTS,
      { diagnostics },
    );
    await Promise.all(deferred);
    return snapshotRecallBudget(diagnostics, result);
  }

  it("charges one existing operation path for direct recall", async () => {
    const budget = await run(0);

    expect(budget).toMatchObject({
      workerRequests: 1,
      // One embedding only: tag inference is a literal match, never an LLM call.
      aiCalls: 1,
      embeddingCalls: 1,
      vectorizeQueries: 1,
      vectorizeGets: 0,
      // embedding cacheのmiss読取とwaitUntilでの保存を含める。
      kvReads: 5,
      kvWrites: 1,
      graphSeeds: 0,
      expandedNodes: 0,
      renderedResults: 1,
    });
    expect(budget.d1Statements).toBe(6);
    expect(budget.d1Statements).toBeLessThanOrEqual(30);
    // The observer runs first() as all() so its meta is seen. This double reports
    // no rows_read at all, so the read total stays unknown (never a fabricated
    // number); the writes it does report are now counted rather than nulled.
    expect(budget.d1RowsRead).toBeNull();
    expect(budget.d1RowsWritten).toBeTypeOf("number");
  });

  it("adds graph reads but no extra AI, embedding, or Vectorize path", async () => {
    const budget = await run(1);

    expect(budget.aiCalls).toBe(1);
    expect(budget.embeddingCalls).toBe(1);
    expect(budget.vectorizeQueries).toBe(1);
    expect(budget.vectorizeGets).toBe(0);
    expect(budget.kvReads).toBe(5);
    expect(budget.kvWrites).toBe(1);
    expect(budget.workerRequests).toBe(1);
    expect(budget.graphSeeds).toBe(1);
    expect(budget.expandedNodes).toBe(1);
    expect(budget.renderedResults).toBeLessThanOrEqual(5);
    expect(budget.d1Statements).toBe(8);
    expect(budget.d1Statements).toBeLessThanOrEqual(30);
    expect(budget.d1RowsRead).toBeNull();
    expect(budget.d1RowsWritten).toBeTypeOf("number");
  });

  it("a warm isolate's second recall pays zero readiness KV reads", async () => {
    // The readiness answer is cached for FTS_READY_CACHE_MS in both
    // directions. With the flag absent, the cached false must serve the second
    // recall within the TTL: otherwise every recall on a stable warm isolate
    // pays the flag read the arm was meant to cut.
    resetFtsReadyMemo();
    const state = await setup(0);
    const cold = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env,
      state.ctx,
      DEFAULTS,
      { diagnostics: state.diagnostics },
    );
    await Promise.all(state.deferred);
    expect(snapshotRecallBudget(state.diagnostics, cold).kvReads).toBe(5); // vocabulary, readiness, query cache, AI health, standing

    const warmDiagnostics: RecallDiagnostics = {};
    const warm = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env,
      state.ctx,
      DEFAULTS,
      { diagnostics: warmDiagnostics },
    );
    await Promise.all(state.deferred);
    expect(snapshotRecallBudget(warmDiagnostics, warm).kvReads).toBe(2); // vocabulary and query cache; no readiness or standing re-read
  });

  // forkのdiagnosticsはD1 batchを呼出し数ではなく含まれるSQL文数で計上する。
  it("a live FTS index stays within eight SQL statements, counting each batched statement", async () => {
    resetFtsReadyMemo();
    const state = await setup(0);
    await state.env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");

    const result = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env,
      state.ctx,
      DEFAULTS,
      { diagnostics: state.diagnostics },
    );
    await Promise.all(state.deferred);

    expect(state.diagnostics.ftsUsed).toBe(true); // the live index actually served this
    // T-0059: distillation counted through the index, or (every row here holds the terms) the one pass that prices cheaper; same call either way
    expect(["fts", "scan"]).toContain(state.diagnostics.distillSource);
    const budget = snapshotRecallBudget(state.diagnostics, result);
    // FTS健全性検査とentry_counts集計を含むバッチ内のSQLも数える。
    expect(budget.d1Statements).toBe(8);
  });

  it("a second recall costs the same as the first — entry_counts is exact, not cached, so there is no cold/warm split", async () => {
    resetFtsReadyMemo();
    const state = await setup(0);
    await state.env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");

    await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env, state.ctx, DEFAULTS, { diagnostics: state.diagnostics },
    );
    await Promise.all(state.deferred);

    const warmDiagnostics: RecallDiagnostics = {};
    const warm = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env, state.ctx, DEFAULTS, { diagnostics: warmDiagnostics },
    );
    await Promise.all(state.deferred);

    expect(warmDiagnostics.ftsUsed).toBe(true);
    expect(["fts", "scan"]).toContain(warmDiagnostics.distillSource);
    // Matches the first call above exactly (T-0065): entry_counts has no
    // warm/cold distinction left to be cheaper than the first call.
    expect(snapshotRecallBudget(warmDiagnostics, warm).d1Statements).toBe(8);
  });

  // MINOR 4b (final review): every case above calls recallEntries directly,
  // in-process, bypassing auth and schema readiness entirely. This one goes
  // through the real Worker entry point — real token authentication (the
  // legacy AUTH_TOKEN bootstrapped into a genuine admin row via
  // ensureTenantBootstrap, resolved through the Authorization header the
  // same way production does) against a freshly migrated real SQLite brain
  // (initializeDatabase, not a pre-populated D1 mock) — so the pinned count
  // reflects an actual request's real cost, not a hand-assembled one.
  it("a real POST /recall request through worker.fetch pins its D1 subrequest count end to end", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    resetStandingIsolateState();
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    const kv = makeMemoryKV();
    const bootEnv = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv });
    await initializeDatabase(bootEnv);
    const roots = await ensureTenantBootstrap(bootEnv);
    sqlite.seed({ id: "root", content: "atlas ledger changed", createdAt: 1000, tags: ["work"] });
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'root'`)
      .bind(roots.ownerPersonalWorkspaceId).run();
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    sqlite.issued.length = 0; // setup's own DDL/bootstrap/seed statements are not what this pins

    const vectorQuery = vi.fn().mockResolvedValue({
      matches: [{ id: "root", score: .9, metadata: { parentId: "root", created_at: 1000 } }],
    });
    const env: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;

    const res = await worker.fetch(
      new Request("http://localhost/recall", {
        method: "POST",
        body: JSON.stringify({query: "why atlas ledger changed", topK: 5}),
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      }),
      env, ctx,
    );
    await Promise.all(deferred);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; results: { id: string }[] };
    expect(body.ok).toBe(true);
    expect(body.results.map(m => m.id)).toContain("root");
    // Exact pin, real end-to-end path (measured, not assumed): identity
    // resolution, distillation, the keyword and dense arms, candidate
    // hydration, and the deferred recall_count bump. If this number moves,
    // say why in the same commit.

    // admission取得・解放3文、generation初期化4文、vocabulary再構築1文も含む。
    expect(sqlite.issued.length).toBe(15);
  });
});
