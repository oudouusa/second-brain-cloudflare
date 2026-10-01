import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { observeWorkersAiSuccess } from "../../src/lib/ai";

const values = new Array(128).fill(0.1);

describe("未索引記憶の検索連続性", () => {
  it.each(["SB-024", "配備記録"])("%sを枯渇→AI復旧→索引完了の各段階で検索できる", async query => {
    const sqlite = makeSqliteD1();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
    const now = Date.now();
    sqlite.seed({ id: "target", content: `${query} を本番に反映した。`, tags: ["deployment", "kind:semantic"], createdAt: now - 360_000 });
    sqlite.seed({ id: "noise", content: "別のシステムの本番運用", tags: ["deployment", "kind:semantic"], createdAt: now, vectorIds: ["noise"] });
    sqlite.seed({ id: "irrelevant", content: "好きな料理について", tags: ["deployment", "kind:semantic"], createdAt: now });
    sqlite.seed({ id: "deprecated", content: query, tags: ["deployment", "kind:semantic", "status:deprecated"], createdAt: now });
    sqlite.seed({ id: "other-tag", content: query, tags: ["unrelated", "kind:semantic"], createdAt: now });
    if (query === "SB-024") sqlite.seed({ id: "weak", content: "preSB-024post", tags: ["deployment", "kind:semantic"], createdAt: now });
    sqlite.seed({ id: "too-old", content: query, tags: ["deployment", "kind:semantic"], createdAt: now - 600000 });
    sqlite.seed({ id: "wrong-kind", content: query, tags: ["deployment", "kind:episodic"], createdAt: now });
    const run = vi.fn().mockRejectedValue(new Error("4006: daily free allocation"));
    const vectors = new Map<string, VectorizeVector>([["noise", { id: "noise", values, metadata: { parentId: "noise" } }]]);
    const upsert = vi.fn(async (rows: VectorizeVector[]) => {
      for (const row of rows) vectors.set(row.id, row);
      return { mutationId: "recovery" };
    });
    const getByIds = vi.fn(async (ids: string[]) => ids.flatMap(id => vectors.has(id) ? [vectors.get(id)!] : []));
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: { run } as unknown as Ai, VECTORIZE: makeVectorizeMock({ getByIds, upsert }) });
    const recall = async () => {
      const response = await worker.fetch(req("POST", "/recall", { body: { query, tag: "deployment", topK: 5, synthesize: false, after: now - 420000, kind: "semantic" } }), env, ctx);
      expect(response.status).toBe(200);
      const body = await response.json() as { results: { id: string }[]; semantic_unavailable: boolean };
      const ids = body.results.map(row => row.id);
      expect(ids).toContain("target");
      expect(ids).not.toContain("irrelevant");
      expect(ids).not.toContain("deprecated");
      expect(ids).not.toContain("other-tag");
      expect(ids).not.toContain("too-old");
      expect(ids).not.toContain("wrong-kind");
      return body;
    };
    try {
      expect((await recall()).semantic_unavailable).toBe(true);
      const failedRepair = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
      expect(failedRepair.status).toBe(200);
      // remainingは猶予期間中の項目も含む。今回選択できる2件と、新着3〜4件を区別する。
      const pendingCount = query === "SB-024" ? 6 : 5;
      expect(await failedRepair.json()).toMatchObject({ processed: 0, failed: 1, remaining: pendingCount });
      expect(sqlite.rows().find(row => row.id === "target")?.vector_ids).toBe("[]");
      expect(upsert).not.toHaveBeenCalled();
      run.mockResolvedValue({ data: [new Array(768).fill(0.1)] });
      // 別の保留項目の回復によりマーカーだけが解除された状態。
      await observeWorkersAiSuccess(env, Date.now() + 1);
      const recovered = await recall();
      expect(recovered.semantic_unavailable).toBe(false);
      expect(recovered.results.map(row => row.id)).not.toContain("weak");
      const repair = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
      expect(repair.status).toBe(200);
      expect(await repair.json()).toMatchObject({ processed: 2, failed: 0, remaining: pendingCount - 2 });
      expect(upsert).toHaveBeenCalled();
      const target = sqlite.rows().find(row => row.id === "target")!;
      const ids = JSON.parse(target.vector_ids as string) as string[];
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every(id => vectors.has(id))).toBe(true);
      expect(target.content).toBe(`${query} を本番に反映した。`);
      expect((await recall()).semantic_unavailable).toBe(false);
      await Promise.allSettled(pending);
      expect(await sqlite.db.prepare("SELECT count(*) AS count FROM memory_write_admissions").first()).toMatchObject({ count: 0 });
    } finally {
      await Promise.allSettled(pending);
      sqlite.close();
    }
  });
  it.each([
    { query: "Cedar", content: "Cedarの移行を確認した", hit: true },
    { query: "SB-024", content: "SB-024を反映した", hit: true },
    { query: "SB-024", content: "今回はSB-024を反映した", hit: true },
    { query: "SB-024", content: "ＳＢ－０２４を反映した", hit: true },
    { query: "Cedar", content: "Cedarwoodの移行", hit: false },
    { query: "SB-024", content: "preSB-024post", hit: false },
    { query: "SB-024", content: "SB-0249を反映", hit: false },
  ])("AI正常時の助詞隣接と部分一致: $content", async ({ query, content, hit }) => {
    const sqlite = makeSqliteD1();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
    sqlite.seed({ id: "target", content, createdAt: Date.now() - 360000, tags: ["deployment"] });
    sqlite.seed({ id: "noise", content: "別の運用", createdAt: Date.now(), tags: ["deployment"], vectorIds: ["noise"] });
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
      AI: { run: vi.fn().mockResolvedValue({ data: [new Array(768).fill(0.1)] }) } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({ getByIds: vi.fn().mockResolvedValue([{ id: "noise", values, metadata: { parentId: "noise" } }]) }) });
    try {
      const response = await worker.fetch(req("POST", "/recall", { body: { query, tag: "deployment", topK: 5, synthesize: false } }), env, ctx);
      expect(response.status).toBe(200);
      const body = await response.json() as { results: { id: string }[]; semantic_unavailable: boolean };
      expect(body.semantic_unavailable).toBe(false);
      expect(body.results.some(row => row.id === "target")).toBe(hit);
    } finally {
      await Promise.allSettled(pending);
      sqlite.close();
    }
  });

  it.each(["kind", "after", "before", "deprecated"])("AI正常でも適格ベクトルがないとき%s対象外の候補でtopKが埋まらない", async exclusion => {
    const sqlite = makeSqliteD1();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
    const now = Date.now();
    sqlite.seed({ id: "target", content: "SB-024 を反映", tags: ["deployment", "kind:semantic"], createdAt: now - 360000 });
    for (let i = 0; i < 8; i++) sqlite.seed({ id: `excluded-${i}`, content: "SB-024 を反映", importanceScore: 5,
      tags: ["deployment", exclusion === "kind" ? "kind:episodic" : "kind:semantic", ...(exclusion === "deprecated" ? ["status:deprecated"] : [])],
      createdAt: exclusion === "after" ? now - 600000 : now });
    sqlite.seed({ id: "noise", content: "別の運用", createdAt: Date.now(), tags: ["deployment", "kind:episodic"], vectorIds: ["noise"] });
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
      AI: { run: vi.fn().mockResolvedValue({ data: [new Array(768).fill(0.1)] }) } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({ getByIds: vi.fn().mockResolvedValue([{ id: "noise", values, metadata: { parentId: "noise" } }]) }) });
    try {
      const response = await worker.fetch(req("POST", "/recall", { body: { query: "SB-024", tag: "deployment", topK: 1, synthesize: false,
        kind: "semantic", ...(exclusion === "after" ? { after: now - 420000 } : {}), ...(exclusion === "before" ? { before: now - 1000 } : {}) } }), env, ctx);
      expect(response.status).toBe(200);
      const body = await response.json() as { results: { id: string }[]; semantic_unavailable: boolean };
      // 対象外のベクトルでは正常扱いにせず、適格な未索引記憶を字句検索で返す。
      expect(body.semantic_unavailable).toBe(true);
      expect(env.AI.run).toHaveBeenCalled();
      expect(env.VECTORIZE.getByIds).not.toHaveBeenCalled();
      expect(body.results.map(row => row.id)).toEqual(["target"]);
    } finally {
      await Promise.allSettled(pending);
      sqlite.close();
    }
  });

});
