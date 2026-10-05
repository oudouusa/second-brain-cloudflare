/**
 * All four nightly jobs are fired from a single scheduled() invocation (src/index.ts),
 * so they share ONE subrequest budget — 50 on the free plan. Each of them awaits
 * initializeDatabase, so before it was memoised the same thirteen DDL statements were paid
 * for once per job, and the pass that runs last could find the budget already spent.
 *
 * Memoisation cut that to thirteen; #282 cut the thirteen to a single catalogue read.
 * The schema-version marker now makes the steady state cheaper still: one single-row
 * version read, with the catalogue probe reserved for a genuine upgrade.
 *
 * This measures the whole invocation rather than any one job, because per-job budget
 * assertions are not true in situ.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { SYNC_EVENT_BATCH } from "../../src/integrations/calendar";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import { makeTestDb, makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";
import { INTEGRATION_SYNC_CRON } from "../../src/integrations/mirror";
import { INTEGRATION_PROVIDERS } from "../../src/integrations";
import { INSIGHT_ACCRUAL_CRON, INSIGHT_WEEKLY_CRON, INSIGHT_TEAM_WEEKLY_CRON } from "../../src/insight/schedule";
import { CONFIG_KEY } from "../../src/config";
import { ACCRUAL_CURSOR_KEY } from "../../src/insight/candidates";
import { runGraphPass } from "../../src/graph/pass";
import { SCHEDULED_VECTORIZE_PENDING_BATCH } from "../../src/capture/pending";

const FREE_PLAN_SUBREQUESTS = 50;
const MAINTENANCE_CRON = "0 1 * * *";
const TEAM_INSIGHT_SLOT = Date.UTC(2026, 7, 30, 2, 30); // Sunday 02:30 UTC

// D1 Free bills every query, including every statement inside DB.batch(). The wrapper
// counts statements, not network round trips, so a large batch cannot hide a limit breach.
function countingEnv(db: D1Mock, overrides: Partial<Env> = {}) {
  const statements: string[] = [];
  const kvOperations: string[] = [];
  const bindingCalls: string[] = [];
  const bill = (sql: string) => statements.push(sql.replace(/\s+/g, " ").trim());
  const wrap = (stmt: any, sql: string): any => ({
    bind: (...a: any[]) => wrap(stmt.bind(...a), sql),
    run: () => { bill(sql); bindingCalls.push("D1"); return stmt.run(); },
    first: (...a: any[]) => { bill(sql); bindingCalls.push("D1"); return stmt.first(...a); },
    all: () => { bill(sql); bindingCalls.push("D1"); return stmt.all(); },
    __inner: stmt,
    __sql: sql.replace(/\s+/g, " ").trim(),
  });
  const prepared: string[] = [];
  const DB = {
    prepare(sql: string) { prepared.push(sql.replace(/\s+/g, " ").trim()); return wrap(db.prepare(sql), sql); },
    exec(sql: string) { bill(sql); bindingCalls.push("D1"); return db.exec(sql); },
    batch: (stmts: any[]) => {
      bindingCalls.push("D1_BATCH");
      for (const stmt of stmts) bill(stmt.__sql ?? "BATCH_STATEMENT");
      return db.batch(stmts.map((s: any) => s.__inner ?? s));
    },
  } as unknown as D1Database;

  const baseKV = overrides.OAUTH_KV ?? makeTestEnv(db).OAUTH_KV;
  const OAUTH_KV = {
    ...baseKV,
    get: (...a: Parameters<KVNamespace["get"]>) => { kvOperations.push(`GET ${a[0]}`); bindingCalls.push("KV_GET"); return (baseKV.get as any)(...a); },
    put: (...a: Parameters<KVNamespace["put"]>) => { kvOperations.push(`PUT ${a[0]}`); bindingCalls.push("KV_PUT"); return (baseKV.put as any)(...a); },
  } as unknown as KVNamespace;

  return { env: makeTestEnv(db, { DB, VECTORIZE: makeVectorizeMock(), ...overrides, OAUTH_KV }), statements, prepared, kvOperations, bindingCalls };
}

// Each tag gets more than the ten eligible entries a digest needs, so nightly compression
// actually runs. Without that the budget test measures a cron with its largest job idle.
function seedCompressibleTags(db: D1Mock, tagCount: number) {
  const old = Date.now() - STALENESS_AGE_MS - 86400000;
  for (let t = 0; t < tagCount; t++) {
    for (let i = 0; i < 11; i++) {
      db.entries.push({
        id: `t${t}-e${i}`, content: `Person ${i} works at Company ${t}`, tags: JSON.stringify([`topic-${t}`]),
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
        recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
      });
    }
  }
}

// ─── Integration fixture ──────────────────────────────────────────────────────
// A connected calendar with a backlog far larger than one batch, so the cron is
// measured with the integration job doing as much work as it is ever allowed to.

function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsWithUpcomingEvents(count: number): string {
  const now = Date.now();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN"];
  for (let i = 0; i < count; i++) {
    const start = now + (i + 1) * 3600_000; // hourly, inside the 30-day window
    lines.push(
      "BEGIN:VEVENT", `UID:evt-${i}@test`, `DTSTAMP:${icsUtc(now)}`,
      `DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(start + 1800_000)}`,
      `SUMMARY:Event ${i}`, "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// The feed URL carries the provider id so a stubbed fetch can tell the
// connections apart when more than one is wired up.
async function connectCalendar(
  kv: KVNamespace,
  eventCount: number,
  providers: string[] = ["calendar-google"],
): Promise<ReturnType<typeof vi.fn>> {
  for (const [i, id] of providers.entries()) {
    await kv.put(`integrations:${id}`, JSON.stringify({
      provider: id,
      authKind: "token",
      credentials: { token: `https://cal.example/${id}/feed.ics` },
      config: {},
      status: "connected",
      workspaceName: id,
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 0,
      // Distinct so the rotation has a defined starting order.
      updatedAt: i,
    }));
  }
  const ics = icsWithUpcomingEvents(eventCount);
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => ics }) as any);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function savedIntegration(kv: KVNamespace, db: D1Mock, provider: string) {
  const generation = db.integrationStateGeneration?.generation;
  const providerGeneration = db.integrationProviderGenerations.get(provider)?.generation;
  const raw = await kv.get(generation && providerGeneration
    ? `integrations:${provider}:${generation}:${providerGeneration}`
    : `integrations:${provider}`);
  return JSON.parse(raw as string);
}

// Consecutive runs in a test land in the same millisecond, which the real
// schedule never does — and the rotation cursor is a timestamp, so equal
// timestamps tie and registry order wins every time. Step a fake clock by an
// hour per run so a multi-run test models the schedule it is describing.
function hourlyClock(): (run: number) => void {
  const base = Date.now();
  const spy = vi.spyOn(Date, "now");
  return (run: number) => spy.mockReturnValue(base + run * 3600_000);
}

// `cron` selects which invocation is being measured — the two schedules are two
// separate budgets, so a run has to name the one it means (#290).
async function runCron(env: any, cron = MAINTENANCE_CRON, scheduledTime?: number) {
  const pending: Promise<any>[] = [];
  const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any;
  await (worker as any).scheduled({ cron, scheduledTime } as any, env, ctx);
  await Promise.allSettled(pending);
}

describe("nightly cron D1 subrequest cost", () => {
  beforeEach(() => {
    resetDatabaseInit();
    vi.restoreAllMocks();
  });

  it("checks the schema version once per invocation, not once per job, and issues no DDL", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env, "0 1 * * *");

    // The steady-state signature statement of initializeDatabase, once for the whole cron.
    expect(statements.filter(s => s.startsWith("SELECT version"))).toHaveLength(1);
    expect(statements.filter(s => s.startsWith("WITH schema_groups"))).toHaveLength(0);
    // #282: the schema is already there, and the whole point is that finding that out no
    // longer costs a CREATE and an ALTER per object.
    expect(statements.filter(s => /^(CREATE|ALTER)\b/.test(s))).toEqual([]);
  });

  // The staleness pass used to be the largest consumer of this budget: one CAS per
  // candidate, and in situ it runs concurrently with the compression job's writes, so its
  // guards lose and it pays for re-reads and retries on top. Batched, the whole pass is a
  // candidate query and one write round trip.
  it("bounds combined maintenance and advances remaining work on the next run", async () => {
    const db = makeTestDb();
    seedCompressibleTags(db, 7);
    const { env, statements } = countingEnv(db);

    await runCron(env);
    const compressionQueries = statements.length;
    expect(db.entries.filter(e => e.staleness_checked_at != null)).toHaveLength(2);
    expect(compressionQueries).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    await runCron(env, "0 1 * * *");
    const graphStalenessQueries = statements.length - compressionQueries;

    expect(db.entries.filter(e => JSON.parse(e.tags).includes("synthesized")).length).toBeGreaterThan(0);
    expect(db.entries.filter(e => e.staleness_checked_at != null)).toHaveLength(4);
    expect(graphStalenessQueries).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });

  it.each([[false, false], [true, false], [true, true]])("counts SQL and other bindings separately with active work (Sunday=%s, long=%s)", async (sunday, long) => {
    // Use a future weekend: SQLite validates admission expiry against its real clock.
    // Keep Saturday at maintenance phase 0 and Sunday at phase 1. The phase-2
    // index-first pass can legitimately defer compression within the shared budget;
    // this fixture asserts a complete digest run, not that every phase completes it.
    const current = new Date();
    let nextSaturday = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(),
      current.getUTCDate() + 7 + ((6 - current.getUTCDay() + 7) % 7), 1);
    while (Math.floor(nextSaturday / 86400000) % 3 !== 0) nextSaturday += 7 * 86400000;
    vi.spyOn(Date, "now").mockReturnValue(nextSaturday + (sunday ? 86400000 : 0));
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });
    const sq = makeSqliteD1();
    try {
      const kv = makeMemoryKV();
      await initializeDatabase(makeTestEnv(undefined, { DB: sq.db as unknown as D1Database, OAUTH_KV: kv }));
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      for (let t = 0; t < 7; t++) for (let i = 0; i < 11; i++) sq.seed({
        id: `t${t}-e${i}`, content: `Person ${i} works at Company ${t}` + (long ? " extended relevant memory".repeat(500) : ""),
        source: "api", tags: [`topic-${t}`], createdAt: old + i,
      });
      resetDatabaseInit();
      const vectorize = makeVectorizeMock({
        // Capturing the new digest has no duplicate in its scoped lookup;
        // the unfiltered graph backfill independently finds four neighbors.
        query: vi.fn().mockImplementation((_values, options) => Promise.resolve({
          matches: options?.filter ? [] : Array.from({ length: 4 }, (_, i) => ({ id: `t1-e${i}`, score: 0.95 })),
        })),
      });
      const ai = makeTestEnv().AI;
      // The wrapper only needs prepare/exec/batch; real SQL is essential for
      // rotation, scoped compression, CAS retries and affected-row counters.
      const { env, statements, bindingCalls, kvOperations } = countingEnv(sq.db as unknown as D1Mock, {
        OAUTH_KV: kv, VECTORIZE: vectorize, AI: ai,
      });
      await runCron(env);
      const vectorCalls = [vectorize.query, vectorize.upsert, vectorize.getByIds,
        vectorize.deleteByIds, vectorize.describe].reduce((n, fn) => n + vi.mocked(fn).mock.calls.length, 0);
      const totalBindingCalls = bindingCalls.length + vi.mocked(ai.run).mock.calls.length + vectorCalls;
      const edges = await sq.db.prepare("SELECT COUNT(*) AS n FROM edges").first() as { n: number };
      expect(edges.n).toBeGreaterThan(0);
      expect(sq.rows().some(e => JSON.parse(e.tags as string).includes("synthesized"))).toBe(true);
      expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
      // Internal service requests have a separate limit from D1 SQL statements.
      // Conservatively count every instrumented binding call here; this does
      // not assert remote billed rows, CPU, or external HTTP subrequests.
      expect(totalBindingCalls).toBeLessThanOrEqual(1_000);
      expect(errors).toEqual([]);
      expect(kvOperations.filter(s => s.startsWith("PUT night:"))).toHaveLength(1);
      const record = JSON.parse((await kv.get("night:"))!);
      expect(record.digestsWritten).toBe(1);
      expect(record.linksInferred).toBeGreaterThan(0);
      expect(record.claimsFlagged).toBeGreaterThan(0);
    } finally { sq.close(); }
  });

  it.each([
    { day: "Saturday", now: Date.UTC(2026, 8, 12, 1), expectedStatements: 31 },
    { day: "Sunday", now: Date.UTC(2026, 8, 13, 1), expectedStatements: 33 },
  ])("keeps a whole nightly run inside the free-plan subrequest budget ($day)", async ({ now, expectedStatements }) => {
    // Pin the mock clock: Sunday's existing graph sweep adds two statements.
    // This fixture uses D1Mock, so there is no independent SQLite expiry clock.
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env, "0 1 * * *");

    expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    // 期限抽出の走査2文を追加し、古さの再判定は夜間2件にする。手動上限は維持。
    // KV is counted separately; batch SQL is still counted per statement.
    // The bounded pre-pass cleanup adds one empty-queue read; FTS maintenance
    // adds six statements on this mock's first, healthy-but-unlatched night.
    expect(statements.length).toBe(expectedStatements);
  });

  it("retires three pages of confirmed cleanup within the bounded nightly invocation", async () => {
    const db = makeTestDb();
    for (let i = 0; i < 30; i++) {
      db.vectorCleanupOps.push({
        op_id: `cleanup-${i}`,
        entry_id: `retired-${i}`,
        vector_ids: JSON.stringify({
          ids: [`old-vector-${i}`],
          deleteMutationId: "m",
          deleteSubmittedAt: 1,
        }),
        created_at: i,
        ready: 3,
        expires_at: 0,
        write_marker: null,
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env, "0 1 * * *");

    expect(db.vectorCleanupOps).toHaveLength(0);
    expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });

  it("packs the bounded graph refresh of 8 x 3 edges into three D1 inserts", async () => {
    const db = makeTestDb();
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `graph-${i}`, content: `entry ${i}`, tags: "[]", source: "api",
        created_at: i, updated_at: i, vector_ids: "[]",
      });
    }
    for (let i = 0; i < 4; i++) {
      db.entries.push({
        id: `neighbor-${i}`, content: `neighbor ${i}`, tags: "[]", source: "api",
        created_at: -i - 1, updated_at: -i - 1, vector_ids: "[]",
      });
    }
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: Array.from({ length: 4 }, (_, i) => ({ id: `neighbor-${i}`, score: 0.9 })),
      }),
    });
    const { env, statements } = countingEnv(db, { VECTORIZE: vectorize });

    await runGraphPass(env, { waitUntil: () => {} } as unknown as ExecutionContext);

    expect(db.edges).toHaveLength(24);
    expect(statements.filter(sql => sql.startsWith("INSERT INTO edges"))).toHaveLength(3);
    expect(statements.length).toBeLessThanOrEqual(13);
  });

  it("still leaves the staleness pass room to run after the other jobs", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "job", content: "Bob works at Example Inc", tags: "[]",
      source: "api", created_at: old, updated_at: old, vector_ids: "[]",
    });
    const { env } = countingEnv(db);

    await runCron(env, "0 1 * * *");

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
    expect(tags).toContain("stale:as-of");
  });

  // ─── The integration sync's own invocation (#290) ──────────────────────────
  // The mirror sync used to be the fourth job on this invocation, sized against
  // an accounting that counted only the ONE outbound fetch a sync makes. What a
  // batch actually costs is the bindings each mirrored item touches — two D1
  // queries per created entry, three per updated one — so its five batches were
  // 100 D1 queries in an invocation that allows 50 in total. Even one batch only
  // fitted while the batch was creates and exactly one provider was connected.
  // It now runs on its own schedule, so these are two budgets to keep, not one.

  describe("the integration schedule", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("runs one batch, and records the cursor the next run resumes from", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 24);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      // One batch is one feed fetch and one expansion of it — the expansion is
      // the CPU half of #290, so paying it once per run is the point.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(SYNC_EVENT_BATCH);

      const saved = await savedIntegration(kv, db, "calendar-google");
      expect(Object.keys(saved.itemMap)).toHaveLength(SYNC_EVENT_BATCH);
      expect(saved.lastSyncedAt).not.toBeNull();
    });

    it("purges a full disconnect page inside the D1 Free budget", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 0);
      for (let i = 0; i < 1; i++) {
        db.entries.push({
          id: `purge-${i}`,
          content: `Calendar ${i}`,
          tags: '["calendar","calendar-google"]',
          source: "calendar-google",
          created_at: i + 1,
          updated_at: i + 1,
          vector_ids: JSON.stringify([`vector-${i}`]),
        });
      }
      const { env, statements } = countingEnv(db, { OAUTH_KV: kv });
      const pending: Promise<unknown>[] = [];
      const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as any;
      let done = false;
      let cursor: string | undefined;
      for (let page = 0; page < 2; page++) {
        statements.length = 0;
        const response = await worker.fetch(new Request("http://localhost/integrations/calendar-google/disconnect", {
          method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
          body: JSON.stringify({ purge: true, ...(cursor === undefined ? {} : { cursor }) }),
        }), env, ctx);
        await Promise.allSettled(pending);
        expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
        const result = await response.json() as any;
        expect(response.status).toBe(result.done ? 200 : 202);
        cursor = result.next_cursor;
        if (result.done) { done = true; break; }
      }
      expect(done).toBe(true);
      expect(db.entries).toHaveLength(0);
      expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    });

    // An iCloud published URL that misses on caldav retries once on calendars
    // (#310). That is two outbound fetches in the same invocation; the happy
    // path above still asserts one, so this is the case that notices the extra.
    it("pays two feed fetches when an iCloud caldav host misses and calendars succeeds", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await kv.put("integrations:calendar-icloud", JSON.stringify({
        provider: "calendar-icloud",
        authKind: "token",
        credentials: { token: "https://p12-caldav.icloud.com/published/2/token" },
        config: {},
        status: "connected",
        workspaceName: "Family",
        lastSyncedAt: null,
        lastSyncError: null,
        itemMap: {},
        createdAt: 0,
        updatedAt: 0,
      }));
      const ics = icsWithUpcomingEvents(24);
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).includes("-caldav.")) {
          return { ok: false, status: 400, text: async () => "" } as any;
        }
        return { ok: true, status: 200, text: async () => ics } as any;
      });
      vi.stubGlobal("fetch", fetchMock);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
        "https://p12-caldav.icloud.com/published/2/token",
        "https://p12-calendars.icloud.com/published/2/token",
      ]);
      expect(db.entries.filter(e => e.source === "calendar-icloud")).toHaveLength(SYNC_EVENT_BATCH);
      const saved = await savedIntegration(kv, db, "calendar-icloud");
      expect(saved.lastSyncedAt).not.toBeNull();
    });

    it("keeps its own invocation inside the D1 budget", async () => {
      const db = makeTestDb();
      seedCompressibleTags(db, 7); // a big brain must not make the sync cost more
      const kv = makeMemoryKV();
      await connectCalendar(kv, 24);
      const { env, statements } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(SYNC_EVENT_BATCH);
      expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    });

    it("keeps scheduled vector recovery inside the total Free-plan subrequest budget", async () => {
      const now = Date.UTC(2026, 7, 29, 0, 30);
      vi.spyOn(Date, "now").mockReturnValue(now);
      const db = makeTestDb();
      for (let i = 0; i < SCHEDULED_VECTORIZE_PENDING_BATCH; i++) {
        db.entries.push({
          id: `pending-${i}`,
          content: `Pending recovery ${i}`,
          tags: '["work"]',
          source: "api",
          created_at: now - 600_000,
          updated_at: now - 600_000,
          vector_ids: "[]",
          recall_count: 0,
          importance_score: 0,
          contradiction_wins: 0,
          contradiction_losses: 0,
        });
      }
      const kv = makeMemoryKV();
      const aiRun = vi.fn().mockResolvedValue({ data: [new Array(768).fill(0.1)] });
      const vectorize = makeVectorizeMock();
      const { env, statements } = countingEnv(db, {
        AI: { run: aiRun } as unknown as Ai,
        OAUTH_KV: kv,
        VECTORIZE: vectorize,
      });
      const kvGet = vi.spyOn(kv, "get");

      await runCron(env, INTEGRATION_SYNC_CRON, now);

      const totalSubrequests = statements.length
        + aiRun.mock.calls.length
        + vi.mocked(vectorize.upsert).mock.calls.length
        + kvGet.mock.calls.length;
      expect(db.entries.every(entry => entry.vector_ids !== "[]")).toBe(true);
      expect(totalSubrequests).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    });

    // The multiplier the rotation exists to remove: syncing every connected
    // provider in one invocation measured 70 D1 queries with two calendars.
    it("syncs one provider per run however many are connected", async () => {
      const db = makeTestDb();
      seedCompressibleTags(db, 7);
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 24, ["calendar-google", "calendar-outlook", "calendar-icloud"]);
      const { env, statements } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(db.entries.filter(e => e.source.startsWith("calendar-"))).toHaveLength(SYNC_EVENT_BATCH);
      expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    });

    it("rotates to the least recently attempted provider on the next run", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 24, ["calendar-google", "calendar-outlook"]);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);
      resetDatabaseInit();
      await runCron(env, INTEGRATION_SYNC_CRON);

      // Each got exactly one batch — the second run did not repeat the first's
      // provider, which is what stops one connection starving the others.
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(SYNC_EVENT_BATCH);
      expect(db.entries.filter(e => e.source === "calendar-outlook")).toHaveLength(SYNC_EVENT_BATCH);
    });

    // A provider whose token has expired writes updatedAt but never lastSyncedAt.
    // Ordering the rotation by lastSyncedAt would therefore pick it every single
    // run, forever, and the working connection would never sync again.
    it("does not let a permanently failing provider starve a working one", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 24, ["calendar-google", "calendar-outlook"]);
      const { env } = countingEnv(db, { OAUTH_KV: kv });
      const ics = icsWithUpcomingEvents(24);
      // calendar-google's feed is broken; calendar-outlook's is fine.
      vi.stubGlobal("fetch", vi.fn(async (url: any) => {
        if (String(url).includes("calendar-google")) throw new Error("401 Unauthorized");
        return { ok: true, status: 200, text: async () => ics } as any;
      }));

      const tick = hourlyClock();
      for (let run = 0; run < 4; run++) {
        tick(run);
        resetDatabaseInit();
        await runCron(env, INTEGRATION_SYNC_CRON);
      }

      const failing = await savedIntegration(kv, db, "calendar-google");
      expect(failing.status).toBe("error");
      // The working provider kept getting turns rather than being locked out —
      // four runs, so two of them were its.
      expect(db.entries.filter(e => e.source === "calendar-outlook"))
        .toHaveLength(2 * SYNC_EVENT_BATCH);
    });

    // The case above is an error the provider's own handler catches, so the
    // provider persists updatedAt itself. This is the one where it does not:
    // a throw escaping the handler is swallowed by job() in src/index.ts, and
    // nothing about the record was written. If the rotation trusted providers to
    // advance their own cursor, this provider would be re-selected every run
    // forever — and, because its item map did not persist either, would re-mirror
    // the same batch under fresh ids each time.
    it("advances past a provider whose sync throws past its own handler", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 24, ["calendar-google", "calendar-outlook"]);
      const { env } = countingEnv(db, { OAUTH_KV: kv });
      vi.spyOn(INTEGRATION_PROVIDERS["calendar-google"], "sync")
        .mockRejectedValue(new Error("KV write failed inside saveIntegration"));

      const tick = hourlyClock();
      for (let run = 0; run < 4; run++) {
        tick(run);
        resetDatabaseInit();
        await runCron(env, INTEGRATION_SYNC_CRON);
      }

      // Two of the four runs went to the provider that works.
      expect(db.entries.filter(e => e.source === "calendar-outlook"))
        .toHaveLength(2 * SYNC_EVENT_BATCH);
      // And the thrower never mirrored anything, so there are no duplicate
      // re-creations to find.
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(0);
    });
  });

  // ─── Routing (#290) ────────────────────────────────────────────────────────
  // The split only buys anything if scheduled() actually branches. A handler
  // that ignored event.cron would run every job on BOTH triggers, which is
  // strictly worse than before: the same shared cost, now paid hourly.

  describe("cron routing", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("does not run the mirror sync on the maintenance schedule", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 24);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, MAINTENANCE_CRON);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(0);
    });

    it("does not run the maintenance jobs on the integration schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const kv = makeMemoryKV();
      await connectCalendar(kv, 1);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      // The staleness pass is the cheapest maintenance job to detect: on the
      // maintenance schedule this same entry comes back tagged.
      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).not.toContain("stale:as-of");
    });

    it("uses upstream combined maintenance for an unrecognised schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const { env } = countingEnv(db);

      await runCron(env, "*/5 * * * *");

      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).toContain("stale:as-of");
    });

    // The insight passes get the same treatment as the mirror sync above: each
    // is its own budget (#290's argument extended to insight accrual/#296's
    // reasoning pass), so scheduled() has to name them explicitly. A handler
    // that let either fall through would run the maintenance suite a second
    // (or third) time on top of whatever the insight job itself did — the
    // exact multiplier the split exists to avoid, now happening daily and
    // weekly instead of hourly.

    it("does not run the maintenance jobs on the insight accrual schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const kv = makeMemoryKV();
      const kvGet = vi.spyOn(kv, "get");
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INSIGHT_ACCRUAL_CRON);

      // The staleness pass is the cheapest maintenance job to detect: on the
      // maintenance schedule this same entry comes back tagged.
      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).not.toContain("stale:as-of");
      // And accrual's own job did run: it is the very first thing
      // runInsightAccrual does, so this is what tells "routed nowhere" (the
      // bug this test exists to catch) apart from "routed correctly to a job
      // that found nothing to accrue."
      expect(kvGet).toHaveBeenCalledWith(ACCRUAL_CURSOR_KEY);
    });

    it("does not run the maintenance jobs on the insight weekly schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const { env, prepared } = countingEnv(db);

      await runCron(env, INSIGHT_WEEKLY_CRON);

      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).not.toContain("stale:as-of");
      // And the weekly pass's own job did run: its candidate-queue read is
      // the first D1 statement it issues, so its presence is what tells
      // "routed nowhere" apart from "routed correctly to a job with nothing
      // pending."
      expect(prepared.some(s => s.includes("FROM insight_candidates"))).toBe(true);
    });

    // The Team pass's dedicated upstream trigger (spec 4.5). Its gating,
    // its solo-brain behaviour and
    // what it writes are covered end to end in
    // test/integration/team-insight-schedule.test.ts; what belongs HERE is the
    // same fact this describe asserts about the other four — that the cron is
    // routed at all, and that routing it did not also re-run maintenance.
    // Every scheduled branch needs a case in both places.
    it("does not run the maintenance jobs on the team insight schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const kv = makeMemoryKV();
      // The branch is off by default, and an off branch returns before it
      // touches D1 — which would leave "routed nowhere" and "routed correctly"
      // indistinguishable here. On, the company-workspace read is its first
      // statement and therefore the positive signal.
      await kv.put(CONFIG_KEY, JSON.stringify({ TEAM_INSIGHTS: "on" }));
      const { env, prepared } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INSIGHT_TEAM_WEEKLY_CRON, TEAM_INSIGHT_SLOT);

      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).not.toContain("stale:as-of");
      expect(prepared.some(s => s.includes("FROM workspaces WHERE kind = 'company'"))).toBe(true);
    });
  });
});
