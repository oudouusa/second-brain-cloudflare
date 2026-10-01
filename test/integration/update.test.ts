import { parentIdOfVectorId } from "../../src/vectorize/ids";
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

// A stateful Vectorize mock that faithfully models Cloudflare's semantics:
// insert() SKIPS ids that already exist, upsert() OVERWRITES them. The default
// mock's insert/upsert are indistinguishable no-op spies, which is exactly why
// the stale-vector bug (#208) went unnoticed — this reproduces it behaviorally.
function makeStatefulVectorize(seed: any[] = []) {
  const store = new Map<string, any>();
  for (const v of seed) store.set(v.id, v);
  const mock = makeVectorizeMock({
    insert: vi.fn(async (vectors: any[]): Promise<any> => {
      for (const v of vectors) if (!store.has(v.id)) store.set(v.id, v);
      return { mutationId: "m" };
    }),
    upsert: vi.fn(async (vectors: any[]): Promise<any> => {
      for (const v of vectors) store.set(v.id, v);
      return { mutationId: "m" };
    }),
    deleteByIds: vi.fn(async (ids: string[]): Promise<any> => {
      for (const id of ids) store.delete(id);
      return { mutationId: "m" };
    }),
    getByIds: vi.fn(async (ids: string[]): Promise<any> =>
      ids.map(id => store.get(id)).filter(Boolean)),
    query: vi.fn(async (): Promise<any> => ({ matches: [] })),
  });
  return { store, mock };
}

function seedEntry(db: D1Mock, overrides: Partial<ReturnType<typeof makeEntry>> = {}) {
  const entry = makeEntry(overrides);
  db.entries.push(entry);
  return entry;
}

function makeEntry(overrides: Partial<{
  id: string; content: string; tags: string; source: string;
  created_at: number; vector_ids: string; recall_count: number; importance_score: number;
}> = {}) {
  return {
    id: "entry-abc",
    content: "Original content",
    tags: '["work"]',
    source: "api",
    created_at: Date.now(),
    vector_ids: '["entry-abc"]',
    recall_count: 0,
    importance_score: 3,
    ...overrides,
  };
}

describe("POST /update", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "x", content: "new" }, token: null }),
      env, ctx
    );
    expect(res.status).toBe(401);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { content: "new content" } }),
      env, ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/id/);
  });

  it("returns 400 when content is missing", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc" } }),
      env, ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/content/);
  });

  it("returns 400 when content is blank whitespace", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "   " } }),
      env, ctx
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when entry does not exist", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "nonexistent", content: "new content" } }),
      env, ctx
    );
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/nonexistent/);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("updates D1 content and returns ok:true with id", async () => {
    seedEntry(db);
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.id).toBe("entry-abc");
    expect(db.entries[0].content).toBe("Updated content");
  });

  it("preserves existing tags and source after update", async () => {
    seedEntry(db, { tags: '["work","important"]', source: "claude" });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "New content" } }),
      env, ctx
    );
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("work");
    expect(tags).toContain("important");
    expect(db.entries[0].source).toBe("claude");
  });

  // ── Hashtag merge ───────────────────────────────────────────────────────────

  it("merges new #hashtag from content into tags and strips it from stored content", async () => {
    seedEntry(db, { tags: '["work"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content #newtag" } }),
      env, ctx
    );
    expect(db.entries[0].content).toBe("Updated content");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("work");
    expect(tags).toContain("newtag");
  });

  it("does not duplicate a tag already present when the same #tag appears in content", async () => {
    seedEntry(db, { tags: '["work"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content #work" } }),
      env, ctx
    );
    expect(db.entries[0].content).toBe("Updated content");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags.filter((t: string) => t === "work")).toHaveLength(1);
  });

  // ── Tag replacement ─────────────────────────────────────────────────────────
  //
  // Every write path unioned new tags onto old ones, so a tag could be added
  // from anywhere and removed from nowhere. The editor's remove control is the
  // first caller that means "these and not the others", and the risk it
  // introduces is that a replacement also throws away the brain's own
  // conclusions — which the user never saw and cannot re-derive.

  it("removes a tag the user dropped", async () => {
    seedEntry(db, { tags: '["work","pricing"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "New content", tags: ["work"] } }),
      env, ctx
    );
    expect(JSON.parse(db.entries[0].tags)).toEqual(["work"]);
  });

  it("keeps the Worker's own tags through a replacement", async () => {
    // kind: is the classifier's verdict, status: the contradiction pass's, and
    // neither is shown in the editor — so neither can appear in what it sends,
    // and dropping "anything not sent" would silently destroy both.
    seedEntry(db, { tags: '["work","kind:semantic","status:canonical","auto-pattern"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "New content", tags: [] } }),
      env, ctx
    );
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("kind:semantic");
    expect(tags).toContain("status:canonical");
    expect(tags).toContain("auto-pattern");
    expect(tags).not.toContain("work");
  });

  it("leaves tags untouched when the caller says nothing about them", async () => {
    // The MCP update tool, the CLI and every integration omit the key. Reading a
    // missing key as an empty list would have all of them wiping tags on save.
    seedEntry(db, { tags: '["work","pricing"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "New content" } }),
      env, ctx
    );
    expect(JSON.parse(db.entries[0].tags).sort()).toEqual(["pricing", "work"]);
  });

  it("still accepts a #hashtag added in the same edit that removed one", async () => {
    seedEntry(db, { tags: '["work","pricing"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "New content #signpath", tags: ["work"] } }),
      env, ctx
    );
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags.sort()).toEqual(["signpath", "work"]);
  });

  it("rejects a tags field that is not a list of strings", async () => {
    seedEntry(db);
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "New content", tags: [1, 2] } }),
      env, ctx
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/tags/);
    // Refused before the write, not after it.
    expect(db.entries[0].content).toBe("Original content");
  });

  // Per-upload vector ids (T-0089.1.1): an update uploads under fresh ids, points the row at them in its
  // compare-and-set, and only then retires the ids the row listed before.
  it("re-embeds on update via upsert, under fresh ids the row then lists", async () => {
    const upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ upsert: upsertMock, insert: insertMock }),
    });
    seedEntry(db);
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Brand new content" } }),
      env, ctx
    );
    expect(upsertMock).toHaveBeenCalledOnce();
    const upsertedVectors = upsertMock.mock.calls[0][0] as any[];
    expect(upsertedVectors[0].id).not.toBe("entry-abc");
    expect(upsertedVectors[0].metadata).toMatchObject({ content: "Brand new content", parentId: "entry-abc" });
    expect(JSON.parse(db.entries.find((e: any) => e.id === "entry-abc").vector_ids)).toEqual([upsertedVectors[0].id]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("the vector the row lists after an update holds the new content, and the old one is gone (regression #208)", async () => {
    const { store, mock } = makeStatefulVectorize([
      {
        id: "entry-abc",
        values: new Array(128).fill(0.1),
        metadata: { content: "Original content", parentId: "entry-abc", chunkIndex: 0, totalChunks: 1 },
      },
    ]);
    env = makeTestEnv(db, { VECTORIZE: mock });
    seedEntry(db, { content: "Original content", vector_ids: '["entry-abc"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Brand new content" } }),
      env, ctx
    );

    const listed = JSON.parse(db.entries.find((e: any) => e.id === "entry-abc").vector_ids) as string[];
    expect(listed).toHaveLength(1);
    expect(store.get(listed[0])?.metadata.content).toBe("Brand new content");
    expect(store.has("entry-abc")).toBe(false);
  });

  // ── Vector orphan prevention ────────────────────────────────────────────────

  it("retires every id the row listed before (3.7's deterministic ids included)", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: '["entry-abc","entry-abc-chunk-1"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env, ctx
    );

    expect(deleteByIdsMock).toHaveBeenCalledOnce();
    expect(deleteByIdsMock.mock.calls[0][0]).toEqual(["entry-abc", "entry-abc-chunk-1"]);
  });

  it("never deletes the id the row now lists (the entry stays searchable)", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: '["entry-abc"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env, ctx
    );

    const listed = JSON.parse(db.entries.find((e: any) => e.id === "entry-abc").vector_ids) as string[];
    expect(listed).toHaveLength(1);
    expect(deleteByIdsMock.mock.calls.flat(2)).not.toContain(listed[0]);
    expect(deleteByIdsMock.mock.calls.flat(2)).toContain("entry-abc");
  });

  it("does not call deleteByIds when vector_ids is empty", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: "[]" });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env, ctx
    );

    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  // ── Non-fatal error handling ────────────────────────────────────────────────

  it("fails loud and leaves the entry untouched when the re-embed throws (regression #212)", async () => {
    // A failed re-embed must NOT commit new content and then delete every vector,
    // which would leave the entry silently unsearchable. Embed-first: on failure the
    // caller gets a 500 and D1 content + vectors are unchanged.
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockRejectedValue(new Error("Vectorize down")),
        deleteByIds: deleteByIdsMock,
      }),
    });
    seedEntry(db); // content: "Original content", vector_ids: ["entry-abc"]
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env, ctx
    );
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    // D1 content stays as it was — the update did not commit.
    expect(db.entries[0].content).toBe("Original content");
    // Cleanup may delete a partially accepted new vector, but never the old live id.
    expect(deleteByIdsMock.mock.calls.flatMap(call => call[0])).not.toContain("entry-abc");
  });

  it("returns ok:true even when deleteByIds throws", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("Delete failed")),
      }),
    });
    seedEntry(db, { vector_ids: '["entry-abc"]' });
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  // ── Safe ordering ───────────────────────────────────────────────────────────

  it("reads vector_ids before D1 content update (safe ordering)", async () => {
    // Seed entry with known vector_ids
    seedEntry(db, { vector_ids: '["old-vec-1","old-vec-2"]' });

    const callOrder: string[] = [];
    const deleteByIdsMock = vi.fn().mockImplementation(async (ids: string[]) => {
      callOrder.push(`delete:${ids.join(",")}`);
      return { mutationId: "m" };
    });
    const upsertMock = vi.fn().mockImplementation(async () => {
      callOrder.push("upsert");
      return { mutationId: "m" };
    });

    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ upsert: upsertMock, deleteByIds: deleteByIdsMock }),
    });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Replaced content" } }),
      env, ctx
    );

    // re-embed must happen before delete — new vectors before old ones removed
    const insertIdx = callOrder.indexOf("upsert");
    const deleteIdx = callOrder.findIndex(s => s.startsWith("delete:"));
    expect(insertIdx).toBeLessThan(deleteIdx);
    expect(callOrder[deleteIdx]).toContain("old-vec-1");
    expect(callOrder[deleteIdx]).toContain("old-vec-2");
  });
});
