/**
 * Real-SQLite evidence for the shipped 128-candidate window, not another
 * embedding-only benchmark. Quota is observed locally; no provider is called.
 * Both candidate SELECTs together must return no more than the configured cap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, type Config } from "../../src/config";
import { recallEntries } from "../../src/recall/search";
import { observeWorkersAiQuotaError } from "../../src/lib/ai";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import type { Identity } from "../../src/lib/identity";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const NOW = Date.UTC(2026, 8, 5, 12);
const OLD = NOW - 180 * 86_400_000;
const open: SqliteD1[] = [];
afterEach(() => { open.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });

async function fixture(noiseCount: number, cjk = false) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const sqlite = makeSqliteD1(); open.push(sqlite);
  sqlite.seed({ id: "old-decision", createdAt: OLD, importanceScore: 5,
    content: cjk ? "認証方式はパスキーとする。決定 SB-024。" : "The cat adoption decision is approved. Record SB-024.",
    tags: ["status:canonical", "kind:semantic"],
  });
  for (let i = 0; i < noiseCount; i++) sqlite.seed({
    id: `noise-${i}`, createdAt: NOW - i,
    content: cjk ? "認証の定例確認を行いました。" : "We concatenate the routine fields.",
  });
  const candidateCalls: { sql: string; args: unknown[]; returned: number }[] = [];
  const prepare = sqlite.db.prepare.bind(sqlite.db);
  vi.spyOn(sqlite.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT id, content, tags, source, created_at FROM entries WHERE")) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...args) => {
      const bound = bind(...args);
      const all = bound.all.bind(bound);
      vi.spyOn(bound, "all").mockImplementation(async () => {
        const result = await all();
        candidateCalls.push({ sql, args, returned: result.results.length });
        return result;
      });
      return bound;
    });
    return statement;
  });
  const ai = vi.fn().mockRejectedValue(new Error("unexpected provider call"));
  const vector = vi.fn().mockRejectedValue(new Error("unexpected vector call"));
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
    AI: { run: ai } as unknown as Ai, VECTORIZE: makeVectorizeMock({ query: vector }),
  }));
  await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));
  return {
    sqlite, env, candidateCalls,
    async recall(query: string, before?: number, internal: RecallInternalOptions = {}, config: Readonly<Config> = DEFAULTS) {
      candidateCalls.length = 0;
      const pending: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
      const diagnostics: RecallDiagnostics = {};
      const result = await recallEntries({ query, topK: 5, hops: 0, synthesize: false, before },
        env, ctx, config, { ...internal, diagnostics });
      await Promise.all(pending);
      expect(result.semanticUnavailableReason).toBe("workers_ai_quota_exhausted");
      expect(ai).not.toHaveBeenCalled();
      expect(vector).not.toHaveBeenCalled();
      expect(diagnostics.keywordIds?.length ?? 0).toBeLessThanOrEqual(config.KEYWORD_CANDIDATE_LIMIT);
      expect(candidateCalls.length).toBeLessThanOrEqual(2);
      expect(candidateCalls.reduce((sum, call) => sum + call.returned, 0)).toBeLessThanOrEqual(config.KEYWORD_CANDIDATE_LIMIT);
      for (const call of candidateCalls) {
        expect(call.args.length).toBeLessThanOrEqual(100);
        const [whereSql, orderSql = ""] = call.sql.split(" ORDER BY ");
        const wherePatternCount = (whereSql.match(/(?:LIKE|GLOB) \?/g) ?? []).length;
        const orderPatternCount = (orderSql.match(/CASE WHEN content LIKE \?/g) ?? []).length;
        for (const pattern of [
          ...call.args.slice(0, wherePatternCount),
          ...call.args.slice(-1 - orderPatternCount, -1),
        ]) {
          expect(new TextEncoder().encode(String(pattern)).byteLength).toBeLessThanOrEqual(50);
        }
        expect(call.sql).toContain("created_at DESC LIMIT ?");
      }
      expect(diagnostics.operations?.d1Statements).toBeLessThanOrEqual(30);
      // SQLite does not know Cloudflare's billed rows read: do not invent it.
      expect(diagnostics.operations?.d1RowsRead).toBeNull();
      return { result, diagnostics };
    },
  };
}

describe("bounded keyword recall under quota and aging", () => {
  it("pins the CPU-protection candidate budget rather than silently widening it", () => {
    expect(DEFAULTS.KEYWORD_CANDIDATE_LIMIT).toBe(128);
  });

  it("still admits a six-month-old decision at position 128", async () => {
    const f = await fixture(127);
    const { diagnostics } = await f.recall("cat");
    expect(diagnostics.keywordIds).toContain("old-decision");
  });

  it("rescues a word-boundary match at position 129 without widening the candidate budget", async () => {
    const f = await fixture(128);
    const { result, diagnostics } = await f.recall("cat");
    expect(diagnostics.keywordIds).toHaveLength(128);
    expect(diagnostics.keywordIds).toContain("old-decision");
    expect(result.matches[0]?.id).toBe("old-decision");
  });

  it.each([false, true])("recovers the old decision using a bounded time filter (CJK=%s)", async cjk => {
    const f = await fixture(160, cjk);
    const { result, diagnostics } = await f.recall(cjk ? "認証" : "cat", OLD + 1);
    expect(diagnostics.keywordIds).toEqual(["old-decision"]);
    expect(result.matches[0]?.id).toBe("old-decision");
  });

  it.each([false, true])("recovers an exact identifier beyond 160 noisy notes (CJK=%s)", async cjk => {
    const f = await fixture(160, cjk);
    const { result } = await f.recall("SB-024");
    expect(result.matches[0]?.id).toBe("old-decision");
  });

  it("returns no invented candidate for an absent identifier", async () => {
    const f = await fixture(160);
    const { result, diagnostics } = await f.recall("unobtainium-9f872e");
    expect(diagnostics.keywordIds ?? []).toEqual([]);
    expect(result.matches).toEqual([]);
  });
  it("reserves only a quarter of the cap, fills the remainder, and never returns duplicates", async () => {
    const f = await fixture(160);
    for (let i = 0; i < 45; i++) f.sqlite.seed({ id: `exact-${i}`, content: "A cat adoption.", createdAt: NOW + i });
    const { result, diagnostics } = await f.recall("cat");
    expect(f.candidateCalls.map(call => call.returned)).toEqual([32, 96]);
    expect(diagnostics.keywordIds).toHaveLength(128);
    expect(new Set(diagnostics.keywordIds).size).toBe(128);
    // Explicit authority wins admission within the fixed reserve; the reserve
    // itself remains bounded and does not promise every authoritative match.
    expect(diagnostics.keywordIds).toContain("old-decision");
    expect(result.matches.map(row => row.id)).toContain("old-decision");
    expect(f.candidateCalls[0].sql).toContain("importance_score DESC");
  });

  it("honors the configured cap of 50 across both SELECTs", async () => {
    const f = await fixture(160);
    const { result, diagnostics } = await f.recall("cat", undefined, {}, { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: 50 });
    expect(f.candidateCalls.map(call => call.returned)).toEqual([1, 49]);
    expect(diagnostics.keywordIds).toHaveLength(50);
    expect(result.matches[0]?.id).toBe("old-decision");
  });

  it("uses the upstream rare-term choice to rescue a Japanese multi-term query", async () => {
    const f = await fixture(160, true);
    const { result, diagnostics } = await f.recall("認証 パスキー");
    expect(diagnostics.keywordIds).toContain("old-decision");
    expect(result.matches[0]?.id).toBe("old-decision");
    expect(f.candidateCalls).toHaveLength(2);
  });

  it.each([
    ["importance", 5, ["kind:semantic"]],
    ["canonical", 0, ["status:canonical", "kind:semantic"]],
  ] as const)("uses explicit %s authority to rescue a lone common Japanese token", async (_label, importance, tags) => {
    const f = await fixture(160, true);
    await f.sqlite.db.prepare("UPDATE entries SET importance_score = ?, tags = ? WHERE id = ?")
      .bind(importance, JSON.stringify(tags), "old-decision").run();
    const { result, diagnostics } = await f.recall("認証");
    expect(f.candidateCalls.map(call => call.returned)).toEqual([1, 127]);
    expect(diagnostics.keywordIds).toContain("old-decision");
    expect(result.matches.map(row => row.id)).toContain("old-decision");
  });

  it("does not invent a lone-token distinction when authority metadata is absent", async () => {
    const f = await fixture(160, true);
    await f.sqlite.db.prepare("UPDATE entries SET importance_score = 0, tags = ? WHERE id = ?")
      .bind(JSON.stringify(["kind:semantic"]), "old-decision").run();
    const { result, diagnostics } = await f.recall("認証");
    expect(f.candidateCalls.map(call => call.returned)).toEqual([0, 128]);
    expect(diagnostics.keywordIds).not.toContain("old-decision");
    expect(result.matches.map(row => row.id)).not.toContain("old-decision");
  });

  it("does not promote authority metadata from the broad lane", async () => {
    const f = await fixture(160);
    f.sqlite.seed({ id: "broad-authority", content: "cat routine only", createdAt: NOW + 500,
      importanceScore: 5, tags: ["status:canonical"] });
    const { result } = await f.recall("cat adoption");
    // This row matches only the broad OR lane, not the conjunctive priority lane.
    // Authority metadata alone must not reserve the final direct slot.
    expect(result.matches.map(row => row.id)).not.toContain("broad-authority");
  });

  it("does not reserve an authority slot on the healthy semantic path", async () => {
    const f = await fixture(8, true);
    f.env.OAUTH_KV = makeMemoryKV();
    const query = vi.fn().mockResolvedValue({ matches: [] });
    f.env.VECTORIZE = makeVectorizeMock({ query });
    vi.mocked(f.env.AI.run).mockResolvedValue({ data: [new Array(768).fill(0.01)] } as any);
    const pending: Promise<unknown>[] = [];
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: "認証", topK: 5, hops: 0, synthesize: false }, f.env,
      { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext,
      DEFAULTS, { diagnostics });
    await Promise.all(pending);
    expect(result.semanticUnavailable).toBe(false);
    expect(query).toHaveBeenCalled();
  });
  it("retains substring rescue when the priority lane has no match", async () => {
    const f = await fixture(160);
    const { result, diagnostics } = await f.recall("ncat");
    expect(f.candidateCalls.map(call => call.returned)).toEqual([0, 128]);
    expect(diagnostics.keywordIds).toHaveLength(128);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("does not treat an adjacent non-ASCII letter as an ASCII word boundary", async () => {
    const f = await fixture(160);
    for (const [i, content] of ["écat", "caté", "漢cat", "cat字"].entries()) {
      f.sqlite.seed({ id: `unicode-${i}`, content, createdAt: NOW + i });
    }
    const { result } = await f.recall("cat");
    expect(f.candidateCalls[0].returned).toBe(1);
    expect(result.matches[0]?.id).toBe("old-decision");
  });

  it("checks later word occurrences, padding, and ASCII case rather than only the first substring", async () => {
    const f = await fixture(160);
    f.sqlite.seed({ id: "repeated", content: "concatenate; later a CAT", createdAt: OLD + 1 });
    const { diagnostics } = await f.recall("cat");
    expect(diagnostics.keywordIds).toContain("repeated");
    expect(f.candidateCalls[0].returned).toBe(2);
  });

  it("preserves literal underscore/dot identifiers instead of LIKE or GLOB wildcards", async () => {
    const f = await fixture(160);
    f.sqlite.seed({ id: "literal", content: "auth_token.v1 is the documented identifier.", createdAt: OLD });
    for (let i = 0; i < 160; i++) f.sqlite.seed({ id: `literal-noise-${i}`, content: "authXtoken.v1x is different.", createdAt: NOW + i });
    const { result, diagnostics } = await f.recall("auth_token.v1");
    expect(diagnostics.keywordIds).toContain("literal");
    expect(result.matches[0]?.id).toBe("literal");
  });

  it("applies workspace and time predicates inside both candidate lanes", async () => {
    const f = await fixture(160);
    await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE 1").bind("own").run();
    for (let i = 0; i < 160; i++) {
      f.sqlite.seed({ id: `foreign-${i}`, content: "cat approved decision", createdAt: NOW - i });
      f.sqlite.seed({ id: `future-${i}`, content: "cat approved decision", createdAt: NOW + i });
      await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind("foreign", `foreign-${i}`).run();
      await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind("own", `future-${i}`).run();
    }
    const identity: Identity = { userId: "member", role: "member", personalWorkspaceId: "own", companyWorkspaceIds: ["team"], defaultShare: "" };
    const { result, diagnostics } = await f.recall("cat", NOW, { identity });
    expect(result.matches[0]?.id).toBe("old-decision");
    expect(diagnostics.keywordIds!.some(id => /^(foreign|future)-/.test(id))).toBe(false);
    for (const call of f.candidateCalls) {
      expect(call.sql).toContain("created_at < ?");
      expect(call.sql).toContain("workspace_id IN (?, ?)");
    }
  });

  it("keeps the 100-binding boundary with many readable workspaces and a raw compatibility probe", async () => {
    const f = await fixture(160);
    f.sqlite.seed({ id: "wide", content: "Ｃｌｏｕｄｆｌａｒｅ rollout", createdAt: OLD });
    await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE 1").bind("own").run();
    // 96 readable workspaces leave two binds for the normalized and raw
    // WHERE probes, plus validity and LIMIT: exactly 100. ORDER has no bind left.
    const identity: Identity = { userId: "member", role: "member", personalWorkspaceId: "own", companyWorkspaceIds: Array.from({ length: 95 }, (_, i) => `team-${i}`), defaultShare: "" };
    const { diagnostics } = await f.recall("Ｃｌｏｕｄｆｌａｒｅ", undefined, { identity });
    expect(f.candidateCalls).toHaveLength(1);
    expect(f.candidateCalls[0].args).toHaveLength(100);
    expect(f.candidateCalls[0].sql).toContain("ORDER BY created_at DESC LIMIT ?");
    expect(diagnostics.keywordIds).toContain("wide");
  });

  it("keeps the priority lane when its exclusion uses the last spare bind", async () => {
    const f = await fixture(0);
    await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE 1").bind("own").run();
    const identity: Identity = { userId: "member", role: "member", personalWorkspaceId: "own", companyWorkspaceIds: Array.from({ length: 95 }, (_, i) => `team-${i}`), defaultShare: "" };
    const { diagnostics } = await f.recall("cat", undefined, { identity });
    expect(f.candidateCalls).toHaveLength(2);
    expect(f.candidateCalls[0].sql).toContain("importance_score DESC");
    expect(f.candidateCalls[1].args).toHaveLength(100);
    expect(f.candidateCalls[1].sql).toContain("ORDER BY created_at DESC LIMIT ?");
    expect(diagnostics.keywordIds).toContain("old-decision");
  });

});
