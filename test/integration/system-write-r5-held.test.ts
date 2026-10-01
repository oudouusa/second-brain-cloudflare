import { describe, it, expect, vi } from "vitest";
import { compressTag, HELD_DIGESTS_READ_LIMIT } from "../../src/compression/digest";
import { runNightlyCompression } from "../../src/compression/nightly";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const DAY = 86400000;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
}});

describe("held drafts", () => {
  async function world(withSecondTag = false) {
    let now = 400 * DAY;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    resetDatabaseInit();
    const sqlite = makeSqliteD1();
    let n = 0;
    const env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn(async (): Promise<any> => {
        const held = (sqlite.rows() as any[]).filter(r => String(r.tags).includes('"synthesized"'));
        // Each new digest resembles the previous drafts (flagged) and the user row.
        return { matches: [...held.map(r => ({ id: r.id, score: 0.9, metadata: { parentId: r.id } })), { id: "user-row", score: 0.7, metadata: { parentId: "user-row" } }] };
      }) }),
      AI: { run: vi.fn(async (model: string, opts: any) => {
        if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
        const p = String(opts?.messages?.[0]?.content ?? "");
        if (p.includes("Choose exactly one action")) return stream('{"action":"contradiction","conflicting_id":"user-row","reason":"changed"}');
        if (p.includes("checking if a new memory contradicts")) return stream('{"contradicts":true,"conflicting_id":"user-row","reason":"changed"}');
        // Only the digest prompt counts: the classifier and others also reach this branch.
        if (p.includes("write a single cohesive paragraph")) return stream(`Digest of the work memories, run ${++n}.`);
        return stream("3");
      }) } as any,
    })) as Env;
    await initializeDatabase(env);
    sqlite.seed({ id: "user-row", content: "We ship the work plan in May", createdAt: now - 5 * DAY, tags: ["decisions"], source: "api" });
    for (let i = 0; i < 12; i++) sqlite.seed({ id: `w-${i}`, content: `Memory about work number ${i}`, createdAt: now - 200 * DAY + i, tags: ["rocket-project"] });
    if (withSecondTag) for (let i = 0; i < 12; i++) sqlite.seed({ id: `h-${i}`, content: `Memory about home number ${i}`, createdAt: now - 200 * DAY + i, tags: ["home"] });
    const nightly = async () => { const r = await runNightlyCompression(env, ctx); now += 2 * DAY; return r; };
    const cycle = async () => { await compressTag("rocket-project", env, ctx); now += 2 * DAY; };
    const held = () => (sqlite.rows() as any[]).filter(r => String(r.tags).includes('"conflict-held"'));
    return { sqlite, env, cycle, nightly, held, calls: () => n };
  }

  it("H1: five cycles of a digest that keeps contradicting a user row leave one held draft and one LLM call", async () => {
    const { sqlite, cycle, held, calls } = await world();
    for (let i = 0; i < 5; i++) await cycle();
    expect(held()).toHaveLength(1);
    expect(calls()).toBe(1);
    expect((sqlite.rows() as any[]).filter(r => String(r.tags).includes('"rolled-up"'))).toHaveLength(0);
    sqlite.close();
  });

  it.each([
    ["edits the held draft", (sqlite: any, id: string) => sqlite.db.prepare(`UPDATE entries SET tags = json_insert(tags, '$[#]', 'user-edited') WHERE id = ?`).bind(id).run()],
    ["confirms the held draft to canonical", (sqlite: any, id: string) => sqlite.db.prepare(`UPDATE entries SET tags = json_insert(tags, '$[#]', 'status:canonical') WHERE id = ?`).bind(id).run()],
    ["deprecates the held draft", (sqlite: any, id: string) => sqlite.db.prepare(`UPDATE entries SET tags = json_insert(tags, '$[#]', 'status:deprecated') WHERE id = ?`).bind(id).run()],
    ["forgets the held draft", (sqlite: any, id: string) => sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = ?`, id)],
  ])("H2: once the user %s, the next cycle digests normally again", async (_what, release) => {
    const { sqlite, cycle, held, calls } = await world();
    await cycle(); await cycle();
    expect(calls()).toBe(1);
    await release(sqlite, held()[0].id);
    await cycle();
    expect(calls()).toBe(2);
    sqlite.close();
  });

  it("a source shared to another workspace during the digest's model call is not marked rolled up", async () => {
    let now = 400 * DAY;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    resetDatabaseInit();
    const sqlite = makeSqliteD1();
    const env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn(async (): Promise<any> => ({ matches: [] })) }),
      AI: { run: vi.fn(async (model: string, opts: any) => {
        if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
        // The person shares one source to another workspace while the digest is being written.
        sqlite.db.prepare(`UPDATE entries SET workspace_id = 'company-ws' WHERE id = 'w-0'`).run();
        return opts?.stream ? stream("A digest of the work memories.") : { response: "3" };
      }) } as any,
    })) as Env;
    await initializeDatabase(env);
    for (let i = 0; i < 12; i++) sqlite.seed({ id: `w-${i}`, content: `Memory about work number ${i}`, createdAt: now - 200 * DAY + i, tags: ["rocket-project"] });
    await compressTag("rocket-project", env, ctx);
    const rows = sqlite.rows() as any[];
    const moved = rows.find(r => r.id === "w-0");
    expect(rows.filter(r => String(r.tags).includes('"rolled-up"')).length).toBe(11);
    expect(String(moved.tags)).not.toContain("rolled-up");
    expect(String(moved.content)).not.toContain("[Digest:");
    sqlite.close();
  });

  it("still answers on a brain that has not built the held-draft index yet", async () => {
    const { sqlite, cycle, held, calls } = await world();
    sqlite.db.prepare(`DROP INDEX idx_entries_conflict_held`).run();
    await cycle(); await cycle();
    expect(held()).toHaveLength(1);
    expect(calls()).toBe(1);
    sqlite.close();
  });

  it("the nightly run reads the held set ONCE for all its tags (in its candidate batch), and skips the held ones", async () => {
    const { sqlite, env, nightly, held, calls } = await world(true);
    const prepared: string[] = [];
    const db = env.DB as any; const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => { prepared.push(sql); return realPrepare(sql); };
    // Every held-draft read is prepared through env.DB, batched or not; count them there.
    const heldReads = () => prepared.filter(q => q.includes("idx_entries_conflict_held")).length;
    await nightly();
    expect(held()).toHaveLength(2); // work and home each held
    expect(calls()).toBe(2);
    expect(heldReads()).toBe(1);
    await nightly();
    expect(calls()).toBe(2); // both skipped, no new model calls
    expect(held()).toHaveLength(2);
    expect(heldReads()).toBe(2); // one per run, not one per tag
    sqlite.close();
  });

  it("the nightly run digests again for a tag whose held draft the person edited, and only that tag", async () => {
    const { sqlite, nightly, held, calls } = await world(true);
    await nightly();
    const workHeld = held().find(r => String(r.tags).includes('"rocket-project"'))!;
    sqlite.db.prepare(`UPDATE entries SET tags = json_insert(tags, '$[#]', 'user-edited') WHERE id = ?`).bind(workHeld.id).run();
    await nightly();
    expect(calls()).toBe(3); // work digested again, home still held
    sqlite.close();
  });

  it("a held read that comes back full is treated as unknown: the run falls back to exact per-tag checks", async () => {
    const { sqlite, env, nightly, held, calls } = await world(true);
    await nightly();
    expect(held()).toHaveLength(2);
    const prepared: string[] = [];
    const db = env.DB as any;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => { prepared.push(sql); return realPrepare(sql); };
    // The batch's third statement (the held read) returns a full page, as a very large brain's would.
    const realBatch = db.batch.bind(db);
    db.batch = async (stmts: unknown[]) => {
      const out = await realBatch(stmts);
      if (Array.isArray(out) && out.length === 3) out[2] = { ...out[2], results: Array.from({ length: HELD_DIGESTS_READ_LIMIT }, () => ({ workspace_id: "", tags: "[]" })) };
      return out;
    };
    await nightly();
    // Per-tag checks ran (the per-tag form has a LIMIT 1 and a tag pattern), and both holds still skip the digest.
    expect(prepared.filter(q => q.includes("idx_entries_conflict_held") && q.includes("LIMIT 1")).length).toBe(2);
    expect(calls()).toBe(2);
    sqlite.close();
  });
});