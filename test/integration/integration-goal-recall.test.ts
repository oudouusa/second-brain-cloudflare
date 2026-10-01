/** INTEGRATION_GOAL D: exercise the real pipeline, not another scorer. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { recallEntries } from "../../src/recall/search";
import { observeWorkersAiQuotaError } from "../../src/lib/ai";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";
import type { Identity } from "../../src/lib/identity";
import { summarizeResults } from "../../benchmarks/recall-v1/evaluate.mjs";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const NOW = Date.UTC(2026, 8, 5, 12);
const OLD = NOW - 180 * 86_400_000;
const ANSWER = "old-decision";
type Mode = "healthy" | "quota" | "embedding-failure" | "vector-failure";
const MODES = ["healthy", "quota", "vector-failure"] as const;
const LANGUAGES = ["en", "ja"] as const;
const open: SqliteD1[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  // waitUntil may append another task while draining (admission release).
  for (let i = 0; i < pending.length; i++) await pending[i];
  pending.length = 0;
  open.splice(0).forEach(db => db.close());
  vi.restoreAllMocks();
});

async function fixture(noise: number, language: "en" | "ja", mode: Mode) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const sqlite = makeSqliteD1(); open.push(sqlite);
  const query = language === "ja" ? "認証 SB-024" : "cat";
  sqlite.seed({ id: ANSWER, content: language === "ja"
    ? "認証方式はパスキーとする。決定 SB-024。"
    : "The cat adoption decision is approved. Record SB-024.",
    createdAt: OLD, importanceScore: 5, tags: ["kind:semantic", "status:canonical"] });
  for (let i = 0; i < noise; i++) sqlite.seed({ id: `noise-${i}`,
    content: language === "ja" ? "認証 SB-024x 定例確認。" : "We concatenate the routine fields.",
    createdAt: NOW - i - 1 });
  const vector = vi.fn().mockResolvedValue({ matches: [{ id: `v-${ANSWER}`, score: .99,
    metadata: { parentId: ANSWER, created_at: OLD, workspace_id: "own" }, values: new Array(128).fill(.1) }] });
  if (mode === "vector-failure") vector.mockRejectedValue(new Error("test: vector unavailable"));
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vector }),
  }));
  if (mode === "quota") await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));
  if (mode === "embedding-failure") vi.mocked(env.AI.run).mockRejectedValue(new Error("test: embedding unavailable"));
  return { sqlite, env, vector, query, async recall(
    text = query,
    options: { hops?: number; after?: number; before?: number } = {},
    internal: RecallInternalOptions = {},
  ) {
    sqlite.issued.length = 0;
    const diagnostics: RecallDiagnostics = {};
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
    const result = await recallEntries({ query: text, topK: 5, hops: 0, synthesize: false, ...options },
      env, ctx, DEFAULTS, { ...internal, diagnostics });
    for (let i = 0; i < pending.length; i++) await pending[i];
    const candidateSelects = sqlite.issued.filter(sql => sql.startsWith("SELECT id, content, tags, source, created_at FROM entries WHERE") || sql.startsWith("WITH s AS MATERIALIZED (SELECT id, created_at, tags, source, lower(content) AS lc"));
    expect(diagnostics.keywordIds?.length ?? 0).toBeLessThanOrEqual(128);
    expect(new Set(diagnostics.keywordIds).size).toBe(diagnostics.keywordIds?.length ?? 0);
    expect(candidateSelects.length).toBeLessThanOrEqual(2);
    expect(diagnostics.operations?.d1RowsRead).toBeNull();
    return { result, diagnostics, candidateSelects };
  } };
}

const AGING = MODES.flatMap(mode => LANGUAGES.flatMap(language =>
  // Fixed dataset positions, deliberately not calculated from the configured cap.
  [120, 129, 161].map(position => ({ mode, language, position }))));

describe("integration goal: distinguish dense rescue from lexical rescue", () => {
  it("keeps the SB-024。 decision ahead of newer SB-024x noise when embedding is unavailable", async () => {
    const f = await fixture(160, "ja", "quota");
    const { result, diagnostics } = await f.recall("SB-024。");
    expect(diagnostics.keywordIds).toContain(ANSWER);
    expect(result.matches[0]?.id).toBe(ANSWER);
  });

  it.each(AGING)("$mode/$language at fixed recency position $position", async ({ mode, language, position }) => {
    const f = await fixture(position - 1, language, mode);
    const { result, diagnostics, candidateSelects } = await f.recall();
    expect(DEFAULTS.KEYWORD_CANDIDATE_LIMIT).toBe(128);
    expect(diagnostics.candidateIds).toContain(ANSWER);
    expect(result.matches[0]?.id).toBe(ANSWER);
    if (mode === "healthy") {
      // Controlled dense candidates test the pipeline contract, not live model quality.
      expect(result.semanticUnavailable).toBe(false);
      expect(diagnostics.denseIds).toContain(ANSWER);
      expect(diagnostics.keywordIds?.includes(ANSWER)).toBe(position <= 128);
      expect(candidateSelects).toHaveLength(1);
      expect(f.vector).toHaveBeenCalledTimes(1);
      expect(f.vector.mock.calls[0][0]).toHaveLength(128);
    } else {
      expect(result.semanticUnavailableReason).toBe(mode === "quota"
        ? "workers_ai_quota_exhausted" : "vectorize_unavailable");
      expect(diagnostics.denseIds).toEqual([]);
      expect(diagnostics.keywordIds).toContain(ANSWER);
      expect(candidateSelects).toHaveLength(2);
      if (mode === "quota") {
        expect(f.env.AI.run).not.toHaveBeenCalled();
        expect(f.vector).not.toHaveBeenCalled();
      } else {
        expect(f.vector).toHaveBeenCalledTimes(1);
      }
    }
  });

  it.each(["。cat。", "、cat、", "前文。cat、後文"])("admits Japanese sentence separators: %s", async content => {
    const f = await fixture(160, "en", "quota");
    await f.sqlite.db.prepare("UPDATE entries SET content = ? WHERE id = ?").bind(content, ANSWER).run();
    const { result, diagnostics } = await f.recall();
    expect(diagnostics.keywordIds).toContain(ANSWER);
    expect(result.matches[0]?.id).toBe(ANSWER);
  });

  it.each(["漢cat", "cat字", "écat", "caté"])("does not manufacture a boundary at a Unicode letter: %s", async content => {
    const f = await fixture(160, "en", "quota");
    await f.sqlite.db.prepare("UPDATE entries SET content = ? WHERE id = ?").bind(content, ANSWER).run();
    const { diagnostics } = await f.recall();
    expect(diagnostics.keywordIds).not.toContain(ANSWER);
  });

  it.each(LANGUAGES)("uses the same bounded fallback for an embedding failure (%s)", async language => {
    const f = await fixture(160, language, "embedding-failure");
    const { result, diagnostics, candidateSelects } = await f.recall();
    expect(result.semanticUnavailableReason).toBe("embedding_unavailable");
    expect(diagnostics.keywordIds).toContain(ANSWER);
    expect(result.matches[0]?.id).toBe(ANSWER);
    expect(candidateSelects).toHaveLength(2);
    expect(f.vector).not.toHaveBeenCalled();
  });

  it.each(LANGUAGES)("rescues the old answer after a late Vectorize failure (%s)", async language => {
    const f = await fixture(160, language, "vector-failure");
    const { result, diagnostics, candidateSelects } = await f.recall();
    expect(result.semanticUnavailableReason).toBe("vectorize_unavailable");
    expect(candidateSelects).toHaveLength(2);
    expect(diagnostics.denseIds).toEqual([]);
    expect(diagnostics.keywordIds).toContain(ANSWER);
    expect(diagnostics.candidateIds).toContain(ANSWER);
    expect(result.matches[0]?.id).toBe(ANSWER);
  });
});

describe("integration goal: time, current decision and workspace boundaries", () => {
  it.each(MODES)("keeps inclusive after/exclusive before and excludes deprecated decisions (%s)", async mode => {
    const f = await fixture(160, "ja", mode);
    for (const [id, createdAt, tags] of [
      ["too-early", OLD - 1, ["kind:semantic"]],
      ["at-before", OLD + 2, ["kind:semantic"]],
      ["deprecated", OLD + 1, ["kind:semantic", "status:deprecated"]],
    ] as const) f.sqlite.seed({ id, createdAt, tags: [...tags],
      content: "認証 SB-024 は旧パスワード方式とする。", importanceScore: 5 });
    const { result, diagnostics } = await f.recall("現在の認証 SB-024", { after: OLD, before: OLD + 2, hops: 1 });
    expect(diagnostics.keywordIds).toContain(ANSWER);
    expect(diagnostics.keywordIds).toContain("deprecated");
    expect(diagnostics.keywordIds).not.toContain("too-early");
    expect(diagnostics.keywordIds).not.toContain("at-before");
    expect(result.matches[0]?.id).toBe(ANSWER);
    expect(result.matches.some(row => ["too-early", "at-before", "deprecated"].includes(row.id))).toBe(false);
  });

  it.each(MODES)("does not spend lexical slots on foreign rows or walk a foreign graph bridge (%s)", async mode => {
    const f = await fixture(160, "en", mode);
    await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE 1").bind("own").run();
    for (let i = 0; i < 160; i++) {
      f.sqlite.seed({ id: `foreign-${i}`, content: "cat approved decision", createdAt: NOW + i });
      await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind("foreign", `foreign-${i}`).run();
    }
    for (const id of ["readable-evidence", "behind-foreign-bridge"]) {
      f.sqlite.seed({ id, content: "Supporting adoption evidence.", createdAt: OLD + 1 });
      await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind("own", id).run();
    }
    for (const [from, to] of [[ANSWER, "readable-evidence"], [ANSWER, "foreign-0"], ["foreign-0", "behind-foreign-bridge"]]) {
      await f.sqlite.db.prepare(`INSERT INTO edges
        (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
        VALUES (?, ?, ?, 'caused_by', .9, 'system', '{}', ?, ?, 'own')`)
        .bind(`${from}-${to}`, from, to, NOW, NOW).run();
    }
    const identity: Identity = { userId: "member", role: "member", personalWorkspaceId: "own",
      companyWorkspaceIds: [], defaultShare: "" };
    const { result, diagnostics } = await f.recall("cat", { hops: 2 }, { identity });
    expect(diagnostics.keywordIds).toHaveLength(128);
    expect(diagnostics.keywordIds?.some(id => id.startsWith("foreign-"))).toBe(false);
    expect(diagnostics.expandedIds).toContain("readable-evidence");
    expect(diagnostics.expandedIds).not.toContain("foreign-0");
    expect(diagnostics.expandedIds).not.toContain("behind-foreign-bridge");
    expect(result.matches.some(row => row.id.startsWith("foreign-") || row.id === "behind-foreign-bridge")).toBe(false);
    expect(result.matches.map(row => row.id)).toContain(ANSWER);
  });
});

describe("integration goal: no-answer evaluation is not a retrieval win", () => {
  it.each(["unobtainium-9f872e", "ncat"])("measures returned distractors separately for %s", async query => {
    const f = await fixture(160, "en", "quota");
    const { result } = await f.recall(query);
    const rank = result.matches.findIndex(row => row.id === "answer-not-in-corpus") + 1;
    const summary = summarizeResults([{ category: "identifier", rank, mustPass: true }]);
    expect(summary.overall).toEqual({ queries: 1, recallAt1: 0, recallAt5: 0, mrr: 0 });
    expect(summary.mustPass.passedTop5).toBe(0);
    const returnedDistractors = result.matches.length;
    // Empty literal and nonempty substring fallback are different outcomes.
    // Do not turn "no gold answer" into a new promise to always return nothing.
    if (query === "ncat") expect(returnedDistractors).toBeGreaterThan(0);
    else expect(returnedDistractors).toBe(0);
    expect(returnedDistractors).toBeLessThanOrEqual(5);
  });
});
