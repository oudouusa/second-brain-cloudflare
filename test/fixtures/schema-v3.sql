-- Frozen fork v3 reference schema from b3ca1ff:db/schema.sql.
-- Reference schema for local SQLite tests and inspection of a completely empty DB only.
-- Never execute this file directly against an existing or production D1: CREATE TABLE
-- does not add missing columns before later triggers. Deploy the Worker, then call the
-- authenticated /health endpoint so src/db/init.ts applies ordered runtime upgrades.

-- Single-row cold-start schema check. Bump alongside DATABASE_SCHEMA_VERSION in
-- src/db/init.ts whenever the runtime schema changes.
CREATE TABLE IF NOT EXISTS schema_meta (
  id         TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);
INSERT INTO schema_meta (id, version, applied_at)
VALUES ('current', 3, 0)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS entries (
  id               TEXT PRIMARY KEY,
  content          TEXT NOT NULL,
  tags             TEXT NOT NULL DEFAULT '[]',   -- JSON array
  source           TEXT NOT NULL DEFAULT 'api',  -- 'phone', 'browser', 'voice', 'claude', 'api'
  created_at       INTEGER NOT NULL,             -- Unix ms timestamp
  vector_ids       TEXT NOT NULL DEFAULT '[]',   -- JSON array of Vectorize vector IDs
  recall_count         INTEGER DEFAULT 0,
  importance_score     INTEGER DEFAULT 0,
  contradiction_wins   INTEGER DEFAULT 0,
  contradiction_losses INTEGER DEFAULT 0,
  updated_at INTEGER,
  staleness_checked_at INTEGER,
  memory_tier TEXT DEFAULT 'warm',
  pinned INTEGER DEFAULT 0,
  last_recalled_at INTEGER,
  restore_lease_owner  TEXT,
  migration_lease_owner TEXT,
  write_marker TEXT,
  workspace_id TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL DEFAULT '',
  pending_append_passages TEXT NOT NULL DEFAULT '[]' -- bounded derived indexing queue
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
-- Every scoped read filters on the workspace first, then orders by recency. This
-- index is what keeps that shape a range search rather than a sort.
CREATE INDEX IF NOT EXISTS idx_entries_workspace_created
  ON entries(workspace_id, created_at DESC);

-- Relationship graph (issue #16). One additive table — old code ignores it and
-- rollback is a no-op. Designed to never need an ALTER: type/provenance are free
-- TEXT validated in app code (not SQL CHECK), and metadata is a JSON escape-hatch
-- for any future per-edge attribute (the edges analogue of entries.tags).
CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'relates_to',  -- relates_to | supersedes | caused_by | decided | about_person | part_of_project | follows
  weight      REAL NOT NULL DEFAULT 0.5,           -- 0..1 strength/confidence
  provenance  TEXT NOT NULL DEFAULT 'inferred',    -- explicit | inferred | system
  metadata    TEXT NOT NULL DEFAULT '{}',          -- JSON escape-hatch for future per-edge fields
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  restore_lease_owner TEXT,
  write_marker TEXT,
  workspace_id TEXT NOT NULL DEFAULT '',
  UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
-- The graph view reads the strongest edges (ORDER BY weight DESC LIMIT n). Without an
-- ordered path to weight, SQLite scans every edge into a temp b-tree before the LIMIT
-- applies — measured rows_read is 2 x the edge count whether or not a LIMIT is present,
-- which at 500k edges is 1M rows read per request against D1's 5M/day free cap. Costs one
-- extra index write per edge (5 -> 6 rows written per insert), which the far larger read
-- saving pays for many times over. Must stay in step with src/db/init.ts, which creates
-- the same index at runtime for brains that were migrated before it existed.
CREATE INDEX IF NOT EXISTS idx_edges_weight ON edges(weight DESC);

-- A backup containing a dangling edge cannot be restored because import validates
-- both endpoints. Keep the invariant at the database boundary for every writer.
CREATE TRIGGER IF NOT EXISTS trg_edges_endpoint_guard_v1
BEFORE INSERT ON edges
WHEN NOT EXISTS (SELECT 1 FROM entries WHERE id = NEW.source_id)
  OR NOT EXISTS (SELECT 1 FROM entries WHERE id = NEW.target_id)
BEGIN
  SELECT RAISE(ABORT, 'missing-edge-endpoint');
END;

-- Candidate pairs for the weekly insight pass. Must stay in step with
-- src/db/init.ts, which creates the same objects at runtime for brains that
-- were migrated before this existed.
CREATE TABLE IF NOT EXISTS insight_candidates (
  id          TEXT PRIMARY KEY,
  a_id        TEXT NOT NULL,
  b_id        TEXT NOT NULL,                       -- normalised so a_id < b_id
  similarity  REAL NOT NULL,                       -- cosine at accrual time
  gap_ms      INTEGER NOT NULL,                    -- |created_at difference|
  score       REAL NOT NULL,                       -- see src/insight/score.ts
  signal      TEXT NOT NULL DEFAULT 'vector',      -- vector | supersedes
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending | used | rejected
  created_at  INTEGER NOT NULL,
  write_marker TEXT,
  UNIQUE(a_id, b_id)
);

CREATE INDEX IF NOT EXISTS idx_insight_candidates_queue
  ON insight_candidates(status, score DESC);

-- Team Edition tenancy. Legacy rows use workspace_id/actor_id '' until the
-- owner bootstrap assigns them to the owner's personal workspace.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'personal',
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  default_share TEXT NOT NULL DEFAULT '',
  removed_at INTEGER,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_token_hash ON users(token_hash);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS entry_events (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entry_events_entry ON entry_events(entry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entry_events_created ON entry_events(created_at DESC);

CREATE TABLE IF NOT EXISTS admin_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL DEFAULT '',
  target_user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_events_created ON admin_events(created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id TEXT NOT NULL DEFAULT '',
  advanced_at INTEGER NOT NULL DEFAULT 0
);

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

-- Strong daily guard in front of anonymous OAuth dynamic client registration.
-- DCR itself writes to the shared OAuth KV namespace; bounding accepted requests
-- here prevents one caller from consuming the namespace's Free daily write quota.
CREATE TABLE IF NOT EXISTS oauth_registration_quota (
  id                 TEXT PRIMARY KEY,
  window_start       INTEGER NOT NULL,
  registration_count INTEGER NOT NULL
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
  staleness_checked_at, memory_tier, pinned, last_recalled_at,
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

CREATE TRIGGER IF NOT EXISTS trg_entries_write_fence_source_update_v6 BEFORE UPDATE OF id, content, tags, source, created_at, recall_count, importance_score, contradiction_wins, contradiction_losses, updated_at, staleness_checked_at, memory_tier, pinned, last_recalled_at, restore_lease_owner, write_marker, workspace_id, actor_id ON entries
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
