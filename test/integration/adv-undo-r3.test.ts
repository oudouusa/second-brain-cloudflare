// Round-3 adversary reproductions for revertEntry (T-0089.1.3), against the fixes at 9109feea.
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

describe("ADV-U13 (MAJOR): undoing a large merge writes a version row D1 cannot store", () => {
  it("the revert's own version row stays under D1's 2,000,000-byte row limit", async () => {
    const e = mergingEnv("big");
    const original = "a".repeat(700_000), incoming = "b".repeat(1_000_000);
    await seed("big", { content: original + " " + incoming, tags: ["work"] });
    await env.DB.prepare(`INSERT INTO entry_versions (entry_id, workspace_id, seq, content, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
      VALUES ('big', ?, 1, ?, '["work"]', '{}', ?, 'rest', 'merge', ?, 1000, 2000)`)
      .bind(owner.personalWorkspaceId, original, owner.userId, JSON.stringify({ incoming, incomingTags: [], incomingSource: "api" })).run();
    const mergeRow = (await versions("big")).at(-1)!;
    expect(JSON.parse(mergeRow.meta).incoming).toHaveLength(1_000_000);

    const r = await revertEntry(e, owner, "big", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    const revertRow = await env.DB.prepare(
      `SELECT COALESCE(length(CAST(content AS BLOB)), 0) + length(CAST(meta AS BLOB)) + length(CAST(tags AS BLOB)) + length(CAST(state AS BLOB)) AS bytes
         FROM entry_versions WHERE entry_id = 'big' AND reason = 'revert'`).first() as any;
    // 再作成本文の重複保存を避け、長い旧履歴でもD1の行上限を守る。
    expect(revertRow.bytes).toBeLessThanOrEqual(D1_ROW_MAX_BYTES);
  }, 120_000);
});

describe("ADV-U14 (MINOR): statements grow with every merge a rollback crosses", () => {
  it("a to_version past 16 merges stays inside the free plan's 50 D1 queries per invocation", async () => {
    const e = mergingEnv("hub");
    await seed("hub", { content: "Hub", tags: ["work"] });
    for (let i = 0; i < 16; i++) expect((await capture(e, `fact ${i}`)).status).toBe("merged");
    const first = (await versions("hub"))[0].seq;
    const { env: counted, executed } = counting(e);
    const r = await revertEntry(counted, owner, "hub", change(), DEFAULTS, first, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(live("fact 15")).toHaveLength(1);
    expect(executed.length).toBeLessThanOrEqual(50);
  });

  it("19件のmergeを戻し、索引生成3件と保護処理を含め35実行", async () => {
    const e = mergingEnv("hub19");
    await seed("hub19", { content: "Hub", tags: ["work"] });
    for (let i = 0; i < 19; i++) expect((await capture(e, `fact ${i}`)).status).toBe("merged");
    const first = (await versions("hub19"))[0].seq;
    const { env: counted, executed } = counting(e);
    const r = await revertEntry(counted, owner, "hub19", change(), DEFAULTS, first, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    for (let i = 0; i < 19; i++) expect(live(`fact ${i}`)).toHaveLength(1);
    // 本文19件を復元し、索引生成は3件まで。残りはpendingへ渡す。
    expect(executed).toHaveLength(35);
    expect(executed.length).toBeLessThanOrEqual(50);
  });
});

describe("ADV-U15 (MINOR): U8's 'unchanged' check ignores tags, status and dates", () => {
  it("redo keeps (or reports) a re-created memory its owner has since marked canonical and tagged", async () => {
    const e = mergingEnv("old");
    await seed("old", { content: "Old text", tags: ["work"] });
    await capture(e, "Incoming fact");
    const x = ((await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId)) as any).recreatedIncomingId as string;
    await applyStatus(x, "canonical", e, change(), DEFAULTS, owner.personalWorkspaceId);
    await resolveEntryAction(e, ctx, owner, x, "snooze", new Date(Date.now() + 86_400_000).toISOString(), change());
    expect(JSON.parse(row(x).tags)).toContain("status:canonical");

    const redo = await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(redo.status).toBe("reverted");
    // The row has two versions of its own now; it is not "what this mechanism left behind".
    const kept = ((redo as any).keptIncoming ?? []) as { id: string }[];
    expect(row(x) !== undefined || kept.some(k => k.id === x)).toBe(true); // actual: trashed silently
  });
});

// T-0089.1.3 round 3 (Director decision): redo no longer removes a re-created row, so it can no
// longer be the thing that puts it in the trash either. This asserts the new semantics: a row the
// USER deliberately removed is never resurrected, and redo still says something about it rather than
// going silent — the old scenario's "or the 14-day purge" comment now applies to a user action, not
// something redo itself did.
describe("ADV-U16 (MINOR, superseded by the round-3 simplification): a user-removed re-created row is never resurrected, and redo still says something", () => {
  it("after the re-created row is deleted forever, redo neither resurrects it nor stays silent", async () => {
    const e = mergingEnv("old");
    await seed("old", { content: "Old text", tags: ["work"] });
    await capture(e, "Incoming fact");
    const x = ((await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId)) as any).recreatedIncomingId as string;
    // The user removes the re-created row for good, deliberately — not through redo, which never
    // touches it at all any more.
    await forgetEntry(x, e, change(), { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    expect((await deleteForever(e, x, change(), owner.personalWorkspaceId, await trashNonce(e, x))).status).toBe("deleted");

    const redo = await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(redo.status).toBe("reverted");
    expect(row("old").content).toBe("Old text Incoming fact");
    // Nothing resurrects x, and the result still names it rather than falling silent about a fact
    // the user can no longer find under that id.
    expect(row(x)).toBeUndefined();
    expect((redo as any).keptIncoming).toEqual([{ id: x, reason: "re-created earlier" }]);
  });
});

describe("ADV-U17 (MINOR): the re-created row's audit event has no channel", () => {
  it("created {cause: undo_merge} carries the undo's channel, like restored and deleted do", async () => {
    const e = mergingEnv("old");
    await seed("old", { content: "Old text", tags: ["work"] });
    await capture(e, "Incoming fact");
    const x = ((await revertEntry(e, owner, "old", change(owner, "mcp"), DEFAULTS, undefined, owner.personalWorkspaceId)) as any).recreatedIncomingId as string;
    const ev = await env.DB.prepare(`SELECT payload FROM entry_events WHERE entry_id = ? AND event = 'created'`).bind(x).first() as any;
    expect(JSON.parse(ev.payload).channel).toBe("mcp"); // actual: undefined
  });
});
