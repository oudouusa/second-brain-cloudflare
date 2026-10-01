import { chatGptEnvForWorkspaces, isChatGptOperationEnabled } from "../lib/chatgpt";
import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { inferEdgesOnWrite } from "../graph/edges";
import { getStatus, withStatus, type MemoryStatus } from "../memory/status";
import { extractHashtags } from "../text/hashtags";
import { classifyThenInfer, scheduleClassifyAndTag } from "./classify";
import { checkDuplicateAndContradiction } from "./duplicate";
import { auditEvent, type AuditChannel, type ChangeContext } from "../lib/audit";
import { deleteStaleVectors, embedContextForRow, reembedOrThrow, discardUpload, storeEntry, validateIndexableMemory } from "./store";
import { tagsAfterWrite } from "../memory/stale";
import { getVolatility, withVolatility } from "../memory/volatility";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { projectFilterSql } from "../projects/filter";
import type { ProjectRow } from "../projects/registry";
import { rememberTags } from "../tags/vocabulary";
import { CONFLICT_HELD_TAG, isCapsuleTag, stripNewReservedTags, SYSTEM_JOB_TAGS, USER_EDITED_TAG, withUserEditMarker } from "../tags/system";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import { STANDING_MAX_CHARS, SYSTEM_SOURCE, TRANSCRIPT_SOURCES, VERSION_ROW_BUDGET_BYTES } from "../constants";
import { buildCasGuard, changesOf, Params, pruneStatement, snapshotStatement } from "../memory/versions";
import { currentValidityAt, planSupersede, statedWindow, supersededBySql, supersedeStatements, windowClosedSql, type SupersedePlan, type Window } from "../memory/validity";
import type { WhenKind, WhenSource } from "../when/input";
import { extractUnambiguousDate } from "../when/heuristic";
import { STANDING_TAG } from "../tags/t7";
import { standingTouched, type StandingCacheConfig } from "../standing/cache";
import { buildDecisionCapture } from "../decisions/capture";
import { buildCommitmentTags, validateT7Capture, type T7CaptureInput, type T7ReplyInfo } from "./t7-capture";
import { scoreWrite, type QuarantineChannel, type ScoreResult } from "../quarantine/score";
import { heldTagsFor, holdDecision, holdStatements, type HeldInfo } from "../quarantine/hold";
import { countMcpWritesInWindow } from "../quarantine/burst";

export function buildEntryFilterQuery(params: {
  n: number;
  tag?: string;
  after?: number;
  before?: number;
  /**
   * A single resolved actor_id, already checked against the caller's roster by
   * resolveActorFilter (src/lib/actors.ts). One id, never a list: the filter has
   * to stay ONE predicate with ONE binding, because binding one parameter per
   * author is what put the author-label lookup over D1's 100-parameter ceiling
   * on a large team and 500'd the request.
   */
  actor?: string;
  /** Registry rows for one project: entries carrying its tag or any alias. ANDed with `tag`. */
  project?: readonly ProjectRow[];
}): { sql: string; bindings: (string | number)[] } {
  const conds: string[] = [];
  const bindings: (string | number)[] = [];
  // Escaped for the same reason as the recall path: `_` and `%` in a tag are LIKE
  // wildcards, so `#q3_planning` would also list `q3-planning` entries and `?tag=%` would
  // list everything. A read, so over-broad rather than destructive — but a filter that
  // silently stops filtering is worse than one that returns nothing.
  if (params.tag) { conds.push(`tags LIKE ? ${TAG_LIKE_ESCAPE}`); bindings.push(tagLikePattern(params.tag)); }
  if (params.project) {
    const project = projectFilterSql(params.project);
    conds.push(project.clause);
    bindings.push(...project.bindings);
  }
  // An equality on one id, ANDed with everything else including the caller's
  // scope clause — so it can only ever narrow what the scope already allowed.
  // Tested against undefined rather than truthiness for the reason the tag
  // comment above gives: `actor: ""` is the legacy authorless rows, a real and
  // narrow answer, and a filter that silently stops filtering and returns the
  // whole listing instead is the worst of the three outcomes.
  if (params.actor !== undefined) { conds.push(`actor_id = ?`); bindings.push(params.actor); }
  if (params.after !== undefined) { conds.push(`created_at >= ?`); bindings.push(params.after); }
  if (params.before !== undefined) { conds.push(`created_at <= ?`); bindings.push(params.before); }

  // validity: any: /list and list_recent are listings, not current-facts answers (5.9); valid_from/valid_until and the
  // superseded_by lookup let both derive the six validity fields with no added query (T-0089.2.1)
  // scope-checked: the superseded_by subquery pins its closer `s` to entries.workspace_id — the outer row's own, scoped by the caller's own clause spliced in below
  // scope-exempt: builder only: callers splice the caller's scope in before ORDER BY — routes/recall.ts always, but mcp/server.ts only `if (identity)`, so an identity-less MCP caller gets this SQL unscoped
  let sql = `SELECT id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, valid_from, valid_until,
    ${supersededBySql("entries")} AS superseded_by_json
    FROM entries`;
  if (conds.length) sql += ` WHERE ` + conds.join(` AND `);
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  bindings.push(params.n);

  return { sql, bindings };
}

export type CaptureResult = (
  | { status: "blocked"; matchId: string; score: number }
  | { status: "stored"; id: string; tags: string[]; held?: HeldInfo; semanticUnavailable?: boolean; semanticUnavailableReason?: "workers_ai_quota_exhausted"; semanticRetryAt?: number; classificationDeferred?: boolean }
  | { status: "flagged"; id: string; matchId: string; score: number; held?: HeldInfo }
  | {
    status: "contradiction"; id: string; resolvedConflict: string; reason?: string;
    /** Which window closed (T-0089.2.1): the conflicting row ("older"), or the late-told newcomer ("newer"). */
    supersede?: { closedId: string; at: number; direction: "older" | "newer"; conflictPreview: string };
  }
  | { status: "contradiction_protected"; id: string; canonicalId: string; entryStatus: MemoryStatus | null; reason?: string }
  | { status: "merged"; id: string }
  | { status: "replaced"; id: string }
  // A standing/decision/commitment request that failed its own cross-validation
  // (Design 2.1 point 1, 4.1, 5.1). Nothing is written on this path.
  | { status: "t7_refused"; error: string }
) & { t7?: T7ReplyInfo };

/**
 * Content and tags exactly as captureEntry stores them: trimmed, hashtags lifted into tags,
 * tags lowercased and deduped. A caller-supplied tag in a namespace this contract reserved
 * (quarantine:, standing:, ...) is dropped here -- stripNewReservedTags is the single guard
 * every caller write path goes through; see test/unit/reserved-tags-write-guard.test.ts.
 */
export function normalizeCaptureInput(rawContent: string, tags: string[]): { content: string; tags: string[] } {
  const raw = rawContent.trim();
  const { cleanContent, hashtags } = extractHashtags(raw);
  const { kept } = stripNewReservedTags(tags.map(tag => tag.trim().toLowerCase()).filter(Boolean));
  return {
    content: cleanContent || raw,
    tags: [...new Set([...kept, ...hashtags])],
  };
}

export interface CaptureOptions {
  /**
   * A system job is writing, and which: the nightly "digest" or the weekly "insight".
   * It only ever merges into, replaces or deprecates a row of ITS OWN kind that a
   * system job wrote (`isSystemRow`). A user's or agent's memory, an edited digest,
   * and the other job's output are left untouched, and the newcomer is stored as its
   * own row, still flagged as a duplicate.
   */
  systemWrite?: SystemJob;
  /**
   * Audit channel for events the domain layer writes itself: "mcp", "rest" or
   * "system:<job>". Absent means the caller has no identity to attribute, and
   * no such event is written.
   */
  channel?: AuditChannel;
  /**
   * What the caller stated about when this became and stopped being true (T-0089.2.1), already
   * parsed and checked (parseValidityDate). Written at creation; a contradiction then supersedes by
   * interval with it.
   */
  validity?: { from?: number | null; until?: number | null };
  /** Test seam: the byte budget a merge's version row may use before it drops the incoming text. */
  versionRowBudgetBytes?: number;
  /** Track 7 (T-0089.7.1/.2/.3): standing, decision or commitment parameters. Absent for an
   * ordinary capture. Never set alongside systemWrite — system jobs never carry these. */
  t7?: T7CaptureInput;
}

export type SystemJob = keyof typeof SYSTEM_JOB_TAGS;

/**
 * A row THIS system job wrote and nobody has touched since: empty actor, the source
 * the jobs write, the job's own tag, no `user-edited` marker, and not a held or
 * draft or deprecated row (a digest stored because it contradicted something is not a live digest). Not the source
 * string alone, which any client can set through POST /capture or MCP remember; not
 * either system tag, which would let a digest overwrite an unreviewed insight.
 */
export function isSystemRow(row: { tags: string[]; actor_id?: unknown; source?: unknown }, job: SystemJob): boolean {
  return (row.actor_id ?? "") === ""
    && row.source === SYSTEM_SOURCE
    && row.tags.includes(SYSTEM_JOB_TAGS[job])
    && !row.tags.includes(USER_EDITED_TAG)
    && !row.tags.includes(CONFLICT_HELD_TAG)
    && getStatus(row.tags) !== "draft"
    && getStatus(row.tags) !== "deprecated";
}

export async function captureEntry(
  rawContent: string,
  tags: string[],
  source: string,
  env: Env,
  ctx: ExecutionContext,
  config?: Readonly<Config>,
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT,
  // The time-anchor primitive (src/when/input.ts). Only ever set on the plain
  // "stored" INSERT below — a merged/replaced/protected write survives as an
  // EXISTING row with its own timing, which this does not touch.
  when?: { at: number; kind: WhenKind; source: WhenSource },
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  env = chatGptEnvForWorkspaces(env, [writeCtx.workspaceId]);
  await assertMemoryWritesAllowed(env);
  // Resolved once per capture and threaded through duplicate detection and
  // every embed below. Recall and capture must agree on EMBEDDING_MODEL or the
  // vectors they produce are not comparable.
  const cfg = config ?? await resolveConfig(env);
  source = source.trim() || "api";
  // Who and which surface made the change, recorded on every version this capture writes.
  const change: ChangeContext = { actorId: writeCtx.actorId, channel: opts.channel ?? "unspecified" };
  const { content: c, tags: t } = normalizeCaptureInput(rawContent, tags);
  // 保留保存もmetadataに使うタグ・sourceの上限は守る。本文の埋込み上限は
  // 保留判定後に検査し、モデルへ渡さない長文のD1保存を妨げない。
  validateIndexableMemory("capture", "", t, source);

  // Track 7 (Design 2.1 point 1, 4.1, 5.1): cross-validate before any duplicate check or
  // write, and fold in whichever mode's own tags into this capture's tag list. At most one
  // of standing/decision/commitment ever applies (validateT7Capture refuses the rest).
  let t7Reply: T7ReplyInfo | undefined;
  let t7When: { at: number; kind: "due"; source: "explicit"; label: string } | undefined;
  if (opts.t7) {
    const validation = validateT7Capture(opts.t7);
    if (validation) return { status: "t7_refused", error: validation.error };

    if (opts.t7.decision) {
      const decisionResult = buildDecisionCapture(opts.t7, c, Date.now(), { reviewDefaultDays: cfg.DECISION_REVIEW_DEFAULT_DAYS, timezone: cfg.TIMEZONE });
      if ("error" in decisionResult) return { status: "t7_refused", error: decisionResult.error };
      t.push(...decisionResult.tags);
      t7When = { at: decisionResult.when_at, kind: decisionResult.when_kind, source: decisionResult.when_source, label: decisionResult.when_label };
      t7Reply = { kind: "decision", when_at: decisionResult.when_at, confidence: decisionResult.confidence };
    } else if (opts.t7.owed_by !== undefined || opts.t7.owed_to !== undefined) {
      const commitment = buildCommitmentTags(opts.t7);
      t.push(...commitment.tags);
      t7Reply = {
        kind: "commitment", direction: commitment.direction,
        ...(commitment.counterpartyLabel ? { counterpartyLabel: commitment.counterpartyLabel } : {}),
        ...(commitment.slugDropped ? { slugDropped: true as const } : {}),
      };
    } else if (opts.t7.standing) {
      if (c.length > STANDING_MAX_CHARS) {
        t7Reply = { kind: "standing", applied: false, reason: "too_long" };
      } else {
        // One statement, only for a standing request (Design 2.1 point 3). A concurrent
        // standing write can overshoot by the race width; the cache build (Design 2.4)
        // enforces the cap regardless, so a stale count here never breaks correctness.
        // validity: current: a replaced or ended standing instruction must not count toward the
        // cap, the same predicate src/standing/cache.ts's own build uses (T-0089.2.1, 5.5) — the
        // two counts would otherwise disagree about how many standing instructions are active.
        const capRow = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM entries
            WHERE workspace_id = ? AND instr(lower(tags), '"standing:active"') > 0 AND tags NOT LIKE '%"status:deprecated"%'
              AND ${currentValidityAt("", "?")}`,
        ).bind(writeCtx.workspaceId, Date.now()).first<{ n: number }>();
        if ((capRow?.n ?? 0) >= cfg.STANDING_MAX) {
          t7Reply = { kind: "standing", applied: false, reason: "cap" };
        } else {
          t.push(STANDING_TAG);
          t7Reply = { kind: "standing", applied: true };
        }
      }
    }
  }
  /** Attaches this capture's t7 reply info to a result, except across a merge/replace: those tags are
   * not propagated by the merge path (only a standing tag is, separately, in commitPerson below). */
  const withT7 = (r: CaptureResult): CaptureResult => (t7Reply ? { ...r, t7: t7Reply } : r);
  const standingKnownVector = (vector: number[] | null | undefined, entryId: string) => {
    if (t7Reply?.kind !== "standing" || !t7Reply.applied || !vector) return;
    standingTouched(env, ctx, cfg as StandingCacheConfig, [writeCtx.workspaceId], [{ id: entryId, vector }]);
  };

  // Track 4 (16-t3-t4-trust-spec.md 5.4 W-a): scored BEFORE duplicate and contradiction
  // detection, so a held write's model calls below can be skipped outright rather than run
  // and discarded. Only "mcp" and "rest" channels are content-writer channels captureEntry
  // ever scores; a system job (digest, weekly insight) is never scored (Q-F, 5.1) and takes
  // neither branch below.
  let score: ScoreResult | null = null;
  if (opts.channel === "mcp" || opts.channel === "rest") {
    const channel: QuarantineChannel = opts.channel;
    const mcpWritesInWindow = channel === "mcp"
      ? await countMcpWritesInWindow(env, writeCtx.actorId, Date.now(), cfg.QUARANTINE_WRITE_BURST)
      : undefined;
    score = scoreWrite(
      { content: c, tags: t, source, channel, kind: "create", mcpWritesInWindow, capsuleTagsChanged: t.some(isCapsuleTag) },
      cfg,
    );
  }
  // Codex review class D (T-0089.4.2): a `partial` score (over 32 KB, only the head and tail
  // scanned) holds too, reason too_long, not just an outright `hold` — see holdDecision.
  const decision = score ? holdDecision(score) : { hold: false as const };
  if (!decision.hold) validateIndexableMemory("capture", c, t, source);
  // Codex review class E (T-0089.4.2): a held write's content is unreviewed — too_long included,
  // since only the head and tail were ever scanned — and must never reach a model prompt, the
  // same rule that governs every candidate ROW read for a prompt (excludeHeld, quarantine/tags.ts).
  // This costs an oversized-but-benign write its own automatic merge/contradiction verdict; it
  // lands as a standalone row instead (finding #1 already refuses to commit a merge for one
  // anyway), which is the smaller loss next to sending unscanned text into an AI call.
  const { duplicate: dup, contradiction, mergeAction, neighbors, semanticUnavailable } = await checkDuplicateAndContradiction(
    c, env, cfg, writeCtx.workspaceId, ctx, { skipModelCall: decision.hold },
  );

  const classificationDeferred = !!semanticUnavailable && !isChatGptOperationEnabled(env, "classify");
  const definesCapsule = t.some(isCapsuleTag);
  if (definesCapsule && getStatus(t) === null) t.push("status:draft");

  if (dup.status === "blocked" && !definesCapsule) {
    return { status: "blocked", matchId: dup.matchId, score: dup.score };
  }

  // A capsule definition must land as its own row: a merge discards the
  // incoming tags, and the slot tags are the whole point of the write.
  //
  // Codex recheck (T-0089.4.2): a held write — too_long included — must never merge, replace,
  // supersede or deprecate an existing row. The model call above still runs for a merely-oversized
  // write (skipModelCall is narrower than decision.hold, see above), so mergeAction can still come
  // back "merge"/"replace" for one; committing that would publish the write's own unscanned or
  // unreviewed content into a target row that was never held, exactly the exposure a hold exists
  // to prevent. A held write always falls through to landing as its own standalone (held) row.
  if (dup.status === "flagged" && mergeAction && mergeAction.action !== "keep_both" && !definesCapsule && !decision.hold) {
    const targetId = mergeAction.target_id;
    const newContent = mergeAction.action === "merge" ? mergeAction.merged_content : c;

    const targetRow = await env.DB.prepare(
      // Pinned to the WRITER's workspace, not read back from the row: a share or move after the
      // scoped candidate read must make this a lost race (null row), never a merge in the new workspace.
      `SELECT content, tags, source, vector_ids, importance_score, actor_id, workspace_id, length(CAST(content AS BLOB)) AS content_bytes, length(CAST(tags AS BLOB)) AS tags_bytes FROM entries WHERE id = ? AND workspace_id = ?`
    ).bind(targetId, writeCtx.workspaceId).first() as Record<string, any> | null;

    if (targetRow) {
      const existingTags: string[] = JSON.parse(targetRow.tags ?? "[]");
      const existingContent = targetRow.content as string;
      const existingSource = targetRow.source as string;
      const oldVectorIds: string[] = JSON.parse(targetRow.vector_ids ?? "[]");

      const targetStatus = getStatus(existingTags);
      // A protected target is left alone and the newcomer is STORED below as a
      // duplicate-candidate. This branch used to `return` a random id here
      // without inserting anything, so the route reported success for a row
      // that did not exist (#327 review). The third clause is the transcript
      // rule from TRANSCRIPT_SOURCES.
      const protectedTarget =
        (targetRow.importance_score as number) >= 4
        || targetStatus === "canonical"
        || (TRANSCRIPT_SOURCES.has(source) && existingSource !== source)
        // A system job merges only into what a system job wrote.
        || (opts.systemWrite !== undefined && !isSystemRow({ tags: existingTags, actor_id: targetRow.actor_id, source: existingSource }, opts.systemWrite));

      if (!protectedTarget) {
        let newVectorIds: string[] | null = null;
        let newVectorValues: number[] | null = null;
        try {
          const reembedded = await reembedOrThrow(env, targetId, newContent, existingTags, existingSource, cfg, writeCtx);
          newVectorIds = reembedded.vectorIds;
          newVectorValues = reembedded.values;
        } catch (e) {
          console.error("Merge re-embed failed — keeping both, target untouched:", e);
        }

        if (newVectorIds) {
          // The rest of the incoming tag list is deliberately discarded on a merge, which
          // predates this and is left alone — but the volatility verdict cannot be, because
          // it is the one value the tool schema tells the caller wins permanently. Dropping
          // it here reported "merged" on a write that silently threw the judgment away, and
          // the merge bumps updated_at, so the nightly pass would not revisit the entry for
          // 90 days to re-derive anything. The caller judged the content being merged in, so
          // its verdict describes the combined body more recently than the target's does.
          const incomingVerdict = getVolatility(t);
          // The version keeps the target's prior text and the incoming capture, so a merge can be undone
          // and the incoming memory re-created. The incoming text is dropped when the row would not fit.
          const incoming = { incoming: c, incomingTags: t, incomingSource: source };
          const versionMeta = (targetRow.content_bytes as number) + (targetRow.tags_bytes as number)
            + new TextEncoder().encode(JSON.stringify(incoming)).length + 1024 <= (opts.versionRowBudgetBytes ?? VERSION_ROW_BUDGET_BYTES)
            ? incoming
            : { incomingTruncated: true, incomingBytes: new TextEncoder().encode(c).length };
          const reason = mergeAction.action === "merge" ? "merge" as const : "replace" as const;

          // A system job merges only through this one attempt, matching prep: its snapshot shares the
          // same compare-and-set, so a lost merge writes no version and keeps both rows (unversioned).
          // The guard is built once (buildCasGuard) and fed to both the snapshot and the UPDATE — spec
          // P3, ADV-1 — and it pins workspace_id, so a target the caller is no longer authorized to
          // write into (moved since the read above) misses rather than commits there (ADV-2).
          const commitSystem = async (): Promise<boolean> => {
            const now = Date.now();
            const stripped = tagsAfterWrite(existingTags);
            const refreshedTags = incomingVerdict ? withVolatility(stripped, incomingVerdict) : stripped;
            const systemCasColumns = { tags: targetRow.tags ?? "[]", content: existingContent, workspace_id: writeCtx.workspaceId, vector_ids: targetRow.vector_ids ?? null };
            const results = await env.DB.batch([
              snapshotStatement(env, {
                entryId: targetId, reason, change, content: { kind: "next", content: newContent }, nextTags: refreshedTags, meta: versionMeta, now,
                guard: p => `${buildCasGuard(p, systemCasColumns)} AND COALESCE(e.actor_id, '') = '' AND e.source = ${p.add(existingSource)}`,
              }),
              (() => {
                const p = new Params();
                const contentIdx = p.add(newContent);
                const tagsIdx = p.add(JSON.stringify(refreshedTags));
                const nowIdx = p.add(now);
                // ADV-4 residual: vector_ids lands in this same guarded UPDATE now, not from
                // reembedOrThrow's own (removed) unconditional write racing ahead of this batch.
                const vectorIdsIdx = p.add(JSON.stringify(newVectorIds));
                const idIdx = p.add(targetId);
                // scope-exempt: by-id: the merge target read above under this write's workspace, compare-and-set on the workspace, system-row identity, tags and content read
                // updated_at clamped strictly past its own previous value (digest mark guard, see commitPerson below).
                // versioning: snapshot
                return env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, content = ${contentIdx}, tags = ${tagsIdx}, updated_at = MAX(${nowIdx}, COALESCE(e.updated_at, e.created_at) + 1), vector_ids = ${vectorIdsIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, systemCasColumns)} AND COALESCE(e.actor_id, '') = '' AND e.source = ${p.add(existingSource)}`)
                  .bind(...p.values());
              })(),
              pruneStatement(env, targetId, cfg.VERSION_KEEP),
            ]);
            return changesOf(results[1]) > 0;
          };

          // A person's merge compare-and-sets on the content, tags AND workspace it embedded from
          // (T-0089.10, W2: a system merge already did, prep 0798b62; workspace_id added for ADV-2). A
          // miss means someone else's edit landed, OR the target moved to a workspace this request was
          // never authorized to write into (an unshare mid-embed) — either way this keeps both rather
          // than committing a merge decision that no longer accounts for the row as it now stands.
          const commitPerson = async (): Promise<boolean> => {
            const now = Date.now();
            const stripped = tagsAfterWrite(existingTags);
            const verdictTags = incomingVerdict ? withVolatility(stripped, incomingVerdict) : stripped;
            // A person's capture merging into a digest or insight makes it theirs.
            const userEditedTags = withUserEditMarker(verdictTags);
            // Design 2.1 point 4a: a standing capture that merges into an existing row makes
            // THAT row standing too, through the normal merge path — the rest of the incoming
            // tag list is otherwise discarded here, but this one is not optional.
            const refreshedTags = t.includes(STANDING_TAG) && !userEditedTags.includes(STANDING_TAG)
              ? [...userEditedTags, STANDING_TAG] : userEditedTags;
            const personCasColumns = { tags: targetRow.tags ?? "[]", content: existingContent, workspace_id: writeCtx.workspaceId, vector_ids: targetRow.vector_ids ?? null };
            const results = await env.DB.batch([
              snapshotStatement(env, {
                entryId: targetId, reason, change, content: { kind: "next", content: newContent }, nextTags: refreshedTags, meta: versionMeta, now,
                guard: p => buildCasGuard(p, personCasColumns),
              }),
              (() => {
                const p = new Params();
                const contentIdx = p.add(newContent);
                const tagsIdx = p.add(JSON.stringify(refreshedTags));
                const nowIdx = p.add(now);
                // ADV-4 residual: see commitSystem's identical reasoning above.
                const vectorIdsIdx = p.add(JSON.stringify(newVectorIds));
                const idIdx = p.add(targetId);
                // scope-exempt: by-id: the merge target this write read, compare-and-set on the tags, content and workspace it embedded from
                // updated_at clamped strictly past its own previous value (the digest mark guard,
                // src/compression/digest.ts, trusts COALESCE(updated_at, created_at) plus byte
                // length as its change signal; a same-millisecond, same-length merge with no
                // clamp would leave it unmoved and invisible to it).
                // versioning: snapshot
                return env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, content = ${contentIdx}, tags = ${tagsIdx}, updated_at = MAX(${nowIdx}, COALESCE(e.updated_at, e.created_at) + 1), vector_ids = ${vectorIdsIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, personCasColumns)}`)
                  .bind(...p.values());
              })(),
              pruneStatement(env, targetId, cfg.VERSION_KEEP),
            ]);
            return changesOf(results[1]) > 0;
          };

          const landed = opts.systemWrite !== undefined ? await commitSystem() : await commitPerson();
          if (!landed) {
            console.error("Merge lost the row to a concurrent edit — keeping both");
            // This merge's own upload never became the row's (round 6: ids are per upload): delete it.
            await discardUpload(env, targetId, newVectorIds);
          } else {
            // Either side: the incoming capture's own standing tag (propagated by refreshedTags
            // above), or the target already being standing:active before this merge/replace ever
            // ran — either way its content and vector just changed, so the cache's stored vector
            // for it is now stale (spec 15 2.6).
            if (opts.systemWrite === undefined && (t.includes(STANDING_TAG) || existingTags.includes(STANDING_TAG))) {
              standingTouched(env, ctx, cfg as StandingCacheConfig, [writeCtx.workspaceId], newVectorValues ? [{ id: targetId, vector: newVectorValues }] : undefined);
            }
            try {
              await deleteStaleVectors(env, targetId, oldVectorIds, newVectorIds);
            } catch (e) { console.error("Old vector cleanup failed (non-fatal):", e); }

            // The survivor's content just changed, so its graph position should
            // too. `neighbors` is the answer duplicate detection already got from
            // Vectorize for this same text, reused rather than asked again — the
            // merge therefore adds no query and no embed of its own.
            // inferEdgesOnWrite drops the written id from its own candidates, so
            // the target needs no filtering. dup.matchId does: the model picks the
            // merge target and is free to choose the SECOND-best match, leaving
            // the closest near-duplicate in `neighbors` — and linking the survivor
            // to that is the junk edge suppression exists to prevent, arriving by
            // a different door.
            if (!classificationDeferred) classifyThenInfer(targetId, newContent, env, ctx, cfg, kind =>
              inferEdgesOnWrite(targetId, neighbors, env, { suppressId: dup.matchId, newKind: kind }));

            // Only standing's tag is propagated by a merge (see refreshedTags above); a decision's or
            // commitment's own tags are silently discarded like the rest of the incoming list, matching
            // existing merge behavior, so their reply info is not attached to a merged/replaced outcome.
            const mergeT7 = t7Reply?.kind === "standing" ? t7Reply : undefined;
            return mergeAction.action === "merge"
              ? { status: "merged", id: targetId, ...(mergeT7 ? { t7: mergeT7 } : {}) }
              : { status: "replaced", id: targetId, ...(mergeT7 ? { t7: mergeT7 } : {}) };
          }
        }
      }
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const window = statedWindow(opts.validity, now);
  if ("error" in window) throw new Error(window.error);

  // 公開可否をINSERT前に確定し、同時に読むgatewayへ矛盾したprefixを見せない。
  // The supersede is planned by interval before the INSERT (T-0089.2.1, P4): a late-told or disjoint
  // newcomer never rules on the conflicting row, so only a close-older plan is subject to protection.
  let protectConflict = false;
  let conflictSnapshot: Record<string, any> | null = null;
  let plan: SupersedePlan | null = null;
  let older: Window | null = null;
  let newer: Window | null = null;
  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictRow = await env.DB.prepare(
      // Pinned to the WRITER's workspace, like the merge read above: a row moved since the scoped
      // read comes back null, which a system job treats as "not mine to supersede".
      `SELECT content, tags, source, actor_id, workspace_id, vector_ids, created_at, COALESCE(updated_at, created_at) AS row_version, valid_from, valid_until FROM entries WHERE id = ? AND workspace_id = ?`
    ).bind(contradiction.conflicting_id, writeCtx.workspaceId).first() as Record<string, any> | null;
    conflictSnapshot = conflictRow;
    const conflictTags: string[] = conflictRow ? JSON.parse(conflictRow.tags ?? "[]") : [];
    const conflictStatus = conflictRow ? getStatus(conflictTags) : null;
    const conflictSource = conflictRow ? String(conflictRow.source ?? "") : "";
    if (conflictRow) {
      older = {
        id: contradiction.conflicting_id, from: (conflictRow.valid_from ?? conflictRow.created_at) as number,
        until: (conflictRow.valid_until ?? null) as number | null, workspaceId: writeCtx.workspaceId, status: conflictStatus,
      };
      // A newcomer told now, with no stated start, is newer than the fact it contradicts even when the
      // clocks tie (the same millisecond, or another isolate's clock ahead of this one): it starts just
      // after the older fact, and that start is stored, so the older row's end still meets it exactly.
      if (window.valid_from === null && window.valid_until === null && now <= older.from) window.valid_from = older.from + 1;
      newer = { id, from: window.valid_from ?? now, until: window.valid_until, workspaceId: writeCtx.workspaceId, status: getStatus(t) };
      plan = planSupersede(older, newer);
    }
    // Canonical memories were always protected here. A transcript gets the same
    // treatment against any memory of another source: the newcomer becomes a
    // draft and nothing is superseded, because "we decided X… actually Y" in a
    // session log is not evidence that the memory of X is no longer true.
    protectConflict =
      // The row is no longer in the writer's workspace (moved, shared or forgotten since the scoped
      // read): whoever wrote it has decided where it lives, and this write may not rule on it.
      !conflictRow
      || (plan?.action === "close-older" && (
        conflictStatus === "canonical"
        || (TRANSCRIPT_SOURCES.has(source) && conflictSource !== source)
        // A system job never rewrites a row it did not write, supersede included.
        || (opts.systemWrite !== undefined && !isSystemRow({ tags: conflictTags, actor_id: conflictRow?.actor_id, source: conflictSource }, opts.systemWrite))
      ));
  }

  // A contradiction whose windows do not overlap (disjoint, already closed, or a closed episode inside
  // the older window) changes nothing elsewhere: the newcomer is an ordinary memory.
  const supersedes = contradiction.detected && !!contradiction.conflicting_id && (protectConflict || (plan !== null && plan.action !== "none"));
  const baseTags = supersedes ? [...t, "contradiction-resolved"] : t;
  const duplicateTags = dup.status === "flagged" ? [...baseTags, "duplicate-candidate"] : baseTags;
  const finalTags = protectConflict
    ? withStatus(duplicateTags.filter(tag => tag !== "contradiction-resolved"), "draft")
    : duplicateTags;

  // A decision's own computed review date wins over everything (Design 4.1); it is never
  // combined with a caller `when` (validateT7Capture already refused review_by + when
  // together). Otherwise the caller's own `when` always wins. Absent both, a cheap regex
  // pass looks for an unambiguous future date already in the text — negligible CPU, no
  // model call — and only ever claims a date nobody could dispute; anything fuzzier is
  // src/when/pass.ts's job, on a budget, at night.
  const resolvedWhen = t7When ?? when ?? (() => {
    const at = extractUnambiguousDate(c, now, cfg.TIMEZONE);
    return at !== null ? { at, kind: "due" as WhenKind, source: "regex" as WhenSource } : undefined;
  })();

  // versioning: exempt: creation — a new row has no prior state to keep
  const insertStatement = env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source, when_label, valid_from, valid_until, write_marker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, c, JSON.stringify(finalTags), source, now, now, "[]", writeCtx.workspaceId, writeCtx.actorId,
    resolvedWhen?.at ?? null, resolvedWhen?.kind ?? null, resolvedWhen?.source ?? null,
    // Only a decision's review date carries a stored label (Design 4.1: "Review: " + shortDecision(content),
    // bare — no English prefix, see decisions/capture.ts's reviewLabel comment); the regex/caller-`when`
    // paths never generate one, matching every other when_label writer in this codebase.
    (resolvedWhen && "label" in resolvedWhen) ? resolvedWhen.label : null,
    window.valid_from, window.valid_until, memoryWriteMarker(env),
  );

  if (decision.hold) {
    // 5.4: the INSERT (with the tags the write asked for) and the hold's own version, guarded
    // UPDATE and prune all land in ONE batch, so a crash between them can never leave an
    // unheld row. No scheduleIndex: a held create is never vectorized (5.3 point 1). Class D
    // (T-0089.4.2): this also covers a `partial` score, held reason too_long.
    const heldTags = heldTagsFor(finalTags, decision.reasons);
    await env.DB.batch([
      insertStatement,
      ...holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: cfg.VERSION_KEEP }, {
        entryId: id, reasons: decision.reasons, score: decision.score, signals: decision.signals, change, heldTags, now,
      }),
    ]);
    ctx.waitUntil(rememberTags(env, finalTags, writeCtx.workspaceId));
    const held: HeldInfo = { reasons: decision.reasons, score: decision.score };
    return withT7(
      dup.status === "flagged"
        ? { status: "flagged", id, matchId: dup.matchId, score: dup.score, held }
        : { status: "stored", id, tags: heldTags, held },
    );
  }

  await insertStatement.run();

  // Indexed once the outcome is known, with the tags the row will actually keep: a system capture can
  // still be turned into a held draft by a lost compare-and-set below.
  const scheduleIndex = (indexTags: string[]) => !semanticUnavailable && ctx.waitUntil(
    storeEntry(env, id, c, indexTags, source, now, cfg, writeCtx)
      .then(stored => standingKnownVector(stored.values, id))
      .catch(e => console.error("Vectorize insert failed (non-fatal):", e))
  );

  // Capture is where a tag string nobody wrote into the source first exists, so it is
  // one of the two places the cached vocabulary has to learn one (#288). Deferred, so
  // the capture does not wait on KV — which means the tag is admitted once this
  // settles rather than by the time the response lands, and a `GET /tags` fired
  // straight off the back of the save can miss it by one refresh.
  ctx.waitUntil(rememberTags(env, finalTags, writeCtx.workspaceId));

  // A flagged capture is a near-duplicate the writer chose to keep, so the
  // entry it duplicates is its top neighbour by construction. Linking them
  // spends an inference slot restating the duplicate-candidate tag.
  const suppressId = dup.status === "flagged" ? dup.matchId : undefined;

  if (supersedes) {
    const conflictId = contradiction.conflicting_id!;

    const keepAsDraft = async (): Promise<CaptureResult> => {
      const draftTags = finalTags.filter(t => t !== "contradiction-resolved");
      // Contradictory definitions must not publish into a prompt prefix.
      const heldTags = withStatus(draftTags, "draft");
      // A system job's draft is held: no later system job may supersede, merge into or replace it.
      const protectedTags = opts.systemWrite !== undefined && !heldTags.includes(CONFLICT_HELD_TAG)
        ? [...heldTags, CONFLICT_HELD_TAG] : heldTags;
      scheduleIndex(protectedTags);
      // versioning: exempt: protects the newcomer's own uncommitted row before its version chain exists
      await env.DB.prepare(`UPDATE entries SET tags = ?, write_marker = ? WHERE id = ?`)
        .bind(JSON.stringify(protectedTags), memoryWriteMarker(env), id).run();
      // A system job's guess must not move the user's row: a win here would make it
      // permanently ineligible for digests (compression/eligibility.ts).
      if (opts.systemWrite === undefined && conflictSnapshot) {
        try {
          // versioning: exempt: counters, not undoable content
          await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1, write_marker = ? WHERE id = ?`).bind(memoryWriteMarker(env), conflictId).run();
          // versioning: exempt: counters, not undoable content
          await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1, write_marker = ? WHERE id = ?`).bind(memoryWriteMarker(env), id).run();
        } catch (e) {
          console.error("Contradiction count update failed (non-fatal):", e);
        }
      }
      // This path draws no edges, so there is nothing to chain onto.
      if (!classificationDeferred) scheduleClassifyAndTag(id, c, env, ctx, cfg);
      return {
        status: "contradiction_protected",
        id,
        canonicalId: conflictId,
        entryStatus: getStatus(protectedTags),
        reason: contradiction.reason,
        ...(t7Reply ? { t7: t7Reply } : {}),
      };
    };

    if (protectConflict) return keepAsDraft();

    // Supersede (T-0089.2.1): one batch closes a window, versions it, links the two rows and moves the
    // counters. The older row keeps its status and its vectors; it is history, not wrong (D2.1).
    // Closing the conflicting row compare-and-sets what was read: a system job the whole system row
    // (as before), a person's write its tags (status included) and its row version (any content edit).
    // Closing the newcomer (late-told) rules only on this write's own row.
    const snap = conflictSnapshot!;
    const closesOlder = plan!.action === "close-older";
    const guard = !closesOlder ? undefined
      : opts.systemWrite !== undefined
        ? (p: Params) => `${buildCasGuard(p, { tags: snap.tags ?? "[]", content: snap.content, vector_ids: snap.vector_ids ?? null })} AND COALESCE(e.actor_id, '') = '' AND e.source = ${p.add(snap.source)}`
        : (p: Params) => `${buildCasGuard(p, { tags: snap.tags ?? "[]" })} AND COALESCE(e.updated_at, e.created_at) = ${p.add(snap.row_version)}`;
    const at = (plan as Extract<SupersedePlan, { at: number }>).at;
    const [closedId, closerId] = closesOlder ? [conflictId, id] : [id, conflictId];
    const counter = (column: "contradiction_wins" | "contradiction_losses", rowId: string) => {
      const p = new Params();
      // versioning: exempt: counters, not undoable content
      const sql = `UPDATE entries SET write_marker = ${p.add(memoryWriteMarker(env))}, ${column} = ${column} + 1 WHERE id = ${p.add(rowId)} AND ${windowClosedSql(p, closedId, at)}`;
      return env.DB.prepare(sql).bind(...p.values());
    };
    const results = await env.DB.batch([
      ...supersedeStatements(env, plan!, older!, newer!, change, cfg, guard),
      counter("contradiction_wins", closerId),
      counter("contradiction_losses", closedId),
    ]);

    if (changesOf(results[1]) === 0) {
      // A system job's lost race holds its newcomer, as before.
      if (opts.systemWrite !== undefined) return keepAsDraft();
      // A person's: the row changed since it was read, so this was not a contradiction this write may
      // rule on. Nothing was superseded, so the newcomer is an ordinary memory: `contradiction-resolved`
      // would wrongly claim otherwise and permanently exclude it from insight candidates.
      const keptTags = finalTags.filter(tag => tag !== "contradiction-resolved");
      // versioning: exempt: protects the newcomer's own uncommitted row before its version chain exists
      await env.DB.prepare(`UPDATE entries SET tags = ?, write_marker = ? WHERE id = ?`).bind(JSON.stringify(keptTags), memoryWriteMarker(env), id).run();
      scheduleIndex(keptTags);
      if (!classificationDeferred) classifyThenInfer(id, c, env, ctx, cfg, kind =>
        inferEdgesOnWrite(id, neighbors, env, { suppressId, newKind: kind }));
      return withT7({ status: "stored", id, tags: keptTags });
    }

    // The supersede close (spec 15 2.6): the CLOSED row just left "current", which is what the
    // cache build's own currentValidityAt filter admits on. Only the closed side's tags matter —
    // the closer (still open) had no eligibility change of its own from this write.
    const closedTags: string[] = closesOlder ? JSON.parse(snap.tags ?? "[]") : finalTags;
    if (closedTags.includes(STANDING_TAG)) {
      standingTouched(env, ctx, cfg as StandingCacheConfig, [writeCtx.workspaceId]);
    }

    if (opts.channel) {
      auditEvent(env, ctx, {
        entryId: closedId,
        actorId: writeCtx.actorId,
        event: "superseded",
        payload: { by: closerId, until: at, channel: opts.channel },
      });
    }
    scheduleIndex(finalTags);
    if (!classificationDeferred) classifyThenInfer(id, c, env, ctx, cfg, kind =>
      inferEdgesOnWrite(id, neighbors.filter(n => n.id !== conflictId), env, { suppressId, newKind: kind }));
    return withT7({
      status: "contradiction", id, resolvedConflict: conflictId, reason: contradiction.reason,
      supersede: { closedId, at, direction: closesOlder ? "older" : "newer", conflictPreview: String(snap.content ?? "").slice(0, 60) },
    });
  }
  scheduleIndex(finalTags);
  if (!classificationDeferred) classifyThenInfer(id, c, env, ctx, cfg, kind =>
    inferEdgesOnWrite(id, neighbors, env, { suppressId, newKind: kind }));

  if (dup.status === "flagged") {
    return withT7({ status: "flagged", id, matchId: dup.matchId, score: dup.score });
  }

  // finalTags is what actually landed on the row — hashtags pulled out of the
  // content, plus anything the caller passed. The dashboard shows it back as a
  // capture receipt, so a person can see what the brain did with what they
  // wrote rather than trusting it silently.
  return withT7({ status: "stored", id, tags: finalTags, semanticUnavailable: semanticUnavailable ? true : undefined, semanticUnavailableReason: semanticUnavailable?.reason, semanticRetryAt: semanticUnavailable?.retryAt, classificationDeferred });
}
