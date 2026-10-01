/** Authority rescue must reuse admitted, eligible evidence, never metadata alone. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { observeWorkersAiQuotaError } from "../../src/lib/ai";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const NOW = Date.UTC(2026, 8, 5, 12);
const OLD = NOW - 180 * 86_400_000;
const MODES = ["quota", "embedding-failure", "vector-failure"] as const;
type Mode = typeof MODES[number] | "healthy";
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

async function fixture(mode: Mode) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const sqlite = makeSqliteD1(); databases.push(sqlite);
  sqlite.seed({ id: "authority", content: "A cat adoption.", createdAt: OLD,
    tags: ["kind:semantic", "status:canonical"] });
  for (let i = 0; i < 8; i++) {
    sqlite.seed({ id: `recent-${i}`, content: "A cat adoption.", createdAt: NOW - i,
      tags: ["kind:semantic"] });
    sqlite.seed({ id: `noise-${i}`, content: "We concatenate routine fields.", createdAt: NOW - i });
  }
  const vector = vi.fn().mockResolvedValue({ matches: [] });
  if (mode === "vector-failure") vector.mockRejectedValue(new Error("injected Vectorize outage"));
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vector }),
  }));
  if (mode === "quota") await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));
  if (mode === "embedding-failure") vi.mocked(env.AI.run).mockRejectedValue(new Error("injected embedding outage"));
  const ctx = { waitUntil: (task: Promise<unknown>) => { pending.push(task); } } as ExecutionContext;
  return { sqlite, env, vector, async recall(options: { topK?: number; kind?: "semantic"; hops?: number } = {}) {
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: "cat", topK: 5, hops: 0, synthesize: false, ...options },
      env, ctx, DEFAULTS, { diagnostics });
    for (let i = 0; i < pending.length; i++) await pending[i];
    expect(diagnostics.keywordIds?.length ?? 0).toBeLessThanOrEqual(128);
    expect(diagnostics.operations?.d1RowsRead).toBeNull();
    if (mode === "quota") {
      expect(env.AI.run).not.toHaveBeenCalled();
      expect(vector).not.toHaveBeenCalled();
    } else if (mode === "embedding-failure") expect(vector).not.toHaveBeenCalled();
    else expect(vector).toHaveBeenCalledTimes(1);
    expect(result.semanticUnavailableReason).toBe(mode === "quota" ? "workers_ai_quota_exhausted"
      : mode === "embedding-failure" ? "embedding_unavailable"
        : mode === "vector-failure" ? "vectorize_unavailable" : undefined);
    return { result, diagnostics };
  } };
}

const EXCLUSIONS = ["status:deprecated", "auto-pattern", "auto-insight", "wrong-kind"] as const;
describe("authority rescue eligibility", () => {
  it.each(MODES.flatMap(mode => EXCLUSIONS.map(exclusion => ({ mode, exclusion }))))(
    "$mode: an excluded $exclusion candidate must not evict a usable direct result", async ({ mode, exclusion }) => {
      const f = await fixture(mode);
      const tags = exclusion === "wrong-kind"
        ? ["kind:episodic", "status:canonical"] : ["kind:semantic", "status:canonical", exclusion];
      await f.sqlite.db.prepare("UPDATE entries SET tags = ? WHERE id = ?")
        .bind(JSON.stringify(tags), "authority").run();
      const { result, diagnostics } = await f.recall({ kind: "semantic" });
      expect(diagnostics.keywordIds).not.toContain("authority");
      expect(result.matches).toHaveLength(5);
      expect(result.matches.every(row => row.id.startsWith("recent-"))).toBe(true);
    },
  );

  it.each(MODES)("%s: an eligible lower-ranked canonical match occupies at most one slot", async mode => {
    const f = await fixture(mode);
    for (const id of ["authority-b", "authority-c"]) f.sqlite.seed({ id,
      content: "A cat adoption.", createdAt: OLD, tags: ["kind:semantic", "status:canonical"] });
    const { result } = await f.recall();
    expect(result.matches.map(row => row.id)).toEqual([
      "recent-0", "recent-1", "recent-2", "recent-3", "authority",
    ]);
    expect(new Set(result.matches.map(row => row.id)).size).toBe(5);
  });

  it.each([1, 2, 5])("keeps topK=%s bounded when rescuing the canonical result", async topK => {
    const f = await fixture("quota");
    const { result } = await f.recall({ topK });
    expect(result.matches).toHaveLength(topK);
    expect(result.matches.map(row => row.id)).toContain("authority");
  });

  it("does not force a slot on the healthy path even when the canonical row was admitted", async () => {
    const f = await fixture("healthy");
    const { result, diagnostics } = await f.recall();
    expect(diagnostics.keywordIds).toContain("authority");
    expect(result.semanticUnavailable).toBe(false);
    expect(result.matches).toHaveLength(5);
    expect(result.matches.every(row => row.id.startsWith("recent-"))).toBe(true);
  });

  it("uses refreshed D1 metadata rather than a stale authority flag from candidate generation", async () => {
    const f = await fixture("quota");
    const prepare = f.sqlite.db.prepare.bind(f.sqlite.db);
    let revoked = false;
    vi.spyOn(f.sqlite.db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (!sql.startsWith("SELECT id, created_at, recall_count")) return statement;
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, "bind").mockImplementation((...args) => {
        const bound = bind(...args);
        const all = bound.all.bind(bound);
        vi.spyOn(bound, "all").mockImplementation(async () => {
          await prepare("UPDATE entries SET tags = ? WHERE id = ?")
            .bind(JSON.stringify(["kind:semantic"]), "authority").run();
          revoked = true;
          return all();
        });
        return bound;
      });
      return statement;
    });
    const { result, diagnostics } = await f.recall();
    expect(revoked).toBe(true);
    expect(diagnostics.keywordIds).toContain("authority");
    expect(result.matches).toHaveLength(5);
    expect(result.matches.every(row => row.id.startsWith("recent-"))).toBe(true);
  });
});


describe("remaining authority admission boundary (not a recall win)", () => {
  it.each(["quota", "vector-failure"] as const)("%s: more than 32 equal-authority rows can still exclude the old answer", async mode => {
    const f = await fixture(mode);
    await f.sqlite.db.prepare("UPDATE entries SET importance_score = 5 WHERE id = ?").bind("authority").run();
    for (let i = 0; i < 40; i++) f.sqlite.seed({ id: `new-authority-${i}`,
      content: "A cat adoption.", createdAt: NOW + i, importanceScore: 5,
      tags: ["kind:semantic", "status:canonical"] });
    for (let i = 0; i < 160; i++) f.sqlite.seed({ id: `filler-${i}`,
      content: "We concatenate routine fields.", createdAt: NOW - i });
    const { result, diagnostics } = await f.recall();
    expect(diagnostics.keywordIds).toHaveLength(128);
    expect(diagnostics.keywordIds).not.toContain("authority");
    expect(result.matches.map(row => row.id)).not.toContain("authority");
    expect(result.matches).toHaveLength(5);
  });
});
