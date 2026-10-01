import { afterEach } from "vitest";
import { chatGptResponse, mockChatGptFetch } from "../helpers/chatgpt-provider";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
import { describe, it, expect, vi, beforeEach } from "vitest";
import { compressTag } from "../../src/compression/digest";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import type { Env } from "../../src/env";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function makeDigestAI(digestText = "Work on the API redesign is progressing well with REST chosen over GraphQL.") {
  return {
    run: vi.fn().mockImplementation(async (_model: string, opts: any) => {
      if (_model === "@cf/google/embeddinggemma-300m")
        return { data: [new Array(768).fill(0.1)] };
      if (opts?.stream)
        return makeSseStream(digestText);
      return { response: "3" };
    }),
  } as unknown as Ai;
}

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

function seedEntries(db: D1Mock, tag: string, count: number, overrides: Partial<any> = {}) {
  for (let i = 0; i < count; i++) {
    db.entries.push({
      id: `entry-${i}`,
      content: `Memory about ${tag} number ${i + 1}`,
      tags: JSON.stringify([tag]),
      source: "api",
      created_at: Date.now() - i * 1000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
      ...overrides,
    });
  }
}

describe("compressTag()", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db, { AI: makeDigestAI() });
  });

  // ── Early-return guards ──────────────────────────────────────────────────────

  it("returns early when fewer than 10 compressible entries exist", async () => {
    seedEntries(db, "project-atlas", 9);
    const { ctx } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(result.entriesUsed).toBe(0);
  });

  it("excludes rolled-up entries from the compressible count", async () => {
    seedEntries(db, "project-atlas", 9);
    db.entries.push({
      id: "rolled", content: "old memory", tags: JSON.stringify(["project-atlas", "rolled-up"]),
      source: "api", created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
    const { ctx } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    // 9 compressible + 1 rolled-up = still < 10 compressible → bail
    expect(result.synthesizedId).toBeNull();
  });

  it("excludes high-importance entries (score >= 4) from the compressible count", async () => {
    seedEntries(db, "project-atlas", 9);
    db.entries.push({
      id: "critical", content: "critical memory", tags: JSON.stringify(["project-atlas"]),
      source: "api", created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 4,
    });
    const { ctx } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    // 9 compressible + 1 high-importance (excluded) → bail
    expect(result.synthesizedId).toBeNull();
  });

  it("returns early when a synthesized entry for this tag exists within 24h", async () => {
    seedEntries(db, "project-atlas", 15);
    db.entries.push({
      id: "recent-synth",
      content: "[Synthesized from 15 entries tagged \"project-atlas\"]\n\nExisting digest.",
      tags: JSON.stringify(["synthesized", "project-atlas"]),
      source: "system",
      created_at: Date.now() - 3600000, // 1h ago
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    const { ctx } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("stores a digest entry with clean header (no source_ids)", async () => {
    seedEntries(db, "project-atlas", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    await drain();
    expect(result.synthesizedId).not.toBeNull();
    const digest = db.entries.find(e => e.id === result.synthesizedId);
    expect(digest).toBeDefined();
    expect(digest.content).toContain("[Synthesized from 12 entries tagged \"project-atlas\"]");
    expect(digest.content).not.toContain("source_ids");
  });

  it("digest entry is tagged synthesized and with the target tag", async () => {
    seedEntries(db, "project-atlas", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    await drain();
    const digest = db.entries.find(e => e.id === result.synthesizedId);
    const tags: string[] = JSON.parse(digest.tags);
    expect(tags).toContain("synthesized");
    expect(tags).toContain("project-atlas");
  });

  it("tags all source entries as rolled-up", async () => {
    seedEntries(db, "project-atlas", 12);
    const { ctx, drain } = makeCtx();
    await compressTag("project-atlas", env, ctx);
    await drain();
    const sources = db.entries.filter(e => !JSON.parse(e.tags).includes("synthesized"));
    expect(sources.length).toBe(12);
    sources.forEach(e => {
      expect(JSON.parse(e.tags)).toContain("rolled-up");
    });
  });

  it("appends [Digest: {id}] to each source entry's content", async () => {
    seedEntries(db, "project-atlas", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    await drain();
    const sources = db.entries.filter(e => !JSON.parse(e.tags).includes("synthesized"));
    sources.forEach(e => {
      expect(e.content).toContain(`[Digest: ${result.synthesizedId}]`);
    });
  });

  it("returns entriesUsed equal to the number of source entries", async () => {
    seedEntries(db, "project-atlas", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    await drain();
    expect(result.entriesUsed).toBe(12);
  });

  it("returns the synthesis text", async () => {
    seedEntries(db, "project-atlas", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    await drain();
    expect(result.text).toBe("Work on the API redesign is progressing well with REST chosen over GraphQL.");
  });

  it("does not roll up high-importance entries but still uses them in synthesis", async () => {
    seedEntries(db, "project-atlas", 10);
    db.entries.push({
      id: "critical", content: "critical strategy decision", tags: JSON.stringify(["project-atlas"]),
      source: "api", created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 5,
    });
    const { ctx, drain } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    await drain();
    // Digest succeeds on the 10 compressible entries
    expect(result.synthesizedId).not.toBeNull();
    // High-importance entry is NOT rolled-up
    const critical = db.entries.find(e => e.id === "critical");
    expect(JSON.parse(critical.tags)).not.toContain("rolled-up");
    expect(critical.content).not.toContain("[Digest:");
  });

  // ── Recall- and contradiction-aware protection ───────────────────────────────

  it("protects entries recalled >= 2 times from compression", async () => {
    seedEntries(db, "project-atlas", 12, { recall_count: 5 });
    const { ctx } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    expect(result.synthesizedId).toBeNull();
  });

  it("treats never-recalled entries as eligible", async () => {
    seedEntries(db, "project-atlas", 12, { recall_count: 0 });
    const { ctx, drain } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    await drain();
    expect(result.synthesizedId).not.toBeNull();
    expect(result.entriesUsed).toBe(12);
  });

  it("treats recall_count=1 entries older than 60 days as eligible", async () => {
    seedEntries(db, "project-atlas", 12, { recall_count: 1, created_at: Date.now() - 61 * 86400000 });
    const { ctx, drain } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    await drain();
    expect(result.synthesizedId).not.toBeNull();
    expect(result.entriesUsed).toBe(12);
  });

  it("protects recall_count=1 entries newer than 60 days", async () => {
    seedEntries(db, "project-atlas", 12, { recall_count: 1, created_at: Date.now() - 5 * 86400000 });
    const { ctx } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    expect(result.synthesizedId).toBeNull();
  });

  it("protects contradiction survivors (contradiction_wins > 0) from compression", async () => {
    seedEntries(db, "project-atlas", 12, { contradiction_wins: 1 });
    const { ctx } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    expect(result.synthesizedId).toBeNull();
  });

  it("only rolls up the eligible subset when a tag mixes protected and eligible entries", async () => {
    seedEntries(db, "project-atlas", 11, { recall_count: 0 }); // 11 eligible (ids entry-0..entry-10)
    for (let i = 0; i < 3; i++) {
      db.entries.push({
        id: `hot-${i}`, content: `hot ${i}`, tags: JSON.stringify(["project-atlas"]),
        source: "api", created_at: Date.now(), vector_ids: "[]",
        recall_count: 9, importance_score: 0, contradiction_wins: 0,
      });
    }
    const { ctx, drain } = makeCtx();
    const result = await compressTag("project-atlas", env, ctx);
    await drain();
    expect(result.entriesUsed).toBe(11);
    for (let i = 0; i < 3; i++) {
      const hot = db.entries.find(e => e.id === `hot-${i}`);
      expect(JSON.parse(hot.tags)).not.toContain("rolled-up");
    }
  });

  // ── Reserved namespace protection ────────────────────────────────────────────

  it("refuses to compress a kind:* namespaced tag", async () => {
    seedEntries(db, "kind:semantic", 15, { recall_count: 0 });
    const { ctx } = makeCtx();
    const result = await compressTag("kind:semantic", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("refuses to compress a status:* namespaced tag", async () => {
    seedEntries(db, "status:canonical", 15, { recall_count: 0 });
    const { ctx } = makeCtx();
    const result = await compressTag("status:canonical", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  // The candidate query excludes these, so reaching here means something else called
  // compressTag directly. It matters more than it looks: without the guard a digest gets
  // built for "everything the staleness pass touched", and markSourcesRolledUp then rolls
  // up every one of those sources — taking them out of the running for the real topics
  // they were also tagged with.
  it("refuses to compress a volatility:* namespaced tag", async () => {
    seedEntries(db, "volatility:state", 15, { recall_count: 0 });
    const { ctx } = makeCtx();
    const result = await compressTag("volatility:state", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
    for (const e of db.entries) expect(JSON.parse(e.tags)).not.toContain("rolled-up");
  });

  it("refuses to compress the stale:as-of tag", async () => {
    seedEntries(db, "stale:as-of", 15, { recall_count: 0 });
    const { ctx } = makeCtx();
    const result = await compressTag("stale:as-of", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
    for (const e of db.entries) expect(JSON.parse(e.tags)).not.toContain("rolled-up");
  });

  // Mixed case is the dangerous form, not a curiosity. The source selector below this guard
  // is `tags LIKE '%"<tag>"%'`, and LIKE ignores ASCII case — so `Kind:Semantic` reaching
  // compressTag does not roll up the entries tagged `Kind:Semantic`, it rolls up every
  // entry tagged `kind:semantic`. The guard has to reject it before that query runs.
  it.each(["Kind:Semantic", "Status:Active", "Volatility:State", "Stale:As-Of", "STALE:AS-OF"])(
    "refuses to compress %s regardless of case",
    async (tag) => {
      seedEntries(db, tag.toLowerCase(), 15, { recall_count: 0 });
      const { ctx } = makeCtx();
      const result = await compressTag(tag, env, ctx);
      expect(result.synthesizedId).toBeNull();
      expect(result.entriesUsed).toBe(0);
      expect(env.AI.run).not.toHaveBeenCalled();
      for (const e of db.entries) expect(JSON.parse(e.tags)).not.toContain("rolled-up");
    },
  );

  // ── Marking sources rolled-up (#278, round 2: byte-size fix) ─────────────────
  //
  // All four nightly jobs share one scheduled() invocation and therefore one
  // subrequest budget, and marking sources one statement at a time was ~88% of the
  // whole cron's D1 cost. These pin the batching, and the per-row fallback that
  // keeps a single bad row from rolling back a whole tag's worth of marks.
  //
  // A row's id is no longer a literal bound arg (round 2: the guard moved from full content,
  // bound per source, to one JSON tuple list of (id, updated_at, byte length) shared by the whole
  // batch) — so "which statement is this row's" is a substring match on the JSON blob rather than
  // an exact bound-arg match, which is deliberately looser: it also still finds the id in whatever
  // shape a future guard takes, the same way it did before this round's change.

  /** Counts D1 statements and can reject the packed multi-row mark. */
  function countingDb(db: D1Mock, failPackedMark = false, failRowIds: string[] = []) {
    const calls = { batches: 0, batchedStatements: 0, individualRuns: 0 };
    // Fires once: it stands in for the whole 15-row batch hitting a transient D1 rejection,
    // not every batch call forever — the per-row fallback batches must be free to succeed.
    let armFailBatch = failPackedMark;
    const rowsIn = (args: any[]) => failRowIds.filter(id => args.some(a => typeof a === "string" && a.includes(id)));
    const wrap = (stmt: any, boundIds: string[] = [], sql = ""): any => ({
      sourceSql: () => sql,
      bind: (...args: any[]) => wrap(stmt.bind(...args), rowsIn(args), sql),
      boundIds,
      run: async () => {
        calls.individualRuns++;
        if (boundIds.length) throw new Error(`row ${boundIds[0]} rejected`);
        return stmt.run();
      },
      first: () => stmt.first(),
      all: () => stmt.all(),
      __inner: stmt,
    });
    const DB = {
      prepare: (sql: string) => wrap(db.prepare(sql), [], sql),
      exec: (sql: string) => db.exec(sql),
      batch: (stmts: any[]) => {
        calls.batches++;
        calls.batchedStatements += stmts.length;
        if (armFailBatch && stmts.some(s => /UPDATE entries(?: AS e)? SET.*tags.*rolled-up/s.test(s.sourceSql()))) { armFailBatch = false; throw new Error("batch rejected"); }
        // D1 batches are all-or-nothing: a single bad row anywhere in the batch fails the whole thing.
        const failing = stmts.find((s: any) => s.boundIds?.length);
        if (failing) throw new Error(`row ${failing.boundIds[0]} rejected`);
        return db.batch(stmts.map(s => s.__inner ?? s));
      },
    } as unknown as D1Database;
    return { DB, calls };
  }

  const rolledUp = (db: D1Mock) =>
    db.entries.filter(e => JSON.parse(e.tags ?? "[]").includes("rolled-up")).map(e => e.id).sort();

  it("marks every source in one packed statement and advances updated_at", async () => {
    seedEntries(db, "project-atlas", 15, { recall_count: 0 });
    const { DB, calls } = countingDb(db);
    const { ctx, drain } = makeCtx();

    const result = await compressTag("project-atlas", makeTestEnv(db, { AI: makeDigestAI(), DB }), ctx);
    await drain();

    expect(result.synthesizedId).not.toBeNull();
    // The successful vector write clears its durable cleanup tombstone with one
    // marker+DELETE batch.
    expect(calls.batches).toBe(3);
    // MOVED 17 -> 31 (ADV-3/ADV-9 fix) -> 3 (round 2 byte-size fix): the per-source compare-and-set
    // (workspace and content, so a source that moved or was edited mid-run is skipped rather than
    // corrupted) moved from a per-source statement pair to one JSON tuple list shared by a single
    // snapshot and a single mark — one snapshot + one mark + the one prune, whatever the source
    // count, measured against real workerd D1 at 50 sources of up to 1 MB
    // (digest-rollup-batch-size.workerd.test.ts): 2N+1 statements and ~100 MB in one batch before,
    // 3 statements and a few KB after.
    expect(calls.batchedStatements, JSON.stringify(calls)).toBe(7);
    expect(rolledUp(db)).toHaveLength(15);
    expect(db.entries.filter(e => e.id.startsWith("entry-")).every(e =>
      typeof e.updated_at === "number" && e.updated_at >= e.created_at)).toBe(true);
  });

  it("falls back to per-row writes when the packed statement is rejected", async () => {
    // The packed statement is atomic, so without this fallback one bad row would un-mark every
    // source for the tag — and an unmarked source is compressed again later,
    // turning one duplicate digest into a whole tag's worth.
    seedEntries(db, "project-atlas", 15, { recall_count: 0 });
    const { DB, calls } = countingDb(db, true);
    const { ctx, drain } = makeCtx();

    const result = await compressTag("project-atlas", makeTestEnv(db, { AI: makeDigestAI(), DB }), ctx);
    await drain();

    expect(result.synthesizedId).not.toBeNull();
    // The rejected big batch, plus one small [snapshot, mark, prune] batch per row on the fallback.
    expect(calls.batches).toBe(18);
    expect(rolledUp(db)).toHaveLength(15);
  });

  it("keeps marking the rest when one row fails during the fallback", async () => {
    seedEntries(db, "project-atlas", 15, { recall_count: 0 });
    const { DB } = countingDb(db, true, ["entry-7"]);
    const { ctx, drain } = makeCtx();

    await compressTag("project-atlas", makeTestEnv(db, { AI: makeDigestAI(), DB }), ctx);
    await drain();

    const marked = rolledUp(db);
    expect(marked).toHaveLength(14);
    expect(marked).not.toContain("entry-7");
  });
});

it("ChatGPT打切り応答ではダイジェストも元記憶のrolled-upも保存しない", async () => {
  const db = makeTestDb();
  seedEntries(db, "project-atlas", 12, { recall_count: 1, created_at: Date.now() - 61 * 86400000 });
  for (const row of db.entries) row.workspace_id = "owner-personal";
  const before = structuredClone(db.entries);
  const fetch = mockChatGptFetch(vi.fn().mockImplementation(async () => chatGptResponse("partial digest", "length")));
  const env = makeTestEnv(db, {
    CHATGPT_OPERATIONS: "digest", CHATGPT_OWNER_WORKSPACE_ID: "owner-personal",
  });
  const { ctx, drain } = makeCtx();
  const result = await compressTag("project-atlas", env, ctx, { workspaceIds: ["owner-personal"] });
  await drain();
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.synthesizedId).toBeNull();
  expect(db.entries).toEqual(before);
  expect(env.AI.run).not.toHaveBeenCalled();
});
