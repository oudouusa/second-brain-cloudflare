/**
 * T-0089.3.1 / T-0089.3.2 (4.4): recurring mirror notices collapse at recall
 * time. Real SQLite because the subject includes the assembled/hydrated
 * content the signature groups on.
 */
import { describe, it, expect, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { renderRecallText } from "../../src/recall/render";
import { DEFAULTS, CONFIG_KEY } from "../../src/config";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { req } from "../helpers/make-request";
import worker from "../../src/index";
import type { RecallMatch } from "../../src/recall/types";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as unknown as ExecutionContext;

function denseEnv(sqlite: SqliteD1, index: { id: string; score: number }[]): Env {
  const query = vi.fn(async (_v: unknown, opts: { topK?: number } = {}) => ({
    matches: index.slice(0, opts.topK ?? 10).map(m => ({ id: m.id, score: m.score, metadata: { parentId: m.id, isUpdate: false } })),
  }));
  return sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock({ query: query as never }) }));
}

async function setup() {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  sqlite.issued.length = 0;
  return { sqlite, env };
}

const cfgOn = { ...DEFAULTS, NOTICE_COLLAPSE: "on" as const };

describe("near-duplicate collapse at recall time", () => {
  it("keeps only the best-ranked recurring notice; the others become `similar`", async () => {
    const { sqlite } = await setup();
    sqlite.seed({ id: "notice1", content: "Statement ready: balance $10.00 as of 2026-08-11", createdAt: 3000, source: "email-gmail" });
    sqlite.seed({ id: "notice2", content: "Statement ready: balance $20.00 as of 2026-08-04", createdAt: 2000, source: "email-gmail" });
    sqlite.seed({ id: "notice3", content: "Statement ready: balance $30.00 as of 2026-07-28", createdAt: 1000, source: "email-gmail" });
    sqlite.seed({ id: "genuine", content: "Team standup notes and decisions", createdAt: 500, source: "api" });
    const index = [
      { id: "notice1", score: 0.95 }, { id: "notice2", score: 0.9 }, { id: "notice3", score: 0.85 }, { id: "genuine", score: 0.5 },
    ];
    const env = denseEnv(sqlite, index);
    const { matches } = await recallEntries({ query: "statement balance", topK: 4, synthesize: false }, env, ctx, cfgOn);
    const ids = matches.map(m => m.id);
    expect(ids).toContain("notice1");
    expect(ids).not.toContain("notice2");
    expect(ids).not.toContain("notice3");
    const survivor = matches.find(m => m.id === "notice1")!;
    expect(survivor.similar).toEqual([
      { id: "notice2", createdAt: 2000 },
      { id: "notice3", createdAt: 1000 },
    ]);
  });

  it("a freed position is filled from the lookahead, so topK is kept", async () => {
    const { sqlite } = await setup();
    // Genuine notes share no words with the query, so only their dense score
    // (not a keyword-arm boost) decides their order relative to each other.
    sqlite.seed({ id: "notice1", content: "Statement ready: balance $10.00 as of 2026-08-11", createdAt: 3000, source: "email-gmail" });
    sqlite.seed({ id: "notice2", content: "Statement ready: balance $20.00 as of 2026-08-04", createdAt: 2000, source: "email-gmail" });
    sqlite.seed({ id: "genuine1", content: "Team standup notes", createdAt: 500, source: "api" });
    sqlite.seed({ id: "genuine2", content: "Roadmap planning session", createdAt: 400, source: "api" });
    const index = [
      { id: "notice1", score: 0.95 }, { id: "notice2", score: 0.9 }, { id: "genuine1", score: 0.5 }, { id: "genuine2", score: 0.45 },
    ];
    const env = denseEnv(sqlite, index);
    const { matches } = await recallEntries({ query: "statement balance", topK: 3, synthesize: false }, env, ctx, cfgOn);
    // notice2 collapses into notice1, and genuine2 fills the freed slot: 3 results, not 2.
    expect(matches.map(m => m.id)).toEqual(["notice1", "genuine1", "genuine2"]);
  });

  it("only mirror rows collapse: two notes with the same first line never collapse", async () => {
    const { sqlite } = await setup();
    sqlite.seed({ id: "a", content: "Team standup notes", createdAt: 2000, source: "api" });
    sqlite.seed({ id: "b", content: "Team standup notes", createdAt: 1000, source: "api" });
    const env = denseEnv(sqlite, [{ id: "a", score: 0.9 }, { id: "b", score: 0.85 }]);
    const { matches } = await recallEntries({ query: "standup notes", topK: 5, synthesize: false }, env, ctx, cfgOn);
    expect(matches.map(m => m.id)).toEqual(["a", "b"]);
  });

  it("transcripts never collapse", async () => {
    const { sqlite } = await setup();
    sqlite.seed({ id: "a", content: "Statement ready: balance $10.00 as of 2026-08-11", createdAt: 2000, source: "claude-code" });
    sqlite.seed({ id: "b", content: "Statement ready: balance $20.00 as of 2026-08-04", createdAt: 1000, source: "claude-code" });
    const env = denseEnv(sqlite, [{ id: "a", score: 0.9 }, { id: "b", score: 0.85 }]);
    const { matches } = await recallEntries({ query: "statement balance", topK: 5, synthesize: false }, env, ctx, cfgOn);
    expect(matches.map(m => m.id)).toEqual(["a", "b"]);
  });

  it("a source word in the query lifts the collapse", async () => {
    const { sqlite } = await setup();
    sqlite.seed({ id: "notice1", content: "Statement ready: balance $10.00 as of 2026-08-11", createdAt: 2000, source: "email-gmail" });
    sqlite.seed({ id: "notice2", content: "Statement ready: balance $20.00 as of 2026-08-04", createdAt: 1000, source: "email-gmail" });
    const env = denseEnv(sqlite, [{ id: "notice1", score: 0.9 }, { id: "notice2", score: 0.85 }]);
    const { matches } = await recallEntries({ query: "email statement balance", topK: 5, synthesize: false }, env, ctx, cfgOn);
    expect(matches.map(m => m.id)).toEqual(["notice1", "notice2"]);
  });

  it("a mirror tag filter lifts the collapse", async () => {
    const { sqlite } = await setup();
    sqlite.seed({ id: "notice1", content: "Statement ready: balance $10.00 as of 2026-08-11", createdAt: 2000, source: "email-gmail", tags: ["email"] });
    sqlite.seed({ id: "notice2", content: "Statement ready: balance $20.00 as of 2026-08-04", createdAt: 1000, source: "email-gmail", tags: ["email"] });
    const env = denseEnv(sqlite, [{ id: "notice1", score: 0.9 }, { id: "notice2", score: 0.85 }]);
    const { matches } = await recallEntries({ query: "statement balance", topK: 5, tag: "email", synthesize: false }, env, ctx, cfgOn);
    expect(matches.map(m => m.id)).toEqual(["notice1", "notice2"]);
  });

  it("an enumerating query (show, list, all, every, how many) lifts the collapse", async () => {
    const { sqlite } = await setup();
    sqlite.seed({ id: "notice1", content: "Statement ready: balance $10.00 as of 2026-08-11", createdAt: 2000, source: "email-gmail" });
    sqlite.seed({ id: "notice2", content: "Statement ready: balance $20.00 as of 2026-08-04", createdAt: 1000, source: "email-gmail" });
    const env = denseEnv(sqlite, [{ id: "notice1", score: 0.9 }, { id: "notice2", score: 0.85 }]);
    const { matches } = await recallEntries({ query: "show all the statements", topK: 5, synthesize: false }, env, ctx, cfgOn);
    expect(matches.map(m => m.id)).toEqual(["notice1", "notice2"]);
  });

  it("NOTICE_COLLAPSE off leaves rankings byte-identical to no collapse logic at all", async () => {
    const { sqlite } = await setup();
    sqlite.seed({ id: "notice1", content: "Statement ready: balance $10.00 as of 2026-08-11", createdAt: 2000, source: "email-gmail" });
    sqlite.seed({ id: "notice2", content: "Statement ready: balance $20.00 as of 2026-08-04", createdAt: 1000, source: "email-gmail" });
    const env = denseEnv(sqlite, [{ id: "notice1", score: 0.9 }, { id: "notice2", score: 0.85 }]);
    const { matches } = await recallEntries({ query: "statement balance", topK: 5, synthesize: false }, env, ctx, DEFAULTS);
    expect(matches.map(m => m.id)).toEqual(["notice1", "notice2"]);
    expect(matches.every(m => m.similar === undefined)).toBe(true);
  });
});

describe("render: the similar-notices line (4.4)", () => {
  it("adds 'and N similar (dates)' to the header and a similar-ids line; no em dash anywhere", () => {
    const m: RecallMatch = {
      id: "notice1", content: "Statement ready", score: 1, createdAt: Date.UTC(2026, 7, 11, 12), updatedAt: Date.UTC(2026, 7, 11, 12),
      tags: [], source: "email-gmail", isUpdate: false, hop: 0,
      validFrom: Date.UTC(2026, 7, 11, 12), validFromStated: false, validUntil: null, validityState: "current",
      supersededBy: null, retractedSource: false,
      similar: [
        { id: "a1b2c3d4", createdAt: Date.UTC(2026, 7, 11, 12) },
        { id: "e5f6a7b8", createdAt: Date.UTC(2026, 7, 4, 12) },
        { id: "11112222", createdAt: Date.UTC(2026, 6, 28, 12) },
      ],
    };
    const out = renderRecallText([m], "");
    expect(out).toContain("and 3 similar (Aug 11, Aug 4, Jul 28)");
    expect(out).toContain("similar ids: a1b2c3d4, e5f6a7b8, 11112222");
    expect(out).not.toContain("—");
  });

  it("omits the similar line entirely when there is nothing collapsed", () => {
    const m: RecallMatch = {
      id: "x", content: "hello", score: 1, createdAt: Date.now(), updatedAt: Date.now(),
      tags: [], source: "api", isUpdate: false, hop: 0,
      validFrom: Date.now(), validFromStated: false, validUntil: null, validityState: "current",
      supersededBy: null, retractedSource: false,
    };
    const out = renderRecallText([m], "");
    expect(out).not.toContain("similar");
  });
});

describe("REST /recall exposes similar[]", () => {
  it("returns similar entries per collapsed match", async () => {
    const { sqlite, env } = await setup();
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ NOTICE_COLLAPSE: "on" }));
    sqlite.seed({ id: "notice1", content: "Statement ready: balance $10.00 as of 2026-08-11", createdAt: 2000, source: "email-gmail" });
    sqlite.seed({ id: "notice2", content: "Statement ready: balance $20.00 as of 2026-08-04", createdAt: 1000, source: "email-gmail" });
    (env as any).VECTORIZE = makeVectorizeMock({
      query: vi.fn(async () => ({
        count: 2,
        matches: [
          { id: "notice1", score: 0.9, metadata: { parentId: "notice1", isUpdate: false } },
          { id: "notice2", score: 0.85, metadata: { parentId: "notice2", isUpdate: false } },
        ],
      })),
    });
    const res = await worker.fetch(req("POST", "/recall?query=statement+balance"), env, ctx);
    const body = await res.json() as any;
    const survivor = body.results.find((r: any) => r.id === "notice1");
    expect(survivor.similar).toEqual([{ id: "notice2", created_at: 1000 }]);
  });
});
