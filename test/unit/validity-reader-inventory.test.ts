/**
 * Validity read-path inventory guard (Task B2, T-0089.2.7, spec 14 4.5/5.5).
 *
 * Every SQL statement that reads `entries` must say, within five lines above it (the same
 * lookback scripts/check-scope.mjs uses for `scope-checked:`/`scope-exempt:`), which of the
 * spec's three reader classes it is: `// validity: current | as-of | any: <reason>`. This scans
 * src/ with the same template-literal lexer check-scope.mjs uses, so a statement neither script
 * can read fails loudly rather than passing both silently.
 *
 * Lane B does not own every file this scan touches (spec 11): most of src/ belongs to other
 * Track 2 lanes, or predates Track 2 entirely. This guard enforces two different things for the
 * two halves of that split:
 *   - files and regions lane B owns: zero unmarked reads, checked directly against the source.
 *   - everything else: an exact, named exemption list, so a new unmarked read anywhere in the
 *     tree is caught immediately, but classifying another lane's query is that lane's obligation
 *     (spec 15 frames this guard as an ongoing, cross-track item, not a one-shot by lane B alone).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";

const ROOT = join(import.meta.dirname, "../..");
const LOOKBACK = 5;
const MARKER = /\/\/\s*validity:\s*(current|as-of|any):\s*(.+)/;

interface Hit { file: string; line: number; sql: string }

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split("\n").length;
}

/** Every `FROM entries`-bearing template literal under src/, whether or not it is marked. */
function scanReaders(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    if (path.includes(`${join("src", "db")}${"/"}`) || path.includes(`${join("src", "migration")}${"/"}`)) continue;
    const file = relative(ROOT, path);
    const text = readFileSync(path, "utf8");
    const spans = templateSpans(text) as unknown as { start: number; end: number }[] & { balanced: boolean };
    if (!spans.balanced) continue;
    for (const span of spans) {
      const sql = text.slice(span.start + 1, span.end);
      if (!/FROM\s+entries\b/.test(sql)) continue;
      hits.push({ file, line: lineOf(text, span.start), sql });
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Marker text found within LOOKBACK lines above a hit, spent by the first (nearest) hit that claims it. */
function markersFor(hits: Hit[]): Map<Hit, string | null> {
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) (byFile.get(h.file) ?? byFile.set(h.file, []).get(h.file)!).push(h);
  const result = new Map<Hit, string | null>();
  for (const [file, fileHits] of byFile) {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    const claimed = new Set<number>();
    for (const hit of fileHits) {
      const from = Math.max(0, hit.line - 1 - LOOKBACK);
      let found: string | null = null;
      for (let i = hit.line - 1; i >= from && found === null; i--) {
        if (claimed.has(i)) continue;
        const m = MARKER.exec(lines[i] ?? "");
        if (m) { found = `${m[1]}: ${m[2]}`; claimed.add(i); }
      }
      result.set(hit, found);
    }
  }
  return result;
}

/**
 * Files lane B owns outright for this task (recall's validity summary and its readers, the
 * as-of core, the graph traversal validity fields): a `FROM entries` read here with no marker
 * is a real gap, not another lane's business.
 */
const OWNED_FILES = new Set([
  "src/recall/search.ts",
  "src/recall/render.ts",
  "src/recall/validity-view.ts",
  "src/recall/keyword-rows.ts",
  "src/recall/as-of.ts",
  "src/routes/recall.ts",
  "src/graph/traverse.ts",
  "src/when/input.ts",
  "src/memory/loops.ts",
  "src/prompt-capsule/build.ts",
]);

/**
 * Lines in shared files where lane B owns only a region (spec 11): due, loops, resurface, the
 * capsule, the digest and insight-weekly candidate scans, insight dry-run's pair query, GET
 * /entry, and recall/get/list_recent in the MCP server. Every other `FROM entries` read in these
 * same files belongs to a different lane's region and is listed here by exact line, not by file,
 * so a new unmarked line landing in lane B's own region of these files still fails the guard.
 */
const SHARED_FILE_EXEMPT_LINES: Record<string, number[]> = {
  // MOVED (merge of release/v4 d3b5b25c into v4/t7-c): Track 7's own reads (dueSplit/loopsSplit's
  // items+totals, now each marked directly; the standing-hydration read, now marked `any`) and
  // Track 9's dashboard aggregates shifted; recomputed against the real scanner output.
  // MOVED (merge of release/v4 1cbc817b into v4/gate-fx2): this lane's own round 3 NOT_HELD_SQL
  // swap and FX1's own finding-8 comment block are independently-tracked deltas from the same
  // base; recomputed against the real scanner output on the merged tree, not hand-combined.
  "src/brief/compute.ts": [],
  // MOVED (merge of release/v4 c870e5ac into v4/t34-w, T-0089.4.2): v4/t34-w's own class E
  // held-row exclusions and release/v4's own Track 2 lane B deltas shifted these; recomputed
  // against the real scanner output on the merged tree.
  "src/compression/digest.ts": [],
  "src/insight/weekly.ts": [],
  // REMOVED mcp/server.ts:489 (T-0089.2.1 fix round, release/v4 d3b5b25c): the digest tool's read
  // now carries its own `validity: current` marker and predicate.
  "src/mcp/server.ts": [],
  // MOVED (merge of release/v4 c0eed34b into v4/t2-b): Track 7-C's GET /loops direction/kind logic
  // and the decisions/commitments wiring added lines above several of these sites; recomputed
  // against the real scanner output on the merged tree.
  // MOVED +2 (merge of release/v4 c870e5ac into v4/t34-w, T-0089.4.2): the /insights/dry-run
  // held-row exclusion.
  // MOVED (T-0089.2.3): GET /stale's own `reason` computation (spec 14 5.9) added lines above it
  // and everything after; recomputed against the real scanner output.
  // MOVED (merge of release/v4 1cbc817b into v4/gate-fx2): this lane's own round 3 "event life"
  // filter and FX3's own member-removal vector-delete cap are independently-tracked deltas from
  // the same base; recomputed against the real scanner output on the merged tree, not hand-combined.
  // MOVED -1 (7b69dde6 comment trim): a comment above admin.ts's own life filter shrank by 1 line.
  "src/routes/admin.ts": [],
  // MOVED +1 (R16): entries.ts imports supersededBySql.
  "src/routes/entries.ts": [],
};

/**
 * Files with no lane B ownership at all for this task: other Track 2 lanes' write and version
 * paths, admin/team management, staleness and graph maintenance passes, import/export, and
 * recall's diagnostic/distillation path. Whole-file, not by line, because these lines shift
 * under other lanes' own commits the way REVIEWED_TABLE in entry-write-inventory.test.ts already
 * documents shifting under this lane's; tracking them by line here would only fight that churn.
 */
const OTHER_LANE_FILES = new Set([
  "src/capture/classify.ts", "src/capture/entry.ts", "src/capture/lifecycle.ts",
  "src/capture/share.ts", "src/capture/store.ts",
  "src/compression/nightly.ts",
  "src/decisions/queries.ts",
  "src/entries/import.ts",
  "src/graph/edges.ts", "src/graph/pass.ts",
  "src/integrations/mirror.ts",
  "src/lib/entry-access.ts", "src/lib/team-admin.ts",
  "src/memory/trash.ts", "src/memory/undo.ts", "src/memory/validity.ts", "src/memory/versions.ts",
  "src/recall/distill.ts",
  "src/routes/projects.ts",
  "src/runtime/rotation.ts",
  "src/staleness/pass.ts",
  "src/standing/cache.ts",
  "src/tags/vocabulary.ts",
  "src/vectorize/pending.ts",
]);

describe("validity read-path inventory guard (B2, 5.5)", () => {
  const hits = scanReaders();
  const markers = markersFor(hits);

  it("finds at least one FROM-entries reader (the scan itself is not silently empty)", () => {
    expect(hits.length).toBeGreaterThan(20);
  });

  it("every read in a lane-B-owned file carries a validity marker", () => {
    const unmarked = hits
      .filter(h => OWNED_FILES.has(h.file) && !markers.get(h)!)
      .map(h => `${h.file}:${h.line}`);
    expect(unmarked).toEqual([]);
  });

  it("every read in lane B's own region of a shared file carries a validity marker", () => {
    const unmarked = hits
      .filter(h => {
        const exempt = SHARED_FILE_EXEMPT_LINES[h.file];
        return exempt !== undefined && !exempt.includes(h.line) && !markers.get(h)!;
      })
      .map(h => `${h.file}:${h.line}`);
    expect(unmarked).toEqual([]);
  });

  it("every unmarked read outside lane B ownership is on the documented exemption list, exactly", () => {
    const actualUnmarkedOutsideOwnership = hits
      .filter(h => !OWNED_FILES.has(h.file) && !markers.get(h))
      .map(h => `${h.file}:${h.line}`)
      .sort();

    const documented = [
      ...Object.entries(SHARED_FILE_EXEMPT_LINES).flatMap(([file, lines]) => lines.map(line => `${file}:${line}`)),
      ...hits.filter(h => OTHER_LANE_FILES.has(h.file) && !markers.get(h)).map(h => `${h.file}:${h.line}`),
    ].sort();

    expect(actualUnmarkedOutsideOwnership).toEqual(documented);
  });

  it("every OTHER_LANE_FILES entry still exists (no stale exemption for a file no longer read)", () => {
    const filesWithHits = new Set(hits.map(h => h.file));
    const stale = [...OTHER_LANE_FILES].filter(f => !filesWithHits.has(f));
    expect(stale).toEqual([]);
  });
});
