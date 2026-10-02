# R2 backup / restore

This document describes the brain-v5 format on the 4.0.0 integration branch. The deployed 3.7.0 version used brain-v4.

## Format

Backups are manual snapshots only: no cron backups or per-memory dual writes. Immutable chunks and manifests are stored in the private `second-brain-cf-archive` bucket.

```text
backups/YYYY/MM/<unix-ms>/chunks/entries-<global-offset>.json
backups/YYYY/MM/<unix-ms>/chunks/edges-<global-offset>.json
backups/YYYY/MM/<unix-ms>/chunks/projects-<global-offset>.json
backups/YYYY/MM/<unix-ms>/chunks/history-<global-offset>.json
backups/YYYY/MM/<unix-ms>/manifest.json
```

A `brain-v5` manifest records `format`, `workerVersion`, `createdAt`, entry/edge/project/history counts, the fixed embedding profile, backup ID, and each chunk's table, global offset, count, object key, UTF-8 byte length, and SHA-256. The manifest's own SHA-256 fixes the entire descriptor set. R2 conditional puts refuse to overwrite chunks or manifests. If creation fails before the manifest is published, chunks from that attempt are deleted on a best-effort basis. Current entries' `vector_ids` are deployment-specific and excluded; re-embed after restore. Old vector references retained in trash are also discarded during recovery. R2 stores D1 entries, edges, Project settings, and history from entry_versions / entries_trash / recall_log / entry_events. Project and history workspace IDs are retained to restore membership. Integration tokens, workspace administration records, user configuration, item maps, and sync cursors are not written to R2.

Restore remains compatible with legacy `brain-v2.json` and `brain-v3` / `brain-v4` manifests. New backups on this branch always use `brain-v5`.

Cloudflare KV is eventually consistent, so D1 and KV cannot be proven to form a strict point-in-time snapshot. This fork does not add its own integration-state recovery layer. Before backup, disconnect every integration with `purge=true` and require zero known-provider mirror entries in D1. Backup returns 409 if a connection is visible in KV or even one provider-source entry remains. Credentials from a newly connected, not-yet-synced integration are not backed up either. Reconnect after restore and resync from the external source of truth.

Snapshot creation acquires a dedicated exclusive write barrier that expires after 120 seconds. It blocks new ordinary writes, confirms in D1 that existing admissions have drained, and rotates the epoch. Within the barrier, it checks entry/edge/project counts and edge referential integrity, reads D1 pages in global-offset order, and creates chunks of at most 4 MiB. Barrier ownership is rechecked before each page read and R2 write. This preserves a single snapshot without concurrent writes or loading the entire JSON into Worker memory. The barrier is released on success or failure only if ownership matches. Other migration/backup barriers or active writes return 423 for retry. Even if the Worker terminates before release, an expired snapshot barrier does not block admission, D1 triggers, or subsequent backup/restore.

## API

- `POST /admin/backup`: create a snapshot.
- `GET /admin/backups`: list manifest metadata, newest first.
- `POST /admin/restore/:backupId`: restore into empty D1 page by page. The next offset returned is persisted in the target D1 `restore_state` ledger, so calls without arguments resume the run.

Before D1 queries or mutations, restore validates the manifest fingerprint, descriptor continuity and counts, byte size / SHA-256 / JSON shape of the chunk containing the current cursor, and absence of known integration sources in its payload. Old archives containing integration mirrors return 409. The first restore requires empty D1; a visibly connected integration returns 409 with a request to disconnect. Replaying an incomplete page skips existing IDs. Entry, edge, and project resume cursors never move backward; `offset`, `edge_offset`, or `project_offset` ahead of the durable cursor returns 409. If any entry/edge/project row in a page fails, return 503 without advancing cursors or `completed_at`. Retry skips successful rows and retries failed ones. The final page verifies actual D1 counts against the manifest, then updates the integration generation in the same D1 transaction as the completion cursor.

Integration records use generation-specific KV keys, `integrations:<provider>:<generation>`. Connect, disconnect, and sync all check current D1 write admission and generation. An invocation started before restore can only reach an old-generation key even if it finishes late. Normal reads use only the current generation, so pre-restore KV blobs or old blobs arriving late from another colo are treated as disconnected. Only records explicitly reconnected by the owner become valid in the new generation. Physical deletion of old objects is not a safety condition under KV eventual consistency; administrators can explicitly clean the KV namespace to shorten credential retention.

After `completed_at`, another call for the same backup is a no-op even for an empty backup or explicitly old offsets. It does not reinsert old rows into D1 after normal operation resumes. A client that missed the final response can retry without arguments to read the saved cursors and completion state. To restore a nonempty backup afresh under the same ID, empty the target D1 and start a new run. An empty backup cannot distinguish an empty target from an intentional restart, so explicit restarts under that same backup ID are not supported.

`restore_state` holds the backup ID, run ID, cursors, completion state, and a short lease. Only one restore page runs at a time; a concurrent call during an active lease returns 409. An incomplete ledger remains a maintenance barrier between pages and blocks normal REST/MCP memory mutations and scheduled jobs. Restore alone passes through with its run ID and releases the lease after each page. A lease left behind by a stopped Worker can be reacquired after 120 seconds. Completion removes the barrier.

Overlaying another backup onto nonempty D1 is refused. If entries, edges, projects, insight candidates, and vector-cleanup tombstones are all empty, the ledger can switch to a new backup ID and start at offset 0. The D1 claim for a new restore run updates the embedding-migration generation and memory-write epoch in the same transaction; old shared-OAuth-KV cursors and pre-restore admissions cannot be reused afterward. If an upgrade stops between creation of the integration-generation singleton and insertion of its initial row, the first integration read/save repairs only the missing row once and rereads it. Keeping the ledger in D1 prevents a temporary restore drill using shared OAuth KV from interfering with another D1 database's recovery. The legacy KV key `restore:r2:v1` is ignored. After completion, reconnect/resync integrations and rebuild the index through `/vectorize-pending` or embedding migration.

FTS indexes (`entries_fts`, since 3.6.0) and `entry_counts` are derived from `entries` and excluded from both R2 backups and HTTP exports. Restore inserts into `entries` activate synchronous triggers that update FTS and counts. Nightly consistency checks detect gaps and repeat backfill. Full D1 SQL export fails with FTS5 virtual tables; use D1 Time Travel and table-specific SQL exports for predeployment preservation (see “Safeguards before updates and checks afterward” in `DEPLOYMENT.md`).

Until R2 is enabled and the bucket exists, the APIs return 503 and the configured fixed bucket name. This is the intended unconfigured state.

## Worker processing limits

To protect the Worker's 128 MiB memory limit, total snapshot rows and bytes are not capped; instead, D1 read pages are capped at 2,000 rows, R2 chunks at 4 MiB, and manifests at 512 KiB. A single row exceeding the chunk limit returns 413. Restore checks R2 metadata size before reading the object body. D1 restore write pages remain capped at 12 rows.

For backward compatibility, complete `GET /export` responses without arguments remain capped at 500 rows, an estimated 512 KiB, and 768 KiB of actual JSON. For larger brains, start with `GET /export?paged=1&limit=500` and pass `pagination.next_offset`, `next_edge_offset`, and `next_project_offset` to each subsequent request until `complete=true`. HTTP pages are capped at 500 rows. Legacy `brain-v2` restore keeps the 768 KiB / 500-row limit so a single object can be read safely. Normal `POST /import`, which accepts arbitrary JSON, stops at 1 MiB and 10,000 combined entries, edges, and projects to prevent structural expansion from exhausting memory.
