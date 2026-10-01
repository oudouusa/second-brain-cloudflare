import { pricingInsight, PRICING_INSIGHTS } from "../helpers/insight-fixture";
/**
 * GET /insights/dry-run — a preview of the weekly pass that writes nothing.
 *
 * Ships ahead of the weekly writer being enabled: the design was validated
 * against one brain that is not representative, so before the writer ever
 * touches real data, a human needs to read what it would have said. That
 * only works if this endpoint truly writes nothing, never hides a declined
 * candidate, reasons with the model the user actually configured, and is
 * honest about which candidates a real run would have kept (`would_write`) —
 * all asserted directly below, not inferred from the response shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";
import { handleAdminRoutes } from "../../src/routes/admin";
import { CONFIG_KEY } from "../../src/config";

const DAY = 86400000;
// Keep the deterministic clock aligned with SQLite's real wall clock. The
// write-admission fence evaluates expiry through strftime(), so an epoch-near
// fake time would make a freshly issued JS admission look expired to SQLite.
const NOW = Date.now();
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const GOOD_TEXT = PRICING_INSIGHTS["0"];
const GOOD = pricingInsight(GOOD_TEXT);

function makeAI(payload: string) {
  return {
    run: vi.fn().mockResolvedValue(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    })),
  } as unknown as Ai;
}

/**
 * One AI mock that answers differently per candidate, keyed off the "tier N"
 * token each fixture's content carries — the same trick
 * insight-cron-budget.test.ts uses for the same reason: a single canned
 * response can't tell an ordering test apart from a lucky coincidence.
 * `declineTier` is the one candidate that gets refused; everything else is
 * accepted with text that shares vocabulary with its own pair (required by
 * reasonOverPair's sharesVocabulary floor).
 *
 * Each accepted tier's text is genuinely distinct wording, not a shared
 * template with the tier digit swapped in. Before this task, the dry-run
 * endpoint never called restatesRecent, so a digit-swapped template worked
 * here by accident. distinctiveTokens (reason.ts) drops a bare digit
 * entirely — it only matches tokens starting with a letter — so a
 * template that differs solely by "tier N" is ~100% token-identical across
 * every tier once tokenised, and now that the dry run applies D2 the same
 * way the weekly pass does, that template would make every candidate after
 * the first report as restating the one before it, which is correct
 * behaviour, not a bug, but would defeat this test's premise of exercising
 * cap-based ordering rather than restatement suppression. Matches the same
 * fix test/unit/insight-weekly.test.ts's own "reasons over the
 * highest-scored candidates first" test needed for the identical reason.
 */
function makeTieredAI(declineTier: number) {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  const perTier: Record<number, string> = {
    0: PRICING_INSIGHTS["0"], 1: PRICING_INSIGHTS["1"], 2: PRICING_INSIGHTS["2"],
    3: PRICING_INSIGHTS["2"],
    4: "契約時の毎月の支払額を一定に保つ方式を廃止し、サービスを使った実績に合わせて対価を受け取る仕組みへ改めています。",
    5: "小規模チーム向けに請求額の見通しを優先していましたが、実際の消費を売上につなげる従量課金へ変更しています。",
  };
  return {
    run: vi.fn().mockImplementation(async (_model: string, opts: any) => {
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      const tier = Number(prompt.match(/tier (\d+)/)?.[1] ?? -1);
      if (tier === declineTier) return sse(`{"insight": false}`);
      return sse(
        pricingInsight(perTier[tier] ?? perTier[0]),
      );
    }),
  } as unknown as Ai;
}

function seedTier(sq: SqliteD1, tier: number, score: number) {
  sq.seed({
    id: `a-${tier}`, createdAt: NOW - 120 * DAY, tags: ["pricing"],
    content: `Decision: price tier ${tier} flat at nine dollars a month for predictable billing.`,
  });
  sq.seed({
    id: `b-${tier}`, createdAt: NOW, tags: ["pricing"],
    content: `Decision: move tier ${tier} to usage-based billing instead of flat pricing.`,
  });
  sq.db.prepare(
    `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
     VALUES (?, ?, ?, 0.8, ?, ?, 'vector', 'pending', ?)`,
  ).bind(`c-${tier}`, `a-${tier}`, `b-${tier}`, 120 * DAY, score, NOW).run();
}

const call = (env: any, path: string, token: string | null = "test-token") =>
  handleAdminRoutes(req("GET", path, { token }), new URL(`http://localhost${path}`), env, ctx);

describe("GET /insights/dry-run", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    sqlite = makeSqliteD1();
    expect(sqlite.columns()).toContain("valid_until");
    sqlite.seed({
      id: "a-1", createdAt: NOW - 120 * DAY, tags: ["pricing"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability.",
    });
    sqlite.seed({
      id: "b-1", createdAt: NOW, tags: ["pricing"],
      content: "Decision: move the first tier to usage-based billing instead of flat pricing.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('c-1', 'a-1', 'b-1', 0.87, ?, 4.2, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
  });

  afterEach(() => sqlite.close());

  it("requires auth", async () => {
    const env = makeTestEnv(undefined, { DB: sqlite.db as any, OAUTH_KV: makeMemoryKV() });
    const res = await call(env, "/insights/dry-run", null);
    expect(res?.status).toBe(401);
  });

  it("returns reasoned candidates", async () => {
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD),
      OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const body = await (await call(env, "/insights/dry-run"))!.json() as any;

    expect(body.ok).toBe(true);
    expect(body.candidates[0].shape).toBe("contradiction");
    expect(body.candidates[0].a_id).toBe("a-1");
    // The only candidate, accepted, is comfortably inside the cap of three.
    expect(body.candidates[0].would_write).toBe(true);
  });

  it("writes nothing at all", async () => {
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD),
      OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    await call(env, "/insights/dry-run");

    const insights = await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%'`,
    ).first() as { n: number };
    const status = await sqlite.db.prepare(
      `SELECT status FROM insight_candidates WHERE id = 'c-1'`,
    ).first() as { status: string };

    expect(insights.n).toBe(0);
    expect(status.status).toBe("pending");
  });

  it("reports a declined candidate as having no insight", async () => {
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(`{"insight": false}`),
      OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const body = await (await call(env, "/insights/dry-run"))!.json() as any;

    expect(body.candidates[0].outcome).toBe("declined");
    expect(body.candidates[0].shape).toBeNull();
    expect(body.candidates[0].text).toBeNull();
    // A decline can never count toward the write cap.
    expect(body.candidates[0].would_write).toBe(false);
  });

  it("reports a failed model call distinctly from a declined one", async () => {
    // Both used to collapse to the same null; a human reading the shortlist
    // could not tell "the model looked and said no" apart from "the call
    // itself never answered." They must stay distinguishable here even though
    // neither ever writes anything.
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any,
      AI: { run: vi.fn().mockRejectedValue(new Error("AI down")) } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const body = await (await call(env, "/insights/dry-run"))!.json() as any;

    expect(body.candidates[0].outcome).toBe("failed");
    expect(body.candidates[0].shape).toBeNull();
    expect(body.candidates[0].text).toBeNull();
    expect(body.candidates[0].would_write).toBe(false);
  });

  it("excludes a candidate whose entry was deprecated after it was accrued", async () => {
    await sqlite.db.prepare(
      `UPDATE entries SET tags = '["pricing","status:deprecated"]' WHERE id = 'b-1'`,
    ).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD),
      OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const body = await (await call(env, "/insights/dry-run"))!.json() as any;

    expect(body.candidates).toEqual([]);
  });

  it("reasons with the configured INSIGHT_LLM_MODEL, not the shipped default", async () => {
    // makeAI's mock answers the same way whatever model string it's called
    // with, so this has to inspect the call itself — a regression that drops
    // `cfg` and silently falls back to DEFAULTS.INSIGHT_LLM_MODEL would
    // otherwise pass every other test in this file unnoticed. reasonOverPair
    // (src/insight/reason.ts) reads INSIGHT_LLM_MODEL, not the shared
    // LLM_MODEL every other feature uses — see src/constants.ts.
    const kv = makeMemoryKV();
    await kv.put(CONFIG_KEY, JSON.stringify({ INSIGHT_LLM_MODEL: "custom-model-for-test" }));
    const ai = makeAI(GOOD);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: ai, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock(),
    });

    await call(env, "/insights/dry-run");

    expect((ai.run as any).mock.calls[0][0]).toBe("custom-model-for-test");
  });
});

describe("GET /insights/dry-run — mirrors what the weekly pass actually enforces", () => {
  // The Rollout section this endpoint exists for: "Ship behind the existing
  // admin dry-run endpoint first and compare a run with and without, on the
  // real brain, before enabling." That comparison is only honest if the
  // preview suppresses what production suppresses. Before this task, the
  // dry-run's query selected no tags and never called isEligiblePair or
  // restatesRecent, so it reported as would-write exactly the candidates
  // production would refuse.
  let sqlite: SqliteD1;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    sqlite = makeSqliteD1();
    expect(sqlite.columns()).toContain("valid_until");
  });

  afterEach(() => sqlite.close());

  it("never reasons over a pair where both sides are assistant-authored, and reports it as not written", async () => {
    sqlite.seed({
      id: "a-1", createdAt: NOW - 120 * DAY, tags: ["work", "claude-response"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability.",
    });
    sqlite.seed({
      id: "b-1", createdAt: NOW, tags: ["work", "codex-response"],
      content: "Decision: move the first tier to usage-based billing instead of flat pricing.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('c-1', 'a-1', 'b-1', 0.87, ?, 4.2, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
    const ai = makeAI(GOOD);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: ai, OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const body = await (await call(env, "/insights/dry-run"))!.json() as any;

    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].would_write).toBe(false);
    expect(body.candidates[0].shape).toBeNull();
    expect(body.candidates[0].text).toBeNull();
    // The whole point: no model call spent on a pair D1 refuses outright.
    const reasoningCalls = (ai.run as any).mock.calls.filter(
      (c: any) => String(c[1]?.messages?.[0]?.content ?? "").includes("Memory A:"),
    );
    expect(reasoningCalls).toHaveLength(0);
  });

  it("still reports would_write for a pair where only one side is assistant-authored", async () => {
    // The regression D1's own comment warns against: a blunt exclusion would
    // destroy this case, which is often the useful kind of insight.
    sqlite.seed({
      id: "a-1", createdAt: NOW - 120 * DAY, tags: ["work", "claude-response"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability.",
    });
    sqlite.seed({
      id: "b-1", createdAt: NOW, tags: ["work"],
      content: "Decision: move the first tier to usage-based billing instead of flat pricing.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('c-1', 'a-1', 'b-1', 0.87, ?, 4.2, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const body = await (await call(env, "/insights/dry-run"))!.json() as any;

    expect(body.candidates[0].would_write).toBe(true);
  });

  it("reports would_write:false for a candidate that restates an insight already sitting in the queue", async () => {
    // The spec's own motivating case (weekly.ts's RECENT_INSIGHT_WINDOW
    // comment): the 2026-08-16 run restated an insight the 2026-08-12 dry run
    // had already produced, four days earlier — a DIFFERENT run, still
    // unreviewed. Seeding a pending auto-insight entry with the identical
    // text and running the dry run against a candidate the model answers the
    // same way is the direct regression test for that.
    sqlite.seed({
      id: "prior-insight", createdAt: NOW - 4 * DAY, tags: ["auto-insight"],
      content: `${GOOD_TEXT}\n\n[Insight: contradiction — drawn from 2 memories]`,
    });
    sqlite.seed({
      id: "a-1", createdAt: NOW - 120 * DAY, tags: ["pricing"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability.",
    });
    sqlite.seed({
      id: "b-1", createdAt: NOW, tags: ["pricing"],
      content: "Decision: move the first tier to usage-based billing instead of flat pricing.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('c-1', 'a-1', 'b-1', 0.87, ?, 4.2, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const body = await (await call(env, "/insights/dry-run"))!.json() as any;

    // The model DID answer, and the answer is reported (this is the "reasoned
    // but suppressed" case, distinct from "never reasoned over" above) — but
    // it must not be marked would_write, because production's restatesRecent
    // would suppress it exactly the same way.
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].outcome).toBe("insight");
    expect(body.candidates[0].text).toBe(GOOD_TEXT);
    expect(body.candidates[0].would_write).toBe(false);
  });

  it("still writes nothing at all when a pair is rejected or a candidate restates a recent insight", async () => {
    sqlite.seed({
      id: "prior-insight", createdAt: NOW - 4 * DAY, tags: ["auto-insight"],
      content: `${GOOD_TEXT}\n\n[Insight: contradiction — drawn from 2 memories]`,
    });
    sqlite.seed({
      id: "a-1", createdAt: NOW - 120 * DAY, tags: ["pricing"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability.",
    });
    sqlite.seed({
      id: "b-1", createdAt: NOW, tags: ["pricing"],
      content: "Decision: move the first tier to usage-based billing instead of flat pricing.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('c-1', 'a-1', 'b-1', 0.87, ?, 4.2, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    await call(env, "/insights/dry-run");

    const insights = await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%'`,
    ).first() as { n: number };
    const status = await sqlite.db.prepare(
      `SELECT status FROM insight_candidates WHERE id = 'c-1'`,
    ).first() as { status: string };

    // Only the pre-seeded prior insight, nothing newly written; the dry-run
    // candidate itself is untouched, still 'pending' — a preview commits no
    // status change either, unlike the real weekly pass marking it 'used'.
    expect(insights.n).toBe(1);
    expect(status.status).toBe("pending");
  });
});

describe("GET /insights/dry-run — ordering and the write cap across many candidates", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    sqlite = makeSqliteD1();
    expect(sqlite.columns()).toContain("valid_until");
    // Seeded out of score order on purpose: inserting tier 0 first would let
    // an ORDER BY bug hide behind insertion order happening to already match.
    const tiersInInsertionOrder: [tier: number, score: number][] = [
      [3, 6.6], [0, 9.9], [5, 4.4], [1, 8.8], [4, 5.5], [2, 7.7],
    ];
    for (const [tier, score] of tiersInInsertionOrder) seedTier(sqlite, tier, score);
  });

  afterEach(() => sqlite.close());

  it("orders by score, marks only the first three ACCEPTED candidates as would_write, and clamps to the requested limit", async () => {
    // Score order (desc): tier 0 (9.9), 1 (8.8), 2 (7.7), 3 (6.6), 4 (5.5), 5 (4.4).
    // Tier 2 — the 3rd-ranked candidate — is declined.
    const DECLINE_TIER = 2;
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeTieredAI(DECLINE_TIER),
      OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    });

    const full = await (await call(env, "/insights/dry-run"))!.json() as any;

    expect(full.candidates.map((c: any) => c.a_id)).toEqual(["a-0", "a-1", "a-2", "a-3", "a-4", "a-5"]);

    // Declined: reported, not dropped, and never counts toward the cap.
    expect(full.candidates[2]).toMatchObject({ a_id: "a-2", shape: null, text: null, would_write: false });

    // Accepted in score order: tier 0, 1, 3, 4, 5 (tier 2 declined). The cap
    // is 3 ACCEPTED candidates, so tier 3 — ranked 4th by score, but only the
    // 3rd one actually accepted, because tier 2's decline cost a model call
    // but never consumed a cap slot — is still marked would_write: true, and
    // the ones after it are not.
    expect(full.candidates[0].would_write).toBe(true);  // tier 0: 1st accepted
    expect(full.candidates[1].would_write).toBe(true);  // tier 1: 2nd accepted
    expect(full.candidates[3].would_write).toBe(true);  // tier 3: 3rd accepted
    expect(full.candidates[4].would_write).toBe(false); // tier 4: 4th accepted, past the cap
    expect(full.candidates[5].would_write).toBe(false); // tier 5: 5th accepted, past the cap

    // The JOIN and ORDER BY aren't just correct for the whole set — LIMIT
    // has to apply to that same ordering, not to some other row order.
    const limited = await (await call(env, "/insights/dry-run?limit=2"))!.json() as any;
    expect(limited.candidates.map((c: any) => c.a_id)).toEqual(["a-0", "a-1"]);
  });
});
