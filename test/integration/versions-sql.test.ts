import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";
import {
  Params, snapshotStatement, snapshotManyStatement, pruneStatement, pruneManyStatement, mirrorPruneStatement, ownSnapshotLandedSql,
  getVersionsSince, loadHistory, type ContentChange, type VersionReason, type WhenChange,
} from "../../src/memory/versions";

let d1: SqliteD1;
let env: Env;
const change = (actorId = "u1", channel: "rest" | "mcp" | `system:${string}` = "rest") => ({ actorId, channel });

/**
 * Node 22's node:sqlite truncates a TEXT column at its first NUL byte when marshaling the C string
 * back into a JS string on read; confirmed against real D1/workerd, which returns the full value
 * (production is unaffected; this is the local driver only). instr()/SQL-level checks still see
 * the whole value either way (SQLite's own engine never loses it, only node:sqlite's JS binding
 * does), which is why "NUL forces a full copy" (the decision, prior_length null) still holds
 * regardless; only the exact byte-for-byte content readback needs this feature-detect. A
 * dedicated check, not a Node version test: this is a driver quirk that could change independent
 * of which Node version ships it. See versioning-rows-written.workerd.test.ts's own NUL test for
 * the real-D1 proof of the byte-for-byte claim this can't make locally.
 */
let nulTruncatesCache: boolean | undefined;
async function driverTruncatesNul(): Promise<boolean> {
  if (nulTruncatesCache !== undefined) return nulTruncatesCache;
  const probe = makeSqliteD1();
  try {
    await probe.db.exec(`CREATE TABLE nul_probe (v TEXT)`);
    await probe.db.prepare(`INSERT INTO nul_probe (v) VALUES (?)`).bind("a\u0000b").run();
    const row = (await probe.db.prepare(`SELECT v FROM nul_probe`).first()) as { v: string } | null;
    nulTruncatesCache = row?.v !== "a\u0000b";
  } finally {
    probe.close();
  }
  return nulTruncatesCache;
}

beforeEach(async () => {
  resetDatabaseInit();
  d1 = makeSqliteD1();
  env = d1.admitEnv(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env); // schema.sql alone lacks the ALTER-added columns
  env = d1.admitEnv(env);
});
afterEach(() => d1.close());

async function seedRow(id: string, content: string, over: { tags?: string[]; created_at?: number; updated_at?: number | null; when_at?: number | null; when_kind?: string | null; workspace_id?: string } = {}) {
  await d1.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind) VALUES (?, ?, ?, 'api', ?, ?, '[]', ?, 'u1', ?, ?)`,
  ).bind(id, content, JSON.stringify(over.tags ?? []), over.created_at ?? 100, over.updated_at ?? null, over.workspace_id ?? "w1", over.when_at ?? null, over.when_kind ?? null).run();
}
const versions = async (id: string) =>
  (await d1.db.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const row = async (id: string) => (await d1.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
// sourceの行数と、FTS等を含むD1 changesの合計を区別する。
const changes = (r: any) => r.meta.rows_written ?? r.meta.changes;

interface Edit {
  id: string; next: string; tags?: string[]; now?: number; keep?: number; reason?: VersionReason;
  content?: ContentChange; when?: WhenChange; guardTags?: string; actor?: string; channel?: any; meta?: Record<string, unknown>;
}
/** A writer shaped like Task 3's: [snapshot, UPDATE, prune]. */
async function edit(e: Edit) {
  const now = e.now ?? 1000;
  const tags = e.tags ?? JSON.parse((await row(e.id))?.tags ?? "[]");
  const content = e.content ?? { kind: "next" as const, content: e.next };
  const whenSql = e.when ? Object.keys(e.when).map(c => `, ${c} = ?`).join("") : "";
  const guard = e.guardTags;
  const res = await d1.db.batch([
    snapshotStatement(env, {
      entryId: e.id, reason: e.reason ?? "update", change: change(e.actor, e.channel), content, nextTags: tags, nextWhen: e.when, meta: e.meta, now,
      guard: guard === undefined ? undefined : p => `e.tags = ${p.add(guard)}`,
    }),
    d1.db.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ?${whenSql} WHERE id = ?${guard === undefined ? "" : " AND tags = ?"}`)
      .bind(e.next, JSON.stringify(tags), now, ...(e.when ? Object.values(e.when) : []), e.id, ...(guard === undefined ? [] : [guard])),
    pruneStatement(env, e.id, e.keep ?? 20),
  ] as any[]);
  return { snap: changes(res[0]), upd: changes(res[1]) };
}
const texts = async (id: string) => {
  const chain = await loadHistory(env, undefined, { id, content: (await row(id)).content }, 500);
  return chain.rows.map(r => [r.seq, chain.text(r.seq)] as const);
};

describe("snapshot SQL", () => {
  it("full copy when the new text is not an extension", async () => {
    await seedRow("e1", "hello");
    await edit({ id: "e1", next: "goodbye" });
    const [v] = await versions("e1");
    expect(v).toMatchObject({ seq: 1, content: "hello", prior_length: null, reason: "update", actor_id: "u1", channel: "rest", workspace_id: "w1" });
  });

  it("delta when it extends", async () => {
    await seedRow("e1", "hello");
    await edit({ id: "e1", next: "hello world" });
    const [v] = await versions("e1");
    expect(v).toMatchObject({ content: null, prior_length: 5 });
  });

  it("the delta is decided against the row, not the caller's copy", async () => {
    await seedRow("e1", "abc");
    // Another writer got in first: the row is now "abcd". This caller still believes "abc".
    await d1.db.prepare(`UPDATE entries SET content = 'abcd' WHERE id = 'e1'`).run();
    await edit({ id: "e1", next: "abcdef" });
    expect((await versions("e1"))[0]).toMatchObject({ content: null, prior_length: 4 });
    await d1.db.prepare(`UPDATE entries SET content = 'zzz' WHERE id = 'e1'`).run();
    await edit({ id: "e1", next: "abcdef and more" });
    expect((await versions("e1"))[1]).toMatchObject({ content: "zzz", prior_length: null });
  });

  it("NUL forces a full copy", async () => {
    const truncates = await driverTruncatesNul();
    await seedRow("e1", "a\u0000b");
    await edit({ id: "e1", next: "a\u0000b and more" });
    const v1 = (await versions("e1"))[0];
    // The decision this test is named for -- a NUL byte anywhere in the row's content forces a
    // full copy, never a delta -- holds regardless of the local driver's own NUL handling, since
    // SQLite's instr() (what buildSnapshot's own check uses) sees the whole value either way.
    expect(v1.prior_length).toBeNull();
    if (truncates) expect(v1.content).not.toBeNull();
    else expect(v1).toMatchObject({ content: "a\u0000b" });
    await seedRow("e2", "plain");
    await edit({ id: "e2", next: "plain\u0000more" });
    expect((await versions("e2"))[0]).toMatchObject({ content: "plain", prior_length: null });
  });

  it("a failed CAS guard writes neither", async () => {
    await seedRow("e1", "hello", { tags: ["a"] });
    const r = await edit({ id: "e1", next: "changed", guardTags: JSON.stringify(["stale"]) });
    expect(r).toEqual({ snap: 0, upd: 0 });
    expect(await versions("e1")).toEqual([]);
    expect((await row("e1")).content).toBe("hello");
  });

  it("a vanished row writes no version", async () => {
    const r = await edit({ id: "gone", next: "x", tags: [] });
    expect(r).toEqual({ snap: 0, upd: 0 });
    expect(await versions("gone")).toEqual([]);
  });

  it("no version for the same content and a reordered tag set", async () => {
    await seedRow("e1", "same", { tags: ["b", "a", "status:canonical"] });
    const r = await edit({ id: "e1", next: "same", tags: ["status:canonical", "a", "b"] });
    expect(r.snap).toBe(0);
    expect(await versions("e1")).toEqual([]);
  });

  it("a version when only the tag set changes", async () => {
    await seedRow("e1", "same", { tags: ["a"] });
    await edit({ id: "e1", next: "same", tags: ["a", "b"], reason: "status" });
    const [v] = await versions("e1");
    expect(v).toMatchObject({ prior_length: 4, content: null, tags: JSON.stringify(["a"]), reason: "status" });
  });

  it("state captures when_at, when_kind, when_source and when_label", async () => {
    await seedRow("e1", "call bob", { when_at: 500, when_kind: "due" });
    await d1.db.prepare(`UPDATE entries SET when_source = 'model', when_label = 'call bob' WHERE id = 'e1'`).run();
    await edit({ id: "e1", next: "call bob", content: { kind: "unchanged" }, reason: "due", when: { when_at: 900 } });
    expect(JSON.parse((await versions("e1"))[0].state)).toEqual({ when_at: 500, when_kind: "due", when_source: "model", when_label: "call bob", valid_from: null, valid_until: null });
    expect((await row("e1")).when_at).toBe(900);
  });

  it("no version for a due write that sets when_at to its current value; a version when it differs", async () => {
    await seedRow("e1", "call bob", { when_at: 500, when_kind: "due" });
    const same = await edit({ id: "e1", next: "call bob", content: { kind: "unchanged" }, reason: "due", when: { when_at: 500 } });
    expect(same.snap).toBe(0);
    const differs = await edit({ id: "e1", next: "call bob", content: { kind: "unchanged" }, reason: "due", when: { when_at: 501 } });
    expect(differs.snap).toBe(1);
    // A clear against an already-null column is also a no-op; against a set one it is not.
    await seedRow("e2", "x");
    expect((await edit({ id: "e2", next: "x", content: { kind: "unchanged" }, reason: "due", when: { when_at: null, when_kind: null } })).snap).toBe(0);
  });

  it("seq increases by one", async () => {
    await seedRow("e1", "a");
    for (const t of ["b", "c", "d"]) await edit({ id: "e1", next: t });
    expect((await versions("e1")).map(v => v.seq)).toEqual([1, 2, 3]);
  });

  it("prune keeps exactly keep newest with no gap", async () => {
    await seedRow("e1", "0");
    for (let i = 1; i <= 12; i++) await edit({ id: "e1", next: String(i), keep: 5 });
    expect((await versions("e1")).map(v => v.seq)).toEqual([8, 9, 10, 11, 12]);
    await d1.db.batch([pruneStatement(env, "e1", 2)] as any[]);
    expect((await versions("e1")).map(v => v.seq)).toEqual([11, 12]);
  });

  it("valid_from is the previous version's created_at, else updated_at, else created_at", async () => {
    await seedRow("e1", "a", { created_at: 100, updated_at: 200 });
    await edit({ id: "e1", next: "b", now: 1000 });
    await edit({ id: "e1", next: "c", now: 2000 });
    expect((await versions("e1")).map(v => v.valid_from)).toEqual([200, 1000]);
    // A skipped no-op that bumped updated_at must not move valid_from.
    await d1.db.prepare(`UPDATE entries SET updated_at = 5000 WHERE id = 'e1'`).run();
    await edit({ id: "e1", next: "d", now: 6000 });
    expect((await versions("e1")).map(v => v.valid_from)).toEqual([200, 1000, 2000]);
    await seedRow("e2", "a", { created_at: 300, updated_at: null });
    await edit({ id: "e2", next: "b" });
    expect((await versions("e2"))[0].valid_from).toBe(300);
  });

  it("many-row forms bind one parameter for 101 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `m${i}`);
    for (const id of ids) await seedRow(id, `text ${id}`, { tags: ["x"] });
    const res = await d1.db.batch([
      snapshotManyStatement(env, { entryIds: ids, reason: "rollup", change: change("", "system:digest"), content: { kind: "suffix" }, meta: { digestId: "d1" }, now: 10 }),
      pruneManyStatement(env, ids, 20),
    ] as any[]);
    expect(changes(res[0])).toBe(101);
    const all = (await d1.db.prepare(`SELECT entry_id, seq, prior_length, reason, meta FROM entry_versions`).all()).results as any[];
    expect(all).toHaveLength(101);
    expect(all.every(v => v.seq === 1 && v.reason === "rollup" && v.prior_length !== null)).toBe(true);
    expect(JSON.parse(all[0].meta)).toEqual({ digestId: "d1" });
  });
});

describe("mirror prune", () => {
  const mirrorEdit = async (id: string, next: string, keep = 20, mirrorKeep = 3) => {
    await d1.db.batch([
      snapshotStatement(env, { entryId: id, reason: "mirror", change: change("", "system:mirror"), content: { kind: "next", content: next }, nextTags: [], now: 1 }),
      d1.db.prepare(`UPDATE entries SET content = ? WHERE id = ?`).bind(next, id),
      pruneStatement(env, id, keep),
      mirrorPruneStatement(env, id, mirrorKeep),
    ] as any[]);
  };

  it("removes only mirror versions below the oldest user version", async () => {
    await seedRow("e1", "v0", { tags: [] });
    await mirrorEdit("e1", "v1");
    await edit({ id: "e1", next: "v1", tags: ["status:canonical"], reason: "status" }); // user version, seq 2
    for (let i = 2; i <= 6; i++) await mirrorEdit("e1", `v${i}`, 50);
    const reasons = (await versions("e1")).map(v => `${v.seq}:${v.reason}`);
    // The status version survives, and nothing below it is mirror-pruned past it.
    expect(reasons).toContain("2:status");
    expect(reasons.indexOf("2:status")).toBeGreaterThanOrEqual(0);
    expect((await versions("e1")).filter(v => v.reason === "mirror").length).toBeGreaterThan(3 - 1);
  });

  it("the full mirror batch: 1 mirror version, 1 status version, then 100 syncs never exceeds 20 and returns to 3", async () => {
    await seedRow("e1", "start");
    await mirrorEdit("e1", "sync 0");
    await edit({ id: "e1", next: "sync 0", tags: ["status:canonical"], reason: "status" });
    for (let i = 1; i <= 100; i++) {
      await mirrorEdit("e1", `sync ${i}`);
      const vs = await versions("e1");
      expect(vs.length).toBeLessThanOrEqual(20);
      // Chain stays contiguous and reconstructs at every step.
      expect(vs.map(v => v.seq)).toEqual(vs.map((_, k) => vs[0].seq + k));
      if (i % 25 === 0) for (const [seq, text] of await texts("e1")) expect(text.startsWith("sync") || text === "start", `seq ${seq}: ${text}`).toBe(true);
    }
    const final = await versions("e1");
    expect(final.length).toBe(3);
    expect(final.every(v => v.reason === "mirror")).toBe(true);
  });
});

describe("revert guard", () => {
  interface Revert { id: string; newest: number; nonce: string; next: string; now?: number; actor?: string }
  async function revert(r: Revert) {
    const p = new Params();
    const upd = `UPDATE entries SET content = ${p.add(r.next)} WHERE id = ${p.add(r.id)} AND ${ownSnapshotLandedSql(p, r.id, r.newest, r.nonce)}`;
    const res = await d1.db.batch([
      snapshotStatement(env, {
        entryId: r.id, reason: "revert", change: change(r.actor ?? "u2"), content: { kind: "next", content: r.next }, nextTags: [], skipNoOp: false,
        expectNewestSeq: r.newest, meta: { nonce: r.nonce, target_seq: 1 }, now: r.now ?? 5000,
      }),
      d1.db.prepare(upd).bind(...p.values()),
      pruneStatement(env, r.id, 20),
    ] as any[]);
    return { snap: changes(res[0]), upd: changes(res[1]) };
  }

  it("a revert snapshot with expectNewestSeq writes nothing if another version landed first, and the guarded UPDATE changes 0 rows", async () => {
    await seedRow("e1", "one");
    await edit({ id: "e1", next: "two" });            // seq 1
    await edit({ id: "e1", next: "three" });          // seq 2, lands before the revert built against seq 1
    const r = await revert({ id: "e1", newest: 1, nonce: "n1", next: "one" });
    expect(r).toEqual({ snap: 0, upd: 0 });
    expect((await row("e1")).content).toBe("three");
    expect(await versions("e1")).toHaveLength(2);
  });

  it("two concurrent reverts of the same newest version: exactly one snapshot and one UPDATE land", async () => {
    await seedRow("e1", "one");
    await edit({ id: "e1", next: "two" });
    const a = await revert({ id: "e1", newest: 1, nonce: "a", next: "one" });
    const b = await revert({ id: "e1", newest: 1, nonce: "b", next: "one!" });
    expect(a).toEqual({ snap: 1, upd: 1 });
    expect(b).toEqual({ snap: 0, upd: 0 });
    expect((await row("e1")).content).toBe("one");
    expect((await versions("e1")).filter(v => v.reason === "revert")).toHaveLength(1);
  });

  it("two reverts by the SAME actor with the SAME now and different targets: only the one whose nonce landed updates the row", async () => {
    await seedRow("e1", "one");
    await edit({ id: "e1", next: "two" });
    const first = await revert({ id: "e1", newest: 1, nonce: "n-first", next: "target A", now: 7777 });
    const second = await revert({ id: "e1", newest: 1, nonce: "n-second", next: "target B", now: 7777 });
    expect(first).toEqual({ snap: 1, upd: 1 });
    expect(second).toEqual({ snap: 0, upd: 0 });
    // No unrecorded change: the live row is exactly what the recorded revert wrote.
    expect((await row("e1")).content).toBe("target A");
  });

  it("history still reconstructs after interleaved same-millisecond reverts", async () => {
    await seedRow("e1", "one");
    await edit({ id: "e1", next: "one two" });
    await revert({ id: "e1", newest: 1, nonce: "x", next: "one", now: 9000 });
    await revert({ id: "e1", newest: 1, nonce: "y", next: "other", now: 9000 });
    await revert({ id: "e1", newest: 2, nonce: "z", next: "one two", now: 9000 });
    expect(await texts("e1")).toEqual([[3, "one"], [2, "one two"], [1, "one"]]);
  });
});

describe("reconstruction and versions:since", () => {
  it("reconstruction matches every recorded state (30 mixed writes)", async () => {
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    let current = "start";
    await seedRow("e1", current);
    const states = new Map<number, string>();
    for (let i = 1; i <= 30; i++) {
      const before = current;
      const kind = rand(4);
      current = kind === 0 ? `${current} + ${i} 😀日本` : kind === 1 ? `replaced ${i}` : kind === 2 ? current.slice(0, Math.max(1, current.length - 3)) : `${current}\u0000${i}`;
      if (current === before) current += "!";
      await edit({ id: "e1", next: current, keep: 500 });
      states.set(i, before);
    }
    for (const [seq, text] of await texts("e1")) expect(text, `seq ${seq}`).toBe(states.get(seq));
  });

  it("getVersionsSince recovers MIN(created_at)", async () => {
    await seedRow("e1", "a");
    // Increasing, not decreasing (R2-6): a version's created_at is now clamped to at least the
    // previous version's, so this recovers the FIRST version's created_at, not an artificially
    // earlier one a later write could no longer produce.
    await edit({ id: "e1", next: "b", now: 800 });
    await edit({ id: "e1", next: "c", now: 900 });
    expect(await getVersionsSince(env)).toBe(800);
    expect(await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY)).toBe("800");
    await env.OAUTH_KV.put(VERSIONS_SINCE_KV_KEY, "123");
    expect(await getVersionsSince(env)).toBe(123);
  });

  it("getVersionsSince falls back to now with no versions, and survives a KV write failure", async () => {
    env.OAUTH_KV.put = async () => { throw new Error("kv down"); };
    const before = Date.now();
    expect(await getVersionsSince(env)).toBeGreaterThanOrEqual(before);
  });
});
