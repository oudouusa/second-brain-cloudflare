/**
 * Standing invalidation (spec 15 2.6, Track 7 lane D Task 12): every writer that can change a
 * standing memory's eligibility refreshes the cache. Each case writes through the real domain
 * function, awaits its ctx.waitUntil'd rebuild, then reads KV directly — the same contract
 * readStandingCaches relies on, exercised without going through recall itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import { forgetEntry, applyStatus } from "../../src/capture/lifecycle";
import { moveEntry } from "../../src/capture/share";
import { restoreEntry, getTrashedEntry } from "../../src/memory/trash";
import { revertEntry } from "../../src/memory/undo";
import { resolveEntryAction } from "../../src/memory/actions";
import { captureEntry } from "../../src/capture/entry";
import { appendToEntry } from "../../src/capture/store";
import { resetStandingIsolateState, standingKvKey, standingTouched } from "../../src/standing/cache";
import type { StandingCacheV1 } from "../../src/standing/codec";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Identity } from "../../src/lib/identity";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";

function insertEntry(sqlite: SqliteD1, opts: {
  id: string; content?: string; tags?: string[]; workspaceId?: string; actorId?: string; createdAt?: number;
}): void {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
     VALUES (?, ?, ?, 'api', ?, '["v"]', ?, ?)`,
  ).bind(
    opts.id, opts.content ?? "standing content", JSON.stringify(opts.tags ?? ["standing:active"]),
    opts.createdAt ?? 1000, opts.workspaceId ?? "", opts.actorId ?? "",
  ).run();
}

const identity: Identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-a", companyWorkspaceIds: [], defaultShare: "" };

const open: SqliteD1[] = [];
let deferred: Promise<unknown>[];
let ctx: ExecutionContext;

beforeEach(() => {
  resetDatabaseInit();
  resetStandingIsolateState();
  deferred = [];
  ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;
});
afterEach(() => open.splice(0).forEach(s => s.close()));

async function setup() {
  const sqlite = makeSqliteD1();
  open.push(sqlite);
  const kv = makeMemoryKV();
  let env: Env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv }));
  await initializeDatabase(env);
    env = sqlite.admitEnv(env);
  return { env, sqlite, kv };
}

async function cacheAfter(kv: KVNamespace, workspaceId: string): Promise<StandingCacheV1 | null> {
  await Promise.all(deferred);
  return (await kv.get(standingKvKey(workspaceId), "json")) as StandingCacheV1 | null;
}

describe("standing invalidation: every touch writer refreshes the cache", () => {
  it("applyStatus(deprecated) drops a standing row from the next cache build", async () => {
    const { env, sqlite, kv } = await setup();
    insertEntry(sqlite, { id: "s1", workspaceId: "ws-a" });
    const result = await applyStatus("s1", "deprecated", env, { actorId: "u1", channel: "rest" }, DEFAULTS, "ws-a", ctx);
    expect(result.status).toBe("ok");
    const cache = await cacheAfter(kv, "ws-a");
    expect(cache?.items.map(i => i.id)).not.toContain("s1");
  });

  it("forgetEntry drops a standing row from the next cache build", async () => {
    const { env, sqlite, kv } = await setup();
    insertEntry(sqlite, { id: "s1", workspaceId: "ws-a" });
    const result = await forgetEntry("s1", env, { actorId: "u1", channel: "rest" }, { reason: "forget", config: DEFAULTS }, "ws-a", ctx);
    expect(result.status).toBe("deleted");
    const cache = await cacheAfter(kv, "ws-a");
    expect(cache?.items.map(i => i.id)).not.toContain("s1");
  });

  it("undo of a forget (restoreEntry) restores firing after the build", async () => {
    const { env, sqlite, kv } = await setup();
    insertEntry(sqlite, { id: "s1", workspaceId: "ws-a" });
    await forgetEntry("s1", env, { actorId: "u1", channel: "rest" }, { reason: "forget", config: DEFAULTS }, "ws-a", ctx);
    deferred.length = 0;
    const trashed = await getTrashedEntry(env, identity, "s1");
    expect(trashed).not.toBeNull();
    const restored = await restoreEntry(env, trashed!, { actorId: "u1", channel: "rest" }, DEFAULTS, ctx);
    expect(restored.status).toBe("restored");
    const cache = await cacheAfter(kv, "ws-a");
    expect(cache?.items.map(i => i.id)).toContain("s1");
  });

  it("moveEntry touches both the source and the destination workspace", async () => {
    const { env, sqlite, kv } = await setup();
    insertEntry(sqlite, { id: "s1", workspaceId: "ws-a", actorId: "u1" });
    const mover: Identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-a", companyWorkspaceIds: ["ws-b"], defaultShare: "" };
    const result = await moveEntry("s1", "company", env, mover, { actorId: "u1", channel: "rest" }, "ws-b", ctx);
    expect(result.status).toBe("shared");
    const [source, dest] = await Promise.all([cacheAfter(kv, "ws-a"), cacheAfter(kv, "ws-b")]);
    expect(source?.items.map(i => i.id) ?? []).not.toContain("s1");
    expect(dest?.items.map(i => i.id)).toContain("s1");
  });

  it("undo of a Stop (revertEntry) restores firing after the build", async () => {
    const { env, sqlite, kv } = await setup();
    insertEntry(sqlite, { id: "s1", workspaceId: "ws-a", actorId: "u1" });
    const stop = await resolveEntryAction(env, ctx, identity, "s1", "stop_standing", undefined, { actorId: "u1", channel: "rest" });
    expect(stop.ok).toBe(true);
    const stoppedCache = await cacheAfter(kv, "ws-a");
    expect(stoppedCache?.items.map(i => i.id) ?? []).not.toContain("s1");
    deferred.length = 0;

    const reverted = await revertEntry(env, identity, "s1", { actorId: "u1", channel: "rest" }, DEFAULTS, undefined, "ws-a", undefined, ctx);
    expect(reverted.status).toBe("reverted");
    const cache = await cacheAfter(kv, "ws-a");
    expect(cache?.items.map(i => i.id)).toContain("s1");
  });

  it("ordinary writes never touch KV", async () => {
    const { env, sqlite, kv } = await setup();
    insertEntry(sqlite, { id: "ordinary", tags: ["work"], workspaceId: "ws-a" });
    const put = vi.spyOn(kv, "put");
    const result = await applyStatus("ordinary", "deprecated", env, { actorId: "u1", channel: "rest" }, DEFAULTS, "ws-a", ctx);
    expect(result.status).toBe("ok");
    await Promise.all(deferred);
    expect(put).not.toHaveBeenCalled();
  });
});

// Lane W's own files (spec 15 2.6): captureEntry's insert, merge and replace, its contradiction
// supersede-close, and store.ts's appendToEntry — wired once lane W merged (director's follow-up).
describe("standing invalidation: captureEntry and appendToEntry (lane W's files)", () => {
  const stream = (text: string) => new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
    c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
  } });
  const decisionAI = (decision: string) =>
    ({ run: vi.fn(async (model: string) => model === DEFAULTS.EMBEDDING_MODEL ? { data: [new Array(768).fill(0.1)] } : stream(decision)) }) as unknown as Ai;

  it("merge into an already-standing target touches the cache, even when the incoming capture is not itself tagged standing", async () => {
    const { sqlite, kv } = await setup();
    insertEntry(sqlite, { id: "s1", content: "Old text", workspaceId: "" });
    const decision = JSON.stringify({ action: "merge", target_id: "s1", merged_content: "Old text. Incoming fact." });
    let env: Env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "s1", score: 0.9, metadata: { parentId: "s1" } }] }) }),
      AI: decisionAI(decision),
    }));
    await initializeDatabase(env);
    env = sqlite.admitEnv(env);

    const result = await captureEntry("Incoming fact", [], "api", env, ctx, undefined, { workspaceId: "", actorId: "u1" }, undefined, { channel: "rest" });
    expect(result.status).toBe("merged");
    const cache = await cacheAfter(kv, "");
    expect(cache?.items.map(i => i.id)).toContain("s1");
  });

  it("a contradiction that closes a standing row's window touches the cache and drops it", async () => {
    const { sqlite, kv } = await setup();
    insertEntry(sqlite, { id: "old", content: "I live in NYC", workspaceId: "" });
    let env: Env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "old", score: 0.72, metadata: { parentId: "old" } }] }) }),
      AI: decisionAI(JSON.stringify({ contradicts: true, conflicting_id: "old", reason: "different city" })),
    }));
    await initializeDatabase(env);
    env = sqlite.admitEnv(env);
    standingTouched(env, ctx, DEFAULTS, [""]);
    const before = await cacheAfter(kv, "");
    expect(before?.items.map(i => i.id)).toContain("old");
    deferred = [];

    const result = await captureEntry("I moved to LA", [], "api", env, ctx, undefined, { workspaceId: "", actorId: "u1" }, undefined, { channel: "rest" });
    expect(result.status).toBe("contradiction");
    const cache = await cacheAfter(kv, "");
    expect(cache?.items.map(i => i.id)).not.toContain("old");
  });

  it("appendToEntry touches the cache for a standing row", async () => {
    const { env, sqlite, kv } = await setup();
    insertEntry(sqlite, { id: "s1", content: "When reviewing code, prefer small diffs", workspaceId: "ws-a" });
    standingTouched(env, ctx, DEFAULTS, ["ws-a"]);
    await cacheAfter(kv, "ws-a");
    deferred = [];

    const result = await appendToEntry(
      env, "s1", "existing", " and pair review", [], "api", DEFAULTS, undefined,
      { workspaceId: "ws-a", actorId: "u1" }, { actorId: "u1", channel: "rest" }, undefined, "ws-a", ctx,
    );
    expect(result.indexed).toBe(true);
    const cache = await cacheAfter(kv, "ws-a");
    expect(cache?.items.map(i => i.id)).toContain("s1");
  });
});
