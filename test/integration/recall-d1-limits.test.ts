/**
 * The two statements in recall whose size is decided by data rather than by the
 * code that builds them: the keyword arm's OR chain of `content LIKE ?` terms,
 * and the hydration `id IN (…)` list. D1 caps bound parameters at 100 and
 * expression-tree depth at 100, and both statements are one constant away from
 * either ceiling.
 *
 * #276 is what that looks like in production. `distillToRareTerms` narrows a
 * query to its MAX_QUERY_TERMS rarest terms by counting how often each occurs
 * across the corpus; with no rows to count it hands the query back whole, the
 * keyword arm turns every token into its own LIKE clause, and past roughly 120
 * words the request fails outright. A fresh install was one long question away
 * from a recall that could not answer, until the user saved their first memory.
 *
 * Driven against real SQLite (`test/helpers/sqlite-d1.ts`) so the empty corpus
 * is genuinely empty — the frequency aggregate returns `total: 0` because there
 * is nothing to count, not because a mock said so. The D1 limits are layered on
 * top, because nothing else here enforces them: the D1 mock evaluates no SQL,
 * and `node:sqlite` accepts 999 OR'd terms against its own depth ceiling of
 * 1000. A test run against either would pass while the Worker returned a 500.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { recallEntries } from "../../src/recall/search";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";
import { D1_MAX_LIKE_PATTERN_BYTES } from "../../src/constants";
import { likeContainsPattern, tokenizeQueryDetailed } from "../../src/text/lexical-query";
import { RECALL_SEED_TOPK, graphSeedLimit } from "../../src/recall/neighborhood";

// The dense arm's graph seats: fixed by RECALL_SEED_TOPK, not by the topK a caller asks for.
const RECALL_GRAPH_SEEDS = graphSeedLimit(RECALL_SEED_TOPK, 1_000);

// Measured against the Workers runtime for this issue: 119 words recalled, 120
// (100 tokens) returned a 500, and depth was the limit that bound first.
const D1_MAX_BOUND_PARAMS = 100;
const D1_MAX_EXPR_DEPTH = 100;

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

// 120 coined words: every one clears the minimum token length and none is a
// stopword, so the token count is exactly the word count. A real 120-word
// question lands on the same 100 tokens once stopwords are stripped.
const LONG_QUERY = Array.from({ length: 120 }, (_, i) => `topic${i}`).join(" ");
const LONG_MIXED_QUERY = "ユーザーはsecond-brain-cfに保存済みのEmbeddingGemma関連メモをquota枯渇中でも読み取れるか本番確認したい。どんな内容が記録されているか。";
const LONG_COMPAT_QUERY = Array.from({ length: 20 }, (_, i) =>
  `topic${i}`.replace(/[!-~]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0))
).join(" ");

interface Executed { sql: string; params: unknown[] }

/**
 * A D1 facade that enforces the two limits the real one enforces, and records
 * what was executed. `failWhen` fails a single statement, for the exit that
 * needs a database error rather than an empty corpus to fire.
 */
function withD1Limits(
  inner: SqliteD1["db"],
  executed: Executed[],
  failWhen: (sql: string) => boolean = () => false,
) {
  const check = (sql: string, params: unknown[]) => {
    executed.push({ sql, params });
    if (failWhen(sql)) throw new Error("D1_ERROR: network error: SQLITE_ERROR");
    // An N-way OR chain parses one level deeper than N, which is why 99 LIKE
    // terms are accepted and 100 are not. "ORDER BY" cannot match: the "OR"
    // there is not followed by whitespace. Checked before the parameter budget
    // because that is the order the runtime reported them in — parsing first.
    if (exprDepth(sql) > D1_MAX_EXPR_DEPTH) {
      throw new Error(`D1_ERROR: Expression tree is too large (maximum depth ${D1_MAX_EXPR_DEPTH}): SQLITE_ERROR`);
    }
    if (params.length > D1_MAX_BOUND_PARAMS) {
      throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
    }
    for (const param of params) {
      if (typeof param === "string"
        && param.startsWith("%")
        && param.endsWith("%")
        && new TextEncoder().encode(param).byteLength > D1_MAX_LIKE_PATTERN_BYTES) {
        throw new Error("D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR");
      }
    }
  };
  const wrap = (sql: string, stmt: any, params: unknown[]): any => ({
    bind: (...args: unknown[]) => wrap(sql, stmt.bind(...args), args),
    all: async () => { check(sql, params); return stmt.all(); },
    first: async () => { check(sql, params); return stmt.first(); },
    run: async () => { check(sql, params); return stmt.run(); },
  });
  return {
    prepare: (sql: string) => wrap(sql, inner.prepare(sql), []),
    exec: (sql: string) => inner.exec(sql),
    batch: async (statements: { run(): Promise<unknown> }[]) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

const exprDepth = (sql: string) => sql.split(/\s+OR\s+/i).length + 1;

const keywordStatements = (executed: Executed[]) =>
  executed.filter(e => /FROM entries WHERE \(?content LIKE/.test(e.sql));

const edgeScanStatements = (executed: Executed[]) =>
  executed.filter(e => /FROM edges WHERE/.test(e.sql));

const hydrationStatements = (executed: Executed[]) =>
  // "superseded_by_json" (T-0089.2.1) is unique to the full hydration
  // projection; the narrower candidateSignalProjection read also matches
  // "FROM entries WHERE id IN" alone.
  executed.filter(e => e.sql.includes("superseded_by_json") && e.sql.includes("FROM entries WHERE id IN"));

describe("recall stays inside D1's statement limits", () => {
  let sqlite: SqliteD1;
  let executed: Executed[];

  beforeEach(async () => {
    sqlite = makeSqliteD1();
    executed = [];
    // `updated_at` is one of the columns src/db/init.ts adds by ALTER at
    // runtime rather than in schema.sql, and that path goes through `exec`,
    // which this facade does not implement. Recall's hydration selects it.
  });

  afterEach(() => sqlite.close());

  const envWith = (failWhen?: (sql: string) => boolean, overrides: Partial<Env> = {}): Env =>
    makeTestEnv(undefined, {
      DB: withD1Limits(sqlite.db, executed, failWhen) as unknown as D1Database,
      ...overrides,
    });

  describe("the keyword clause, on an empty brain (#276)", () => {
    it("scopes both existing candidate reads to one explicit date", async () => {
      // parseTimePhrase anchors in the brain's TIMEZONE (UTC by default, T-0089.2.2),
      // not the test runner's host zone.
      const day = Date.UTC(2026, 7, 17);
      sqlite.seed({ id: "in-range", content: "quartz ledger record", createdAt: day + 1 });
      sqlite.seed({ id: "out-of-range", content: "quartz ledger record", createdAt: day + 86400000 + 1 });
      const env = envWith(undefined, {
        VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
      });

      const result = await recallEntries({
        query: "quartz ledger on August 17",
        topK: 5,
        hops: 0,
        synthesize: false,
      }, env, ctx);

      expect(result.matches.map(match => match.id)).toEqual(["in-range"]);
      const frequency = executed.find(entry => entry.sql.includes("SUM(CASE WHEN content LIKE"));
      const keyword = keywordStatements(executed)[0];
      expect(frequency?.sql).toContain("WHERE created_at >= ? AND created_at < ?");
      expect(keyword.sql).toContain("AND created_at >= ? AND created_at < ?");
      expect(frequency?.params.slice(-2)).toEqual([day, day + 86400000]);
      const whereProbes = (keyword.sql.split(" ORDER BY ")[0].match(/content LIKE \?/g) ?? []).length;
      expect(keyword.params.slice(whereProbes, whereProbes + 2)).toEqual([day, day + 86400000]);
    });

    it("answers a 120-word query with no memories stored", async () => {
      const res = await worker.fetch(
        req("POST", "/recall", { body: { query: LONG_QUERY } }),
        envWith(),
        ctx,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.results).toEqual([]);

      const [keyword] = keywordStatements(executed);
      expect(keyword).toBeDefined();
      // One parameter per LIKE term plus the row limit.
      expect(keyword.params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      expect(exprDepth(keyword.sql)).toBeLessThanOrEqual(D1_MAX_EXPR_DEPTH);
    });

    it("keeps 16 raw NFKC compatibility probes inside the same D1 limits", async () => {
      const res = await worker.fetch(
        req("POST", "/recall", { body: { query: LONG_COMPAT_QUERY } }),
        envWith(),
        ctx,
      );

      expect(res.status).toBe(200);
      const [keyword] = keywordStatements(executed);
      expect(keyword).toBeDefined();
      expect(keyword.params.length).toBe(69); // validity + 16 normalized + 16 raw, each in WHERE and ORDER, + 3 scope + LIMIT
      expect(keyword.params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      expect(exprDepth(keyword.sql)).toBeLessThanOrEqual(D1_MAX_EXPR_DEPTH);
    });

    it("keeps all WHERE probes before spending remaining binds on ORDER", async () => {
      const identity: Identity = {
        userId: "many-teams",
        role: "member",
        personalWorkspaceId: "personal",
        companyWorkspaceIds: Array.from({ length: 80 }, (_, i) => `company-${i}`),
        defaultShare: "",
      };
      await recallEntries(
        { query: LONG_QUERY, topK: 5, hops: 0, synthesize: false },
        envWith(), ctx, undefined, { identity },
      );

      const [keyword] = keywordStatements(executed);
      expect(keyword).toBeDefined();
      expect(keyword.params).toHaveLength(D1_MAX_BOUND_PARAMS);
      expect((keyword.sql.split(" ORDER BY ")[0].match(/content LIKE \?/g) ?? [])).toHaveLength(16);
      expect((keyword.sql.split(" ORDER BY ")[1].match(/CASE WHEN content LIKE \?/g) ?? [])).toHaveLength(1);
      expect(keyword.params.slice(16, 97)).toEqual(["personal", ...identity.companyWorkspaceIds]);
      expect(keyword.params.slice(98, 99)).toEqual(keyword.params.slice(0, 1));
      expect(keyword.params.at(-1)).toBe(128);
    });

    it("preserves primary-then-raw WHERE probes when no bind remains for ORDER", async () => {
      const identity: Identity = {
        userId: "many-teams",
        role: "member",
        personalWorkspaceId: "personal",
        companyWorkspaceIds: Array.from({ length: 80 }, (_, i) => `company-${i}`),
        defaultShare: "",
      };
      await recallEntries(
        { query: LONG_COMPAT_QUERY, topK: 5, hops: 0, synthesize: false },
        envWith(), ctx, undefined, { identity },
      );

      const [keyword] = keywordStatements(executed);
      const terms = tokenizeQueryDetailed(LONG_COMPAT_QUERY).slice(0, 16);
      const originalWhere = [
        ...terms.map(term => term.probes[0]),
        ...terms.flatMap(term => term.probes.slice(1)),
      ].slice(0, 17).map(likeContainsPattern);
      expect(originalWhere).toHaveLength(17);
      expect(originalWhere.slice(16)).toEqual(["%ｔｏｐｉｃ０%"]);
      expect(keyword.params.slice(0, 17)).toEqual(originalWhere);
      expect(keyword.params.slice(17, 98)).toEqual(["personal", ...identity.companyWorkspaceIds]);
      expect(keyword.sql.split(" ORDER BY ")[0].match(/content LIKE \?/g)).toHaveLength(17);
      expect(keyword.sql).toContain("ORDER BY created_at DESC LIMIT ?");
      expect(keyword.params).toHaveLength(D1_MAX_BOUND_PARAMS);
      expect(keyword.params.at(-1)).toBe(128);
    });

    it("answers a 120-word query when the frequency scan itself fails", async () => {
      // The other exit that returns the query uncapped, and the reason the cap
      // lives where the clause is built rather than at one distillation exit:
      // here the corpus is not empty, the statistics are simply unavailable.
      sqlite.seed({ id: "e1", content: "topic0 is written down", createdAt: 1000 });
      const scanFailed = (sql: string) => sql.includes("SUM(CASE WHEN content LIKE");

      const res = await worker.fetch(
        req("POST", "/recall", { body: { query: LONG_QUERY } }),
        envWith(scanFailed),
        ctx,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.results.map((r: any) => r.id)).toEqual(["e1"]);

      const [keyword] = keywordStatements(executed);
      expect(keyword.params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      expect(exprDepth(keyword.sql)).toBeLessThanOrEqual(D1_MAX_EXPR_DEPTH);
    });

    it("still distills to the rarest terms, and still finds them, once a memory exists", async () => {
      sqlite.seed({ id: "e1", content: "topic0 is written down", createdAt: 1000 });
      const env = envWith();

      const long = await worker.fetch(
        req("POST", "/recall", { body: { query: LONG_QUERY } }),
        env,
        ctx,
      );
      expect(long.status).toBe(200);
      // Distillation still puts its three rarest terms first, while bounded
      // retrieval anchors use the remainder of the existing 16-token budget.
      // Next come the three workspace-scope bindings (personal, company,
      // legacy '') that v3 adds whenever an Identity is in play, then the
      // current-validity bound (T-0089.2.1), then the row limit — 16 + 3 + 1
      // + 1 = 21 — and then the 16 terms the statement scores for the notes
      // it selects, each bound once and referenced by number: 37, far under
      // D1's 100.
      expect(keywordStatements(executed)[0].params.length).toBe(37);

      executed.length = 0;
      const short = await worker.fetch(req("POST", "/recall", { body: { query: "topic0" } }), env, ctx);
      expect(short.status).toBe(200);
      const data = await short.json() as any;
      expect(data.results.map((r: any) => r.id)).toEqual(["e1"]);
    });

    it("keeps long mixed Japanese queries readable during Workers AI quota fallback", async () => {
      sqlite.seed({ id: "e1", content: "EmbeddingGemmaの推論閾値と再索引の記録", createdAt: 1000 });
      const env = envWith(undefined, {
        AI: {
          run: vi.fn().mockRejectedValue(new Error(
            "4006: you have used up your daily free allocation of 10,000 neurons",
          )),
        } as unknown as Ai,
      });

      const res = await worker.fetch(
        req("POST", "/recall", { body: { query: LONG_MIXED_QUERY } }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.results.map((r: any) => r.id)).toContain("e1");
      expect(data.semantic_unavailable).toBe(true);
      expect(data.semantic_unavailable_reason).toBe("workers_ai_quota_exhausted");
      const patterns = executed.flatMap(entry => entry.params)
        .filter((param): param is string => typeof param === "string" && param.startsWith("%") && param.endsWith("%"));
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.every(pattern =>
        new TextEncoder().encode(pattern).byteLength <= D1_MAX_LIKE_PATTERN_BYTES
      )).toBe(true);
    });
  });

  describe("the hydration id list", () => {
    // Direct recall can exceed the public topK cap when recallEntries is called
    // internally, while graph-aware recall hydrates at most RECALL_GRAPH_SEEDS candidate
    // roots plus 50 expanded nodes. Both paths must leave room for shared filter bindings.
    const N = 150;
    const ids = Array.from({ length: N }, (_, i) => `e${i}`);

    it("chunks the ids rather than binding them all in one statement", async () => {
      for (const [i, id] of ids.entries()) {
        sqlite.seed({ id, content: `memory ${i} about topic0`, createdAt: 1000 + i });
      }
      const env = envWith(undefined, {
        VECTORIZE: makeVectorizeMock({
          query: vi.fn().mockResolvedValue({
            matches: ids.map((id, i) => ({
              id,
              score: 1 - i / (N * 2),
              metadata: { parentId: id, created_at: 1000 + i },
            })),
          }),
        }),
      });

      const { matches } = await recallEntries(
        { query: "topic0", topK: N, synthesize: false }, env, ctx,
      );

      // Every seed hydrated exactly once: nothing dropped at a batch boundary,
      // nothing counted twice by an overlapping slice.
      expect(matches.length).toBe(N);
      expect(new Set(matches.map(m => m.id)).size).toBe(N);
      expect([...matches.map(m => m.id)].sort()).toEqual([...ids].sort());
      expect(matches.every(m => m.content === `memory ${ids.indexOf(m.id)} about topic0`)).toBe(true);

      const hydration = hydrationStatements(executed);
      expect(hydration.length).toBe(2);
      // Was [100, 50] before the current-validity bound (T-0089.2.1) joined
      // filterBindings: idBatchSize drops by 1, so 99 ids (+1 filter binding)
      // fill the first chunk and the remaining 51 (+1) land in the second.
      expect(hydration.map(h => h.params.length)).toEqual([100, 52]);
      expect(Math.max(...hydration.map(h => h.params.length))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });

    it("leaves room for the time-filter bindings it shares the budget with", async () => {
      for (const [i, id] of ids.entries()) {
        sqlite.seed({ id, content: `memory ${i} about topic0`, createdAt: 1000 + i });
      }
      const env = envWith(undefined, {
        VECTORIZE: makeVectorizeMock({
          query: vi.fn().mockResolvedValue({
            matches: ids.map((id, i) => ({
              id,
              score: 1 - i / (N * 2),
              metadata: { parentId: id, created_at: 1000 + i },
            })),
          }),
        }),
      });

      // `after` and `before` are bound on every batch, so the id slice has to be
      // smaller than the parameter budget, not equal to it.
      const { matches } = await recallEntries(
        { query: "topic0", topK: N, after: 1000, before: 1000 + N, synthesize: false }, env, ctx,
      );

      expect(matches.length).toBe(N);
      const hydration = hydrationStatements(executed);
      // Was [100, 54] before the current-validity bound (T-0089.2.1) joined
      // filterBindings alongside after/before: idBatchSize drops by 1 more.
      expect(hydration.map(h => h.params.length)).toEqual([100, 56]);
      expect(Math.max(...hydration.map(h => h.params.length))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });

    it("keeps the largest graph-root plus expanded-node union inside one statement's budget, with tag and time filters", async () => {
      // Graph seeds are capped at RECALL_GRAPH_SEEDS whatever topK is, so the union is at most
      // the direct matches, that many roots and 50 expanded nodes: under one statement's budget.
      const roots = Array.from({ length: RECALL_GRAPH_SEEDS + 5 }, (_, i) => `root-${i}`);
      for (const [i, id] of roots.entries()) {
        sqlite.seed({ id, content: `topic0 decision root ${i}`, createdAt: 1000 + i, tags: ["work"], vectorIds: [`v-${id}`] });
        for (const n of [0, 1, 2, 3]) {
          const neighbor = `${id}-neighbor-${n}`;
          sqlite.seed({ id: neighbor, content: `linked evidence ${i}`, createdAt: 1000 + i, tags: ["work"] });
          await sqlite.db.prepare(
            `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(`edge-${id}-${n}`, id, neighbor, "decided", 1, "explicit", "{}", 1, 1).run();
        }
      }
      const env = envWith(undefined, {
        VECTORIZE: makeVectorizeMock({
          getByIds: vi.fn(async (ids: string[]) => ids.map(id => ({
            id,
            values: new Array(128).fill(0.1),
            metadata: { parentId: id.replace(/^v-/, "") },
          }))),
        }),
      });

      const { matches } = await recallEntries(
        { query: "topic0", topK: 20, tag: "work", hops: 1, after: 900, before: 2000, synthesize: false },
        env,
        ctx,
      );

      expect(matches.length).toBeGreaterThanOrEqual(RECALL_GRAPH_SEEDS);
      expect(new Set(matches.map(m => m.id)).size).toBe(matches.length);
      const hydration = hydrationStatements(executed);
      expect(hydration.length).toBeGreaterThan(0);
      expect(hydration.every(h => h.params.includes('%"work"%'))).toBe(true);
      expect(Math.max(...hydration.map(h => h.params.length))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      expect(executed.length).toBeLessThanOrEqual(32);
    });

    // expandGraph's edge scan binds every seed TWICE (source_id IN (…) OR target_id
    // IN (…)), and a scoped caller's workspace bindings come out of the same budget.
    // A ceiling of 50 is only right for an identity-less caller: scoped, the batch is
    // floor((100 - bindings) / 2), so a 50-seed hop split into two statements.
    it("keeps a scoped hop's seeds inside one edge-scan statement", async () => {
      const identity = {
        userId: "u-1", role: "member" as const,
        personalWorkspaceId: "ws-personal", companyWorkspaceIds: ["ws-company"], defaultShare: "" as const,
      };
      const ids = Array.from({ length: 60 }, (_, i) => `root-${i}`);
      for (const [i, id] of ids.entries()) {
        sqlite.seed({ id, content: `topic0 decision root ${i}`, createdAt: 1000 + i });
        await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind("ws-personal", id).run();
      }
      const env = envWith(undefined, {
        VECTORIZE: makeVectorizeMock({
          query: vi.fn().mockResolvedValue({
            matches: ids.map((id, i) => ({ id, score: 1 - i / 200, metadata: { parentId: id, created_at: 1000 + i } })),
          }),
        }),
      });

      executed.length = 0;
      await recallEntries(
        { query: "topic0", topK: 20, hops: 1, synthesize: false }, env, ctx, undefined, { identity },
      );

      const edges = edgeScanStatements(executed);
      expect(edges).toHaveLength(1);
      expect(Math.max(...edges.map(e => e.params.length))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });
  });
});
