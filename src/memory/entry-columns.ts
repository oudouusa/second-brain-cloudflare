/**
 * Every `entries` column except `id`, `content` and `vector_ids`, in the order the
 * trash row keeps them (`entries_trash.row_json`). `id` lives in the trash row's own
 * primary key, `content` in its own column (2 MB row limit), and `vector_ids` is
 * rebuilt by the restore's re-embed. A test compares this list with the live schema,
 * so a new `entries` column that is not added here fails the build instead of being
 * silently lost on the next forget.
 *
 * `default` is the SQL literal an INSERT that omits the column would get: an absent
 * key in an old trash row restores it, while a stored null restores NULL.
 */
export interface EntryColumn { name: string; notNull: boolean; default?: string }

export const ENTRY_ROW_COLUMNS: readonly EntryColumn[] = [
  { name: "tags", notNull: true, default: "'[]'" },
  { name: "source", notNull: true, default: "'api'" },
  { name: "created_at", notNull: true },
  { name: "recall_count", notNull: false, default: "0" },
  { name: "importance_score", notNull: false, default: "0" },
  { name: "contradiction_wins", notNull: false, default: "0" },
  { name: "contradiction_losses", notNull: false, default: "0" },
  { name: "workspace_id", notNull: true, default: "''" },
  { name: "actor_id", notNull: true, default: "''" },
  { name: "updated_at", notNull: false },
  { name: "staleness_checked_at", notNull: false },
  { name: "when_at", notNull: false },
  { name: "when_kind", notNull: false },
  { name: "when_source", notNull: false },
  { name: "when_label", notNull: false },
  { name: "valid_from", notNull: false },
  { name: "valid_until", notNull: false },
  { name: "memory_tier", notNull: false, default: "'warm'" },
  { name: "pinned", notNull: false, default: "0" },
  { name: "last_recalled_at", notNull: false },
  { name: "pending_append_passages", notNull: true, default: "'[]'" },
];

/** `json_object(...)` over the columns of the entries row aliased `alias`. */
export function rowJsonSql(alias: string): string {
  return `json_object(${ENTRY_ROW_COLUMNS.map((c) => `'${c.name}', ${alias}.${c.name}`).join(", ")})`;
}

/** The restore's SELECT list: an absent key takes the column default, a stored null stays NULL. */
export function restoreColumnsSql(alias: string): { names: string; exprs: string } {
  const exprs = ENTRY_ROW_COLUMNS.map((c) => {
    const path = `'$.${c.name}'`;
    return `CASE WHEN json_type(${alias}.row_json, ${path}) IS NULL THEN ${c.default ?? "NULL"} ELSE json_extract(${alias}.row_json, ${path}) END`;
  });
  return { names: ENTRY_ROW_COLUMNS.map((c) => c.name).join(", "), exprs: exprs.join(", ") };
}

/** The edge columns a trash row keeps, as they stand in `edges`. */
export const EDGE_ROW_COLUMNS = [
  "id", "source_id", "target_id", "type", "weight", "provenance", "metadata", "created_at", "updated_at", "workspace_id",
] as const;

export function edgesJsonSql(alias: string): string {
  const obj = EDGE_ROW_COLUMNS.map((c) => `'${c}', g.${c}`).join(", ");
  // scope-exempt: by-id edge capture for entries the caller already authorized
  return `(SELECT json_group_array(json_object(${obj})) FROM edges g WHERE g.source_id = ${alias}.id OR g.target_id = ${alias}.id)`;
}
