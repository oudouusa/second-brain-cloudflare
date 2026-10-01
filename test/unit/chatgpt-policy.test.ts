import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "../..");
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestEnv } from "../helpers/make-env";
import { chatGptResponse, mockChatGptFetch } from "../helpers/chatgpt-provider";
import { isChatGptOperationEnabled, runChatGptGeneration, runChatGptGenerationAnswerStream,
  type ChatGptOperation } from "../../src/lib/chatgpt";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(content: string, operations = "classify", status = 200) {
  const fetch = mockChatGptFetch(vi.fn().mockImplementation(async () => chatGptResponse(content, "stop", status)));
  const env = makeTestEnv(undefined, { CHATGPT_OPERATIONS: operations, CHATGPT_OWNER_WORKSPACE_ID: "owner-personal", CHATGPT_WORKSPACE_ID: "owner-personal" });
  return { env, fetch };
}
const cases: { operation: ChatGptOperation; content: string; tokens: number; chars: number; model: string }[] = [
  { operation: "classify", content: '{"importance":3,"canonical":false,"kind":"episodic"}', tokens: 256, chars: 12000, model: "gpt-5.6-luna" },
  { operation: "query-tags", content: "", tokens: 256, chars: 12000, model: "gpt-5.6-luna" },
  { operation: "smart-merge", content: '{"action":"keep_both"}', tokens: 1024, chars: 64000, model: "gpt-5.6-terra" },
  { operation: "contradiction", content: '{"contradicts":false}', tokens: 512, chars: 64000, model: "gpt-5.6-terra" },
  { operation: "recall-summary", content: "根拠を要約", tokens: 1024, chars: 64000, model: "gpt-5.6-luna" },
  { operation: "digest", content: "元の条件を保持", tokens: 1024, chars: 32000, model: "gpt-5.6-terra" },
  { operation: "answer", content: "根拠に基づく回答", tokens: 2048, chars: 64000, model: "gpt-5.6-luna" },
  { operation: "weekly-insight", content: '{"insight":false}', tokens: 1600, chars: 16000, model: "gpt-5.6-terra" },
];
describe("直接生成の処理予算と保存判断", () => {
  it.each(cases)("$operation: 上限内の要求を公開Responsesだけへ送る", async item => {
    const { env, fetch } = setup(item.content, item.operation);
    expect(await runChatGptGeneration(env, item.operation, "x".repeat(item.chars), item.tokens)).toBe(item.content);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(init.body)).toEqual({ model: item.model, input: [{ role: "user", content: "x".repeat(item.chars) }], stream: true, store: false });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it.each(cases)("$operation: 入力と生成上限の超過では通信しない", async item => {
    const { env, fetch } = setup(item.content, item.operation);
    for (const tokens of [0, -1, 1.5, item.tokens + 1]) {
      await expect(runChatGptGeneration(env, item.operation, "prompt", tokens)).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(runChatGptGeneration(env, item.operation, "x".repeat(item.chars + 1), item.tokens)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["classify", '{"importance":0,"canonical":false,"kind":"semantic"}'],
    ["classify", '{"importance":6,"canonical":false,"kind":"semantic"}'],
    ["classify", '{"importance":2.5,"canonical":false,"kind":"semantic"}'],
    ["classify", '{"importance":3,"canonical":"true","kind":"semantic"}'],
    ["classify", '{"importance":3,"canonical":false,"kind":"unknown"}'],
    ["smart-merge", '{"action":"replace","target_id":""}'],
    ["smart-merge", '{"action":"merge","target_id":"a","merged_content":" "}'],
    ["smart-merge", JSON.stringify({ action: "merge", target_id: "a", merged_content: "x".repeat(401) })],
    ["smart-merge", '{"action":"contradiction","conflicting_id":""}'],
    ["contradiction", '{"contradicts":true,"conflicting_id":""}'],
    ["contradiction", JSON.stringify({ contradicts: true, conflicting_id: "a", reason: "x".repeat(501) })],
    ["weekly-insight", '{"insight":"false"}'],
  ])("%s: 範囲外の保存判断を拒否する", async (operation, content) => {
    const { env } = setup(content, operation);
    await expect(runChatGptGeneration(env, operation as ChatGptOperation, "prompt", 256)).rejects.toMatchObject({ code: "invalid_response" });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it("未選択の生成は通信せず拒否し、選択は空白と大文字を正規化する", async () => {
    const { env, fetch } = setup("unused", " CLASSIFY , Query-Tags ");
    expect(isChatGptOperationEnabled(env, "classify")).toBe(true);
    expect(isChatGptOperationEnabled(env, "query-tags")).toBe(true);
    await expect(runChatGptGeneration(env, "digest", "prompt", 64)).rejects.toMatchObject({ code: "operation_not_enabled" });
    await expect(runChatGptGenerationAnswerStream(env, [{ role: "user", content: "prompt" }])).rejects.toMatchObject({ code: "operation_not_enabled" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("明示モデルは通常生成にだけ適用し、保存判断用Terraを保持する", async () => {
    const { env, fetch } = setup('{"action":"keep_both"}', "smart-merge,query-tags");
    env.CHATGPT_MODEL = "gpt-5.6-terra";
    await runChatGptGeneration(env, "query-tags", "prompt", 64);
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe("gpt-5.6-terra");
    env.CHATGPT_MODEL = "unapproved-model";
    await expect(runChatGptGeneration(env, "query-tags", "prompt", 64)).rejects.toMatchObject({ code: "model_not_allowlisted" });
    await expect(runChatGptGeneration(env, "smart-merge", "prompt", 64)).resolves.toBe('{"action":"keep_both"}');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("生成文字数の超過でも部分応答を返さない", async () => {
    const { env } = setup("123456789", "query-tags");
    await expect(runChatGptGeneration(env, "query-tags", "prompt", 1)).rejects.toMatchObject({ code: "response_too_large" });
  });
  it("直接接続のHTTP障害を隠さず、別providerへ切り替えない", async () => {
    const { env, fetch } = setup("private upstream body", "classify,answer", 503);
    await expect(runChatGptGeneration(env, "classify", "prompt", 64)).rejects.toMatchObject({ upstreamStatus: 503 });
    await expect(runChatGptGenerationAnswerStream(env, [{ role: "user", content: "prompt" }])).rejects.toMatchObject({ upstreamStatus: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it("配備設定とruntimeからprivate経路・キー・adapterを撤去する", () => {
    for (const path of ["wrangler.jsonc", "src/env.ts", "src/lib/chatgpt.ts"]) {
      expect(readFileSync(resolve(ROOT, path), "utf8")).not.toMatch(/CLIPROXY|cliproxy\.internal|vpc_services/);
    }
    expect(existsSync(resolve(ROOT, "src/lib/cliproxy.ts"))).toBe(false);
  });
});
