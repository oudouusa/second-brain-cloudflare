import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";
import { distillToRareTerms } from "../../src/recall/distill";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { buildQueryProfile } from "../../src/recall/query-profile";
import { fuseDenseAndKeyword, keywordSearch, recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { tokenizeQueryDetailed } from "../../src/text/lexical-query";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const NOW = Date.UTC(2026, 8, 24);
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
let sqlite: SqliteD1;
let env: Env;
let maxBindings: number;
const candidateSql = () => sqlite.issued.filter(sql => sql.startsWith("SELECT id, content, tags, source, created_at FROM entries WHERE"));

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  resetFtsReadyMemo();
  sqlite = makeSqliteD1();
  maxBindings = 0;
  const prepare = sqlite.db.prepare.bind(sqlite.db);
  vi.spyOn(sqlite.db, "prepare").mockImplementation(sql => {
    const stmt = prepare(sql);
    const bind = stmt.bind.bind(stmt);
    vi.spyOn(stmt, "bind").mockImplementation((...args: unknown[]) => {
      maxBindings = Math.max(maxBindings, args.length);
      expect(args.length).toBeLessThanOrEqual(100);
      return bind(...args);
    });
    return stmt;
  });
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) }),
  });
});
afterEach(() => { sqlite.close(); vi.restoreAllMocks(); });

async function recall(query: string) {
  const diagnostics: RecallDiagnostics = {};
  const result = await recallEntries({ query, topK: 5, hops: 0, synthesize: false }, env, ctx,
    { ...DEFAULTS, RERANK_MODE: "off" }, { diagnostics });
  expect(diagnostics.keywordIds!.length).toBeLessThanOrEqual(128);
  expect(new Set(diagnostics.keywordIds).size).toBe(diagnostics.keywordIds!.length);
  return { result, diagnostics };
}

describe("言い回しを伴う稀語のrecall", () => {
  it.each(["星砂石 all", "Tell me all about 星砂石"])("頻出語が窓を埋めても古い稀語を保持する: %s", async query => {
    sqlite.seed({ id: "rare", content: "星砂石の保管場所は北棟。", createdAt: NOW - 86_400_000 });
    for (let i = 0; i < 160; i++) sqlite.seed({ id: `noise-${i}`, content: "Tell them all about routine work.", createdAt: NOW - i });
    const { result, diagnostics } = await recall(query);
    expect(diagnostics.keywordIds).toContain("rare");
    expect(result.matches[0]?.id).toBe("rare");
    expect(candidateSql()).toHaveLength(2);
  });

  it("稀語窓の取得後にdenseが失敗しても初回候補を再取得せず予算内で救済する", async () => {
    sqlite.seed({ id: "rare", content: "星砂石の保管場所は北棟。", createdAt: NOW - 86_400_000 });
    for (let i = 0; i < 160; i++) sqlite.seed({ id: `noise-${i}`, content: "Tell them all about routine work.", createdAt: NOW - i });
    vi.mocked(env.VECTORIZE.query).mockRejectedValue(new Error("合成試験: 索引利用不可"));
    const { result, diagnostics } = await recall("Tell me all about 星砂石");
    expect(result.semanticUnavailableReason).toBe("vectorize_unavailable");
    expect(result.matches[0]?.id).toBe("rare");
    // 稀語・残りの2文に、従来のpriority lane 1文だけを追加する。
    expect(candidateSql()).toHaveLength(3);
    expect(diagnostics.operations!.d1Statements).toBeLessThanOrEqual(30);
    expect(diagnostics.operations!.d1RowsRead).toBeNull();
  });

  it.each(["What do you know about ZX-731? I need the details", "ZX-731、その後"])(
    "日本語に接する識別子を頻出語より優先する: %s", async query => {
      // ASCII経路でも局所評価を通る長文。依頼語を含まない記憶を検索する。
      sqlite.seed({ id: "rare", content: `決定ZX-731を採用する。${"独立した記録。".repeat(65)}`, createdAt: NOW - 86_400_000 });
      for (let i = 0; i < 30; i++) sqlite.seed({ id: `noise-${i}`, content: "We need the details、その後の連絡。", createdAt: NOW - i });
      for (let i = 0; i < 120; i++) sqlite.seed({ id: `other-${i}`, content: "無関係な定例記録。", createdAt: NOW - i });
      const { result, diagnostics } = await recall(query);
      expect(diagnostics.keywordIds).toContain("rare");
      expect(result.matches[0]?.id).toBe("rare");
    },
  );

  it.each(["preZX-731post", "éZX-731é", "ZX-731x"])("ラテン文字内の識別子部分一致は減額する: %s", content => {
    const terms = tokenizeQueryDetailed("ZX-731");
    const score = (text: string) => fuseDenseAndKeyword([], [{ id: "r", content: text, tags: "[]", source: "api", created_at: NOW }],
      terms, true, { df: new Map([["zx-731", 1]]), total: 100 }, DEFAULTS.SUBSTRING_MATCH_WEIGHT)[0].score;
    const full = score("決定ZX-731を採用");
    expect(score(content) / full).toBeCloseTo(DEFAULTS.SUBSTRING_MATCH_WEIGHT);
    expect(score("ZX-731") / full).toBeCloseTo(1);
  });

  it.each(["漢cat", "cat字", "écat", "caté"])("一般語のUnicode部分一致ガードを保持する: %s", content => {
    const score = (text: string) => fuseDenseAndKeyword([], [{ id: "r", content: text, tags: "[]", source: "api", created_at: NOW }],
      tokenizeQueryDetailed("cat"), true, { df: new Map([["cat", 1]]), total: 100 }, DEFAULTS.SUBSTRING_MATCH_WEIGHT)[0].score;
    expect(score(content) / score("cat")).toBeCloseTo(DEFAULTS.SUBSTRING_MATCH_WEIGHT);
  });

  it("raw表記の稀語窓と残りの窓の両方にscope・時刻・kind・lifecycle条件を適用する", async () => {
    const identity: Identity = { userId: "reader", role: "member", personalWorkspaceId: "own", companyWorkspaceIds: [], defaultShare: "" };
    for (const [id, workspace, time, tags] of [
      ["rare", "own", 100, ["kind:semantic"]],
      ["foreign-rare", "foreign", 100, ["kind:semantic"]],
      ["expired", "own", 99, ["kind:semantic"]],
      ["future", "own", 200, ["kind:semantic"]],
      ["wrong-kind", "own", 100, ["kind:episodic"]],
      ["deprecated", "own", 100, ["kind:semantic", "status:deprecated"]],
    ] as const) {
      sqlite.seed({ id, content: "ＺＸ－７３１の決定。", createdAt: time, tags: [...tags] });
      await sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind(workspace, id).run();
    }
    for (let i = 0; i < 160; i++) {
      const id = `noise-${i}`;
      sqlite.seed({ id, content: "Tell them all.", createdAt: 150, tags: ["kind:semantic"] });
      await sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind(i % 2 ? "foreign" : "own", id).run();
    }
    const query = "Tell me all about ＺＸ－７３１";
    const bounds = { after: 100, before: 200 };
    const distilled = await distillToRareTerms(query, env, DEFAULTS, bounds, identity, "personal");
    const profile = buildQueryProfile(query, distilled);
    sqlite.issued.length = 0;
    const { rows } = await keywordSearch(profile.retrievalTokens, env, 16, bounds, identity, "personal", undefined, distilled,
      { terms: profile.retrievalTerms, kind: "semantic", answerOnly: true });
    expect(rows.map(r => r.id)).toContain("rare");
    expect(rows.every(r => r.id === "rare" || (r.id.startsWith("noise-") && Number(r.id.slice(6)) % 2 === 0))).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(16);
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length);
    expect(candidateSql()).toHaveLength(2);
  });

  it("多workspaceとraw probeでも分割窓のbindを100以内に保つ", async () => {
    const terms = tokenizeQueryDetailed("ＺＸ－７３１ 星砂石 all");
    const identity: Identity = { userId: "reader", role: "member", personalWorkspaceId: "own",
      companyWorkspaceIds: Array.from({ length: 88 }, (_, i) => `team-${i}`), defaultShare: "" };
    const df = new Map(terms.map(t => [t.value, t.value === "all" ? 200 : 1]));
    await keywordSearch(terms.map(t => t.value), env, 128, { after: 1, before: NOW }, identity, undefined, undefined,
      { df, total: 300 }, { terms, answerOnly: true });
    expect(candidateSql()).toHaveLength(2);
    expect(maxBindings).toBe(100);
  });
});
