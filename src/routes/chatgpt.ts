import type { Env } from "../env";
import { json, requireAuth } from "../lib/http";
import { readBoundedResponseText } from "../lib/body";
import { ChatGptError, chatGptSessionStatus, disconnectChatGptSession, importChatGptSession } from "../lib/chatgpt-session";
import { listChatGptModels, runChatGptText } from "../lib/chatgpt";

/** 配備所有者だけが接続・切断・固定promptの実機probeを操作する。 */
export async function handleChatGptRoutes(request: Request, url: URL, env: Env, _ctx: ExecutionContext): Promise<Response | null> {
  if (!url.pathname.startsWith("/admin/chatgpt/")) return null;
  const denied = requireAuth(request, env);
  if (denied) return denied;
  if (env.MCP_EXECUTOR) return env.MCP_EXECUTOR.getByName("mcp-v1").handleChatGpt(request);
  const send = (value: unknown, status = 200) => {
    const response = json(value, status);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  try {
    if (url.pathname === "/admin/chatgpt/status" && request.method === "GET") {
      return send({ ok: true, ...await chatGptSessionStatus(env), operations: env.CHATGPT_OPERATIONS ?? "",
        configured_workspace_id: env.CHATGPT_OWNER_WORKSPACE_ID ?? "", usage_url: "https://chatgpt.com/settings/usage" });
    }
    if (url.pathname === "/admin/chatgpt/models" && request.method === "GET") {
      return send({ ok: true, models: await listChatGptModels(env) });
    }
    if (url.pathname === "/admin/chatgpt/session" && request.method === "DELETE") {
      let expectedClientId: string | undefined;
      if (request.body) {
        try {
          const payload = JSON.parse(await readBoundedResponseText(new Response(request.body, { headers: request.headers }), 1024));
          if (typeof payload?.client_id !== "string" || !payload.client_id) throw new Error();
          expectedClientId = payload.client_id;
        } catch { return send({ ok: false, code: "invalid_request" }, 400); }
      }
      return send({ ok: true, ...await disconnectChatGptSession(env, expectedClientId) });
    }
    if ((url.pathname === "/admin/chatgpt/session" && request.method === "PUT")
      || (url.pathname === "/admin/chatgpt/probe" && request.method === "POST")) {
      let payload: unknown;
      try { payload = JSON.parse(await readBoundedResponseText(new Response(request.body, { headers: request.headers }), 64 * 1024)); }
      catch { return send({ ok: false, code: "invalid_request" }, 400); }
      if (url.pathname === "/admin/chatgpt/session") {
        await importChatGptSession(env, payload);
        return send({ ok: true, connected: true });
      }
      const model = payload && typeof payload === "object" ? (payload as { model?: unknown }).model : undefined;
      if (typeof model !== "string") return send({ ok: false, code: "invalid_request" }, 400);
      const started = performance.now();
      const text = await runChatGptText(env, "answer", model,
        [{ role: "user", content: "Return exactly: SECOND_BRAIN_CHATGPT_OK" }],
        { chars: 100, outputChars: 1024, timeout: 25_000 });
      return send({ ok: true, provider: "chatgpt", model, completed: true,
        matched: text.trim() === "SECOND_BRAIN_CHATGPT_OK", latency_ms: Math.round(performance.now() - started) });
    }
    return send({ ok: false, code: "not_found" }, 404);
  } catch (error) {
    const safe = error instanceof ChatGptError ? error : new ChatGptError("connection_error");
    return send({ ok: false, code: safe.code, ...(safe.upstreamStatus ? { upstream_status: safe.upstreamStatus } : {}) },
      ["invalid_request", "invalid_credentials", "scope_not_granted", "model_not_allowlisted"].includes(safe.code) ? 400 : 503);
  }
}
