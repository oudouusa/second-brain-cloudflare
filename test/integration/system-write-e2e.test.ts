import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { compressTag } from "../../src/compression/digest";
import { runWeeklyInsights } from "../../src/insight/weekly";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { pricingInsight, PRICING_INSIGHTS } from "../helpers/insight-fixture";
import type { Env } from "../../src/env";

const DAY = 86400000;
let now = 400 * DAY;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const sse = (text: string) => new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
    c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    c.close();
  },
});

function makeAI(decision: () => string) {
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (prompt.includes("Choose exactly one action") || prompt.includes("checking if a new memory contradicts")) return sse(decision());
      return opts?.stream ? sse("A digest of the work memories.") : { response: "3" };
    }),
  } as unknown as Ai;
}

describe("ADV systemWrite", () => {
  // Real system row: actor "" plus a system tag, as the digest itself writes.
  let sqlite: SqliteD1;
  let target = "";
  let score = 0.9;
  let decision = () => "";
  let env: Env;
  beforeEach(async () => {
    now = 400 * DAY;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(() => decision()), OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockImplementation(async () => ({ matches: target ? [{ id: target, score, metadata: { parentId: target } }] : [] })) }),
    })) as Env;
    await initializeDatabase(env);
    for (let i = 0; i < 12; i++) sqlite.seed({ id: `w-${i}`, content: `Memory about work number ${i}`, createdAt: now - 200 * DAY + i, tags: ["rocket-project"] });
  });
  afterEach(() => { sqlite.close(); vi.restoreAllMocks(); });

  it("A: flagged digest (merge into its OWN earlier digest) inserts an orphan row, sources never roll up, repeats", async () => {
    sqlite.seed({ id: "old-digest", content: "[Synthesized from 12 entries tagged \"work\"]\n\nOlder digest", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "system" });
    target = "old-digest"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "old-digest", merged_content: "combined digest" });
    const r1 = await compressTag("rocket-project", env, ctx);
    now += 2 * DAY;
    const r2 = await compressTag("rocket-project", env, ctx);
    now += 2 * DAY;
    const r3 = await compressTag("rocket-project", env, ctx);
    const rows = sqlite.rows();
    const digests = rows.filter(r => String(r.tags).includes('"synthesized"'));
    const rolled = rows.filter(r => String(r.tags).includes('"rolled-up"'));
    console.log("results", r1.synthesizedId, r2.synthesizedId, r3.synthesizedId, "digests", digests.length, "rolled", rolled.length);
    // Desired: digest merged into its own row (plan allows) or stored & sources rolled up.
    expect(digests.length).toBe(1 + 0);
    // The three runs merged into the one digest and its sources rolled up onto it.
    expect(r1.synthesizedId).toBe("old-digest");
    expect(rolled.length).toBe(12);
  });

  it("B: a row whose source string is 'system' but written by a user is deprecated by a digest contradiction", async () => {
    // What POST /capture {source:"system"} or MCP remember {source:"system"} stores.
    sqlite.seed({ id: "user-row", content: "We decided the work plan is X", createdAt: now - 1 * DAY, tags: ["decisions"], source: "system" });
    target = "user-row"; score = 0.7; // below flag, above candidate: contradiction-only prompt
    decision = () => JSON.stringify({ contradicts: true, conflicting_id: "user-row", reason: "changed" });
    await compressTag("rocket-project", env, ctx);
    const row = sqlite.rows().find(r => r.id === "user-row")!;
    console.log("user-row tags", row.tags);
    expect(String(row.tags)).not.toContain("status:deprecated");
  });

  it("C: a protected contradiction leaves the user row alone and stores a draft digest without rolling sources up", async () => {
    sqlite.seed({ id: "user-row", content: "We decided the work plan is X", createdAt: now - 1 * DAY, tags: ["decisions"], source: "api" });
    target = "user-row"; score = 0.7;
    decision = () => JSON.stringify({ contradicts: true, conflicting_id: "user-row", reason: "changed" });
    const r = await compressTag("rocket-project", env, ctx);
    const rows = sqlite.rows();
    const user = rows.find(x => x.id === "user-row")!;
    const digests = rows.filter(x => String(x.tags).includes('"synthesized"'));
    console.log("C: synthesizedId", r.synthesizedId, "user.contradiction_wins", user.contradiction_wins, "digest tags", digests.map(d => d.tags), "rolled", rows.filter(x => String(x.tags).includes('"rolled-up"')).length);
    expect(user.contradiction_wins).toBe(0);
    expect(user.contradiction_losses).toBe(0);
    expect(JSON.parse(String(user.tags))).toEqual(["decisions"]);
    // The draft digest is stored, but it is not a live digest: sources are not rolled up onto it
    // and nothing is reported as synthesized. The digest retries next cycle.
    expect(digests).toHaveLength(1);
    expect(r.synthesizedId).toBeNull();
    expect(rows.filter(x => String(x.tags).includes('"rolled-up"'))).toHaveLength(0);
  });

  it("D: a user row that merely carries the system tags but has an actor is still protected from merge", async () => {
    sqlite.seed({ id: "user-digest", content: "[Synthesized from 12 entries tagged \"work\"]\n\nMine", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "system" });
    sqlite.db.prepare(`UPDATE entries SET actor_id = 'u1' WHERE id = 'user-digest'`).run();
    target = "user-digest"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "user-digest", merged_content: "combined" });
    await compressTag("rocket-project", env, ctx);
    const row = sqlite.rows().find(r => r.id === "user-digest")!;
    expect(row.content).toContain("Mine");
    expect(sqlite.rows().filter(r => String(r.tags).includes('"synthesized"')).length).toBe(2);
  });

  it("E: an insight flagged as a duplicate of a user memory still gets its drawn_from edges", async () => {
    sqlite.seed({ id: "a-0", content: "Decision: price tier 0 flat at nine dollars a month for predictable billing.", createdAt: now - 120 * DAY, tags: ["pricing"] });
    sqlite.seed({ id: "b-0", content: "Decision: move tier 0 to usage-based billing instead of flat pricing.", createdAt: now, tags: ["pricing"] });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('cand-0', 'a-0', 'b-0', 0.87, ?, 10, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, now).run();
    target = "a-0"; score = 0.9;
    decision = () => JSON.stringify({ action: "keep_both" });
    const ai = env.AI as any;
    const base = ai.run.getMockImplementation();
    ai.run.mockImplementation(async (model: string, opts: any) => {
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (prompt.includes("Memory A:")) return sse(pricingInsight(PRICING_INSIGHTS["0"]));
      return base(model, opts);
    });
    await runWeeklyInsights(env, ctx);
    const insight = sqlite.rows().find(r => String(r.tags).includes('"auto-insight"'))!;
    expect(insight).toBeTruthy();
    expect(String(insight.tags)).toContain("duplicate-candidate");
    const edges = (await env.DB.prepare(`SELECT target_id FROM edges WHERE source_id = ? AND type = 'drawn_from' ORDER BY target_id`).bind(insight.id).all()).results as { target_id: string }[];
    expect(edges.map(e => e.target_id)).toEqual(["a-0", "b-0"]);
  });

  it("F (T-0089.3.3): two replaces of one insight in one weekly run leave only the second pair's drawn_from edges", async () => {
    // A prior auto-insight row (real system row: actor "", source "system", the
    // tag itself), which BOTH of this run's candidates below will replace into.
    sqlite.seed({ id: "insight-0", content: "An older insight, now stale.", createdAt: now - 5 * DAY, tags: ["auto-insight"], source: "system" });
    // Two unrelated topics on purpose: reasonOverPair's D8 vocabulary floor
    // (sharesVocabulary) requires the insight text to name a word EXACT to
    // each side's own content, and restatesRecent must not treat the second
    // pair's insight as restating the first's — both are trivial when the
    // two pairs share no subject matter.
    sqlite.seed({ id: "a-0", content: "Decision: price tier flat at nine dollars a month for predictable billing.", createdAt: now - 120 * DAY, tags: ["pricing"] });
    sqlite.seed({ id: "b-0", content: "Decision: move tier to usage-based billing instead of flat pricing.", createdAt: now, tags: ["pricing"] });
    sqlite.seed({ id: "a-1", content: "Decision: schedule the design review every Thursday afternoon for the whole team.", createdAt: now - 120 * DAY, tags: ["meetings"] });
    sqlite.seed({ id: "b-1", content: "Decision: moved the design review to Tuesday mornings because Thursday conflicted with client calls.", createdAt: now, tags: ["meetings"] });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('cand-0', 'a-0', 'b-0', 0.87, ?, 10, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, now).run();
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('cand-1', 'a-1', 'b-1', 0.87, ?, 9, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, now).run();
    // Every capture in this run sees the same near-duplicate target and the
    // same "replace" verdict — both pairs replace into insight-0, one after
    // the other, inside the SAME weekly batch build.
    target = "insight-0"; score = 0.9;
    decision = () => JSON.stringify({ action: "replace", target_id: "insight-0" });
    const ai = env.AI as any;
    const base = ai.run.getMockImplementation();
    ai.run.mockImplementation(async (model: string, opts: any) => {
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (prompt.includes("Memory A:")) {
        if (prompt.includes("price tier")) {
          return sse(pricingInsight(PRICING_INSIGHTS["0"]));
        }
        if (prompt.includes("design review")) {
          return sse(JSON.stringify({ insight: true, shape: "contradiction", text: "チーム全員の設計レビューを毎週木曜日の午後に開く方針から、顧客との通話予定が重なるため、火曜日の午前に変更する判断をしています。", evidence: { a: "every Thursday afternoon", b: "Tuesday mornings because Thursday conflicted with client calls" } }));
        }
      }
      return base(model, opts);
    });
    await runWeeklyInsights(env, ctx);

    const insightRows = sqlite.rows().filter(r => String(r.tags).includes('"auto-insight"'));
    // Both candidates replaced the SAME row: no second insight row was created.
    expect(insightRows).toHaveLength(1);
    expect(insightRows[0].id).toBe("insight-0");

    const edges = (await env.DB.prepare(`SELECT target_id FROM edges WHERE source_id = ? AND type = 'drawn_from' ORDER BY target_id`).bind("insight-0").all()).results as { target_id: string }[];
    // Only the SECOND replace's pair survives — the first replace's edges
    // (a-0/b-0) must not linger alongside it.
    expect(edges.map(e => e.target_id)).toEqual(["a-1", "b-1"]);
  });
});
