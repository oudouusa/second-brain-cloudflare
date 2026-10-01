import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer } from "../../src/mcp/server";
import * as serverModule from "../../src/mcp/server";
import { createApiHandler } from "../../src/mcp/handler";
import { makeMemoryKV, makeTestDb, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";
import { setMemoryWriteLock } from "../../src/migration/write-lock";
import { resetDatabaseInit } from "../../src/db/init";

vi.mock("@modelcontextprotocol/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@modelcontextprotocol/server")>(),
  createMcpHandler: vi.fn(),
}));

vi.mock("../../src/mcp/server", () => ({
  buildMcpServer: vi.fn(() => ({})),
}));

vi.mock("../../src/mcp/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mcp/server")>();
  return { ...actual, buildMcpServer: vi.fn(actual.buildMcpServer) };
});

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

function mcpPost(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token", ...headers },
    body: JSON.stringify(body),
  });
}

function mcpHandlerWithFetch(fetch: ReturnType<typeof vi.fn>) {
  return {
    fetch,
    close: vi.fn(),
    notify: {},
    bus: {},
  } as never;
}

describe("MCP HTTP handler (/mcp)", () => {
  let env: Env;
  let handler: ReturnType<typeof createApiHandler>;

  beforeEach(() => {
    env = makeTestEnv();
    handler = createApiHandler();
    vi.mocked(buildMcpServer).mockReset().mockReturnValue({} as never);
    vi.mocked(createMcpHandler).mockImplementation((factory) => mcpHandlerWithFetch(vi.fn(async () => {
      await factory({} as never);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "remember", description: "Store", inputSchema: {}, execution: { taskSupport: "optional" } },
            { name: "recall", description: "Search", inputSchema: {}, execution: { taskSupport: "optional" } },
          ],
        },
      }), { headers: { "content-type": "application/json" } });
    })));
  });

  it("tools/list strips execution metadata from the handler response", async () => {
    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);

    const payload = await res.json() as { result: { tools: { name: string; execution?: unknown }[] } };
    const names = payload.result.tools.map((t) => t.name);
    expect(names).toContain("remember");
    expect(names).toContain("recall");
    for (const tool of payload.result.tools) {
      expect(tool).not.toHaveProperty("execution");
    }
  });

  it("rejects an MCP request without a bearer or verified OAuth identity", async () => {
    const downstream = vi.fn();
    vi.mocked(createMcpHandler).mockReturnValue(mcpHandlerWithFetch(downstream));
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    const res = await handler.fetch(request, env, ctx);

    expect(res.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("passes the resolved bearer identity into the tenant-aware MCP server", async () => {
    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const identity = vi.mocked(buildMcpServer).mock.calls[0]?.[2];
    expect(identity).toMatchObject({ role: "admin" });
    expect(identity?.personalWorkspaceId).toEqual(expect.any(String));
  });

  it("resolves an owner identity supplied by a verified OAuth or Access context", async () => {
    resetDatabaseInit();
    const sqlite = makeSqliteD1();
    const sqliteEnv = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: makeMemoryKV(),
    });
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const ownerCtx = {
      waitUntil: (_: Promise<unknown>) => {},
      props: { userId: "owner" },
    } as unknown as ExecutionContext;

    try {
      const res = await handler.fetch(request, sqliteEnv, ownerCtx);

      expect(res.status).toBe(200);
      const identity = vi.mocked(buildMcpServer).mock.calls[0]?.[2];
      expect(identity).toMatchObject({ role: "admin" });
      expect(identity?.personalWorkspaceId).toEqual(expect.any(String));
    } finally {
      sqlite.close();
    }
  });

  it.each([
    { method: "tools/list", params: {} },
    { method: "tools/call", params: { name: "get", arguments: { id: "e-1" } } },
    { method: "tools/call", params: { name: "list_recent", arguments: {} } },
    { method: "tools/call", params: { name: "get_hot_context", arguments: {} } },
    { method: "tools/call", params: { name: "get_prompt_capsule", arguments: {} } },
    { method: "tools/call", params: { name: "connections", arguments: { id: "e-1" } } },
    { method: "tools/call", params: { name: "history", arguments: { id: "e-1" } } },
    { method: "tools/call", params: { name: "list_teams", arguments: {} } },
    { method: "tools/call", params: { name: "list_projects", arguments: {} } },
  ])("allows protocol and pure-read requests while maintenance is locked", async ({ method, params }) => {
    await setMemoryWriteLock(env);

    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 1, method, params }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
  });

  it.each(["recall", "remember", "append", "rollover", "update", "set_status", "share",
    "set_memory_tier", "pin_memory", "unpin_memory", "forget", "link", "unlink", "future_mutation"])(
    "blocks %s while maintenance is locked",
    async (name) => {
      await setMemoryWriteLock(env);

      const res = await handler.fetch(
        mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
        env,
        ctx,
      );

      expect(res.status).toBe(423);
    },
  );

  it("実SDKの履歴・チーム一覧が保守ロック中も応答し、書込admissionを取得しない", async () => {
    const sdk = await vi.importActual<typeof import("@modelcontextprotocol/server")>("@modelcontextprotocol/server");
    const server = await vi.importActual<typeof import("../../src/mcp/server")>("../../src/mcp/server");
    vi.mocked(createMcpHandler).mockImplementation(sdk.createMcpHandler);
    vi.mocked(buildMcpServer).mockImplementation(server.buildMcpServer);
    resetDatabaseInit();
    const sqlite = makeSqliteD1();
    const sqliteEnv = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });
    try {
      sqlite.seed({ id: "current", content: "synthetic memory", createdAt: 1000 });
      // 認証bootstrapは書込を伴うため、保守開始前に完了させる。
      const ready = await handler.fetch(mcpPost({ jsonrpc: "2.0", id: 18, method: "tools/list", params: {} }), sqliteEnv, ctx);
      await ready.text();
      await setMemoryWriteLock(sqliteEnv);
      sqlite.issued.length = 0;
      for (const name of ["history", "list_teams"]) {
        const request = mcpPost({ jsonrpc: "2.0", id: 19, method: "tools/call",
          params: { name, arguments: name === "history" ? { id: "current" } : {} } });
        request.headers.set("Accept", "application/json, text/event-stream");
        const response = await handler.fetch(request, sqliteEnv, ctx);
        expect(response.status).toBe(200);
        const body = await response.text();
        const payload = response.headers.get("content-type")?.includes("text/event-stream")
          ? body.split("\n").find(line => line.startsWith("data: "))!.slice(6) : body;
        const result = JSON.parse(payload);
        expect(result.error).toBeUndefined();
        expect(result.result.isError).not.toBe(true);
        expect(result.result.content[0].text).toContain(name === "history" ? "History for current" : "team");
      }
      expect(sqlite.issued.filter(sql => /INSERT.*memory_write_admissions/is.test(sql))).toEqual([]);
    } finally {
      sqlite.close();
      resetDatabaseInit();
    }
  });

  it("blocks a mixed JSON-RPC batch when any tool mutates", async () => {
    await setMemoryWriteLock(env);

    const res = await handler.fetch(mcpPost([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get", arguments: { id: "e-1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remember", arguments: {} } },
    ]), env, ctx);

    expect(res.status).toBe(423);
  });

  it("materializes non-tools/list responses before releasing write admission", async () => {
    const downstream = new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }), {
      headers: { "content-type": "application/json" },
    });
    vi.mocked(createMcpHandler).mockReturnValue(mcpHandlerWithFetch(vi.fn(() => Promise.resolve(downstream))));

    const res = await handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }),
      env,
      ctx,
    );
    expect(res).not.toBe(downstream);
    expect(res.status).toBe(downstream.status);
    expect(res.headers.get("content-type")).toBe("application/json");
    await expect(res.json()).resolves.toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    expect(vi.mocked(createMcpHandler).mock.calls[0]?.[1]).toEqual({
      legacy: "stateless",
      responseMode: "json",
      keepAliveMs: 0,
      maxSubscriptions: 0,
    });
  });

  it("実SDKでも購読要求は有限JSONで閉じ、ページ用SSEを常設しない", async () => {
    const sdk = await vi.importActual<typeof import("@modelcontextprotocol/server")>("@modelcontextprotocol/server");
    vi.mocked(createMcpHandler).mockImplementation(sdk.createMcpHandler);
    vi.mocked(buildMcpServer).mockImplementation(() => new sdk.McpServer({ name: "test", version: "1" }));
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      signal: AbortSignal.timeout(1500),
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", "mcp-method": "subscriptions/listen" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 17, method: "subscriptions/listen", params: {
        notifications: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      } }),
    });
    const response = await handler.fetch(request, env, ctx);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ id: 17, error: { code: -32603, message: "Subscription limit reached" } });
  });

  it("実SDKのGETは405で閉じ、通常tools/listは引き続き応答する", async () => {
    const sdk = await vi.importActual<typeof import("@modelcontextprotocol/server")>("@modelcontextprotocol/server");
    vi.mocked(createMcpHandler).mockImplementation(sdk.createMcpHandler);
    vi.mocked(buildMcpServer).mockImplementation(() => {
      const server = new sdk.McpServer({ name: "test", version: "1" });
      server.registerTool("ping", { description: "test", inputSchema: {} }, async () => ({ content: [] }));
      return server;
    });
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      headers: { Authorization: "Bearer test-token", Accept: "text/event-stream" },
      signal: AbortSignal.timeout(1500),
    }), env, ctx);
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "Method not allowed." } });
    const list = mcpPost({ jsonrpc: "2.0", id: 18, method: "tools/list", params: {} });
    list.headers.set("Accept", "application/json, text/event-stream");
    const tools = await handler.fetch(list, env, ctx);
    expect(tools.status).toBe(200);
    expect(await tools.text()).toContain('"name":"ping"');
  });

  it("keeps a write admission until the SDK response body finishes", async () => {
    const db = makeTestDb();
    env = makeTestEnv(db);
    let releaseBody!: () => void;
    const bodyReady = new Promise<void>((resolve) => { releaseBody = resolve; });
    let pullSawAdmission = false;
    vi.mocked(createMcpHandler).mockReturnValue(mcpHandlerWithFetch(vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await bodyReady;
          pullSawAdmission = db.memoryWriteAdmissions.size === 1;
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}'));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    ))));

    let resolved = false;
    const pending = handler.fetch(
      mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: {} } }),
      env,
      ctx,
    ).then((response) => {
      resolved = true;
      return response;
    });

    await vi.waitFor(() => expect(db.memoryWriteAdmissions.size).toBe(1));
    expect(resolved).toBe(false);
    releaseBody();
    const response = await pending;

    expect(pullSawAdmission).toBe(true);
    expect(db.memoryWriteAdmissions.size).toBe(0);
    await expect(response.json()).resolves.toEqual({ jsonrpc: "2.0", id: 3, result: { ok: true } });
  });

  it("rejects a declared MCP body above 1 MiB before admission or dispatch", async () => {
    const downstream = vi.fn();
    vi.mocked(createMcpHandler).mockReturnValue(mcpHandlerWithFetch(downstream));
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(1024 * 1024 + 1) },
      body: "{}",
    });

    const res = await handler.fetch(request, env, ctx);

    expect(res.status).toBe(413);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects an unannounced MCP body above 1 MiB while streaming it", async () => {
    const downstream = vi.fn();
    vi.mocked(createMcpHandler).mockReturnValue(mcpHandlerWithFetch(downstream));
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });

    const res = await handler.fetch(request, env, ctx);

    expect(res.status).toBe(413);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("BE-5: reads ctx.props and passes {clientName, via} plus the bearer into buildMcpServer", async () => {
    const ctxWithProps = {
      waitUntil: (_: Promise<unknown>) => {},
      props: { userId: "owner", clientId: "client-1", clientName: "Cursor" },
    } as unknown as ExecutionContext;

    await handler.fetch(mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }), env, ctxWithProps);

    expect(serverModule.buildMcpServer).toHaveBeenCalledWith(
      env, ctxWithProps, expect.anything(),
      expect.objectContaining({ clientName: "Cursor" }),
      "test-token",
    );
  });

  it("BE-5: a static-token caller's props carry via: token through to buildMcpServer", async () => {
    const ctxWithProps = {
      waitUntil: (_: Promise<unknown>) => {},
      props: { userId: "owner", via: "token" },
    } as unknown as ExecutionContext;

    await handler.fetch(mcpPost({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }), env, ctxWithProps);

    expect(serverModule.buildMcpServer).toHaveBeenCalledWith(
      env, ctxWithProps, expect.anything(),
      expect.objectContaining({ via: "token" }),
      "test-token",
    );
  });

  describe("R3 (budget audit): a tool call that hit the D1 daily cap", () => {
    const READ_CAP = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
    const WRITE_CAP = "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

    function toolErrorResponse(text: string) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: 3, result: { isError: true, content: [{ type: "text", text }] },
      }), { headers: { "content-type": "application/json" } });
    }

    it("rewrites the SDK's raw D1 read-cap message to the MCP read sentence", async () => {
      vi.mocked(createMcpHandler).mockReturnValue({ fetch: () => Promise.resolve(toolErrorResponse(READ_CAP)) } as never);
      const res = await handler.fetch(
        mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recall", arguments: {} } }),
        env, ctx,
      );
      expect(res.status).toBe(200);
      const payload = await res.json() as any;
      expect(payload.result.isError).toBe(true);
      expect(payload.result.content[0].text.startsWith("Could not load memories.")).toBe(true);
      expect(payload.result.content[0].text).not.toContain("D1_ERROR");
    });

    it("rewrites the SDK's raw D1 write-cap message to the MCP write sentence", async () => {
      vi.mocked(createMcpHandler).mockReturnValue({ fetch: () => Promise.resolve(toolErrorResponse(WRITE_CAP)) } as never);
      const res = await handler.fetch(
        mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: {} } }),
        env, ctx,
      );
      const payload = await res.json() as any;
      expect(payload.result.content[0].text.startsWith("Not saved.")).toBe(true);
    });

    it("leaves an unrelated tool error untouched", async () => {
      vi.mocked(createMcpHandler).mockReturnValue({ fetch: () => Promise.resolve(toolErrorResponse("No memory found with ID: e1")) } as never);
      const res = await handler.fetch(
        mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get", arguments: { id: "e1" } } }),
        env, ctx,
      );
      const payload = await res.json() as any;
      expect(payload.result.content[0].text).toBe("No memory found with ID: e1");
    });
  });
});
