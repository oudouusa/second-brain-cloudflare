import { describe, expect, it, vi } from "vitest";
import { scoreLinkedEvidence } from "../../src/recall/neighborhood";
import { recallEntries } from "../../src/recall/search";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

const cases = [
  { domain: "personal", query: "anniversary childcare", answer: "The anniversary moved to Chateau Elan to solve the sitter constraint" },
  { domain: "enterprise", query: "backend dotnet", answer: "The backend moved to the Microsoft stack for enterprise support skills" },
  { domain: "governance", query: "review cycles", answer: "The review separated critique from approval" },
  { domain: "operations", query: "issue ledger", answer: "The ledger still counted closed items as open" },
  { domain: "product", query: "learn council", answer: "Learn followed user intent while risk governed oversight" },
  { domain: "launch", query: "product hunt", answer: "The Product launch moved because Fabian Merian requested the earlier Sunday" },
  { domain: "architecture", query: "okf retrieval", answer: "OKF is a portable document format rather than a query engine" },
  { domain: "insights", query: "derivepattern rebuilt", answer: "DerivePattern was removed because zero of 135 proposals were accepted" },
  { domain: "platform", query: "graph fanout", answer: "The graph ceiling bounds database reads and response growth" },
  { domain: "operating-model", query: "advisor partner", answer: "Advisor search changed from a gate into guided recommendations" },
] as const;

function suppressKeywordSearch(db: ReturnType<typeof makeTestDb>) {
  const prepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    if (/WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)) {
      return { bind: () => ({ all: async () => ({ results: [] }) }) };
    }
    return prepare(sql);
  };
}

function fixture(c: typeof cases[number]) {
  const db = makeTestDb();
  for (let i = 0; i < 5; i++) {
    db.entries.push({
      id: `${c.domain}-direct-${i}`,
      content: `unrelated direct note ${i}`,
      tags: "[]",
      source: "api",
      created_at: 2000 - i,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
  }
  const rootId = `${c.domain}-root`;
  const answerId = `${c.domain}-answer`;
  db.entries.push({
    id: rootId,
    content: "decision root",
    tags: "[]",
    source: "api",
    created_at: 1000,
    vector_ids: "[]",
    recall_count: 0,
    importance_score: 0,
  });
  db.entries.push({
    id: answerId,
    content: `${c.query} ${c.answer}`,
    tags: "[]",
    source: "api",
    created_at: 900,
    vector_ids: "[]",
    recall_count: 0,
    importance_score: 0,
  });
  db.edges.push({
    id: `${c.domain}-edge`,
    source_id: rootId,
    target_id: answerId,
    type: "decided",
    weight: 1,
    provenance: "explicit",
    metadata: "{}",
    created_at: 1,
    updated_at: 1,
  });
  suppressKeywordSearch(db);

  const matches = [
    ...[0, 1, 2, 3, 4].map(i => ({
      id: `${c.domain}-direct-${i}`,
      score: 0.95 - i * 0.04,
      metadata: { parentId: `${c.domain}-direct-${i}`, isUpdate: false },
    })),
    { id: rootId, score: 0.7, metadata: { parentId: rootId, isUpdate: false } },
  ];
  const env = makeTestEnv(db, {
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches }),
    }),
  });
  const ctx = { waitUntil: () => undefined } as any as ExecutionContext;
  return { env, ctx, answerId };
}

describe("graph-aware recall multi-domain benchmark", () => {
  for (const c of cases) {
    it(`${c.domain}: linked causal evidence enters Recall@5 only when graph recall is requested`, async () => {
      const direct = fixture(c);
      const graph = fixture(c);

      const withoutGraph = await recallEntries(
        { query: c.query, topK: 5, hops: 0, synthesize: false },
        direct.env,
        direct.ctx,
      );
      const withGraph = await recallEntries(
        { query: c.query, topK: 5, hops: 1, synthesize: false },
        graph.env,
        graph.ctx,
      );

      expect(withoutGraph.matches.map(m => m.id)).not.toContain(direct.answerId);
      expect(withGraph.matches.map(m => m.id)).toContain(graph.answerId);
      expect(withGraph.matches[0].id).toBe(`${c.domain}-direct-0`);
      expect(withGraph.matches).toHaveLength(5);
    });
  }

  it("intentionally abstains from a neighbor matching one common low-IDF term", () => {
    const evidence = scoreLinkedEvidence({
      parentScore: 1,
      parentContent: "Specific ledger decision root",
      content: "A generic platform overview",
      queryTokens: ["platform", "ledger"],
      evidenceTokens: ["platform", "ledger", "status", "planning"],
      corpus: { total: 100, df: new Map([["platform", 90], ["ledger", 2]]) },
      hop: 1,
      edgeWeight: 1,
      provenance: "explicit",
      hopDecay: 0.6,
      replacementCoverage: 0,
      intent: "direct",
      edgeType: "relates_to",
    });

    expect(evidence.eligible).toBe(false);
    expect(evidence.rejection).toBe("weak-neighborhood");
  });
});
