import { readReferenceSchema } from "./reference-schema";

/** What src/db/init.ts's probe sees on a migrated brain — see the handler in all(). */
const SCHEMA_SQL = readReferenceSchema();
export const TRIGGER_DDL = new Map([...SCHEMA_SQL.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)[\s\S]*?END;/g)].map(m => [m[1], m[0].slice(0, -1).replace(/\bIF NOT EXISTS\s+/i, "")]));
export const FTS_TABLE_DDL = SCHEMA_SQL.match(/CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts[^;]*;/)?.[0]
  .slice(0, -1).replace(/\bIF NOT EXISTS\s+/i, "") ?? "";
export const SCHEMA_PROBE_RESULTS = [
  ...["schema_meta", "entries", "edges", "insight_candidates", "workspaces", "users", "memberships", "entry_events", "admin_events", "maintenance_cursor", "migration_control", "memory_write_epoch", "memory_write_admissions", "restore_state", "embedding_migration_generation", "integration_state_generation", "integration_provider_generation", "oauth_registration_quota", "vector_cleanup_ops", "append_receipts", "prompt_capsule_revisions", "projects", "push_subscriptions", "entries_fts", "entry_counts", "recall_log", "entry_versions", "entries_trash", "entries_fts_vocab"].map(name => ({ kind: "table", name })),
  ...["idx_push_subscriptions_workspace", "idx_projects_workspace", "idx_entries_project", "idx_entries_capsule", "idx_workspaces_kind", "idx_entries_created_at", "idx_entries_source", "idx_edges_source", "idx_edges_target", "idx_edges_weight", "idx_insight_candidates_queue", "idx_entries_workspace_created", "idx_users_token_hash", "idx_users_email", "idx_memberships_workspace", "idx_entry_events_entry", "idx_entry_events_created", "idx_admin_events_created", "idx_entry_events_actor", "idx_entry_events_held", "idx_entry_events_life_end", "idx_entries_conflict_held", "idx_recall_log_ws", "idx_entries_when", "idx_entries_task", "idx_entries_insight", "idx_entries_stale", "idx_entries_ledger", "idx_entries_standing", "idx_entry_versions_entry", "idx_entries_trash_deleted", "idx_entries_trash_workspace_deleted"]
    .map(name => ({ kind: "index", name })),
  ...["trg_projects_write_fence_insert_v1", "trg_projects_write_fence_update_v1", "trg_projects_write_fence_delete_v1", "trg_entries_write_fence_insert_v5", "trg_entries_write_fence_source_update_v8",
    "trg_entries_write_fence_vector_update_v7", "trg_entries_write_fence_delete_v5",
    "trg_edges_endpoint_guard_v1",
    "trg_edges_write_fence_insert_v5", "trg_edges_write_fence_update_v5", "trg_edges_write_fence_delete_v5",
    "trg_insight_candidates_write_fence_insert_v5", "trg_insight_candidates_write_fence_update_v5",
    "trg_insight_candidates_write_fence_delete_v5", "trg_vector_cleanup_write_fence_insert_v1",
    "trg_vector_cleanup_write_fence_update_v1", "trg_vector_cleanup_write_fence_delete_v1"].map(name => ({ kind: "trigger", name })),
  ...["prompt_capsule_entry_insert", "prompt_capsule_entry_update",
    "prompt_capsule_entry_delete", "prompt_capsule_workspace_delete",
    "entries_fts_insert", "entries_fts_update", "entries_fts_delete",
    "entry_counts_insert", "entry_counts_update", "entry_counts_delete"]
    .map(name => ({ kind: "trigger", name, definition: TRIGGER_DDL.get(name) })),
  ...["id", "content", "tags", "source", "created_at", "vector_ids", "recall_count",
    "importance_score", "contradiction_wins", "contradiction_losses", "updated_at",
    "staleness_checked_at", "memory_tier", "pinned", "last_recalled_at",
    "restore_lease_owner", "migration_lease_owner", "write_marker", "workspace_id", "actor_id",
    "pending_append_passages", "when_at", "when_kind", "when_source", "when_label", "valid_from", "valid_until"]
    .map(name => ({ kind: "entry_column", name })),
  ...["id", "source_id", "target_id", "type", "weight", "provenance", "metadata",
    "created_at", "updated_at", "restore_lease_owner", "write_marker", "workspace_id"]
    .map(name => ({ kind: "edge_column", name })),
  ...["restore_lease_owner", "write_marker"].map(name => ({ kind: "project_column", name })),
  { kind: "insight_column", name: "write_marker" },
  { kind: "admission_column", name: "generation" },
  { kind: "cleanup_column", name: "write_marker" },
  ...["id", "backup_id", "backup_sha256", "run_id", "started_at", "next_offset", "next_edge_offset", "next_project_offset", "next_history_offset",
    "completed_at", "lease_owner", "lease_expires_at"].map(name => ({ kind: "restore_column", name })),
  ...["owner_id", "final_delta_completed_at", "active_delta_token", "active_delta_expires_at"].map(name => ({ kind: "migration_column", name })),
  { kind: "user_column", name: "default_share" },
  { kind: "user_column", name: "removed_at" },
  { kind: "user_column", name: "last_used_at" },
  { kind: "admin_event_column", name: "target_user_id" },
  { kind: "admin_event_column", name: "workspace_id" },
  // entry_versions.prior_length_utf16 arrives by ALTER on brains created before it existed and
  // lives in the base CREATE on fresh ones (T-0089.1.1, ADV-10) — a migrated brain reports it either way.
  { kind: "entry_version_column", name: "prior_length_utf16" },
  // entries_trash.nonce, same shape (T-0089.1.1, adv-final MAJOR 1): ALTER on an old brain, base
  // CREATE on a fresh one, reported either way by a migrated brain.
  { kind: "entries_trash_column", name: "nonce" },
];

