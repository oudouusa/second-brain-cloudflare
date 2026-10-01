import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { serializeExportWithinMemoryLimit, EXPORT_COMPLETE_MAX_BYTES, EXPORT_COMPLETE_MAX_ROWS, EXPORT_COMPLETE_MAX_ESTIMATED_BYTES } from "../../src/entries/export";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string, content: string, tags: string[] = [], created_at = 1000) {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at, vector_ids: '["v1"]', recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 });
}

describe("GET /export", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/export", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns ALL entries when the count exceeds the /list cap of 100", async () => {
    for (let i = 0; i < 150; i++) seedEntry(db, `e${i}`, `Memory ${i}`, [], 1000 + i);

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.version).toBe(3);
    expect(typeof data.exported_at).toBe("number");
    expect(data.entries).toHaveLength(150);
    // oldest first: a restore inserts in this order, and rowids should follow time
    expect(data.entries[0].id).toBe("e0");
    expect(data.entries[149].id).toBe("e149");
  });

  it("exports a brain above the complete-export ceiling through bounded pages", async () => {
    for (let i = 0; i < 650; i++) seedEntry(db, `e${i}`, `Memory ${i}`, [], 1000 + i);

    const complete = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(complete.status).toBe(413);
    await expect(complete.json()).resolves.toMatchObject({ error: expect.stringMatching(/paged=1/) });

    const first = await worker.fetch(req("GET", "/export?paged=1&limit=500"), env, ctx);
    const firstPage = await first.json() as any;
    expect(first.status).toBe(200);
    expect(firstPage.entries).toHaveLength(500);
    expect(firstPage.pagination).toMatchObject({
      next_offset: 500,
      remaining_entries: 150,
      complete: false,
    });

    const second = await worker.fetch(
      req("GET", `/export?paged=1&limit=500&offset=${firstPage.pagination.next_offset}`),
      env,
      ctx,
    );
    const secondPage = await second.json() as any;
    expect(secondPage.entries).toHaveLength(150);
    expect(secondPage.pagination).toMatchObject({
      next_offset: 650,
      remaining_entries: 0,
      complete: true,
    });
  });

  it("端点のないedgeはHTTP 409で拒否する", async () => {
    seedEntry(db, "a", "Memory A");
    db.edges.push({ id: "dangling", source_id: "a", target_id: "missing", type: "relates_to", weight: 1, provenance: "manual", metadata: "{}", created_at: 1, updated_at: 1 });

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "Backup contains an edge with a missing endpoint; repair graph integrity first",
    });
  });

  it.each(["あ".repeat(40_000), "\u0000".repeat(90_000)])(
    "UTF-8とJSON escapeを含む大型本文をHTTP 413で拒否する %#",
    async (content) => {
      seedEntry(db, "large", content);
      const res = await worker.fetch(req("GET", "/export"), env, ctx);
      expect(res.status).toBe(413);
      await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/paged=1/) });
    },
  );

  it("大型edge metadataもHTTP 413で拒否する", async () => {
    seedEntry(db, "a", "Memory A");
    seedEntry(db, "b", "Memory B");
    db.edges.push({ id: "large-edge", source_id: "a", target_id: "b", type: "relates_to", weight: 1, provenance: "manual", metadata: JSON.stringify({ note: "あ".repeat(40_000) }), created_at: 1, updated_at: 1 });
    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/paged=1/) });
  });

  // updated_at is what a restore needs to put an entry back where it was: recall reads
  // it as the entry's age and the staleness pass selects on it. An export without it
  // silently resets every restored entry's last-touched time to its creation time.
  it("carries updated_at so a restore can put an entry back where it was", async () => {
    seedEntry(db, "edited", "Edited later", [], 1000);
    db.entries[0].updated_at = 9000;

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    expect(data.entries[0].updated_at).toBe(9000);
    expect(data.entries[0].created_at).toBe(1000);
  });

  // Rows written before the column existed hold NULL. Exporting that verbatim would
  // hand the importer a null to insert, so the fallback happens on the way out.
  it("falls back to created_at for rows written before updated_at existed", async () => {
    seedEntry(db, "old", "Never edited", [], 1000);
    db.entries[0].updated_at = null;

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    expect(data.entries[0].updated_at).toBe(1000);
  });

  it("includes edges and parses tags to real arrays", async () => {
    seedEntry(db, "a", "Memory A", ["work", "kind:semantic"]);
    seedEntry(db, "b", "Memory B", ["idea"]);
    Object.assign(db.entries.find(entry => entry.id === "a")!, {
      workspace_id: "ws-team",
      actor_id: "user-a",
    });
    db.edges.push({ id: "edge-1", source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1, workspace_id: "ws-team" });

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    const a = data.entries.find((e: any) => e.id === "a");
    expect(a.tags).toEqual(["work", "kind:semantic"]); // array, not a JSON string
    expect(a).toMatchObject({ workspace_id: "ws-team", actor_id: "user-a" });
    expect(data.edges).toEqual([
      { id: "edge-1", source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", metadata: {}, created_at: 1, updated_at: 1, workspace_id: "ws-team" },
    ]);
  });

  it("never includes vector_ids (deployment-specific, import re-embeds)", async () => {
    seedEntry(db, "a", "Memory A");

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    expect(data.entries[0]).not.toHaveProperty("vector_ids");
  });

  it("carries manual tier, pin, and recall timestamp metadata", async () => {
    seedEntry(db, "tiered", "Tiered memory");
    Object.assign(db.entries[0], { memory_tier: "hot", pinned: 1, last_recalled_at: 7000 });
    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    expect(data.entries[0]).toMatchObject({
      memory_tier: "hot",
      pinned: true,
      last_recalled_at: 7000,
    });
  });

  it("exports an empty brain as a valid structure with empty arrays", async () => {
    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.entries).toEqual([]);
    expect(data.edges).toEqual([]);
  });
});


describe("完全exportの生成後上限", () => {
  it("完全exportの上限を維持し、実JSON byte数の上限ちょうどを許可する", () => {
    expect([EXPORT_COMPLETE_MAX_ROWS, EXPORT_COMPLETE_MAX_ESTIMATED_BYTES, EXPORT_COMPLETE_MAX_BYTES])
      .toEqual([500, 512 * 1024, EXPORT_COMPLETE_MAX_BYTES]);
    const bundle = { ok: true as const, version: 3 as const, exported_at: 1,
      entries: [{ id: "a", content: "", tags: [], source: "api", created_at: 1 }], edges: [] };
    const overhead = new TextEncoder().encode(JSON.stringify(bundle)).byteLength;
    bundle.entries[0].content = "x".repeat(EXPORT_COMPLETE_MAX_BYTES - overhead);
    expect(new TextEncoder().encode(serializeExportWithinMemoryLimit(bundle)).byteLength)
      .toBe(EXPORT_COMPLETE_MAX_BYTES);
    bundle.entries[0].content += "あ";
    expect(() => serializeExportWithinMemoryLimit(bundle)).toThrowError(expect.objectContaining({
      name: "ExportError", status: 413,
      message: "Backup exceeds the restorable object limit; use a paged export workflow",
    }));
  });
});
