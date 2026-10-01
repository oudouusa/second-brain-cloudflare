import { EXPORT_COMPLETE_MAX_ROWS, EXPORT_COMPLETE_MAX_ESTIMATED_BYTES } from "../../src/entries/export";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  createR2Backup,
  listR2Backups,
  restoreR2Backup,
  sha256Hex,
  MAX_BACKUP_CHUNK_BYTES,
  type BackupManifest,
} from "../../src/backup/r2";
import { MIGRATION_KEY, readMigration } from "../../src/migration/embedding";
import { makeMemoryKV, makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { resetDatabaseInit } from "../../src/db/init";
import { IMPORT_DEFAULT_LIMIT } from "../../src/entries/import";
import {
  acquireMemoryWriteAdmission,
  assertMemoryWritesAllowed,
  beginMemoryWriteAdmission,
  releaseMemoryWriteAdmission,
  setMemoryWriteLock,
} from "../../src/migration/write-lock";
import { ACCRUAL_CURSOR_KEY } from "../../src/insight/candidates";
import { TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";
import {
  deleteIntegration,
  loadIntegration,
  saveIntegration,
  type IntegrationRecord,
} from "../../src/integrations/framework";

type Stored = { value: string; customMetadata?: Record<string, string>; uploaded: Date };

function fakeR2() {
  const objects = new Map<string, Stored>();
  const bucket = {
    async put(key: string, value: string, options?: R2PutOptions) {
      if (options?.onlyIf && objects.has(key)) return null;
      objects.set(key, {
        value: String(value),
        customMetadata: options?.customMetadata,
        uploaded: new Date(),
      });
      return { key };
    },
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        key,
        size: new TextEncoder().encode(object.value).byteLength,
        uploaded: object.uploaded,
        customMetadata: object.customMetadata,
        text: async () => object.value,
        json: async <T>() => JSON.parse(object.value) as T,
      };
    },
    async list(options: R2ListOptions = {}) {
      const rows = [...objects.entries()]
        .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
        .map(([key, object]) => ({
          key,
          uploaded: object.uploaded,
          customMetadata: object.customMetadata,
        }));
      return { objects: rows, truncated: false };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

function manifestFingerprint(manifest: BackupManifest): string {
  return JSON.stringify({
    format: manifest.format,
    workerVersion: manifest.workerVersion,
    createdAt: manifest.createdAt,
    entryCount: manifest.entryCount,
    edgeCount: manifest.edgeCount,
    ...(manifest.format === "brain-v5" ? { projectCount: manifest.projectCount } : {}),
    ...(manifest.format === "brain-v5" ? { historyCount: manifest.historyCount } : {}),
    embeddingProfile: manifest.embeddingProfile,
    backupId: manifest.backupId,
    chunks: manifest.chunks ?? [],
  });
}

function entryChunkKey(manifest: BackupManifest): string {
  const key = manifest.chunks?.find(chunk => chunk.kind === "entries")?.key;
  if (!key) throw new Error("test backup has no entry chunk");
  return key;
}

async function rewriteEntryChunk(
  r2: ReturnType<typeof fakeR2>,
  manifest: BackupManifest,
  mutate: (chunk: { entries: Array<Record<string, unknown>> }) => void,
): Promise<void> {
  const descriptor = manifest.chunks?.find(chunk => chunk.kind === "entries");
  if (!descriptor) throw new Error("test backup has no entry chunk");
  const object = r2.objects.get(descriptor.key);
  if (!object) throw new Error("test entry chunk is missing");
  const chunk = JSON.parse(object.value) as { entries: Array<Record<string, unknown>> };
  mutate(chunk);
  object.value = JSON.stringify(chunk);
  descriptor.bytes = new TextEncoder().encode(object.value).byteLength;
  descriptor.sha256 = await sha256Hex(object.value);
  manifest.sha256 = await sha256Hex(manifestFingerprint(manifest));
  r2.objects.get(`backups/${manifest.backupId}/manifest.json`)!.value = JSON.stringify(manifest);
}

function seededEnv(r2: R2Bucket, count = 2) {
  const db = makeTestDb();
  for (let i = 0; i < count; i++) {
    db.entries.push({
      id: `e-${i}`,
      content: `memory ${i}`,
      tags: JSON.stringify(["backup"]),
      source: "api",
      created_at: 1000 + i,
      updated_at: 2000 + i,
      vector_ids: '["deployment-vector"]',
      recall_count: i,
      importance_score: i,
      contradiction_wins: 0,
      contradiction_losses: 0,
      memory_tier: i === 0 ? "hot" : "cold",
      pinned: i === 0 ? 1 : 0,
      last_recalled_at: 3000 + i,
    });
  }
  return { db, env: makeTestEnv(db, { ARCHIVE: r2, OAUTH_KV: makeMemoryKV() }) };
}

describe("manual R2 backup and restore", () => {
  it("writes immutable brain-v5 chunks plus a SHA-256 manifest under the UTC date path", async () => {
    const r2 = fakeR2();
    const { env } = seededEnv(r2.bucket);
    const manifest = await createR2Backup(env, new Date("2026-08-25T12:34:56.000Z"));

    expect(manifest.backupId).toBe("2026/08/1787661296000");
    expect(manifest).toMatchObject({
      format: "brain-v5",
      entryCount: 2,
      edgeCount: 0,
      embeddingProfile: { profileId: "embeddinggemma-mrl128-v1", dimensions: 128 },
    });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...r2.objects.keys()].sort()).toEqual([
      `backups/${manifest.backupId}/chunks/entries-000000000000.json`,
      `backups/${manifest.backupId}/manifest.json`,
    ]);
    expect((await listR2Backups(env))[0]).toMatchObject({ backupId: manifest.backupId, entryCount: 2 });
  });

  it("preserves entry authorship and workspace ownership across trusted R2 restore", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    for (const entry of source.db.entries) {
      entry.workspace_id = "ws-alice";
      entry.actor_id = "user-alice";
    }
    source.db.edges.push({
      id: "edge-team",
      source_id: "e-0",
      target_id: "e-1",
      type: "relates_to",
      weight: 0.8,
      provenance: "explicit",
      metadata: "{}",
      created_at: 4_000,
      updated_at: 4_000,
      workspace_id: "ws-alice",
    });
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);

    let completed = false;
    for (let page = 0; page < 4 && !completed; page++) {
      const result = await restoreR2Backup(target.env, manifest.backupId);
      completed = result.state.completedAt !== undefined;
    }

    expect(completed).toBe(true);
    expect(target.db.entries).toHaveLength(2);
    expect(target.db.entries.every(entry => entry.workspace_id === "ws-alice"
      && entry.actor_id === "user-alice")).toBe(true);
    expect(target.db.edges).toHaveLength(1);
    expect(target.db.edges[0].workspace_id).toBe("ws-alice");
  });

  it("reads deterministic pages behind the snapshot barrier without materialising the whole brain", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    let batchCalls = 0;
    const originalBatch = source.env.DB.batch.bind(source.env.DB);
    source.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      batchCalls++;
      return originalBatch(statements);
    }) as D1Database["batch"];

    await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));

    // Only the barrier claim is a batch; table pages are read independently while
    // that exclusive fence remains owned by this backup.
    expect(batchCalls).toBe(1);
  });

  it("never overwrites an archive object when a backup ID collides", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    const now = new Date("2026-08-25T12:34:56.000Z");
    const first = await createR2Backup(source.env, now);
    const firstChunk = entryChunkKey(first);
    const original = r2.objects.get(firstChunk)?.value;
    source.db.entries[0].content = "replacement that must not win";

    await expect(createR2Backup(source.env, now)).rejects.toMatchObject({ status: 409 });
    expect(r2.objects.get(firstChunk)?.value).toBe(original);
  });

  it("backs up more rows than the former whole-brain ceiling", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, EXPORT_COMPLETE_MAX_ROWS + 1);
    for (const entry of source.db.entries) entry.content = `memory ${entry.id} ${"x".repeat(10_000)}`;
    let batchCalls = 0;
    const originalBatch = source.env.DB.batch.bind(source.env.DB);
    source.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      batchCalls++;
      return originalBatch(statements);
    }) as D1Database["batch"];

    const manifest = await createR2Backup(source.env);
    expect(manifest).toMatchObject({ format: "brain-v5", entryCount: EXPORT_COMPLETE_MAX_ROWS + 1 });
    expect(manifest.chunks?.filter(chunk => chunk.kind === "entries").length).toBeGreaterThan(1);
    expect(batchCalls).toBe(1);

    const target = seededEnv(r2.bucket, 0);
    let calls = 0;
    let completed = false;
    while (!completed && calls < 100) {
      const page = await restoreR2Backup(target.env, manifest.backupId);
      calls++;
      completed = page.state.completedAt !== undefined;
    }
    expect(completed).toBe(true);
    expect(calls).toBeGreaterThan(1);
    expect(target.db.entries).toHaveLength(EXPORT_COMPLETE_MAX_ROWS + 1);
  }, 15_000);

  it("rejects an externally replaced archive above the restore row limit before touching D1", async () => {
    const r2 = fakeR2();
    const backupId = "2026/08/1787661296999";
    const brainKey = `backups/${backupId}/brain-v2.json`;
    const manifestKey = `backups/${backupId}/manifest.json`;
    const payload = JSON.stringify({
      version: 2,
      entries: Array.from({ length: EXPORT_COMPLETE_MAX_ROWS + 1 }, (_, i) => ({
        id: `tiny-${i}`, content: "x", created_at: i,
      })),
      edges: [],
    });
    const manifest = {
      format: "brain-v2",
      workerVersion: "legacy-test",
      createdAt: "2026-08-25T12:34:56.999Z",
      backupId,
      brainKey,
      sha256: await sha256Hex(payload),
      entryCount: EXPORT_COMPLETE_MAX_ROWS + 1,
      edgeCount: 0,
      embeddingProfile: {
        profileId: "embeddinggemma-mrl128-v1",
        model: "@cf/google/embeddinggemma-300m",
        rawDimensions: 768,
        dimensions: 128,
        promptVersion: 1,
      },
    };
    await r2.bucket.put(brainKey, payload);
    await r2.bucket.put(manifestKey, JSON.stringify(manifest));
    const target = seededEnv(r2.bucket, 0);

    await expect(restoreR2Backup(target.env, backupId)).rejects.toMatchObject({ status: 413 });
    expect(target.db.entries).toHaveLength(0);
    expect(target.db.restoreState).toBeNull();
  });

  it("refuses a new restore when the destination Vectorize index is not empty", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    target.env.VECTORIZE = makeVectorizeMock({
      describe: vi.fn().mockResolvedValue({ vectorCount: 1 }),
    });

    await expect(restoreR2Backup(target.env, manifest.backupId)).rejects.toMatchObject({ status: 409 });
    expect(target.db.entries).toHaveLength(0);
    expect(target.db.restoreState).toBeNull();
  });

  it("refuses a new restore when an insight candidate survives in the destination D1", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    target.db.insightCandidates.push({ id: "stale-candidate" });

    await expect(restoreR2Backup(target.env, manifest.backupId)).rejects.toMatchObject({ status: 409 });
    expect(target.db.entries).toHaveLength(0);
    expect(target.db.restoreState).toBeNull();
  });

  it("refuses a new restore while a Vectorize cleanup tombstone is still pending", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    target.db.vectorCleanupOps.push({
      op_id: "pending-delete",
      entry_id: "forgotten-entry",
      vector_ids: JSON.stringify(["possibly-late-vector"]),
      created_at: Date.now(),
      ready: 3,
      expires_at: Date.now() + 60_000,
    });

    await expect(restoreR2Backup(target.env, manifest.backupId)).rejects.toMatchObject({ status: 409 });
    expect(target.db.entries).toHaveLength(0);
    expect(target.db.restoreState).toBeNull();
  });

  it("invalidates shared insight and tag caches before importing a restore page", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const kv = makeMemoryKV();
    await kv.put(ACCRUAL_CURSOR_KEY, JSON.stringify({ createdAt: 99, id: "retired-d1" }));
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["retired"], rebuiltAt: Date.now() }));
    const db = makeTestDb();
    const env = makeTestEnv(db, { ARCHIVE: r2.bucket, OAUTH_KV: kv });

    await restoreR2Backup(env, manifest.backupId, { limit: 1 });

    expect(await kv.get(ACCRUAL_CURSOR_KEY)).toBeNull();
    expect(await kv.get(TAG_VOCABULARY_KEY)).toBeNull();
    expect(db.entries).toHaveLength(1);
  });

  it("backs up edge metadata beyond the former whole-brain byte estimate", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    source.db.edges.push({
      id: "large-metadata-edge",
      source_id: "e-0",
      target_id: "e-1",
      type: "relates_to",
      weight: 0.5,
      provenance: "explicit",
      metadata: JSON.stringify({ note: "x".repeat(EXPORT_COMPLETE_MAX_ESTIMATED_BYTES / 6) }),
      created_at: 1,
      updated_at: 1,
    });
    let batchCalls = 0;
    const originalBatch = source.env.DB.batch.bind(source.env.DB);
    source.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      batchCalls++;
      return originalBatch(statements);
    }) as D1Database["batch"];

    const manifest = await createR2Backup(source.env);
    expect(manifest).toMatchObject({ format: "brain-v5", entryCount: 2, edgeCount: 1 });
    expect(manifest.chunks?.some(chunk => chunk.kind === "edges")).toBe(true);
    expect(batchCalls).toBe(1);
  });

  it("rejects a legacy dangling edge before creating an unrestorable archive", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    source.db.edges.push({
      id: "dangling", source_id: "e-0", target_id: "missing", type: "relates_to",
      weight: 0.5, provenance: "explicit", metadata: "{}", created_at: 1, updated_at: 1,
    });

    await expect(createR2Backup(source.env)).rejects.toMatchObject({ status: 409 });
    expect(r2.objects.size).toBe(0);
  });

  it("preserves leading whitespace and trailing newlines byte-for-byte through restore", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const exact = "  indented Markdown\n\n```ts\nconst x = 1;\n```\n\n";
    source.db.entries[0].content = exact;
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);

    await restoreR2Backup(target.env, manifest.backupId);

    expect(target.db.entries[0].content).toBe(exact);
  });

  it("rejects one row larger than a bounded chunk and removes partial objects", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    source.db.edges.push({
      id: "serialized-limit-edge",
      source_id: "e-0",
      target_id: "e-1",
      type: "relates_to",
      weight: 0.5,
      provenance: "explicit",
      metadata: JSON.stringify({ note: "x".repeat(MAX_BACKUP_CHUNK_BYTES + 1) }),
      created_at: 1,
      updated_at: 1,
    });
    await expect(createR2Backup(source.env)).rejects.toMatchObject({ status: 413 });
    expect(r2.objects.size).toBe(0);
  });

  it("rejects an oversized R2 chunk before reading it into Worker memory", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    r2.objects.get(entryChunkKey(manifest))!.value = "x".repeat(MAX_BACKUP_CHUNK_BYTES + 1);
    const target = seededEnv(r2.bucket, 0);

    await expect(restoreR2Backup(target.env, manifest.backupId)).rejects.toMatchObject({ status: 413 });
    expect(target.db.restoreState).toBeNull();
  });

  it("rejects a missing manifest chunk before touching D1", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    r2.objects.delete(entryChunkKey(manifest));
    const target = seededEnv(r2.bucket, 0);

    await expect(restoreR2Backup(target.env, manifest.backupId)).rejects.toMatchObject({ status: 404 });
    expect(target.db.restoreState).toBeNull();
  });

  it("rejects non-contiguous manifest offsets before touching D1", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    manifest.chunks![0].start = 1;
    r2.objects.get(`backups/${manifest.backupId}/manifest.json`)!.value = JSON.stringify(manifest);
    const target = seededEnv(r2.bucket, 0);

    await expect(restoreR2Backup(target.env, manifest.backupId)).rejects.toMatchObject({ status: 422 });
    expect(target.db.restoreState).toBeNull();
  });

  it("pins the verified SHA so a resumed restore cannot mix object versions", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    await restoreR2Backup(target.env, manifest.backupId, { limit: 1 });

    await rewriteEntryChunk(r2, manifest, chunk => {
      chunk.entries[1].content = "same count, different backup version";
    });

    await expect(restoreR2Backup(target.env, manifest.backupId))
      .rejects.toThrow(/backup changed/i);
    expect(target.db.entries).toHaveLength(1);
    expect(target.db.restoreState?.next_offset).toBe(1);
  });

  it("restores in resumable pages, preserves tier fields, and is idempotent", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 45);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);

    const first = await restoreR2Backup(target.env, manifest.backupId);
    expect(first.restore.imported).toBe(IMPORT_DEFAULT_LIMIT);
    expect(first.restore.remaining_entries).toBe(45 - IMPORT_DEFAULT_LIMIT);
    const second = await restoreR2Backup(target.env, manifest.backupId);
    expect(second.restore.imported).toBe(IMPORT_DEFAULT_LIMIT);
    expect(second.state.completedAt).toBeUndefined();
    const third = await restoreR2Backup(target.env, manifest.backupId);
    expect(third.restore.imported).toBe(IMPORT_DEFAULT_LIMIT);
    expect(third.state.completedAt).toBeUndefined();
    const fourth = await restoreR2Backup(target.env, manifest.backupId);
    expect(fourth.restore.imported).toBe(45 - 3 * IMPORT_DEFAULT_LIMIT);
    expect(fourth.state.completedAt).toEqual(expect.any(Number));
    expect(target.db.entries).toHaveLength(45);
    expect(target.db.entries.find(row => row.id === "e-0")).toMatchObject({
      memory_tier: "hot",
      pinned: 1,
      last_recalled_at: 3000,
      vector_ids: "[]",
    });

    const completedGeneration = target.db.embeddingMigrationGeneration;
    const replay = await restoreR2Backup(target.env, manifest.backupId, { offset: 0, edgeOffset: 0 });
    expect(replay.restore.skipped).toBe(0);
    expect(replay.restore.results).toEqual([]);
    expect(target.db.entries).toHaveLength(45);
    expect(target.db.embeddingMigrationGeneration).toBe(completedGeneration);
    expect(target.db.restoreState).toMatchObject({
      backup_id: manifest.backupId,
      next_offset: 45,
      completed_at: expect.any(Number),
    });
  });

  it("treats a completed restore retry as a no-op after live data has changed", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    await restoreR2Backup(target.env, manifest.backupId);
    target.db.entries = target.db.entries.filter(row => row.id !== "e-0");
    target.db.entries.push({
      id: "live-after-restore",
      content: "new live memory",
      tags: "[]",
      source: "api",
      created_at: 9999,
      updated_at: 9999,
      vector_ids: "[]",
    });

    const retry = await restoreR2Backup(target.env, manifest.backupId, { offset: 0, edgeOffset: 0 });

    expect(retry.restore).toMatchObject({ imported: 0, skipped: 0, remaining_entries: 0 });
    expect(target.db.entries.some(row => row.id === "e-0")).toBe(false);
    expect(target.db.entries.some(row => row.id === "live-after-restore")).toBe(true);
  });

  it("treats a completed empty backup retry as a no-op", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 0);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);

    const completed = await restoreR2Backup(target.env, manifest.backupId);
    const completedGeneration = target.db.embeddingMigrationGeneration;
    const completedRunId = target.db.restoreState?.run_id;
    const retry = await restoreR2Backup(target.env, manifest.backupId, { offset: 0, edgeOffset: 0 });

    expect(completed.state.completedAt).toEqual(expect.any(Number));
    expect(retry.restore).toMatchObject({ imported: 0, skipped: 0, remaining_entries: 0 });
    expect(retry.state.completedAt).toBe(completed.state.completedAt);
    expect(target.db.embeddingMigrationGeneration).toBe(completedGeneration);
    expect(target.db.restoreState?.run_id).toBe(completedRunId);
  });

  it("refuses to restart a completed restore when only derived D1 state remains", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    await restoreR2Backup(target.env, manifest.backupId);
    target.db.entries = [];
    target.db.vectorCleanupOps.push({
      op_id: "remaining-cleanup",
      entry_id: "old",
      vector_ids: "[]",
      created_at: 1,
      ready: 3,
      expires_at: Date.now() + 60_000,
    });

    await expect(restoreR2Backup(target.env, manifest.backupId, { offset: 0 }))
      .rejects.toMatchObject({ status: 409 });
    expect(target.db.entries).toEqual([]);
  });

  it("takes a new exclusive barrier for a snapshot and never borrows an existing lock", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const existing = await setMemoryWriteLock(source.env, "another-maintenance-task");

    await expect(createR2Backup(source.env)).rejects.toMatchObject({ status: 423 });

    expect(source.db.migrationControl?.owner_id).toBe(existing.ownerId);
    expect(r2.objects.size).toBe(0);
  });

  it("never takes over or clears an ownerless legacy migration lock", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    source.db.migrationControl = {
      id: "memory-write-lock",
      locked_at: 1,
      reason: "legacy-final-delta",
      owner_id: null,
      final_delta_completed_at: null,
      active_delta_token: null,
      active_delta_expires_at: null,
    };

    await expect(createR2Backup(source.env)).rejects.toMatchObject({ status: 423 });

    expect(source.db.migrationControl).toMatchObject({
      reason: "legacy-final-delta",
      owner_id: null,
    });
    expect(r2.objects.size).toBe(0);
  });

  it("refuses a backup while an integration is connected", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const record: IntegrationRecord = {
      provider: "notion",
      authKind: "token",
      credentials: { token: "must-never-enter-r2" },
      config: {},
      status: "connected",
      workspaceName: "workspace",
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 10,
      updatedAt: 10,
    };
    await source.env.OAUTH_KV.put("integrations:notion", JSON.stringify(record));

    await expect(createR2Backup(source.env)).rejects.toMatchObject({ status: 409 });

    expect(r2.objects.size).toBe(0);
  });

  it("refuses a backup containing integration mirrors even after disconnect", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    source.db.entries[0].source = "notion";

    await expect(createR2Backup(source.env)).rejects.toMatchObject({ status: 409 });

    expect(r2.objects.size).toBe(0);
  });

  it("refuses a backup when whitespace disguises an integration mirror source", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    source.db.entries[0].source = "\u00a0notion\u00a0";

    await expect(createR2Backup(source.env)).rejects.toMatchObject({ status: 409 });
    expect(r2.objects.size).toBe(0);
  });

  it("invalidates a stale integration KV blob after restore and accepts only a reconnect", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = makeTestDb();
    const oldGeneration = target.integrationStateGeneration!.generation;
    const kv = makeMemoryKV();
    const env = makeTestEnv(target, { ARCHIVE: r2.bucket, OAUTH_KV: kv });

    await restoreR2Backup(env, manifest.backupId);
    expect(target.integrationStateGeneration).toMatchObject({ restore_count: 1 });
    expect(target.integrationStateGeneration!.generation).not.toBe(oldGeneration);

    const stale: IntegrationRecord = {
      provider: "notion",
      authKind: "token",
      credentials: { token: "stale-secret" },
      config: {},
      status: "connected",
      workspaceName: "old workspace",
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 1,
      updatedAt: 1,
      stateGeneration: oldGeneration,
    };
    await kv.put("integrations:notion", JSON.stringify(stale));
    expect(await loadIntegration(env, "notion")).toBeNull();

    const reconnect = { ...stale, credentials: { token: "new-secret" }, stateGeneration: undefined };
    const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext;
    const admitted = await beginMemoryWriteAdmission(env, ctx);
    await saveIntegration(admitted.env, reconnect);
    await admitted.finish();
    expect((await loadIntegration(env, "notion"))?.credentials.token).toBe("new-secret");
  });

  it("rejects delayed pre-restore connect and disconnect mutations before they can touch the new generation key", async () => {
    const db = makeTestDb();
    const kv = makeMemoryKV();
    const env = makeTestEnv(db, { OAUTH_KV: kv });
    const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext;
    const oldRequest = await beginMemoryWriteAdmission(env, ctx);
    const oldGeneration = db.integrationStateGeneration!.generation;

    // Simulate the atomic D1 rotations performed by a completed restore while
    // the old invocation was suspended in an external provider call.
    db.memoryWriteEpoch = "post-restore-write-epoch";
    db.integrationStateGeneration = { generation: "post-restore-integration", restore_count: 1 };
    const currentRequest = await beginMemoryWriteAdmission(env, ctx);
    const current: IntegrationRecord = {
      provider: "notion",
      authKind: "token",
      credentials: { token: "current-secret" },
      config: {},
      status: "connected",
      workspaceName: "current workspace",
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 2,
      updatedAt: 2,
    };
    await saveIntegration(currentRequest.env, current);

    const delayed = { ...current, credentials: { token: "old-secret" }, stateGeneration: undefined };
    await expect(saveIntegration(oldRequest.env, delayed)).rejects.toMatchObject({ status: 423 });
    await expect(deleteIntegration(oldRequest.env, "notion")).rejects.toMatchObject({ status: 423 });

    expect(await kv.get(`integrations:notion:${oldGeneration}`)).toBeNull();
    const providerGeneration = db.integrationProviderGenerations.get("notion")!.generation;
    expect(JSON.parse((await kv.get(`integrations:notion:post-restore-integration:${providerGeneration}`))!)
      .credentials.token).toBe("current-secret");
    await currentRequest.finish();
    await oldRequest.finish();
  });

  it("repairs an interrupted integration generation seed exactly when the singleton is absent", async () => {
    const d1 = makeSqliteD1();
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: kv });
    await d1.db.prepare(
      `DELETE FROM integration_state_generation WHERE id = 'current'`,
    ).run();
    await kv.put("integrations:notion", JSON.stringify({
      provider: "notion",
      authKind: "token",
      credentials: { token: "legacy-secret" },
      config: {},
      status: "connected",
      workspaceName: "legacy workspace",
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 1,
      updatedAt: 1,
    } satisfies IntegrationRecord));

    expect((await loadIntegration(env, "notion"))?.stateGeneration).toMatch(/^[0-9a-f]{32}$/);
    const repaired = await d1.db.prepare(
      `SELECT generation, restore_count FROM integration_state_generation WHERE id = 'current'`,
    ).first() as { generation: string; restore_count: number } | null;
    expect(repaired).toMatchObject({ restore_count: 0 });
    expect(repaired?.generation).toMatch(/^[0-9a-f]{32}$/);
    d1.close();
  });

  it("refuses an archive whose payload contains an integration mirror", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    await rewriteEntryChunk(r2, manifest, chunk => { chunk.entries[0].source = "notion"; });
    const target = makeTestEnv(makeTestDb(), { ARCHIVE: r2.bucket, OAUTH_KV: makeMemoryKV() });

    await expect(restoreR2Backup(target, manifest.backupId)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an archive whose integration source is whitespace-padded", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    await rewriteEntryChunk(r2, manifest, chunk => { chunk.entries[0].source = "  notion  "; });
    const target = makeTestEnv(makeTestDb(), { ARCHIVE: r2.bucket, OAUTH_KV: makeMemoryKV() });

    await expect(restoreR2Backup(target, manifest.backupId)).rejects.toMatchObject({ status: 409 });
  });

  it("can restore a newer backup after the same destination D1 is emptied", async () => {
    const r2 = fakeR2();
    const sourceA = seededEnv(r2.bucket, 1);
    const backupA = await createR2Backup(sourceA.env, new Date("2026-08-25T12:34:56.000Z"));
    const sourceB = seededEnv(r2.bucket, 2);
    sourceB.db.entries[0].content = "newer backup content";
    const backupB = await createR2Backup(sourceB.env, new Date("2026-08-26T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);

    await restoreR2Backup(target.env, backupA.backupId);
    expect(target.db.restoreState?.backup_id).toBe(backupA.backupId);

    const staleGeneration = "generation-before-reuse";
    target.db.embeddingMigrationGeneration = staleGeneration;
    await target.env.OAUTH_KV.put(MIGRATION_KEY, JSON.stringify({
      generation: staleGeneration,
      model: "@cf/google/embeddinggemma-300m",
      dimensions: 128,
      promptVersion: 1,
      profileId: "embeddinggemma-300m-eg128-v1",
      startedAt: 1,
      cursorCreatedAt: 9_999_999,
      cursorId: "z",
      processed: 1,
      failed: 0,
      totalAtStart: 1,
    }));

    target.db.entries = [];
    target.db.edges = [];
    const restored = await restoreR2Backup(target.env, backupB.backupId);

    expect(restored.restore.imported).toBe(2);
    expect(restored.state.backupId).toBe(backupB.backupId);
    expect(target.db.restoreState?.backup_id).toBe(backupB.backupId);
    expect(target.db.embeddingMigrationGeneration).not.toBe(staleGeneration);
    expect(await readMigration(target.env)).toBeNull();
    expect(target.db.entries).toHaveLength(2);
    expect(target.db.entries.find(row => row.id === "e-0")?.content).toBe("newer backup content");
  });

  it.each([false, true])("旧復元cursorを古い順・新しい順のarchiveで完了させ世代を更新する (descending=%s)", async descending => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    // 旧archiveの新しい順も、そのファイル内位置で再開する。
    if (descending) await rewriteEntryChunk(r2, manifest, chunk => { chunk.entries.reverse(); });
    target.db.entries.push({ ...source.db.entries[descending ? 1 : 0], vector_ids: "[]" });
    target.db.restoreState = {
      id: "r2-v1",
      backup_id: manifest.backupId,
      backup_sha256: manifest.sha256,
      run_id: "legacy-run",
      started_at: 1,
      next_offset: 1,
      next_edge_offset: 0,
      completed_at: null,
      lease_owner: null,
      lease_expires_at: null,
    };
    const staleGeneration = "legacy-generation";
    target.db.embeddingMigrationGeneration = staleGeneration;
    await target.env.OAUTH_KV.put(MIGRATION_KEY, JSON.stringify({
      generation: staleGeneration,
      model: "@cf/google/embeddinggemma-300m",
      dimensions: 128,
      promptVersion: 1,
      profileId: "embeddinggemma-300m-eg128-v1",
      startedAt: 1,
      cursorCreatedAt: 999,
      cursorId: "z",
      processed: 1,
      failed: 0,
      totalAtStart: 1,
    }));

    const restored = await restoreR2Backup(target.env, manifest.backupId);

    expect(restored.state.completedAt).toEqual(expect.any(Number));
    expect(target.db.embeddingMigrationGeneration).not.toBe(staleGeneration);
    expect(await readMigration(target.env)).toBeNull();
    expect(target.db.entries).toHaveLength(2);
  });

  it("rejects switching backups while the destination D1 still contains restored data", async () => {
    const r2 = fakeR2();
    const sourceA = seededEnv(r2.bucket, 1);
    const backupA = await createR2Backup(sourceA.env, new Date("2026-08-25T12:34:56.000Z"));
    const sourceB = seededEnv(r2.bucket, 1);
    const backupB = await createR2Backup(sourceB.env, new Date("2026-08-26T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);

    await restoreR2Backup(target.env, backupA.backupId);

    await expect(restoreR2Backup(target.env, backupB.backupId))
      .rejects.toThrow(/empty D1 database/);
    expect(target.db.restoreState?.backup_id).toBe(backupA.backupId);
  });

  it("verifies R2 completely before leaving any D1 changes", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const chunk = r2.objects.get(entryChunkKey(manifest))!;
    chunk.value = chunk.value.replace("memory 0", "tampered");
    const target = seededEnv(r2.bucket, 0);
    let d1Queries = 0;
    const prepare = target.env.DB.prepare.bind(target.env.DB);
    target.env.DB.prepare = ((sql: string) => {
      d1Queries++;
      return prepare(sql);
    }) as D1Database["prepare"];

    const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
    const response = await worker.fetch(
      req("POST", `/admin/restore/${encodeURIComponent(manifest.backupId)}`),
      target.env,
      ctx,
    );
    expect(response.status).toBe(422);
    expect(target.db.entries).toHaveLength(0);
    expect(d1Queries).toBe(0);
  });

  it("does not advance the cursor on a failed page and succeeds on retry", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    target.db.failEntryInsertIds.add("e-0");

    await expect(restoreR2Backup(target.env, manifest.backupId, { limit: 1 }))
      .rejects.toThrow(/cursor was not advanced/);
    expect(target.db.restoreState).toMatchObject({ next_offset: 0, completed_at: null });

    target.db.failEntryInsertIds.clear();
    const retry = await restoreR2Backup(target.env, manifest.backupId, { limit: 1 });
    expect(retry.restore.imported).toBe(1);
    expect(retry.state).toMatchObject({ nextOffset: 1, completedAt: expect.any(Number) });
    expect(target.db.entries).toHaveLength(1);
  });

  it("rejects forward offsets without moving the durable cursor", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);

    await expect(restoreR2Backup(target.env, manifest.backupId, { offset: 1 }))
      .rejects.toThrow(/durable cursor/);
    await expect(restoreR2Backup(target.env, manifest.backupId, { edgeOffset: 1 }))
      .rejects.toThrow(/durable cursor/);
    expect(target.db.restoreState).toMatchObject({ next_offset: 0, next_edge_offset: 0, completed_at: null });
    expect(target.db.entries).toHaveLength(0);
  });

  it("keeps the cursor unchanged when an edge in the page fails", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    source.db.edges.push({
      id: "bad-edge",
      source_id: "e-0",
      target_id: "e-1",
      type: "relates_to",
      weight: 0.5,
      provenance: "explicit",
      metadata: "{}",
      created_at: 1000,
      updated_at: 1000,
    });
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    const entriesPage = await restoreR2Backup(target.env, manifest.backupId, { limit: 10 });
    expect(entriesPage.state).toMatchObject({ nextOffset: 2, nextEdgeOffset: 0 });
    target.db.failEdgeInsertIds.add("bad-edge");

    await expect(restoreR2Backup(target.env, manifest.backupId, { limit: 10 }))
      .rejects.toThrow(/cursor was not advanced/);
    expect(target.db.restoreState).toMatchObject({
      next_offset: 2,
      next_edge_offset: 0,
      completed_at: null,
    });
  });

  it("rejects a concurrent page while an unexpired D1 lease is active", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 45);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    await restoreR2Backup(target.env, manifest.backupId);
    if (!target.db.restoreState) throw new Error("restore state missing");
    target.db.restoreState.lease_owner = "other-page";
    target.db.restoreState.lease_expires_at = Date.now() + 60_000;

    await expect(restoreR2Backup(target.env, manifest.backupId))
      .rejects.toThrow(/already in progress/);
    expect(target.db.restoreState.next_offset).toBe(IMPORT_DEFAULT_LIMIT);
    expect(target.db.entries).toHaveLength(IMPORT_DEFAULT_LIMIT);
  });

  it("blocks ordinary HTTP memory writes between restore pages", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 45);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    await restoreR2Backup(target.env, manifest.backupId);
    const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

    const response = await worker.fetch(req("POST", "/capture", {
      body: { content: "must not interleave with restore" },
    }), target.env, ctx);

    expect(response.status).toBe(423);
    expect(target.db.entries).toHaveLength(IMPORT_DEFAULT_LIMIT);
  });

  it("blocks a writer that passed admission before restore acquired its lease", async () => {
    const d1 = makeSqliteD1();
    const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database });
    try {
      resetDatabaseInit();
      await assertMemoryWritesAllowed(env); // the stale pre-restore check
      const now = Date.now();
      await d1.db.prepare(
        `INSERT INTO restore_state
           (id, backup_id, run_id, started_at, next_offset, next_edge_offset,
            completed_at, lease_owner, lease_expires_at)
         VALUES ('r2-v1', '2026/08/1787661296000', 'run-a', ?, 0, 0, NULL, 'lease-a', ?)`,
      ).bind(now, now + 60_000).run();

      await expect(d1.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
         VALUES ('late-writer', 'private', '[]', 'api', ?, '[]')`,
      ).bind(now).run()).rejects.toThrow(/memory-write-locked/);
      expect(d1.rows()).toHaveLength(0);

      await expect(d1.db.prepare(
        `INSERT INTO entries
           (id, content, tags, source, created_at, vector_ids, restore_lease_owner)
         VALUES ('restored', 'backup row', '[]', 'import', ?, '[]', 'lease-a')`,
      ).bind(now).run()).resolves.toBeDefined();
      expect(d1.rows()).toHaveLength(1);
    } finally {
      d1.close();
    }
  });

  it("fences the old page after an expired lease is acquired by a new owner", async () => {
    const d1 = makeSqliteD1();
    const now = Date.now();
    try {
      await d1.db.prepare(
        `INSERT INTO restore_state
           (id, backup_id, run_id, started_at, next_offset, next_edge_offset,
            completed_at, lease_owner, lease_expires_at)
         VALUES ('r2-v1', '2026/08/1787661296000', 'run-a', ?, 0, 0, NULL, 'lease-a', ?)`,
      ).bind(now, now - 1).run();
      await d1.db.prepare(
        `UPDATE restore_state SET lease_owner = 'lease-b', lease_expires_at = ?
          WHERE id = 'r2-v1' AND lease_expires_at <= ?`,
      ).bind(now + 60_000, now).run();

      await expect(d1.db.prepare(
        `INSERT INTO entries
           (id, content, tags, source, created_at, vector_ids, restore_lease_owner)
         VALUES ('old-page', 'old', '[]', 'import', ?, '[]', 'lease-a')`,
      ).bind(now).run()).rejects.toThrow(/memory-write-locked/);
      await expect(d1.db.prepare(
        `INSERT INTO entries
           (id, content, tags, source, created_at, vector_ids, restore_lease_owner)
         VALUES ('new-page', 'new', '[]', 'import', ?, '[]', 'lease-b')`,
      ).bind(now).run()).resolves.toBeDefined();
      expect(d1.rows().map(row => row.id)).toEqual(["new-page"]);
    } finally {
      d1.close();
    }
  });

  it("does not create a restore ledger while the migration lock is active", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    await setMemoryWriteLock(target.env);

    await expect(restoreR2Backup(target.env, manifest.backupId))
      .rejects.toMatchObject({ status: 423 });
    expect(target.db.restoreState).toBeNull();
  });

  it("does not start restore or migration cutover while a normal write admission is live", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    const admission = await acquireMemoryWriteAdmission(target.env);

    await expect(restoreR2Backup(target.env, manifest.backupId)).rejects.toMatchObject({ status: 423 });
    await expect(setMemoryWriteLock(target.env)).rejects.toMatchObject({ status: 423 });
    expect(target.db.restoreState).toBeNull();
    expect(target.db.migrationControl).toBeNull();

    await releaseMemoryWriteAdmission(target.env, admission);
    await expect(setMemoryWriteLock(target.env)).resolves.toBeDefined();
  });

  it("blocks a stale D1 writer after the migration lock wins the race", async () => {
    const d1 = makeSqliteD1();
    const env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database });
    try {
      resetDatabaseInit();
      await assertMemoryWritesAllowed(env);
      await setMemoryWriteLock(env);
      await expect(d1.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
         VALUES ('late-migration-writer', 'private', '[]', 'api', ?, '[]')`,
      ).bind(Date.now()).run()).rejects.toThrow(/memory-write-locked/);
      expect(d1.rows()).toHaveLength(0);
    } finally {
      d1.close();
    }
  });

  it("does not update recall counters while an unfinished restore is active", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 45);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const target = seededEnv(r2.bucket, 0);
    await restoreR2Backup(target.env, manifest.backupId);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    } as unknown as ExecutionContext;
    const before = target.db.entries.map(row => row.recall_count ?? 0);

    const response = await worker.fetch(req("POST", "/recall?query=memory"), target.env, ctx);
    await Promise.allSettled(pending);

    expect(response.status).toBe(423);
    expect(target.db.entries.map(row => row.recall_count ?? 0)).toEqual(before);
  });

  it("executes the atomic lease and cursor SQL against real SQLite", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 2);
    const manifest = await createR2Backup(source.env, new Date("2026-08-25T12:34:56.000Z"));
    const d1 = makeSqliteD1();
    const env = makeTestEnv(undefined, {
      DB: d1.db as unknown as D1Database,
      ARCHIVE: r2.bucket,
      OAUTH_KV: makeMemoryKV(),
    });

    try {
      resetDatabaseInit();
      const restored = await restoreR2Backup(env, manifest.backupId, { limit: 2 });
      expect(restored.state).toMatchObject({ nextOffset: 2, completedAt: expect.any(Number) });
      await expect(assertMemoryWritesAllowed(env)).resolves.toBeUndefined();
      expect(d1.rows()).toHaveLength(2);
      const ledger = await d1.db.prepare(
        `SELECT next_offset, completed_at, lease_owner FROM restore_state WHERE id = 'r2-v1'`,
      ).first() as Record<string, unknown>;
      expect(ledger).toMatchObject({ next_offset: 2, completed_at: expect.any(Number), lease_owner: null });
    } finally {
      d1.close();
    }
  });

  it("exposes authenticated admin endpoints and reports a missing R2 binding", async () => {
    const env = makeTestEnv(makeTestDb(), { ARCHIVE: undefined });
    const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
    expect((await worker.fetch(req("POST", "/admin/backup", { token: null }), env, ctx)).status).toBe(401);
    expect((await worker.fetch(req("POST", "/admin/backup"), env, ctx)).status).toBe(503);
  });

  it("creates an HTTP backup without deadlocking on its own ordinary admission", async () => {
    const r2 = fakeR2();
    const target = seededEnv(r2.bucket, 1);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    } as ExecutionContext;

    const response = await worker.fetch(req("POST", "/admin/backup"), target.env, ctx);
    await Promise.allSettled(pending);

    expect(response.status).toBe(200);
    expect(target.db.memoryWriteAdmissions.size).toBe(0);
    expect(target.db.migrationControl).toBeNull();
    expect(r2.objects.size).toBe(2);
  });
});

describe("Projects付きR2形式の互換境界", () => {
  it("Projects導入前のbrain-v3 chunkとfingerprintを復元できる", async () => {
    const r2 = fakeR2();
    const source = seededEnv(r2.bucket, 1);
    const manifest = await createR2Backup(source.env, new Date("2026-09-22T00:00:00.000Z"));
    manifest.format = "brain-v3";
    delete manifest.historyCount;
    delete manifest.projectCount;
    for (const chunk of manifest.chunks!) {
      const object = r2.objects.get(chunk.key)!;
      const payload = JSON.parse(object.value);
      payload.version = 3;
      object.value = JSON.stringify(payload);
      chunk.bytes = new TextEncoder().encode(object.value).byteLength;
      chunk.sha256 = await sha256Hex(object.value);
    }
    manifest.sha256 = await sha256Hex(manifestFingerprint(manifest));
    r2.objects.get(`backups/${manifest.backupId}/manifest.json`)!.value = JSON.stringify(manifest);
    const target = seededEnv(r2.bucket, 0);
    resetDatabaseInit();
    const result = await restoreR2Backup(target.env, manifest.backupId);
    expect(result.state.completedAt).toBeTypeOf("number");
    expect(result.restore).toMatchObject({ imported: 1, projects_imported: 0, remaining_projects: 0, next_project_offset: 0 });
  });

  it("Projectsだけのバックアップを分割再開し、改ざん時はカーソルを進めない", async () => {
    const r2 = fakeR2();
    const source = makeSqliteD1({ autoAdmitFixtureWrites: false });
    const target = makeSqliteD1({ autoAdmitFixtureWrites: false });
    const sourceEnv = makeTestEnv(undefined, { DB: source.db as unknown as D1Database, ARCHIVE: r2.bucket, OAUTH_KV: makeMemoryKV() });
    const targetEnv = makeTestEnv(undefined, { DB: target.db as unknown as D1Database, ARCHIVE: r2.bucket, OAUTH_KV: makeMemoryKV() });
    try {
      const { acquireMemoryWriteAdmission, releaseMemoryWriteAdmission, memoryWriteMarker } = await import("../../src/migration/write-lock");
      const admission = await acquireMemoryWriteAdmission(sourceEnv);
      const admitted = { ...sourceEnv, WRITE_ADMISSION_TOKEN: admission.token };
      for (const id of ["a", "b"]) await source.db.prepare(
        `INSERT INTO projects (id, workspace_id, name, created_at, write_marker) VALUES (?, 'ws', ?, 1, ?)`,
      ).bind(id, `Project ${id}`, memoryWriteMarker(admitted)).run();
      await releaseMemoryWriteAdmission(sourceEnv, admission);
      const manifest = await createR2Backup(sourceEnv, new Date("2026-09-22T00:00:01.000Z"));
      expect(manifest).toMatchObject({ format: "brain-v5", entryCount: 0, edgeCount: 0, projectCount: 2 });
      expect(manifest.chunks!.map(c => c.kind)).toEqual(["projects"]);
      resetDatabaseInit();
      const first = await restoreR2Backup(targetEnv, manifest.backupId, { limit: 1 });
      expect(first.state).toMatchObject({ nextOffset: 0, nextEdgeOffset: 0, nextProjectOffset: 1 });
      expect(first.state.completedAt).toBeUndefined();
      await expect(restoreR2Backup(targetEnv, manifest.backupId, { projectOffset: 2 })).rejects.toMatchObject({ status: 409 });
      const object = r2.objects.get(manifest.chunks![0].key)!;
      const original = object.value;
      object.value = original.replace("Project b", "Project X");
      await expect(restoreR2Backup(targetEnv, manifest.backupId)).rejects.toMatchObject({ status: 422 });
      const cursor = await target.db.prepare("SELECT next_project_offset FROM restore_state").first();
      expect(cursor).toMatchObject({ next_project_offset: 1 });
      object.value = original;
      const last = await restoreR2Backup(targetEnv, manifest.backupId, { limit: 1 });
      expect(last.state).toMatchObject({ nextProjectOffset: 2, completedAt: expect.any(Number) });
      const replay = await restoreR2Backup(targetEnv, manifest.backupId);
      expect(replay.restore).toMatchObject({ projects_imported: 0, next_project_offset: 2 });
      expect((await target.db.prepare("SELECT id FROM projects ORDER BY id").all()).results).toEqual([{ id: "a" }, { id: "b" }]);
    } finally { source.close(); target.close(); resetDatabaseInit(); }
  });
});

describe("brain-v5履歴の実SQLite往復", () => {
  it("履歴・ゴミ箱・検索ログ・旧監査eventを分割復元し、途中でも通常書込を遮断する", async () => {
    const r2 = fakeR2();
    const source = makeSqliteD1();
    const target = makeSqliteD1();
    try {
      source.seed({ id: "live", content: "現在", createdAt: 100 });
      await source.db.prepare(`UPDATE entries SET valid_from = 10, valid_until = 500 WHERE id = 'live'`).run();
      await source.db.prepare(`INSERT INTO entry_versions (id, entry_id, seq, content, tags, reason, created_at) VALUES (7, 'live', 1, '過去', '[]', 'update', 50)`).run();
      await source.db.prepare(`INSERT INTO entries_trash (id, content, row_json, vector_ids, deleted_at, nonce) VALUES ('gone', '削除済', ?, '["old-vector"]', 99, 'trash-nonce')`)
        .bind(JSON.stringify({ memory_tier: "hot", pinned: 1, vector_ids: '["old-vector"]' })).run();
      await source.db.prepare(`INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids) VALUES ('log', '', 80, 'rest', '検索', '{}', '["live"]')`).run();
      await source.db.prepare(`INSERT INTO entry_events (id, entry_id, event, payload, created_at) VALUES ('event', 'live', 'updated', '{"before":{"content":"旧履歴"}}', 50)`).run();
      await source.db.prepare(`DELETE FROM memory_write_admissions`).run();
      const sourceEnv = makeTestEnv(undefined, { DB: source.db as unknown as D1Database, ARCHIVE: r2.bucket, OAUTH_KV: makeMemoryKV() });
      const targetEnv = makeTestEnv(undefined, { DB: target.db as unknown as D1Database, ARCHIVE: r2.bucket, OAUTH_KV: makeMemoryKV() });
      resetDatabaseInit();
      const manifest = await createR2Backup(sourceEnv);
      expect(manifest).toMatchObject({ format: "brain-v5", historyCount: 4 });
      resetDatabaseInit();
      let result = await restoreR2Backup(targetEnv, manifest.backupId, { limit: 1 });
      expect(result.state.completedAt).toBeUndefined();
      await expect(assertMemoryWritesAllowed(targetEnv)).rejects.toThrow();
      const historyKey = manifest.chunks!.find(chunk => chunk.kind === "history")!.key;
      const historyObject = r2.objects.get(historyKey)!;
      const original = historyObject.value;
      historyObject.value += " ";
      await expect(restoreR2Backup(targetEnv, manifest.backupId, { limit: 1 })).rejects.toThrow(/size|SHA/);
      expect(await target.db.prepare(`SELECT next_history_offset FROM restore_state`).first()).toEqual({ next_history_offset: 0 });
      historyObject.value = original;
      for (let i = 0; i < 8 && !result.state.completedAt; i++) result = await restoreR2Backup(targetEnv, manifest.backupId, { limit: 1 });
      expect(result.state.completedAt).toBeTypeOf("number");
      expect(result.state.nextHistoryOffset).toBe(4);
      expect(await target.db.prepare(`SELECT content, valid_from, valid_until FROM entries WHERE id = 'live'`).first()).toEqual({ content: "現在", valid_from: 10, valid_until: 500 });
      expect(await target.db.prepare(`SELECT id, content FROM entry_versions`).first()).toEqual({ id: 7, content: "過去" });
      const trash = await target.db.prepare(`SELECT row_json, vector_ids, nonce FROM entries_trash`).first() as { row_json: string; vector_ids: string; nonce: string } | null;
      expect(trash?.vector_ids).toBe("[]");
      expect(JSON.parse(trash!.row_json)).toMatchObject({ memory_tier: "hot", pinned: 1, vector_ids: "[]" });
      expect(await target.db.prepare(`SELECT query FROM recall_log`).first()).toEqual({ query: "検索" });
      expect(await target.db.prepare(`SELECT payload FROM entry_events`).first()).toEqual({ payload: '{"before":{"content":"旧履歴"}}' });
      await expect(assertMemoryWritesAllowed(targetEnv)).resolves.toBeUndefined();
      const replay = await restoreR2Backup(targetEnv, manifest.backupId);
      expect(replay.state.completedAt).toBe(result.state.completedAt);
    } finally { source.close(); target.close(); }
  });
});
