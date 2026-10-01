import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { appendToEntry, EntryGoneError, WriteConflictError } from "../../src/capture/store";
import { DEFAULTS } from "../../src/config";
import { loadHistory } from "../../src/memory/versions";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const change = { actorId: "u1", channel: "rest" as const };

let d1: SqliteD1;
let env: Env;
let wsId = "";
let ownerId = "";
let store: Map<string, any>;
let deleted: string[] = [];
let inserts: string[] = [];
let uploadedOwners: Map<string, string>;

function statefulVectorize() {
  store = new Map();
  uploadedOwners = new Map();
  return makeVectorizeMock({
    insert: vi.fn(async (vs: any[]) => { for (const v of vs) { inserts.push(v.id); uploadedOwners.set(v.id, v.metadata.parentId); if (!store.has(v.id)) store.set(v.id, v); } return { mutationId: "m" } as any; }),
    upsert: vi.fn(async (vs: any[]) => { for (const v of vs) { store.set(v.id, v); uploadedOwners.set(v.id, v.metadata.parentId); } return { mutationId: "m" } as any; }),
    deleteByIds: vi.fn(async (ids: string[]) => { deleted.push(...ids); for (const i of ids) store.delete(i); return { mutationId: "m" } as any; }),
  });
}

beforeEach(async () => {
  resetDatabaseInit();
  deleted = []; inserts = [];
  d1 = makeSqliteD1();
  env = d1.admitEnv(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(), AI: makeAIMock() }));
  await initializeDatabase(env);
  env = d1.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  wsId = roots.ownerPersonalWorkspaceId;
  ownerId = roots.ownerUserId;
});
afterEach(() => d1.close());

const seed = (id: string, content: string, tags: string[] = []) => d1.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'claude', 1000, NULL, '[]', ?, ?)`,
).bind(id, content, JSON.stringify(tags), wsId, ownerId).run();
const live = async (id: string) => (await d1.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (id: string) => (await d1.db.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const append = (e: Env, id: string, addition: string, existing = "") =>
  appendToEntry(e, id, existing, addition, [], "claude", DEFAULTS, undefined, { workspaceId: wsId, actorId: ownerId }, change, undefined, wsId);

/** An env whose reads of the appended row are followed by a concurrent write, `times` times. */
function racingEnv(mutate: () => Promise<void>, times = Infinity): Env {
  let left = times;
  const raw = env.DB as any;
  const DB = {
    ...raw,
    prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!sql.startsWith("SELECT content, tags, source, ")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => { const r = await st.bind(...a).first(); if (left-- > 0) await mutate(); return r; } }) };
    },
    batch: (stmts: unknown[]) => raw.batch(stmts),
  };
  return { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB } as unknown as Env;
}

describe("append concurrency (T-0089.9)", () => {
  it("two concurrent short appends both appear in the live row, in commit order", async () => {
    await seed("e1", "base");
    await Promise.all([append(env, "e1", "first"), append(env, "e1", "second")]);
    const { content } = await live("e1");
    expect(content).toMatch(/^base\n\n\[Update [^\]]+\]: (first|second)\n\n\[Update [^\]]+\]: (second|first)$/);
    expect(content).toContain("first");
    expect(content).toContain("second");
    expect((await versions("e1")).map(v => v.seq)).toEqual([1, 2]);
  });

  it("a short append's version is a suffix delta and reconstructs the prior text", async () => {
    await seed("e1", "base");
    await append(env, "e1", "first");
    const afterFirst = (await live("e1")).content;
    await append(env, "e1", "second");
    const vs = await versions("e1");
    expect(vs.every(v => v.content === null && v.reason === "append")).toBe(true);
    const chain = await loadHistory(env, undefined, { id: "e1", content: (await live("e1")).content }, 10);
    expect(chain.text(1)).toBe("base");
    expect(chain.text(2)).toBe(afterFirst);
  });

  it("a concurrent tag change makes the short append retry and keep both the tag change and the addition", async () => {
    await seed("e1", "base", ["a"]);
    let raced = false;
    const racing = racingEnv(async () => {
      if (raced) return;
      raced = true;
      await d1.db.prepare(`UPDATE entries SET write_marker = '${d1.fixtureMarker()}', tags = '["a","status:canonical"]' WHERE id = 'e1'`).run();
    });
    await append(racing, "e1", "addition");
    const row = await live("e1");
    expect(row.content).toContain("addition");
    expect(JSON.parse(row.tags)).toEqual(expect.arrayContaining(["a", "status:canonical"]));
    // The addition's chunk vector is independent of the row text: inserted once, not per attempt.
    // forkは失った試行のpassageを削除し、再試行の新しいIDを確定する。
    expect(inserts.filter(i => uploadedOwners.get(i) === "e1")).toHaveLength(2);
    expect(deleted).toContain(inserts[0]);
    expect(JSON.parse(row.vector_ids)).toHaveLength(1);
    // The lost attempt wrote no version.
    expect(await versions("e1")).toHaveLength(1);
  });

  it("a short append that misses its tags guard 3 times returns 409 and deletes its chunk vector", async () => {
    await seed("e1", "base", ["t0"]);
    let n = 0;
    const racing = racingEnv(async () => {
      await d1.db.prepare(`UPDATE entries SET write_marker = ?, tags = ? WHERE id = 'e1'`).bind(d1.fixtureMarker(), JSON.stringify([`t${++n}`])).run();
    });
    await expect(append(racing, "e1", "addition")).rejects.toBeInstanceOf(WriteConflictError);
    expect((await live("e1")).content).toBe("base");
    expect(await versions("e1")).toEqual([]);
    expect(deleted.some(id => uploadedOwners.get(id) === "e1")).toBe(true);

    // And through the route: HTTP 409.
    n = 0;
    const res = await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "again" } }), racingEnv(async () => {
      await d1.db.prepare(`UPDATE entries SET write_marker = ?, tags = ? WHERE id = 'e1'`).bind(d1.fixtureMarker(), JSON.stringify([`r${++n}`])).run();
    }), ctx);
    expect(res.status).toBe(409);
  });

  it("two concurrent long-branch appends: one commits, the other retries with the new text and commits; both additions survive; the vectors describe the final text", async () => {
    const base = "x".repeat(1580);
    await seed("e1", base);
    await Promise.all([append(env, "e1", "AAAA-first-addition"), append(env, "e1", "BBBB-second-addition")]);
    const { content } = await live("e1");
    expect(content).toContain("AAAA-first-addition");
    expect(content).toContain("BBBB-second-addition");
    expect(content.startsWith(base)).toBe(true);
    // The vectors under the row's id end up describing the committed text, whoever embedded last.
    const indexed = [...store.values()].map(v => v.metadata.content as string).join("");
    expect(indexed).toContain("AAAA-first-addition");
    expect(indexed).toContain("BBBB-second-addition");
    const vs = await versions("e1");
    expect(vs.map(v => v.seq)).toEqual([1, 2]);
    const chain = await loadHistory(env, undefined, { id: "e1", content }, 10);
    expect(chain.text(1)).toBe(base);
  });

  it("a long append that loses 3 compare-and-set attempts returns 409 and leaves none of its own uploads behind", async () => {
    const base = "y".repeat(1580);
    await seed("e1", base);
    let n = 0;
    const racing = racingEnv(async () => {
      await d1.db.prepare(`UPDATE entries SET write_marker = ?, content = content || ? WHERE id = 'e1'`).bind(d1.fixtureMarker(), `!${++n}`).run();
    });
    await expect(append(racing, "e1", "will-not-land")).rejects.toBeInstanceOf(WriteConflictError);
    const { content } = await live("e1");
    expect(content).not.toContain("will-not-land");
    expect(await versions("e1")).toEqual([]);
    // Per-upload vector ids (T-0089.1.1): each lost attempt deletes its own upload and nothing else.
    const indexed = [...store.values()].map(v => v.metadata.content as string).join("");
    expect(indexed).not.toContain("will-not-land");
    expect((await live("e1")).vector_ids).toBe("[]");
    expect([...store.keys()].filter(k => uploadedOwners.get(k) === "e1")).toEqual([]);
  });

  it("appendToEntry ignores a stale existingContent passed by the caller", async () => {
    await seed("e1", "the real text");
    await append(env, "e1", "more", "a stale copy the caller read earlier");
    const { content } = await live("e1");
    expect(content.startsWith("the real text\n\n[Update")).toBe(true);
    expect(content).not.toContain("stale copy");
  });

  it("an append to a row forgotten meanwhile throws EntryGoneError and deletes its chunk", async () => {
    await seed("e1", "base");
    const racing = racingEnv(async () => { await d1.db.prepare(`UPDATE entries SET write_marker = ? WHERE id = 'e1'`).bind(d1.fixtureMarker("delete")).run(); await d1.db.prepare(`DELETE FROM entries WHERE id = 'e1'`).run(); }, 1);
    // The first read finds the row; the delete lands after it, so the CAS misses and the retry finds nothing.
    await expect(append(racing, "e1", "addition")).rejects.toBeInstanceOf(EntryGoneError);
    expect(deleted.some(id => uploadedOwners.get(id) === "e1")).toBe(true);
  });
});
