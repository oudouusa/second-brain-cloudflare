// Auto-create for a write that names an unknown project: silent, best effort, one statement.
import type { Env } from "../env";
import { adminAuditEvent } from "../lib/admin-audit";
import { ensureProject } from "./registry";

/**
 * Called after the entry write succeeded. Never blocks or fails the capture: a lost
 * registry row only means the project is not listed until the next write names it.
 * Audits `project_autocreated` only when this call actually created the row.
 */
export async function autoCreateProject(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  target: { workspaceId: string; actorId: string; slug: string },
): Promise<void> {
  try {
    if (await ensureProject(env.DB, target.workspaceId, target.slug, env)) {
      adminAuditEvent(env, ctx, {
        actorId: target.actorId,
        workspaceId: target.workspaceId,
        event: "project_autocreated",
        payload: { slug: target.slug },
      });
    }
  } catch (e) {
    console.error("project auto-create failed (non-fatal):", e);
  }
}
