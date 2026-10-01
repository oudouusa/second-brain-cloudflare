import { describe, it, expect, vi } from "vitest";
import { embedDocument, embedQuery, embedMany } from "../../src/lib/ai";
import { DEFAULTS } from "../../src/config";
import { makeTestEnv } from "../helpers/make-env";

describe("embedDocument() input shape", () => {
  it("sends the pinned EmbeddingGemma document prompt", async () => {
    const env = makeTestEnv();
    await embedDocument("hello", env, DEFAULTS);
    expect(vi.mocked(env.AI.run).mock.calls[0][1]).toEqual({ text: ["title: none | text: hello"] });
  });

  it("rejects an embedding model that does not match the deployed profile", async () => {
    const env = makeTestEnv();
    await expect(embedDocument("hello", env, { ...DEFAULTS, EMBEDDING_MODEL: "@cf/baai/bge-m3" }))
      .rejects.toThrow(/unsupported embedding model/);
    expect(vi.mocked(env.AI.run)).not.toHaveBeenCalled();
  });

  it("makes exactly one AI.run call, delegating to embedMany", async () => {
    const env = makeTestEnv();
    await embedQuery("hello", env, DEFAULTS);
    expect(vi.mocked(env.AI.run).mock.calls).toHaveLength(1);
  });
});

describe("embedMany()の固定Gemma入力とMRL", () => {
  const raw = (index: number) => Array.from({ length: 768 }, (_, i) => i === index ? 2 : 0);
  const projected = (index: number) => Array.from({ length: 128 }, (_, i) => i === index ? 1 : 0);

  it("複数のqueryをまとめ、入力順と正規化した128次元を保つ", async () => {
    const env = makeTestEnv();
    env.AI.run = vi.fn().mockResolvedValue({ data: [raw(0), raw(1)] });
    const vectors = await embedMany(["a", "b"], env, DEFAULTS);
    expect(vi.mocked(env.AI.run).mock.calls).toHaveLength(1);
    expect(vi.mocked(env.AI.run).mock.calls[0][1]).toEqual({ text: ["task: search result | query: a", "task: search result | query: b"] });
    expect(vectors).toEqual([projected(0), projected(1)]);
  });

  it("documentの入力形式をまとめた呼出しでも保つ", async () => {
    const env = makeTestEnv();
    env.AI.run = vi.fn().mockResolvedValue({ data: [raw(0), raw(1)] });
    await embedMany(["a", "b"], env, DEFAULTS, "document", "題名");
    expect(vi.mocked(env.AI.run).mock.calls[0][1]).toEqual({ text: ["title: 題名 | text: a", "title: 題名 | text: b"] });
  });

  it("別モデルはAI呼出し前に拒否する", async () => {
    const env = makeTestEnv();
    await expect(embedMany(["a", "b"], env, { ...DEFAULTS, EMBEDDING_MODEL: "@cf/baai/bge-m3" })).rejects.toThrow(/unsupported embedding model/);
    expect(vi.mocked(env.AI.run)).not.toHaveBeenCalled();
  });

  it("同じ本文でも応答の順を維持する", async () => {
    const env = makeTestEnv();
    env.AI.run = vi.fn().mockResolvedValue({ data: [raw(0), raw(1), raw(2)] });
    expect(await embedMany(["same", "same", "different"], env, DEFAULTS)).toEqual([projected(0), projected(1), projected(2)]);
  });

  it("応答件数の不一致を拒否する", async () => {
    const env = makeTestEnv();
    env.AI.run = vi.fn().mockResolvedValue({ data: [raw(0)] });
    await expect(embedMany(["a", "b"], env, DEFAULTS)).rejects.toThrow(/件数/);
  });
});
