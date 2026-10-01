import { describe, it, expect } from "vitest";
import { compressionEligibilitySql, COMPRESSION_MIN_RECALL, isReservedTag, isTopicTag, isTopicTagSql, isCompressionTag, isCompressionTagSql } from "../../src/compression/eligibility";
import { STATUS_PREFIX } from "../../src/memory/status";
import { KIND_PREFIX } from "../../src/memory/kind";
import { VOLATILITY_PREFIX } from "../../src/memory/volatility";
import { STALE_AS_OF } from "../../src/memory/stale";
import { CAPSULE_SLOT_TAG_PREFIX, CAPSULE_TAG_PREFIX, PROJECT_TAG_PREFIX } from "../../src/tags/system";
import { OWED_TO_ME_TAG, STANDING_TAG, T7_TAG_PREFIXES } from "../../src/tags/t7";

describe("compressionEligibilitySql", () => {
  it("includes the importance, recall+age, and contradiction-win clauses", () => {
    const sql = compressionEligibilitySql();
    expect(sql).toContain("importance_score < 4");
    expect(sql).toContain(`recall_count < ${COMPRESSION_MIN_RECALL}`);
    expect(sql).toContain("recall_count = 0");
    expect(sql).toContain("contradiction_wins");
    expect(sql).toContain("created_at < ?");
  });

  it("contains exactly one bind placeholder (the age cutoff)", () => {
    expect(compressionEligibilitySql().match(/\?/g)?.length).toBe(1);
  });

  it("applies a column prefix to every column when given one", () => {
    const sql = compressionEligibilitySql("entries.");
    expect(sql).toContain("entries.importance_score");
    expect(sql).toContain("entries.recall_count");
    expect(sql).toContain("entries.contradiction_wins");
    expect(sql).toContain("entries.created_at < ?");
    for (const col of ["importance_score", "recall_count", "created_at", "contradiction_wins"]) {
      expect(sql).not.toMatch(new RegExp(`(^|[^.])\\b${col}\\b`));
    }
  });

  it("defaults to no prefix", () => {
    const sql = compressionEligibilitySql();
    expect(sql).not.toContain("entries.");
  });

  // A standing instruction rolled into a digest would stop firing (its own row is gone,
  // folded into the digest's synthesized text) with nothing to say why — a silent loss the
  // per-row eligibility check must refuse before importance/recall/age ever gets a say.
  it("excludes standing:active rows from compression eligibility", () => {
    expect(compressionEligibilitySql()).toContain(`tags NOT LIKE '%"${STANDING_TAG}"%'`);
  });

  it("prefixes the standing exclusion's tags column too", () => {
    const sql = compressionEligibilitySql("entries.");
    expect(sql).toContain(`entries.tags NOT LIKE '%"${STANDING_TAG}"%'`);
  });
});

// The TS predicate and the SQL fragment are two encodings of one rule, and only the TS one
// is reachable from the D1 mock — so a rule that exists in isTopicTag but not in
// isTopicTagSql would pass every mock-based test while production kept the old behaviour.
// These bind both encodings to the same constants.
describe("reserved tags", () => {
  const RESERVED = [
    `${STATUS_PREFIX}canonical`,
    `${KIND_PREFIX}semantic`,
    `${VOLATILITY_PREFIX}state`,
    `${CAPSULE_TAG_PREFIX}core`,
    `${CAPSULE_SLOT_TAG_PREFIX}current-state`,
    `${PROJECT_TAG_PREFIX}website`,
    STALE_AS_OF,
  ];

  it("rejects every reserved namespace", () => {
    for (const tag of RESERVED) {
      expect(isReservedTag(tag)).toBe(true);
      expect(isTopicTag(tag)).toBe(false);
    }
  });

  it("excludes every reserved namespace from the SQL too", () => {
    const sql = isTopicTagSql();
    for (const prefix of [
      STATUS_PREFIX,
      KIND_PREFIX,
      VOLATILITY_PREFIX,
      CAPSULE_TAG_PREFIX,
      CAPSULE_SLOT_TAG_PREFIX,
      PROJECT_TAG_PREFIX,
    ]) {
      expect(sql).toContain(`value NOT LIKE '${prefix}%'`);
    }
    expect(sql).toContain(`value NOT LIKE '${STALE_AS_OF}'`);
  });

  // Reserving is case-INsensitive on both sides, and the asymmetry is the reason: a
  // mixed-case reserved tag that reaches compressTag is matched against sources with
  // `tags LIKE`, which ignores case, so it rolls up every entry carrying the lowercase
  // system tag. Over-reserving costs one un-digested tag; under-reserving costs memories.
  // GLOB or `<>` here would be case-sensitive and let those tags through.
  it("reserves the namespace whatever its case", () => {
    expect(isTopicTagSql()).not.toContain("GLOB");
    expect(isTopicTagSql()).not.toContain("<>");
    for (const tag of [
      "Status:Active",
      "Kind:Personal",
      "Volatility:High",
      "Capsule:Core",
      "Capsule-Slot:Current-State",
      "Stale:As-Of",
      "STALE:AS-OF",
    ]) {
      expect(isReservedTag(tag)).toBe(true);
      expect(isTopicTag(tag)).toBe(false);
    }
  });

  it("treats bookkeeping tags as non-topics whatever their case", () => {
    for (const tag of ["SYNTHESIZED", "Duplicate-Candidate", "Rolled-Up", "Contradiction-Resolved"]) {
      expect(isTopicTag(tag)).toBe(false);
    }
    expect(isTopicTagSql()).toContain("lower(value) NOT IN");
  });

  // The SQL now matches these with LIKE, where % and _ are wildcards. No constant contains
  // one today; this keeps it that way, because a stray _ would silently widen the match.
  it("keeps every constant free of LIKE metacharacters", () => {
    const sql = isTopicTagSql();
    const literals = [...sql.matchAll(/'([^']*)'/g)].map(m => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(literal.replace(/%$/, "")).not.toMatch(/[%_]/);
      expect(literal).toBe(literal.toLowerCase());
    }
  });

  it("treats compression bookkeeping tags as non-topics without calling them reserved", () => {
    for (const tag of ["synthesized", "auto-pattern", "duplicate-candidate", "contradiction-resolved", "rolled-up"]) {
      expect(isTopicTag(tag)).toBe(false);
      expect(isReservedTag(tag)).toBe(false); // compressTag's guard is about namespaces only
      expect(isTopicTagSql()).toContain(`'${tag}'`);
    }
  });

  it("reserves the namespace, not the bare word", () => {
    for (const tag of ["volatility", "stale", "status", "kind", "capsule", "capsule-slot", "project", "project-atlas", "work"]) {
      expect(isTopicTag(tag)).toBe(true); // a user may legitimately tag something "stale"
    }
  });

  it("汎用分類タグは保存用に残し、大文字小文字を問わず要約の話題から外す", () => {
    for (const tag of ["personal", "work", "task", "idea", "context", "codex-response"]) {
      expect(isReservedTag(tag)).toBe(false);
      expect(isTopicTag(tag)).toBe(true);
      expect(isCompressionTag(tag)).toBe(false);
      expect(isCompressionTag(tag.toUpperCase())).toBe(false);
      expect(isCompressionTagSql()).toContain(`'${tag}'`);
    }
    for (const tag of ["work-notes", "task-runner", "personal-website", "context-menu", "project-atlas"]) {
      expect(isCompressionTag(tag)).toBe(true);
    }
  });

  it("applies to whatever column it is given", () => {
    expect(isTopicTagSql("entries.tag")).toContain(`entries.tag NOT LIKE '${VOLATILITY_PREFIX}%'`);
    expect(isTopicTagSql()).not.toContain("?"); // no placeholders — safe to inline anywhere
  });
});

// Track 7 (standing memory, decision ledger, commitments): none of these
// namespaces may ever take a digest's tag slot, and the bare words "decision"
// and "standing" stay ordinary topics (P7.2).
describe("Track 7 reserved tags are never digest topics", () => {
  it("rejects every T7 prefix", () => {
    for (const prefix of T7_TAG_PREFIXES) {
      const tag = `${prefix}sample`;
      expect(isReservedTag(tag), tag).toBe(true);
      expect(isTopicTag(tag), tag).toBe(false);
    }
  });

  it("rejects the bare owed-to-me marker without calling it reserved", () => {
    expect(isTopicTag(OWED_TO_ME_TAG)).toBe(false);
    expect(isReservedTag(OWED_TO_ME_TAG)).toBe(false);
    expect(isTopicTagSql()).toContain(`'${OWED_TO_ME_TAG}'`);
  });

  it("reserves the namespace, not the bare word", () => {
    expect(isTopicTag("decision")).toBe(true);
    expect(isTopicTag("standing")).toBe(true);
  });

  it("excludes every T7 prefix from the SQL too", () => {
    const sql = isTopicTagSql();
    for (const prefix of T7_TAG_PREFIXES) expect(sql).toContain(`NOT LIKE '${prefix}%'`);
  });
});
