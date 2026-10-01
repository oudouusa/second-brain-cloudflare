/**
 * GET /digest hands compressTag an arbitrary user-supplied string, which makes it the one
 * path where the guard inside compressTag is the ONLY thing standing between a request and
 * a rollup. The nightly path is protected twice — the candidate query filters the tag list
 * before compressTag ever sees it — so a guard that is too narrow shows up here and nowhere
 * else. It went unnoticed because this route had no test at all.
 *
 * Compressing a system tag is not a no-op: compressTag selects sources with `tags LIKE
 * '%"<tag>"%'` and marks every one of them `rolled-up` with a `[Digest: …]` suffix appended
 * to its content, permanently. `duplicate-candidate` and `contradiction-resolved` are the
 * dangerous ones — unlike synthesized/auto-pattern/rolled-up they have no row-level
 * exclusion anywhere, so every entry carrying one is selectable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("POST /digest", () => {
  let env: Env;
  let db: D1Mock;

  function seed(tags: string[], n = 12) {
    const old = Date.now() - 200 * 24 * 3600 * 1000;
    for (let i = 0; i < n; i++) {
      db.entries.push({
        id: `e-${i}`, content: `Memory ${i}`, tags: JSON.stringify(tags), source: "api",
        created_at: old + i, updated_at: old + i, vector_ids: "[]",
        recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
      });
    }
  }

  // Compared against the state before the request rather than against absolutes: some of
  // these fixtures are seeded with the very tag under test, so "nothing changed" is the
  // assertion — no row added, none marked, no content appended to.
  const snapshot = () => db.entries.map(e => ({ id: e.id, tags: e.tags, content: e.content }));

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(req("POST", "/digest?tag=work", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("requires a tag", async () => {
    const res = await worker.fetch(req("POST", "/digest"), env, ctx);
    expect(res.status).toBe(400);
  });

  it.each([
    "duplicate-candidate",
    "Duplicate-Candidate",
    "contradiction-resolved",
    "synthesized",
    "rolled-up",
    "stale:as-of",
    "Stale:As-Of",
    "kind:semantic",
    "Kind:Semantic",
    "status:canonical",
    "volatility:state",
  ])("refuses to compress the system tag %s", async (tag) => {
    seed([tag, "project-atlas"]);
    const before = snapshot();

    const res = await worker.fetch(req("POST", `/digest?tag=${encodeURIComponent(tag)}`), env, ctx);

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.entry_id).toBeUndefined();
    expect(data.source_count).toBe(0);
    expect(env.AI.run).not.toHaveBeenCalled(); // rejected before any work at all
    expect(snapshot()).toEqual(before);
  });

  // The guard must not have become a blanket refusal — an ordinary tag still compresses.
  it("still compresses an ordinary tag", async () => {
    seed(["holiday-plans"]);

    const res = await worker.fetch(req("POST", "/digest?tag=holiday-plans"), env, ctx);

    const data = await res.json() as any;
    expect(data.entry_id).toBeTruthy();
    expect(data.source_count).toBe(12);
    expect(db.entries.filter(e => JSON.parse(e.tags).includes("rolled-up"))).toHaveLength(12);
  });

  // The message must state the real threshold: digest.ts skips a tag with fewer than 10
  // eligible entries, and this text once said 20.
  it("names the real eligibility threshold when a tag has too few entries", async () => {
    seed(["thin-tag"], 3);

    const res = await worker.fetch(req("POST", "/digest", { body: { tag: "thin-tag" } }), env, ctx);

    const data = await res.json() as any;
    expect(data.error).toBe("Could not create digest: the tag may have fewer than 10 eligible entries or was recently compressed");
    expect(data.source_count).toBe(0);
  });
});
