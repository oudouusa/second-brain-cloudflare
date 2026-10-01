import { describe, it, expect, vi, beforeEach } from "vitest";
import { withFtsWriteGuard } from "../../src/db/fts-write-guard";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";

vi.mock("../../src/db/fts-repair", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/fts-repair")>();
  return { ...actual, repairFtsIndex: vi.fn().mockResolvedValue(undefined) };
});
import { repairFtsIndex } from "../../src/db/fts-repair";

// FIX 3 (final review): retryOnce now probes the OTHER dependency (the one
// the caught error does not identify) before its single retry. Mocked the
// same way as repairFtsIndex above, defaulting to "healthy" so every
// pre-existing single-dependency test below is unaffected — the probe for
// the dependency that did not fail returns live, so no second repair fires.
vi.mock("../../src/db/entry-counts-repair", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/entry-counts-repair")>();
  return { ...actual, repairEntryCounts: vi.fn().mockResolvedValue(undefined), isEntryCountsLive: vi.fn().mockResolvedValue(true) };
});
import { repairEntryCounts, isEntryCountsLive } from "../../src/db/entry-counts-repair";
vi.mock("../../src/recall/fts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/recall/fts")>();
  return { ...actual, isFtsLive: vi.fn().mockResolvedValue(true) };
});
import { isFtsLive } from "../../src/recall/fts";

const FTS_ERROR = "D1_ERROR: no such table: entries_fts: SQLITE_ERROR";
const ENTRY_COUNTS_ERROR = "D1_ERROR: no such table: entry_counts: SQLITE_ERROR";
const OTHER_ERROR = "UNIQUE constraint failed: users.email";

/** A minimal D1-shaped fake whose statement/batch calls fail `failTimes` times, then succeed. */
function makeFakeDB(failTimes: number, message = FTS_ERROR) {
  let runCalls = 0;
  let batchCalls = 0;
  const statement = {
    bind: (..._args: unknown[]) => statement,
    run: async () => {
      runCalls++;
      if (runCalls <= failTimes) throw new Error(message);
      return { success: true, meta: { rows_written: 1 } };
    },
  };
  const db = {
    prepare: (_sql: string) => statement,
    batch: async (statements: unknown[]) => {
      batchCalls++;
      if (batchCalls <= failTimes) throw new Error(message);
      return statements.map(() => ({ success: true, meta: { rows_written: 1 } }));
    },
  } as unknown as D1Database;
  return { db, runCalls: () => runCalls, batchCalls: () => batchCalls };
}

function makeEnv(db: D1Database): Env {
  return { DB: db, OAUTH_KV: {} as KVNamespace } as Env;
}

describe("withFtsWriteGuard", () => {
  beforeEach(() => {
    vi.mocked(repairFtsIndex).mockReset();
    vi.mocked(repairFtsIndex).mockResolvedValue(undefined);
    vi.mocked(repairEntryCounts).mockReset();
    vi.mocked(repairEntryCounts).mockResolvedValue(undefined);
    vi.mocked(isEntryCountsLive).mockReset();
    vi.mocked(isEntryCountsLive).mockResolvedValue(true);
    vi.mocked(isFtsLive).mockReset();
    vi.mocked(isFtsLive).mockResolvedValue(true);
  });

  it("passes a successful statement through untouched: no repair, one call", async () => {
    const { db, runCalls } = makeFakeDB(0);
    const env = withFtsWriteGuard(makeEnv(db));

    const result = await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(result).toEqual({ success: true, meta: { rows_written: 1 } });
    expect(runCalls()).toBe(1);
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  it("repairs once and retries when a statement fails with an entries_fts error", async () => {
    const { db, runCalls } = makeFakeDB(1);
    const env = withFtsWriteGuard(makeEnv(db));

    const result = await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(result).toEqual({ success: true, meta: { rows_written: 1 } });
    expect(runCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
    // The triggering error is handed to repairFtsIndex, which needs it to
    // distinguish missing-table from every other case (v2 spec).
    expect(vi.mocked(repairFtsIndex).mock.calls[0][1]).toBeInstanceOf(Error);
    expect((vi.mocked(repairFtsIndex).mock.calls[0][1] as Error).message).toBe(FTS_ERROR);
  });

  it("retries exactly once and then throws, without looping, when repair cannot fix it", async () => {
    const { db, runCalls } = makeFakeDB(Number.POSITIVE_INFINITY);
    const env = withFtsWriteGuard(makeEnv(db));

    await expect(env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run())
      .rejects.toThrow(FTS_ERROR);
    expect(runCalls()).toBe(2); // original attempt + exactly one retry, never more
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
  });

  it("does not repair or retry an unrelated error", async () => {
    const { db, runCalls } = makeFakeDB(Number.POSITIVE_INFINITY, OTHER_ERROR);
    const env = withFtsWriteGuard(makeEnv(db));

    await expect(env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run())
      .rejects.toThrow(OTHER_ERROR);
    expect(runCalls()).toBe(1);
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  it("repairs once and retries a failed batch() as a whole", async () => {
    const { db, batchCalls } = makeFakeDB(1);
    const env = withFtsWriteGuard(makeEnv(db));
    const stmt = env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1");

    const result = await env.DB.batch([stmt]);

    expect(result).toEqual([{ success: true, meta: { rows_written: 1 } }]);
    expect(batchCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
  });

  it("batch() retries exactly once and then throws when repair cannot fix it", async () => {
    const { db, batchCalls } = makeFakeDB(Number.POSITIVE_INFINITY);
    const env = withFtsWriteGuard(makeEnv(db));
    const stmt = env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1");

    await expect(env.DB.batch([stmt])).rejects.toThrow(FTS_ERROR);
    expect(batchCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
  });

  // FIX 3 (final review): the caught error identifies entries_fts; the
  // OTHER dependency (entry_counts) is probed and found healthy, so its
  // repair must not fire.
  it("does not touch entry_counts when only entries_fts is broken", async () => {
    const { db, runCalls } = makeFakeDB(1);
    const env = withFtsWriteGuard(makeEnv(db));

    const result = await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(result).toEqual({ success: true, meta: { rows_written: 1 } });
    expect(runCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
    expect(repairEntryCounts).not.toHaveBeenCalled();
  });

  // Mirror image: the caught error identifies entry_counts; entries_fts is
  // probed and found healthy, so repairFtsIndex must not fire.
  it("repairs entry_counts (not entries_fts) when only the counter table is missing", async () => {
    const { db, runCalls } = makeFakeDB(1, ENTRY_COUNTS_ERROR);
    const env = withFtsWriteGuard(makeEnv(db));

    const result = await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(result).toEqual({ success: true, meta: { rows_written: 1 } });
    expect(runCalls()).toBe(2);
    expect(repairEntryCounts).toHaveBeenCalledTimes(1);
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  // The reviewer's reproduction: with both entries_fts and entry_counts
  // missing, the entries_fts trigger fires first and its failure is the one
  // the write throws. The old code repaired only that one and retried once,
  // so the retry threw again on the still-missing entry_counts with nothing
  // left to catch it. Real SQLite end to end (unmocked repairs), because the
  // subject is whether both tables and all six triggers actually come back.
  it("repairs both entries_fts and entry_counts when both are missing, succeeding on the single retry", async () => {
    const actualFts = await vi.importActual<typeof import("../../src/db/fts-repair")>("../../src/db/fts-repair");
    vi.mocked(repairFtsIndex).mockImplementation(actualFts.repairFtsIndex);
    const actualEntryCounts = await vi.importActual<typeof import("../../src/db/entry-counts-repair")>("../../src/db/entry-counts-repair");
    vi.mocked(repairEntryCounts).mockImplementation(actualEntryCounts.repairEntryCounts);
    vi.mocked(isEntryCountsLive).mockImplementation(actualEntryCounts.isEntryCountsLive);
    const actualRecallFts = await vi.importActual<typeof import("../../src/recall/fts")>("../../src/recall/fts");
    vi.mocked(isFtsLive).mockImplementation(actualRecallFts.isFtsLive);
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TABLE entries_fts; DROP TABLE entry_counts;");
      const env = withFtsWriteGuard(makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() }));

      const result = await env.DB.prepare(
        "INSERT INTO entries (id,content,tags,source,created_at,vector_ids,workspace_id) VALUES ('e1','hello searchable','[]','api',1,'[]','ws-a')",
      ).run();

      expect(result.success).toBe(true);
      expect(s.rows().map(r => r.id)).toEqual(["e1"]);
      expect(await s.db.prepare(`SELECT id FROM entries_fts WHERE id = 'e1'`).first()).toEqual({ id: "e1" });
      expect(await s.db.prepare(`SELECT n FROM entry_counts WHERE workspace_id = 'ws-a'`).first()).toEqual({ n: 1 });
    } finally { s.close(); }
  });

  // Both repairs run (the probe says entry_counts also needs it), but the
  // underlying failure persists regardless — the single retry must still
  // throw rather than loop.
  it("retries exactly once and then throws when both dependencies need repair but the underlying failure persists", async () => {
    vi.mocked(isEntryCountsLive).mockResolvedValueOnce(false);
    const { db, runCalls } = makeFakeDB(Number.POSITIVE_INFINITY);
    const env = withFtsWriteGuard(makeEnv(db));

    await expect(env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run())
      .rejects.toThrow(FTS_ERROR);
    expect(runCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
    expect(repairEntryCounts).toHaveBeenCalledTimes(1);
  });

  it("reuses the same guarded DB for the same raw binding (tenancy-style memoization stays intact)", () => {
    const { db } = makeFakeDB(0);
    const rawEnv = makeEnv(db);

    const guardedA = withFtsWriteGuard(rawEnv).DB;
    const guardedB = withFtsWriteGuard(rawEnv).DB;

    expect(guardedA).toBe(guardedB);
  });

  // B1(a): only a statement that writes to `entries` is ever guarded. A read
  // — even one naming entries_fts, even one that throws something that
  // matches isFtsFailure — passes straight through, never retried, never
  // triggering a repair.
  it("does not guard a read, even one whose error would match isFtsFailure", async () => {
    const { db, runCalls } = makeFakeDB(Number.POSITIVE_INFINITY, "no such column: entries_fts.nonexistent");
    const env = withFtsWriteGuard(makeEnv(db));

    await expect(env.DB.prepare("SELECT entries_fts.nonexistent FROM entries_fts").bind().run())
      .rejects.toThrow("no such column: entries_fts.nonexistent");
    expect(runCalls()).toBe(1); // no retry, no repair
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  it("guards a batch only when some statement in it writes to entries", async () => {
    const { db, batchCalls } = makeFakeDB(Number.POSITIVE_INFINITY, "no such column: entries_fts.nonexistent");
    const env = withFtsWriteGuard(makeEnv(db));
    const stmt = env.DB.prepare("SELECT id FROM entries_fts").bind();

    await expect(env.DB.batch([stmt])).rejects.toThrow("no such column: entries_fts.nonexistent");
    expect(batchCalls()).toBe(1); // no retry, no repair — nothing in the batch writes to entries
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  // The reviewer's original reproduction (B1): a malformed read naming a
  // nonexistent entries_fts column dropped a healthy, indexed row. Real
  // SQLite, unmocked repairFtsIndex — a genuine end-to-end check that a read
  // error never reaches repair at all.
  it("a healthy index survives a malformed read naming an entries_fts column (B1 end-to-end)", async () => {
    const actual = await vi.importActual<typeof import("../../src/db/fts-repair")>("../../src/db/fts-repair");
    vi.mocked(repairFtsIndex).mockImplementation(actual.repairFtsIndex);
    const s = makeSqliteD1();
    try {
      s.seed({ id: "before", content: "searchable dashboard", createdAt: 1 });
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "100");
      const env = withFtsWriteGuard(makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: kv }));
      const before = await s.db.prepare("SELECT count(*) AS n FROM entries_fts").first() as { n: number };

      await expect(env.DB.prepare("SELECT entries_fts.nonexistent FROM entries_fts").all())
        .rejects.toThrow(/no such column/);

      const after = await s.db.prepare("SELECT count(*) AS n FROM entries_fts").first() as { n: number };
      expect(before.n).toBe(1);
      expect(after.n).toBe(1);
      expect(await kv.get(FTS_READY_KV_KEY)).toBe("1");
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("100");
    } finally { s.close(); }
  });

  // v2 removes the hot-path health probe entirely, so there is no longer an
  // "index was already healthy, don't retry" branch: repairFtsIndex always
  // performs an idempotent, non-destructive action when called, and the
  // guard always retries exactly once afterward.
  it("still retries exactly once even when repair had nothing destructive to undo", async () => {
    vi.mocked(repairFtsIndex).mockResolvedValueOnce(undefined);
    const { db, runCalls } = makeFakeDB(1);
    const env = withFtsWriteGuard(makeEnv(db));

    const result = await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(result).toEqual({ success: true, meta: { rows_written: 1 } });
    expect(runCalls()).toBe(2);
    expect(repairFtsIndex).toHaveBeenCalledTimes(1);
  });

  it("the no-failure path issues zero D1 statements to repairFtsIndex and zero KV operations", async () => {
    const kvCalls: string[] = [];
    const kv = {
      get: async () => { kvCalls.push("get"); return null; },
      put: async () => { kvCalls.push("put"); },
      delete: async () => { kvCalls.push("delete"); },
    } as unknown as KVNamespace;
    const { db } = makeFakeDB(0);
    const env = withFtsWriteGuard({ DB: db, OAUTH_KV: kv } as Env);

    await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind("e1").run();

    expect(kvCalls).toEqual([]);
    expect(repairFtsIndex).not.toHaveBeenCalled();
  });

  // v2: missing table + a totally failing KV still must not fail the write.
  // repairFtsIndex falls back to dropping the triggers (best-effort KV, no
  // table create), which is enough on its own to let the retried write
  // succeed — real SQLite end to end, unmocked repairFtsIndex.
  it("a write succeeds when the table is missing and KV fails outright (triggers dropped, no table created)", async () => {
    const actual = await vi.importActual<typeof import("../../src/db/fts-repair")>("../../src/db/fts-repair");
    vi.mocked(repairFtsIndex).mockImplementation(actual.repairFtsIndex);
    const s = makeSqliteD1();
    try {
      await s.db.exec("DROP TABLE entries_fts");
      const brokenKv = {
        get: async () => null,
        put: async () => { throw new Error("KV unavailable"); },
        delete: async () => { throw new Error("KV unavailable"); },
      } as unknown as KVNamespace;
      const env = withFtsWriteGuard(makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: brokenKv }));

      const result = await env.DB.prepare(
        "INSERT INTO entries (id,content,tags,source,created_at) VALUES ('e1','hello searchable','[]','api',1)",
      ).run();

      expect(result.success).toBe(true);
      expect(s.rows().map(r => r.id)).toEqual(["e1"]);
      const table = await s.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all() as { results: unknown[] };
      expect(table.results).toEqual([]); // never created — KV failed
      const triggers = await s.db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'entries_fts_%'`,
      ).all() as { results: unknown[] };
      expect(triggers.results).toEqual([]); // dropped
    } finally { s.close(); }
  });

  // Test 1 (v2.2 review, pre-rename-schema-snapshot adapted): a cold start's
  // own probe snapshot, taken BEFORE a hot-path repair drops a corrupt
  // trigger, could (pre-v2.2) later be used to recreate the trigger the
  // repair had just removed — a snapshot is only ever as fresh as the
  // moment it was taken. v2.2's fix is structural, not timing-dependent:
  // applySchema never creates or repairs an FTS trigger on an EXISTING
  // table at all, so a stale snapshot showing the trigger "still there" no
  // longer matters — there is no code path left that would act on it.
  it("a cold-start snapshot taken before a hot-path trigger drop does not re-arm it, and the retried write succeeds", async () => {
    const actual = await vi.importActual<typeof import("../../src/db/fts-repair")>("../../src/db/fts-repair");
    vi.mocked(repairFtsIndex).mockImplementation(actual.repairFtsIndex);
    const s = makeSqliteD1();
    try {
      const kv = makeMemoryKV();
      const coldEnv = makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: kv });
      resetDatabaseInit();
      await initializeDatabase(coldEnv);
      // A real SQLite write failure with the corruption shape (not
      // missing-table), so the hot path drops the triggers rather than
      // running the creation batch.
      await s.db.exec("DROP TRIGGER entries_fts_insert");
      await s.db.exec("CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN SELECT RAISE(ABORT, 'fts5: corrupt'); END");
      await s.db.prepare("UPDATE schema_meta SET version = 7 WHERE id = 'current'").run();

      // A cold start's own probe snapshot, taken BEFORE the hot path's
      // repair drops the triggers, paused right after so the guarded write
      // below can run to completion first.
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let snapshotTaken!: () => void;
      const snapped = new Promise<void>(resolve => { snapshotTaken = resolve; });
      const coldDb = {
        prepare(sql: string) {
          const raw = s.db.prepare(sql);
          if (!sql.startsWith("WITH schema_groups")) return raw;
          return { all: async () => { const result = await raw.all(); snapshotTaken(); await gate; return result; } };
        },
        exec: s.db.exec.bind(s.db),
        batch: s.db.batch.bind(s.db),
      } as unknown as D1Database;
      resetDatabaseInit();
      const cold = initializeDatabase(makeTestEnv(undefined, { DB: coldDb, OAUTH_KV: kv }));
      await snapped;

      const env = withFtsWriteGuard(makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: kv }));
      const result = await env.DB.prepare(
        "INSERT INTO entries (id,content,tags,source,created_at) VALUES ('recovered','recovered searchable','[]','api',1)",
      ).run();

      // Now let the paused cold start resume and finish, using its stale
      // snapshot (taken while the trigger still existed).
      release();
      await cold;

      const triggers = (await s.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'entries_fts_%'`,
      ).all() as { results: unknown[] }).results;
      expect(result.success).toBe(true);
      expect(s.rows().map(r => r.id)).toEqual(["recovered"]);
      // The corruption-shaped repair drops all three triggers (not just the
      // failing one) — none of them come back, stale snapshot or not.
      expect(triggers).toEqual([]);
    } finally { s.close(); }
  });

  // M2 (v2.2 re-review): kills the "restore CREATE VIRTUAL TABLE IF NOT
  // EXISTS" mutant, which survived the whole shipped suite. A stale
  // MISSING-table startup snapshot, then real recovery (someone else
  // creates the table+triggers), then a save drops one trigger (the
  // hot-path corruption branch), then the stale cold start FINALLY runs its
  // own creation batch. With the table DDL's atomicity intact, that batch's
  // CREATE VIRTUAL TABLE fails ("table already exists") and the WHOLE batch
  // rolls back, so the just-dropped trigger stays dropped. With IF NOT
  // EXISTS restored, the table statement would silently no-op instead of
  // failing, the batch would continue, and the trigger CREATE (already
  // "IF NOT EXISTS") would re-arm exactly the trigger the save just removed.
  it("MUTATION-KILLER: a stale missing-table snapshot cannot re-arm a trigger dropped after real recovery", async () => {
    const s = makeSqliteD1();
    try {
      const kv = makeMemoryKV();
      resetDatabaseInit();
      await initializeDatabase(makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: kv }));
      await s.db.exec(
        "DROP TRIGGER entries_fts_insert; DROP TRIGGER entries_fts_update;" +
        "DROP TRIGGER entries_fts_delete; DROP TABLE entries_fts;",
      );
      await s.db.prepare("UPDATE schema_meta SET version = 7 WHERE id = 'current'").run();

      // A cold start's own probe snapshot, taken while the table is
      // genuinely missing, paused right after so the events below can play
      // out first.
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let snapshotTaken!: () => void;
      const snapped = new Promise<void>(resolve => { snapshotTaken = resolve; });
      const coldDb = {
        prepare(sql: string) {
          const raw = s.db.prepare(sql);
          if (!sql.startsWith("WITH schema_groups")) return raw;
          return { all: async () => { const result = await raw.all(); snapshotTaken(); await gate; return result; } };
        },
        exec: s.db.exec.bind(s.db),
        batch: s.db.batch.bind(s.db),
      } as unknown as D1Database;
      resetDatabaseInit();
      const cold = initializeDatabase(makeTestEnv(undefined, { DB: coldDb, OAUTH_KV: kv }));
      await snapped;

      // Real recovery: someone else (a normal repair) creates the table and
      // all three triggers for real, while the cold start is still paused.
      const actual = await vi.importActual<typeof import("../../src/db/fts-repair")>("../../src/db/fts-repair");
      await actual.repairFtsIndex(
        makeTestEnv(undefined, { DB: s.db as unknown as D1Database, OAUTH_KV: kv }),
        new Error("no such table: entries_fts"),
      );
      // Then a save's hot-path corruption repair drops one trigger.
      await s.db.exec("DROP TRIGGER entries_fts_insert");

      // Now let the stale cold start resume and run ITS OWN creation batch,
      // still believing (from its snapshot) that the table is missing.
      release();
      await cold;

      const triggers = (await s.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name = 'entries_fts_insert'`,
      ).all() as { results: unknown[] }).results;
      expect(triggers).toEqual([]); // must stay dropped — not re-armed
    } finally { s.close(); }
  });
});

describe("ENTRIES_WRITE_SQL classifier (table-driven)", () => {
  function classifiedAsEntriesWrite(sql: string): boolean {
    const raw = { bind: () => raw, run: async () => ({ success: true, meta: { rows_written: 1 } }) } as D1PreparedStatement;
    const db = { prepare: () => raw, batch: async () => [] } as unknown as D1Database;
    const env = withFtsWriteGuard({ DB: db, OAUTH_KV: makeMemoryKV() } as Env);
    return (env.DB.prepare(sql) as unknown as { __entriesWrite?: boolean }).__entriesWrite === true;
  }

  const V = (id: string) => `('${id}','${id} searchable','[]','api',1)`;

  // The reviewer's nine missed forms (fix3b-probes, T-0052 review): each was
  // a valid SQLite write to `entries` that the old regex failed to classify
  // as a guarded write.
  const POSITIVES: [string, string][] = [
    ["leading block comment", `/* comment */ INSERT INTO entries (id,content,tags,source,created_at) VALUES ${V("a")}`],
    ["leading line comment", `-- comment\nINSERT INTO entries (id,content,tags,source,created_at) VALUES ${V("b")}`],
    ["INSERT OR IGNORE", `INSERT OR IGNORE INTO entries (id,content,tags,source,created_at) VALUES ${V("c")}`],
    ["REPLACE INTO", `REPLACE INTO entries (id,content,tags,source,created_at) VALUES ${V("d")}`],
    ["double-quoted table name", `INSERT INTO "entries" (id,content,tags,source,created_at) VALUES ${V("e")}`],
    ["bracket-quoted table name", `INSERT INTO [entries] (id,content,tags,source,created_at) VALUES ${V("f")}`],
    ["backtick-quoted table name", `INSERT INTO \`entries\` (id,content,tags,source,created_at) VALUES ${V("g")}`],
    ["schema-qualified (main.entries)", `INSERT INTO main.entries (id,content,tags,source,created_at) VALUES ${V("h")}`],
    ["CTE prefix (WITH ... INSERT INTO entries)", `WITH x(v) AS (SELECT 'i') INSERT INTO entries (id,content,tags,source,created_at) SELECT v,v,'[]','api',1 FROM x`],
    // Already-working forms, kept as a regression net.
    ["canonical INSERT", `INSERT INTO entries (id,content,tags,source,created_at) VALUES ${V("j")}`],
    ["lowercase across newlines", `\ninsert\ninto\nentries (id,content,tags,source,created_at) VALUES ${V("k")}`],
    ["UPDATE with alias", `UPDATE entries AS e SET content = 'x' WHERE e.id = 'seed'`],
    ["DELETE FROM", `DELETE FROM entries WHERE id = 'x'`],
    ["UPDATE OR REPLACE", `UPDATE OR REPLACE entries SET content = 'x' WHERE id = 'y'`],
    // v2 review (S3/S4 + adjacent evasions), fts5-guard-v2 round 2.
    ["S3: trailing semicolon", `DELETE FROM entries;`],
    ["UPSERT (ON CONFLICT DO UPDATE)", `INSERT INTO entries(id) VALUES('x') ON CONFLICT(id) DO UPDATE SET content='x'`],
    ["uppercase schema qualifier", `INSERT INTO MAIN.ENTRIES(id) VALUES('x')`],
    ["nested CTE write (subquery references entries, outer statement writes entries)",
      `WITH c AS (SELECT id FROM entries) INSERT INTO entries (id) SELECT id FROM c`],
    ["CTE body containing a doubled-quote-escaped string, outer statement writes entries",
      `WITH c AS (SELECT 'it''s (fake) INSERT INTO entries' AS text) INSERT INTO entries (id) SELECT id FROM c`],
    // v2.2 review: WITH RECURSIVE was parsed as if "RECURSIVE" were the CTE's
    // own name, so the real name/AS/body never matched and the scanner bailed
    // out before ever reaching the outer INSERT.
    ["WITH RECURSIVE write", `WITH RECURSIVE c(x) AS (SELECT 1) INSERT INTO entries(id,content,tags,source,created_at) VALUES ('r','r searchable','[]','api',1)`],
  ];

  const NEGATIVES: [string, string][] = [
    ["entries_fts", `INSERT INTO entries_fts (rowid,id,content) VALUES (1,'x','x')`],
    ["entry_events", `INSERT INTO entry_events (id) VALUES ('x')`],
    ["entries_x", `INSERT INTO entries_x (id) VALUES ('x')`],
    ["entriesé (non-ASCII identifier continuation)", `INSERT INTO entriesé (id) VALUES ('x')`],
    // S4: a CTE whose write-shaped text is only a STRING LITERAL inside a read.
    ["S4: CTE read with a write-shaped string literal", `WITH c AS (SELECT 'INSERT INTO entries (id) VALUES (1)' AS text) SELECT * FROM c`],
    ["comment containing write-shaped text, real statement is a read", `/* INSERT INTO entries (id) VALUES (1) */ SELECT id FROM entries`],
    ["plain read", `SELECT id FROM entries`],
    ["CTE body with a doubled-quote-escaped write-shaped literal, outer statement is a read",
      `WITH c AS (SELECT 'it''s (fake) INSERT INTO entries' AS text) SELECT * FROM c`],
  ];

  it.each(POSITIVES)("classifies as an entries write: %s", (_name, sql) => {
    expect(classifiedAsEntriesWrite(sql)).toBe(true);
  });

  it.each(NEGATIVES)("does not classify as an entries write: %s", (_name, sql) => {
    expect(classifiedAsEntriesWrite(sql)).toBe(false);
  });
});
