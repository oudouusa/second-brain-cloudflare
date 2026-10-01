import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, stat, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { main, paths, workerUrl } from "../../scripts/chatgpt-auth.mjs";

const origin = "https://brain.example.test", hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
const nativeFetch = globalThis.fetch;
let root: string, tokenFile: string, logs: ReturnType<typeof vi.spyOn>;
let pair: { publicKey: KeyObject; privateKey: KeyObject }, jwk: object;
beforeAll(() => { pair = generateKeyPairSync("rsa", { modulusLength: 2048 }); jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "cli-key" }; });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sb-chatgpt-cli-"));
  tokenFile = join(root, "owner-token");
  await writeFile(tokenFile, "private-owner-fixture", { mode: 0o600 });
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
const options = (profile = "default", url = origin) => ({ "worker-url": url, "auth-token-file": tokenFile, "config-dir": root, profile });
const args = (command: string, profile = "default") => [command, "--worker-url", origin, "--auth-token-file", tokenFile, "--config-dir", root, "--profile", profile];
async function registration(value: object, profile = "default") {
  const p = paths(options(profile)); await mkdir(p.dir, { recursive: true, mode: 0o700 });
  await writeFile(p.registration, JSON.stringify(value), { mode: 0o600 }); return p;
}
function jwt(client: string, nonce: string, sub = "cli-subject") {
  const now = Math.floor(Date.now() / 1000);
  const body = [Buffer.from(JSON.stringify({ alg: "RS256", kid: "cli-key" })).toString("base64url"),
    Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: client, sub, nonce, exp: now + 3600, iat: now, email: "same@example.test", name: "所有者" })).toString("base64url")].join(".");
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), pair.privateKey).toString("base64url")}`;
}
async function startLogin({ profile = "default", client = "oaiapp_cli", granted = true, exchangeError = false, sub = "cli-subject", consent = false } = {}) {
  let authorize: URL;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
    if (url.origin === origin) return Response.json({ ok: true, connected: false, state: "disconnected", host_id: hostId });
    if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [jwk] });
    if (url.pathname === "/api/accounts/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe(client);
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(authorize.searchParams.get("code_challenge"));
      if (exchangeError) return Response.json({ error: "private-diagnostic" }, { status: 400 });
      return Response.json({ id_token: jwt(client, authorize.searchParams.get("nonce")!, sub), access_token: "private-access-fixture",
        refresh_token: "private-refresh-fixture", token_type: "Bearer", expires_in: 3600,
        scope: granted ? "openid offline_access resource.invoke chatgpt.tokens.use.direct" : "openid profile email" });
    }
    throw new Error("予期しない外部接続");
  });
  vi.stubGlobal("fetch", fetcher);
  const firstLog = logs.mock.calls.length;
  const pending = main([...args("login", profile), "--port", "0", ...(consent ? ["--consent"] : [])]);
  const outcome = pending.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  await vi.waitFor(() => expect(logs.mock.calls.length).toBeGreaterThan(firstLog));
  const local = String(logs.mock.calls[firstLog][0]).match(/http:\/\/127\.0\.0\.1:\d+\/auth\/start\/\S+/)![0];
  const page = await (await nativeFetch(local)).text();
  authorize = new URL(page.match(/href="(https:\/\/auth\.openai\.com[^" ]+)"/)![1].replaceAll("&amp;", "&"));
  const callback = new URL(authorize.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "one-time-code", client_id: client }).toString();
  return { fetcher, authorize, local, page, callback, outcome };
}

describe("所有者CLIの導入・登録・操作境界", () => {
  it.each([undefined, "http://brain.example.test", "https://user:secret@brain.example.test", `${origin}/path`, `${origin}/?token=secret`, `${origin}/#secret`])("明示的なHTTPS originだけを接続先にする: %s", url => {
    expect(() => workerUrl({ "worker-url": url })).toThrow();
  });
  it("同じemailでもWorkerとprofileの保存領域を分離し、一覧に秘密を出さない", async () => {
    const one = await registration({ client_id: "oaiapp_one", email: "same@example.test", id_token_hint: "private-id-hint" }, "one");
    const two = await registration({ client_id: "oaiapp_two", email: "same@example.test", id_token_hint: "private-id-hint-2" }, "two");
    expect(one.dir).not.toBe(two.dir); expect(one.dir).not.toBe(paths(options("one", "https://other.example.test")).dir);
    await main(args("profiles"));
    expect(JSON.parse(String(logs.mock.calls.at(-1)![0])).profiles.map((p: { client_id: string }) => p.client_id)).toEqual(["oaiapp_one", "oaiapp_two"]);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private-id-hint");
    expect(() => paths(options("../escape"))).toThrow();
  });
  it("初回のstate/nonce/PKCE・issued client保存・Worker host・0600を確認する", async () => {
    const login = await startLogin();
    expect(login.authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(login.authorize.searchParams.get("ext_agent_host_id")).toBe(hostId);
    const wrong = new URL(login.callback); wrong.searchParams.set("state", "incorrect");
    expect((await nativeFetch(wrong)).status).toBe(400);
    expect((await nativeFetch(login.callback)).status).toBe(200);
    expect(await login.outcome).toEqual({ ok: true });
    const p = paths(options()); const saved = JSON.parse(await readFile(p.credentials, "utf8"));
    expect(saved).toMatchObject({ client_id: "oaiapp_cli", worker_origin: origin, ext_agent_host_id: hostId });
    expect(JSON.parse(await readFile(p.registration, "utf8"))).toMatchObject({ client_id: "oaiapp_cli", subject: "cli-subject" });
    if (process.platform !== "win32") expect((await stat(p.credentials)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private-access|private-refresh|id_token_hint/);
  });
  it("再認証はissued clientと署名済みsubjectを保持し、ID hint入りURLを端末へ表示しない", async () => {
    await registration({ client_id: "oaiapp_cli", subject: "cli-subject", email: "same@example.test", id_token_hint: "private-retained-id" });
    const login = await startLogin({ consent: true });
    expect(login.authorize.searchParams.get("client_id")).toBe("oaiapp_cli");
    expect(login.authorize.searchParams.get("id_token_hint")).toBe("private-retained-id");
    expect(login.authorize.searchParams.get("prompt")).toBe("consent");
    expect(login.page).toContain("Continue with ChatGPT");
    expect(login.page).toContain('lang="en"');
    expect(login.page).toContain("Team and member operations are excluded.");
    expect(login.page).toContain("Manage usage");
    await nativeFetch(login.callback); expect(await login.outcome).toEqual({ ok: true });
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private-retained-id");
    expect(JSON.stringify(logs.mock.calls)).not.toContain("https://auth.openai.com");
  });
  it("同じprofileの並行認証を拒否し、成功後は操作lockを解放する", async () => {
    const login = await startLogin();
    await expect(main([...args("login"), "--port", "0"])).rejects.toThrow("profile is busy");
    await nativeFetch(login.callback); expect(await login.outcome).toEqual({ ok: true });
    await expect(access(join(paths(options()).dir, "operation.lock"))).rejects.toThrow();
  });
  it("利用権限なしでも登録したidentityを保持し、推論資格情報は作らない", async () => {
    const login = await startLogin({ granted: false }); await nativeFetch(login.callback);
    expect((await login.outcome).ok).toBe(false);
    const p = paths(options());
    expect(JSON.parse(await readFile(p.registration, "utf8"))).toMatchObject({ client_id: "oaiapp_cli", subject: "cli-subject", email: "same@example.test" });
    await expect(access(p.credentials)).rejects.toThrow();
  });
  it("交換失敗でもissued clientを再登録せず、資格情報は作らない", async () => {
    const login = await startLogin({ exchangeError: true }); await nativeFetch(login.callback);
    expect((await login.outcome).ok).toBe(false);
    const p = paths(options()); expect(JSON.parse(await readFile(p.registration, "utf8"))).toMatchObject({ client_id: "oaiapp_cli" });
    await expect(access(p.credentials)).rejects.toThrow();
  });
  it("同一registrationに別subjectが戻った場合は保存状態を上書きしない", async () => {
    const before = { client_id: "oaiapp_cli", subject: "original-subject", id_token_hint: "private-original-id" };
    const p = await registration(before);
    const login = await startLogin({ sub: "different-subject" }); await nativeFetch(login.callback);
    expect((await login.outcome).ok).toBe(false);
    expect(JSON.parse(await readFile(p.registration, "utf8"))).toMatchObject(before);
    await expect(access(p.credentials)).rejects.toThrow();
  });
  it("転送失敗では一時資格情報を残し、確認できた転送成功時だけ消す", async () => {
    const p = await registration({ client_id: "oaiapp_cli" });
    await writeFile(p.credentials, JSON.stringify({ client_id: "oaiapp_cli", worker_origin: origin, access_token: "private-access" }), { mode: 0o600 });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, code: "invalid_credentials" }, { status: 400 })).mockResolvedValueOnce(Response.json({ ok: true, connected: true }));
    vi.stubGlobal("fetch", fetcher);
    await expect(main(args("import"))).rejects.toThrow("invalid_credentials"); await access(p.credentials);
    await main(args("import")); await expect(access(p.credentials)).rejects.toThrow();
    expect(fetcher.mock.calls.every(call => new URL(String(call[0])).pathname === "/admin/chatgpt/session")).toBe(true);
  });
  it("別Worker向けのpendingファイルは転送しない", async () => {
    const p = await registration({}); await writeFile(p.credentials, JSON.stringify({ worker_origin: "https://other.example.test" }));
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(main(args("import"))).rejects.toThrow("destination"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("enableは有効化候補だけを示し、推論・配備・無効なmodelの選択をしない", async () => {
    const fetcher = vi.fn(async (input: string | URL, _init?: RequestInit) => Response.json(String(input).endsWith("status")
      ? { ok: true, connected: true, owner_workspace_id: "owner-personal" }
      : { ok: true, models: [{ slug: "gpt-5.6-luna" }, { slug: "gpt-5.6-terra" }, { slug: "untested-model" }] }));
    vi.stubGlobal("fetch", fetcher);
    await main(args("enable"));
    expect(JSON.parse(String(logs.mock.calls.at(-1)![0])).vars).toEqual({ CHATGPT_MODEL: "gpt-5.6-luna", CHATGPT_OPERATIONS: "answer", CHATGPT_OWNER_WORKSPACE_ID: "owner-personal" });
    await expect(main([...args("enable"), "--model", "untested-model"])).rejects.toThrow("evaluated");
    expect(fetcher.mock.calls.every(call => /\/(status|models)$/.test(String(call[0])))).toBe(true);
  });
  it("accountのcatalogに保存判断用Terraが無ければdigestを有効化できない", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => Response.json(String(input).endsWith("status")
      ? { ok: true, connected: true, owner_workspace_id: "owner-personal" } : { ok: true, models: [{ slug: "gpt-5.6-luna" }] })));
    await expect(main([...args("enable"), "--operations", "digest"])).rejects.toThrow("model");
  });
  it("別profileで接続中アカウントを切断せず、一致した切断でhintだけを消す", async () => {
    const p = await registration({ client_id: "oaiapp_cli", subject: "cli-subject", id_token_hint: "private-hint" });
    const fetcher = vi.fn(async (input: string | URL, _init?: RequestInit) => Response.json(String(input).endsWith("status")
      ? { ok: true, connected: true, state: "ready", account: { client_id: "oaiapp_other" } } : { ok: true, revoked: false }));
    vi.stubGlobal("fetch", fetcher);
    await expect(main(args("disconnect"))).rejects.toThrow("differs");
    expect(fetcher).toHaveBeenCalledOnce(); expect(JSON.parse(await readFile(p.registration, "utf8"))).toHaveProperty("id_token_hint");
    fetcher.mockImplementation(async (input: string | URL) => Response.json(String(input).endsWith("status")
      ? { ok: true, connected: true, state: "ready", account: { client_id: "oaiapp_cli" } } : { ok: true, revoked: false }));
    await main(args("disconnect"));
    expect(JSON.parse(await readFile(p.registration, "utf8"))).toEqual({ client_id: "oaiapp_cli", subject: "cli-subject" });
    expect(JSON.parse(String(logs.mock.calls.at(-1)![0])).revoked).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toEqual({ client_id: "oaiapp_cli" });
  });
  it("保護されていないowner tokenを送らず、status表示へ任意のtokenを写さない", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, account: { client_id: "safe-client", refresh_token: "private-secret" }, access_token: "private-secret" }));
    vi.stubGlobal("fetch", fetcher);
    if (process.platform !== "win32") {
      const { chmod } = await import("node:fs/promises"); await chmod(tokenFile, 0o644);
      await expect(main(args("status"))).rejects.toThrow("permissions"); expect(fetcher).not.toHaveBeenCalled(); await chmod(tokenFile, 0o600);
    }
    await main(args("status")); expect(JSON.stringify(logs.mock.calls)).not.toContain("private-secret");
  });
});
