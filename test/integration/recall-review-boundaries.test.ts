import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { recallEntries } from "../../src/recall/search";
import { recallSnippet } from "../../src/recall/render";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

const NOW = Date.UTC(2026, 8, 13);
const fixtures: { sqlite: ReturnType<typeof makeSqliteD1>; pending: Promise<unknown>[] }[] = [];
function fixture() {
  const sqlite = makeSqliteD1();
  const pending: Promise<unknown>[] = [];
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database,
    OAUTH_KV: makeMemoryKV(),
  }));
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
  const f = { sqlite, env, ctx, pending };
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  await Promise.allSettled(fixtures.flatMap(f => f.pending));
  fixtures.splice(0).forEach(f => f.sqlite.close());
});

describe("CoSレビューの検索境界", () => {
  it.each(["status:deprecated", "kind:episodic"])("%sの新しい行が直接検索の候補枠を埋めない", async excluded => {
    const { sqlite, env, ctx } = fixture();
    for (let i = 0; i < DEFAULTS.KEYWORD_CANDIDATE_LIMIT; i++) {
      sqlite.seed({ id: `excluded-${i}`, content: "quartz ledger", createdAt: NOW,
        tags: ["work", ...(excluded === "status:deprecated" ? ["kind:semantic"] : []), excluded] });
    }
    sqlite.seed({ id: "answer", content: "quartz ledger", createdAt: NOW - 1000,
      tags: ["work", "kind:semantic"] });
    // 埋め込み成功・dense空。失敗時の優先枠だけで直ったことにしない。
    const result = await recallEntries({ query: "quartz ledger", topK: 5,
      kind: "semantic", hops: 0, synthesize: false }, env, ctx);
    expect(result.matches.map(m => m.id)).toEqual(["answer"]);
  });

  it.each([0, 1])("tag候補の前倒し除外とgraph中継点を区別する（hops=%i）", async hops => {
    const { sqlite, env, ctx } = fixture();
    const rows = [
      { id: "answer", createdAt: NOW, tags: ["work", "kind:semantic"] },
      { id: "old", createdAt: NOW - 2000, tags: ["work", "kind:semantic"] },
      { id: "event", createdAt: NOW, tags: ["work", "kind:episodic"] },
      { id: "deprecated", createdAt: NOW, tags: ["work", "kind:semantic", "status:deprecated"] },
    ];
    rows.forEach(row => sqlite.seed({ ...row, content: "quartz ledger", vectorIds: [row.id] }));
    const getByIds = vi.fn(async (ids: string[]) => ids.map(id => ({ id,
      values: new Array(128).fill(.1), metadata: { parentId: id, created_at: NOW } })));
    env.VECTORIZE = makeVectorizeMock({ getByIds });
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: "quartz ledger", tag: "work", topK: 5,
      kind: "semantic", after: NOW - 1000, before: NOW + 1000, hops, synthesize: false },
    env, ctx, undefined, { diagnostics });
    expect(result.matches.map(m => m.id)).toEqual(["answer"]);
    expect(getByIds.mock.calls.flatMap(([ids]) => ids).sort()).toEqual(
      hops ? rows.map(row => row.id).sort() : ["answer"],
    );
    if (hops) expect(diagnostics.rootSelections?.map(row => row.id)).toEqual(
      expect.arrayContaining(["old", "event"]),
    );
  });

  it.each([false, true])("実際のcurrent質問から独立した語だけで最新抜粋を選ぶ（2語=%s）", async twoWords => {
    const { sqlite, env, ctx } = fixture();
    const latest = twoWords ? "スキル 再開の最新確定。" : "スキルは別案件で更新。";
    const content = "記録の先頭。" + "古い資料。".repeat(100)
      + "\n[Update Jan 1, 2026]: スキル 再開 個人の対象記録。" + "補足資料。".repeat(100)
      + "\n[Update Feb 1, 2026]: " + latest;
    sqlite.seed({ id: "journal", content, createdAt: NOW, tags: ["work"] });
    for (let i = 0; i < 10; i++) sqlite.seed({ id: `other-${i}`, content: `garden memo ${i}`,
      createdAt: NOW, tags: ["work"] });
    const result = await recallEntries({ query: "現状 スキル 再開 個人", topK: 1,
      tag: "work", hops: 0, synthesize: false }, env, ctx);
    expect(result.matches[0]?.id).toBe("journal");
    expect(result.currentQueryTokens).toContain("スキル");
    expect(result.currentQueryTokens).not.toContain("スキ");
    expect(result.currentQueryTokens).not.toContain("キル");
    const opts = { queryTokens: result.queryTokens,
      config: { ...DEFAULTS, FULL_MATCH_MAX_CHARS: 300 } };
    const ordinary = recallSnippet(result.matches[0], 0, opts);
    const current = recallSnippet(result.matches[0], 0, { ...opts, currentQueryTokens: result.currentQueryTokens });
    if (twoWords) expect(current.text).toContain(latest);
    else {
      expect(ordinary.text).toContain("対象記録");
      expect(current).toEqual(ordinary);
      expect(current.text).not.toContain(latest);
    }
  });

  it("要約へ質問全文を渡し、要約なしの検索結果と順位を維持する", async () => {
    const { sqlite, env, ctx, pending } = fixture();
    for (let i = 0; i < 2; i++) sqlite.seed({ id: `answer-${i}`, content: "quartz ledger current decision",
      createdAt: NOW, tags: ["work"] });
    const query = "What is the current quartz ledger decision, including the original constraints?";
    const params = { query, tag: "work", topK: 2, hops: 0 };
    const plain = await recallEntries({ ...params, synthesize: false }, env, ctx);
    await Promise.all(pending);
    const summary = await recallEntries(params, env, ctx);
    expect(summary.queryUsed).not.toBe(query);
    expect(summary.matches.map(m => m.id)).toEqual(plain.matches.map(m => m.id));
    summary.matches.forEach((m, index) => expect(m.score).toBeCloseTo(plain.matches[index].score, 12));
    const calls = vi.mocked(env.AI.run).mock.calls;
    const prompts = calls.map(([, input]) => (input as { messages?: { content: string }[] }).messages?.[0]?.content)
      .filter((prompt): prompt is string => !!prompt?.startsWith("You are a second brain assistant."));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`Query: "${query}"`);
  });
});
