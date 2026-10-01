import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("GET /entry", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/entry?id=a", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("POST", "/entry"), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns the full row with tags parsed to an array", async () => {
    const longContent = "A memory well past the eighty character graph label limit — ".repeat(4);
    db.entries.push({ id: "a", content: longContent, tags: '["work","kind:semantic"]', source: "api", created_at: 1234, vector_ids: '["v"]', recall_count: 3, importance_score: 4 });

    const res = await worker.fetch(req("POST", "/entry?id=a"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    // history (BE-7, contract 4.1) is asserted separately below: its footer.not_recorded_before
    // is versions:since, which this D1Mock has no entry_versions rows to derive deterministically
    // (it falls back to Date.now()), so it cannot join the exact toEqual below.
    const { history, ...entry } = data.entry;
    expect(entry).toEqual({
      id: "a",
      content: longContent, // full content, not an 80-char label
      tags: ["work", "kind:semantic"],
      source: "api",
      created_at: 1234,
      // What the pipeline decided about this memory. The detail view shows all
      // of it, and none of it was reachable before v2.3 — /entry answered with
      // five fields while the row carried ten.
      updated_at: 1234, // coalesced: this row predates the column
      importance_score: 4,
      recall_count: 3,
      contradiction_wins: 0,
      contradiction_losses: 0,
      memory_tier: "warm",
      pinned: false,
      last_recalled_at: null,
      indexed: true,
      when_at: null,
      when_kind: null,
      when_source: null,
      workspace: "personal",
      actor_name: "Owner",
      // Whether this caller may edit or forget it. True here and on every row of
      // a solo brain: the author lock only ever engages on the company layer.
      can_edit: true,
      timeline: [],
      legacyVersions: [],
      valid_from: 1234,
      valid_from_stated: false,
      valid_until: null,
      validity_state: "current",
      superseded_by: null,
      retracted_source: false,
    });
    expect(history).toMatchObject({ items: [], footer: { pruned: false, kept: 20, shared_cut_by: null } });
    expect(typeof history.footer.not_recorded_before).toBe("number");
  });

  it("reports a memory recall cannot see as unindexed", async () => {
    db.entries.push({ id: "pending", content: "Just captured", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });

    const res = await worker.fetch(req("POST", "/entry?id=pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.entry.indexed).toBe(false);
  });

  it("prefers updated_at when the memory has been edited since capture", async () => {
    db.entries.push({ id: "edited", content: "Changed", tags: "[]", source: "api", created_at: 1000, updated_at: 9000, vector_ids: '["v"]' });

    const res = await worker.fetch(req("POST", "/entry?id=edited"), env, ctx);
    const data = await res.json() as any;
    expect(data.entry.created_at).toBe(1000);
    expect(data.entry.updated_at).toBe(9000);
  });

  it("404s for an unknown id", async () => {
    const res = await worker.fetch(req("POST", "/entry?id=ghost"), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toContain("ghost");
  });

  // Nit (d), found during live testing: the detail view could set a `when`
  // via append but never see it reflected back without a page reload.
  it("echoes when_at/when_kind/when_source (Nit d)", async () => {
    db.entries.push({
      id: "anchored", content: "Renew the passport", tags: "[]", source: "api", created_at: 1000,
      when_at: 5000, when_kind: "due", when_source: "explicit",
    });

    const res = await worker.fetch(req("POST", "/entry?id=anchored"), env, ctx);
    const data = await res.json() as any;
    expect(data.entry.when_at).toBe(5000);
    expect(data.entry.when_kind).toBe("due");
    expect(data.entry.when_source).toBe("explicit");
  });
});
