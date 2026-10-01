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
      // R20's batchEmbeds sends every chunk in one call: answer with one vector per requested text.
      if (model === "@cf/google/embeddinggemma-300m") {
        const texts = Array.isArray(opts?.text) ? opts.text : [opts?.text];
        return { data: texts.map(() => new Array(768).fill(0.1)) };
      }
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

  function seedPair() {
    sqlite.seed({ id: "a-0", content: "Decision: price tier 0 flat at nine dollars a month for predictable billing.", createdAt: now - 120 * DAY, tags: ["pricing"] });
    sqlite.seed({ id: "b-0", content: "Decision: move tier 0 to usage-based billing instead of flat pricing.", createdAt: now, tags: ["pricing"] });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('cand-0', 'a-0', 'b-0', 0.87, ?, 10, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, now).run();
  }
  function insightAI() {
    const ai = env.AI as any;
    const base = ai.run.getMockImplementation();
    ai.run.mockImplementation(async (model: string, opts: any) => {
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (prompt.includes("Memory A:")) return sse(pricingInsight(PRICING_INSIGHTS["0"]));
      return base(model, opts);
    });
  }

  it("F: a digest replaces an unreviewed auto-insight and rolls its sources up onto a recall-hidden row", async () => {
    sqlite.seed({ id: "ins", content: "You priced work at nine dollars then moved to usage billing.\n\n[Insight: contradiction — drawn from 2 memories]", createdAt: now - 3 * DAY, tags: ["auto-insight"], source: "system" });
    target = "ins"; score = 0.9;
    decision = () => JSON.stringify({ action: "replace", target_id: "ins" });
    await compressTag("rocket-project", env, ctx);
    const rows = sqlite.rows();
    // The digest lands as its own row and the sources roll up onto THAT, not onto the recall-hidden insight.
    const digest = rows.find(x => String(x.tags).includes('"synthesized"'))!;
    expect(digest.id).not.toBe("ins");
    expect(rows.filter(x => String(x.tags).includes('"rolled-up"')).length).toBe(12);
    expect(String(rows.find(x => x.id === "ins")!.tags)).toBe('["auto-insight"]');
    expect(String(rows.find(x => x.id === "ins")!.content)).toContain("nine dollars"); // untouched
    expect(rows.filter(x => String(x.tags).includes('"synthesized"')).length).toBe(1); // new digest row
  });

  it("F2: an insight cannot merge into a digest either", async () => {
    sqlite.seed({ id: "dig", content: "[Synthesized from 12 entries tagged \"rocket-project\"]\n\nA digest", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "system" });
    seedPair();
    target = "dig"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "dig", merged_content: "digest plus model guess" });
    insightAI();
    await runWeeklyInsights(env, ctx);
    expect(String(sqlite.rows().find(x => x.id === "dig")!.content)).toContain("A digest");
    expect(String(sqlite.rows().find(x => x.id === "dig")!.content)).not.toContain("model guess");
  });

  it("H: an insight that replaces an earlier insight drops the old drawn_from edges", async () => {
    sqlite.seed({ id: "ins-old", content: "Old insight text", createdAt: now - 3 * DAY, tags: ["auto-insight"], source: "system" });
    for (const t of ["x-1", "x-2"]) {
      sqlite.seed({ id: t, content: `old source ${t}`, createdAt: now - 9 * DAY, tags: [] });
      await env.DB.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES (?, 'ins-old', ?, 'drawn_from', 1, 'system', '{}', 1, 1)`).bind(`e-${t}`, t).run();
    }
    seedPair();
    target = "ins-old"; score = 0.9;
    decision = () => JSON.stringify({ action: "replace", target_id: "ins-old" });
    insightAI();
    await runWeeklyInsights(env, ctx);
    const edges = (await env.DB.prepare(`SELECT target_id FROM edges WHERE source_id = 'ins-old' AND type = 'drawn_from' ORDER BY target_id`).all()).results as { target_id: string }[];
    expect(edges.map(e => e.target_id)).toEqual(["a-0", "b-0"]);
  });

  it("M: replacing an insight also deletes a drawn_from link the USER made by hand", async () => {
    sqlite.seed({ id: "ins-old", content: "Old insight text", createdAt: now - 3 * DAY, tags: ["auto-insight"], source: "system" });
    sqlite.seed({ id: "mine", content: "my evidence", createdAt: now - 9 * DAY, tags: [] });
    await env.DB.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES ('e-user', 'ins-old', 'mine', 'drawn_from', 1, 'explicit', '{}', 1, 1)`).run();
    seedPair();
    target = "ins-old"; score = 0.9;
    decision = () => JSON.stringify({ action: "replace", target_id: "ins-old" });
    insightAI();
    await runWeeklyInsights(env, ctx);
    const edges = (await env.DB.prepare(`SELECT target_id FROM edges WHERE source_id = 'ins-old'`).all()).results as any[];
    expect(edges.some(e => e.target_id === "mine")).toBe(true); // fails: only a-0, b-0 remain
  });

  it("N: a user edit landing between the merge's read and its UPDATE survives; the system text lands as its own row", async () => {
    sqlite.seed({ id: "old-digest", content: "Older digest", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "system" });
    target = "old-digest"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "old-digest", merged_content: "combined digest text" });
    const upserts: { id: string; metadata: any }[] = [];
    (env.VECTORIZE as any).upsert = async (v: any[]) => { upserts.push(...v); return { mutationId: "m" }; };
    // deleteEntryVectors reads metadata.parentId first (T-0089.1.1): answer from what was upserted.
    (env.VECTORIZE as any).getByIds = async (ids: string[]) => upserts.filter(u => ids.includes(u.id));
    // The person's edit commits after the merge read the row and before its UPDATE runs.
    const db = env.DB as any;
    const realPrepare = db.prepare.bind(db);
    let raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("UPDATE entries AS e SET write_marker = ") && sql.includes(", content = ")) {
        raced = true;
        sqlite.db.prepare(`UPDATE entries SET content = 'MY EDIT', tags = '["synthesized","rocket-project","user-edited"]' WHERE id = 'old-digest'`).run();
      }
      return realPrepare(sql);
    };
    await compressTag("rocket-project", env, ctx);
    expect(raced).toBe(true);
    const rows = sqlite.rows();
    const mine = rows.find(x => x.id === "old-digest")!;
    expect(mine.content).toBe("MY EDIT");
    expect(JSON.parse(String(mine.tags))).toContain("user-edited");
    const others = rows.filter(x => String(x.tags).includes('"synthesized"') && x.id !== "old-digest");
    expect(others).toHaveLength(1);
    expect(String(others[0].content)).not.toContain("MY EDIT");
    // Per-upload vector ids (T-0089.1.1): the lost merge's own upload (the system text) is deleted and
    // never listed by the user's row.
    const mergeUpload = upserts.filter(v => v.metadata?.parentId === "old-digest").map(v => v.id);
    const deletedIds = (env.VECTORIZE.deleteByIds as any).mock?.calls?.flatMap((c: any) => c[0]) ?? [];
    for (const id of mergeUpload) expect(deletedIds).toContain(id);
    expect(JSON.parse(String(mine.vector_ids ?? "[]")).some((id: string) => mergeUpload.includes(id))).toBe(false);
  });

  function statefulVectors() {
    const store = new Map<string, any>();
    const vz = env.VECTORIZE as any;
    vz.upsert = async (v: any[]) => { for (const x of v) store.set(x.id, x.metadata); return { mutationId: "m" }; };
    vz.deleteByIds = async (ids: string[]) => { for (const i of ids) store.delete(i); return { mutationId: "m" }; };
    // deleteEntryVectors reads metadata.parentId first (T-0089.1.1): answer from this store.
    vz.getByIds = async (ids: string[]) => ids.filter(i => store.has(i)).map(i => ({ id: i, values: [], metadata: store.get(i) }));
    return store;
  }
  function raceOnMergeUpdate(action: () => void | Promise<void>) {
    const db = env.DB as any;
    const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
    let ready = false, raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("UPDATE entries AS e SET write_marker = ") && sql.includes(", content = ")) ready = true;
      return prepare(sql);
    };
    db.batch = async (statements: unknown[]) => {
      if (ready && !raced) { raced = true; await action(); }
      return batch(statements);
    };
    return () => raced;
  }
  const LONG = "combined digest text ".repeat(10); // forkの400文字以内のmerge契約

  it("P2: lost merge + restore embed failure leaves the user row indexed by the system text", async () => {
    sqlite.seed({ id: "d", content: "Older digest", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "system", vectorIds: ["d"] });
    const store = statefulVectors(); store.set("d", { content: "Older digest", parentId: "d" });
    target = "d"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "d", merged_content: LONG });
    const ai = env.AI as any; const base = ai.run.getMockImplementation(); let failEmbeds = false;
    ai.run.mockImplementation(async (m: string, o: any) => { if (failEmbeds && m === "@cf/google/embeddinggemma-300m") throw new Error("embed 503"); return base(m, o); });
    raceOnMergeUpdate(() => { sqlite.db.prepare(`UPDATE entries SET content = 'MY EDIT', tags = '["synthesized","rocket-project","user-edited"]' WHERE id = 'd'`).run(); failEmbeds = true; });
    await compressTag("rocket-project", env, ctx);
    // No vector of the lost merge's system text survives under the user's row.
    expect([...store.values()].filter(m => m.parentId === "d").every(m => !String(m.content).includes("combined digest"))).toBe(true);
    // Round 6: the lost merge only deleted its own upload, so the row still lists (and has) its own vector.
    expect(sqlite.rows().find(x => x.id === "d")!.vector_ids).toBe('["d"]');
    expect(store.has("d")).toBe(true);
  });

  it("P3: row forgotten during the merge re-embed leaves the merge's vectors orphaned", async () => {
    sqlite.seed({ id: "d", content: "Older digest", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "system", vectorIds: ["d"] });
    const store = statefulVectors(); store.set("d", { content: "Older digest", parentId: "d" });
    target = "d"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "d", merged_content: LONG });
    const raced = raceOnMergeUpdate(() => { return sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = 'd'`).then(() => { store.delete("d"); }); });
    await compressTag("rocket-project", env, ctx);
    expect(raced()).toBe(true);
    expect([...store.entries()].filter(([, m]) => m.parentId === "d").map(([k]) => k)).toEqual([]); // gets d-chunk-0..2
  });

  it("I: a legacy row (empty actor, ordinary source) a user tagged synthesized is not a system row", async () => {
    sqlite.seed({ id: "legacy", content: "My own note that I tagged synthesized", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "api" });
    target = "legacy"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "legacy", merged_content: "combined digest text" });
    await compressTag("rocket-project", env, ctx);
    expect(String(sqlite.rows().find(x => x.id === "legacy")!.content)).toBe("My own note that I tagged synthesized");
  });

  it("J: appending to a digest also marks it user-edited, so the next digest leaves it alone", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    sqlite.seed({ id: "old-digest", content: "Older digest", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "system" });
    await appendToEntry(env, "old-digest", "Older digest", "my addendum", ["synthesized", "rocket-project"], "system", undefined, undefined, { workspaceId: "", actorId: "u1" }, { actorId: "u1", channel: "rest" }, undefined, "");
    expect(JSON.parse(String(sqlite.rows().find(x => x.id === "old-digest")!.tags))).toContain("user-edited");
    target = "old-digest"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "old-digest", merged_content: "combined digest text" });
    await compressTag("rocket-project", env, ctx);
    expect(String(sqlite.rows().find(x => x.id === "old-digest")!.content)).toContain("my addendum");
  });

  it("K: a user capture that merges into a digest marks it user-edited", async () => {
    const { captureEntry } = await import("../../src/capture/entry");
    sqlite.seed({ id: "old-digest", content: "Older digest", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "system" });
    target = "old-digest"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "old-digest", merged_content: "digest with my fact" });
    const r = await captureEntry("my fact", [], "api", env, ctx, undefined, { workspaceId: "", actorId: "u1" });
    expect(r.status).toBe("merged");
    expect(JSON.parse(String(sqlite.rows().find(x => x.id === "old-digest")!.tags))).toContain("user-edited");
  });

  it("L: user-edited is a reserved bookkeeping tag, never a digest topic", async () => {
    const { isWorkerOwnedTag } = await import("../../src/tags/system");
    const { isTopicTag } = await import("../../src/compression/eligibility");
    expect(isWorkerOwnedTag("user-edited")).toBe(true);
    expect(isTopicTag("user-edited")).toBe(false);
  });

  it("G: an owner-edited digest is no longer a system row, so the next digest leaves the edit alone", async () => {
    const { updateEntryContent } = await import("../../src/capture/store");
    sqlite.seed({ id: "old-digest", content: "Older digest", createdAt: now - 3 * DAY, tags: ["synthesized", "rocket-project"], source: "system" });
    await updateEntryContent(env, "old-digest", "MY OWN CORRECTION: the launch is in March, not May", undefined, undefined, undefined, { workspaceId: "", actorId: "owner" }, { actorId: "owner", channel: "rest" }, "");
    target = "old-digest"; score = 0.9;
    decision = () => JSON.stringify({ action: "merge", target_id: "old-digest", merged_content: "combined digest text" });
    await compressTag("rocket-project", env, ctx);
    expect(String(sqlite.rows().find(x => x.id === "old-digest")!.content)).toContain("MY OWN CORRECTION"); // the digest text does not replace it
  });
});
