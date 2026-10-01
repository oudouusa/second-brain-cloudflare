import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import {
  EMBEDDING_PROFILE,
  assertEmbeddingConfig,
  assertVectorProfiles,
  embeddingInput,
  embeddingMetadata,
  projectEmbedding,
} from "../../src/embedding/profile";

describe("EmbeddingGemma MRL128 profile", () => {
  it("fixes model, dimensions and prompt version as one profile", () => {
    expect(assertEmbeddingConfig(DEFAULTS)).toBe(EMBEDDING_PROFILE);
    expect(EMBEDDING_PROFILE).toMatchObject({
      profileId: "embeddinggemma-mrl128-v1",
      model: "@cf/google/embeddinggemma-300m",
      rawDimensions: 768,
      dimensions: 128,
      promptVersion: 1,
    });
  });

  it("uses separate official query and document prompts", () => {
    expect(embeddingInput("京都の予定", "query")).toBe("task: search result | query: 京都の予定");
    expect(embeddingInput("本文", "document")).toBe("title: none | text: 本文");
    expect(embeddingInput("本文", "document", "題名")).toBe("title: 題名 | text: 本文");
  });

  it("truncates 768 dimensions to 128 then renormalizes", () => {
    const raw = Array.from({ length: 768 }, (_, index) => index + 1);
    const projected = projectEmbedding(raw);
    expect(projected).toHaveLength(128);
    expect(Math.sqrt(projected.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 12);
    expect(projected[0] / projected[1]).toBeCloseTo(0.5, 12);
  });

  it.each([
    ["wrong length", new Array(767).fill(1)],
    ["non-finite", [...new Array(127).fill(1), Number.NaN, ...new Array(640).fill(1)]],
    ["zero norm", new Array(768).fill(0)],
  ])("rejects %s output", (_name, vector) => {
    expect(() => projectEmbedding(vector)).toThrow();
  });

  it("rejects missing or mixed Vectorize profile metadata", () => {
    expect(() => assertVectorProfiles([{ id: "old", metadata: {} }])).toThrow(/does not belong/);
    expect(() => assertVectorProfiles([{
      id: "current",
      metadata: embeddingMetadata(),
    }])).not.toThrow();
  });
});
