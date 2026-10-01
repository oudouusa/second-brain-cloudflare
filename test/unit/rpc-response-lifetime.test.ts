import { afterEach, describe, expect, it, vi } from "vitest";
import { McpExecutor } from "../../src/mcp/executor";
import { handleChatGptRoutes } from "../../src/routes/chatgpt";
import { createDefaultHandler } from "../../src/routes/index";
import { makeTestEnv } from "../helpers/make-env";

vi.mock("../../src/routes/chatgpt", () => ({ handleChatGptRoutes: vi.fn() }));
vi.mock("../../src/routes/index", () => ({ createDefaultHandler: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });

function executor() {
  const tasks: Promise<unknown>[] = [];
  return { tasks, object: new McpExecutor({ waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as DurableObjectState,
    makeTestEnv()) };
}

describe("RPC応答本文の寿命", () => {
  it("JSON本文を読み終えるまで文脈を維持し、statusとheaderも保持する", async () => {
    const { object, tasks } = executor();
    vi.mocked(handleChatGptRoutes).mockResolvedValue(Response.json({ matched: true }, { status: 201, headers: { "X-Test": "preserved" } }));
    const response = await object.handleChatGpt(new Request("https://brain/admin/chatgpt/probe"));
    let finished = false;
    const completion = Promise.all(tasks).then(() => { finished = true; });
    await Promise.resolve();
    expect(tasks).toHaveLength(1); expect(finished).toBe(false);
    expect(response.status).toBe(201); expect(response.headers.get("X-Test")).toBe("preserved");
    expect(await response.json()).toEqual({ matched: true });
    await completion; expect(finished).toBe(true);
  });

  it("クライアント切断を元の本文へ伝え、背景処理も終了する", async () => {
    const { object, tasks } = executor();
    const cancel = vi.fn();
    vi.mocked(handleChatGptRoutes).mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const response = await object.handleChatGpt(new Request("https://brain/admin/chatgpt/models"));
    await response.body!.cancel(); await Promise.all(tasks);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("途中の送信エラーを正常なJSON完了へ変換しない", async () => {
    const { object, tasks } = executor();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.mocked(handleChatGptRoutes).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } })));
    const response = await object.handleChatGpt(new Request("https://brain/admin/chatgpt/probe"));
    const body = response.text();
    controller.enqueue(new TextEncoder().encode('{"partial":'));
    controller.error(new Error("途中切断"));
    await expect(body).rejects.toThrow("途中切断"); await Promise.all(tasks);
  });

  it("本文のない応答には送信処理を追加しない", async () => {
    const { object, tasks } = executor();
    vi.mocked(handleChatGptRoutes).mockResolvedValue(new Response(null, { status: 204 }));
    expect((await object.handleChatGpt(new Request("https://brain/admin/chatgpt/status"))).status).toBe(204);
    expect(tasks).toHaveLength(0);
  });

  it.each([false, true])("プレビューは既存REST本体を再利用し、bindingの再帰を防ぐ: dashboard=%s", async dashboard => {
    const { object, tasks } = executor();
    const fetch = vi.fn(async (_request, env) => {
      expect(env.MCP_EXECUTOR).toBeUndefined();
      return Response.json({ ok: true, candidates: [] });
    });
    vi.mocked(createDefaultHandler).mockReturnValue({ fetch });
    const request = new Request(`https://brain${dashboard ? "/dashboard/api" : ""}/insights/dry-run?limit=1`);
    expect(await (await object.handleInsightPreview(request)).json()).toEqual({ ok: true, candidates: [] });
    await Promise.all(tasks);
    expect(createDefaultHandler).toHaveBeenCalledWith(dashboard ? { trustedPrefix: "/dashboard/api" } : {});
    expect(fetch).toHaveBeenCalledWith(request, expect.any(Object), expect.any(Object));
  });

  it.each([["/insights/accrue", "POST"], ["/insights/dry-run", "POST"], ["/team/members", "GET"]])(
    "専用RPCから別の管理処理を実行しない: %s %s", async (path, method) => {
      const { object, tasks } = executor();
      const response = await object.handleInsightPreview(new Request("https://brain" + path, { method }));
      expect(response.status).toBe(404); await response.text(); await Promise.all(tasks);
      expect(createDefaultHandler).not.toHaveBeenCalled();
    });

  it.each([false, true])("REST検索は元のREST本体と応答寿命を保持する: dashboard=%s", async dashboard => {
    const { object, tasks } = executor();
    const fetch = vi.fn(async (_request, env) => {
      expect(env.MCP_EXECUTOR).toBeUndefined();
      return Response.json({ matches: [], insight: "" });
    });
    vi.mocked(createDefaultHandler).mockReturnValue({ fetch });
    const request = new Request(`https://brain${dashboard ? "/dashboard/api" : ""}/recall`, { method: "POST", body: "{}" });
    const response = await object.handleRecall(request);
    expect(tasks).toHaveLength(1);
    expect(await response.json()).toEqual({ matches: [], insight: "" }); await Promise.all(tasks);
    expect(createDefaultHandler).toHaveBeenCalledWith(dashboard ? { trustedPrefix: "/dashboard/api" } : {});
    expect(fetch).toHaveBeenCalledWith(request, expect.any(Object), expect.any(Object));
  });

  it.each([["/capture", "POST"], ["/recall", "GET"], ["/dashboard/api/team/members", "POST"]])(
    "検索専用RPCで別の処理を実行しない: %s %s", async (path, method) => {
      const { object, tasks } = executor();
      const response = await object.handleRecall(new Request("https://brain" + path, { method }));
      expect(response.status).toBe(404); await response.text(); await Promise.all(tasks);
      expect(createDefaultHandler).not.toHaveBeenCalled();
    });
});
