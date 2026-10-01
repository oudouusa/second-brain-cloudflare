import { reserveD1Sql, remainingD1Sql } from "../runtime/d1-budget";
/**
 * The Web Push sender: reads due items for one workspace, encrypts a
 * notification per subscription (RFC 8291, src/push/crypto.ts), and posts it
 * to the subscription's push service. Driven by the hourly integration-sync
 * cron (src/index.ts) and by the admin POST /push/run and /push/test routes.
 */
import type { Env } from "../env";
import { resolveConfig, type Config } from "../config";
import { dueSql } from "../when/input";
import { NOT_HELD_SQL } from "../quarantine/tags";
import { encryptWebPush } from "./crypto";
import { vapidAuthHeader } from "./vapid";
import { fromBase64Url } from "./base64url";
import { OWED_TO_ME_TAG, COUNTERPARTY_TAG_PREFIX, counterpartyName } from "../commitments/direction";
import { reviewLabel } from "../decisions/capture";

// Literal for now, not imported from a shared reserved-tag list: Track 7's
// Lane A (src/tags/t7.ts) owns that list and lands separately. Reconcile once
// it merges.
const LEDGER_DECISION_TAG = "ledger:decision";

/** A feed, not a blast: at most this many due items per workspace are considered per run. */
const MAX_NOTIFICATIONS_PER_RUN = 3;
/**
 * Each send is an external fetch, and the free plan allows 50 per
 * invocation, shared with anything else the same invocation fetches. One
 * PushBudget of 40 is created per invocation and shared by every workspace
 * that invocation touches: the cron, POST /push/run and POST /push/test.
 * A send the budget cannot cover is never attempted, so it is never a failure.
 */
export const MAX_PUSH_FETCHES_PER_RUN = 40;
/**
 * The platform's real external-fetch ceiling per invocation (FX3 finding 3). The hourly cron
 * runs the mirror sync and this pass in the SAME invocation (src/index.ts), so when the sync
 * spent some of that 50 already, push must not also assume it gets the full MAX_PUSH_FETCHES_PER_RUN
 * on top — a Notion sync alone can spend up to ~35 (src/integrations/notion.ts), which left
 * unshared totals 75 against a limit of 50.
 */
export const PLATFORM_EXTERNAL_FETCH_BUDGET_PER_RUN = 50;
/**
 * Subscribed workspaces the cron reads per run. Each costs two D1 SELECTs,
 * so the worst case is 1 + 2 x 50 + 1 = 102 D1 calls per invocation, well
 * under the 1,000 cap. The ring cursor below brings the rest in later runs.
 */
export const MAX_PUSH_WORKSPACES_PER_RUN = 4;
/** Consecutive send failures a subscription tolerates before it is dropped. */
const MAX_FAIL_COUNT = 5;
/** Per-workspace delivery record: {entryId: {w: when_at, s: endpoint hashes that received it at that when_at}}. */
export const PUSHED_KV_PREFIX = "pushed:";
/**
 * The cron's position in the ring of subscribed workspaces, with the
 * maintenance_cursor semantics (src/runtime/rotation.ts): ascending by id,
 * resume strictly after the stored value, wrap at the end, '' takes its
 * turn like any other id. KV rather than that table: it is single-row by
 * design (CHECK id = 1) and this track adds no schema.
 */
export const PUSH_CURSOR_KV_KEY = "push:cursor";

/** Short-lived run lease, best effort: see acquireRunLease. */
export const PUSH_LEASE_KV_KEY = "push:lease";
const PUSH_LEASE_TTL_SECONDS = 60;

/**
 * FX3 finding 4: pushDueItemsAllWorkspaces writes one delivery record per workspace it reserves
 * into, plus the lease and the cursor — up to 42 KV writes an hour, so run every hour with nothing
 * else slowing it down that is ~1,008 a day, alone close to exhausting a shared account-wide daily
 * KV write quota before the standing cache, nightly cleanup, or anything else gets a write in.
 * MAX_PUSH_KV_WRITES_PER_DAY is push's own self-imposed slice of that shared budget, tracked in
 * PUSH_KV_WRITE_COUNT_KEY (one extra read and one extra write per invocation that sends anything,
 * not per workspace) and reset at UTC midnight.
 */
export const MAX_PUSH_KV_WRITES_PER_DAY = 300;
export const PUSH_KV_WRITE_COUNT_KEY = "push:kv-writes";

/** Per-invocation state: the fetch budget, and the run lease shared by every workspace call that uses it. */
export interface PushBudget {
  fetchesLeft: number;
  lease?: Promise<LeaseResult>;
  leaseToken?: string;
  users?: number;
  kvWriteFailed?: boolean;
}

type LeaseResult = "held" | "busy" | "kv_write_failed";

/**
 * One per invocation; pass the same one to every workspace the invocation pushes to.
 * `fetchesLeft` defaults to push's own cap, for a caller that is the only fetcher in its
 * invocation; a caller sharing the invocation with another fetcher (the sync cron) passes
 * what is actually left of PLATFORM_EXTERNAL_FETCH_BUDGET_PER_RUN instead (FX3 finding 3).
 */
export function newPushBudget(fetchesLeft: number = MAX_PUSH_FETCHES_PER_RUN): PushBudget {
  return { fetchesLeft };
}

/** Set while a run in this isolate holds the lease: an overlap within one isolate is refused outright. */
let isolateLeaseHeld = false;

/**
 * Taken once per invocation, and only when there is something to send, so
 * a run with nothing new writes nothing. In-isolate overlaps are refused
 * exactly; across isolates it is best effort, because KV has no atomic
 * compare-and-set: write a random token, read it back, and back off if
 * another run's token is there. Two runs that both write before either
 * reads back can still both proceed, and a run that outlasts the 60-second
 * TTL loses its protection; the cost of either is one duplicate
 * notification. The lease write doubles as the KV canary: if it fails (for
 * example the daily write cap is spent), the run sends nothing.
 */
function acquireRunLease(env: Env, budget: PushBudget): Promise<LeaseResult> {
  budget.lease ??= (async (): Promise<LeaseResult> => {
    if (isolateLeaseHeld) return "busy";
    isolateLeaseHeld = true;
    const token = crypto.randomUUID();
    try {
      const existing = parseLease(await env.OAUTH_KV.get(PUSH_LEASE_KV_KEY));
      if (existing && existing.until > Date.now()) { isolateLeaseHeld = false; return "busy"; }
      try {
        await env.OAUTH_KV.put(PUSH_LEASE_KV_KEY, JSON.stringify({ token, until: Date.now() + PUSH_LEASE_TTL_SECONDS * 1000 }), { expirationTtl: PUSH_LEASE_TTL_SECONDS });
      } catch (e) {
        isolateLeaseHeld = false;
        logKvWriteFailure(budget, e);
        return "kv_write_failed";
      }
      const readBack = parseLease(await env.OAUTH_KV.get(PUSH_LEASE_KV_KEY));
      if (readBack && readBack.token !== token) { isolateLeaseHeld = false; return "busy"; }
      budget.leaseToken = token;
      return "held";
    } catch (e) {
      isolateLeaseHeld = false;
      console.error("push: could not read the run lease; skipping this run:", e);
      return "busy";
    }
  })();
  return budget.lease;
}

function parseLease(raw: string | null): { token: string; until: number } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { token?: unknown; until?: unknown };
    return typeof value.token === "string" && typeof value.until === "number" ? { token: value.token, until: value.until } : null;
  } catch {
    return null;
  }
}

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Today's write count against MAX_PUSH_KV_WRITES_PER_DAY, or 0 for a stored day that has passed. */
async function readDailyKvWriteCount(env: Env, now: number): Promise<number> {
  try {
    const raw = await env.OAUTH_KV.get(PUSH_KV_WRITE_COUNT_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { date?: unknown; count?: unknown };
    if (parsed.date !== utcDate(now) || typeof parsed.count !== "number") return 0;
    return parsed.count;
  } catch {
    return 0;
  }
}

/** Adds this run's writes to today's count. Never throws: a failure here costs only the count's accuracy, not the run. */
async function recordDailyKvWrites(env: Env, now: number, before: number, thisRun: number): Promise<void> {
  if (!thisRun) return;
  try {
    await env.OAUTH_KV.put(PUSH_KV_WRITE_COUNT_KEY, JSON.stringify({ date: utcDate(now), count: before + thisRun }));
  } catch (e) {
    console.error("push: recording today's KV write count failed (non-fatal):", e);
  }
}

async function releaseRunLease(env: Env, budget: PushBudget): Promise<void> {
  if (!budget.leaseToken) return;
  const token = budget.leaseToken;
  budget.leaseToken = undefined;
  isolateLeaseHeld = false;
  try {
    if (parseLease(await env.OAUTH_KV.get(PUSH_LEASE_KV_KEY))?.token === token) await env.OAUTH_KV.delete(PUSH_LEASE_KV_KEY);
  } catch {
    // The TTL expires it anyway.
  }
}

/** One line per invocation, however many writes fail after it. */
function logKvWriteFailure(budget: PushBudget, e: unknown): void {
  if (budget.kvWriteFailed) return;
  budget.kvWriteFailed = true;
  console.error(
    "push: KV write failed (the daily KV write limit may be spent); nothing more is sent this run, so nothing repeats. Push resumes once KV writes succeed:",
    e,
  );
}
/**
 * Push services require a TTL on every request (RFC 8030 section 5.2); Apple
 * in particular rejects a request missing one. An hour is enough life for a
 * due-item nudge to reach an offline device without the push service
 * holding onto (and eventually redelivering) something stale.
 */
const PUSH_TTL_SECONDS = 3600;
/** RFC 8030 section 5.3. "normal" is the one push services expect absent a real priority signal — this sender has none. */
const PUSH_URGENCY = "normal";
/** Forgotten test/stale ids age out of the pushed-map on write; see prunePushedMap. */
const PUSHED_MAP_PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** POST /push/run's per-subscription outcomes, capped so a large brain's response stays small. */
const MAX_REPORTED_RESULTS = 10;

interface PushSubscriptionRow {
  id: string;
  endpoint_hash: string;
  subscription_json: string;
  content_free: number;
  fail_count: number;
}

interface DueCandidate {
  id: string;
  when_at: number;
  label: string;
  tags: string[];
}

type PushKind = "inbound" | "decision" | "other";

function pushKindOf(tags: string[]): PushKind {
  if (tags.includes(LEDGER_DECISION_TAG)) return "decision";
  if (tags.includes(OWED_TO_ME_TAG)) return "inbound";
  return "other";
}

/** The display name from the row's counterparty:<slug> tag, or null when there is none. */
function counterpartyOf(tags: string[]): string | null {
  const tag = tags.find((t) => t.startsWith(COUNTERPARTY_TAG_PREFIX));
  return tag ? counterpartyName(tag.slice(COUNTERPARTY_TAG_PREFIX.length)) : null;
}

type SendResult = "ok" | "gone" | "failed";

interface SendOutcome {
  result: SendResult;
  /** The push service's HTTP response status, or null when the request itself threw (network error). */
  httpStatus: number | null;
}

function parseTags(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function pushedKvKey(workspaceId: string): string {
  return `${PUSHED_KV_PREFIX}${workspaceId}`;
}

type DeliveryMap = Record<string, { w: number; s: string[] }>;

/** In a record's hash list: delivered to every subscription (a pre-4.0 record). */
const ALL_SUBSCRIPTIONS = "*";

/**
 * Per subscription, not per workspace, so a run cut short by the budget
 * resumes with exactly the subscriptions still missing an item. A pre-4.0
 * map stored a bare when_at, meaning every subscription had it: read that
 * as delivered to all, so upgrading re-sends nothing.
 */
async function readDeliveryMap(env: Env, workspaceId: string): Promise<DeliveryMap> {
  const raw = await env.OAUTH_KV.get(pushedKvKey(workspaceId));
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== "object") return {};
  const map: DeliveryMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number") {
      map[id] = { w: value, s: [ALL_SUBSCRIPTIONS] };
    } else if (value && typeof value === "object") {
      const { w, s } = value as { w?: unknown; s?: unknown };
      if (typeof w === "number" && Array.isArray(s)) map[id] = { w, s: s.filter((h): h is string => typeof h === "string") };
    }
  }
  return map;
}

/**
 * Drops a record only when the due query returned every due item (the
 * window was not full) and the record's item was not among them and is
 * over 30 days old: then it is provably no longer due. Pruning by age alone
 * dropped still-due items overdue by more than 30 days, which were then
 * re-pushed on every run. Hashes of deleted subscriptions are dropped too.
 */
function pruneDeliveryMap(map: DeliveryMap, dueIds: Set<string>, windowFull: boolean, hashes: Set<string>, now: number): DeliveryMap {
  const cutoff = now - PUSHED_MAP_PRUNE_AGE_MS;
  const pruned: DeliveryMap = {};
  for (const [id, entry] of Object.entries(map)) {
    if (windowFull || dueIds.has(id) || entry.w >= cutoff) {
      pruned[id] = { w: entry.w, s: entry.s.filter(h => h === ALL_SUBSCRIPTIONS || hashes.has(h)) };
    }
  }
  return pruned;
}

/** "ok" | "http_<code>" | "error", the shape POST /push/run reports per subscription. */
function outcomeStatus(outcome: SendOutcome): string {
  if (outcome.result === "ok") return "ok";
  if (outcome.httpStatus != null) return `http_${outcome.httpStatus}`;
  return "error";
}

export interface PushOutcome {
  /** First 12 hex characters of the subscription's endpoint hash — enough to tell rows apart in a log, not enough to identify the device. */
  endpoint_hash_prefix: string;
  status: string;
}

function toReportedOutcomes(outcomes: { hash: string; result: SendResult; httpStatus: number | null }[]): PushOutcome[] {
  return outcomes.slice(0, MAX_REPORTED_RESULTS).map(o => ({
    endpoint_hash_prefix: o.hash.slice(0, 12),
    status: outcomeStatus(o),
  }));
}

/** The attribution line, its own short sentence with the product name capitalized. */
const FROM_SECOND_BRAIN = "From your Second Brain.";

/**
 * The Worker has no browser locale to render in, so the notification body's
 * date is formatted directly in the brain's configured TIMEZONE via Intl —
 * not toISOString (always UTC) and not the server runtime's own local time
 * (Workers run in UTC anyway, and even if they did not, "the machine
 * happened to run on" is not "the zone this brain is configured for").
 */
function zonedDateParts(atMs: number, timezone: string): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(atMs);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * "today", or a friendly "Sep 1" ("Sep 1, 2025" when the year differs from
 * the current one in the brain's timezone) — never the ISO date the old
 * wording used (18-copy-deck.md section 5.1).
 */
function friendlyDueDate(atMs: number, now: number, timezone: string): string {
  const due = zonedDateParts(atMs, timezone);
  const today = zonedDateParts(now, timezone);
  if (due.year === today.year && due.month === today.month && due.day === today.day) return "today";
  const options: Intl.DateTimeFormatOptions = { timeZone: timezone, month: "short", day: "numeric" };
  if (due.year !== today.year) options.year = "numeric";
  return new Intl.DateTimeFormat("en-US", options).format(atMs);
}

function notificationPayload(candidate: DueCandidate, contentFree: boolean, timezone: string, now: number): Record<string, unknown> {
  if (contentFree) return { title: "Something is due. Tap to see it." };
  const dueDate = friendlyDueDate(candidate.when_at, now, timezone);
  const kind = pushKindOf(candidate.tags);

  if (kind === "decision") {
    return { title: reviewLabel(candidate.label), body: `How did this decision turn out? ${FROM_SECOND_BRAIN}`, entry_id: candidate.id };
  }
  if (kind === "inbound") {
    const counterparty = counterpartyOf(candidate.tags);
    const body = counterparty
      ? `${counterparty} owes you this. Due ${dueDate}. ${FROM_SECOND_BRAIN}`
      : `Owed to you. Due ${dueDate}. ${FROM_SECOND_BRAIN}`;
    return { title: candidate.label, body, entry_id: candidate.id };
  }
  return { title: candidate.label, body: `Due ${dueDate}. ${FROM_SECOND_BRAIN}`, entry_id: candidate.id };
}

/**
 * Encrypts and sends one message. encryptWebPush generates its own fresh
 * ephemeral ECDH key pair per call (src/push/crypto.ts) — this function never
 * touches the persistent VAPID keys except through vapidAuthHeader, which
 * signs the JWT and is unrelated to the message's encryption key.
 */
async function sendOne(env: Env, sub: PushSubscriptionRow, payload: Record<string, unknown>): Promise<SendOutcome> {
  let res: Response;
  try {
    // Inside the try: a malformed stored subscription is one failed send, never an aborted run.
    const subscription = JSON.parse(sub.subscription_json) as { endpoint: string; keys: { p256dh: string; auth: string } };
    const encrypted = await encryptWebPush({
      plaintext: new TextEncoder().encode(JSON.stringify(payload)),
      subscriptionPublicKey: fromBase64Url(subscription.keys.p256dh),
      subscriptionAuthSecret: fromBase64Url(subscription.keys.auth),
    });
    res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: PUSH_URGENCY,
        Authorization: await vapidAuthHeader(env, subscription.endpoint),
      },
      body: encrypted.body,
    });
  } catch {
    return { result: "failed", httpStatus: null };
  }
  if (res.status === 404 || res.status === 410) return { result: "gone", httpStatus: res.status };
  return { result: res.ok ? "ok" : "failed", httpStatus: res.status };
}

/** Keeps each IN-list well under D1's 100 bound parameters, with room for a statement's two extra bindings. */
const HASHES_PER_STATEMENT = 90;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function groupBy<K>(entries: [K, string][]): Map<K, string[]> {
  const groups = new Map<K, string[]>();
  for (const [key, hash] of entries) groups.set(key, [...(groups.get(key) ?? []), hash]);
  return groups;
}

interface SendRecord { hash: string; result: SendResult; httpStatus: number | null; failCountBefore: number }

/**
 * Every failed send adds exactly 1 to its subscription's fail_count; a
 * success resets it, so the stored value is the failures since the last
 * success, taken in send order. At MAX_FAIL_COUNT, or on 404/410, the
 * subscription is deleted. Only attempted sends are recorded, so a send the
 * budget skipped can never count. One D1 batch, one subrequest, however many
 * statements the chunking makes.
 */
async function applySubscriptionOutcomes(env: Env, sends: SendRecord[]): Promise<void> {
  const bySub = new Map<string, { failCountBefore: number; results: SendResult[] }>();
  for (const send of sends) {
    const entry = bySub.get(send.hash) ?? { failCountBefore: send.failCountBefore, results: [] };
    entry.results.push(send.result);
    bySub.set(send.hash, entry);
  }

  const toDelete: string[] = [];
  const failedOnly: [number, string][] = [];
  const recovered: [number, string][] = [];
  for (const [hash, { failCountBefore, results }] of bySub) {
    if (results.includes("gone")) { toDelete.push(hash); continue; }
    let consecutive = failCountBefore;
    let failures = 0;
    let sawOk = false;
    for (const result of results) {
      if (result === "ok") { consecutive = 0; sawOk = true; } else { consecutive++; failures++; }
    }
    if (consecutive >= MAX_FAIL_COUNT) toDelete.push(hash);
    else if (sawOk) recovered.push([consecutive, hash]);
    else failedOnly.push([failures, hash]);
  }

  const writes = [];
  for (const hashes of chunk(toDelete, HASHES_PER_STATEMENT)) {
    writes.push(env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint_hash IN (${hashes.map(() => "?").join(",")})`,
    ).bind(...hashes));
  }
  // Relative, so a concurrent run's increments are not overwritten.
  for (const [failures, group] of groupBy(failedOnly)) {
    for (const hashes of chunk(group, HASHES_PER_STATEMENT)) {
      writes.push(env.DB.prepare(
        `UPDATE push_subscriptions SET fail_count = fail_count + ? WHERE endpoint_hash IN (${hashes.map(() => "?").join(",")})`,
      ).bind(failures, ...hashes));
    }
  }
  const okAt = Date.now();
  for (const [trailing, group] of groupBy(recovered)) {
    for (const hashes of chunk(group, HASHES_PER_STATEMENT)) {
      writes.push(env.DB.prepare(
        `UPDATE push_subscriptions SET last_ok_at = ?, fail_count = ? WHERE endpoint_hash IN (${hashes.map(() => "?").join(",")})`,
      ).bind(okAt, trailing, ...hashes));
    }
  }
  if (writes.length) await env.DB.batch(writes);
}

export interface PushDueItemsResult {
  sent: number;
  candidates: number;
  subscriptions: number;
  /** Per-subscription send outcomes, capped at MAX_REPORTED_RESULTS — POST /push/run surfaces these for live diagnosis. */
  results: PushOutcome[];
}

/** One workspace's pending sends for this run, and what it has sent so far. */
interface WorkspacePush {
  workspaceId: string;
  now: number;
  timezone: string;
  candidates: DueCandidate[];
  subs: PushSubscriptionRow[];
  delivery: DeliveryMap;
  dueRows: Record<string, any>[];
  dueIds: Set<string>;
  windowFull: boolean;
  tasks: SendTask[];
  sends: SendRecord[];
}

interface SendTask { push: WorkspacePush; candidate: DueCandidate; sub: PushSubscriptionRow }

const DUE_WINDOW = MAX_NOTIFICATIONS_PER_RUN * 5;

/**
 * One KV read and two D1 SELECTs (the subscriptions one only when something
 * is due). The due query sorts items with a delivery record at their
 * current when_at LAST, so a backlog of already-delivered overdue items can
 * never fill the window and hide a newer one.
 */
async function prepareWorkspacePush(env: Env, workspaceId: string, now: number, timezone: string): Promise<WorkspacePush> {
  const push: WorkspacePush = {
    workspaceId, now, timezone, candidates: [], subs: [], delivery: {}, dueRows: [], dueIds: new Set(),
    windowFull: false, tasks: [], sends: [],
  };
  push.delivery = await readDeliveryMap(env, workspaceId);
  const delivered = Object.fromEntries(Object.entries(push.delivery).map(([id, record]) => [id, record.w]));
  // validity: current: a superseded due item never pushes (5.5)
  push.dueRows = ((await env.DB.prepare(
    `SELECT id, content, when_at, when_label, tags FROM entries
     WHERE ${dueSql(now)} AND ${NOT_HELD_SQL} AND when_at <= ? AND workspace_id = ?
     ORDER BY EXISTS (SELECT 1 FROM json_each(?) d WHERE d.key = entries.id AND d.value = entries.when_at), when_at ASC
     LIMIT ?`,
  ).bind(now, workspaceId, JSON.stringify(delivered), DUE_WINDOW).all()).results ?? []) as Record<string, any>[];
  if (!push.dueRows.length) return push;
  push.dueIds = new Set(push.dueRows.map(r => r.id as string));
  push.windowFull = push.dueRows.length >= DUE_WINDOW;

  push.subs = ((await env.DB.prepare(
    `SELECT id, endpoint_hash, subscription_json, content_free, fail_count FROM push_subscriptions
     WHERE workspace_id = ? ORDER BY endpoint_hash`,
  ).bind(workspaceId).all()).results ?? []) as unknown as PushSubscriptionRow[];
  if (!push.subs.length) return push;

  computeTasks(push);
  return push;
}

/** Every (item, subscription) pair the delivery record lacks, item-major so each device gets the most overdue item first. */
function computeTasks(push: WorkspacePush): void {
  push.candidates = [];
  push.tasks = [];
  for (const row of push.dueRows) {
    if (!Number.isFinite(new Date(row.when_at as number).getTime())) continue;
    if (push.candidates.length >= MAX_NOTIFICATIONS_PER_RUN) break;
    const record = push.delivery[row.id as string];
    const have = new Set(record && record.w === row.when_at ? record.s : []);
    const missing = have.has(ALL_SUBSCRIPTIONS) ? [] : push.subs.filter(sub => !have.has(sub.endpoint_hash));
    if (!missing.length) continue;
    const candidate: DueCandidate = {
      id: row.id as string,
      when_at: row.when_at as number,
      label: (row.when_label as string | null) || (row.content as string).slice(0, 80),
      tags: parseTags(row.tags),
    };
    push.candidates.push(candidate);
    for (const sub of missing) push.tasks.push({ push, candidate, sub });
  }
}

/** Takes the first tasks the shared budget can afford, decrementing it now, so parallel callers cannot overrun it. */
function reserve(tasks: SendTask[], budget: PushBudget): SendTask[] {
  const reserved = tasks.slice(0, Math.max(0, budget.fetchesLeft));
  budget.fetchesLeft -= reserved.length;
  return reserved;
}

/**
 * Write-ahead: the delivery record gains the reserved sends BEFORE they are
 * made. A run that overlaps this one reads them as delivered, and if the
 * write fails nothing is sent, so a failing KV can never cause a resend
 * storm. The cost is at-most-once delivery if the invocation dies mid-send.
 */
async function recordAhead(env: Env, push: WorkspacePush, reserved: SendTask[], budget: PushBudget): Promise<boolean> {
  if (budget.kvWriteFailed) return false;
  for (const { candidate, sub } of reserved) {
    const record = push.delivery[candidate.id];
    if (record && record.w === candidate.when_at) record.s.push(sub.endpoint_hash);
    else push.delivery[candidate.id] = { w: candidate.when_at, s: [sub.endpoint_hash] };
  }
  const hashes = new Set(push.subs.map(s => s.endpoint_hash));
  try {
    await env.OAUTH_KV.put(pushedKvKey(push.workspaceId), JSON.stringify(pruneDeliveryMap(push.delivery, push.dueIds, push.windowFull, hashes, push.now)));
    return true;
  } catch (e) {
    logKvWriteFailure(budget, e);
    return false;
  }
}

async function sendReserved(env: Env, reserved: SendTask[]): Promise<void> {
  for (const { push, candidate, sub } of reserved) {
    const outcome = await sendOne(env, sub, notificationPayload(candidate, !!sub.content_free, push.timezone, push.now));
    push.sends.push({ hash: sub.endpoint_hash, result: outcome.result, httpStatus: outcome.httpStatus, failCountBefore: sub.fail_count });
  }
}

/** 送信前の重複抑止は維持し、失敗が確定した端末だけ次回の再試行へ戻す。 */
async function retryFailedSends(env: Env, push: WorkspacePush, reserved: SendTask[], budget: PushBudget): Promise<boolean> {
  let changed = false;
  for (let i = 0; i < push.sends.length; i++) {
    if (push.sends[i].result !== "failed") continue;
    const { candidate, sub } = reserved[i];
    const record = push.delivery[candidate.id];
    if (record?.w === candidate.when_at) {
      record.s = record.s.filter(hash => hash !== sub.endpoint_hash);
      changed = true;
    }
  }
  if (!changed) return false;
  try { await env.OAUTH_KV.put(pushedKvKey(push.workspaceId), JSON.stringify(push.delivery)); }
  catch (error) { logKvWriteFailure(budget, error); }
  return true;
}

/** Re-reads the delivery record under the lease, so sends a run finished meanwhile are not repeated. */
async function refreshTasks(env: Env, push: WorkspacePush): Promise<void> {
  push.delivery = await readDeliveryMap(env, push.workspaceId);
  computeTasks(push);
}

const okCount = (sends: SendRecord[]) => sends.filter(s => s.result === "ok").length;

/**
 * Why a run sent nothing although something was due: another run held the lease, KV writes
 * failed, or (pushDueItemsAllWorkspaces only, FX3 finding 4) today's self-imposed KV write
 * allowance is already spent.
 */
export type PushSkip = "busy" | "kv_write_failed" | "daily_kv_cap";

/**
 * Pushes due items (overdue and due today, dueSql) for one workspace to
 * each subscription that has not yet had them at their current when_at.
 * POST /push/run calls this once per readable workspace with one shared
 * budget, which also carries one shared run lease; alone it gets its own.
 *
 * Cost: at most 3 D1 calls (delivery-aware due SELECT, subscriptions
 * SELECT, one batch) and budget-limited external fetches. KV is written
 * only when something is sent: the lease and one delivery record.
 */
export async function pushDueItems(
  env: Env, workspaceId: string, resolved?: Readonly<Config>, budget: PushBudget = newPushBudget(),
): Promise<PushDueItemsResult & { skipped?: PushSkip }> {
  // 候補・購読の2読取と、失敗回数別の結果更新を送信前に確保する。
  const allowance = Math.min(9, remainingD1Sql(env));
  if (allowance < 2) return { sent: 0, candidates: 0, subscriptions: 0, results: [] };
  const reservation = reserveD1Sql(env, allowance);
  if (!reservation) return { sent: 0, candidates: 0, subscriptions: 0, results: [] };
  env = reservation.env;
  budget.users = (budget.users ?? 0) + 1;
  try {
    const config = resolved ?? await resolveConfig(env);
    const push = await prepareWorkspacePush(env, workspaceId, Date.now(), config.TIMEZONE);
    const base = { candidates: push.candidates.length, subscriptions: push.subs.length };
    if (!push.tasks.length) return { sent: 0, ...base, results: [] };
    if (remainingD1Sql(env) < Math.min(push.subs.length, 7)) return { sent: 0, ...base, results: [] };

    const lease = await acquireRunLease(env, budget);
    if (lease !== "held") return { sent: 0, ...base, results: [], skipped: lease };

    await refreshTasks(env, push);
    const reserved = reserve(push.tasks, budget);
    if (reserved.length && await recordAhead(env, push, reserved, budget)) {
      await sendReserved(env, reserved);
      await retryFailedSends(env, push, reserved, budget);
    }
    await applySubscriptionOutcomes(env, push.sends);
    return {
      sent: okCount(push.sends), candidates: push.candidates.length, subscriptions: push.subs.length,
      results: toReportedOutcomes(push.sends), ...(budget.kvWriteFailed ? { skipped: "kv_write_failed" as const } : {}),
    };
  } finally {
    reservation.release();
    budget.users--;
    if (budget.users === 0) await releaseRunLease(env, budget);
  }
}

/** Up to `limit` ids from the ring, starting strictly after the cursor and wrapping. */
function ringSlice(ring: string[], cursor: string | null, limit: number): string[] {
  const after = cursor === null ? 0 : ring.findIndex(id => id > cursor);
  const start = after === -1 ? 0 : after;
  return Array.from({ length: Math.min(limit, ring.length) }, (_, i) => ring[(start + i) % ring.length]);
}

/** Each workspace's first pending task, then each one's second, and so on. */
function interleave(pushes: WorkspacePush[]): SendTask[] {
  const longest = pushes.reduce((max, p) => Math.max(max, p.tasks.length), 0);
  const tasks: SendTask[] = [];
  for (let position = 0; position < longest; position++) {
    for (const push of pushes) if (position < push.tasks.length) tasks.push(push.tasks[position]);
  }
  return tasks;
}

/**
 * The hourly cron. Reads up to MAX_PUSH_WORKSPACES_PER_RUN subscribed
 * workspaces from the persistent ring cursor and, only if something is
 * pending, takes the run lease, re-reads their delivery records, reserves
 * sends one per workspace per round under one fetch budget (MAX_PUSH_FETCHES_PER_RUN
 * by default, or whatever a caller sharing its invocation with another
 * fetcher passes instead — see newPushBudget, FX3 finding 3), records them
 * ahead, sends them, then moves the cursor: to the last workspace read when
 * everything fit, otherwise to just before the workspace the budget stopped
 * at, so the next run starts there. Together with the per-subscription
 * delivery record this reaches every workspace and subscription within a
 * bounded number of runs.
 *
 * Worst case per invocation, alone: 102 D1 calls (1 ring scan + 2 per workspace x
 * 50 + 1 batch), 40 external fetches, 105 KV reads (cursor, 50 records, 50
 * re-reads under the lease, 2 lease reads, 1 at release, 1 daily-write-count read)
 * and 43 KV writes (lease, at most 40 records, cursor, 1 daily-write-count write)
 * plus 1 lease delete. A run with nothing new writes nothing, and never reaches
 * the daily-cap check (FX3 finding 4) at all.
 */
async function pushDueItemsAllWorkspacesReserved(
  env: Env, resolved?: Readonly<Config>, budget: PushBudget = newPushBudget(),
): Promise<{ sent: number; skipped?: PushSkip }> {
  const ring = (((await env.DB.prepare(
    `SELECT DISTINCT workspace_id FROM push_subscriptions ORDER BY workspace_id`,
  ).all()).results ?? []) as { workspace_id: string }[]).map(r => r.workspace_id);
  if (!ring.length) return { sent: 0 };

  const cursor = await env.OAUTH_KV.get(PUSH_CURSOR_KV_KEY);
  const selection = ringSlice(ring, cursor, MAX_PUSH_WORKSPACES_PER_RUN);
  const config = resolved ?? await resolveConfig(env);
  const now = Date.now();
  const pushes: WorkspacePush[] = [];
  for (const workspaceId of selection) pushes.push(await prepareWorkspacePush(env, workspaceId, now, config.TIMEZONE));
  if (!pushes.some(p => p.tasks.length)) return { sent: 0 };

  // FX3 finding 4: checked only once something is actually due, so a quiet hour costs nothing
  // extra — matching the function's existing "nothing new, nothing written" economy.
  const dailyWritesBefore = await readDailyKvWriteCount(env, now);
  if (dailyWritesBefore >= MAX_PUSH_KV_WRITES_PER_DAY) return { sent: 0, skipped: "daily_kv_cap" };

  const lease = await acquireRunLease(env, budget);
  if (lease !== "held") return { sent: 0, skipped: lease };
  let writesThisRun = 0;
  try {
    for (const push of pushes) if (push.tasks.length) await refreshTasks(env, push);
    const tasks = interleave(pushes);
    const reserved = reserve(tasks, budget);

    const byPush = new Map<WorkspacePush, SendTask[]>();
    for (const task of reserved) byPush.set(task.push, [...(byPush.get(task.push) ?? []), task]);
    const recorded: SendTask[] = [];
    for (const [push, own] of byPush) {
      if (!await recordAhead(env, push, own, budget)) break;
      writesThisRun++;
      recorded.push(...own);
    }
    await sendReserved(env, reserved.filter(task => recorded.includes(task)));
    for (const [push, own] of byPush) {
      if (push.sends.length && await retryFailedSends(env, push, own, budget)) writesThisRun++;
    }
    await applySubscriptionOutcomes(env, pushes.flatMap(p => p.sends));

    if (!budget.kvWriteFailed) {
      let next: string | null = selection[selection.length - 1];
      if (reserved.length < tasks.length) {
        const index = selection.indexOf(tasks[reserved.length].push.workspaceId);
        next = index > 0 ? selection[index - 1] : cursor;
      }
      if (next !== null && next !== cursor) {
        try { await env.OAUTH_KV.put(PUSH_CURSOR_KV_KEY, next); writesThisRun++; } catch (e) { logKvWriteFailure(budget, e); }
      }
    }
    return { sent: pushes.reduce((n, p) => n + okCount(p.sends), 0), ...(budget.kvWriteFailed ? { skipped: "kv_write_failed" as const } : {}) };
  } finally {
    await recordDailyKvWrites(env, now, dailyWritesBefore, writesThisRun);
    await releaseRunLease(env, budget);
  }
}

/** POST /push/test's fixed notification, bypassing the due query entirely. */
export interface SendTestNotificationResult {
  sent: number;
  subscriptions: number;
  /** Same shape POST /push/run reports — shared code path, not a duplicate. */
  results: PushOutcome[];
}

/** Sends to subscriptions in endpoint-hash order while the budget lasts; POST /push/test shares one budget across workspaces. */
export async function sendTestNotification(
  env: Env, workspaceId: string, budget: PushBudget = newPushBudget(),
): Promise<SendTestNotificationResult> {
  const subs = ((await env.DB.prepare(
    `SELECT id, endpoint_hash, subscription_json, content_free, fail_count FROM push_subscriptions
     WHERE workspace_id = ? ORDER BY endpoint_hash`,
  ).bind(workspaceId).all()).results ?? []) as unknown as PushSubscriptionRow[];
  if (!subs.length) return { sent: 0, subscriptions: 0, results: [] };

  const payload = { title: "Second Brain", body: "Test notification. Push is working." };
  const sends: SendRecord[] = [];
  for (const sub of subs) {
    if (budget.fetchesLeft <= 0) break;
    budget.fetchesLeft--;
    const outcome = await sendOne(env, sub, payload);
    sends.push({ hash: sub.endpoint_hash, result: outcome.result, httpStatus: outcome.httpStatus, failCountBefore: sub.fail_count });
  }
  await applySubscriptionOutcomes(env, sends);

  return { sent: okCount(sends), subscriptions: subs.length, results: toReportedOutcomes(sends) };
}

export async function pushDueItemsAllWorkspaces(env: Env, resolved?: Readonly<Config>, budget: PushBudget = newPushBudget()): Promise<{ sent: number; skipped?: PushSkip }> {
  const allowance = Math.min(49, remainingD1Sql(env));
  if (allowance < 10) return { sent: 0 };
  // 4 workspaceの候補・購読SELECTと、送信ごとの最悪1更新文を確保する。
  budget.fetchesLeft = Math.min(budget.fetchesLeft, allowance - 9);
  const reservation = reserveD1Sql(env, allowance);
  if (!reservation) return { sent: 0 };
  try { return await pushDueItemsAllWorkspacesReserved(reservation.env, resolved, budget); }
  finally { reservation.release(); }
}
