// An entry is eligible for nightly digest compression only if it's low-importance,
// not proven-useful by recall, and not a contradiction survivor. Strictly more
// protective than the old `importance_score < 4` filter — it can only exempt MORE.
import { DEFAULTS, type Config } from "../config";
import { STATUS_PREFIX } from "../memory/status";
import { KIND_PREFIX } from "../memory/kind";
import { VOLATILITY_PREFIX } from "../memory/volatility";
import { STALE_AS_OF } from "../memory/stale";
import { RETRACTED_SOURCE_TAG } from "../tags/system";
import { CAPSULE_SLOT_TAG_PREFIX, CAPSULE_TAG_PREFIX, PROJECT_TAG_PREFIX } from "../tags/system";
import { QUARANTINE_TAG_PREFIX, EDITED_CANONICAL_TAG_PREFIX } from "../quarantine/tags";
import { T7_TAG_PREFIXES, OWED_TO_ME_TAG, STANDING_TAG } from "../tags/t7";

export const COMPRESSION_IMPORTANCE_THRESHOLD = 4;   // importance >= this → protected
export const COMPRESSION_MIN_RECALL = 2;             // recalled >= this many times → protected
export const COMPRESSION_MIN_AGE_MS = 60 * 86400000; // entries with fewer than COMPRESSION_MIN_RECALL recalls protected until this old (60 days)

/**
 * Tags the system writes ABOUT an entry, as opposed to tags describing what it is about.
 *
 * They are never digest candidates, and getting that wrong is not merely a wasted check:
 * a nightly run compresses at most COMPRESSION_MAX_TAGS_PER_RUN tags, chosen by descending
 * entry count, so a reserved tag in the candidate list takes a slot a real topic would have
 * had. These tags are applied in bulk — the staleness pass alone writes volatility: and
 * stale:as-of across up to 25 entries a night — so they outrank ordinary topics easily, and
 * the symptom is compression appearing to stop working with nothing in the logs to say why.
 *
 * Derived from the prefixes themselves so the SQL below, the guard in compressTag, and the
 * test double all agree by construction rather than by three copies staying in step.
 *
 * MATCHING IS CASE-INSENSITIVE, deliberately, and this is the dangerous half to get wrong.
 * compressTag selects the entries it will roll up with `tags LIKE '%"<tag>"%'`, and SQLite's
 * LIKE ignores ASCII case — so a candidate tag `Kind:Semantic` does not select the entries
 * carrying `Kind:Semantic`, it selects every entry carrying `kind:semantic` in any case.
 * Admitting one mixed-case reserved tag therefore does not cost a digest slot, it rolls up
 * whatever unrelated entries happen to share the lowercase system tag: content permanently
 * appended to, recall penalised, and the entries dropped from staleness, future compression
 * and /stats. Nothing lowercases the tags src/integrations/mirror.ts inserts, so this is
 * reachable, and it was reproduced: 9 entries tagged `holiday-plans` rolled up by a
 * candidate tag they never carried.
 *
 * The two directions are not symmetric. Wrongly reserving a user's `Status:Active` costs one
 * tag that never gets a digest. Wrongly admitting it costs up to 50 memories, irreversibly.
 */
export const RESERVED_TAG_PREFIXES = [
  STATUS_PREFIX,
  KIND_PREFIX,
  VOLATILITY_PREFIX,
  CAPSULE_TAG_PREFIX,
  CAPSULE_SLOT_TAG_PREFIX,
  // Membership, not a topic: project digests come from the registry, not tag frequency.
  PROJECT_TAG_PREFIX,
  QUARANTINE_TAG_PREFIX,
  EDITED_CANONICAL_TAG_PREFIX,
  ...T7_TAG_PREFIXES,
];
const RESERVED_TAGS = [STALE_AS_OF];

const NON_TOPIC_TAGS = [
  "synthesized", "auto-pattern", "auto-insight", "duplicate-candidate", "contradiction-resolved", "rolled-up", "user-edited", "conflict-held", OWED_TO_ME_TAG, RETRACTED_SOURCE_TAG,
];
// 汎用分類タグは検索に残し、案件をまとめるdigestの対象からだけ外す。
const GENERIC_CLASSIFICATION_TAGS = [
  "personal", "work", "task", "idea", "context", "codex-response",
];

export function isReservedTag(tag: string): boolean {
  const t = tag.toLowerCase();
  return RESERVED_TAG_PREFIXES.some(prefix => t.startsWith(prefix)) || RESERVED_TAGS.includes(t);
}

export function isTopicTag(tag: string): boolean {
  return !isReservedTag(tag) && !NON_TOPIC_TAGS.includes(tag.toLowerCase());
}

/**
 * SQL boolean fragment for isTopicTag, applied to a json_each() tag value. No placeholders.
 *
 * Every clause is case-insensitive, matching the predicate above: LIKE ignores ASCII case,
 * and the set membership is compared through lower(). The constants are all lowercase, and
 * none may contain a LIKE metacharacter (% or _) — LIKE would read it as a wildcard. That
 * is an invariant now, not an observation, and test/unit/compression-eligibility.test.ts
 * enforces it.
 *
 * Note lower() is ASCII-only in SQLite while JavaScript's toLowerCase is Unicode-aware, so
 * for a non-ASCII tag the predicate can reserve something the SQL admits. That direction is
 * harmless: the candidate query offers the tag, compressTag's backstop declines it, and the
 * cost is a spent slot rather than a wrong rollup.
 */
export function isTopicTagSql(column = "value"): string {
  return [
    `lower(${column}) NOT IN (${NON_TOPIC_TAGS.map(t => `'${t}'`).join(", ")})`,
    ...RESERVED_TAG_PREFIXES.map(prefix => `${column} NOT LIKE '${prefix}%'`),
    ...RESERVED_TAGS.map(t => `${column} NOT LIKE '${t}'`),
  ].join("\n      AND ");
}

/** 検索用の話題判定へ、要約に限った汎用タグ除外を追加する。 */
export function isCompressionTag(tag: string): boolean {
  return isTopicTag(tag) && !GENERIC_CLASSIFICATION_TAGS.includes(tag.toLowerCase());
}

/** 直接実行と候補SQLが同じ一覧・大文字小文字を無視する完全一致を使う。 */
export function isCompressionTagSql(column = "value"): string {
  return `${isTopicTagSql(column)}\n      AND lower(${column}) NOT IN (${GENERIC_CLASSIFICATION_TAGS.map(t => `'${t}'`).join(", ")})`;
}

// Returns a SQL boolean fragment for "this entry is eligible for compression".
// Contains exactly one `?` placeholder — bind `Date.now() - COMPRESSION_MIN_AGE_MS`.
// columnPrefix: "" for bare columns (compressTag), "entries." for json_each-joined queries.
//
// standing:active is excluded here, not just from the topic-tag candidate list above: a
// standing instruction that is low-importance and never recalled would otherwise be a
// perfectly ordinary rollup candidate under some OTHER topic tag it also carries, folding
// its own row into the digest's synthesized text and silently ending its firing (spec 15
// Track 7 lane D). isTopicTagSql alone only stops standing:active from being CHOSEN as the
// tag to compress; it says nothing about a standing row being SWEPT UP by a different one.
export function compressionEligibilitySql(
  columnPrefix = "",
  config: Readonly<Config> = DEFAULTS,
): string {
  const p = columnPrefix;
  return `(${p}importance_score IS NULL OR ${p}importance_score < ${config.COMPRESSION_IMPORTANCE_THRESHOLD})
      AND (${p}recall_count = 0 OR (${p}recall_count < ${config.COMPRESSION_MIN_RECALL} AND ${p}created_at < ?))
      AND (${p}contradiction_wins IS NULL OR ${p}contradiction_wins = 0)
      AND ${p}tags NOT LIKE '%"${STANDING_TAG}"%'`;
}
