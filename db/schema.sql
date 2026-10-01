-- Base reference schema for local SQLite tests and inspection of a completely empty DB.
-- Apply db/fork-write-protection.sql after this file to complete the fork schema.
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
VALUES ('current', 9, 0)
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
  pending_append_passages TEXT NOT NULL DEFAULT '[]',
  when_at INTEGER,
  when_kind TEXT,
  when_source TEXT,
  when_label TEXT,
  valid_from INTEGER,
  valid_until INTEGER
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

-- UNIQUE(source_id, target_id, type) already covers source_id-first lookups.
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

-- Authoritative version for each workspace's Prompt Capsule. The full Capsule
-- body is cached in eventually-consistent KV, but this revision is read from D1
-- before every lookup so an old KV payload can never cross an edit, delete,
-- workspace move, or id change. Rows are created lazily by the entry triggers
-- below or by the first Capsule read of an otherwise untouched workspace.
CREATE TABLE IF NOT EXISTS prompt_capsule_revisions (
  workspace_id TEXT PRIMARY KEY,
  revision     TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS prompt_capsule_entry_insert
AFTER INSERT ON entries
WHEN instr(lower(NEW.tags), '"capsule:') > 0
  OR instr(lower(NEW.tags), '"capsule-slot:') > 0
BEGIN
  INSERT INTO prompt_capsule_revisions (workspace_id, revision)
  VALUES (NEW.workspace_id, lower(hex(randomblob(16))))
  ON CONFLICT(workspace_id) DO UPDATE SET revision = lower(hex(randomblob(16)));
END;

CREATE TRIGGER IF NOT EXISTS prompt_capsule_entry_update
AFTER UPDATE OF id, content, tags, workspace_id ON entries
WHEN instr(lower(OLD.tags), '"capsule:') > 0
  OR instr(lower(OLD.tags), '"capsule-slot:') > 0
  OR instr(lower(NEW.tags), '"capsule:') > 0
  OR instr(lower(NEW.tags), '"capsule-slot:') > 0
BEGIN
  INSERT INTO prompt_capsule_revisions (workspace_id, revision)
  VALUES (OLD.workspace_id, lower(hex(randomblob(16))))
  ON CONFLICT(workspace_id) DO UPDATE SET revision = lower(hex(randomblob(16)));

  INSERT INTO prompt_capsule_revisions (workspace_id, revision)
  SELECT NEW.workspace_id, lower(hex(randomblob(16))) WHERE NEW.workspace_id <> OLD.workspace_id
  ON CONFLICT(workspace_id) DO UPDATE SET revision = lower(hex(randomblob(16)));
END;

CREATE TRIGGER IF NOT EXISTS prompt_capsule_entry_delete
AFTER DELETE ON entries
WHEN instr(lower(OLD.tags), '"capsule:') > 0
  OR instr(lower(OLD.tags), '"capsule-slot:') > 0
BEGIN
  INSERT INTO prompt_capsule_revisions (workspace_id, revision)
  VALUES (OLD.workspace_id, lower(hex(randomblob(16))))
  ON CONFLICT(workspace_id) DO UPDATE SET revision = lower(hex(randomblob(16)));
END;

CREATE TRIGGER IF NOT EXISTS prompt_capsule_workspace_delete
AFTER DELETE ON workspaces
BEGIN
  DELETE FROM prompt_capsule_revisions WHERE workspace_id = OLD.id;
END;

-- The bootstrap looks up the company workspace by kind on every identity path.
CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(kind);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  default_share TEXT NOT NULL DEFAULT '',
  removed_at INTEGER,
  last_used_at INTEGER
);
-- Email uniqueness among members. createMember's check-then-INSERT guard left a
-- two-writer race (both SELECTs miss, both INSERTs land); this index is the real
-- constraint and the app code maps the loser to the same 409 the winner's guard
-- produced. SQLite counts NULLs as distinct, so members without an email are
-- unaffected. Fresh installs only: an EXISTING brain gets the same index from
-- src/db/init.ts, which resolves any duplicates it finds before building.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

-- listTeamWorkspaces (GET /team/roster) joins memberships on workspace_id; the
-- composite PK above only serves user_id-first lookups. Same trade as
-- the other bounded Team indexes: a tiny table, a cheap index, and the join stays a seek.
CREATE INDEX IF NOT EXISTS idx_memberships_workspace ON memberships(workspace_id);

-- Immutable audit trail. Application code only ever INSERTs here — no UPDATE or
-- DELETE exists anywhere in src/, by design. Tamper evidence is absence of a way
-- to rewrite it, not cryptography.
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
-- brief/changes.ts's raw event scan reserves index-backed branches for actor_id = reader and
-- event = 'held' so a teammate's own burst cannot crowd either out of the raw scan's cap.
CREATE INDEX IF NOT EXISTS idx_entry_events_actor ON entry_events(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entry_events_held ON entry_events(created_at DESC) WHERE event = 'held';
-- The event readers' life-end subquery (quadratic in edits per memory without this index). No
-- json_extract in the WHERE -- must never throw on a non-JSON payload; readers check trash=0 on top.
CREATE INDEX IF NOT EXISTS idx_entry_events_life_end ON entry_events(entry_id) WHERE event IN ('purged', 'deleted');

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

-- Strong daily guard in front of anonymous OAuth dynamic client registration.
-- DCR itself writes to the shared OAuth KV namespace; bounding accepted requests
-- here prevents one caller from consuming the namespace's Free daily write quota.
CREATE TABLE IF NOT EXISTS oauth_registration_quota (
  id                 TEXT PRIMARY KEY,
  window_start       INTEGER NOT NULL,
  registration_count INTEGER NOT NULL
);

-- Capsule-only index: missing project ids never scan ordinary memories.
CREATE INDEX IF NOT EXISTS idx_entries_capsule ON entries(workspace_id, id)
WHERE instr(lower(tags), '"capsule:') > 0;

-- Projects: a thin registry over the reserved project:<slug> tag. Membership stays
-- tag-shaped on entries; aliases claim existing plain tags, so nothing is backfilled.
-- Must stay in step with src/db/init.ts.
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT NOT NULL,                    -- slug, ^[a-z0-9][a-z0-9_-]{0,63}$
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,                    -- display name, <= 120 chars
  description  TEXT NOT NULL DEFAULT '',         -- <= 1000 chars
  aliases      TEXT NOT NULL DEFAULT '[]',       -- JSON array of plain tags, max 16
  status       TEXT NOT NULL DEFAULT 'active',   -- active | archived (validated in app code)
  created_at   INTEGER NOT NULL,                 -- Unix ms timestamp
  updated_at   INTEGER,                          -- Unix ms, NULL until first edit
  restore_lease_owner TEXT,
  write_marker TEXT,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id, status);

-- Project-only index: membership scans never walk ordinary memories.
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(workspace_id, id)
WHERE instr(lower(tags), '"project:') > 0;

-- Held-draft index: the nightly digest's "is one still waiting on the person?" check reads only these
-- rows. Must stay in step with src/db/init.ts.
CREATE INDEX IF NOT EXISTS idx_entries_conflict_held ON entries(workspace_id, id)
WHERE instr(lower(tags), '"conflict-held"') > 0;
-- Agent brief queues: each scans only its own rows, not every memory. The WHERE clauses are the
-- instr(...) forms src/brief/compute.ts repeats. Must stay in step with src/db/init.ts.
-- schema 9の参照DDLにも、runtimeと同じ日付queue用indexを含める。
CREATE INDEX IF NOT EXISTS idx_entries_when ON entries(workspace_id, when_at) WHERE when_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entries_task ON entries(workspace_id, created_at)
WHERE instr(lower(tags), '"task"') > 0;
CREATE INDEX IF NOT EXISTS idx_entries_insight ON entries(workspace_id, created_at)
WHERE instr(lower(tags), '"auto-insight"') > 0;
CREATE INDEX IF NOT EXISTS idx_entries_stale ON entries(workspace_id, id)
WHERE instr(lower(tags), '"stale:as-of"') > 0;

-- Track 7 (T-0089.7.1, T-0089.7.2): the decision log and standing-memory cache build each
-- scan only their own marker, not every memory. Neither writes a row on upgrade — the two
-- tags are new, so both indexes start empty. Must stay in step with src/db/init.ts.
CREATE INDEX IF NOT EXISTS idx_entries_ledger ON entries(workspace_id, created_at)
WHERE instr(lower(tags), '"ledger:decision"') > 0;
CREATE INDEX IF NOT EXISTS idx_entries_standing ON entries(workspace_id, created_at)
WHERE instr(lower(tags), '"standing:active"') > 0;

-- Web Push subscriptions. One row per subscribed browser/device, scoped to
-- the workspace it was created against. Must stay in step with src/db/init.ts.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL DEFAULT '',
  endpoint_hash     TEXT NOT NULL,               -- SHA-256 hex of the subscription endpoint URL
  subscription_json TEXT NOT NULL,               -- {endpoint, keys:{p256dh, auth}}
  content_free      INTEGER NOT NULL DEFAULT 0,  -- 1: notify with a fixed title, no entry content
  created_at        INTEGER NOT NULL,
  last_ok_at        INTEGER,                     -- Unix ms of the last successful push, NULL until one lands
  fail_count        INTEGER NOT NULL DEFAULT 0,  -- consecutive send failures; deleted at 5
  UNIQUE(endpoint_hash)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_workspace ON push_subscriptions(workspace_id);

-- Sampled recall log (T-0089.5.2 Part A), feeding the golden eval set T-0043. Additive:
-- old code never reads this table and rollback is a no-op. Opt-in (config RECALL_LOG,
-- off by default everywhere, D5.2) and sampled by src/recall/log.ts's KV day counter, not
-- written on every recall. followed_ids starts empty and is filled by Part B (get, append,
-- update or link on a returned id within 30 minutes) within the same row, never a new one.
-- Must stay in step with src/db/init.ts.
CREATE TABLE IF NOT EXISTS recall_log (
  write_marker TEXT,
  restore_lease_owner TEXT,
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  channel      TEXT NOT NULL,             -- mcp | rest
  query        TEXT NOT NULL,
  params       TEXT NOT NULL,             -- JSON: topK, filters, hops
  returned_ids TEXT NOT NULL,             -- JSON array, in order
  followed_ids TEXT NOT NULL DEFAULT '[]' -- JSON array, filled by Part B within 30 minutes
);

-- The only read path: the latest row for a workspace within the follow window
-- (Part B) and the retention purge (oldest-first). One index serves both.
CREATE INDEX IF NOT EXISTS idx_recall_log_ws ON recall_log(workspace_id, created_at DESC);

-- Content history (4.0, T-0089.1.1). One row per retired state of an entry,
-- written in the same batch as the change. Must stay in step with src/db/init.ts.
CREATE TABLE IF NOT EXISTS entry_versions (
  write_marker TEXT,
  restore_lease_owner TEXT,
  id           INTEGER PRIMARY KEY,           -- rowid alias: no extra index row per insert
  entry_id     TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',      -- the entry's workspace at change time; decides who may read it
  seq          INTEGER NOT NULL,              -- 1, 2, 3 per entry, newest highest, no gaps above the oldest kept
  content      TEXT,                          -- full prior text, or NULL when prior_length is set
  prior_length INTEGER,                       -- prior text = first N (Unicode) characters of the next newer state
  prior_length_utf16 INTEGER,                 -- same boundary in UTF-16 units, when the writer had it to give (T-0089.1.1, ADV-10);
                                               -- NULL on a full copy, or on a delta an older writer left the JS-side boundary out of
  tags         TEXT NOT NULL,                 -- prior tags (JSON), always full
  state        TEXT NOT NULL DEFAULT '{}',    -- prior non-text state (JSON): when_at, when_kind, when_source, when_label
  actor_id     TEXT NOT NULL DEFAULT '',      -- who made the change that retired this state
  channel      TEXT NOT NULL DEFAULT '',      -- rest | mcp | system:<job>
  reason       TEXT NOT NULL,                 -- update | append | merge | replace | rollup | status | due | mirror | revert
  meta         TEXT NOT NULL DEFAULT '{}',
  valid_from   INTEGER,                       -- when the prior state became current
  created_at   INTEGER NOT NULL,              -- when the prior state was retired
  CHECK ((content IS NULL) <> (prior_length IS NULL)),
  CHECK (prior_length_utf16 IS NULL OR prior_length IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_versions_entry ON entry_versions(entry_id, seq);

-- Soft delete (4.0, T-0089.1.2). A forgotten entry waits here for
-- TRASH_RETENTION_DAYS. Must stay in step with src/db/init.ts.
CREATE TABLE IF NOT EXISTS entries_trash (
  write_marker TEXT,
  restore_lease_owner TEXT,
  id           TEXT PRIMARY KEY,              -- the original entry id
  workspace_id TEXT NOT NULL DEFAULT '',      -- scopes restore and permanent delete
  actor_id     TEXT NOT NULL DEFAULT '',      -- the entry's author, for the permission check
  content      TEXT NOT NULL,                 -- kept out of row_json so escaping cannot pass the 2 MB row limit
  row_json     TEXT NOT NULL,                 -- every entries column except content and vector_ids
  edges_json   TEXT NOT NULL DEFAULT '[]',    -- edges at either endpoint at deletion time
  vector_ids   TEXT NOT NULL DEFAULT '[]',    -- the live row's own vector ids at deletion time; not
                                               -- rederivable, since a short append's chunk is
                                               -- id-update-<ts>, not a function of content — kept
                                               -- out of row_json on purpose, like content
  deleted_at   INTEGER NOT NULL,
  deleted_by   TEXT NOT NULL DEFAULT '',
  channel      TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL DEFAULT 'forget', -- forget | mirror | disconnect
  nonce        TEXT NOT NULL DEFAULT ''        -- per-row identity (adv-final MAJOR 1): a
                                                -- purge can free `id` and a fresh forget can
                                                -- reuse it, with SQLite reusing its own rowid
                                                -- on top; every trash mutation pins to this,
                                                -- not to id (or rowid) alone. '' means this row
                                                -- predates the column: no mutation may treat an
                                                -- empty nonce as a match, only as "conflict".
);

CREATE INDEX IF NOT EXISTS idx_entries_trash_deleted ON entries_trash(deleted_at);

-- R5 (budget audit, MINOR, 20-free-tier-ledger.md): listTrash's WHERE clause (src/memory/
-- trash-list.ts) scopes by workspace_id and orders by deleted_at DESC. Without this, the only
-- index available (deleted_at above) makes SQLite walk the whole table in deleted_at order,
-- filtering every row for a workspace match — 1,193 rows read for one 50-row page at 2,000 trash
-- rows, 5% visible. This lets it seek directly to the reader's own readable workspaces instead.
CREATE INDEX IF NOT EXISTS idx_entries_trash_workspace_deleted ON entries_trash(workspace_id, deleted_at DESC);

-- Lexical recall index (FTS5, trigram). Plain table, not external-content: entries
-- has a TEXT PK, so triggers mirror entries.rowid into entries_fts.rowid and sync
-- by rowid — an O(1) delete instead of a content-table scan. Must stay in step
-- with src/db/init.ts.
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, content, tokenize='trigram');

-- Indentation below must match src/db/init.ts's ENTRIES_FTS_*_TRIGGER_DDL
-- constants EXACTLY: SQLite stores a CREATE statement's body verbatim in
-- sqlite_master.sql (only "IF NOT EXISTS" is stripped), and the v2.2
-- liveness check (src/recall/fts.ts) compares that stored text against
-- those same constants byte-for-byte. A brain bootstrapped from this file
-- must read as live, not just one bootstrapped by applySchema.
CREATE TRIGGER IF NOT EXISTS entries_fts_insert
    AFTER INSERT ON entries
    BEGIN
      INSERT INTO entries_fts (rowid, id, content) VALUES (NEW.rowid, NEW.id, NEW.content);
    END;

-- The update trigger fires on every UPDATE; its WHEN guard covers exactly the
-- columns FTS mirrors, so recall's recall_count bumps write nothing here.
CREATE TRIGGER IF NOT EXISTS entries_fts_update
    AFTER UPDATE ON entries
    WHEN OLD.rowid IS NOT NEW.rowid OR OLD.id IS NOT NEW.id OR OLD.content IS NOT NEW.content
    BEGIN
      DELETE FROM entries_fts WHERE rowid = OLD.rowid;
      INSERT INTO entries_fts (rowid, id, content) VALUES (NEW.rowid, NEW.id, NEW.content);
    END;

CREATE TRIGGER IF NOT EXISTS entries_fts_delete
    AFTER DELETE ON entries
    BEGIN
      DELETE FROM entries_fts WHERE rowid = OLD.rowid;
    END;

-- Per-trigram document counts over entries_fts (distillation prices its df counts with it).
-- Stores nothing; resolves entries_fts by name at query time. Must stay in step with src/db/init.ts.
-- D1 export does not support virtual tables: drop it before `wrangler d1 export` and recreate it after, as for entries_fts.
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts_vocab USING fts5vocab(entries_fts, row);

-- Exact per-workspace entry counters (T-0065), replacing distillation's scoped
-- COUNT(*)/cache. Same ownership as entries_fts above: table and its three
-- triggers created together. Must stay in step with src/db/init.ts.
-- A row reaching n = 0 is kept, not deleted: SUM(n) is correct either way.
CREATE TABLE IF NOT EXISTS entry_counts (workspace_id TEXT PRIMARY KEY, n INTEGER NOT NULL);

CREATE TRIGGER IF NOT EXISTS entry_counts_insert
    AFTER INSERT ON entries
    BEGIN
      INSERT INTO entry_counts (workspace_id, n) VALUES (NEW.workspace_id, 1)
      ON CONFLICT(workspace_id) DO UPDATE SET n = n + 1;
    END;

CREATE TRIGGER IF NOT EXISTS entry_counts_update
    AFTER UPDATE OF workspace_id ON entries
    WHEN OLD.workspace_id IS NOT NEW.workspace_id
    BEGIN
      INSERT INTO entry_counts (workspace_id, n) VALUES (OLD.workspace_id, -1)
      ON CONFLICT(workspace_id) DO UPDATE SET n = n - 1;
      INSERT INTO entry_counts (workspace_id, n) VALUES (NEW.workspace_id, 1)
      ON CONFLICT(workspace_id) DO UPDATE SET n = n + 1;
    END;

CREATE TRIGGER IF NOT EXISTS entry_counts_delete
    AFTER DELETE ON entries
    BEGIN
      INSERT INTO entry_counts (workspace_id, n) VALUES (OLD.workspace_id, -1)
      ON CONFLICT(workspace_id) DO UPDATE SET n = n - 1;
    END;
