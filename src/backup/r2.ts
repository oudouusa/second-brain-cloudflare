import { HISTORY_COUNT_SQL, HISTORY_EMPTY_SQL, readBackupHistoryPage, parseBackupHistoryRows, restoreBackupHistoryPage, type BackupHistoryRow } from "./history";
import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";
import { SB_VERSION } from "../env";
import { EMBEDDING_PROFILE } from "../embedding/profile";
import {
  EXPORT_COMPLETE_MAX_ROWS as MAX_BACKUP_ROWS,
  EXPORT_COMPLETE_MAX_BYTES as MAX_RESTORE_OBJECT_BYTES,
  EXPORT_READ_PAGE_ROWS,
  readExportCounts,
  readExportEdgesPage,
  readExportEntriesPage,
  readExportProjectsPage,
} from "../entries/export";
import {
  importExportPayload,
  parseImportBody,
  type ExportEdge,
  type ExportEntry,
  type ExportProject,
  type ExportPayload,
  type ImportSummary,
} from "../entries/import";
import { initializeDatabase } from "../db/init";
import { ACCRUAL_CURSOR_KEY } from "../insight/candidates";
import { TAG_VOCABULARY_KEY } from "../tags/vocabulary";
import { loadIntegration, SQLITE_JAVASCRIPT_TRIM_CHARSET } from "../integrations/framework";
import { INTEGRATION_PROVIDERS } from "../integrations";
import {
  BACKUP_SNAPSHOT_LOCK_REASON,
  assertMemoryWriteLockOwner,
  clearMemoryWriteLock,
  MemoryWriteLockedError,
  readMemoryWriteLock,
  setMemoryWriteLock,
} from "../migration/write-lock";

const BACKUP_PREFIX = "backups/";
const RESTORE_STATE_ID = "r2-v1";
const EMBEDDING_MIGRATION_GENERATION_ID = "embedding-v1";
const RESTORE_LEASE_MS = 120_000;
// 旧brain-v2復元の上限はentries/exportから直接取得する。brain-v4はchunkごとに制限する。
export const MAX_BACKUP_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;

async function invalidateSharedDerivedState(env: Env): Promise<void> {
  try {
    await Promise.all([
      env.OAUTH_KV.delete(ACCRUAL_CURSOR_KEY),
      env.OAUTH_KV.delete(TAG_VOCABULARY_KEY),
    ]);
  } catch {
    throw new BackupError("R2 restore could not invalidate shared derived caches", 503);
  }
}

export interface BackupChunkDescriptor {
  kind: "entries" | "edges" | "projects" | "history";
  start: number;
  count: number;
  key: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: "brain-v2" | "brain-v3" | "brain-v4" | "brain-v5";
  workerVersion: string;
  createdAt: string;
  entryCount: number;
  edgeCount: number;
  projectCount?: number;
  historyCount?: number;
  sha256: string;
  embeddingProfile: typeof EMBEDDING_PROFILE;
  backupId: string;
  brainKey?: string;
  chunks?: BackupChunkDescriptor[];
}

interface RestoreState {
  backupId: string;
  startedAt: number;
  nextOffset: number;
  nextEdgeOffset: number;
  nextProjectOffset: number;
  nextHistoryOffset: number;
  completedAt?: number;
}

interface RestoreLedger extends RestoreState {
  backupSha256: string;
  runId: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
}

interface RestoreStateRow {
  backup_id: string;
  backup_sha256: string | null;
  run_id: string | null;
  started_at: number;
  next_offset: number;
  next_edge_offset: number;
  next_project_offset: number;
  next_history_offset: number;
  completed_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
}

export class BackupError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "BackupError";
  }
}

function d1Changes(result: D1Result): number {
  const meta = result.meta as D1Result["meta"] & { rows_written?: number };
  return Number(meta.changes ?? meta.rows_written ?? 0);
}

function archive(env: Env): R2Bucket {
  if (!env.ARCHIVE) {
    throw new BackupError("R2 archive binding is unavailable; enable R2 and create second-brain-cf-archive", 503);
  }
  return env.ARCHIVE;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function backupIdAt(now: Date): string {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}/${now.getTime()}`;
}

function keysFor(backupId: string) {
  return {
    brain: `${BACKUP_PREFIX}${backupId}/brain-v2.json`,
    chunks: `${BACKUP_PREFIX}${backupId}/chunks/`,
    manifest: `${BACKUP_PREFIX}${backupId}/manifest.json`,
  };
}

function assertBackupId(backupId: string): void {
  if (!/^\d{4}\/\d{2}\/\d{10,}$/.test(backupId)) {
    throw new BackupError("Invalid backup ID", 400);
  }
}

const INTEGRATION_PROVIDER_IDS = Object.keys(INTEGRATION_PROVIDERS);

async function assertNoConnectedIntegrations(env: Env, operation: "backup" | "restore"): Promise<void> {
  for (const provider of INTEGRATION_PROVIDER_IDS) {
    if (await loadIntegration(env, provider)) {
      throw new BackupError(
        `R2 ${operation} requires every integration to be disconnected with purge=true; reconnect and resync after restore`,
        409,
      );
    }
  }
}

async function assertNoIntegrationMirrorsInD1(env: Env): Promise<void> {
  const placeholders = INTEGRATION_PROVIDER_IDS.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    // scope-exempt: an R2 snapshot is deployment-wide and must refuse if any integration mirror remains anywhere in the source database
    // validity: any: 所有者の全量backup・復旧判定は過去・保留状態を含めて原本を扱う。
    `SELECT COUNT(*) AS mirror_count FROM entries
      WHERE TRIM(source, ${SQLITE_JAVASCRIPT_TRIM_CHARSET})
            IN (${placeholders})`,
  ).bind(...INTEGRATION_PROVIDER_IDS).first<{ mirror_count: number }>();
  if (Number(row?.mirror_count ?? 0) > 0) {
    throw new BackupError(
      "R2 backup requires integration mirrors to be purged before the snapshot; reconnect and resync after restore",
      409,
    );
  }
}

function assertNoIntegrationMirrorsInPayload(
  payload: ExportPayload,
): void {
  const providers = new Set(INTEGRATION_PROVIDER_IDS);
  if (payload.entries.some(entry => providers.has((entry.source ?? "api").trim()))) {
    throw new BackupError(
      "R2 restore refuses backups containing integration mirrors; create a new backup after disconnecting with purge=true",
      409,
    );
  }
}

type BackupRow = ExportEntry | ExportEdge | ExportProject | BackupHistoryRow;

interface SerializedChunk {
  kind: BackupChunkDescriptor["kind"];
  start: number;
  count: number;
  json: string;
  bytes: number;
}

function chunkPrefix(kind: BackupChunkDescriptor["kind"], start: number): string {
  return `{"version":5,"kind":${JSON.stringify(kind)},"start":${start},${JSON.stringify(kind)}:[`;
}

function serializePageChunks(
  kind: BackupChunkDescriptor["kind"],
  pageStart: number,
  rows: readonly BackupRow[],
): SerializedChunk[] {
  const encoder = new TextEncoder();
  const suffix = "]}";
  const chunks: SerializedChunk[] = [];
  let chunkStart = pageStart;
  let serializedRows: string[] = [];
  let rowsBytes = 0;

  const flush = () => {
    if (serializedRows.length === 0) return;
    const json = `${chunkPrefix(kind, chunkStart)}${serializedRows.join(",")}${suffix}`;
    const bytes = encoder.encode(json).byteLength;
    if (bytes > MAX_BACKUP_CHUNK_BYTES) {
      throw new BackupError("One backup chunk exceeds the in-Worker safety limit", 413);
    }
    chunks.push({ kind, start: chunkStart, count: serializedRows.length, json, bytes });
    chunkStart += serializedRows.length;
    serializedRows = [];
    rowsBytes = 0;
  };

  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const rowBytes = encoder.encode(serialized).byteLength;
    const prefixBytes = encoder.encode(chunkPrefix(kind, chunkStart)).byteLength;
    const nextBytes = prefixBytes + rowsBytes + rowBytes
      + (serializedRows.length > 0 ? serializedRows.length : 0)
      + suffix.length;
    if (serializedRows.length > 0 && nextBytes > MAX_BACKUP_CHUNK_BYTES) flush();
    const freshPrefixBytes = encoder.encode(chunkPrefix(kind, chunkStart)).byteLength;
    if (freshPrefixBytes + rowBytes + suffix.length > MAX_BACKUP_CHUNK_BYTES) {
      throw new BackupError("One backup row exceeds the in-Worker chunk safety limit", 413);
    }
    serializedRows.push(serialized);
    rowsBytes += rowBytes;
  }
  flush();
  return chunks;
}

function chunkKey(backupId: string, kind: BackupChunkDescriptor["kind"], start: number): string {
  return `${keysFor(backupId).chunks}${kind}-${String(start).padStart(12, "0")}.json`;
}

function manifestFingerprintPayload(manifest: Omit<BackupManifest, "sha256"> | BackupManifest): string {
  return JSON.stringify({
    format: manifest.format,
    workerVersion: manifest.workerVersion,
    createdAt: manifest.createdAt,
    entryCount: manifest.entryCount,
    edgeCount: manifest.edgeCount,
    ...((manifest.format === "brain-v4" || manifest.format === "brain-v5") ? { projectCount: manifest.projectCount } : {}),
    ...(manifest.format === "brain-v5" ? { historyCount: manifest.historyCount } : {}),
    embeddingProfile: manifest.embeddingProfile,
    backupId: manifest.backupId,
    chunks: manifest.chunks ?? [],
  });
}

async function writeChunkedTable(
  env: Env,
  bucket: R2Bucket,
  lockOwner: string,
  backupId: string,
  kind: BackupChunkDescriptor["kind"],
  total: number,
  readPage: (env: Env, offset: number, limit: number) => Promise<BackupRow[]>,
  writtenKeys: string[],
): Promise<BackupChunkDescriptor[]> {
  const descriptors: BackupChunkDescriptor[] = [];
  let offset = 0;
  while (offset < total) {
    await assertMemoryWriteLockOwner(env, lockOwner);
    const page = await readPage(env, offset, EXPORT_READ_PAGE_ROWS);
    if (page.length === 0 || offset + page.length > total) {
      throw new BackupError("Backup snapshot count changed while reading a locked table", 503);
    }
    for (const chunk of serializePageChunks(kind, offset, page)) {
      await assertMemoryWriteLockOwner(env, lockOwner);
      const key = chunkKey(backupId, kind, chunk.start);
      const descriptor: BackupChunkDescriptor = {
        kind,
        start: chunk.start,
        count: chunk.count,
        key,
        bytes: chunk.bytes,
        sha256: await sha256Hex(chunk.json),
      };
      const put = await bucket.put(key, chunk.json, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (!put) throw new BackupError("Backup ID already contains an immutable chunk", 409);
      writtenKeys.push(key);
      descriptors.push(descriptor);
    }
    offset += page.length;
  }
  if (offset !== total) throw new BackupError("Backup snapshot count does not match exported chunks", 503);
  return descriptors;
}

async function readSnapshotCountsAndIntegrity(env: Env): Promise<{ entryCount: number; edgeCount: number; projectCount: number }> {
  const [counts, dangling] = await Promise.all([
    readExportCounts(env),
    env.DB.prepare(
      // scope-exempt: the scheduled/admin R2 snapshot validates graph integrity for the complete deployment before writing any chunk
      `SELECT COUNT(*) AS dangling_edge_count FROM edges e
        LEFT JOIN entries s ON s.id = e.source_id
        LEFT JOIN entries t ON t.id = e.target_id
       WHERE s.id IS NULL OR t.id IS NULL`,
    ).first<{ dangling_edge_count: number }>(),
  ]);
  if (Number(dangling?.dangling_edge_count ?? 0) > 0) {
    throw new BackupError("Backup contains an edge with a missing endpoint; repair graph integrity first", 409);
  }
  return counts;
}

export async function createR2Backup(env: Env, now = new Date()): Promise<BackupManifest> {
  const bucket = archive(env);
  let lock;
  try {
    lock = await setMemoryWriteLock(env, BACKUP_SNAPSHOT_LOCK_REASON, {
      requireNew: true,
      expiresInMs: RESTORE_LEASE_MS,
    });
  } catch (error) {
    if (error instanceof MemoryWriteLockedError) {
      throw new BackupError("R2 backup is waiting for an in-flight write or maintenance lock", 423);
    }
    throw error;
  }
  try {
    const backupId = backupIdAt(now);
    const keys = keysFor(backupId);
    const writtenKeys: string[] = [];
    try {
      await assertNoConnectedIntegrations(env, "backup");
      await assertNoIntegrationMirrorsInD1(env);
      const counts = await readSnapshotCountsAndIntegrity(env);
      const entryChunks = await writeChunkedTable(
        env,
        bucket,
        lock.ownerId,
        backupId,
        "entries",
        counts.entryCount,
        readExportEntriesPage,
        writtenKeys,
      );
      const edgeChunks = await writeChunkedTable(
        env,
        bucket,
        lock.ownerId,
        backupId,
        "edges",
        counts.edgeCount,
        readExportEdgesPage,
        writtenKeys,
      );
      await assertMemoryWriteLockOwner(env, lock.ownerId);
      const projectChunks = await writeChunkedTable(env, bucket, lock.ownerId, backupId, "projects", counts.projectCount, readExportProjectsPage, writtenKeys);
      const historyCounts = await env.DB.prepare(`SELECT ${HISTORY_COUNT_SQL} AS n`).first<{ n: number }>();
      const historyCount = Number(historyCounts?.n ?? 0);
      const historyChunks = await writeChunkedTable(env, bucket, lock.ownerId, backupId, "history", historyCount, readBackupHistoryPage, writtenKeys);
      await assertMemoryWriteLockOwner(env, lock.ownerId);
      const withoutSha: Omit<BackupManifest, "sha256"> = {
        format: "brain-v5",
        workerVersion: SB_VERSION,
        createdAt: now.toISOString(),
        entryCount: counts.entryCount,
        edgeCount: counts.edgeCount,
        projectCount: counts.projectCount,
        historyCount,
        embeddingProfile: EMBEDDING_PROFILE,
        backupId,
        chunks: [...entryChunks, ...edgeChunks, ...projectChunks, ...historyChunks],
      };
      const manifest: BackupManifest = {
        ...withoutSha,
        sha256: await sha256Hex(manifestFingerprintPayload(withoutSha)),
      };
      const manifestJson = JSON.stringify(manifest);
      if (new TextEncoder().encode(manifestJson).byteLength > MAX_MANIFEST_BYTES) {
        throw new BackupError("Backup manifest exceeds the in-Worker safety limit", 413);
      }
      const customMetadata = {
        format: manifest.format,
        createdAt: manifest.createdAt,
        entryCount: String(manifest.entryCount),
        edgeCount: String(manifest.edgeCount),
        projectCount: String(manifest.projectCount ?? 0),
        historyCount: String(manifest.historyCount ?? 0),
        sha256: manifest.sha256,
        profileId: manifest.embeddingProfile.profileId,
        model: manifest.embeddingProfile.model,
        rawDimensions: String(manifest.embeddingProfile.rawDimensions),
        dimensions: String(manifest.embeddingProfile.dimensions),
        promptVersion: String(manifest.embeddingProfile.promptVersion),
        workerVersion: manifest.workerVersion,
        backupId,
      };
      const manifestPut = await bucket.put(keys.manifest, manifestJson, {
        httpMetadata: { contentType: "application/json" },
        customMetadata,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (!manifestPut) throw new BackupError("Backup manifest already exists; refusing to overwrite immutable archive", 409);
      return manifest;
    } catch (error) {
      if (writtenKeys.length > 0) {
        try { await bucket.delete(writtenKeys); } catch { /* incomplete chunks remain invisible without a manifest */ }
      }
      throw error;
    }
  } finally {
    if (!await clearMemoryWriteLock(env, lock.ownerId, { force: true })) {
      throw new BackupError("R2 backup snapshot lock could not be released", 503);
    }
  }
}

export async function listR2Backups(env: Env): Promise<BackupManifest[]> {
  const bucket = archive(env);
  const manifests: BackupManifest[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: BACKUP_PREFIX,
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    });
    for (const object of page.objects) {
      if (!object.key.endsWith("/manifest.json")) continue;
      const meta = object.customMetadata;
      if (!meta?.backupId || (meta.format !== "brain-v2" && meta.format !== "brain-v3" && meta.format !== "brain-v4" && meta.format !== "brain-v5")) continue;
      manifests.push({
        format: meta.format,
        workerVersion: meta.workerVersion ?? "unknown",
        createdAt: meta.createdAt ?? object.uploaded.toISOString(),
        entryCount: Number(meta.entryCount ?? 0),
        edgeCount: Number(meta.edgeCount ?? 0),
        ...((meta.format === "brain-v4" || meta.format === "brain-v5") ? { projectCount: Number(meta.projectCount ?? 0) } : {}),
        sha256: meta.sha256 ?? "",
        embeddingProfile: {
          profileId: meta.profileId as typeof EMBEDDING_PROFILE.profileId,
          model: (meta.model ?? EMBEDDING_PROFILE.model) as typeof EMBEDDING_PROFILE.model,
          rawDimensions: Number(meta.rawDimensions ?? EMBEDDING_PROFILE.rawDimensions) as typeof EMBEDDING_PROFILE.rawDimensions,
          dimensions: Number(meta.dimensions ?? EMBEDDING_PROFILE.dimensions) as typeof EMBEDDING_PROFILE.dimensions,
          promptVersion: Number(meta.promptVersion ?? EMBEDDING_PROFILE.promptVersion) as typeof EMBEDDING_PROFILE.promptVersion,
        },
        backupId: meta.backupId,
        ...(meta.format === "brain-v5" ? { historyCount: Number(meta.historyCount ?? 0) } : {}),
        ...(meta.format === "brain-v2" ? { brainKey: keysFor(meta.backupId).brain } : {}),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

type LoadedBackupPageKind = "legacy" | BackupChunkDescriptor["kind"] | "done";

interface LoadedBackupPage {
  manifest: BackupManifest;
  payload: ExportPayload;
  kind: LoadedBackupPageKind;
  entryBase: number;
  edgeBase: number;
  projectBase: number;
  historyBase?: number;
  history?: BackupHistoryRow[];
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertManifestEnvelope(manifest: unknown, backupId: string): asserts manifest is BackupManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new BackupError("Backup manifest is invalid", 422);
  }
  const candidate = manifest as Partial<BackupManifest>;
  const profile = candidate.embeddingProfile as Partial<typeof EMBEDDING_PROFILE> | undefined;
  if (
    (candidate.format !== "brain-v2" && candidate.format !== "brain-v3" && candidate.format !== "brain-v4" && candidate.format !== "brain-v5")
    || candidate.backupId !== backupId
    || typeof candidate.workerVersion !== "string"
    || typeof candidate.createdAt !== "string"
    || !Number.isFinite(Date.parse(candidate.createdAt))
    || !isNonNegativeInteger(candidate.entryCount)
    || ((candidate.format === "brain-v4" || candidate.format === "brain-v5") && !isNonNegativeInteger(candidate.projectCount))
    || (candidate.format !== "brain-v4" && candidate.format !== "brain-v5" && candidate.projectCount !== undefined)
    || (candidate.format === "brain-v5" ? !isNonNegativeInteger(candidate.historyCount) : candidate.historyCount !== undefined)
    || !isNonNegativeInteger(candidate.edgeCount)
    || typeof candidate.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(candidate.sha256)
    || !profile || typeof profile !== "object"
    || typeof profile.profileId !== "string" || profile.profileId.length === 0
    || typeof profile.model !== "string" || profile.model.length === 0
    || !Number.isSafeInteger(profile.rawDimensions) || Number(profile.rawDimensions) <= 0
    || !Number.isSafeInteger(profile.dimensions) || Number(profile.dimensions) <= 0
    || !isNonNegativeInteger(profile.promptVersion)
  ) {
    throw new BackupError("Backup manifest is invalid", 422);
  }
}

function validatedV3Chunks(manifest: BackupManifest): BackupChunkDescriptor[] {
  if (!Array.isArray(manifest.chunks) || manifest.brainKey !== undefined) {
    throw new BackupError("Backup manifest is invalid", 422);
  }
  const seenKeys = new Set<string>();
  const counts = { entries: manifest.entryCount, edges: manifest.edgeCount, projects: manifest.projectCount ?? 0, history: manifest.historyCount ?? 0 };
  const next = { entries: 0, edges: 0, projects: 0, history: 0 };
  const kinds = ["entries", "edges", ...(manifest.format === "brain-v3" ? [] : ["projects"]), ...(manifest.format === "brain-v5" ? ["history"] : [])];
  let rank = 0;
  for (const descriptor of manifest.chunks) {
    if (!descriptor || typeof descriptor !== "object" || !kinds.includes(descriptor.kind)
      || !isNonNegativeInteger(descriptor.start) || !Number.isSafeInteger(descriptor.count) || descriptor.count <= 0
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes <= 0 || descriptor.bytes > MAX_BACKUP_CHUNK_BYTES
      || typeof descriptor.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(descriptor.sha256)
      || descriptor.key !== chunkKey(manifest.backupId, descriptor.kind, descriptor.start) || seenKeys.has(descriptor.key)) {
      throw new BackupError("Backup chunk manifest is invalid", 422);
    }
    const current = kinds.indexOf(descriptor.kind);
    if (current < rank || descriptor.start !== next[descriptor.kind]) throw new BackupError("Backup chunks are not contiguous or out of order", 422);
    rank = current;
    next[descriptor.kind] += descriptor.count;
    seenKeys.add(descriptor.key);
  }
  if (Object.keys(next).some(kind => next[kind as keyof typeof next] !== counts[kind as keyof typeof counts])) throw new BackupError("Backup manifest counts do not match its chunks", 422);
  return manifest.chunks;
}

function descriptorForRestoreCursor(
  chunks: readonly BackupChunkDescriptor[],
  manifest: BackupManifest,
  offset: number,
  edgeOffset: number,
  projectOffset: number,
  historyOffset: number,
): BackupChunkDescriptor | undefined {
  if (offset < manifest.entryCount) {
    return chunks.find(chunk => chunk.kind === "entries"
      && chunk.start <= offset && offset < chunk.start + chunk.count);
  }
  if (edgeOffset < manifest.edgeCount) {
    return chunks.find(chunk => chunk.kind === "edges"
      && chunk.start <= edgeOffset && edgeOffset < chunk.start + chunk.count);
  }
  if (projectOffset < (manifest.projectCount ?? 0)) {
    return chunks.find(chunk => chunk.kind === "projects" && chunk.start <= projectOffset && projectOffset < chunk.start + chunk.count);
  }
  if (historyOffset < (manifest.historyCount ?? 0)) return chunks.find(chunk => chunk.kind === "history" && chunk.start <= historyOffset && historyOffset < chunk.start + chunk.count);
  return undefined;
}

function parseV3Chunk(raw: unknown, descriptor: BackupChunkDescriptor, version: number): ExportPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BackupError("Backup chunk is invalid JSON", 422);
  }
  const chunk = raw as Record<string, unknown>;
  const rows = chunk[descriptor.kind];
  if (chunk.version !== version || chunk.kind !== descriptor.kind || chunk.start !== descriptor.start
    || !Array.isArray(rows) || rows.length !== descriptor.count) {
    throw new BackupError("Backup chunk does not match its manifest", 422);
  }
  const candidate = { version: 3, entries: [], edges: [], projects: [], [descriptor.kind]: rows };
  const parsed = parseImportBody(candidate);
  if (!parsed.ok) throw new BackupError(`Backup chunk is invalid: ${parsed.error}`, 422);
  return parsed.payload;
}

async function loadVerifiedBackup(
  env: Env,
  backupId: string,
  offset = 0,
  edgeOffset = 0,
  projectOffset = 0,
  historyOffset = 0,
): Promise<LoadedBackupPage> {
  assertBackupId(backupId);
  const bucket = archive(env);
  const keys = keysFor(backupId);
  const manifestObject = await bucket.get(keys.manifest);
  if (!manifestObject) throw new BackupError("Backup not found", 404);
  if (manifestObject.size > MAX_MANIFEST_BYTES) {
    throw new BackupError("Backup manifest exceeds the in-Worker restore safety limit", 413);
  }

  let manifest: unknown;
  try {
    manifest = await manifestObject.json<unknown>();
  } catch {
    throw new BackupError("Backup manifest is not valid JSON", 422);
  }
  assertManifestEnvelope(manifest, backupId);

  if (manifest.format === "brain-v2") {
    if (manifest.brainKey !== keys.brain || manifest.chunks !== undefined) {
      throw new BackupError("Backup manifest is invalid", 422);
    }
    const brainObject = await bucket.get(keys.brain);
    if (!brainObject) throw new BackupError("Backup not found", 404);
    if (brainObject.size > MAX_RESTORE_OBJECT_BYTES) {
      throw new BackupError("Backup object exceeds the in-Worker restore safety limit", 413);
    }
    let brainJson: string;
    try { brainJson = await brainObject.text(); } catch {
      throw new BackupError("Backup payload is not valid JSON", 422);
    }
    if (await sha256Hex(brainJson) !== manifest.sha256) {
      throw new BackupError("Backup SHA-256 verification failed", 422);
    }
    let raw: unknown;
    try { raw = JSON.parse(brainJson); } catch {
      throw new BackupError("Backup payload is invalid JSON", 422);
    }
    const parsed = parseImportBody(raw);
    if (!parsed.ok) throw new BackupError(`Backup payload is invalid: ${parsed.error}`, 422);
    if (parsed.payload.entries.length + (parsed.payload.edges?.length ?? 0) > MAX_BACKUP_ROWS) {
      throw new BackupError("Backup payload exceeds the in-Worker restore row limit", 413);
    }
    if ((parsed.payload.projects?.length ?? 0) !== 0
      || parsed.payload.entries.length !== manifest.entryCount
      || (parsed.payload.edges?.length ?? 0) !== manifest.edgeCount) {
      throw new BackupError("Backup manifest counts do not match the payload", 422);
    }
    return { manifest, payload: parsed.payload, kind: "legacy", entryBase: 0, edgeBase: 0, projectBase: 0 };
  }

  const chunks = validatedV3Chunks(manifest);
  if (await sha256Hex(manifestFingerprintPayload(manifest)) !== manifest.sha256) {
    throw new BackupError("Backup manifest SHA-256 verification failed", 422);
  }
  const descriptor = descriptorForRestoreCursor(chunks, manifest, offset, edgeOffset, projectOffset, historyOffset);
  if (!descriptor) {
    if (offset < manifest.entryCount || edgeOffset < manifest.edgeCount || projectOffset < (manifest.projectCount ?? 0) || historyOffset < (manifest.historyCount ?? 0)) {
      throw new BackupError("Backup manifest has no chunk for the restore cursor", 422);
    }
    return {
      manifest,
      payload: { version: 2, entries: [], edges: [] },
      kind: "done",
      entryBase: manifest.entryCount,
      edgeBase: manifest.edgeCount,
      projectBase: manifest.projectCount ?? 0,
    };
  }
  const chunkObject = await bucket.get(descriptor.key);
  if (!chunkObject) throw new BackupError("Backup chunk is missing", 404);
  if (chunkObject.size > MAX_BACKUP_CHUNK_BYTES) {
    throw new BackupError("Backup chunk exceeds the in-Worker restore safety limit", 413);
  }
  if (chunkObject.size !== descriptor.bytes) {
    throw new BackupError("Backup chunk size does not match its manifest", 422);
  }
  let chunkJson: string;
  try { chunkJson = await chunkObject.text(); } catch {
    throw new BackupError("Backup chunk is not valid JSON", 422);
  }
  if (new TextEncoder().encode(chunkJson).byteLength !== descriptor.bytes
    || await sha256Hex(chunkJson) !== descriptor.sha256) {
    throw new BackupError("Backup chunk SHA-256 verification failed", 422);
  }
  let raw: unknown;
  try { raw = JSON.parse(chunkJson); } catch {
    throw new BackupError("Backup chunk is invalid JSON", 422);
  }
  const version = manifest.format === "brain-v5" ? 5 : manifest.format === "brain-v4" ? 4 : 3;
  const payload = parseV3Chunk(raw, descriptor, version);
  let history: BackupHistoryRow[] | undefined;
  if (descriptor.kind === "history") {
    try { history = parseBackupHistoryRows((raw as Record<string, unknown>).history); }
    catch { throw new BackupError("Backup history chunk is invalid", 422); }
  }
  return {
    manifest,
    payload,
    history,
    historyBase: descriptor.kind === "history" ? descriptor.start : 0,
    kind: descriptor.kind,
    entryBase: descriptor.kind === "entries" ? descriptor.start : manifest.entryCount,
    edgeBase: descriptor.kind === "edges" ? descriptor.start : 0,
    projectBase: descriptor.kind === "projects" ? descriptor.start : 0,
  };
}

function completedRestoreSummary(state: RestoreLedger): ImportSummary {
  return {
    ok: true,
    imported: 0,
    skipped_in_trash: 0, skipped_too_large: 0,
    skipped: 0,
    failed: 0,
    edges_imported: 0,
    edges_skipped: 0,
    edges_failed: 0,
    projects_imported: 0, projects_skipped: 0, projects_failed: 0,
    remaining_projects: 0,
    remaining_history: 0, next_history_offset: state.nextHistoryOffset,
    next_project_offset: state.nextProjectOffset,
    remaining_entries: 0,
    remaining_edges: 0,
    next_offset: state.nextOffset,
    next_edge_offset: state.nextEdgeOffset,
    results: [],
    vectorize_hint: "Restore already completed; no rows were replayed.",
  };
}

async function readRestoreState(env: Env): Promise<RestoreLedger | null> {
  const row = await env.DB.prepare(
    `SELECT backup_id, backup_sha256, run_id, started_at, next_offset, next_edge_offset, next_project_offset, next_history_offset,
            completed_at, lease_owner, lease_expires_at
       FROM restore_state WHERE id = ?`,
  ).bind(RESTORE_STATE_ID).first<RestoreStateRow>();
  if (!row) return null;
  return {
    backupId: row.backup_id,
    backupSha256: row.backup_sha256 ?? "",
    runId: row.run_id ?? "",
    startedAt: Number(row.started_at),
    nextOffset: Number(row.next_offset),
    nextEdgeOffset: Number(row.next_edge_offset),
    nextProjectOffset: Number(row.next_project_offset ?? 0),
    nextHistoryOffset: Number(row.next_history_offset ?? 0),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: Number(row.lease_expires_at) }),
  };
}

async function readRestoreTargetState(env: Env): Promise<{ sourceEmpty: boolean; allEmpty: boolean }> {
  const counts = await env.DB.prepare(
    // scope-exempt: restore is an owner-admin disaster-recovery operation and requires every corpus table in the target deployment to be empty
    // validity: any: 所有者の全量backup・復旧判定は過去・保留状態を含めて原本を扱う。
    `SELECT (SELECT COUNT(*) FROM entries) AS entry_count,
            (SELECT COUNT(*) FROM edges) AS edge_count,
            (SELECT COUNT(*) FROM projects) AS project_count,
            (SELECT COUNT(*) FROM insight_candidates) AS candidate_count,
            (SELECT COUNT(*) FROM vector_cleanup_ops) AS cleanup_count,
            (${HISTORY_COUNT_SQL}) AS history_count`,
  ).first<{ entry_count: number; edge_count: number; project_count: number; candidate_count: number; cleanup_count: number; history_count: number }>();
  const sourceEmpty = Number(counts?.entry_count ?? 0) === 0
    && Number(counts?.edge_count ?? 0) === 0
    && Number(counts?.project_count ?? 0) === 0
    && Number(counts?.history_count ?? 0) === 0;
  return {
    sourceEmpty,
    allEmpty: sourceEmpty
      && Number(counts?.candidate_count ?? 0) === 0
      && Number(counts?.cleanup_count ?? 0) === 0,
  };
}

async function acquireRestoreLease(env: Env, backupId: string, backupSha256: string): Promise<RestoreLedger> {
  const prior = await readRestoreState(env);
  const targetEmpty = (await readRestoreTargetState(env)).allEmpty;
  const now = Date.now();
  const leaseOwner = crypto.randomUUID();
  const leaseExpiresAt = now + RESTORE_LEASE_MS;
  const switchingBackup = prior !== null && prior.backupId !== backupId;
  const restartingClearedTarget = prior !== null
    && prior.backupId === backupId
    && targetEmpty
    && (prior.nextOffset > 0 || prior.nextEdgeOffset > 0 || prior.nextProjectOffset > 0 || prior.nextHistoryOffset > 0 || prior.completedAt !== undefined);

  let result: D1Result;
  if (!prior || switchingBackup || restartingClearedTarget) {
    if (!targetEmpty) {
      throw new BackupError("R2 restore must start with an empty D1 database", 409);
    }
    let vectorCount: number;
    try {
      const description = await env.VECTORIZE.describe() as unknown as { vectorCount?: number };
      vectorCount = Number(description.vectorCount);
    } catch {
      throw new BackupError("R2 restore could not verify that Vectorize is empty", 503);
    }
    if (!Number.isFinite(vectorCount)) {
      throw new BackupError("R2 restore could not verify that Vectorize is empty", 503);
    }
    if (vectorCount !== 0) {
      throw new BackupError("R2 restore requires a fresh empty Vectorize index", 409);
    }
    const runId = crypto.randomUUID();
    // The emptiness predicates live in the same D1 statement as the ledger claim. This
    // closes the important new-restore race: a competing restore cannot both observe an
    // empty target and then overwrite the other's state.
    const claim = env.DB.prepare(
      // scope-exempt: the restore lease atomically proves deployment-wide emptiness before admitting a trusted full-corpus replay
      // validity: any: 所有者の全量backup・復旧判定は過去・保留状態を含めて原本を扱う。
      `INSERT INTO restore_state
         (id, backup_id, backup_sha256, run_id, started_at, next_offset, next_edge_offset, next_project_offset,
          completed_at, lease_owner, lease_expires_at)
       SELECT ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM entries LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM projects LIMIT 1)
          AND ${HISTORY_EMPTY_SQL}
          AND NOT EXISTS (SELECT 1 FROM edges LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM insight_candidates LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM vector_cleanup_ops LIMIT 1)
          AND NOT EXISTS (
            SELECT 1 FROM migration_control WHERE id = 'memory-write-lock'
              AND NOT (reason = 'r2-backup-snapshot'
                AND active_delta_expires_at IS NOT NULL
                AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
          )
          AND NOT EXISTS (
            SELECT 1 FROM memory_write_admissions a
            JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
            WHERE a.expires_at > ?
          )
       ON CONFLICT(id) DO UPDATE SET
         backup_id = excluded.backup_id,
         backup_sha256 = excluded.backup_sha256,
         run_id = excluded.run_id,
         started_at = excluded.started_at,
         next_offset = 0,
         next_edge_offset = 0,
         next_project_offset = 0,
         next_history_offset = 0,
         completed_at = NULL,
         lease_owner = excluded.lease_owner,
         lease_expires_at = excluded.lease_expires_at
       WHERE (restore_state.lease_owner IS NULL
           OR restore_state.lease_expires_at IS NULL
           OR restore_state.lease_expires_at <= ?)
         AND NOT EXISTS (SELECT 1 FROM entries LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM projects LIMIT 1)
          AND ${HISTORY_EMPTY_SQL}
          AND NOT EXISTS (SELECT 1 FROM edges LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM insight_candidates LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM vector_cleanup_ops LIMIT 1)
         AND NOT EXISTS (
           SELECT 1 FROM migration_control WHERE id = 'memory-write-lock'
             AND NOT (reason = 'r2-backup-snapshot'
               AND active_delta_expires_at IS NOT NULL
               AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
         )
         AND NOT EXISTS (
           SELECT 1 FROM memory_write_admissions a
           JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
           WHERE a.expires_at > ?
         )`,
    ).bind(
      RESTORE_STATE_ID,
      backupId,
      backupSha256,
      runId,
      now,
      leaseOwner,
      leaseExpiresAt,
      now,
      now,
      now,
    );
    // A restore into a reused D1 invalidates every cursor kept in shared KV. Keep
    // the ledger claim and generation rotation in one D1 transaction: the second
    // statement can change the generation only if this unique runId owns the claim.
    const rotateGeneration = env.DB.prepare(
      `INSERT INTO embedding_migration_generation (id, generation)
       SELECT ?, ?
        WHERE EXISTS (
          SELECT 1 FROM restore_state
           WHERE id = ? AND run_id = ? AND lease_owner = ?
        )
       ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`,
    ).bind(
      EMBEDDING_MIGRATION_GENERATION_ID,
      crypto.randomUUID(),
      RESTORE_STATE_ID,
      runId,
      leaseOwner,
    );
    const rotateWriteEpoch = env.DB.prepare(
      `INSERT INTO memory_write_epoch (id, generation)
       SELECT 'current', ?
        WHERE EXISTS (
          SELECT 1 FROM restore_state
           WHERE id = ? AND run_id = ? AND lease_owner = ?
        )
       ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`,
    ).bind(crypto.randomUUID(), RESTORE_STATE_ID, runId, leaseOwner);
    const [claimResult, generationResult, epochResult] = await env.DB.batch([
      claim,
      rotateGeneration,
      rotateWriteEpoch,
    ]);
    result = claimResult;
    if (d1Changes(claimResult) === 1 && d1Changes(generationResult) !== 1) {
      throw new BackupError("R2 restore could not invalidate the embedding migration cursor", 503);
    }
    if (d1Changes(claimResult) === 1 && d1Changes(epochResult) !== 1) {
      throw new BackupError("R2 restore could not rotate the memory write epoch", 503);
    }
  } else {
    const runId = prior.runId || crypto.randomUUID();
    const resumeClaim = env.DB.prepare(
      // scope-exempt: resuming a trusted restore rechecks deployment-wide emptiness while claiming the singleton restore ledger
      // validity: any: 所有者の全量backup・復旧判定は過去・保留状態を含めて原本を扱う。
      `UPDATE restore_state
          SET backup_sha256 = COALESCE(backup_sha256, ?),
              run_id = ?, lease_owner = ?, lease_expires_at = ?
        WHERE id = ? AND backup_id = ?
          AND (backup_sha256 = ? OR (
            backup_sha256 IS NULL
            AND next_offset = 0
            AND next_edge_offset = 0
            AND next_project_offset = 0
            AND next_history_offset = 0
            AND completed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM entries LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM projects LIMIT 1)
          AND ${HISTORY_EMPTY_SQL}
          AND NOT EXISTS (SELECT 1 FROM edges LIMIT 1)
          ))
          AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM migration_control WHERE id = 'memory-write-lock'
              AND NOT (reason = 'r2-backup-snapshot'
                AND active_delta_expires_at IS NOT NULL
                AND active_delta_expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
          )
          AND NOT EXISTS (
            SELECT 1 FROM memory_write_admissions a
            JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
            WHERE a.expires_at > ?
          )`,
    ).bind(
      backupSha256,
      runId,
      leaseOwner,
      leaseExpiresAt,
      RESTORE_STATE_ID,
      backupId,
      backupSha256,
      now,
      now,
    );
    const resumeEpoch = env.DB.prepare(
      `INSERT INTO memory_write_epoch (id, generation)
       SELECT 'current', ?
        WHERE EXISTS (
          SELECT 1 FROM restore_state
           WHERE id = ? AND run_id = ? AND lease_owner = ?
        )
       ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`,
    ).bind(crypto.randomUUID(), RESTORE_STATE_ID, runId, leaseOwner);
    const [resumeResult, epochResult] = await env.DB.batch([resumeClaim, resumeEpoch]);
    result = resumeResult;
    if (d1Changes(resumeResult) === 1 && d1Changes(epochResult) !== 1) {
      throw new BackupError("R2 restore could not rotate the memory write epoch", 503);
    }
  }

  if (d1Changes(result) !== 1) {
    const migrationLock = await readMemoryWriteLock(env);
    if (migrationLock) {
      throw new BackupError("R2 restore cannot start while the embedding migration write lock is active", 423);
    }
    const current = await readRestoreState(env);
    if (current?.backupId === backupId && current.backupSha256
      && current.backupSha256 !== backupSha256) {
      throw new BackupError("R2 backup changed after restore began", 409);
    }
    const admission = await env.DB.prepare(
      `SELECT 1 AS active FROM memory_write_admissions a
       JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
       WHERE a.expires_at > ? LIMIT 1`,
    ).bind(Date.now()).first<{ active: number }>();
    if (admission) {
      throw new BackupError("R2 restore is waiting for an in-flight memory write", 423);
    }
    throw new BackupError("Another R2 restore page is already in progress", 409);
  }
  const claimed = await readRestoreState(env);
  if (!claimed || claimed.backupId !== backupId || claimed.backupSha256 !== backupSha256
    || claimed.leaseOwner !== leaseOwner) {
    throw new BackupError("R2 restore lease could not be acquired", 409);
  }
  return claimed;
}

async function renewRestoreLease(env: Env, state: RestoreLedger): Promise<void> {
  if (!state.leaseOwner) throw new BackupError("R2 restore lease is unavailable", 409);
  const now = Date.now();
  const leaseExpiresAt = now + RESTORE_LEASE_MS;
  const renewed = await env.DB.prepare(
    `UPDATE restore_state SET lease_expires_at = ?
      WHERE id = ? AND backup_id = ? AND run_id = ? AND lease_owner = ?
        AND lease_expires_at > ?`,
  ).bind(
    leaseExpiresAt,
    RESTORE_STATE_ID,
    state.backupId,
    state.runId,
    state.leaseOwner,
    now,
  ).run();
  if (d1Changes(renewed) !== 1) {
    throw new BackupError("R2 restore lease was lost before a write batch", 409);
  }
  state.leaseExpiresAt = leaseExpiresAt;
}

async function releaseRestoreLease(env: Env, state: RestoreLedger): Promise<void> {
  if (!state.leaseOwner) return;
  await env.DB.prepare(
    `UPDATE restore_state SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND backup_id = ? AND run_id = ? AND lease_owner = ?`,
  ).bind(RESTORE_STATE_ID, state.backupId, state.runId, state.leaseOwner).run();
}

function publicRestoreState(state: RestoreLedger): RestoreState {
  return {
    backupId: state.backupId,
    startedAt: state.startedAt,
    nextOffset: state.nextOffset,
    nextEdgeOffset: state.nextEdgeOffset,
    nextProjectOffset: state.nextProjectOffset,
    nextHistoryOffset: state.nextHistoryOffset,
    ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt }),
  };
}

function localRestoreOffsets(
  page: LoadedBackupPage,
  offset: number,
  edgeOffset: number,
  projectOffset: number,
): { offset: number; edgeOffset: number; projectOffset: number } {
  if (page.kind === "legacy") return { offset, edgeOffset, projectOffset: 0 };
  if (page.kind === "entries") {
    return { offset: Math.max(0, offset - page.entryBase), edgeOffset: 0, projectOffset: 0 };
  }
  if (page.kind === "edges") {
    return { offset: 0, edgeOffset: Math.max(0, edgeOffset - page.edgeBase), projectOffset: 0 };
  }
  return { offset: 0, edgeOffset: 0, projectOffset: page.kind === "projects" ? Math.max(0, projectOffset - page.projectBase) : 0 };
}

function globalizeRestoreSummary(
  page: LoadedBackupPage,
  restore: ImportSummary,
  offset: number,
  edgeOffset: number,
  projectOffset: number,
): ImportSummary {
  if (page.kind === "legacy") return restore;
  let nextOffset = offset;
  let nextEdgeOffset = edgeOffset;
  let nextProjectOffset = projectOffset;
  if (page.kind === "entries") {
    nextOffset = page.entryBase + restore.next_offset;
  } else if (page.kind === "edges") {
    nextOffset = page.manifest.entryCount;
    nextEdgeOffset = page.edgeBase + restore.next_edge_offset;
  } else {
    nextOffset = page.manifest.entryCount;
    nextEdgeOffset = page.manifest.edgeCount;
    nextProjectOffset = page.kind === "projects" ? page.projectBase + restore.next_project_offset : (page.manifest.projectCount ?? 0);
  }
  return {
    ...restore,
    remaining_entries: Math.max(0, page.manifest.entryCount - nextOffset),
    remaining_edges: Math.max(0, page.manifest.edgeCount - nextEdgeOffset),
    remaining_projects: Math.max(0, (page.manifest.projectCount ?? 0) - nextProjectOffset),
    next_project_offset: nextProjectOffset,
    next_offset: nextOffset,
    next_edge_offset: nextEdgeOffset,
  };
}

export async function restoreR2Backup(
  env: Env,
  backupId: string,
  options: { offset?: number; edgeOffset?: number; projectOffset?: number; historyOffset?: number; limit?: number } = {},
): Promise<{ manifest: BackupManifest; restore: ImportSummary; state: RestoreState }> {
  const requestedOffset = Math.max(0, options.offset ?? 0);
  const requestedEdgeOffset = Math.max(0, options.edgeOffset ?? 0);
  const requestedProjectOffset = Math.max(0, options.projectOffset ?? 0);
  const requestedHistoryOffset = Math.max(0, options.historyOffset ?? 0);
  let page = await loadVerifiedBackup(env, backupId, requestedOffset, requestedEdgeOffset, requestedProjectOffset, requestedHistoryOffset);
  const { manifest } = page;
  assertNoIntegrationMirrorsInPayload(page.payload);
  // R2 and hash validation complete before this first D1 operation. A missing,
  // unreadable, or corrupt object therefore leaves even the schema untouched.
  const initialized = await initializeDatabase(env);
  if (initialized.changed) {
    throw new BackupError("Database schema initialized; retry the same restore request", 202);
  }
  const completedState = await readRestoreState(env);
  const completedTarget = completedState?.completedAt === undefined
    ? null
    : await readRestoreTargetState(env);
  if (completedState?.backupId === backupId && completedState.completedAt !== undefined
    && completedTarget
    && (!completedTarget.sourceEmpty || (manifest.entryCount === 0 && manifest.edgeCount === 0 && (manifest.projectCount ?? 0) === 0 && (manifest.historyCount ?? 0) === 0))) {
    if (completedState.backupSha256 !== manifest.sha256) {
      throw new BackupError("R2 backup changed after restore completed", 409);
    }
    if ((options.offset ?? completedState.nextOffset) > completedState.nextOffset
      || (options.edgeOffset ?? completedState.nextEdgeOffset) > completedState.nextEdgeOffset
      || (options.projectOffset ?? completedState.nextProjectOffset) > completedState.nextProjectOffset
      || (options.historyOffset ?? completedState.nextHistoryOffset) > completedState.nextHistoryOffset) {
      throw new BackupError("Restore offsets cannot advance beyond the durable cursor", 409);
    }
    return {
      manifest,
      restore: completedRestoreSummary(completedState),
      state: publicRestoreState(completedState),
    };
  }
  if (completedState?.backupId === backupId && completedState.completedAt !== undefined
    && completedTarget && !completedTarget.allEmpty) {
    throw new BackupError(
      "R2 restore cannot restart while derived D1 state remains; clear candidates and cleanup tombstones first",
      409,
    );
  }
  await assertNoConnectedIntegrations(env, "restore");
  const state = await acquireRestoreLease(env, backupId, manifest.sha256);

  try {
    // The OAuth KV namespace is shared across D1 restore drills. Clear cursors
    // before every page, and again after the final commit below, so neither a
    // retired database's cursor nor a read racing a partial restore can survive.
    await invalidateSharedDerivedState(env);
    const offset = Math.max(0, options.offset ?? state.nextOffset);
    const edgeOffset = Math.max(0, options.edgeOffset ?? state.nextEdgeOffset);
    const projectOffset = Math.max(0, options.projectOffset ?? state.nextProjectOffset);
    const historyOffset = Math.max(0, options.historyOffset ?? state.nextHistoryOffset);
    if (offset > state.nextOffset || edgeOffset > state.nextEdgeOffset || projectOffset > state.nextProjectOffset || historyOffset > state.nextHistoryOffset) {
      throw new BackupError("Restore offsets cannot advance beyond the durable cursor", 409);
    }

    if (manifest.format !== "brain-v2"
      && (offset !== requestedOffset || edgeOffset !== requestedEdgeOffset || projectOffset !== requestedProjectOffset || historyOffset !== requestedHistoryOffset)) {
      page = await loadVerifiedBackup(env, backupId, offset, edgeOffset, projectOffset, historyOffset);
      if (page.manifest.sha256 !== manifest.sha256) {
        throw new BackupError("R2 backup changed after restore began", 409);
      }
      assertNoIntegrationMirrorsInPayload(page.payload);
    }
    const local = localRestoreOffsets(page, offset, edgeOffset, projectOffset);

    let nextHistoryOffset = historyOffset;
    if (page.kind === "history") {
      const rows = page.history!.slice(historyOffset - (page.historyBase ?? 0), historyOffset - (page.historyBase ?? 0) + Math.min(12, Math.max(1, options.limit ?? 12)));
      await renewRestoreLease(env, state);
      await restoreBackupHistoryPage(env, rows, state.leaseOwner!);
      nextHistoryOffset += rows.length;
    }
    const pageRestore = page.kind === "history" ? completedRestoreSummary(state) : await importExportPayload(env, page.payload, {
      offset: local.offset,
      edgeOffset: local.edgeOffset,
      projectOffset: local.projectOffset,
      limit: options.limit,
      writeLockOwner: state.runId,
      restoreLeaseOwner: state.leaseOwner,
      preserveWriteContext: true,
      beforeWriteBatch: () => renewRestoreLease(env, state),
    });
    const restore = globalizeRestoreSummary(page, pageRestore, offset, edgeOffset, projectOffset);
    restore.remaining_history = Math.max(0, (manifest.historyCount ?? 0) - nextHistoryOffset);
    restore.next_history_offset = nextHistoryOffset;
    if (restore.failed > 0 || restore.edges_failed > 0 || restore.projects_failed > 0) {
      throw new BackupError("Restore page contained failed rows; cursor was not advanced", 503);
    }

    const completed = restore.remaining_entries === 0 && restore.remaining_edges === 0 && restore.remaining_projects === 0 && nextHistoryOffset >= (manifest.historyCount ?? 0);
    if (completed && state.completedAt === undefined) {
      const counts = await env.DB.prepare(
        // scope-exempt: final restore verification compares full-deployment counts with the signed backup manifest
        // validity: any: 所有者の全量backup・復旧判定は過去・保留状態を含めて原本を扱う。
        `SELECT (SELECT COUNT(*) FROM entries) AS entry_count,
                (SELECT COUNT(*) FROM edges) AS edge_count,
                (SELECT COUNT(*) FROM projects) AS project_count, (${HISTORY_COUNT_SQL}) AS history_count`,
      ).first<{ entry_count: number; edge_count: number; project_count: number; history_count: number }>();
      if (Number(counts?.entry_count ?? -1) !== manifest.entryCount
        || Number(counts?.edge_count ?? -1) !== manifest.edgeCount
        || Number(counts?.project_count ?? -1) !== (manifest.projectCount ?? 0)
        || Number(counts?.history_count ?? -1) !== (manifest.historyCount ?? 0)) {
        throw new BackupError("Restored D1 counts do not match the backup manifest", 503);
      }
    }

    const nextOffset = Math.max(state.nextOffset, restore.next_offset);
    const nextEdgeOffset = Math.max(state.nextEdgeOffset, restore.next_edge_offset);
    const nextProjectOffset = Math.max(state.nextProjectOffset, restore.next_project_offset);
    nextHistoryOffset = Math.max(state.nextHistoryOffset, nextHistoryOffset);
    const completedAt = completed ? (state.completedAt ?? Date.now()) : state.completedAt;
    await renewRestoreLease(env, state);
    const commitNow = Date.now();
    const cursorUpdate = env.DB.prepare(
      `UPDATE restore_state
          SET next_offset = max(next_offset, ?),
              next_edge_offset = max(next_edge_offset, ?),
              next_project_offset = max(next_project_offset, ?),
              next_history_offset = max(next_history_offset, ?),
              completed_at = ?,
              lease_owner = NULL,
              lease_expires_at = NULL
        WHERE id = ? AND backup_id = ? AND backup_sha256 = ? AND run_id = ? AND lease_owner = ?
          AND lease_expires_at > ?`,
    ).bind(
      nextOffset,
      nextEdgeOffset,
      nextProjectOffset,
      nextHistoryOffset,
      completedAt ?? null,
      RESTORE_STATE_ID,
      backupId,
      manifest.sha256,
      state.runId,
      state.leaseOwner,
      commitNow,
    );
    let update: D1Result;
    if (completed && state.completedAt === undefined) {
      const rotateGeneration = env.DB.prepare(
        `INSERT INTO embedding_migration_generation (id, generation)
         SELECT ?, ?
          WHERE EXISTS (
            SELECT 1 FROM restore_state
             WHERE id = ? AND run_id = ? AND completed_at = ? AND lease_owner IS NULL
          )
         ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`,
      ).bind(
        EMBEDDING_MIGRATION_GENERATION_ID,
        crypto.randomUUID(),
        RESTORE_STATE_ID,
        state.runId,
        completedAt,
      );
      const activateIntegrationGeneration = env.DB.prepare(
        `INSERT INTO integration_state_generation (id, generation, restore_count)
         SELECT 'current', ?, 1
          WHERE EXISTS (
            SELECT 1 FROM restore_state
             WHERE id = ? AND run_id = ? AND completed_at = ? AND lease_owner IS NULL
          )
         ON CONFLICT(id) DO UPDATE SET
           generation = excluded.generation,
           restore_count = integration_state_generation.restore_count + 1`,
      ).bind(crypto.randomUUID(), RESTORE_STATE_ID, state.runId, completedAt);
      const [cursorResult, generationResult, integrationGenerationResult] = await env.DB.batch([
        cursorUpdate,
        rotateGeneration,
        activateIntegrationGeneration,
      ]);
      update = cursorResult;
      if (d1Changes(cursorResult) === 1 && d1Changes(generationResult) !== 1) {
        throw new BackupError("R2 restore could not invalidate the embedding migration cursor", 503);
      }
      if (d1Changes(cursorResult) === 1 && d1Changes(integrationGenerationResult) !== 1) {
        throw new BackupError("R2 restore could not activate the integration state generation", 503);
      }
    } else {
      update = await cursorUpdate.run();
    }
    if (d1Changes(update) !== 1) {
      throw new BackupError("R2 restore lease was lost before cursor commit", 409);
    }
    if (completed) await invalidateSharedDerivedState(env);
    const updated: RestoreLedger = {
      ...state,
      nextOffset,
      nextEdgeOffset,
      nextProjectOffset,
      nextHistoryOffset,
      ...(completedAt === undefined ? {} : { completedAt }),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    };
    return { manifest, restore, state: publicRestoreState(updated) };
  } finally {
    await releaseRestoreLease(env, state);
  }
}
