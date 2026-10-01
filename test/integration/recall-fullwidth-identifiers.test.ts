/** Full-width identifier probes, with the real SQLite recall pipeline. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { D1_MAX_LIKE_PATTERN_BYTES, KEYWORD_MAX_TOKENS } from "../../src/constants";
import { tokenizeQueryDetailed, likeContainsPattern } from "../../src/text/lexical-query";
import { DEFAULTS } from "../../src/config";
import { recallEntries } from "../../src/recall/search";
import { observeWorkersAiQuotaError } from "../../src/lib/ai";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const CASES = [
  ["ＳＢ－０２４", "sb-024"],
  ["ａｕｔｈ＿ｔｏｋｅｎ．ｖ１", "auth_token.v1"],
  ["２０２６－０９－０５", "2026-09-05"],
  ["ｖ１．９", "v1.9"],
  ["SB－０２４", "sb-024"],
  ["ｕｓｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ", "user@example.com"],
];
const open: SqliteD1[] = [];
afterEach(() => { open.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });

describe("full-width protected identifier probes", () => {
  it.each(CASES)("retains the exact surface %s beside %s", (surface, value) => {
    const token = tokenizeQueryDetailed(surface).find(term => term.value === value);
    expect(token).toMatchObject({ kind: "protected", probes: [value, surface] });
  });

  it("preserves Unicode whitespace boundaries and deduplicates repeated surfaces", () => {
    const tokens = tokenizeQueryDetailed("ＳＢ－０２４\uFEFFｖ１．９\u3000ＳＢ－０２４");
    expect(tokens.filter(term => term.value === "sb-024")).toEqual([
      { value: "sb-024", kind: "protected", probes: ["sb-024", "ＳＢ－０２４"] },
    ]);
    expect(tokens.find(term => term.value === "v1.9")?.probes).toEqual(["v1.9", "ｖ１．９"]);
  });

  it("does not turn compatibility probes into another tokenization or ranking policy", () => {
    for (const [surface] of CASES) {
      const shape = (text: string) => tokenizeQueryDetailed(text).map(({ value, kind }) => ({ value, kind }));
      expect(shape(surface)).toEqual(shape(surface.normalize("NFKC")));
    }
  });

  it("keeps overlong surfaces and many identifiers inside existing pattern/token bounds", () => {
    const query = `${"Ａ".repeat(60)}－１ ` + Array.from({ length: 40 }, (_, i) => `ＳＢ－${i}`).join(" ");
    const tokens = tokenizeQueryDetailed(query);
    expect(tokens.length).toBeLessThanOrEqual(KEYWORD_MAX_TOKENS);
    for (const token of tokens) for (const probe of token.probes) {
      expect(new TextEncoder().encode(likeContainsPattern(probe)).byteLength).toBeLessThanOrEqual(D1_MAX_LIKE_PATTERN_BYTES);
    }
  });

  it.each(CASES.slice(0, 4))("retrieves a stored %s through quota-mode SQLite recall", async (surface, normalized) => {
    const now = Date.UTC(2026, 8, 5, 12);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sqlite = makeSqliteD1(); open.push(sqlite);
    sqlite.seed({ id: "fullwidth-decision", content: `決定を ${surface} に記録した。`,
      createdAt: now - 180 * 86400000, tags: ["status:canonical"], importanceScore: 5 });
    for (let i = 0; i < 160; i++) sqlite.seed({ id: `noise-${i}`,
      content: `Routine ${normalized}x review.`, createdAt: now - i });
    const ai = vi.fn().mockRejectedValue(new Error("unexpected AI call"));
    const vector = vi.fn().mockRejectedValue(new Error("unexpected Vectorize call"));
    const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: makeMemoryKV(), AI: { run: ai } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({ query: vector }) }));
    await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: surface, topK: 5, hops: 0, synthesize: false },
      env, ctx, DEFAULTS, { diagnostics });
    await Promise.all(pending);
    expect(result.semanticUnavailableReason).toBe("workers_ai_quota_exhausted");
    expect(result.matches[0]?.id).toBe("fullwidth-decision");
    expect(diagnostics.keywordIds?.length ?? 0).toBeLessThanOrEqual(128);
    expect(diagnostics.operations?.d1RowsRead).toBeNull();
    expect(ai).not.toHaveBeenCalled();
    expect(vector).not.toHaveBeenCalled();
  });
});
