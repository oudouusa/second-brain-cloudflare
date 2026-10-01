/** Fork-owned DDL declarations. applySchema in init.ts still owns the execution order. */

export const WRITE_PROTECTION_TABLES_BEFORE_OAUTH: Record<string, string> = {
  // D1-backed rather than KV-backed: the final cutover lock must become visible
  // to writers consistently across colos before the last delta pass begins.
  migration_control: `CREATE TABLE IF NOT EXISTS migration_control (id TEXT PRIMARY KEY, locked_at INTEGER NOT NULL, reason TEXT NOT NULL, owner_id TEXT, final_delta_completed_at INTEGER, active_delta_token TEXT, active_delta_expires_at INTEGER)`,
  memory_write_epoch: `CREATE TABLE IF NOT EXISTS memory_write_epoch (id TEXT PRIMARY KEY, generation TEXT NOT NULL)`,
  memory_write_admissions: `CREATE TABLE IF NOT EXISTS memory_write_admissions (token TEXT PRIMARY KEY, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, generation TEXT NOT NULL)`,
  // Restore progress belongs to the destination database, not the shared OAuth KV.
  // This prevents a restore drill or a retired database from blocking recovery of a
  // different D1 database that happens to use the same KV namespace.
  restore_state: `CREATE TABLE IF NOT EXISTS restore_state (id TEXT PRIMARY KEY, backup_id TEXT NOT NULL, backup_sha256 TEXT, run_id TEXT NOT NULL, started_at INTEGER NOT NULL, next_offset INTEGER NOT NULL DEFAULT 0, next_edge_offset INTEGER NOT NULL DEFAULT 0, next_project_offset INTEGER NOT NULL DEFAULT 0, next_history_offset INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER)`,
  embedding_migration_generation: `CREATE TABLE IF NOT EXISTS embedding_migration_generation (id TEXT PRIMARY KEY, generation TEXT NOT NULL)`,
  integration_state_generation: `CREATE TABLE IF NOT EXISTS integration_state_generation (id TEXT PRIMARY KEY, generation TEXT NOT NULL, restore_count INTEGER NOT NULL DEFAULT 0)`,
  integration_provider_generation: `CREATE TABLE IF NOT EXISTS integration_provider_generation (provider TEXT PRIMARY KEY, generation TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, draining INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at INTEGER)`,
};

export const WRITE_PROTECTION_TABLES_AFTER_OAUTH: Record<string, string> = {
  // Every vector write is journaled before it reaches Vectorize and cleared only after
  // D1 points at the surviving IDs (or the unreferenced IDs were deleted). This closes
  // the capture -> immediate forget race even if Vectorize cleanup itself is transiently
  // unavailable: the nightly maintenance pass can finish the durable tombstone later.
  vector_cleanup_ops: `CREATE TABLE IF NOT EXISTS vector_cleanup_ops (op_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, vector_ids TEXT NOT NULL, created_at INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, write_marker TEXT)`,
  // One bounded receipt per entry protects the common timeout/5xx retry without an
  // unbounded operation log. A later, distinct append replaces the older receipt.
  append_receipts: `CREATE TABLE IF NOT EXISTS append_receipts (entry_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, indexed INTEGER NOT NULL, completed_at INTEGER NOT NULL)`,
};

export const INSIGHT_CANDIDATE_COLUMNS: Record<string, string> = {
  write_marker: `ALTER TABLE insight_candidates ADD COLUMN write_marker TEXT`,
};

export const WRITE_ADMISSION_COLUMNS: Record<string, string> = {
  // Old Workers can still issue the legacy three-column INSERT during a rolling deploy.
  // A nullable migration lets that INSERT finish harmlessly; the trigger never accepts
  // a NULL generation as a write capability.
  generation: `ALTER TABLE memory_write_admissions ADD COLUMN generation TEXT`,
};

export const VECTOR_CLEANUP_COLUMNS: Record<string, string> = {
  write_marker: `ALTER TABLE vector_cleanup_ops ADD COLUMN write_marker TEXT`,
};

/** Restore coordination columns added after the first D1-backed ledger shipped. */
export const RESTORE_STATE_COLUMNS: Record<string, string> = {
  next_history_offset: `ALTER TABLE restore_state ADD COLUMN next_history_offset INTEGER NOT NULL DEFAULT 0`,
  next_project_offset: `ALTER TABLE restore_state ADD COLUMN next_project_offset INTEGER NOT NULL DEFAULT 0`,
  // Nullable ALTERs are intentional: SQLite cannot add a NOT NULL column without a
  // default to an existing table. acquireRestoreLease fills run_id before using a row.
  run_id: `ALTER TABLE restore_state ADD COLUMN run_id TEXT`,
  backup_sha256: `ALTER TABLE restore_state ADD COLUMN backup_sha256 TEXT`,
  lease_owner: `ALTER TABLE restore_state ADD COLUMN lease_owner TEXT`,
  lease_expires_at: `ALTER TABLE restore_state ADD COLUMN lease_expires_at INTEGER`,
};

export const MIGRATION_CONTROL_COLUMNS: Record<string, string> = {
  owner_id: `ALTER TABLE migration_control ADD COLUMN owner_id TEXT`,
  final_delta_completed_at: `ALTER TABLE migration_control ADD COLUMN final_delta_completed_at INTEGER`,
  active_delta_token: `ALTER TABLE migration_control ADD COLUMN active_delta_token TEXT`,
  active_delta_expires_at: `ALTER TABLE migration_control ADD COLUMN active_delta_expires_at INTEGER`,
};

// Created only after the marker ALTERs above. Existing databases do not have the marker
// columns when SCHEMA_OBJECTS is applied, so putting these in that earlier map would make
// the first upgraded cold start fail before it could add the columns the triggers use.
export const OBSOLETE_WRITE_FENCE_TRIGGERS = [
  "trg_entries_write_fence_insert_v2",
  "trg_entries_write_fence_update_v2",
  "trg_entries_write_fence_delete_v2",
  "trg_edges_write_fence_insert_v2",
  "trg_edges_write_fence_update_v2",
  "trg_edges_write_fence_delete_v2",
  "trg_insight_candidates_write_fence_insert_v2",
  "trg_insight_candidates_write_fence_update_v2",
  "trg_insight_candidates_write_fence_delete_v2",
  "trg_entries_write_fence_vector_update_v3",
  "trg_entries_write_fence_insert_v3",
  "trg_entries_write_fence_source_update_v3",
  "trg_entries_write_fence_vector_update_v4",
  "trg_entries_write_fence_delete_v3",
  "trg_edges_write_fence_insert_v3",
  "trg_edges_write_fence_update_v3",
  "trg_edges_write_fence_delete_v3",
  "trg_insight_candidates_write_fence_insert_v3",
  "trg_insight_candidates_write_fence_update_v3",
  "trg_insight_candidates_write_fence_delete_v3",
  "trg_entries_write_fence_insert_v4",
  "trg_entries_write_fence_source_update_v4",
  "trg_entries_write_fence_vector_update_v5",
  "trg_entries_write_fence_delete_v4",
  "trg_edges_write_fence_insert_v4",
  "trg_edges_write_fence_update_v4",
  "trg_edges_write_fence_delete_v4",
  "trg_insight_candidates_write_fence_insert_v4",
  "trg_insight_candidates_write_fence_update_v4",
  "trg_insight_candidates_write_fence_delete_v4",
  "trg_entries_write_fence_source_update_v5",
  "trg_entries_write_fence_source_update_v6",
  "trg_entries_write_fence_source_update_v8",
  "trg_entries_write_fence_vector_update_v6",
] as const;

export const D1_NOW_MS = `CAST(strftime('%s', 'now') AS INTEGER) * 1000`;
const activeAdmission = (marker: string) => `EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > ${D1_NOW_MS}
    AND substr(${marker}, 1, length(a.token) + 1) = a.token || ':'
)`;
const activeDeleteAdmission = (marker: string) => `EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > ${D1_NOW_MS}
    AND substr(${marker}, 1, length(a.token) + 8) = a.token || ':delete:'
)`;
const migrationBarrier = `EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= ${D1_NOW_MS})
)`;
const restoreBarrier = `EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > ${D1_NOW_MS})))`;
const restoreInsert = (marker: string) => `EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND lease_owner IS NOT NULL AND lease_owner = ${marker} AND lease_expires_at > ${D1_NOW_MS})`;
const finalDeltaUpdate = `NEW.migration_lease_owner IS NOT OLD.migration_lease_owner AND EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock' AND owner_id IS NOT NULL
    AND active_delta_token IS NOT NULL AND active_delta_expires_at > ${D1_NOW_MS}
    AND substr(NEW.migration_lease_owner, 1, length(owner_id) + length(active_delta_token) + 2)
      = owner_id || ':' || active_delta_token || ':'
)`;
const activeFinalDeltaMarker = (marker: string) => `EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock' AND owner_id IS NOT NULL
    AND active_delta_token IS NOT NULL AND active_delta_expires_at > ${D1_NOW_MS}
    AND substr(${marker}, 1, length(owner_id) + length(active_delta_token) + 2)
      = owner_id || ':' || active_delta_token || ':'
)`;

export const WRITE_FENCE_TRIGGERS: Record<string, string> = {
  trg_entry_versions_write_fence_insert_v1: `CREATE TRIGGER IF NOT EXISTS trg_entry_versions_write_fence_insert_v1 BEFORE INSERT ON entry_versions WHEN NOT (${restoreInsert("NEW.restore_lease_owner")}) AND (${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")})) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_entry_versions_write_fence_update_v1: `CREATE TRIGGER IF NOT EXISTS trg_entry_versions_write_fence_update_v1 BEFORE UPDATE ON entry_versions WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")}) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_entries_trash_write_fence_insert_v1: `CREATE TRIGGER IF NOT EXISTS trg_entries_trash_write_fence_insert_v1 BEFORE INSERT ON entries_trash WHEN NOT (${restoreInsert("NEW.restore_lease_owner")}) AND (${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")})) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_entries_trash_write_fence_update_v1: `CREATE TRIGGER IF NOT EXISTS trg_entries_trash_write_fence_update_v1 BEFORE UPDATE ON entries_trash WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")}) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_recall_log_write_fence_insert_v1: `CREATE TRIGGER IF NOT EXISTS trg_recall_log_write_fence_insert_v1 BEFORE INSERT ON recall_log WHEN NOT (${restoreInsert("NEW.restore_lease_owner")}) AND (${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")})) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_recall_log_write_fence_update_v1: `CREATE TRIGGER IF NOT EXISTS trg_recall_log_write_fence_update_v1 BEFORE UPDATE ON recall_log WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")}) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  // scope-outer-join: triggerのONはjoinではない。OLD.entry_idで同一記憶のcapabilityのみ検証し応答行を返さない。
  trg_entry_versions_write_fence_delete_v1: `CREATE TRIGGER IF NOT EXISTS trg_entry_versions_write_fence_delete_v1 BEFORE DELETE ON entry_versions WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (
    ${activeAdmission("OLD.write_marker")} OR EXISTS (SELECT 1 FROM entries p WHERE p.id = OLD.entry_id AND ${activeAdmission("p.write_marker")}) OR EXISTS (SELECT 1 FROM entries_trash p WHERE p.id = OLD.entry_id AND ${activeAdmission("p.write_marker")}) OR EXISTS (SELECT 1 FROM entry_versions p WHERE p.entry_id = OLD.entry_id AND ${activeAdmission("p.write_marker")})
  ) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  // scope-outer-join: triggerのONはjoinではない。OLD.idの復元済み記憶のcapabilityのみ検証する。
  trg_entries_trash_write_fence_delete_v1: `CREATE TRIGGER IF NOT EXISTS trg_entries_trash_write_fence_delete_v1 BEFORE DELETE ON entries_trash WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (
    ${activeDeleteAdmission("OLD.write_marker")} OR EXISTS (SELECT 1 FROM entries p WHERE p.id = OLD.id AND ${activeAdmission("p.write_marker")})
  ) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_recall_log_write_fence_delete_v1: `CREATE TRIGGER IF NOT EXISTS trg_recall_log_write_fence_delete_v1 BEFORE DELETE ON recall_log WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeDeleteAdmission("OLD.write_marker")}) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_projects_write_fence_insert_v1: `CREATE TRIGGER IF NOT EXISTS trg_projects_write_fence_insert_v1 BEFORE INSERT ON projects WHEN NOT (${restoreInsert("NEW.restore_lease_owner")}) AND (${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")})) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_projects_write_fence_update_v1: `CREATE TRIGGER IF NOT EXISTS trg_projects_write_fence_update_v1 BEFORE UPDATE ON projects WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")}) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_projects_write_fence_delete_v1: `CREATE TRIGGER IF NOT EXISTS trg_projects_write_fence_delete_v1 BEFORE DELETE ON projects WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeDeleteAdmission("OLD.write_marker")}) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  // scope-outer-join: the lexer reads CREATE TRIGGER's `INSERT ON edges` as an undecidable join; this is DDL whose two EXISTS checks only validate NEW endpoint ids and return no corpus rows
  trg_edges_endpoint_guard_v1: `CREATE TRIGGER IF NOT EXISTS trg_edges_endpoint_guard_v1 BEFORE INSERT ON edges WHEN NOT EXISTS (SELECT 1 FROM entries WHERE id = NEW.source_id) OR NOT EXISTS (SELECT 1 FROM entries WHERE id = NEW.target_id) BEGIN SELECT RAISE(ABORT, 'missing-edge-endpoint'); END`,
  trg_entries_write_fence_insert_v5: `CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_insert_v5 BEFORE INSERT ON entries WHEN NOT (${restoreInsert("NEW.restore_lease_owner")}) AND (${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")})) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  // Every source-memory column is fenced. UPDATE OF intentionally names runtime-added
  // columns too: SQLite accepts names not present yet, and the trigger is installed only
  // after those ALTERs by applySchema. The one excluded derived field is vector_ids.
  trg_entries_write_fence_source_update_v9: `CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_source_update_v9 BEFORE UPDATE OF id, content, tags, source, created_at, recall_count, importance_score, contradiction_wins, contradiction_losses, updated_at, staleness_checked_at, when_at, when_kind, when_source, when_label, memory_tier, pinned, last_recalled_at, restore_lease_owner, write_marker, workspace_id, actor_id, valid_from, valid_until ON entries WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")}) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  // The final delta is the sole write admitted under a migration lock. A fresh nonce
  // transition is required because vector IDs are intentionally stable across model/index
  // changes; requiring their value to differ would reject the normal migration. Restore
  // never permits UPDATEs, and every source field is fenced by the trigger above.
  trg_entries_write_fence_vector_update_v7: `CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_vector_update_v7 BEFORE UPDATE OF vector_ids, migration_lease_owner, pending_append_passages ON entries WHEN NOT (${finalDeltaUpdate}) AND (${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")}) OR NEW.write_marker IS OLD.write_marker) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_entries_write_fence_delete_v5: `CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_delete_v5 BEFORE DELETE ON entries WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeDeleteAdmission("OLD.write_marker")}) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_edges_write_fence_insert_v5: `CREATE TRIGGER IF NOT EXISTS trg_edges_write_fence_insert_v5 BEFORE INSERT ON edges WHEN NOT (${restoreInsert("NEW.restore_lease_owner")}) AND (${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")})) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_edges_write_fence_update_v5: `CREATE TRIGGER IF NOT EXISTS trg_edges_write_fence_update_v5 BEFORE UPDATE ON edges WHEN NOT (${restoreInsert("NEW.restore_lease_owner")}) AND (${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")}) OR NEW.write_marker IS OLD.write_marker) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_edges_write_fence_delete_v5: `CREATE TRIGGER IF NOT EXISTS trg_edges_write_fence_delete_v5 BEFORE DELETE ON edges WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeDeleteAdmission("OLD.write_marker")}) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_insight_candidates_write_fence_insert_v5: `CREATE TRIGGER IF NOT EXISTS trg_insight_candidates_write_fence_insert_v5 BEFORE INSERT ON insight_candidates WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")}) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_insight_candidates_write_fence_update_v5: `CREATE TRIGGER IF NOT EXISTS trg_insight_candidates_write_fence_update_v5 BEFORE UPDATE ON insight_candidates WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeAdmission("NEW.write_marker")}) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_insight_candidates_write_fence_delete_v5: `CREATE TRIGGER IF NOT EXISTS trg_insight_candidates_write_fence_delete_v5 BEFORE DELETE ON insight_candidates WHEN ${migrationBarrier} OR ${restoreBarrier} OR NOT (${activeDeleteAdmission("OLD.write_marker")}) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  // A remote Vectorize mutation may happen only after this durable journal accepted the
  // same current admission (or the one active final-delta lease). Fencing the source row
  // alone is too late: a stale invocation can already have leaked a remote vector.
  trg_vector_cleanup_write_fence_insert_v1: `CREATE TRIGGER IF NOT EXISTS trg_vector_cleanup_write_fence_insert_v1 BEFORE INSERT ON vector_cleanup_ops WHEN NOT (${activeAdmission("NEW.write_marker")}) AND NOT (${activeFinalDeltaMarker("NEW.write_marker")}) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_vector_cleanup_write_fence_update_v1: `CREATE TRIGGER IF NOT EXISTS trg_vector_cleanup_write_fence_update_v1 BEFORE UPDATE ON vector_cleanup_ops WHEN NOT (${activeAdmission("NEW.write_marker")}) AND NOT (${activeFinalDeltaMarker("NEW.write_marker")}) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
  trg_vector_cleanup_write_fence_delete_v1: `CREATE TRIGGER IF NOT EXISTS trg_vector_cleanup_write_fence_delete_v1 BEFORE DELETE ON vector_cleanup_ops WHEN NOT (${activeDeleteAdmission("OLD.write_marker")}) AND NOT (${activeFinalDeltaMarker("OLD.write_marker")}) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END`,
};
