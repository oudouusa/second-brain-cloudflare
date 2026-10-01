/**
 * Adversary round 4, Task 10 (fa5fe4a7): are the budget pins honest?
 *
 * Every count here comes from an independent ledger wrapped around env.DB and OAUTH_KV on real
 * SQLite (sqlite-d1): run/first/all/raw/exec are one execution each, a batch is one, a KV
 * get/put/delete/list is one. It does not read SqliteD1's prepare-counting `issued`.
 *
 * forkのupload台帳とadmissionを含め、回数と既存の上限を別々に検証する。
 */
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { makeTrashEnv, seedTrashRows, type TrashEnv } from "../helpers/trash-env";
import { cleanTemp } from "../helpers/tmp";
import { updateEntryContent, appendToEntry } from "../../src/capture/store";
import { applyInsightResolution } from "../../src/memory/actions";
import { markSourcesRolledUp } from "../../src/compression/digest";
import { revertEntry } from "../../src/memory/undo";
import { createMember } from "../../src/lib/team-admin";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import { DEFAULTS } from "../../src/config";
import { WRITE_CAS_ATTEMPTS, UNDO_MERGE_REEMBED_INLINE } from "../../src/constants";
import { AUDIT_BATCH_MAX } from "../../src/lib/audit";
import worker from "../../src/index";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let t: TrashEnv | undefined;
afterEach(() => { t?.close(); t = undefined; vi.restoreAllMocks(); });
afterAll(cleanTemp);

interface Ledger { calls: string[]; kv: string[]; batchSizes: number[]; maxParams: number }

/** Real executions on env.DB and real KV calls. `beforeBatch` runs uncounted before each batch; `failBatch` makes one throw. */
function counted(env: Env, opts: { beforeBatch?: (n: number, statements: any[]) => void | Promise<void>; failBatch?: (n: number) => boolean } = {}) {
  const L: Ledger = { calls: [], kv: [], batchSizes: [], maxParams: 0 };
  const inner = env.DB as any;
  const unwrap = new WeakMap<object, any>();
  const argsOf = new WeakMap<object, unknown[]>();
  const noteParams = (n: number) => { if (n > L.maxParams) L.maxParams = n; };
  const wrap = (s: any, sql: string, args: unknown[] = []): any => {
    const bill = () => { L.calls.push(sql.replace(/\s+/g, " ").trim().slice(0, 80)); noteParams(args.length); };
    const w = {
      bind: (...a: unknown[]) => wrap(s.bind(...a), sql, a),
      run: () => { bill(); return s.run(); },
      first: (...a: unknown[]) => { bill(); return s.first(...a); },
      all: () => { bill(); return s.all(); },
      raw: () => { bill(); return s.raw(); },
      sourceSql: () => sql,
    };
    unwrap.set(w, s);
    argsOf.set(w, args);
    return w;
  };
  let batches = 0;
  const DB = {
    prepare: (sql: string) => wrap(inner.prepare(sql), sql),
    exec: (sql: string) => { L.calls.push("EXEC"); return inner.exec(sql); },
    batch: async (stmts: any[]) => {
      const n = ++batches;
      L.calls.push("BATCH");
      L.batchSizes.push(stmts.length);
      for (const s of stmts) noteParams((argsOf.get(s) ?? []).length);
      if (opts.beforeBatch) await opts.beforeBatch(n, stmts);
      if (opts.failBatch?.(n)) throw new Error("D1_ERROR: Network connection lost.");
      return inner.batch(stmts.map((s) => unwrap.get(s) ?? s));
    },
  };
  const kv = env.OAUTH_KV as any;
  const OAUTH_KV = {
    get: (...a: any[]) => { L.kv.push(`GET ${a[0]}`); return kv.get(...a); },
    put: (...a: any[]) => { L.kv.push(`PUT ${a[0]}`); return kv.put(...a); },
    delete: (...a: any[]) => { L.kv.push(`DEL ${a[0]}`); return kv.delete(...a); },
    list: (...a: any[]) => { L.kv.push("LIST"); return kv.list(...a); },
    getWithMetadata: (...a: any[]) => { L.kv.push(`GETM ${a[0]}`); return kv.getWithMetadata(...a); },
  };
  return { env: { ...env, DB, OAUTH_KV } as unknown as Env, L };
}

const tt = () => t!;
const change = () => ({ actorId: tt().roots.ownerUserId, channel: "rest" as const });
const identity = (): Identity => ({
  userId: tt().roots.ownerUserId, role: "admin", personalWorkspaceId: tt().roots.ownerPersonalWorkspaceId,
  companyWorkspaceIds: [tt().roots.companyWorkspaceId], defaultShare: "",
});
const writeCtx = () => ({ workspaceId: tt().roots.ownerPersonalWorkspaceId, actorId: tt().roots.ownerUserId });

const EXTERNAL_FETCH_CAP = 50;
const MONDAY = "2024-01-15T02:00:00Z"; // no weekly dangling-edge sweep (graph/pass.ts)

/** The busy night cron-subrequest-budget.test.ts:281 seeds: 7 compressible tags of 11 old entries each. */
function seedBusyNight(env: TrashEnv) {
  const old = Date.now() - STALENESS_AGE_MS - 86_400_000;
  for (let tg = 0; tg < 7; tg++) {
    for (let i = 0; i < 11; i++) {
      env.seed(`t${tg}-e${i}`, { content: `Person ${i} works at Company ${tg}`, tags: JSON.stringify([`topic-${tg}`]), created_at: old + i, updated_at: old + i });
    }
  }
}

/** versioning-budget.test.ts:367-380's own worst-night fixture: 3,000 expired trash rows plus a pending removal. */
async function seedWorstCleanup(env: TrashEnv) {
  await seedTrashRows(env, 3000);
  const { member } = await createMember(env.env, { name: "Ada" });
  const P = member.personalWorkspaceId;
  await env.sqlite.db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
    INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, write_marker)
    SELECT 'm' || i, 'c', '[]', 'api', 1, '[]', '${P}', '${member.userId}', '${env.sqlite.fixtureMarker()}' FROM n`);
  await env.sqlite.db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
    INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
    SELECT 'm1', '${P}', i, 'v', NULL, '[]', '', 'rest', 'update', i, '${env.sqlite.fixtureMarker()}' FROM n`);
  await env.sqlite.db.prepare(`UPDATE users SET removed_at = 5 WHERE id = ?`).bind(member.userId).run();
}

async function runMaintenanceCron(env: Env, scheduledTime?: number) {
  const pending: Promise<unknown>[] = [];
  await (worker as any).scheduled({ cron: "0 1 * * *", scheduledTime }, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.allSettled(pending);
}

describe("R4-B1 (re-graded MINOR): the whole scheduled() invocation's real cost, not runNightlyCleanup alone", () => {
  it("実SQLiteで混雑した夜間処理を3回進め、各回の予算と保守・digestの進捗を守る", async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((...a: Parameters<typeof fetch>) => realFetch(...a));
    t = await makeTrashEnv();
    seedBusyNight(t);
    await seedWorstCleanup(t);
    const before = await t.one<{ w: string | null }>(`SELECT MAX(workspace_id) AS w FROM entries WHERE workspace_id < ?`, t.roots.ownerPersonalWorkspaceId);
    await t.sqlite.db.prepare(`UPDATE maintenance_cursor SET workspace_id = ? WHERE id = 1`).bind(before?.w ?? "").run();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.map(a => a instanceof Error ? a.message : String(a)).join(" ")); });
    const base = new Date(MONDAY).getTime();
    for (let phase = 0; phase < 3; phase++) {
      await t.sqlite.db.prepare("INSERT INTO maintenance_cursor (id, workspace_id, advanced_at) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id").bind(before?.w ?? "").run();
      const { env, L } = counted(t.env);
      await runMaintenanceCron(env, base + phase * 86400000);
      expect(L.calls.length, JSON.stringify(L)).toBeLessThanOrEqual(50);
      expect(L.calls.length + L.kv.length).toBeLessThanOrEqual(1000);
    }
    expect((await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"synthesized"%'`))!.n, JSON.stringify(errors)).toBeGreaterThan(0);
    expect((await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM entries_trash`))!.n).toBeLessThan(3000);
    expect(fetchSpy).not.toHaveBeenCalled();

  });

  it("the busy-night baseline those pins rest on is measured on d1-mock, which skips calls real SQL makes", async () => {
    t = await makeTrashEnv();
    seedBusyNight(t);
    const { env, L } = counted(t.env);
    await runMaintenanceCron(env);
    expect(L.calls.length, JSON.stringify(L)).toBeLessThanOrEqual(50);
    expect(L.calls.length + L.kv.length).toBeLessThanOrEqual(1000);

  });
});

describe("R4-B2 (re-graded MINOR): digest rollup's retry path is 1 + N executions, 51 at 50 sources", () => {
  it("a transient error on the one rollup batch falls back to one batch PER SOURCE (digest.ts:119-128)", async () => {
    t = await makeTrashEnv();
    const sources = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, content: `content ${i}`, rowVersion: 1000 }));
    for (const s of sources) t.seed(s.id, { content: s.content, updated_at: null, created_at: 1000 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, L } = counted(t.env, { failBatch: (n) => n === 1 });
    await markSourcesRolledUp(env, sources, "digest-1", t.roots.ownerPersonalWorkspaceId, DEFAULTS);
    expect((await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%rolled-up%'`))!.n).toBe(50);
    expect(L.calls.length).toBe(51);
  });
});

describe("R4-B3 (MINOR): a compare-and-set miss on a CONTENT race costs +4 per retry, not the pinned +2", () => {
  const contentRace = (env: TrashEnv, text: (n: number) => string, times = Infinity) => {
    let races = 0;
    return async (_n: number, statements: any[]) => {
      if (!statements.some(stmt => /^UPDATE entries(?: AS e)? SET.*content = /s.test(stmt.sourceSql()))) return;
      if (++races <= times) await env.sqlite.db.prepare("UPDATE entries SET content = ? WHERE id = ?").bind(text(races), "e1").run();
    };
  };

  it("updateEntryContent: one content miss then success costs 4", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    const { env, L } = counted(t.env, { beforeBatch: contentRace(t, (n) => `raced ${n}`, 1) });
    const r = await updateEntryContent(env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");
    expect(L.calls).toHaveLength(28);
    expect(L.calls.length).toBeLessThanOrEqual(50);
  });

  it("updateEntryContent: exhausting every attempt on content races costs 2 per attempt", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    const { env, L } = counted(t.env, { beforeBatch: contentRace(t, (n) => `raced ${n}`) });
    const r = await updateEntryContent(env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("conflict");
    expect(L.calls).toHaveLength(42);
    expect(L.calls.length).toBeLessThanOrEqual(50);
  });

  it("appendToEntry's long branch (row past CHUNK_MAX_CHARS): exhausting every attempt costs 2 per attempt", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { content: "x".repeat(1700) });
    const { env, L } = counted(t.env, { beforeBatch: contentRace(t, (n) => "y".repeat(1700) + n) });
    await expect(appendToEntry(env, "e1", "", "met Sam", [], "api", DEFAULTS, undefined, writeCtx(), change(), undefined, t.roots.ownerPersonalWorkspaceId))
      .rejects.toThrow("changed while saving");
    expect(L.calls).toHaveLength(33);
    expect(L.calls.length).toBeLessThanOrEqual(50);
  });
});

describe("mergeのundo: 作成auditと索引生成の有界処理", () => {
  it("60 merges (VERSION_KEEP 100): the created-audit write splits into 2 batches, and every row is re-created, but only UNDO_MERGE_REEMBED_INLINE are embedded inline", async () => {
    t = await makeTrashEnv();
    const M = 60;
    t.seed("hub", { content: "Hub" + Array.from({ length: M }, (_, i) => ` fact ${i}`).join("") });
    for (let i = 0; i < M; i++) {
      const prior = "Hub" + Array.from({ length: i }, (_, j) => ` fact ${j}`).join("");
      t.version("hub", i + 1, { content: prior, reason: "merge", meta: JSON.stringify({ incoming: `fact ${i}`, incomingTags: [], incomingSource: "api" }), created_at: 2000 + i });
    }
    const ai = (t.env.AI as any).run; const upsert = (t.env.VECTORIZE as any).upsert;
    const before = ai.mock.calls.length + upsert.mock.calls.length;
    const { env, L } = counted(t.env);
    const r = await revertEntry(env, identity(), "hub", change(), { ...DEFAULTS, VERSION_KEEP: 100 }, 1, t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect((await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE content LIKE 'fact %'`))!.n).toBe(M);
    expect(ai.mock.calls.length + upsert.mock.calls.length - before).toBe(2 * (UNDO_MERGE_REEMBED_INLINE + 1));
    const deferred = (r as { deferredIncoming?: number }).deferredIncoming;
    expect(deferred).toBe(M - UNDO_MERGE_REEMBED_INLINE);
    expect((await t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE content LIKE 'fact %' AND vector_ids = '[]'`))!.n).toBe(deferred);
    expect(AUDIT_BATCH_MAX).toBe(50);
    expect(L.calls).toHaveLength(30);
  });
});

describe("adv-final MAJOR 2: to_version at VERSION_KEEP's real ceiling stays inside the platform's service subrequest limit", () => {
  it("500件のmergeを戻し、D1・KV・AI・Vectorizeの合計を200以内に収める", async () => {
    t = await makeTrashEnv();
    const M = 500;
    t.seed("hub", { content: "hub " + "x".repeat(M) });
    for (let i = 0; i < M; i++) {
      t.version("hub", i + 1, {
        content: "hub " + "x".repeat(i), reason: "merge",
        meta: JSON.stringify({ incoming: `fact ${i}`, incomingTags: [], incomingSource: "api" }),
        created_at: 2000 + i,
      });
    }
    const ai = (t.env.AI as any).run; const upsert = (t.env.VECTORIZE as any).upsert;
    const before = ai.mock.calls.length + upsert.mock.calls.length;
    const { env, L } = counted(t.env);
    const r = await revertEntry(env, identity(), "hub", change(), { ...DEFAULTS, VERSION_KEEP: M }, 1, t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("reverted");
    const aiAndVectorize = ai.mock.calls.length + upsert.mock.calls.length - before;
    expect(aiAndVectorize).toBe(2 * (UNDO_MERGE_REEMBED_INLINE + 1));
    const total = aiAndVectorize + L.calls.length + L.kv.length;
    expect(total).toBeLessThanOrEqual(200);
  }, 30000);
});

describe("R4-B5 (MINOR): insight resolution at the route's real maximum adds N+1 statements to the batch", () => {
  it("97 ids (admin.ts:1397's bulkLimit for an admin with 3 scope bindings): a 195-statement batch, 98 more than main's 97", async () => {
    t = await makeTrashEnv();
    const N = 100 - 3;
    const found: Record<string, unknown>[] = [];
    for (let i = 0; i < N; i++) {
      t.seed(`i${i}`, { tags: '["auto-insight"]' });
      found.push({ id: `i${i}`, tags: '["auto-insight"]', workspace_id: t.roots.ownerPersonalWorkspaceId, vector_ids: "[]" });
    }
    const pending: Promise<unknown>[] = [];
    const { env, L } = counted(t.env);
    const r = await applyInsightResolution(env, { waitUntil: (p) => { pending.push(p); } }, change(), found, N, "confirm");
    await Promise.allSettled(pending);
    expect(r.resolved).toHaveLength(N);
    expect(L.batchSizes[1]).toBe(N);
    expect(L.batchSizes[0]).toBe(2 * N + 1);
  });
});

describe("R4-B7 (MINOR): 'an ordinary update costs exactly one D1 read plus one batch' holds only with no neighbour and no new tag", () => {
  it("関連記憶と新hashtagを含む更新を11 D1・1 KVに固定する", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { tags: '["work"]' });
    t.seed("e2", { tags: '["work"]' });
    (t.env.VECTORIZE as any).query = vi.fn().mockResolvedValue({ matches: [{ id: "e2", score: 0.9, metadata: { parentId: "e2" } }] });
    await t.env.OAUTH_KV.put(`tags:vocabulary:${t.roots.ownerPersonalWorkspaceId}`, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    const { env, L } = counted(t.env);
    const r = await updateEntryContent(env, "e1", "new content #fresh", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");
    expect(L.kv).toHaveLength(1); // 現行4.0 updateは新規captureの語彙登録を繰り返さない。
    expect(L.calls).toHaveLength(11);
    expect(L.calls[0]).toContain("SELECT content, tags, source, vector_ids, workspace_id");
    expect(L.batchSizes).toContain(3);
  });
});

describe.runIf(process.env.EVAL_WORKERD === "1")("R4-B6 (MINOR): the member-removal chunk's '2,000 rows' pin asserts the code's own estimate, not D1", () => {
  it("a chunk deleting 1,000 versions writes 1,000 rows on real workerd D1", async () => {
    const { openD1 } = await import("../eval/d1");
    const { makeMemoryKV, makeTestEnv, makeVectorizeMock, makeAIMock } = await import("../helpers/make-env");
    const { resetDatabaseInit, initializeDatabase } = await import("../../src/db/init");
    const { ensureTenantBootstrap } = await import("../../src/lib/tenancy");
    const { cleanupMemberData } = await import("../../src/lib/team-admin");
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as any, OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock() }) as Env;
      await initializeDatabase(env);
      await ensureTenantBootstrap(env);
      const { member } = await createMember(env, { name: "Ada" });
      await env.DB.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('m1', 'c', '[]', 'api', 1, '[]', ?, ?)`)
        .bind(member.personalWorkspaceId, member.userId).run();
      await env.DB.prepare(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
        INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at)
        SELECT 'm1', ?, i, 'v', NULL, '[]', '', 'rest', 'update', i FROM n`).bind(member.personalWorkspaceId).run();
      const chunkRows: number[] = [];
      const inner = env.DB as any;
      const wrapS = (s: any, sql: string): any => ({
        bind: (...a: unknown[]) => wrapS(s.bind(...a), sql),
        run: async () => { const r = await s.run(); if (/^\s*DELETE FROM entry_versions WHERE id IN/.test(sql)) chunkRows.push(r.meta?.rows_written ?? 0); return r; },
        all: () => s.all(),
        first: (c?: string) => s.first(c),
        __inner: s,
      });
      const DB = { prepare: (sql: string) => wrapS(inner.prepare(sql), sql), batch: (st: any[]) => inner.batch(st.map((x) => x.__inner ?? x)) };
      const progress = await cleanupMemberData({ ...env, DB } as unknown as Env, member.userId, member.personalWorkspaceId, { rowsLeft: 100_000 });
      expect(progress.done).toBe(true);
      expect(progress.rowsWritten).toBeGreaterThanOrEqual(2000); // team-admin.ts's own 2x estimate, unchanged
      expect(chunkRows.reduce((a, b) => a + b, 0)).toBe(1000);
    } finally { await d1.close(); }
  }, 120_000);
});
