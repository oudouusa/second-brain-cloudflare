import type { Env } from "../env";

// 復旧専用の固定列。archive内のtable名や列名をSQLへ直接展開しない。
const TABLE_COLUMNS = {
  entry_versions: "id,entry_id,workspace_id,seq,content,prior_length,prior_length_utf16,tags,state,actor_id,channel,reason,meta,valid_from,created_at",
  entries_trash: "id,workspace_id,actor_id,content,row_json,edges_json,vector_ids,deleted_at,deleted_by,channel,reason,nonce",
  recall_log: "id,workspace_id,created_at,channel,query,params,returned_ids,followed_ids",
  entry_events: "id,entry_id,actor_id,event,payload,created_at",
} as const;
type HistoryTable = keyof typeof TABLE_COLUMNS;
export interface BackupHistoryRow { table: HistoryTable; row: Record<string, string | number | null> }
const tables = Object.keys(TABLE_COLUMNS) as HistoryTable[];
// scope-exempt: owner-adminの復旧だけが使う全deploymentの固定table集合の件数。
export const HISTORY_COUNT_SQL = tables.map(table => `(SELECT COUNT(*) FROM ${table})`).join(" + ");
// scope-exempt: owner-adminの復旧開始は全deploymentで空であることを原子的に要求する。
export const HISTORY_EMPTY_SQL = tables.map(table => `NOT EXISTS (SELECT 1 FROM ${table} LIMIT 1)`).join(" AND ");

// snapshot lease保持中の全deployment読取。ROWID順により同時刻eventのライフサイクル順を保つ。
export async function readBackupHistoryPage(env: Env, offset: number, limit: number): Promise<BackupHistoryRow[]> {
  const rows: BackupHistoryRow[] = [];
  for (const table of tables) {
    // scope-exempt: snapshot leaseを保持したowner-admin backupの固定table読取。
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    const total = Number(count?.n ?? 0);
    if (offset >= total) { offset -= total; continue; }
    // scope-exempt: snapshot leaseを保持したowner-admin backupの固定table読取。
    const result = await env.DB.prepare(`SELECT ${TABLE_COLUMNS[table]} FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`)
      .bind(limit - rows.length, offset).all<Record<string, string | number | null>>();
    rows.push(...result.results.map(row => ({ table, row })));
    if (rows.length >= limit) break;
    offset = 0;
  }
  return rows;
}

export function parseBackupHistoryRows(value: unknown): BackupHistoryRow[] {
  if (!Array.isArray(value)) throw new Error("Invalid history rows");
  for (const item of value) {
    if (!item || typeof item !== "object" || !Object.hasOwn(TABLE_COLUMNS, item.table)
      || !item.row || typeof item.row !== "object" || Array.isArray(item.row)) throw new Error("Invalid history row");
    const columns = TABLE_COLUMNS[item.table as HistoryTable].split(",");
    if (Object.keys(item.row).length !== columns.length
      || columns.some(column => !Object.hasOwn(item.row, column)
        || !(item.row[column] === null || typeof item.row[column] === "string"
          || (typeof item.row[column] === "number" && Number.isFinite(item.row[column]))))) throw new Error("Invalid history columns");
    if (item.table === "entry_versions" ? !Number.isSafeInteger(item.row.id) : typeof item.row.id !== "string") throw new Error("Invalid history id");
  }
  return value as BackupHistoryRow[];
}

/** 同一pageの再送はINSERT ... DO NOTHING。epochは移植せず、このpageのleaseだけを付与する。 */
export async function restoreBackupHistoryPage(env: Env, rows: BackupHistoryRow[], leaseOwner: string): Promise<void> {
  if (!rows.length) return;
  const statements = rows.map(({ table, row }) => {
    const columns = TABLE_COLUMNS[table].split(",");
    const values = columns.map(column => row[column]);
    if (table === "entries_trash") {
      // Vectorizeは派生索引。旧deploymentのIDを持ち込まずrestoreTrashが再生成する。
      values[columns.indexOf("vector_ids")] = "[]";
      const snapshot = JSON.parse(String(row.row_json));
      snapshot.vector_ids = "[]";
      for (const key of ["write_marker", "restore_lease_owner", "migration_lease_owner"]) delete snapshot[key];
      values[columns.indexOf("row_json")] = JSON.stringify(snapshot);
    }
    if (table !== "entry_events") { columns.push("restore_lease_owner"); values.push(leaseOwner); }
    // versioning: exempt: owner認可済みR2復旧で履歴原本を戻す。新しい編集ではない。
    return env.DB.prepare(`INSERT INTO ${table} (${columns.join(",")}) SELECT ${columns.map(() => "?").join(",")}
      WHERE EXISTS (SELECT 1 FROM restore_state WHERE id = 'r2-v1' AND lease_owner = ? AND lease_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
      ON CONFLICT(id) DO NOTHING`).bind(...values, leaseOwner);
  });
  await env.DB.batch(statements);
}
