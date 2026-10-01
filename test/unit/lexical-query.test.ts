import { describe, it, expect } from "vitest";
import {
  escapeLikeToken,
  likeContainsPattern,
  tokenizeQuery,
  tokenizeQueryDetailed,
} from "../../src/text/lexical-query";
import { D1_MAX_LIKE_PATTERN_BYTES } from "../../src/constants";

describe("recall lexical query policy", () => {
  it("preserves identifier-shaped tokens like version strings", () => {
    expect(tokenizeQuery("release v1.9")).toEqual(["release", "v1.9"]);
  });

  it("drops stopwords and 1-char tokens but keeps the meaningful ones", () => {
    expect(tokenizeQuery("What is the v1.9 release?")).toEqual(["v1.9", "release"]);
  });

  it("preserves identifier underscores and escapes SQL LIKE wildcards separately", () => {
    expect(tokenizeQuery("foo_bar 100%")).toEqual(["foo_bar", "100"]);
    expect(escapeLikeToken("foo_bar%\\done")).toBe("foo\\_bar\\%\\\\done");
    expect(likeContainsPattern("foo_bar")).toBe("%foo\\_bar%");
  });

  it("deduplicates repeated tokens", () => {
    expect(tokenizeQuery("test test")).toEqual(["test"]);
  });

  it("returns an empty array when the query is all stopwords", () => {
    expect(tokenizeQuery("what is the")).toEqual([]);
  });

  it("normalizes NFKC and adds deterministic CJK 2-gram fallbacks", () => {
    const tokens = tokenizeQuery("Ｃｌｏｕｄｆｌａｒｅで東京都庁を検索");
    expect(tokens).toContain("cloudflare");
    expect(tokens).toContain("東京");
    expect(tokens).toContain("都庁");
    expect(tokens).not.toContain("京都");
  });

  it("keeps the raw compatibility-form probe beside the normalized score value", () => {
    const [token] = tokenizeQueryDetailed("Ｃｌｏｕｄｆｌａｒｅ");

    expect(token).toEqual({
      value: "cloudflare",
      kind: "word",
      probes: ["cloudflare", "Ｃｌｏｕｄｆｌａｒｅ"],
    });
  });

  it("keeps compatibility probes grouped after punctuation segmentation", () => {
    expect(tokenizeQueryDetailed("５０％ｏｆｆ ＿ｆｏｏ")).toEqual([
      { value: "50%off", kind: "protected", probes: ["50%off", "５０％ｏｆｆ"] },
      { value: "_foo", kind: "word", probes: ["_foo", "ｆｏｏ"] },
    ]);
  });

  it("keeps a later token after an earlier token that contains it", () => {
    const tokens = tokenizeQuery("Vectorize index を作成し、旧indexとvectorを混在させない");
    expect(tokens.indexOf("vector")).toBeGreaterThan(tokens.indexOf("作成"));
  });

  it("keeps lexical boundaries between ASCII words and punctuation", () => {
    expect(tokenizeQuery("alpha,beta foo(bar)")).toEqual(["alpha", "beta", "foo", "bar"]);
  });

  it("preserves upstream token boundaries for embedded Unicode whitespace", () => {
    expect(tokenizeQuery("hello\uFEFFworld")).toEqual(["hello", "world"]);
    expect(tokenizeQueryDetailed("ｈｅｌｌｏ\uFEFFｗｏｒｌｄ")).toEqual([
      { value: "hello", kind: "word", probes: ["hello", "ｈｅｌｌｏ"] },
      { value: "world", kind: "word", probes: ["world", "ｗｏｒｌｄ"] },
    ]);
  });

  it("preserves repeated and leading underscores as literal identifiers", () => {
    expect(tokenizeQueryDetailed("foo__bar _foo _x x_ __x")).toEqual([
      { value: "foo__bar", kind: "word", probes: ["foo__bar"] },
      { value: "_foo", kind: "word", probes: ["_foo"] },
      { value: "_x", kind: "word", probes: ["_x"] },
      { value: "x_", kind: "word", probes: ["x_"] },
      { value: "__x", kind: "word", probes: ["__x"] },
    ]);
    expect(likeContainsPattern("foo__bar")).toBe("%foo\\_\\_bar%");
  });

  it("does not fabricate a CJK 2-gram across two Segmenter words", () => {
    expect(tokenizeQueryDetailed("認証方式").map(term => term.value)).not.toContain("証方");
  });

  it("keeps deterministic CJK fallbacks inside one Segmenter word", () => {
    const token = tokenizeQueryDetailed("未登録語彙").find(term => term.value === "未登");

    expect(token?.kind).toBe("cjk-bigram");
  });

  it("protects URLs, issue IDs, type names, colors, and API paths", () => {
    const tokens = tokenizeQuery("https://example.com/A ISSUE-149 MemoryTier #1A73E8 /api/v2/recall");
    expect(tokens).toEqual(expect.arrayContaining([
      "https://example.com/a",
      "issue-149",
      "memorytier",
      "#1a73e8",
      "/api/v2/recall",
    ]));
  });

  it("deduplicates and enforces the SQL token ceiling", () => {
    const tokens = tokenizeQuery(Array.from({ length: 40 }, (_, i) => `token-${i}`).join(" "));
    expect(tokens).toHaveLength(16);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens).toContain("token-39");
  });

  it("keeps mixed Japanese identifier queries inside D1's 50-byte LIKE limit", () => {
    const query = "ユーザーはsecond-brain-cfに保存済みのEmbeddingGemma関連メモをquota枯渇中でも読み取れるか本番確認したい。";
    const tokens = tokenizeQuery(query);

    expect(tokens).toContain("embeddinggemma");
    expect(tokens.every(token =>
      new TextEncoder().encode(likeContainsPattern(token)).byteLength <= D1_MAX_LIKE_PATTERN_BYTES
    )).toBe(true);
  });

  it("bounds direct LIKE patterns after escaping metacharacters", () => {
    const pattern = likeContainsPattern("_".repeat(100));
    expect(new TextEncoder().encode(pattern).byteLength).toBeLessThanOrEqual(D1_MAX_LIKE_PATTERN_BYTES);
  });

  it("preserves fork identifier policy on top of the upstream ASCII pipeline", () => {
    expect(tokenizeQuery("2026-09-02 user@example.com src/recall/search.ts #149 --no-cache key=value @cf/baai/bge-m3"))
      .toEqual(["2026-09-02", "user@example.com", "src/recall/search.ts", "#149", "no-cache", "key=value", "@cf/baai/bge-m3"]);
  });
});
