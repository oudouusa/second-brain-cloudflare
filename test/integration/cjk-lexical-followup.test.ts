import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildQueryProfile } from "../../src/recall/query-profile";
import { exactQueryMatchCount, queryCoverage } from "../../src/recall/neighborhood";
import { recallEntries } from "../../src/recall/search";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Identity } from "../../src/lib/identity";
import { resetVectorizeFilterState } from "../../src/vectorize/scope";
import type { Env } from "../../src/env";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const memberOf = (personalWorkspaceId: string): Identity => ({
  userId: "u-cjk",
  role: "member",
  personalWorkspaceId,
  companyWorkspaceIds: ["ws-company"],
  defaultShare: "" as const,
});

function makeCtx(): ExecutionContext {
  return { waitUntil: (_promise: Promise<unknown>) => {} } as unknown as ExecutionContext;
}

function seedIn(
  sqlite: SqliteD1,
  id: string,
  workspaceId: string,
  content: string,
  createdAt: number,
): void {
  sqlite.seed({ id, content, createdAt });
  sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?")
    .bind(workspaceId, id)
    .run();
}

describe("CJK lexical follow-up regressions", () => {
  it("preserves a generated multi-word phrase as one lexical retrieval term", () => {
    const profile = buildQueryProfile(
      "Did North Harbor teams review launch-plans on June 3?",
      { query: "review", df: null, total: null },
    );

    expect(profile.retrievalTokens).toContain("june 3");
    expect(profile.retrievalTerms).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: "june 3",
        kind: "protected",
        probes: ["june 3"],
      }),
    ]));
    expect(profile.retrievalTerms.filter(term => term.value === "june")).toHaveLength(1);
  });

  it("filters stopwords produced only by splitting a generated hyphen variant", () => {
    const profile = buildQueryProfile(
      "compare state-of-the-art retrieval",
      { query: "state-of-the-art", df: null, total: null },
    );

    expect(profile.retrievalTokens).toEqual(expect.arrayContaining([
      "state-of-the-art",
      "stateoftheart",
      "state",
      "art",
    ]));
    expect(profile.retrievalTokens).not.toContain("of");
    expect(profile.retrievalTokens).not.toContain("the");
    expect(profile.retrievalTerms.map(term => term.value)).not.toContain("of");
    expect(profile.retrievalTerms.map(term => term.value)).not.toContain("the");
  });

  it("normalizes compatibility characters before evidence coverage and exact-match checks", () => {
    const content = "設定: Ｃｌｏｕｄｆｌａｒｅ。";
    const corpus = { df: null, total: null };

    expect(queryCoverage(content, ["cloudflare"], corpus)).toEqual({
      score: 1,
      exactHighIdf: false,
    });
    expect(exactQueryMatchCount(content, ["cloudflare"])).toBe(1);
  });
});

describe("CJK raw-probe workspace isolation before candidate LIMIT", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    resetVectorizeFilterState();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockRejectedValue(new Error("index unavailable")),
      }),
    });
    await initializeDatabase(env);
  });

  afterEach(() => sqlite.close());

  it.each([
    { query: "What is #730 rollout verification status?", target: "#730 rollout verification status: enabled.", distractor: "#731 rollout verification status: pending.", tag: undefined },
    { query: "What is #730 rollout verification status?", target: "#730 rollout verification status: enabled.", distractor: "#731 rollout verification status: pending.", tag: "release" },
    { query: "#730 配備 検証 状況", target: "#730 配備 検証 状況: 完了。", distractor: "#731 配備 検証 状況: 未完了。", tag: undefined },
    { query: "#730 配備 検証 状況", target: "#730 配備 検証 状況: 完了。", distractor: "#731 配備 検証 状況: 未完了。", tag: "release" },
  ])("識別子を保ち別案件の状態記録を優先しない: $query / tag=$tag", async ({ query, target, distractor, tag }) => {
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      seedIn(sqlite, `background-${i}`, "ws-personal",
        i < 20 ? `#730 archive ${i}` : `unrelated memo ${i}`, now);
    }
    seedIn(sqlite, "target", "ws-personal", target, now);
    seedIn(sqlite, "different-issue", "ws-personal", distractor, now);
    await sqlite.db.prepare("UPDATE entries SET tags = ? WHERE workspace_id = ?")
      .bind(JSON.stringify(["release"]), "ws-personal").run();
    env.AI = { run: vi.fn().mockRejectedValue(new Error("offline fixture")) } as unknown as Ai;
    const pending: Promise<unknown>[] = [];
    const result = await recallEntries(
      { query, tag, topK: 5, synthesize: false }, sqlite.admitEnv(env),
      { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext,
      undefined, { identity: memberOf("ws-personal") },
    );
    await Promise.all(pending);
    expect(result.semanticUnavailable).toBe(true);
    expect(result.matches[0]?.id).toBe("target");
    expect(result.queryTokens).toContain("#730");
  });

  it("applies the readable-workspace predicate to the complete OR probe group", async () => {
    // The query produces normalized and raw full-width probes. Without
    // parentheses around their OR group, SQL precedence applies workspace scope
    // only to the raw probe. Newer foreign normalized matches then consume the
    // 500-row keyword window before scoped hydration can reject them.
    for (let i = 0; i < 500; i++) {
      seedIn(sqlite, `foreign-${i}`, "ws-foreign", `cloudflare foreign row ${i}`, 10_000 + i);
    }
    seedIn(sqlite, "own-full-width", "ws-personal", "Ｃｌｏｕｄｆｌａｒｅ設定", 1_000);

    const result = await recallEntries(
      { query: "Ｃｌｏｕｄｆｌａｒｅ", topK: 5, synthesize: false },
      env,
      makeCtx(),
      undefined,
      { identity: memberOf("ws-personal") },
    );

    expect(result.semanticUnavailable).toBe(true);
    expect(result.matches.map(match => match.id)).toEqual(["own-full-width"]);
    const keywordSql = sqlite.issued.find(sql =>
      sql.includes("SELECT id, content, tags, source, created_at FROM entries WHERE")
      && sql.includes("content LIKE")
      && sql.includes("workspace_id IN"),
    );
    expect(keywordSql).toContain("WHERE (content LIKE");
    expect(keywordSql).toContain(") AND workspace_id IN");
  });
});
