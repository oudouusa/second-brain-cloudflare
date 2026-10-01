/** Late dense failure: reuse the first read, never retry the provider or the broad scan. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { EmbeddingProfileMismatchError } from "../../src/embedding/profile";
import type { Identity } from "../../src/lib/identity";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const NOW = Date.UTC(2026, 8, 5, 12);
const OLD = NOW - 180 * 86_400_000;
const databases: SqliteD1[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  try { for (let i = 0; i < pending.length; i++) await pending[i]; }
  finally {
    pending.length = 0;
    databases.splice(0).forEach(db => db.close());
    vi.restoreAllMocks();
  }
});

function fixture(afterKeyword = false) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const sqlite = makeSqliteD1(); databases.push(sqlite);
  sqlite.seed({ id: "answer", content: "The cat adoption decision is approved.",
    createdAt: OLD, tags: ["kind:semantic", "status:canonical"], importanceScore: 5 });
  for (let i = 0; i < 160; i++) sqlite.seed({ id: `noise-${i}`,
    content: "We concatenate routine fields.", createdAt: NOW - i });
  let firstReadDone!: () => void;
  const firstRead = new Promise<void>(resolve => { firstReadDone = resolve; });
  const calls: { sql: string; args: unknown[]; returned: number }[] = [];
  const failure = { priority: false, initial: false };
  const prepare = sqlite.db.prepare.bind(sqlite.db);
  vi.spyOn(sqlite.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT id, content, tags, source, created_at FROM entries WHERE")
      && !sql.startsWith("WITH s AS MATERIALIZED (SELECT id, created_at, tags, source, lower(content) AS lc")) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...args) => {
      const bound = bind(...args);
      const all = bound.all.bind(bound);
      vi.spyOn(bound, "all").mockImplementation(async () => {
        const call = { sql, args, returned: 0 }; calls.push(call);
        if ((failure.priority && sql.includes(" GLOB ?")) || (failure.initial && calls.length === 1)) {
          firstReadDone();
          throw new Error("injected candidate query failure");
        }
        const result = await all(); call.returned = result.results.length;
        firstReadDone();
        return result;
      });
      return bound;
    });
    return statement;
  });
  const vector = vi.fn(async () => {
    if (afterKeyword) await firstRead;
    throw new Error("injected Vectorize outage");
  });
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vector }),
  }));
  const ctx = { waitUntil: (task: Promise<unknown>) => { pending.push(task); } } as ExecutionContext;
  return { sqlite, env, vector, calls, failure, async recall(
    query = "cat", cap = 128, internal: RecallInternalOptions = {},
  ) {
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query, topK: 5, hops: 0, synthesize: false },
      env, ctx, { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: cap }, { ...internal, diagnostics });
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls.reduce((sum, call) => sum + call.returned, 0)).toBeLessThanOrEqual(cap + Math.min(32, Math.floor(cap / 4)));
    expect(diagnostics.keywordIds?.length ?? 0).toBeLessThanOrEqual(cap);
    expect(new Set(diagnostics.keywordIds).size).toBe(diagnostics.keywordIds?.length ?? 0);
    expect(diagnostics.operations?.d1RowsRead).toBeNull();
    for (const call of calls) {
      expect(call.args.length).toBeLessThanOrEqual(100);
      const patterns = (call.sql.match(/(?:LIKE|GLOB) \?/g) ?? []).length;
      for (const pattern of call.args.slice(0, patterns)) {
        expect(new TextEncoder().encode(String(pattern)).byteLength).toBeLessThanOrEqual(50);
      }
    }
    return { result, diagnostics };
  } };
}

describe("bounded late Vectorize recovery", () => {
  it.each([false, true])("rescues the old answer independently of completion order (after keyword=%s)", async afterKeyword => {
    const f = fixture(afterKeyword);
    const { result, diagnostics } = await f.recall();
    expect(result.semanticUnavailableReason).toBe("vectorize_unavailable");
    expect(result.matches[0]?.id).toBe("answer");
    expect(f.calls.map(call => call.returned)).toEqual([128, 1]);
    expect(f.calls[1].sql).toContain(" GLOB ?");
    expect(f.vector).toHaveBeenCalledTimes(1);
    expect(diagnostics.operations?.embeddingCalls).toBe(1);
  });

  it.each([50, 128])("rescues authority within cap=%s even when newer ordinary matches fill the priority lane", async cap => {
    const f = fixture(true);
    for (let i = 0; i < 40; i++) f.sqlite.seed({ id: `exact-${i}`,
      content: "A cat adoption.", createdAt: NOW + i });
    const { result, diagnostics } = await f.recall("cat", cap);
    expect(f.calls.map(call => call.returned)).toEqual([cap, Math.min(32, Math.floor(cap / 4))]);
    expect(diagnostics.keywordIds).toHaveLength(cap);
    // Ordinary new matches no longer crowd explicit authority out of the lane.
    // Equal-authority saturation is characterized separately, not called a win.
    expect(diagnostics.keywordIds).toContain("answer");
    expect(result.matches.map(row => row.id)).toContain("answer");
    expect(f.vector).toHaveBeenCalledTimes(1);
  });

  it("uses the configured cap for a rescued older match", async () => {
    const f = fixture(true);
    const { result, diagnostics } = await f.recall("cat", 50);
    expect(f.calls.map(call => call.returned)).toEqual([50, 1]);
    expect(diagnostics.keywordIds).toHaveLength(50);
    expect(result.matches[0]?.id).toBe("answer");
  });

  it.each(["ncat", "unobtainium-9f872e"])("keeps the initial results when priority has no match: %s", async query => {
    const f = fixture(true);
    const { result } = await f.recall(query);
    expect(f.calls.map(call => call.returned)).toEqual(query === "ncat" ? [128, 0] : [0, 0]);
    expect(result.matches.length > 0).toBe(query === "ncat");
    expect(f.vector).toHaveBeenCalledTimes(1);
  });

  it("keeps the first read if the optional rescue SELECT fails, without looping", async () => {
    const f = fixture(true); f.failure.priority = true;
    const { result, diagnostics } = await f.recall();
    expect(result.semanticUnavailableReason).toBe("vectorize_unavailable");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(diagnostics.keywordIds).toHaveLength(128);
    expect(diagnostics.keywordIds).not.toContain("answer");
    expect(f.calls).toHaveLength(2); expect(f.vector).toHaveBeenCalledTimes(1);
  });

  it("does not hide a failure of the initial required keyword read", async () => {
    const f = fixture(); f.failure.initial = true;
    await expect(f.recall()).rejects.toThrow("injected candidate query failure");
    expect(f.calls).toHaveLength(1);
  });

  it("does not convert embedding-profile mismatch into an outage or retry", async () => {
    const f = fixture();
    const failure = new EmbeddingProfileMismatchError("wrong index profile");
    f.vector.mockRejectedValue(failure);
    await expect(f.recall()).rejects.toBe(failure);
    expect(f.calls).toHaveLength(1); expect(f.vector).toHaveBeenCalledTimes(1);
  });

  it("keeps an empty healthy Vectorize response on the original one-SELECT path", async () => {
    const f = fixture();
    f.vector.mockResolvedValue({ matches: [] } as never);
    const { result } = await f.recall();
    expect(result.semanticUnavailable).toBe(false);
    expect(f.calls).toHaveLength(1); expect(f.vector).toHaveBeenCalledTimes(1);
  });

  it("retains narrow dense results when only widening fails", async () => {
    const f = fixture();
    f.vector.mockResolvedValueOnce({ matches: [{ id: "vector-answer", score: 0.1,
      metadata: { parentId: "answer", created_at: OLD }, values: new Array(128).fill(.1) }] } as never);
    const { result, diagnostics } = await f.recall();
    expect(result.semanticUnavailable).toBe(false);
    expect(diagnostics.denseIds).toContain("answer");
    expect(f.calls).toHaveLength(1); expect(f.vector).toHaveBeenCalledTimes(2);
  });

  it("skips the optional lane at the existing 100-binding limit", async () => {
    const f = fixture(true);
    f.sqlite.seed({ id: "wide", content: "Ｃｌｏｕｄｆｌａｒｅ rollout", createdAt: NOW + 1 });
    await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE 1").bind("own").run();
    const identity: Identity = { userId: "member", role: "member", personalWorkspaceId: "own",
      companyWorkspaceIds: Array.from({ length: 95 }, (_, i) => `team-${i}`), defaultShare: "" };
    const { diagnostics } = await f.recall("Ｃｌｏｕｄｆｌａｒｅ", 128, { identity });
    expect(f.calls).toHaveLength(1); expect(f.calls[0].args).toHaveLength(100);
    expect(diagnostics.keywordIds).toContain("wide");
  });
});
