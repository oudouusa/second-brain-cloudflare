/**
 * A life-end marker (an entry_events INSERT for "deleted" or "purged") permanently claims an id
 * is safe to reuse, so it can only be as trustworthy as the row-removal statement it rides
 * alongside. This scans all of src/ for such an INSERT and asserts each one carries a real WHERE
 * guard, not a bare id list (the tier-3 marker in trash.ts once had none).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";

const ROOT = join(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");

const LIFE_END_EVENT = /'deleted'|'purged'/;
/** Several real guard shapes exist (entriesGuardSql's EXISTS, workspace_id = ?, deleted_at <
 * cutoff, a by-id nonce match) but every one is a WHERE clause on the marker's own SELECT. */
const HAS_WHERE_CLAUSE = /\bWHERE\b/;

interface Hit { file: string; line: number; sql: string }

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

function markerInserts(file: string, text: string): Hit[] {
  const spans = templateSpans(text) as unknown as { start: number; end: number; balanced?: boolean }[];
  if ((spans as unknown as { balanced?: boolean }).balanced === false) {
    throw new Error(`life-end-marker-guard scan: ${file} has unbalanced template literals`);
  }
  const hits: Hit[] = [];
  for (const span of spans) {
    const sql = text.slice(span.start + 1, span.end);
    if (!/INSERT INTO entry_events/.test(sql)) continue;
    if (!LIFE_END_EVENT.test(sql)) continue;
    hits.push({ file, line: text.slice(0, span.start).split("\n").length, sql });
  }
  return hits;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(SRC)) {
    const file = relative(ROOT, path).replace(/\\/g, "/");
    hits.push(...markerInserts(file, readFileSync(path, "utf8")));
  }
  return hits;
}

describe("every life-end marker insert shares its delete's guard", () => {
  it("finds at least 3 markers (the scan is not silently empty)", () => {
    expect(scan().length).toBeGreaterThanOrEqual(3);
  });

  it("finds only the known sites", () => {
    const sites = scan().map((h) => `${h.file}:${h.line}`).sort();
    expect(sites).toEqual([
      "src/lib/team-admin.ts:611",
      "src/lib/team-admin.ts:619",
      "src/memory/trash.ts:300",
      "src/memory/trash.ts:595",
      "src/memory/trash.ts:920",
    ].sort());
  });

  it("every life-end marker (event 'deleted' or 'purged') is guarded, not a bare id list", () => {
    const unguarded = scan().filter((h) => !HAS_WHERE_CLAUSE.test(h.sql)).map((h) => `${h.file}:${h.line}`);
    expect(unguarded).toEqual([]);
  });
});
