import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(
  db: D1Mock,
  id: string,
  content: string,
  tags: string[] = [],
  created_at = 1000,
  opts: { source?: string; vector_ids?: string; recall_count?: number; importance_score?: number } = {},
) {
  db.entries.push({
    id,
    content,
    tags: JSON.stringify(tags),
    source: opts.source ?? "api",
    created_at,
    updated_at: created_at,
    vector_ids: opts.vector_ids ?? '["v1"]',
    recall_count: opts.recall_count ?? 0,
    importance_score: opts.importance_score ?? 0,
    contradiction_wins: 0,
    contradiction_losses: 0,
  });
}

function exportPayload(db: D1Mock) {
  return {
    version: 2,
    entries: db.entries.map(e => ({
      id: e.id,
      content: e.content,
      tags: JSON.parse(e.tags ?? "[]"),
      source: e.source,
      created_at: e.created_at,
      updated_at: e.updated_at ?? e.created_at,
      recall_count: e.recall_count ?? 0,
      importance_score: e.importance_score ?? 0,
      contradiction_wins: e.contradiction_wins ?? 0,
      contradiction_losses: e.contradiction_losses ?? 0,
      memory_tier: e.memory_tier ?? "warm",
      pinned: Number(e.pinned ?? 0) === 1,
      last_recalled_at: e.last_recalled_at ?? null,
    })),
    edges: db.edges.map(e => ({
      id: e.id,
      source_id: e.source_id,
      target_id: e.target_id,
      type: e.type,
      weight: e.weight,
      provenance: e.provenance,
      metadata: JSON.parse(e.metadata ?? "{}"),
      created_at: e.created_at,
      updated_at: e.updated_at ?? e.created_at,
    })),
  };
}

describe("POST /import", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/import", { body: { version: 2, entries: [] }, token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("rejects invalid version", async () => {
    const res = await worker.fetch(req("POST", "/import", { body: { version: 99, entries: [] } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/version must be 1, 2 or 3/);
  });

  it("rejects missing entries array", async () => {
    const res = await worker.fetch(req("POST", "/import", { body: { version: 2 } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/entries must be an array/);
  });

  it("rejects more than 10,000 rows before import work begins", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: { version: 2, entries: Array.from({ length: 10_001 }, () => ({})), edges: [] },
    }), env, ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("manual import") });
    expect(db.entries).toHaveLength(0);
  });

  it("rejects a JSON body over 1 MiB before parsing or writing", async () => {
    const request = new Request("http://localhost/import", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 2, entries: [], padding: "x".repeat(1024 * 1024) }),
    });
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(413);
    expect(db.entries).toHaveLength(0);
  });

  it("fails manual-import rows that can never fit the embedding contract", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: "too-large", content: "x".repeat(12_001), source: "import" },
          { id: "tag-too-large", content: "valid", tags: ["あ".repeat(22)], source: "import" },
        ],
      },
    }), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      imported: 0,
      failed: 2,
      results: [
        { id: "too-large", status: "failed", reason: "index_limit" },
        { id: "tag-too-large", status: "failed", reason: "index_limit" },
      ],
    });
    expect(db.entries).toHaveLength(0);
  });

  it("round-trips export payload into an empty brain", async () => {
    seedEntry(db, "a", "Memory A", ["work", "kind:semantic"], 5000, { source: "phone", recall_count: 3, importance_score: 4 });
    seedEntry(db, "b", "Memory B", ["idea"], 4000);
    db.edges.push({ id: "edge-1", source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", metadata: '{"reason":"shared-project"}', created_at: 1, updated_at: 9 });

    const payload = exportPayload(db);
    db.reset();

    const res = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    expect(res.status).toBe(200);
    const entryData = await res.json() as any;
    const edgeRes = await worker.fetch(req("POST", "/import?offset=2", { body: payload }), env, ctx);
    const data = await edgeRes.json() as any;
    expect(data.ok).toBe(true);
    expect(entryData.imported).toBe(2);
    expect(entryData.skipped).toBe(0);
    expect(entryData.failed).toBe(0);
    expect(data.edges_imported).toBe(1);
    expect(data.edges_failed).toBe(0);
    expect(data.remaining_entries).toBe(0);
    expect(data.remaining_edges).toBe(0);
    expect(data.vectorize_hint).toMatch(/vectorize-pending/);

    const a = db.entries.find(e => e.id === "a")!;
    expect(a.content).toBe("Memory A");
    expect(JSON.parse(a.tags)).toEqual(["work", "kind:semantic"]);
    expect(a.source).toBe("phone");
    expect(a.created_at).toBe(5000);
    expect(a.updated_at).toBe(5000);
    expect(a.recall_count).toBe(3);
    expect(a.importance_score).toBe(4);
    expect(a.memory_tier).toBe("warm");
    expect(a.pinned).toBe(0);
    expect(a.last_recalled_at).toBeNull();
    expect(a.vector_ids).toBe("[]");

    expect(db.edges).toHaveLength(1);
    expect(db.edges[0]).toMatchObject({ id: "edge-1", source_id: "a", target_id: "b", type: "relates_to", metadata: '{"reason":"shared-project"}', updated_at: 9 });
    expect(db.edges[0].created_at).toBe(1);
  });

  it("is idempotent — second import skips all entries", async () => {
    const payload = {
      version: 2,
      entries: [{ id: "x", content: "Note", tags: ["t"], source: "api", created_at: 100 }],
      edges: [],
    };

    const first = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    const firstData = await first.json() as any;
    expect(firstData.imported).toBe(1);

    const second = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    const secondData = await second.json() as any;
    expect(secondData.imported).toBe(0);
    expect(secondData.skipped).toBe(1);
    expect(secondData.results).toHaveLength(0);
    expect(db.entries).toHaveLength(1);
  });

  it("skips edges with missing endpoints, without saying why, but still imports entries", async () => {
    const payload = {
      version: 2,
      entries: [{ id: "a", content: "Only A", created_at: 1 }],
      edges: [{ source_id: "a", target_id: "missing", type: "relates_to" }],
    };

    const res = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    const entryData = await res.json() as any;
    const edgeRes = await worker.fetch(req("POST", "/import?offset=1", { body: payload }), env, ctx);
    const data = await edgeRes.json() as any;
    expect(entryData.imported).toBe(1);
    expect(data.edges_imported).toBe(0);
    // A missing endpoint and another member's private one look the same (T-0089.1.1): a plain skip.
    expect(data.edges_skipped).toBe(1);
    expect(data.edges_failed).toBe(0);
    expect(JSON.stringify(data.results)).not.toMatch(/missing/);
  });

  it("does not trigger capture duplicate detection for similar content with a new id", async () => {
    seedEntry(db, "existing", "The quick brown fox jumps over the lazy dog", ["note"]);

    const payload = {
      version: 2,
      entries: [{ id: "new-id", content: "The quick brown fox jumps over the lazy dog", tags: ["note"], created_at: 2000 }],
      edges: [],
    };

    const res = await worker.fetch(req("POST", "/import", { body: payload }), env, ctx);
    const data = await res.json() as any;
    expect(data.imported).toBe(1);
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find(e => e.id === "new-id")?.vector_ids).toBe("[]");
  });

  it("reports failed entries with missing content", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: { version: 2, entries: [{ id: "bad", content: "  " }], edges: [] },
    }), env, ctx);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.results).toContainEqual({ id: "bad", status: "failed", reason: "missing_content" });
  });

  it("reports invalid_id for non-string ids without aborting the request", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: 123, content: "bad id type" },
          { id: "good", content: "valid entry", created_at: 1 },
        ],
        edges: [],
      },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.imported).toBe(1);
    expect(data.results).toContainEqual({ id: "123", status: "failed", reason: "invalid_id" });
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].id).toBe("good");
  });

  it("respects ?limit= and reports remaining_entries", async () => {
    const payload = {
      version: 2,
      entries: [
        { id: "e1", content: "One", created_at: 1 },
        { id: "e2", content: "Two", created_at: 2 },
        { id: "e3", content: "Three", created_at: 3 },
      ],
      edges: [],
    };

    const first = await worker.fetch(req("POST", "/import?limit=1", { body: payload }), env, ctx);
    const firstData = await first.json() as any;
    expect(firstData.imported).toBe(1);
    expect(firstData.remaining_entries).toBe(2);

    const second = await worker.fetch(req("POST", "/import?limit=10", { body: payload }), env, ctx);
    const secondData = await second.json() as any;
    expect(secondData.imported).toBe(2);
    expect(secondData.skipped).toBe(1);
    expect(secondData.remaining_entries).toBe(0);
    expect(db.entries).toHaveLength(3);
  });

  it("defers edges until all entries are processed", async () => {
    const payload = {
      version: 2,
      entries: [
        { id: "a", content: "A", created_at: 1 },
        { id: "b", content: "B", created_at: 2 },
      ],
      edges: [{ source_id: "a", target_id: "b", type: "relates_to" }],
    };

    const partial = await worker.fetch(req("POST", "/import?limit=1", { body: payload }), env, ctx);
    const partialData = await partial.json() as any;
    expect(partialData.imported).toBe(1);
    expect(partialData.remaining_entries).toBe(1);
    expect(partialData.remaining_edges).toBe(1);
    expect(partialData.edges_imported).toBe(0);
    expect(db.edges).toHaveLength(0);

    const finish = await worker.fetch(req("POST", `/import?offset=${partialData.next_offset}`, { body: payload }), env, ctx);
    const finishData = await finish.json() as any;
    expect(finishData.edges_imported).toBe(0);
    const edges = await worker.fetch(req("POST", `/import?offset=${finishData.next_offset}`, { body: payload }), env, ctx);
    const edgeData = await edges.json() as any;
    expect(edgeData.edges_imported).toBe(1);
    expect(db.edges).toHaveLength(1);
  });

  it("rejects null entries without aborting the request", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [null, { id: "good", content: "valid", created_at: 1 }],
        edges: [],
      },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.imported).toBe(1);
    expect(data.results).toContainEqual({ id: "", status: "failed", reason: "invalid_entry" });
    expect(db.entries).toHaveLength(1);
  });

  it("rejects non-string tags", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [{ id: "bad", content: "Note", tags: [42], created_at: 1 }],
        edges: [],
      },
    }), env, ctx);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.results).toContainEqual({ id: "bad", status: "failed", reason: "invalid_tag" });
    expect(db.entries).toHaveLength(0);
  });

  it("pages entries then edges by cursor, with idempotent re-runs", async () => {
    const entries = [
      { id: "a", content: "A", created_at: 1 },
      { id: "b", content: "B", created_at: 2 },
      { id: "c", content: "C", created_at: 3 },
    ];
    const edges = [
      { source_id: "a", target_id: "b", type: "relates_to", created_at: 100 },
      { source_id: "b", target_id: "c", type: "relates_to", created_at: 200 },
    ];
    const payload = { version: 2, entries, edges };

    // Entry pages at limit=1: edges wait until the entries array is exhausted.
    const p1 = await (await worker.fetch(req("POST", "/import?limit=1", { body: payload }), env, ctx)).json() as any;
    expect(p1.imported).toBe(1);
    expect(p1.next_offset).toBe(1);
    expect(p1.remaining_entries).toBe(2);
    expect(p1.edges_imported).toBe(0);
    expect(p1.remaining_edges).toBe(2);

    const p2 = await (await worker.fetch(req("POST", "/import?limit=1&offset=1", { body: payload }), env, ctx)).json() as any;
    expect(p2.imported).toBe(1);
    expect(db.edges).toHaveLength(0);

    // The final entries page never starts edge work in the same D1 budget.
    const p3 = await (await worker.fetch(req("POST", "/import?limit=1&offset=2", { body: payload }), env, ctx)).json() as any;
    expect(p3.imported).toBe(1);
    expect(p3.remaining_entries).toBe(0);
    expect(p3.edges_imported).toBe(0);
    expect(p3.next_edge_offset).toBe(0);
    expect(p3.remaining_edges).toBe(2);

    const p4 = await (await worker.fetch(req("POST", "/import?limit=1&offset=3", { body: payload }), env, ctx)).json() as any;
    expect(p4.edges_imported).toBe(1);
    expect(p4.next_edge_offset).toBe(1);
    expect(p4.remaining_edges).toBe(1);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].created_at).toBe(100);

    const p5 = await (await worker.fetch(req("POST", "/import?limit=1&offset=3&edge_offset=1", { body: payload }), env, ctx)).json() as any;
    expect(p5.edges_imported).toBe(1);
    expect(p5.remaining_edges).toBe(0);
    expect(db.edges).toHaveLength(2);
    expect(db.edges.find((e: any) => e.source_id === "b" && e.target_id === "c")?.created_at).toBe(200);

    // Re-running a page is a skip, not a duplicate or an error.
    const rerun = await (await worker.fetch(req("POST", "/import?limit=1&offset=3&edge_offset=1", { body: payload }), env, ctx)).json() as any;
    expect(rerun.edges_skipped).toBe(1);
    expect(rerun.edges_imported).toBe(0);
    expect(db.edges).toHaveLength(2);
  });

  it("reports invalid_recall_count without aborting the request", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: "bad", content: "Note", recall_count: "lots", created_at: 1 },
          { id: "good", content: "valid", created_at: 2 },
        ],
        edges: [],
      },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.failed).toBe(1);
    expect(data.imported).toBe(1);
    expect(data.results).toContainEqual({ id: "bad", status: "failed", reason: "invalid_recall_count" });
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].id).toBe("good");
  });

  it("preserves updated_at across the round trip, and defaults it for old exports", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: "edited", content: "Edited later", created_at: 1000, updated_at: 9000 },
          { id: "old-export", content: "From a pre-updated_at export", created_at: 2000 },
        ],
      },
    }), env, ctx);
    expect((await res.json() as any).imported).toBe(2);

    expect(db.entries.find(e => e.id === "edited")!.updated_at).toBe(9000);
    // The field is what recall and the staleness pass read as the entry's age;
    // created_at is what the column would have coalesced to anyway.
    expect(db.entries.find(e => e.id === "old-export")!.updated_at).toBe(2000);
  });

  it("reports invalid_updated_at without laundering it into a fresh timestamp", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: "bad", content: "X", created_at: 1000, updated_at: "yesterday" },
          { id: "good", content: "Y", created_at: 1000 },
        ],
      },
    }), env, ctx);
    const data = await res.json() as any;
    expect(data.imported).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.results).toContainEqual({ id: "bad", status: "failed", reason: "invalid_updated_at" });
    expect(db.entries.map(e => e.id)).toEqual(["good"]);
  });

  it("skips a duplicate id within one payload instead of failing the batch", async () => {
    const res = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: "dup", content: "First occurrence", created_at: 1000 },
          { id: "dup", content: "Second occurrence", created_at: 2000 },
        ],
      },
    }), env, ctx);
    const data = await res.json() as any;
    // Without the queue-time skip both rows enter one batch and the PRIMARY KEY
    // conflict fails the whole batch into the per-row fallback.
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.failed).toBe(0);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("First occurrence");
  });

  it("rejects self-edges the way the capture path does", async () => {
    await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [{ id: "a", content: "A", created_at: 1 }],
        edges: [{ source_id: "a", target_id: "a", type: "relates_to" }],
      },
    }), env, ctx);
    const res = await worker.fetch(req("POST", "/import?offset=1", {
      body: {
        version: 2,
        entries: [{ id: "a", content: "A", created_at: 1 }],
        edges: [{ source_id: "a", target_id: "a", type: "relates_to" }],
      },
    }), env, ctx);
    const data = await res.json() as any;
    expect(data.edges_failed).toBe(1);
    expect(data.results).toContainEqual({
      source_id: "a", target_id: "a", type: "relates_to", status: "failed", reason: "self_edge",
    });
    expect(db.edges).toHaveLength(0);
  });

  it("imports edges when endpoints were imported in a prior request", async () => {
    const entriesRes = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [
          { id: "a", content: "Memory A", created_at: 1 },
          { id: "b", content: "Memory B", created_at: 2 },
        ],
        edges: [],
      },
    }), env, ctx);
    expect((await entriesRes.json() as any).imported).toBe(2);

    const edgesRes = await worker.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [],
        edges: [{ source_id: "a", target_id: "b", type: "relates_to", created_at: 100 }],
      },
    }), env, ctx);
    expect(edgesRes.status).toBe(200);
    const edgeData = await edgesRes.json() as any;
    expect(edgeData.edges_imported).toBe(1);
    expect(edgeData.edges_failed).toBe(0);
    expect(db.edges).toHaveLength(1);
  });

  it("imports edges when the payload has more than 50 distinct endpoints", async () => {
    const entries = Array.from({ length: 52 }, (_, i) => ({
      id: `n${i}`,
      content: `Memory ${i}`,
      created_at: i + 1,
    }));
    const edges = Array.from({ length: 51 }, (_, i) => ({
      source_id: `n${i}`,
      target_id: `n${i + 1}`,
      type: "relates_to",
      created_at: 1000 + i,
    }));

    let offset = 0;
    while (offset < entries.length) {
      const res = await worker.fetch(req("POST", `/import?offset=${offset}`, {
        body: { version: 2, entries, edges },
      }), env, ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      offset = data.next_offset;
    }
    let edgeOffset = 0;
    while (edgeOffset < edges.length) {
      const res = await worker.fetch(req("POST", `/import?offset=${entries.length}&edge_offset=${edgeOffset}`, {
        body: { version: 2, entries, edges },
      }), env, ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.edges_failed).toBe(0);
      edgeOffset = data.next_edge_offset;
    }
    expect(db.edges).toHaveLength(51);
  });

  describe("Gemma128の手動import境界", () => {
    it("巨大な本文を明示的に拒否し、同じpage内の有効な記憶は保存する", async () => {
      const entries = [{ id: "ok", content: "短い記憶", created_at: 1 }, { id: "too-big", content: "a".repeat(131_073), created_at: 2 }];
      const res = await worker.fetch(req("POST", "/import", { body: { version: 2, entries } }), env, ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data).toMatchObject({ imported: 1, failed: 1, skipped_too_large: 0 });
      expect(data.results).toContainEqual(expect.objectContaining({ id: "too-big", status: "failed", reason: "index_limit" }));
      expect(db.entries.map(e => e.id)).toEqual(["ok"]);
    });
    it("上流128KiB以内でも固定embedding上限を超えればindex_limitを返す", async () => {
      const entries = [{ id: "at-limit", content: "a".repeat(131_072), created_at: 1000 }];
      const res = await worker.fetch(req("POST", "/import", { body: { version: 2, entries } }), env, ctx);
      expect(await res.json()).toMatchObject({ imported: 0, failed: 1, results: [expect.objectContaining({ id: "at-limit", reason: "index_limit" })] });
    });
  });
});
