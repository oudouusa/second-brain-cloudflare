/**
 * The hooks lane needs recall WITHOUT LLM synthesis, but GET /recall never passed a `synthesize`
 * option to recallEntries even though src/recall/search.ts supports it (default true). This adds
 * an opt-out — `synthesize=false` or `synthesize=0` — additive only: the default is unchanged, so
 * every existing caller (including every hook that has not opted out yet) is byte-identical.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { LLM_MODEL } from "../../src/constants";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeMatch(id: string, score: number) {
  return { id, score, metadata: { parentId: id, isUpdate: false } };
}

/** Tracks every model name env.AI.run is called with, so a test can assert the synthesis
 * (chat) model was or was not invoked without caring about the embedding call. */
function makeTrackingAI(calls: string[]): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      calls.push(model);
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":"an insight about the memories"}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

describe("GET /recall synthesize opt-out", () => {
  let db: D1Mock;
  let env: Env;
  let calls: string[];

  beforeEach(() => {
    db = makeTestDb();
    calls = [];
    db.entries.push(
      { id: "e1", content: "first memory about the topic", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]" },
      { id: "e2", content: "second memory about the topic", tags: "[]", source: "api", created_at: 2000, vector_ids: "[]" },
    );
    env = makeTestEnv(db, {
      AI: makeTrackingAI(calls),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [makeMatch("e1", 0.9), makeMatch("e2", 0.8)] }),
      }),
    });
  });

  it("by default still calls the synthesis model and returns an insight (unchanged)", async () => {
    const res = await worker.fetch(req("POST", "/recall?query=the+topic"), env, ctx);
    const data = await res.json() as any;
    expect(calls).toContain(LLM_MODEL);
    expect(data.insight).toBeTruthy();
  });

  it("synthesize=false makes no synthesis model call", async () => {
    const res = await worker.fetch(req("POST", "/recall", { body: { query: "the topic", synthesize: false } }), env, ctx);
    const data = await res.json() as any;
    expect(calls).not.toContain(LLM_MODEL);
    expect(data.insight).toBeFalsy();
    expect(res.status).toBe(200);
    expect(data.results).toHaveLength(2);
  });

  it("explicit false keeps synthesis disabled", async () => {
    const res = await worker.fetch(req("POST", "/recall", { body: { query: "the topic", synthesize: false } }), env, ctx);
    const data = await res.json() as any;
    expect(calls).not.toContain(LLM_MODEL);
    expect(data.insight).toBeFalsy();
  });

  it("a string synthesize value is rejected", async () => {
    const res = await worker.fetch(req("POST", "/recall", { body: { query: "the topic", synthesize: "nope" } }), env, ctx);
    const data = await res.json() as any;
    expect(res.status).toBe(400);
    expect(calls).not.toContain(LLM_MODEL);
  });
});
