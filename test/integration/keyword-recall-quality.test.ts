/**
 * Keyword-arm recall quality: the three LIKE-era defects, each pinned by an
 * observable ranking outcome rather than an implementation detail.
 *
 * 1. `ORDER BY created_at DESC LIMIT 100` silently returned the newest 100
 *    candidates, not the best 100 — a strong match older than 100 fresher
 *    substring hits could never enter the candidate set.
 * 2. Substring matching scored "concatenate" as evidence for "cat" at full
 *    weight, so noise outranked genuine word matches of equal recency.
 * 3. Relevance (IDF) was re-estimated from the fetched rows — a sample biased
 *    by recency and capped by the LIMIT — when the corpus-wide frequencies had
 *    already been computed by distillToRareTerms in the same request.
 *
 * Every test forces the dense arm down (VECTORIZE.query rejects) so the
 * keyword arm's ranking is the whole observable result, and seeds equal or
 * controlled created_at so recency decay cannot mask the scoring change.
 */
import { describe, it, expect, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { CONFIG_KEY, DEFAULTS } from "../../src/config";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { readDerivedStateGeneration } from "../../src/migration/write-lock";
import { getTagVocabulary, TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return { ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext };
}

function seed(db: D1Mock, id: string, content: string, created_at: number) {
  db.entries.push({
    id, content, tags: "[]", source: "api", created_at,
    vector_ids: "[]", recall_count: 0, importance_score: 0,
  });
}

/** Env whose dense arm always fails, isolating the keyword arm. */
function keywordOnlyEnv(db: D1Mock, overrides?: Record<string, unknown>) {
  const kv = makeMemoryKV();
  const env = makeTestEnv(db, {
    OAUTH_KV: kv,
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockRejectedValue(new Error("index unavailable")),
    }),
  });
  const seedConfig = async () => { if (overrides) await kv.put(CONFIG_KEY, JSON.stringify(overrides)); };
  return { env, seedConfig };
}

/**
 * The shared D1Mock deliberately has no handler for distillToRareTerms'
 * frequency aggregate (`SELECT COUNT(*) AS total, SUM(CASE WHEN content LIKE
 * …)`), so distill falls back and fusion sees no corpus stats — which is also
 * what keeps the other 37 mock consumers on their existing behaviour. This
 * wrapper answers that one query from db.entries, locally to this file, so the
 * corpus-IDF path can be exercised end to end.
 */
function answerFrequencyAggregate(db: D1Mock) {
  const orig = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.includes("AS total") && s.includes("SUM(CASE WHEN content LIKE")) {
      return {
        bind: (...args: unknown[]) => ({
          first: async () => {
            const row: Record<string, number> = { total: db.entries.length };
            args
              .map(a => String(a).replace(/^%|%$/g, "").toLowerCase())
              .forEach((p, i) => {
                row[`d${i}`] = db.entries.filter((e: any) => String(e.content).toLowerCase().includes(p)).length;
              });
            return row;
          },
        }),
      };
    }
    return orig(sql);
  };
}

describe("keyword candidate limit", () => {
  it("a word-boundary match buried past the old 100-newest window now wins", async () => {
    const db = makeTestDb();
    // 119 fresher rows that only substring-match "cat"; the one genuine match
    // is seeded last and oldest-in-window, i.e. position 120 by recency —
    // outside the old LIMIT 100 fetch entirely.
    for (let i = 0; i < 119; i++) seed(db, `noise-${i}`, "we concatenate the fields", 1000);
    seed(db, "genuine", "my cat sleeps here", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "cat", topK: 3, synthesize: false }, env, ctx);

    expect(res.semanticUnavailable).toBe(true);
    expect(res.matches[0]?.id).toBe("genuine");
    // Re-weighting, not filtering: substring hits still fill the tail.
    expect(res.matches.length).toBe(3);
  });

  it("KEYWORD_CANDIDATE_LIMIT is honoured as a config override", async () => {
    const db = makeTestDb();
    // 50 fresher substring-only rows, then the genuine match older than all of
    // them. An override of 50 (the rule's floor) truncates the fetch window to
    // exactly the noise, so the genuine row cannot appear at all — observable
    // proof the bound limit comes from config, not the shipped constant (100
    // would admit all 52 rows and the genuine row would win the top slot).
    for (let i = 0; i < 50; i++) seed(db, `noise-${i}`, "we concatenate the fields", 1000);
    seed(db, "genuine", "my cat sleeps here", 500);

    const { env, seedConfig } = keywordOnlyEnv(db, { KEYWORD_CANDIDATE_LIMIT: 50 });
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "cat", topK: 10, synthesize: false }, env, ctx);

    expect(res.matches.map(m => m.id)).not.toContain("genuine");
  });

  it("keeps a decisive tail token in a long keyword-only query", async () => {
    const db = makeTestDb();
    seed(db, "tail-hit", "the decisive-tail-anchor is recorded here", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();
    const query = [
      ...Array.from({ length: 20 }, (_, i) => `leading${i}`),
      "decisive-tail-anchor",
    ].join(" ");

    const res = await recallEntries({ query, topK: 1, synthesize: false }, env, ctx);

    expect(res.matches[0]?.id).toBe("tail-hit");
  });
});

describe("substring down-weighting", () => {
  it("a word match outranks a substring match of equal recency, without dropping it", async () => {
    const db = makeTestDb();
    seed(db, "substr", "we concatenate the fields", 1000);
    seed(db, "word", "my cat sleeps here", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "cat", topK: 10, synthesize: false }, env, ctx);

    expect(res.matches.map(m => m.id)).toEqual(["word", "substr"]);
  });

  it("identifier-shaped tokens still match on word boundaries", async () => {
    const db = makeTestDb();
    seed(db, "issue", "see issue #149 for the fix", 1000);
    seed(db, "noise", "phone number 5551490000 on file", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "#149", topK: 10, synthesize: false }, env, ctx);

    expect(res.matches[0]?.id).toBe("issue");
  });

  it("SUBSTRING_MATCH_WEIGHT: 1 restores the old parity, proving the knob threads", async () => {
    const db = makeTestDb();
    // The substring row is fresher; at equal weight the tie breaks on recency
    // and the noise wins again — exactly the pre-change behaviour.
    seed(db, "substr", "we concatenate the fields", 2000);
    seed(db, "word", "my cat sleeps here", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db, { SUBSTRING_MATCH_WEIGHT: 1 });
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "cat", topK: 10, synthesize: false }, env, ctx);

    expect(res.matches[0]?.id).toBe("substr");
  });

  it("down-weights a fallback CJK bigram inside a longer CJK run", async () => {
    const db = makeTestDb();
    seed(db, "noise", "監査未登方針", 2000);
    seed(db, "exact", "未登", 1000);
    answerFrequencyAggregate(db);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "未登録", topK: 2, synthesize: false }, env, ctx);

    expect(res.matches.map(match => match.id)).toEqual(["exact", "noise"]);
  });

  it("retrieves an exact full-width surface through its raw compatibility probe", async () => {
    const db = makeTestDb();
    seed(db, "full-width", `unrelated prefix ${" filler".repeat(80)} Ｃｌｏｕｄｆｌａｒｅ設定`, 1000);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({
      query: "Ｃｌｏｕｄｆｌａｒｅ",
      topK: 1,
      synthesize: false,
    }, env, ctx);

    expect(res.matches[0]?.id).toBe("full-width");
  });
});

describe("corpus-wide IDF", () => {
  it("ranks by corpus rarity even when the fetched sample says the opposite", async () => {
    const db = makeTestDb();
    // The fetch window is pinned to 100 rows (config override — also what the
    // pre-config constant shipped), and the corpus is arranged so the window
    // disagrees with the truth. In the window: alpha appears twice, beta 8
    // times, gamma 90 times → a window-sample IDF calls alpha the rare term.
    // In the corpus: alpha is in 120 rows, beta in 8, gamma in 90 → beta is
    // the rare term. Only corpus-wide IDF ranks the beta row first.
    seed(db, "alpha-hit", "alpha memo", 1000);
    seed(db, "alpha-hit-2", "alpha note", 999);
    for (let i = 0; i < 8; i++) seed(db, `beta-${i}`, "beta report", 990 - i);
    for (let i = 0; i < 90; i++) seed(db, `gamma-${i}`, "gamma worklog", 500 - i);
    // Older than the 100-row window: the alpha bulk the sample never sees.
    for (let i = 0; i < 118; i++) seed(db, `alpha-old-${i}`, "alpha archive", 100 - (i % 90));
    // Filler keeps alpha under the 30% saturation cut so distill retains all terms.
    for (let i = 0; i < 190; i++) seed(db, `filler-${i}`, "unrelated filler", 10);
    answerFrequencyAggregate(db);

    const { env, seedConfig } = keywordOnlyEnv(db, { KEYWORD_CANDIDATE_LIMIT: 100 });
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "alpha beta gamma", topK: 5, synthesize: false }, env, ctx);

    // Corpus IDF: idf(beta) = log(1+408/9) ≈ 3.8 ≫ idf(alpha) = log(1+408/121)
    // ≈ 1.5 — the beta row must lead. Window-sample IDF inverts it: df(alpha)=2
    // in 100 rows → log(1+100/3) ≈ 3.5 ≫ df(beta)=8 → log(1+100/9) ≈ 2.5,
    // which puts alpha-hit first. matches[0] is the whole verdict.
    expect(res.matches[0]?.id).toBe("beta-0");
  });

  it("without corpus stats, fusion still ranks (sample fallback)", async () => {
    const db = makeTestDb();
    seed(db, "common-hit", "alpha memo", 1000);
    seed(db, "rare-hit", "beta report", 1000);
    seed(db, "alpha-2", "alpha note", 999);
    seed(db, "alpha-3", "alpha list", 998);
    // No answerFrequencyAggregate → distill falls back, df/total are null.

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "alpha beta", topK: 5, synthesize: false }, env, ctx);

    // Sample IDF over the 4 fetched rows: beta (df 1) beats alpha (df 3).
    expect(res.matches[0]?.id).toBe("rare-hit");
    expect(res.matches.length).toBe(4);
  });
});

describe("append-grown memory locality", () => {
  it("prefers one coherent passage over query terms scattered across distant updates", async () => {
    const db = makeTestDb();
    const gap = " unrelated filler".repeat(60);

    // A broad project history can mention every query term, but in unrelated
    // updates hundreds of characters apart. Before query-local keyword
    // scoring, that whole-entry token union tied the focused memory and its
    // newer timestamp incorrectly put it first.
    seed(
      db,
      "broad-history",
      `EmbeddingGemma was evaluated.${gap}\n[Update 2026-01-02]\nA separate project shipped.${gap}\n[Update 2026-01-03]\nOld vectors were pruned.`,
      2000,
    );
    seed(
      db,
      "focused-decision",
      "For this project, EmbeddingGemma recall was fixed by pruning stale vectors.",
      1000,
    );

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries(
      { query: "EmbeddingGemma project vectors", topK: 2, synthesize: false },
      env,
      ctx,
    );

    expect(res.matches[0]?.id).toBe("focused-decision");
    expect(res.matches.map(match => match.id)).toContain("broad-history");
  });

  it("does not penalize a long memory when its best passage is coherent", async () => {
    const db = makeTestDb();
    const gap = " unrelated filler".repeat(60);
    seed(
      db,
      "coherent-history",
      `${gap}\n[Update 2026-01-03]\nFor this project, EmbeddingGemma recall was fixed by pruning stale vectors.`,
      2000,
    );
    seed(db, "partial-note", "EmbeddingGemma was evaluated for another task.", 1000);

    const { env, seedConfig } = keywordOnlyEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries(
      { query: "EmbeddingGemma project vectors", topK: 2, synthesize: false },
      env,
      ctx,
    );

    expect(res.matches[0]?.id).toBe("coherent-history");
  });

  it("keeps a lexically supported short update ahead of an unrelated dense root", async () => {
    const db = makeTestDb();
    const gap = " unrelated history".repeat(60);
    seed(
      db,
      "relevant-history",
      `${gap}\n[Update 2026-01-03]\nダッシュボードとMCPは同じCloudflare Accessログインを使う。`,
      1000,
    );
    db.entries[0].tags = JSON.stringify(["duplicate-candidate"]);
    seed(db, "unrelated-root", "Wardrobe asset architecture and approval flow.", 1000);
    // These surface-only bigrams occur in the corpus but not in the relevant
    // memory. The query also produces an absent cross-boundary bigram (じロ).
    seed(db, "particle-distractor", "カードとログインの課題", 900);
    answerFrequencyAggregate(db);

    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: "unrelated-root",
              score: 0.95,
              metadata: { parentId: "unrelated-root", content: "Wardrobe asset architecture and approval flow." },
            },
            {
              id: "relevant-history-update-1",
              score: 0.9,
              metadata: {
                parentId: "relevant-history",
                isUpdate: true,
                content: "ダッシュボードとMCPは同じCloudflare Accessログインを使う。",
              },
            },
          ],
        }),
      }),
    });
    const { ctx } = makeCtx();

    const res = await recallEntries(
      {
        query: "ダッシュボードとMCPを同じログインのCloudflare Accessにした最終構成は？",
        topK: 3,
        synthesize: false,
      },
      env,
      ctx,
    );

    expect(res.matches[0]?.id).toBe("relevant-history");
  });
});

describe("hybrid arm calibration", () => {
  function hybridFixture(
    denseScore: number,
    semanticContent = "VestaOS camisole garment-shape decision",
    distractorImportance = 5,
  ) {
    const db = makeTestDb();
    seed(db, "semantic-root", semanticContent, 1000);
    db.entries[0].tags = JSON.stringify(["vestaos"]);
    db.entries[0].importance_score = 3;
    db.entries[0].recall_count = 85;
    seed(db, "lexical-distractor", "configurable visible range for an unrelated dashboard", 1000);
    db.entries[1].importance_score = distractorImportance;
    db.entries[1].recall_count = 87;
    answerFrequencyAggregate(db);

    const query = vi.fn().mockResolvedValue({
      matches: [{
        id: "semantic-root-vector",
        score: denseScore,
        metadata: {
          parentId: "semantic-root",
          created_at: 1000,
          tags: ["vestaos"],
          content: semanticContent,
        },
      }],
    });
    const env = makeTestEnv(db, {
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query }),
    });
    return { env, query };
  }

  it("keeps a calibrated strong dense hit ahead of a summed-IDF keyword-only distractor", async () => {
    // Production analogue: raw Vectorize ranked the requested VestaOS memory
    // first at 0.67, but three individually rare generic words accumulated
    // three full RRF votes and let a higher-importance unrelated memory erase
    // that semantic win during final reranking.
    const { env } = hybridFixture(0.67, "camisole garment-shape decision", 4);
    // Production's cached distilled-query signals contained no topic tags. Pin
    // that state so this regression exercises the full-query dense anchor, not
    // inferQueryTags independently rediscovering VestaOS from the vocabulary.
    const generation = await readDerivedStateGeneration(env);
    await env.OAUTH_KV.put(TAG_VOCABULARY_KEY, JSON.stringify({
      tags: [],
      rebuiltAt: Date.now(),
      generation,
    }));
    expect(await getTagVocabulary(env)).toEqual([]);
    const { ctx } = makeCtx();

    const res = await recallEntries(
      { query: "configurable visible range in VestaOS", topK: 2, synthesize: false },
      env,
      ctx,
    );

    expect(res.matches.map(match => match.id)).toEqual([
      "semantic-root",
      "lexical-distractor",
    ]);
  });

  it("keeps full lexical rescue strength when the dense arm is below calibration", async () => {
    const { env, query } = hybridFixture(0.59);
    const { ctx } = makeCtx();

    const res = await recallEntries(
      { query: "configurable visible range in VestaOS", topK: 2, synthesize: false },
      env,
      ctx,
    );

    expect(res.matches[0]?.id).toBe("lexical-distractor");
    // A weak top score still uses the existing widened semantic query before
    // the lexical arm is allowed to decide the result.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not weaken lexical rescue when the query names no topic tag on the strong dense hit", async () => {
    const { env, query } = hybridFixture(0.67);
    const { ctx } = makeCtx();

    const res = await recallEntries(
      { query: "configurable visible range for a dashboard", topK: 2, synthesize: false },
      env,
      ctx,
    );

    expect(res.matches[0]?.id).toBe("lexical-distractor");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("tagged current-state calibration", () => {
  it.each([
    ["latest Orion deployment configurable visible range", 0.72, true, {}],
    ["Orion deployment configurable visible range", 0.72, false, {}],
    ["why change the latest Orion deployment configurable visible range", 0.72, false, {}],
    ["latest Orion deployment configurable visible range", 0.40, false, {}],
    ["latest Orion deployment configurable visible range", 0.72, true, { after: 0 }],
    ["latest Orion deployment configurable visible range", 0.72, true, { before: Date.UTC(2100, 0) }],
  ] as [string, number, boolean, { after?: number; before?: number }][])("keeps bounded status evidence for %s at dense strength %s", async (queryText, strength, rescued, bounds) => {
    const { makeSqliteD1 } = await import("../helpers/sqlite-d1");
    const sqlite = makeSqliteD1();
    // Many semantically related notes precede six generic lexical distractors.
    // Isolate fusion from MMR below; private replay also exercises default MMR.
    const vectors: VectorizeVector[] = [];
    for (let index = 0; index < 86; index++) {
      const id = `entry-${index}`;
      const content = index === 0 ? "Orion deployment is accepted: configurable visible controls."
        : index < 80 ? "Orion deployment notes."
        : "configurable visible range for an unrelated dashboard";
      sqlite.seed({ id, content, tags: ["orion"], createdAt: Date.now(), vectorIds: [id] });
      const score = index < 80 ? strength - index * 0.001 : 0.1;
      const values = Array(128).fill(score / Math.sqrt(128));
      values[0] += Math.sqrt(1 - score * score) / Math.sqrt(2);
      values[1] -= Math.sqrt(1 - score * score) / Math.sqrt(2);
      vectors.push({ id, values, metadata: { parentId: id, content, tags: ["orion"], created_at: Date.now() } });
    }
    const pending: Promise<unknown>[] = [];
    const env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ getByIds: vi.fn(async ids => vectors.filter(v => ids.includes(v.id))) }),
    }));
    try {
      const result = await recallEntries(
        { query: queryText, tag: "orion", topK: 5, synthesize: false, ...bounds },
        env, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
        { ...DEFAULTS, MMR_LAMBDA: 1 },
      );
      await Promise.all(pending);
      expect(result.matches.some(match => match.id === "entry-0")).toBe(rescued);
      expect(env.VECTORIZE.query).not.toHaveBeenCalled();
      expect(env.VECTORIZE.getByIds).toHaveBeenCalledTimes(5);
      if (queryText.startsWith("latest") && bounds.after === undefined && bounds.before === undefined) {
        expect(result.currentQueryTokens).toContain("configurable");
        // Ubiquitous topic words cannot alone justify replacing a focused excerpt.
        expect(result.currentQueryTokens).not.toContain("orion");
      } else {
        expect(result.currentQueryTokens).toBeUndefined();
      }
    } finally { sqlite.close(); }
  });
});

// 通常LIKEの上流候補窓と、forkの局所passage評価を実SQLで同時に検証する。
describe("長い追記履歴の局所評価（実SQLite）", () => {
  it.each([false, true])("Vectorize障害=%sでも一貫したpassageを優先する", async failure => {
    const sqlite = makeSqliteD1();
    const pending: Promise<unknown>[] = [];
    try {
      const gap = " unrelated filler".repeat(60);
      sqlite.seed({ id: "broad-history", content: `EmbeddingGemma was evaluated.${gap}\n[Update 2026-01-02]\nA separate project shipped.${gap}\n[Update 2026-01-03]\nOld vectors were pruned.`, createdAt: 2000 });
      sqlite.seed({ id: "focused-decision", content: "For this project, EmbeddingGemma recall was fixed by pruning stale vectors.", createdAt: 1000 });
      const query = failure ? vi.fn().mockRejectedValue(new Error("index unavailable")) : vi.fn().mockResolvedValue({ matches: [] });
      const env = sqlite.admitEnv(makeTestEnv(undefined, {
        DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock({ query }),
      }));
      const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
      const res = await recallEntries({ query: "EmbeddingGemma project vectors", topK: 2, synthesize: false }, env, ctx,
        { ...DEFAULTS, RERANK_MODE: "off" });
      expect(res.matches[0]?.id).toBe("focused-decision");
      expect(res.matches.map(match => match.id)).toContain("broad-history");
    } finally {
      for (const task of pending) await task;
      sqlite.close();
    }
  });
});
