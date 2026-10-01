import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATABASE_SCHEMA_VERSION, initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const baselinePath = resolve(import.meta.dirname, "../fixtures/write-protection-ddl-v4-baseline.json");
const catalogueSql = `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name`;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function catalogue(d1: SqliteD1) {
  return (await d1.db.prepare(catalogueSql).all()).results as {
    type: string; name: string; tbl_name: string; sql: string | null;
  }[];
}

async function runUpgrade(version: "fresh" | "v3" | "v7") {
  resetDatabaseInit();
  const d1 = makeSqliteD1({ schema: false });
  try {
    if (version !== "fresh") {
      await d1.db.exec(readFileSync(resolve(import.meta.dirname, `../fixtures/schema-${version}.sql`), "utf8"));
      if (version === "v7") d1.seed({ id: "v7-existing", content: "preserve", createdAt: 1 });
    }
    d1.issued.length = 0;
    const result = await initializeDatabase(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database }));
    const statements = [...d1.issued];
    const objects = await catalogue(d1);
    const schemaVersion = await d1.db.prepare(`SELECT version FROM schema_meta WHERE id = 'current'`).first();
    const existingContent = version === "v7"
      ? await d1.db.prepare(`SELECT content FROM entries WHERE id = 'v7-existing'`).first()
      : undefined;
    return { result, statements, objects, schemaVersion, existingContent };
  } finally {
    d1.close();
    resetDatabaseInit();
  }
}

describe("4.0 DDL の初期化・旧版移行との完全一致", () => {
  afterEach(() => resetDatabaseInit());

  it("空 DB と v3/v7 DB の SQL 列・sqlite_master を固定する", async () => {
    expect(DATABASE_SCHEMA_VERSION).toBe(9);
    const fresh = await runUpgrade("fresh");
    const v3 = await runUpgrade("v3");
    const v7 = await runUpgrade("v7");
    const reference = makeSqliteD1();
    let referenceObjects: { type: string; name: string; tbl_name: string; sql: string | null }[];
    try { referenceObjects = await catalogue(reference); }
    finally { reference.close(); }
    const expected = JSON.parse(readFileSync(baselinePath, "utf8"));
    const snapshot = (value: typeof fresh) => ({
      result: value.result,
      schemaVersion: value.schemaVersion,
      statementCount: value.statements.length,
      statementsSha256: sha256(value.statements),
      objectCount: value.objects.length,
      sqliteMasterSha256: sha256(value.objects),
    });
    expect(snapshot(fresh)).toEqual(expected.fresh);
    expect(snapshot(v3)).toEqual(expected.v3);
    expect(snapshot(v7)).toEqual(expected.v7);
    expect(v7.existingContent).toEqual({ content: "preserve" });
    expect(referenceObjects).toHaveLength(expected.referenceObjectCount);
    expect(sha256(referenceObjects)).toBe(expected.referenceSqliteMasterSha256);
    // 参照DDLの差分は日付index 1個のみ。残る129 objectは旧hashと完全一致する。
    expect(referenceObjects.find(object => object.name === "idx_entries_when")).toEqual({
      type: "index", name: "idx_entries_when", tbl_name: "entries",
      sql: "CREATE INDEX idx_entries_when ON entries(workspace_id, when_at) WHERE when_at IS NOT NULL",
    });
    expect(sha256(referenceObjects.filter(object => object.name !== "idx_entries_when")))
      .toBe("d6657c13a67fcea14bd519400396a8ad1dacca83072346be91f89db498cf7769");
    // The v9 bootstrap issues 101 SQL statements, including nine derived-index
    // statements. It exceeds the Free 50-query invocation limit; bootstrap-resume.test.ts
    // fixes that a cut at any statement resumes to this same definition.
    expect(fresh.statements).toHaveLength(101);
    const trigger = v3.statements.findIndex(sql => sql.includes("CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_source_update_v9"));
    const obsolete = v3.statements.findIndex(sql => sql === "DROP TRIGGER IF EXISTS trg_entries_write_fence_source_update_v6");
    expect(trigger).toBeGreaterThanOrEqual(0);
    expect(obsolete).toBeGreaterThan(trigger);
  });
});
