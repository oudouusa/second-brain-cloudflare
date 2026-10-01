/**
 * Embedding-migration surface for the desktop app (#248).
 *
 * The app orchestrates a model change — create the new index, redeploy the
 * binding at it, rebuild every vector, verify, then drop the old index — because
 * only the app holds Cloudflare credentials. These routes are the parts that
 * have to run inside the Worker: reading D1 for the estimate, and re-embedding.
 *
 * Authenticated with the same AUTH_TOKEN as the rest of the API.
 *
 * `POST /migration/reembed` does one bounded batch and returns `remaining`, so
 * the caller loops until it reaches zero — the same shape as
 * `POST /vectorize-pending` and the integration syncs. One request cannot do the
 * whole rebuild: Workers cap subrequests per invocation, and a brain of a few
 * thousand entries needs thousands of model calls.
 */
import type { Env } from "../env";
import { json, readJsonBody, requireAuth } from "../lib/http";
import { resolveConfig } from "../config";
import { assertEmbeddingConfig } from "../embedding/profile";
import { initializeDatabase } from "../db/init";
import {
  clearMigration,
  estimate,
  MigrationPhaseError,
  readMigration,
  runBatch,
  runDeltaBatch,
} from "../migration/embedding";
import {
  clearMemoryWriteLock,
  acquireFinalDeltaLease,
  beginMemoryWriteAdmission,
  MemoryWriteLockedError,
  readMemoryWriteLock,
  releaseFinalDeltaLease,
  setMemoryWriteLock,
} from "../migration/write-lock";

export async function handleMigrationRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /migration/estimate — what a rebuild would cost, before anything is
  // created. The app shows this first; the price should be known before
  // committing, not discovered during.
  if (url.pathname === "/migration/estimate" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const cfg = await resolveConfig(env);
    const { entries, chunks } = await estimate(env);
    return json({
      ok: true,
      entries,
      // A lower bound — see the note on CHUNK_STRIDE. Named so the app can say
      // "at least" rather than implying precision it does not have.
      chunksAtLeast: chunks,
      ...assertEmbeddingConfig(cfg),
    });
  }

  // GET /migration/status — the ledger. The app reads this to resume an
  // interrupted rebuild, and to tell the user where it got to.
  if (url.pathname === "/migration/status" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    await initializeDatabase(env);
    const state = await readMigration(env);
    const writeLock = await readMemoryWriteLock(env);
    const cfg = await resolveConfig(env);
    return json({
      ok: true,
      // null means no rebuild has ever been started for this brain.
      state,
      writeLock,
      // The model currently in force, so the app can spot a ledger left over
      // from a different target.
      ...assertEmbeddingConfig(cfg),
    });
  }

  // POST /migration/reembed — one bounded batch.
  if (url.pathname === "/migration/reembed" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { phase?: unknown; restart?: unknown; lockOwner?: unknown } = {};
    if (request.body) {
      const parsedBody = await readJsonBody<typeof body>(request, 8 * 1024);
      if (!parsedBody.ok) return parsedBody.response;
      body = parsedBody.value;
    }
    if (body.phase !== undefined && body.phase !== "full" && body.phase !== "delta") {
      return json({ ok: false, error: "phase must be full or delta" }, 400);
    }
    if (body.restart !== undefined && typeof body.restart !== "boolean") {
      return json({ ok: false, error: "restart must be a boolean" }, 400);
    }
    if (body.lockOwner !== undefined && typeof body.lockOwner !== "string") {
      return json({ ok: false, error: "lockOwner must be a string" }, 400);
    }

    const cfg = await resolveConfig(env);
    const phase = body.phase === "delta" ? "delta" : "full";
    let finishAdmission: (() => Promise<void>) | undefined;
    let admittedEnv = env;
    let finalDeltaLease: { ownerId: string; token: string } | undefined;
    try {
      const writeLock = await readMemoryWriteLock(env);
      let lockOwner: string | undefined;
      if (writeLock) {
        if (phase !== "delta" || !writeLock.ownerId || body.lockOwner !== writeLock.ownerId) {
          throw new MemoryWriteLockedError(writeLock);
        }
        lockOwner = writeLock.ownerId;
        const token = await acquireFinalDeltaLease(env, lockOwner);
        finalDeltaLease = { ownerId: lockOwner, token };
      } else {
        const admission = await beginMemoryWriteAdmission(env, ctx);
        finishAdmission = admission.finish;
        admittedEnv = admission.env;
      }
      const result = phase === "delta"
        ? await runDeltaBatch(admittedEnv, cfg, {
            restart: body.restart === true,
            lockOwner,
            deltaToken: finalDeltaLease?.token,
          })
        : await runBatch(admittedEnv, cfg);
      return json({ ok: true, phase, ...result });
    } catch (e) {
      if (e instanceof MemoryWriteLockedError) {
        return json({ ok: false, error: e.message, writeLock: e.lock }, e.status);
      }
      if (e instanceof MigrationPhaseError) {
        return json({ ok: false, error: e.message }, e.status);
      }
      throw e;
    } finally {
      if (finalDeltaLease) {
        try {
          await releaseFinalDeltaLease(env, finalDeltaLease.ownerId, finalDeltaLease.token);
        } catch {
          console.error("Final delta lease release failed");
        }
      }
      await finishAdmission?.();
    }
  }

  // The lock is enabled only for the final, restarted delta pass. D1 makes it
  // strongly visible to API and MCP writers across colos; clearing is explicit
  // so a failed smoke test cannot silently unlock the brain.
  if (url.pathname === "/migration/write-lock" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    let body: { reason?: unknown } = {};
    if (request.body) {
      const parsed = await readJsonBody<typeof body>(request, 8 * 1024);
      if (!parsed.ok) return parsed.response;
      body = parsed.value;
    }
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return json({ ok: false, error: "reason must be a string" }, 400);
    }
    const lock = await setMemoryWriteLock(env, body.reason?.trim() || "embedding-cutover");
    return json({ ok: true, writeLock: lock });
  }

  if (url.pathname === "/migration/write-lock" && request.method === "DELETE") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const parsed = await readJsonBody<{ lockOwner?: unknown; force?: unknown }>(request, 8 * 1024);
    if (!parsed.ok) return parsed.response;
    if (typeof parsed.value.lockOwner !== "string" || !parsed.value.lockOwner.trim()) {
      return json({ ok: false, error: "lockOwner is required" }, 400);
    }
    if (parsed.value.force !== undefined && typeof parsed.value.force !== "boolean") {
      return json({ ok: false, error: "force must be a boolean" }, 400);
    }
    if (!await clearMemoryWriteLock(env, parsed.value.lockOwner, { force: parsed.value.force === true })) {
      return json({
        ok: false,
        error: "Migration write-lock owner did not match or final delta is incomplete",
      }, 409);
    }
    return json({ ok: true, writeLock: null });
  }

  // POST /migration/reset — forget the ledger so the next batch starts from the
  // beginning. Rebuilding is idempotent (upserts are journaled and stale IDs are retired, and the
  // upsert overwrites), so this costs model calls but cannot corrupt anything.
  if (url.pathname === "/migration/reset" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    await clearMigration(env);
    return json({ ok: true });
  }

  return null;
}
