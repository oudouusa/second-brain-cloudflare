/**
 * D2 (T-0089.4.6, 16-t3-t4-trust-spec.md Lane D): a system job's contradiction
 * never deprecates a row it did not write, and still deprecates its own.
 * Test only -- protectConflict (src/capture/entry.ts, the isSystemRow check
 * inside it) and the CAS-guarded self-deprecation UPDATE were fixed by an
 * earlier follow-up (the spec cites entry.ts:339-346 and :436-445 at
 * release/v4); no regression test named either path until now.
 *
 * Real SQLite throughout: the self-deprecation path is a compare-and-set
 * UPDATE keyed on tags/content/workspace/actor/source together, which
 * test/helpers/d1-mock.ts does not model (it matches generic single-row
 * UPDATEs by id only) -- a green test against the mock there would not be
 * coverage of the CAS itself.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { captureEntry } from "../../src/capture/entry";

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {} } as unknown as ExecutionContext;
}

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

/** Unconditionally answers every non-embedding model call with `response` --
 *  the same shape as capture-entry.test.ts's makeContradictionAI, which is
 *  enough: a missing "action" field defaults duplicate.ts's merge decision
 *  to keep_both, harmlessly, while the "contradicts"/"conflicting_id" fields
 *  are read by the separate contradiction check regardless. */
function makeContradictionAI(response: string) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      return makeSseStream(response);
    }),
  } as unknown as Ai;
}

describe("captureEntry() system-job contradiction protection (D2)", () => {
  let d1: SqliteD1;

  beforeEach(async () => {
    resetDatabaseInit();
    d1 = makeSqliteD1();
  });
  afterEach(() => d1.close());

  it.each([
    ["digest", "system:digest", "synthesized"],
    ["insight", "system:insight", "auto-insight"],
  ] as const)("a %s capture that contradicts a user row stores it as a held draft and leaves the user row's status alone", async (job, channel, ownJobTag) => {
    const env = d1.admitEnv({
      DB: d1.db as unknown as Env["DB"],
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "user-row", score: 0.72, metadata: { parentId: "user-row" } }],
        }),
      }),
      AI: makeContradictionAI('{"contradicts": true, "conflicting_id": "user-row", "reason": "changed"}'),
      OAUTH_KV: makeMemoryKV(),
      AUTH_TOKEN: "test-token",
    } as Env);
    await initializeDatabase(env);
    d1.seed({ id: "user-row", content: "We decided the plan is X", createdAt: Date.now(), tags: ["decisions"], source: "api" });

    const result = await captureEntry("The plan is actually Y", [ownJobTag], "system", env, makeCtx(), undefined, undefined, undefined, { systemWrite: job, channel });

    expect(result.status).toBe("contradiction_protected");
    if (result.status !== "contradiction_protected") return;
    expect(result.canonicalId).toBe("user-row");
    expect(result.entryStatus).toBe("draft");

    // The system's own capture is a held draft: draft status, plus the
    // conflict-held marker so no later system job may supersede it.
    const own = d1.rows().find(r => r.id === result.id)! as { tags: string };
    const ownTags: string[] = JSON.parse(own.tags);
    expect(ownTags).toContain("status:draft");
    expect(ownTags).toContain("conflict-held");

    // The user row's status is untouched: no status:deprecated, no win/loss counters moved.
    const userRow = d1.rows().find(r => r.id === "user-row")! as { tags: string; contradiction_wins: number; contradiction_losses: number };
    expect(JSON.parse(userRow.tags)).toEqual(["decisions"]);
    expect(userRow.contradiction_wins).toBe(0);
    expect(userRow.contradiction_losses).toBe(0);
  });

  it("a system job still supersedes its own untouched system row", async () => {
    const env = d1.admitEnv({
      DB: d1.db as unknown as Env["DB"],
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "old-insight", score: 0.72, metadata: { parentId: "old-insight" } }],
        }),
      }),
      AI: makeContradictionAI('{"contradicts": true, "conflicting_id": "old-insight", "reason": "superseded"}'),
      OAUTH_KV: makeMemoryKV(),
      AUTH_TOKEN: "test-token",
    } as Env);
    await initializeDatabase(env);
    // source "system", no actor_id (defaults to '' per db/schema.sql): a real
    // system-authored row, the way runWeeklyInsights and compressTag write one.
    d1.seed({ id: "old-insight", content: "An older insight, now stale", createdAt: Date.now() - 1000, tags: ["auto-insight"], source: "system" });

    const result = await captureEntry("A fresher insight", ["auto-insight"], "system", env, makeCtx(), undefined, undefined, undefined, { systemWrite: "insight", channel: "system:insight" });

    expect(result.status).toBe("contradiction");
    if (result.status !== "contradiction") return;
    // T-0089.2.1: superseded, not deprecated: its window closes and it stays as history.
    const superseded = d1.rows().find(r => r.id === "old-insight")! as { tags: string; valid_until: number | null; contradiction_losses: number };
    expect(JSON.parse(superseded.tags)).not.toContain("status:deprecated");
    expect(superseded.valid_until).not.toBeNull();
    expect(superseded.contradiction_losses).toBe(1);
  });
});
