/**
 * T-0065: entry_counts, the exact per-workspace entry counter that replaces
 * distillation's scoped COUNT(*)/cache. Real SQLite (test/helpers/sqlite-d1.ts):
 * the triggers' correctness under concurrency and the migration seed's
 * atomicity are exactly what the string-matching D1 mock cannot evaluate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { checkFtsIntegrity } from "../../src/db/fts-backfill";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import type { Env } from "../../src/env";

let d1: SqliteD1;
const envFor = (sqlite: SqliteD1): Env =>
  makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });

async function countsOf(sqlite: SqliteD1): Promise<Record<string, number>> {
  const { results } = await sqlite.db.prepare(`SELECT workspace_id, n FROM entry_counts ORDER BY workspace_id`).all() as {
    results: { workspace_id: string; n: number }[];
  };
  return Object.fromEntries(results.map(r => [r.workspace_id, r.n]));
}

async function trueCountsOf(sqlite: SqliteD1): Promise<Record<string, number>> {
  const { results } = await sqlite.db.prepare(
    `SELECT workspace_id, count(*) AS n FROM entries GROUP BY workspace_id ORDER BY workspace_id`,
  ).all() as { results: { workspace_id: string; n: number }[] };
  return Object.fromEntries(results.map(r => [r.workspace_id, r.n]));
}

function insertEntry(sqlite: SqliteD1, id: string, workspaceId: string, createdAt = 1): void {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, 'memory', '[]', 'api', ?, '[]', ?)`,
  ).bind(id, createdAt, workspaceId).run();
}

describe("entry_counts triggers, against real SQLite", () => {
  beforeEach(() => {
    d1 = makeSqliteD1();
  });
  afterEach(() => d1?.close());

  it("is exact after inserts across several workspaces", async () => {
    insertEntry(d1, "a1", "ws-a");
    insertEntry(d1, "a2", "ws-a");
    insertEntry(d1, "b1", "ws-b");

    expect(await countsOf(d1)).toEqual({ "ws-a": 2, "ws-b": 1 });
    expect(await countsOf(d1)).toEqual(await trueCountsOf(d1));
  });

  it("is exact after deletes", async () => {
    insertEntry(d1, "a1", "ws-a");
    insertEntry(d1, "a2", "ws-a");

    await d1.db.prepare(`UPDATE entries SET write_marker = ? WHERE id = 'a1'`).bind(d1.fixtureMarker("delete")).run();
    await d1.db.prepare(`DELETE FROM entries WHERE id = 'a1'`).run();

    expect(await countsOf(d1)).toEqual({ "ws-a": 1 });
  });

  it("is exact after a workspace move (share to a team)", async () => {
    insertEntry(d1, "a1", "ws-personal");

    await d1.db.prepare(`UPDATE entries SET workspace_id = 'ws-team' WHERE id = 'a1'`).run();

    expect(await countsOf(d1)).toEqual({ "ws-personal": 0, "ws-team": 1 });
  });

  it("is exact after a workspace move back (unshare)", async () => {
    insertEntry(d1, "a1", "ws-personal");
    await d1.db.prepare(`UPDATE entries SET workspace_id = 'ws-team' WHERE id = 'a1'`).run();

    await d1.db.prepare(`UPDATE entries SET workspace_id = 'ws-personal' WHERE id = 'a1'`).run();

    expect(await countsOf(d1)).toEqual({ "ws-personal": 1, "ws-team": 0 });
  });

  it("is exact across several team moves of the same entry", async () => {
    insertEntry(d1, "a1", "ws-a");
    for (const target of ["ws-b", "ws-c", "ws-a", "ws-b"]) {
      await d1.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'a1'`).bind(target).run();
    }

    expect(await countsOf(d1)).toEqual({ "ws-a": 0, "ws-b": 1, "ws-c": 0 });
  });

  it("a workspace_id UPDATE that re-sets the SAME value never touches entry_counts (the update trigger's WHEN guard)", async () => {
    insertEntry(d1, "a1", "ws-a");
    // total_changes() (unlike node:sqlite's per-statement .changes, see the
    // rows_written test below) includes trigger-caused writes, so it can
    // distinguish "the WHEN guard suppressed the body" from "it ran and
    // happened to net to the same total".
    const before = (await d1.db.prepare(`SELECT total_changes() AS c`).first() as { c: number }).c;

    await d1.db.prepare(`UPDATE entries SET workspace_id = workspace_id WHERE id = 'a1'`).run();

    const after = (await d1.db.prepare(`SELECT total_changes() AS c`).first() as { c: number }).c;
    expect(after - before).toBe(1); // only the entries row; entry_counts untouched
    expect(await countsOf(d1)).toEqual({ "ws-a": 1 });
  });

  it("a recall_count-only UPDATE does not fire the workspace_id trigger", async () => {
    insertEntry(d1, "a1", "ws-a");
    const before = await countsOf(d1);

    await d1.db.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = 'a1'`).run();

    expect(await countsOf(d1)).toEqual(before);
  });

  it("is exact after a bulk import", async () => {
    const statements = [];
    for (let i = 0; i < 200; i++) {
      statements.push(
        d1.db.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, 'memory', '[]', 'api', 1, '[]', ?)`,
        ).bind(`bulk-${i}`, i % 2 === 0 ? "ws-a" : "ws-b"),
      );
    }
    await d1.db.batch(statements);

    expect(await countsOf(d1)).toEqual({ "ws-a": 100, "ws-b": 100 });
  });

  it("team deletion (bulk delete of every entry in a workspace) keeps SUM correct — the row stays at n = 0, not deleted", async () => {
    insertEntry(d1, "a1", "ws-team");
    insertEntry(d1, "a2", "ws-team");
    insertEntry(d1, "b1", "ws-b");

    await d1.db.prepare(`UPDATE entries SET write_marker = ? WHERE workspace_id = 'ws-team'`).bind(d1.fixtureMarker("delete")).run();
    await d1.db.prepare(`DELETE FROM entries WHERE workspace_id = 'ws-team'`).run();

    const row = await d1.db.prepare(`SELECT n FROM entry_counts WHERE workspace_id = 'ws-team'`).first() as { n: number } | null;
    expect(row).toEqual({ n: 0 }); // kept, not deleted (documented design decision)
    expect(await countsOf(d1)).toEqual({ "ws-b": 1, "ws-team": 0 });
    const total = await d1.db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM entry_counts`).first() as { n: number };
    expect(total.n).toBe(1); // SUM is correct either way
  });

  it("rows_written per capture: measured, not assumed (MINOR 4a, final review)", async () => {
    // node:sqlite's StatementSync.run().changes (what D1's meta.rows_written
    // maps to in this test double) reports only the directly executed
    // statement's own row count — it does NOT include rows an AFTER trigger
    // writes to a different table, so it undercounts the real per-capture
    // cost. total_changes() on the connection counts every row any
    // statement OR trigger touches since the connection opened, so a delta
    // across one capture is trigger-aware and reflects the real write count.
    const before = (await d1.db.prepare(`SELECT total_changes() AS n`).first() as { n: number }).n;
    const result = await d1.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES ('x1', 'memory', '[]', 'api', 1, '[]', 'ws-a')`,
    ).run() as { meta: { rows_written: number } };
    const after = (await d1.db.prepare(`SELECT total_changes() AS n`).first() as { n: number }).n;

    expect(result.meta.rows_written).toBe(1); // the statement's own count — undercounts on purpose, see above
    // Measured directly against this brain's real schema.sql, every sync
    // trigger live: this fork's additional write-fence bookkeeping makes a
    // single INSERT INTO entries write 10 rows total.
    // Reconciles with the reviewer's probe (final-review.probe.test.ts):
    // 9 total_changes with entry_counts' table and triggers dropped, 10 with
    // them present — this brain has them present, so 10 is the expected value.
    expect(after - before).toBe(10);
    expect((await d1.db.prepare(`SELECT n FROM entry_counts WHERE workspace_id = 'ws-a'`).first() as { n: number }).n).toBe(1); // the row is really there
  });

  it("a capsule-tagged capture writes one row more than a plain one (MINOR 4a, final review)", async () => {
    // The prompt_capsule_entry_insert trigger adds exactly one more row
    // (prompt_capsule_revisions). Use two identical fresh databases: FTS5's
    // first insert has a different internal write count than later inserts.
    const capsuleDb = makeSqliteD1();
    try {
      const delta = async (db: SqliteD1, tags: string) => {
        const before = (await db.db.prepare(`SELECT total_changes() AS n`).first() as { n: number }).n;
        await db.db.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES ('same', 'memory', ?, 'api', 1, '[]', 'ws-a')`,
        ).bind(tags).run();
        const after = (await db.db.prepare(`SELECT total_changes() AS n`).first() as { n: number }).n;
        return after - before;
      };
      const plainWrites = await delta(d1, "[]");
      const capsuleWrites = await delta(capsuleDb, '["capsule:test"]');
      expect(plainWrites).toBe(10);
      expect(capsuleWrites).toBe(11);
    } finally { capsuleDb.close(); }
  });
});

describe("entry_counts seed, against real SQLite", () => {
  beforeEach(() => { resetDatabaseInit(); });
  afterEach(() => d1?.close());

  it("seeds exact per-workspace counts on a populated pre-T-0065 brain (the migration)", async () => {
    d1 = makeSqliteD1(); // schema.sql applied, then rewound to its pre-T-0065 shape below
    await d1.db.exec(
      `DROP TRIGGER IF EXISTS entry_counts_insert; DROP TRIGGER IF EXISTS entry_counts_update;` +
      `DROP TRIGGER IF EXISTS entry_counts_delete; DROP TABLE IF EXISTS entry_counts;`,
    );
    // Rows written directly, with no entry_counts triggers to track them —
    // exactly what a brain that predates T-0065 looks like.
    insertEntry(d1, "a1", "ws-a");
    insertEntry(d1, "a2", "ws-a");
    insertEntry(d1, "b1", "ws-b");
    insertEntry(d1, "legacy", "");
    await d1.db.prepare("UPDATE schema_meta SET version = 7 WHERE id = 'current'").run();

    await initializeDatabase(envFor(d1));

    expect(await countsOf(d1)).toEqual({ "": 1, "ws-a": 2, "ws-b": 1 });
  });

  it("a concurrent entries insert landing exactly between the creation batch and the seed is neither double-counted nor missed", async () => {
    d1 = makeSqliteD1();
    await d1.db.exec(
      `DROP TRIGGER IF EXISTS entry_counts_insert; DROP TRIGGER IF EXISTS entry_counts_update;` +
      `DROP TRIGGER IF EXISTS entry_counts_delete; DROP TABLE IF EXISTS entry_counts;`,
    );
    for (let i = 0; i < 20; i++) insertEntry(d1, `pre-${i}`, "ws-a", i);
    await d1.db.prepare("UPDATE schema_meta SET version = 7 WHERE id = 'current'").run();

    const env = envFor(d1);
    // Targets the one window that matters: the sqlite-d1 helper serializes
    // every statement and batch on this connection through one FIFO queue
    // (see its enqueue() doc comment), so a concurrent write can only ever
    // land fully before or fully after any single batch — never mid-batch.
    // The only place a second isolate could genuinely race applySchema is
    // between the creation batch resolving and whatever runs next, so this
    // wraps batch() to fire the concurrent insert at exactly that instant,
    // deterministically, rather than hoping an unrelated Promise.all
    // schedules into it.
    const realBatch = env.DB.batch.bind(env.DB);
    let injected = false;
    env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      const result = await realBatch(statements);
      if (!injected && statements.some(s => (s as unknown as { sourceSql?: () => string }).sourceSql?.().includes("entry_counts"))) {
        injected = true;
        insertEntry(d1, "concurrent", "ws-a", 999);
      }
      return result;
    }) as typeof env.DB.batch;

    await initializeDatabase(env);

    expect(injected).toBe(true); // the injection point was actually reached
    expect(await countsOf(d1)).toEqual(await trueCountsOf(d1));
    expect((await d1.db.prepare(`SELECT n FROM entry_counts WHERE workspace_id = 'ws-a'`).first() as { n: number }).n).toBe(21);
  });
});

describe("T-0065 nightly per-workspace check (FIX 1, final review)", () => {
  beforeEach(() => { resetDatabaseInit(); });
  afterEach(() => d1?.close());

  // The reviewer's reproduction: dropping entry_counts_update lets a
  // cross-workspace move desync the two workspaces' counters while their SUM
  // stays equal to count(*) — the old global check reported healthy forever.
  it("repairs a permanent per-workspace drift the old global SUM check could not see", async () => {
    d1 = makeSqliteD1();
    insertEntry(d1, "e1", "ws-a");
    await d1.db.exec(`DROP TRIGGER entry_counts_update`);

    await d1.db.prepare(`UPDATE entries SET workspace_id = 'ws-b' WHERE id = 'e1'`).run();

    // Reproduces the bug: SUM(n) still equals count(*) globally.
    const totals = await d1.db.prepare(
      `SELECT (SELECT COALESCE(SUM(n),0) FROM entry_counts) AS cached, (SELECT count(*) FROM entries) AS actual`,
    ).first() as { cached: number; actual: number };
    expect(totals.cached).toBe(totals.actual);
    expect(await countsOf(d1)).toEqual({ "ws-a": 1 }); // stale: ws-b never appears

    expect(await checkFtsIntegrity(envFor(d1))).toEqual({ healthy: true }); // entries_fts itself is fine

    // Reseeded via GROUP BY, the same shape applySchema's own first seed
    // uses — a workspace with zero current rows gets no row at all, unlike
    // the trigger's own "kept at 0" convention (see the "team deletion"
    // test above). SUM is correct either way.
    expect(await countsOf(d1)).toEqual({ "ws-b": 1 });
    expect(await d1.db.prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='entry_counts_update'`,
    ).first()).toEqual({ n: 1 }); // trigger restored, not just the data
  });

  it("repairs a tampered entry_counts trigger body even when the per-workspace counts still happen to be exact", async () => {
    d1 = makeSqliteD1();
    insertEntry(d1, "e1", "ws-a");
    // Right name, wrong body — the same corruption shape v2.2 guards against
    // for entries_fts, reproduced here for entry_counts' insert trigger.
    await d1.db.exec(`DROP TRIGGER entry_counts_insert`);
    await d1.db.exec(
      `CREATE TRIGGER entry_counts_insert AFTER INSERT ON entries BEGIN SELECT 1; END`,
    );
    insertEntry(d1, "e2", "ws-a");
    expect(await countsOf(d1)).toEqual({ "ws-a": 1 }); // tampered body missed e2

    expect(await checkFtsIntegrity(envFor(d1))).toEqual({ healthy: true });

    const tamperedGone = await d1.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='entry_counts_insert'`,
    ).first() as { sql: string };
    expect(tamperedGone.sql).toContain("INSERT INTO entry_counts");
    expect(tamperedGone.sql).not.toContain("SELECT 1");
    // The repair reseeds via GROUP BY, including both real rows.
    expect(await countsOf(d1)).toEqual({ "ws-a": 2 });
    insertEntry(d1, "e3", "ws-a");
    expect(await countsOf(d1)).toEqual({ "ws-a": 3 }); // the restored trigger fires on the next write
  });

  // Mutation-killer, isolated from the trigger-liveness check: both
  // entry_counts triggers stay intact and correct here — only the row
  // VALUES are tampered directly (bypassing the triggers entirely), so a
  // check that fell back to comparing global totals would see the same
  // (wrong) sum on both sides and report healthy, while a per-workspace
  // comparison catches it. This is the piece the first test above cannot
  // isolate on its own, since dropping entry_counts_update there also
  // flips the trigger-liveness signal, which alone is enough to trigger a
  // repair regardless of what the counter comparison finds.
  it("MUTATION-KILLER: catches per-workspace drift even with every trigger intact and live", async () => {
    d1 = makeSqliteD1();
    insertEntry(d1, "e1", "ws-a");
    // Tamper the row directly: global SUM(n) still equals count(*) (both 1),
    // but the split across workspaces is wrong — ws-a should be 1, ws-b 0.
    await d1.db.prepare(`UPDATE entry_counts SET workspace_id = 'ws-b' WHERE workspace_id = 'ws-a'`).run();
    const totals = await d1.db.prepare(
      `SELECT (SELECT COALESCE(SUM(n),0) FROM entry_counts) AS cached, (SELECT count(*) FROM entries) AS actual`,
    ).first() as { cached: number; actual: number };
    expect(totals.cached).toBe(totals.actual); // a global-only check would call this healthy
    expect(await countsOf(d1)).toEqual({ "ws-b": 1 }); // provably wrong: e1 is in ws-a

    expect(await checkFtsIntegrity(envFor(d1))).toEqual({ healthy: true });

    expect(await countsOf(d1)).toEqual({ "ws-a": 1 }); // repaired to the true split
  });
});
