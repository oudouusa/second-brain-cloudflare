import { resolveConfig } from "../config";
import { MemoryInputError } from "../capture/store";
import type { Env } from "../env";
import { assertCanEditContent, getReadableEntry } from "../lib/entry-access";
import { json } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { isManagedMirror, mirrorEditError } from "../integrations/mirror";
import {
  rolloverEntry,
  RolloverAlreadyExistsError,
  RolloverNotNeededError,
  RolloverOperationConflictError,
  RolloverSourceChangedError,
} from "../memory/rollover";
import { MEMORY_ROLLOVER_SNAPSHOT_MAX_CHARS } from "../memory/rollover-policy";
import { VOLATILITY_VALUES, type Volatility } from "../memory/volatility";

function readVolatility(raw: unknown): { value?: Volatility; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string" || !(VOLATILITY_VALUES as readonly string[]).includes(raw)) {
    return { error: `volatility must be one of: ${VOLATILITY_VALUES.join(", ")}` };
  }
  return { value: raw as Volatility };
}

/**
 * POST /rollover lives outside the broad capture router so this fork's lifecycle
 * extension stays an additive registration instead of expanding an upstream hotspot.
 */
export async function handleRolloverRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname !== "/rollover" || request.method !== "POST") return null;

  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  let body: { id?: string; snapshot?: string; volatility?: unknown; operation_id?: unknown };
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
  if (!body.snapshot?.trim()) return json({ ok: false, error: "snapshot is required" }, 400);
  if (body.snapshot.trim().length > MEMORY_ROLLOVER_SNAPSHOT_MAX_CHARS) {
    return json({ ok: false, error: `snapshot is limited to ${MEMORY_ROLLOVER_SNAPSHOT_MAX_CHARS} characters` }, 413);
  }
  if (typeof body.operation_id !== "string" || !body.operation_id.trim() || body.operation_id.length > 128) {
    return json({ ok: false, error: "operation_id must be a non-empty string of at most 128 characters" }, 400);
  }

  const rolloverVol = readVolatility(body.volatility);
  if (rolloverVol.error) return json({ ok: false, error: rolloverVol.error }, 400);
  const id = body.id.trim();
  const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, source");
  if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
  const denied = assertCanEditContent(identity, row);
  if (denied) return json({ ok: false, error: denied.message }, 403);
  if (await isManagedMirror(row.source as string, env)) {
    return json({ ok: false, error: mirrorEditError(row.source as string) }, 409);
  }

  try {
    const result = await rolloverEntry(
      env,
      id,
      body.snapshot,
      ctx,
      await resolveConfig(env),
      {
        operationId: body.operation_id.trim(),
        volatility: rolloverVol.value,
        writeContext: { workspaceId: String(row.workspace_id ?? ""), actorId: identity.userId },
      },
    );
    return json({
      ok: true,
      id: result.id,
      source_id: result.sourceId,
      replayed: result.replayed,
      source_chars: result.sourceChars,
      snapshot_chars: result.snapshotChars,
      indexing_scheduled: result.indexingScheduled,
      message: result.replayed
        ? "This rollover operation was already applied; no duplicate continuation was created"
        : "Continuation created; the original journal was preserved and moved to the cold tier",
    });
  } catch (error) {
    if (error instanceof RolloverAlreadyExistsError
      || error instanceof RolloverOperationConflictError
      || error instanceof RolloverNotNeededError
      || error instanceof RolloverSourceChangedError) {
      return json({ ok: false, error: error.message }, 409);
    }
    if (error instanceof MemoryInputError) {
      return json({ ok: false, error: error.message }, error.status);
    }
    return json({ ok: false, error: `Rollover failed: ${(error as Error).message}` }, 500);
  }
}
