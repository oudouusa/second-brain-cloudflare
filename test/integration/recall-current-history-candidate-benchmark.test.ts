import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { buildQueryProfile, type RecallIntent } from "../../src/recall/query-profile";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const JOURNAL_ID = "benchmark-journal-source";
const CONTINUATION_ID = "benchmark-current-continuation";
const NOW = 1_787_996_400_000;

const CASES = [
  {
    language: "English",
    intent: "current",
    query: "latest current state of atlas deployment history and rollover",
  },
  {
    language: "Japanese",
    intent: "current",
    query: "現在のAtlas配備履歴とrolloverの運用状態を確認したい",
  },
  {
    language: "English",
    intent: "chronology",
    query: "atlas deployment rollover history and sequence",
  },
  {
    language: "Japanese",
    intent: "chronology",
    query: "Atlas配備とrolloverの履歴を時系列で確認したい",
  },
] as const satisfies readonly { language: string; intent: RecallIntent; query: string }[];

interface BenchmarkFixture {
  sqlite: SqliteD1;
  env: Env;
  ctx: ExecutionContext;
  pending: Promise<unknown>[];
}

async function buildFixture(): Promise<BenchmarkFixture> {
  const sqlite = makeSqliteD1();
  const rows = [
    {
      id: JOURNAL_ID,
      content: "Atlas deployment rollover journal history sequence 配備 ロールオーバー 更新 履歴 時系列",
      createdAt: NOW - 60_000,
      tags: ["work", "kind:semantic"],
      importanceScore: 5,
    },
    {
      id: CONTINUATION_ID,
      content: "Atlas deployment rollover latest current production state 配備 ロールオーバー 現在 最新 運用状態",
      createdAt: NOW,
      tags: ["work", "kind:semantic"],
      importanceScore: 1,
    },
    ...[
      ["benchmark-bakery", "bakery inventory and supplier notes パン屋の在庫メモ"],
      ["benchmark-garden", "garden irrigation calendar 庭の散水予定"],
      ["benchmark-travel", "rail travel packing checklist 鉄道旅行の荷造り"],
      ["benchmark-music", "music practice room schedule 音楽練習室の予定"],
    ].map(([id, content], index) => ({
      id,
      content,
      createdAt: NOW - (index + 2) * 1_000,
      tags: ["context", "kind:semantic"],
      importanceScore: 0,
    })),
  ];
  rows.forEach(row => sqlite.seed(row));
  await sqlite.db.prepare("UPDATE entries SET memory_tier = 'cold' WHERE id = ?")
    .bind(JOURNAL_ID).run();
  await sqlite.db.prepare(
    `INSERT INTO edges
       (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, 'drawn_from', 1, 'system', ?, ?, ?, '')`,
  ).bind(
    "benchmark-rollover-edge",
    CONTINUATION_ID,
    JOURNAL_ID,
    JSON.stringify({ rollover: { version: 1 } }),
    NOW,
    NOW,
  ).run();

  const denseScores = [.99, .9, .8, .79, .78, .77];
  const vectorQuery = vi.fn().mockResolvedValue({
    matches: rows.map((row, index) => ({
      id: `v-${row.id}`,
      score: denseScores[index],
      metadata: { parentId: row.id, created_at: row.createdAt },
      values: new Array(128).fill(.1 + index * .01),
    })),
  });
  const baseEnv = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database,
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
  });
  const admitted = sqlite.admitEnv(baseEnv);
  const env = { ...baseEnv, WRITE_ADMISSION_TOKEN: admitted.WRITE_ADMISSION_TOKEN };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: promise => { pending.push(promise); } } as ExecutionContext;
  sqlite.issued.length = 0;
  return { sqlite, env, ctx, pending };
}

describe("current/history candidate-generation benchmark", () => {
  const fixtures: BenchmarkFixture[] = [];

  afterEach(async () => {
    await Promise.allSettled(fixtures.flatMap(fixture => fixture.pending));
    fixtures.splice(0).forEach(fixture => fixture.sqlite.close());
  });

  it.each(CASES)("keeps deterministic $language $intent semantics", async benchmark => {
    const fixture = await buildFixture();
    fixtures.push(fixture);
    const diagnostics: RecallDiagnostics = {};
    const profile = buildQueryProfile(
      benchmark.query,
      { query: benchmark.query, df: null, total: null },
    );

    const result = await recallEntries(
      { query: benchmark.query, topK: 5, hops: 1, synthesize: false },
      fixture.env,
      fixture.ctx,
      undefined,
      { diagnostics },
    );
    const ids = result.matches.map(match => match.id);

    expect(profile.intent).toBe(benchmark.intent);
    expect(diagnostics.candidateIds).toEqual(
      expect.arrayContaining([JOURNAL_ID, CONTINUATION_ID]),
    );
    if (benchmark.intent === "current") {
      expect(ids[0]).toBe(CONTINUATION_ID);
      expect(ids).not.toContain(JOURNAL_ID);
    } else {
      expect(ids).toEqual(expect.arrayContaining([JOURNAL_ID, CONTINUATION_ID]));
    }
  });
});
