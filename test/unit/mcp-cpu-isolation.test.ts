import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RERANK_MODEL, RERANK_READY_KV_KEY } from "../../src/constants";
import { rerankStep, resetRerankReadyMemo } from "../../src/recall/model-reranker";
import type { Env } from "../../src/env";
import { McpExecutor } from "../../src/mcp/executor";
import { apiHandler } from "../../src/mcp/handler";
import { fetchMcpApi } from "../../src/mcp/dispatch";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

vi.mock("../../src/mcp/handler", () => ({
  apiHandler: { fetch: vi.fn() },
}));

describe("MCP CPU isolation", () => {
  beforeEach(() => {
    vi.mocked(apiHandler.fetch).mockReset();
  });

  it("DOのwaitUntilがrerankerのprobeとready書込みを完了させる", async () => {
    resetRerankReadyMemo();
    const pending: Promise<unknown>[] = [];
    const env = makeTestEnv(undefined, { OAUTH_KV: makeMemoryKV() });
    const run = vi.fn(async (_model: string, input: { contexts: unknown[] }) => ({
      response: input.contexts.map((_, id) => ({ id, score: id === 1 ? 1 : 0 })),
    }));
    env.AI = { run } as unknown as Ai;
    const direct = [0, 1, 2].map(i => ({ id: `p${i}`, score: .9 - i * .01, metadata: { parentId: `p${i}` } }));
    let route: string | undefined;
    vi.mocked(apiHandler.fetch).mockImplementation(async (_req, guardedEnv, ctx) => {
      route = (await rerankStep({ mode: "auto", forced: false, env: guardedEnv, ctx,
        query: "launch planning", queryTokens: ["launch", "planning"], evidenceTokens: ["launch", "planning"],
        direct, root: direct, loadContent: async () => new Map(),
      })).route;
      return new Response("ok");
    });
    const executor = new McpExecutor({ waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as DurableObjectState, env);
    await executor.handleMcp(new Request("https://example.com/mcp"));
    await Promise.all(pending);
    expect(route).toBe("not-ready");
    expect(pending.length).toBeGreaterThan(0);
    expect(run).toHaveBeenCalledWith(RERANK_MODEL, expect.any(Object));
    expect(await env.OAUTH_KV.get(RERANK_READY_KV_KEY)).toBe("1");
    resetRerankReadyMemo();
  });

  it("ships the Durable Object binding and its SQLite-class migration together", () => {
    const raw = readFileSync(resolve(import.meta.dirname, "../../wrangler.jsonc"), "utf8");
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
      durable_objects?: { bindings?: { name: string; class_name: string }[] };
      migrations?: { tag: string; new_sqlite_classes?: string[] }[];
    };

    expect(config.durable_objects?.bindings).toContainEqual({
      name: "MCP_EXECUTOR",
      class_name: "McpExecutor",
    });
    expect(config.migrations).toContainEqual({
      tag: "v1-mcp-executor",
      new_sqlite_classes: ["McpExecutor"],
    });
  });

  it("forwards production MCP requests to the stable Durable Object shard", async () => {
    const request = new Request("https://example.com/mcp", { method: "POST", body: "{}" });
    const response = new Response("mcp");
    const handleMcp = vi.fn(async () => response);
    const getByName = vi.fn(() => ({ handleMcp }));
    const env = makeTestEnv(undefined, {
      MCP_EXECUTOR: { getByName } as unknown as Env["MCP_EXECUTOR"],
    });
    const ctx = {
      waitUntil: vi.fn(),
      props: { userId: "owner" },
    } as unknown as ExecutionContext;

    const actual = await fetchMcpApi(request, env, ctx);

    expect(actual).toBe(response);
    expect(getByName).toHaveBeenCalledWith("mcp-v1");
    expect(handleMcp).toHaveBeenCalledWith(request, "owner");
    expect(apiHandler.fetch).not.toHaveBeenCalled();
  });

  it("keeps the local fallback for tests and unbound development", async () => {
    const request = new Request("https://example.com/mcp", { method: "POST", body: "{}" });
    const response = new Response("local");
    vi.mocked(apiHandler.fetch).mockResolvedValue(response);
    const env = makeTestEnv();
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    const actual = await fetchMcpApi(request, env, ctx);

    expect(actual).toBe(response);
    expect(apiHandler.fetch).toHaveBeenCalledWith(request, env, ctx);
  });

  it("executes the full MCP handler inside the Durable Object CPU budget", async () => {
    const request = new Request("https://example.com/mcp", { method: "POST", body: "{}" });
    const response = new Response("inside-do");
    let forwardedContext: ExecutionContext | undefined;
    vi.mocked(apiHandler.fetch).mockImplementation(async (_request, _env, ctx) => {
      forwardedContext = ctx;
      return response;
    });
    const waitUntil = vi.fn();
    const env = makeTestEnv();
    const executor = new McpExecutor({ waitUntil } as unknown as DurableObjectState, env);

    const actual = await executor.handleMcp(request, "owner");

    expect(actual).toBe(response);
    expect(apiHandler.fetch).toHaveBeenCalledWith(request, env, expect.any(Object));
    expect((forwardedContext as ExecutionContext & { props?: { userId?: string } }).props)
      .toEqual({ userId: "owner" });
    const background = Promise.resolve();
    forwardedContext?.waitUntil(background);
    expect(waitUntil).toHaveBeenCalledWith(background);
  });

  it("DO 内の MCP 書込みにも FTS 修復ガードを適用する", async () => {
    const sqlite = makeSqliteD1();
    try {
      await sqlite.db.exec("DROP TABLE entries_fts");
      const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });
      vi.mocked(apiHandler.fetch).mockImplementation(async (_request, guardedEnv) => {
        await guardedEnv.DB.prepare("INSERT INTO entries (id, content, created_at) VALUES ('mcp', 'saved', 1)").run();
        return new Response("saved");
      });
      const executor = new McpExecutor({ waitUntil: vi.fn() } as unknown as DurableObjectState, env);

      const response = await executor.handleMcp(new Request("https://example.com/mcp", { method: "POST" }));

      expect(response.status).toBe(200);
      expect(sqlite.rows().map(row => row.id)).toEqual(["mcp"]);
      expect((await sqlite.db.prepare("SELECT name FROM sqlite_master WHERE name = 'entries_fts'").all()).results)
        .toEqual([{ name: "entries_fts" }]);
    } finally {
      sqlite.close();
    }
  });
});
