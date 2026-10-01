/**
 * Structural guard for the review's reader class (T-0089.2.1, spec 14 5.5): every SQL literal in src/
 * that drops deprecated, quarantined or conflict-held rows is deciding what is live, so it must also
 * drop replaced and ended rows, or be on the pinned list below of readers that deliberately read any
 * row, each with its reason. A new reader that filters those tags without the validity predicate fails
 * here, and so does a named fragment that loses it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";
import { STALE_REVIEW_SQL } from "../../src/memory/stale";
import { PENDING_INSIGHT_SQL } from "../../src/memory/patterns";
import { dueSql } from "../../src/when/input";
import { openLoopSql } from "../../src/memory/loops";
import { openOutboundSql, openInboundSql } from "../../src/commitments/direction";

const ROOT = join(import.meta.dirname, "../..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

/** Drops rows that are deprecated, quarantined or held: a "what is live" filter. */
const LIVENESS_FILTER = /NOT LIKE '%"status:deprecated"%'|NOT LIKE '%"quarantine:|NOT LIKE '%"conflict-held"%'|\$\{NOT_HELD_SQL\}/;
/** The validity predicate itself, or a named fragment that carries it (checked below). */
const VALIDITY = /(\w+\.)?valid_until IS NULL OR (\w+\.)?valid_until >|currentValidityAt\(|currentValiditySql\(|validAtSql\(|\$\{(STALE_REVIEW_SQL|PENDING_INSIGHT_SQL)\}|dueSql\(|openLoopSql\(|openOutboundSql\(|openInboundSql\(|resurfaceFilter\(|asOfPredicateSql\(/;
/** True when the SQL literal filters on current validity (the predicate itself, or a fragment that carries it). */
export const carriesValidity = (sql: string): boolean => VALIDITY.test(sql);

interface Hit { file: string; sql: string }

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    const text = readFileSync(path, "utf8");
    for (const span of templateSpans(text) as unknown as { start: number; end: number }[]) {
      const sql = text.slice(span.start + 1, span.end);
      if (LIVENESS_FILTER.test(sql) && !carriesValidity(sql)) hits.push({ file: relative(ROOT, path), sql: sql.replace(/\s+/g, " ").trim() });
    }
  }
  return hits;
}

/**
 * Readers that filter liveness tags but read any row, current or not, on purpose. Keyed by file and a
 * fragment of the statement (not by line, which other lanes shift), each with the reason it is "any".
 */
const ANY_READERS: { file: string; has: string; why: string }[] = [
  { file: "src/graph/pass.ts", has: "SELECT e.id, e.content, e.created_at FROM entries e", why: "回転する夜間グラフ再計算は履歴もリンクする。保留本文はnotHeldSqlForで除外する。" },
  { file: "src/graph/pass.ts", has: "SELECT e.id, e.content FROM entries e", why: "旧推論辺の再計算は履歴も対象にする。保留本文はnotHeldSqlForで除外する。" },
  { file: "src/recall/search.ts", has: "AND tags NOT LIKE '%\"auto-pattern\"%' AND tags NOT LIKE", why: "keyword用のsystem除外fragment。実行SQLはvaliditySql／asOfPredicateSqlを別途付加する。" },
  { file: "src/capture/lifecycle.ts", has: "tags NOT LIKE '%\"status:deprecated\"%'", why: "INDEXABLE_SQL: superseded rows keep their vectors and must be re-indexed (P11)" },
  { file: "src/capture/lifecycle.ts", has: "x.tags NOT LIKE", why: "the un-retraction hook's landed guard over the retracted row itself, not a reader" },
  { file: "src/memory/trash.ts", has: "x.tags NOT LIKE", why: "restore's un-retraction landed guard over the restored row itself, not a reader" },
  { file: "src/compression/digest.ts", has: "INDEXED BY idx_entries_conflict_held", why: "held digests are bookkeeping for the digest writer, whatever their window" },
  { file: "src/decisions/queries.ts", has: "tags LIKE '%\"outcome:%'", why: "calibration scores every decision that had an outcome, including one later replaced" },
  { file: "src/graph/traverse.ts", has: "SELECT id, content, tags, source, created_at, valid_until FROM entries WHERE id IN", why: "graph node hydration for connections and GET /graph (5.5: any); recall's hops drop replaced nodes in expandGraph from the valid_until it projects" },
  { file: "src/graph/traverse.ts", has: "e.source, e.valid_until, u.name AS actor_display_name", why: "GET /graph view hydration: the graph shows replaced memories, dimmed (5.5: any)" },
  { file: "src/memory/validity.ts", has: "CASE WHEN ${outer}.valid_until IS NULL THEN NULL ELSE", why: "supersededBySql: the replacing memory may itself be replaced later; it only has to be live and not wrong" },
  { file: "src/graph/pass.ts", has: "id NOT IN (SELECT source_id FROM edges)", why: "nightly edge backfill links history too (spec 4.5: any)" },
  { file: "src/insight/candidates.ts", has: "WHERE (created_at > ? OR (created_at = ? AND id > ?)) AND ${NOT_HELD_SQL}", why: "seed scan fragment; isCurrent() drops replaced rows in JS on the rows it returns" },
  { file: "src/insight/candidates.ts", has: "WHERE ${NOT_HELD_SQL}", why: "seed scan fragment; isCurrent() drops replaced rows in JS on the rows it returns" },
  { file: "src/recall/search.ts", has: "${tagScopeSql}${tagEligibilitySql} AND ${NOT_HELD_SQL}", why: "tag/project member ids; the final hydration's d1Filters is the current-only predicate" },
  { file: "src/staleness/pass.ts", has: "tags NOT LIKE '%\"status:deprecated\"%'", why: "SYSTEM_TAG_EXCLUSIONS fragment; the candidate query adds currentValidityAt itself" },
  { file: "src/recall/as-of.ts", has: "v.tags NOT LIKE '%\"status:deprecated\"%'", why: "retracted_at: the newest version whose PRIOR tags were not deprecated, i.e. when a belief was last marked wrong (5.7 item 5) — a version-history lookup, not a current-facts reader" },
  { file: "src/brief/compute.ts", has: "AND tags LIKE '%\"standing:active\"%' AND tags NOT LIKE '%\"status:deprecated\"%'", why: "hydrates ids readStandingCaches already picked with its own currentValidityAt filter (Design 2.x); nothing here can be replaced" },
];

describe("the validity matcher", () => {
  it("a projected valid_until is not a filter; the predicate shape and the helpers are", () => {
    expect(carriesValidity(`SELECT id, valid_until FROM entries WHERE tags NOT LIKE '%"status:deprecated"%'`)).toBe(false);
    expect(carriesValidity(`SELECT id FROM entries WHERE (valid_until IS NULL OR valid_until > ?)`)).toBe(true);
    expect(carriesValidity(`SELECT a.id FROM entries a WHERE (a.valid_until IS NULL OR a.valid_until > 5)`)).toBe(true);
    expect(carriesValidity("SELECT id FROM entries WHERE ${currentValidityAt(\"\", \"?3\")}")).toBe(true);
    expect(carriesValidity("SELECT id FROM entries e WHERE ${currentValiditySql(p, \"e\", now)}")).toBe(true);
  });
});

describe("current-reader class guard (5.5)", () => {
  const hits = scan();

  it("finds the liveness filters (the scan is not silently empty)", () => {
    const all: string[] = [];
    for (const path of walk(join(ROOT, "src"))) {
      const text = readFileSync(path, "utf8");
      for (const span of templateSpans(text) as unknown as { start: number; end: number }[]) {
        if (LIVENESS_FILTER.test(text.slice(span.start + 1, span.end))) all.push(path);
      }
    }
    expect(all.length).toBeGreaterThan(30);
  });

  it("every liveness filter without the validity predicate is a pinned 'any' reader, and every pin still matches", () => {
    const unexplained = hits.filter(h => !ANY_READERS.some(a => a.file === h.file && h.sql.includes(a.has))).map(h => `${h.file}: ${h.sql.slice(0, 140)}`);
    expect(unexplained).toEqual([]);
    const stale = ANY_READERS.filter(a => !hits.some(h => h.file === a.file && h.sql.includes(a.has))).map(a => `${a.file}: ${a.has}`);
    expect(stale).toEqual([]);
  });

  it("the named fragments that stand in for the predicate carry it", () => {
    for (const [name, sql] of [
      ["STALE_REVIEW_SQL", STALE_REVIEW_SQL], ["PENDING_INSIGHT_SQL", PENDING_INSIGHT_SQL],
      ["dueSql", dueSql(1)], ["openLoopSql", openLoopSql(1)],
      ["openOutboundSql", openOutboundSql(1)], ["openInboundSql", openInboundSql(1)],
    ] as const) {
      expect(sql, name).toMatch(/valid_until IS NULL OR valid_until >/);
    }
  });
});
