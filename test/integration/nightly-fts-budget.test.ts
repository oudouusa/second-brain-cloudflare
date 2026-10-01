import { describe, expect, it } from "vitest";
import { createNightlyD1Budget, remainingD1Sql, reserveD1Sql, recordD1BaseEnv } from "../../src/runtime/d1-budget";
import { withFtsWriteGuard } from "../../src/db/fts-write-guard";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

describe("夜間の FTS 修復と SQL 予算", () => {
  it("失敗した書込み、修復 SQL、再試行を同じ有限予算へ計上する", async () => {
    const sqlite = makeSqliteD1();
    try {
      await sqlite.db.exec("DROP TABLE entries_fts");
      const base = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });
      // HTTP が先に同じ binding を包んだ isolate でも二重ガードにしない。
      withFtsWriteGuard(recordD1BaseEnv(base));
      const rawPrepare = base.DB.prepare;
      const rawBatch = base.DB.batch;
      const budget = createNightlyD1Budget(base, 20, withFtsWriteGuard);
      expect(base.DB.prepare).toBe(rawPrepare);
      expect(base.DB.batch).toBe(rawBatch);
      const child = reserveD1Sql(budget.env, 12);
      expect(child).not.toBeNull();
      expect(remainingD1Sql(budget.env)).toBe(8);
      expect(remainingD1Sql(child!.env)).toBe(12);

      await child!.env.DB.prepare("INSERT INTO entries (id, content, created_at) VALUES ('e1', 'orchid', 1)").run();

      // 失敗 1、entry_counts の健全性確認 1、FTS trigger の停止 3、再試行 1。
      expect(budget.stats().used).toBe(6);
      expect(remainingD1Sql(child!.env)).toBe(6);
      expect(sqlite.rows().map(row => row.id)).toEqual(["e1"]);
      expect(base.DB.prepare).toBe(rawPrepare);
      expect(base.DB.batch).toBe(rawBatch);
      child!.release();
      expect(remainingD1Sql(budget.env)).toBe(14);
    } finally {
      sqlite.close();
    }
  });

  it("CAS 不一致と失効した書込み許可を FTS 修復で成功に変えない", async () => {
    const sqlite = makeSqliteD1();
    try {
      sqlite.seed({ id: "e1", content: "original", createdAt: 1 });
      await sqlite.db.exec("DROP TABLE entries_fts");
      const base = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });
      const rawPrepare = base.DB.prepare;
      const rawBatch = base.DB.batch;
      const budget = createNightlyD1Budget(base, 20, withFtsWriteGuard);
      expect(base.DB.prepare).toBe(rawPrepare);
      expect(base.DB.batch).toBe(rawBatch);
      const cas = await budget.env.DB.prepare(
        "UPDATE entries SET content = 'changed', write_marker = ? WHERE id = 'e1' AND content = 'different'",
      ).bind(sqlite.fixtureMarker()).run();
      expect(cas.meta.changes).toBe(0);
      // SQLite はゼロ件 UPDATE でも壊れた trigger 本体を評価する。
      // 修復後の再試行も CAS 不一致のままで、更新は発生しない。
      expect(budget.stats().used).toBe(6);
      await expect(budget.env.DB.prepare(
        "UPDATE entries SET content = 'changed', write_marker = 'expired:write:1' WHERE id = 'e1'",
      ).run()).rejects.toThrow("memory-write-locked");
      // 修復後も失効した許可の UPDATE は拒否され、本文は変わらない。
      expect(budget.stats().used).toBe(7);
      expect(sqlite.rows()[0].content).toBe("original");
      expect(base.DB.prepare).toBe(rawPrepare);
      expect(base.DB.batch).toBe(rawBatch);
    } finally {
      sqlite.close();
    }
  });
});
