/**
 * #245 — the embedding model must be consistent across every path that writes
 * or reads vectors.
 *
 * This is the sharpest hazard in making EMBEDDING_MODEL configurable: if
 * capture embeds with the configured model while recall still embeds with the
 * compiled-in default (or vice versa), the two produce vectors from different
 * models and every similarity score becomes meaningless. Nothing would throw —
 * recall would just quietly return wrong answers.
 *
 * The thin fork fixes model, dimensions and prompt version as one profile.
 * A stale or hand-edited model-only override must therefore fall back to the
 * fixed profile before any AI call, instead of taking the service down or
 * producing vectors that look valid but are incomparable.
 */
import { describe, it, expect, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { captureEntry } from "../../src/capture/entry";
import { CONFIG_KEY, DEFAULTS, resolveConfig } from "../../src/config";
import { createDefaultHandler } from "../../src/routes/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";

const OVERRIDE_MODEL = "@cf/baai/bge-base-en-v1.5";

function envRecordingModels() {
  const models: string[] = [];
  const kv = makeMemoryKV();
  const db = makeTestDb();
  const env = makeTestEnv(db, {
    OAUTH_KV: kv,
    AI: {
      run: vi.fn().mockImplementation(async (model: string) => {
        models.push(model);
        // Embedding models return data[]; text models return a stream. Only the
        // embedding shape is needed here.
        return { data: [new Array(768).fill(0.1)] };
      }),
    } as never,
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [] }),
      upsert: vi.fn().mockResolvedValue({}),
    }),
  });
  return { env, db, kv, models };
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe("embedding model consistency (#245)", () => {
  it("recall ignores a stale model-only override and uses the fixed profile", async () => {
    const { env, kv, models } = envRecordingModels();
    await kv.put(CONFIG_KEY, JSON.stringify({ EMBEDDING_MODEL: OVERRIDE_MODEL }));

    await recallEntries({ query: "anything", topK: 5 }, env, ctx);

    expect(models).toContain(DEFAULTS.EMBEDDING_MODEL);
    expect(models).not.toContain(OVERRIDE_MODEL);
  });

  it("capture ignores a stale model-only override and uses the fixed profile", async () => {
    const { env, kv, models } = envRecordingModels();
    await kv.put(CONFIG_KEY, JSON.stringify({ EMBEDDING_MODEL: OVERRIDE_MODEL }));

    await captureEntry("a memory worth storing", ["test"], "api", env, ctx);

    expect(models).toContain(DEFAULTS.EMBEDDING_MODEL);
    expect(models).not.toContain(OVERRIDE_MODEL);
  });

  it("both paths use the same fixed model when no override exists", async () => {
    const capture = envRecordingModels();
    await captureEntry("a memory worth storing", [], "api", capture.env, ctx);

    const recall = envRecordingModels();
    await recallEntries({ query: "anything", topK: 5 }, recall.env, ctx);

    const captureModels = new Set(capture.models.filter(m => m.includes("embeddinggemma")));
    const recallModels = new Set(recall.models.filter(m => m.includes("embeddinggemma")));

    expect([...captureModels]).toEqual([...recallModels]);
    expect([...captureModels]).toEqual([DEFAULTS.EMBEDDING_MODEL]);
  });

  it("rejects changing the fixed embedding profile model through PATCH /config", async () => {
    const { env } = envRecordingModels();
    const res = await createDefaultHandler().fetch(new Request("http://localhost/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ EMBEDDING_MODEL: OVERRIDE_MODEL }),
    }), env, ctx);
    const body = await res.json() as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/EMBEDDING_MODEL.*fixed/i);
    expect((await resolveConfig(env)).EMBEDDING_MODEL).toBe(DEFAULTS.EMBEDDING_MODEL);
  });
});
