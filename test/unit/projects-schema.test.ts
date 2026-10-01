import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

type Named = { name: string };

const columnsOf = async (d1: SqliteD1, table: string) =>
  ((await d1.db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY cid`).all())
    .results as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]);

const indexDefinition = async (d1: SqliteD1, name: string) =>
  (await d1.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).bind(name).first()) as { sql: string } | null;

describe("projects schema", () => {
  let d1: SqliteD1;
  const envFor = (sqlite: SqliteD1) => makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });

  beforeEach(resetDatabaseInit);
  afterEach(() => { d1?.close(); });

  it("db/schema.sql creates projects keyed by (workspace_id, id)", async () => {
    d1 = makeSqliteD1();
    const cols = await columnsOf(d1, "projects");

    expect(cols.map(c => c.name)).toEqual(["id", "workspace_id", "name", "description", "aliases", "status", "created_at", "updated_at", "restore_lease_owner", "write_marker"]);
    const pk = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    expect(pk).toEqual(["workspace_id", "id"]);
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));
    expect(byName.description.dflt_value).toBe("''");
    expect(byName.aliases.dflt_value).toBe("'[]'");
    expect(byName.status.dflt_value).toBe("'active'");
    expect(byName.updated_at.notnull).toBe(0);
    expect(byName.created_at.notnull).toBe(1);
  });

  it("db/schema.sql creates the workspace/status index and the entries partial index", async () => {
    d1 = makeSqliteD1();

    expect((await indexDefinition(d1, "idx_projects_workspace"))?.sql).toMatch(/ON projects\(workspace_id, status\)/);
    const partial = (await indexDefinition(d1, "idx_entries_project"))?.sql ?? "";
    expect(partial).toMatch(/ON entries\(workspace_id, id\)/);
    expect(partial).toContain(`WHERE instr(lower(tags), '"project:') > 0`);
  });

  it("the partial index can serve the membership scan the counts endpoint issues", async () => {
    d1 = makeSqliteD1();
    // INDEXED BY throws if SQLite cannot use the index for the predicate, which is the claim.
    const plan = (await d1.db
      .prepare(`EXPLAIN QUERY PLAN SELECT id, tags FROM entries INDEXED BY idx_entries_project WHERE workspace_id IN (?) AND instr(lower(tags), '"project:') > 0 LIMIT 5000`)
      .bind("w")
      .all()).results as { detail: string }[];

    expect(plan.map(p => p.detail).join("\n")).toContain("idx_entries_project");
  });

  it("initializeDatabase creates both on a brain that predates projects", async () => {
    // v1 entries: no workspace_id yet, so the partial index can only be built after the ALTERs.
    d1 = makeSqliteD1({ schema: false });
    await d1.db.exec(
      `CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`,
    );

    await initializeDatabase(envFor(d1));

    const names = ((await d1.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index')`).all()).results as Named[]).map(r => r.name);
    expect(names).toContain("projects");
    expect(names).toContain("idx_projects_workspace");
    expect(names).toContain("idx_entries_project");
  });

  it("runtime init and db/schema.sql agree on the projects table and both indexes", async () => {
    d1 = makeSqliteD1();
    const fromInit = makeSqliteD1({ schema: false });
    try {
      await initializeDatabase(envFor(fromInit));

      expect(await columnsOf(fromInit, "projects")).toEqual(await columnsOf(d1, "projects"));
      for (const name of ["idx_projects_workspace", "idx_entries_project"]) {
        const a = (await indexDefinition(fromInit, name))?.sql.replace(/\s+/g, " ").replace("IF NOT EXISTS ", "");
        const b = (await indexDefinition(d1, name))?.sql.replace(/\s+/g, " ").replace("IF NOT EXISTS ", "");
        expect(a, name).toBeDefined();
        expect(a).toBe(b);
      }
    } finally {
      fromInit.close();
    }
  });

  it("rejects a second row for the same (workspace_id, id) and allows the same slug across workspaces", async () => {
    d1 = makeSqliteD1();
    const insert = (ws: string, id: string) =>
      d1.db.prepare(`INSERT INTO projects (id, workspace_id, name, created_at) VALUES (?, ?, ?, 1)`).bind(id, ws, id).run();

    await insert("w1", "website");
    await insert("w2", "website");
    await expect(insert("w1", "website")).rejects.toThrow(/UNIQUE/i);
  });
});
