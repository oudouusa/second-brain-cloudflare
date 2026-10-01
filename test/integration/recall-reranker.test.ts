import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, type Config } from "../../src/config";
import { FTS_READY_KV_KEY, RERANK_MODEL, RERANK_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { resetRerankReadyMemo } from "../../src/recall/model-reranker";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { createNightlyD1Budget } from "../../src/runtime/d1-budget";
import { TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

type Scorer = (contexts: { text: string }[]) => unknown;
const IDS = ["m0", "m1", "m2", "m3", "m4", "m5"];
const CONTENT: Record<string, string> = Object.fromEntries(IDS.map((id, i) => [id, `notes about launch planning item ${i} with tomato details`]));

describe("recall reranker step", () => {
  const open: SqliteD1[] = [];
  afterEach(() => { open.splice(0).forEach(s => s.close()); resetRerankReadyMemo(); resetFtsReadyMemo(); vi.restoreAllMocks(); });

  async function setup(o: { ready?: boolean; scorer?: Scorer | "throw" | "hang"; extraVectors?: object[] } = {}) {
    resetRerankReadyMemo();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    if (!sqlite.columns().includes("updated_at")) await sqlite.db.prepare(`ALTER TABLE entries ADD COLUMN updated_at INTEGER`).run();
    IDS.forEach((id, i) => sqlite.seed({ id, content: CONTENT[id], createdAt: 1000 + i, tags: ["work"] }));
    const kv = makeMemoryKV();
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    if (o.ready !== false) await kv.put(RERANK_READY_KV_KEY, "1");
    const rerankInputs: { query: string; contexts: { text: string }[]; top_k: number }[] = [];
    const run = vi.fn(async (model: string, input: any) => {
      if (model === RERANK_MODEL) {
        rerankInputs.push(input);
        if (o.scorer === "throw") throw new Error("3040: capacity");
        if (o.scorer === "hang") return new Promise(() => {});
        return (o.scorer ?? ((c: { text: string }[]) => ({ response: c.map((_, id) => ({ id, score: id })) })))(input.contexts);
      }
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":"3"}\n\n')); c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } });
    });
    const matches = [
      ...IDS.map((id, i) => ({ id, score: 0.9 - i * 0.002, metadata: { parentId: id, created_at: 1000 + i, content: `vector copy ${id}` } })),
      ...(o.extraVectors ?? []),
    ];
    const env: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv, AI: { run } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches }) }),
    });
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;
    return { env, ctx, deferred, rerankInputs, run, kv, sqlite };
  }

  async function recall(s: Awaited<ReturnType<typeof setup>>, mode: Config["RERANK_MODE"], q = "launch planning tomato", hops = 0, cfg: Partial<Config> = {}) {
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: q, topK: 5, hops, synthesize: false }, s.env, s.ctx, { ...DEFAULTS, ...cfg, RERANK_MODE: mode }, { diagnostics });
    await Promise.all(s.deferred);
    return { result, diagnostics };
  }

  it("rerankerの本文読取もD1予算に計上し既存の30文以内に収める", async () => {
    const offFixture = await setup();
    const offBudget = createNightlyD1Budget(offFixture.env, 30);
    offFixture.env = offBudget.env;
    const off = await recall(offFixture, "off");
    const onFixture = await setup();
    const onBudget = createNightlyD1Budget(onFixture.env, 30);
    onFixture.env = onBudget.env;
    const on = await recall(onFixture, "on");
    expect(on.diagnostics.rerankRoute).toBe("applied");
    expect(onBudget.stats().used).toBe(offBudget.stats().used + 1);
    expect(on.diagnostics.operations?.d1Statements).toBe(off.diagnostics.operations!.d1Statements + 1);
    expect(onBudget.stats().used).toBeLessThanOrEqual(30);
    expect(onBudget.stats().deferred).toBe(0);
  });

  it("off never calls the model, on scores one batch and reorders within the bounded blend", async () => {
    const off = await recall(await setup(), "off");
    expect(off.diagnostics.rerankRoute).toBe("off");
    const s = await setup();
    const on = await recall(s, "on");
    expect(on.diagnostics.rerankRoute).toBe("applied");
    expect(s.rerankInputs).toHaveLength(1);
    expect(s.rerankInputs[0].contexts).toHaveLength(6);
    expect(s.rerankInputs[0].top_k).toBe(6);
    // scores rise with submission index, so the last-submitted parent gains the full boost over near-equal heuristics
    const ids = (r: typeof on) => r.result.matches.map(m => m.id);
    expect(ids(on)).not.toEqual(ids(off));
    // the last-submitted parent has the best model score and near-equal heuristics, so the blend lifts it above where the heuristic order had it
    const best = IDS.find(id => CONTENT[id] === s.rerankInputs[0].contexts.at(-1)!.text)!;
    expect(ids(on).indexOf(best)).toBeGreaterThanOrEqual(0);
    expect(ids(on).indexOf(best)).toBeLessThan(ids(off).includes(best) ? ids(off).indexOf(best) : Infinity);
    expect(on.diagnostics.rerankMs).toBeTypeOf("number");
  });

  it("explain reports each scored parent's model percentile and changes neither order nor scores", async () => {
    const run = async (explain: boolean) => {
      const s = await setup();
      const result = await recallEntries({ query: "launch planning tomato", topK: 5, hops: 0, synthesize: false, explain }, s.env, s.ctx, { ...DEFAULTS, RERANK_MODE: "on" }, {});
      await Promise.all(s.deferred);
      return result.matches;
    };
    const plain = await run(false);
    const explained = await run(true);
    expect(explained.map(({ why: _w, ...rest }) => rest)).toEqual(plain);
    for (const m of plain) expect(m).not.toHaveProperty("why");
    // the model's best-scored parent is the last one submitted; the blend lifts it into the list, at percentile 1
    const pcts = explained.map(m => m.why!.rerank_percentile as number);
    for (const v of pcts) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(pcts).toContain(1);
  });

  it("sends only scoped D1 passage text, never Vectorize metadata or a foreign hit", async () => {
    const foreign = { id: "ghost", score: 0.95, metadata: { parentId: "ghost", created_at: 1, content: "SECRET stranger memory" } };
    const s = await setup({ extraVectors: [foreign] });
    await recall(s, "on");
    const sent = s.rerankInputs[0].contexts.map(c => c.text).join("\n");
    expect(sent).not.toMatch(/SECRET|vector copy/);
    expect(s.rerankInputs[0].contexts).toHaveLength(6);
    for (const c of s.rerankInputs[0].contexts) expect(Object.values(CONTENT)).toContain(c.text);
  });

  it("with an Identity, a real row in another workspace never reaches the model even when its vector hits first", async () => {
    const foreign = { id: "foreign", score: 0.99, metadata: { parentId: "foreign", created_at: 1, content: "FOREIGN private diary" } };
    const s = await setup({ extraVectors: [foreign] });
    s.sqlite.seed({ id: "foreign", content: "FOREIGN private diary about launch planning tomato", createdAt: 5 });
    for (const id of IDS) s.sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind("ws-a", id).run();
    s.sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind("ws-b", "foreign").run();
    const identity: Identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-a", companyWorkspaceIds: [], defaultShare: "" as const };
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: "launch planning tomato", topK: 5, hops: 0, synthesize: false }, s.env, s.ctx, { ...DEFAULTS, RERANK_MODE: "on" }, { identity, diagnostics });
    expect(diagnostics.rerankRoute).toBe("applied");
    expect(s.rerankInputs[0].contexts.map(c => c.text).join("\n")).not.toMatch(/FOREIGN/);
    expect(s.rerankInputs[0].contexts).toHaveLength(6);
    expect(result.matches.map(m => m.id)).not.toContain("foreign");
  });

  it.each([
    ["an AI error (quota or capacity)", "throw", "error"],
    ["a malformed answer", () => ({ data: [[1]] }), "error"],
    ["a truncated answer", () => ({ response: [{ id: 0, score: 1 }] }), "error"],
    ["a hung model", "hang", "timeout"],
  ] as const)("falls back to the exact baseline result on %s", async (_name, scorer, route) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = await recall(await setup(), "off");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const s = await setup({ scorer: scorer as never });
      const pending = recall(s, "on");
      // HMACは実非同期処理なので、モデル開始を待ってから仮想時間を進める。
      await vi.waitFor(() => expect(s.rerankInputs).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10_000);
      const got = await pending;
      expect(got.diagnostics.rerankRoute).toBe(route);
      expect(got.result.matches).toEqual(base.result.matches);
    } finally {
      vi.useRealTimers();
    }
  });

  it("three consecutive failures open the breaker: the latch flips to not-ready and the model is not called again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup({ scorer: "throw" });
    for (let i = 0; i < 3; i++) expect((await recall(s, "on")).diagnostics.rerankRoute).toBe("error");
    expect(await s.kv.get(RERANK_READY_KV_KEY)).toBe("0");
    const before = s.rerankInputs.length;
    // forced runs (the eval) ignore the latch; a production recall must not
    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "launch planning tomato", topK: 5, hops: 0, synthesize: false }, s.env, s.ctx, { ...DEFAULTS, RERANK_MODE: "on" }, { diagnostics });
    expect(diagnostics.rerankRoute).toBe("not-ready");
    expect(s.rerankInputs.length).toBe(before);
  });

  it("a success resets the failure count", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup();
    const flaky = s.run.getMockImplementation()!;
    let fail = true;
    s.run.mockImplementation(async (model: string, input: any) => (model === RERANK_MODEL && fail ? Promise.reject(new Error("boom")) : flaky(model, input)));
    for (let i = 0; i < 2; i++) await recall(s, "on");
    fail = false;
    expect((await recall(s, "on")).diagnostics.rerankRoute).toBe("applied");
    fail = true;
    for (let i = 0; i < 2; i++) await recall(s, "on");
    expect(await s.kv.get(RERANK_READY_KV_KEY)).toBe("1"); // 2 + success + 2 never reaches 3 in a row
  });

  it("an exact rare-term match the fused pool left at its tail is scored, and is not displaced by the scored block", async () => {
    // 40 dense candidates about something else, plus one keyword-only note holding the rare term (no vector): fusion ranks it last.
    const extraVectors = Array.from({ length: 34 }, (_, i) => ({ id: `p${i}`, score: 0.895 - i * 0.001, metadata: { parentId: `p${i}`, created_at: 100 + i } }));
    const s = await setup({ extraVectors, scorer: (c: { text: string }[]) => ({ response: c.map((x, id) => ({ id, score: /glisteria/i.test(x.text) ? 6 : -5 + (id % 7) * 0.1 })) }) });
    for (let i = 0; i < 34; i++) s.sqlite.seed({ id: `p${i}`, content: `weekly gardening note ${i} about tomatoes`, createdAt: 100 + i });
    s.sqlite.seed({ id: "rare", content: "Glisteria Labs demoed their sensor; accuracy looked great.", createdAt: 5 });
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries({ query: "glisteria", topK: 10, hops: 0, synthesize: false }, s.env, s.ctx, { ...DEFAULTS, RERANK_MODE: "on" }, { diagnostics });
    await Promise.all(s.deferred);
    expect(diagnostics.rerankRoute).toBe("applied");
    const sent = s.rerankInputs[0].contexts.map(c => c.text);
    expect(sent.some(t => /Glisteria Labs/.test(t))).toBe(true); // scored although fusion left it far outside the top 25
    expect(sent).toHaveLength(25); // hops 0: the extra took the seat of the lowest fused candidate, so the batch did not grow
    expect(result.matches.map(m => m.id)).toContain("rare"); // still in the top 10 with the model on
  });

  it("keyword evidence comes from the bounded keyword plan: an old note holding every term is scored though 2,100 newer rows share two of them", async () => {
    // widget and gadget are past the FTS budget together, so keyword search runs the bounded plan (T-0073); the old LIKE window
    // (newest 500) would never have returned the three holders. zorblax alone fits the OR tier, and the evidence read still finds them.
    const extraVectors = Array.from({ length: 34 }, (_, i) => ({ id: `p${i}`, score: 0.895 - i * 0.001, metadata: { parentId: `p${i}`, created_at: 100_000 + i } }));
    const s = await setup({ extraVectors });
    await s.kv.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    for (let i = 0; i < 34; i++) s.sqlite.seed({ id: `p${i}`, content: `weekly gardening note ${i} about beans`, createdAt: 100_000 + i });
    for (let i = 0; i < 2100; i++) s.sqlite.seed({ id: `f${i}`, content: `widget gadget ledger row ${i}`, createdAt: 200_000 + i });
    for (let i = 0; i < 3; i++) s.sqlite.seed({ id: `h${i}`, content: `Zorblax widget gadget report ${i}, unrelated otherwise.`, createdAt: 10 + i });
    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "zorblax widget gadget", topK: 5, hops: 0, synthesize: false }, s.env, s.ctx, { ...DEFAULTS, RERANK_MODE: "on" }, { diagnostics });
    await Promise.all(s.deferred);
    expect(diagnostics.ftsRoute).toBe("fts-bounded");
    expect(diagnostics.keywordIds).toEqual(expect.arrayContaining(["h0", "h1", "h2"]));
    const sent = s.rerankInputs.at(-1)!.contexts.map(c => c.text);
    expect(sent.filter(t => /Zorblax widget gadget report/.test(t))).toHaveLength(3);
  });

  it("a single COMMON word is not keyword evidence: no note outside the fused head takes a seat", async () => {
    // "tomatoes" is in 35 of ~41 notes, far over the saturation fraction; the keyword arm still returns them all.
    const extraVectors = Array.from({ length: 34 }, (_, i) => ({ id: `p${i}`, score: 0.895 - i * 0.001, metadata: { parentId: `p${i}`, created_at: 100 + i } }));
    const s = await setup({ extraVectors });
    const text = new Map<string, string>(IDS.map(id => [id, CONTENT[id]]));
    for (let i = 0; i < 34; i++) { text.set(`p${i}`, `weekly gardening note ${i} about tomatoes`); s.sqlite.seed({ id: `p${i}`, content: text.get(`p${i}`)!, createdAt: 100 + i }); }
    text.set("tail", "A keyword-only note that also mentions tomatoes in passing.");
    s.sqlite.seed({ id: "tail", content: text.get("tail")!, createdAt: 5 });
    const off = await recall(s, "off", "tomatoes"); // candidateIds with the model off is the heuristic order the batch is cut from
    const { diagnostics } = await recall(s, "on", "tomatoes");
    expect(diagnostics.rerankRoute).toBe("applied");
    const sent = s.rerankInputs[0].contexts.map(c => c.text).sort();
    const fusedHead = (off.diagnostics.candidateIds ?? []).slice(0, 25).map(id => text.get(id)!).sort();
    expect(sent).toEqual(fusedHead); // exactly the fused head: nothing evicted for a "match" on a word half the brain contains
  });

  // 40 dense notes about gardening fill the fused head; `holders` keyword-only notes hold the single term.
  async function singleTermCorpus(holders: number, others: number, opts: { limit?: number; breakCounts?: boolean } = {}) {
    const extraVectors = Array.from({ length: 34 }, (_, i) => ({ id: `p${i}`, score: 0.895 - i * 0.001, metadata: { parentId: `p${i}`, created_at: 100 + i } }));
    const s = await setup({ extraVectors });
    const text = new Map<string, string>(IDS.map(id => [id, CONTENT[id]]));
    for (let i = 0; i < 34; i++) { text.set(`p${i}`, `weekly gardening note ${i} about beans`); s.sqlite.seed({ id: `p${i}`, content: text.get(`p${i}`)!, createdAt: 100 + i }); }
    for (let i = 0; i < holders; i++) { text.set(`h${i}`, `Zorblax report number ${i}, unrelated otherwise.`); s.sqlite.seed({ id: `h${i}`, content: text.get(`h${i}`)!, createdAt: 10 + i }); }
    for (let i = 0; i < others; i++) s.sqlite.seed({ id: `o${i}`, content: `filler ledger row ${i} with nothing special`, createdAt: 1 });
    if (opts.breakCounts) {
      const real = s.env.DB;
      s.env = { ...s.env, DB: new Proxy(real as object as Record<string, unknown>, { get: (t, k) => k === "prepare" ? (sql: string) => { if (/entry_counts/.test(sql)) throw new Error("entry_counts unavailable"); return (t.prepare as (q: string) => unknown)(sql); } : typeof t[k as string] === "function" ? (t[k as string] as (...a: unknown[]) => unknown).bind(t) : t[k as string] }) as unknown as Env["DB"] };
    }
    const off = await recall(s, "off", "zorblax", 0, { ...(opts.limit && { KEYWORD_CANDIDATE_LIMIT: opts.limit }) }); // the same window as the run below, or the two heads weigh the term differently
    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "zorblax", topK: 5, hops: 0, synthesize: false }, s.env, s.ctx, { ...DEFAULTS, RERANK_MODE: "on", ...(opts.limit && { KEYWORD_CANDIDATE_LIMIT: opts.limit }) }, { diagnostics });
    await Promise.all(s.deferred);
    const sent = s.rerankInputs.at(-1)!.contexts.map(c => c.text).sort();
    const head = (off.diagnostics.candidateIds ?? []).slice(0, 25).map(id => text.get(id)!).sort();
    return { sent, head, diagnostics };
  }

  it("a term that fills the keyword window is treated as saturated even when the rows read are a small share of the corpus", async () => {
    // 60 holders in a 260-note corpus is 23% (under the 0.3 fraction), but the keyword window (50 here) is full, so df is only a lower bound.
    const r = await singleTermCorpus(60, 160, { limit: 50 });
    expect(r.sent).toEqual(r.head); // no evidence extras: a common word in a big brain undercounts at the window
    expect(r.diagnostics.rerankEvidence).toBe("suppressed-saturated");
  });

  it("a rare single term below the window is weighed against the corpus, so its holders are already in the fused head the batch is cut from", async () => {
    const r = await singleTermCorpus(3, 160, { limit: 50 });
    expect(r.sent).toEqual(r.head);
    expect(r.sent.filter(t => /Zorblax report/.test(t))).toHaveLength(3);
    expect(r.diagnostics.rerankEvidence).toBeUndefined();
  });

  it("an unavailable corpus total means not evidence, and says so in the diagnostics", async () => {
    const r = await singleTermCorpus(30, 160, { limit: 50, breakCounts: true });
    expect(r.sent).toEqual(r.head);
    expect(r.diagnostics.rerankEvidence).toBe("suppressed-no-total");
  });

  it("the eval-only timeout override lets a slow model finish; without it the same call times out, and the probe never reads it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const slow = (c: { text: string }[]) => new Promise(r => setTimeout(() => r({ response: c.map((_, id) => ({ id, score: id })) }), 2000));
      const run = async (tuning?: { timeoutMs: number }) => {
        const s = await setup({ scorer: slow as never });
        const diagnostics: RecallDiagnostics = {};
        const pending = recallEntries({ query: "launch planning tomato", topK: 5, hops: 0, synthesize: false }, s.env, s.ctx, { ...DEFAULTS, RERANK_MODE: "on" }, { diagnostics, ...(tuning && { variant: { rerankTuning: tuning } }) });
        await vi.waitFor(() => expect(s.rerankInputs).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(5000);
        await pending;
        return diagnostics.rerankRoute;
      };
      expect(await run()).toBe("timeout"); // production budget: 1.5 s
      expect(await run({ timeoutMs: 10_000 })).toBe("applied");
    } finally { vi.useRealTimers(); }
  });

  it("skips exact-identifier queries and too-few candidates", async () => {
    const s = await setup();
    const exact = await recall(s, "on", "release v1.9 launch planning");
    expect(exact.diagnostics.rerankRoute).toBe("exact-id");
    expect(s.rerankInputs).toHaveLength(0);
  });

  it("auto attempts an ambiguous pack, and too few candidates are never sent", async () => {
    expect((await recall(await setup(), "auto")).diagnostics.rerankRoute).toBe("applied");
    const few = await setup();
    few.env = { ...few.env, VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [
      { id: "m0", score: 0.95, metadata: { parentId: "m0", created_at: 1000 } },
      { id: "m1", score: 0.5, metadata: { parentId: "m1", created_at: 1001 } },
    ] }) }) } as Env;
    const got = await recall(few, "on", "zzqq unmatched words");
    expect(got.diagnostics.rerankRoute).toBe("too-few");
    expect(few.rerankInputs).toHaveLength(0);
  });

  it("a never-probed model is not used; the first recall schedules the probe and a passing probe latches ready", async () => {
    const s = await setup({ ready: false, scorer: (c: { text: string }[]) => ({ response: c.map((x, id) => ({ id, score: /reset a forgotten password/.test(x.text) ? 5 : -5 })) }) });
    const first = await recall(s, "on");
    expect(first.diagnostics.rerankRoute).toBe("not-ready");
    expect(await s.kv.get(RERANK_READY_KV_KEY)).toBe("1"); // the probe ran in waitUntil
    expect(s.rerankInputs).toHaveLength(2); // both calls are the probe (ranking check, then the full batch), not a recall batch
    expect(s.rerankInputs.map(i => i.contexts.length)).toEqual([3, 30]);
  });

  it("a latch marked failed keeps recall on the heuristic order without another probe", async () => {
    const s = await setup({ ready: false });
    await s.kv.put(RERANK_READY_KV_KEY, "0");
    const got = await recall(s, "on");
    expect(got.diagnostics.rerankRoute).toBe("not-ready");
    expect(s.rerankInputs).toHaveLength(0);
  });

  it("costs one extra AI call and one extra D1 statement at hops 0, and no extra statement at hops 1", async () => {
    for (const hops of [0, 1]) {
      const off = await setup();
      const offDiag: RecallDiagnostics = {};
      await recallEntries({ query: "launch planning tomato", topK: 5, hops, synthesize: false }, off.env, off.ctx, { ...DEFAULTS, RERANK_MODE: "off" }, { diagnostics: offDiag });
      const on = await setup();
      const onDiag: RecallDiagnostics = {};
      await recallEntries({ query: "launch planning tomato", topK: 5, hops, synthesize: false }, on.env, on.ctx, { ...DEFAULTS, RERANK_MODE: "on" }, { diagnostics: onDiag });
      expect(onDiag.rerankRoute).toBe("applied");
      expect(onDiag.operations!.aiCalls).toBe(offDiag.operations!.aiCalls + 1);
      expect(onDiag.operations!.d1Statements).toBe(offDiag.operations!.d1Statements + (hops === 0 ? 1 : 0));
      expect(onDiag.operations!.vectorizeQueries).toBe(offDiag.operations!.vectorizeQueries);
      expect(onDiag.operations!.kvReads).toBe(offDiag.operations!.kvReads + 1); // the readiness latch; off returns before reading it
    }
  });
});
