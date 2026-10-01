import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ENTRY_ROW_COLUMNS, restoreColumnsSql, rowJsonSql } from "../../src/memory/entry-columns";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

async function liveColumns() {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database })) as Env;
  await initializeDatabase(env);
  const info = await env.DB.prepare(`PRAGMA table_info(entries)`).all() as any;
  sqlite.close();
  return info.results as { name: string; notnull: number; dflt_value: string | null; pk: number }[];
}

describe("ENTRY_ROW_COLUMNS", () => {
  it("本文・索引・一時capabilityを除く全列を保存する", async () => {
    const live = (await liveColumns()).map((c) => c.name).filter((n) => !["id", "content", "vector_ids", "write_marker", "restore_lease_owner", "migration_lease_owner"].includes(n));
    expect(ENTRY_ROW_COLUMNS.map((c) => c.name).sort()).toEqual(live.sort());
  });

  it("carries a restore default exactly where the schema has one, and every NOT NULL column except created_at has one", async () => {
    const live = await liveColumns();
    for (const c of ENTRY_ROW_COLUMNS) {
      const col = live.find((l) => l.name === c.name)!;
      expect(c.notNull, `${c.name} notNull`).toBe(col.notnull === 1);
      expect(c.default ?? null, `${c.name} default`).toBe(col.dflt_value);
      if (c.notNull && c.name !== "created_at") expect(c.default, `${c.name} needs a default`).toBeDefined();
    }
  });

  it("builds a json_object over every column and a restore expression per column", () => {
    expect(rowJsonSql("e").match(/'[a-z_]+', e\./g)).toHaveLength(ENTRY_ROW_COLUMNS.length);
    const { names, exprs } = restoreColumnsSql("t");
    expect(names.split(", ")).toHaveLength(ENTRY_ROW_COLUMNS.length);
    expect(exprs.match(/json_type\(t\.row_json/g)).toHaveLength(ENTRY_ROW_COLUMNS.length);
  });
});
