import { describe, it, expect, beforeEach, vi } from "vitest";
import { runFtsBackfill, runFtsMaintenance, checkFtsIntegrity } from "../../src/db/fts-backfill";
import { isFtsLive } from "../../src/recall/fts";
import {
  FTS_BACKFILL_BATCH, FTS_BACKFILL_CURSOR_KV_KEY, FTS_CONTENT_CHECK_CURSOR_KV_KEY, FTS_READY_KV_KEY, FTS_INTEGRITY_SPOT_CHECK,
} from "../../src/constants";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

let d1: SqliteD1;

// makeTestEnv's default KV mock never stores; the backfill's cursor and ready
// latch must be readable, so its memory KV is what every env here carries.
const envFor = (sqlite: SqliteD1): Env =>
  makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });

const seed = (sqlite: SqliteD1, n: number) => {
  for (let i = 1; i <= n; i++) {
    sqlite.db.prepare(`INSERT INTO entries (id, content, created_at) VALUES (?, ?, ?)`)
      .bind(`e${i}`, `memory number ${i} about dashboards`, i)
      .run();
  }
};

const emptyFts = (sqlite: SqliteD1) => sqlite.db.prepare(`DELETE FROM entries_fts`).run();

const ftsCount = async (sqlite: SqliteD1) =>
  await sqlite.db.prepare(`SELECT count(*) AS n FROM entries_fts`).first() as { n: number };
const shadowOf = async (sqlite: SqliteD1) =>
  (await sqlite.db.prepare(`SELECT rowid, id, content FROM entries_fts ORDER BY rowid`).all()).results;
const sourceOf = async (sqlite: SqliteD1) =>
  (await sqlite.db.prepare(`SELECT rowid, id, content FROM entries ORDER BY rowid`).all()).results;
const triggerNames = async (sqlite: SqliteD1) =>
  ((await sqlite.db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('entries_fts_insert','entries_fts_update','entries_fts_delete') ORDER BY name`,
  ).all()).results as { name: string }[]).map(r => r.name);
const ftsTableExists = async (sqlite: SqliteD1) =>
  ((await sqlite.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all()).results as unknown[]).length === 1;

/**
 * Genuine FTS5-internal corruption cannot be reproduced against real SQLite
 * in node:sqlite — its shadow tables (entries_fts_data/_idx/_docsize/_config)
 * refuse direct writes even under PRAGMA writable_schema (see
 * test/integration/fts-write-repair.test.ts's breakByReshaping comment).
 * Reshaping entries_fts itself also fails isFtsLive's exact-DDL check first,
 * which would exercise the "not live" branch instead of the integrity-check
 * branch this is meant to isolate. So the fault is injected at exactly the
 * integrity-check statement; every other statement in the run still executes
 * against the real schema.
 */
function envWithFailingIntegrityCheck(sqlite: SqliteD1, kv = makeMemoryKV()): Env {
  const real = sqlite.db;
  const DB = {
    prepare(sql: string) {
      if (sql.includes(`VALUES('integrity-check', 1)`)) {
        return { bind: () => ({ run: async () => { throw new Error("database disk image is malformed"); } }), run: async () => { throw new Error("database disk image is malformed"); } };
      }
      return real.prepare(sql);
    },
    exec: real.exec.bind(real),
    batch: real.batch.bind(real),
  } as unknown as D1Database;
  return makeTestEnv(undefined, { DB, OAUTH_KV: kv });
}

describe("runFtsBackfill", () => {
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  it("indexes pre-FTS rows in batches behind a KV cursor and latches ready", async () => {
    // Two over a full production batch: one full page, one tail page, then
    // the resume is proven against the real FTS_BACKFILL_BATCH, unmocked.
    const total = FTS_BACKFILL_BATCH + 2;
    seed(d1, total);
    await emptyFts(d1); // rows that predate the index: no trigger fired for these
    const env = envFor(d1);

    expect(await runFtsBackfill(env)).toEqual({ indexed: FTS_BACKFILL_BATCH, done: false });
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe(String(FTS_BACKFILL_BATCH));
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();

    expect(await runFtsBackfill(env)).toEqual({ indexed: 2, done: true });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");

    expect(await ftsCount(d1)).toEqual({ n: total });
    // Every entry indexed exactly once: no duplicate rowids, full shadow matches.
    expect(await d1.db.prepare(
      `SELECT count(*) AS n FROM (SELECT rowid FROM entries_fts GROUP BY rowid HAVING count(*) > 1)`,
    ).first()).toEqual({ n: 0 });
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1));
  });

  it("is idempotent over trigger-covered rows", async () => {
    seed(d1, 5); // triggers populated entries_fts for all five
    const env = envFor(d1);

    let result = { indexed: 0, done: false };
    while (!result.done) result = await runFtsBackfill(env);

    expect(await ftsCount(d1)).toEqual({ n: 5 });
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1));
  });

  it("no-ops once the ready flag is set on a live index", async () => {
    seed(d1, 3);
    await emptyFts(d1);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    d1.issued.length = 0;

    expect(await runFtsBackfill(env)).toEqual({ indexed: 0, done: true });
    // Liveness (M1: checked FIRST, before the ready flag) costs one D1
    // statement even on the healthy fast path — the price of never trusting
    // a flag that a hot-path repair can leave stale with no KV write at all.
    expect(d1.issued).toHaveLength(1);
    expect(await ftsCount(d1)).toEqual({ n: 0 });
  });

  // M1 (v2.2 re-review): the OLD order checked ready BEFORE liveness, so a
  // stale ready="1" left behind by a hot-path repair (which never touches
  // KV) made the backfill report {done:true} without ever looking at the
  // index — exactly the "disabled but marked ready" state the liveness
  // check exists to catch everywhere else.
  it("checks liveness before the ready flag: a disabled index is not done, even with ready=1", async () => {
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    await d1.db.exec("DROP TRIGGER entries_fts_insert");
    const before = d1.issued.length;

    const result = await runFtsBackfill(env);

    expect(result).toEqual({ indexed: 0, done: false });
    expect(d1.issued.slice(before)).toHaveLength(1); // liveness only — never reached the ready GET
  });

  it("indexes every entry exactly once after a repair reset the cursor", async () => {
    // Post-repair state: repairFtsIndex dropped and rebuilt an empty
    // entries_fts, reset the cursor to "0", and deleted the ready flag.
    seed(d1, 5);
    await d1.db.prepare(`DROP TABLE entries_fts`).run();
    await d1.db.prepare(
      `CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, content, tokenize='trigram')`,
    ).run();
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");

    let result = { indexed: 0, done: false };
    while (!result.done) result = await runFtsBackfill(env);

    expect(await ftsCount(d1)).toEqual({ n: 5 });
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1));
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
  });

  // Write-path isolation v2.2: FTS is live only if entries_fts exists AND
  // all three sync triggers exist. A hot-path repair on a non-missing-table
  // failure only drops the failed trigger (no rename in v2.2), so this is
  // "table present, one trigger gone" — the live table's data is stale but
  // querying it throws nothing. Without the liveness check the backfill's
  // DELETE+INSERT batch would either throw "no such table: entries_fts"
  // (missing-table shape) or silently index against a still-broken sync
  // (missing-trigger shape) every night. Only Task 5's nightly rebuild may
  // recreate entries_fts; the backfill must leave it alone either way.
  it("skips cleanly without throwing while entries_fts is not live (a trigger is missing), even with a backlog", async () => {
    seed(d1, 5);
    await emptyFts(d1); // a genuine backlog: these rows predate the index
    await d1.db.exec("DROP TRIGGER entries_fts_insert");
    const env = envFor(d1);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runFtsBackfill(env);

    expect(result).toEqual({ indexed: 0, done: false });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    expect(await ftsCount(d1)).toEqual({ n: 0 }); // untouched — the backlog never got written
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("skips cleanly without throwing while entries_fts is not live (table missing), even with no backlog", async () => {
    // No pre-FTS rows to index: the old code's early "no backlog -> ready=1"
    // path did not check entries_fts's existence at all, so this shape would
    // have wrongly latched ready over a table that does not exist.
    await d1.db.exec("DROP TABLE entries_fts");
    const env = envFor(d1);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runFtsBackfill(env);

    expect(result).toEqual({ indexed: 0, done: false });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    logSpy.mockRestore();
  });

  it("does not latch ready over an incomplete index when the cursor is past max rowid", async () => {
    // The reviewer's PAST_CURSOR probe: a cursor beyond every rowid reads an
    // empty page, and the old latch took that as "backfill complete" without
    // ever comparing the shadow to entries — ready=1 over an empty index.
    seed(d1, 3);
    await emptyFts(d1);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "999");

    const result = await runFtsBackfill(env);

    expect(result).toEqual({ indexed: 0, done: false });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0"); // restart, not latch
    expect(await shadowOf(d1)).toEqual([]);
    expect(await sourceOf(d1)).toHaveLength(3);
  });

  it("does not latch ready when a trigger is dropped during the final batch", async () => {
    // The reviewer's LATCH_RACE probe: a hot-path repair drops a sync trigger
    // while the final batch runs; the old code latched ready over the now
    // dead-but-queryable table in the same breath.
    d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at) VALUES ('e1', 'first violet', '[]', 'api', 1)`).run();
    d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at) VALUES ('e2', 'second violet', '[]', 'api', 2)`).run();
    await emptyFts(d1);
    const raw = d1.db;
    let injected = false;
    const DB = {
      prepare(sql: string) {
        const stmt = raw.prepare(sql);
        if (!sql.includes("SELECT rowid AS rid FROM entries")) return stmt;
        return {
          bind(...args: unknown[]) {
            const bound = stmt.bind(...args);
            return {
              all: async () => {
                const selected = await bound.all();
                if (!injected) {
                  injected = true;
                  await raw.exec("DROP TRIGGER entries_fts_insert");
                  await raw.prepare(
                    "INSERT INTO entries (id,content,tags,source,created_at) VALUES ('raced','raced violet','[]','api',3)",
                  ).run();
                }
                return selected;
              },
            };
          },
        };
      },
      exec: raw.exec.bind(raw),
      batch: raw.batch.bind(raw),
    } as unknown as D1Database;
    const env = makeTestEnv(undefined, { DB, OAUTH_KV: makeMemoryKV() });

    const result = await runFtsBackfill(env);

    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
    expect(result).toEqual({ indexed: 2, done: false });
    expect(await sourceOf(d1)).toHaveLength(3);
    expect(await shadowOf(d1)).toHaveLength(2);
  });

  // Promoted from review/mutation-b-orphan.probe.ts (T-0056 mutation testing):
  // with the latch guard's REVERSE parity probe deleted, every other shipped
  // test still passes. An FTS row whose rowid is absent from entries is
  // invisible to the forward EXCEPT probe and to the newest-5 spot check —
  // only the reverse direction refuses the latch over it.
  it("does not latch ready while an FTS orphan row (rowid absent from entries) exists", async () => {
    seed(d1, 1);
    await d1.db.prepare(`INSERT INTO entries_fts (rowid, id, content) VALUES (9999, 'ghost', 'ghost content')`).run();
    const env = envFor(d1);

    const result = await runFtsBackfill(env);

    expect(result).toEqual({ indexed: 1, done: false });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0"); // restart, not latch
    // The refusal repairs nothing itself; the nightly integrity check owns orphan cleanup.
    expect(await d1.db.prepare(`SELECT count(*) AS n FROM entries_fts WHERE id = 'ghost'`).first()).toEqual({ n: 1 });
  });

  // Promoted from review/mutation-e-liveness-race.probe.ts: with the latch
  // guard's OWN liveness recheck deleted, every other shipped test still
  // passes. Unlike the trigger-drop test above, nothing is written between
  // the final batch and the latch, so both EXCEPT parity probes come back
  // clean — only the guard's fresh liveness read sees the dropped trigger.
  it("does not latch ready when a trigger drops between the final batch and the latch with data still in parity", async () => {
    seed(d1, 2);
    const raw = d1.db;
    let dropped = false;
    const DB = {
      prepare(sql: string) {
        const stmt = raw.prepare(sql);
        if (!sql.includes("SELECT rowid AS rid FROM entries")) return stmt;
        return {
          bind(...args: unknown[]) {
            const bound = stmt.bind(...args);
            return {
              all: async () => {
                const selected = await bound.all();
                if (!dropped) { dropped = true; await raw.exec("DROP TRIGGER entries_fts_insert"); }
                return selected;
              },
            };
          },
        };
      },
      exec: raw.exec.bind(raw),
      batch: raw.batch.bind(raw),
    } as unknown as D1Database;
    const env = makeTestEnv(undefined, { DB, OAUTH_KV: makeMemoryKV() });

    const result = await runFtsBackfill(env);

    expect(result).toEqual({ indexed: 2, done: false });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
    expect(await isFtsLive(env)).toBe(false);
  });
});

describe("checkFtsIntegrity", () => {
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  it("live + healthy + ready: reports healthy, issues no DDL or KV writes, ready stays set", async () => {
    seed(d1, 5); // triggers populate entries_fts
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    d1.issued.length = 0;

    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: true });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBeNull();
    expect(d1.issued.some(sql => /^(DROP|DELETE|CREATE)\b/i.test(sql))).toBe(false);
  });

  it("a healthy night full-scans entries exactly once: the GROUP BY is the scan, the total is summed in JS", async () => {
    // T-0065 regression: the spec replaced the global count(*) with the
    // per-workspace GROUP BY, keeping one full scan of entries per night.
    // Keeping both means two full scans every night, so the plan of every
    // statement the healthy path issues must show exactly one `SCAN entries`.
    seed(d1, 5);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    d1.issued.length = 0;
    d1.batches.length = 0;

    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: true });
    // This fork's SQLite facade records every prepared statement in `issued`,
    // including batch members. Inspect each statement exactly once.
    const allSql = [...d1.issued];

    const planDetails = async (sql: string): Promise<string[]> =>
      ((await d1.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()).results as { detail: string }[]).map(r => r.detail);
    const entriesScans: string[] = [];
    for (const sql of allSql) {
      if (!/\bFROM\s+entries\b/i.test(sql)) continue;
      entriesScans.push(...(await planDetails(sql)).filter(d => /^SCAN entries\b/.test(d)).map(d => `${sql}: ${d}`));
    }
    expect(entriesScans).toHaveLength(1);
    // Belt and suspenders: no bare count(*) over entries (a full scan in its
    // own right) survives anywhere in the night's statements.
    expect(allSql.some(sql => /count\(\*\)\s+FROM\s+entries\b(?!\s+GROUP)/i.test(sql.replace(/GROUP\s+BY[^)]*count\(\*\)/gi, "")))).toBe(false);
  });

  it("count drift: deletes FTS orphans, clears ready, resets the cursor, never drops the table", async () => {
    seed(d1, 5);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    // A row that predates a trigger-covered write, or a partial batch failure:
    // entries_fts has one fewer row than entries.
    await d1.db.prepare(
      `DELETE FROM entries_fts WHERE rowid = (SELECT rowid FROM entries ORDER BY rowid LIMIT 1)`,
    ).run();

    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: false });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
    expect(await ftsCount(d1)).toEqual({ n: 4 }); // the orphan-delete found no orphans to remove
    expect(await ftsTableExists(d1)).toBe(true);
  });

  it("rowid-mapping drift: detected by the spot check even though counts still agree, same in-place repair", async () => {
    seed(d1, 5);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    const newest = await d1.db.prepare(`SELECT rowid FROM entries ORDER BY rowid DESC LIMIT 1`).first() as { rowid: number };
    // Same rowid as a live entry, wrong id: count parity alone cannot see this.
    await d1.db.prepare(`DELETE FROM entries_fts WHERE rowid = ?`).bind(newest.rowid).run();
    await d1.db.prepare(`INSERT INTO entries_fts (rowid, id, content) VALUES (?, 'wrong-id', 'drifted')`).bind(newest.rowid).run();

    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: false });
    expect(await ftsCount(d1)).toEqual({ n: 5 }); // still not an orphan by rowid — the reset lets the backfill fix it
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
  });

  it("content drift inside the window heals in place: ready and the backfill cursor are untouched", async () => {
    // The reviewer's DRIFT_SURVIVES probe, at unit scale: a same-row content
    // drift keeps counts equal and misses the newest-5 spot check, so the old
    // checks never saw it. The rotating window reads (rowid,id,content) both
    // ways and re-indexes exactly the mismatched rowids.
    seed(d1, 7);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    const staleRowid = (await d1.db.prepare(`SELECT rowid FROM entries WHERE id = 'e1'`).first() as { rowid: number }).rowid;
    await d1.db.prepare(`UPDATE entries_fts SET content = 'stale orchid payload' WHERE rowid = ?`).bind(staleRowid).run();

    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: true });
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1)); // e1 healed in place
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1"); // no reset: the backfill is not restarted
    expect(await env.OAUTH_KV.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBeNull();
  });

  it("the content window advances past the corpus and wraps to 0", async () => {
    seed(d1, 3);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");

    await checkFtsIntegrity(env); // window 1..200 covers all three; past max rowid, so it wraps

    expect(await env.OAUTH_KV.get(FTS_CONTENT_CHECK_CURSOR_KV_KEY)).toBe("0");
  });

  it("content drift outside the current window survives until its window night", async () => {
    // Rotation, not a full scan: a drift beyond the window stays until the
    // cursor reaches it, so a drift at a far rowid is not healed by the
    // first check. With a window of 200 and rowids 1..2, both are inside the
    // first window — seed past it instead by resetting the cursor mid-way.
    seed(d1, 2);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    // Start the rotation past both rows, as the previous night left it.
    await env.OAUTH_KV.put(FTS_CONTENT_CHECK_CURSOR_KV_KEY, "200");

    await d1.db.prepare(`UPDATE entries_fts SET content = 'stale' WHERE rowid = (SELECT rowid FROM entries WHERE id = 'e1')`).run();
    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: true }); // window (200, 400] saw neither row
    expect(await shadowOf(d1)).not.toEqual(await sourceOf(d1));
    // ...and the next night's window wraps to 0 and heals it.
    await checkFtsIntegrity(env);
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1));
  });

  // A missing mirror paired with an orphan cancels in the count (12 == 12), so
  // night 1's parity passes and the drift half heals the missing row in place.
  // The counts then differ (13 vs 12), and night 2's count parity sends the
  // run down the unhealthy branch, whose DELETE removes the orphan.
  it("heals a canceled missing-plus-orphan pair over two nights: window then count parity", async () => {
    seed(d1, 12); // e1..e12; the newest-5 spot check never reaches e1's rowid
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    const rid1 = (await d1.db.prepare(`SELECT rowid FROM entries WHERE id = 'e1'`).first() as { rowid: number }).rowid;
    await d1.db.prepare(`DELETE FROM entries_fts WHERE rowid = ?`).bind(rid1).run();
    await d1.db.prepare(`INSERT INTO entries_fts (rowid, id, content) VALUES (999, 'ghost', 'ghost content')`).run();

    expect(await checkFtsIntegrity(env)).toEqual({ healthy: true });
    expect((await d1.db.prepare(`SELECT 1 FROM entries_fts WHERE rowid = ?`).bind(rid1).all()).results).toHaveLength(1); // missing row re-indexed
    expect((await d1.db.prepare(`SELECT 1 FROM entries_fts WHERE rowid = 999`).all()).results).toHaveLength(1); // orphan survives the window
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1"); // healed in place, no reset

    expect(await checkFtsIntegrity(env)).toEqual({ healthy: false }); // 12 entries vs 13 fts rows
    expect(await ftsCount(d1)).toEqual({ n: 12 });
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1)); // orphan gone, mirror complete
  });

  it("the rotating window's FTS reads scale with the window, not the corpus", async () => {
    // Cost proof on a real 5,000-row corpus (the E2E finding measured a
    // 5,747-row brain). node:sqlite exposes no rows_read meter, so cost is
    // pinned by SQLite's own access-path verdicts: EXPLAIN QUERY PLAN of the
    // exact statements the run issues must show the window pushed into every
    // access path — never a whole-corpus virtual-table scan.
    seed(d1, 5000);
    // Realistic memory-size content; the update trigger re-mirrors FTS,
    // keeping (rowid, id, content) parity.
    await d1.db.prepare(`UPDATE entries SET content = content || ' with violet orchid dashboard detail repeated for a realistic memory size', write_marker = ?`).bind(d1.fixtureMarker()).run();
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    await d1.db.prepare(`UPDATE entries_fts SET content = 'stale orchid payload' WHERE rowid = 7`).run();

    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: true });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1"); // healed in place, no reset
    expect(await ftsCount(d1)).toEqual({ n: 5000 });
    expect(await shadowOf(d1)).toEqual(await sourceOf(d1));

    // The drift statement, verbatim from the batch the run issued — found by
    // its parity predicate (`IS NOT`), not the join text, so the lookup
    // survives a query-shape change. The plan asserts ONLY this statement:
    // the window no longer carries an orphan half. FTS5's range constraints
    // on rowid are not honored as seeks on real D1 (measured: INDEX 0:>< in
    // the plan, a whole-table 20,961 rows_read at 20.8k entries), so orphans
    // rely on checkFtsIntegrity's nightly count parity instead of a window
    // scan.
    const batchSql = d1.batches.flat();
    const driftSql = batchSql.find(sql => sql.includes("IS NOT"));
    expect(driftSql).toBeTruthy();

    // FTS5 serves the drift side by exact-rowid lookups (INDEX 0:=) driven by
    // entries' pk range — never a scan of the virtual table.
    const planDetails = async (sql: string): Promise<string[]> =>
      ((await d1.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(0, 4294967295).all()).results as { detail: string }[])
        .map(r => r.detail);
    const driftPlan = await planDetails(driftSql!);
    expect(driftPlan).toContain("SEARCH e USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)");
    expect(driftPlan).toContain("SCAN f VIRTUAL TABLE INDEX 0:= LEFT-JOIN");
    expect(driftPlan.some(d => d.startsWith("SCAN entries_fts"))).toBe(false);

    // Count probe: the window statement returns exactly the window's worth
    // of rows. The run healed rowid 7, so re-inject one drifted row first.
    await d1.db.prepare(`UPDATE entries_fts SET content = 'stale again' WHERE rowid = 6`).run();
    expect((await d1.db.prepare(driftSql!).bind(0, 200).all()).results).toEqual([{ rowid: 6 }]);
  });
});

// T-0065: entry_counts' nightly self-heal. Independent of the entries_fts
// checks above — a mismatch here does not touch the ready flag or the FTS
// backfill cursor, and vice versa.
describe("checkFtsIntegrity: entry_counts drift", () => {
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  const totalN = async (sqlite: SqliteD1) =>
    (await sqlite.db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM entry_counts`).first() as { n: number }).n;
  const entryCount = async (sqlite: SqliteD1) =>
    (await sqlite.db.prepare(`SELECT count(*) AS n FROM entries`).first() as { n: number }).n;

  it("healthy: reports healthy and touches entry_counts with no extra scan", async () => {
    seed(d1, 5); // triggers populate entry_counts
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    d1.issued.length = 0;
    d1.batches.length = 0;

    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: true });
    expect(await totalN(d1)).toBe(5);
    // No DELETE/rebuild batch: the healthy path pays for the extra SUM(n)
    // column on the existing count-parity SELECT and nothing more.
    expect(d1.batches.some(b => b.some(sql => sql.startsWith("DELETE FROM entry_counts")))).toBe(false);
  });

  it("count mismatch: rebuilds entry_counts from a fresh GROUP BY in one batch", async () => {
    seed(d1, 5);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    // Tamper with the counter directly — the shape a dropped/mis-tracked
    // write would leave behind, without touching entries or entries_fts.
    await d1.db.prepare(`UPDATE entry_counts SET n = n + 3`).run();
    expect(await totalN(d1)).toBe(8);

    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: true }); // entries/entries_fts parity is unaffected
    expect(await totalN(d1)).toBe(await entryCount(d1)); // exact again
    expect(await totalN(d1)).toBe(5);
    // DELETE + INSERT...SELECT rode in ONE batch.
    const rebuild = d1.batches.find(b => b.some(sql => sql.startsWith("DELETE FROM entry_counts")));
    expect(rebuild).toBeTruthy();
    expect(rebuild!.some(sql => sql.includes("INSERT INTO entry_counts SELECT workspace_id, count(*) FROM entries GROUP BY workspace_id"))).toBe(true);
  });

  it("an orphaned workspace row (no matching entries) is removed by the rebuild", async () => {
    seed(d1, 3);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    await d1.db.prepare(`INSERT INTO entry_counts (workspace_id, n) VALUES ('ghost-ws', 4)`).run();
    expect(await totalN(d1)).toBe(7);

    await checkFtsIntegrity(env);

    const ghost = await d1.db.prepare(`SELECT n FROM entry_counts WHERE workspace_id = 'ghost-ws'`).first();
    expect(ghost).toBeNull(); // DELETE-then-reseed drops rows for workspaces with no entries left
    expect(await totalN(d1)).toBe(3);
  });

  it("stays independent of an entries_fts count mismatch in the same run", async () => {
    seed(d1, 5);
    const env = envFor(d1);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    await d1.db.prepare(`DELETE FROM entries_fts WHERE rowid = (SELECT rowid FROM entries ORDER BY rowid LIMIT 1)`).run();
    await d1.db.prepare(`UPDATE entry_counts SET n = n + 1`).run();

    const result = await checkFtsIntegrity(env);

    expect(result).toEqual({ healthy: false }); // the FTS side is unhealthy...
    expect(await totalN(d1)).toBe(5); // ...but entry_counts still self-healed
  });
});

describe("runFtsMaintenance", () => {
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  it("delegates to the backfill for now", async () => {
    seed(d1, 2);
    await emptyFts(d1);
    const env = envFor(d1);

    let result = { indexed: 0, done: false };
    while (!result.done) result = await runFtsMaintenance(env);

    expect(await ftsCount(d1)).toEqual({ n: 2 });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
  });

  it("live + ready not set: runs the backfill only, skipping the parity checks", async () => {
    seed(d1, 3);
    await emptyFts(d1); // a genuine backlog, as if these rows predate the index
    const env = envFor(d1);

    const result = await runFtsMaintenance(env);

    expect(result).toEqual({ indexed: 3, done: true });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
    expect(d1.issued.some(sql => sql.includes("(SELECT count(*) FROM entries) AS e"))).toBe(false);
  });

  it("not live (a trigger is missing): rebuilds the table and triggers, and the backfill starts the same night", async () => {
    seed(d1, 3);
    await d1.db.exec("DROP TRIGGER entries_fts_insert");
    const env = envFor(d1);

    const result = await runFtsMaintenance(env);

    expect(await triggerNames(d1)).toEqual(["entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
    expect(result).toEqual({ indexed: 3, done: true });
    expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
    expect(await ftsCount(d1)).toEqual({ n: 3 });
  });

  it("a genuine SQLite error from the integrity-check statement triggers a rebuild, not the count/spot checks", async () => {
    seed(d1, 2);
    const kv = makeMemoryKV();
    await kv.put(FTS_READY_KV_KEY, "1"); // proves the rebuild path is reached via the throw, not the ready gate
    const env = envWithFailingIntegrityCheck(d1, kv);

    const result = await runFtsMaintenance(env);

    expect(result).toEqual({ indexed: 2, done: true });
    expect(await kv.get(FTS_READY_KV_KEY)).toBe("1"); // re-latched by the backfill after the rebuild
    expect(await ftsCount(d1)).toEqual({ n: 2 });
  });

  it("rebuild with KV failing: issues no DDL, and the error propagates for the nightly catch to log", async () => {
    seed(d1, 1);
    await d1.db.exec("DROP TRIGGER entries_fts_insert");
    const kv = {
      get: async () => null,
      put: async () => { throw new Error("KV unavailable"); },
      delete: async () => { throw new Error("KV unavailable"); },
    } as unknown as KVNamespace;
    const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: kv });

    await expect(runFtsMaintenance(env)).rejects.toThrow("KV unavailable");

    // The rebuild aborted before any DDL: only the trigger this test itself
    // dropped is missing, nothing else changed.
    expect(await triggerNames(d1)).toEqual(["entries_fts_delete", "entries_fts_update"]);
  });
});
