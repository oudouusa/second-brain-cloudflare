/**
 * Runtime config layer (#245).
 *
 * `DEFAULTS` is the shipped behaviour. A sparse override blob in KV under
 * `config:overrides` carries only the keys a user has actually changed, so a
 * tuned default in a later release still reaches anyone who never overrode it,
 * and a per-key reset is a `delete` rather than a rewrite.
 *
 * Reads are per-request and uncached on purpose. Recall already makes an
 * embedding call and several D1 queries, so one KV read is noise; a
 * version-counter cache would leave a window where a stale isolate serves the
 * previous value after a save, which presents to the user as a control that
 * does nothing.
 */
import type { Env } from "./env";
import { EMBEDDING_PROFILE } from "./embedding/profile";

// Prefixed to coexist with workers-oauth-provider's token:/grant:/client: keys
// and the integrations: blobs in the same namespace.
export const CONFIG_KEY = "config:overrides";

export const DEFAULTS = {
  // ── Ranking (src/recall/math.ts) ──
  RECENCY_FLOOR: 0.6,
  RECENCY_FLOOR_DURABLE: 0.9,
  RECENCY_FLOOR_VOLATILE: 0.15,
  MMR_LAMBDA: 0.7,

  // ── Duplicate detection (src/capture/duplicate.ts) ──
  DUPLICATE_BLOCK_THRESHOLD: 0.98,
  DUPLICATE_FLAG_THRESHOLD: 0.80,

  // ── Recall widening (src/recall/search.ts) ──
  RECALL_WIDEN_THRESHOLD: 0.60,

  // ── Keyword arm (src/recall/search.ts) ──
  KEYWORD_CANDIDATE_LIMIT: 128,
  SUBSTRING_MATCH_WEIGHT: 0.25,

  // ── Cross-encoder reranker (src/recall/model-reranker.ts) ──
  // "off" never calls the model; "on" reranks every eligible recall; "auto"
  // reranks only when the top two heuristic scores are close. Any mode also
  // needs the readiness latch the model probe writes, so an unverified model
  // never runs. A model failure always falls back to the un-reranked order.
  RERANK_MODE: "auto",

  // ── Graph expansion (src/graph/traverse.ts) ──
  // Hard cap on traversal depth. Deliberately not surfaced as a user control
  // (#246) — it bounds fanout, it is not a preference.
  GRAPH_MAX_HOPS: 3,
  GRAPH_HOP_DECAY: 0.6,
  // Applied only when a caller does not supply `hops`. An explicit value from
  // an MCP client or API caller always wins, including an explicit 0.
  DEFAULT_HOPS: 0,

  // ── Output budgeting (src/recall/snippet.ts) ──
  RECALL_OUTPUT_BUDGET: 12000,
  SNIPPET_MAX_CHARS: 400,
  FULL_MATCH_MAX_CHARS: 4000,
  RECALL_FULL_MATCHES: 2,
  STRONG_MATCH_RATIO: 0.75,

  // ── Compression eligibility (src/compression/eligibility.ts) ──
  COMPRESSION_IMPORTANCE_THRESHOLD: 4,
  COMPRESSION_MIN_RECALL: 2,
  COMPRESSION_MIN_AGE_MS: 60 * 86400000,

  // ── Source trust in retrieval (src/recall/source-trust.ts, Track 3) ──
  // All five start at their neutral / off value: source weighting, the
  // mirror/transcript occupancy cap and the near-duplicate collapse ship
  // lock-neutral, so every intermediate commit changes no ranking. A later
  // tuning task flips these once the eval sets their final values (P1).
  SOURCE_WEIGHT_MIRROR: 1.0,
  SOURCE_WEIGHT_TRANSCRIPT: 1.0,
  SOURCE_WEIGHT_SYSTEM: 1.0,
  MIRROR_MAX_SHARE: 1.0,
  NOTICE_COLLAPSE: "off",

  // ── Self-protecting quarantine (src/quarantine/score.ts, Track 4) ──
  // A write scoring at or above the threshold is held out of recall.
  // Nothing computes a score yet in this commit, so the default is inert;
  // 100 disables holds outright once scoring lands, but is not the default.
  QUARANTINE_THRESHOLD: 1.0,
  // MCP content writes by one actor inside a 10-minute window before a burst hold fires.
  QUARANTINE_WRITE_BURST: 40,
  // Status changes by one actor inside a 10-minute window before the brief groups them.
  QUARANTINE_STATUS_BURST: 10,

  // ── Capture tuning (src/constants.ts) ──
  TAG_BOOST_STEP: 0.15,
  TAG_BOOST_MAX: 1.5,
  CONTRADICTION_IMPORTANCE_STEP: 1.0,

  // Re-check age by volatility (spec 14 5.8, T-0089.2.3): a state fact goes untouched for
  // 90 days before the nightly pass asks again, a volatile one for 14. Durable never re-checks.
  STALE_AFTER_DAYS_VOLATILE: 14,
  STALE_AFTER_DAYS_STATE: 90,

  // A mild score demotion for a stale:as-of row under a "current" query intent (spec 14 5.8/B6).
  // 1.0 (off) until the as-of eval gate passes on knowledge-update:ku-silent with no regression on
  // ku-silent-true/ku-silent-fresh (director, 2026-09-27); the real value is 0.9.
  STALE_PENALTY: 1.0,

  // ── Models (src/lib/ai.ts) ──
  LLM_MODEL: "@cf/meta/llama-4-scout-17b-16e-instruct",
  EMBEDDING_MODEL: "@cf/google/embeddinggemma-300m",
  // Used only by src/insight/reason.ts's pair-reasoning call — everything
  // else above keeps using LLM_MODEL. See the cost comment on
  // constants.INSIGHT_LLM_MODEL for why this is a separate setting.
  INSIGHT_LLM_MODEL: "@cf/openai/gpt-oss-120b",
  // Used only by src/when/pass.ts's nightly commitment-extraction call.
  // Defaults to the same model as INSIGHT_LLM_MODEL — a smaller model's
  // judgment on "is this a commitment, and when is it due" was not measured
  // to be reliably worse, but nothing here has re-litigated it either, so
  // this stays a separate, independently overridable setting rather than
  // aliasing INSIGHT_LLM_MODEL outright.
  WHEN_LLM_MODEL: "@cf/openai/gpt-oss-120b",

  // ── Team edition (src/lib/scope.ts) ──
  // Where a capture lands when neither the request nor the member's own
  // override says. Org-level policy, set by an admin via PATCH /config;
  // per-member overrides live on users.default_share and win over this.
  TEAM_DEFAULT_WORKSPACE: "personal",

  // Whether the weekly reasoning pass also runs over the company workspaces,
  // on its own schedule and its own budget. "off" by default: this pass reads
  // the whole team's shared memory and writes into every member's review
  // queue, so it is opted into rather than out of — and a default-on flag
  // would start spending model calls on every existing team brain the day
  // this deploys.
  TEAM_INSIGHTS: "off",

  // Whether this brain is a team at all: "auto" | "on" | "off". Read in exactly
  // one place — isTeamBrain() in src/lib/team-admin.ts, which GET /health
  // publishes as `team` — so no other caller has to know the key exists.
  //
  //   "auto" infers from active membership (more than one non-tombstoned user),
  //   "on"   is a team before anyone is invited, which inference cannot express,
  //   "off"  is solo, and only takes effect while the owner really is alone —
  //          real membership is a FLOOR on it, so a brain that acquires
  //          colleagues while this says "off" is still a team. Two mechanisms
  //          hold that: the floor in isTeamBrain() enforces it, and PATCH
  //          /config refuses the write outright while more than one person is
  //          on the team (src/routes/config.ts).
  //
  // The default is "auto" and that is NOT a cosmetic choice. DEFAULTS is static
  // and reaches every brain that never overrode the key, so a default of "off"
  // would turn every existing team brain solo on upgrade — the sharing controls
  // would vanish from the dashboard while the shared workspace and everyone's
  // access to it stayed exactly where they were. "auto" is today's behaviour
  // spelled out, so upgrading changes nothing for anybody.
  TEAM_MODE: "auto",

  // ── Time anchoring (src/when/timezone.ts) ──
  // IANA zone name a date-only `when` (a bare "2026-06-15", the regex pass's
  // extracted dates, the model pass's due_at) anchors midnight in — and an
  // offsetless datetime anchors its wall-clock time in, superseding the
  // earlier "always UTC" rule. "UTC" by construction: a brain that never sets
  // this keeps today's behaviour exactly. Validated against Intl.DateTimeFormat
  // when set (src/config.ts's coerce/validateStrict), not just any non-empty
  // string — an unrecognized zone name would silently anchor every future due
  // date at the wrong instant instead of failing the write that set it.
  TIMEZONE: "UTC",

  // ── Web Push (src/push/vapid.ts) ──
  // VAPID JWT contact: a mailto:<address> or an https: URL, RFC 8292's own
  // two accepted shapes. Empty by default — a brain that never sets this
  // falls back to the origin recorded the first time POST /push/subscribe
  // saw a real Request, which is enough for every push service tested
  // (FCM, Apple) to accept the JWT. Set this to give subscribers a real
  // contact, not to work around a rejection: an EMPTY default, not a fixed
  // placeholder string, is what this key protects — see the comment on the
  // .local placeholder this replaced in src/push/vapid.ts.
  PUSH_CONTACT: "",

  // ── Sampled recall log (src/recall/log.ts, T-0089.5.2) ──
  // Off by default everywhere (D5.2): the log holds the user's own query text, so it is
  // opt-in rather than opt-out. Consequences of leaving it off: Part B's implicit feedback
  // never accrues, and T-0043's golden set can only harvest from a brain that turned it on.
  RECALL_LOG: "off",

  // ── Content versions and trash (src/memory/versions.ts, src/memory/trash.ts) ──
  // Prior states kept per memory, newest first. The oldest fall off as new ones arrive.
  VERSION_KEEP: 20,
  // Days a forgotten memory waits in the trash before it is purged for good.
  TRASH_RETENTION_DAYS: 14,

  // ── Standing memory (src/standing/*, Track 7, T-0089.7.1) ──
  // Eval-tuned firing threshold (the committed standing eval report, Task 2's chosen value
  // for the raw-input curve — see SYNTHETIC-CORPORA.md). Not a fixed constant: a future
  // re-run of the eval retunes this without a code change.
  STANDING_THRESHOLD: 0.67,
  // Capacity, not a fixed cap: how many standing memories one workspace may hold at once
  // (Design 2.1 "the cap", 2.4's oldest-first cache build).
  STANDING_MAX: 50,
  // Dimension of DEFAULTS.EMBEDDING_MODEL's vectors (bge-small-en-v1.5). Threaded explicitly
  // into the standing cache codec/build rather than hard-coded there, so a future embedding
  // model change updates both together.
  EMBEDDING_DIM: EMBEDDING_PROFILE.dimensions,

  // ── Decision ledger (src/decisions/*, Track 7, T-0089.7.2) ──
  // D7.3: a decision's review date when neither review_by nor when is given.
  DECISION_REVIEW_DEFAULT_DAYS: 90,
  CALIBRATION_MIN_N: 10,
  CALIBRATION_MIN_BUCKET_N: 5,
  CALIBRATION_MIN_TOPIC_N: 5,
} as const;

// DEFAULTS is `as const` so the shipped values are pinned and a typo shows up
// as a type error. Config must widen those literals back to number/string,
// though — without this, `Partial<Config>` would only accept the exact default
// value and reject every real override.
type Widen<T> = T extends number ? number : T extends string ? string : T;

export type Config = { -readonly [K in keyof typeof DEFAULTS]: Widen<(typeof DEFAULTS)[K]> };
export type ConfigKey = keyof Config;

type Rule =
  | { kind: "number"; min: number; max: number; integer?: boolean }
  | { kind: "string" }
  | { kind: "fixed"; value: string };

/**
 * Accepted shape and range per key. Enforced at resolve time rather than only
 * at write, because values also arrive from hand-edited KV, from blobs written
 * by an older release, and from ranges tightened in a later one.
 */
export const RULES: Record<ConfigKey, Rule> = {
  RECENCY_FLOOR: { kind: "number", min: 0, max: 1 },
  RECENCY_FLOOR_DURABLE: { kind: "number", min: 0, max: 1 },
  RECENCY_FLOOR_VOLATILE: { kind: "number", min: 0, max: 1 },
  MMR_LAMBDA: { kind: "number", min: 0, max: 1 },

  DUPLICATE_BLOCK_THRESHOLD: { kind: "number", min: 0, max: 1 },
  DUPLICATE_FLAG_THRESHOLD: { kind: "number", min: 0, max: 1 },
  RECALL_WIDEN_THRESHOLD: { kind: "number", min: 0, max: 1 },

  // Floor of 50 keeps the keyword arm alive; the 2000 cap bounds the newest-
  // first scan and the per-request rows shipped out of D1.
  KEYWORD_CANDIDATE_LIMIT: { kind: "number", min: 50, max: 2000, integer: true },
  SUBSTRING_MATCH_WEIGHT: { kind: "number", min: 0, max: 1 },

  // Hops above 3 explode the fanout without improving results; traverse.ts is
  // written against this ceiling.
  GRAPH_MAX_HOPS: { kind: "number", min: 0, max: 3, integer: true },
  GRAPH_HOP_DECAY: { kind: "number", min: 0, max: 1 },
  DEFAULT_HOPS: { kind: "number", min: 0, max: 3, integer: true },

  RECALL_OUTPUT_BUDGET: { kind: "number", min: 1000, max: 100000, integer: true },
  SNIPPET_MAX_CHARS: { kind: "number", min: 100, max: 4000, integer: true },
  FULL_MATCH_MAX_CHARS: { kind: "number", min: 500, max: 20000, integer: true },
  RECALL_FULL_MATCHES: { kind: "number", min: 0, max: 10, integer: true },
  STRONG_MATCH_RATIO: { kind: "number", min: 0, max: 1 },

  // Importance is a 1–5 band; a threshold outside it protects everything or
  // nothing.
  COMPRESSION_IMPORTANCE_THRESHOLD: { kind: "number", min: 1, max: 5, integer: true },
  COMPRESSION_MIN_RECALL: { kind: "number", min: 0, max: 100, integer: true },
  COMPRESSION_MIN_AGE_MS: { kind: "number", min: 0, max: 10 * 365 * 86400000, integer: true },

  SOURCE_WEIGHT_MIRROR: { kind: "number", min: 0.5, max: 1.0 },
  SOURCE_WEIGHT_TRANSCRIPT: { kind: "number", min: 0.5, max: 1.0 },
  SOURCE_WEIGHT_SYSTEM: { kind: "number", min: 0.5, max: 1.0 },
  MIRROR_MAX_SHARE: { kind: "number", min: 0.1, max: 1.0 },
  NOTICE_COLLAPSE: { kind: "string" },

  QUARANTINE_THRESHOLD: { kind: "number", min: 0.5, max: 100 },
  QUARANTINE_WRITE_BURST: { kind: "number", min: 5, max: 1000, integer: true },
  QUARANTINE_STATUS_BURST: { kind: "number", min: 3, max: 1000, integer: true },

  TAG_BOOST_STEP: { kind: "number", min: 0, max: 1 },
  TAG_BOOST_MAX: { kind: "number", min: 1, max: 5 },
  CONTRADICTION_IMPORTANCE_STEP: { kind: "number", min: 0, max: 5 },
  STALE_AFTER_DAYS_VOLATILE: { kind: "number", min: 1, max: 365, integer: true },
  STALE_AFTER_DAYS_STATE: { kind: "number", min: 7, max: 730, integer: true },
  STALE_PENALTY: { kind: "number", min: 0.5, max: 1.0 },

  RERANK_MODE: { kind: "string" },

  LLM_MODEL: { kind: "string" },
  // Model, dimensions and prompt version are one immutable vector profile in
  // this fork. Keeping the key in Config preserves upstream call signatures,
  // while the fixed rule prevents a model-only override from taking capture
  // and recall down or producing incomparable vectors.
  EMBEDDING_MODEL: { kind: "fixed", value: DEFAULTS.EMBEDDING_MODEL },
  INSIGHT_LLM_MODEL: { kind: "string" },
  WHEN_LLM_MODEL: { kind: "string" },
  TEAM_DEFAULT_WORKSPACE: { kind: "string" },
  TEAM_INSIGHTS: { kind: "string" },
  TEAM_MODE: { kind: "string" },
  TIMEZONE: { kind: "string" },
  PUSH_CONTACT: { kind: "string" },
  RECALL_LOG: { kind: "string" },
  VERSION_KEEP: { kind: "number", min: 5, max: 500, integer: true },
  TRASH_RETENTION_DAYS: { kind: "number", min: 1, max: 365, integer: true },

  STANDING_THRESHOLD: { kind: "number", min: 0.5, max: 0.95 },
  STANDING_MAX: { kind: "number", min: 1, max: 100, integer: true },
  EMBEDDING_DIM: { kind: "number", min: 1, max: 4096, integer: true },

  DECISION_REVIEW_DEFAULT_DAYS: { kind: "number", min: 7, max: 730, integer: true },
  CALIBRATION_MIN_N: { kind: "number", min: 5, max: 100, integer: true },
  CALIBRATION_MIN_BUCKET_N: { kind: "number", min: 3, max: 50, integer: true },
  CALIBRATION_MIN_TOPIC_N: { kind: "number", min: 3, max: 50, integer: true },
};

/**
 * The only cheap probe available — there is no static IANA zone list to check
 * against, and Intl.DateTimeFormat throws RangeError for a name it does not
 * recognize. Special-cased on the key rather than a new Rule kind: every
 * other consumer of RULES/coerce/validateStrict treats "string" generically,
 * and TIMEZONE is the one string setting where "non-empty" is not "valid".
 */
function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const RERANK_MODES = ["off", "on", "auto"] as const;
export type RerankMode = (typeof RERANK_MODES)[number];
export const isRerankMode = (value: unknown): value is RerankMode => (RERANK_MODES as readonly unknown[]).includes(value);

export const NOTICE_COLLAPSE_MODES = ["off", "on"] as const;
export type NoticeCollapseMode = (typeof NOTICE_COLLAPSE_MODES)[number];
export const isNoticeCollapseMode = (value: unknown): value is NoticeCollapseMode =>
  (NOTICE_COLLAPSE_MODES as readonly unknown[]).includes(value);

export const RECALL_LOG_MODES = ["off", "on"] as const;
export type RecallLogMode = (typeof RECALL_LOG_MODES)[number];
export const isRecallLogMode = (value: unknown): value is RecallLogMode =>
  (RECALL_LOG_MODES as readonly unknown[]).includes(value);

/** RFC 8292 section 2's two accepted VAPID `sub` shapes. */
function isValidPushContact(value: string): boolean {
  return /^mailto:[^@\s]+@[^@\s]+$/.test(value) || /^https:\/\/\S+$/.test(value);
}

/**
 * Groups that must stay internally ordered. A violation is not clamped
 * key-by-key — that could satisfy the letter of the range while still leaving
 * the group inverted — so the whole group falls back to its defaults, which
 * satisfy the invariant by construction.
 */
const INVARIANTS: { keys: ConfigKey[]; holds: (c: Config) => boolean; describe: string }[] = [
  {
    keys: ["DUPLICATE_BLOCK_THRESHOLD", "DUPLICATE_FLAG_THRESHOLD"],
    holds: c => c.DUPLICATE_BLOCK_THRESHOLD > c.DUPLICATE_FLAG_THRESHOLD,
    describe: "DUPLICATE_BLOCK_THRESHOLD must exceed DUPLICATE_FLAG_THRESHOLD, or flagging is unreachable",
  },
  {
    keys: ["RECENCY_FLOOR_VOLATILE", "RECENCY_FLOOR", "RECENCY_FLOOR_DURABLE"],
    holds: c => c.RECENCY_FLOOR_VOLATILE <= c.RECENCY_FLOOR && c.RECENCY_FLOOR <= c.RECENCY_FLOOR_DURABLE,
    describe: "RECENCY_FLOOR_VOLATILE <= RECENCY_FLOOR <= RECENCY_FLOOR_DURABLE, or durability tiering inverts",
  },
];

/**
 * Coerces one stored value against its rule. Returns the default when the
 * value is unsalvageable (wrong type, non-finite); clamps when it is merely
 * out of range.
 */
export function coerce(key: ConfigKey, value: unknown): { value: Config[ConfigKey]; note?: string } {
  const rule = RULES[key];
  const fallback = DEFAULTS[key] as Config[ConfigKey];

  if (rule.kind === "fixed") {
    return value === rule.value
      ? { value: rule.value as Config[ConfigKey] }
      : { value: fallback, note: `${key}: fixed by the active embedding profile` };
  }

  if (rule.kind === "string") {
    // PUSH_CONTACT is the one string setting where EMPTY is the valid,
    // meaningful default (see src/push/vapid.ts) rather than "unsalvageable" —
    // every other string key requires non-empty, checked below.
    if (key === "PUSH_CONTACT") {
      if (value === "") return { value: "" as Config[ConfigKey] };
      if (typeof value !== "string" || !isValidPushContact(value)) {
        return { value: fallback, note: `${key}: expected empty, a mailto:<address>, or an https:// URL, got ${JSON.stringify(value)}` };
      }
      return { value: value as Config[ConfigKey] };
    }
    // A closed enum: an unknown stored value reads as "off" (never the model), not as the default.
    if (key === "RERANK_MODE" && !isRerankMode(value)) {
      return { value: "off" as Config[ConfigKey], note: `${key}: expected off, on or auto, got ${JSON.stringify(value)}; reranking stays off` };
    }
    // A closed enum: an unknown stored value reads as "off" (the collapse stays off), not as the default.
    if (key === "NOTICE_COLLAPSE" && !isNoticeCollapseMode(value)) {
      return { value: "off" as Config[ConfigKey], note: `${key}: expected off or on, got ${JSON.stringify(value)}; the collapse stays off` };
    }
    // A closed enum: an unknown stored value reads as "off" (the log stays off, D5.2's opt-in default), not as the default key's own value — which happens to also be "off" today, but this must not depend on that coincidence.
    if (key === "RECALL_LOG" && !isRecallLogMode(value)) {
      return { value: "off" as Config[ConfigKey], note: `${key}: expected off or on, got ${JSON.stringify(value)}; the log stays off` };
    }
    if (typeof value !== "string" || value.trim() === "") {
      return { value: fallback, note: `${key}: expected a non-empty string, got ${typeof value}` };
    }
    if (key === "TIMEZONE" && !isValidTimeZone(value)) {
      return { value: fallback, note: `${key}: "${value}" is not a recognized IANA timezone` };
    }
    return { value: value as Config[ConfigKey] };
  }

  // typeof NaN and typeof Infinity are both "number", so the finite check is
  // what actually protects arithmetic downstream.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { value: fallback, note: `${key}: expected a finite number, got ${JSON.stringify(value)}` };
  }

  let n = value;
  if (rule.integer) n = Math.round(n);
  const clamped = Math.min(rule.max, Math.max(rule.min, n));
  const note = clamped !== n ? `${key}: ${n} clamped to ${clamped} (range ${rule.min}–${rule.max})` : undefined;
  return { value: clamped as Config[ConfigKey], note };
}

export const INVARIANT_RULES = INVARIANTS;

/**
 * Reads the sparse override blob and merges it over the defaults.
 *
 * Every failure mode here degrades to the shipped defaults rather than
 * throwing: a KV outage, a hand-edited blob, or a payload written by a future
 * version must never be able to take recall down.
 */
export async function resolveConfig(env: Env): Promise<Readonly<Config>> {
  const resolved: Config = { ...DEFAULTS };

  let stored: unknown;
  try {
    const raw = await env.OAUTH_KV.get(CONFIG_KEY);
    if (!raw) return Object.freeze(resolved);
    stored = JSON.parse(raw);
  } catch {
    // KV unreachable or the blob is unparseable — ship the defaults.
    return Object.freeze(resolved);
  }

  if (!isRecord(stored)) return Object.freeze(resolved);

  const notes: string[] = [];

  for (const [key, value] of Object.entries(stored)) {
    // Unknown keys are ignored rather than carried through: they may be a
    // setting removed in a later release, or a typo in a hand-edited blob.
    if (!(key in DEFAULTS)) continue;
    const { value: safe, note } = coerce(key as ConfigKey, value);
    (resolved as Record<string, unknown>)[key] = safe;
    if (note) notes.push(note);
  }

  for (const invariant of INVARIANTS) {
    if (invariant.holds(resolved)) continue;
    for (const key of invariant.keys) {
      (resolved as Record<string, unknown>)[key] = DEFAULTS[key];
    }
    notes.push(`invariant violated, group reset to defaults — ${invariant.describe}`);
  }

  if (notes.length) console.warn(`[config] ${notes.join("; ")}`);

  return Object.freeze(resolved);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Write path ───────────────────────────────────────────────────────────────
//
// Deliberately stricter than resolve. A bad value arriving from KV is repaired,
// because recall must not fail on it. A bad value arriving from a caller is
// rejected with a message naming the conflict, so the settings UI can explain
// what happened rather than appear to accept a change and silently discard it.

export type WriteResult = { ok: true } | { ok: false; error: string };

/** Reads the raw sparse blob. Any failure reads as "no overrides". */
export async function readOverrides(env: Env): Promise<Partial<Config>> {
  try {
    const raw = await env.OAUTH_KV.get(CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in DEFAULTS)) continue;
      const rule = RULES[k as ConfigKey];
      // A stale model-only override is not an active override. Omitting it here
      // also means the next valid PATCH naturally cleans the old blob up.
      if (rule.kind === "fixed" && v !== rule.value) continue;
      out[k] = v;
    }
    return out as Partial<Config>;
  } catch {
    return {};
  }
}

/** Strict per-key check. Returns an error message, or null when acceptable. */
function validateStrict(key: string, value: unknown): string | null {
  if (!(key in DEFAULTS)) return `${key} is not a known setting`;
  const rule = RULES[key as ConfigKey];

  if (rule.kind === "fixed") {
    return value === rule.value
      ? null
      : `${key} is fixed by the active embedding profile`;
  }

  if (rule.kind === "string") {
    if (key === "PUSH_CONTACT") {
      if (value === "") return null;
      return typeof value === "string" && isValidPushContact(value)
        ? null
        : `${key} must be empty, a mailto:<address>, or an https:// URL`;
    }
    if (key === "RERANK_MODE") return isRerankMode(value) ? null : `${key} must be one of ${RERANK_MODES.join(", ")}`;
    if (key === "NOTICE_COLLAPSE") return isNoticeCollapseMode(value) ? null : `${key} must be one of ${NOTICE_COLLAPSE_MODES.join(", ")}`;
    if (typeof value !== "string" || value.trim() === "") return `${key} must be a non-empty string`;
    if (key === "TIMEZONE" && !isValidTimeZone(value)) {
      return `${key} must be a recognized IANA timezone name (e.g. "America/New_York")`;
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${key} must be a finite number`;
  }
  if (rule.integer && !Number.isInteger(value)) {
    return `${key} must be a whole number`;
  }
  if (value < rule.min || value > rule.max) {
    return `${key} must be between ${rule.min} and ${rule.max} (got ${value})`;
  }
  return null;
}

/**
 * Merges a patch into the stored overrides. Rejects the whole patch if any key
 * is unknown, malformed, or would invert an invariant once merged with what is
 * already stored — a value can be individually valid and still break the pair.
 */
export async function writeOverrides(env: Env, patch: Partial<Config>): Promise<WriteResult> {
  for (const [key, value] of Object.entries(patch)) {
    const error = validateStrict(key, value);
    if (error) return { ok: false, error };
  }

  const merged = { ...(await readOverrides(env)), ...patch } as Record<string, unknown>;
  const effective = { ...DEFAULTS, ...merged } as Config;

  for (const invariant of INVARIANTS) {
    if (!invariant.holds(effective)) return { ok: false, error: invariant.describe };
  }

  // Values equal to the shipped default are dropped rather than stored. Storing
  // them would pin the user to today's number and stop a retuned default in a
  // later release from ever reaching them.
  const sparse: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== DEFAULTS[key as ConfigKey]) sparse[key] = value;
  }

  await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify(sparse));
  return { ok: true };
}

/**
 * Per-setting reset. A delete rather than a write-back of the default, so the
 * user rejoins the shipped value and picks up any future retune of it.
 */
export async function resetOverride(env: Env, key: ConfigKey): Promise<void> {
  const overrides = { ...(await readOverrides(env)) } as Record<string, unknown>;
  if (!(key in overrides)) return;
  delete overrides[key];
  await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify(overrides));
}
