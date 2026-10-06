import { afterEach, describe, it, expect, vi } from "vitest";
import { makeTestEnv } from "../helpers/make-env";
import { synthesizeDigest } from "../../src/compression/digest";
import { synthesizeInsight } from "../../src/recall/insight";
import { reasonOverPair } from "../../src/insight/reason";
import * as vocabulary from "../../src/tags/vocabulary";
import { DEFAULTS, type Config } from "../../src/config";
import type { Env } from "../../src/env";
import { chatGptResponse, mockChatGptFetch } from "../helpers/chatgpt-provider";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const operations = "recall-summary,digest,answer,weekly-insight";
const rows = [{ id: "a", content: "Migration is deferred until validation passes." }];
function setup(content: string, finishReason = "stop", status = 200) {
  const fetch = mockChatGptFetch(vi.fn().mockImplementation(async () => chatGptResponse(content, finishReason, status)));
  const env = makeTestEnv(undefined, {
    CHATGPT_OPERATIONS: operations,
    CHATGPT_OWNER_WORKSPACE_ID: "owner-personal", CHATGPT_WORKSPACE_ID: "owner-personal",
  });
  return { env, fetch };
}
describe("生成処理の全面移行", () => {
  it.each(["digest", "recall-summary"])("%s の正常応答とモデル選択", async operation => {
    const { env, fetch } = setup("Validation remains required.");
    const result = operation === "digest" ? await synthesizeDigest("migration", rows, env) : await synthesizeInsight("status", rows, env);
    expect(result).toBe("Validation remains required.");
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe(operation === "digest" ? "gpt-5.6-terra" : "gpt-5.6-luna");
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it.each(["length", "stop"])("%s の未完了・空生成は見送り、Workers AIへ戻らない", async finishReason => {
    const { env } = setup(finishReason === "stop" ? "" : "partial", finishReason);
    expect(await synthesizeDigest("migration", rows, env)).toBe("");
    expect(await synthesizeInsight("status", rows, env)).toBe("");
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it("週次洞察の途中応答はfailedとして再試行可能なままにする", async () => {
    const { env } = setup('{"insight":false}', "length");
    expect(await reasonOverPair(rows[0], rows[0], env)).toEqual({ outcome: "failed" });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it("週次洞察はTerraで明示的な見送りを受理する", async () => {
    const { env, fetch } = setup('{"insight":false,"relationship":"none"}');
    expect(await reasonOverPair(rows[0], rows[0], env)).toEqual({ outcome: "declined" });
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe("gpt-5.6-terra");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

});

describe("単純テキスト生成3箇所の接続契約", () => {
  afterEach(() => vi.restoreAllMocks());
  const config = { ...DEFAULTS, LLM_MODEL: "@cf/test/text-model", INSIGHT_LLM_MODEL: "@cf/test/reason-model" };
  const cases: {
    operation: string; tokens: number; model: string; response: string; failed: unknown;
    invoke: (env: Env, config: Readonly<Config>) => Promise<unknown>;
  }[] = [
    { operation: "recall-summary", tokens: 300, model: config.LLM_MODEL, response: "検証待ち。", failed: "",
      invoke: (env, config) => synthesizeInsight("status", rows, env, config) },
    { operation: "digest", tokens: 400, model: config.LLM_MODEL, response: "検証待ち。", failed: "",
      invoke: (env, config) => synthesizeDigest("migration", rows, env, config) },
    { operation: "weekly-insight", tokens: 1200, model: config.INSIGHT_LLM_MODEL, response: '{"insight":false,"relationship":"none"}', failed: { outcome: "failed" },
      invoke: (env, config) => reasonOverPair(rows[0], rows[0], env, config) },
  ];

  it.each(cases)("$operation: 接続先を変えてもprompt・上限・解釈を維持する", async item => {
    vi.spyOn(vocabulary, "getTagVocabulary").mockResolvedValue(["migration"]);
    const direct = setup(item.response);
    direct.env.CHATGPT_OPERATIONS = item.operation;
    const directResult = await item.invoke(direct.env, config);
    expect(direct.fetch).toHaveBeenCalledTimes(1);
    expect(direct.fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(direct.env.AI.run).not.toHaveBeenCalled();
    const body = JSON.parse(direct.fetch.mock.calls[0][1].body);

    const workers = setup("使われない応答");
    workers.env.CHATGPT_OPERATIONS = "classify";
    workers.env.AI.run = vi.fn().mockResolvedValue(new ReadableStream({
      start(controller) {
        // UTF-8とSSE行を分割し、最終行には改行を付けない。
        const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning":"内部推論"}}]}\n\ndata: ' + JSON.stringify({ response: item.response }));
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }));
    expect(await item.invoke(workers.env, config)).toEqual(directResult);
    expect(workers.fetch).not.toHaveBeenCalled();
    expect(workers.env.AI.run).toHaveBeenCalledExactlyOnceWith(item.model, {
      messages: body.input.map((message: { role: string; content: string }) => ({ ...message, role: message.role === "developer" ? "system" : message.role })), max_tokens: item.tokens, stream: true,
    });
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.model).toBe(["digest", "weekly-insight"].includes(item.operation) ? "gpt-5.6-terra" : "gpt-5.6-luna");
  });

  it.each(cases)("$operation: 選択した接続先の障害では別モデルへ再試行しない", async item => {
    vi.spyOn(vocabulary, "getTagVocabulary").mockResolvedValue(["migration"]);
    const direct = setup("unavailable", "stop", 503);
    direct.env.CHATGPT_OPERATIONS = item.operation;
    expect(await item.invoke(direct.env, config)).toEqual(item.failed);
    expect(direct.fetch).toHaveBeenCalledTimes(1);
    expect(direct.fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(direct.env.AI.run).not.toHaveBeenCalled();

    const workers = setup("使われない応答");
    workers.env.CHATGPT_OPERATIONS = "";
    vi.mocked(workers.env.AI.run).mockRejectedValueOnce(new Error("AI unavailable"));
    expect(await item.invoke(workers.env, config)).toEqual(item.failed);
    expect(workers.env.AI.run).toHaveBeenCalledTimes(1);
    expect(workers.fetch).not.toHaveBeenCalled();
  });
});
