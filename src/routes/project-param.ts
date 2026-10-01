import type { Env } from "../env";
import { json } from "../lib/http";
import type { Identity } from "../lib/identity";
import { resolveProjectRead } from "../projects/resolve";
import type { ProjectRow } from "../projects/registry";

/**
 * The `?project=` read param shared by /list, /recall, /digest and /graph.
 * Undefined when absent or empty; a Response (400 bad slug, 404 unknown with the known
 * slugs) when it cannot be resolved among the workspaces this read may see.
 */
export async function readProjectParam(
  env: Env,
  identity: Identity,
  url: URL,
  opts?: { layer?: "personal" | "company"; teamId?: string },
  value: unknown = url.searchParams.get("project"),
): Promise<ProjectRow[] | undefined | Response> {
  if (value != null && typeof value !== "string") return json({ ok: false, error: "project must be a string" }, 400);
  const raw = typeof value === "string" ? value.trim() : undefined;
  if (!raw) return undefined;
  const resolved = await resolveProjectRead(env, identity, raw, opts);
  if (resolved.ok) return resolved.rows;
  return json({
    ok: false,
    error: resolved.error,
    ...(resolved.known_projects ? { known_projects: resolved.known_projects } : {}),
  }, resolved.status);
}
