import { pricingInsight, PRICING_INSIGHTS } from "../helpers/insight-fixture";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runInsightAccrual, ACCRUAL_SEED_LIMIT } from "../../src/insight/candidates";
import { runWeeklyInsights, WEEKLY_CANDIDATE_LIMIT, MAX_INSIGHTS_PER_RUN } from "../../src/insight/weekly";
import { resetDatabaseInit } from "../../src/db/init";
import { initializeDatabase } from "../../src/db/init";
import { makeInsightFixture, FIXTURE_NOW } from "../helpers/insight-fixture";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { handleAdminRoutes } from "../../src/routes/admin";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { CONFIG_KEY } from "../../src/config";
import { INSIGHT_TEAM_WEEKLY_CRON } from "../../src/insight/schedule";

/**
 * D1 Free allows 50 queries per Worker invocation. That is a D1-specific
 * statement limit, not a shared counter for Vectorize, Workers AI and KV.
 * `sqlite.issued` records every D1 statement, including each statement inside
 * batch(); other bindings are asserted separately where their fanout matters.
 */
const D1_QUERY_BUDGET = 50;

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const DAY = 86400000;
// Keep the fake Worker clock ahead of SQLite's real `strftime('now')`. A fixed
// 2026 slot became an expired write admission once wall time passed slot+16m,
// even though the production clocks are the same. Any future Sunday 02:30 UTC
// exercises the same scheduler branch without turning this into a dated test.
const futureSunday = new Date();
futureSunday.setUTCDate(futureSunday.getUTCDate() + 7 + ((7 - futureSunday.getUTCDay()) % 7));
futureSunday.setUTCHours(2, 30, 0, 0);
const TEAM_INSIGHT_SLOT = futureSunday.getTime();

const drawnFrom = async (sqlite: SqliteD1) =>
  ((await sqlite.db.prepare(
    `SELECT source_id, target_id, provenance FROM edges WHERE type = 'drawn_from'`,
  ).all()).results) as { source_id: string; target_id: string; provenance: string }[];

/**
 * A reasoning call that always accepts. The default AI mock (makeAIMock in
 * test/helpers/make-env.ts) returns the literal text "3" for every non-embedding
 * call, which parseInsightResponse (src/insight/reason.ts) can never parse as
 * JSON — so with the default mock reasonOverPair returns null for every
 * candidate and captureEntry is never reached at all. That measures the cheap
 * branch of the weekly pass (rejections only), not the expensive one: up to
 * MAX_INSIGHTS_PER_RUN real captures, each paying duplicate detection,
 * embedding and storage. This mock (same shape as test/unit/insight-weekly.
 * test.ts's makeAI) answers the reasoning prompt — identified by "Memory A:",
 * the one string only that prompt contains — with a well-formed insight, so
 * the pass actually exercises captureEntry the number of times production
 * would on a night where every candidate is a real one.
 */
function makeReasoningAI() {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      // Keyed off the candidate's own tier number so every accepted insight's
      // text — and therefore captureEntry's stored content — is distinct per
      // candidate, not a repeat of the same string three times over. Distinct
      // means genuinely different wording, not a shared template with the
      // tier digit swapped in: distinctiveTokens (reason.ts) drops a bare
      // digit entirely, and even where it didn't, one differing word among
      // nine tokens is still ~89% overlap — restatesRecent (wired into
      // weekly.ts by the same task this fixture had to be corrected for)
      // would treat that as the same conclusion restated and this run would
      // stop writing after the first candidate instead of three. Only tiers
      // 0-2 need to clear both the vocabulary floor (against their own
      // entries) and mutual novelty (against each other), since only the top
      // three by score are ever reasoned over.
      const tier = prompt.match(/tier (\d+)/)?.[1] ?? "0";
      const perTier: Record<string, string> = PRICING_INSIGHTS;
      const insight = pricingInsight(perTier[tier] ?? perTier["0"]);
      return sse(prompt.includes("Memory A:") ? insight : "3");
    }),
  } as unknown as Ai;
}

/**
 * The model DECLINES every candidate but the last three.
 *
 * makeReasoningAI above accepts the first thing it is offered, so the pass
 * breaks out of its loop at MAX_INSIGHTS_PER_RUN after three of the ten
 * candidates — that measures the CHEAPEST branch, not the ceiling. Nothing
 * stops a real run reasoning over the whole WEEKLY_CANDIDATE_LIMIT slate: a
 * corpus of near-duplicate memories declines constantly, which is the exact
 * corpus the pass exists for. Every declined candidate is one more AI.run
 * against the same 50-subrequest invocation, so the honest worst case is
 * "every candidate reaches the model AND three of them are written".
 *
 * The three accepted tiers reuse the same three texts makeReasoningAI uses,
 * for the same reason: they are genuinely differently worded, so the novelty
 * floor does not suppress the second and third write and turn this back into
 * a cheap run wearing an expensive fixture.
 */
function makeDecliningAI(acceptFromTier: number) {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  const accepted = Object.values(PRICING_INSIGHTS);
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (!prompt.includes("Memory A:")) return sse("3");
      const tier = Number(prompt.match(/tier (\d+)/)?.[1] ?? "0");
      // An explicit refusal, the shape reasonOverPair reads as "declined"
      // (src/insight/reason.ts) — settled, not retried, and one model call
      // spent either way.
      if (tier < acceptFromTier) return sse('{"insight": false}');
      const text = accepted[(tier - acceptFromTier) % accepted.length];
      return sse(pricingInsight(text));
    }),
  } as unknown as Ai;
}

/** 再試行待ち＋4種の検証失敗＋明示見送り＋3保存を同じ実行に混ぜる。 */
function makeMixedValidationAI() {
  const ai = makeDecliningAI(7);
  const delegate = ai.run.bind(ai);
  return { run: vi.fn(async (model: string, opts: any) => {
    const prompt = String(opts?.messages?.[0]?.content ?? "");
    const tier = Number(prompt.match(/tier (\d+)/)?.[1] ?? "0");
    if (!prompt.includes("Memory A:") || tier >= 6) return delegate(model as any, opts);
    const good = JSON.parse(pricingInsight(PRICING_INSIGHTS["0"]));
    const payloads = ["not JSON", "not JSON", JSON.stringify({ ...good, text: "You reversed the pricing decision by choosing usage-based billing instead." }),
      JSON.stringify({ ...good, evidence: undefined }),
      JSON.stringify({ ...good, text: "記憶Aと記憶Bを比較すると、料金の予測しやすさよりも利用量に応じた請求を重視する判断に変更しています。" }), "not JSON"];
    return new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: payloads[tier] })}\n\n`));
      c.close();
    } });
  }) } as unknown as Ai;
}

// forkのcapability確認は保存成功の有無にもかかわらず計上し、50 SQLの上限は維持する。
describe("insight crons stay inside one invocation's budget", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    // initializeDatabase memoizes its promise at module scope (src/db/init.ts).
    // Every test here builds a brand-new in-memory database, so without this
    // reset the second test to reach a runtime-ALTER column (captureEntry's
    // INSERT below writes updated_at, which lives only in the ALTER, not in
    // db/schema.sql) inherits an "already migrated" memo for a database that
    // was never altered, and the insert fails against real SQLite.
    resetDatabaseInit();
  });

  it("accrual stays under budget at a full seed batch", async () => {
    // The fixture holds a handful of entries; a real night can present
    // ACCRUAL_SEED_LIMIT of them, so pad it to the worst case.
    //
    // Padding with a vector id the fixture's VECTORIZE mock has never heard of
    // (e.g. `vec-pad-${i}`) makes getByIds silently drop it — the mock's
    // getByIds filters to ids it recognises — so the padded seed never reaches
    // a query() call at all, and the measured run is dominated by the handful
    // of real fixture entries rather than a full 25-seed batch. Pointing each
    // pad entry's vector id at one of the fixture's own (real, registered)
    // vectors keeps every padded seed resolvable, so this actually drives
    // ACCRUAL_SEED_LIMIT worth of VECTORIZE.query calls — the cost line item
    // that dominates the budget (see src/insight/candidates.ts's own comment:
    // "25 queries" of the ~34 total) — rather than measuring a run that quietly
    // does almost nothing.
    const fx = makeInsightFixture();
    for (let i = 0; i < ACCRUAL_SEED_LIMIT; i++) {
      fx.sqlite.seed({
        id: `pad-${i}`, createdAt: FIXTURE_NOW - i * DAY, tags: ["pricing"],
        content: `A padding decision about the pricing model number ${i}, long enough to be eligible.`,
        vectorIds: [`vec-${fx.all[i % fx.all.length].id}`],
      });
    }
    // The fixture's KV (test/helpers/make-env.ts's makeMemoryKV) is a plain
    // object, not a vi.fn(), so its calls have to be spied on explicitly —
    // runInsightAccrual reads and writes the accrual cursor through it, and
    // that read/write is as real a subrequest as a D1 or Vectorize call.
    const kvGet = vi.spyOn(fx.env.OAUTH_KV, "get");
    const kvPut = vi.spyOn(fx.env.OAUTH_KV, "put");

    const admittedEnv = fx.sqlite.admitEnv(fx.env);
    await runInsightAccrual(admittedEnv, ctx);

    const bindingCalls =
      (fx.env.VECTORIZE.query as any).mock.calls.length +
      (fx.env.VECTORIZE.getByIds as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    expect(fx.sqlite.issued.length).toBeLessThan(D1_QUERY_BUDGET);
    expect(bindingCalls).toBeLessThanOrEqual(ACCRUAL_SEED_LIMIT + 4);
    fx.sqlite.close();
  });

  it("the weekly pass stays under budget at a full candidate slate", async () => {
    // Every candidate content string is parameterised by `i` so that, once
    // reasoning starts accepting (below), the entries captureEntry writes are
    // not identical to one another — an identical-content run would let
    // duplicate detection block the second and third capture, which would
    // measure that path's cost instead of three genuinely separate writes.
    const sqlite: SqliteD1 = makeSqliteD1();
    for (let i = 0; i < WEEKLY_CANDIDATE_LIMIT; i++) {
      sqlite.seed({
        id: `a-${i}`, createdAt: FIXTURE_NOW - 120 * DAY, tags: ["pricing"],
        content: `Decision: price tier ${i} flat at nine dollars a month for predictable billing.`,
      });
      sqlite.seed({
        id: `b-${i}`, createdAt: FIXTURE_NOW, tags: ["pricing"],
        content: `Decision: move tier ${i} to usage-based billing instead of flat pricing.`,
      });
      sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`c-${i}`, `a-${i}`, `b-${i}`, 120 * DAY, 10 - i, FIXTURE_NOW).run();
    }
    const kv = makeMemoryKV();
    const env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock(),
      AI: makeReasoningAI(),
    }));
    // The scheduler dedicates a changed-schema tick to DDL and starts the periodic job
    // on the next tick. Measure that runnable steady-state invocation, not DDL+job in a
    // combination production deliberately never executes.
    await initializeDatabase(env);
    const before = sqlite.issued.length;   // seeding/schema convergence are not the pass
    // Same reasoning as the accrual test: KV is a plain object, not a vi.fn(),
    // so it needs an explicit spy. runWeeklyInsights itself reads it once
    // (config, via resolveConfig) — but each successful captureEntry call
    // fires its own KV read too, for the tag-vocabulary cache (rememberTags,
    // src/tags/vocabulary.ts), via a fire-and-forget ctx.waitUntil() call
    // whose body still runs (and still spends the read) synchronously up to
    // its first await regardless of whether anything ever awaits the result.
    // Measured: 1 config read + 3 vocabulary reads (one per capture) = 4.
    const kvGet = vi.spyOn(kv, "get");
    const kvPut = vi.spyOn(kv, "put");

    await runWeeklyInsights(sqlite.admitEnv(env), ctx);

    // Confirms this actually measured the expensive branch (real captures)
    // rather than the cheap one (every candidate declined) — otherwise the
    // budget assertion below would hold trivially, the way it did against
    // the default AI mock.
    const written = (await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%'`,
    ).first()) as { n: number };
    expect(written.n).toBe(MAX_INSIGHTS_PER_RUN);

    const bindingCalls =
      (env.AI.run as any).mock.calls.length +
      (env.VECTORIZE.query as any).mock.calls.length +
      // captureEntry's storage path calls VECTORIZE.upsert, not .insert
      // (src/capture/store.ts) — counting only .insert left the actual
      // vector write completely untracked. Both are counted, rather than
      // one replacing the other, so this stays correct if that ever changes.
      (env.VECTORIZE.insert as any).mock.calls.length +
      (env.VECTORIZE.upsert as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    const measured = sqlite.issued.length - before;
    expect(measured).toBeLessThan(D1_QUERY_BUDGET);
    expect(bindingCalls).toBeGreaterThan(0);
    // The D1 check above has headroom at this
    // candidate slate (measured 35 of 50, including the schema and lock reads
    // column ALTERs and one cutover-lock read for each accepted insight) —
    // wide enough that
    // spending six more unbatched subrequests here (two drawn_from edges per
    // insight via createEdge, rather than joining the batch below) would
    // still read as "under budget" and this test would not catch the
    // regression edgeInsertStatement exists to prevent. Pinned to the
    // measured value so that regression fails loudly instead of quietly
    // eating slack.
    expect(measured).toBe(37);

    // Verified after the budget assertion, not before: this SELECT is a test
    // check, not something runWeeklyInsights() itself issues, and including
    // it above would charge the measurement for a subrequest production
    // never spends. Two drawn_from edges per stored insight — the whole
    // reason edgeInsertStatement exists is so these join the batch above
    // rather than costing MAX_INSIGHTS_PER_RUN * 2 extra subrequests via
    // createEdge.
    expect(await drawnFrom(sqlite)).toHaveLength(MAX_INSIGHTS_PER_RUN * 2);
    sqlite.close();
  });

  it("the sliced team pass stays under budget at a full candidate slate", async () => {
    // The team pass is its own invocation and therefore its own 50, and this
    // is the measurement the fifth cron trigger is justified by: if the two
    // passes shared one invocation the total would be the sum of this number
    // and the one above, which is well past the ceiling and would leave the
    // second pass dead half-written.
    //
    // A FULL slate inside the slice, plus personal candidates outscoring every
    // one of them — the worst case, and the shape a real team brain has. The
    // personal rows are what make the measurement honest: a slice that cost
    // less only because it drew fewer candidates would prove nothing.
    const sqlite: SqliteD1 = makeSqliteD1();
    const seedIn = (id: string, workspaceId: string, content: string, createdAt: number) => {
      sqlite.seed({ id, content, createdAt, tags: ["pricing"] });
      return sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
    };
    for (let i = 0; i < WEEKLY_CANDIDATE_LIMIT; i++) {
      await seedIn(`co-a-${i}`, "ws-co",
        `Decision: price tier ${i} flat at nine dollars a month for predictable billing.`, FIXTURE_NOW - 120 * DAY);
      await seedIn(`co-b-${i}`, "ws-co",
        `Decision: move tier ${i} to usage-based billing instead of flat pricing.`, FIXTURE_NOW);
      await sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`co-c-${i}`, `co-a-${i}`, `co-b-${i}`, 120 * DAY, 10 - i, FIXTURE_NOW).run();
      // A higher-scoring personal pair per company pair, which the slice must
      // remove in the query rather than after drawing it.
      await seedIn(`p-a-${i}`, "ws-alice",
        `Decision: price plan ${i} flat at nine dollars a month for predictable billing.`, FIXTURE_NOW - 120 * DAY);
      await seedIn(`p-b-${i}`, "ws-alice",
        `Decision: move plan ${i} to usage-based billing instead of flat pricing.`, FIXTURE_NOW);
      await sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`p-c-${i}`, `p-a-${i}`, `p-b-${i}`, 120 * DAY, 100 - i, FIXTURE_NOW).run();
    }
    const before = sqlite.issued.length;   // seeding is not the pass

    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock(),
      AI: makeReasoningAI(),
    });
    const kvGet = vi.spyOn(kv, "get");
    const kvPut = vi.spyOn(kv, "put");

    await runWeeklyInsights(sqlite.admitEnv(env), ctx, { onlyWorkspaceIds: ["ws-co"] });

    // The expensive branch: three real captures, all of them in the slice.
    const written = (await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%' AND workspace_id = 'ws-co'`,
    ).first()) as { n: number };
    expect(written.n).toBe(MAX_INSIGHTS_PER_RUN);

    const bindingCalls =
      (env.AI.run as any).mock.calls.length +
      (env.VECTORIZE.query as any).mock.calls.length +
      (env.VECTORIZE.insert as any).mock.calls.length +
      (env.VECTORIZE.upsert as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    const d1Queries = sqlite.issued.length - before;
    expect(d1Queries).toBeLessThan(D1_QUERY_BUDGET);
    expect(bindingCalls).toBe(21);
    // Pinned, like the unsliced case above: the slice is a WHERE predicate on
    // a query that already ran, so it costs the same 42 the personal pass
    // costs. A future change that made the team pass more expensive than the
    // personal one is exactly what this number is here to surface.
    expect(d1Queries).toBe(38);

    expect(await drawnFrom(sqlite)).toHaveLength(MAX_INSIGHTS_PER_RUN * 2);
    sqlite.close();
  });
});

describe("the worst case, not the cheapest branch", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    resetDatabaseInit();
  });

  /**
   * A full slate the model mostly refuses: ten candidates all reach
   * reasonOverPair and only the last three are written. Both fixtures above
   * hand the model something it accepts immediately, so their loop breaks after
   * three of the ten candidates and the 36 they pin is a SAMPLE of the cheapest
   * branch. This is the ceiling: nothing in the pass can cost more than a full
   * WEEKLY_CANDIDATE_LIMIT of model calls plus MAX_INSIGHTS_PER_RUN captures.
   */
  const seedFullSlate = (sqlite: SqliteD1, workspaceId?: string) => {
    for (let i = 0; i < WEEKLY_CANDIDATE_LIMIT; i++) {
      sqlite.seed({
        id: `a-${i}`, createdAt: FIXTURE_NOW - 120 * DAY, tags: ["pricing"],
        content: `Decision: price tier ${i} flat at nine dollars a month for predictable billing.`,
      });
      sqlite.seed({
        id: `b-${i}`, createdAt: FIXTURE_NOW, tags: ["pricing"],
        content: `Decision: move tier ${i} to usage-based billing instead of flat pricing.`,
      });
      if (workspaceId) {
        sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id IN (?, ?)`)
          .bind(workspaceId, `a-${i}`, `b-${i}`).run();
      }
      sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`c-${i}`, `a-${i}`, `b-${i}`, 120 * DAY, 10 - i, FIXTURE_NOW).run();
    }
  };

  const countBindings = (env: Env, kvGet: any, kvPut: any) =>
    (env.AI.run as any).mock.calls.length +
    (env.VECTORIZE.query as any).mock.calls.length +
    (env.VECTORIZE.insert as any).mock.calls.length +
    (env.VECTORIZE.upsert as any).mock.calls.length +
    kvGet.mock.calls.length +
    kvPut.mock.calls.length;

  it("the weekly pass at its most expensive slate", async () => {
    const sqlite: SqliteD1 = makeSqliteD1();
    seedFullSlate(sqlite);
    const before = sqlite.issued.length;
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock(),
      AI: makeDecliningAI(WEEKLY_CANDIDATE_LIMIT - MAX_INSIGHTS_PER_RUN),
    }) as Env;
    const kvGet = vi.spyOn(kv, "get");
    const kvPut = vi.spyOn(kv, "put");

    await runWeeklyInsights(sqlite.admitEnv(env), ctx);

    // The whole slate reached the model AND three insights were still written:
    // without both halves this measures a cheaper run than the ceiling.
    const reasonCalls = (env.AI.run as any).mock.calls.filter(
      (c: any[]) => String(c[1]?.messages?.[0]?.content ?? "").includes("Memory A:"),
    ).length;
    expect(reasonCalls).toBe(WEEKLY_CANDIDATE_LIMIT);
    const written = (await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%'`,
    ).first()) as { n: number };
    expect(written.n).toBe(MAX_INSIGHTS_PER_RUN);

    const bindingCalls = countBindings(env, kvGet, kvPut);
    const d1Queries = sqlite.issued.length - before;
    expect(d1Queries).toBeLessThan(D1_QUERY_BUDGET);
    expect(d1Queries).toBe(39);
    expect(bindingCalls).toBe(28);
    sqlite.close();
  });

  it("the whole team invocation at its most expensive slate", async () => {
    // Measured end to end through scheduled(), not the pass plus arithmetic:
    // the branch's own schema/admission work and companyWorkspaceIds query are
    // part of the same D1 limit. This measures the complete scheduled branch,
    // rather than inferring its cost from the pass alone.
    const sqlite: SqliteD1 = makeSqliteD1();
    sqlite.db.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', ?, 0)`)
      .bind("ws-co", "ws-co").run();
    seedFullSlate(sqlite, "ws-co");
    const kv = makeMemoryKV();
    await kv.put(CONFIG_KEY, JSON.stringify({ TEAM_INSIGHTS: "on" }));
    const before = sqlite.issued.length;
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock(),
      AI: makeDecliningAI(WEEKLY_CANDIDATE_LIMIT - MAX_INSIGHTS_PER_RUN),
    }) as Env;
    const kvGet = vi.spyOn(kv, "get");
    const kvPut = vi.spyOn(kv, "put");

    const pending: Promise<unknown>[] = [];
    vi.spyOn(Date, "now").mockReturnValue(TEAM_INSIGHT_SLOT);
    await (worker as any).scheduled(
      { cron: INSIGHT_TEAM_WEEKLY_CRON, scheduledTime: TEAM_INSIGHT_SLOT } as any,
      env,
      { waitUntil: (pr: Promise<unknown>) => pending.push(pr) } as unknown as ExecutionContext,
    );
    await Promise.allSettled(pending);

    const written = (await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%' AND workspace_id = 'ws-co'`,
    ).first()) as { n: number };
    expect(written.n).toBe(MAX_INSIGHTS_PER_RUN);

    const bindingCalls = countBindings(env, kvGet, kvPut);
    const d1Queries = sqlite.issued.length - before;
    expect(d1Queries).toBeLessThan(D1_QUERY_BUDGET);
    // 40 of 50 D1 statements. Keep the non-D1 binding fanout pinned separately:
    // Workers AI, Vectorize and KV do not consume D1's 50-query allowance.
    expect(d1Queries).toBe(42);
    expect(bindingCalls).toBe(29);
    sqlite.close();
  });

  /**
   * THE CHUNKED ARM, measured rather than inferred.
   *
   * 40 above is one company workspace, so the slice fits one statement and the
   * second chunk never executes. The additional statement's cost is
   * measured below rather than inferred from this one-workspace case.
   * So it is driven end to end through scheduled(), at the two workspace
   * counts that bracket the behaviour:
   *
   *   49 workspaces — 2N + 1 = 99 parameters, still ONE statement, still 40.
   *   50 workspaces — 101 parameters unchunked, so the second statement is
   *                   owed and the invocation costs 41.
   *   98 workspaces — the whole capacity (MAX_SLICE_STATEMENTS chunks). Still
   *                   41: a third statement is never issued, which is what
   *                   MAX_SLICE_STATEMENTS is for.
   *
   * 51 and 52 are one and two over this codebase's self-imposed 50, and ONLY
   * here: this test (like its siblings above) resets initializeDatabase's
   * memo before every call, so it pays the four time-anchor ALTERs (when_at,
   * when_kind, when_source, when_label) fresh each time — a cost a real
   * brain pays exactly once, ever, on its first request after this ships,
   * not on every chunked team-insights night for the rest of its life.
   * Nowhere near the platform's real 1,000-subrequest ceiling either way.
   * Accepted as a one-time, self-imposed-budget-only trade-off rather than
   * clawed back from the migration or the pass.
   *
   * The slate lives in the LAST workspace of the slice on purpose, so the
   * measured run is one where the second chunk is the chunk that does the
   * work, not one where it comes back empty.
   */
  const teamInvocationCost = async (workspaceCount: number, mixedValidation = false): Promise<{ d1Queries: number; bindingCalls: number }> => {
    resetDatabaseInit();
    const sqlite: SqliteD1 = makeSqliteD1();
    const ids = Array.from({ length: workspaceCount }, (_, i) => `ws-co-${i}`);
    for (const id of ids) {
      sqlite.db.prepare(
        `INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', ?, 0)`,
      ).bind(id, id).run();
    }
    seedFullSlate(sqlite, ids[ids.length - 1]);
    if (mixedValidation) {
      await sqlite.db.prepare("UPDATE insight_candidates SET status = 'retry:evidence-v1' WHERE id IN ('c-1', 'c-2', 'c-3', 'c-4', 'c-5')").run();
    }
    const kv = makeMemoryKV();
    await kv.put(CONFIG_KEY, JSON.stringify({ TEAM_INSIGHTS: "on" }));
    const before = sqlite.issued.length;
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock(),
      AI: mixedValidation ? makeMixedValidationAI() : makeDecliningAI(WEEKLY_CANDIDATE_LIMIT - MAX_INSIGHTS_PER_RUN),
    }) as Env;
    const kvGet = vi.spyOn(kv, "get");
    const kvPut = vi.spyOn(kv, "put");

    const pending: Promise<unknown>[] = [];
    vi.spyOn(Date, "now").mockReturnValue(TEAM_INSIGHT_SLOT);
    await (worker as any).scheduled(
      { cron: INSIGHT_TEAM_WEEKLY_CRON, scheduledTime: TEAM_INSIGHT_SLOT } as any,
      env,
      { waitUntil: (pr: Promise<unknown>) => pending.push(pr) } as unknown as ExecutionContext,
    );
    await Promise.allSettled(pending);

    // Still the expensive branch, or the number below is a cheaper run.
    const written = (await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%' AND workspace_id = ?`,
    ).bind(ids[ids.length - 1]).first()) as { n: number };
    expect(written.n).toBe(MAX_INSIGHTS_PER_RUN);

    const bindingCalls = countBindings(env, kvGet, kvPut);
    const d1Queries = sqlite.issued.length - before;
    if (mixedValidation) {
      const states = await sqlite.db.prepare("SELECT id, status FROM insight_candidates ORDER BY id").all();
      expect(states.results).toEqual([
        { id: "c-0", status: "retry:evidence-v1" },
        { id: "c-1", status: "invalid:evidence-v1:format" },
        { id: "c-2", status: "invalid:evidence-v1:language" },
        { id: "c-3", status: "invalid:evidence-v1:evidence" },
        { id: "c-4", status: "invalid:evidence-v1:restatement" },
        { id: "c-5", status: "invalid:evidence-v1:format" },
        { id: "c-6", status: "rejected" },
        { id: "c-7", status: "used" }, { id: "c-8", status: "used" }, { id: "c-9", status: "used" },
      ]);
    }
    sqlite.close();
    return { d1Queries, bindingCalls };
  };

  it("stays inside the budget when the slice needs a second statement", async () => {
    expect(await teamInvocationCost(49)).toEqual({ d1Queries: 42, bindingCalls: 29 });
    const fifty = await teamInvocationCost(50);
    expect(fifty.d1Queries).toBeLessThan(D1_QUERY_BUDGET);
    // 41 of 50. Nine D1 statements of slack for the whole team invocation on a
    // deployment big enough to need chunking.
    expect(fifty).toEqual({ d1Queries: 43, bindingCalls: 29 });
    // The whole capacity, and no third statement.
    expect(await teamInvocationCost(98)).toEqual({ d1Queries: 43, bindingCalls: 29 });
  });

  it("検証失敗の全理由と3保存を含む98ワークスペースの実行もD1上限内", async () => {
    const cost = await teamInvocationCost(98, true);
    expect(cost.d1Queries).toBeLessThan(D1_QUERY_BUDGET);
    expect(cost).toEqual({ d1Queries: 46, bindingCalls: 29 });
  });
});

describe("POST /insights/accrue stays inside one invocation's budget", () => {
  // The on-demand endpoint (src/routes/admin.ts) runs the exact same
  // runInsightAccrual pass the nightly cron does, plus two cheap COUNT(*)
  // queries against insight_candidates (before/after) to report what
  // changed. It has to fit the same 50-subrequest ceiling — the platform
  // does not grant fetch handlers a bigger budget than scheduled ones — so
  // this measures the endpoint's total cost, not just the accrual pass
  // underneath it.
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    resetDatabaseInit();
  });

  it("stays under budget at a full seed batch", async () => {
    // Same worst-case padding as "accrual stays under budget at a full seed
    // batch" above — see that test's comment for why each pad seed points at
    // a real, registered fixture vector rather than an unresolvable one.
    const fx = makeInsightFixture();
    for (let i = 0; i < ACCRUAL_SEED_LIMIT; i++) {
      fx.sqlite.seed({
        id: `pad-${i}`, createdAt: FIXTURE_NOW - i * DAY, tags: ["pricing"],
        content: `A padding decision about the pricing model number ${i}, long enough to be eligible.`,
        vectorIds: [`vec-${fx.all[i % fx.all.length].id}`],
      });
    }
    const kvGet = vi.spyOn(fx.env.OAUTH_KV, "get");
    const kvPut = vi.spyOn(fx.env.OAUTH_KV, "put");

    const res = await handleAdminRoutes(
      req("POST", "/insights/accrue"),
      new URL("http://localhost/insights/accrue"),
      fx.env,
      ctx,
    );
    expect(res?.status).toBe(200);

    const bindingCalls =
      (fx.env.VECTORIZE.query as any).mock.calls.length +
      (fx.env.VECTORIZE.getByIds as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    // Measured: 37 (runInsightAccrual's own ~34-37 plus the endpoint's two
    // COUNT(*) queries) — comfortably inside the 50-subrequest ceiling.
    expect(fx.sqlite.issued.length).toBeLessThan(D1_QUERY_BUDGET);
    expect(bindingCalls).toBeLessThanOrEqual(ACCRUAL_SEED_LIMIT + 4);
    fx.sqlite.close();
  });
});
