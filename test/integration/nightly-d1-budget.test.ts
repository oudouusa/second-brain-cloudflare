import { chatGptResponse, mockChatGptFetch } from "../helpers/chatgpt-provider";
/** Whole scheduled() regression: real SQLite/fences, real Responses adapter, fake providers.
 * Counts attempted SQL (including each batch member), not billed rows or CPU time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { initializeDatabase, resetDatabaseInit, DATABASE_SCHEMA_VERSION } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import {
  NIGHTLY_D1_FREE_SQL_LIMIT,
  NIGHTLY_D1_PAID_SQL_LIMIT,
} from "../../src/runtime/d1-budget";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";

type Fault = "none" | "stale-cas" | "stale-sql" | "rollup" | "cleanup-read"
  | "release-twice" | "release-always" | "vector-upsert" | "vector-delete" | "receipt";
type Scenario = { fault?: Fault; cleanup?: "send" | "confirmed" | "visible"; long?: boolean;
  sunday?: boolean; sourceCount?: number; steady?: boolean; neighbors?: number; nights?: number;
  executionProfile?: "free" | "paid" };
const prior = { ranAt: 1000, digestsWritten: 3, linksInferred: 2, claimsFlagged: 1, insightsProposed: 0 };
const normalize = (q: string) => q.replace(/\s+/g, " ").trim();

function countedDatabase(base: any, fault: Fault, ceiling = NIGHTLY_D1_FREE_SQL_LIMIT) {
  const sql: { sql: string; bindings: number }[] = [];
  let calls = 0; let releases = 0; let refusals = 0;
  const bill = (q: string, bindings: number) => {
    sql.push({ sql: q, bindings });
    // Native ceiling too: a broken guard must fail the test, not silently overrun.
    if (sql.length > ceiling) throw new Error("Synthetic platform SQL ceiling");
  };
  const simulate = (q: string) => {
    const cas = q.startsWith("UPDATE entries SET tags = ?, staleness_checked_at");
    if (fault === "stale-cas" && cas) { refusals++; return { success: true, meta: { changes: 0 } }; }
    if (fault === "stale-sql" && cas) { refusals++; throw new Error("Synthetic staleness refusal"); }
    if (fault === "rollup" && q.includes("SET tags = json_insert")) { refusals++; throw new Error("Synthetic rollup refusal"); }
    if (fault === "cleanup-read" && q.startsWith("SELECT op_id, entry_id")) { refusals++; throw new Error("Synthetic cleanup refusal"); }
    if ((fault === "release-twice" || fault === "release-always") && q === "DELETE FROM memory_write_admissions WHERE token = ?") {
      releases++; if (releases <= 2 || fault === "release-always") { refusals++; throw new Error("Synthetic release refusal"); }
    }
    if (fault === "receipt" && q.startsWith("UPDATE vector_cleanup_ops SET ready = 3")) {
      refusals++; throw new Error("Synthetic receipt refusal");
    }
  };
  const wrap = (inner: any, q: string, args: any[] = []): any => ({
    bind: (...values: any[]) => wrap(inner.bind(...values), q, values),
    run: async () => { bill(q, args.length); calls++; return simulate(q) ?? await inner.run(); },
    first: async (...a: any[]) => { bill(q, args.length); calls++; const r = simulate(q); return r ?? await inner.first(...a); },
    all: async () => { bill(q, args.length); calls++; return simulate(q) ?? await inner.all(); },
    __inner: inner, __sql: q, __args: args,
  });
  const DB = {
    prepare: (q: string) => wrap(base.prepare(q), normalize(q)),
    exec: async (q: string) => { bill(q, 0); calls++; return base.exec(q); },
    batch: async (batch: any[]) => {
      calls++; for (const s of batch) bill(s.__sql, s.__args.length);
      const result = batch.map(s => simulate(s.__sql));
      if (result.some(Boolean)) {
        if (!result.every(Boolean)) throw new Error("Unexpected mixed synthetic CAS batch");
        return result;
      }
      return base.batch(batch.map(s => s.__inner));
    },
  } as unknown as D1Database;
  return { DB, sql, calls: () => calls, refusals: () => refusals, releases: () => releases,
    reset: () => { sql.length = 0; calls = 0; releases = 0; refusals = 0; } };
}

async function runScenario(s: Scenario = {}) {
  // cleanupを先頭で処理するphase=1の日曜と、phase=0の土曜を固定する。
  const saturday = Date.UTC(2026, 9, 10, 1);
  const clock = vi.spyOn(Date, "now").mockReturnValue(saturday + (s.sunday ? 86400000 : 0));
  const sq = makeSqliteD1({ autoAdmitFixtureWrites: false });
  try {
    const kv = makeMemoryKV();
    const fixtureEnv = makeTestEnv(undefined, { DB: sq.db as unknown as D1Database, OAUTH_KV: kv });
    await initializeDatabase(fixtureEnv);
    const ownerWorkspace = (await ensureTenantBootstrap(fixtureEnv)).ownerPersonalWorkspaceId;
    const summaryKey = `night:${ownerWorkspace}`;
    for (let t = 0; t < 7; t++) for (let i = 0; i < (s.sourceCount ?? 11); i++) sq.seed({
      id: `t${t}-e${i}`, content: `Person ${i} works at Company ${t}`
        + (s.long ? " extended relevant memory".repeat(500) : ""),
      workspaceId: ownerWorkspace, tags: [`topic-${t}`], source: "api", createdAt: Date.now() - STALENESS_AGE_MS - 86400000 + i,
    });
    if (s.steady) await sq.db.prepare("INSERT INTO maintenance_cursor(id,workspace_id,advanced_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id")
      .bind(ownerWorkspace, 1).run();
    if (s.cleanup) for (let i = 0; i < 30; i++) await sq.db.prepare(
      "INSERT INTO vector_cleanup_ops(op_id,entry_id,vector_ids,created_at,ready,expires_at,write_marker) VALUES(?,?,?,?,?,?,?)",
    ).bind(`debt-${i}`, `gone-${i}`, JSON.stringify(s.cleanup === "send" ? [`old-${i}`]
      : { ids: [`old-${i}`], deleteMutationId: "m", deleteSubmittedAt: 1 }),
    i, s.cleanup === "send" ? 1 : 3, 0, sq.fixtureMarker()).run();
    await kv.put(summaryKey, JSON.stringify(prior));
    resetDatabaseInit();
    const ceiling = s.executionProfile === "paid"
      ? NIGHTLY_D1_PAID_SQL_LIMIT
      : NIGHTLY_D1_FREE_SQL_LIMIT;
    const counted = countedDatabase(sq.db, s.fault ?? "none", ceiling);
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockImplementation((_v, options) => Promise.resolve({ matches: options?.filter ? []
        : Array.from({ length: s.neighbors ?? 4 }, (_, i) => ({ id: `t1-e${i}`, score: 0.95 })) })),
      ...(s.cleanup === "visible" ? { getByIds: vi.fn().mockImplementation((ids: string[]) =>
        Promise.resolve(ids.map(id => ({ id, values: [1], metadata: { parentId: id.replace("old-", "gone-") } })))) } : {}),
    });
    if (s.fault === "vector-upsert") vi.mocked(vectorize.upsert).mockRejectedValue(new Error("Synthetic upsert refusal"));
    if (s.fault === "vector-delete") vi.mocked(vectorize.deleteByIds).mockRejectedValue(new Error("Synthetic delete refusal"));
    const directFetch = mockChatGptFetch(vi.fn(async (_url: any, init: any) => {
      const payload = JSON.parse(init.body);
      return chatGptResponse(payload.model === "gpt-5.6-terra"
        ? "Stored evidence summarized without adding facts."
        : JSON.stringify({ importance: 3, canonical: false, kind: "semantic" }));
    }));
    const env = makeTestEnv(undefined, { DB: counted.DB, OAUTH_KV: kv, VECTORIZE: vectorize,
      CHATGPT_MODEL: "gpt-5.6-luna", CHATGPT_OWNER_WORKSPACE_ID: ownerWorkspace,
      NIGHTLY_D1_EXECUTION_PROFILE: s.executionProfile,
      CHATGPT_OPERATIONS: "classify,query-tags,smart-merge,contradiction,recall-summary,digest,answer,weekly-insight" });
    const logs: any[] = [];
    vi.spyOn(console, "log").mockImplementation(value => {
      try { logs.push(JSON.parse(String(value))); } catch { /* not an event */ }
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (task: Promise<unknown>) => pending.push(task) } as unknown as ExecutionContext;
    let budget: any;
    const invocations: { sql: number; calls: number; debt: number }[] = [];
    for (let night = 0; night < (s.nights ?? 1); night++) {
      counted.reset(); logs.length = 0; resetDatabaseInit();
      clock.mockReturnValue(saturday + ((s.sunday ? 1 : 0) + night) * 86400000);
      const previousSummary = await kv.get(summaryKey);
      await worker.scheduled({ cron: "0 1 * * *", scheduledTime: Date.now() } as ScheduledEvent, env, ctx);
      const settled: PromiseSettledResult<unknown>[] = [];
      while (pending.length) settled.push(...await Promise.allSettled(pending.splice(0)));
      budget = logs.find(x => x.event === "nightly_budget");
      expect(budget).toBeDefined();
      expect(budget.used).toBe(counted.sql.length);
      expect(budget.calls).toBe(counted.calls());
      expect(counted.sql.length).toBeLessThanOrEqual(ceiling);
      expect(budget.limit).toBe(ceiling);
      expect(counted.sql.every(q => q.bindings <= 100)).toBe(true);
      expect(settled.every(x => x.status === "fulfilled")).toBe(true);
      if (budget.deferred > 0) expect(await kv.get(summaryKey)).toBe(previousSummary);

      invocations.push({ sql: counted.sql.length, calls: counted.calls(),
        debt: Number((await sq.db.prepare("SELECT COUNT(*) AS n FROM vector_cleanup_ops WHERE op_id LIKE 'debt-%'").first() as any).n) });
    }
    const admissions = await sq.db.prepare("SELECT token FROM memory_write_admissions WHERE token NOT LIKE 'sqlite-fixture-%'").all();
    if (s.fault !== "release-always") expect(admissions.results).toHaveLength(0);
    const summary = JSON.parse((await kv.get(summaryKey))!);
    if (budget.deferred > 0) expect(summary).toEqual(prior);
    const rows = sq.rows();
    const debt = (await sq.db.prepare("SELECT op_id,ready,vector_ids FROM vector_cleanup_ops").all()).results as any[];
    return { budget, summary, rows, debt, logs, invocations, sql: counted.sql, refusals: counted.refusals(),
      releases: counted.releases(), admissions: admissions.results,
      directCalls: directFetch.mock.calls.length,
      deletes: vi.mocked(vectorize.deleteByIds).mock.calls, upserts: vi.mocked(vectorize.upsert).mock.calls };
  } finally { sq.close(); }
}

describe("bounded complete nightly invocation", () => {
  beforeEach(() => { resetDatabaseInit(); vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it.each([{ steady: true }, {}, { sunday: true }, { long: true }, { long: true, sunday: true }])(
    "実Responses・SQLiteの処理と解放を50 SQL以内に保ち、保守先行日のpartialを公開しない: %j", async options => {
      const r = await runScenario(options);
      expect(r.directCalls).toBeGreaterThan(0);
      expect(r.rows.some(e => JSON.parse(String(e.tags)).includes("synthesized"))).toBe(true);
      if ("sunday" in options && options.sunday) {
        expect(r.budget.deferred).toBe(1);
        expect(r.summary).toEqual(prior);
        expect(r.logs).toContainEqual(expect.objectContaining({ operation: "nightly_maintenance", outcome: "partial" }));
        return;
      }
      expect(r.summary.ranAt).toBeGreaterThan(prior.ranAt);
      expect(r.summary).toMatchObject({ digestsWritten: 1 });
      expect(r.summary.linksInferred).toBeGreaterThan(0);
      expect(r.summary.claimsFlagged).toBeGreaterThan(0);
      expect(r.budget.deferred).toBe(0);
    });

  it("uses Paid headroom to retire cleanup debt without weakening the journal boundary", async () => {
    const r = await runScenario({ cleanup: "confirmed", executionProfile: "paid" });
    expect(r.budget.limit).toBe(NIGHTLY_D1_PAID_SQL_LIMIT);
    expect(r.budget.deferred).toBe(0);
    expect(r.sql.length).toBeGreaterThan(NIGHTLY_D1_FREE_SQL_LIMIT);
    expect(r.sql.length).toBeLessThanOrEqual(NIGHTLY_D1_PAID_SQL_LIMIT);
    expect(r.debt.filter(row => row.op_id.startsWith("debt-"))).toHaveLength(0);
    expect(r.summary.ranAt).toBeGreaterThan(prior.ranAt);
  });

  it.each(["send", "confirmed", "visible"] as const)("bounds 30 cleanup rows in state %s alongside real passes", async cleanup => {
    const r = await runScenario({ cleanup });
    expect(r.directCalls).toBeGreaterThan(0);
    if (cleanup !== "confirmed") {
      expect(r.deletes.length).toBeGreaterThan(0);
      expect(r.debt.filter(row => row.op_id.startsWith("debt-")).length).toBeGreaterThan(0);
      // Every acknowledged delete remains journaled with its receipt until confirmed.
      for (const [ids] of r.deletes) for (const id of ids as string[]) {
        expect(r.debt.some(row => JSON.stringify(row.vector_ids).includes(id))).toBe(true);
      }
    } else {
      expect(r.debt.filter(row => row.op_id.startsWith("debt-")).length).toBeLessThan(30);
    }
  });

  it.each(["stale-cas", "stale-sql", "rollup", "cleanup-read", "release-twice", "release-always", "vector-upsert"] as const)(
    "preserves durable work and finalizer under %s", async fault => {
      const r = await runScenario({ fault, sourceCount: fault === "rollup" ? 50 : 11 });
      expect(r.rows.filter(e => String(e.id).startsWith("t"))).toHaveLength(7 * (fault === "rollup" ? 50 : 11));
      if (["stale-cas", "stale-sql", "rollup", "cleanup-read"].includes(fault)) {
        expect(r.refusals).toBeGreaterThan(0); expect(r.summary).toEqual(prior);
      }
      if (fault === "rollup") {
        expect(r.sql.filter(q => q.sql.includes("SET tags = json_insert"))).toHaveLength(1);
        expect(r.rows.filter(e => String(e.id).startsWith("t")).every(e => !String(e.tags).includes("rolled-up"))).toBe(true);
      }
      if (fault.startsWith("release")) expect(r.releases).toBe(3);
      if (fault === "release-always") expect(r.admissions).toHaveLength(1);
      if (fault === "vector-upsert") expect(r.debt.length).toBeGreaterThan(0);
    });

  it.each(["vector-delete", "receipt", "stale-cas", "stale-sql", "rollup"] as const)(
    "bounds combined cleanup and %s failure without losing tombstones", async fault => {
      const r = await runScenario({ fault, cleanup: "send", sunday: true });
      expect(r.debt.filter(row => row.op_id.startsWith("debt-")).length).toBeGreaterThan(0);
      expect(r.rows.filter(e => String(e.id).startsWith("t"))).toHaveLength(77);
      expect(r.summary).toEqual(prior);
    });
  it("drains finite deletion debt across bounded nights instead of starving behind new work", async () => {
    const r = await runScenario({ cleanup: "send", nights: 32 });
    expect(r.invocations).toHaveLength(32);
    expect(r.invocations.every(x => x.sql <= NIGHTLY_D1_FREE_SQL_LIMIT)).toBe(true);
    expect(r.invocations[0].debt).toBe(30); // first receipt is not proof of visible deletion
    expect(r.invocations.at(-1)!.debt).toBe(0);
    expect(r.debt.filter(row => row.op_id.startsWith("debt-"))).toHaveLength(0);
    expect(r.rows.filter(e => String(e.id).startsWith("t"))).toHaveLength(77);
  });

  it("schema-initialization ticks converge without bypassing the nightly SQL cap", async () => {
    const sq = makeSqliteD1({ schema: false, autoAdmitFixtureWrites: false });
    const kv = makeMemoryKV();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let ready = false;
      for (let tick = 0; tick < 12 && !ready; tick++) {
        resetDatabaseInit();
        const trace = countedDatabase(sq.db, "none");
        const env = makeTestEnv(undefined, { DB: trace.DB, OAUTH_KV: kv });
        const pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
        await worker.scheduled({ cron: "0 1 * * *", scheduledTime: Date.now() } as ScheduledEvent, env, ctx);
        while (pending.length) await Promise.allSettled(pending.splice(0));
        expect(trace.sql.length).toBeLessThanOrEqual(NIGHTLY_D1_FREE_SQL_LIMIT);
        const row = await sq.db.prepare("SELECT version FROM schema_meta").first() as { version: number } | null;
        ready = row?.version === DATABASE_SCHEMA_VERSION;
      }
      expect(ready).toBe(true);
    } finally { sq.close(); }
  });

});
