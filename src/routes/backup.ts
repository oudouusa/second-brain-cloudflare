import type { Env } from "../env";
import { json, requireAuth } from "../lib/http";
import { parseImportLimit, parseImportOffset } from "../entries/import";
import {
  BackupError,
  createR2Backup,
  listR2Backups,
  restoreR2Backup,
} from "../backup/r2";
import { initializeDatabase } from "../db/init";

export async function handleBackupRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  const isBackupRoute = url.pathname === "/admin/backup"
    || url.pathname === "/admin/backups"
    || url.pathname.startsWith("/admin/restore/");
  if (!isBackupRoute) return null;
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  try {
    if (url.pathname === "/admin/backup" && request.method === "POST") {
      const initialized = await initializeDatabase(env);
      if (initialized.changed) {
        return json({
          ok: false,
          retry: true,
          error: "Database schema initialized; retry the same backup request",
        }, 202);
      }
      return json({ ok: true, manifest: await createR2Backup(env) });
    }
    if (url.pathname === "/admin/backups" && request.method === "GET") {
      return json({ ok: true, backups: await listR2Backups(env) });
    }
    if (url.pathname.startsWith("/admin/restore/") && request.method === "POST") {
      const backupId = decodeURIComponent(url.pathname.slice("/admin/restore/".length));
      const offsetRaw = url.searchParams.get("offset");
      const projectOffsetRaw = url.searchParams.get("project_offset");
      const historyOffsetRaw = url.searchParams.get("history_offset");
      const edgeOffsetRaw = url.searchParams.get("edge_offset");
      const result = await restoreR2Backup(env, backupId, {
        offset: offsetRaw === null ? undefined : parseImportOffset(offsetRaw),
        historyOffset: historyOffsetRaw === null ? undefined : parseImportOffset(historyOffsetRaw),
        projectOffset: projectOffsetRaw === null ? undefined : parseImportOffset(projectOffsetRaw),
        edgeOffset: edgeOffsetRaw === null ? undefined : parseImportOffset(edgeOffsetRaw),
        limit: parseImportLimit(url.searchParams.get("limit")),
      });
      return json({ ok: true, ...result });
    }
  } catch (e) {
    if (e instanceof BackupError) return json({ ok: false, error: e.message }, e.status);
    throw e;
  }
  return null;
}
