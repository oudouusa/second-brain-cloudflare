import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { DEFAULT_EMBEDDING_QUERY_MODE } from "../../src/recall/query-profile";
import { recallEntries } from "../../src/recall/search";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { resetStandingIsolateState } from "../../src/standing/cache";
import type { RecallDiagnostics } from "../../src/recall/types";
import { D1Mock } from "../helpers/d1-mock";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const seed = (db: D1Mock, id: string, content: string, tags: string[] = []) =>
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
const edge = (db: D1Mock, source_id: string, target_id: string) =>
  db.edges.push({ id: `${source_id}-${target_id}`, source_id, target_id, type: "decided", weight: 1, provenance: "explicit", metadata: "{}", created_at: 1, updated_at: 1 });

describe("recall root selection", () => {
  it("records the complete bounded candidate funnel without changing results", async () => {
    const build = () => {
      const db = new D1Mock();
      seed(db, "dense-root", "atlas ledger root", ["work"]);
      seed(db, "keyword-root", "atlas ledger reconciliation decision", ["work"]);
      seed(db, "eligible", "atlas ledger changed because reconciliation was required", ["work"]);
      seed(db, "weak", "grocery list", ["personal"]);
      edge(db, "dense-root", "eligible");
      edge(db, "dense-root", "weak");
      const prepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        if (/WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)) {
          return { bind: () => ({ all: async () => ({ results: db.entries
            .filter(entry => ["dense-root", "keyword-root"].includes(entry.id))
            .map(({ id, content, tags, source, created_at }) => ({ id, content, tags, source, created_at })) }) }) };
        }
        return prepare(sql);
      };
      const vectorQuery = vi.fn().mockResolvedValue({
        matches: [{ id: "dense-root", score: .9, metadata: { parentId: "dense-root" } }],
      });
      const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vectorQuery }) });
      return { db, env, vectorQuery };
    };

    const ordinary = build();
    const observed = build();
    const ordinaryPrepare = vi.spyOn(ordinary.db, "prepare");
    const observedPrepare = vi.spyOn(observed.db, "prepare");
    const diagnostics: RecallDiagnostics = {};

    // The readiness answer is cached per isolate for FTS_READY_CACHE_MS, and the standing cache's
    // own read is memoized the same way (STANDING_ISOLATE_MEMO_MS) — both module-level, so a key
    // this test's two DIFFERENT env/KV instances happen to share ("" workspace) would otherwise let
    // the second call ride the first's warm memo. Reset both so both recalls start cold and the get
    // counts stay comparable.
    resetFtsReadyMemo();
    resetStandingIsolateState();
    const ordinaryResult = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 1, synthesize: false },
      ordinary.env,
      ctx,
    );
    resetFtsReadyMemo();
    resetStandingIsolateState();
    const observedResult = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 1, synthesize: false },
      observed.env,
      ctx,
      undefined,
      { diagnostics },
    );

    expect(diagnostics.denseIds).toEqual(["dense-root"]);
    expect(diagnostics.keywordIds).toEqual(expect.arrayContaining(["dense-root", "keyword-root"]));
    expect(diagnostics.fusedIds).toEqual(expect.arrayContaining(["dense-root", "keyword-root"]));
    expect(diagnostics.rootSelections?.map(x => x.id)).toContain("dense-root");
    expect(diagnostics.expandedIds).toEqual(expect.arrayContaining(["eligible", "weak"]));
    expect(diagnostics.eligibleRelatedIds).toContain("eligible");
    expect(diagnostics.rejections).toContainEqual({ id: "weak", reason: "no-linked-evidence" });
    expect(diagnostics.finalIds).toEqual(observedResult.matches.map(x => x.id));
    expect(diagnostics.operations?.embeddingCalls).toBe(1);
    expect(Object.keys(diagnostics.stageMs ?? {}).sort()).toEqual([
      "candidateGeneration", "candidateHydration", "finalHydration", "graphExpansion",
      "querySignals", "selection", "setup", "synthesis", "total",
    ]);
    expect(Object.values(diagnostics.stageMs ?? {}).every(value => value >= 0)).toBe(true);
    expect(diagnostics.stageMs?.total).toBeGreaterThanOrEqual(
      Math.max(...Object.entries(diagnostics.stageMs ?? {})
        .filter(([stage]) => stage !== "total")
        .map(([, value]) => value)),
    );

    expect(observedResult.matches.map(x => x.id)).toEqual(ordinaryResult.matches.map(x => x.id));
    expect(observed.env.AI.run).toHaveBeenCalledTimes((ordinary.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.length);
    expect(observed.vectorQuery).toHaveBeenCalledTimes(ordinary.vectorQuery.mock.calls.length);
    expect(observedPrepare).toHaveBeenCalledTimes(ordinaryPrepare.mock.calls.length);
    expect(observed.env.OAUTH_KV.get).toHaveBeenCalledTimes((ordinary.env.OAUTH_KV.get as ReturnType<typeof vi.fn>).mock.calls.length);
  });

  it("selects a rare lexical root crowded below semantic leaders", async () => {
    const db = new D1Mock();
    for (let i = 0; i < 16; i++) seed(db, `semantic-${i}`, `general summary ${i}`);
    seed(db, "ledger-root", "ledger status changed", ["work"]);
    seed(db, "ledger-answer", "The ledger reconciliation decision fixed the status", ["work"]);
    edge(db, "ledger-root", "ledger-answer");
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => /WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
    const diagnostics: RecallDiagnostics = {};
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      ...Array.from({ length: 16 }, (_, i) => ({ id: `semantic-${i}`, score: .95 - i * .01, metadata: { parentId: `semantic-${i}` } })),
      { id: "ledger-root", score: .5, metadata: { parentId: "ledger-root" } },
    ] }) }) });

    const result = await recallEntries({ query: "why did the ledger reconciliation status change", topK: 5, hops: 1, synthesize: false }, env, ctx, undefined, { diagnostics });
    expect(diagnostics.rootSelections).toContainEqual({ id: "ledger-root", selectedBy: "lexical" });
    expect(result.matches.map(x => x.id)).toContain("ledger-answer");
  });

  it("backfills the fifth direct result when every neighborhood abstains", async () => {
    const db = new D1Mock();
    for (let i = 0; i < 5; i++) seed(db, `d${i}`, `direct status result ${i}`, ["work"]);
    seed(db, "unrelated-neighbor", "grocery list");
    edge(db, "d0", "unrelated-neighbor");
    const diagnostics: RecallDiagnostics = {};
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, score: .9 - i * .01, metadata: { parentId: `d${i}` } })) }) }) });

    const result = await recallEntries({ query: "status work", topK: 5, hops: 1, synthesize: false }, env, ctx, undefined, { diagnostics });
    expect(result.matches.map(x => x.id)).toEqual(["d0", "d1", "d2", "d3", "d4"]);
    expect(diagnostics.selectedRelatedIds).toEqual([]);
    expect(result.matches.map(x => x.id)).not.toContain("unrelated-neighbor");
  });

  it("promotes a graph-supported candidate already present below the direct result cutoff", async () => {
    const db = new D1Mock();
    seed(db, "root", "alpha decision root");
    for (let i = 1; i < 5; i++) seed(db, `direct-${i}`, `unrelated direct note ${i}`);
    seed(db, "linked-answer", "alpha beta causal explanation");
    seed(db, "omitted-distractor", "unrelated omitted note");
    edge(db, "root", "linked-answer");
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => /WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
    const matches = [
      { id: "root", score: .95, metadata: { parentId: "root" } },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `direct-${index + 1}`,
        score: .9 - index * .05,
        metadata: { parentId: `direct-${index + 1}` },
      })),
      { id: "omitted-distractor", score: .25, metadata: { parentId: "omitted-distractor" } },
      { id: "linked-answer", score: .2, metadata: { parentId: "linked-answer" } },
    ];
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches }) }) });

    const direct = await recallEntries(
      { query: "alpha beta", topK: 5, hops: 0, synthesize: false },
      env,
      ctx,
    );
    const graph = await recallEntries(
      { query: "alpha beta", topK: 5, hops: 1, synthesize: false },
      env,
      ctx,
    );

    expect(direct.matches.map(match => match.id)).not.toContain("linked-answer");
    expect(graph.matches.map(match => match.id)).toContain("linked-answer");
    expect(graph.matches.find(match => match.id === "linked-answer")).toMatchObject({
      hop: 1,
      viaFrom: "root",
      viaType: "decided",
    });
    expect(graph.graphContribution).toMatchObject({ eligibleCount: 1, selectedCount: 1 });
    expect(new Set(graph.matches.map(match => match.id)).size).toBe(graph.matches.length);
  });

  it("follows an explicit directed edge for a Japanese chronology question", async () => {
    const db = new D1Mock();
    seed(db, "check", "Worlddoc の Second Brain 動作確認");
    for (let i = 1; i < 5; i++) seed(db, `direct-${i}`, `unrelated direct note ${i}`);
    seed(db, "omitted-distractor", "unrelated omitted note");
    seed(db, "followup", "ダッシュボード修正が完了した");
    db.edges.push({
      id: "followup-check",
      source_id: "followup",
      target_id: "check",
      type: "follows",
      weight: 1,
      provenance: "explicit",
      metadata: "{}",
      created_at: 1,
      updated_at: 1,
    });
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => /WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
    const matches = [
      { id: "check", score: .95, metadata: { parentId: "check" } },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `direct-${index + 1}`,
        score: .9 - index * .05,
        metadata: { parentId: `direct-${index + 1}` },
      })),
      { id: "omitted-distractor", score: .25, metadata: { parentId: "omitted-distractor" } },
      { id: "followup", score: .2, metadata: { parentId: "followup" } },
    ];
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches }) }) });

    const result = await recallEntries(
      { query: "Worlddoc の確認後に何が起きたか", topK: 5, hops: 1, synthesize: false },
      env,
      ctx,
    );

    expect(result.matches.find(match => match.id === "followup")).toMatchObject({
      hop: 1,
      viaFrom: "check",
      viaType: "follows",
      viaDirection: "incoming",
    });
    expect(result.graphContribution.selectedCount).toBe(1);
  });

  it("uses one omitted strong root only for the fifth slot", async () => {
    const db = new D1Mock();
    for (let i = 0; i < 4; i++) seed(db, `direct-${i}`, `quartz ledger protocol result ${i}`);
    seed(db, "weak-fifth", "quartz archive note");
    seed(db, "strong-root", "quartz ledger protocol decision record", ["status:canonical"]);
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => /WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `direct-${i}`, score: .95 - i * .01, metadata: { parentId: `direct-${i}` } })),
      { id: "weak-fifth", score: .8, metadata: { parentId: "weak-fifth" } },
      { id: "strong-root", score: .4, metadata: { parentId: "strong-root" } },
    ] }) }) });

    const result = await recallEntries({
      query: "quartz ledger protocol",
      topK: 5,
      hops: 1,
      synthesize: false,
    }, env, ctx);

    expect(result.matches.map(match => match.id)).toEqual([
      "direct-0", "direct-1", "direct-2", "direct-3", "strong-root",
    ]);
  });

  it("uses existing semantic rank to rescue a paraphrased root only into the fifth slot", async () => {
    const db = new D1Mock();
    seed(db, "semantic-root", "The migration rationale was operational resilience");
    for (let i = 0; i < 5; i++) {
      seed(db, `frequent-${i}`, `north harbor direction note ${i}`);
      (db.entries.at(-1) as any).recall_count = 10_000;
    }
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => /WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
    const vectorQuery = vi.fn().mockResolvedValue({ matches: [
      { id: "semantic-root", score: .96, metadata: { parentId: "semantic-root", created_at: 1000 } },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `frequent-${i}`,
        score: .9 - i * .01,
        metadata: { parentId: `frequent-${i}`, created_at: 1000 },
      })),
    ] });
    const diagnostics: RecallDiagnostics = {};
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vectorQuery }) });

    const result = await recallEntries({
      query: "why did the north harbor direction change",
      topK: 5,
      hops: 1,
      synthesize: false,
    }, env, ctx, undefined, { diagnostics });

    expect(result.matches.slice(0, 4).map(match => match.id)).toEqual([
      "frequent-0", "frequent-1", "frequent-2", "frequent-3",
    ]);
    expect(result.matches[4].id).toBe("semantic-root");
    expect(diagnostics.operations).toMatchObject({
      embeddingCalls: 1,
      vectorizeQueries: 1,
      vectorizeGets: 0,
    });
  });

  it("considers only the strongest omitted semantic root without expanding the graph budget", async () => {
    const db = new D1Mock();
    for (let i = 1; i <= 17; i++) {
      const content = i === 16 ? "The resilience rationale favored a staged migration" : `unrelated archive note ${i}`;
      seed(db, `candidate-${i}`, content, i >= 5 && i <= 15 ? ["status:deprecated"] : []);
      if (i <= 4 || i === 17) (db.entries.at(-1) as any).recall_count = 10_000;
    }
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => /WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
    const query = vi.fn().mockResolvedValue({ matches: Array.from({ length: 17 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      score: .91 - index * .01,
      metadata: { parentId: `candidate-${index + 1}`, created_at: 1000 },
    })) });
    const diagnostics: RecallDiagnostics = {};
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });

    const result = await recallEntries({
      query: "why did the north harbor direction change",
      topK: 5,
      hops: 1,
      synthesize: false,
    }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.rootSelections).toHaveLength(15);
    expect(diagnostics.rootSelections?.map(selection => selection.id)).not.toContain("candidate-16");
    expect(result.matches.map(match => match.id)).toEqual([
      "candidate-1", "candidate-2", "candidate-3", "candidate-4", "candidate-16",
    ]);
    expect(diagnostics.operations).toMatchObject({
      embeddingCalls: 1,
      vectorizeQueries: 1,
      vectorizeGets: 0,
    });
  });

  it("recovers a supplemental-anchor candidate without reordering the direct top four", async () => {
    const db = new D1Mock();
    for (let i = 0; i < 5; i++) seed(db, `direct-${i}`, `ledger note ${i}`);
    seed(db, "anchor-root", "quartz protocol compass decision record", ["status:canonical"]);
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql.includes("AS total") && sql.includes("SUM(CASE WHEN content LIKE")) {
        const row = { total: 100, d0: 90, d1: 15, d2: 80, d3: 85 };
        // The recall observer runs first() as all() to count rows_read, so the double answers both the same way.
        return { bind: () => ({ first: async () => row, all: async () => ({ results: [row], meta: {} }) }) };
      }
      if (/WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)) {
        const row = db.entries.find(entry => entry.id === "anchor-root")!;
        return { bind: (...bindings: unknown[]) => ({
          all: async () => ({
            results: bindings.some(value => ["%quartz%", "%protocol%", "%compass%"].includes(String(value)))
              ? [row]
              : [],
          }),
          // 上流のrare/rest窓はbatch経由でも同じ読取りを実行する。
          run: async () => ({ results: bindings.some(value => ["%quartz%", "%protocol%", "%compass%"].includes(String(value))) ? [row] : [] }),
        }) };
      }
      return prepare(sql);
    };
    const diagnostics: RecallDiagnostics = {};
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `direct-${i}`, score: .95 - i * .01, metadata: { parentId: `direct-${i}` } })),
    ] }) }) });

    const result = await recallEntries({
      query: "quartz ledger protocol compass",
      topK: 5,
      hops: 1,
      synthesize: false,
    }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.keywordIds).toContain("anchor-root");
    expect(diagnostics.fusedIds).toContain("anchor-root");
    expect(result.matches.map(match => match.id)).toEqual([
      "direct-0", "direct-1", "direct-2", "direct-3", "anchor-root",
    ]);
  });

  it("does not populate root-selection diagnostics at hops:0", async () => {
    const db = new D1Mock();
    seed(db, "direct", "direct status", ["work"]);
    const diagnostics: RecallDiagnostics = {};
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "direct", score: .9, metadata: { parentId: "direct" } }] }) }) });

    await recallEntries({ query: "direct status", topK: 5, hops: 0, synthesize: false }, env, ctx, undefined, { diagnostics });
    expect(diagnostics.rootSelections).toBeUndefined();
    expect(diagnostics.expandedIds).toBeUndefined();
  });

  it("never returns a direct candidate again as a graph-hop result", async () => {
    const db = new D1Mock();
    seed(db, "d0", "alpha root");
    seed(db, "d1", "other");
    seed(db, "d2", "alpha beta evidence");
    seed(db, "d3", "other three");
    seed(db, "d4", "other four");
    edge(db, "d0", "d2");
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      ...["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, score: .9 - i * .01, metadata: { parentId: id } })),
    ] }) }) });

    const result = await recallEntries({ query: "alpha beta", topK: 5, hops: 1, synthesize: false }, env, ctx);
    expect(new Set(result.matches.map(match => match.id)).size).toBe(result.matches.length);
    expect(result.matches.filter(match => match.hop > 0).map(match => match.id)).not.toContain("d2");
  });

  it("normalizes a selected root against the actual positive root maximum", async () => {
    const db = new D1Mock();
    seed(db, "low-root", "alpha beta gamma");
    seed(db, "normalized-answer", "delta epsilon evidence");
    edge(db, "low-root", "normalized-answer");
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "low-root", score: .1, metadata: { parentId: "low-root" } }] }) }) });

    const result = await recallEntries({ query: "alpha beta gamma delta epsilon", topK: 5, hops: 1, synthesize: false }, env, ctx);
    expect(result.matches.map(match => match.id)).toContain("normalized-answer");
  });

  it("keeps a specific root when direct frequency favors a popular summary", async () => {
    const db = new D1Mock();
    seed(db, "popular-summary", "summary", []); (db.entries.at(-1) as any).recall_count = 10_000;
    seed(db, "specific-root", "alpha beta context");
    seed(db, "specific-answer", "alpha beta decision evidence");
    edge(db, "specific-root", "specific-answer");
    const diagnostics: RecallDiagnostics = {};
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      { id: "specific-root", score: .8, metadata: { parentId: "specific-root" } },
      { id: "popular-summary", score: .7, metadata: { parentId: "popular-summary" } },
    ] }) }) });

    await recallEntries({ query: "alpha beta", topK: 5, hops: 1, synthesize: false }, env, ctx, undefined, { diagnostics });
    expect(diagnostics.rootSelections?.map(selection => selection.id)).toContain("specific-root");
    expect(diagnostics.rootSelections?.[0].id).not.toBe("popular-summary");
  });

  it("uses a query-relevant local chunk instead of an unrelated parent section", async () => {
    const db = new D1Mock();
    seed(db, "chunk-root", "unrelated parent section");
    seed(db, "chunk-answer", "gamma delta evidence");
    seed(db, "unrelated-neighbor", "grocery list");
    edge(db, "chunk-root", "chunk-answer");
    edge(db, "chunk-root", "unrelated-neighbor");
    for (let i = 0; i < 5; i++) seed(db, `direct-${i}`, "alpha beta gamma direct evidence");
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => /WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `direct-${i}`, score: .9 - i * .01, metadata: { parentId: `direct-${i}` } })),
      { id: "chunk-root", score: .5, metadata: { parentId: "chunk-root", content: "alpha beta local chunk" } },
    ] }) }) });

    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: "alpha beta gamma delta", topK: 5, hops: 1, synthesize: false }, env, ctx, undefined, { diagnostics });
    expect(diagnostics.rejections).not.toContainEqual({ id: "chunk-answer", reason: "no-evidence-gain" });
    expect(result.matches.map(match => match.id)).toContain("chunk-answer");
    expect(result.matches.map(match => match.id)).not.toContain("unrelated-neighbor");
  });

  it("abstains when linked query terms are scattered across a long memory", async () => {
    const db = new D1Mock();
    seed(db, "long-root", "root context");
    const noise = "x".repeat(600);
    seed(db, "long-neighbor", `alpha ${noise} beta ${noise} gamma`);
    edge(db, "long-root", "long-neighbor");
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => /WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
    const diagnostics: RecallDiagnostics = {};
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      { id: "long-root", score: .9, metadata: { parentId: "long-root" } },
    ] }) }) });

    const result = await recallEntries(
      { query: "alpha beta gamma", topK: 5, hops: 1, synthesize: false },
      env,
      ctx,
      undefined,
      { diagnostics },
    );

    expect(result.matches.map(match => match.id)).toEqual(["long-root"]);
    expect(diagnostics.rejections).toContainEqual({ id: "long-neighbor", reason: "weak-neighborhood" });
  });

  it("returns full long linked content when localized evidence begins at offset zero", async () => {
    const db = new D1Mock();
    seed(db, "localized-root", "root context");
    const content = `alpha beta ${"noise ".repeat(100)}`;
    seed(db, "localized-neighbor", content);
    edge(db, "localized-root", "localized-neighbor");
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => /WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
    const diagnostics: RecallDiagnostics = {};
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      { id: "localized-root", score: .9, metadata: { parentId: "localized-root" } },
    ] }) }) });

    const result = await recallEntries(
      { query: "alpha beta", topK: 5, hops: 1, synthesize: false },
      env,
      ctx,
      undefined,
      { diagnostics },
    );

    expect(content.length).toBeGreaterThan(400);
    expect(result.matches.map(match => match.id)).toEqual(["localized-root", "localized-neighbor"]);
    expect(result.matches.find(match => match.id === "localized-neighbor")?.content).toBe(content);
    expect(diagnostics.rejections).not.toContainEqual({ id: "localized-neighbor", reason: "weak-neighborhood" });
  });

  it("selects candidate content only for graph-aware recalls", async () => {
    const candidateSql = async (hops: 0 | 1) => {
      const db = new D1Mock();
      seed(db, "root", "alpha beta root");
      const prepared: string[] = [];
      const prepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        if (sql.startsWith("SELECT") && sql.includes("recall_count") && sql.includes("WHERE id IN")) prepared.push(sql.replace(/\s+/g, " ").trim());
        return prepare(sql);
      };
      const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
        { id: "root", score: .9, metadata: { parentId: "root" } },
      ] }) }) });

      await recallEntries({ query: "alpha beta", topK: 5, hops, synthesize: false }, env, ctx);
      return prepared;
    };

    const hops0 = await candidateSql(0);
    const hops1 = await candidateSql(1);
    expect(hops0).toHaveLength(1);
    expect(hops1).toHaveLength(1);
    expect(hops0[0]).not.toMatch(/^SELECT id, content,/);
    expect(hops1[0]).toMatch(/^SELECT id, content,/);
  });

  it("uses the configured default embedding mode when the internal override is absent", async () => {
    const db = new D1Mock();
    seed(db, "root", "ledger");
    const query = vi.fn().mockResolvedValue({ matches: [{ id: "root", score: .9, metadata: { parentId: "root" } }] });
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });
    const diagnostics: RecallDiagnostics = {};
    const expectedInput = {
      distilled: "ledger",
      semantic: "why ledger",
      hybrid: "why ledger ledger",
    } as const;

    await recallEntries({ query: "why ledger", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(env.AI.run).toHaveBeenCalledTimes(1);
    expect(env.AI.run).toHaveBeenCalledWith(DEFAULTS.EMBEDDING_MODEL, {
      text: [`task: search result | query: ${expectedInput[DEFAULT_EMBEDDING_QUERY_MODE]}`],
    });
    expect(diagnostics.embeddingMode).toBe(DEFAULT_EMBEDDING_QUERY_MODE);
  });

  it.each([
    ["distilled", "ledger"],
    ["semantic", "why ledger"],
    ["hybrid", "why ledger ledger"],
  ] as const)("uses one embedding call in %s mode", async (embeddingQueryMode, expectedInput) => {
    const db = new D1Mock();
    seed(db, "root", "ledger");
    const query = vi.fn().mockResolvedValue({ matches: [{ id: "root", score: .9, metadata: { parentId: "root" } }] });
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });

    await recallEntries({ query: "why ledger", topK: 5, synthesize: false }, env, ctx, undefined, { embeddingQueryMode });
    expect(env.AI.run).toHaveBeenCalledWith(DEFAULTS.EMBEDDING_MODEL, {
      text: [`task: search result | query: ${expectedInput}`],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect((env.AI.run as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual([DEFAULTS.EMBEDDING_MODEL]);
  });
});
