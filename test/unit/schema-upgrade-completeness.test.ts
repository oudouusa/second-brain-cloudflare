/**
 * The guard the schema-parity tests structurally cannot be.
 *
 * test/unit/db-init.test.ts and test/integration/graph-read-budget.test.ts both
 * compare the two-file reference schema against `src/db/init.ts`. Those agreeing says
 * nothing about the database an upgraded brain is actually running: the SQL files
 * run only in local fresh-DB tests, and init.ts's
 * `CREATE TABLE IF NOT EXISTS` is a no-op the moment the table exists. A column
 * added to a table that already shipped therefore reaches every NEW brain and no
 * EXISTING one, and both declarations agree the whole time. That is how
 * admin_events lost target_user_id and workspace_id on a live brain while every
 * parity test stayed green.
 *
 * So this asks the only question that distinguishes the two: take a database
 * carrying an EARLIER version of a table, run the real initialisation against
 * it, and require that every column the reference SQL declares today is there
 * afterwards — and that a write binding all of them lands.
 *
 * The legacy shapes below are frozen historical DDL, deliberately not derived
 * from the reference SQL. Deriving them would make this test vacuous: a newly added
 * column would appear in the "old" table too and there would be nothing to
 * migrate. Frozen, a column added to either SQL file without a matching entry in
 * init.ts's ALTER maps fails here on the next run, which is the whole point.
 * Adding a TABLE fails the coverage test until its shape is recorded here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { readReferenceSchema } from "../helpers/reference-schema";

/**
 * Every table shape a brain could have been created with before the columns it
 * carries today existed, keyed by table.
 *
 * Where a table has never gained a column its entry is simply today's shape —
 * which is not filler: it is what makes the FIRST column added to that table
 * fail here rather than silently only reaching new brains.
 */
const LEGACY_SHAPES: Record<string, string> = {
  schema_meta: `CREATE TABLE schema_meta (id TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL)`,
  // v1. Everything after vector_ids arrived by ALTER.
  entries: `CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`,
  // Issue #16, before v3 denormalised the workspace onto each edge.
  edges: `CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'relates_to', weight REAL NOT NULL DEFAULT 0.5, provenance TEXT NOT NULL DEFAULT 'inferred', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(source_id, target_id, type))`,
  // Never widened since it shipped.
  insight_candidates: `CREATE TABLE insight_candidates (id TEXT PRIMARY KEY, a_id TEXT NOT NULL, b_id TEXT NOT NULL, similarity REAL NOT NULL, gap_ms INTEGER NOT NULL, score REAL NOT NULL, signal TEXT NOT NULL DEFAULT 'vector', status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, UNIQUE(a_id, b_id))`,
  workspaces: `CREATE TABLE workspaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'personal', name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
  // Added with Prompt Capsule caching and never widened since.
  prompt_capsule_revisions: `CREATE TABLE prompt_capsule_revisions (workspace_id TEXT PRIMARY KEY, revision TEXT NOT NULL)`,
  // v3 as first provisioned: default_share, removed_at and last_used_at all
  // arrived afterwards, against team brains that already had members in them.
  users: `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT, role TEXT NOT NULL DEFAULT 'member', token_hash TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  memberships: `CREATE TABLE memberships (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL, PRIMARY KEY (user_id, workspace_id))`,
  entry_events: `CREATE TABLE entry_events (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, actor_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  // The regression this file exists for: shipped with five columns, gained
  // target_user_id and workspace_id a release later.
  admin_events: `CREATE TABLE admin_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  maintenance_cursor: `CREATE TABLE maintenance_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), workspace_id TEXT NOT NULL DEFAULT '', advanced_at INTEGER NOT NULL DEFAULT 0)`,
  // Existing single-purpose infrastructure tables. Shapes with a comment below
  // predate a later ALTER; the rest have never widened since first release.
  migration_control: `CREATE TABLE migration_control (id TEXT PRIMARY KEY, locked_at INTEGER NOT NULL, reason TEXT NOT NULL)`,
  memory_write_admissions: `CREATE TABLE memory_write_admissions (token TEXT PRIMARY KEY, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  memory_write_epoch: `CREATE TABLE memory_write_epoch (id TEXT PRIMARY KEY, generation TEXT NOT NULL)`,
  embedding_migration_generation: `CREATE TABLE embedding_migration_generation (id TEXT PRIMARY KEY, generation TEXT NOT NULL)`,
  integration_state_generation: `CREATE TABLE integration_state_generation (id TEXT PRIMARY KEY, generation TEXT NOT NULL, restore_count INTEGER NOT NULL DEFAULT 0)`,
  integration_provider_generation: `CREATE TABLE integration_provider_generation (provider TEXT PRIMARY KEY, generation TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, draining INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at INTEGER)`,
  oauth_registration_quota: `CREATE TABLE oauth_registration_quota (id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, registration_count INTEGER NOT NULL)`,
  vector_cleanup_ops: `CREATE TABLE vector_cleanup_ops (op_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, vector_ids TEXT NOT NULL, created_at INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`,
  append_receipts: `CREATE TABLE append_receipts (entry_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, indexed INTEGER NOT NULL, completed_at INTEGER NOT NULL)`,
  restore_state: `CREATE TABLE restore_state (id TEXT PRIMARY KEY, backup_id TEXT NOT NULL, started_at INTEGER NOT NULL, next_offset INTEGER NOT NULL DEFAULT 0, next_edge_offset INTEGER NOT NULL DEFAULT 0, completed_at INTEGER)`,
  // Projects registry. Never widened since it shipped.
  projects: `CREATE TABLE projects (id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', aliases TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER, PRIMARY KEY (workspace_id, id))`,
  // Web Push subscriptions. Never widened since it shipped.
  push_subscriptions: `CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT '', endpoint_hash TEXT NOT NULL, subscription_json TEXT NOT NULL, content_free INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_ok_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0, UNIQUE(endpoint_hash))`,
  // Sampled recall log (T-0089.5.2). Never widened since it shipped.
  recall_log: `CREATE TABLE recall_log (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL, channel TEXT NOT NULL, query TEXT NOT NULL, params TEXT NOT NULL, returned_ids TEXT NOT NULL, followed_ids TEXT NOT NULL DEFAULT '[]')`,
  // Content history (4.0). Gained prior_length_utf16 a release later (T-0089.1.1, ADV-10).
  entry_versions: `CREATE TABLE entry_versions (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL, content TEXT, prior_length INTEGER, tags TEXT NOT NULL, state TEXT NOT NULL DEFAULT '{}', actor_id TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', valid_from INTEGER, created_at INTEGER NOT NULL, CHECK ((content IS NULL) <> (prior_length IS NULL)))`,
  // Soft delete (4.0). Never widened since it shipped.
  entries_trash: `CREATE TABLE entries_trash (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, row_json TEXT NOT NULL, edges_json TEXT NOT NULL DEFAULT '[]', vector_ids TEXT NOT NULL DEFAULT '[]', deleted_at INTEGER NOT NULL, deleted_by TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT 'forget')`,
};

/** `-- …` line comments, without mistaking a "--" inside a string literal for one. */
function stripSqlComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") { inString = true; out += ch; continue; }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Table-level constraints, which sit in the column list but are not columns. */
const CONSTRAINT_KEYWORDS = new Set(["primary", "unique", "check", "foreign", "constraint"]);

/** Column name -> declared type, per table, as the reference SQL declares them today. */
function declaredTables(sql: string): Record<string, Record<string, string>> {
  const tables: Record<string, Record<string, string>> = {};
  // entry_counts is an atomic derived-index unit covered by db-init tests. Its
  // one-line CREATE used to sit at EOF; after the reference schema was split it
  // would otherwise consume the next file's first multiline CREATE.
  const declarations = stripSqlComments(sql).replace(/CREATE TABLE IF NOT EXISTS entry_counts \([^;]*\);/g, "");
  for (const match of declarations.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
    const [, table, body] = match;
    const columns: Record<string, string> = {};
    let depth = 0;
    let current = "";
    const parts: string[] = [];
    for (const ch of body) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
      current += ch;
    }
    parts.push(current);
    for (const part of parts) {
      const [name, type] = part.trim().split(/\s+/);
      // `UNIQUE(a, b)` has no space before its paren, so split on it too — the
      // first token of a table constraint has to be recognised as a keyword
      // rather than taken for a column called `UNIQUE(a,`.
      if (!name || CONSTRAINT_KEYWORDS.has(name.split("(")[0].toLowerCase())) continue;
      columns[name] = (type ?? "TEXT").toUpperCase();
    }
    tables[table] = columns;
  }
  return tables;
}

const DECLARED = declaredTables(readReferenceSchema());

/** A value SQLite will accept for a column of this declared type. */
const sampleFor = (type: string, index: number): string | number =>
  type.startsWith("INT") ? index : type.startsWith("REAL") ? 0.5 : `v${index}`;
/**
 * entry_versions carries two CHECKs: (content IS NULL) <> (prior_length IS NULL), so a full copy
 * leaves prior_length NULL; and prior_length_utf16 IS NULL OR prior_length IS NOT NULL, so it must
 * stay NULL right alongside it.
 */
const sampleForColumn = (table: string, column: string, type: string, index: number): string | number | null =>
  table === "entry_versions" && (column === "prior_length" || column === "prior_length_utf16") ? null : sampleFor(type, index);

describe("an existing database gains every column db/schema.sql declares", () => {
  let d1: SqliteD1;
  const envFor = (sqlite: SqliteD1) => makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });

  beforeEach(resetDatabaseInit);
  afterEach(() => { d1?.close(); });

  it("has a recorded earlier shape for every table schema.sql declares", () => {
    // A new table with no entry here would otherwise be exempt from the whole
    // guard the moment it gains its first column.
    expect(Object.keys(LEGACY_SHAPES).sort()).toEqual(Object.keys(DECLARED).sort());
  });

  for (const [table, legacyDdl] of Object.entries(LEGACY_SHAPES)) {
    it(`migrates a pre-existing ${table} to today's columns without losing its rows`, async () => {
      const declared = DECLARED[table];
      // Guards the fixture itself: a legacy shape naming a column the table no
      // longer declares means one was renamed or dropped, and this test would
      // otherwise be asserting against a table nothing in production has.
      const legacyColumns = Object.keys(declaredTables(`${legacyDdl.replace(/\)$/, "\n);")}`)[table]);
      expect(declared).toBeDefined();
      expect(legacyColumns.filter(c => !(c in declared))).toEqual([]);

      d1 = makeSqliteD1({ schema: false });
      await d1.db.exec(legacyDdl);
      // One row written by the release that shipped this shape. It must survive,
      // and it must be readable through the columns the table gains.
      const legacyValues = legacyColumns.map((c, i) =>
        table === "schema_meta" && c === "version" ? 1 : sampleForColumn(table, c, declared[c], i + 1));
      await d1.db
        .prepare(`INSERT INTO ${table} (${legacyColumns.join(", ")}) VALUES (${legacyColumns.map(() => "?").join(", ")})`)
        .bind(...legacyValues)
        .run();

      await initializeDatabase(envFor(d1));

      const after = ((await d1.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all())
        .results as { name: string }[]).map(c => c.name);
      const missing = Object.keys(declared).filter(c => !after.includes(c));
      // The message names the fix: an ALTER map entry in src/db/init.ts, not a
      // wider CREATE, which an existing table never reaches.
      expect(missing, `${table} is missing ${missing.join(", ")} after init — db/schema.sql declares ${
        Object.keys(declared).length} columns but src/db/init.ts has no ALTER TABLE ${table} ADD COLUMN for these, so only fresh brains get them`).toEqual([]);

      const row = await d1.db.prepare(`SELECT ${legacyColumns.join(", ")} FROM ${table}`).first() as Record<string, unknown>;
      const expected = Object.fromEntries(legacyColumns.map((c, i) => [c, legacyValues[i]]));
      if (table === "prompt_capsule_revisions") {
        // 欠落したトリガーの復旧時には、古いキャッシュを失効させる。
        // ワークスペースの行を保持し、リビジョンだけを再生成する。
        expect(row.revision).toMatch(/^[0-9a-f]{32}$/);
        expect(row.revision).not.toBe(expected.revision);
        expect(row).toEqual({ ...expected, revision: row.revision });
      } else {
        // その他の既存データは書き換えずに保持する。
        expect(row).toEqual(expected);
      }

      // Existence of the columns is the mechanism; a write that binds all of
      // them is the behaviour every caller depends on. OR REPLACE only so the
      // fixture row's key constraints do not decide the outcome.
      const columns = Object.keys(declared);
      const values = columns.map((c, i) => {
        if (c === "write_marker") return d1.fixtureMarker();
        if (table === "maintenance_cursor" && c === "id") return 1;
        return sampleForColumn(table, c, declared[c], i + 100);
      });
      if (table === "edges") {
        const sourceId = String(values[columns.indexOf("source_id")]);
        const targetId = String(values[columns.indexOf("target_id")]);
        for (const id of [sourceId, targetId]) {
          await d1.db.prepare(
            `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, write_marker)
             VALUES (?, ?, '[]', 'test', 1, '[]', ?)`,
          ).bind(id, id, d1.fixtureMarker()).run();
        }
      }
      await expect(
        d1.db
          .prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
          .bind(...values)
          .run(),
      ).resolves.toMatchObject({ success: true });
    });
  }
});
