/** Issue #54: excluded rows must not consume the degraded priority window. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { observeWorkersAiQuotaError } from "../../src/lib/ai";
import type { Identity } from "../../src/lib/identity";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const NOW = Date.UTC(2026, 8, 6, 0);
const OLD = NOW - 180 * 86_400_000;
const MODES = ["quota", "embedding-failure", "vector-failure"] as const;
const EXCLUSIONS = ["status:deprecated", "auto-pattern", "auto-insight", "wrong-kind"] as const;
type Mode = typeof MODES[number] | "healthy";
const open: SqliteD1[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  try { for (let i = 0; i < pending.length; i++) await pending[i]; }
  finally { pending.length = 0; open.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); }
});

async function fixture(mode: Mode, query: string, exclusion: typeof EXCLUSIONS[number]) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const sqlite = makeSqliteD1(); open.push(sqlite);
  sqlite.seed({ id: "old-decision", content: `${query} decision approved.`, createdAt: OLD,
    tags: ["kind:semantic", "status:canonical"], importanceScore: 5 });
  // Usable priority candidates (also eligible for the lone-CJK authority lane)
  // expose post-LIMIT/MMR filtering slot loss independently of retrieval.
  for (let i = 0; i < 8; i++) sqlite.seed({ id: `usable-${i}`, content: `${query} working note.`,
    createdAt: NOW - 10_000 - i, tags: ["kind:semantic", "status:canonical"] });
  const tags = exclusion === "wrong-kind" ? ["status:canonical", "kind:episodic"]
    : ["status:canonical", "kind:semantic", exclusion];
  for (let i = 0; i < 160; i++) sqlite.seed({ id: `excluded-${i}`, content: `${query} decision approved.`,
    createdAt: NOW - i, tags, importanceScore: 5 });
  const calls: { sql: string; args: unknown[]; returned: number }[] = [];
  const prepare = sqlite.db.prepare.bind(sqlite.db);
  vi.spyOn(sqlite.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT id, content, tags, source, created_at FROM entries WHERE")
      && !sql.startsWith("WITH s AS MATERIALIZED (SELECT id, created_at, tags, source, lower(content) AS lc")) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...args) => {
      const bound = bind(...args); const all = bound.all.bind(bound);
      vi.spyOn(bound, "all").mockImplementation(async () => {
        const result = await all(); calls.push({ sql, args, returned: result.results.length }); return result;
      });
      return bound;
    });
    return statement;
  });
  const vector = vi.fn().mockResolvedValue({ matches: [] });
  if (mode === "vector-failure") vector.mockRejectedValue(new Error("synthetic Vectorize outage"));
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vector }),
  }));
  if (mode === "quota") await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));
  if (mode === "embedding-failure") vi.mocked(env.AI.run).mockRejectedValue(new Error("synthetic embedding outage"));
  return { sqlite, calls, async recall(cap = 128, options: {
    kind?: "semantic"; after?: number; before?: number;
  } = { kind: "semantic" }, internal: RecallInternalOptions = {}) {
    const diagnostics: RecallDiagnostics = {};
    const ctx = { waitUntil: (task: Promise<unknown>) => { pending.push(task); } } as ExecutionContext;
    const result = await recallEntries({ query, topK: 5, hops: 0, synthesize: false, ...options }, env, ctx,
      { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: cap }, { ...internal, diagnostics });
    for (let i = 0; i < pending.length; i++) await pending[i];
    expect(calls.length).toBeLessThanOrEqual(2);
    const returnedLimit = mode === "vector-failure" ? cap + Math.min(32, Math.floor(cap / 4)) : cap;
    expect(calls.reduce((sum, call) => sum + call.returned, 0)).toBeLessThanOrEqual(returnedLimit);
    for (const call of calls) {
      expect(call.args.length).toBeLessThanOrEqual(100);
      // WHERE patterns lead the bindings; word-first ORDER patterns sit just before LIMIT.
      const [whereSql, orderSql = ""] = call.sql.split(" ORDER BY ");
      const whereCount = (whereSql.match(/(?:LIKE|GLOB) \?/g) ?? []).length;
      const orderCount = (orderSql.match(/(?:LIKE|GLOB) \?/g) ?? []).length;
      const patterns = [...call.args.slice(0, whereCount), ...call.args.slice(call.args.length - 1 - orderCount, call.args.length - 1)];
      expect(patterns).toHaveLength(whereCount + orderCount);
      for (const pattern of patterns) {
        expect(new TextEncoder().encode(String(pattern)).byteLength).toBeLessThanOrEqual(50);
      }
    }
    expect(diagnostics.keywordIds?.length ?? 0).toBeLessThanOrEqual(cap);
    expect(new Set(diagnostics.keywordIds).size).toBe(diagnostics.keywordIds?.length ?? 0);
    expect(diagnostics.operations?.d1RowsRead).toBeNull();
    if (mode === "quota") { expect(env.AI.run).not.toHaveBeenCalled(); expect(vector).not.toHaveBeenCalled(); }
    else if (mode === "embedding-failure") expect(vector).not.toHaveBeenCalled();
    else expect(vector).toHaveBeenCalledTimes(1);
    expect(result.semanticUnavailableReason).toBe(mode === "quota" ? "workers_ai_quota_exhausted"
      : mode === "embedding-failure" ? "embedding_unavailable"
        : mode === "vector-failure" ? "vectorize_unavailable" : undefined);
    return { result, diagnostics };
  } };
}

const CASES = MODES.flatMap(mode => ["cat", "認証"].flatMap(query => EXCLUSIONS.flatMap(exclusion =>
  [50, 128].map(cap => ({ mode, query, exclusion, cap })))));
describe("Issue #54: eligibility before bounded admission and selection", () => {
  it.each(CASES)("$mode / $query / $exclusion / cap=$cap", async ({ mode, query, exclusion, cap }) => {
    const f = await fixture(mode, query, exclusion);
    const { result, diagnostics } = await f.recall(cap);
    expect(diagnostics.keywordIds).toContain("old-decision");
    expect(result.matches.map(row => row.id)).toContain("old-decision");
    expect(result.matches).toHaveLength(5);
    expect(result.matches.every(row => row.id === "old-decision" || row.id.startsWith("usable-"))).toBe(true);
  });

  it.each(MODES)("%s: omitting kind does not silently restrict other memory kinds", async mode => {
    const f = await fixture(mode, "cat", "wrong-kind");
    const { result } = await f.recall(128, {});
    expect(result.matches.some(row => row.tags.includes("kind:episodic"))).toBe(true);
  });

  it.each(["quota", "vector-failure"] as const)("%s: scope and time still precede priority LIMIT", async mode => {
    const f = await fixture(mode, "cat", "status:deprecated");
    await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE 1").bind("own").run();
    for (let i = 0; i < 160; i++) {
      f.sqlite.seed({ id: `foreign-${i}`, content: "cat decision approved.", createdAt: NOW - i,
        tags: ["kind:semantic", "status:canonical"], importanceScore: 5 });
      await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind("foreign", `foreign-${i}`).run();
    }
    for (const [id, createdAt] of [["before-after", OLD - 1], ["at-before", NOW + 1]] as const) {
      f.sqlite.seed({ id, content: "cat decision approved.", createdAt,
        tags: ["kind:semantic", "status:canonical"], importanceScore: 5 });
      await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind("own", id).run();
    }
    const identity: Identity = { userId: "member", role: "member", personalWorkspaceId: "own", companyWorkspaceIds: [], defaultShare: "" };
    const { result, diagnostics } = await f.recall(128, { kind: "semantic", after: OLD, before: NOW + 1 }, { identity });
    expect(result.matches.map(row => row.id)).toContain("old-decision");
    expect(result.matches).toHaveLength(5);
    expect(diagnostics.keywordIds?.some(id => id.startsWith("foreign-") || id === "before-after" || id === "at-before")).toBe(false);
  });

  it("recovers eligible healthy candidates without adding a SELECT", async () => {
    const f = await fixture("healthy", "cat", "status:deprecated");
    const { result, diagnostics } = await f.recall();
    expect(f.calls).toHaveLength(1);
    expect(diagnostics.keywordIds).toHaveLength(9);
    expect(diagnostics.keywordIds).toContain("old-decision");
    expect(result.matches.map(row => row.id)).toContain("old-decision");
    expect(result.semanticUnavailable).toBe(false);
  });
});
