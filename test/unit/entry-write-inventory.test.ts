/**
 * Write-path inventory guard (Task 6, T-0089.1.1).
 *
 * Every SQL statement that writes to `entries` must say, right above it, what it does to that
 * row's history: `// versioning: snapshot | trash | hard-delete: <why> | exempt: <why>`. This
 * scans src/ the way scripts/check-scope.mjs does — the same template-literal lexer, so a
 * statement neither script can read fails loudly rather than passing both silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { writerSpans } from "../../scripts/check-scope.mjs";
import { isEntriesWriteSql } from "../../src/db/fts-write-guard";

const ROOT = resolveRoot();
function resolveRoot(): string {
  return join(import.meta.dirname, "../..");
}

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

const MARKER = /\/\/\s*versioning:\s*(snapshot|trash|hard-delete:.*|exempt:.*)/;

interface Site { file: string; line: number; sql: string; markerKind: string | null; markerText: string | null }

/** Every entries-write statement under src/, with whatever marker sits within 3 lines above it. */
function scanInventory(): Site[] {
  const sites: Site[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    const file = relative(ROOT, path);
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const spans = writerSpans(text) as { start: number; end: number }[];
    for (const span of spans) {
      const sql = text.slice(span.start + 1, span.end);
      if (!isEntriesWriteSql(sql)) continue;
      const line = lineOf(text, span.start);
      let markerKind: string | null = null;
      let markerText: string | null = null;
      for (let l = line; l >= Math.max(1, line - 3); l--) {
        const m = MARKER.exec(lines[l - 1] ?? "");
        if (m) {
          markerText = m[1];
          markerKind = m[1].startsWith("hard-delete") ? "hard-delete" : m[1].startsWith("exempt") ? "exempt" : m[1];
          break;
        }
      }
      sites.push({ file, line, sql, markerKind, markerText });
    }
  }
  return sites;
}

/**
 * The reviewed table, one entry per code site (writer table in the spec, plus the compare-and-set
 * forms Tasks 3a and 4a added and row 29's vector-bookkeeping exempt, L5). Frozen: a writer that
 * moves, is added, or is removed must update this list by hand, which is the point.
 */
// MOVED to real --inventory output (merge of release/v4 d3b5b25c into v4/t7-c, T-0089.7.1/.2/.3):
// Track 2's validity columns/supersede/retraction rework and Track 7's standing/decision/
// commitment/resolve work landed on src/capture/entry.ts, src/memory/actions.ts,
// src/routes/admin.ts and others independently. Recomputed against the real scanner output after
// combining rather than hand-reconciling two independently-tracked line sets, same reasoning as
// every prior cross-track merge this table records — see the history further below.
/**
 * `standing` (Track 7 lane D Tasks 11-12, spec 15 2.6): `touch` when a written row's prior or
 * next tags can contain standing:active and the writer calls standingTouched somewhere in its
 * own file (checked per-file, not per-statement: several touch sites share one orchestrator
 * elsewhere in the same file that already makes the call). Every other site is `exempt: <why>`.
 */
const REVIEWED_TABLE: { file: string; line: number; kind: string; standing: string }[] = [
  // 4.0統合: 実SQLを照合し、移動した経路・追加したfork経路の履歴とstanding責任を固定する。
  {"file": "src/backup/history.ts", "line": 67, "kind": "exempt", "standing": "exempt: 動的tableはentry_versions・entries_trashの復旧のみ。現行entriesのstandingは変更しない。"},
  {"file": "src/capture/classify.ts", "line": 111, "kind": "exempt", "standing": "exempt: importance_score only, no tags column"},
  {"file": "src/capture/classify.ts", "line": 121, "kind": "exempt", "standing": "exempt: withKind/withStatus only add or replace the kind/canonical marker; standing:active (if present) survives unchanged either way"},
  {"file": "src/capture/entry.ts", "line": 380, "kind": "snapshot", "standing": "exempt: a system job merges only into what a system job wrote (isSystemRow), which a person's standing capture never is"},
  {"file": "src/capture/entry.ts", "line": 424, "kind": "snapshot", "standing": "touch"},
  {"file": "src/capture/entry.ts", "line": 548, "kind": "exempt", "standing": "touch"},
  {"file": "src/capture/entry.ts", "line": 614, "kind": "exempt", "standing": "exempt: keepAsDraft's protective self-tag; scheduleIndex(protectedTags) right below it is this same new row's own standingKnownVector touch"},
  {"file": "src/capture/entry.ts", "line": 621, "kind": "exempt", "standing": "exempt: contradiction_wins counter only, no tags column"},
  {"file": "src/capture/entry.ts", "line": 623, "kind": "exempt", "standing": "exempt: contradiction_losses counter only, no tags column"},
  {"file": "src/capture/entry.ts", "line": 658, "kind": "exempt", "standing": "exempt: a window-closed bump counter, no tags column"},
  {"file": "src/capture/entry.ts", "line": 675, "kind": "exempt", "standing": "exempt: the lost-race retry's own protective retag; scheduleIndex(keptTags) right below it is this same row's own standingKnownVector touch"},
  {"file": "src/capture/lifecycle.ts", "line": 185, "kind": "snapshot", "standing": "touch"},
  {"file": "src/capture/lifecycle.ts", "line": 275, "kind": "snapshot", "standing": "touch"},
  {"file": "src/capture/pending.ts", "line": 302, "kind": "exempt", "standing": "exempt: kind/statusの初期分類を再試行するhygiene。standingは削除しない。"},
  {"file": "src/capture/share.ts", "line": 83, "kind": "exempt", "standing": "exempt: workspace_id only, no tags column; moveEntry's own touch call (both workspaces) reads tags separately after this statement"},
  {"file": "src/capture/store.ts", "line": 308, "kind": "exempt", "standing": "exempt: 索引移行のvector_ids・leaseのみ。タグは保持する。"},
  {"file": "src/capture/store.ts", "line": 322, "kind": "snapshot", "standing": "touch"},
  {"file": "src/capture/store.ts", "line": 337, "kind": "exempt", "standing": "exempt: 派生索引と追記queueのみ。タグは保持する。"},
  {"file": "src/capture/store.ts", "line": 356, "kind": "exempt", "standing": "exempt: 派生索引と追記queueのみ。タグは保持する。"},
  {"file": "src/capture/store.ts", "line": 854, "kind": "snapshot", "standing": "touch"},
  {"file": "src/capture/store.ts", "line": 1122, "kind": "snapshot", "standing": "touch"},
  {"file": "src/capture/store.ts", "line": 1345, "kind": "exempt", "standing": "exempt: 追記queueと索引の復旧のみ。タグは保持する。"},
  {"file": "src/compression/digest.ts", "line": 103, "kind": "snapshot", "standing": "exempt: rollup marker on the source row, unaffected by compressionEligibilitySql's own standing:active exclusion"},
  {"file": "src/entries/import.ts", "line": 56, "kind": "exempt", "standing": "touch"},
  {"file": "src/integrations/mirror.ts", "line": 129, "kind": "exempt", "standing": "exempt: mirrors cannot carry standing:active — 1.3 strips it via stripT7CallerTags before mirror tags are built"},
  {"file": "src/integrations/mirror.ts", "line": 197, "kind": "snapshot", "standing": "exempt: mirrors cannot carry standing:active — 1.3 strips it via stripT7CallerTags before mirror tags are built"},
  {"file": "src/lib/team-admin.ts", "line": 591, "kind": "exempt", "standing": "exempt: 同batch削除用のmarkerのみ。"},
  {"file": "src/lib/team-admin.ts", "line": 594, "kind": "hard-delete", "standing": "touch"},
  {"file": "src/lib/tenancy.ts", "line": 135, "kind": "exempt", "standing": "exempt: one-time pre-v3 tenancy bootstrap moving every legacy \"\" row to the new owner workspace; a legacy standing row would need a cache rebuild after migration, which the 24h revalidation (P7.4) supplies on its own"},
  {"file": "src/memory/actions.ts", "line": 76, "kind": "snapshot", "standing": "exempt: withoutStaleAsOf/RETRACTED_SOURCE_TAG only, never touches standing:active"},
  {"file": "src/memory/actions.ts", "line": 134, "kind": "snapshot", "standing": "exempt: withTaskDone/withoutTask only, never touches standing:active"},
  {"file": "src/memory/actions.ts", "line": 148, "kind": "snapshot", "standing": "touch"},
  {"file": "src/memory/actions.ts", "line": 160, "kind": "snapshot", "standing": "exempt: when_at only, no tags column"},
  {"file": "src/memory/actions.ts", "line": 172, "kind": "snapshot", "standing": "exempt: when_* only, no tags column"},
  {"file": "src/memory/actions.ts", "line": 260, "kind": "snapshot", "standing": "exempt: a decision outcome; decision and standing are mutually exclusive at capture (2.1/4.1)"},
  {"file": "src/memory/actions.ts", "line": 302, "kind": "snapshot", "standing": "exempt: auto-insight rows are system-generated candidates, never standing:active"},
  {"file": "src/memory/actions.ts", "line": 314, "kind": "snapshot", "standing": "exempt: auto-insight rows are system-generated candidates, never standing:active"},
  {"file": "src/memory/history.ts", "line": 233, "kind": "exempt", "standing": "exempt: 通常recallに返さない旧before-imageを不変の履歴として保存する。"},
  {"file": "src/memory/rollover.ts", "line": 278, "kind": "exempt", "standing": "touch"},
  {"file": "src/memory/rollover.ts", "line": 317, "kind": "exempt", "standing": "exempt: 原本のtier・pinだけを変更し、standingタグは保持する。"},
  {"file": "src/memory/tier.ts", "line": 20, "kind": "exempt", "standing": "exempt: tierだけを変更し、standingの内容・タグは保持する。"},
  {"file": "src/memory/tier.ts", "line": 29, "kind": "exempt", "standing": "exempt: pinだけを変更し、standingの内容・タグは保持する。"},
  {"file": "src/memory/trash.ts", "line": 255, "kind": "exempt", "standing": "exempt: 同batch削除用のmarkerのみ。"},
  {"file": "src/memory/trash.ts", "line": 266, "kind": "trash", "standing": "touch"},
  {"file": "src/memory/trash.ts", "line": 796, "kind": "exempt", "standing": "touch"},
  {"file": "src/memory/undo.ts", "line": 200, "kind": "snapshot", "standing": "exempt: KNOWN GAP, not fixed here — releaseHeldAfterEdit releases a Track 4 hold via a tags-only change (5.6, the row was edited after the hold), which can restore standing:active without going through revertEntry's own touch. Not in the director's named list for this pass; self-heals within 24h (P7.4), flagged for the director rather than fixed in scope here"},
  {"file": "src/memory/undo.ts", "line": 538, "kind": "snapshot", "standing": "touch"},
  {"file": "src/memory/undo.ts", "line": 574, "kind": "exempt", "standing": "exempt: KNOWN GAP, not fixed here — a merge-undo re-creates the incoming row a merge had absorbed; if that absorbed content was itself standing:active this would need a touch too. Rare (a merge target and its incoming are topically close, not a disjoint standing instruction) and self-heals within 24h (P7.4), flagged for the director, not implemented in this pass"},
  {"file": "src/memory/validity.ts", "line": 170, "kind": "snapshot", "standing": "exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire"},
  {"file": "src/memory/validity.ts", "line": 311, "kind": "snapshot", "standing": "exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire"},
  {"file": "src/memory/validity.ts", "line": 381, "kind": "snapshot", "standing": "exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire"},
  {"file": "src/memory/validity.ts", "line": 425, "kind": "snapshot", "standing": "exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire"},
  {"file": "src/memory/validity.ts", "line": 470, "kind": "snapshot", "standing": "exempt: current validity is re-checked at hydration independent of the cache (2.4/2.6); a missed touch here only delays pruning, never a false fire"},
  {"file": "src/memory/validity.ts", "line": 631, "kind": "snapshot", "standing": "touch"},
  {"file": "src/memory/validity.ts", "line": 649, "kind": "snapshot", "standing": "exempt: the propagate UPDATE moves a REPLACED row's own valid_until; a standing row is never itself in a supersede chain, and if it were, the primary row's own touch above plus the 24h revalidation (2.4) covers it"},
  {"file": "src/quarantine/hold.ts", "line": 122, "kind": "snapshot", "standing": "exempt: Track 4's own quarantine hold/release wiring (spec 15 2.13, Task 16), not lane D"},
  {"file": "src/recall/search.ts", "line": 2128, "kind": "exempt", "standing": "exempt: recall_count bookkeeping only, no tags column"},
  {"file": "src/staleness/pass.ts", "line": 93, "kind": "exempt", "standing": "exempt: a staleness marker addition, never removes standing:active, and hydration re-checks validity independently (2.4/2.6) regardless"},
  {"file": "src/staleness/pass.ts", "line": 103, "kind": "exempt", "standing": "exempt: staleness_checked_at only, no tags column"},
  {"file": "src/when/pass.ts", "line": 443, "kind": "exempt", "standing": "exempt: when_* only, no tags column"},
];

/**
 * Cron/hygiene sites that are REST- or MCP-reachable (an admin route, in classify's case) but not
 * a user- or agent-observable change to a memory's content, tags or due date — the design calls
 * these out by name as staying unversioned. Everything else that touches tags or when_* must be
 * snapshot, trash or hard-delete (the undo invariant).
 */
const HYGIENE_EXEMPT = new Set([
  "src/staleness/pass.ts:93", "src/staleness/pass.ts:103",
  "src/when/pass.ts:443",
  "src/capture/classify.ts:121", "src/capture/pending.ts:302",
  // captureの新規行は返却前に自己保護タグを確定する。既存行の編集ではない。
  "src/capture/entry.ts:614", "src/capture/entry.ts:675",
]);

const setClause = (sql: string) => (/\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql)?.[1] ?? "");
/** A SET of tags, a when_* column, or a validity column (T-0089.2.1): state undo must be able to restore. */
const undoableStateWrite = (sql: string) =>
  /\btags\s*=/i.test(setClause(sql)) || /\bwhen_(at|kind|label|source)\s*=/i.test(setClause(sql)) || /\bvalid_(from|until)\s*=/i.test(setClause(sql));

describe("write-path inventory guard", () => {
  const sites = scanInventory();


  it("every write to entries carries a versioning marker", () => {
    const unmarked = sites.filter(s => s.markerKind === null).map(s => `${s.file}:${s.line}`);
    expect(unmarked).toEqual([]);
  });

  it("the inventory matches the reviewed table", () => {
    const actual = sites.map(s => ({ file: s.file, line: s.line, kind: s.markerKind })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const expected = REVIEWED_TABLE.map(({ file, line, kind }) => ({ file, line, kind })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    expect(actual).toEqual(expected);
  });

  it("every entries writer is classified for standing invalidation", () => {
    const bad = REVIEWED_TABLE.filter(s => s.standing !== "touch" && !s.standing.startsWith("exempt:")).map(s => `${s.file}:${s.line}`);
    expect(bad).toEqual([]);
  });

  it("every touch-classified writer calls standingTouched somewhere in its own file", () => {
    // Per file, not per statement (the docblock above REVIEWED_TABLE explains why): several touch
    // sites share one orchestrator elsewhere in the same file that already makes the call.
    const touchFiles = [...new Set(REVIEWED_TABLE.filter(s => s.standing === "touch").map(s => s.file))];
    expect(touchFiles.length).toBeGreaterThan(0);
    const missing = touchFiles.filter(file => !/\bstandingTouched\(/.test(readFileSync(join(ROOT, file), "utf8")));
    expect(missing).toEqual([]);
  });

  it("every content-changing write is marked snapshot", () => {
    // Only the SET clause counts: a CAS guard's WHERE ... AND content = ? is a read, not a write.
    const setClause = (sql: string) => (/\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql)?.[1] ?? "");
    const contentWrites = sites.filter(s => /\bcontent\s*=/i.test(setClause(s.sql)) || /\bcontent\s*\|\|/i.test(setClause(s.sql)));
    expect(contentWrites.length).toBeGreaterThan(0);
    for (const s of contentWrites) {
      expect(s.markerKind, `${s.file}:${s.line}`).toBe("snapshot");
    }
  });

  it("every REST- or MCP-reachable write of tags, when_* or valid_* is marked snapshot, trash or hard-delete", () => {
    const tagsOrWhenWrites = sites.filter(s => undoableStateWrite(s.sql));
    const reachable = tagsOrWhenWrites.filter(s => !HYGIENE_EXEMPT.has(`${s.file}:${s.line}`));
    expect(reachable.length).toBeGreaterThan(0);
    for (const s of reachable) {
      expect(["snapshot", "trash", "hard-delete"], `${s.file}:${s.line}`).toContain(s.markerKind);
    }
  });
});

describe("undoable state writes", () => {
  it("the inventory rule requires a snapshot marker on any SET of valid_from or valid_until", () => {
    expect(undoableStateWrite(`UPDATE entries AS e SET valid_until = ?1 WHERE e.id = ?2`)).toBe(true);
    expect(undoableStateWrite(`UPDATE entries SET valid_from = ?, valid_until = ? WHERE id = ?`)).toBe(true);
    expect(undoableStateWrite(`UPDATE entries SET recall_count = 1 WHERE valid_until IS NULL`)).toBe(false);
  });
});

describe("isEntriesWriteSql", () => {
  it("still matches WITH-prefixed, REPLACE INTO and quoted-name writes", () => {
    expect(isEntriesWriteSql(`WITH x AS (SELECT 1) UPDATE entries SET tags = ? WHERE id = ?`)).toBe(true);
    expect(isEntriesWriteSql(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 5) UPDATE entries SET tags = ?`)).toBe(true);
    expect(isEntriesWriteSql(`REPLACE INTO entries (id, content) VALUES (?, ?)`)).toBe(true);
    expect(isEntriesWriteSql(`UPDATE "entries" SET tags = ? WHERE id = ?`)).toBe(true);
    expect(isEntriesWriteSql("UPDATE `entries` SET tags = ? WHERE id = ?")).toBe(true);
    expect(isEntriesWriteSql(`UPDATE [entries] SET tags = ? WHERE id = ?`)).toBe(true);
    expect(isEntriesWriteSql(`UPDATE entries_fts SET rank = ?`)).toBe(false);
    expect(isEntriesWriteSql(`SELECT * FROM entries`)).toBe(false);
  });
});
