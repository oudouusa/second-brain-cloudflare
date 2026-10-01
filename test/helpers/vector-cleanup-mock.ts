import type { D1Mock } from "./d1-mock";

/** 削除台帳のSQLモデル。状態遷移・receipt・一括JSON指定をD1Mockと同じ台帳へ反映する。 */
export function executeVectorCleanupMock(db: Pick<D1Mock, "entries" | "vectorCleanupOps">, s: string, args: any[]) {
  if (s.startsWith("INSERT INTO vector_cleanup_ops")) {
    if (s.includes("FROM json_each(?)")) {
      const [created_at, expires_at, write_marker, raw] = args;
      const rows = JSON.parse(raw as string);
      for (const o of rows) db.vectorCleanupOps.push({ op_id: o.opId, entry_id: o.entryId,
        vector_ids: JSON.stringify(o.vectorIds), created_at, ready: 1, expires_at, write_marker });
      return { meta: { changes: rows.length } };
    }
    if (s.includes("SELECT ?, id, vector_ids")) {
      const [op_id, created_at, expires_at, write_marker, entry_id] = args;
      const entry = db.entries.find((row: any) => row.id === entry_id);
      if (!entry) return { meta: { changes: 0 } };
      db.vectorCleanupOps.push({ op_id, entry_id, vector_ids: entry.vector_ids, created_at, ready: 1, expires_at, write_marker });
      return { meta: { changes: 1 } };
    }
    const [op_id, entry_id, vector_ids, created_at, expires_at, write_marker] = args;
    db.vectorCleanupOps.push({ op_id, entry_id, vector_ids, created_at, ready: s.includes("VALUES (?, ?, ?, ?, 1, ?, ?)") ? 1 : 0, expires_at, write_marker });
    return { meta: { changes: 1 } };
  }
  if (s.startsWith("UPDATE vector_cleanup_ops SET write_marker = ?")) {
    const marker = args[0];
    const ids = s.includes(" IN (")
      ? new Set(s.includes("json_each(?)") ? JSON.parse(args[1] as string) : args.slice(1).map(String))
      : new Set([String(args[1])]);
    let changes = 0;
    for (const op of db.vectorCleanupOps) {
      if (!ids.has(op.op_id)) continue;
      op.write_marker = marker;
      changes++;
    }
    return { meta: { changes } };
  }
  if (s.startsWith("UPDATE vector_cleanup_ops SET ready = 1")) {
    const op = db.vectorCleanupOps.find(row => row.op_id === args[1]);
    const changed = op?.ready === 0;
    if (op && changed) {
      op.ready = 1;
      op.write_marker = args[0];
    }
    return { meta: { changes: changed ? 1 : 0 } };
  }
  if (s.startsWith("UPDATE vector_cleanup_ops SET ready = 2, expires_at = ?")) {
    const hasExpiry = s.includes("expires_at <= ?");
    const expiresAt = hasExpiry ? Number(args[args.length - 1]) : undefined;
    const nextExpiry = Number(args[0]);
    const marker = args[1];
    const ids = new Set((hasExpiry ? args.slice(2, -1) : args.slice(2)).map(String));
    let changes = 0;
    for (const op of db.vectorCleanupOps) {
      const stateEligible = s.includes("ready = 1 OR")
        ? op.ready === 1 || (op.ready === 0 && op.expires_at <= Number(expiresAt))
        : op.ready === 0 || op.ready === 1;
      if (ids.has(op.op_id) && stateEligible
        && (expiresAt === undefined || s.includes("ready = 1 OR") || op.expires_at <= expiresAt)) {
        op.ready = 2;
        op.expires_at = nextExpiry;
        op.write_marker = marker;
        changes++;
      }
    }
    return { meta: { changes } };
  }
  if (s.startsWith("UPDATE vector_cleanup_ops SET ready = 3, expires_at = ?")) {
    const transformsPayload = s.includes("vector_ids = json_object");
    const hasPayload = !transformsPayload && s.includes("vector_ids = ?");
    const expiresAt = args[0];
    const payload = hasPayload ? String(args[1]) : undefined;
    const marker = transformsPayload ? args[3] : hasPayload ? args[2] : args[1];
    const opIds = transformsPayload ? args.slice(4) : hasPayload ? args.slice(3) : args.slice(2);
    const ids = new Set(s.includes("json_each(?)") ? JSON.parse(opIds[0] as string) : opIds.map(String));
    let changes = 0;
    for (const op of db.vectorCleanupOps) {
      if (!ids.has(op.op_id)) continue;
      op.ready = 3;
      op.expires_at = Number(expiresAt);
      if (transformsPayload) {
        op.vector_ids = JSON.stringify({
          ids: JSON.parse(op.vector_ids),
          deleteMutationId: String(args[1]),
          deleteSubmittedAt: Number(args[2]),
        });
      } else if (payload !== undefined) op.vector_ids = payload;
      op.write_marker = marker;
      changes++;
    }
    return { meta: { changes } };
  }
  if (s.startsWith("DELETE FROM vector_cleanup_ops WHERE op_id =")) {
    const before = db.vectorCleanupOps.length;
    db.vectorCleanupOps = db.vectorCleanupOps.filter(op => op.op_id !== args[0]);
    return { meta: { changes: before - db.vectorCleanupOps.length } };
  }
  if (s.startsWith("DELETE FROM vector_cleanup_ops WHERE op_id IN")) {
    const ids = new Set(s.includes("json_each(?)") ? JSON.parse(args[0] as string) : args.map(String));
    const before = db.vectorCleanupOps.length;
    db.vectorCleanupOps = db.vectorCleanupOps.filter(op => !ids.has(op.op_id));
    return { meta: { changes: before - db.vectorCleanupOps.length } };
  }
  return undefined;
}
