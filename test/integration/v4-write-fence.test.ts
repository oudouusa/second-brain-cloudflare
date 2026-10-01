import { afterEach, describe, expect, it } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { memoryWriteMarker } from "../../src/migration/write-lock";

let db: SqliteD1;
afterEach(() => db?.close());

describe("4.0履歴・ゴミ箱・検索ログの書込み境界", () => {
  for (const table of ["entry_versions", "entries_trash", "recall_log"] as const) {
    it(`${table} はmarkerなしと旧epochを拒否し、期限付き復旧leaseのみ許す`, async () => {
      db = makeSqliteD1();
      const base = makeTestEnv(undefined, { DB: db.db as unknown as D1Database });
      const env = db.admitEnv(base);
      const fields = table === "entry_versions"
        ? ["entry_id", "seq", "content", "tags", "reason", "created_at"]
        : table === "entries_trash" ? ["id", "content", "row_json", "deleted_at"]
        : ["id", "workspace_id", "created_at", "channel", "query", "params", "returned_ids"];
      const values = table === "entry_versions" ? ["e", 1, "old", "[]", "update", 1]
        : table === "entries_trash" ? ["e", "old", "{}", 1]
        : ["e", "", 1, "rest", "query", "{}", "[]"];
      const insert = (marker: string | null, lease: string | null = null) => env.DB.prepare(
        `INSERT INTO ${table} (${fields.join(",")}, write_marker, restore_lease_owner) VALUES (${fields.map(() => "?").join(",")}, ?, ?)`,
      ).bind(...values, marker, lease).run();
      await expect(insert(null)).rejects.toThrow("memory-write-locked");
      const stale = memoryWriteMarker(env);
      await db.db.prepare("UPDATE memory_write_epoch SET generation = 'new-epoch' WHERE id = 'current'").run();
      await expect(insert(stale)).rejects.toThrow("memory-write-locked");
      await db.db.prepare(`INSERT INTO restore_state (id, backup_id, run_id, started_at, lease_owner, lease_expires_at) VALUES ('r2-v1', 'backup', 'run', 1, 'lease', ?)`)
        .bind(Date.now() + 60_000).run();
      await expect(insert(null, "wrong")).rejects.toThrow("memory-write-locked");
      await expect(insert(null, "lease")).resolves.toMatchObject({ success: true });
      await expect(env.DB.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow("memory-write-locked");
    });
  }

  it("validityだけの更新でも現在のadmissionと新markerを要求する", async () => {
    db = makeSqliteD1();
    await db.db.prepare("INSERT INTO entries (id, content, created_at) VALUES ('e', 'c', 1)").run();
    const base = makeTestEnv(undefined, { DB: db.db as unknown as D1Database });
    await expect(base.DB.prepare("UPDATE entries SET valid_until = 2, write_marker = NULL WHERE id = 'e'").run()).rejects.toThrow("memory-write-locked");
    const env = db.admitEnv(base);
    await expect(env.DB.prepare("UPDATE entries SET valid_until = 2, write_marker = ? WHERE id = 'e'").bind(memoryWriteMarker(env)).run()).resolves.toMatchObject({ success: true });
    await env.DB.prepare("INSERT INTO migration_control (id, locked_at, reason) VALUES ('memory-write-lock', 1, 'test')").run();
    await expect(env.DB.prepare("UPDATE entries SET valid_from = 1, write_marker = ? WHERE id = 'e'").bind(memoryWriteMarker(env)).run()).rejects.toThrow("memory-write-locked");
  });
});
