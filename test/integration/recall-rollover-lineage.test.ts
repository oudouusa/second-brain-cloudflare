import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Env } from "../../src/env";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const JOURNAL_ID = "journal-90fefeba";
const CONTINUATION_ID = "rollover-c07573b8";

describe("recall rollover lineage ranking", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let pending: Promise<unknown>[];
  let ctx: ExecutionContext;
  let seededAt: number;
  let vectorQuery: Mock<Vectorize["query"]>;

  beforeEach(async () => {
    sqlite = makeSqliteD1();
    const now = seededAt = Date.now();
    sqlite.seed({
      id: JOURNAL_ID,
      content: "atlas rollout latest current state upstream tracking deployment history",
      createdAt: now - 60_000,
      tags: ["work", "kind:semantic"],
      importanceScore: 5,
    });
    sqlite.seed({
      id: CONTINUATION_ID,
      content: "atlas rollout latest current state is production ready",
      createdAt: now,
      tags: ["work", "kind:semantic"],
      importanceScore: 1,
    });
    await sqlite.db.prepare(`UPDATE entries SET memory_tier = 'cold' WHERE id = ?`)
      .bind(JOURNAL_ID).run();
    await sqlite.db.prepare(
      `INSERT INTO edges
         (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES (?, ?, ?, 'drawn_from', 1, 'system', ?, ?, ?, '')`,
    ).bind(
      "rollover-edge",
      CONTINUATION_ID,
      JOURNAL_ID,
      JSON.stringify({ rollover: { version: 1 } }),
      now,
      now,
    ).run();

    vectorQuery = vi.fn<Vectorize["query"]>().mockResolvedValue({
      count: 2,
      matches: [
        {
          id: `v-${JOURNAL_ID}`,
          score: .99,
          metadata: { parentId: JOURNAL_ID, created_at: now - 60_000 },
          values: new Array(128).fill(.2),
        },
        {
          id: `v-${CONTINUATION_ID}`,
          score: .8,
          metadata: { parentId: CONTINUATION_ID, created_at: now },
          values: new Array(128).fill(.2),
        },
      ],
    });
    const baseEnv = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    const admitted = sqlite.admitEnv(baseEnv);
    // Recall diagnostics clones Env to wrap the bindings. Preserve the
    // test-only write capability as an enumerable own field across that clone.
    env = { ...baseEnv, WRITE_ADMISSION_TOKEN: admitted.WRITE_ADMISSION_TOKEN };
    pending = [];
    ctx = { waitUntil: promise => { pending.push(promise); } } as ExecutionContext;
    sqlite.issued.length = 0;
  });

  afterEach(async () => {
    await Promise.allSettled(pending);
    sqlite.close();
  });

  it.each([
    "atlas rollout latest current state",
    "atlas rollout deployment status",
    "latest current state of atlas deployment history and rollover",
  ])("prefers the readable continuation for an ordinary/current query: %s", async query => {
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query, topK: 2, hops: 0, synthesize: false },
      env,
      ctx,
      undefined,
      { diagnostics },
    );

    // The pre-lineage reranker still puts the broad journal first. The final
    // direct candidate set collapses only that journal in favour of its current
    // continuation, proving this is not an embedding-score fixture accident.
    expect(diagnostics.candidateIds?.[0]).toBe(JOURNAL_ID);
    expect(result.matches.map(match => match.id)).toEqual([CONTINUATION_ID]);
    expect(sqlite.issued.filter(sql => sql.includes("WITH RECURSIVE rollover_lineage")))
      .toHaveLength(1);
    // This two-row lexical/dense fixture spends ten existing D1 statements;
    // lineage adds exactly one and remains well below the per-request guard.
    expect(diagnostics.operations?.d1Statements).toBe(11);
    expect(diagnostics.operations?.d1Statements).toBeLessThanOrEqual(30);
  });

  it("keeps both journal and continuation for history/chronology intent", async () => {
    const result = await recallEntries(
      { query: "atlas rollout history and sequence", topK: 2, hops: 0, synthesize: false },
      env,
      ctx,
    );

    expect(result.matches.map(match => match.id)).toEqual([JOURNAL_ID, CONTINUATION_ID]);
    expect(sqlite.issued.some(sql => sql.includes("WITH RECURSIVE rollover_lineage"))).toBe(false);
  });

  it("keeps the current continuation first and the source journal out with production-like graph settings", async () => {
    const distractors = [
      ["distractor-bakery", "bakery inventory and supplier notes"],
      ["distractor-garden", "garden irrigation calendar"],
      ["distractor-travel", "rail travel packing checklist"],
      ["distractor-music", "music practice room schedule"],
    ] as const;
    for (const [index, [id, content]] of distractors.entries()) {
      sqlite.seed({
        id,
        content,
        createdAt: seededAt - (index + 2) * 1_000,
        tags: ["context", "kind:semantic"],
      });
    }
    await sqlite.db.prepare(
      "UPDATE entries SET importance_score = 5, write_marker = ? WHERE id = ?",
    ).bind(sqlite.fixtureMarker(), CONTINUATION_ID).run();
    vectorQuery.mockResolvedValue({
      count: distractors.length + 2,
      matches: [
        { id: `v-${JOURNAL_ID}`, score: .99, metadata: { parentId: JOURNAL_ID, created_at: seededAt - 60_000 }, values: new Array(128).fill(.2) },
        { id: `v-${CONTINUATION_ID}`, score: .9, metadata: { parentId: CONTINUATION_ID, created_at: seededAt }, values: new Array(128).fill(.2) },
        ...distractors.map(([id], index) => ({
          id: `v-${id}`,
          score: .8 - index * .01,
          metadata: { parentId: id, created_at: seededAt - (index + 2) * 1_000 },
          values: new Array(128).fill(.1 + index * .01),
        })),
      ],
    });
    sqlite.issued.length = 0;

    const diagnostics: RecallDiagnostics = {};
    const current = await recallEntries(
      {
        query: "latest current state of atlas deployment history and rollover",
        topK: 5,
        hops: 1,
        synthesize: false,
      },
      env,
      ctx,
      undefined,
      { diagnostics },
    );

    expect(diagnostics.candidateIds).toEqual(expect.arrayContaining([JOURNAL_ID, CONTINUATION_ID]));
    expect(diagnostics.collapsedDirectRolloverIds).toEqual([JOURNAL_ID]);
    expect(diagnostics.collapsedGraphRolloverIds).toEqual([JOURNAL_ID]);
    expect(diagnostics.rootSelections?.map(selection => selection.id)).not.toContain(JOURNAL_ID);
    expect(diagnostics.expandedIds).toContain(JOURNAL_ID);
    expect(diagnostics.eligibleRelatedIds).not.toContain(JOURNAL_ID);
    expect(current.matches[0]?.id).toBe(CONTINUATION_ID);
    expect(current.matches.map(match => match.id)).not.toContain(JOURNAL_ID);

    const history = await recallEntries(
      {
        query: "atlas deployment rollover history and sequence",
        topK: 5,
        hops: 1,
        synthesize: false,
      },
      env,
      ctx,
    );

    expect(history.matches.map(match => match.id)).toEqual(
      expect.arrayContaining([JOURNAL_ID, CONTINUATION_ID]),
    );
  });

  it("collapses a source journal from graph paths when only the retrieval-token arm found it", async () => {
    const distractors = [
      ["root-only-bakery", "bakery inventory notes"],
      ["root-only-garden", "garden irrigation calendar"],
      ["root-only-travel", "rail travel checklist"],
      ["root-only-music", "music practice schedule"],
    ] as const;
    await sqlite.db.prepare(
      "UPDATE entries SET content = ?, write_marker = ? WHERE id = ?",
    ).bind(
      "archivedjournal historical source snapshot",
      sqlite.fixtureMarker(),
      JOURNAL_ID,
    ).run();
    await sqlite.db.prepare(
      "UPDATE entries SET content = ?, importance_score = 5, write_marker = ? WHERE id = ?",
    ).bind(
      "atlas current deployment production state",
      sqlite.fixtureMarker(),
      CONTINUATION_ID,
    ).run();
    for (const [index, [id, content]] of distractors.entries()) {
      sqlite.seed({
        id,
        content,
        createdAt: seededAt - (index + 2) * 1_000,
        tags: ["context", "kind:semantic"],
      });
    }
    vectorQuery.mockResolvedValue({
      count: distractors.length + 1,
      matches: [
        { id: `v-${CONTINUATION_ID}`, score: .95, metadata: { parentId: CONTINUATION_ID, created_at: seededAt }, values: new Array(128).fill(.2) },
        ...distractors.map(([id], index) => ({
          id: `v-${id}`,
          score: .8 - index * .01,
          metadata: { parentId: id, created_at: seededAt - (index + 2) * 1_000 },
          values: new Array(128).fill(.1 + index * .01),
        })),
      ],
    });
    sqlite.issued.length = 0;

    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      {
        // Distillation keeps the first three equally rare terms. The fourth
        // remains a retrieval token, so only rootFusedMatches sees the journal.
        query: "atlas current deployment archivedjournal",
        topK: 5,
        hops: 1,
        synthesize: false,
      },
      env,
      ctx,
      undefined,
      { diagnostics },
    );

    expect(diagnostics.candidateIds).not.toContain(JOURNAL_ID);
    expect(diagnostics.fusedIds).toContain(JOURNAL_ID);
    expect(diagnostics.collapsedDirectRolloverIds).toEqual([]);
    expect(diagnostics.collapsedGraphRolloverIds).toEqual([JOURNAL_ID]);
    expect(diagnostics.promotedDirectRolloverIds).toEqual([]);
    expect(diagnostics.rootSelections?.map(selection => selection.id)).not.toContain(JOURNAL_ID);
    expect(diagnostics.expandedIds).toContain(JOURNAL_ID);
    expect(diagnostics.eligibleRelatedIds).not.toContain(JOURNAL_ID);
    expect(result.matches[0]?.id).toBe(CONTINUATION_ID);
    expect(result.matches.map(match => match.id)).not.toContain(JOURNAL_ID);
  });

  it("promotes a continuation into direct results when only the retrieval-token arm found it", async () => {
    const distractors = [
      ["promotion-bakery", "bakery inventory notes"],
      ["promotion-garden", "garden irrigation calendar"],
      ["promotion-travel", "rail travel checklist"],
      ["promotion-music", "music practice schedule"],
    ] as const;
    await sqlite.db.prepare(
      "UPDATE entries SET content = ?, write_marker = ? WHERE id = ?",
    ).bind(
      "atlas current deployment historical source snapshot",
      sqlite.fixtureMarker(),
      JOURNAL_ID,
    ).run();
    await sqlite.db.prepare(
      "UPDATE entries SET content = ?, importance_score = 5, write_marker = ? WHERE id = ?",
    ).bind(
      "activecontinuation production state",
      sqlite.fixtureMarker(),
      CONTINUATION_ID,
    ).run();
    for (const [index, [id, content]] of distractors.entries()) {
      sqlite.seed({
        id,
        content,
        createdAt: seededAt - (index + 2) * 1_000,
        tags: ["context", "kind:semantic"],
      });
    }
    vectorQuery.mockResolvedValue({
      count: distractors.length + 1,
      matches: [
        { id: `v-${JOURNAL_ID}`, score: .95, metadata: { parentId: JOURNAL_ID, created_at: seededAt - 60_000 }, values: new Array(128).fill(.2) },
        ...distractors.map(([id], index) => ({
          id: `v-${id}`,
          score: .8 - index * .01,
          metadata: { parentId: id, created_at: seededAt - (index + 2) * 1_000 },
          values: new Array(128).fill(.1 + index * .01),
        })),
      ],
    });
    sqlite.issued.length = 0;

    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      {
        query: "atlas current deployment activecontinuation",
        topK: 5,
        hops: 1,
        synthesize: false,
      },
      env,
      ctx,
      undefined,
      { diagnostics },
    );

    expect(diagnostics.candidateIds).toContain(JOURNAL_ID);
    // 上流診断のcandidateIdsにはroot候補も含まれる。直接語彙からは外れたまま昇格する。
    expect(result.queryTokens).not.toContain("activecontinuation");
    expect(diagnostics.fusedIds).toContain(CONTINUATION_ID);
    expect(diagnostics.collapsedDirectRolloverIds).toEqual([JOURNAL_ID]);
    expect(diagnostics.collapsedGraphRolloverIds).toEqual([JOURNAL_ID]);
    expect(diagnostics.promotedDirectRolloverIds).toEqual([CONTINUATION_ID]);
    expect(result.matches.map(match => match.id)).toContain(CONTINUATION_ID);
    expect(result.matches.map(match => match.id)).not.toContain(JOURNAL_ID);
  });

  it("keeps recall available and emits structured diagnostics when the lineage lookup fails", async () => {
    const privateFailure = "PRIVATE-LINEAGE-DB-DETAIL";
    const baseDb = sqlite.db;
    env = {
      ...env,
      DB: {
        ...baseDb,
        prepare(sql: string) {
          const statement = baseDb.prepare(sql);
          if (!sql.includes("WITH RECURSIVE rollover_lineage")) return statement;
          return {
            bind(...args: unknown[]) {
              const bound = statement.bind(...args);
              return {
                all: async () => { throw new Error(privateFailure); },
                first: () => bound.first(),
                run: () => bound.run(),
                bind: (...next: unknown[]) => bound.bind(...next),
              };
            },
          };
        },
      } as unknown as D1Database,
    };
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await recallEntries(
      { query: "atlas rollout latest current state", topK: 2, hops: 0, synthesize: false },
      env,
      ctx,
    );

    expect(result.lineageFallbackUsed).toBe(true);
    expect(result.matches.map(match => match.id)).toEqual([JOURNAL_ID, CONTINUATION_ID]);
    const errorLogs = error.mock.calls.flat().join("\n");
    const infoLogs = info.mock.calls.flat().join("\n");
    expect(errorLogs).toContain('"event":"recall_lineage_fallback"');
    expect(errorLogs).toContain('"outcome":"degraded"');
    expect(errorLogs).toContain('"error_name":"Error"');
    expect(errorLogs).not.toContain(privateFailure);
    expect(infoLogs).toContain('"lineage_fallback_used":true');
  });

  it("keeps a journal when its exact ID is explicitly requested", async () => {
    const result = await recallEntries(
      { query: `retrieve ${JOURNAL_ID}`, topK: 2, hops: 0, synthesize: false },
      env,
      ctx,
    );

    expect(result.matches[0]?.id).toBe(JOURNAL_ID);
    expect(sqlite.issued.some(sql => sql.includes("WITH RECURSIVE rollover_lineage"))).toBe(false);
  });

  it("does not let an out-of-window continuation hide an in-window journal", async () => {
    const result = await recallEntries(
      {
        query: "atlas rollout latest current state",
        topK: 2,
        hops: 0,
        synthesize: false,
        before: seededAt - 10_000,
      },
      env,
      ctx,
    );

    expect(result.matches.map(match => match.id)).toEqual([JOURNAL_ID]);
  });

  it("does not let a deprecated continuation hide a valid journal", async () => {
    await sqlite.db.prepare(
      `UPDATE entries SET tags = ?, write_marker = ? WHERE id = ?`,
    ).bind(
      JSON.stringify(["work", "kind:semantic", "status:deprecated"]),
      sqlite.fixtureMarker(),
      CONTINUATION_ID,
    ).run();
    sqlite.issued.length = 0;

    const result = await recallEntries(
      { query: "atlas rollout latest current state", topK: 2, hops: 0, synthesize: false },
      env,
      ctx,
    );

    expect(result.matches.map(match => match.id)).toEqual([JOURNAL_ID]);
  });

  it("does not collapse a generic cold memory through a user-created drawn_from edge", async () => {
    await sqlite.db.prepare(
      `UPDATE edges SET provenance = 'explicit' WHERE id = ?`,
    ).bind("rollover-edge").run();
    sqlite.issued.length = 0;

    const result = await recallEntries(
      { query: "atlas rollout latest current state", topK: 2, hops: 0, synthesize: false },
      env,
      ctx,
    );

    expect(result.matches[0]?.id).toBe(JOURNAL_ID);
    expect(result.matches.map(match => match.id)).toContain(CONTINUATION_ID);
  });

  it("follows a bounded rollover chain when an intermediate continuation is not a candidate", async () => {
    const intermediateId = "rollover-intermediate";
    const now = Date.now();
    sqlite.seed({
      id: intermediateId,
      content: "bounded snapshot between generations",
      createdAt: now - 30_000,
      tags: ["work", "kind:semantic"],
    });
    await sqlite.db.prepare(
      `UPDATE entries SET memory_tier = 'cold' WHERE id = ?`,
    ).bind(intermediateId).run();
    await sqlite.db.prepare(
      `UPDATE edges SET source_id = ?, write_marker = ? WHERE id = ?`,
    ).bind(intermediateId, sqlite.fixtureMarker(), "rollover-edge").run();
    await sqlite.db.prepare(
      `INSERT INTO edges
         (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES (?, ?, ?, 'drawn_from', 1, 'system', ?, ?, ?, '')`,
    ).bind(
      "rollover-edge-current",
      CONTINUATION_ID,
      intermediateId,
      JSON.stringify({ rollover: { version: 1 } }),
      now,
      now,
    ).run();
    sqlite.issued.length = 0;

    const result = await recallEntries(
      { query: "atlas rollout latest current state", topK: 2, hops: 0, synthesize: false },
      env,
      ctx,
    );

    expect(result.matches.map(match => match.id)).toEqual([CONTINUATION_ID]);
  });
});
