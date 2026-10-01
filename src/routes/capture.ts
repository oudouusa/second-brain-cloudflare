import { validInputTags, projectSlugError, projectTagError, withProjectTag, MAX_INPUT_TAGS, MAX_INPUT_TAG_CHARS, reservedTagsNote, stripNewReservedTags } from "../tags/system";
import { autoCreateProject } from "../projects/autocreate";
import { parseExplicitWhen } from "../when/input";
import type { Env } from "../env";
import { resolveConfig, type Config } from "../config";
import { VECTORIZE_FIX_HINT } from "../constants";
import { json } from "../lib/http";
import { requireIdentity, type Identity } from "../lib/identity";
import { assertCanEditContent, getReadableEntry } from "../lib/entry-access";
import { scopeWrite, effectiveWriteTarget, readTeamParam, type WriteContext } from "../lib/scope";
import { captureEntry } from "../capture/entry";
import { partitionIgnoredTags, t7ReplyText, validateT7Capture, validateT7RestFields, type T7CaptureInput } from "../capture/t7-capture";
import { appendToEntry, AppendOperationConflictError, MemoryInputError, EntryGoneError, updateEntryContent, WriteConflictError } from "../capture/store";
import { isManagedMirror, mirrorEditError } from "../integrations/mirror";
import { auditEvent } from "../lib/audit";
import { maybeMarkFollowed } from "../recall/log";
import { VOLATILITY_VALUES, withVolatility, type Volatility } from "../memory/volatility";
import { contentByteLength, isOverContentLimit, tooLargeRestBody, MAX_CONTENT_BYTES } from "../lib/content-size";
import { parseValidityInput, updateEntryValidity, VALIDITY_WITH_CONTENT_ERROR, type UpdateValidityResult } from "../memory/validity";

// Copy deck 9.1 (T-0089.4.2): too_long's own REST message, ahead of any T7 reply text or the
// generic held message — there is no nightly check to wait on any more, just a note over the
// scorer's budget that only the owner can read and release.
const TOO_LONG_MESSAGE = "Saved, but held out of search because it is too long to check automatically. Read it and release it if it's fine. Shorter memories (about 5,000 words or less) are not held.";
import {
  WORKERS_AI_QUOTA_CODE,
  WorkersAiQuotaError,
  workersAiQuotaRetryMessage,
  workersAiRetryAfterSeconds,
} from "../lib/ai";

function workersAiQuotaResponse(retryAt: number, unchanged: boolean): Response {
  const response = json({
    ok: false,
    code: WORKERS_AI_QUOTA_CODE,
    retry_at: retryAt,
    error: `${workersAiQuotaRetryMessage(retryAt)}${unchanged ? " Your memory is unchanged." : ""}`,
  }, 429);
  response.headers.set("Retry-After", String(workersAiRetryAfterSeconds(retryAt)));
  return response;
}

/** Validate route-only volatility input; MCP gets equivalent Zod validation. */
/** Where this caller's writes land and who gets stamped on them. */
export async function writeContextFor(
  env: Env,
  identity: Identity,
  target?: unknown,
  team?: unknown,
): Promise<WriteContext | Response> {
  // Precedence lives in effectiveWriteTarget: explicit request value, then the
  // member's own default_share override, then the org's TEAM_DEFAULT_WORKSPACE,
  // then personal. scopeWrite resolves the id from the identity, so no request
  // value can name an arbitrary workspace.
  const orgDefault = (await resolveConfig(env)).TEAM_DEFAULT_WORKSPACE;
  const resolvedTarget = effectiveWriteTarget(identity, target, orgDefault);
  const teamRead = readTeamParam(team, identity, resolvedTarget);
  if (teamRead.error) return json({ ok: false, error: teamRead.error }, 400);
  return {
    workspaceId: scopeWrite(identity, resolvedTarget, teamRead.teamId),
    actorId: identity.userId,
  };
}

function readVolatility(raw: unknown): { value?: Volatility; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string" || !(VOLATILITY_VALUES as readonly string[]).includes(raw)) {
    return { error: `volatility must be one of: ${VOLATILITY_VALUES.join(", ")}` };
  }
  return { value: raw as Volatility };
}

/**
 * Additive: older clients ignore both extra fields. Merged rather than
 * overwritten, since several branches already carry their own `message`.
 * `extraNotes` (Design 1.3) carries T7's own per-tag notes ("use standing: true"),
 * kept separate from `ignored` so a T7 tag is never also named in the generic sentence.
 */
function withReservedNote(body: Record<string, unknown>, ignored: readonly string[], extraNotes: readonly string[] = []): Record<string, unknown> {
  const notes = [...extraNotes, ...(ignored.length ? [reservedTagsNote(ignored)] : [])];
  if (!notes.length) return body;
  const combined = notes.join(" ");
  const existingMessage = typeof body.message === "string" ? body.message : undefined;
  return {
    ...body,
    ...(ignored.length ? { ignored_tags: [...ignored] } : {}),
    message: existingMessage ? `${existingMessage} ${combined}` : combined,
  };
}

export async function handleCaptureRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // POST /capture
  if (url.pathname === "/capture" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: {
      content?: string; tags?: string[]; source?: string; volatility?: unknown; workspace?: unknown; team?: unknown; project?: unknown; when?: unknown; when_kind?: unknown;
      standing?: unknown; decision?: unknown; confidence?: unknown; confidence_source?: unknown; review_by?: unknown; owed_by?: unknown; owed_to?: unknown;
      valid_from?: unknown; valid_until?: unknown;
    };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body.tags !== undefined && !validInputTags(body.tags)) return json({ ok: false, error: `tags must contain at most ${MAX_INPUT_TAGS} NUL-free strings of at most ${MAX_INPUT_TAG_CHARS} characters` }, 400);
    const badProjectTag = body.tags === undefined ? null : projectTagError(body.tags);
    if (badProjectTag) return json({ ok: false, error: badProjectTag }, 400);
    if (typeof body.content === "string" && body.content.includes("\0")) return json({ ok: false, error: "NUL is not allowed" }, 400);
    if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);
    if (body.source !== undefined && typeof body.source !== "string") {
      return json({ ok: false, error: "source must be a string" }, 400);
    }
    if (body.tags !== undefined
      && (!Array.isArray(body.tags) || body.tags.some(tag => typeof tag !== "string"))) {
      return json({ ok: false, error: "tags must be an array of strings" }, 400);
    }
    // Rahil's decision (18-copy-deck.md 6.8): 128 KB per note, so a very large paste cannot
    // spend the Worker's 10 ms CPU budget on one write. Checked before anything is written.
    if (isOverContentLimit(body.content)) return json(tooLargeRestBody(), 413);
    if (body.workspace !== undefined && body.workspace !== "personal" && body.workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }

    const captureVol = readVolatility(body.volatility);
    if (captureVol.error) return json({ ok: false, error: captureVol.error }, 400);

    // Every T7 field's type/range is checked here, unconditionally, before anything below
    // branches on `decision` or reads a field under a different path (the class of bug a
    // cross-vendor review found: decision:true skipped `when`'s own type guard and crashed
    // parseExplicitWhen with a 500 instead of a 400).
    const restFieldError = validateT7RestFields(body);
    if (restFieldError) return json({ ok: false, error: restFieldError.error }, 400);
    const t7Input: T7CaptureInput = {
      standing: body.standing === undefined ? undefined : !!body.standing,
      decision: body.decision === undefined ? undefined : !!body.decision,
      confidence: body.confidence as number | undefined,
      confidence_source: body.confidence_source as "stated" | "inferred" | undefined,
      review_by: body.review_by as string | undefined,
      owed_by: body.owed_by as string | undefined,
      owed_to: body.owed_to as string | undefined,
      when: body.when as string | undefined,
      when_kind: body.when_kind as string | undefined,
    };
    const t7Validation = validateT7Capture(t7Input);
    if (t7Validation) return json({ ok: false, error: t7Validation.error }, 400);

    // A decision's review date comes from review_by/when, resolved inside captureEntry
    // (Design 4.1); the generic when/when_kind parsing below is skipped for it. A
    // commitment's promised date is an ordinary `when`, just defaulting when_kind to
    // "due" instead of "wake" (Design 5.1) when the caller left it out.
    let when: { at: number; kind: "due" | "event" | "wake"; source: "explicit" } | undefined;
    if (!t7Input.decision) {
      const hasCommitment = body.owed_by !== undefined || body.owed_to !== undefined;
      const effectiveKind = body.when_kind ?? (hasCommitment ? "due" : undefined);
      if (body.when !== undefined && body.when !== null) {
        if (typeof body.when !== "string") return json({ ok: false, error: "when must be a string" }, 400);
        const parsed = parseExplicitWhen(body.when, effectiveKind, undefined, (await resolveConfig(env)).TIMEZONE);
        if (parsed.error) return json({ ok: false, error: parsed.error }, 400);
        when = parsed.value;
      } else if (body.when_kind !== undefined) {
        return json({ ok: false, error: "when_kind requires when" }, 400);
      }
    }

    // T-0089.2.1: when the fact became and stopped being true, as the user said it.
    const validity = parseValidityInput(body, Date.now(), (await resolveConfig(env)).TIMEZONE, { allowNull: false });
    if ("error" in validity) return json({ ok: false, error: validity.error, field: validity.field }, 400);

    // Empty means absent, like every other optional param. A bad slug is bad input, not an
    // unknown project, so it fails the capture before anything is written.
    let projectSlug: string | undefined;
    if (body.project !== undefined && body.project !== null && body.project !== "") {
      if (typeof body.project !== "string") return json({ ok: false, error: "project must be a string" }, 400);
      projectSlug = body.project.trim();
      const badSlug = projectSlugError(projectSlug);
      if (badSlug) return json({ ok: false, error: badSlug }, 400);
    }

    const volatileTags = captureVol.value
      ? withVolatility(body.tags ?? [], captureVol.value)
      : body.tags ?? [];
    const captureTags = projectSlug ? withProjectTag(volatileTags, projectSlug) : volatileTags;
    // forkの保存上限は自動付与タグを含めて検証する。

    // Computed on the caller's raw tags — captureEntry strips these again on its own
    // path (normalizeCaptureInput), this is purely for telling the caller honestly.
    // Design 1.3: a T7-namespace tag gets its own specific note, kept out of the
    // generic reserved-tags sentence so it is never named in both.
    const { ignored: allIgnoredTags } = stripNewReservedTags(body.tags ?? []);
    const { t7Notes, otherIgnored: ignoredReservedTags } = partitionIgnoredTags(body.tags ?? [], allIgnoredTags);

    const writeCtx = await writeContextFor(env, identity, body.workspace, body.team);
    if (writeCtx instanceof Response) return writeCtx;
    let result;
    try {
      const cfg = await resolveConfig(env);
      result = await captureEntry(
        body.content,
        captureTags,
        body.source?.trim() || "api",
        env,
        ctx,
        cfg,
        writeCtx,
        when,
        { channel: "rest", t7: t7Input, validity: validity.value },
      );
    } catch (error) {
      if (error instanceof MemoryInputError) {
        return json({ ok: false, error: error.message }, error.status);
      }
      throw error;
    }

    if (result.status === "t7_refused") {
      return json({ ok: false, error: result.error }, 400);
    }

    if (projectSlug && result.status !== "blocked") {
      await autoCreateProject(env, ctx, { workspaceId: writeCtx.workspaceId, actorId: identity.userId, slug: projectSlug });
    }

    if (result.status !== "blocked") {
      auditEvent(env, ctx, {
        entryId: result.id,
        actorId: identity.userId,
        event: result.status === "stored" || result.status === "flagged" ? "created" : "updated",
        payload: { captureStatus: result.status, channel: "rest" },
      });
      // 5.4: the hold's own event, written alongside the write's own.
      if ((result.status === "stored" || result.status === "flagged") && result.held) {
        auditEvent(env, ctx, {
          entryId: result.id,
          actorId: identity.userId,
          event: "held",
          payload: { reasons: result.held.reasons, score: result.held.score, channel: "rest" },
        });
      }
    }

    if (result.status === "blocked") {
      return json({
        ok: false,
        duplicate: true,
        matchId: result.matchId,
        score: parseFloat((result.score * 100).toFixed(1)),
        message: "Near-exact duplicate detected. Not stored.",
      });
    }
    const t7Message = async () => result.t7 && t7ReplyText(result.id, result.t7, {
      timezone: (await resolveConfig(env)).TIMEZONE, hasProject: !!projectSlug, commitmentWhenAt: when?.at,
    });
    if (result.status === "contradiction") {
      const supersede = result.supersede
        ? { closed_id: result.supersede.closedId, at: result.supersede.at, direction: result.supersede.direction }
        : null;
      return json(withReservedNote({ ok: true, id: result.id, resolved_conflict: result.resolvedConflict, reason: result.reason, supersede, message: await t7Message() }, ignoredReservedTags, t7Notes));
    }
    if (result.status === "contradiction_protected") {
      return json(withReservedNote({
        ok: true,
        id: result.id,
        status: result.entryStatus,
        kept_canonical: result.canonicalId,
        reason: result.reason,
        message: await t7Message(),
      }, ignoredReservedTags, t7Notes));
    }
    if (result.status === "replaced") {
      return json(withReservedNote({ ok: true, id: result.id, action: "replaced", message: "The new memory replaced an older one." }, ignoredReservedTags, t7Notes));
    }
    if (result.status === "merged") {
      return json(withReservedNote({ ok: true, id: result.id, action: "merged", message: "Merged into an existing memory." }, ignoredReservedTags, t7Notes));
    }
    if (result.status === "flagged") {
      const message = await t7Message();
      return json(withReservedNote({
        ok: true,
        id: result.id,
        warning: "similar",
        matchId: result.matchId,
        score: parseFloat((result.score * 100).toFixed(1)),
        held: result.held ? { reason: result.held.reasons[0] } : null,
        message: result.held?.reasons[0] === "too_long" ? TOO_LONG_MESSAGE : (message ?? "Stored but similar entry exists: tagged as duplicate-candidate"),
      }, ignoredReservedTags, t7Notes));
    }
    // Additive: older clients ignore the extra field, and the dashboard uses it
    // to show what was filed under what.
    return json(withReservedNote({
      ok: true, id: result.id, tags: result.tags ?? [],
      semantic_unavailable: result.semanticUnavailable ?? false,
      semantic_unavailable_reason: result.semanticUnavailableReason ?? null,
      semantic_retry_at: result.semanticRetryAt ?? null,
      classification_pending: result.classificationDeferred ?? false,
      classification_status: result.held ? "held" : result.classificationDeferred ? "deferred" : "scheduled",
      held: result.held ? { reason: result.held.reasons[0] } : null,
      message: result.held?.reasons[0] === "too_long" ? TOO_LONG_MESSAGE
        : result.semanticUnavailable && result.semanticRetryAt
          ? `Stored in D1 and keyword-searchable. Semantic indexing is pending. ${result.classificationDeferred ? "AI classification is also deferred; /classify-pending can retry it." : "AI classification is scheduled separately."} Scheduled indexing recovery starts after ${new Date(result.semanticRetryAt).toISOString()} (09:00 JST); /vectorize-pending can retry it manually.`
          : await t7Message(),
    }, ignoredReservedTags, t7Notes));
  }

  // POST /append
  if (url.pathname === "/append" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: { id?: string; addition?: string; volatility?: unknown; operation_id?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (typeof body.addition === "string" && body.addition.includes("\0")) return json({ ok: false, error: "NUL is not allowed" }, 400);
    if (!body.addition?.trim()) return json({ ok: false, error: "addition is required" }, 400);
    if (body.operation_id !== undefined
      && (typeof body.operation_id !== "string" || !body.operation_id.trim() || body.operation_id.length > 128)) {
      return json({ ok: false, error: "operation_id must be a non-empty string of at most 128 characters" }, 400);
    }

    const appendVol = readVolatility(body.volatility);
    if (appendVol.error) return json({ ok: false, error: appendVol.error }, 400);

    const id = body.id.trim();
    const addition = body.addition.trim();

    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, content, tags, source");
    if (!row) return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);
    const denied = assertCanEditContent(identity, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    const source = row.source as string;
    const existingContent = row.content as string;
    const tags: string[] = JSON.parse(row.tags as string);

    if (await isManagedMirror(source, env)) {
      return json({ ok: false, error: mirrorEditError(source) }, 409);
    }

    // Rahil's decision (18-copy-deck.md 6.8): checks the RESULTING total, not the addition
    // alone — an append that would push an already-large memory over 128 KB is refused before
    // anything is written, same as a fresh capture or a full replacement.
    if (contentByteLength(existingContent) + contentByteLength(addition) > MAX_CONTENT_BYTES) {
      return json(tooLargeRestBody(), 413);
    }

    const cfg = await resolveConfig(env);
    let appendResult: Awaited<ReturnType<typeof appendToEntry>>;
    try {
      const writeCtx = await writeContextFor(env, identity);
      if (writeCtx instanceof Response) return writeCtx;
      appendResult = await appendToEntry(env, id, existingContent, addition, tags, source, cfg, appendVol.value, writeCtx, { actorId: identity.userId, channel: "rest" }, undefined, row.workspace_id as string, ctx, { operationId: typeof body.operation_id === "string" ? body.operation_id.trim() : undefined });
    } catch (e) {
      if (e instanceof WriteConflictError) return json({ ok: false, error: "Entry changed while saving, try again" }, 409);
      if (e instanceof EntryGoneError) return json({ ok: false, error: e.message }, 404);
      if (e instanceof MemoryInputError) return json({ ok: false, error: e.message }, e.status);
      if (e instanceof AppendOperationConflictError) return json({ ok: false, error: e.message }, 409);
      if (e instanceof WorkersAiQuotaError) return workersAiQuotaResponse(e.retryAt, true);
      return json({ ok: false, error: `Append failed: ${(e as Error).message}` }, 500);
    }
    const { indexed, held, wasCanonical, eventId } = appendResult;

    if (!appendResult.replayed) auditEvent(env, ctx, {
      id: eventId,
      entryId: id, actorId: identity.userId, event: "appended",
      payload: { channel: "rest", ...(wasCanonical ? { was_canonical: true } : {}) },
    });
    if (held) {
      auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "held", payload: { reasons: held.reasons, score: held.score, channel: "rest" } });
    }
    // T-0089.5.2 Part B: an append on a recently-recalled id is implicit feedback
    // that the recall was used. No-op unless RECALL_LOG is on — cfg is already on
    // hand from appendToEntry above, so this adds no second KV read.
    ctx.waitUntil(maybeMarkFollowed(env, row.workspace_id, id, Date.now(), cfg));

    if (held) {
      const message = held.reasons[0] === "too_long"
        ? TOO_LONG_MESSAGE
        : "Update appended, but held out of recall: it looks like an instruction to an AI. Release it once you're sure it's fine.";
      return json({ ok: true, id, held: { reason: held.reasons[0] }, message });
    }

    return json({
      ok: true,
      id,
      replayed: appendResult.replayed,
      semantic_unavailable: !appendResult.indexed,
      semantic_unavailable_reason: appendResult.semanticUnavailableReason ?? null,
      semantic_retry_at: appendResult.semanticRetryAt ?? null,
      rollover_status: appendResult.rollover.status,
      content_chars: appendResult.rollover.contentChars,
      rollover_warn_at: appendResult.rollover.warnAt,
      rollover_at: appendResult.rollover.rolloverAt,
      message: appendResult.replayed
        ? "This append operation was already applied; no duplicate was added"
        : appendResult.indexed
          ? "Update appended successfully with timestamp"
          : appendResult.semanticUnavailableReason === "workers_ai_quota_exhausted"
            ? `Update appended to D1 and queued for semantic indexing. It is already findable by keyword; scheduled recovery starts after ${new Date(appendResult.semanticRetryAt ?? Date.now()).toISOString()} (09:00 JST), and /vectorize-pending can retry it manually.`
            : appendResult.semanticUnavailableReason === "vectorize_unavailable"
              ? `Update appended to D1 and queued for semantic indexing because Vectorize is unavailable. It is already findable by keyword; /vectorize-pending will retry it. Fix: ${VECTORIZE_FIX_HINT}.`
              : "This append operation was already applied and remains queued for semantic indexing; no duplicate was added. It is already findable by keyword, and /vectorize-pending will retry it.",
    });
  }

  // POST /update
  if (url.pathname === "/update" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: { id?: string; content?: string; volatility?: unknown; tags?: unknown; valid_from?: unknown; valid_until?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

    // T-0089.2.1: valid_from / valid_until, the same rules as the MCP update tool.
    const hasValidity = body.valid_from !== undefined || body.valid_until !== undefined;
    if (body.content === undefined && !hasValidity) return json({ ok: false, error: "Nothing to update: pass content, valid_from or valid_until." }, 400);
    if (body.content === undefined && (body.tags !== undefined || body.volatility !== undefined)) return json({ ok: false, error: "To change tags or volatility, pass content too." }, 400);
    if (body.content !== undefined && body.valid_from !== undefined) return json({ ok: false, error: VALIDITY_WITH_CONTENT_ERROR, field: "valid_from" }, 400);
    const validityCfg = hasValidity ? await resolveConfig(env) : null;
    const validity = hasValidity ? parseValidityInput(body, Date.now(), (validityCfg as Config).TIMEZONE, { allowNull: true }) : null;
    if (validity && "error" in validity) return json({ ok: false, error: validity.error, field: validity.field }, 400);
    const setValidity = (workspaceId: string) =>
      updateEntryValidity(env, body.id!.trim(), validity!.value as { from?: number | null; until?: number | null }, { actorId: identity.userId, channel: "rest" }, validityCfg as Config, workspaceId, ctx);
    const validityBody = (r: UpdateValidityResult): { status: number; body: Record<string, unknown> } => {
      if (r.status === "updated") return { status: 200, body: { validity: { valid_from: r.effectiveFrom, valid_from_stated: r.validFrom !== null, valid_until: r.validUntil, propagated: r.propagated } } };
      if (r.status === "refused") return { status: 400, body: { ok: false, error: r.error, field: r.field } };
      if (r.status === "no_change") return { status: 200, body: { validity: null, changed: false } };
      if (r.status === "conflict") return { status: 409, body: { ok: false, error: "Entry changed while saving, try again" } };
      return { status: 404, body: { ok: false, error: `No entry found with ID: ${body.id!.trim()}` } };
    };
    if (body.content === undefined) {
      const target = await getReadableEntry(env, identity, body.id.trim(), "id, workspace_id, actor_id");
      if (!target) return json({ ok: false, error: `No entry found with ID: ${body.id.trim()}` }, 404);
      const refused = assertCanEditContent(identity, target);
      if (refused) return json({ ok: false, error: refused.message }, 403);
      const out = validityBody(await setValidity(target.workspace_id as string));
      return json(out.status === 200 ? { ok: true, id: body.id.trim(), ...out.body } : out.body, out.status);
    }
    if (body.tags !== undefined && !validInputTags(body.tags)) return json({ ok: false, error: `tags must contain at most ${MAX_INPUT_TAGS} NUL-free strings of at most ${MAX_INPUT_TAG_CHARS} characters` }, 400);
    const badProjectTag = body.tags === undefined ? null : projectTagError(body.tags);
    if (badProjectTag) return json({ ok: false, error: badProjectTag }, 400);
    if (typeof body.content === "string" && body.content.includes("\0")) return json({ ok: false, error: "NUL is not allowed" }, 400);
    if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);
    // Rahil's decision (18-copy-deck.md 6.8): 128 KB per note, checked before anything is written.
    if (isOverContentLimit(body.content)) return json(tooLargeRestBody(), 413);

    const updateVol = readVolatility(body.volatility);
    if (updateVol.error) return json({ ok: false, error: updateVol.error }, 400);

    // Absent means "leave the tags alone" — every client but the editor omits the
    // key, and reading a missing key as an empty list would have them all wiping
    // tags on save. An explicit [] does mean the user removed the last one.
    let replaceTags: string[] | undefined;
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some(t => typeof t !== "string")) {
        return json({ ok: false, error: "tags must be an array of strings" }, 400);
      }
      replaceTags = body.tags as string[];
    }

    const id = body.id.trim();
    const newContent = body.content.trim();

    // Refuse before anything is written. Only `source` is needed: updateEntryContent reads
    // the rest for itself, and keeping the mirror guard out here is what stops
    // capture/store.ts having to depend on the integrations registry (see #289).
    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, source");
    if (!row) return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);
    const denied = assertCanEditContent(identity, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    if (await isManagedMirror(row.source as string, env)) {
      return json({ ok: false, error: mirrorEditError(row.source as string) }, 409);
    }

    const writeCtx = await writeContextFor(env, identity);
    if (writeCtx instanceof Response) return writeCtx;

    // Computed on the caller's raw tags — updateEntryContent strips these again on its
    // own path (applyTagReplacement), this is purely for telling the caller honestly.
    // Absent (undefined) means "leave the tags alone", so nothing was ignored.
    const { ignored: ignoredReservedTags } = stripNewReservedTags(replaceTags ?? []);

    const cfg = await resolveConfig(env);
    let result;
    try {
      result = await updateEntryContent(env, id, newContent, cfg, updateVol.value, replaceTags, writeCtx, { actorId: identity.userId, channel: "rest" }, row.workspace_id as string, ctx);
    } catch (error) {
      if (error instanceof MemoryInputError) return json({ ok: false, error: error.message }, error.status);
      throw error;
    }

    // Only reachable if the entry was deleted between the guard read and the write.
    if (result.status === "not_found") {
      return json({ ok: false, error: `No memory found with ID: ${id}` }, 404);
    }

    // R2-5: the row is still there, just moved out of this caller's reach mid-edit — a conflict to
    // retry, not a memory that vanished.
    if (result.status === "moved") {
      return json({ ok: false, error: "Entry changed while saving, try again" }, 409);
    }

    if (result.status === "reembed_failed") {
      if (result.reason === "workers_ai_quota_exhausted" && result.retryAt) return workersAiQuotaResponse(result.retryAt, true);
      return json({ ok: false, error: "Couldn't update: search did not update. The memory is unchanged. Try again." }, 500);
    }

    if (result.status === "conflict") {
      return json({ ok: false, error: "Entry changed while saving, try again" }, 409);
    }

    // Only a write that happened is audited.
    auditEvent(env, ctx, {
      id: result.eventId,
      entryId: id, actorId: identity.userId, event: "updated",
      payload: {
        channel: "rest",
        ...(result.wasCanonical ? { was_canonical: true } : {}),
        ...(result.capsuleChanged ? { capsule_changed: true } : {}),
      },
    });
    if (result.held) {
      auditEvent(env, ctx, {
        entryId: id, actorId: identity.userId, event: "held",
        payload: { reasons: result.held.reasons, score: result.held.score, channel: "rest" },
      });
    }
    // New content plus an end date: the text first, then the window, each its own version.
    const endFields = hasValidity ? validityBody(await setValidity(row.workspace_id as string)).body : {};
    // T-0089.5.2 Part B: an update on a recently-recalled id is implicit feedback
    // that the recall was used. No-op unless RECALL_LOG is on — cfg is already on
    // hand from updateEntryContent above, so this adds no second KV read.
    ctx.waitUntil(maybeMarkFollowed(env, row.workspace_id, id, Date.now(), cfg));

    if (result.held) {
      const message = result.held.reasons[0] === "too_long"
        ? TOO_LONG_MESSAGE
        : "Updated, but held out of recall: it looks like an instruction to an AI. Release it once you're sure it's fine.";
      return json(withReservedNote({
        ...endFields, ok: true, id, held: { reason: result.held.reasons[0] }, message,
      }, ignoredReservedTags));
    }

    if (!result.vectorIds) {
      return json(withReservedNote({
        ...endFields,
        ok: true,
        id,
        vectors: 0,
        semantic_unavailable: true,
        message: `Updated. Search by meaning is unavailable because Vectorize is unavailable, so it is findable by its words only. Fix: ${VECTORIZE_FIX_HINT}.`,
      }, ignoredReservedTags));
    }

    return json(withReservedNote({ ...endFields, ok: true, id, vectors: result.vectorIds.length }, ignoredReservedTags));
  }

  return null;
}
