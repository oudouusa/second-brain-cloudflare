import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { importAllPages as importExportPayload } from "../helpers/import-pages";
import { forgetEntry } from "../../src/capture/lifecycle";
import { deleteEntryVectors, drainPendingVectorDeletes, persistPendingVectorDeletes } from "../../src/vectorize/batch";
import { MAX_ENTRY_ID_BYTES, newVectorIds } from "../../src/vectorize/ids";
import { DEFAULTS } from "../../src/config";
import { VECTORIZE_DELETE_MAX_IDS_PER_CALL, VECTORIZE_GET_BY_IDS_BATCH } from "../../src/constants";

// T-0089.1.1 close-out, final round. (1) Every id an entry can be created with leaves room for the
// per-upload vector suffix inside Vectorize's 64-byte id limit. (2) No path deletes a vector unless
// the vector's own metadata.parentId names the entry being removed.

let t: TrashEnv;
afterEach(() => t?.close());

const bytes = (s: string) => new TextEncoder().encode(s).length;
const entry = (id: string) => ({ id, content: `memory ${id}`, source: "api", created_at: 1000 });

describe("entry ids leave room for the vector suffix", () => {
  it("every id within MAX_ENTRY_ID_BYTES fits in 64 bytes with the largest suffix (a 6-digit chunk index)", () => {
    for (const id of ["a".repeat(MAX_ENTRY_ID_BYTES), "é".repeat(MAX_ENTRY_ID_BYTES / 2), "€".repeat(Math.floor(MAX_ENTRY_ID_BYTES / 3))]) {
      expect(bytes(id)).toBeLessThanOrEqual(MAX_ENTRY_ID_BYTES);
      const ids = newVectorIds(id, 1_000_000);
      expect(bytes(ids[ids.length - 1])).toBeLessThanOrEqual(64);
    }
  });

  it("a legacy row whose id is already too long (3.7 had no bound) still gets vector ids within 64 bytes", () => {
    for (const v of newVectorIds("x".repeat(200), 3)) expect(bytes(v)).toBeLessThanOrEqual(64);
  });

  it("import keeps an id within the bound and maps a longer one to a minted id, reported as {id, original_id}", async () => {
    t = await makeTrashEnv();
    const ws = { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId };
    const fits = "k".repeat(MAX_ENTRY_ID_BYTES), long = "L".repeat(MAX_ENTRY_ID_BYTES + 1), wide = "€".repeat(21);
    const s1 = await importExportPayload(t.env, { entries: [entry(fits), entry(long), entry(wide)] }, { writeCtx: ws });
    expect(s1.imported).toBe(3);
    expect(s1.results).toContainEqual({ id: fits, status: "imported" });
    const mapped = s1.results.filter((r: any) => r.original_id) as { id: string; original_id: string }[];
    expect(mapped.map((r) => r.original_id).sort()).toEqual([long, wide].sort());
    for (const r of mapped) expect(bytes(r.id)).toBeLessThanOrEqual(MAX_ENTRY_ID_BYTES);
    // Deterministic, so a re-import of the same export skips instead of duplicating.
    const s2 = await importExportPayload(t.env, { entries: [entry(long)] }, { writeCtx: ws });
    expect(s2).toMatchObject({ imported: 0, skipped: 1 });
    // Every id in the table leaves room for the suffix.
    for (const r of await t.all<{ id: string }>(`SELECT id FROM entries`)) expect(bytes(r.id), r.id).toBeLessThanOrEqual(MAX_ENTRY_ID_BYTES);
  });

  it("an edge in the same export that names a long id follows it to the minted id", async () => {
    t = await makeTrashEnv();
    const ws = { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId };
    const long = "L".repeat(MAX_ENTRY_ID_BYTES + 5);
    const s = await importExportPayload(t.env, {
      entries: [entry(long), entry("short")],
      edges: [{ source_id: long, target_id: "short", type: "relates_to", weight: 1, provenance: "explicit", created_at: 1000 }],
    }, { writeCtx: ws });
    const minted = (s.results.find((r: any) => r.original_id === long) as any).id as string;
    expect(s.edges_imported).toBe(1);
    const edge = await t.one<{ source_id: string; target_id: string }>(`SELECT source_id, target_id FROM edges`);
    expect([edge!.source_id, edge!.target_id].sort()).toEqual([minted, "short"].sort());
  });
});

describe("a vector is deleted only by the entry its parentId names", () => {
  function vectorStore(t: TrashEnv, seeded: { id: string; parentId?: string }[]) {
    const store = new Map(seeded.map((v) => [v.id, v.parentId === undefined ? {} : { parentId: v.parentId }]));
    (t.env.VECTORIZE as any).getByIds = async (ids: string[]) => {
      if (ids.length > 20) throw new Error("getByIds takes at most 20 ids");
      return ids.filter((i) => store.has(i)).map((i) => ({ id: i, values: [], metadata: store.get(i) }));
    };
    (t.env.VECTORIZE as any).deleteByIds = async (ids: string[]) => { ids.forEach((i) => store.delete(i)); return {}; };
    return store;
  }

  it("deleteEntryVectors keeps another entry's vector, deletes the owner's, and a metadata-less vector only under its own id", async () => {
    t = await makeTrashEnv();
    const store = vectorStore(t, [
      { id: "x-chunk-0", parentId: "x-chunk-0" }, // another entry's own vector, under a name x's chunk 0 also had
      { id: "x-chunk-1", parentId: "x" },
      { id: "x" }, // 3.7-era, no metadata: its id is the owner's own
      { id: "y" }, // no metadata, some other id
    ]);
    await deleteEntryVectors(t.env, [{ entryId: "x", vectorIds: ["x-chunk-0", "x-chunk-1", "x", "y"] }]);
    expect([...store.keys()].sort()).toEqual(["x-chunk-0", "y"]);
  });

  it("checks in batches of at most 20 (Vectorize's getByIds limit)", async () => {
    t = await makeTrashEnv();
    const ids = Array.from({ length: 45 }, (_, i) => `z:${"0".repeat(8)}:${i}`);
    const store = vectorStore(t, ids.map((id) => ({ id, parentId: "z" })));
    await deleteEntryVectors(t.env, [{ entryId: "z", vectorIds: ids }]);
    expect(store.size).toBe(0);
  });

  it("FX3 finding 2: a call with no cap still deletes everything and reports done", async () => {
    t = await makeTrashEnv();
    const store = vectorStore(t, [{ id: "x", parentId: "x" }, { id: "y", parentId: "y" }]);
    const result = await deleteEntryVectors(t.env, [
      { entryId: "x", vectorIds: ["x"] },
      { entryId: "y", vectorIds: ["y"] },
    ]);
    expect(store.size).toBe(0);
    expect(result).toEqual({ done: true, remaining: [] });
  });

  it("FX3 finding 2: a capped call processes only maxIds ids and reports the rest as remaining, grouped by owner", async () => {
    t = await makeTrashEnv();
    const xIds = Array.from({ length: 3 }, (_, i) => `x:${i}`);
    const yIds = Array.from({ length: 3 }, (_, i) => `y:${i}`);
    const store = vectorStore(t, [...xIds, ...yIds].map((id) => ({ id, parentId: id.startsWith("x") ? "x" : "y" })));
    const result = await deleteEntryVectors(
      t.env,
      [{ entryId: "x", vectorIds: xIds }, { entryId: "y", vectorIds: yIds }],
      { maxIds: 4 },
    );
    // Only the first 4 of the 6 ids (claim order: x:0, x:1, x:2, y:0) were checked and deleted.
    expect(store.size).toBe(2);
    expect([...store.keys()].sort()).toEqual(["y:1", "y:2"]);
    expect(result.done).toBe(false);
    expect(result.remaining).toEqual([{ entryId: "y", vectorIds: ["y:1", "y:2"] }]);
  });

  it("FX3 finding 2: a member-removal-sized delete (~20k vectors) stays far under the platform's 1,000-subrequest ceiling when capped", async () => {
    t = await makeTrashEnv();
    const ids = Array.from({ length: 20_000 }, (_, i) => `m:${i}`);
    const store = vectorStore(t, ids.map((id) => ({ id, parentId: "m" })));
    let getByIdsCalls = 0;
    const realGetByIds = (t.env.VECTORIZE as any).getByIds.bind(t.env.VECTORIZE);
    (t.env.VECTORIZE as any).getByIds = async (batch: string[]) => { getByIdsCalls++; return realGetByIds(batch); };

    const result = await deleteEntryVectors(t.env, [{ entryId: "m", vectorIds: ids }], { maxIds: VECTORIZE_DELETE_MAX_IDS_PER_CALL });

    const expectedCalls = Math.ceil(VECTORIZE_DELETE_MAX_IDS_PER_CALL / VECTORIZE_GET_BY_IDS_BATCH);
    // 所有者確認と、台帳から削除する直前の再確認を両方数える。
    expect(getByIdsCalls).toBe(expectedCalls * 2);
    expect(getByIdsCalls + 1).toBeLessThan(100); // +1 for the single deleteByIds call; nowhere near the 1,000 ceiling
    expect(result.done).toBe(false);
    expect(store.size).toBe(20_000 - VECTORIZE_DELETE_MAX_IDS_PER_CALL);
  });

  it("FX3 finding 2: leftover ids from a capped call survive a persist/drain round trip", async () => {
    t = await makeTrashEnv();
    const ids = Array.from({ length: 10 }, (_, i) => `m:${i}`);
    const store = vectorStore(t, ids.map((id) => ({ id, parentId: "m" })));

    const first = await deleteEntryVectors(t.env, [{ entryId: "m", vectorIds: ids }], { maxIds: 4 });
    expect(first.done).toBe(false);
    await persistPendingVectorDeletes(t.env, first.remaining);
    // The 4 checked ids are gone; the other 6 are untouched and still pending.
    expect(store.size).toBe(6);

    // Draining with a cap big enough to finish clears the KV entry and the rest of the vectors.
    await drainPendingVectorDeletes(t.env, 6);
    expect(store.size).toBe(0);

    // A second drain with nothing pending is a no-op, not an error.
    await drainPendingVectorDeletes(t.env, 6);
    expect(store.size).toBe(0);
  });

  it("FX3 finding 2: a drain that is itself capped short writes back only what is still left", async () => {
    t = await makeTrashEnv();
    const ids = Array.from({ length: 10 }, (_, i) => `m:${i}`);
    vectorStore(t, ids.map((id) => ({ id, parentId: "m" })));
    await persistPendingVectorDeletes(t.env, [{ entryId: "m", vectorIds: ids }]);

    await drainPendingVectorDeletes(t.env, 4);
    const raw = await t.env.OAUTH_KV.get("vectorize:pending-deletes");
    const stored = JSON.parse(raw!) as { entryId: string; vectorIds: string[] }[];
    expect(stored).toEqual([{ entryId: "m", vectorIds: ids.slice(4) }]);
  });

  it("forgetting a legacy row whose listed chunk id is another entry's own vector leaves that vector alone", async () => {
    t = await makeTrashEnv();
    t.seed("x", { vector_ids: '["x","x-chunk-0"]' });
    t.seed("x-chunk-0", { vector_ids: '["x-chunk-0"]' });
    const store = vectorStore(t, [{ id: "x", parentId: "x" }, { id: "x-chunk-0", parentId: "x-chunk-0" }]);
    await forgetEntry("x", t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, t.roots.ownerPersonalWorkspaceId);
    expect(store.has("x-chunk-0")).toBe(true);
    expect(store.has("x")).toBe(false);
  });
});

describe("structural", () => {
  const SRC = join(import.meta.dirname, "../../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const all = files(SRC).map((p) => ({ file: p.slice(SRC.length + 1), src: readFileSync(p, "utf8") }));

  it("every Vectorize delete goes through the parentId-checked helper", () => {
    for (const f of all) {
      if (f.file === "vectorize/batch.ts") continue;
      if (f.file === "vectorize/cleanup.ts") {
        expect(f.src.match(/\.deleteByIds\([^)]*\)/g)).toEqual([".deleteByIds(vectorIds)"]);
        expect(f.src).toContain("await excludeForeignVectors");
        expect(f.src).toContain("async function deleteVectorsWithRetry");
        expect(f.src).not.toContain("export async function deleteVectorsWithRetry");
        expect(f.src).toContain("await authorizeVectorMutation");
        continue;
      }
      expect(f.src, f.file).not.toMatch(/\.deleteByIds\(/);
      expect(f.src, f.file).not.toMatch(/\bdeleteVectorIds\b/);
    }
    const batch = all.find((f) => f.file === "vectorize/batch.ts")!.src;
    // 低水準の送信はcleanupだけが使う。一般の呼出元は所有者確認付きAPIを使う。
    expect(all.filter(f => f.file !== "vectorize/batch.ts" && /\bdeleteVectorIds\b/.test(f.src)).map(f => f.file))
      .toEqual(["vectorize/cleanup.ts"]);
    expect(batch).toMatch(/export async function deleteEntryVectors/);
  });

  it("import bounds caller-chosen ids with the shared constant", () => {
    expect(all.find((f) => f.file === "entries/import.ts")!.src).toMatch(/await boundedEntryId\(parsed\.row\.id\)/);
    expect(all.find((f) => f.file === "vectorize/ids.ts")!.src).toMatch(/if \(byteLength\(id\) <= MAX_ENTRY_ID_BYTES\) return id;/);
  });
});
