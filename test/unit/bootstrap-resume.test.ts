import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { createNightlyD1Budget, D1BudgetExceededError } from "../../src/runtime/d1-budget";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

// Workers Free では 1 回の呼び出しで D1 クエリは 50 まで（batch 内の各文も 1 つと数える）。
// 空の D1 の初期化は 101 文あるため、最初の呼び出しは上限で途中終了する。applySchema は
// probe で既存オブジェクトを飛ばし、version を完成時にだけ書くので、次の呼び出しが続きから
// 再開して同じ定義に収束する。ここではその性質を、上限の位置を変えながら固定する。
// 上限は fork の D1 予算で模す。予算を超えた文は実行されずに例外になる。

const baseline = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/write-protection-ddl-v4-baseline.json"), "utf8"));
const catalogueSql = `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name`;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function finalState(d1: SqliteD1) {
  const objects = (await d1.db.prepare(catalogueSql).all()).results;
  const version = await d1.db.prepare(`SELECT version FROM schema_meta WHERE id = 'current'`).first();
  return { sqliteMasterSha256: sha256(objects), objectCount: objects.length, version };
}

/** 1 回の Worker 呼び出しを模す：新しい isolate（memo なし）と、呼び出しごとの D1 上限。 */
async function invoke(d1: SqliteD1, kv: KVNamespace, limit: number) {
  resetDatabaseInit();
  const base = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: kv });
  const budget = createNightlyD1Budget(base, limit);
  try {
    await initializeDatabase(budget.env);
    return { completed: true, used: budget.stats().used };
  } catch (error) {
    if (!(error instanceof D1BudgetExceededError)) throw error;
    return { completed: false, used: budget.stats().used };
  }
}

describe("空の D1 の初期化は呼び出しごとの上限で途中終了しても再開して完成する", () => {
  afterEach(() => resetDatabaseInit());

  // 再開した呼び出しは version 読取りと probe を毎回払うため、上限によって完成までの
  // 回数が変わる（実測：50 文なら 50→49 の 2 回、45 文なら 41→45→15 の 3 回）。
  it.each([50, 45])("上限 %i 文でも数回の呼び出しで完成し、1 回で完成した場合と同じ定義になる", async (limit) => {
    const d1 = makeSqliteD1({ schema: false });
    const kv = makeMemoryKV();
    try {
      const calls = [];
      for (let i = 0; i < 4; i++) {
        const call = await invoke(d1, kv, limit);
        calls.push(call);
        if (call.completed) break;
      }
      expect(calls.at(-1)?.completed).toBe(true);
      expect(calls.length).toBeLessThanOrEqual(4);
      expect(calls.every(call => call.used <= limit)).toBe(true);
      expect(await finalState(d1)).toEqual({
        sqliteMasterSha256: baseline.fresh.sqliteMasterSha256,
        objectCount: baseline.fresh.objectCount,
        version: baseline.fresh.schemaVersion,
      });
      // 完成後の cold start は version の読取り 1 文で終わる。
      const steady = await invoke(d1, kv, limit);
      expect(steady).toEqual({ completed: true, used: 1 });
    } finally {
      d1.close();
    }
  });

  it("どの文の位置で上限に当たっても、次の呼び出しで同じ定義と version に収束する", async () => {
    // 予算の最小値は解放予約の 3 文。1〜2 文目は version 読取りと probe で DDL を含まない。
    for (let limit = 3; limit < baseline.fresh.statementCount; limit++) {
      const d1 = makeSqliteD1({ schema: false });
      const kv = makeMemoryKV();
      try {
        const first = await invoke(d1, kv, limit);
        expect(first.completed, `limit=${limit}`).toBe(false);
        // 未完成の間は version を書かない。
        const pending = await d1.db.prepare(
          `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'`,
        ).first() as { n: number } | null;
        if (pending?.n) {
          expect(await d1.db.prepare(`SELECT version FROM schema_meta WHERE id = 'current'`).first(), `limit=${limit}`).toBeNull();
        }
        const second = await invoke(d1, kv, 1_000);
        expect(second.completed, `limit=${limit}`).toBe(true);
        expect(await finalState(d1), `limit=${limit}`).toEqual({
          sqliteMasterSha256: baseline.fresh.sqliteMasterSha256,
          objectCount: baseline.fresh.objectCount,
          version: baseline.fresh.schemaVersion,
        });
      } finally {
        d1.close();
      }
    }
  });
});
