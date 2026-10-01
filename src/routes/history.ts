import type { Env } from "../env";
import { json, readJsonBody } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { readEntryHistory, MEMORY_HISTORY_MAX_RESULTS } from "../memory/history";

/** Read the immutable before-images created by update and smart merge/replace. */
export async function handleHistoryRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname === "/history" && request.method === "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Use POST /history with a JSON body" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST" },
    });
  }
  if (url.pathname !== "/history" || request.method !== "POST") return null;

  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  const parsed = await readJsonBody<{ id?: unknown; limit?: unknown }>(request, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const id = typeof parsed.value.id === "string" ? parsed.value.id.trim() : "";
  if (!id) return json({ ok: false, error: "id is required" }, 400);
  const limit = parsed.value.limit === undefined ? 20 : parsed.value.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit)
    || limit < 1 || limit > MEMORY_HISTORY_MAX_RESULTS) {
    return json({ ok: false, error: `limit must be an integer from 1 to ${MEMORY_HISTORY_MAX_RESULTS}` }, 400);
  }
  const history = await readEntryHistory(env, auth, id);
  if (!history) {
    return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
  }

  // 旧forkの退役行はversionsへ残し、4.0の変更・イベントは共通の認可済み表示を使う。
  return json({ ok: true, id, versions: history.legacyVersions.slice(0, limit),
    history: { ...history.history, items: history.history.items.slice(0, limit) } });
}
