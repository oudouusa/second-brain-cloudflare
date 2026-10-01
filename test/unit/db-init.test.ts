import { hashToken, resolveIdentityFromToken } from "../../src/lib/identity";
import { ENTRY_COUNTS_TABLE_DDL, ENTRY_COUNTS_INSERT_TRIGGER_DDL, ENTRY_COUNTS_UPDATE_TRIGGER_DDL, ENTRY_COUNTS_DELETE_TRIGGER_DDL } from "../../src/db/init";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DATABASE_SCHEMA_VERSION,
  initializeDatabase,
  resetDatabaseInit,
} from "../../src/db/init";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { readReferenceSchema } from "../helpers/reference-schema";
import { beginMemoryWriteAdmission, memoryWriteMarker } from "../../src/migration/write-lock";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY, VERSIONS_SINCE_KV_KEY } from "../../src/constants";

const MIGRATION: [column: string, alter: string][] = [
  ["recall_count", `ALTER TABLE entries ADD COLUMN recall_count INTEGER DEFAULT 0`],
  ["importance_score", `ALTER TABLE entries ADD COLUMN importance_score INTEGER DEFAULT 0`],
  ["contradiction_wins", `ALTER TABLE entries ADD COLUMN contradiction_wins INTEGER DEFAULT 0`],
  ["contradiction_losses", `ALTER TABLE entries ADD COLUMN contradiction_losses INTEGER DEFAULT 0`],
  ["updated_at", `ALTER TABLE entries ADD COLUMN updated_at INTEGER`],
  ["staleness_checked_at", `ALTER TABLE entries ADD COLUMN staleness_checked_at INTEGER`],
  ["memory_tier", `ALTER TABLE entries ADD COLUMN memory_tier TEXT DEFAULT 'warm'`],
  ["pinned", `ALTER TABLE entries ADD COLUMN pinned INTEGER DEFAULT 0`],
  ["last_recalled_at", `ALTER TABLE entries ADD COLUMN last_recalled_at INTEGER`],
  ["restore_lease_owner", `ALTER TABLE entries ADD COLUMN restore_lease_owner TEXT`],
  ["migration_lease_owner", `ALTER TABLE entries ADD COLUMN migration_lease_owner TEXT`],
  ["write_marker", `ALTER TABLE entries ADD COLUMN write_marker TEXT`],
  ["workspace_id", `ALTER TABLE entries ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`],
  ["actor_id", `ALTER TABLE entries ADD COLUMN actor_id TEXT NOT NULL DEFAULT ''`],
  ["pending_append_passages", `ALTER TABLE entries ADD COLUMN pending_append_passages TEXT NOT NULL DEFAULT '[]'`],
  ["when_at", `ALTER TABLE entries ADD COLUMN when_at INTEGER`],
  ["when_kind", `ALTER TABLE entries ADD COLUMN when_kind TEXT`],
  ["when_source", `ALTER TABLE entries ADD COLUMN when_source TEXT`],
  ["when_label", `ALTER TABLE entries ADD COLUMN when_label TEXT`],
  ["valid_from", `ALTER TABLE entries ADD COLUMN valid_from INTEGER`],
  ["valid_until", `ALTER TABLE entries ADD COLUMN valid_until INTEGER`],
];
// Tenancy (v3) ALTERs exist for upgraded brains, but on fresh brains these columns
// ship inside the base CREATE (see BASE_COLUMNS), so unlike MIGRATION they are not
// part of the "columns a migrated brain carries beyond its base" fingerprint.
const TENANCY_EDGE_ALTERS: [column: string, alter: string][] = [
  ["workspace_id", `ALTER TABLE edges ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`],
];
const USERS_ALTERS: [column: string, alter: string][] = [
  ["default_share", `ALTER TABLE users ADD COLUMN default_share TEXT NOT NULL DEFAULT ''`],
  ["removed_at", `ALTER TABLE users ADD COLUMN removed_at INTEGER`],
  ["last_used_at", `ALTER TABLE users ADD COLUMN last_used_at INTEGER`],
];
// admin_events shipped without its two subject columns; a brain that wrote a single
// administration event before they existed has the narrow table, and the audit writer
// binds all seven. Same shape as the users ALTERs above.
const ADMIN_EVENTS_ALTERS: [column: string, alter: string][] = [
  ["target_user_id", `ALTER TABLE admin_events ADD COLUMN target_user_id TEXT NOT NULL DEFAULT ''`],
  ["workspace_id", `ALTER TABLE admin_events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`],
];
// entry_versions shipped without prior_length_utf16; a brain that wrote a version before it
// existed has the narrow table (T-0089.1.1, ADV-10).
const ENTRY_VERSIONS_ALTERS: [column: string, alter: string][] = [
  ["prior_length_utf16", `ALTER TABLE entry_versions ADD COLUMN prior_length_utf16 INTEGER`],
];
// entries_trash shipped without nonce; a brain that trashed an entry before it existed
// has the narrow table (T-0089.1.1, adv-final MAJOR 1).
const ENTRIES_TRASH_ALTERS: [column: string, alter: string][] = [
  ["nonce", `ALTER TABLE entries_trash ADD COLUMN nonce TEXT NOT NULL DEFAULT ''`],
];
const ALL_COLUMNS = MIGRATION.map(([column]) => column);
const TRIGGER_DDL = new Map([...readReferenceSchema().matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)[\s\S]*?END;/g)].map(m => [m[1], m[0].slice(0, -1)]));
const PROMPT_CAPSULE_TRIGGERS = [
  "prompt_capsule_entry_insert",
  "prompt_capsule_entry_update",
  "prompt_capsule_entry_delete",
  "prompt_capsule_workspace_delete",
];
const EDGE_MIGRATIONS = [
  ["restore_lease_owner", `ALTER TABLE edges ADD COLUMN restore_lease_owner TEXT`],
  ["write_marker", `ALTER TABLE edges ADD COLUMN write_marker TEXT`],
] as const;
const RESTORE_COLUMNS = ["id", "backup_id", "backup_sha256", "run_id", "started_at", "next_offset", "next_edge_offset", "next_project_offset", "next_history_offset", "completed_at", "lease_owner", "lease_expires_at"];
const BASE_OBJECTS = ["schema_meta", "entries", "idx_entries_created_at", "idx_entries_source", "edges", "idx_edges_target", "idx_edges_weight", "insight_candidates", "idx_insight_candidates_queue", "migration_control", "memory_write_epoch", "memory_write_admissions", "restore_state", "embedding_migration_generation", "integration_state_generation", "integration_provider_generation", "oauth_registration_quota", "vector_cleanup_ops", "append_receipts", "workspaces", "users", "idx_users_email", "memberships", "idx_memberships_workspace", "entry_events", "idx_entry_events_entry", "idx_entry_events_created", "admin_events", "idx_admin_events_created", "maintenance_cursor", "idx_entries_workspace_created"];
const WRITE_FENCE_TRIGGERS = [
  "trg_edges_endpoint_guard_v1",
  "trg_entries_write_fence_insert_v5", "trg_entries_write_fence_source_update_v9",
  "trg_entries_write_fence_vector_update_v7", "trg_entries_write_fence_delete_v5",
  "trg_edges_write_fence_insert_v5", "trg_edges_write_fence_update_v5", "trg_edges_write_fence_delete_v5",
  "trg_insight_candidates_write_fence_insert_v5", "trg_insight_candidates_write_fence_update_v5",
  "trg_insight_candidates_write_fence_delete_v5", "trg_vector_cleanup_write_fence_insert_v1",
  "trg_vector_cleanup_write_fence_update_v1", "trg_vector_cleanup_write_fence_delete_v1",
];
const FTS_OBJECTS = ["entries_fts", "entries_fts_insert", "entries_fts_update", "entries_fts_delete", "entry_counts", "entry_counts_insert", "entry_counts_update", "entry_counts_delete"];
// Lexical recall index (FTS5, trigram). entries_fts and its three sync
// triggers are NOT in SCHEMA_OBJECTS/POST_COLUMN_OBJECTS (ownership v2.2):
// they are created together, in their own dedicated batch, in applySchema.
const FTS_TRIGGERS = ["entries_fts_insert", "entries_fts_update", "entries_fts_delete"];
// Exact per-workspace entry counters (T-0065). Same ownership rule as
// entries_fts above: entry_counts and its three triggers are created
// together in their own dedicated batch, never via SCHEMA_OBJECTS/
// POST_COLUMN_OBJECTS (the triggers reference entries.workspace_id, which
// arrives by ALTER on a legacy brain, so the batch runs after that ALTER).
const ENTRY_COUNTS_TRIGGERS = ["entry_counts_insert", "entry_counts_update", "entry_counts_delete"];
const ALL_OBJECTS = [...BASE_OBJECTS, ...WRITE_FENCE_TRIGGERS, "entries", "idx_entries_created_at", "idx_entries_source", "edges", "idx_edges_target", "idx_edges_weight", "insight_candidates", "idx_insight_candidates_queue",
  // Team edition (v3). idx_entries_workspace_created is deliberately last-applied
  // (POST_COLUMN_OBJECTS): it indexes a column that arrives via ALTER.
  "workspaces", "prompt_capsule_revisions", "idx_workspaces_kind", "users", "idx_users_email",
  "memberships", "idx_memberships_workspace", "entry_events", "idx_entry_events_entry", "idx_entry_events_created",
  "idx_entry_events_actor", "idx_entry_events_held", "idx_entry_events_life_end",
  "admin_events", "idx_admin_events_created", "maintenance_cursor", "idx_entries_workspace_created", "idx_entries_capsule",
  // Projects registry; idx_entries_project is post-column like the capsule index.
  "projects", "idx_projects_workspace", "idx_entries_project",
  // Held draft digests (T-0089.4.4); post-column like the capsule and project indexes.
  "idx_entries_conflict_held",
  // Agent brief queues (T-0089.6): partial indexes, post-column.
  "idx_entries_when", "idx_entries_task", "idx_entries_insight", "idx_entries_stale",
  // Decision ledger and standing memory (T-0089.7.1, T-0089.7.2): partial indexes, post-column.
  "idx_entries_ledger", "idx_entries_standing",
  // Web Push subscriptions.
  "push_subscriptions", "idx_push_subscriptions_workspace",
  // Sampled recall log (T-0089.5.2 Part A).
  "recall_log", "idx_recall_log_ws",
  // Content history and soft delete (T-0089.1.1, T-0089.1.2).
  "entry_versions", "idx_entry_versions_entry", "entries_trash", "idx_entries_trash_deleted", "idx_entries_trash_workspace_deleted",
  // Trigram document counts that price distillation's df counts.
  "entries_fts_vocab",
  "entries_fts",
  "entry_counts",
  ...PROMPT_CAPSULE_TRIGGERS,
  ...FTS_TRIGGERS,
  ...ENTRY_COUNTS_TRIGGERS];
// Columns in the base CREATE of entries since v3 — present on every brain init touches.
const BASE_COLUMNS = ["id", "content", "tags", "source", "created_at", "vector_ids"];
/** Every object + column a fully-migrated brain reports through the probe. */
const FULLY_MIGRATED = {
  objects: ALL_OBJECTS,
  entryColumns: ALL_COLUMNS,
  edgeColumns: [...EDGE_MIGRATIONS.map(([c]) => c), ...TENANCY_EDGE_ALTERS.map(([c]) => c)],
  userColumns: USERS_ALTERS.map(([c]) => c),
  adminEventColumns: ADMIN_EVENTS_ALTERS.map(([c]) => c),
  entryVersionColumns: ENTRY_VERSIONS_ALTERS.map(([c]) => c),
  entriesTrashColumns: ENTRIES_TRASH_ALTERS.map(([c]) => c),
};

/** The catalogue read that opens every init. Spelled out so tests can exclude it by name. */
const PROBE = /^WITH schema_groups\b/;
const SCHEMA_VERSION_READ = /^SELECT version\b/;
const SCHEMA_VERSION_WRITE = /^INSERT INTO schema_meta\b/;
const isSchemaBookkeeping = (sql: string) => PROBE.test(sql)
  || SCHEMA_VERSION_READ.test(sql)
  || SCHEMA_VERSION_WRITE.test(sql);
const isDerivedIndexSetup = (sql: string) => /^(?:CREATE (?:VIRTUAL )?(?:TABLE|TRIGGER)|INSERT INTO entry_counts)\b/.test(sql)
  && /\b(?:entries_fts|entry_counts)\b/.test(sql);
const DERIVED_INDEX_SETUP_STATEMENTS = 9; // FTS table + 3 triggers; counts table + 3 triggers + seed.

type Row = { created_at: number; updated_at?: number | null };

// D1Mock's exec() never throws, so it cannot express "this column already exists".
// This stand-in models what the migration path turns on, verified against real workerd
// D1 via Miniflare: D1 rejects an ALTER for a column the table already has, a column
// added to a populated table reads NULL on every pre-existing row, and the probe reports
// exactly the tables, indexes, triggers, and columns that are there. Every statement is recorded so
// a test can assert what a cold start costs — ALTERs are recorded even when they throw.
//
// `objects` defaults from the columns: a brain carrying migration columns necessarily has
// the table they sit on, and a brain carrying none is the fresh case where nothing exists.
// Pass it explicitly for anything in between.
function makeMigrationDb(existingColumns: string[] = [], rows: Row[] = [], existingObjects?: string[], existingEdgeColumns: string[] = [], existingUserColumns: string[] = [], existingAdminEventColumns: string[] = [], existingEntryVersionColumns: string[] = [], existingEntriesTrashColumns: string[] = []) {
  const columns = new Set(existingColumns.length ? [...BASE_COLUMNS, ...existingColumns] : []);
  const complete = existingColumns.includes("write_marker");
  const objects = new Set(existingObjects ?? (existingColumns.length ? (complete ? ALL_OBJECTS : BASE_OBJECTS) : []));
  const edgeColumns = new Set(objects.has("edges") ? [
    "id", "source_id", "target_id", "type", "weight", "provenance", "metadata", "created_at", "updated_at",
    ...(complete ? ["restore_lease_owner", "write_marker"] : []),
  ] : []);
  for (const column of existingEdgeColumns) edgeColumns.add(column);
  const userColumns = new Set(existingUserColumns.length
    ? existingUserColumns
    : objects.has("users") && complete ? USERS_ALTERS.map(([column]) => column) : []);
  const adminEventColumns = new Set(existingAdminEventColumns.length
    ? existingAdminEventColumns
    : objects.has("admin_events") && complete ? ADMIN_EVENTS_ALTERS.map(([column]) => column) : []);
  const insightColumns = new Set(objects.has("insight_candidates") && complete ? ["write_marker"] : []);
  const admissionColumns = new Set(objects.has("memory_write_admissions") && complete ? ["generation"] : []);
  const cleanupColumns = new Set(objects.has("vector_cleanup_ops") && complete ? ["write_marker"] : []);
  const restoreColumns = new Set(objects.has("restore_state") ? RESTORE_COLUMNS : []);
  const migrationColumns = new Set(objects.has("migration_control") && complete
    ? ["owner_id", "final_delta_completed_at", "active_delta_token", "active_delta_expires_at"]
    : []);
  const entryVersionColumns = new Set(existingEntryVersionColumns);
  const entriesTrashColumns = new Set(existingEntriesTrashColumns);
  const execd: string[] = [];
  const prepared: string[] = [];
  let schemaVersion: number | null = complete && objects.has("schema_meta")
    ? DATABASE_SCHEMA_VERSION
    : null;

  const recordCreatedObject = (sql: string) => {
    const created = sql.match(/CREATE (?:VIRTUAL )?(?:UNIQUE )?(?:TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?(\w+)/);
    if (!created) return;
    objects.add(created[1]);
    if (created[1] === "entries") BASE_COLUMNS.forEach(c => columns.add(c));
    if (created[1] === "edges") TENANCY_EDGE_ALTERS.forEach(([c]) => edgeColumns.add(c));
    if (created[1] === "users") USERS_ALTERS.forEach(([c]) => userColumns.add(c));
    if (created[1] === "admin_events") ADMIN_EVENTS_ALTERS.forEach(([c]) => adminEventColumns.add(c));
    if (created[1] === "entry_versions") ENTRY_VERSIONS_ALTERS.forEach(([c]) => entryVersionColumns.add(c));
    if (created[1] === "entries_trash") ENTRIES_TRASH_ALTERS.forEach(([c]) => entriesTrashColumns.add(c));
  };

  const DB = {
    async exec(sql: string) {
      execd.push(sql);
      const altered = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
      if (altered) {
        const [, table, column] = altered;
        const target = table === "edges" ? edgeColumns
          : table === "users" ? userColumns
            : table === "admin_events" ? adminEventColumns
              : table === "entry_versions" ? entryVersionColumns
                : table === "entries_trash" ? entriesTrashColumns : columns;
        if (target.has(column)) throw new Error(`D1_EXEC_ERROR: duplicate column name: ${column}`);
        target.add(column);
        if (table === "entries" && column === "updated_at") rows.forEach(r => { r.updated_at = null; });
        return;
      }
      const restoreAdded = sql.match(/ALTER TABLE restore_state ADD COLUMN (\w+)/);
      if (restoreAdded) {
        if (restoreColumns.has(restoreAdded[1])) throw new Error(`D1_EXEC_ERROR: duplicate column name: ${restoreAdded[1]}`);
        restoreColumns.add(restoreAdded[1]);
        return;
      }
      const edgeAdded = sql.match(/ALTER TABLE edges ADD COLUMN (\w+)/);
      if (edgeAdded) {
        if (edgeColumns.has(edgeAdded[1])) throw new Error(`D1_EXEC_ERROR: duplicate column name: ${edgeAdded[1]}`);
        edgeColumns.add(edgeAdded[1]);
        return;
      }
      const insightAdded = sql.match(/ALTER TABLE insight_candidates ADD COLUMN (\w+)/);
      if (insightAdded) {
        if (insightColumns.has(insightAdded[1])) throw new Error(`D1_EXEC_ERROR: duplicate column name: ${insightAdded[1]}`);
        insightColumns.add(insightAdded[1]);
        return;
      }
      const admissionAdded = sql.match(/ALTER TABLE memory_write_admissions ADD COLUMN (\w+)/);
      if (admissionAdded) {
        if (admissionColumns.has(admissionAdded[1])) throw new Error(`D1_EXEC_ERROR: duplicate column name: ${admissionAdded[1]}`);
        admissionColumns.add(admissionAdded[1]);
        return;
      }
      const cleanupAdded = sql.match(/ALTER TABLE vector_cleanup_ops ADD COLUMN (\w+)/);
      if (cleanupAdded) {
        if (cleanupColumns.has(cleanupAdded[1])) throw new Error(`D1_EXEC_ERROR: duplicate column name: ${cleanupAdded[1]}`);
        cleanupColumns.add(cleanupAdded[1]);
        return;
      }
      const migrationAdded = sql.match(/ALTER TABLE migration_control ADD COLUMN (\w+)/);
      if (migrationAdded) {
        if (migrationColumns.has(migrationAdded[1])) throw new Error(`D1_EXEC_ERROR: duplicate column name: ${migrationAdded[1]}`);
        migrationColumns.add(migrationAdded[1]);
        return;
      }
      const dropped = sql.match(/DROP TRIGGER IF EXISTS (\w+)/);
      if (dropped) {
        objects.delete(dropped[1]);
        return;
      }
      const created = sql.match(/CREATE (?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?(\w+)/);
      if (created) {
        objects.add(created[1]);
        if (created[1] === "entries") [...BASE_COLUMNS, ...ALL_COLUMNS].forEach(c => columns.add(c));
        if (created[1] === "edges") {
          ["id", "source_id", "target_id", "type", "weight", "provenance", "metadata", "created_at", "updated_at", "restore_lease_owner", "write_marker"]
            .forEach(c => edgeColumns.add(c));
        }
        if (created[1] === "insight_candidates") insightColumns.add("write_marker");
        if (created[1] === "memory_write_admissions") admissionColumns.add("generation");
        if (created[1] === "vector_cleanup_ops") cleanupColumns.add("write_marker");
        if (created[1] === "restore_state") RESTORE_COLUMNS.forEach(c => restoreColumns.add(c));
        if (created[1] === "migration_control") {
          ["owner_id", "final_delta_completed_at", "active_delta_token", "active_delta_expires_at"]
            .forEach(c => migrationColumns.add(c));
        }
      }
    },
    prepare(sql: string) {
      prepared.push(sql);
      const make = (args: unknown[]) => ({
        bind: (...next: unknown[]) => make(next),
        first: async () => SCHEMA_VERSION_READ.test(sql) && schemaVersion !== null
          ? { version: schemaVersion, capsule_definitions: JSON.stringify(Object.fromEntries([...TRIGGER_DDL, ["idx_entries_capsule", `CREATE INDEX idx_entries_capsule ON entries(workspace_id, id) WHERE instr(lower(tags), '"capsule:') > 0`]])) }
          : null,
        all: async () => ({
          results: SCHEMA_VERSION_READ.test(sql)
            ? (schemaVersion === null ? [] : [{ version: schemaVersion, capsule_definitions: JSON.stringify(Object.fromEntries([...TRIGGER_DDL, ["idx_entries_capsule", `CREATE INDEX idx_entries_capsule ON entries(workspace_id, id) WHERE instr(lower(tags), '"capsule:') > 0`]])) }])
            : PROBE.test(sql)
            ? [
              ...[...objects].map(name => ({
                kind: name.startsWith("idx_") ? "index" : (name.startsWith("trg_") || PROMPT_CAPSULE_TRIGGERS.includes(name) || name.startsWith("entries_fts_") || name.startsWith("entry_counts_")) ? "trigger" : "table",
                name,
                definition: name === "idx_entries_capsule" ? `CREATE INDEX IF NOT EXISTS idx_entries_capsule ON entries(workspace_id, id) WHERE instr(lower(tags), '"capsule:') > 0` : TRIGGER_DDL.get(name),
              })),
              ...[...columns].map(name => ({ kind: "entry_column", name })),
              ...[...edgeColumns].map(name => ({ kind: "edge_column", name })),
              ...[...insightColumns].map(name => ({ kind: "insight_column", name })),
              ...[...admissionColumns].map(name => ({ kind: "admission_column", name })),
              ...[...cleanupColumns].map(name => ({ kind: "cleanup_column", name })),
              ...[...restoreColumns].map(name => ({ kind: "restore_column", name })),
              ...[...migrationColumns].map(name => ({ kind: "migration_column", name })),
              ...[...userColumns].map(name => ({ kind: "user_column", name })),
              ...[...adminEventColumns].map(name => ({ kind: "admin_event_column", name })),
              ...[...entryVersionColumns].map(name => ({ kind: "entry_version_column", name })),
              ...[...entriesTrashColumns].map(name => ({ kind: "entries_trash_column", name })),
            ]
            : [],
        }),
        run: async () => {
          recordCreatedObject(sql);
          if (SCHEMA_VERSION_WRITE.test(sql)) schemaVersion = Number(args[0]);
          return { meta: { changes: 1 } };
        },
      });
      return make([]);
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;

  return { env: makeTestEnv(undefined, { DB }), execd, prepared, rows };
}

const rowsAged = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ created_at: 1000 + i }));
/** Statements that touch entry *rows*. The probe reads the catalogue, not the table. */
const touchesEntries = (statements: string[]) =>
  statements.filter(s => /\bentries\b/.test(s) && !/^(CREATE|ALTER)\b/.test(s) && !PROBE.test(s));

describe("initializeDatabase updated_at migration", () => {
  // initializeDatabase memoises per isolate, so each case needs a clean slate.
  beforeEach(resetDatabaseInit);

  // updated_at is added by ALTER and never backfilled. initializeDatabase runs on every
  // cold isolate, so the target property is absolute: it issues no read and no write
  // against entries on any path, on any brain. A probe would be a full table scan on an
  // unindexed column (D1 bills rows_read); a backfill would be one row written per entry
  // (D1 caps rows written per day) for a value no reader can distinguish from NULL.

  it("issues no entry-row query at all on a fresh, unmigrated brain", async () => {
    const { env, execd, prepared, rows } = makeMigrationDb([], rowsAged(3));

    await initializeDatabase(env);

    expect(prepared.filter(s => !isSchemaBookkeeping(s) && !s.startsWith("CREATE TRIGGER") && !isDerivedIndexSetup(s))).toEqual([]);
    expect(prepared.filter(isDerivedIndexSetup)).toHaveLength(DERIVED_INDEX_SETUP_STATEMENTS);
    expect(touchesEntries(execd)).toEqual([]);
    // The fixture's rows are intentionally impossible for an absent table; no
    // historical ALTER runs merely to mutate them.
    expect(rows.every(r => r.updated_at === undefined)).toBe(true);
  });

  it("issues no entry-row query at all on an already-migrated brain", async () => {
    const { env, execd, prepared } = makeMigrationDb(ALL_COLUMNS, [{ created_at: 1000, updated_at: 1000 }]);

    await initializeDatabase(env);

    expect(prepared.filter(s => !isSchemaBookkeeping(s) && !s.startsWith("CREATE TRIGGER") && !isDerivedIndexSetup(s))).toEqual([]);
    expect(touchesEntries(execd)).toEqual([]);
  });

  // #282. Twelve blind statements were spent per cold isolate discovering that a migrated
  // brain — every brain after its first request — needed none of them, out of a 50-per-
  // invocation free-plan budget that ensureDbReady spends inside the triggering request.
  describe("cost on a migrated brain", () => {
    it("costs one statement and issues no DDL when the schema is already complete", async () => {
      const { env, execd, prepared } = makeMigrationDb(
        FULLY_MIGRATED.entryColumns, rowsAged(1), FULLY_MIGRATED.objects, FULLY_MIGRATED.edgeColumns, FULLY_MIGRATED.userColumns, FULLY_MIGRATED.adminEventColumns, FULLY_MIGRATED.entryVersionColumns, FULLY_MIGRATED.entriesTrashColumns,
      );

      await initializeDatabase(env);

      expect(execd).toEqual([]);
      expect(prepared).toHaveLength(1);
      expect(prepared[0]).toMatch(SCHEMA_VERSION_READ);
    });

    it("costs one statement on every cold start after the first", async () => {
      const { env, execd, prepared } = makeMigrationDb([], rowsAged(1));

      // Each reset stands in for a fresh isolate, which is what a cold start actually is.
      await initializeDatabase(env);
      const initialExecCount = execd.length;
      const initialPreparedCount = prepared.length;
      const migrated = initialExecCount + initialPreparedCount;
      resetDatabaseInit();
      await initializeDatabase(env);
      resetDatabaseInit();
      await initializeDatabase(env);

      expect(migrated - DERIVED_INDEX_SETUP_STATEMENTS).toBeLessThanOrEqual(ALL_OBJECTS.length + MIGRATION.length + 40);
      expect(execd).toHaveLength(initialExecCount); // the two later cold starts added nothing
      // First cold start: version read + catalogue probe + version write. Later cold
      // starts: one single-row version read each.
      expect(prepared).toHaveLength(initialPreparedCount + 2);
      expect(touchesEntries(execd)).toEqual([]);
    });

    it("issues only the ALTERs a partially-migrated brain is missing", async () => {
      const present = ["recall_count", "importance_score"];
      const { env, execd, prepared } = makeMigrationDb(present, rowsAged(1));

      await initializeDatabase(env);

      const missing = MIGRATION.filter(([column]) => !present.includes(column));
      expect(execd.filter(sql => sql.startsWith("ALTER TABLE entries "))).toEqual(missing.map(([, alter]) => alter));
      for (const [, alter] of EDGE_MIGRATIONS) expect(execd).toContain(alter);
      for (const trigger of WRITE_FENCE_TRIGGERS) {
        expect(execd.some(sql => sql.includes(`TRIGGER IF NOT EXISTS ${trigger}`))).toBe(true);
      }
      expect(prepared).toHaveLength(7 + DERIVED_INDEX_SETUP_STATEMENTS);
    });
  });

  // All four nightly jobs await initializeDatabase inside one scheduled() invocation,
  // sharing a single subrequest budget. Without memoisation the work is paid for once per
  // job. Callers must still await real completion — ensureDbReady's waitUntil does not.
  describe("memoisation", () => {
    it("runs the schema work once per isolate no matter how many callers await it", async () => {
      const { env, execd, prepared } = makeMigrationDb([], rowsAged(1));

      await initializeDatabase(env);
      const once = execd.length;
      await Promise.all([initializeDatabase(env), initializeDatabase(env), initializeDatabase(env)]);

      expect(execd).toHaveLength(once);
      expect(prepared).toHaveLength(7 + DERIVED_INDEX_SETUP_STATEMENTS); // version read + probe + marker, once
    });

    it("shares one in-flight promise across concurrent callers", async () => {
      const { env, execd } = makeMigrationDb([], rowsAged(1));

      await Promise.all(Array.from({ length: 4 }, () => initializeDatabase(env)));

      expect(execd.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries ("))).toHaveLength(1);
    });

    it("resetDatabaseInit clears the memo so a later call redoes the work", async () => {
      // Named for what it actually exercises — the test seam, not the failure path. The
      // rejection tests below are the ones that cover failure.
      const { env, prepared } = makeMigrationDb([], rowsAged(1));

      await initializeDatabase(env);
      resetDatabaseInit();
      await initializeDatabase(env);

      expect(prepared).toHaveLength(8 + DERIVED_INDEX_SETUP_STATEMENTS); // first migration (3), then one fast version read
    });
  });

  // Regression: memoising on *completion* rather than on *success* latched a failed or
  // half-applied schema for the isolate's lifetime. Before memoisation each nightly job
  // re-ran the DDL and repaired the previous one's transient failure; these pin that a
  // failure is still retryable. Most likely trigger is a brand-new brain, where the very
  // first request must create every table against a D1 database made seconds earlier.
  describe("failure is not latched", () => {
    beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); });

    const statement = (all: () => Promise<unknown>) => {
      const value = {
        all,
        run: async () => ({ meta: { changes: 1 } }),
        bind: () => value,
      };
      return value;
    };
    const batch = async (statements: { run(): Promise<unknown> }[]) => {
      const results: unknown[] = [];
      for (const item of statements) results.push(await item.run());
      return results;
    };

    /** DB whose statements all fail until `failing` is cleared. */
    function flakyDb() {
      const state = { failing: true, execd: [] as string[] };
      const fail = () => { throw new Error("D1_ERROR: Network connection lost."); };
      const DB = {
        async exec(sql: string) {
          if (state.failing) fail();
          state.execd.push(sql);
        },
        prepare: () => statement(async () => (state.failing ? fail() : { results: [] })),
        batch,
      } as unknown as D1Database;
      return { state, env: makeTestEnv(undefined, { DB }) };
    }

    it("rejects rather than resolving when the schema could not be applied", async () => {
      const { env } = flakyDb();
      await expect(initializeDatabase(env)).rejects.toThrow(/Network connection lost/);
    });

    it("retries on the next call once D1 recovers", async () => {
      const { state, env } = flakyDb();

      await expect(initializeDatabase(env)).rejects.toThrow();
      state.failing = false;
      await initializeDatabase(env); // no resetDatabaseInit — the memo must have cleared itself

      expect(state.execd.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries ("))).toHaveLength(1);
    });

    it("rejects when a later statement fails, rather than latching a partial schema", async () => {
      // The edges CREATE fails; entries already exists. Resolving here would leave the
      // isolate believing a schema with no edges table is complete.
      const execd: string[] = [];
      let failEdges = true;
      const DB = {
        async exec(sql: string) {
          if (failEdges && sql.includes("CREATE TABLE IF NOT EXISTS edges")) throw new Error("D1_ERROR: Network connection lost.");
          execd.push(sql);
        },
        prepare: () => statement(async () => ({
          results: [
            { kind: "table", name: "entries" },
            ...BASE_COLUMNS.map(name => ({ kind: "entry_column", name })),
          ],
        })),
        batch,
      } as unknown as D1Database;
      const env = makeTestEnv(undefined, { DB });

      await expect(initializeDatabase(env)).rejects.toThrow();
      expect(execd.some(s => s.includes("CREATE TABLE IF NOT EXISTS edges"))).toBe(false);

      failEdges = false;
      await initializeDatabase(env);
      expect(execd.some(s => s.includes("CREATE TABLE IF NOT EXISTS edges"))).toBe(true);
    });

    it("still swallows the routine duplicate-column ALTER error", async () => {
      // The probe closes the ordinary case, but not the race: two isolates can cold-start
      // on the same brain at once, both read a schema without `updated_at`, and both try
      // to add it. The loser must not reject.
      const DB = {
        async exec(sql: string) {
          if (sql.startsWith("ALTER TABLE")) throw new Error("D1_EXEC_ERROR: duplicate column name: updated_at");
        },
        prepare: () => statement(async () => ({
          results: [
            { kind: "table", name: "entries" },
            ...BASE_COLUMNS.map(name => ({ kind: "entry_column", name })),
          ],
        })),
        batch,
      } as unknown as D1Database;

      await expect(initializeDatabase(makeTestEnv(undefined, { DB }))).resolves.toEqual({ changed: true });
    });

    it("rejects on an ALTER failure that is not duplicate-column", async () => {
      const DB = {
        async exec(sql: string) {
          if (sql.startsWith("ALTER TABLE entries ADD COLUMN importance_score")) {
            throw new Error("D1_ERROR: database is locked");
          }
        },
        prepare: () => statement(async () => ({
          results: [
            { kind: "table", name: "entries" },
            ...BASE_COLUMNS.map(name => ({ kind: "entry_column", name })),
          ],
        })),
      } as unknown as D1Database;

      await expect(initializeDatabase(makeTestEnv(undefined, { DB }))).rejects.toThrow(/database is locked/);
    });
  });

  it("applies every missing ALTER on a partially-migrated brain", async () => {
    const { env, execd, prepared } = makeMigrationDb(["recall_count", "importance_score"], rowsAged(1));

    await initializeDatabase(env);

    for (const [column, alter] of MIGRATION) {
      if (["recall_count", "importance_score"].includes(column)) continue;
      expect(execd).toContain(alter);
    }
    expect(prepared.filter(s => !isSchemaBookkeeping(s) && !s.startsWith("CREATE TRIGGER") && !isDerivedIndexSetup(s))).toEqual([]);
  });

  // The backfill this replaced wrote one row per entry. On a 50,000-entry brain that was
  // half of D1's daily row-write budget in a single statement, and exceeding the cap
  // fails every query account-wide until 00:00 UTC.
  it("never backfills, at any brain size", async () => {
    const { env, execd, prepared, rows } = makeMigrationDb([], rowsAged(50_000));

    await initializeDatabase(env);

    const all = [...execd, ...prepared];
    expect(all.filter(s => /UPDATE\s+entries/i.test(s))).toEqual([]);
    expect(all.filter(s => /updated_at IS NULL/i.test(s))).toEqual([]);
    expect(rows.filter(r => r.updated_at == null)).toHaveLength(50_000);
  });
});

/**
 * The probe against a real database.
 *
 * The failure that would actually hurt is a probe that reports a schema as PRESENT when
 * it is not: the DDL is skipped, initializeDatabase resolves, and a brand-new brain
 * serves every subsequent request against tables that were never created. No mock can
 * catch that — d1-mock's exec() is a no-op and the stand-in above answers its own probe —
 * so these run the real statements against real SQLite, which is what D1 is.
 */
describe("initializeDatabase against real SQLite", () => {
  let d1: SqliteD1;
  const envFor = (sqlite: SqliteD1) => makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });

  beforeEach(resetDatabaseInit);
  afterEach(() => { d1?.close(); vi.restoreAllMocks(); });

  async function objectNames(sqlite: SqliteD1): Promise<string[]> {
    const { results } = await sqlite.db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')`)
      .all() as { results: { name: string }[] };
    return results.map(r => r.name);
  }

  async function markSchemaStale(sqlite: SqliteD1): Promise<void> {
    await sqlite.db.prepare(
      `UPDATE schema_meta SET version = 0 WHERE id = 'current'`,
    ).run();
  }

  it("migrates a genuinely empty database", async () => {
    d1 = makeSqliteD1({ schema: false });
    expect(await objectNames(d1)).toEqual([]); // nothing at all, the state a new brain is in

    await initializeDatabase(envFor(d1));

    for (const name of ALL_OBJECTS) expect(await objectNames(d1)).toContain(name);
    await expect(d1.db.prepare(
      `INSERT INTO users (id, token_hash, email, created_at) VALUES ('u1', 'hash-1', 'one@example.com', 1)`,
    ).run()).resolves.toBeTruthy();
    await expect(d1.db.prepare(
      `INSERT INTO users (id, token_hash, email, created_at) VALUES ('u2', 'hash-1', 'two@example.com', 2)`,
    ).run()).rejects.toThrow(/UNIQUE constraint failed/i);
    await expect(d1.db.prepare(
      `INSERT INTO users (id, token_hash, email, created_at) VALUES ('u3', 'hash-3', 'one@example.com', 3)`,
    ).run()).rejects.toThrow(/UNIQUE constraint failed/i);
    expect(d1.columns()).toEqual(expect.arrayContaining([...BASE_COLUMNS, ...ALL_COLUMNS]));
    const restoreInfo = await d1.db.prepare(`PRAGMA table_info('restore_state')`).all() as {
      results: { name: string }[];
    };
    expect(restoreInfo.results.map(row => row.name)).toEqual(RESTORE_COLUMNS);
  });

  it("adds lease columns to the legacy restore ledger without rewriting its row", async () => {
    d1 = makeSqliteD1({ schema: false });
    await d1.db.exec(`CREATE TABLE restore_state (
      id TEXT PRIMARY KEY, backup_id TEXT NOT NULL, started_at INTEGER NOT NULL,
      next_offset INTEGER NOT NULL DEFAULT 0, next_edge_offset INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER)`);
    await d1.db.prepare(
      `INSERT INTO restore_state (id, backup_id, started_at, next_offset, next_edge_offset, completed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind("r2-v1", "2026/08/1787661296000", 1000, 40, 0).run();

    await initializeDatabase(envFor(d1));

    const row = await d1.db.prepare(
      `SELECT backup_id, backup_sha256, next_offset, run_id, lease_owner, lease_expires_at
         FROM restore_state WHERE id = 'r2-v1'`,
    ).first() as Record<string, unknown>;
    expect(row).toEqual({
      backup_id: "2026/08/1787661296000",
      backup_sha256: null,
      next_offset: 40,
      run_id: null,
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it("creates idx_entries_ledger and idx_entries_standing on a fresh brain, both empty", async () => {
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));

    const objects = (await d1.db.prepare(
      `SELECT name, type FROM sqlite_master WHERE name IN ('idx_entries_ledger','idx_entries_standing')`,
    ).all()).results as { name: string; type: string }[];
    expect(objects.map(o => o.name).sort()).toEqual(["idx_entries_ledger", "idx_entries_standing"]);
    expect(objects.every(o => o.type === "index")).toBe(true);

    // Neither tag exists yet on a fresh brain, so both partial indexes start empty (Design "Global constraints").
    await d1.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'ordinary', '["work"]', 'api', 1, '[]')`,
    ).run();
    const ledgerCount = (await d1.db.prepare(
      `SELECT COUNT(*) AS n FROM entries INDEXED BY idx_entries_ledger WHERE workspace_id = '' AND instr(lower(tags), '"ledger:decision"') > 0`,
    ).first()) as { n: number };
    const standingCount = (await d1.db.prepare(
      `SELECT COUNT(*) AS n FROM entries INDEXED BY idx_entries_standing WHERE workspace_id = '' AND instr(lower(tags), '"standing:active"') > 0`,
    ).first()) as { n: number };
    expect(ledgerCount.n).toBe(0);
    expect(standingCount.n).toBe(0);
  });

  it("advances Prompt Capsule revisions atomically on entry writes and workspace moves", async () => {
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));
    await d1.db.exec(
      `INSERT INTO workspaces (id, kind, name, created_at) VALUES ('ws-a', 'personal', 'A', 1);` +
      `INSERT INTO workspaces (id, kind, name, created_at) VALUES ('ws-b', 'company', 'B', 1);`,
    );

    const revision = async (workspaceId: string) => {
      const row = await d1.db.prepare(
        `SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?`,
      ).bind(workspaceId).first() as { revision: string } | null;
      return row?.revision ?? null;
    };

    await d1.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, ?, ?, 'api', 1, '[]', ?)`,
    ).bind("ordinary", "Ordinary", '["work"]', "ws-a").run();
    expect(await revision("ws-a")).toBeNull();

    await d1.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, ?, ?, 'api', 1, '[]', ?)`,
    ).bind(
      "capsule",
      "Initial",
      '["capsule:core","capsule-slot:identity","status:canonical"]',
      "ws-a",
    ).run();
    const afterInsert = await revision("ws-a");
    expect(afterInsert).toMatch(/^[0-9a-f]{32}$/);

    await d1.db.prepare(`UPDATE entries SET content = ? WHERE id = ?`)
      .bind("Updated", "capsule").run();
    const afterContentUpdate = await revision("ws-a");
    expect(afterContentUpdate).toMatch(/^[0-9a-f]{32}$/);
    expect(afterContentUpdate).not.toBe(afterInsert);

    await d1.db.prepare(`UPDATE entries SET id = ? WHERE id = ?`)
      .bind("capsule-renamed", "capsule").run();
    const afterIdUpdate = await revision("ws-a");
    expect(afterIdUpdate).toMatch(/^[0-9a-f]{32}$/);
    expect(afterIdUpdate).not.toBe(afterContentUpdate);

    await d1.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`)
      .bind("ws-b", "capsule-renamed").run();
    const afterMoveFromA = await revision("ws-a");
    const afterMoveToB = await revision("ws-b");
    expect(afterMoveFromA).toMatch(/^[0-9a-f]{32}$/);
    expect(afterMoveFromA).not.toBe(afterIdUpdate);
    expect(afterMoveToB).toMatch(/^[0-9a-f]{32}$/);

    await d1.db.prepare(`UPDATE entries SET write_marker = ? WHERE id = ?`)
      .bind(d1.fixtureMarker("delete"), "capsule-renamed").run();
    await d1.db.prepare(`DELETE FROM entries WHERE id = ?`).bind("capsule-renamed").run();
    const afterDelete = await revision("ws-b");
    expect(afterDelete).toMatch(/^[0-9a-f]{32}$/);
    expect(afterDelete).not.toBe(afterMoveToB);

    await d1.db.prepare(`DELETE FROM workspaces WHERE id = ?`).bind("ws-b").run();
    expect(await revision("ws-b")).toBeNull();
  });

  it("leaves a migrated database usable, not merely present", async () => {
    // The tables existing is not the claim worth making — the claim is that the columns
    // every reader selects are really there. A missing ALTER passes an existence check
    // and then fails at the first SELECT.
    d1 = makeSqliteD1({ schema: false });
    const env = envFor(d1);
    await initializeDatabase(env);
    const admitted = await beginMemoryWriteAdmission(
      env,
      { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext,
    );

    await d1.db
      .prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, write_marker) VALUES (?, ?, '[]', 'api', ?, '[]', ?)`)
      .bind("e1", "hello", 1000, memoryWriteMarker(admitted.env))
      .run();
    await admitted.finish();
    const { results } = await d1.db
      .prepare(`SELECT id, COALESCE(updated_at, created_at) AS updated_at, staleness_checked_at, recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries`)
      .all() as { results: Record<string, unknown>[] };

    expect(results).toEqual([{
      id: "e1", updated_at: 1000, staleness_checked_at: null,
      recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
    }]);
  });

  it("rejects an edge whose endpoint is missing in real SQLite", async () => {
    d1 = makeSqliteD1({ schema: false });
    const env = envFor(d1);
    await initializeDatabase(env);
    const admitted = await beginMemoryWriteAdmission(
      env,
      { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext,
    );
    await d1.db
      .prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, write_marker) VALUES (?, ?, '[]', 'api', ?, '[]', ?)`)
      .bind("present", "hello", 1000, memoryWriteMarker(admitted.env))
      .run();

    await expect(d1.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, write_marker)
       VALUES (?, ?, ?, 'relates_to', 0.5, 'explicit', '{}', 1000, 1000, ?)`,
    ).bind("dangling", "present", "missing", memoryWriteMarker(admitted.env)).run()).rejects.toThrow(/missing-edge-endpoint/);
    await admitted.finish();

    const count = await d1.db.prepare(`SELECT COUNT(*) AS count FROM edges`).first() as { count: number } | null;
    expect(count?.count).toBe(0);
  });

  it("upgrades a populated fork v4 without changing source rows or write fences", async () => {
    d1 = makeSqliteD1();
    d1.seed({ id: "existing-v4", content: "Keep this memory", createdAt: 1,
      tags: ["capsule:core", "capsule-slot:identity", "status:canonical"] });
    const before = await d1.db.prepare("SELECT * FROM entries WHERE id = 'existing-v4'").first();
    for (const name of PROMPT_CAPSULE_TRIGGERS) await d1.db.exec(`DROP TRIGGER ${name}`);
    await d1.db.exec("DROP INDEX idx_entries_capsule");
    await d1.db.exec("DROP TABLE prompt_capsule_revisions");
    await d1.db.exec("UPDATE schema_meta SET version = 4 WHERE id = 'current'");
    resetDatabaseInit();
    await initializeDatabase(envFor(d1));
    expect(await d1.db.prepare("SELECT * FROM entries WHERE id = 'existing-v4'").first()).toEqual(before);
    expect(await d1.db.prepare("SELECT version FROM schema_meta WHERE id = 'current'").first())
      .toEqual({ version: DATABASE_SCHEMA_VERSION });
    expect(await objectNames(d1)).toEqual(expect.arrayContaining([
      "idx_entries_capsule", "prompt_capsule_revisions", ...PROMPT_CAPSULE_TRIGGERS, ...WRITE_FENCE_TRIGGERS,
    ]));
    // An explicit invalid marker cannot bypass the original capability fence.
    await expect(d1.db.prepare("UPDATE entries SET content = 'bad', write_marker = 'invalid' WHERE id = 'existing-v4'").run())
      .rejects.toThrow(/memory-write-locked/);
  });

  it("costs one statement on an already-migrated brain", async () => {
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));
    const cold = d1.issued.length;
    d1.issued.length = 0;

    resetDatabaseInit(); // a second cold isolate against the brain the first one migrated
    await initializeDatabase(envFor(d1));

    expect(cold - DERIVED_INDEX_SETUP_STATEMENTS).toBeLessThanOrEqual(ALL_OBJECTS.length + MIGRATION.length + 40);
    expect(d1.issued).toHaveLength(1);
    expect(d1.issued[0]).toMatch(SCHEMA_VERSION_READ);
  });

  it("recognizes the reference schema as fully current", async () => {
    d1 = makeSqliteD1();
    expect(d1.columns()).toContain("updated_at");

    await initializeDatabase(envFor(d1));

    expect(d1.issued).toHaveLength(1);
    expect(d1.issued[0]).toMatch(SCHEMA_VERSION_READ);
    expect(d1.columns()).toEqual(expect.arrayContaining([...BASE_COLUMNS, ...ALL_COLUMNS]));
  });

  it("adds only the weight index to a brain migrated before #281", async () => {
    // The newest object, and the one most likely to be the only thing a brain is missing:
    // every install that migrated before #281 has the complete schema apart from this.
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));
    await d1.db.exec(`DROP INDEX idx_edges_weight`);
    await markSchemaStale(d1);
    resetDatabaseInit();
    d1.issued.length = 0;

    await initializeDatabase(envFor(d1));

    expect(d1.issued).toEqual([
      expect.stringMatching(SCHEMA_VERSION_READ),
      expect.stringMatching(PROBE),
      `CREATE INDEX IF NOT EXISTS idx_edges_weight ON edges(weight DESC)`,
      expect.stringMatching(SCHEMA_VERSION_WRITE),
    ]);
    expect(await objectNames(d1)).toContain("idx_edges_weight");
  });

  it("replaces the pre-append-queue v6 vector trigger with the queue-fenced v7 trigger", async () => {
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));
    await d1.db.exec(`DROP TRIGGER trg_entries_write_fence_vector_update_v7`);
    await d1.db.exec(`CREATE TRIGGER trg_entries_write_fence_vector_update_v6
      BEFORE UPDATE OF vector_ids, migration_lease_owner ON entries
      WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock')
      BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`);
    await markSchemaStale(d1);
    resetDatabaseInit();
    d1.issued.length = 0;

    await initializeDatabase(envFor(d1));

    const upgradeIssued = [...d1.issued];
    const names = await objectNames(d1);
    expect(names).not.toContain("trg_entries_write_fence_vector_update_v6");
    expect(names).toContain("trg_entries_write_fence_vector_update_v7");
    expect(upgradeIssued).toEqual([
      expect.stringMatching(SCHEMA_VERSION_READ),
      expect.stringMatching(PROBE),
      expect.stringContaining(`TRIGGER IF NOT EXISTS trg_entries_write_fence_vector_update_v7`),
      `DROP TRIGGER IF EXISTS trg_entries_write_fence_vector_update_v6`,
      expect.stringMatching(SCHEMA_VERSION_WRITE),
    ]);
  });

  it("the entries-table filters do not match entries_trash", async () => {
    // entries_trash starts with the same prefix as entries; the "(" is what tells them apart.
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));
    const creates = d1.issued.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries"));
    expect(creates.some(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries_trash"))).toBe(true);
    expect(creates.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries ("))).toHaveLength(1);
  });

  it("adds the edges table to a brain that predates it", async () => {
    // The other real intermediate state (issue #16 added edges to brains that already had
    // entries). Tables, indexes, and triggers are probed independently of columns, so this is not
    // the same path as the ALTERs above.
    d1 = makeSqliteD1({ schema: false });
    await d1.db.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`);
    d1.issued.length = 0;

    await initializeDatabase(envFor(d1));

    expect(await objectNames(d1)).toContain("edges");
    expect(d1.issued.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries ("))).toEqual([]);
    expect(d1.columns()).toEqual(expect.arrayContaining([...BASE_COLUMNS, ...ALL_COLUMNS]));
  });

  it("adds last_used_at to a users table that predates it, keeping every member row", async () => {
    // The upgrade path this column actually takes: a team brain provisioned
    // before it existed, with members already in it. The ALTER must be the whole
    // migration — no backfill, no rewrite of the rows that are already there.
    d1 = makeSqliteD1({ schema: false });
    await d1.db.exec(
      `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT, role TEXT NOT NULL DEFAULT 'member', token_hash TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, default_share TEXT NOT NULL DEFAULT '', removed_at INTEGER)`,
    );
    await d1.db
      .prepare(`INSERT INTO users (id, name, email, role, token_hash, suspended, created_at, default_share, removed_at) VALUES ('u1', 'Ada', 'ada@example.com', 'admin', 'hash-1', 0, 1000, 'company', NULL)`)
      .run();
    d1.issued.length = 0;

    await initializeDatabase(envFor(d1));

    const userColumns = (await d1.db.prepare(`SELECT name FROM pragma_table_info('users')`).all())
      .results as { name: string }[];
    expect(userColumns.map(c => c.name)).toContain("last_used_at");
    // Exactly one users ALTER — the two columns already there are not re-added.
    expect(d1.issued.filter(s => /^ALTER TABLE users/.test(s))).toEqual([
      `ALTER TABLE users ADD COLUMN last_used_at INTEGER`,
    ]);
    // Nothing wrote to the row: every field survives and the new one reads NULL.
    const row = await d1.db.prepare(`SELECT * FROM users WHERE id = 'u1'`).first() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: "u1", name: "Ada", email: "ada@example.com", role: "admin",
      token_hash: "hash-1", suspended: 0, created_at: 1000, default_share: "company", removed_at: null,
    });
    expect(row.last_used_at).toBeNull();
    expect(d1.issued.some(s => /^(?:INSERT INTO|UPDATE|DELETE FROM) (?:users|admin_events)\b/i.test(s))).toBe(false);
  });

  it("adds target_user_id and workspace_id to an admin_events table that predates them", async () => {
    // The upgrade path a real brain took: admin_events shipped with five columns
    // and gained the two subject columns a release later, so an audit trail that
    // was already being written to is missing exactly the columns the writer now
    // binds. Nothing surfaces that — every write goes through ctx.waitUntil and
    // ends in .catch(console.error) — so the trail simply stops recording.
    d1 = makeSqliteD1({ schema: false });
    await d1.db.exec(
      `CREATE TABLE admin_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
    );
    await d1.db
      .prepare(`INSERT INTO admin_events (id, actor_id, event, payload, created_at) VALUES ('a1', 'u1', 'team_renamed', '{"name":"Acme"}', 1000)`)
      .run();
    d1.issued.length = 0;

    await initializeDatabase(envFor(d1));

    const columns = (await d1.db.prepare(`SELECT name FROM pragma_table_info('admin_events')`).all())
      .results as { name: string }[];
    expect(columns.map(c => c.name)).toEqual(
      expect.arrayContaining(["target_user_id", "workspace_id"]),
    );
    expect(d1.issued.filter(s => /^ALTER TABLE admin_events/.test(s))).toEqual([
      `ALTER TABLE admin_events ADD COLUMN target_user_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE admin_events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
    ]);
    // The row already in the trail keeps every field, and the new columns read as
    // the empty subject rather than NULL — an audit row is never rewritten.
    expect(await d1.db.prepare(`SELECT * FROM admin_events WHERE id = 'a1'`).first()).toEqual({
      id: "a1", actor_id: "u1", target_user_id: "", workspace_id: "",
      event: "team_renamed", payload: '{"name":"Acme"}', created_at: 1000,
    });
    expect(d1.issued.some(s => /^(?:INSERT INTO|UPDATE|DELETE FROM) (?:users|admin_events)\b/i.test(s))).toBe(false);

    // The claim that matters: the statement src/lib/admin-audit.ts issues now
    // works against this brain. Existence of the columns is the mechanism; a
    // write that lands is the behaviour.
    await expect(
      d1.db
        .prepare(`INSERT INTO admin_events (id, actor_id, target_user_id, workspace_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind("a2", "u1", "u2", "ws-company", "member_suspended", "{}", 2000)
        .run(),
    ).resolves.toMatchObject({ success: true });
  });

  it("leaves existing rows untouched when it adds a column", async () => {
    d1 = makeSqliteD1();
    d1.seed({ id: "old", content: "written before the migration", createdAt: 1000 });

    await initializeDatabase(envFor(d1));

    // Not backfilled: readers coalesce updated_at to created_at, and writing it would
    // cost one row written per entry for a value nothing downstream can distinguish.
    expect(d1.rows()).toEqual([expect.objectContaining({
      id: "old", content: "written before the migration", created_at: 1000,
      updated_at: null, staleness_checked_at: null,
    })]);
  });

  // Degrading to the pre-#282 cost is the acceptable failure; skipping the DDL is not.
  // A probe may only report a thing PRESENT if it actually saw it, so every way of not
  // seeing it has to end in the statement being issued. Each of these would otherwise
  // leave a brand-new brain resolving initializeDatabase against tables that do not exist.
  describe("a probe that cannot be trusted still migrates", () => {
    /** Real SQLite for the DDL, `probe` for what the probe appears to return. */
    function dbWhoseProbe(probe: () => unknown) {
      return {
        prepare: (sql: string) => (PROBE.test(sql) ? { all: async () => probe() } : d1.db.prepare(sql)),
        exec: (sql: string) => d1.db.exec(sql),
        batch: (statements: Parameters<typeof d1.db.batch>[0]) => d1.db.batch(statements),
      } as unknown as D1Database;
    }

    async function expectFullyMigrated() {
      for (const name of ALL_OBJECTS) expect(await objectNames(d1)).toContain(name);
      expect(d1.columns()).toEqual(expect.arrayContaining([...BASE_COLUMNS, ...ALL_COLUMNS]));
    }

    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      d1 = makeSqliteD1({ schema: false });
    });

    it("applies the whole schema when the probe throws", async () => {
      // The guard against the probe's one statement being unsupported on some future D1
      // and taking first-request migration down with it.
      await initializeDatabase(makeTestEnv(undefined, {
        DB: dbWhoseProbe(() => { throw new Error("D1_ERROR: unsupported statement"); }),
      }));

      await expectFullyMigrated();
      expect(console.warn).toHaveBeenCalledWith("Schema probe failed; applying the full schema instead");
    });

    it("applies the whole schema when the probe returns a shape it cannot read", async () => {
      await initializeDatabase(makeTestEnv(undefined, { DB: dbWhoseProbe(() => ({ success: true })) }));

      await expectFullyMigrated();
    });

    it("does not accept a name held by the wrong kind of object", async () => {
      // SQLite puts tables, indexes, and triggers in one namespace. A user table that has taken an
      // index's name is not that index, and matching on the name alone would resolve init
      // having silently never created it. Issuing the CREATE gets SQLite's collision
      // error instead — which is what happened before the probe existed.
      await d1.db.exec(`CREATE TABLE idx_entries_source (id TEXT)`);

      await expect(initializeDatabase(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database })))
        .rejects.toThrow(/already a table named idx_entries_source/);
    });

    it("treats a row it cannot classify as missing rather than present", async () => {
      // `kind` is what separates a column from a table. A row that has lost it names
      // something, but nothing that licenses skipping a statement.
      await initializeDatabase(makeTestEnv(undefined, {
        DB: dbWhoseProbe(() => ({
          results: [
            ...ALL_OBJECTS.map(name => ({ name })), // no kind
            ...ALL_COLUMNS.map(name => ({ kind: "column", name: { toString: () => name } })), // not a string
            { kind: "trigger", name: "entries" },
          ],
        })),
      }));

      await expectFullyMigrated();
    });
  });

  describe("entries_fts", () => {
    it("creates the FTS table and sync triggers on a fresh brain", async () => {
      d1 = makeSqliteD1({ schema: false });

      await initializeDatabase(envFor(d1));

      const { results } = await d1.db.prepare(
        `SELECT name, type FROM sqlite_master WHERE name IN ('entries_fts','entries_fts_insert','entries_fts_update','entries_fts_delete')`,
      ).all() as { results: { name: string; type: string }[] };
      expect(results).toHaveLength(4);
    });

    it("keeps the index in sync through insert, update, and delete", async () => {
      d1 = makeSqliteD1(); // schema.sql applied
      await initializeDatabase(envFor(d1));

      await d1.db.prepare(`INSERT INTO entries (id, content, created_at) VALUES ('e1', 'the dashboard redesign shipped', 1)`).run();
      expect(((await d1.db.prepare(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"dashboard"'`).all()).results)).toHaveLength(1);

      await d1.db.prepare(`UPDATE entries SET content = 'the composer landed' WHERE id = 'e1'`).run();
      expect(((await d1.db.prepare(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"dashboard"'`).all()).results)).toHaveLength(0);
      expect(((await d1.db.prepare(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"composer"'`).all()).results)).toHaveLength(1);

      await d1.db.prepare(`UPDATE entries SET write_marker = ? WHERE id = 'e1'`).bind(d1.fixtureMarker("delete")).run();
      await d1.db.prepare(`DELETE FROM entries WHERE id = 'e1'`).run();
      expect(await d1.db.prepare(`SELECT count(*) AS n FROM entries_fts`).first()).toEqual({ n: 0 });
    });

    /** FTS shadow of entries, the shape an id or rowid change has to preserve. */
    const ftsOf = async (sqlite: SqliteD1) =>
      ((await sqlite.db.prepare(`SELECT rowid, id, content FROM entries_fts ORDER BY rowid`).all()).results);
    const entriesOf = async (sqlite: SqliteD1) =>
      ((await sqlite.db.prepare(`SELECT rowid, id, content FROM entries ORDER BY rowid`).all()).results);

    it("syncs FTS through an id-only UPDATE", async () => {
      d1 = makeSqliteD1();
      await initializeDatabase(envFor(d1));
      await d1.db.prepare(`INSERT INTO entries (id, content, created_at) VALUES ('old-id', 'unique drift marker', 1)`).run();

      await d1.db.prepare(`UPDATE entries SET id = 'new-id' WHERE id = 'old-id'`).run();

      expect(await ftsOf(d1)).toEqual(await entriesOf(d1));
    });

    it("syncs FTS through a rowid-only UPDATE", async () => {
      d1 = makeSqliteD1();
      await initializeDatabase(envFor(d1));
      await d1.db.prepare(`INSERT INTO entries (id, content, created_at) VALUES ('e1', 'unique drift marker', 1)`).run();
      const row = await d1.db.prepare(`SELECT rowid FROM entries WHERE id = 'e1'`).first() as { rowid: number };

      await d1.db.prepare(`UPDATE entries SET rowid = ? WHERE id = 'e1'`).bind(row.rowid + 100).run();

      expect(await ftsOf(d1)).toEqual(await entriesOf(d1));
    });

    it("writes nothing to FTS for a recall_count-only UPDATE", async () => {
      d1 = makeSqliteD1();
      await initializeDatabase(envFor(d1));
      await d1.db.prepare(`INSERT INTO entries (id, content, created_at) VALUES ('e1', 'the dashboard redesign shipped', 1)`).run();
      const before = await ftsOf(d1);

      await d1.db.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = 'e1'`).run();

      expect(await ftsOf(d1)).toEqual(before);
      expect(await ftsOf(d1)).toEqual(await entriesOf(d1));
    });

    it("marks FTS ready immediately on a brand-new brain", async () => {
      // No entries table before this pass, so there are no pre-FTS rows to
      // backfill: the triggers cover everything from row one.
      d1 = makeSqliteD1({ schema: false });
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });

      await initializeDatabase(env);

      expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
    });

    it("does not latch ready on a migrated brain that may hold pre-FTS rows", async () => {
      d1 = makeSqliteD1(); // schema.sql applied: entries already exists
      const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });

      await initializeDatabase(env);

      expect(await env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBeNull();
    });

    it("repairs missing triggers on a populated pre-FTS brain without invalidating capsules", async () => {
      d1 = makeSqliteD1(); // schema.sql applied, then rewound to its pre-FTS shape below
      await d1.db.exec(
        `DROP TRIGGER IF EXISTS entries_fts_insert; DROP TRIGGER IF EXISTS entries_fts_update;` +
        `DROP TRIGGER IF EXISTS entries_fts_delete; DROP TABLE IF EXISTS entries_fts; DELETE FROM schema_meta;` +
        `INSERT INTO workspaces (id, kind, name, created_at) VALUES ('w1', 'personal', 'One', 1), ('w2', 'personal', 'Two', 1);` +
        `INSERT INTO prompt_capsule_revisions (workspace_id, revision) VALUES ('w1', 'rev-w1'), ('w2', 'rev-w2');`,
      );

      await initializeDatabase(envFor(d1));

      // The seeded revisions are untouched: a missing FTS trigger is a schema
      // repair, not an entry edit, and capsule payloads stay valid through it.
      expect((await d1.db.prepare(
        `SELECT workspace_id, revision FROM prompt_capsule_revisions ORDER BY workspace_id`,
      ).all()).results).toEqual([
        { workspace_id: "w1", revision: "rev-w1" },
        { workspace_id: "w2", revision: "rev-w2" },
      ]);
      expect((await d1.db.prepare(
        `SELECT name FROM sqlite_master WHERE name IN ('entries_fts','entries_fts_insert','entries_fts_update','entries_fts_delete')`,
      ).all()).results).toHaveLength(4);

      resetDatabaseInit();
      d1.issued.length = 0;
      const batchesBefore = d1.batches.length;
      await initializeDatabase(envFor(d1));
      expect(d1.issued.filter(s => /^(CREATE|DROP|ALTER)\b/.test(s))).toEqual([]);
      expect(d1.batches).toHaveLength(batchesBefore);
    });
  });

  // Write-path isolation v2.2: ownership (triggers created only with the
  // table) and the populated-brain creation rule.
  describe("entries_fts ownership (v2.2)", () => {
    const envWithKv = (sqlite: SqliteD1, kv: KVNamespace) =>
      makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv });

    async function ftsObjectNames(sqlite: SqliteD1): Promise<string[]> {
      const { results } = await sqlite.db.prepare(
        `SELECT name FROM sqlite_master WHERE name IN ('entries_fts','entries_fts_insert','entries_fts_update','entries_fts_delete')`,
      ).all() as { results: { name: string }[] };
      return results.map(r => r.name).sort();
    }

    async function triggerNames(sqlite: SqliteD1): Promise<string[]> {
      const { results } = await sqlite.db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('entries_fts_insert','entries_fts_update','entries_fts_delete')`,
      ).all() as { results: { name: string }[] };
      return results.map(r => r.name).sort();
    }

    // Test 3 (v2.2 review, disabled-existing-trigger-repaired): applySchema
    // never creates or repairs an FTS trigger independently of the table.
    // Missing one trigger while the table exists is simply "not live"
    // (src/recall/fts.ts) — left for the nightly rebuildFtsIndex, not
    // silently patched back in on the next cold start.
    it("never repairs a missing FTS trigger on an existing table", async () => {
      d1 = makeSqliteD1();
      await initializeDatabase(envFor(d1));
      await d1.db.exec(`DROP TRIGGER entries_fts_insert`); // table stays; not live
      resetDatabaseInit();

      await initializeDatabase(envFor(d1));

      expect(await triggerNames(d1)).toEqual(["entries_fts_delete", "entries_fts_update"]); // insert stays gone
      const table = (await d1.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entries_fts'`).all()).results;
      expect(table).toHaveLength(1); // the table itself is untouched
    });

    // Rule 4: creating entries_fts on a brain whose `entries` table already
    // existed must first invalidate ready and reset the cursor. If either KV
    // op fails, skip creating it this pass rather than serve an unbackfilled
    // index as ready.
    it("populated brain, KV working: creates entries_fts, deletes ready, resets cursor to 0", async () => {
      d1 = makeSqliteD1(); // schema.sql applied: `entries` already exists
      await d1.db.exec(
        `DROP TRIGGER IF EXISTS entries_fts_insert; DROP TRIGGER IF EXISTS entries_fts_update;` +
        `DROP TRIGGER IF EXISTS entries_fts_delete; DROP TABLE IF EXISTS entries_fts; DELETE FROM schema_meta;`,
      );
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");

      await initializeDatabase(envWithKv(d1, kv));

      expect(await ftsObjectNames(d1)).toEqual(["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
      expect(await kv.get(FTS_READY_KV_KEY)).toBeNull();
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
    });

    // Test 5 (v2.2 review, init-memo-kv-recovery) + B1 (v2.2 re-review,
    // BLOCKER): a deferred creation must leave initializeDatabase retryable,
    // not silently memoized as done — the OLD (v2.1) behavior left a
    // populated brain without FTS forever, even after KV recovered, because
    // the first call still resolved. But rejecting (the FIRST fix) was
    // itself wrong: initializeDatabase is awaited by authentication and
    // every other caller (src/lib/identity.ts etc.), so a populated brain
    // with a missing entries_fts and KV down would fail EVERY authenticated
    // request — exactly the upgrade-time state every existing brain hits.
    // Deferral must be NON-FATAL: the call resolves so the request proceeds
    // (recall uses LIKE, saves work), but is not memoized as fully done.
    it("populated brain, KV failing: resolves (non-fatal), and a later call retries the deferred creation", async () => {
      d1 = makeSqliteD1(); // schema.sql applied: `entries` already exists
      await d1.db.exec(
        `DROP TRIGGER IF EXISTS entries_fts_insert; DROP TRIGGER IF EXISTS entries_fts_update;` +
        `DROP TRIGGER IF EXISTS entries_fts_delete; DROP TABLE IF EXISTS entries_fts; DELETE FROM schema_meta;`,
      );
      const kv = {
        get: async () => null,
        put: async () => { throw new Error("KV unavailable"); },
        delete: async () => { throw new Error("KV unavailable"); },
      } as unknown as KVNamespace;

      await expect(initializeDatabase(envWithKv(d1, kv))).resolves.toMatchObject({ changed: expect.any(Boolean) });
      expect(await ftsObjectNames(d1)).toEqual([]);

      // No resetDatabaseInit(): the first call above must already have left
      // the memo retryable itself, or this second call would be a no-op.
      await initializeDatabase(envWithKv(d1, makeMemoryKV()));
      expect(await ftsObjectNames(d1)).toEqual(["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
    });

    // B1's exact reviewer scenario: an authenticated request against a
    // populated, pre-upgrade brain (entries_fts missing) with KV down.
    it("B1: authentication succeeds through a deferred FTS creation with KV down", async () => {
      d1 = makeSqliteD1();
      await d1.db.exec(
        `DROP TRIGGER IF EXISTS entries_fts_insert; DROP TRIGGER IF EXISTS entries_fts_update;` +
        `DROP TRIGGER IF EXISTS entries_fts_delete; DROP TABLE IF EXISTS entries_fts; DELETE FROM schema_meta;`,
      );
      await d1.db.prepare(
        `INSERT INTO users (id, name, role, token_hash, created_at) VALUES ('u1', 'Owner', 'admin', ?, 1)`,
      ).bind(await hashToken("test-token")).run();
      await d1.db.prepare(
        `INSERT INTO workspaces (id, kind, name, created_at) VALUES ('w1', 'personal', 'Owner', 1)`,
      ).run();
      await d1.db.prepare(
        `INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES ('u1', 'w1', 'admin', 1)`,
      ).run();
      const kv = {
        get: async () => null,
        put: async () => { throw new Error("KV unavailable"); },
        delete: async () => { throw new Error("KV unavailable"); },
      } as unknown as KVNamespace;

      const identity = await resolveIdentityFromToken("test-token", envWithKv(d1, kv));

      expect(identity?.userId).toBe("u1");
      expect(await ftsObjectNames(d1)).toEqual([]); // still deferred — but the request succeeded
    });

    // Fresh-brain exemption: `entries` did not exist before this pass, so
    // rule 4's populated-brain gate owes no KV round trip of its own — it
    // returns true immediately. The one KV call this test now measures is
    // Task 4's separate fresh-brain ready latch (src/db/init.ts, the very
    // end of applySchema), not rule 4: that latch fires on exactly the same
    // "entries did not exist before this pass" condition rule 4 exempts, and
    // the two compose by design rather than by coincidence.
    it("fresh brain: creates entries_fts with no KV call from rule 4 (only Task 4's own ready latch)", async () => {
      d1 = makeSqliteD1({ schema: false });
      const calls: string[] = [];
      const kv = {
        get: async () => { calls.push("get"); return null; },
        put: async (key: string) => { calls.push(`put:${key}`); },
        delete: async (key: string) => { calls.push(`delete:${key}`); },
      } as unknown as KVNamespace;

      await initializeDatabase(envWithKv(d1, kv));

      expect(await ftsObjectNames(d1)).toEqual(["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
      // versions:since (T-0089.1.1) is written the pass entry_versions is created, fresh brains included.
      expect(calls).toEqual([`put:${VERSIONS_SINCE_KV_KEY}`, `put:${FTS_READY_KV_KEY}`]);
    });

    // Probe failure (combined review of Tasks 4-6): `existing === null` must
    // read as populated/unknown, never fresh. The reviewer's PROBE_FAILURE
    // probe: a legacy brain with ready=1 and a stale cursor loses its
    // entries_fts; a transient schema-probe failure used to skip the KV
    // invalidation entirely, so the recreated empty table was still served
    // as ready over nothing.
    it("probe failure: a brain of unknown shape invalidates KV before FTS creation and never fresh-latches", async () => {
      d1 = makeSqliteD1(); // schema.sql applied, then rewound to its pre-FTS shape below
      await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at) VALUES ('legacy', 'legacy violet', '[]', 'api', 1)`).run();
      await d1.db.exec(
        `DROP TRIGGER IF EXISTS entries_fts_insert; DROP TRIGGER IF EXISTS entries_fts_update;` +
        `DROP TRIGGER IF EXISTS entries_fts_delete; DROP TABLE IF EXISTS entries_fts; DELETE FROM schema_meta;`,
      );
      const kv = makeMemoryKV();
      await kv.put(FTS_READY_KV_KEY, "1");
      await kv.put(FTS_BACKFILL_CURSOR_KV_KEY, "500");
      const raw = d1.db;
      const DB = {
        prepare(sql: string) {
          if (!sql.startsWith("SELECT type AS kind, name, sql AS definition FROM sqlite_master")) return raw.prepare(sql);
          return { all: async () => { throw new Error("transient schema probe failure"); } };
        },
        exec: raw.exec.bind(raw),
        batch: raw.batch.bind(raw),
      } as unknown as D1Database;

      await initializeDatabase(makeTestEnv(undefined, { DB: DB as unknown as D1Database, OAUTH_KV: kv }));

      expect(await ftsObjectNames(d1)).toEqual(["entries_fts", "entries_fts_delete", "entries_fts_insert", "entries_fts_update"]);
      expect(await kv.get(FTS_READY_KV_KEY)).toBeNull();
      expect(await kv.get(FTS_BACKFILL_CURSOR_KV_KEY)).toBe("0");
    });
  });

  // T-0065, same convention as the FTS liveness check (src/recall/fts.ts's
  // EXPECTED_FTS_DEFINITIONS): db/schema.sql and src/db/init.ts must define
  // entry_counts identically, or a brain bootstrapped from schema.sql and one
  // migrated by applySchema would carry different trigger bodies.
  it("entry_counts DDL in db/schema.sql matches src/db/init.ts exactly", async () => {
    d1 = makeSqliteD1(); // schema.sql applied
    const { results } = await d1.db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE name IN ('entry_counts','entry_counts_insert','entry_counts_update','entry_counts_delete')`,
    ).all() as { results: { name: string; sql: string }[] };
    const stored = Object.fromEntries(results.map(r => [r.name, r.sql]));
    const strip = (ddl: string) => ddl.replace(/\bIF NOT EXISTS\s+/i, "");
    expect(stored.entry_counts).toBe(strip(ENTRY_COUNTS_TABLE_DDL));
    expect(stored.entry_counts_insert).toBe(strip(ENTRY_COUNTS_INSERT_TRIGGER_DDL));
    expect(stored.entry_counts_update).toBe(strip(ENTRY_COUNTS_UPDATE_TRIGGER_DDL));
    expect(stored.entry_counts_delete).toBe(strip(ENTRY_COUNTS_DELETE_TRIGGER_DDL));
  });

  it("survives two isolates migrating the same brain at once", async () => {
    // Both probe an unmigrated brain, both decide every ALTER is owed, and the loser gets
    // `duplicate column name` — the race the tolerance in applySchema exists for. D1 has
    // no transactional DDL to serialise them.
    d1 = makeSqliteD1({ schema: false });
    const first = initializeDatabase(envFor(d1));
    resetDatabaseInit(); // the second isolate has its own memo
    const second = initializeDatabase(envFor(d1));

    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(d1.columns()).toEqual(expect.arrayContaining([...BASE_COLUMNS, ...ALL_COLUMNS]));
  });
});
