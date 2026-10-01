import type { Env } from "../env";
import { FTS_BACKFILL_CURSOR_KV_KEY, FTS_READY_KV_KEY, VERSIONS_SINCE_KV_KEY } from "../constants";
import {
  INSIGHT_CANDIDATE_COLUMNS, MIGRATION_CONTROL_COLUMNS, OBSOLETE_WRITE_FENCE_TRIGGERS,
  RESTORE_STATE_COLUMNS, VECTOR_CLEANUP_COLUMNS, WRITE_ADMISSION_COLUMNS,
  WRITE_FENCE_TRIGGERS, WRITE_PROTECTION_TABLES_AFTER_OAUTH,
  WRITE_PROTECTION_TABLES_BEFORE_OAUTH,
} from "./write-protection-schema";

// The schema work below is idempotent but not free. All four nightly jobs run inside a
// single scheduled() invocation and therefore share one subrequest budget, and each of
// them awaits initializeDatabase, so without memoisation the same pass is paid for three
// or four times per cron. Memoise per isolate: the first caller does the work, everyone
// else awaits that promise.
//
// Deliberately not routed through ensureDbReady (src/runtime/state.ts) — that fires under
// ctx.waitUntil *without* awaiting, and the nightly jobs must not begin querying before
// the schema exists. They await this directly and must keep doing so.
export interface DatabaseInitResult {
  /** True when this invocation issued schema DDL and must not continue a D1-heavy job. */
  changed: boolean;
  /** Internal signal: the FTS creation is retried after KV recovers. */
  ftsDeferred?: boolean;
}

// Bump whenever SCHEMA_OBJECTS, a column migration, or a trigger generation changes.
// A deployed brain pays one single-row read per cold isolate and only runs the catalogue
// probe when this version is absent or stale.
export const DATABASE_SCHEMA_VERSION = 9;

let initPromise: Promise<DatabaseInitResult> | null = null;

async function readSchemaVersion(env: Env): Promise<number | null> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT version, (SELECT json_group_object(name, sql) FROM sqlite_master
        WHERE name IN ('idx_entries_capsule', 'prompt_capsule_entry_insert',
          'prompt_capsule_entry_update', 'prompt_capsule_entry_delete',
          'prompt_capsule_workspace_delete')) AS capsule_definitions
       FROM schema_meta WHERE id = 'current'`,
    ).all<{ version: number; capsule_definitions: string }>();
    const row = results[0];
    if (row?.version === DATABASE_SCHEMA_VERSION) {
      const definitions = JSON.parse(row.capsule_definitions) as Record<string, string>;
      const normalize = (sql: string) => sql.replace(/IF NOT EXISTS\s+/i, "")
        .replace(/;\s*$/, "").match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[a-zA-Z_]\w*|\d+|[^\s]/g)?.join(" ") ?? "";
      for (const [name, ddl] of Object.entries(POST_COLUMN_OBJECTS)) {
        if (name !== "idx_entries_capsule" && !name.startsWith("prompt_capsule_")) continue;
        if (normalize(definitions[name] ?? "") !== normalize(ddl)) return null;
      }
    }
    return typeof row?.version === "number" ? row.version : null;
  } catch (error) {
    // This is the expected one-time upgrade path for every existing installation.
    if (/no such table(?::|\s).*schema_meta/i.test(String((error as { message?: string })?.message ?? error))) {
      return null;
    }
    throw error;
  }
}

async function initializeDatabaseOnce(env: Env): Promise<DatabaseInitResult> {
  const version = await readSchemaVersion(env);
  if (version === DATABASE_SCHEMA_VERSION) return { changed: false };
  if (version !== null && version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Database schema version ${version} is newer than this Worker supports`);
  }

  const applied = await applySchema(env);
  if (applied.ftsDeferred) return { changed: applied.changed, ftsDeferred: true };
  await env.DB.prepare(
    `INSERT INTO schema_meta (id, version, applied_at)
     VALUES ('current', ?, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
  ).bind(DATABASE_SCHEMA_VERSION, Date.now()).run();
  return { changed: true };
}

export async function initializeDatabase(env: Env): Promise<DatabaseInitResult> {
  if (initPromise) {
    await initPromise;
    return { changed: false };
  }
  initPromise = initializeDatabaseOnce(env).then((result) => {
    // A populated brain can defer FTS creation while KV invalidation is
    // unavailable. The version stays old, so a later request must retry.
    if (result.ftsDeferred) initPromise = null;
    return result;
  }).catch((e) => {
      // The memo keys on SUCCESS, not on completion. Clearing it here is what makes a
      // failed or half-applied schema retryable: latching a resolved promise would leave
      // every later caller in this isolate doing nothing against a database that was
      // never migrated. Before memoisation each nightly job re-ran the DDL and repaired
      // the previous one's transient failure; this preserves that.
      initPromise = null;
      throw e;
  });
  return initPromise;
}

/**
 * Test seam. The memo is module-scoped, so within a single test file the second call
 * would otherwise be a no-op and assertions about issued statements would go blind.
 */
export function resetDatabaseInit(): void {
  initPromise = null;
}

// FTS DDL is shared with src/db/fts-repair.ts (a write-path failure recreates
// this same table and these same triggers), so each string is a named export
// rather than an inline literal — one definition, referenced from both places.
//
// Ownership (v2.2): deliberately NOT "IF NOT EXISTS". The table and its three
// triggers are created only together, in one batch — see applySchema below
// and src/db/fts-repair.ts's repairFtsIndex — and this is what makes a race
// between two creators safe: the loser's whole batch fails atomically
// ("table entries_fts already exists", verified against real node:sqlite),
// never partially applying, and is treated as a no-op rather than retried.
export const ENTRIES_FTS_TABLE_DDL =
  `CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, content, tokenize='trigram')`;
export const ENTRIES_FTS_VOCAB_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts_vocab USING fts5vocab(entries_fts, row)`;
export const ENTRIES_FTS_INSERT_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS entries_fts_insert
    AFTER INSERT ON entries
    BEGIN
      INSERT INTO entries_fts (rowid, id, content) VALUES (NEW.rowid, NEW.id, NEW.content);
    END`;
export const ENTRIES_FTS_UPDATE_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS entries_fts_update
    AFTER UPDATE ON entries
    WHEN OLD.rowid IS NOT NEW.rowid OR OLD.id IS NOT NEW.id OR OLD.content IS NOT NEW.content
    BEGIN
      DELETE FROM entries_fts WHERE rowid = OLD.rowid;
      INSERT INTO entries_fts (rowid, id, content) VALUES (NEW.rowid, NEW.id, NEW.content);
    END`;
export const ENTRIES_FTS_DELETE_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS entries_fts_delete
    AFTER DELETE ON entries
    BEGIN
      DELETE FROM entries_fts WHERE rowid = OLD.rowid;
    END`;

// entry_counts (T-0065): exact per-workspace row counts, replacing distillation's
// scoped COUNT(*)/cache. Same ownership rule as entries_fts above: table and its
// three triggers created together, in ONE batch, never independently repaired on
// an existing table. Shared with src/db/entry-counts-repair.ts (the hot-path
// repair for a manually dropped table), so each string is a named export.
//
// A row reaching n = 0 is KEPT, not deleted: SUM(n) is correct either way, and
// keeping it needs no extra statement in the triggers.
export const ENTRY_COUNTS_TABLE_DDL =
  `CREATE TABLE entry_counts (workspace_id TEXT PRIMARY KEY, n INTEGER NOT NULL)`;
export const ENTRY_COUNTS_INSERT_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS entry_counts_insert
    AFTER INSERT ON entries
    BEGIN
      INSERT INTO entry_counts (workspace_id, n) VALUES (NEW.workspace_id, 1)
      ON CONFLICT(workspace_id) DO UPDATE SET n = n + 1;
    END`;
export const ENTRY_COUNTS_UPDATE_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS entry_counts_update
    AFTER UPDATE OF workspace_id ON entries
    WHEN OLD.workspace_id IS NOT NEW.workspace_id
    BEGIN
      INSERT INTO entry_counts (workspace_id, n) VALUES (OLD.workspace_id, -1)
      ON CONFLICT(workspace_id) DO UPDATE SET n = n - 1;
      INSERT INTO entry_counts (workspace_id, n) VALUES (NEW.workspace_id, 1)
      ON CONFLICT(workspace_id) DO UPDATE SET n = n + 1;
    END`;
export const ENTRY_COUNTS_DELETE_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS entry_counts_delete
    AFTER DELETE ON entries
    BEGIN
      INSERT INTO entry_counts (workspace_id, n) VALUES (OLD.workspace_id, -1)
      ON CONFLICT(workspace_id) DO UPDATE SET n = n - 1;
    END`;

/**
 * Tables, indexes, and triggers, keyed by the name each occupies in sqlite_master.
 * Declaration order is apply order: a table has to exist before its indexes and triggers.
 */
const SCHEMA_OBJECTS: Record<string, string> = {
  schema_meta: `CREATE TABLE IF NOT EXISTS schema_meta (id TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL)`,
  entries: `CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]', recall_count INTEGER DEFAULT 0, importance_score INTEGER DEFAULT 0, contradiction_wins INTEGER DEFAULT 0, contradiction_losses INTEGER DEFAULT 0, updated_at INTEGER, staleness_checked_at INTEGER, memory_tier TEXT DEFAULT 'warm', pinned INTEGER DEFAULT 0, last_recalled_at INTEGER, restore_lease_owner TEXT, migration_lease_owner TEXT, write_marker TEXT, workspace_id TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT '', pending_append_passages TEXT NOT NULL DEFAULT '[]', when_at INTEGER, when_kind TEXT, when_source TEXT, when_label TEXT, valid_from INTEGER, valid_until INTEGER)`,
  idx_entries_created_at: `CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)`,
  idx_entries_source: `CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)`,
  // Relationship graph (issue #16). One additive table — never touches existing
  // rows/queries, so old code ignores it and rollback is a no-op. Designed to never
  // need an ALTER: type/provenance are free TEXT validated in code, and metadata is
  // a JSON escape-hatch for any future per-edge attribute.
  edges: `CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'relates_to', weight REAL NOT NULL DEFAULT 0.5, provenance TEXT NOT NULL DEFAULT 'inferred', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, restore_lease_owner TEXT, write_marker TEXT, workspace_id TEXT NOT NULL DEFAULT '', UNIQUE(source_id, target_id, type))`,
  // UNIQUE(source_id, target_id, type) already creates an index whose leading column is
  // source_id, so a second source-only index would duplicate both reads and write cost.
  idx_edges_target: `CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)`,
  // The graph view picks the strongest edges (ORDER BY weight DESC LIMIT n). Without an
  // ordered path to weight SQLite reads the whole table into a temp b-tree and applies the
  // LIMIT afterwards, so on workerd D1 that statement's rows_read is 2 x the edge count and
  // is *identical* with and without the LIMIT: 400,000 at 200k edges, 6,000 with this
  // index. D1's free plan allows 5M rows read/day and fails every query account-wide until
  // 00:00 UTC once that is spent, so an authenticated caller could take the brain offline
  // in a handful of /graph requests.
  //
  // This is the fifth index on a table written on the capture hot path, so it is a real
  // trade rather than a free win. Measured, one whole capture (entry insert, vector_ids
  // and classifier updates, plus inferEdgesOnWrite's worst case of 3 edges) costs 22 rows
  // written before and 25 after — 4,545 captures/day against the 100k/day budget, down to
  // 4,000. The same brain went from 3 /graph requests/day to 129 (and, unlike the write
  // cost, that ceiling no longer falls as the brain grows). The read budget binds first by
  // three orders of magnitude on any brain that is not capturing thousands of times a day.
  //
  // Building it on an existing brain costs one row written per edge, once: measured
  // 200,001 rows written at 200k edges, and 0/0 on every run after that. Before #282 that
  // no-op was a statement issued on every cold isolate and made free by IF NOT EXISTS;
  // now the probe means it is not issued at all once the index exists, so the repeat costs
  // nothing rather than costing a subrequest that does nothing. That one build can exceed
  // the 100k/day write cap on a brain that is already very large — the same hazard the
  // updated_at note below describes. It is still the right call, because such a brain is
  // precisely the one the missing index takes offline every day, and the cost here is paid
  // once rather than on every /graph. If it ever needs to be avoided, the fix is to build
  // the index out of band, not to leave the query unindexed.
  //
  // DESC matches the query; SQLite would walk an ASC index backwards just as well, but
  // stating the direction keeps the index and its one caller obviously paired. Bonus: the
  // nightly prune's `weight < ?` becomes a range search, 200,000 rows read down to 60,000.
  idx_edges_weight: `CREATE INDEX IF NOT EXISTS idx_edges_weight ON edges(weight DESC)`,
  // Candidate pairs for the weekly insight pass. Additive, like `edges` — old code
  // ignores it and rollback is a no-op.
  //
  // UNIQUE(a_id, b_id) with ids normalised so a_id < b_id at the call site is
  // what makes a pair enter once rather than twice in opposite orders. Together
  // with the `rejected` status it is also the dedupe: a candidate the model has
  // already declined is never re-proposed, and never paid for twice.
  insight_candidates: `CREATE TABLE IF NOT EXISTS insight_candidates (id TEXT PRIMARY KEY, a_id TEXT NOT NULL, b_id TEXT NOT NULL, similarity REAL NOT NULL, gap_ms INTEGER NOT NULL, score REAL NOT NULL, signal TEXT NOT NULL DEFAULT 'vector', status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, write_marker TEXT, UNIQUE(a_id, b_id))`,
  // The weekly read is `WHERE status='pending' ORDER BY score DESC LIMIT n`.
  // Without an ordered path to score SQLite builds a temp b-tree over the whole
  // table before applying the LIMIT, the same shape idx_edges_weight exists to
  // avoid on the graph read path.
  idx_insight_candidates_queue: `CREATE INDEX IF NOT EXISTS idx_insight_candidates_queue ON insight_candidates(status, score DESC)`,
  workspaces: `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'personal', name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
  prompt_capsule_revisions: `CREATE TABLE IF NOT EXISTS prompt_capsule_revisions (workspace_id TEXT PRIMARY KEY, revision TEXT NOT NULL)`,
  idx_workspaces_kind: `CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(kind)`,
  // The inline token constraint supplies the lookup index too; a separate named UNIQUE
  // index would be redundant. Existing brains may harmlessly retain the old named copy.
  users: `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT, role TEXT NOT NULL DEFAULT 'member', token_hash TEXT NOT NULL UNIQUE, suspended INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, default_share TEXT NOT NULL DEFAULT '', removed_at INTEGER, last_used_at INTEGER)`,
  memberships: `CREATE TABLE IF NOT EXISTS memberships (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL, PRIMARY KEY (user_id, workspace_id))`,
  // listTeamWorkspaces (GET /team/roster) joins memberships on workspace_id; the
  // composite PK only serves user_id-first lookups.
  idx_memberships_workspace: `CREATE INDEX IF NOT EXISTS idx_memberships_workspace ON memberships(workspace_id)`,
  entry_events: `CREATE TABLE IF NOT EXISTS entry_events (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, actor_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  idx_entry_events_entry: `CREATE INDEX IF NOT EXISTS idx_entry_events_entry ON entry_events(entry_id, created_at DESC)`,
  idx_entry_events_created: `CREATE INDEX IF NOT EXISTS idx_entry_events_created ON entry_events(created_at DESC)`,
  // Cloud re-review MINOR (T-0102, on top of 0b970baa's R22 fix): brief/changes.ts's raw scan of
  // this table is capped BEFORE any workspace/visibility filter can run (no workspace column to
  // filter on without a join). A teammate's own ordinary burst, under a different actor_id, could
  // fill that cap with noise and crowd the reader's own changes and held notices out of the window
  // entirely. Reserving separate, index-backed scans for `actor_id = reader` and `event = 'held'`
  // fixes that -- but only if each one is a genuine index range scan, not a full-table scan
  // filtered in date order (which, with the reader's own matches sparse against the noise, would
  // cost the same as no cap at all). Same table, same "busiest table in the schema" reasoning as
  // idx_entry_events_created above; actor_id is in the original CREATE like created_at is.
  idx_entry_events_actor: `CREATE INDEX IF NOT EXISTS idx_entry_events_actor ON entry_events(actor_id, created_at DESC)`,
  // A partial index, sized to how many rows are ever actually held (rare, by construction -- a
  // hold is an exceptional write, not a routine one), not to entry_events' total row count: cheap
  // to maintain, and gives `WHERE event = 'held' ORDER BY created_at DESC LIMIT n` a direct,
  // index-only seek regardless of how much non-held noise shares the same window.
  idx_entry_events_held: `CREATE INDEX IF NOT EXISTS idx_entry_events_held ON entry_events(created_at DESC) WHERE event = 'held'`,
  // The event readers' life-end subquery (quadratic in edits per memory without this index). No
  // json_extract in the WHERE -- must never throw on a non-JSON payload; readers check trash=0 on top.
  idx_entry_events_life_end: `CREATE INDEX IF NOT EXISTS idx_entry_events_life_end ON entry_events(entry_id) WHERE event IN ('purged', 'deleted')`,
  // Immutable administration audit trail. Same contract as entry_events:
  // application code only ever INSERTs here. Consumed by Phase 4.2.
  admin_events: `CREATE TABLE IF NOT EXISTS admin_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL DEFAULT '', target_user_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  idx_admin_events_created: `CREATE INDEX IF NOT EXISTS idx_admin_events_created ON admin_events(created_at DESC)`,
  maintenance_cursor: `CREATE TABLE IF NOT EXISTS maintenance_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), workspace_id TEXT NOT NULL DEFAULT '', advanced_at INTEGER NOT NULL DEFAULT 0)`,
  ...WRITE_PROTECTION_TABLES_BEFORE_OAUTH,
  oauth_registration_quota: `CREATE TABLE IF NOT EXISTS oauth_registration_quota (id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, registration_count INTEGER NOT NULL)`,
  ...WRITE_PROTECTION_TABLES_AFTER_OAUTH,
  // Projectsは追加schema。membershipはentries.tagsに保持し、既存記憶のbackfillはしない。
  // schema version 6への更新後は旧Workerへの単純なdowngradeを許可しない。
  projects: `CREATE TABLE IF NOT EXISTS projects (id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', aliases TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER, restore_lease_owner TEXT, write_marker TEXT, PRIMARY KEY (workspace_id, id))`,
  idx_projects_workspace: `CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id, status)`,
  // Web Push subscriptions. Additive, like projects above: old code never
  // reads this table and rollback is a no-op. One row per subscribed
  // browser/device; endpoint_hash is unique so re-subscribing the same
  // device replaces rather than duplicates it.
  push_subscriptions: `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT '', endpoint_hash TEXT NOT NULL, subscription_json TEXT NOT NULL, content_free INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_ok_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0, UNIQUE(endpoint_hash))`,
  idx_push_subscriptions_workspace: `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_workspace ON push_subscriptions(workspace_id)`,
  // Sampled recall log (T-0089.5.2 Part A). Additive, like push_subscriptions above: old
  // code never reads this table and rollback is a no-op. Opt-in and sampled, so a brain
  // that never turns RECALL_LOG on never writes a row here.
  recall_log: `CREATE TABLE IF NOT EXISTS recall_log (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL, channel TEXT NOT NULL, query TEXT NOT NULL, params TEXT NOT NULL, returned_ids TEXT NOT NULL, followed_ids TEXT NOT NULL DEFAULT '[]', write_marker TEXT, restore_lease_owner TEXT)`,
  idx_recall_log_ws: `CREATE INDEX IF NOT EXISTS idx_recall_log_ws ON recall_log(workspace_id, created_at DESC)`,
  // Content history and soft delete (4.0). Additive: old code never reads either table,
  // so rollback is a no-op. Never backfilled.
  entry_versions: `CREATE TABLE IF NOT EXISTS entry_versions (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL, content TEXT, prior_length INTEGER, prior_length_utf16 INTEGER, tags TEXT NOT NULL, state TEXT NOT NULL DEFAULT '{}', actor_id TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', valid_from INTEGER, created_at INTEGER NOT NULL, write_marker TEXT, restore_lease_owner TEXT, CHECK ((content IS NULL) <> (prior_length IS NULL)), CHECK (prior_length_utf16 IS NULL OR prior_length IS NOT NULL))`,
  idx_entry_versions_entry: `CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_versions_entry ON entry_versions(entry_id, seq)`,
  entries_trash: `CREATE TABLE IF NOT EXISTS entries_trash (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, row_json TEXT NOT NULL, edges_json TEXT NOT NULL DEFAULT '[]', vector_ids TEXT NOT NULL DEFAULT '[]', deleted_at INTEGER NOT NULL, deleted_by TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT 'forget', nonce TEXT NOT NULL DEFAULT '', write_marker TEXT, restore_lease_owner TEXT)`,
  idx_entries_trash_deleted: `CREATE INDEX IF NOT EXISTS idx_entries_trash_deleted ON entries_trash(deleted_at)`,
  // R5 (budget audit, MINOR): listTrash scopes by workspace_id and orders by deleted_at DESC;
  // without this, SQLite's only path is the deleted_at index above, so it walks the whole trash
  // table filtering every row for a workspace match — see db/schema.sql for the measured cost.
  idx_entries_trash_workspace_deleted: `CREATE INDEX IF NOT EXISTS idx_entries_trash_workspace_deleted ON entries_trash(workspace_id, deleted_at DESC)`,
  // Per-trigram document counts over entries_fts, read by distillation to price its df counts (src/recall/distill.ts).
  // Stores nothing and resolves entries_fts by name at query time, so it may exist before, and survive a rebuild of, the index.
  entries_fts_vocab: ENTRIES_FTS_VOCAB_DDL,
  // entries_fts and its three sync triggers are NOT here (v2.2 ownership
  // rule): they are created together, in one dedicated batch, below in
  // applySchema — never as independent SCHEMA_OBJECTS/POST_COLUMN_OBJECTS
  // entries, which would let one be created or repaired without the other.
  // entry_counts and its three triggers (T-0065) follow the same rule, in
  // their own dedicated batch below.
};

/**
 * Columns added to `entries` after the table shipped, keyed by column name. They arrived
 * across several releases, so a real brain can hold any prefix of this list — the probe
 * below is what decides which ones are still owed.
 */
const ENTRIES_COLUMNS: Record<string, string> = {
  recall_count: `ALTER TABLE entries ADD COLUMN recall_count INTEGER DEFAULT 0`,
  importance_score: `ALTER TABLE entries ADD COLUMN importance_score INTEGER DEFAULT 0`,
  contradiction_wins: `ALTER TABLE entries ADD COLUMN contradiction_wins INTEGER DEFAULT 0`,
  contradiction_losses: `ALTER TABLE entries ADD COLUMN contradiction_losses INTEGER DEFAULT 0`,
  // updated_at and staleness_checked_at are deliberately nullable and deliberately NOT
  // backfilled. Every reader coalesces them to a sensible default — updated_at to
  // created_at (COALESCE in SQL, ?? in TS), staleness_checked_at to 0 — so on an
  // existing row a NULL and a written value are indistinguishable downstream, and a
  // backfill would be a pure no-op that still costs one row written per entry. That is
  // not free: D1's plan limits row writes per day, and exceeding the cap fails every
  // query account-wide until 00:00 UTC, so backfilling a large brain on the ordinary
  // upgrade path is an availability risk that buys nothing. Please do not add one.
  // test/unit/updated-at-coalesced.test.ts fails if any reader stops coalescing.
  updated_at: `ALTER TABLE entries ADD COLUMN updated_at INTEGER`,
  staleness_checked_at: `ALTER TABLE entries ADD COLUMN staleness_checked_at INTEGER`,
  memory_tier: `ALTER TABLE entries ADD COLUMN memory_tier TEXT DEFAULT 'warm'`,
  pinned: `ALTER TABLE entries ADD COLUMN pinned INTEGER DEFAULT 0`,
  last_recalled_at: `ALTER TABLE entries ADD COLUMN last_recalled_at INTEGER`,
  // Internal restore fencing token. It is never exported and ordinary writers leave it
  // NULL; a restore INSERT must present the current D1 lease owner.
  restore_lease_owner: `ALTER TABLE entries ADD COLUMN restore_lease_owner TEXT`,
  // Presented only by the authenticated owner running the final embedding delta.
  migration_lease_owner: `ALTER TABLE entries ADD COLUMN migration_lease_owner TEXT`,
  // Every ordinary source or derived write presents a live admission capability here.
  // Nullable keeps the upgrade additive; triggers require it once the epoch is active.
  write_marker: `ALTER TABLE entries ADD COLUMN write_marker TEXT`,
  workspace_id: `ALTER TABLE entries ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
  actor_id: `ALTER TABLE entries ADD COLUMN actor_id TEXT NOT NULL DEFAULT ''`,
  // Derived, resumable semantic work. The authoritative appended text is committed to
  // content in the same row; this bounded JSON passage lets recovery index only the
  // addition after a Workers AI quota or Vectorize outage.
  pending_append_passages: `ALTER TABLE entries ADD COLUMN pending_append_passages TEXT NOT NULL DEFAULT '[]'`,
  // The time-anchor primitive. Same nullable, never-backfilled shape as updated_at
  // above: most rows have no "when" at all, and NULL already reads that way to
  // every consumer. when_at is epoch ms; when_kind is 'due' | 'event' | 'wake';
  // when_source is 'explicit' | 'regex' | 'model', naming which of the three
  // producers (MCP/API caller, src/when/heuristic.ts, src/when/pass.ts) set it.
  when_at: `ALTER TABLE entries ADD COLUMN when_at INTEGER`,
  when_kind: `ALTER TABLE entries ADD COLUMN when_kind TEXT`,
  when_source: `ALTER TABLE entries ADD COLUMN when_source TEXT`,
  // The nightly model pass already generates a short label ("File the annual
  // report") to judge whether an entry is a real commitment; this is that
  // same text, kept instead of discarded, so GET /due can show it instead of
  // the first 80 characters of raw content. NULL on the explicit and regex
  // paths, which never generate one.
  when_label: `ALTER TABLE entries ADD COLUMN when_label TEXT`,
  // Validity windows (T-0089.2.1). Never backfilled: readers coalesce valid_from to
  // created_at and read a NULL valid_until as "still true". No index: every validity
  // predicate runs on rows another predicate already selected.
  valid_from: `ALTER TABLE entries ADD COLUMN valid_from INTEGER`,
  valid_until: `ALTER TABLE entries ADD COLUMN valid_until INTEGER`,
};

/** Edge columns added after the graph table shipped. */
const EDGES_COLUMNS: Record<string, string> = {
  restore_lease_owner: `ALTER TABLE edges ADD COLUMN restore_lease_owner TEXT`,
  write_marker: `ALTER TABLE edges ADD COLUMN write_marker TEXT`,
  workspace_id: `ALTER TABLE edges ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
};

const USERS_COLUMNS: Record<string, string> = {
  default_share: `ALTER TABLE users ADD COLUMN default_share TEXT NOT NULL DEFAULT ''`,
  removed_at: `ALTER TABLE users ADD COLUMN removed_at INTEGER`,
  last_used_at: `ALTER TABLE users ADD COLUMN last_used_at INTEGER`,
};

const ADMIN_EVENTS_COLUMNS: Record<string, string> = {
  target_user_id: `ALTER TABLE admin_events ADD COLUMN target_user_id TEXT NOT NULL DEFAULT ''`,
  workspace_id: `ALTER TABLE admin_events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
};

/**
 * Columns added to `entry_versions` after the table shipped (T-0089.1.1, ADV-10).
 *
 * prior_length_utf16 lets a reconstruction skip scanning a delta row's base for the UTF-16 boundary
 * `prior_length` (Unicode characters) points at, when the writer already had that boundary in JS and
 * stamped it directly. A brain with rows from before this column existed just falls back to the scan
 * for those — NULL is a valid, already-handled value, not a gap to backfill.
 */
const ENTRY_VERSIONS_COLUMNS: Record<string, string> = {
  write_marker: `ALTER TABLE entry_versions ADD COLUMN write_marker TEXT`,
  restore_lease_owner: `ALTER TABLE entry_versions ADD COLUMN restore_lease_owner TEXT`,
  prior_length_utf16: `ALTER TABLE entry_versions ADD COLUMN prior_length_utf16 INTEGER`,
};

/**
 * Columns added to `entries_trash` after the table shipped (T-0089.1.1, adv-final MAJAOR 1).
 *
 * nonce is a per-row identity independent of id and of SQLite's own reused rowid: additive,
 * idempotent, never backfilled. A row already in the trash when this column arrives keeps
 * reading '' forever — every trash mutation treats that as "cannot safely match this row",
 * never as a value to match against, so an old row fails closed (conflict) instead of being
 * silently trusted the way id or rowid alone were.
 */
const ENTRIES_TRASH_COLUMNS: Record<string, string> = {
  write_marker: `ALTER TABLE entries_trash ADD COLUMN write_marker TEXT`,
  restore_lease_owner: `ALTER TABLE entries_trash ADD COLUMN restore_lease_owner TEXT`,
  nonce: `ALTER TABLE entries_trash ADD COLUMN nonce TEXT NOT NULL DEFAULT ''`,
};

/**
 * Objects that can only be built once the ALTERs above have run — an index over a
 * column that arrives via ALTER. These must NOT live in SCHEMA_OBJECTS: that loop
 * runs before the ALTERs on every pass, so on an upgraded brain (table exists,
 * column missing) the CREATE would throw before the ALTER ever ran, and it would
 * throw again on every later pass. Applying them after the ALTER loops converges
 * in one pass on both fresh and upgraded brains.
 */
const POST_COLUMN_OBJECTS: Record<string, string> = {
  idx_entries_capsule: `CREATE INDEX IF NOT EXISTS idx_entries_capsule ON entries(workspace_id, id) WHERE instr(lower(tags), '"capsule:') > 0`,
  idx_entries_workspace_created: `CREATE INDEX IF NOT EXISTS idx_entries_workspace_created ON entries(workspace_id, created_at DESC)`,
  // Membership scans (GET /projects?counts=1) stay off ordinary memories. Post-column
  // because workspace_id arrives by ALTER on older brains.
  idx_entries_project: `CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(workspace_id, id) WHERE instr(lower(tags), '"project:') > 0`,
  // Held draft digests (a digest stored because it contradicted a memory a system job may not rewrite):
  // the nightly check for one reads only these rows. Post-column because workspace_id arrives by ALTER.
  idx_entries_conflict_held: `CREATE INDEX IF NOT EXISTS idx_entries_conflict_held ON entries(workspace_id, id) WHERE instr(lower(tags), '"conflict-held"') > 0`,
  // Agent brief queues (src/brief/compute.ts): each scans only its own rows instead of every
  // memory. Each WHERE is the instr(...) form the brief queries repeat, so the planner can use it.
  idx_entries_when: `CREATE INDEX IF NOT EXISTS idx_entries_when ON entries(workspace_id, when_at) WHERE when_at IS NOT NULL`,
  idx_entries_task: `CREATE INDEX IF NOT EXISTS idx_entries_task ON entries(workspace_id, created_at) WHERE instr(lower(tags), '"task"') > 0`,
  idx_entries_insight: `CREATE INDEX IF NOT EXISTS idx_entries_insight ON entries(workspace_id, created_at) WHERE instr(lower(tags), '"auto-insight"') > 0`,
  idx_entries_stale: `CREATE INDEX IF NOT EXISTS idx_entries_stale ON entries(workspace_id, id) WHERE instr(lower(tags), '"stale:as-of"') > 0`,
  // Track 7 (T-0089.7.1, T-0089.7.2): the decision log and standing-memory cache build each
  // scan only their own marker. Post-column like the three above: workspace_id arrives by
  // ALTER on older brains. Neither writes a row on upgrade — both tags are new.
  idx_entries_ledger: `CREATE INDEX IF NOT EXISTS idx_entries_ledger ON entries(workspace_id, created_at) WHERE instr(lower(tags), '"ledger:decision"') > 0`,
  idx_entries_standing: `CREATE INDEX IF NOT EXISTS idx_entries_standing ON entries(workspace_id, created_at) WHERE instr(lower(tags), '"standing:active"') > 0`,
  prompt_capsule_entry_insert: `CREATE TRIGGER IF NOT EXISTS prompt_capsule_entry_insert
    AFTER INSERT ON entries
    WHEN instr(lower(NEW.tags), '"capsule:') > 0 OR instr(lower(NEW.tags), '"capsule-slot:') > 0
    BEGIN
      INSERT INTO prompt_capsule_revisions (workspace_id, revision) VALUES (NEW.workspace_id, lower(hex(randomblob(16))))
      ON CONFLICT(workspace_id) DO UPDATE SET revision = lower(hex(randomblob(16)));
    END`,
  prompt_capsule_entry_update: `CREATE TRIGGER IF NOT EXISTS prompt_capsule_entry_update
    AFTER UPDATE OF id, content, tags, workspace_id ON entries
    WHEN instr(lower(OLD.tags), '"capsule:') > 0 OR instr(lower(OLD.tags), '"capsule-slot:') > 0
      OR instr(lower(NEW.tags), '"capsule:') > 0 OR instr(lower(NEW.tags), '"capsule-slot:') > 0
    BEGIN
      INSERT INTO prompt_capsule_revisions (workspace_id, revision) VALUES (OLD.workspace_id, lower(hex(randomblob(16))))
      ON CONFLICT(workspace_id) DO UPDATE SET revision = lower(hex(randomblob(16)));
      INSERT INTO prompt_capsule_revisions (workspace_id, revision)
      SELECT NEW.workspace_id, lower(hex(randomblob(16))) WHERE NEW.workspace_id <> OLD.workspace_id
      ON CONFLICT(workspace_id) DO UPDATE SET revision = lower(hex(randomblob(16)));
    END`,
  prompt_capsule_entry_delete: `CREATE TRIGGER IF NOT EXISTS prompt_capsule_entry_delete
    AFTER DELETE ON entries
    WHEN instr(lower(OLD.tags), '"capsule:') > 0 OR instr(lower(OLD.tags), '"capsule-slot:') > 0
    BEGIN
      INSERT INTO prompt_capsule_revisions (workspace_id, revision) VALUES (OLD.workspace_id, lower(hex(randomblob(16))))
      ON CONFLICT(workspace_id) DO UPDATE SET revision = lower(hex(randomblob(16)));
    END`,
  prompt_capsule_workspace_delete: `CREATE TRIGGER IF NOT EXISTS prompt_capsule_workspace_delete
    AFTER DELETE ON workspaces
    BEGIN
      DELETE FROM prompt_capsule_revisions WHERE workspace_id = OLD.id;
    END`,
};

/**
 * One statement that reports every schema object this file knows how to create: table,
 * index, and trigger names out of sqlite_master, and entries' columns out of the
 * table-valued form of PRAGMA table_info (SQLite rewrites neither list lazily — an
 * ALTER shows up immediately).
 * `kind` is what stops a name that appears on both sides from being read as the wrong one.
 *
 * This exists because the fifteen statements it replaces cost fifteen subrequests to
 * discover that a migrated brain — which is every brain after its first request — needs
 * nothing done (#282). Free-plan invocations get 50 subrequests, ensureDbReady spends
 * them inside the request that triggered it, and GET /graph was already close enough to
 * the ceiling that a cold isolate pushed it over: 59 against a limit of 50, now 47.
 *
 * Cost is one subrequest and one row read per catalogue entry, flat in the number of
 * entries because neither the catalogue nor pragma subqueries touch table data — measured on real D1
 * (workerd via Miniflare), not the mock, which is not something that can be re-verified
 * from a laptop. rows_read = 23 was that measurement, but it predates insight_candidates
 * and its index: it was taken when SCHEMA_OBJECTS held seven objects, not the nine it
 * holds now (plus D1's own bookkeeping table, SQLite's implicit autoindexes, and twelve
 * columns), so 23 is stale by two rows and should be re-measured against a live database
 * rather than trusted as today's figure. What the measurement did establish, and what
 * still holds regardless of the exact count: it grows by one row per object added to
 * SCHEMA_OBJECTS, which is the cheap direction — adding a statement above now costs one
 * row here rather than one subrequest on every cold start.
 */
// D1 expands each table-valued pragma internally. Combining five of them with UNION ALL
// crosses SQLite's 500-term compound-SELECT limit even though only five UNION arms are
// visible here. Aggregate each catalogue into JSON, then flatten the nested arrays with
// json_each: the result shape stays { kind, name } and the whole probe remains one query.
const PROBE_SQL =
  `WITH schema_groups(groups) AS (SELECT json_array(` +
  `json((SELECT json_group_array(json_object('kind', type, 'name', name, 'definition', sql)) FROM sqlite_master WHERE type IN ('table','index','trigger'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'entry_column', 'name', name)) FROM pragma_table_info('entries'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'edge_column', 'name', name)) FROM pragma_table_info('edges'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'project_column', 'name', name)) FROM pragma_table_info('projects'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'insight_column', 'name', name)) FROM pragma_table_info('insight_candidates'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'admission_column', 'name', name)) FROM pragma_table_info('memory_write_admissions'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'cleanup_column', 'name', name)) FROM pragma_table_info('vector_cleanup_ops'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'restore_column', 'name', name)) FROM pragma_table_info('restore_state'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'migration_column', 'name', name)) FROM pragma_table_info('migration_control'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'user_column', 'name', name)) FROM pragma_table_info('users'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'entry_version_column', 'name', name)) FROM pragma_table_info('entry_versions'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'recall_log_column', 'name', name)) FROM pragma_table_info('recall_log'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'entries_trash_column', 'name', name)) FROM pragma_table_info('entries_trash'))), ` +
  `json((SELECT json_group_array(json_object('kind', 'admin_event_column', 'name', name)) FROM pragma_table_info('admin_events'))))) ` +
  `SELECT json_extract(item.value, '$.kind') AS kind, json_extract(item.value, '$.name') AS name, json_extract(item.value, '$.definition') AS definition ` +
  `FROM schema_groups, json_each(schema_groups.groups) AS group_rows, json_each(group_rows.value) AS item`;

type ObjectKind = "table" | "index" | "trigger";
/**
 * `objects` maps name to kind rather than being a set of names, because SQLite puts tables,
 * indexes, and triggers in one namespace: a name can be taken by the wrong kind of thing. Skipping on
 * the name alone would let a user table called `idx_entries_source` stand in for the index,
 * which resolves init successfully and silently never creates it.
 */
type ExistingSchema = {
  entryVersionColumns: Set<string>;
  entriesTrashColumns: Set<string>;
  recallLogColumns: Set<string>;
  definitions: Map<string, string>;
  objects: Map<string, ObjectKind>;
  entryColumns: Set<string>;
  edgeColumns: Set<string>;
  projectColumns: Set<string>;
  insightColumns: Set<string>;
  admissionColumns: Set<string>;
  cleanupColumns: Set<string>;
  restoreColumns: Set<string>;
  migrationColumns: Set<string>;
  userColumns: Set<string>;
  adminEventColumns: Set<string>;
};

/** Which kind of object a CREATE statement makes, so the probe can be asked about it. */
const kindOf = (ddl: string): ObjectKind => /^CREATE (?:VIRTUAL )?TABLE/.test(ddl)
  ? "table"
  : ddl.startsWith("CREATE TRIGGER")
    ? "trigger"
    : "index";

/**
 * What the database already has, or null if that could not be established.
 *
 * The invariant, and the only one that matters here: this may report a thing PRESENT only
 * if it actually saw it, as the kind it is looking for. Everything else — the probe
 * throwing, a result shape it does not recognise, a row whose `kind` is not one of the
 * four, a name that exists as the other kind — resolves towards "missing", so the worst a
 * confused probe can do is make applySchema pay the old whole-schema cost against DDL
 * that is idempotent anyway. The opposite error is the one that would hurt: a brand-new
 * brain talked out of migrating would then serve every request against tables that do not
 * exist.
 *
 * Returning null rather than throwing is not error-swallowing. It does not resolve
 * initializeDatabase — applySchema still has to apply and still rejects if the DDL fails.
 * It degrades this isolate to the pre-#282 cost, which is the behaviour that shipped for
 * every release before this one, and it is what keeps an unsupported PRAGMA on some
 * future D1 from bricking first-request migration for every new install.
 */
async function probeSchema(env: Env): Promise<ExistingSchema | null> {
  let rows: unknown;
  try {
    rows = (await env.DB.prepare(PROBE_SQL).all<{ kind: string; name: string }>())?.results;
  } catch {
    console.warn("Schema probe failed; applying the full schema instead");
    return null;
  }
  if (!Array.isArray(rows)) return null;

  const objects = new Map<string, ObjectKind>();
  const definitions = new Map<string, string>();
  const entryColumns = new Set<string>();
  const edgeColumns = new Set<string>();
  const projectColumns = new Set<string>();
  const insightColumns = new Set<string>();
  const admissionColumns = new Set<string>();
  const cleanupColumns = new Set<string>();
  const restoreColumns = new Set<string>();
  const migrationColumns = new Set<string>();
  const userColumns = new Set<string>();
  const adminEventColumns = new Set<string>();
  const entryVersionColumns = new Set<string>();
  const entriesTrashColumns = new Set<string>();
  const recallLogColumns = new Set<string>();
  for (const row of rows as { kind?: unknown; name?: unknown; definition?: unknown }[]) {
    if (typeof row?.name !== "string") continue;
    if (row.kind === "entry_column") entryColumns.add(row.name);
    else if (row.kind === "project_column") projectColumns.add(row.name);
    else if (row.kind === "edge_column") edgeColumns.add(row.name);
    else if (row.kind === "insight_column") insightColumns.add(row.name);
    else if (row.kind === "admission_column") admissionColumns.add(row.name);
    else if (row.kind === "cleanup_column") cleanupColumns.add(row.name);
    else if (row.kind === "restore_column") restoreColumns.add(row.name);
    else if (row.kind === "migration_column") migrationColumns.add(row.name);
    else if (row.kind === "user_column") userColumns.add(row.name);
    else if (row.kind === "admin_event_column") adminEventColumns.add(row.name);
    else if (row.kind === "entry_version_column") entryVersionColumns.add(row.name);
    else if (row.kind === "recall_log_column") recallLogColumns.add(row.name);
    else if (row.kind === "entries_trash_column") entriesTrashColumns.add(row.name);
    else if (row.kind === "table" || row.kind === "index" || row.kind === "trigger") {
      objects.set(row.name, row.kind);
      if (typeof row.definition === "string") definitions.set(row.name, row.definition);
    }
  }
  return {
    entryVersionColumns,
    entriesTrashColumns,
    recallLogColumns,
    definitions,
    objects,
    entryColumns,
    edgeColumns,
    projectColumns,
    insightColumns,
    admissionColumns,
    cleanupColumns,
    restoreColumns,
    migrationColumns,
    userColumns,
    adminEventColumns,
  };
}

/**
 * users.email is UNIQUE. The constraint cannot ship as an ordinary SCHEMA_OBJECTS
 * entry: on a brain that already holds two members with the same email — the
 * check-then-INSERT race this index closes — the CREATE itself would throw,
 * applySchema would reject, and initializeDatabase would refuse to memoise, so
 * EVERY request from then on would fail against a database that is otherwise
 * fine. Instead the index is built with a repair path: create it, and only if
 * the build trips over existing duplicates, collapse them (earliest created
 * keeps the address — "first created wins", what the app-level guard intended)
 * and create again. Fresh brains have no duplicates and pay one statement, once.
 */
const EMAIL_UNIQUE_INDEX_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`;
const EMAIL_DEDUPLICATE_SQL =
  `UPDATE users SET email = NULL ` +
  `WHERE id IN (` +
  `  SELECT id FROM (` +
  `    SELECT id, ROW_NUMBER() OVER (PARTITION BY email ORDER BY created_at ASC, id ASC) AS rn` +
  `      FROM users WHERE email IS NOT NULL` +
  `  ) WHERE rn > 1` +
  `)`;

/**
 * The one ALTER failure that is routine rather than a fault: the column was added between
 * the probe and here. That window is small now but not closed — two isolates can cold-start
 * on the same brain at once, and D1 has no transactional DDL to serialise them — so this
 * stays as the backstop it was. Every other error means the schema is not in the shape the
 * code expects.
 */
function isDuplicateColumn(e: unknown): boolean {
  return /duplicate column name/i.test(String((e as { message?: string })?.message ?? e));
}

/**
 * The one CREATE failure that is routine rather than a fault: building a UNIQUE
 * index over data that already violates it. Both D1 and node:sqlite surface
 * SQLite's own message. Any other error means the schema is not in the shape
 * the code expects and still rejects.
 */
function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as { message?: string })?.message ?? e));
}

// Rejects on any genuine failure. Nothing here may swallow errors: a resolved promise is
// the signal initializeDatabase memoises, so swallowing would cache a schema that was
// never applied. The installer creates the D1 database moments before the first request
// reaches the Worker, so the very first run is exactly when a transient error is most
// likely — and most damaging, since that run is the one that creates every table.
//
// A fully migrated brain leaves here having issued the probe and nothing else. The DDL
// keeps its IF NOT EXISTS: it costs nothing to keep and it is the same backstop as the
// duplicate-column tolerance, for the same concurrent-cold-start race.
async function applySchema(env: Env): Promise<DatabaseInitResult> {
  const existing = await probeSchema(env);
  let changed = existing === null;
  // A successful probe can prove a table is absent. Its CREATE below uses the
  // current full definition, so replaying every historical ALTER in the same
  // invocation would waste 25 D1 statements and push a clean bootstrap over the
  // Free 50-query ceiling. A failed/unknown probe does not take this shortcut.
  const createdFresh = (table: string) => existing !== null && existing.objects.get(table) !== "table";
  const freshEntries = createdFresh("entries");
  const freshEdges = createdFresh("edges");
  const freshInsights = createdFresh("insight_candidates");
  const freshAdmissions = createdFresh("memory_write_admissions");
  const freshCleanup = createdFresh("vector_cleanup_ops");
  const freshRestore = createdFresh("restore_state");
  const freshMigration = createdFresh("migration_control");
  const freshUsers = createdFresh("users");
  const freshAdminEvents = createdFresh("admin_events");

  for (const [name, ddl] of Object.entries(SCHEMA_OBJECTS)) {
    // Kind as well as name: if something else has taken the name, this is not the object
    // we need and the CREATE has to be issued so SQLite raises the collision, which is
    // what it did before the probe existed.
    if (existing?.objects.get(name) === kindOf(ddl)) continue;
    changed = true;
    await env.DB.exec(ddl);
  }
  for (const [column, ddl] of Object.entries(ENTRIES_COLUMNS)) {
    if (freshEntries || existing?.entryColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e; // column already exists — anything else is real
    }
  }
  // The FTS index and sync triggers are a single atomic unit. A populated
  // brain must invalidate its ready latch before creating an empty index.

  // History starts when the table does. A failed probe (existing === null) is unknown, not
  // proof the table is new, so it never writes the marker; getVersionsSince recovers instead.
  if (existing !== null && existing.objects.get("entry_versions") !== "table") {
    try {
      await env.OAUTH_KV.put(VERSIONS_SINCE_KV_KEY, String(Date.now()));
    } catch (e) {
      console.error("versions:since write failed (non-fatal):", e);
    }
  }

  // Ownership (v2.2): entries_fts and its three sync triggers are created
  // together, in ONE batch, only when the table itself is missing — never
  // independently, and never repaired once the table exists (a trigger
  // missing on an existing table just reads as "not live" to every other
  // caller, src/recall/fts.ts, left for the nightly rebuildFtsIndex).
  //
  // Populated-brain creation rule: creating the table on a brain whose
  // `entries` already existed must first invalidate the ready flag and reset
  // the backfill cursor, so a freshly created but not-yet-backfilled index
  // is never served as ready. If that invalidation fails, DEFER — do not
  // create the table this pass — and report it (return true) so
  // initializeDatabase knows not to memoize this pass as fully done and
  // retries the creation on the next call.
  //
  // Deferral must be NON-FATAL (B1, v2.2 re-review, BLOCKER): throwing here
  // used to reject initializeDatabase itself, which authentication and every
  // other caller await — on a populated brain with entries_fts missing and
  // KV down (every existing brain's first request after this upgrade),
  // EVERY authenticated request would fail. Recall falls back to LIKE and
  // saves proceed with no FTS sync regardless; deferring only postpones
  // when the index catches up, never blocks the request it happened inside.
  // A brand-new brain (entries did not exist before this pass) is exempt
  // from all of this: nothing to invalidate, and the triggers cover it from
  // row one (see the fresh-brain ready latch below).
  let ftsDeferred = false;
  if (existing?.objects.get("entries_fts") !== "table") {
    const entriesPreexisted = existing === null || existing.objects.get("entries") === "table";
    let kvOk = true;
    if (entriesPreexisted) {
      try {
        await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
        await env.OAUTH_KV.put(FTS_BACKFILL_CURSOR_KV_KEY, "0");
      } catch (error) {
        kvOk = false;
        console.error("FTS creation deferred (non-fatal): KV invalidation failed:", error);
      }
    }
    if (!kvOk) {
      ftsDeferred = true;
    } else {
      changed = true;
      try {
        await env.DB.batch([
          env.DB.prepare(ENTRIES_FTS_TABLE_DDL),
          env.DB.prepare(ENTRIES_FTS_INSERT_TRIGGER_DDL),
          env.DB.prepare(ENTRIES_FTS_UPDATE_TRIGGER_DDL),
          env.DB.prepare(ENTRIES_FTS_DELETE_TRIGGER_DDL),
        ]);
      } catch (error) {
        if (!/table entries_fts already exists/i.test(String(error))) throw error;
      }
    }
  }
  // Seed and triggers share a transaction, so every concurrent entry write
  // is counted by either the seed or its trigger.
  if (existing?.objects.get("entry_counts") !== "table") {
    changed = true;
    try {
      await env.DB.batch([
        env.DB.prepare(ENTRY_COUNTS_TABLE_DDL),
        env.DB.prepare(ENTRY_COUNTS_INSERT_TRIGGER_DDL),
        env.DB.prepare(ENTRY_COUNTS_UPDATE_TRIGGER_DDL),
        env.DB.prepare(ENTRY_COUNTS_DELETE_TRIGGER_DDL),
        // scope-exempt: deployment-wide one-time seed for per-workspace counts.
        env.DB.prepare(`INSERT INTO entry_counts SELECT workspace_id, count(*) FROM entries GROUP BY workspace_id`),
      ]);
    } catch (error) {
      if (!/table entry_counts already exists/i.test(String(error))) throw error;
    }
  }
  if (freshEntries && !ftsDeferred) {
    try { await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1"); }
    catch (error) { console.error("FTS ready latch failed (non-fatal):", error); }
  }
  for (const [column, ddl] of Object.entries(EDGES_COLUMNS)) {
    if (freshEdges || existing?.edgeColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [column, ddl] of Object.entries(INSIGHT_CANDIDATE_COLUMNS)) {
    if (freshInsights || existing?.insightColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [column, ddl] of Object.entries(WRITE_ADMISSION_COLUMNS)) {
    if (freshAdmissions || existing?.admissionColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [column, ddl] of Object.entries(VECTOR_CLEANUP_COLUMNS)) {
    if (freshCleanup || existing?.cleanupColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const column of ["restore_lease_owner", "write_marker"]) {
    if (createdFresh("projects") || existing?.projectColumns.has(column)) continue;
    changed = true;
    try { await env.DB.exec(`ALTER TABLE projects ADD COLUMN ${column} TEXT`); }
    catch (e) { if (!isDuplicateColumn(e)) throw e; }
  }
  for (const [column, ddl] of Object.entries(RESTORE_STATE_COLUMNS)) {
    if (freshRestore || existing?.restoreColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e; // column already exists — anything else is real
    }
  }
  for (const [column, ddl] of Object.entries(MIGRATION_CONTROL_COLUMNS)) {
    if (freshMigration || existing?.migrationColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [column, ddl] of Object.entries(USERS_COLUMNS)) {
    if (freshUsers || existing?.userColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [column, ddl] of Object.entries(ADMIN_EVENTS_COLUMNS)) {
    if (freshAdminEvents || existing?.adminEventColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [column, ddl] of Object.entries(ENTRY_VERSIONS_COLUMNS)) {
    if (createdFresh("entry_versions") || existing?.entryVersionColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [column, ddl] of Object.entries(ENTRIES_TRASH_COLUMNS)) {
    if (createdFresh("entries_trash") || existing?.entriesTrashColumns.has(column)) continue;
    changed = true;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const column of ["write_marker", "restore_lease_owner"]) {
    if (createdFresh("recall_log") || existing?.recallLogColumns.has(column)) continue;
    changed = true;
    try { await env.DB.exec(`ALTER TABLE recall_log ADD COLUMN ${column} TEXT`); }
    catch (e) { if (!isDuplicateColumn(e)) throw e; }
  }
  // users.email uniqueness — see the note above EMAIL_UNIQUE_INDEX_DDL for why
  // this is not a plain SCHEMA_OBJECTS entry. Skipped once the index exists,
  // which the probe reports like any other index.
  if (existing?.objects.get("idx_users_email") !== "index") {
    changed = true;
    try {
      await env.DB.exec(EMAIL_UNIQUE_INDEX_DDL);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // The build tripped over duplicates a legacy brain accumulated through
      // the app-level check-then-INSERT gap. Resolve them, then build again;
      // a second failure here is a real fault and still rejects.
      await env.DB.exec(EMAIL_DEDUPLICATE_SQL);
      await env.DB.exec(EMAIL_UNIQUE_INDEX_DDL);
    }
  }
  for (const [name, ddl] of Object.entries(POST_COLUMN_OBJECTS)) {
    if (name === "idx_entries_capsule" && (existing === null || existing.objects.has(name))) {
      // 強制利用する専用indexは、同名でも定義が異なれば修復する。
      const normalize = (sql: string) => sql
        .replace(/^CREATE INDEX IF NOT EXISTS\s+/i, "CREATE INDEX ")
        .match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[a-zA-Z_]\w*|\d+|[^\s]/g)?.join(" ") ?? "";
      if (normalize(existing?.definitions.get(name) ?? "") !== normalize(ddl)) {
        await env.DB.batch([
          env.DB.prepare(`DROP INDEX IF EXISTS ${name}`),
          env.DB.prepare(ddl),
          env.DB.prepare(`UPDATE prompt_capsule_revisions SET revision = lower(hex(randomblob(16)))`),
        ]);
      }
      continue;
    }
    if (kindOf(ddl) === "trigger" && (existing === null || existing.objects.get(name) === "trigger"
      || existing.objects.get("prompt_capsule_revisions") === "table")) {
      // sqlite_master removes IF NOT EXISTS. Compare bodies so a deployed
      // trigger can be repaired on the next cold start, not frozen forever.
      const normalize = (sql: string) => sql
        .replace(/^CREATE TRIGGER IF NOT EXISTS\s+/i, "CREATE TRIGGER ")
        // SQL文字列の空白は意味を持つため、その内部は正規化しない。
        .match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[a-zA-Z_]\w*|\d+|[^\s]/g)?.join(" ") ?? "";
      if (normalize(existing?.definitions.get(name) ?? "") !== normalize(ddl)) {
        await env.DB.batch([
          env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`),
          env.DB.prepare(ddl),
          // A repaired invalidator must not reuse payloads from its old body.
          env.DB.prepare(`UPDATE prompt_capsule_revisions SET revision = lower(hex(randomblob(16)))`),
        ]);
      }
      continue;
    }
    if (existing?.objects.get(name) === kindOf(ddl)) continue;
    changed = true;
    // D1Database.exec splits on semicolons, including the statements inside a
    // trigger body, and therefore sends an incomplete CREATE TRIGGER. Prepared
    // DDL keeps the trigger as one SQLite statement.
    if (kindOf(ddl) === "trigger") await env.DB.prepare(ddl).run();
    else await env.DB.exec(ddl);
  }
  // Admissions deliberately spend only the cleanup+claim statements on the hot path.
  // Seed the generation once during schema convergence instead of issuing a no-op
  // INSERT on every request. The current triggers remain fail-closed if this row is ever
  // removed. Admission acquisition has a bounded repair+retry path for an interrupted
  // older schema pass that created the table but did not seed this singleton.
  if (existing?.objects.get("memory_write_epoch") !== "table") {
    changed = true;
    // D1 exec splits on newlines; keep this single-statement seed on one line.
    await env.DB.exec(`INSERT INTO memory_write_epoch (id, generation) VALUES ('current', lower(hex(randomblob(16)))) ON CONFLICT(id) DO NOTHING;`);
  }
  if (existing?.objects.get("integration_state_generation") !== "table") {
    changed = true;
    await env.DB.exec(`INSERT INTO integration_state_generation (id, generation, restore_count) VALUES ('current', lower(hex(randomblob(16))), 0) ON CONFLICT(id) DO NOTHING;`);
  }
  for (const [name, ddl] of Object.entries(WRITE_FENCE_TRIGGERS)) {
    if (existing?.objects.get(name) === "trigger") continue;
    changed = true;
    // D1Database.exec treats newlines as statement separators, including the
    // newlines inside CREATE TRIGGER ... BEGIN ... END. Collapse this one DDL
    // statement before sending it to workerd.
    await env.DB.exec(ddl.replace(/\s+/g, " ").trim());
  }
  // Install every fail-closed capability trigger before retiring its older barrier-only
  // predecessor. During a rolling upgrade there is never a gap with neither generation.
  for (const name of OBSOLETE_WRITE_FENCE_TRIGGERS) {
    if (existing !== null && existing.objects.get(name) !== "trigger") continue;
    changed = true;
    await env.DB.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  return { changed, ftsDeferred };
}
