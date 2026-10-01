import { afterEach, expect, it, vi } from "vitest";
import { captureEntry } from "../../src/capture/entry";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import type { Env } from "../../src/env";

const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
}});
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } } as ExecutionContext;

afterEach(async () => { await Promise.allSettled(pending); vi.restoreAllMocks(); pending.length = 0; });

// R4-V3 (T-0089.1.1) supersedes T-0089.4.4's own fix: pinning the failure branch's clear to
// writeCtx.workspaceId (the caller's ORIGINAL, now-stale attempt) rather than the row's CURRENT
// workspace (read moments earlier in the very same call) is exactly what let an unshare mid-edit
// commit a dangling vector_ids reference — the clear missed on the stale pin, yet the delete ran
// unconditionally anyway, deleting a live vector while vector_ids still named it. Pinning to the
// row's current workspace instead means the clear lands wherever the row actually is, so a race
// into another workspace now empties vector_ids there (self-healing via /vectorize-pending)
// instead of leaving a reference to a vector this call just deleted.
// Round 6 (per-upload vector ids): a lost merge deletes only its own upload; the row's listed vectors
// are never touched, so there is no clear to pin and no dangling reference to create.
it("a lost system merge into a row that moved leaves the row's own vectors listed and undeleted", async () => {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  let restoreEmbedFails = false;
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn(async (): Promise<any> => ({ matches: [{ id: "target", score: 0.9, metadata: { parentId: "target" } }] })) }),
    AI: { run: vi.fn(async (model: string, opts: any) => {
      if (model === "@cf/google/embeddinggemma-300m") {
        if (restoreEmbedFails) throw new Error("local embed failure");
        return { data: [new Array(768).fill(0.1)] };
      }
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (prompt.includes("Choose exactly one action")) return stream('{"action":"merge","target_id":"target","merged_content":"Combined digest"}');
      return stream("3");
    }) } as any,
  })) as Env;
  await initializeDatabase(env);
  sqlite.seed({ id: "target", content: "Old digest", tags: ["synthesized", "work"], source: "system", createdAt: 1, vectorIds: ["old-vector"] });
  const db = env.DB as any;
  const realPrepare = db.prepare.bind(db);
  let raced = false;
  db.prepare = (sql: string) => {
    // Current shape (buildCasGuard, ADV-1/ADV-2): "UPDATE entries AS e SET content = ..." with the
    // system-row guard (COALESCE(e.actor_id, '') = '') appended after the CAS predicate.
    if (!raced && /^UPDATE entries AS e SET .*content = /s.test(sql) && sql.includes("COALESCE(e.actor_id")) {
      raced = true;
      void sqlite.db.prepare("UPDATE entries SET workspace_id = 'other-private', actor_id = 'other-user' WHERE id = 'target'").run();
      restoreEmbedFails = true;
    }
    return realPrepare(sql);
  };

  await captureEntry("New digest", ["synthesized", "work"], "system", env, ctx, undefined,
    { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest" });
  const target = sqlite.rows().find(r => r.id === "target")!;
  expect(raced).toBe(true);
  expect(target.workspace_id).toBe("other-private");
  expect(target.vector_ids).toBe('["old-vector"]');
  const deletedIds = (env.VECTORIZE.deleteByIds as any).mock.calls.flatMap((c: any) => c[0]);
  expect(deletedIds).not.toContain("old-vector");
  sqlite.close();
});
