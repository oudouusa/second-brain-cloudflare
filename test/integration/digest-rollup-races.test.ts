/**
 * Adversary reproductions ADV-3 and ADV-9 (range bb5377f..5c25183, ported from adv/t1-versions@258a932
 * test/integration/adv-t1-versions.test.ts). markSourcesRolledUp's mark is a compare-and-set on
 * workspace and content (the row and text the digest actually summarised); a source that moved
 * workspace or was edited mid-synthesis is skipped, not corrupted or phantom-versioned.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { compressTag } from "../../src/compression/digest";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
afterEach(() => sqlite?.close());

const seed = (id: string, over: Record<string, unknown> = {}, workspaceId: string, actorId: string) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "Some fact", JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, over.updatedAt ?? null,
  JSON.stringify(over.vectorIds ?? [id]), workspaceId, actorId,
).run();

async function makeDigestEnv() {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() })) as Env;
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  return { env, roots };
}

function mockAi() {
  return {
    run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m" ? { data: [new Array(768).fill(0.1)] }
      : new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":"Synthesized text"}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
      } })),
  } as any;
}

const live = async (env: Env, id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (env: Env, id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;

describe("ADV-3: digest rollup writes no version for a source it did not change", () => {
  it("a source moved out of the digest's workspace mid-run gets no rollup version", async () => {
    const { env, roots } = await makeDigestEnv();
    const digestEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), AI: mockAi() })) as Env;
    for (let i = 0; i < 12; i++) {
      await seed(`s${i}`, { content: `Work memory number ${i} with enough detail to be eligible`, tags: ["rocket-project"], createdAt: 1000 + i }, roots.ownerPersonalWorkspaceId, roots.ownerUserId);
    }
    const db = digestEnv.DB as any;
    const prepare = db.prepare.bind(db);
    let moved = false;
    db.prepare = (sql: string) => {
      // The author shares s0 to the company workspace after the digest read its sources.
      if (!moved && /UPDATE entries SET tags = json_insert/.test(sql)) {
        moved = false; // only trip once, right before the FIRST mark statement fires
        moved = true;
        prepare(`UPDATE entries SET workspace_id = ? WHERE id = 's0'`).bind(roots.companyWorkspaceId).run();
      }
      return prepare(sql);
    };
    await compressTag("rocket-project", digestEnv, ctx);
    const s0 = await live(env, "s0");
    expect(s0.content).not.toContain("[Digest:"); // the mark missed, correctly: it moved before the mark ran
    expect(await versions(env, "s0")).toEqual([]); // no phantom rollup version stamped with the wrong workspace
  });
});

describe("ADV-9: a rollup does not mark text the digest never saw", () => {
  it("the user's new text is not marked rolled-up by a digest that summarised the old text", async () => {
    const { env, roots } = await makeDigestEnv();
    const digestEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), AI: mockAi() })) as Env;
    for (let i = 0; i < 12; i++) {
      await seed(`s${i}`, { content: `Work memory number ${i} with enough detail to be eligible`, tags: ["rocket-project"], createdAt: 1000 + i }, roots.ownerPersonalWorkspaceId, roots.ownerUserId);
    }
    const db = digestEnv.DB as any;
    const prepare = db.prepare.bind(db);
    let edited = false;
    db.prepare = (sql: string) => {
      if (!edited && /UPDATE entries SET tags = json_insert/.test(sql)) {
        edited = true;
        prepare(`UPDATE entries SET content = 'Corrected: the launch moved to October', updated_at = 5000 WHERE id = 's0'`).run();
      }
      return prepare(sql);
    };
    await compressTag("rocket-project", digestEnv, ctx);
    const s0 = await live(env, "s0");
    expect(s0.content.startsWith("Corrected: the launch moved to October")).toBe(true);
    expect(JSON.parse(s0.tags)).not.toContain("rolled-up");
    expect(await versions(env, "s0")).toEqual([]); // no rollup version for text the digest never saw
  });
});

describe("round 2: the rollup mark bumps updated_at like every other content writer", () => {
  it("a marked source's updated_at moves off NULL, so its rowVersion (COALESCE(updated_at, created_at)) tracks the write", async () => {
    const { env, roots } = await makeDigestEnv();
    const digestEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), AI: mockAi() })) as Env;
    for (let i = 0; i < 12; i++) {
      await seed(`s${i}`, { content: `Work memory number ${i} with enough detail to be eligible`, tags: ["rocket-project"], createdAt: 1000 + i }, roots.ownerPersonalWorkspaceId, roots.ownerUserId);
    }
    const before = await live(env, "s0");
    expect(before.updated_at).toBeNull(); // never edited: the exact state the guard's rowVersion falls back to created_at for

    await compressTag("rocket-project", digestEnv, ctx);

    const after = await live(env, "s0");
    expect(JSON.parse(after.tags)).toContain("rolled-up");
    // The mark itself is a content write (appends the digest note): it must bump updated_at like
    // every other content writer, or a later reader's rowVersion (this guard's own compare-and-set,
    // and any future one built the same way) keeps reading the pre-mark value forever.
    expect(after.updated_at).not.toBeNull();
    expect(after.updated_at).toBeGreaterThan(before.created_at);
  });
});
