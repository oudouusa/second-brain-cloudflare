import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";

let d1: SqliteD1;
const envFor = (sqlite: SqliteD1, kv: KVNamespace = makeMemoryKV()) =>
  makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv });
const objectNames = async () =>
  ((await d1.db.prepare(`SELECT name FROM sqlite_master`).all()).results as { name: string }[]).map(r => r.name);
const columnNames = async (table: string) =>
  ((await d1.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()).results as { name: string }[]).map(r => r.name);
const insertVersion = (over: Record<string, unknown> = {}) => {
  const v = { entry_id: "e1", seq: 1, content: "old", prior_length: null, tags: "[]", reason: "update", created_at: 10, ...over };
  return d1.db.prepare(
    `INSERT INTO entry_versions (entry_id, seq, content, prior_length, tags, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(v.entry_id, v.seq, v.content, v.prior_length, v.tags, v.reason, v.created_at).run();
};
const plan = async (sql: string) =>
  ((await d1.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()).results as { detail: string }[]).map(r => r.detail).join("\n");

beforeEach(() => { resetDatabaseInit(); d1 = makeSqliteD1(); });
afterEach(() => { d1.close(); });

describe("entry_versions and entries_trash schema", () => {
  it("creates entry_versions and entries_trash with their indexes on a fresh brain", async () => {
    d1.close();
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));
    const names = await objectNames();
    for (const n of ["entry_versions", "idx_entry_versions_entry", "entries_trash", "idx_entries_trash_deleted"]) expect(names).toContain(n);
    // ADV-10: a brain with no entry_versions at all (a 3.7.0-shaped database included) gets
    // prior_length_utf16 in the CREATE, not by a later ALTER.
    expect(await columnNames("entry_versions")).toContain("prior_length_utf16");
  });

  it("creates them on a brain that predates them (init adds only what is missing)", async () => {
    await d1.db.exec(`DELETE FROM schema_meta; DROP TABLE entry_versions; DROP TABLE entries_trash`);
    expect(await objectNames()).not.toContain("entry_versions");
    await initializeDatabase(envFor(d1));
    const names = await objectNames();
    for (const n of ["entry_versions", "idx_entry_versions_entry", "entries_trash", "idx_entries_trash_deleted"]) expect(names).toContain(n);
  });

  it("ADV-10: an entry_versions table from before prior_length_utf16 existed gains it by ALTER, and a second cold start issues only the probe", async () => {
    // A dev brain that ran init on a commit before prior_length_utf16 shipped: entry_versions
    // exists, but narrower than db/schema.sql declares today (frozen shape, matching
    // test/unit/schema-upgrade-completeness.test.ts's LEGACY_SHAPES.entry_versions).
    await d1.db.exec(`DELETE FROM schema_meta; DROP TABLE entry_versions`);
    await d1.db.exec(
      `CREATE TABLE entry_versions (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL, content TEXT, prior_length INTEGER, tags TEXT NOT NULL, state TEXT NOT NULL DEFAULT '{}', actor_id TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', valid_from INTEGER, created_at INTEGER NOT NULL, CHECK ((content IS NULL) <> (prior_length IS NULL)))`,
    );
    await d1.db.exec(`CREATE UNIQUE INDEX idx_entry_versions_entry ON entry_versions(entry_id, seq)`);
    expect(await columnNames("entry_versions")).not.toContain("prior_length_utf16");

    await initializeDatabase(envFor(d1));
    expect(await columnNames("entry_versions")).toContain("prior_length_utf16");
    // The ALTER actually took, not just reported: a write binding the new column succeeds.
    await d1.db.prepare(
      `INSERT INTO entry_versions (entry_id, seq, content, prior_length, prior_length_utf16, tags, reason, created_at) VALUES ('e1', 1, NULL, 3, 3, '[]', 'update', 10)`,
    ).run();

    // Second cold start: the column is already there, so nothing beyond the probe is issued.
    resetDatabaseInit();
    d1.issued.length = 0;
    await initializeDatabase(envFor(d1));
    expect(d1.issued).toHaveLength(1);
    expect(d1.issued[0]).toMatch(/^SELECT version\b/);
  });

  it("entry_versions rejects a duplicate (entry_id, seq)", async () => {
    await insertVersion();
    await expect(insertVersion({ content: "other" })).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insertVersion({ entry_id: "e2" })).resolves.toBeDefined();
  });

  it("entry_versions rejects both or neither of content and prior_length", async () => {
    await expect(insertVersion({ content: "x", prior_length: 3 })).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertVersion({ seq: 2, content: null, prior_length: null })).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertVersion({ seq: 3, content: null, prior_length: 3 })).resolves.toBeDefined();
  });

  it("entry_versions has no automatic primary-key index", async () => {
    const idx = (await d1.db.prepare(`SELECT name, origin FROM pragma_index_list('entry_versions')`).all()).results as { name: string; origin: string }[];
    expect(idx).toEqual([{ name: "idx_entry_versions_entry", origin: "c" }]);
  });

  it("history reads use idx_entry_versions_entry", async () => {
    expect(await plan(`SELECT seq FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq DESC LIMIT 5`)).toMatch(/idx_entry_versions_entry/);
    expect(await plan(`SELECT MAX(seq) FROM entry_versions WHERE entry_id = 'e1'`)).toMatch(/idx_entry_versions_entry/);
  });

  it("the trash age query uses idx_entries_trash_deleted", async () => {
    expect(await plan(`SELECT id FROM entries_trash WHERE deleted_at < 5 ORDER BY deleted_at LIMIT 10`)).toMatch(/idx_entries_trash_deleted/);
  });

  it("state defaults to {} and accepts JSON", async () => {
    await insertVersion();
    await d1.db.prepare(`INSERT INTO entry_versions (entry_id, seq, content, tags, state, reason, created_at) VALUES ('e1', 2, 'x', '[]', ?, 'due', 11)`)
      .bind(JSON.stringify({ when_at: 5, when_kind: "due", when_source: null, when_label: null })).run();
    const rows = (await d1.db.prepare(`SELECT seq, state FROM entry_versions ORDER BY seq`).all()).results as { seq: number; state: string }[];
    expect(rows[0].state).toBe("{}");
    expect(JSON.parse(rows[1].state)).toMatchObject({ when_at: 5, when_kind: "due" });
  });

  it("entries_trash defaults match the design", async () => {
    await d1.db.prepare(`INSERT INTO entries_trash (id, content, row_json, deleted_at) VALUES ('t1', 'c', '{}', 1)`).run();
    const row = await d1.db.prepare(`SELECT workspace_id, actor_id, edges_json, deleted_by, channel, reason FROM entries_trash WHERE id = 't1'`).first();
    expect(row).toEqual({ workspace_id: "", actor_id: "", edges_json: "[]", deleted_by: "", channel: "", reason: "forget" });
  });
});

describe("versions:since", () => {
  it("init writes versions:since on fresh and upgraded brains, once", async () => {
    // Fresh: nothing exists before init.
    d1.close();
    d1 = makeSqliteD1({ schema: false });
    let kv = makeMemoryKV();
    await initializeDatabase(envFor(d1, kv));
    const fresh = await kv.get(VERSIONS_SINCE_KV_KEY);
    expect(Number(fresh)).toBeGreaterThan(0);

    // Later isolate on the same brain: table present, so the value is not rewritten.
    resetDatabaseInit();
    await kv.put(VERSIONS_SINCE_KV_KEY, "123");
    await initializeDatabase(envFor(d1, kv));
    expect(await kv.get(VERSIONS_SINCE_KV_KEY)).toBe("123");

    // Upgraded: an existing 3.7.0-shaped brain without the tables.
    resetDatabaseInit();
    d1.close();
    d1 = makeSqliteD1();
    await d1.db.exec(`DELETE FROM schema_meta; DROP TABLE entry_versions; DROP TABLE entries_trash`);
    kv = makeMemoryKV();
    await initializeDatabase(envFor(d1, kv));
    expect(Number(await kv.get(VERSIONS_SINCE_KV_KEY))).toBeGreaterThan(0);
  });

  it("a failed probe never writes versions:since", async () => {
    const kv = makeMemoryKV();
    await d1.db.exec(`DELETE FROM schema_meta`);
    const failingProbe = {
      ...d1.db,
      prepare: (sql: string) => /^WITH schema_groups/.test(sql)
        ? { all: async () => { throw new Error("probe down"); } }
        : d1.db.prepare(sql),
    };
    await initializeDatabase(makeTestEnv(undefined, { DB: failingProbe as unknown as D1Database, OAUTH_KV: kv }));
    expect(await kv.get(VERSIONS_SINCE_KV_KEY)).toBeNull();
  });

  it("a KV failure while writing versions:since does not fail init", async () => {
    d1.close();
    d1 = makeSqliteD1({ schema: false });
    const kv = makeMemoryKV();
    kv.put = async () => { throw new Error("kv down"); };
    await expect(initializeDatabase(envFor(d1, kv))).resolves.toMatchObject({ changed: true });
  });
});
