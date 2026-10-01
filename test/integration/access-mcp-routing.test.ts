import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const mocks = vi.hoisted(() => ({
  mcpFetch: vi.fn(),
  seenMcpUserIds: [] as (string | undefined)[],
}));

vi.mock("../../src/mcp/handler", () => ({
  apiHandler: { fetch: mocks.mcpFetch },
}));

import worker from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
const issuer = "https://second-brain-test.cloudflareaccess.com", audience = "access-audience", dashboardAudience = "dashboard-audience", owner = "owner@example.com";
const bindings = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, DASHBOARD_ACCESS_AUD: dashboardAudience, ACCESS_ALLOWED_EMAIL: owner };
let privateKey: CryptoKey;

async function accessToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", kid: "access-test-key" })}.${encode({
    iss: issuer, aud: audience, email: owner, sub: "owner-subject", type: "app",
    exp: now + 300, nbf: now - 1,
    ...overrides,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}

const dashboardAccessToken = () => accessToken({ aud: dashboardAudience });

function accessMcpRequest(assertion: string): Request {
  return new Request("https://brain.example/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer opaque-access-token", "Cf-Access-Jwt-Assertion": assertion,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

function managedOAuthMcpRequest(path = "/oauth-mcp"): Request {
  return new Request(`https://brain.example${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

function accessDashboardRequest(path: string, assertion: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("X-Second-Brain-Dashboard", "1");
  headers.set("Cf-Access-Jwt-Assertion", assertion);
  return new Request(`https://brain.example${path}`, { ...init, headers });
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ["sign", "verify"]) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const publicJwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey),
    alg: "RS256", kid: "access-test-key", use: "sig" };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [publicJwk] })));
});

afterAll(() => vi.unstubAllGlobals());

describe("Cloudflare Access MCP routing", () => {
  beforeEach(() => {
    mocks.seenMcpUserIds.length = 0;
    mocks.mcpFetch.mockReset();
    mocks.mcpFetch.mockImplementation((_request, _env, routedCtx: ExecutionContext & { props?: { userId?: string } }) => {
      mocks.seenMcpUserIds.push(routedCtx.props?.userId);
      return Promise.resolve(Response.json({ ok: true }));
    });
  });

  it.each(["declared", "stream", "read-error", "invalid-json"])("不正なJWKS本文を拒否する: %s", async mode => {
    // issuerを分け、他の試験で取得済みの鍵cacheを利用しない。
    const testIssuer = `https://${mode}.cloudflareaccess.com`;
    const response = mode === "declared"
      ? new Response("{}", { headers: { "Content-Length": String(64 * 1024 + 1) } })
      : mode === "stream"
        ? new Response("x".repeat(64 * 1024 + 1))
        : mode === "read-error"
          ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("read failed")); } }))
          : new Response("invalid json");
    vi.mocked(fetch).mockResolvedValueOnce(response);
    const result = await worker.fetch(
      accessMcpRequest(await accessToken({ iss: testIssuer })),
      makeTestEnv(undefined, { ...bindings, ACCESS_TEAM_DOMAIN: testIssuer }), ctx,
    );
    expect(result.status).toBe(403);
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
  });

  it("routes a verified Access request directly to MCP without forwarding credentials", async () => {
    const response = await worker.fetch(
      accessMcpRequest(await accessToken()), makeTestEnv(undefined, bindings), ctx,
    );

    expect(response.status).toBe(200);
    expect(mocks.mcpFetch).toHaveBeenCalledOnce();
    const routed = mocks.mcpFetch.mock.calls[0][0] as Request;
    expect([routed.headers.get("Authorization"), routed.headers.get("Cf-Access-Jwt-Assertion")]).toEqual([null, null]);
    expect(mocks.seenMcpUserIds).toEqual(["owner"]);
    await expect(routed.json()).resolves.toMatchObject({ method: "tools/list" });
  });

  it("keeps Managed OAuth on an Access-independent path and aliases direct legacy MCP requests", async () => {
    const env = makeTestEnv(undefined, bindings);

    expect((await worker.fetch(managedOAuthMcpRequest(), env, ctx)).status).toBe(200);
    expect((mocks.mcpFetch.mock.calls.at(-1)?.[0] as Request).url).toBe("https://brain.example/mcp");

    expect((await worker.fetch(managedOAuthMcpRequest("/mcp"), env, ctx)).status).toBe(200);
    expect((mocks.mcpFetch.mock.calls.at(-1)?.[0] as Request).url).toBe("https://brain.example/mcp");
    expect(mocks.seenMcpUserIds.slice(-2)).toEqual([undefined, undefined]);
  });

  it("challenges an unauthenticated Managed OAuth request without an Access redirect", async () => {
    const response = await worker.fetch(new Request("https://brain.example/oauth-mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), makeTestEnv(undefined, bindings), ctx);

    expect(response.status).toBe(401);
    expect(response.headers.get("Location")).toBeNull();
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
  });

  it("redirects the public root to the Access-protected dashboard path", async () => {
    const response = await worker.fetch(
      new Request("https://brain.example/"), makeTestEnv(undefined, bindings), ctx,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://brain.example/dashboard");
    expect(response.headers.get("Set-Cookie")).toContain("CF_Authorization=;");
  });

  it("serves dashboard HTML only after verifying the same Access application token", async () => {
    const assetFetch = vi.fn().mockResolvedValue(new Response("<h1>dashboard</h1>", {
      headers: { "Content-Type": "text/html" },
    }));
    const env = makeTestEnv(undefined, { ...bindings, ASSETS: { fetch: assetFetch } as unknown as Fetcher });

    const response = await worker.fetch(
      accessDashboardRequest("/dashboard", await dashboardAccessToken()), env, ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await response.text()).toContain("dashboard");
    expect(assetFetch).toHaveBeenCalledOnce();
    expect(new URL((assetFetch.mock.calls[0][0] as Request).url).pathname).toBe("/");
  });

  it("rejects dashboard API requests without both Access identity and the CSRF marker", async () => {
    const assertion = await dashboardAccessToken();
    const missingAccess = new Request("https://brain.example/dashboard/api/count", {
      headers: { "X-Second-Brain-Dashboard": "1" },
    });
    expect((await worker.fetch(missingAccess, makeTestEnv(undefined, bindings), ctx)).status).toBe(403);

    const missingMarker = new Request("https://brain.example/dashboard/api/count", {
      headers: { "Cf-Access-Jwt-Assertion": assertion },
    });
    expect((await worker.fetch(missingMarker, makeTestEnv(undefined, bindings), ctx)).status).toBe(403);
  });

  it("routes a verified dashboard session to existing REST and MCP handlers", async () => {
    const assertion = await dashboardAccessToken();
    const env = makeTestEnv(undefined, bindings);
    const count = await worker.fetch(
      accessDashboardRequest("/dashboard/api/count", assertion), env, ctx,
    );
    expect(count.status).toBe(200);
    await expect(count.json()).resolves.toMatchObject({ count: 0 });

    const mcp = await worker.fetch(accessDashboardRequest("/dashboard/api/mcp", assertion, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://brain.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), env, ctx);
    expect(mcp.status).toBe(200);
    const routed = mocks.mcpFetch.mock.calls.at(-1)?.[0] as Request;
    expect(routed.url).toBe("https://brain.example/mcp");
    expect(mocks.seenMcpUserIds.at(-1)).toBe("owner");
    expect([
      routed.headers.get("Authorization"), routed.headers.get("Cf-Access-Jwt-Assertion"),
      routed.headers.get("Cookie"), routed.headers.get("X-Second-Brain-Dashboard"),
    ]).toEqual([null, null, null, null]);
  });

  it.each(["activity", "recalled", "night"])("protects /stats/%s through the Access dashboard boundary", async kind => {
    const path = `/dashboard/api/stats/${kind}`;
    const env = makeTestEnv(undefined, bindings);
    const assertion = await dashboardAccessToken();
    const accepted = await worker.fetch(accessDashboardRequest(path, assertion), env, ctx);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true });
    const noAccess = new Request(`https://brain.example${path}`, {
      headers: { "X-Second-Brain-Dashboard": "1", Authorization: "Bearer test-token" },
    });
    expect((await worker.fetch(noAccess, env, ctx)).status).toBe(403);
    const noMarker = new Request(`https://brain.example${path}`, {
      headers: { "Cf-Access-Jwt-Assertion": assertion },
    });
    expect((await worker.fetch(noMarker, env, ctx)).status).toBe(403);
    const crossSite = accessDashboardRequest(path, assertion, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect((await worker.fetch(crossSite, env, ctx)).status).toBe(403);
    const wrongAudience = accessDashboardRequest(path, await accessToken());
    expect((await worker.fetch(wrongAudience, env, ctx)).status).toBe(403);
  });

  it("rejects cross-site dashboard mutations before dispatch", async () => {
    const response = await worker.fetch(accessDashboardRequest("/dashboard/api/mcp", await dashboardAccessToken(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), makeTestEnv(undefined, bindings), ctx);

    expect(response.status).toBe(403);
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
  });

  it("keeps Access authentication out of Authorization and adds only the dashboard CSRF header", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const removed: string[] = [];
    const storage = { removeItem: (key: string) => removed.push(key) };
    const location = {
      pathname: "/dashboard", origin: "https://brain.example",
      href: "https://brain.example/dashboard", assign: vi.fn(),
    };
    const sandbox: Record<string, unknown> = {
      window: { location, fetch: nativeFetch }, location,
      localStorage: storage, sessionStorage: storage,
      URL, Request, Headers, Response,
      WORKER_URL: "", AUTH_TOKEN: "",
    };
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(resolve(import.meta.dirname, "../../public/js/auth.js"), "utf8"), sandbox);

    expect((sandbox.activateAccessDashboard as () => boolean)()).toBe(true);
    await (sandbox.window as { fetch: typeof fetch }).fetch("https://brain.example/dashboard/api/count", {
      headers: { Authorization: "Bearer cloudflare-access", Accept: "application/json" },
    });

    const init = nativeFetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Second-Brain-Dashboard")).toBe("1");
    expect(removed).toContain("sb_token");
  });

  it.each([
    ["another user", { email: "other@example.com" }], ["another audience", { aud: "wrong-audience" }],
    ["an expired token", { exp: 1 }],
  ])("does not dispatch %s", async (_label, overrides) => {
    const response = await worker.fetch(
      accessMcpRequest(await accessToken(overrides)), makeTestEnv(undefined, bindings), ctx,
    );

    expect(response.status).toBe(403);
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
  });
});
