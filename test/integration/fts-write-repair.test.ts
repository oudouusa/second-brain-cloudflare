/**
 * BLOCKER (E2E run 1): the entries_fts sync triggers fire on every write to
 * `entries`, so a missing or broken entries_fts took down capture, MCP
 * remember/append/update/forget, the dashboard, integration mirroring and
 * import with a 500. Real SQLite (not the D1Mock, which cannot evaluate
 * triggers) so a dropped or reshaped entries_fts genuinely fails the way it
 * does against D1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { makeMirrorStore } from "../../src/integrations/mirror";
import { importExportPayload } from "../../src/entries/import";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { withFtsWriteGuard } from "../../src/db/fts-write-guard";
import { setDbReady } from "../../src/runtime/state";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import { FTS_BACKFILL_BATCH, FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../../src/constants";
import { OWNER_WRITE_CONTEXT } from "../../src/lib/scope";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";
import type { RecallDiagnostics } from "../../src/recall/types";

/** A cron string that is not one of the special schedules — routes to the nightly maintenance branch. */
const MAINTENANCE_CRON = "0 1 * * *";

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

/** entries_fts missing entirely: triggers still reference a table that is gone. */
async function breakByDroppingTable(d1: SqliteD1): Promise<void> {
  await d1.db.exec(`DROP TABLE entries_fts`);
}

/**
 * entries_fts "exists" (sqlite_master reports a table by that name) but is the
 * wrong shape — reproduces the write failing while the corruption check
 * (isFtsFailure) sees a genuine SQLite error naming entries_fts, not a
 * missing-table error. FTS5's own shadow tables (entries_fts_data/_idx/
 * _docsize/_config/_content) refuse direct DML and DROP outright ("table
 * entries_fts_data may not be modified/dropped") even under
 * PRAGMA writable_schema, so they cannot be corrupted directly in node:sqlite.
 * Replacing entries_fts with an ordinary table of the wrong shape is what
 * actually reproduces a live "table exists but is broken" write failure:
 * `INSERT INTO entries_fts (rowid, id, content) ...` then fails with
 * "table entries_fts has no column named id".
 */
// Seeds one leftover row so a repair that (wrongly) dropped and recreated
// the table would be caught: v2 must never destroy it.
async function breakByReshaping(d1: SqliteD1): Promise<void> {
  await d1.db.exec(`DROP TABLE entries_fts`);
  await d1.db.exec(`CREATE TABLE entries_fts (wrong_col TEXT)`);
  await d1.db.exec(`INSERT INTO entries_fts (wrong_col) VALUES ('leftover')`);
}

async function ftsObjectNames(d1: SqliteD1): Promise<string[]> {
  const { results } = await d1.db.prepare(
    `SELECT name FROM sqlite_master WHERE name IN ('entries_fts','entries_fts_insert','entries_fts_update','entries_fts_delete')`,
  ).all() as { results: { name: string }[] };
  return results.map(r => r.name).sort();
}

async function triggerNames(d1: SqliteD1): Promise<string[]> {
  const { results } = await d1.db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('entries_fts_insert','entries_fts_update','entries_fts_delete')`,
  ).all() as { results: { name: string }[] };
  return results.map(r => r.name).sort();
}

const ALL_FTS_OBJECTS = ["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"];

/** Missing-table outcome (v2 branch 2): table and triggers created fresh. */
async function expectTableAndTriggersCreated(d1: SqliteD1, env: Env): Promise<void> {
  expect(await ftsObjectNames(d1)).toEqual(ALL_FTS_OBJECTS);
  expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
  expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
}

/**
 * Corrupt/wrong-shape outcome (v2.2): only the triggers are dropped. No DDL
 * ever touches the table itself, so its prior (even wrong-shaped) rows
 * survive under the SAME name — proof that nothing here is destructive.
 * Recall's own liveness check (src/recall/fts.ts), not this repair, is what
 * then reads the table as not live.
 */
async function expectTriggersDroppedTableIntact(d1: SqliteD1, env: Env): Promise<void> {
  expect(await triggerNames(d1)).toEqual([]);
  const leftover = await d1.db.prepare(`SELECT wrong_col FROM entries_fts`).all() as { results: { wrong_col: string }[] };
  expect(leftover.results).toEqual([{ wrong_col: "leftover" }]);
  expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
}

/**
 * Builds a real-schema env and fully migrates + tenant-bootstraps it while
 * entries_fts is still intact, THEN seeds the ready-flag/cursor state the
 * assertions check. Both steps matter for isolating the write-guard under
 * test from unrelated background repair paths that would otherwise also fix
 * entries_fts (or fail for unrelated reasons) before the test gets to it:
 *
 * - schema.sql's base `entries` table lacks the ALTER-only columns (e.g.
 *   updated_at) that append/update/import read and write, so
 *   initializeDatabase must run once, before the table is broken.
 * - Identity resolution runs ensureTenantBootstrap on first use, which
 *   issues its own multi-statement batch touching `entries` — running it here
 *   (through the SAME write guard instance worker.fetch will reuse, since
 *   withFtsWriteGuard memoizes per raw DB) means the real request under test
 *   hits its memo and never repeats that batch while entries_fts is broken.
 */
async function bootstrapSchema(env: Env): Promise<Env> {
  resetDatabaseInit();
  await initializeDatabase(env);
  const guarded = withFtsWriteGuard(env);
  await ensureTenantBootstrap(guarded);
  return guarded;
}

async function makeEnv(d1: SqliteD1): Promise<Env> {
  const kv = makeMemoryKV();
  const env = makeTestEnv(undefined, {
    DB: d1.db as unknown as D1Database,
    OAUTH_KV: kv,
    VECTORIZE: makeVectorizeMock(),
    AI: makeAIMock(),
  });
  await bootstrapSchema(env);
  // Pre-seeded as if the backfill had already completed, so a passing test
  // proves the repair actually reset them rather than finding them already blank.
  await kv.put(FTS_READY_KV_KEY, "1");
  await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");
  return env;
}

describe("a write to entries repairs a missing or broken entries_fts and retries once", () => {
  let d1: SqliteD1;

  beforeEach(() => {
    // Isolate this suite from the unrelated cold-start migration path
    // (ensureDbReady/initializeDatabase): it probes and repairs schema too,
    // in the background, on any request — which would mask the failure this
    // suite exists to reproduce and fix through the write-path guard instead.
    setDbReady(true);
    resetFtsReadyMemo();
  });
  afterEach(() => { d1?.close(); setDbReady(false); });

  describe("missing table", () => {
    it("capture (POST /capture) persists exactly once", async () => {
      d1 = makeSqliteD1();
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/capture", { body: { content: "hello dashboard world" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].content).toBe("hello dashboard world");
      await expectTableAndTriggersCreated(d1, env);
    });

    it("append (POST /append) persists exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "original content", createdAt: 1000 });
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "more detail" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].content).toContain("more detail");
      await expectTableAndTriggersCreated(d1, env);
    });

    it("update (POST /update) persists exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "stale content", createdAt: 1000 });
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: "fresh content" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      expect((await d1.db.prepare("SELECT * FROM entry_versions WHERE entry_id = 'e1'").all()).results).toHaveLength(1);
      expect(d1.rows().find(row => row.id === "e1")?.content).toBe("fresh content");
      await expectTableAndTriggersCreated(d1, env);
    });

    it("forget (POST /forget) deletes exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "to be forgotten", createdAt: 1000 });
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/forget", { body: { id: "e1" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(0);
      await expectTableAndTriggersCreated(d1, env);
    });

    // makeMirrorStore/importExportPayload are called directly rather than
    // through worker.fetch, so they must be handed the SAME guarded env a real
    // request would receive (production reaches them only from inside
    // src/index.ts's fetch/scheduled handlers, both wrapped at the entry
    // point). withFtsWriteGuard is memoized per raw DB, so calling it again
    // here returns the exact instance bootstrapSchema already warmed.
    it("integration mirror create persists exactly once", async () => {
      d1 = makeSqliteD1();
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);

      const id = await makeMirrorStore(d1.admitEnv(withFtsWriteGuard(env))).createEntry("mirrored content", ["source:calendar"], "calendar-google");

      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].id).toBe(id);
      await expectTableAndTriggersCreated(d1, env);
    });

    it("integration mirror update persists exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "mirrored original", createdAt: 1000, source: "calendar-google" });
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);

      const ok = await makeMirrorStore(d1.admitEnv(withFtsWriteGuard(env))).updateEntry("e1", "mirrored updated");

      expect(ok).toBe("updated");
      expect(d1.rows()).toHaveLength(1);
      expect(d1.rows()[0].content).toBe("mirrored updated");
      await expectTableAndTriggersCreated(d1, env);
    });

    it("import persists exactly once per entry", async () => {
      d1 = makeSqliteD1();
      const env = await makeEnv(d1);
      await breakByDroppingTable(d1);

      const summary = await importExportPayload(d1.admitEnv(withFtsWriteGuard(env)), {
        entries: [{ id: "imported-1", content: "imported content", tags: [], source: "api", created_at: 1000 }],
      }, { writeCtx: OWNER_WRITE_CONTEXT });

      expect(summary.imported).toBe(1);
      expect(summary.failed).toBe(0);
      expect(d1.rows()).toHaveLength(1);
      await expectTableAndTriggersCreated(d1, env);
    });
  });

  // The corrupted-existing-table branch of repairFtsIndex (drop then recreate)
  // only runs on this shape; the missing-table suite above exercises the
  // create-when-absent branch of the same, now-unified, repair path.
  describe("broken (wrong-shaped) table", () => {
    it("capture (POST /capture) persists exactly once", async () => {
      d1 = makeSqliteD1();
      const env = await makeEnv(d1);
      await breakByReshaping(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/capture", { body: { content: "hello again" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      await expectTriggersDroppedTableIntact(d1, env);
    });

    // forget's DELETE trigger body only references `rowid` (valid on any
    // ordinary rowid table), so a reshaped-but-still-rowid-bearing entries_fts
    // does not fail a delete the way it fails insert/update, which name `id`
    // and `content`. The missing-table describe block above already covers
    // forget against the other corruption shape.
    it("update (POST /update) persists exactly once", async () => {
      d1 = makeSqliteD1();
      d1.seed({ id: "e1", content: "stale content", createdAt: 1000 });
      const env = await makeEnv(d1);
      await breakByReshaping(d1);
      const { ctx, drain } = makeCtx();

      const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: "fresh content" } }), env, ctx);
      await drain();

      expect(res.status).toBe(200);
      expect(d1.rows()).toHaveLength(1);
      expect((await d1.db.prepare("SELECT * FROM entry_versions WHERE entry_id = 'e1'").all()).results).toHaveLength(1);
      expect(d1.rows().find(row => row.id === "e1")?.content).toBe("fresh content");
      await expectTriggersDroppedTableIntact(d1, env);
    });
  });
});

// T-0065: entry_counts' triggers fire inside the SAME guarded entries
// statement as entries_fts's. A manually dropped table is the smallest
// realistic failure — mirrors the entries_fts "missing table" shape above,
// through the same guard/retry (src/db/fts-write-guard.ts,
// src/db/entry-counts-repair.ts).
describe("a write to entries repairs a manually dropped entry_counts and retries once", () => {
  let d1: SqliteD1;

  beforeEach(() => {
    setDbReady(true);
    resetFtsReadyMemo();
  });
  afterEach(() => { d1?.close(); setDbReady(false); });

  it("capture (POST /capture) persists exactly once and entry_counts is recreated with an exact reseed", async () => {
    d1 = makeSqliteD1();
    d1.seed({ id: "e1", content: "already there", createdAt: 1000 });
    const env = await makeEnv(d1);
    // Dropping ONLY the table (not its triggers, which are defined ON
    // entries and survive) is what reproduces "the trigger body references a
    // table that is now gone" — the same shape as entries_fts's own
    // breakByDroppingTable above.
    await d1.db.exec(`DROP TABLE entry_counts`);
    const { ctx, drain } = makeCtx();

    const res = await worker.fetch(req("POST", "/capture", { body: { content: "hello dashboard world" } }), env, ctx);
    await drain();

    expect(res.status).toBe(200);
    expect(d1.rows()).toHaveLength(2);
    const { results } = await d1.db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'entry_counts%'`).all() as { results: { name: string }[] };
    expect(results.map(r => r.name).sort()).toEqual(["entry_counts", "entry_counts_delete", "entry_counts_insert", "entry_counts_update"]);
    // Reseeded from a fresh GROUP BY — e1 (which predates the drop) is
    // counted too, not just the entry that triggered the repair.
    const total = await d1.db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM entry_counts`).first() as { n: number };
    expect(total.n).toBe(2);
  });

  it("forget (POST /forget) deletes exactly once through the same repair", async () => {
    d1 = makeSqliteD1();
    d1.seed({ id: "e1", content: "to be forgotten", createdAt: 1000 });
    const env = await makeEnv(d1);
    // Dropping ONLY the table (not its triggers, which are defined ON
    // entries and survive) is what reproduces "the trigger body references a
    // table that is now gone" — the same shape as entries_fts's own
    // breakByDroppingTable above.
    await d1.db.exec(`DROP TABLE entry_counts`);
    const { ctx, drain } = makeCtx();

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "e1" } }), env, ctx);
    await drain();

    expect(res.status).toBe(200);
    expect(d1.rows()).toHaveLength(0);
    const total = await d1.db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM entry_counts`).first() as { n: number };
    expect(total.n).toBe(0); // repaired before the delete's trigger could run against it
  });
});

// S3 (adversarial review of e32a2b0): the guard was wired into fetch() but
// never proven to run from scheduled() — the whole suite passed even with
// it removed there. This drives a real nightly job (staleness, the simplest
// pass to seed) through the actual scheduled() entry point, with the
// UNWRAPPED env, so the assertion only holds if scheduled() applies the
// guard itself.
describe("scheduled() repairs entries_fts for nightly writes (S3)", () => {
  let d1: SqliteD1;

  beforeEach(() => {
    setDbReady(true);
    resetFtsReadyMemo();
  });
  afterEach(() => { d1?.close(); setDbReady(false); });

  it("夜間writeは一度だけ確定し、次回までにFTS修復を完了する", async () => {
    d1 = makeSqliteD1();
    const rawEnv = makeTestEnv(undefined, {
      DB: d1.db as unknown as D1Database,
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock(),
      AI: makeAIMock(),
    });
    // Deliberately NOT bootstrapSchema(): that helper calls withFtsWriteGuard
    // itself to warm tenancy's memo, which would patch rawEnv.DB before
    // scheduled() ever runs (the guard patches in place, so the patch would
    // already be there regardless of what scheduled() does) — defeating the
    // point of this test, which is to prove scheduled() applies the guard
    // ITSELF. Only the schema migration is needed for staleness to have the
    // columns it writes; nextWorkspace tolerates an un-bootstrapped brain
    // (a null slice, whole-corpus scan).
    resetDatabaseInit();
    await initializeDatabase(rawEnv);
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    d1.seed({ id: "stale-1", content: "an old memory nobody revisited", createdAt: old });
    await breakByDroppingTable(d1);
    const { ctx, drain } = makeCtx();

    await worker.scheduled({ cron: MAINTENANCE_CRON } as ScheduledEvent, rawEnv, ctx);
    await drain();

    const row = d1.rows().find(r => r.id === "stale-1");
    expect(row).toBeDefined();
    expect(row!.staleness_checked_at).not.toBeNull();
    // Repair rebuilt the index (guard applied in scheduled()) — the missing
    // table branch, not the disabled-marker one, so the table and triggers
    // come back under their own names — then the nightly's own backfill
    // pass recovered from the cursor reset: every entry indexed exactly
    // once and the ready flag latched.
    expect(await ftsObjectNames(d1)).toEqual(ALL_FTS_OBJECTS);
    for (let retry = 0; retry < 3 && await rawEnv.OAUTH_KV.get(FTS_READY_KV_KEY) !== "1"; retry++) {
      await worker.scheduled({ cron: MAINTENANCE_CRON, scheduledTime: Date.now() + (retry + 1) * 86400000 } as ScheduledEvent, rawEnv, ctx);
      await drain();
    }
    expect(await rawEnv.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
    expect(((await d1.db.prepare(`SELECT count(*) AS n FROM entries_fts`).first()) as { n: number }).n)
      .toBe(((await d1.db.prepare(`SELECT count(*) AS n FROM entries`).first()) as { n: number }).n);
  });

  // Task 5: when the SAME nightly write instead hits the corruption-shaped
  // (not missing-table) branch, the write-path repair only drops the FTS
  // triggers (v2.2), leaving entries_fts not live. runFtsMaintenance now runs
  // later in this SAME scheduled() invocation and, regardless of the ready
  // flag, treats "not live" as broken: it rebuilds the table and triggers
  // (the only destructive path, confined to the nightly job) and the
  // backfill starts immediately after — so the outage does not compound into
  // a second night of waiting.
  it("夜間writeで無効化された索引を有限回の保守で再構築する", async () => {
    d1 = makeSqliteD1();
    const rawEnv = makeTestEnv(undefined, {
      DB: d1.db as unknown as D1Database,
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock(),
      AI: makeAIMock(),
    });
    resetDatabaseInit();
    await initializeDatabase(rawEnv);
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    d1.seed({ id: "stale-1", content: "an old memory nobody revisited", createdAt: old });
    await breakByReshaping(d1);
    const { ctx, drain } = makeCtx();

    await worker.scheduled({ cron: MAINTENANCE_CRON } as ScheduledEvent, rawEnv, ctx);
    await drain();

    const row = d1.rows().find(r => r.id === "stale-1");
    expect(row).toBeDefined();
    expect(row!.staleness_checked_at).not.toBeNull(); // the staleness write itself still succeeded
    // The nightly rebuild recreated the table and triggers under their own
    // names, and the backfill that ran right after latched ready.
    expect(await ftsObjectNames(d1)).toEqual(ALL_FTS_OBJECTS);
    for (let retry = 0; retry < 3 && await rawEnv.OAUTH_KV.get(FTS_READY_KV_KEY) !== "1"; retry++) {
      await worker.scheduled({ cron: MAINTENANCE_CRON, scheduledTime: Date.now() + (retry + 1) * 86400000 } as ScheduledEvent, rawEnv, ctx);
      await drain();
    }
    expect(await rawEnv.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
  });
});

// Task 5, end to end: a corrupted index heals across nights through the real
// worker.scheduled() entry point, and recall serves complete results from it
// once healed — not just that the DDL comes back (S3 above), but that every
// row the corruption-era backlog covers actually lands in the index.
describe("a corrupted index heals across nights (Task 5 end to end)", () => {
  let d1: SqliteD1;

  beforeEach(() => {
    setDbReady(true);
    resetFtsReadyMemo();
  });
  afterEach(() => { d1?.close(); setDbReady(false); });

  it("night 1 rebuilds and starts the backfill; night 2 latches ready; recall then finds a row from the second night's batch via FTS", async () => {
    d1 = makeSqliteD1();
    const rawEnv = makeTestEnv(undefined, {
      DB: d1.db as unknown as D1Database,
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("dense down")) }),
      AI: makeAIMock(),
    });
    resetDatabaseInit();
    await initializeDatabase(rawEnv);
    // More than one backfill batch, so night 1 cannot finish it in one pass —
    // the marker entry lands in the tail that only night 2's batch reaches.
    const total = FTS_BACKFILL_BATCH + 3;
    for (let i = 1; i <= total; i++) {
      d1.seed({ id: `e${i}`, content: `memory number ${i} about dashboards`, createdAt: i });
    }
    d1.seed({ id: "tail-marker", content: "a rare zzzqqxviii marker in the final batch", createdAt: total + 1 });
    await breakByDroppingTable(d1); // triggers still reference a table that is now gone: not live

    const { ctx: ctx1, drain: drain1 } = makeCtx();
    await worker.scheduled({ cron: MAINTENANCE_CRON } as ScheduledEvent, rawEnv, ctx1);
    await drain1();

    // Night 1: rebuilt (table and triggers back), backfill started but did
    // not finish — one full batch is not the whole corpus.
    expect(await ftsObjectNames(d1)).toEqual(ALL_FTS_OBJECTS);
    expect(await rawEnv.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    const midCount = await d1.db.prepare(`SELECT count(*) AS n FROM entries_fts`).first() as { n: number };
    expect(midCount.n).toBe(FTS_BACKFILL_BATCH);

    resetDatabaseInit(); // a fresh cold-start probe, as a new night's isolate would run
    const { ctx: ctx2, drain: drain2 } = makeCtx();
    await worker.scheduled({ cron: MAINTENANCE_CRON } as ScheduledEvent, rawEnv, ctx2);
    await drain2();

    // Night 2: the remaining tail is indexed and ready latches.
    for (let retry = 0; retry < 3 && await rawEnv.OAUTH_KV.get(FTS_READY_KV_KEY) !== "1"; retry++) {
      await worker.scheduled({ cron: MAINTENANCE_CRON, scheduledTime: Date.now() + (retry + 1) * 86400000 } as ScheduledEvent, rawEnv, ctx2);
      await drain2();
    }
    expect(await rawEnv.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
    const finalCount = await d1.db.prepare(`SELECT count(*) AS n FROM entries_fts`).first() as { n: number };
    expect(finalCount.n).toBe(total + 1);

    const diagnostics: RecallDiagnostics = {};
    const recallCtx = { waitUntil: () => {} } as unknown as ExecutionContext;
    const result = await recallEntries(
      { query: "zzzqqxviii", topK: 5, synthesize: false }, rawEnv, recallCtx, undefined, { diagnostics },
    );

    expect(diagnostics.ftsUsed).toBe(true);
    expect(result.matches.map(m => m.id)).toContain("tail-marker");
  });
});

// B1 (v2 adversarial review of b4bb804): with KV down, a corrupt write's
// repair only dropped triggers — the table (still named entries_fts) stayed
// queryable and, since KV could not clear ready, kept being served as ready
// indefinitely, silently losing every write from then on. v2.2's fix has no
// KV dependence either, but does not need a rename to get it: recall's own
// liveness check (src/recall/fts.ts) queries sqlite_master directly on every
// keyword search, so a trigger-less table reads as not live regardless of
// what KV says or whether the table kept its own name.
describe("B1: corrupt write + KV down — recall falls back to LIKE, no stale index served", () => {
  let d1: SqliteD1;

  beforeEach(() => {
    setDbReady(true);
    resetFtsReadyMemo();
  });
  afterEach(() => { d1?.close(); setDbReady(false); });

  it("after the corrupt write, recall finds the new row via LIKE and entries_fts keeps the old rows intact", async () => {
    d1 = makeSqliteD1();
    const kv = makeMemoryKV();
    await kv.put(FTS_READY_KV_KEY, "1");
    await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");
    const env = makeTestEnv(undefined, {
      DB: d1.db as unknown as D1Database,
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("dense down")) }),
      AI: makeAIMock(),
    });
    resetDatabaseInit();
    await initializeDatabase(env);
    d1.seed({ id: "old", content: "old searchable", createdAt: 1 });

    // A real SQLite write failure with the corruption shape (not missing-table).
    await d1.db.exec("DROP TRIGGER entries_fts_insert");
    await d1.db.exec("CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN SELECT RAISE(ABORT, 'fts5: corrupt'); END");
    // KV goes down only AFTER the schema migration above (which itself uses KV).
    const brokenKv = {
      get: kv.get.bind(kv),
      put: async () => { throw new Error("KV down"); },
      delete: async () => { throw new Error("KV down"); },
    } as unknown as KVNamespace;
    env.OAUTH_KV = brokenKv;

    await withFtsWriteGuard(env).DB.prepare(
      "INSERT INTO entries (id,content,tags,source,created_at) VALUES ('new','new searchable','[]','api',1)",
    ).run();

    const diagnostics: RecallDiagnostics = {};
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
    const result = await recallEntries({ query: "searchable", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(false);
    expect(result.matches.map(m => m.id)).toContain("new");
    expect(d1.rows().map(r => r.id).sort()).toEqual(["new", "old"]);
    // The table itself was never touched — only its triggers were dropped —
    // so the pre-corruption row survives under entries_fts's own name.
    const ftsRows = (await d1.db.prepare("SELECT id FROM entries_fts").all() as { results: { id: string }[] }).results;
    expect(ftsRows.map(r => r.id)).toEqual(["old"]);
  });
});

// Combined review of Tasks 4-6 (FIX 2): same-row content drift keeps count
// parity true and can hide from the newest-5 spot check forever — the
// reviewer's DRIFT_SURVIVES probe showed two scheduled() nights leaving a
// tampered FTS row untouched. The rotating content check is what closes it:
// every night compares a window of FTS_CONTENT_CHECK_WINDOW rowids both ways
// and re-indexes mismatches in place, so every row is covered within
// ceil(N/window) nights.
describe("same-row content drift heals within ceil(N/window) nights (FIX 2 end to end)", () => {
  let d1: SqliteD1;

  beforeEach(() => {
    setDbReady(true);
    resetFtsReadyMemo();
  });
  afterEach(() => { d1?.close(); setDbReady(false); });

  it("a tampered same-row content heals on its window night through worker.scheduled()", async () => {
    d1 = makeSqliteD1();
    const rawEnv = makeTestEnv(undefined, {
      DB: d1.db as unknown as D1Database,
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("dense down")) }),
      AI: makeAIMock(),
    });
    resetDatabaseInit();
    await initializeDatabase(rawEnv);
    // Seven entries: one window covers all of them, so ceil(7/200) = 1 night.
    for (let i = 1; i <= 7; i++) d1.seed({ id: `e${i}`, content: `fresh violet ${i}`, createdAt: Date.now() + i });
    await rawEnv.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    await d1.db.prepare(
      `UPDATE entries_fts SET content = 'stale orchid payload' WHERE rowid = (SELECT rowid FROM entries WHERE id = 'e1')`,
    ).run();

    const { ctx, drain } = makeCtx();
    await worker.scheduled({ cron: MAINTENANCE_CRON } as ScheduledEvent, rawEnv, ctx);
    await drain();

    const shadowOf = (id: string) => (d1.db.prepare(
      `SELECT content FROM entries_fts WHERE rowid = (SELECT rowid FROM entries WHERE id = ?)`,
    ).bind(id).first() as Promise<{ content: string } | null>);
    expect((await shadowOf("e1"))?.content).toBe("fresh violet 1"); // healed the same night
    expect((await shadowOf("e2"))?.content).toBe("fresh violet 2"); // neighbors untouched
    for (let retry = 0; retry < 3 && await rawEnv.OAUTH_KV.get(FTS_READY_KV_KEY) !== "1"; retry++) {
      await worker.scheduled({ cron: MAINTENANCE_CRON, scheduledTime: Date.now() + (retry + 1) * 86400000 } as ScheduledEvent, rawEnv, ctx);
      await drain();
    }
    expect(await rawEnv.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1"); // healed in place, no backfill reset
  });
});
