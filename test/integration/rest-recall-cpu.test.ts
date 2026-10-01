import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { McpExecutor } from "../../src/mcp/executor";
import { setMemoryWriteLock } from "../../src/migration/write-lock";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

const owner = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
function request(body: unknown, headers: HeadersInit = owner, path = "/recall") {
  return new Request(`https://brain${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function fixture(run: (env: Env, tasks: Promise<unknown>[], getByName: ReturnType<typeof vi.fn>) => Promise<void>) {
  const sqlite = makeSqliteD1();
  const tasks: Promise<unknown>[] = [];
  try {
    sqlite.seed({ id: "own", content: "認証方式の変更を決定した", createdAt: Date.now() });
    sqlite.seed({ id: "foreign", content: "認証方式の変更を決定した", createdAt: Date.now(), workspaceId: "foreign-workspace" });
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });
    const object = new McpExecutor({ waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as DurableObjectState, env);
    const getByName = vi.fn(() => ({ handleRecall: (req: Request) => object.handleRecall(req) }));
    env.MCP_EXECUTOR = { getByName } as unknown as Env["MCP_EXECUTOR"];
    await run(env, tasks, getByName);
  } finally {
    // 解放のwaitUntilから追加される処理も完了させる。
    while (tasks.length) await Promise.all(tasks.splice(0));
    sqlite.close();
  }
}

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
describe("REST検索の既存DOへのCPU隔離", () => {
  it("同じ検索本体を再利用し、他workspaceを返さずJSONとusage更新を完了する", async () => {
    await fixture(async (env, _tasks, getByName) => {
      const response = await worker.fetch(request({ query: "認証方式", topK: 5, hops: 0, synthesize: false }), env, ctx);
      expect(response.status).toBe(200);
      const body = await response.json() as { results: { id: string }[]; insight: string | null; receipt: string };
      expect(body.results.map(row => row.id)).toContain("own");
      expect(body.results.map(row => row.id)).not.toContain("foreign");
      expect(body.insight).toBeNull(); expect(body.receipt).toBeTruthy();
      await Promise.all(_tasks);
      expect(getByName).toHaveBeenCalledOnce(); expect(getByName).toHaveBeenCalledWith("mcp-v1");
      expect(await env.DB.prepare("SELECT recall_count FROM entries WHERE id = 'own'").first()).toEqual({ recall_count: 1 });
      expect(await env.DB.prepare("SELECT recall_count FROM entries WHERE id = 'foreign'").first()).toEqual({ recall_count: 0 });
    });
  });

  it("未認証と偽装済みheaderを転送せず拒否する", async () => {
    await fixture(async (env, _tasks, getByName) => {
      const invalidHeaders: HeadersInit[] = [{}, { "X-Second-Brain-Auth-Verified": "1" }, { Authorization: "Bearer invalid" }];
      for (const headers of invalidHeaders) {
        const response = await worker.fetch(request({ query: "認証" }, headers), env, ctx);
        expect(response.status).toBe(401);
      }
      expect(getByName).not.toHaveBeenCalled();
      expect(env.VECTORIZE.query).not.toHaveBeenCalled();
    });
  });

  it("Content-Lengthのない32 KiB超過も転送前に拒否する", async () => {
    await fixture(async (env, _tasks, getByName) => {
      const response = await worker.fetch(request({ query: "認".repeat(12 * 1024) }), env, ctx);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ ok: false, error: "JSON body is too large" });
      expect(getByName).not.toHaveBeenCalled(); expect(env.VECTORIZE.query).not.toHaveBeenCalled();
    });
  });

  it("DO内でもmaintenanceの書込み制限で423を返す", async () => {
    await fixture(async (env, _tasks, getByName) => {
      await setMemoryWriteLock(env);
      const response = await worker.fetch(request({ query: "認証" }), env, ctx);
      expect(response.status).toBe(423); await response.json();
      expect(getByName).toHaveBeenCalledOnce(); expect(env.VECTORIZE.query).not.toHaveBeenCalled();
    });
  });

  it.each([{ query: "認証", workspace: "invalid" }, { query: "認証", team: "foreign-workspace" },
    { query: "認証", synthesize: "true" }, { query: "認証", hops: "invalid" }])("元の入力とscopeの検証を保持する: %j", async body => {
    await fixture(async (env, _tasks, getByName) => {
      const response = await worker.fetch(request(body), env, ctx);
      await response.json(); expect(response.status).toBe(400);
      expect(getByName).toHaveBeenCalledOnce(); expect(env.VECTORIZE.query).not.toHaveBeenCalled();
    });
  });

  it("legacy GETはDOへ送らず従来の405を返す", async () => {
    await fixture(async (env, _tasks, getByName) => {
      const response = await worker.fetch(new Request("https://brain/recall?query=private-sentinel", { headers: owner }), env, ctx);
      expect(response.status).toBe(405); expect(getByName).not.toHaveBeenCalled();
    });
  });
});
