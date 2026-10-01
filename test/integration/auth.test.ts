import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { createDefaultHandler } from "../../src/routes";
import {
  augmentOAuthRegistrationRequest,
  consumeOAuthRegistrationQuota,
  isAllowedOAuthRedirectUri,
  OAUTH_REGISTRATION_DAILY_LIMIT,
} from "../../src/oauth/register";
import { authorizeErrorHtml, loginHtml } from "../../src/oauth/pages";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

const ctx = { waitUntil: (_: Promise<any>) => { } } as any;

const PROTECTED_ROUTES: Array<[string, string, unknown?]> = [
  ["POST", "/capture", { content: "hello" }],
  ["POST", "/append", { id: "abc", addition: "update" }],
  ["POST", "/rollover", { id: "abc", snapshot: "current", operation_id: "op" }],
  ["GET", "/list", undefined],
  ["GET", "/tags", undefined],
  ["POST", "/recall", { query: "test" }],
  ["POST", "/forget", { id: "abc" }],
  ["POST", "/chat", { query: "what?" }],
  ["POST", "/mcp", undefined],
];

describe("Auth", () => {
  let env: Env;
  beforeEach(() => { env = makeTestEnv(); });

  for (const [method, path, body] of PROTECTED_ROUTES) {
    it(`${method} ${path} — no token → 401`, async () => {
      const res = await worker.fetch(req(method, path, { body, token: null }), env, ctx);
      expect(res.status).toBe(401);
      const data = await res.json() as any;
      expect(data.error).toBe("Unauthorized");
    });

    it(`${method} ${path} — wrong token → 401`, async () => {
      const res = await worker.fetch(req(method, path, { body, token: "wrong-token" }), env, ctx);
      expect(res.status).toBe(401);
    });
  }

  it("rejects a valid token supplied only in the request URL", async () => {
    const request = new Request("http://localhost/health?token=test-token");
    const res = await worker.fetch(request, env, ctx);

    expect(res.status).toBe(401);
  });

  it("rejects a client-forged internal verification marker", async () => {
    const request = new Request("http://localhost/health", {
      headers: { "X-Second-Brain-Auth-Verified": "1" },
    });
    const res = await worker.fetch(request, env, ctx);

    expect(res.status).toBe(401);
  });

  it("fails closed when an Access-marked MCP request lacks Access bindings", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": "not-a-jwt",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    const res = await worker.fetch(request, env, ctx);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "Cloudflare Access authentication failed",
    });
  });

  it("advertises DCR without advertising CIMD pending upstream adoption", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/.well-known/oauth-authorization-server"),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      registration_endpoint: "http://localhost/oauth/register",
      client_id_metadata_document_supported: false,
    });
  });

  it("does not create a D1 write admission before authentication succeeds", async () => {
    const db = new D1Mock();
    env = makeTestEnv(db);
    const prepare = vi.spyOn(env.DB, "prepare");
    const batch = vi.spyOn(env.DB, "batch");
    for (const [path, method, body] of [
      ["/capture", "POST", { content: "unauthorized" }],
      ["/digest", "POST", { tag: "private" }],
      ["/export", "GET", undefined],
      ["/migration/reembed", "POST", {}],
    ] as const) {
      const res = await worker.fetch(req(method, path, { body, token: null }), env, ctx);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(db.memoryWriteAdmissions.size, `${method} ${path}`).toBe(0);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("answers OPTIONS without authentication or storage access", async () => {
    const db = new D1Mock();
    env = makeTestEnv(db);
    const prepare = vi.spyOn(env.DB, "prepare");
    const kvGet = vi.spyOn(env.OAUTH_KV, "get");

    const res = await createDefaultHandler().fetch(req("OPTIONS", "/capture", { token: null }), env, ctx);

    expect(res.status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("rejects an oversized OAuth registration before provider dispatch", async () => {
    const request = new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["x".repeat(65 * 1024)] }),
    });

    const result = await augmentOAuthRegistrationRequest(request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("rejects an attacker-controlled hosted OAuth redirect instead of augmenting it", async () => {
    const request = new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://attacker.example/callback"] }),
    });

    const result = await augmentOAuthRegistrationRequest(request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    await expect((result as Response).json()).resolves.toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("accepts only known native callbacks and explicit-port loopback callbacks", async () => {
    expect(isAllowedOAuthRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(isAllowedOAuthRedirectUri("http://127.0.0.1:49152/oauth/callback")).toBe(true);
    expect(isAllowedOAuthRedirectUri("http://localhost/oauth/callback")).toBe(false);
    expect(isAllowedOAuthRedirectUri("https://localhost:49152/oauth/callback")).toBe(false);

    const request = new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:49152/oauth/callback"] }),
    });
    const result = await augmentOAuthRegistrationRequest(request);
    expect(result).toBeInstanceOf(Request);
    await expect((result as Request).json()).resolves.toMatchObject({
      redirect_uris: ["http://127.0.0.1:49152/oauth/callback"],
    });
  });

  it("escapes OAuth client, redirect, and provider error text in HTML", () => {
    const login = loginHtml("bad <token>", {
      clientId: "<img src=x onerror=alert(1)>",
      redirectUri: "https://example.com/callback",
    });
    const error = authorizeErrorHtml("bad <hint>", "bad <detail>");

    expect(login).not.toContain("<img src=x");
    expect(login).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(login).toContain("https://example.com");
    expect(error).toContain("bad &lt;hint&gt;");
    expect(error).toContain("bad &lt;detail&gt;");
  });

  it("caps accepted dynamic client registrations before they can exhaust OAuth KV writes", async () => {
    const sqlite = makeSqliteD1();
    const quotaEnv = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });
    const now = Date.UTC(2026, 7, 27, 12);
    for (let i = 0; i < OAUTH_REGISTRATION_DAILY_LIMIT; i++) {
      await expect(consumeOAuthRegistrationQuota(quotaEnv, now)).resolves.toBeNull();
    }

    const blocked = await consumeOAuthRegistrationQuota(quotaEnv, now);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBe("43200");
    await expect(consumeOAuthRegistrationQuota(quotaEnv, now + 86_400_000)).resolves.toBeNull();
  });

  it("rejects an oversized OAuth authorization form before checking its password", async () => {
    env = makeTestEnv();
    const parseAuthRequest = vi.fn().mockResolvedValue({ scope: ["read"] });
    (env as Env & { OAUTH_PROVIDER: unknown }).OAUTH_PROVIDER = { parseAuthRequest };
    const request = new Request("http://localhost/oauth/authorize?client_id=test", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "x".repeat(9 * 1024) }),
    });

    const res = await createDefaultHandler().fetch(request, env, ctx);

    expect(res.status).toBe(413);
    expect(parseAuthRequest).toHaveBeenCalledOnce();
  });

  it("binds the OAuth approval form to a short-lived CSRF cookie", async () => {
    (env as Env & { OAUTH_PROVIDER: unknown }).OAUTH_PROVIDER = {
      parseAuthRequest: vi.fn().mockResolvedValue({
      clientId: "dashboard-client",
      redirectUri: "https://second-brain.example/",
      scope: [],
      }),
    };
    const url = "https://second-brain.example/oauth/authorize?client_id=dashboard-client";

    const login = await createDefaultHandler().fetch(new Request(url), env, ctx);
    expect(login.status).toBe(200);
    expect(login.headers.get("Cache-Control")).toBe("no-store");
    expect(login.headers.get("X-Frame-Options")).toBe("DENY");
    const cookie = login.headers.get("Set-Cookie")!;
    const token = (await login.text()).match(/name="csrf_token" value="([a-f0-9-]+)"/)?.[1];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(token).toBeTruthy();

    const missingCsrf = await createDefaultHandler().fetch(new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-token" }),
    }), env, ctx);
    expect(missingCsrf.status).toBe(403);
  });

  it("rejects an oversized chunked OAuth token body before provider storage", async () => {
    const kv = makeMemoryKV();
    const get = vi.spyOn(kv, "get");
    env = makeTestEnv(undefined, { OAUTH_KV: kv });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65 * 1024));
        controller.close();
      },
    });
    const request = new Request("http://localhost/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const res = await worker.fetch(request, env, ctx);

    expect(res.status).toBe(413);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("OAuth sign-in page", () => {
  it("serves same-origin fonts and brand assets only, never a CDN", async () => {
    const res = await worker.fetch(new Request("http://localhost/oauth/authorize"), makeTestEnv(), ctx);
    const html = await res.text();
    expect(html).not.toMatch(/fonts\.googleapis/);
    expect(html).not.toMatch(/cdn\./);
    expect(html).toContain("/fonts/");
    expect(html).toContain("/brand-lockup.png");
  });
});
