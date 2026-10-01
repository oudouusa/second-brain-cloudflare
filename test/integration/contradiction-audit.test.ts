/**
 * The row a contradicting capture supersedes gets its own audit event (T-0089.2.1: superseded).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { captureEntry } from "../../src/capture/entry";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;

function makeAI(decision: string) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(decision)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

describe("contradiction audit", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    pending.length = 0;
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "old", score: 0.72, metadata: { parentId: "old" } }] }),
      }),
      AI: makeAI('{"contradicts": true, "conflicting_id": "old", "reason": "different city"}'),
    }));
    await initializeDatabase(env);
    sqlite.seed({ id: "old", content: "I live in NYC", tags: [], createdAt: 1000 });
  });

  afterEach(() => sqlite.close());

  const events = async () => {
    await Promise.allSettled(pending);
    return ((await env.DB.prepare(`SELECT entry_id, actor_id, event, payload FROM entry_events`).all()).results) as
      { entry_id: string; actor_id: string; event: string; payload: string }[];
  };

  it("writes superseded for the closed row, naming the new row", async () => {
    const result = await captureEntry("I moved to LA", [], "api", env, ctx, undefined, { workspaceId: "", actorId: "u1" }, undefined, { channel: "rest" });
    expect(result.status).toBe("contradiction");
    if (result.status !== "contradiction") return;
    const trail = await events();
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ entry_id: "old", actor_id: "u1", event: "superseded" });
    expect(JSON.parse(trail[0].payload)).toEqual({ by: result.id, until: result.supersede!.at, channel: "rest" });
  });

  it("systemWrite: a system capture contradicting a user memory supersedes nothing and lands as a draft", async () => {
    const before = await env.DB.prepare(`SELECT tags, vector_ids FROM entries WHERE id = 'old'`).first();
    const result = await captureEntry("I moved to LA", ["auto-insight"], "system", env, ctx, undefined, { workspaceId: "", actorId: "" }, undefined, { systemWrite: "insight", channel: "system:insight" });
    expect(result.status).toBe("contradiction_protected");
    if (result.status !== "contradiction_protected") return;
    expect(await env.DB.prepare(`SELECT tags, vector_ids FROM entries WHERE id = 'old'`).first()).toEqual(before);
    const fresh = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(result.id).first() as { tags: string };
    expect(JSON.parse(fresh.tags)).toContain("status:draft");
    expect(await events()).toHaveLength(0);
  });

  it("systemWrite: a system capture may still supersede a row a system job wrote (no actor, system tag)", async () => {
    sqlite.db.prepare(`UPDATE entries SET source = 'system', tags = '["synthesized"]' WHERE id = 'old'`).run();
    const result = await captureEntry("I moved to LA", [], "system", env, ctx, undefined, { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest", channel: "system:digest" });
    expect(result.status).toBe("contradiction");
  });

  it("systemWrite: a user row that merely carries source 'system' is still left alone", async () => {
    sqlite.db.prepare(`UPDATE entries SET source = 'system', actor_id = 'u1' WHERE id = 'old'`).run();
    const result = await captureEntry("I moved to LA", [], "system", env, ctx, undefined, { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest", channel: "system:digest" });
    expect(result.status).toBe("contradiction_protected");
  });

  it("writes no contradiction event when the caller has no channel (an identity-less MCP call)", async () => {
    const result = await captureEntry("I moved to LA", [], "api", env, ctx, undefined, { workspaceId: "", actorId: "" });
    expect(result.status).toBe("contradiction");
    expect(await events()).toHaveLength(0);
  });
});
