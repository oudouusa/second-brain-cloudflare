import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";

describe("ChatGPT回答のCPU境界", () => {
  it("認証後に既存DOへ本文を送り、回答SSEをそのまま返す", async () => {
    const handleChatGpt = vi.fn(async (request: Request) => {
      expect(await request.json()).toEqual({ query: "接続確認", memories: "合成記憶" });
      return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    });
    const getByName = vi.fn(() => ({ handleChatGpt }));
    const env = makeTestEnv(makeTestDb(), { CHATGPT_OPERATIONS: "answer",
      MCP_EXECUTOR: { getByName } as unknown as DurableObjectNamespace<import("../../src/mcp/executor").McpExecutor> });
    const response = await worker.fetch(new Request("https://example.test/chat", { method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ query: "接続確認", memories: "合成記憶" }) }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(response.status).toBe(200); expect(await response.text()).toBe("data: [DONE]\n\n");
    expect(getByName).toHaveBeenCalledWith("mcp-v1"); expect(handleChatGpt).toHaveBeenCalledTimes(1);
  });
  it("匿名・偽装した検証済みheaderをDOへ送らない", async () => {
    const handleChatGpt = vi.fn();
    const env = makeTestEnv(makeTestDb(), { CHATGPT_OPERATIONS: "answer",
      MCP_EXECUTOR: { getByName: vi.fn(() => ({ handleChatGpt })) } as unknown as DurableObjectNamespace<import("../../src/mcp/executor").McpExecutor> });
    const response = await worker.fetch(new Request("https://example.test/chat", { method: "POST",
      headers: { "X-Second-Brain-Auth-Verified": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ query: "拒否する要求" }) }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(response.status).toBe(401); expect(handleChatGpt).not.toHaveBeenCalled();
  });
});

describe("週次プレビューのCPU境界", () => {
  it("認証後のGETとlimitを既存DOへ転送する", async () => {
    const handleInsightPreview = vi.fn(async (request: Request) => {
      expect(new URL(request.url).searchParams.get("limit")).toBe("1");
      expect(request.method).toBe("GET");
      return Response.json({ ok: true, candidates: [] });
    });
    const getByName = vi.fn(() => ({ handleInsightPreview }));
    const env = makeTestEnv(makeTestDb(), { MCP_EXECUTOR: { getByName } as unknown as
      DurableObjectNamespace<import("../../src/mcp/executor").McpExecutor> });
    const response = await worker.fetch(new Request("https://example.test/insights/dry-run?limit=1", {
      headers: { Authorization: "Bearer test-token" } }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, candidates: [] });
    expect(getByName).toHaveBeenCalledWith("mcp-v1"); expect(handleInsightPreview).toHaveBeenCalledOnce();
  });

  it("匿名の検証済みheader偽装をDOへ転送しない", async () => {
    const handleInsightPreview = vi.fn();
    const env = makeTestEnv(makeTestDb(), { MCP_EXECUTOR: { getByName: vi.fn(() => ({ handleInsightPreview })) } as unknown as
      DurableObjectNamespace<import("../../src/mcp/executor").McpExecutor> });
    const response = await worker.fetch(new Request("https://example.test/insights/dry-run", {
      headers: { "X-Second-Brain-Auth-Verified": "1" } }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(response.status).toBe(401); expect(handleInsightPreview).not.toHaveBeenCalled();
  });
});
