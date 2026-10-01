/**
 * Nightly capped AI extraction: for entries the free regex pass
 * (src/when/heuristic.ts) could not anchor, ask the model whether this reads
 * as a commitment and, if so, when it is due.
 *
 * 夜間は候補2件、直接呼出しは最大20件。SELECTとbatch内のUPDATEは
 * それぞれ1 SQLとして予約し、権限解放用の予算には触れない。
 *
 * The cursor is a KV keyset over (created_at, id), mirroring
 * src/insight/candidates.ts's ACCRUAL_CURSOR_KEY: cheap, and immune to a tie
 * group of same-millisecond captures being split across nights.
 * 末尾に到達したら次回の巡回で先頭へ戻る。同じ入力の辞退判断は最大30日再利用する。
 * 隔離もその巡回内で有効。モデル失敗は判断済みとして保存しない。
 *
 * Robustness contract mirrors src/insight/reason.ts: "declined" (the model
 * gave a real answer and it was not a due commitment) and "failed" (the call
 * itself produced nothing to judge) are different outcomes. A declined
 * candidate has been looked at and the cursor may pass it; a failed one has
 * not, and the pass stops there rather than risk skipping it — the whole
 * point of a keyset cursor is that nothing between the old position and the
 * new one is silently missed.
 *
 * Two failure modes this contract has to survive, found in review:
 *
 *   - The persisted write itself can fail (env.DB.batch rejects). If the
 *     cursor had already advanced past the judged candidates by then, a
 *     correctly-judged commitment is lost forever — the row stays
 *     when_at IS NULL, but the cursor says this entry was already handled,
 *     so nothing ever asks about it again. So the cursor advance and the
 *     batch write are one unit: nothing about this run's position is
 *     persisted unless the write actually landed. A rolled-back run
 *     re-judges the same window next time, declines included, which is a
 *     fresh model call for at most WHEN_EXTRACT_PER_NIGHT candidates the
 *     following night — inside the nightly budget it was already
 *     accepting.
 *
 *   - A single entry can fail every night forever (a permanent model
 *     refusal, or content the model can never parse). Because a "failed"
 *     outcome never advances the cursor, that entry is always candidate #1
 *     again the next night, the pass stops on it every time, and every
 *     candidate behind it in the corpus is never reached — proven wedged
 *     across five simulated nights in review. The cursor's KV value
 *     therefore also tracks `failedId`/`failCount`: three consecutive
 *     nights failing on the SAME id quarantines it — the cursor advances
 *     past that one entry, the counter resets, and it is counted in
 *     `whenSkipped` rather than retried forever. Two consecutive failures
 *     still behave exactly as before (stop, no advance): the bar is three,
 *     not one, so a single bad night for an otherwise-fine entry is not
 *     mistaken for a permanent block.
 */
import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import { reserveD1Sql } from "../runtime/d1-budget";
import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { WHEN_PASS_MAX_TOKENS } from "../constants";
import { readStreamText } from "../lib/ai";
import { initializeDatabase } from "../db/init";
import { zonedMidnightMs } from "./timezone";
import { openLoopSql } from "../memory/loops";
import type { ScopeClause } from "../lib/scope";
import { NOT_HELD_SQL } from "../quarantine/tags";

/** Model calls spent per night, hard ceiling. */
export const WHEN_EXTRACT_PER_NIGHT = 20;

/** Below this the model's own confidence says not to act on it. */
export const WHEN_CONFIDENCE_THRESHOLD = 0.7;

/** Overdue commitments are still worth surfacing; this bounds how overdue. */
export const WHEN_MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;

export const WHEN_CURSOR_KEY = "when:cursor";

/** Three consecutive nights failing on the SAME entry quarantines it. */
export const WHEN_QUARANTINE_AFTER = 3;

/**
 * `createdAt`/`id` are the keyset position and are both absent until the
 * pass has ever advanced past anything — a brand-new brain, or one where
 * candidate #1 has failed every night so far, has a cursor carrying only
 * failure tracking and no position at all. `failedId`/`failCount` name
 * whichever id most recently failed and how many consecutive nights running
 * it has failed; both are absent once nothing is currently failing.
 */
export interface WhenCursor {
  createdAt?: number;
  id?: string;
  failedId?: string;
  failCount?: number;
  failedFingerprint?: string;
}

export interface WhenCandidate {
  id: string;
  content: string;
  created_at: number;
  workspace_id: string;
  tags: string;
}

/** Same tolerance as insight/candidates.ts's parseCursor: unreadable means "start from the top". */
export function parseWhenCursor(raw: string | null): WhenCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const cursor: WhenCursor = {};
    if (typeof parsed.createdAt === "number" && typeof parsed.id === "string") {
      cursor.createdAt = parsed.createdAt;
      cursor.id = parsed.id;
    }
    if (typeof parsed.failedId === "string" && typeof parsed.failCount === "number") {
      cursor.failedId = parsed.failedId;
      cursor.failCount = parsed.failCount;
      if (typeof parsed.failedFingerprint === "string") cursor.failedFingerprint = parsed.failedFingerprint;
    }
    // A cursor with neither a position nor an active failure streak carries
    // nothing this pass can use — indistinguishable from absent.
    if (cursor.createdAt === undefined && cursor.failedId === undefined) return null;
    return cursor;
  } catch {
    return null;
  }
}

/** Read-only: GET /extract/dry-run uses this to preview from the same position the real pass would start at. */
export async function readWhenCursor(env: Env, workspaceId?: string | null): Promise<WhenCursor | null> {
  try {
    return parseWhenCursor(await env.OAUTH_KV.get(workspaceId == null ? WHEN_CURSOR_KEY : `${WHEN_CURSOR_KEY}:${workspaceId}`));
  } catch (e) {
    console.error("When-extraction cursor read failed; starting from the top (non-fatal):", e);
    return null;
  }
}

async function writeWhenCursor(env: Env, cursor: WhenCursor, workspaceId?: string | null): Promise<void> {
  try {
    await env.OAUTH_KV.put(workspaceId == null ? WHEN_CURSOR_KEY : `${WHEN_CURSOR_KEY}:${workspaceId}`, JSON.stringify(cursor));
  } catch (e) {
    console.error("When-extraction cursor write failed (non-fatal):", e);
  }
}

// 辞退判断は派生キャッシュ。プロンプトや判定条件を変えるときは版も更新する。
const WHEN_REVIEW_VERSION = 1;
const WHEN_REVIEW_TTL_SECONDS = 30 * 24 * 60 * 60;

interface WhenReview { key: string; fingerprint: string }
async function digestWhenInput(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function whenReview(candidate: WhenCandidate, config: Readonly<Config>): Promise<WhenReview> {
  const [key, fingerprint] = await Promise.all([
    digestWhenInput([candidate.workspace_id, candidate.id]),
    digestWhenInput([WHEN_REVIEW_VERSION, candidate.content, candidate.tags, candidate.workspace_id,
      config.WHEN_LLM_MODEL, config.TIMEZONE, WHEN_CONFIDENCE_THRESHOLD, WHEN_MAX_PAST_MS,
      WHEN_PASS_MAX_TOKENS, ENTRY_EXCERPT_CHARS]),
  ]);
  return { key: `when:review:${key}`, fingerprint };
}

async function hasWhenReview(env: Env, review: WhenReview, now: number): Promise<boolean> {
  try {
    const cached = JSON.parse(await env.OAUTH_KV.get(review.key) ?? "null");
    return cached?.fingerprint === review.fingerprint
      && typeof cached.expiresAt === "number" && Number.isFinite(cached.expiresAt)
      && cached.expiresAt > now && cached.expiresAt <= now + WHEN_REVIEW_TTL_SECONDS * 1000;
  } catch {
    // キャッシュを信用できないときは通常のモデル判定へ戻す。
    return false;
  }
}

async function saveWhenReview(env: Env, review: WhenReview, now: number): Promise<void> {
  try {
    await env.OAUTH_KV.put(review.key, JSON.stringify({
      fingerprint: review.fingerprint, expiresAt: now + WHEN_REVIEW_TTL_SECONDS * 1000,
    }), { expirationTtl: WHEN_REVIEW_TTL_SECONDS });
  } catch {
    // 保存失敗は次の巡回で再評価するだけであり、正本やcursorを壊さない。
    console.error("期限判定キャッシュを保存できませんでした");
  }
}

function candidateSql(hasCursor: boolean, scopeClause: string | null, now: number): string {
  const cursorClause = hasCursor ? `AND (created_at > ? OR (created_at = ? AND id > ?))` : "";
  const sliceClause = scopeClause ? `AND ${scopeClause}` : "";
  // validity: current: a replaced note is not a when-extraction candidate either (T-0089.2.1)
  // scope-exempt: cron: the nightly pass's own single-workspace slice is folded into `scope` by the caller, same exemption shape as the other nightly passes; a direct/manual caller with no slice walks the whole corpus, same as before v3. GET /extract/dry-run instead passes a real scopeWhere(auth), so that path IS scoped.
  return `SELECT id, content, created_at, workspace_id, tags FROM entries
          WHERE when_at IS NULL AND when_source IS NULL
            AND (${openLoopSql(now)} OR tags LIKE '%"volatility:volatile"%')
            AND ${NOT_HELD_SQL}
            ${cursorClause}
            ${sliceClause}
          ORDER BY created_at ASC, id ASC
          LIMIT ${WHEN_EXTRACT_PER_NIGHT}`;
}

/**
 * Candidates from just past `cursor`, capped at `limit` (WHEN_EXTRACT_PER_NIGHT
 * for the real pass; GET /extract/dry-run passes its own, smaller N). Exported
 * so the dry-run route reads the identical prefilter the pass itself uses.
 *
 * `scope` is a plain WHERE fragment, not a bare workspace id: the nightly
 * pass folds its single rotation slice into one (`workspace_id = ?`),
 * while GET /extract/dry-run passes a real scopeWhere(auth) — personal plus
 * every company workspace the caller can read, an IN clause the pass itself
 * never needs.
 */
export async function fetchWhenCandidates(
  env: Env,
  cursor: WhenCursor | null,
  scope: ScopeClause | null,
  limit: number = WHEN_EXTRACT_PER_NIGHT,
): Promise<WhenCandidate[]> {
  // A cursor can carry ONLY failure tracking (no position yet) — see the
  // WhenCursor doc comment — and that is not a position to query from.
  const hasPosition = cursor?.createdAt !== undefined && cursor?.id !== undefined;
  const bindings: (string | number)[] = [];
  if (hasPosition) bindings.push(cursor!.createdAt!, cursor!.createdAt!, cursor!.id!);
  if (scope) bindings.push(...scope.bindings);
  const { results } = await env.DB.prepare(candidateSql(hasPosition, scope?.clause ?? null, Date.now())).bind(...bindings).all();
  // LIMIT is baked into candidateSql at WHEN_EXTRACT_PER_NIGHT; a caller
  // asking for fewer (GET /extract/dry-run) just reads fewer rows back.
  return (results as unknown as WhenCandidate[]).slice(0, limit);
}

export type CommitmentOutcome =
  | { outcome: "commitment"; what: string; dueAt: number; confidence: number; kind: "due" | "event" }
  | { outcome: "declined" }
  | { outcome: "failed" };

const ENTRY_EXCERPT_CHARS = 800;
const MAX_WHAT_CHARS = 120;

function isReadableJsonObject(raw: string): boolean {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return false;
  try {
    JSON.parse(match[0]);
    return true;
  } catch {
    return false;
  }
}

function parseCommitmentJson(raw: string, timezone: string): {
  isCommitment: boolean; what: string; dueAt: number | null; confidence: number; kind: "due" | "event";
} | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed.is_commitment !== "boolean") return null;

  const confidence = typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
    ? parsed.confidence : 0;
  const what = typeof parsed.what === "string" ? parsed.what.trim().slice(0, MAX_WHAT_CHARS) : "";
  let dueAt: number | null = null;
  const dueAtMatch = typeof parsed.due_at === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsed.due_at.trim()) : null;
  // Anchored in the brain's configured TIMEZONE (src/when/timezone.ts), not
  // UTC — the model answers with a bare YYYY-MM-DD, which is exactly the
  // date-only case that anchor exists for.
  if (dueAtMatch) {
    dueAt = zonedMidnightMs(Number(dueAtMatch[1]), Number(dueAtMatch[2]) - 1, Number(dueAtMatch[3]), timezone);
  }
  // Absent or unrecognised defaults to "due" — an appointment is an "event",
  // but calling everything else a deadline is the safer failure than
  // inventing an event that was never one.
  const kind = parsed.kind === "event" ? "event" : "due";

  return { isCommitment: parsed.is_commitment, what, dueAt, confidence, kind };
}

/**
 * One entry in, at most one judgment out. `referenceDate` anchors relative
 * phrases in the memory ("next Friday", "in two weeks") to an absolute date —
 * without it the model has no "today" to resolve them against.
 */
export async function judgeCommitment(
  content: string,
  referenceDate: number,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<CommitmentOutcome> {
  const excerpt = content.slice(0, ENTRY_EXCERPT_CHARS);
  const today = new Date(referenceDate).toISOString().slice(0, 10);

  const prompt = `You are reading one memory from a person's second brain, written on or before ${today}.

Memory:
${excerpt}

Does this describe something the person needs to DO by a specific point in time — a deadline, a task with a due date, an appointment, a commitment they made? A general fact, a preference, or something that already happened with no future action is not a commitment.

If it is a commitment, say what needs to be done in a few words, written as an instruction, at most 120 characters. Give the date it is due as an absolute date (YYYY-MM-DD), resolving any relative phrase ("next Friday", "in two weeks") against ${today} as today. If you cannot pin down a specific date, this is not a commitment for this purpose.

Also say what KIND of moment this is: "event" when it is something happening AT that time — an appointment, a meeting, a trip — rather than a deadline to finish something BY that time, which is "due".

Respond with JSON only. No text outside the JSON object.
{"is_commitment": <true or false>, "what": "<short instruction, or empty string>", "due_at": "<YYYY-MM-DD, or null>", "kind": "<due or event>", "confidence": <0 to 1>}`;

  let raw = "";
  try {
    // config.WHEN_LLM_MODEL, deliberately not config.LLM_MODEL — see the cost
    // comment on constants.WHEN_PASS_MAX_TOKENS for why this defaults to the
    // same model INSIGHT_LLM_MODEL uses.
    const stream = await (env.AI as any).run(config.WHEN_LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: WHEN_PASS_MAX_TOKENS,
      stream: true,
    });
    raw = await readStreamText(stream as ReadableStream);
  } catch (e) {
    // The call itself produced nothing to judge — stays eligible to be asked again.
    console.error("When-extraction call failed (non-fatal):", e);
    return { outcome: "failed" };
  }

  // No JSON object at all — prose, or an object truncated mid-answer — is not
  // a judgement to record, same reasoning as reason.ts's identical guard.
  if (!isReadableJsonObject(raw)) return { outcome: "failed" };

  const parsed = parseCommitmentJson(raw, config.TIMEZONE);
  if (!parsed) return { outcome: "failed" }; // 必須判定のない応答を辞退キャッシュに入れない
  if (!parsed.isCommitment) return { outcome: "declined" };
  if (parsed.confidence < WHEN_CONFIDENCE_THRESHOLD) return { outcome: "declined" };
  if (parsed.dueAt === null) return { outcome: "declined" }; // no anchor, nothing to persist
  if (!parsed.what) return { outcome: "declined" };
  // Overdue is still worth surfacing (the /due feed's whole "overdue" bucket
  // depends on it), but only within reason — a model hallucinating a date
  // decades back is a bad extraction, not a genuinely ancient commitment.
  if (referenceDate - parsed.dueAt > WHEN_MAX_PAST_MS) return { outcome: "declined" };

  return { outcome: "commitment", what: parsed.what, dueAt: parsed.dueAt, confidence: parsed.confidence, kind: parsed.kind };
}

export interface WhenPassSummary {
  whenExtracted: number;
  whenJudged: number;
  /** How many permanently-failing entries were quarantined this run (Finding 2). */
  whenSkipped: number;
  /**
   * False only when this run judged at least one commitment but the batch
   * that would have persisted it failed (Finding 1) — the run's whole cursor
   * advance was rolled back, and every entry it looked at, judged or not,
   * stays eligible to be asked about again. True otherwise, including the
   * ordinary "found nothing to do" case.
   */
  ok: boolean;
}

/**
 * `workspaceId` narrows the candidate query to one workspace's ring slice
 * (v3 Team Edition), same convention as src/staleness/pass.ts. Undefined/null
 * — every direct and manual caller — scans the whole corpus.
 */
export async function runWhenExtractPass(
  env: Env,
  _ctx: ExecutionContext,
  workspaceId?: string | null,
  limit = WHEN_EXTRACT_PER_NIGHT,
): Promise<WhenPassSummary> {
  await initializeDatabase(env);
  const cfg = await resolveConfig(env);
  const now = Date.now();

  const cursor = await readWhenCursor(env, workspaceId);

  let candidates: WhenCandidate[] = [];
  const scan = reserveD1Sql(env, 2);
  if (!scan) return { whenExtracted: 0, whenJudged: 0, whenSkipped: 0, ok: false };

  try {
    const slice: ScopeClause | null = workspaceId != null ? { clause: "workspace_id = ?", bindings: [workspaceId] } : null;
    await assertMemoryWritesAllowed(scan.env);
    candidates = await fetchWhenCandidates(scan.env, cursor, slice, limit);
  } catch (e) {
    console.error("When-extraction candidate query failed (non-fatal):", e);
    return { whenExtracted: 0, whenJudged: 0, whenSkipped: 0, ok: false };
  } finally { scan.release(); }
  // 末尾に到達したら次回は先頭から再評価する。古い記憶のタスク化・移動・編集も拾う。
  // 同じ回で再走査せず、SQL予約とモデル呼出し上限を維持する。
  if (!candidates.length) {
    await writeWhenCursor(env, {}, workspaceId);
    return { whenExtracted: 0, whenJudged: 0, whenSkipped: 0, ok: true };
  }
  const mutation = reserveD1Sql(env, candidates.length);
  if (!mutation) return { whenExtracted: 0, whenJudged: 0, whenSkipped: 0, ok: false };
  try {
    env = mutation.env;

    let whenJudged = 0;
    let whenSkipped = 0;
    const writes: D1PreparedStatement[] = [];
    const reviews: WhenReview[] = [];
    // The position this run WOULD advance the cursor to, kept separate from
    // the write until the batch below (if any) actually lands — Finding 1.
    let nextPosition: { createdAt: number; id: string } | null = null;
    // Failure tracking to persist alongside (or instead of) a position —
    // Finding 2. Absent unless this run's loop stopped on a "failed" outcome.
    let nextFailure: { failedId: string; failCount: number; failedFingerprint: string } | undefined;

    for (const candidate of candidates) {
      const review = await whenReview(candidate, cfg);
      if (await hasWhenReview(env, review, now)) {
        nextPosition = { createdAt: candidate.created_at, id: candidate.id };
        nextFailure = undefined;
        continue;
      }
      const verdict = await judgeCommitment(candidate.content, now, env, cfg);
      if (verdict.outcome === "failed") {
        const priorCount = cursor?.failedId === candidate.id && cursor.failedFingerprint === review.fingerprint
          ? (cursor.failCount ?? 0) : 0;
        const failCount = priorCount + 1;
        if (failCount >= WHEN_QUARANTINE_AFTER) {
          // Quarantined: advance PAST this one poisoned entry and reset the
          // streak, rather than let it block the corpus behind it forever.
          // What comes after it is not judged this same run — a fresh
          // fetchWhenCandidates next time starts right there.
          nextPosition = { createdAt: candidate.created_at, id: candidate.id };
          nextFailure = undefined;
          whenSkipped++;
        } else {
          nextFailure = { failedId: candidate.id, failCount, failedFingerprint: review.fingerprint };
        }
        break; // stop; do not advance the cursor's POSITION past this one, quarantine aside
      }
      nextPosition = { createdAt: candidate.created_at, id: candidate.id };
      nextFailure = undefined; // a real verdict landed — any prior streak on an earlier id no longer applies
      whenJudged++;
      if (verdict.outcome === "declined") reviews.push(review);
      if (verdict.outcome === "commitment") {
        writes.push(
          // versioning: exempt: 上流同様の夜間期限推定。ユーザー編集とは別のhygiene。
          env.DB.prepare(`UPDATE entries SET when_at = ?, when_kind = ?, when_source = 'model', when_label = ?, write_marker = ? WHERE id = ? AND content = ? AND workspace_id = ? AND tags = ? AND when_at IS NULL AND when_source IS NULL`)
            .bind(verdict.dueAt, verdict.kind, verdict.what, memoryWriteMarker(env), candidate.id, candidate.content, candidate.workspace_id, candidate.tags),
        );
      }
    }

    // One batch however many writes it carries — the whole reason the loop
    // above collects statements instead of running them as it goes. Nothing
    // about this run's cursor position is written unless this succeeds: a
    // judged-but-unpersisted commitment must stay eligible to be asked about
    // again, not be silently skipped because the cursor said it was handled.
    let ok = true;
    let whenExtracted = 0;
    if (writes.length) {
      try {
        const results = await env.DB.batch(writes);
        // Each CAS targets one entry; count committed candidates, not trigger writes.
        whenExtracted = results.filter(result => (result.meta.changes ?? result.meta.rows_written ?? 0) > 0).length;
        // 競合した候補は次回再評価し、古い本文からの期限を保存しない。
        ok = whenExtracted === writes.length;
      } catch (e) {
        console.error("When-extraction batch write failed; not advancing the cursor this run (non-fatal):", e);
        ok = false;
      }
    }

    if (ok) {
      for (const review of reviews) await saveWhenReview(env, review, now);
      // Quarantine's resulting position always wins over an in-progress
      // failure streak on some OTHER, earlier id — nextFailure is already
      // cleared in that branch above, so this just persists whichever of the
      // two applies (or neither, on an empty candidate list).
      const toWrite: WhenCursor = {
        ...(nextPosition ? { createdAt: nextPosition.createdAt, id: nextPosition.id } : (cursor?.createdAt !== undefined ? { createdAt: cursor.createdAt, id: cursor.id! } : {})),
        ...(nextFailure ? nextFailure : {}),
      };
      if (toWrite.createdAt !== undefined || toWrite.failedId !== undefined) {
        await writeWhenCursor(env, toWrite, workspaceId);
      }
    }

    return { whenExtracted, whenJudged, whenSkipped, ok };
  } finally { mutation.release(); }
}
