import { describe, it, expect, vi } from "vitest";
import { checkVectorizeHealth, FALLBACK_VECTORIZE_INDEX_NAME } from "../../src/vectorize/health";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";

function envDescribing(value: unknown) {
  return makeTestEnv(makeTestDb(), {
    VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue(value) }),
  });
}

function envFailing(error: unknown) {
  return makeTestEnv(makeTestDb(), {
    VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockRejectedValue(error) }),
  });
}

describe("checkVectorizeHealth", () => {
  it("reports the name the bound index gives, not the compile-time fallback", async () => {
    // The migration case: the binding has been repointed at a 768-dim index, so
    // reporting FALLBACK_VECTORIZE_INDEX_NAME here would name the wrong index on
    // the dashboard banner during the migration the user is watching.
    const health = await checkVectorizeHealth(
      envDescribing({ name: "second-brain-vectors-768", dimensions: 768, vectorCount: 12 }),
    );
    expect(health.indexName).toBe("second-brain-vectors-768");
    expect(health.indexName).not.toBe(FALLBACK_VECTORIZE_INDEX_NAME);
  });

  it("returns the full healthy shape GET /health serialises", async () => {
    const health = await checkVectorizeHealth(
      envDescribing({ name: "second-brain-vectors-768", dimensions: 768, vectorCount: 12 }),
    );
    expect(health).toEqual({
      ok: true,
      indexName: "second-brain-vectors-768",
      dimensions: 768,
      vectorCount: 12,
    });
  });

  it("reports the vector count from the V2 describe() shape", async () => {
    const health = await checkVectorizeHealth(envDescribing({ dimensions: 768, vectorCount: 41 }));
    expect(health.ok).toBe(true);
    expect(health.vectorCount).toBe(41);
  });

  it("reports the vector count from the beta describe() shape (vectorsCount)", async () => {
    const health = await checkVectorizeHealth(
      envDescribing({ name: "second-brain-vectors", config: { dimensions: 384, metric: "cosine" }, vectorsCount: 7 }),
    );
    expect(health.vectorCount).toBe(7);
  });

  it("reports a zero vector count as 0, not as missing (an empty index is a fact)", async () => {
    const health = await checkVectorizeHealth(envDescribing({ dimensions: 384, vectorCount: 0 }));
    expect(health.vectorCount).toBe(0);
  });

  it("omits the vector count when describe() does not report one", async () => {
    const health = await checkVectorizeHealth(envDescribing({ dimensions: 384, metric: "cosine" }));
    expect(health.ok).toBe(true);
    expect(health.dimensions).toBe(384);
    expect(health.vectorCount).toBeUndefined();
    // undefined must not survive into the /health body as an explicit null.
    expect(JSON.parse(JSON.stringify(health))).not.toHaveProperty("vectorCount");
  });

  it("omits the vector count when describe() reports a non-numeric one", async () => {
    const health = await checkVectorizeHealth(envDescribing({ dimensions: 384, vectorCount: "41" }));
    expect(health.vectorCount).toBeUndefined();
  });

  it("falls back to the configured index name when describe() reports no name", async () => {
    // The V2 describe() shape has no `name` field at all, so this is the live path
    // today — the fallback must still be the wrangler.jsonc name that public/utils.js
    // and the README verify step expect.
    const health = await checkVectorizeHealth(envDescribing({ dimensions: 384 }));
    expect(health.indexName).toBe(FALLBACK_VECTORIZE_INDEX_NAME);
    expect(health.indexName).toBe("second-brain-cf-eg128-v1");
  });

  it("falls back when describe() reports an empty or non-string name", async () => {
    expect((await checkVectorizeHealth(envDescribing({ name: "", dimensions: 384 }))).indexName)
      .toBe(FALLBACK_VECTORIZE_INDEX_NAME);
    expect((await checkVectorizeHealth(envDescribing({ name: 123, dimensions: 384 }))).indexName)
      .toBe(FALLBACK_VECTORIZE_INDEX_NAME);
  });

  it("reads dimensions from a beta-shaped config object", async () => {
    const health = await checkVectorizeHealth(
      envDescribing({ config: { dimensions: 384, metric: "cosine" } }),
    );
    expect(health.ok).toBe(true);
    expect(health.dimensions).toBe(384);
  });

  it("returns not-ok with the error message when describe() rejects", async () => {
    const health = await checkVectorizeHealth(envFailing(new Error("index not found")));
    expect(health.ok).toBe(false);
    expect(health.error).toContain("index not found");
    // The banner interpolates indexName, so it stays a non-empty string even when
    // we could not ask the index its name.
    expect(health.indexName).toBe(FALLBACK_VECTORIZE_INDEX_NAME);
    expect(typeof health.indexName).toBe("string");
    expect(health.vectorCount).toBeUndefined();
  });

  it("stringifies a non-Error rejection", async () => {
    const health = await checkVectorizeHealth(envFailing("boom"));
    expect(health.ok).toBe(false);
    expect(health.error).toBe("boom");
  });
});
