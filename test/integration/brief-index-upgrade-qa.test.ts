/**
 * QA: a brain that already carries the pre-index schema upgrades by creating the four brief
 * indexes and nothing else. No row of the entries table is written by the upgrade itself
 * (the only cost is the one-time index build, measured on workerd when EVAL_WORKERD=1).
 */
import { describe, it, expect, afterAll } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import type { Env } from "../../src/env";

afterAll(cleanTemp);
const NEW_INDEXES = ["idx_entries_when", "idx_entries_task", "idx_entries_insight", "idx_entries_stale"];

async function seed(db: D1Database, n: number, marker: string) {
  await db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, workspace_id, actor_id, when_at, when_kind, when_source, write_marker)
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?)
    SELECT 'e'||x, 'memory '||x,
      CASE WHEN x % 20 = 0 THEN '["task","work"]' WHEN x % 50 = 1 THEN '["auto-insight"]' WHEN x % 100 = 2 THEN '["work","stale:as-of"]' ELSE '["work","kind:semantic"]' END,
      'api', 1000 + x, '["v"]', 0, 3, 'ws', 'u1',
      CASE WHEN x % 200 = 0 THEN 5000 ELSE NULL END, CASE WHEN x % 200 = 0 THEN 'due' ELSE NULL END, CASE WHEN x % 200 = 0 THEN 'explicit' ELSE NULL END, ?
    FROM c`).bind(n, marker).run();
}
const indexNames = async (db: D1Database) =>
  ((await db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_entries_%'`).all<{ name: string }>()).results ?? []).map(r => r.name);

describe("upgrade of a database without the brief indexes", () => {
  it("creates exactly the four indexes and issues no row write against entries (real SQLite)", async () => {
    const sq = makeSqliteD1();
    try {
      resetDatabaseInit();
      const env = sq.admitEnv(makeTestEnv(undefined, { DB: sq.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
      await initializeDatabase(env);
      await seed(sq.db as unknown as D1Database, 300, sq.fixtureMarker());
      for (const name of NEW_INDEXES) await sq.db.prepare(`DROP INDEX ${name}`).run();
      const before = await indexNames(sq.db as unknown as D1Database);
      expect(before).not.toContain("idx_entries_task");
      const rowsBefore = JSON.stringify(sq.rows());
      // schema9のsteady probeではなく、brief導入前のupgrade経路を検証する。
      await sq.db.prepare("UPDATE schema_meta SET version = 8 WHERE id = 'current'").run();
      resetDatabaseInit();
      sq.issued.length = 0;
      await initializeDatabase(env);
      const writes = sq.issued.filter(s => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(s) && /\b(?:INTO|UPDATE|FROM) entries\b/i.test(s));
      expect(writes).toEqual([]);
      const creates = sq.issued.filter(s => /^\s*CREATE/i.test(s));
      expect(creates.map(s => /idx_entries_\w+/.exec(s)?.[0]).sort()).toEqual([...NEW_INDEXES].sort());
      expect(await indexNames(sq.db as unknown as D1Database)).toEqual(expect.arrayContaining(NEW_INDEXES));
      expect(JSON.stringify(sq.rows())).toBe(rowsBefore);
      // a second boot is a no-op
      resetDatabaseInit();
      sq.issued.length = 0;
      await initializeDatabase(env);
      expect(sq.issued.filter(s => /^\s*CREATE/i.test(s))).toEqual([]);
    } finally { sq.close(); }
  });

  it.runIf(process.env.EVAL_WORKERD === "1")("one-time index build cost on workerd", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      await initializeDatabase(env);
      await seed(d1.db, 2000, "manual-workerd-fixture");
      for (const name of NEW_INDEXES) await d1.db.prepare(`DROP INDEX ${name}`).run();
      // init.ts creates these through exec(), which returns no meta, so run the same DDL through
      // prepare().run() to read what D1 would bill for the one-time build.
      const ddl = [
        `CREATE INDEX IF NOT EXISTS idx_entries_when ON entries(workspace_id, when_at) WHERE when_at IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_entries_task ON entries(workspace_id, created_at) WHERE instr(lower(tags), '"task"') > 0`,
        `CREATE INDEX IF NOT EXISTS idx_entries_insight ON entries(workspace_id, created_at) WHERE instr(lower(tags), '"auto-insight"') > 0`,
        `CREATE INDEX IF NOT EXISTS idx_entries_stale ON entries(workspace_id, id) WHERE instr(lower(tags), '"stale:as-of"') > 0`,
      ];
      let written = 0;
      for (const q of ddl) written += ((await d1.db.prepare(q).run()).meta.rows_written ?? 0);
      console.log(`INDEX_BUILD rows_written=${written} for 2000 memories (100 task, 40 insight, 20 stale, 10 dated)`);
      expect(await indexNames(d1.db)).toEqual(expect.arrayContaining(NEW_INDEXES));
      expect(written).toBeGreaterThan(0);
      expect(written).toBeLessThan(400);
    } finally { await d1.close(); }
  }, 120_000);
});
