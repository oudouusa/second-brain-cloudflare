/**
 * Track 2 Task A1 (T-0089.2.1): the validity columns, validity in version state, and undo.
 * Real SQLite through the D1 double; spec 14-t2-time-spec.md 5.1 and 5.2.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { forgetEntry } from "../../src/capture/lifecycle";
import { getTrashedEntry, restoreEntry } from "../../src/memory/trash";
import { revertEntry } from "../../src/memory/undo";
import { buildCasGuard, Params, pruneStatement, snapshotStatement } from "../../src/memory/versions";
import { DEFAULTS } from "../../src/config";
import { memoryWriteMarker } from "../../src/migration/write-lock";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let ws: string;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
  ws = owner.personalWorkspaceId;
});
afterEach(() => sqlite.close());

const seed = (id: string, over: { validFrom?: number | null; validUntil?: number | null; createdAt?: number; tags?: string[] } = {}) =>
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, valid_from, valid_until)
     VALUES (?, 'text', ?, 'api', ?, '[]', ?, ?, ?, ?)`,
  ).bind(id, JSON.stringify(over.tags ?? []), over.createdAt ?? 1000, ws, owner.userId, over.validFrom ?? null, over.validUntil ?? null).run();
const row = async (id: string) => (await env.DB.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const change = { actorId: "u1", channel: "rest" as const };

/** A validity-only writer shaped like Track 2's: [snapshot, UPDATE, prune], tags untouched. */
async function setValidity(id: string, next: { valid_from?: number | null; valid_until?: number | null }, now = 5000) {
  const cols = Object.keys(next) as ("valid_from" | "valid_until")[];
  const p = new Params();
  const sets = cols.map(c => `${c} = ${p.add(next[c] ?? null)}`).join(", ");
  return env.DB.batch([
    snapshotStatement(env, { entryId: id, reason: "validity", change, content: { kind: "unchanged" }, nextTags: "unchanged", nextState: next, meta: { cause: "explicit" }, now }),
    env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, ${sets} WHERE e.id = ${p.add(id)}`).bind(...p.values()),
    pruneStatement(env, id, 20),
  ]);
}

describe("validity columns", () => {
  it("init adds valid_from and valid_until to a brain that lacks them", async () => {
    const cols = ((await env.DB.prepare(`PRAGMA table_info(entries)`).all()).results as any[]).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(["valid_from", "valid_until"]));
  });

  it("init on an existing brain writes no rows", async () => {
    await seed("a");
    sqlite.db.prepare(`SELECT 1`); // warm
    const before = (await env.DB.prepare(`SELECT total_changes() AS n`).first<{ n: number }>())!.n;
    resetDatabaseInit();
    await initializeDatabase(env);
    const after = (await env.DB.prepare(`SELECT total_changes() AS n`).first<{ n: number }>())!.n;
    expect(after - before).toBe(0);
    expect(await row("a")).toMatchObject({ valid_from: null, valid_until: null });
  });

  it("forget then restore round-trips valid_from and valid_until, including NULLs", async () => {
    await seed("closed", { validFrom: 500, validUntil: 900 });
    await seed("open");
    for (const id of ["closed", "open"]) {
      expect((await forgetEntry(id, env, change, { reason: "forget", config: DEFAULTS, purge: false }, ws)).status).toBe("deleted");
      const trashed = await getTrashedEntry(env, owner, id);
      expect((await restoreEntry(env, trashed!, change, DEFAULTS)).status).toBe("restored");
    }
    expect(await row("closed")).toMatchObject({ valid_from: 500, valid_until: 900 });
    expect(await row("open")).toMatchObject({ valid_from: null, valid_until: null });
  });
});

describe("validity in version state", () => {
  it("every snapshot's state records valid_from and valid_until", async () => {
    await seed("a", { validFrom: 500, validUntil: 900 });
    await env.DB.batch([
      snapshotStatement(env, { entryId: "a", reason: "update", change, content: { kind: "next", content: "new" }, nextTags: [], now: 2000 }),
      env.DB.prepare(`UPDATE entries SET content = 'new' WHERE id = 'a'`),
    ]);
    const [v] = await versions("a");
    expect(JSON.parse(v.state)).toMatchObject({ valid_from: 500, valid_until: 900 });
  });

  it("a snapshot of a NULL window records the keys as JSON null", async () => {
    await seed("a");
    await setValidity("a", { valid_until: 3000 });
    const state = JSON.parse((await versions("a"))[0].state);
    expect("valid_from" in state && "valid_until" in state).toBe(true);
    expect(state).toMatchObject({ valid_from: null, valid_until: null });
  });

  it("a validity-only snapshot with nextTags unchanged skips when the state is unchanged, and records when it differs", async () => {
    await seed("a", { validUntil: 3000, tags: ["x"] });
    await setValidity("a", { valid_until: 3000 });
    expect(await versions("a")).toHaveLength(0);
    await setValidity("a", { valid_until: 4000 });
    const vs = await versions("a");
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ reason: "validity", tags: `["x"]` });
    expect(JSON.parse(vs[0].meta)).toEqual({ cause: "explicit" });
  });

  it("a CAS guard on valid_until compares NULL with IS", () => {
    const p = new Params();
    expect(buildCasGuard(p, { valid_until: null })).toBe("e.valid_until IS ?1");
  });
});

describe("undo restores validity", () => {
  it("undo of a validity version restores valid_from and valid_until", async () => {
    await seed("a", { validFrom: 500 });
    await setValidity("a", { valid_from: 700, valid_until: 3000 });
    const r = await revertEntry(env, owner, "a", change, DEFAULTS, undefined, ws);
    expect(r).toMatchObject({ status: "reverted" });
    expect(await row("a")).toMatchObject({ valid_from: 500, valid_until: null });
  });

  it("undo of a pre-Track-2 version with no validity keys leaves the columns untouched", async () => {
    await seed("a", { validUntil: 3000 });
    await sqlite.db.prepare(`UPDATE entries SET content = 'edited' WHERE id = 'a'`).run();
    // A Track 1 version: its state predates the validity keys.
    await sqlite.db.prepare(
      `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, tags, state, actor_id, channel, reason, meta, created_at)
       VALUES ('a', ?, 1, 'text', '[]', '{"when_at":null,"when_kind":null,"when_source":null,"when_label":null}', ?, 'rest', 'update', '{}', 1500)`,
    ).bind(ws, owner.userId).run();
    const r = await revertEntry(env, owner, "a", change, DEFAULTS, 1, ws);
    expect(r).toMatchObject({ status: "reverted" });
    expect(await row("a")).toMatchObject({ content: "text", valid_until: 3000 });
  });

  it("to_version restores validity from state", async () => {
    await seed("a");
    await setValidity("a", { valid_until: 3000 }, 5000);
    await env.DB.batch([
      snapshotStatement(env, { entryId: "a", reason: "update", change, content: { kind: "next", content: "later" }, nextTags: [], now: 6000 }),
      env.DB.prepare(`UPDATE entries SET content = 'later' WHERE id = 'a'`),
    ]);
    const r = await revertEntry(env, owner, "a", change, DEFAULTS, 1, ws);
    expect(r).toMatchObject({ status: "reverted" });
    expect(await row("a")).toMatchObject({ content: "text", valid_until: null });
  });

  it("an ordinary content undo leaves validity alone", async () => {
    await seed("a");
    await env.DB.batch([
      snapshotStatement(env, { entryId: "a", reason: "update", change, content: { kind: "next", content: "later" }, nextTags: [], now: 6000 }),
      env.DB.prepare(`UPDATE entries SET content = 'later' WHERE id = 'a'`),
    ]);
    await sqlite.db.prepare(`UPDATE entries SET valid_until = 7000 WHERE id = 'a'`).run();
    await revertEntry(env, owner, "a", change, DEFAULTS, undefined, ws);
    expect(await row("a")).toMatchObject({ content: "text", valid_until: 7000 });
  });

  it("a validity revert that changes only validity is not a no-op", async () => {
    await seed("a");
    await setValidity("a", { valid_until: 3000 });
    expect((await revertEntry(env, owner, "a", change, DEFAULTS, undefined, ws)).status).toBe("reverted");
    // A redo: the revert's own version recorded valid_until 3000, and undoing it puts it back.
    expect((await revertEntry(env, owner, "a", change, DEFAULTS, undefined, ws)).status).toBe("reverted");
    expect((await row("a")).valid_until).toBe(3000);
  });
});
