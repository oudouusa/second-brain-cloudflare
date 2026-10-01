import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { VERIFIED_AUTH_HEADER } from "../../src/lib/http";
import { chatGptAccessToken, chatGptSessionStatus, disconnectChatGptSession, importChatGptSession,
  initializeChatGptSession, chatGptUpstreamCode, ChatGptError } from "../../src/lib/chatgpt-session";
import { listChatGptModels, runChatGptText, runChatGptAnswerStream } from "../../src/lib/chatgpt";
import { isChatGptOperationEnabled, runChatGptGeneration, runChatGptGenerationAnswerStream } from "../../src/lib/chatgpt";
import { handleChatGptRoutes } from "../../src/routes/chatgpt";

const clientId = "oaiapp_second_brain_test";
const subject = "test-subject";
const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const scope = "openid offline_access resource.invoke chatgpt.tokens.use.direct";
const limits = { chars: 1000, outputChars: 2000, timeout: 1000 };
const messages = [{ role: "user" as const, content: "非公開のprompt" }];
const databases: ReturnType<typeof makeSqliteD1>[] = [];
let key: { publicKey: KeyObject; privateKey: KeyObject };
let jwk: object;
beforeAll(() => { key = generateKeyPairSync("rsa", { modulusLength: 2048 }); jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256" }; });
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function jwt(claims: object, header: object = {}) {
  const parts = [Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", ...header })).toString("base64url"),
    Buffer.from(JSON.stringify({ iss: issuer, sub: subject, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString("base64url")];
  const input = parts.join(".");
  return input + "." + sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url");
}
function credentials(accessClaims: object = {}, idClaims: object = {}) {
  return { client_id: clientId, ext_agent_host_id: "urn:uuid:opaque-host", nonce: "test-nonce",
    id_token: jwt({ aud: clientId, nonce: "test-nonce", ...idClaims }),
    access_token: jwt({ aud: resource, client_id: clientId, scope, ...accessClaims }), refresh_token: "private-refresh-token" };
}
function sse(events: unknown[], tail = "") {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + tail,
    { headers: { "Content-Type": "text/event-stream" } });
}
const delta = (text: unknown) => ({ type: "response.output_text.delta", delta: text });
const completed = { type: "response.completed", response: { status: "completed" } };
function network(respond: (url: string, init?: RequestInit) => Response | Promise<Response> = () => sse([delta("回答"), completed])) {
  const mock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/.well-known/jwks.json")) return Promise.resolve(Response.json({ keys: [jwk] }));
    return Promise.resolve(respond(String(url), init));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
async function setup(accessClaims: object = {}, respond?: Parameters<typeof network>[0]) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const db = makeSqliteD1(); databases.push(db);
  const env = makeTestEnv(makeTestDb(), { DB: db.db as unknown as D1Database,
    CHATGPT_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64"), CHATGPT_OPERATIONS: "classify,answer" });
  await initializeChatGptSession(env);
  await db.db.prepare("CREATE TABLE chatgpt_host (id INTEGER PRIMARY KEY, host_id TEXT NOT NULL)").run();
  await db.db.prepare("INSERT INTO chatgpt_host VALUES (1, ?)").bind("urn:uuid:opaque-host").run();
  const fetch = network(respond);
  await importChatGptSession(env, credentials(accessClaims));
  const status = await chatGptSessionStatus(env);
  env.CHATGPT_OWNER_WORKSPACE_ID = status.owner_workspace_id;
  env.CHATGPT_WORKSPACE_ID = status.owner_workspace_id;
  return { env, db, fetch };
}

describe("ChatGPT資格情報と更新の境界", () => {
  it("認証を検証して暗号化し、statusに資格情報を返さない", async () => {
    const { env, db } = await setup();
    const row = await env.DB.prepare("SELECT * FROM chatgpt_session").first<{ cipher: string }>();
    expect(row?.cipher).toMatch(/^v1\./);
    expect(row?.cipher).not.toContain("private-refresh-token");
    expect(await chatGptSessionStatus(env)).toMatchObject({ connected: true, state: "ready" });
    expect(JSON.stringify(await chatGptSessionStatus(env))).not.toContain("token");
    expect(await chatGptAccessToken(env)).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
  });
  it.each([
    [{ aud: "wrong" }, {}], [{ client_id: "wrong" }, {}], [{ sub: "another-account" }, {}],
    [{ scope: "openid" }, {}], [{ exp: 1 }, {}], [{ nbf: 9e12 }, {}],
    [{ iss: "https://attacker.invalid" }, {}], [{}, { nonce: "wrong" }], [{}, { aud: "wrong" }],
  ])("誤った認証・権限を保存しない: %j", async (access, identity) => {
    const { env, db } = await setup();
    const before = await db.db.prepare("SELECT revision FROM chatgpt_session").first();
    await expect(importChatGptSession(env, credentials(access, identity))).rejects.toBeInstanceOf(ChatGptError);
    expect(await db.db.prepare("SELECT revision FROM chatgpt_session").first()).toEqual(before);
  });
  it("改変署名・未知鍵・nonce欠落・dynamic clientを拒否する", async () => {
    const { env } = await setup();
    for (const bad of [
      { ...credentials(), access_token: jwt({ aud: resource }, { kid: "unknown" }) },
      { ...credentials(), id_token: jwt({ aud: clientId, nonce: "test-nonce" }, { alg: "none" }) },
      { ...credentials(), access_token: "not-a-jwt" }, { ...credentials(), nonce: "" },
      { ...credentials(), client_id: "dynamic_agent_client" },
    ]) await expect(importChatGptSession(env, bad)).rejects.toBeInstanceOf(ChatGptError);
  });
  it("鍵欠落・鍵違い・暗号文改変を拒否する", async () => {
    const { env, db } = await setup();
    await expect(chatGptAccessToken({ ...env, CHATGPT_CREDENTIAL_KEY: undefined })).rejects.toMatchObject({ code: "credential_key_missing" });
    await expect(chatGptAccessToken({ ...env, CHATGPT_CREDENTIAL_KEY: "invalid" })).rejects.toMatchObject({ code: "credential_key_invalid" });
    await expect(chatGptAccessToken({ ...env, CHATGPT_CREDENTIAL_KEY: Buffer.alloc(32, 8).toString("base64") })).rejects.toMatchObject({ code: "credentials_unreadable" });
    await db.db.prepare("UPDATE chatgpt_session SET cipher = 'v0.corrupt'").run();
    await expect(chatGptAccessToken(env)).rejects.toMatchObject({ code: "credentials_unreadable" });
  });
  it("期限前の同時更新を一回にし、新しいrefresh tokenも原子的に保存する", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const { env, db, fetch } = await setup({ exp: Math.floor(Date.now() / 1000) + 10 }, (url, init) => {
      expect(url).toBe(`${issuer}/api/accounts/oauth/token`);
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("private-refresh-token");
      expect(new URLSearchParams(String(init?.body)).has("scope")).toBe(false);
      return pending;
    });
    const first = chatGptAccessToken(env);
    await vi.waitFor(async () => expect((await env.DB.prepare("SELECT state FROM chatgpt_session").first<{ state: string }>())?.state).toBe("refreshing"));
    await expect(chatGptAccessToken(env)).rejects.toMatchObject({ code: "refresh_in_progress" });
    const next = credentials();
    resolve(Response.json({ ...next, refresh_token: "rotated-refresh-token", earliest_refresh_at: Math.floor(Date.now() / 1000) + 300 }));
    expect(await first).toBe(next.access_token);
    expect(await chatGptAccessToken(env)).toBe(next.access_token);
    expect(fetch.mock.calls.filter(call => String(call[0]).endsWith("/oauth/token"))).toHaveLength(1);
    expect(await chatGptSessionStatus(env)).toMatchObject({ state: "ready" });
  });
  it.each(["network", "invalid_grant", "bad_json"])("不確実・失効した更新を再送しない: %s", async kind => {
    const { env, fetch } = await setup({ exp: Math.floor(Date.now() / 1000) + 10 }, () => {
      if (kind === "network") throw new Error("private diagnostic");
      return kind === "invalid_grant" ? Response.json({ error: "invalid_grant" }, { status: 400 }) : new Response("private invalid JSON");
    });
    await expect(chatGptAccessToken(env)).rejects.toBeInstanceOf(ChatGptError);
    await expect(chatGptAccessToken(env)).rejects.toMatchObject({ code: "reauth_required" });
    expect(fetch.mock.calls.filter(call => String(call[0]).endsWith("/oauth/token"))).toHaveLength(1);
  });
  it("明示的な5xx拒否は資格情報を保持する", async () => {
    const { env } = await setup({ exp: Math.floor(Date.now() / 1000) + 10 }, () => Response.json({ error: { code: "usage_unavailable" } }, { status: 503 }));
    await expect(chatGptAccessToken(env)).rejects.toMatchObject({ code: "usage_unavailable", upstreamStatus: 503 });
    expect(await chatGptSessionStatus(env)).toMatchObject({ state: "ready" });
  });
  it("更新中の新しい認証を古い更新結果で上書きしない", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const { env, db } = await setup({ exp: Math.floor(Date.now() / 1000) + 10 }, () => pending);
    const refresh = chatGptAccessToken(env);
    await vi.waitFor(async () => expect((await env.DB.prepare("SELECT state FROM chatgpt_session").first<{ state: string }>())?.state).toBe("refreshing"));
    await importChatGptSession(env, credentials());
    const revision = await db.db.prepare("SELECT revision FROM chatgpt_session").first();
    resolve(Response.json(credentials()));
    await expect(refresh).rejects.toMatchObject({ code: "session_changed" });
    expect(await db.db.prepare("SELECT revision FROM chatgpt_session").first()).toEqual(revision);
  });
  it("更新成功後の署名鍵5xxでは古いrefresh tokenを再利用しない", async () => {
    const { env } = await setup({ exp: Math.floor(Date.now() / 1000) + 10 });
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/oauth/token")
      ? Response.json(credentials()) : Response.json({ error: { code: "user_unavailable" } }, { status: 503 }))));
    await expect(chatGptAccessToken(env)).rejects.toMatchObject({ upstreamStatus: 503 });
    expect(await chatGptSessionStatus(env)).toMatchObject({ state: "reauth" });
  });
  it("earliest_refresh_at以前の更新を送らない", async () => {
    const { env, fetch } = await setup();
    await importChatGptSession(env, { ...credentials({ exp: Math.floor(Date.now() / 1000) + 3 }), earliest_refresh_at: Math.floor(Date.now() / 1000) + 20 });
    await expect(chatGptAccessToken(env)).rejects.toMatchObject({ code: "refresh_not_yet_allowed" });
    expect(fetch.mock.calls.some(call => String(call[0]).endsWith("/oauth/token"))).toBe(false);
  });
  it("切断は公開discoveryの失効先を使い、資格情報だけを除去する", async () => {
    const { env, db } = await setup({}, url => url.endsWith("/openid-configuration")
      ? Response.json({ revocation_endpoint: `${issuer}/oauth/revoke` }) : new Response(null, { status: 200 }));
    expect(await disconnectChatGptSession(env)).toEqual({ revoked: true });
    expect(await chatGptSessionStatus(env)).toEqual({ connected: false, state: "disconnected", host_id: "urn:uuid:opaque-host" });
    expect(db.rows()).toHaveLength(0);
    expect(await disconnectChatGptSession(env)).toEqual({ revoked: true });
    await expect(chatGptAccessToken(env)).rejects.toMatchObject({ code: "not_connected" });
  });
  it("失効未確認を返し、他のoriginへトークンを送らない", async () => {
    const { env, fetch } = await setup({}, () => Response.json({ revocation_endpoint: "https://attacker.invalid/revoke" }));
    expect(await disconnectChatGptSession(env)).toEqual({ revoked: false });
    expect(fetch.mock.calls.some(call => String(call[0]).includes("attacker.invalid"))).toBe(false);
  });
});

describe("公開Responsesの完了境界", () => {
  it("公開URL・OAuth・developer・store:false・stream:trueを使う", async () => {
    const { env, fetch } = await setup({}, () => sse([delta("回答"), completed]));
    expect(await runChatGptText(env, "answer", "gpt-5.6-luna", [{ role: "system", content: "命令" }, ...messages], limits)).toBe("回答");
    const [url, init] = fetch.mock.calls.find(call => String(call[0]).endsWith("/responses"))!;
    expect(url).toBe(`${resource}/responses`);
    expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Bearer /);
    expect(JSON.parse(String(init?.body))).toEqual({ model: "gpt-5.6-luna", input: [{ role: "developer", content: "命令" }, ...messages], store: false, stream: true });
  });
  it.each([
    [delta("途中"), { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }],
    [delta("途中"), { type: "response.incomplete" }], [delta("途中")],
    [{ type: "error", code: "usage_unavailable" }], [delta(42), completed],
    [{ type: "response.output_item.added", item: { type: "function_call" } }, completed],
    [{ type: "response.completed", response: { status: "incomplete" } }],
  ].map(events => [events]))("200で始まった失敗・未完了も拒否する: %j", async events => {
    const { env } = await setup({}, () => sse(events as unknown[]));
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toBeInstanceOf(ChatGptError);
  });
  it("イベント分割・複数data行・コメントを読める", async () => {
    const raw = ': comment\n\ndata: {"type":"response.output_text.delta",\ndata: "delta":"回答"}\n\n' + `data: ${JSON.stringify(completed)}\n\n`;
    const { env } = await setup({}, () => new Response(new ReadableStream({ start(controller) {
      for (const byte of new TextEncoder().encode(raw)) controller.enqueue(Uint8Array.of(byte)); controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } }));
    expect(await runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).toBe("回答");
  });
  it("Content-Type欠落でも本文と完了を検証し、途中の使用量エラーを拒否する", async () => {
    const headerless = (events: unknown[]) => { const response = sse(events); response.headers.delete("Content-Type"); return response; };
    const { env } = await setup({}, () => headerless([delta("回答"), completed]));
    expect(await runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).toBe("回答");
    network(() => headerless([delta("途中")]));
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ code: "incomplete_response" });
    network(() => headerless([delta("途中"), { type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } } }]));
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ code: "subscription_sharing_usage_unavailable" });
    network(() => new Response(new TextEncoder().encode("data: invalid-json\n\n")));
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("出力・受信バイト・入力・モデルの上限を守る", async () => {
    const { env } = await setup({}, () => sse([delta("a".repeat(2100)), completed]));
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ code: "response_too_large" });
    network(() => sse([], ":" + "a".repeat(256 * 1024)));
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ code: "response_too_large" });
    await expect(runChatGptText(env, "answer", "unapproved", messages, limits)).rejects.toMatchObject({ code: "model_not_allowlisted" });
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", [], limits)).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("空のタグ回答だけは正常な完了として受け入れる", async () => {
    const { env } = await setup({}, () => sse([completed]));
    expect(await runChatGptText(env, "query-tags", "gpt-5.6-luna", messages, limits)).toBe("");
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("HTTPエラー・不正JSON・誤ったcontent-typeを秘密なしで伝える", async () => {
    const { env } = await setup({}, () => Response.json({ error: { code: "private-error-body" } }, { status: 403 }));
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ code: "upstream_error", upstreamStatus: 403 });
    network(() => sse([], "data: private-error-body\n\n"));
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ code: "invalid_response" });
    network(() => Response.json({}));
    await expect(runChatGptText(env, "answer", "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ code: "invalid_response" });
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logs).not.toContain("private-error-body"); expect(logs).not.toContain(messages[0].content);
    expect(logs).not.toContain("private-refresh-token");
  });
  it("回答のSSE契約を保ち、完了前にDONEを返さない", async () => {
    const { env } = await setup();
    const stream = await runChatGptAnswerStream(env, "gpt-5.6-luna", messages, limits);
    const raw = await new Response(stream).text();
    expect(raw).toContain('"content":"回答"'); expect(raw).toContain('"finish_reason":"stop"'); expect(raw).toContain("[DONE]");
    network(() => sse([delta("途中"), { type: "response.incomplete" }]));
    await expect(new Response(await runChatGptAnswerStream(env, "gpt-5.6-luna", messages, limits)).text()).rejects.toMatchObject({ code: "incomplete_response" });
  });
  it("回答開始前のHTTP拒否をthrowし、キャンセルを伝播する", async () => {
    const { env } = await setup({}, () => new Response(null, { status: 503 }));
    await expect(runChatGptAnswerStream(env, "gpt-5.6-luna", messages, limits)).rejects.toMatchObject({ upstreamStatus: 503 });
    const cancel = vi.fn();
    network(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta("回答"))}\n\n`)); }, cancel }), { headers: { "Content-Type": "text/event-stream" } }));
    const stream = await runChatGptAnswerStream(env, "gpt-5.6-luna", messages, limits);
    await stream.cancel(); expect(cancel).toHaveBeenCalled();
  });
  it("既存callerを直接接続へ切替え、保存JSON・失敗時の見送りを維持する", async () => {
    const { env } = await setup({}, () => sse([delta('{"importance":3,"canonical":false,"kind":"episodic"}'), completed]));
    expect(isChatGptOperationEnabled(env, "classify")).toBe(true);
    expect(isChatGptOperationEnabled(env, "digest")).toBe(false);
    expect(await runChatGptGeneration(env, "classify", "内容", 64)).toContain('"importance":3');
    await expect(runChatGptGeneration(env, "classify", "内容", 999)).rejects.toMatchObject({ code: "invalid_request" });
    network(() => sse([delta("無効な分類"), completed]));
    await expect(runChatGptGeneration(env, "classify", "内容", 64)).rejects.toMatchObject({ code: "invalid_response" });
    expect(env.AI.run).not.toHaveBeenCalled();
    network(() => sse([delta("回答"), completed]));
    expect(await new Response(await runChatGptGenerationAnswerStream(env, messages)).text()).toContain("[DONE]");
  });
  it("accountのmodels配列を使い、表示対象だけを返す", async () => {
    const { env } = await setup({}, () => Response.json({ models: [{ slug: "gpt-5.6-luna", display_name: "Luna", visibility: "list" }, { slug: "hidden", visibility: "hide" }] }));
    expect(await listChatGptModels(env)).toEqual([{ slug: "gpt-5.6-luna", display_name: "Luna" }]);
    network(() => Response.json({ data: [] }));
    await expect(listChatGptModels(env)).rejects.toMatchObject({ code: "invalid_model_catalog" });
  });
});

describe("所有者専用の接続管理", () => {
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  function request(path: string, method = "GET", payload?: unknown, owner = true) {
    return new Request(`https://example.test/admin/chatgpt/${path}`, { method,
      headers: owner ? { [VERIFIED_AUTH_HEADER]: "1" } : {}, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  }
  it("認証なし・通常memberには資格情報とprobeを公開しない", async () => {
    const { env } = await setup();
    const req = request("status", "GET", undefined, false);
    expect((await handleChatGptRoutes(req, new URL(req.url), env, ctx))?.status).toBe(401);
    expect(await handleChatGptRoutes(req, new URL("https://example.test/other"), env, ctx)).toBeNull();
  });
  it("status・models・固定probeと接続・切断を扱う", async () => {
    const { env } = await setup({}, url => url.endsWith("/responses") ? sse([delta("SECOND_BRAIN_CHATGPT_OK"), completed]) : Response.json({ models: [] }));
    for (const [path, method, body] of [["status", "GET", undefined], ["models", "GET", undefined], ["probe", "POST", { model: "gpt-5.6-luna" }], ["session", "PUT", credentials()], ["session", "DELETE", undefined]] as const) {
      const req = request(path, method, body);
      const result = await handleChatGptRoutes(req, new URL(req.url), env, ctx);
      expect(result?.status).toBe(200); expect(result?.headers.get("Cache-Control")).toBe("no-store");
      const output = await result?.json();
      expect(JSON.stringify(output)).not.toContain("private-refresh-token");
      if (path === "probe") expect(output).toMatchObject({ matched: true, completed: true });
    }
  });
  it("不正payload・未知route・未承認modelを拒否する", async () => {
    const { env } = await setup();
    for (const [path, method, body, status] of [["probe", "POST", {}, 400], ["probe", "POST", { model: "wrong" }, 400], ["session", "PUT", {}, 400], ["unknown", "GET", undefined, 404]] as const) {
      const req = request(path, method, body);
      expect((await handleChatGptRoutes(req, new URL(req.url), env, ctx))?.status).toBe(status);
    }
  });
  it("重い処理を既存DOへ送り、新しいstorage/bindingを作らない", async () => {
    const { env } = await setup();
    const handleChatGpt = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const getByName = vi.fn().mockReturnValue({ handleChatGpt });
    env.MCP_EXECUTOR = { getByName } as unknown as Env["MCP_EXECUTOR"];
    const req = request("status");
    await handleChatGptRoutes(req, new URL(req.url), env, ctx);
    expect(getByName).toHaveBeenCalledWith("mcp-v1"); expect(handleChatGpt).toHaveBeenCalledWith(req);
  });
  it("任意のupstream code・本文を公開しない", () => {
    expect(chatGptUpstreamCode({ error: { code: "secret" } })).toBe("upstream_error");
    expect(chatGptUpstreamCode(null)).toBe("upstream_error");
  });
});

describe("保存した資格情報と個人領域の束縛", () => {
  it("signed IDの表示情報と実ownerを使い、転送された所有者・アカウント情報を信用しない", async () => {
    const { env } = await setup();
    await importChatGptSession(env, { ...credentials({}, { email: "owner@example.test", name: "所有者" }),
      owner_workspace_id: "member-personal", account: { email: "forged@example.test" } });
    const status = await chatGptSessionStatus(env);
    expect(status.owner_workspace_id).toBe(env.CHATGPT_OWNER_WORKSPACE_ID);
    expect(status.account).toEqual({ client_id: clientId, subject, email: "owner@example.test", name: "所有者" });
    expect(JSON.stringify(status)).not.toContain("token");
  });
  it("別Workerのhostを保存せず、登録と切断でWorkerのhostを変えない", async () => {
    const { env, db } = await setup({}, url => url.endsWith("/openid-configuration")
      ? Response.json({ revocation_endpoint: `${issuer}/oauth/revoke` }) : new Response(null, { status: 200 }));
    const before = await db.db.prepare("SELECT revision FROM chatgpt_session").first();
    await expect(importChatGptSession(env, { ...credentials(), ext_agent_host_id: "urn:uuid:other-worker" })).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(await db.db.prepare("SELECT revision FROM chatgpt_session").first()).toEqual(before);
    await disconnectChatGptSession(env);
    expect((await chatGptSessionStatus(env)).host_id).toBe("urn:uuid:opaque-host");
    await importChatGptSession(env, credentials());
    expect((await chatGptSessionStatus(env)).host_id).toBe("urn:uuid:opaque-host");
  });
  it("設定をmemberの個人領域へ誤設定しても、保存済みのowner束縛で更新・推論の前に拒否する", async () => {
    const { env, fetch } = await setup({ exp: Math.floor(Date.now() / 1000) + 10 });
    fetch.mockClear();
    await expect(runChatGptGeneration({ ...env, CHATGPT_OWNER_WORKSPACE_ID: "member-personal", CHATGPT_WORKSPACE_ID: "member-personal" }, "classify", "合成入力", 64))
      .rejects.toMatchObject({ code: "personal_scope_required" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await chatGptSessionStatus(env)).state).toBe("ready");
  });
  it("切断対象が別registrationなら失効・保存変更を行わない", async () => {
    const { env, db, fetch } = await setup(); fetch.mockClear();
    const before = await db.db.prepare("SELECT cipher, revision, state FROM chatgpt_session").first();
    await expect(disconnectChatGptSession(env, "oaiapp_other_account")).rejects.toMatchObject({ code: "session_changed" });
    expect(await db.db.prepare("SELECT cipher, revision, state FROM chatgpt_session").first()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("古い束縛のない暗号文は通常生成に使えず、再認証後に使える", async () => {
    const { env, db, fetch } = await setup();
    const row = await env.DB.prepare("SELECT cipher FROM chatgpt_session").first<{ cipher: string }>();
    const [, iv, cipher] = row!.cipher.split(".");
    const rawKey = Uint8Array.from(Buffer.from(env.CHATGPT_CREDENTIAL_KEY!, "base64"));
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt", "encrypt"]);
    const aad = new TextEncoder().encode("second-brain-cf:chatgpt-session:v1");
    const legacy = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(Buffer.from(iv, "base64")), additionalData: aad }, key, Uint8Array.from(Buffer.from(cipher, "base64")))));
    delete legacy.owner_workspace_id; delete legacy.account;
    const nextIv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nextIv, additionalData: aad }, key, new TextEncoder().encode(JSON.stringify(legacy)));
    await db.db.prepare("UPDATE chatgpt_session SET cipher = ?").bind(`v1.${Buffer.from(nextIv).toString("base64")}.${Buffer.from(bytes).toString("base64")}`).run();
    fetch.mockClear();
    await expect(runChatGptGeneration(env, "classify", "合成入力", 64)).rejects.toMatchObject({ code: "personal_scope_required" });
    expect(fetch).not.toHaveBeenCalled();
    const fresh = credentials();
    await importChatGptSession(env, fresh);
    expect(await chatGptAccessToken(env, env.CHATGPT_OWNER_WORKSPACE_ID)).toBe(fresh.access_token);
  });
});
