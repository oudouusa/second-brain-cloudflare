import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { cleanTemp } from "../helpers/tmp";

// Nodeのfetch mockだけではWorkers固有のredirect制約を検出できない。
// 外部通信なしで、本物のworkerd・Web Crypto・D1・SSEを通す。
describe("ChatGPT直接接続のWorkers実ランタイム契約", () => {
  let mf: Miniflare;
  const issuer = "https://auth.openai.com";
  const clientId = "oaiapp_runtime_test";
  const scope = "offline_access resource.invoke chatgpt.tokens.use.direct";
  let hostId: string;
  let credentials: (seconds?: number) => object;
  beforeAll(async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = (claims: object) => {
      const body = [Buffer.from(JSON.stringify({ alg: "RS256", kid: "runtime-key" })).toString("base64url"),
        Buffer.from(JSON.stringify({ iss: issuer, sub: "runtime-subject", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString("base64url")].join(".");
      return body + "." + sign("RSA-SHA256", Buffer.from(body), pair.privateKey).toString("base64url");
    };
    credentials = (seconds = 3600) => ({ client_id: clientId, ext_agent_host_id: hostId, nonce: "runtime-nonce",
      id_token: jwt({ aud: clientId, nonce: "runtime-nonce" }),
      access_token: jwt({ aud: "https://api.openai.com/v1", client_id: clientId, scope, exp: Math.floor(Date.now() / 1000) + seconds }), refresh_token: "runtime-refresh" });
    const next = { id_token: jwt({ aud: clientId }), access_token: jwt({ aud: "https://api.openai.com/v1", client_id: clientId, scope }), refresh_token: "runtime-replacement" };
    const bundle = await build({ stdin: { contents: `
      import { handleChatGptRoutes } from "./src/routes/chatgpt";
      import { withVerifiedAuth } from "./src/lib/http";
      import { runChatGptText } from "./src/lib/chatgpt";
      import { createDefaultHandler } from "./src/routes/index";
      import { beginMemoryWriteAdmission, memoryWriteMarker } from "./src/migration/write-lock";
      import { initializeDatabase } from "./src/db/init";
      import { chatGptSessionStatus } from "./src/lib/chatgpt-session";
      import { McpExecutor as BaseExecutor } from "./src/mcp/executor";
      export class McpExecutor extends BaseExecutor {
        async handleChatGpt(request) {
          this.env.CHATGPT_OWNER_WORKSPACE_ID = (await chatGptSessionStatus(this.env)).owner_workspace_id;
          return super.handleChatGpt(request);
        }
      }
      export default { async fetch(request, env, ctx) {
        request = await withVerifiedAuth(request, env);
        // 本番では接続後にvarsを明示設定する。合成Workerは保存された束縛を使う。
        env.CHATGPT_OWNER_WORKSPACE_ID = (await chatGptSessionStatus(env)).owner_workspace_id;
        const url = new URL(request.url);
        if (url.pathname === "/fixture" && request.headers.get("X-Second-Brain-Auth-Verified") === "1") {
          const tracked = await beginMemoryWriteAdmission(env, ctx);
          try {
            if (request.method === "POST") {
              await env.DB.prepare("INSERT INTO entries (id, content, tags, source, created_at, workspace_id, write_marker) VALUES ('runtime-source', ?, '[]', 'test', ?, ?, ?)")
                .bind(await request.text(), Date.now() - 1000, env.CHATGPT_OWNER_WORKSPACE_ID, memoryWriteMarker(tracked.env)).run();
            } else {
              await env.DB.prepare("UPDATE entries SET write_marker = ? WHERE id = 'runtime-source'").bind(memoryWriteMarker(tracked.env, "delete")).run();
              await env.DB.prepare("DELETE FROM entries WHERE id = 'runtime-source'").run();
            }
            return Response.json({ ok: true });
          } finally { await tracked.finish(); }
        }
        if (["/chat", "/recall"].includes(url.pathname)) return await createDefaultHandler().fetch(request, env, ctx);
        if (url.pathname === "/insights/dry-run") {
          if (request.headers.get("X-Second-Brain-Auth-Verified") === "1") await initializeDatabase(env);
          return await createDefaultHandler().fetch(request, env, ctx);
        }
        if (url.pathname === "/generate") {
          try { return Response.json({ text: await runChatGptText(env, "answer", "gpt-5.6-luna",
            [{role:"user", content:url.searchParams.get("case") || "接続確認"}], {chars:100, outputChars:100, timeout:1000}) }); }
          catch (error) { return Response.json({code:error.code}, {status:503}); }
        }
        return await handleChatGptRoutes(request, url, env, ctx) || new Response(null, {status:404});
      }};
    `, resolveDir: resolve(import.meta.dirname, "../.."), sourcefile: "chatgpt-runtime-entry.ts", loader: "ts" },
      bundle: true, format: "esm", platform: "browser", target: "esnext", write: false, external: ["cloudflare:*"] });
    mf = new Miniflare({ workers: [
      { name: "brain", modules: true, compatibilityDate: "2026-06-17", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        script: bundle.outputFiles[0].text, d1Databases: { DB: "chatgpt-runtime" },
        kvNamespaces: { OAUTH_KV: "chatgpt-runtime-kv" }, durableObjects: { MCP_EXECUTOR: { className: "McpExecutor", useSQLite: true } },
        bindings: { AUTH_TOKEN: "runtime-owner", CHATGPT_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString("base64"), CHATGPT_OPERATIONS: "answer" }, outboundService: "openai" },
      { name: "openai", modules: true, compatibilityDate: "2026-06-17", bindings: { KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "runtime-key" }] }), NEXT: JSON.stringify(next) },
        script: `export default { async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === "/.well-known/jwks.json") return Response.json(JSON.parse(env.KEYS));
          if (url.pathname === "/api/accounts/oauth/token") return Response.json(JSON.parse(env.NEXT));
          if (url.pathname === "/v1/models") return Response.json({models:[{visibility:"list",slug:"gpt-5.6-luna",display_name:"Luna"}]});
          if (url.pathname !== "/v1/responses") return new Response(null, {status:404});
          const body = await request.json();
          if (body.input[0].content === "redirect") return new Response(null, {status:302, headers:{Location:"https://attacker.invalid/"}});
          if (!body.stream || body.store !== false || "max_output_tokens" in body) return new Response(null, {status:400});
          if (body.input.some(message => message.content.includes("missing-terminal"))) return new Response(
            new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"途中"}\\n\\n'), {headers:{"Content-Type":"text/event-stream"}});
          const sse = 'data: {"type":"response.output_text.delta","delta":"接続確認"}\\n\\n'
            + 'data: {"type":"response.completed","response":{"status":"completed"}}\\n\\n';
          return new Response(new TextEncoder().encode(sse), body.input[0].content === "no-content-type" ? {} : {headers:{"Content-Type":"text/event-stream"}});
        }};` },
    ] });
    const status = await mf.dispatchFetch("https://brain/admin/chatgpt/status", { headers: { Authorization: "Bearer runtime-owner" } });
    hostId = (await status.json() as { host_id: string }).host_id;
  }, 30_000);
  afterAll(async () => { await mf?.dispose(); cleanTemp(); });
  const owner = { Authorization: "Bearer runtime-owner", "Content-Type": "application/json" };
  it("認証・署名検証・暗号化保存と公開Responsesの完了まで動く", async () => {
    const denied = await mf.dispatchFetch("https://brain/admin/chatgpt/status"); expect(denied.status).toBe(401);
    const imported = await mf.dispatchFetch("https://brain/admin/chatgpt/session", { method: "PUT", headers: owner, body: JSON.stringify(credentials()) });
    expect(imported.status).toBe(200);
    const generated = await mf.dispatchFetch("https://brain/generate", { headers: owner });
    expect(await generated.json()).toEqual({ text: "接続確認" });
    const models = await mf.dispatchFetch("https://brain/admin/chatgpt/models", { headers: owner });
    expect(models.status).toBe(200);
  });
  it("Bearerを別originへ転送せず3xxを失敗として扱う", async () => {
    const response = await mf.dispatchFetch("https://brain/generate?case=redirect", { headers: owner });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: "upstream_error" });
  });
  it("本番の公開直接経路と同じContent-Type欠落SSEも完了まで検証する", async () => {
    const response = await mf.dispatchFetch("https://brain/generate?case=no-content-type", { headers: owner });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ text: "接続確認" });
  });
  it("D1の実CASで更新し、初回nonceを持たない更新後IDも正しく検証する", async () => {
    const imported = await mf.dispatchFetch("https://brain/admin/chatgpt/session", { method: "PUT", headers: owner, body: JSON.stringify(credentials(10)) });
    expect(imported.status).toBe(200);
    const generated = await mf.dispatchFetch("https://brain/generate", { headers: owner });
    expect(generated.status).toBe(200);
    const status = await mf.dispatchFetch("https://brain/admin/chatgpt/status", { headers: owner });
    expect(await status.json()).toMatchObject({ state: "ready", connected: true });
  });
  const withSource = async (test: () => Promise<void>, content = "接続確認") => {
    const seeded = await mf.dispatchFetch("https://brain/fixture", { method: "POST", headers: owner, body: content });
    expect(seeded.status).toBe(200);
    try { await test(); }
    finally {
      const deleted = await mf.dispatchFetch("https://brain/fixture", { method: "DELETE", headers: owner });
      expect(deleted.status).toBe(200);
    }
  };
  it("実際のDO RPCを通した回答SSEが停止と終端まで届く", async () => withSource(async () => {
    const response = await mf.dispatchFetch("https://brain/chat", { method: "POST", headers: owner,
      body: JSON.stringify({ query: "接続確認", memories: "合成記憶", workspace: "personal" }) });
    expect(response.status).toBe(200);
    const sse = await response.text();
    expect(sse).toContain('"type":"sources"');
    expect(sse).toContain('"id":"runtime-source"');
    expect(sse).toContain("接続確認"); expect(sse).toContain('"finish_reason":"stop"'); expect(sse).toContain("data: [DONE]");
  }));
  it("固定probeのJSONが実際のDO RPCで本文終端まで届く", async () => {
    const response = await mf.dispatchFetch("https://brain/admin/chatgpt/probe", { method: "POST", headers: owner,
      body: JSON.stringify({ model: "gpt-5.6-luna" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, completed: true, provider: "chatgpt" });
  });
  it("REST検索の実DO RPCでJSON本文終端と入力検証が届く", async () => {
    const response = await mf.dispatchFetch("https://brain/recall", { method: "POST", headers: owner,
      body: JSON.stringify({ query: "no-matching-synthetic-entry", synthesize: false }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, results: [] });
    const invalid = await mf.dispatchFetch("https://brain/recall", { method: "POST", headers: owner,
      body: JSON.stringify({ query: "認証", workspace: "invalid" }) });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toHaveProperty("error");
    const oversized = await mf.dispatchFetch("https://brain/recall", { method: "POST", headers: owner,
      body: JSON.stringify({ query: "認".repeat(12000) }) });
    expect(oversized.status).toBe(413); expect(await oversized.json()).toHaveProperty("error");
  });
  it("プレビューの実DO転送後も読取専用とlimit検証を保持する", async () => {
    const response = await mf.dispatchFetch("https://brain/insights/dry-run?limit=1", { headers: owner });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, candidates: [] });
    const invalid = await mf.dispatchFetch("https://brain/insights/dry-run?limit=invalid", { headers: owner });
    expect(invalid.status).toBe(400);
    const db = await mf.getD1Database("DB");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM entries").first("n")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM insight_candidates").first("n")).toBe(0);
  });
  it("DO転送後も回答本文の256 KiB上限を超える要求を拒否する", async () => {
    const response = await mf.dispatchFetch("https://brain/chat", { method: "POST", headers: owner,
      body: JSON.stringify({ query: "接続確認", memories: "x".repeat(256 * 1024) }) });
    expect(response.status).toBe(413);
  });
  it("DOの回答転送後も未完了のSSEを正常終了へ変換しない", async () => withSource(async () => {
    const response = await mf.dispatchFetch("https://brain/chat", { method: "POST", headers: owner,
      body: JSON.stringify({ query: "接続確認 missing-terminal", memories: "合成記憶", workspace: "personal" }) });
    expect(response.status).toBe(200);
    // workerdのHTTP転送ではstream errorもEOFになり得る。正常終了のSSE終端を出さないことを確認する。
    const partial = await response.text();
    expect(partial).toContain("途中");
    expect(partial).not.toContain('"finish_reason":"stop"'); expect(partial).not.toContain("data: [DONE]");
  }, "接続確認 missing-terminal"));
});
