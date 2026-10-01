-- Fork-owned control tables and write protection triggers for empty local SQLite DBs.
-- Apply only after db/schema.sql; runtime upgrades use src/db/init.ts instead.

-- Strongly consistent, short-lived gate used only for the final embedding
-- cutover delta pass. KV is intentionally not used for a lock because its
-- cross-colo propagation is eventually consistent.
CREATE TABLE IF NOT EXISTS migration_control (
  id        TEXT PRIMARY KEY,
  locked_at INTEGER NOT NULL,
  reason    TEXT NOT NULL,
  owner_id  TEXT,
  final_delta_completed_at INTEGER,
  active_delta_token TEXT,
  active_delta_expires_at INTEGER
);

-- Short-lived claims held by ordinary mutations, including their waitUntil work.
-- Restore and migration-lock acquisition refuse to start until all live claims finish.
CREATE TABLE IF NOT EXISTS memory_write_admissions (
  token      TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  generation TEXT NOT NULL
);

-- Strong generation for ordinary write capabilities. Barrier claims rotate this
-- in the same D1 transaction, permanently invalidating every older invocation.
CREATE TABLE IF NOT EXISTS memory_write_epoch (
  id         TEXT PRIMARY KEY,
  generation TEXT NOT NULL
);
INSERT INTO memory_write_epoch (id, generation)
VALUES ('current', lower(hex(randomblob(16))))
ON CONFLICT(id) DO NOTHING;

-- Strong reset generation for the KV-backed migration progress display. A stale KV
-- cursor from another colo is ignored unless it matches this D1 generation.
CREATE TABLE IF NOT EXISTS embedding_migration_generation (
  id         TEXT PRIMARY KEY,
  generation TEXT NOT NULL
);

-- Strong generation paired with eventually-consistent integration KV records.
-- A restored or stale PoP value is rejected unless it names this D1 generation.
CREATE TABLE IF NOT EXISTS integration_state_generation (
  id            TEXT PRIMARY KEY,
  generation    TEXT NOT NULL,
  restore_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO integration_state_generation (id, generation, restore_count)
VALUES ('current', lower(hex(randomblob(16))), 0)
ON CONFLICT(id) DO NOTHING;

-- Provider-local disconnect fence. Rotating one row makes every in-flight sync
-- for that provider stale without disconnecting unrelated integrations.
CREATE TABLE IF NOT EXISTS integration_provider_generation (
  provider         TEXT PRIMARY KEY,
  generation       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 0,
  draining         INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT,
  lease_expires_at INTEGER
);

-- Durable outbox for Vectorize deletions. A vector write is recorded before the
-- remote upsert and cleared only after D1 either references it or cleanup succeeds.
CREATE TABLE IF NOT EXISTS vector_cleanup_ops (
  op_id      TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL,
  vector_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ready      INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  write_marker TEXT
);

-- Bounded idempotency receipt: only the latest append operation per entry is retained.
CREATE TABLE IF NOT EXISTS append_receipts (
  entry_id     TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  indexed      INTEGER NOT NULL,
  completed_at INTEGER NOT NULL
);

-- Resumable R2 restore ledger. D1 owns this state so a temporary restore drill
-- cannot poison a later production restore merely by sharing the OAuth KV.
CREATE TABLE IF NOT EXISTS restore_state (
  id               TEXT PRIMARY KEY,
  backup_id        TEXT NOT NULL,
  backup_sha256    TEXT,
  run_id           TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  next_offset      INTEGER NOT NULL DEFAULT 0,
  next_edge_offset INTEGER NOT NULL DEFAULT 0,
  next_project_offset INTEGER NOT NULL DEFAULT 0,
  next_history_offset INTEGER NOT NULL DEFAULT 0,
  completed_at     INTEGER,
  lease_owner      TEXT,
  lease_expires_at INTEGER
);

-- Database-level restore fence. Application-level checks produce friendly 423
-- responses, while these triggers close the check-then-write race. Restore
-- INSERTs carry the current, unexpired lease owner; ordinary INSERTs do not.
-- UPDATE/DELETE are never part of restore import and are always blocked while
-- a restore is active.
CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_insert_v3
BEFORE INSERT ON entries
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock') OR EXISTS (
  SELECT 1 FROM restore_state
   WHERE id = 'r2-v1'
     AND (completed_at IS NULL OR
          (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
     AND NOT (
       NEW.restore_lease_owner IS NOT NULL
       AND NEW.restore_lease_owner = lease_owner
       AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
     )
)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

-- Source fields remain completely immutable during the final embedding cutover.
-- SQLite deliberately tolerates unknown names in UPDATE OF, so this reference schema
-- can list runtime-added columns even though older snapshots add them via init.ts.
CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_source_update_v3
BEFORE UPDATE OF id, content, tags, source, created_at, recall_count,
  importance_score, contradiction_wins, contradiction_losses, updated_at,
  staleness_checked_at, when_at, when_kind, when_source, when_label, memory_tier, pinned, last_recalled_at,
  restore_lease_owner ON entries
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock') OR EXISTS (
  SELECT 1 FROM restore_state
   WHERE id = 'r2-v1'
     AND (completed_at IS NULL OR
          (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

-- Only the lock owner may update derived vectors. Vector IDs are stable across profiles,
-- so freshness is proved by the nonce-bearing marker transition rather than value change.
CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_vector_update_v4
BEFORE UPDATE OF vector_ids, migration_lease_owner ON entries
WHEN (
  NEW.migration_lease_owner IS NOT OLD.migration_lease_owner
  AND NOT EXISTS (
    SELECT 1 FROM migration_control
     WHERE id = 'memory-write-lock'
       AND owner_id IS NOT NULL
       AND active_delta_token IS NOT NULL
       AND active_delta_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
       AND substr(NEW.migration_lease_owner, 1, length(owner_id) + length(active_delta_token) + 2) = owner_id || ':' || active_delta_token || ':'
  )
) OR (
  EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock')
  AND NOT (
    NEW.migration_lease_owner IS NOT OLD.migration_lease_owner
    AND EXISTS (
      SELECT 1 FROM migration_control
       WHERE id = 'memory-write-lock'
         AND owner_id IS NOT NULL
         AND active_delta_token IS NOT NULL
         AND active_delta_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
         AND substr(NEW.migration_lease_owner, 1, length(owner_id) + length(active_delta_token) + 2) = owner_id || ':' || active_delta_token || ':'
    )
  )
) OR EXISTS (
  SELECT 1 FROM restore_state
   WHERE id = 'r2-v1'
     AND (completed_at IS NULL OR
          (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_delete_v3
BEFORE DELETE ON entries
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock') OR EXISTS (
  SELECT 1 FROM restore_state
   WHERE id = 'r2-v1'
     AND (completed_at IS NULL OR
          (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

CREATE TRIGGER IF NOT EXISTS trg_edges_write_fence_insert_v3
BEFORE INSERT ON edges
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock') OR EXISTS (
  SELECT 1 FROM restore_state
   WHERE id = 'r2-v1'
     AND (completed_at IS NULL OR
          (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
     AND NOT (
       NEW.restore_lease_owner IS NOT NULL
       AND NEW.restore_lease_owner = lease_owner
       AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
     )
)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

CREATE TRIGGER IF NOT EXISTS trg_edges_write_fence_update_v3
BEFORE UPDATE ON edges
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock') OR EXISTS (
  SELECT 1 FROM restore_state
   WHERE id = 'r2-v1'
     AND (completed_at IS NULL OR
          (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

CREATE TRIGGER IF NOT EXISTS trg_edges_write_fence_delete_v3
BEFORE DELETE ON edges
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock') OR EXISTS (
  SELECT 1 FROM restore_state
   WHERE id = 'r2-v1'
     AND (completed_at IS NULL OR
          (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

CREATE TRIGGER IF NOT EXISTS trg_insight_candidates_write_fence_insert_v3
BEFORE INSERT ON insight_candidates
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock')
  OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND completed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

CREATE TRIGGER IF NOT EXISTS trg_insight_candidates_write_fence_update_v3
BEFORE UPDATE ON insight_candidates
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock')
  OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND completed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

CREATE TRIGGER IF NOT EXISTS trg_insight_candidates_write_fence_delete_v3
BEFORE DELETE ON insight_candidates
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock')
  OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND completed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'memory-write-locked');
END;

-- Retire the intermediate fence generation above. It remains in this reference script
-- only to exercise the same additive upgrade path as an older installation; a freshly
-- applied schema ends with exactly the current fail-closed capability generation below.
DROP TRIGGER IF EXISTS trg_entries_write_fence_insert_v3;
DROP TRIGGER IF EXISTS trg_entries_write_fence_source_update_v3;
DROP TRIGGER IF EXISTS trg_entries_write_fence_vector_update_v4;
DROP TRIGGER IF EXISTS trg_entries_write_fence_delete_v3;
DROP TRIGGER IF EXISTS trg_edges_write_fence_insert_v3;
DROP TRIGGER IF EXISTS trg_edges_write_fence_update_v3;
DROP TRIGGER IF EXISTS trg_edges_write_fence_delete_v3;
DROP TRIGGER IF EXISTS trg_insight_candidates_write_fence_insert_v3;
DROP TRIGGER IF EXISTS trg_insight_candidates_write_fence_update_v3;
DROP TRIGGER IF EXISTS trg_insight_candidates_write_fence_delete_v3;
DROP TRIGGER IF EXISTS trg_entries_write_fence_source_update_v5;
DROP TRIGGER IF EXISTS trg_entries_write_fence_vector_update_v6;

CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_insert_v5 BEFORE INSERT ON entries
WHEN NOT (EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND lease_owner IS NOT NULL AND lease_owner = NEW.restore_lease_owner AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
AND (EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':')))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_source_update_v8 BEFORE UPDATE OF id, content, tags, source, created_at, recall_count, importance_score, contradiction_wins, contradiction_losses, updated_at, staleness_checked_at, when_at, when_kind, when_source, when_label, memory_tier, pinned, last_recalled_at, restore_lease_owner, write_marker, workspace_id, actor_id ON entries
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':')) OR NEW.write_marker IS OLD.write_marker
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_vector_update_v7 BEFORE UPDATE OF vector_ids, migration_lease_owner, pending_append_passages ON entries
WHEN NOT (NEW.migration_lease_owner IS NOT OLD.migration_lease_owner AND EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND owner_id IS NOT NULL AND active_delta_token IS NOT NULL AND active_delta_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.migration_lease_owner, 1, length(owner_id) + length(active_delta_token) + 2) = owner_id || ':' || active_delta_token || ':'))
AND (EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':')) OR NEW.write_marker IS OLD.write_marker)
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_delete_v5 BEFORE DELETE ON entries
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(OLD.write_marker, 1, length(a.token) + 8) = a.token || ':delete:'))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_edges_write_fence_insert_v5 BEFORE INSERT ON edges
WHEN NOT (EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND lease_owner IS NOT NULL AND lease_owner = NEW.restore_lease_owner AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
AND (EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':')))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_edges_write_fence_update_v5 BEFORE UPDATE ON edges
WHEN NOT (EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND lease_owner IS NOT NULL AND lease_owner = NEW.restore_lease_owner AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
AND (EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':')) OR NEW.write_marker IS OLD.write_marker)
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_edges_write_fence_delete_v5 BEFORE DELETE ON edges
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(OLD.write_marker, 1, length(a.token) + 8) = a.token || ':delete:'))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_insight_candidates_write_fence_insert_v5 BEFORE INSERT ON insight_candidates
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_insight_candidates_write_fence_update_v5 BEFORE UPDATE ON insight_candidates
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':')) OR NEW.write_marker IS OLD.write_marker
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_insight_candidates_write_fence_delete_v5 BEFORE DELETE ON insight_candidates
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(OLD.write_marker, 1, length(a.token) + 8) = a.token || ':delete:'))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_vector_cleanup_write_fence_insert_v1 BEFORE INSERT ON vector_cleanup_ops
WHEN NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'))
AND NOT (EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND owner_id IS NOT NULL AND active_delta_token IS NOT NULL AND active_delta_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(owner_id) + length(active_delta_token) + 2) = owner_id || ':' || active_delta_token || ':'))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_vector_cleanup_write_fence_update_v1 BEFORE UPDATE ON vector_cleanup_ops
WHEN NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'))
AND NOT (EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND owner_id IS NOT NULL AND active_delta_token IS NOT NULL AND active_delta_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(owner_id) + length(active_delta_token) + 2) = owner_id || ':' || active_delta_token || ':'))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_vector_cleanup_write_fence_delete_v1 BEFORE DELETE ON vector_cleanup_ops
WHEN NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(OLD.write_marker, 1, length(a.token) + 8) = a.token || ':delete:'))
AND NOT (EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND owner_id IS NOT NULL AND active_delta_token IS NOT NULL AND active_delta_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(OLD.write_marker, 1, length(owner_id) + length(active_delta_token) + 2) = owner_id || ':' || active_delta_token || ':'))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_projects_write_fence_insert_v1 BEFORE INSERT ON projects
WHEN NOT (EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND lease_owner IS NOT NULL AND lease_owner = NEW.restore_lease_owner AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))
AND (EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':')))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_projects_write_fence_update_v1 BEFORE UPDATE ON projects
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':')) OR NEW.write_marker IS OLD.write_marker
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

CREATE TRIGGER IF NOT EXISTS trg_projects_write_fence_delete_v1 BEFORE DELETE ON projects
WHEN EXISTS (SELECT 1 FROM migration_control WHERE id = 'memory-write-lock' AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000))
OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)))
OR NOT (EXISTS (SELECT 1 FROM memory_write_admissions a JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 AND substr(OLD.write_marker, 1, length(a.token) + 8) = a.token || ':delete:'))
BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;

-- 4.0 の履歴・ゴミ箱・検索ログと有効期間も既存の書込み境界へ含める。
CREATE TRIGGER IF NOT EXISTS trg_entry_versions_write_fence_insert_v1 BEFORE INSERT ON entry_versions WHEN NOT (EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND lease_owner IS NOT NULL AND lease_owner = NEW.restore_lease_owner AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)) AND (EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'
))) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
CREATE TRIGGER IF NOT EXISTS trg_entry_versions_write_fence_update_v1 BEFORE UPDATE ON entry_versions WHEN EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'
)) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
CREATE TRIGGER IF NOT EXISTS trg_entries_trash_write_fence_insert_v1 BEFORE INSERT ON entries_trash WHEN NOT (EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND lease_owner IS NOT NULL AND lease_owner = NEW.restore_lease_owner AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)) AND (EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'
))) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
CREATE TRIGGER IF NOT EXISTS trg_entries_trash_write_fence_update_v1 BEFORE UPDATE ON entries_trash WHEN EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'
)) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
CREATE TRIGGER IF NOT EXISTS trg_recall_log_write_fence_insert_v1 BEFORE INSERT ON recall_log WHEN NOT (EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND lease_owner IS NOT NULL AND lease_owner = NEW.restore_lease_owner AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)) AND (EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'
))) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
CREATE TRIGGER IF NOT EXISTS trg_recall_log_write_fence_update_v1 BEFORE UPDATE ON recall_log WHEN EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'
)) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
CREATE TRIGGER IF NOT EXISTS trg_entry_versions_write_fence_delete_v1 BEFORE DELETE ON entry_versions WHEN EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (
    EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(OLD.write_marker, 1, length(a.token) + 1) = a.token || ':'
) OR EXISTS (SELECT 1 FROM entries p WHERE p.id = OLD.entry_id AND EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(p.write_marker, 1, length(a.token) + 1) = a.token || ':'
)) OR EXISTS (SELECT 1 FROM entries_trash p WHERE p.id = OLD.entry_id AND EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(p.write_marker, 1, length(a.token) + 1) = a.token || ':'
)) OR EXISTS (SELECT 1 FROM entry_versions p WHERE p.entry_id = OLD.entry_id AND EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(p.write_marker, 1, length(a.token) + 1) = a.token || ':'
))
  ) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
CREATE TRIGGER IF NOT EXISTS trg_entries_trash_write_fence_delete_v1 BEFORE DELETE ON entries_trash WHEN EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (
    EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(OLD.write_marker, 1, length(a.token) + 8) = a.token || ':delete:'
) OR EXISTS (SELECT 1 FROM entries p WHERE p.id = OLD.id AND EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(p.write_marker, 1, length(a.token) + 1) = a.token || ':'
))
  ) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
CREATE TRIGGER IF NOT EXISTS trg_recall_log_write_fence_delete_v1 BEFORE DELETE ON recall_log WHEN EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(OLD.write_marker, 1, length(a.token) + 8) = a.token || ':delete:'
)) BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_source_update_v9 BEFORE UPDATE OF id, content, tags, source, created_at, recall_count, importance_score, contradiction_wins, contradiction_losses, updated_at, staleness_checked_at, when_at, when_kind, when_source, when_label, memory_tier, pinned, last_recalled_at, restore_lease_owner, write_marker, workspace_id, actor_id, valid_from, valid_until ON entries WHEN EXISTS (
  SELECT 1 FROM migration_control
  WHERE id = 'memory-write-lock'
    AND NOT (reason = 'r2-backup-snapshot' AND active_delta_expires_at IS NOT NULL
      AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
) OR EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND (completed_at IS NULL OR (lease_owner IS NOT NULL AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000))) OR NOT (EXISTS (
  SELECT 1 FROM memory_write_admissions a
  JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
  WHERE a.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND substr(NEW.write_marker, 1, length(a.token) + 1) = a.token || ':'
)) OR NEW.write_marker IS OLD.write_marker BEGIN SELECT RAISE(ABORT, 'memory-write-locked'); END;
DROP TRIGGER IF EXISTS trg_entries_write_fence_source_update_v8;
