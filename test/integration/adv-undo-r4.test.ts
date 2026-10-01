// Round-4 adversary reproductions for revertEntry (T-0089.1.3), against the simplification at dee8bc69.
// Each test asserts the CORRECT behaviour, so each one fails until its finding is fixed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { captureEntry } from "../../src/capture/entry";
import { appendToEntry, updateEntryContent } from "../../src/capture/store";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
import { moveEntry } from "../../src/capture/share";
import { resolveEntryAction } from "../../src/memory/actions";
import { deleteForever } from "../../src/memory/trash";
import { trashNonce } from "../helpers/trash-env";
import { D1_ROW_MAX_BYTES } from "../../src/constants";
import { revertEntry } from "../../src/memory/undo";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
} });

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let store: Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>;

function statefulVectorize(matchId?: string) {
  store = new Map();
  const overrides: Record<string, unknown> = {
    upsert: vi.fn(async (vs: any[]): Promise<any> => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }),
    insert: vi.fn(async (vs: any[]): Promise<any> => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }),
    deleteByIds: vi.fn(async (ids: string[]): Promise<any> => { for (const i of ids) store.delete(i); return { mutationId: "m" }; }),
    getByIds: vi.fn(async (ids: string[]): Promise<any> => ids.map(i => store.get(i)).filter(Boolean)),
  };
  if (matchId) overrides.query = vi.fn().mockResolvedValue({ matches: [{ id: matchId, score: 0.93, metadata: { parentId: matchId } }] });
  return makeVectorizeMock(overrides as any);
}
const decisionAI = (decision: string) =>
  ({ run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m" ? { data: [new Array(768).fill(0.1)] } : stream(decision)) }) as any;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(), AI: makeAIMock() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_label, when_source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "text", JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, over.updatedAt ?? null,
  JSON.stringify(over.vectorIds ?? [id]), over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
  over.whenAt ?? null, over.whenKind ?? null, over.whenLabel ?? null, over.whenSource ?? null,
).run();
const row = (id: string) => sqlite.rows().find((r: any) => r.id === id) as any;
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const change = (who: Identity = owner, channel: "rest" | "mcp" = "rest") => ({ actorId: who.userId, channel });
const member = async (name: string) => (await resolveIdentityByUserId(env, (await createMember(env, { name })).member.userId))!;

/** Runs `race` once, just before the revert's own [snapshot, UPDATE, prune] batch reaches the database. */
function beforeRevertBatch(base: Env, race: () => Promise<void>): Env {
  const raw = base.DB as any;
  let fired = false;
  const db = {
    ...raw,
    prepare: (sql: string) => raw.prepare(sql),
    batch: async (stmts: any[]) => {
      const isRevert = stmts.some(s => typeof s.sourceSql === "function" && s.sourceSql().includes("json_extract(ov.meta, '$.nonce')"));
      if (isRevert && !fired) { fired = true; await race(); }
      return raw.batch(stmts);
    },
  };
  return { ...base, WRITE_ADMISSION_TOKEN: base.WRITE_ADMISSION_TOKEN, DB: db } as unknown as Env;
}



/** A merge decider whose merged text is the target's current text plus the incoming capture, like a real merge. */
function mergingEnv(target: string) {
  const ai = { run: vi.fn(async (model: string, input: any) => {
    if (model === "@cf/google/embeddinggemma-300m") return { data: (Array.isArray(input?.text) ? input.text : [input?.text]).map(() => new Array(768).fill(0.1)) };
    if (!String(input?.messages?.[0]?.content ?? "").includes("Choose exactly one action")) return stream("3");
    return stream(JSON.stringify({ action: "merge", target_id: target, merged_content: `${currentContent(target)} ${pending.shift() ?? ""}` }));
  }) } as any;
  return sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as any, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(target), AI: ai })) as Env;
}
const pending: string[] = [];
const currentContent = (id: string) => row(id)?.content ?? "";
const capture = (e: Env, text: string, ws = owner.personalWorkspaceId, actor = owner.userId) => {
  pending.push(text);
  return captureEntry(text, [], "api", e, ctx, undefined, { workspaceId: ws, actorId: actor }, undefined, { channel: "rest" });
};
const live = (content: string) => sqlite.rows().filter((r: any) => r.content === content);

/** Counts every D1 execution, batches as one. */
function counting(base: Env) {
  const raw = base.DB as any;
  const executed: string[] = [];
  const wrap = (s: any, sql: string): any => ({
    ...s, sourceSql: () => sql, raw: () => s,
    bind: (...a: unknown[]) => wrap(s.bind(...a), sql),
    run: () => { executed.push(sql); return s.run(); },
    first: (c?: string) => { executed.push(sql); return s.first(c); },
    all: () => { executed.push(sql); return s.all(); },
  });
  const db = { ...raw, prepare: (sql: string) => wrap(raw.prepare(sql), sql), batch: (stmts: any[]) => { executed.push(`BATCH(${stmts.length})`); return raw.batch(stmts.map((s: any) => s.raw())); } };
  return { env: { ...base, WRITE_ADMISSION_TOKEN: base.WRITE_ADMISSION_TOKEN, DB: db } as unknown as Env, executed };
}


// T-0089.1.3 round 4: the re-creation insert used to run in its own batch after the revert batch had
// already committed, so a failure there was silent and the revert's own meta already recorded the id
// as re-created, blocking every future rollback from trying again. Fixed by folding the insert into
// the revert's own batch, guarded by the same "this request's own snapshot landed" condition as the
// UPDATE, so the row and its record commit together or not at all. There is no longer a separate,
// all-INSERT batch to fail on its own — this asserts that structurally, and that the row still lands.
describe("ADV-U18 (MINOR): the re-creation insert can no longer fail separately from the revert it belongs to", () => {
  it("the incoming row's insert lands in the same batch as the revert, not a separate one that can fail alone", async () => {
    const e = mergingEnv("old");
    await seed("old", { content: "Old text", tags: ["work"] });
    await capture(e, "Incoming fact");
    const raw = e.DB as any;
    let sawSeparateInsertBatch = false;
    const watched = { ...e, DB: { ...raw, prepare: (sql: string) => raw.prepare(sql), batch: async (stmts: any[]) => {
      if (stmts.length && stmts.every(s => s.sourceSql?.().startsWith("INSERT INTO entries (id, content"))) sawSeparateInsertBatch = true;
      return raw.batch(stmts);
    } } } as unknown as Env;
    const r = await revertEntry(watched, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect((r as any).recreatedIncomingId).toBeDefined();
    expect(sawSeparateInsertBatch).toBe(false);
    expect(live("Incoming fact")).toHaveLength(1);
  });
});

describe("ADV-U19 (MINOR): the oversize fallback drops the record, so 'at most once' no longer holds", () => {
  it("rolling back past a merge twice on a ~1.85 MB row leaves one copy of the incoming fact", async () => {
    const e = mergingEnv("big");
    const incoming = "i".repeat(900_000), merged = "Old text " + incoming;
    // 過去の大容量brainをseedし、現行入力の12,000文字上限を迂回した公開経路は作らない。
    await seed("big", { content: merged + "g".repeat(950_000), tags: ["work", "quarantine:too_long", "status:draft"] });
    await env.DB.prepare(`INSERT INTO entry_versions (entry_id, workspace_id, seq, content, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
      VALUES ('big', ?, 1, 'Old text', '["work"]', '{}', ?, 'rest', 'merge', ?, 1000, 2000)`)
      .bind(owner.personalWorkspaceId, owner.userId, JSON.stringify({ incoming, incomingTags: [], incomingSource: "api" })).run();
    await env.DB.prepare(`INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
      VALUES ('big', ?, 2, NULL, ?, '["work"]', '{}', ?, 'rest', 'append', '{}', 2000, 3000)`)
      .bind(owner.personalWorkspaceId, merged.length, owner.userId).run();
    const mergeSeq = 1;
    // First rollback: the version row needs a full 1.85 MB copy, so recreated_incoming is dropped.
    // The row is currently held (too_long, from the append above) and the merge-time target
    // was not, so per 5.6 this rollback is a release, not a plain revert (class D, T-0089.4.2).
    expect((await revertEntry(e, owner, "big", change(), DEFAULTS, mergeSeq, owner.personalWorkspaceId)).status).toBe("released");
    expect(live(incoming)).toHaveLength(1);
    // Undo the rollback, then roll back to the merge again.
    expect((await revertEntry(e, owner, "big", change(), DEFAULTS, undefined, owner.personalWorkspaceId)).status).toBe("reverted");
    expect((await revertEntry(e, owner, "big", change(), DEFAULTS, mergeSeq, owner.personalWorkspaceId)).status).toBe("released");
    expect(live(incoming)).toHaveLength(1); // actual: 2
  }, 120_000);
});

describe("ADV-U20 (MINOR): keptIncoming says a row is kept after it has been deleted forever", () => {
  it("redo does not report a deleted row as 'kept as its own memory'", async () => {
    const e = mergingEnv("old");
    await seed("old", { content: "Old text", tags: ["work"] });
    await capture(e, "Incoming fact");
    const x = ((await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId)) as any).recreatedIncomingId as string;
    await forgetEntry(x, e, change(), { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    expect((await deleteForever(e, x, change(), owner.personalWorkspaceId, await trashNonce(e, x))).status).toBe("deleted");
    const redo = await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(row(x)).toBeUndefined();
    // Task 15 will turn this into user-facing text; it must not claim a memory exists that does not.
    const claim = ((redo as any).keptIncoming ?? []).find((k: any) => k.id === x);
    expect(claim?.reason).toBe("re-created earlier");
  });
});
