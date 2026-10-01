/**
 * T-0089.4.2 (Track 4 read half): a held (quarantined) row must never surface
 * through recall, at any candidate source. Real SQLite (test/helpers/sqlite-d1.ts)
 * because the subject is whether the SQL predicate actually excludes the row —
 * a mocked D1 that matches query strings cannot evaluate `NOT LIKE`.
 */
import { describe, it, expect, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { expandGraph } from "../../src/graph/traverse";
import { DEFAULTS } from "../../src/config";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { mulberry32 } from "../eval/stats";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as unknown as ExecutionContext;
const HELD_TAGS = ["quarantine:instruction", "status:draft"];

function denseEnv(sqlite: SqliteD1, index: { id: string; score: number; values?: number[] }[]): Env {
  const query = vi.fn(async (_v: unknown, opts: { topK?: number } = {}) => ({
    matches: index.slice(0, opts.topK ?? 10).map(m => ({ id: m.id, score: m.score, values: m.values, metadata: { parentId: m.id, isUpdate: false } })),
  }));
  return sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock({ query: query as never }) }));
}

async function setup() {
  resetDatabaseInit();
  resetFtsReadyMemo();
  const sqlite = makeSqliteD1();
  const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  sqlite.issued.length = 0;
  return { sqlite, env };
}

describe("held rows never enter recall (dense arm)", () => {
  it("a held row ranked in the primary dense pool is dropped before rerank, and a real note still fills topK", async () => {
    const { sqlite } = await setup();
    for (let i = 0; i < 4; i++) sqlite.seed({ id: `real${i}`, content: `topic note ${i}`, createdAt: 1000 + i });
    sqlite.seed({ id: "held1", content: "topic note held", createdAt: 1000, tags: HELD_TAGS });
    // The held row scores highest: without the fix it would take the top slot.
    const index = [
      { id: "held1", score: 0.99 },
      { id: "real0", score: 0.95 }, { id: "real1", score: 0.9 }, { id: "real2", score: 0.85 }, { id: "real3", score: 0.8 },
    ];
    const env = denseEnv(sqlite, index);
    const { matches } = await recallEntries({ query: "topic note", topK: 4, synthesize: false }, env, ctx);
    expect(matches.map(m => m.id)).not.toContain("held1");
    expect(matches).toHaveLength(4);
  });

  it("a held row that surfaces only in the deep dense-fill pool is excluded by the hydration filter (the last guard)", async () => {
    const { sqlite } = await setup();
    // 8 real parents, two chunks each (16 raw dense entries), mirroring
    // recall-top-k-prefix.test.ts's setup(): the primary pool (topK 15)
    // covers only the real parents, so the held row's chunks — placed after
    // all of them — never reach the early candidate-drop stage and can only
    // be caught by the hydration filter once the deeper pool widens to them.
    for (let i = 0; i < 8; i++) sqlite.seed({ id: `real${i}`, content: `topic note ${i}`, createdAt: 1000 + i });
    sqlite.seed({ id: "held-deep", content: "topic note held", createdAt: 1000, tags: HELD_TAGS });
    const index = [
      ...Array.from({ length: 8 }, (_, i) => [0, 1].map(c => ({ id: `real${i}-${c}`, score: 0.9 - (i * 2 + c) * 0.01, metaId: `real${i}` }))).flat(),
      { id: "held-deep-0", score: 0.5, metaId: "held-deep" },
      { id: "held-deep-1", score: 0.49, metaId: "held-deep" },
    ];
    const query = vi.fn(async (_v: unknown, opts: { topK?: number } = {}) => ({
      matches: index.slice(0, opts.topK ?? 10).map(m => ({ id: m.id, score: m.score, metadata: { parentId: m.metaId, isUpdate: false } })),
    }));
    const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock({ query: query as never }) }));
    // topK above the 8 real parents forces the deeper dense-fill call.
    const { matches } = await recallEntries({ query: "topic note", topK: 10, synthesize: false }, env, ctx);
    expect(matches.map(m => m.id)).not.toContain("held-deep");
    expect(matches).toHaveLength(8);
  });
});

describe("held rows never enter recall (keyword arm)", () => {
  async function keywordSetup(ftsReady: boolean) {
    const { sqlite, env } = await setup();
    if (ftsReady) await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    else await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
    (env as any).VECTORIZE = makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) });
    sqlite.seed({ id: "real", content: "distinctive keyword note", createdAt: 2000 });
    for (let i = 0; i < 40; i++) {
      sqlite.seed({ id: `held${i}`, content: `distinctive keyword note ${i}`, createdAt: 1000 + i, tags: HELD_TAGS });
    }
    return env;
  }

  it("a held row never takes an FTS keyword LIMIT slot, with a real note still returned", async () => {
    const env = await keywordSetup(true);
    const cfg = { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: 15 };
    const { matches } = await recallEntries({ query: "distinctive keyword", topK: 5, synthesize: false }, env, ctx, cfg);
    expect(matches.map(m => m.id)).toContain("real");
    expect(matches.map(m => m.id).some(id => id.startsWith("held"))).toBe(false);
  });

  it("a held row never takes a LIKE keyword LIMIT slot, with a real note still returned", async () => {
    const env = await keywordSetup(false);
    const cfg = { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: 15 };
    const { matches } = await recallEntries({ query: "distinctive keyword", topK: 5, synthesize: false }, env, ctx, cfg);
    expect(matches.map(m => m.id)).toContain("real");
    expect(matches.map(m => m.id).some(id => id.startsWith("held"))).toBe(false);
  });
});

describe("held rows never enter recall (member-first: tag and project)", () => {
  it("a tag recall excludes a held row carrying that tag", async () => {
    const { sqlite, env } = await setup();
    sqlite.seed({ id: "real", content: "member note", createdAt: 1000, tags: ["work"] });
    sqlite.seed({ id: "held", content: "member note held", createdAt: 1000, tags: ["work", ...HELD_TAGS] });
    (env as any).VECTORIZE = makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) });
    const { matches } = await recallEntries({ query: "member note", topK: 10, tag: "work", synthesize: false }, env, ctx);
    expect(matches.map(m => m.id)).toEqual(["real"]);
  });
});

describe("held rows never enter recall (graph hops)", () => {
  function seed(sqlite: SqliteD1, id: string, tags: string[] = []) {
    sqlite.seed({ id, content: id, createdAt: 1000 });
    if (tags.length) sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(tags), id).run();
  }
  function edge(sqlite: SqliteD1, source: string, target: string) {
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, created_at, updated_at) VALUES (?, ?, ?, 'relates_to', 0.9, 'inferred', 1, 1)`,
    ).bind(`${source}--${target}`, source, target).run();
  }

  it("hops never expands to a held neighbour, and never walks through one to reach what lies beyond it", async () => {
    const { sqlite, env } = await setup();
    seed(sqlite, "root");
    seed(sqlite, "held-neighbor", HELD_TAGS);
    seed(sqlite, "beyond");
    edge(sqlite, "root", "held-neighbor");
    edge(sqlite, "held-neighbor", "beyond");
    const out = await expandGraph(["root"], { hops: 2 }, env);
    expect(out.map(n => n.id)).toEqual([]);
  });
});

describe("held rows and the topK prefix property (T-0081)", () => {
  it("every topK 1-10 is a prefix of every larger one with held rows mixed into the corpus", async () => {
    const { sqlite } = await setup();
    const rand = mulberry32(42);
    const n = 20;
    const heldIds = new Set<string>();
    for (let i = 0; i < n; i++) {
      const held = rand() < 0.35;
      if (held) heldIds.add(`m${i}`);
      sqlite.seed({ id: `m${i}`, content: `topic note ${i}`, createdAt: 1000 + i, tags: held ? HELD_TAGS : [] });
    }
    const index = Array.from({ length: n }, (_, i) => ({ id: `m${i}`, score: 0.9 - i * 0.01, values: Array.from({ length: 6 }, () => rand() - 0.5) }));
    const env = denseEnv(sqlite, index);
    const lists: string[][] = [];
    for (let k = 1; k <= 10; k++) {
      const { matches } = await recallEntries({ query: "topic note", topK: k, synthesize: false }, env, ctx);
      lists.push(matches.map(m => m.id));
    }
    for (const list of lists) for (const id of list) expect(heldIds.has(id)).toBe(false);
    for (let a = 0; a < lists.length; a++) for (let b = a + 1; b < lists.length; b++) {
      expect(lists[a]).toEqual(lists[b].slice(0, lists[a].length));
    }
  });
});
