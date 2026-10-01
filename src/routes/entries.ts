import type { Env } from "../env";
import { importExportPayload, parseImportBody, parseImportLimit, parseImportOffset } from "../entries/import";
import { initializeDatabase } from "../db/init";
import { CORS_HEADERS, json, readJsonBody } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { assertCanMutateEntry, getReadableEntry, FORBIDDEN_MSG } from "../lib/entry-access";
import { layerOf, scopeWhere, readTeamParam } from "../lib/scope";
import { readEntryTimeline, listMemoryHistory, MEMORY_HISTORY_MAX_RESULTS } from "../memory/history";
import { loadHistory } from "../memory/versions";
import { buildEntryHistoryFromReads, readEntryVersion } from "../memory/history-view";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { forgetEntry } from "../capture/lifecycle";
import { deleteForever, getTrashedEntry, restoreEntry } from "../memory/trash";
import { decodeTrashCursor, listTrash } from "../memory/trash-list";
import { revertEntry, undoGroup, goneMessage, prunedMessage, restoredMessage, revertedMessage, unreadableMessage } from "../memory/undo";
import { mirrorUndoError } from "../integrations/mirror";
import { applyStatus } from "../capture/lifecycle";
import { moveEntry, restampVectorWorkspace, type ShareTarget } from "../capture/share";
import { auditEvent } from "../lib/audit";
import { resolveConfig } from "../config";
import { STATUS_VALUES, type MemoryStatus } from "../memory/status";
import { parseSupersededBy, validitySummary } from "../recall/validity-view";
import { getTagVocabulary } from "../tags/vocabulary";
import {
  getHotContext,
  isMemoryTier,
  MEMORY_TIERS,
  setMemoryPinned,
  setMemoryTier,
} from "../memory/tier";
import {
  assertExportWithinMemoryLimit, buildExportBundle, buildPagedExportBundle,
  ExportError, parseExportPageLimit, serializeExportWithinMemoryLimit,
} from "../entries/export";
import { supersededBySql } from "../memory/validity";

const TAG_COUNTS_SCAN_LIMIT = 5000;
const MAX_MANUAL_IMPORT_BYTES = 1024 * 1024;

export async function handleEntriesRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /count
  if (url.pathname === "/count" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const scope = scopeWhere(auth);
    const row = await env.DB.prepare(
      // validity: any: 所有者の件数・タグ集計には過去の記憶も含める。
      `SELECT COUNT(*) as count FROM entries WHERE ${scope.clause}`
    ).bind(...scope.bindings).first() as Record<string, any> | null;
    return json({ count: (row?.count as number) ?? 0 });
  }

  // GET /tags — the dashboard's filter dropdown, refetched on every page load.
  // Reads the same cache recall does (#288): the scan behind it costs 180,000 rows
  // on a 20,000-entry brain, and nothing here is worth that per navigation. Unlike
  // recall this route has no useful degraded answer, so a cold cache is scanned
  // inline rather than answered empty — see getTagVocabulary.
  if (url.pathname === "/tags" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const tags = await getTagVocabulary(env, ctx, auth);
    const counts = url.searchParams.get("counts");
    if (counts !== "1" && counts !== "true") return json(tags);

    // counts=1: the same tags with how many memories carry each. One bounded scan of
    // the caller's rows, tallied here; the cached vocabulary keeps the tag set and order.
    // A capped scan undercounts, so it says so in a header rather than the body shape.
    const scope = scopeWhere(auth);
    const { results } = await env.DB.prepare(
      // validity: any: 所有者の件数・タグ集計には過去の記憶も含める。
      `SELECT tags FROM entries WHERE ${scope.clause} LIMIT ${TAG_COUNTS_SCAN_LIMIT}`
    ).bind(...scope.bindings).all<{ tags: string }>();
    const tally = new Map<string, number>();
    for (const row of results) {
      let rowTags: unknown;
      try { rowTags = JSON.parse(row.tags); } catch { continue; }
      if (!Array.isArray(rowTags)) continue;
      for (const tag of new Set(rowTags)) {
        if (typeof tag === "string") tally.set(tag, (tally.get(tag) ?? 0) + 1);
      }
    }
    const response = json(tags.map(tag => ({ tag, count: tally.get(tag) ?? 0 })));
    if (results.length >= TAG_COUNTS_SCAN_LIMIT) response.headers.set("X-Counts-Approximate", "1");
    return response;
  }

  // GET /export — bounded complete export for backward compatibility, or a
  // positionally paged export when paging parameters are present.
  if (url.pathname === "/export" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    // A member's backup is their readable set — personal plus company — not the
    // whole deployment. Same unbounded-SELECT budget note as below applies.
    try {
      const paged = url.searchParams.get("paged") === "1"
        || url.searchParams.has("offset")
        || url.searchParams.has("edge_offset")
        || url.searchParams.has("project_offset")
        || url.searchParams.has("limit");
      if (paged) {
        return json(await buildPagedExportBundle(
          env,
          parseImportOffset(url.searchParams.get("offset")),
          parseImportOffset(url.searchParams.get("edge_offset")),
          parseExportPageLimit(url.searchParams.get("limit")),
          auth,
          parseImportOffset(url.searchParams.get("project_offset")),
        ));
      }
      await assertExportWithinMemoryLimit(env, auth);
      const serialized = serializeExportWithinMemoryLimit(await buildExportBundle(env, auth));
      return new Response(serialized, {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    } catch (error) {
      if (error instanceof ExportError) {
        const message = error.status === 413
          ? `${error.message}; retry with ?paged=1 and follow pagination cursors`
          : error.message;
        return json({ ok: false, error: message }, error.status);
      }
      throw error;
    }
  }

  // POST /import — round-trip counterpart to GET /export (issue #217). Inserts by
  // export id (skip if exists), preserves created_at/updated_at/tags/source, defers
  // embedding via vector_ids=[] so POST /vectorize-pending can backfill without
  // burning the Workers AI quota in one request. Does NOT go through /capture.
  //
  // Paged positionally: one call examines entries[offset .. offset+limit), then —
  // once entries are exhausted — edges[edge_offset .. edge_offset+limit). Clients
  // resend the same file with the next_offset/next_edge_offset from the previous
  // response until both remaining counts are 0. See importExportPayload for why
  // this is what keeps a large restore inside the D1 free-plan query budget.
  if (url.pathname === "/import" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    // Awaited, not left to ensureDbReady's waitUntil: an import is often a freshly
    // deployed brain's first request, which is exactly when the schema ALTERs have
    // not run yet and every insert would fail on a missing column. Latched after
    // the first call, so this costs nothing in the steady state.
    const initialized = await initializeDatabase(env);
    if (initialized.changed) {
      return json({
        ok: false,
        retry: true,
        error: "Database schema initialized; retry the same import request",
      }, 202);
    }

    // JSON can expand by tens of times when millions of tiny objects are parsed. Keep
    // this convenience route conservative; larger recovery uses the bounded R2 path.
    const importedBody = await readJsonBody<unknown>(request, MAX_MANUAL_IMPORT_BYTES);
    if (!importedBody.ok) return importedBody.response;
    const body = importedBody.value;

    const parsed = parseImportBody(body);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

    const limit = parseImportLimit(url.searchParams.get("limit"));
    const offset = parseImportOffset(url.searchParams.get("offset"));
    const edgeOffset = parseImportOffset(url.searchParams.get("edge_offset"));
    const summary = await importExportPayload(env, parsed.payload, {
      limit,
      offset,
      edgeOffset,
      projectOffset: parseImportOffset(url.searchParams.get("project_offset")),
      enforceIndexLimits: true,
      ctx,
      writeCtx: { workspaceId: auth.personalWorkspaceId, actorId: auth.userId },
    });
    return json(summary);
  }

  // POST /forget — delete-by-id, mirrors the MCP `forget` tool. With { permanent: true, confirm: id,
  // nonce } it is Delete forever (T-0089.4.7) instead: it acts only on the trash row with that nonce
  // (the trash view's row), never on a live memory, and is never offered as an MCP tool or parameter.
  if (url.pathname === "/forget" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; permanent?: unknown; confirm?: unknown; nonce?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    const id = body.id.trim();

    if ("permanent" in body) {
      if (body.permanent !== true) return json({ ok: false, error: "permanent must be true" }, 400);
      if (body.confirm !== id) return json({ ok: false, error: "confirm must equal id" }, 400);
      const nonce = body.nonce;
      if (typeof nonce !== "string" || nonce === "") {
        return json({ ok: false, error: "nonce is required: Delete forever works on a trash row only. Forget the memory first, then delete it from the trash." }, 400);
      }

      const trashed = await getTrashedEntry(env, auth, id);
      if (!trashed || trashed.nonce !== nonce) return json({ ok: false, error: `No trashed entry found with ID: ${id}` }, 404);
      const denied = assertCanMutateEntry(auth, trashed);
      if (denied) return json({ ok: false, error: denied.message }, 403);

      const result = await deleteForever(env, id, { actorId: auth.userId, channel: "rest" }, trashed.workspace_id, nonce);
      if (result.status === "not_found") return json({ ok: false, error: `No trashed entry found with ID: ${id}` }, 404);
      return json({ ok: true, id, permanent: true, deletedVectors: result.deletedVectors });
    }

    const row = await getReadableEntry(env, auth, id);
    if (!row) return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);
    const denied = assertCanMutateEntry(auth, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    const cfg = await resolveConfig(env);
    const result = await forgetEntry(id, env, { actorId: auth.userId, channel: "rest" }, { reason: "forget", config: cfg }, row.workspace_id as string, ctx);

    if (result.status === "not_found") {
      return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);
    }

    // Round 4 re-review MINOR: the tier-3 case (not trashed) already has its own reliable
    // life-end marker, written in forgetEntry's own batch (trashManyStatements) -- this
    // fire-and-forget richer event would only duplicate it, so it is skipped for that case alone.
    if (result.trashed) {
      auditEvent(env, ctx, {
        entryId: id, actorId: auth.userId, event: "deleted",
        payload: { deletedVectors: result.vectorCount, channel: "rest", trash: result.trashed, reason: "forget", ...(result.edgesDropped ? { edgesDropped: true } : {}) },
      });
    }
    return json({ ok: true, id, deletedVectors: result.vectorCount, trash: result.trashed, retention_days: cfg.TRASH_RETENTION_DAYS, validity: result.validity });
  }

  // POST /restore — bring a memory back from the trash, with its links and index.
  if (url.pathname === "/restore" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; nonce?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    const id = body.id.trim();
    const nonce = optionalNonce(body);
    if (nonce === null) return json({ ok: false, error: "nonce must be a non-empty string" }, 400);

    const trashed = await getTrashedEntry(env, auth, id);
    // With a nonce, only that exact trash row: a stale view never restores a row that replaced it.
    if (!trashed || (nonce !== undefined && trashed.nonce !== nonce)) return json({ ok: false, error: `No trashed entry found with ID: ${id}` }, 404);
    const denied = assertCanMutateEntry(auth, trashed);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    const cfg = await resolveConfig(env);
    const result = await restoreEntry(env, trashed, { actorId: auth.userId, channel: "rest" }, cfg, ctx);
    if (result.status === "not_found") return json({ ok: false, error: `No trashed entry found with ID: ${id}` }, 404);
    if (result.status === "conflict") return json({ ok: false, error: `An entry with ID ${id} already exists` }, 409);
    if (result.status === "reembed_failed") return json({ ok: false, error: "Could not restore: re-indexing failed. Try again." }, 502);

    auditEvent(env, ctx, {
      entryId: id, actorId: auth.userId, event: "restored",
      payload: { channel: "rest", edgesRestored: result.edgesRestored, trashedReason: result.trashedReason },
    });
    return json({ ok: true, id, edgesRestored: result.edgesRestored, vectorCount: result.vectorCount, validity: result.validity });
  }

  // GET /trash (BE-2, T-0101.2.1, contract 4.3) — the dashboard trash view's page reader.
  // Q10: listTrash already narrows to what the reader can restore.
  if (url.pathname === "/trash" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const limitParam = url.searchParams.get("limit");
    let limit = 20;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
        return json({ ok: false, error: "limit must be an integer between 1 and 50" }, 400);
      }
      limit = parsed;
    }

    const cursorParam = url.searchParams.get("cursor") ?? undefined;
    if (cursorParam !== undefined && decodeTrashCursor(cursorParam) === null) {
      return json({ ok: false, error: "cursor is invalid" }, 400);
    }

    const layerParam = url.searchParams.get("layer") ?? undefined;
    if (layerParam !== undefined && layerParam !== "personal" && layerParam !== "company") {
      return json({ ok: false, error: 'layer must be "personal" or "company"' }, 400);
    }

    const cfg = await resolveConfig(env);
    const { items, nextCursor } = await listTrash(env, auth, {
      limit, cursor: cursorParam, layer: layerParam as "personal" | "company" | undefined, config: cfg,
    });
    return json({ ok: true, retention_days: cfg.TRASH_RETENTION_DAYS, items, next_cursor: nextCursor });
  }

  // POST /undo — reverse the most recent change to a memory (or a specific earlier version, with
  // to_version), or restore it from the trash when nothing live remains. Mirrors the MCP `undo`
  // tool; both call revertEntry, so REST and MCP undo leave identical rows and versions.
  if (url.pathname === "/undo" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; to_version?: unknown; nonce?: unknown; group?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    // Reviewer MAJOR (server.ts's MCP undo had the same gap): a body naming both a single id and
    // a group is ambiguous about which write the caller wants; refused before any read.
    if (body.group !== undefined) return json({ ok: false, error: "Pass either id or group (POST /undo/group), not both." }, 400);
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    const id = body.id.trim();
    const nonce = optionalNonce(body);
    if (nonce === null) return json({ ok: false, error: "nonce must be a non-empty string" }, 400);

    let toVersion: number | undefined;
    if (body.to_version !== undefined) {
      if (typeof body.to_version !== "number" || !Number.isInteger(body.to_version) || body.to_version < 1) {
        return json({ ok: false, error: "to_version must be a positive integer" }, 400);
      }
      toVersion = body.to_version;
    }

    // The workspace THIS call's own scoped read authorizes (Class 1): a live row's, or — undo of a
    // forget — a trashed row's. revertEntry reads the row again moments later on its own; pinning
    // its CAS guard to what this read found is what keeps an unshare in that gap from landing (the
    // same reason forgetEntry, updateEntryContent and appendToEntry all take this same parameter).
    // No permission check here: revertEntry's own canRevert applies rule (b) (a member's own newest
    // change on a company row), which assertCanMutateEntry alone would wrongly refuse.
    const liveRow = await getReadableEntry(env, auth, id, "id, workspace_id");
    const trashedRow = liveRow ? null : await getTrashedEntry(env, auth, id);
    const authorizedWorkspaceId = (liveRow?.workspace_id ?? trashedRow?.workspace_id) as string | undefined;

    const cfg = await resolveConfig(env);
    const result = await revertEntry(env, auth, id, { actorId: auth.userId, channel: "rest" }, cfg, toVersion, authorizedWorkspaceId ?? "", nonce, ctx);

    switch (result.status) {
      case "reverted":
        return json({
          ok: true, id, status: "reverted", targetSeq: result.targetSeq, message: revertedMessage(id, result), validity: result.validity,
          ...(result.recreatedIncomingId ? { recreatedIncomingId: result.recreatedIncomingId } : {}),
          ...(result.incomingTruncated ? { incomingTruncated: true } : {}),
          ...(result.keptIncoming ? { keptIncoming: result.keptIncoming } : {}),
          ...(result.deferredIncoming ? { deferredIncoming: result.deferredIncoming } : {}),
        });
      case "restored":
        return json({
          ok: true, id, status: "restored", message: restoredMessage(id, result), validity: result.validity,
          ...(result.mirrorSource ? { mirrorWarning: true } : {}),
        });
      // 5.6: 200 { ok, result: "released", id } — REST and MCP release leave identical rows except channel.
      case "released":
        return json({ ok: true, id, result: "released", message: `Released entry ${id}. It is back in recall.` });
      case "no_change":
        return json({ ok: true, id, status: "no_change", changed: false, message: `Entry ${id} already matches that version; nothing changed.` });
      // A hidden version reads exactly like one that never existed (D-SH): never reveals whether
      // history predating a share exists.
      case "unreadable":
        return json({ ok: false, error: unreadableMessage(id) }, 404);
      case "pruned":
        return json({ ok: false, error: prunedMessage(id, toVersion!, result.oldestKept, cfg.VERSION_KEEP), oldestKept: result.oldestKept }, 404);
      case "not_found":
        if (result.gone) return json({ ok: false, error: goneMessage(id, result.gone, cfg.TRASH_RETENTION_DAYS), gone: result.gone }, 404);
        return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);
      case "forbidden":
        return json({ ok: false, error: FORBIDDEN_MSG }, 403);
      case "mirrored":
        return json({ ok: false, error: mirrorUndoError(result.source) }, 409);
      case "stale":
        return json({ ok: false, error: "Entry changed after you looked at it; check history and try again." }, 409);
      case "nothing_to_undo":
        return json({ ok: false, error: `Entry ${id} has no recorded changes to undo.` }, 409);
      case "reembed_failed":
        return json({ ok: false, error: "Couldn't update: search did not update. The memory is unchanged. Try again." }, 500);
    }
  }

  // POST /undo/group — "undo all" or "release all" a burst the brief's changes line grouped
  // (5.9). Kept separate from POST /undo above, so contract 4.4 (T-0089.6.6) is untouched.
  // Membership is re-derived from the reader's own scope on every call, never trusted from the
  // client (undoGroup, src/memory/undo.ts). Each call reverts at most UNDO_GROUP_PAGE memories;
  // the caller loops while remaining > 0, the same pattern as POST /vectorize-pending.
  if (url.pathname === "/undo/group" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { group?: unknown; id?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body.id !== undefined) return json({ ok: false, error: "Pass either id (POST /undo) or group, not both." }, 400);
    if (typeof body.group !== "string" || !body.group.trim()) return json({ ok: false, error: "group is required" }, 400);

    const cfg = await resolveConfig(env);
    const result = await undoGroup(env, auth, body.group.trim(), { actorId: auth.userId, channel: "rest" }, cfg, ctx);
    if (!result) return json({ ok: false, error: "Invalid or unreadable group" }, 404);

    return json({ ok: true, results: result.results, done: result.done, remaining: result.remaining, group: result.group });
  }

  if (url.pathname === "/entry" && request.method === "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Use POST /entry with a JSON body" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST" },
    });
  }

  // POST /entry — one full row by id, for the dashboard graph view's tap-to-open
  // (/graph ships 80-char labels only; fattening it with full content would bloat
  // every graph load to serve a per-tap need). Dashboard-only, no MCP twin.
  if (url.pathname === "/entry" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const parsed = await readJsonBody<{ id?: unknown }>(request, 8 * 1024);
    if (!parsed.ok) return parsed.response;
    const id = typeof parsed.value.id === "string" ? parsed.value.id.trim() : "";
    if (!id) return json({ ok: false, error: "id is required" }, 400);

    // Everything the brain knows about one memory, in the one row read it was
    // already doing. The dashboard's detail view shows what the pipeline
    // decided — importance, how often this was recalled, whether it has ever
    // lost a contradiction — and none of it was reachable before v2.3.
    // Scoped like the list above it: an id outside the caller's readable set
    // reads as a missing entry rather than someone else's memory.
    const scope = scopeWhere(auth);
    // validity: any: GET /entry is a listing/detail view, not a current-facts answer (5.9)
    // scope-checked: the superseded_by subquery pins its closer `s` to entries.workspace_id — the outer row's own, already scoped by the caller's clause above
    const row = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, COALESCE(updated_at, created_at) AS last_updated,
              importance_score, recall_count, contradiction_wins, contradiction_losses, memory_tier, pinned, last_recalled_at, vector_ids,
              workspace_id, actor_id, when_at, when_kind, when_source, valid_from, valid_until,
              ${supersededBySql("entries")} AS superseded_by_json
       FROM entries WHERE id = ? AND ${scope.clause}`
    ).bind(id, ...scope.bindings).first() as Record<string, any> | null;
    if (!row) return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);

    let vectorIds: unknown[] = [];
    try { vectorIds = JSON.parse(row.vector_ids ?? "[]"); } catch { vectorIds = []; }

    // BE-7 (T-0101.1.1): history's versions read is the ONE new statement /entry gains. The events
    // read below is the SAME one `timeline` always made — chain.rows' own actor ids just ride along
    // as extraLabelActorIds, so the one `users` lookup that call already does covers version actors
    // too, and buildEntryHistoryFromReads never reads entry_events or users a second time.
    const config = await resolveConfig(env);
    const chain = await loadHistory(env, auth, { id: row.id as string, content: row.content as string }, config.VERSION_KEEP);
    const timelineResult = await readEntryTimeline(
      env, id, auth, String(row.actor_id ?? ""), undefined, false, String(row.workspace_id ?? ""), chain.rows.map(r => r.actor_id),
      String(row.source ?? ""),
    );
    const { timeline, labelMap } = timelineResult;
    const history = await buildEntryHistoryFromReads(env, auth, {
      id: row.id as string, workspace_id: String(row.workspace_id ?? ""), actor_id: String(row.actor_id ?? ""),
      content: row.content as string, created_at: row.created_at as number, valid_until: row.valid_until as number | null,
    }, config, chain, timelineResult);
    const layer = layerOf(auth, row.workspace_id);
    const actorName = resolveActorLabel(String(row.actor_id ?? ""), labelMap, {
      viewerId: auth.userId,
      source: row.source as string,
    });
    const tags = JSON.parse(row.tags ?? "[]");
    const validity = validitySummary({
      createdAt: row.created_at as number,
      validFrom: row.valid_from as number | null | undefined,
      validUntil: row.valid_until as number | null | undefined,
      tags,
      supersededBy: parseSupersededBy(row.superseded_by_json as string | null | undefined),
    });

    return json({
      ok: true,
      entry: {
        id: row.id,
        content: row.content,
        tags,
        source: row.source,
        created_at: row.created_at,
        updated_at: row.last_updated ?? row.created_at,
        importance_score: row.importance_score ?? 0,
        recall_count: row.recall_count ?? 0,
        contradiction_wins: row.contradiction_wins ?? 0,
        contradiction_losses: row.contradiction_losses ?? 0,
        memory_tier: row.memory_tier ?? "warm",
        pinned: Number(row.pinned ?? 0) === 1,
        last_recalled_at: row.last_recalled_at ?? null,
        // Whether recall can see it at all — the dashboard already surfaces
        // "not indexed" in lists, and the detail view should agree.
        indexed: Array.isArray(vectorIds) && vectorIds.length > 0,
        when_at: row.when_at ?? null,
        when_kind: row.when_kind ?? null,
        when_source: row.when_source ?? null,
        workspace: layer,
        actor_name: actorName,
        valid_from: validity.validFrom,
        valid_from_stated: validity.validFromStated,
        valid_until: validity.validUntil,
        validity_state: validity.validityState,
        superseded_by: validity.supersededBy,
        retracted_source: validity.retractedSource,
        // Whether this caller may edit or forget it, answered by the very
        // predicate the mutation routes enforce with — so the dashboard stops
        // offering an action it will be refused for. One flag rather than two
        // because the server checks edit and delete through the same guard
        // (assertCanEditContent is a re-export of assertCanMutateEntry), and two
        // flags that can never disagree are one flag. Both columns are already
        // in the SELECT above: no extra query.
        can_edit: assertCanMutateEntry(auth, {
          workspace_id: String(row.workspace_id ?? ""),
          actor_id: String(row.actor_id ?? ""),
        }) === null,
        timeline,
        history,
        legacyVersions: await listMemoryHistory(env, id, MEMORY_HISTORY_MAX_RESULTS, auth),
      },
    });
  }

  // 履歴本文も記憶IDをURLへ載せず、JSON本文で取得する。
  if (url.pathname === "/entry/version" && request.method === "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Use POST /entry/version with a JSON body" }), {
      status: 405, headers: { "Content-Type": "application/json", "Allow": "POST" },
    });
  }
  if (url.pathname === "/entry/version" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const parsed = await readJsonBody<{ id?: unknown; seq?: unknown }>(request, 8 * 1024);
    if (!parsed.ok) return parsed.response;
    if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return json({ ok: false, error: "JSON本文はオブジェクトにしてください" }, 400);
    const id = typeof parsed.value.id === "string" ? parsed.value.id.trim() : "";
    if (!id) return json({ ok: false, error: "id is required" }, 400);
    const seq = parsed.value.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return json({ ok: false, error: "seq must be a positive integer" }, 400);

    const config = await resolveConfig(env);
    const result = await readEntryVersion(env, auth, id, seq, config);
    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        pruned: `Version ${seq} of entry ${id} is no longer kept (only the last ${config.VERSION_KEEP} changes are). The oldest kept is version ${result.oldestKept}.`,
        not_visible: `No version ${seq} of entry ${id} is visible to you.`,
        no_version: `Entry ${id} has no version ${seq}.`,
      };
      return json({
        ok: false, error: messages[result.reason], reason: result.reason,
        ...(result.reason === "pruned" ? { oldest_kept: result.oldestKept } : {}),
      }, 404);
    }
    return json({
      ok: true, id: result.id, seq: result.seq, content: result.content, tags: result.tags,
      status: result.status, held: result.held, at: result.at, reason: result.reason, channel: result.channel,
      client: result.client, actor_name: result.actor_name,
    });
  }

  // POST /share — move an entry between the caller's personal and the company
  // workspace (the two-layer visibility model). MOVE semantics: one canonical
  // row, edges follow it, audited. Mirrors the MCP `share` tool.
  if (url.pathname === "/share" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; workspace?: string; team?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (body.workspace !== undefined && body.workspace !== "personal" && body.workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }
    const target = (body.workspace ?? "company") as ShareTarget;
    const teamRead = readTeamParam(body.team, auth, target);
    if (teamRead.error) return json({ ok: false, error: teamRead.error }, 400);

    const id = body.id.trim();
    const result = await moveEntry(id, target, env, auth, { actorId: auth.userId, channel: "rest" }, teamRead.teamId, ctx);

    if (result.status === "not_found") {
      return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);
    }
    if (result.status === "forbidden") {
      return json({ ok: false, error: "Only the entry's author or an admin can un-share it" }, 403);
    }
    if (result.status === "conflict") {
      return json({ ok: false, error: "Entry changed while saving, try again" }, 409);
    }
    if (result.status === "no_change") {
      return json({ ok: true, id, status: "no_change" });
    }

    // The shared/unshared event is written inside moveEntry's own batch (M5): no separate audit here.
    // Before the response: the D1 move is already committed, so a Vectorize outage here can only
    // cost this cosmetic ranking follow-up, never the state change itself.
    ctx.waitUntil(restampVectorWorkspace(env, result.vectorIds, result.workspaceId));
    return json({ ok: true, id, status: result.status, workspaceId: result.workspaceId });
  }

  // POST /status — set lifecycle status, mirrors the MCP `set_status` tool
  if (url.pathname === "/status" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; status?: string };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (!(STATUS_VALUES as readonly string[]).includes(body.status ?? "")) {
      return json({ ok: false, error: `status must be one of: ${STATUS_VALUES.join(", ")}` }, 400);
    }

    const id = body.id.trim();
    const status = body.status as MemoryStatus;
    const row = await getReadableEntry(env, auth, id);
    if (!row) return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);
    const denied = assertCanMutateEntry(auth, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    const result = await applyStatus(id, status, env, { actorId: auth.userId, channel: "rest" }, await resolveConfig(env), row.workspace_id as string, ctx);

    if (result.status === "not_found") {
      return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);
    }
    if (result.status === "reembed_failed") {
      return json({ ok: false, error: "Could not change the status: re-indexing failed. Nothing changed. Try again." }, 502);
    }

    auditEvent(env, ctx, { id: result.eventId, entryId: id, actorId: auth.userId, event: "status_changed", payload: { status, channel: "rest" } });
    return json({ ok: true, id, status, indexed: result.indexed, validity: result.validity });
  }

  if (url.pathname === "/memory/tier" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: unknown; tier?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (typeof body.id !== "string" || !body.id.trim()) {
      return json({ ok: false, error: "id is required" }, 400);
    }
    if (!isMemoryTier(body.tier)) {
      return json({ ok: false, error: `tier must be one of: ${MEMORY_TIERS.join(", ")}` }, 400);
    }
    const id = body.id.trim();
    const row = await getReadableEntry(env, auth, id);
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    const denied = assertCanMutateEntry(auth, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);
    if (!(await setMemoryTier(env, id, body.tier))) {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }
    return json({ ok: true, id, tier: body.tier });
  }

  if (url.pathname === "/memory/pin" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: unknown; pinned?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (typeof body.id !== "string" || !body.id.trim()) {
      return json({ ok: false, error: "id is required" }, 400);
    }
    if (typeof body.pinned !== "boolean") {
      return json({ ok: false, error: "pinned must be a boolean" }, 400);
    }
    const id = body.id.trim();
    const row = await getReadableEntry(env, auth, id);
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    const denied = assertCanMutateEntry(auth, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);
    if (!(await setMemoryPinned(env, id, body.pinned))) {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }
    return json({ ok: true, id, pinned: body.pinned });
  }

  if (url.pathname === "/hot-context" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    return json({ ok: true, ...(await getHotContext(env, auth)) });
  }

  return null;
}

/** An optional trash-row nonce: undefined when absent, null when present but not a non-empty string. */
function optionalNonce(body: { nonce?: unknown }): string | undefined | null {
  if (!("nonce" in body) || body.nonce === undefined) return undefined;
  return typeof body.nonce === "string" && body.nonce !== "" ? body.nonce : null;
}
