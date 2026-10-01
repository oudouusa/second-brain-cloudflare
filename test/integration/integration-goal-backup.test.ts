import { createProject, updateProject } from "../../src/projects/registry";
/** INTEGRATION_GOAL E: source memories and typed edges, not a new backup format. */
import { describe, expect, it } from "vitest";
import { createR2Backup, restoreR2Backup } from "../../src/backup/r2";
import { expandGraph } from "../../src/graph/traverse";
import { resetDatabaseInit } from "../../src/db/init";
import { acquireMemoryWriteAdmission, releaseMemoryWriteAdmission,
  memoryWriteMarker, assertMemoryWritesAllowed } from "../../src/migration/write-lock";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

// In-memory transport only. Snapshot/manifest/checksum/paging/import logic and
// both SQLite databases use production code and the project's real schema.
function fakeR2() {
  const objects = new Map<string, { value: string }>();
  const bucket = {
    async put(key: string, value: string, options?: R2PutOptions) {
      if (options?.onlyIf && objects.has(key)) return null;
      objects.set(key, { value: String(value) });
      return { key };
    },
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return { key, size: new TextEncoder().encode(object.value).byteLength,
        text: async () => object.value, json: async () => JSON.parse(object.value) };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

describe("typed graph backup integration goal", () => {
  it.each([1, 2, 20])("round-trips typed graph evidence through real SQLite and paged R2 restore (page=%s)", async limit => {
    const r2 = fakeR2();
    // No fixture auto-admission: every source INSERT/UPDATE below carries a real
    // production capability, released before the snapshot barrier is acquired.
    const source = makeSqliteD1({ autoAdmitFixtureWrites: false });
    const target = makeSqliteD1({ autoAdmitFixtureWrites: false });
    const sourceEnv = makeTestEnv(undefined, {
      DB: source.db as unknown as D1Database, ARCHIVE: r2.bucket, OAUTH_KV: makeMemoryKV(),
    });
    const targetEnv = makeTestEnv(undefined, {
      DB: target.db as unknown as D1Database, ARCHIVE: r2.bucket, OAUTH_KV: makeMemoryKV(),
    });
    const edgeColumns = "id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id";
    const edges = [
      ["follows", "event-2", "event-1", 0.87, "inferred"],
      ["caused_by", "event-2", "event-0", 0.91, "system"],
      ["decided", "event-1", "event-0", 0.83, "system"],
      ["relates_to", "event-0", "event-1", 0.99, "explicit"],
    ] as const;
    try {
      resetDatabaseInit();
      for (let i = 0; i < 3; i++) source.seed({
        id: `event-${i}`, content: `SB-024 認証方式の決定 ${i}`, createdAt: 1_000 + i,
        tags: ["kind:episodic", "status:canonical"], importanceScore: 3,
      });
      const admission = await acquireMemoryWriteAdmission(sourceEnv);
      const admitted = { ...sourceEnv, WRITE_ADMISSION_TOKEN: admission.token };
      try {
        for (const ws of ["ws-alice", "ws-bob"]) {
          await createProject(admitted.DB, ws, { id: "site", name: `サイト ${ws}`, description: "設定も復元する", aliases: [ws] }, admitted);
        }
        await updateProject(admitted.DB, "ws-bob", "site", { status: "archived" }, admitted);
        for (let i = 0; i < 3; i++) await source.db.prepare(
          "UPDATE entries SET workspace_id = ?, actor_id = ?, memory_tier = ?, write_marker = ? WHERE id = ?",
        ).bind("ws-alice", "alice", i === 0 ? "hot" : "warm", memoryWriteMarker(admitted), `event-${i}`).run();
        await source.db.prepare("UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model', when_label = ?, write_marker = ? WHERE id = 'event-0'")
          .bind(1790000000000, "期限付きの作業", memoryWriteMarker(admitted)).run();
        await source.db.prepare("UPDATE entries SET when_source = 'cleared', write_marker = ? WHERE id = 'event-1'")
          .bind(memoryWriteMarker(admitted)).run();
        for (const [type, from, to, weight, provenance] of edges) {
          await source.db.prepare(
            `INSERT INTO edges (${edgeColumns}, write_marker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(`edge-${type}`, from, to, type, weight, provenance,
            JSON.stringify({ reason: "決定と根拠", evidence: { version: 1, ids: [from, to] } }),
            2_000, 3_000, "ws-alice", memoryWriteMarker(admitted)).run();
        }
      } finally {
        await releaseMemoryWriteAdmission(sourceEnv, admission);
      }
      const expected = (await source.db.prepare(`SELECT ${edgeColumns} FROM edges ORDER BY id`).all()).results;
      const projectColumns = "id, workspace_id, name, description, aliases, status, created_at, updated_at";
      const expectedProjects = (await source.db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY workspace_id, id`).all()).results;
      const originalEntries = source.rows();
      const manifest = await createR2Backup(sourceEnv, new Date("2026-09-05T00:00:00.000Z"));
      expect(manifest).toMatchObject({ format: "brain-v5", entryCount: 3, edgeCount: 4, projectCount: 2,
        embeddingProfile: { profileId: "embeddinggemma-mrl128-v1", dimensions: 128 } });
      expect(manifest.chunks?.filter(chunk => chunk.kind === "edges")).toHaveLength(1);
      expect(source.rows()).toEqual(originalEntries);
      expect((await source.db.prepare(`SELECT ${edgeColumns} FROM edges ORDER BY id`).all()).results).toEqual(expected);
      const archivedObjects = [...r2.objects].map(([key, object]) => [key, object.value]);
      resetDatabaseInit();
      let completed = false;
      const cursors: number[][] = [];
      for (let page = 0; page < 10 && !completed; page++) {
        target.issued.length = 0;
        const result = await restoreR2Backup(targetEnv, manifest.backupId, { limit });
        expect(target.issued.length).toBeLessThanOrEqual(50);
        expect(result.restore.projects_failed).toBe(0);
        expect(result.restore.failed).toBe(0);
        expect(result.restore.edges_failed).toBe(0);
        cursors.push([result.state.nextOffset, result.state.nextEdgeOffset, result.state.nextProjectOffset]);
        completed = result.state.completedAt !== undefined;
      }
      expect(completed).toBe(true);
      expect(cursors.at(-1)).toEqual([3, 4, 2]);
      for (let i = 1; i < cursors.length; i++) {
        expect(cursors[i][0]).toBeGreaterThanOrEqual(cursors[i - 1][0]);
        expect(cursors[i][1]).toBeGreaterThanOrEqual(cursors[i - 1][1]);
      }
      expect((await target.db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY workspace_id, id`).all()).results).toEqual(expectedProjects);
      expect(target.rows()).toHaveLength(3);
      expect(target.rows().find(row => row.id === "event-1")).toMatchObject({ when_at: null, when_source: "cleared" });
      expect(target.rows().find(row => row.id === "event-0")).toMatchObject({
        workspace_id: "ws-alice", actor_id: "alice", memory_tier: "hot",
        when_at: 1790000000000, when_kind: "due", when_source: "model", when_label: "期限付きの作業",
      });
      expect((await target.db.prepare(`SELECT ${edgeColumns} FROM edges ORDER BY id`).all()).results).toEqual(expected);
      // Check traversable meaning, not just JSON equality: direction, inherited
      // weight and provenance of every typed edge survive the actual restore.
      for (const [type, from, to, weight, provenance] of edges.slice(0, 3)) {
        const neighbors = await expandGraph([from], { hops: 1, type }, targetEnv);
        expect(neighbors).toEqual(expect.arrayContaining([expect.objectContaining({
          id: to, viaType: type, viaProvenance: provenance, viaWeight: weight,
          viaSourceId: from, viaTargetId: to, viaDirection: "outgoing",
        })]));
      }
      const replay = await restoreR2Backup(targetEnv, manifest.backupId, { offset: 0, edgeOffset: 0, limit });
      expect(replay.restore).toMatchObject({ imported: 0, edges_imported: 0, results: [] });
      expect((await target.db.prepare(`SELECT ${edgeColumns} FROM edges ORDER BY id`).all()).results).toEqual(expected);
      expect([...r2.objects].map(([key, object]) => [key, object.value])).toEqual(archivedObjects);
      await expect(assertMemoryWritesAllowed(targetEnv)).resolves.toBeUndefined();
      // Restore imports source memories/edges, not deployment-specific vectors.
      // Re-embedding is a separate explicit operation; do not invent AI work here.
      expect(target.rows().every(row => row.vector_ids === "[]")).toBe(true);
      expect(targetEnv.AI.run).not.toHaveBeenCalled();
      expect(targetEnv.VECTORIZE.upsert).not.toHaveBeenCalled();
      expect(targetEnv.VECTORIZE.insert).not.toHaveBeenCalled();
    } finally {
      source.close(); target.close(); resetDatabaseInit();
    }
  });

});
