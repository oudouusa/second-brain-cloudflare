import type { Env } from "../env";
import { initializeDatabase } from "../db/init";
import { json } from "../lib/http";

export const DERIVED_STATE_GENERATION_ID = "embedding-v1";

/** 本文から派生するKV cursor/cacheが共有する、D1正本の世代番号。 */
export async function readDerivedStateGeneration(env: Env): Promise<string> {
  const read = async () => {
    const row = await env.DB.prepare(
      `SELECT generation FROM embedding_migration_generation WHERE id = ?`,
    ).bind(DERIVED_STATE_GENERATION_ID).first<{ generation: string }>();
    return typeof row?.generation === "string" ? row.generation : null;
  };
  const existing = await read();
  if (existing) return existing;
  const created = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO embedding_migration_generation (id, generation) VALUES (?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(DERIVED_STATE_GENERATION_ID, created).run();
  return (await read()) ?? created;
}
const WRITE_LOCK_ID = "memory-write-lock";
const RESTORE_STATE_ID = "r2-v1";
export const BACKUP_SNAPSHOT_LOCK_REASON = "r2-backup-snapshot";
// Scheduled Workers may run for 15 minutes. One extra minute lets the final D1 release
// complete, while bounding a forced-termination or repeated release failure to 16 minutes.
const WRITE_ADMISSION_MS = 16 * 60 * 1000;
const FINAL_DELTA_LEASE_MS = 16 * 60 * 1000;

export interface MemoryWriteLock {
  lockedAt: number;
  reason: string;
  ownerId: string;
  expiresAt?: number;
}

export interface MemoryWriteAdmission {
  token: string;
  startedAt: number;
  expiresAt: number;
}

/**
 * Attach an admission returned by acquireMemoryWriteAdmission to a private Env view.
 *
 * Most requests should use beginMemoryWriteAdmission, which also tracks waitUntil work.
 * This smaller seam exists for bootstrap code that runs before an authenticated request
 * has an ExecutionContext of its own, but still has to cross the same fail-closed D1
 * fences as every ordinary writer.
 */
export function envWithMemoryWriteAdmission(
  env: Env,
  admission: MemoryWriteAdmission,
): Env {
  return admittedEnv(env, admission.token);
}

/** Attach the admission capability without mutating the shared bindings object. */
function admittedEnv(env: Env, token: string): Env {
  const scoped = Object.create(env) as Env;
  Object.defineProperty(scoped, "WRITE_ADMISSION_TOKEN", {
    value: token,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return scoped;
}

/** A fresh row marker for one D1 statement; NULL is accepted only before epoch activation. */
export function memoryWriteMarker(env: Env, purpose: "write" | "delete" = "write"): string | null {
  return env.WRITE_ADMISSION_TOKEN
    ? `${env.WRITE_ADMISSION_TOKEN}:${purpose}:${crypto.randomUUID()}`
    : null;
}

/** Extend only the still-current capability immediately before a remote side effect. */
export async function renewMemoryWriteAdmission(env: Env): Promise<void> {
  const token = env.WRITE_ADMISSION_TOKEN;
  if (!token) return;
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE memory_write_admissions
        SET expires_at = MAX(expires_at, ?)
      WHERE token = ? AND expires_at > ?
        AND generation = (SELECT generation FROM memory_write_epoch WHERE id = 'current')`,
  ).bind(now + WRITE_ADMISSION_MS, token, now).run();
  const changed = Number((result.meta as D1Result["meta"] & { rows_written?: number }).changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changed !== 1) {
    throw new MemoryWriteLockedError({
      lockedAt: now,
      reason: "write-admission-expired",
      ownerId: "",
    });
  }
}

export async function acquireMemoryWriteAdmission(env: Env): Promise<MemoryWriteAdmission> {
  await initializeDatabase(env);
  const startedAt = Date.now();
  const admission = {
    token: crypto.randomUUID(),
    startedAt,
    expiresAt: startedAt + WRITE_ADMISSION_MS,
  };
  const claim = () => env.DB.prepare(
      `INSERT INTO memory_write_admissions (token, started_at, expires_at, generation)
       SELECT ?, ?, ?, generation FROM memory_write_epoch
        WHERE id = 'current'
          AND NOT EXISTS (
            SELECT 1 FROM migration_control
             WHERE id = ?
               AND NOT (reason = ? AND active_delta_expires_at IS NOT NULL
                 AND active_delta_expires_at <= ?)
          )
          AND NOT EXISTS (
            SELECT 1 FROM restore_state
             WHERE id = ?
               AND (completed_at IS NULL
                 OR (lease_owner IS NOT NULL AND lease_expires_at > ?))
          )
      `,
    ).bind(
      admission.token,
      admission.startedAt,
      admission.expiresAt,
      WRITE_LOCK_ID,
      BACKUP_SNAPSHOT_LOCK_REASON,
      startedAt,
      RESTORE_STATE_ID,
      startedAt,
    );
  const [, result] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM memory_write_admissions WHERE expires_at <= ?`).bind(startedAt),
    claim(),
  ]);
  const changed = (value: D1Result) => Number(value.meta.changes
    ?? (value.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changed(result) !== 1) {
    // A table created by an interrupted older schema pass can exist without its singleton
    // generation row. Repair only this exceptional path; successful admissions retain
    // the two-statement hot-path budget.
    await env.DB.prepare(
      `INSERT INTO memory_write_epoch (id, generation) VALUES ('current', ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(crypto.randomUUID()).run();
    const retry = await claim().run();
    if (changed(retry) === 1) return admission;
    await assertMemoryWritesAllowed(env);
    throw new MemoryWriteLockedError({ lockedAt: startedAt, reason: "maintenance", ownerId: "" });
  }
  return admission;
}

export async function releaseMemoryWriteAdmission(
  env: Env,
  admission: MemoryWriteAdmission,
): Promise<void> {
  await env.DB.prepare(`DELETE FROM memory_write_admissions WHERE token = ?`)
    .bind(admission.token).run();
}

/** 同じ権限の解放だけを最大3回試す。失敗時の応答・ログ方針は呼出元が決める。 */
export async function releaseMemoryWriteAdmissionWithRetry(
  env: Env,
  admission: MemoryWriteAdmission,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await releaseMemoryWriteAdmission(env, admission);
      return;
    } catch {
      // 同じ呼出内で再試行し、provider由来の例外本文は外へ出さない。
    }
  }
  throw new Error("Memory write admission release failed");
}

/** Hold an admission until both the awaited handler and every waitUntil task settle. */
export async function beginMemoryWriteAdmission(
  env: Env,
  ctx: ExecutionContext,
  options: { releaseEnv?: Env } = {},
): Promise<{ env: Env; ctx: ExecutionContext; finish: () => Promise<void> }> {
  const admission = await acquireMemoryWriteAdmission(env);
  let pending = 0;
  let handlerDone = false;
  let released = false;
  let releasePromise: Promise<void> | null = null;
  const releaseOnce = async () => {
    if (released) return;
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      await releaseMemoryWriteAdmissionWithRetry(options.releaseEnv ?? env, admission);
      released = true;
    })();
    try {
      await releasePromise;
    } finally {
      releasePromise = null;
    }
  };
  const tracked = Object.create(ctx) as ExecutionContext;
  tracked.waitUntil = (promise: Promise<unknown>) => {
    pending++;
    const settled = Promise.resolve(promise).finally(() => {
      pending--;
      if (handlerDone && pending === 0) {
        ctx.waitUntil(releaseOnce().catch(() => {
          console.error("Memory write admission release failed");
        }));
      }
    });
    ctx.waitUntil(settled);
  };
  return {
    env: admittedEnv(env, admission.token),
    ctx: tracked,
    finish: async () => {
      handlerDone = true;
      if (pending === 0) {
        try {
          await releaseOnce();
        } catch {
          // The mutation already committed. Preserve its response and let the bounded
          // 16-minute TTL fail closed instead of turning success into a retryable 500.
          console.error("Memory write admission release failed");
        }
      }
    },
  };
}

/** Run an authenticated request inside its admission, including response finalization. */
export async function withRequestWriteAdmission(
  env: Env,
  ctx: ExecutionContext,
  needed: boolean,
  run: (env: Env, ctx: ExecutionContext) => Promise<Response>,
): Promise<Response> {
  if (!needed) return run(env, ctx);
  let tracked;
  try {
    tracked = await beginMemoryWriteAdmission(env, ctx);
  } catch (error) {
    if (error instanceof MemoryWriteLockedError) {
      return json({ ok: false, error: error.message, writeLock: error.lock }, error.status);
    }
    throw error;
  }
  try {
    return await run(tracked.env, tracked.ctx);
  } finally {
    await tracked.finish();
  }
}

const READ_ONLY_MCP_TOOLS = new Set([
  "get", "list_projects", "list_recent", "get_hot_context", "get_prompt_capsule",
  "connections", "history", "list_teams",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpMessageNeedsWriteAdmission(payload: unknown): boolean {
  if (!isRecord(payload) || payload.method !== "tools/call") return false;
  if (!isRecord(payload.params) || typeof payload.params.name !== "string") return true;
  return !READ_ONLY_MCP_TOOLS.has(payload.params.name);
}

/** Unknown tools/call names are writes; protocol messages and known pure reads are not. */
export function mcpPayloadNeedsWriteAdmission(payload: unknown): boolean {
  return Array.isArray(payload)
    ? payload.some(mcpMessageNeedsWriteAdmission)
    : mcpMessageNeedsWriteAdmission(payload);
}

export async function mcpRequestNeedsWriteAdmission(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    return mcpPayloadNeedsWriteAdmission(await request.clone().json());
  } catch {
    return false;
  }
}

/** Keep the admission alive while the MCP SDK finishes a finite JSON/SSE body. */
export async function materializeAdmittedResponse(response: Response): Promise<Response> {
  if (response.body === null) return response;
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Classify the REST request after its authentication and trusted-prefix handling. */
export function restRequestNeedsWriteAdmission(request: Request, url: URL): boolean {
  const isRestore = url.pathname.startsWith("/admin/restore/");
  // Snapshot and final-delta reembed own their separate exclusive barriers.
  const isBackupSnapshot = url.pathname === "/admin/backup" && request.method === "POST";
  const isWriteLockControl = url.pathname === "/migration/write-lock";
  const isMigrationReembed = url.pathname === "/migration/reembed";
  const isReadOnlyPost = ["/entry", "/connections", "/graph", "/history", "/list"].includes(url.pathname)
    || url.pathname.startsWith("/prompt-capsules/");
  // Recall writes usage counters even though its primary response is a read.
  return ["/digest", "/export"].includes(url.pathname)
    || (url.pathname === "/recall" && request.method === "POST") || (
      !isRestore && !isBackupSnapshot && !isWriteLockControl && !isMigrationReembed && !isReadOnlyPost
      && !["GET", "HEAD"].includes(request.method)
    );
}

/**
 * Raised by ordinary memory mutations while the final migration delta pass is
 * running. Re-embedding deliberately bypasses this guard: it only rewrites
 * derived vectors and must keep working while source-memory writes are paused.
 */
export class MemoryWriteLockedError extends Error {
  readonly status = 423;

  constructor(readonly lock: MemoryWriteLock) {
    super("Memory writes are temporarily locked for embedding cutover");
    this.name = "MemoryWriteLockedError";
  }
}

/** True only for the stable SQLite trigger message used by the D1 restore fence. */
export function isMemoryWriteFenceError(error: unknown): boolean {
  return /memory-write-locked/i.test(String((error as { message?: string })?.message ?? error));
}

/**
 * Convert a database-trigger rejection into the same typed 423 used by the friendly
 * admission check. This is the expected path for a writer that passed the check before
 * restore began and reached its DML afterwards.
 */
export async function normalizeMemoryWriteLockError(
  env: Env,
  error: unknown,
): Promise<MemoryWriteLockedError | null> {
  if (error instanceof MemoryWriteLockedError) return error;
  if (!isMemoryWriteFenceError(error)) return null;
  try {
    await assertMemoryWritesAllowed(env);
  } catch (lockError) {
    if (lockError instanceof MemoryWriteLockedError) return lockError;
  }
  return new MemoryWriteLockedError({ lockedAt: Date.now(), reason: "r2-restore", ownerId: "" });
}

export async function readMemoryWriteLock(env: Env): Promise<MemoryWriteLock | null> {
  const row = await env.DB.prepare(
    `SELECT locked_at, reason, owner_id, active_delta_expires_at
       FROM migration_control
      WHERE id = ?
        AND NOT (reason = ? AND active_delta_expires_at IS NOT NULL
          AND active_delta_expires_at <= ?)`,
  ).bind(WRITE_LOCK_ID, BACKUP_SNAPSHOT_LOCK_REASON, Date.now()).first() as Record<string, unknown> | null;
  if (!row) return null;
  return {
    lockedAt: Number(row.locked_at),
    reason: typeof row.reason === "string" ? row.reason : "embedding-cutover",
    ownerId: typeof row.owner_id === "string" ? row.owner_id : "",
    ...(row.reason === BACKUP_SNAPSHOT_LOCK_REASON
      && typeof row.active_delta_expires_at === "number"
      ? { expiresAt: row.active_delta_expires_at }
      : {}),
  };
}

interface ActiveWriteBarrierRow {
  locked_at: number;
  reason: string;
  owner_id: string | null;
}

export async function setMemoryWriteLock(
  env: Env,
  reason = "embedding-cutover",
  options: { requireNew?: boolean; expiresInMs?: number } = {},
): Promise<MemoryWriteLock> {
  await initializeDatabase(env);
  const lockedAt = Date.now();
  const expiresAt = options.expiresInMs === undefined
    ? undefined
    : lockedAt + Math.max(1, options.expiresInMs);
  const lock: MemoryWriteLock = {
    lockedAt,
    reason,
    ownerId: crypto.randomUUID(),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
  const nextEpoch = crypto.randomUUID();
  const claim = env.DB.prepare(
    `INSERT INTO migration_control (id, locked_at, reason, owner_id, active_delta_expires_at)
     SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM restore_state
         WHERE id = ?
           AND (completed_at IS NULL
             OR (lease_owner IS NOT NULL AND lease_expires_at > ?))
      )
        AND NOT EXISTS (
          SELECT 1 FROM memory_write_admissions a
          JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
          WHERE a.expires_at > ?
        )
     ON CONFLICT(id) DO UPDATE SET
       locked_at = excluded.locked_at,
       reason = excluded.reason,
       owner_id = excluded.owner_id,
       final_delta_completed_at = NULL,
       active_delta_token = NULL,
       active_delta_expires_at = excluded.active_delta_expires_at
     WHERE migration_control.reason = ?
       AND migration_control.active_delta_expires_at IS NOT NULL
       AND migration_control.active_delta_expires_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM memory_write_admissions a
         JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
         WHERE a.expires_at > ?
       )`,
  ).bind(
    WRITE_LOCK_ID,
    lock.lockedAt,
    lock.reason,
    lock.ownerId,
    expiresAt ?? null,
    RESTORE_STATE_ID,
    lock.lockedAt,
    lock.lockedAt,
    BACKUP_SNAPSHOT_LOCK_REASON,
    lock.lockedAt,
    lock.lockedAt,
  );
  const rotate = env.DB.prepare(
    `INSERT INTO memory_write_epoch (id, generation)
     SELECT 'current', ?
      WHERE EXISTS (SELECT 1 FROM migration_control WHERE id = ? AND owner_id = ?)
     ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`,
  ).bind(nextEpoch, WRITE_LOCK_ID, lock.ownerId);
  const [result, rotateResult] = await env.DB.batch([claim, rotate]);
  const changes = Number((result.meta as D1Result["meta"] & { rows_written?: number }).changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changes === 1) {
    const rotated = Number((rotateResult.meta as D1Result["meta"] & { rows_written?: number }).changes
      ?? (rotateResult.meta as D1Result["meta"] & { rows_written?: number }).rows_written
      ?? 0);
    if (rotated !== 1) throw new Error("Memory write epoch rotation failed");
    return lock;
  }
  if (changes !== 1) {
    // Exclusive callers must never repurpose an ownerless legacy migration lock.
    // They may only create a row or replace their own expired lease above.
    if (options.requireNew) {
      const existing = await readMemoryWriteLock(env);
      if (existing) throw new MemoryWriteLockedError(existing);
      await assertMemoryWritesAllowed(env);
      throw new MemoryWriteLockedError({
        lockedAt: lock.lockedAt,
        reason: "in-flight-memory-write",
        ownerId: "",
      });
    }
    // Upgrade recovery: an old deployment may have left a lock row from before
    // owner_id existed. Claim only that NULL owner once; never rotate a real owner.
    const recoveryEpoch = crypto.randomUUID();
    const recoveryClaim = env.DB.prepare(
      `UPDATE migration_control
          SET locked_at = ?, reason = ?, owner_id = ?, final_delta_completed_at = NULL,
              active_delta_token = NULL, active_delta_expires_at = NULL
        WHERE id = ? AND owner_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM memory_write_admissions a
            JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
            WHERE a.expires_at > ?
          )`,
    ).bind(lock.lockedAt, lock.reason, lock.ownerId, WRITE_LOCK_ID, lock.lockedAt);
    const recoveryRotate = env.DB.prepare(
      `INSERT INTO memory_write_epoch (id, generation)
       SELECT 'current', ?
        WHERE EXISTS (SELECT 1 FROM migration_control WHERE id = ? AND owner_id = ?)
       ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`,
    ).bind(recoveryEpoch, WRITE_LOCK_ID, lock.ownerId);
    const [claimed, recoveredEpoch] = await env.DB.batch([recoveryClaim, recoveryRotate]);
    const claimChanges = Number((claimed.meta as D1Result["meta"] & { rows_written?: number }).changes
      ?? (claimed.meta as D1Result["meta"] & { rows_written?: number }).rows_written
      ?? 0);
    if (claimChanges === 1) {
      const epochChanges = Number((recoveredEpoch.meta as D1Result["meta"] & { rows_written?: number }).changes
        ?? (recoveredEpoch.meta as D1Result["meta"] & { rows_written?: number }).rows_written
        ?? 0);
      if (epochChanges !== 1) throw new Error("Memory write epoch recovery failed");
      return lock;
    }
    const existing = await readMemoryWriteLock(env);
    if (existing) return existing;
    // Produces the same typed 423 error ordinary writers receive, with the durable
    // restore reason and timestamp rather than a generic migration failure.
    await assertMemoryWritesAllowed(env);
    throw new MemoryWriteLockedError({
      lockedAt: lock.lockedAt,
      reason: "in-flight-memory-write",
      ownerId: "",
    });
  }
  return lock;
}

export async function assertMemoryWriteLockOwner(env: Env, ownerId: string): Promise<void> {
  const lock = await readMemoryWriteLock(env);
  if (lock?.ownerId === ownerId) return;
  throw new MemoryWriteLockedError(lock ?? {
    lockedAt: Date.now(),
    reason: "migration-lock-ownership-lost",
    ownerId: "",
  });
}

export async function acquireFinalDeltaLease(env: Env, ownerId: string): Promise<string> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE migration_control
        SET active_delta_token = ?, active_delta_expires_at = ?, final_delta_completed_at = NULL
      WHERE id = ? AND owner_id = ?
        AND active_delta_token IS NULL`,
  ).bind(token, now + FINAL_DELTA_LEASE_MS, WRITE_LOCK_ID, ownerId).run();
  const changed = Number((result.meta as D1Result["meta"] & { rows_written?: number }).changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changed === 1) return token;
  const lock = await readMemoryWriteLock(env);
  throw new MemoryWriteLockedError(lock ?? {
    lockedAt: now,
    reason: "final-delta-in-flight",
    ownerId: "",
  });
}

export async function releaseFinalDeltaLease(env: Env, ownerId: string, token: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE migration_control
        SET active_delta_token = NULL, active_delta_expires_at = NULL
      WHERE id = ? AND owner_id = ? AND active_delta_token = ?`,
  ).bind(WRITE_LOCK_ID, ownerId, token).run();
}

export async function renewFinalDeltaLease(env: Env, ownerId: string, token: string): Promise<void> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE migration_control SET active_delta_expires_at = ?
      WHERE id = ? AND owner_id = ? AND active_delta_token = ? AND active_delta_expires_at > ?`,
  ).bind(now + FINAL_DELTA_LEASE_MS, WRITE_LOCK_ID, ownerId, token, now).run();
  const changed = Number((result.meta as D1Result["meta"] & { rows_written?: number }).changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changed !== 1) {
    throw new MemoryWriteLockedError({
      lockedAt: now,
      reason: "final-delta-lease-lost",
      ownerId,
    });
  }
}

export async function markMemoryWriteLockComplete(
  env: Env,
  ownerId: string,
  deltaToken: string,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE migration_control SET final_delta_completed_at = ?
      WHERE id = ? AND owner_id = ? AND active_delta_token = ?
        AND active_delta_expires_at > ?`,
  ).bind(Date.now(), WRITE_LOCK_ID, ownerId, deltaToken, Date.now()).run();
  const changed = Number((result.meta as D1Result["meta"] & { rows_written?: number }).changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changed !== 1) {
    throw new MemoryWriteLockedError({
      lockedAt: Date.now(),
      reason: "final-delta-lease-lost",
      ownerId,
    });
  }
}

export async function clearMemoryWriteLock(
  env: Env,
  ownerId: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  await initializeDatabase(env);
  const completionGuard = options.force ? "" : " AND final_delta_completed_at IS NOT NULL";
  const result = await env.DB.prepare(
    `DELETE FROM migration_control WHERE id = ? AND owner_id = ?${completionGuard}
      AND (active_delta_token IS NULL OR active_delta_expires_at <= ?)`,
  )
    .bind(WRITE_LOCK_ID, ownerId, Date.now()).run();
  return Number((result.meta as D1Result["meta"] & { rows_written?: number }).changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0) === 1;
}

export async function assertMemoryWritesAllowed(
  env: Env,
  allowedOwnerId?: string,
): Promise<void> {
  // One strongly-consistent read covers both maintenance modes. An unfinished restore
  // remains a barrier between page requests; its current page may pass only by presenting
  // the durable run_id. A completed restore is a barrier solely while an idempotent replay
  // page still owns its short lease.
  const row = await env.DB.prepare(
    `SELECT locked_at, reason, owner_id FROM (
       SELECT locked_at, reason, NULL AS owner_id, 0 AS priority
         FROM migration_control
        WHERE id = ?
          AND NOT (reason = ? AND active_delta_expires_at IS NOT NULL
            AND active_delta_expires_at <= ?)
       UNION ALL
       SELECT started_at AS locked_at, 'r2-restore' AS reason, run_id AS owner_id, 1 AS priority
         FROM restore_state
        WHERE id = ?
          AND (completed_at IS NULL
            OR (lease_owner IS NOT NULL AND lease_expires_at > ?))
     ) ORDER BY priority LIMIT 1`,
  ).bind(
    WRITE_LOCK_ID,
    BACKUP_SNAPSHOT_LOCK_REASON,
    Date.now(),
    RESTORE_STATE_ID,
    Date.now(),
  ).first<ActiveWriteBarrierRow>();
  if (!row) return;
  if (allowedOwnerId && row.owner_id === allowedOwnerId) return;
  throw new MemoryWriteLockedError({
    lockedAt: Number(row.locked_at),
    reason: typeof row.reason === "string" ? row.reason : "maintenance",
    ownerId: typeof row.owner_id === "string" ? row.owner_id : "",
  });
}
