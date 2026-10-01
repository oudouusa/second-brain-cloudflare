/**
 * Behaviour-preservation guard for #245.
 *
 * The config layer only stays honest if every DEFAULT equals the constant that
 * currently governs the same behaviour. A silent drift here changes recall or
 * capture for every user who never touched a setting — the exact failure this
 * refactor must not introduce. This test is the tripwire.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULTS, RULES } from "../../src/config";
import * as constants from "../../src/constants";
import { RECENCY_FLOOR, RECENCY_FLOOR_DURABLE, RECENCY_FLOOR_VOLATILE, MMR_LAMBDA } from "../../src/recall/math";
import { GRAPH_MAX_HOPS, GRAPH_HOP_DECAY } from "../../src/graph/traverse";
import {
  RECALL_OUTPUT_BUDGET,
  SNIPPET_MAX_CHARS,
  FULL_MATCH_MAX_CHARS,
  RECALL_FULL_MATCHES,
  STRONG_MATCH_RATIO,
} from "../../src/recall/snippet";
import {
  COMPRESSION_IMPORTANCE_THRESHOLD,
  COMPRESSION_MIN_RECALL,
  COMPRESSION_MIN_AGE_MS,
} from "../../src/compression/eligibility";

describe("DEFAULTS parity with shipped constants", () => {
  const cases: [string, unknown, unknown][] = [
    ["RECENCY_FLOOR", DEFAULTS.RECENCY_FLOOR, RECENCY_FLOOR],
    ["RECENCY_FLOOR_DURABLE", DEFAULTS.RECENCY_FLOOR_DURABLE, RECENCY_FLOOR_DURABLE],
    ["RECENCY_FLOOR_VOLATILE", DEFAULTS.RECENCY_FLOOR_VOLATILE, RECENCY_FLOOR_VOLATILE],
    ["MMR_LAMBDA", DEFAULTS.MMR_LAMBDA, MMR_LAMBDA],
    ["DUPLICATE_BLOCK_THRESHOLD", DEFAULTS.DUPLICATE_BLOCK_THRESHOLD, constants.DUPLICATE_BLOCK_THRESHOLD],
    ["DUPLICATE_FLAG_THRESHOLD", DEFAULTS.DUPLICATE_FLAG_THRESHOLD, constants.DUPLICATE_FLAG_THRESHOLD],
    ["RECALL_WIDEN_THRESHOLD", DEFAULTS.RECALL_WIDEN_THRESHOLD, constants.RECALL_WIDEN_THRESHOLD],
    ["GRAPH_MAX_HOPS", DEFAULTS.GRAPH_MAX_HOPS, GRAPH_MAX_HOPS],
    ["GRAPH_HOP_DECAY", DEFAULTS.GRAPH_HOP_DECAY, GRAPH_HOP_DECAY],
    ["RECALL_OUTPUT_BUDGET", DEFAULTS.RECALL_OUTPUT_BUDGET, RECALL_OUTPUT_BUDGET],
    ["SNIPPET_MAX_CHARS", DEFAULTS.SNIPPET_MAX_CHARS, SNIPPET_MAX_CHARS],
    ["FULL_MATCH_MAX_CHARS", DEFAULTS.FULL_MATCH_MAX_CHARS, FULL_MATCH_MAX_CHARS],
    ["RECALL_FULL_MATCHES", DEFAULTS.RECALL_FULL_MATCHES, RECALL_FULL_MATCHES],
    ["STRONG_MATCH_RATIO", DEFAULTS.STRONG_MATCH_RATIO, STRONG_MATCH_RATIO],
    ["COMPRESSION_IMPORTANCE_THRESHOLD", DEFAULTS.COMPRESSION_IMPORTANCE_THRESHOLD, COMPRESSION_IMPORTANCE_THRESHOLD],
    ["COMPRESSION_MIN_RECALL", DEFAULTS.COMPRESSION_MIN_RECALL, COMPRESSION_MIN_RECALL],
    ["COMPRESSION_MIN_AGE_MS", DEFAULTS.COMPRESSION_MIN_AGE_MS, COMPRESSION_MIN_AGE_MS],
    ["KEYWORD_CANDIDATE_LIMIT", DEFAULTS.KEYWORD_CANDIDATE_LIMIT, constants.KEYWORD_CANDIDATE_LIMIT],
    ["SUBSTRING_MATCH_WEIGHT", DEFAULTS.SUBSTRING_MATCH_WEIGHT, constants.SUBSTRING_MATCH_WEIGHT],
    ["TAG_BOOST_STEP", DEFAULTS.TAG_BOOST_STEP, constants.TAG_BOOST_STEP],
    ["TAG_BOOST_MAX", DEFAULTS.TAG_BOOST_MAX, constants.TAG_BOOST_MAX],
    ["CONTRADICTION_IMPORTANCE_STEP", DEFAULTS.CONTRADICTION_IMPORTANCE_STEP, constants.CONTRADICTION_IMPORTANCE_STEP],
    ["LLM_MODEL", DEFAULTS.LLM_MODEL, constants.LLM_MODEL],
    ["EMBEDDING_MODEL", DEFAULTS.EMBEDDING_MODEL, constants.EMBEDDING_MODEL],
    ["INSIGHT_LLM_MODEL", DEFAULTS.INSIGHT_LLM_MODEL, constants.INSIGHT_LLM_MODEL],
  ];

  for (const [name, fromConfig, fromModule] of cases) {
    it(`${name} matches the shipped constant`, () => {
      expect(fromConfig).toBe(fromModule);
    });
  }

  it("keeps recall widening independent from duplicate flagging after Gemma calibration", () => {
    expect(DEFAULTS.RECALL_WIDEN_THRESHOLD).not.toBe(DEFAULTS.DUPLICATE_FLAG_THRESHOLD);
  });

  // Brief v2's when-extraction pass defaults to the same model the weekly
  // insight pass reasons with, independently overridable from then on.
  // 4.0 history and trash: the shipped defaults, so a brain that never sets them keeps Rahil's decisions (D1.2).
  it("VERSION_KEEP and TRASH_RETENTION_DAYS ship at 20 and 14, within their rules", () => {
    expect(DEFAULTS.VERSION_KEEP).toBe(20);
    expect(DEFAULTS.TRASH_RETENTION_DAYS).toBe(14);
    expect(RULES.VERSION_KEEP).toEqual({ kind: "number", min: 5, max: 500, integer: true });
    expect(RULES.TRASH_RETENTION_DAYS).toEqual({ kind: "number", min: 1, max: 365, integer: true });
  });

  it("WHEN_LLM_MODEL starts equal to INSIGHT_LLM_MODEL", () => {
    expect(DEFAULTS.WHEN_LLM_MODEL).toBe(DEFAULTS.INSIGHT_LLM_MODEL);
  });

  // Spec 14 5.8 (T-0089.2.3): a state fact ships at the same 90-day age the nightly pass used
  // for everyone before volatility split the threshold, so a brain that never overrides these
  // keeps re-checking state facts exactly as often as it always has.
  it("STALE_AFTER_DAYS_VOLATILE and STALE_AFTER_DAYS_STATE ship at 14 and 90, within their rules", () => {
    expect(DEFAULTS.STALE_AFTER_DAYS_VOLATILE).toBe(14);
    expect(DEFAULTS.STALE_AFTER_DAYS_STATE).toBe(90);
    expect(RULES.STALE_AFTER_DAYS_VOLATILE).toEqual({ kind: "number", min: 1, max: 365, integer: true });
    expect(RULES.STALE_AFTER_DAYS_STATE).toEqual({ kind: "number", min: 7, max: 730, integer: true });
  });
});

describe("config rule coverage", () => {
  it("every default has a validation rule", () => {
    const missing = Object.keys(DEFAULTS).filter(k => !(k in RULES));
    expect(missing).toEqual([]);
  });

  it("every rule corresponds to a real default", () => {
    const orphans = Object.keys(RULES).filter(k => !(k in DEFAULTS));
    expect(orphans).toEqual([]);
  });

  it("every shipped default satisfies its own rule", () => {
    const violations: string[] = [];
    for (const [key, rule] of Object.entries(RULES)) {
      const v = (DEFAULTS as Record<string, unknown>)[key];
      if (rule.kind === "fixed") {
        if (v !== rule.value) violations.push(`${key}: does not match fixed value`);
        continue;
      }
      if (rule.kind === "string") {
        // PUSH_CONTACT is the one string setting whose default IS empty —
        // see the config.ts comment on its DEFAULTS entry.
        if (key === "PUSH_CONTACT") continue;
        if (typeof v !== "string" || !v.trim()) violations.push(`${key}: not a non-empty string`);
        continue;
      }
      if (typeof v !== "number" || !Number.isFinite(v)) { violations.push(`${key}: not finite`); continue; }
      if (v < rule.min || v > rule.max) violations.push(`${key}: ${v} outside ${rule.min}–${rule.max}`);
      if (rule.integer && !Number.isInteger(v)) violations.push(`${key}: ${v} is not an integer`);
    }
    expect(violations).toEqual([]);
  });

  it("platform limits are absent from the config surface", () => {
    // Exposing these guarantees breakage rather than risking it: Vectorize
    // rejects >20 ids per call, D1 caps bound params at 100 and refuses an
    // expression tree deeper than 100 (#276).
    for (const forbidden of ["VECTORIZE_GET_BY_IDS_BATCH", "D1_MAX_BOUND_PARAMS", "EDGE_QUERY_BATCH", "KEYWORD_MAX_TOKENS"]) {
      expect(DEFAULTS).not.toHaveProperty(forbidden);
    }
  });
});

describe("OAuth compatibility boundary", () => {
  it("keeps strict-public fetch routing as an explicit fork exception", () => {
    const raw = readFileSync(resolve(import.meta.dirname, "../../wrangler.jsonc"), "utf8");
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
      compatibility_flags?: string[];
    };

    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
  });
});
