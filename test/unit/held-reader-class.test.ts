/**
 * Structural guard for the review's held-row class (T-0089.2.2 review, MAJOR): a statement that
 * joins INTO entries from another table (edges, entry_versions, insight_candidates) discovers rows
 * outside the normal id-bounded candidate pipeline, where recall's own NOT_HELD_SQL filter never
 * runs. If that statement also projects entries content (a preview, or the row's own content) to
 * the caller or to a model prompt, a quarantined row can surface disguised as an ordinary result,
 * breaking prompt-injection containment (review d9dceb64: as-of beliefs bypassed the held filter).
 *
 * A pure id/bookkeeping join (no content column) is not in scope — nothing it returns is prompt
 * or user-facing text. Each pinned exemption below says which of those two reasons applies.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { templateSpans } from "../../scripts/check-scope.mjs";

const ROOT = join(import.meta.dirname, "../..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

/** A statement that reaches entries via a JOIN (not a bounded `id IN (...)` off the candidate pipeline). */
const JOINS_ENTRIES = /\bJOIN entries\b/;
/**
 * A statement that reaches entries_trash or entry_versions at all -- FROM or JOIN, aliased or
 * not. Unlike `entries` (which has its own separate `validity:`-marker guard for every bare
 * `FROM entries` read, validity-reader-inventory.test.ts), neither trash nor versions has another
 * guard covering a plain, unjoined read -- so both count here whether or not a JOIN is involved.
 */
const TRASH_TABLE = /\b(?:FROM|JOIN)\s+entries_trash\b(?:\s+(\w+))?/g;
const VERSIONS_TABLE = /\b(?:FROM|JOIN)\s+entry_versions\b(?:\s+(\w+))?/g;
/** Words that can legally follow a bare, alias-less table name -- never mistaken for an alias. */
const NOT_ALIAS = new Set(["WHERE", "ON", "SET", "ORDER", "GROUP", "LIMIT", "AND", "OR", "JOIN", "INNER", "LEFT", "CROSS", "UNION", "AS"]);
function aliasOf(cand: string | undefined): string | undefined {
  return cand && !NOT_ALIAS.has(cand.toUpperCase()) ? cand : undefined;
}
/**
 * Every occurrence of `pattern` in `sql`, not just the first (cloud re-review MINOR, on top of
 * 0b970baa: a statement that joins the SAME table twice -- once filtered, once not -- read as
 * fully guarded when only the first occurrence's alias was ever checked, because content pulled
 * through the SECOND, unfiltered join was never examined at all).
 */
function allMatches(sql: string, pattern: RegExp): RegExpExecArray[] {
  pattern.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(sql))) {
    out.push(m);
    if (m.index === pattern.lastIndex) pattern.lastIndex++; // zero-width guard
  }
  return out;
}
/**
 * Projects entries' own text to the caller: a content column (however aliased — `content AS text`,
 * `substr(content, ...) AS snippet`), a preview substr of one, or entries_trash's own row_json
 * (cloud re-review MINOR: row_json IS the trashed row's content and tags, JSON-packed -- reading
 * it bare is exactly as much a leak as reading `content` directly, and the old pattern never
 * matched the word "row_json" at all). A bare substring match, not anchored to a word boundary: a
 * boundary-anchored pattern misses a rename that butts another identifier straight against
 * "content" with no separator. Over-matching is the safe direction — it earns another pinned
 * exemption, not a silent miss.
 */
export const PROJECTS_CONTENT = /content|preview|row_json/;
/**
 * The column list actually feeding the SELECT that reaches this FROM/JOIN match, not the whole
 * span: a whole-span PROJECTS_CONTENT test flagged `EXISTS (SELECT 1 FROM entry_versions v ...)`
 * existence probes and `NOT EXISTS (SELECT 1 FROM entries_trash ...)` id-uniqueness checks as
 * "content readers" purely because some UNRELATED part of the same statement happened to mention
 * content (an entries column, an INSERT's own column list) -- neither projects a single column
 * from the table this match is about. The nearest SELECT before the match is an approximation,
 * not a parser, but it is enough to tell "SELECT 1 FROM x" apart from "SELECT x.content FROM x".
 */
function selectListBefore(sql: string, matchIndex: number): string {
  const selectIdx = sql.lastIndexOf("SELECT", matchIndex);
  return selectIdx === -1 ? sql.slice(0, matchIndex) : sql.slice(selectIdx, matchIndex);
}
/**
 * The hold filter itself: the plain `${NOT_HELD_SQL}` constant, the aliased `${notHeldSqlFor("a")}`
 * call (T-0102 MINOR fix -- a two-table JOIN needs every `tags` reference qualified, so it can no
 * longer use the bare constant with a manual alias-dot prefix), or the literal LIKE either expands to.
 */
const HOLD_FILTER = /\$\{NOT_HELD_SQL\}|\$\{notHeldSqlFor\(|NOT LIKE '%"quarantine:/;
/**
 * Cloud re-review MINOR tightening (T-0102, on top of 0b970baa): the plain HOLD_FILTER test above
 * is satisfied by a quarantine check ANYWHERE in the statement, including one that only filters
 * the CURRENT row (`e.tags`) while the content actually being projected comes from an
 * independently-held table -- entries_trash or entry_versions, whose own hold state a filter on
 * `entries` alone says nothing about (T-0102 findings 1/2: a version's or trash row's own tags can
 * read unheld even when its text was held). For those two tables the filter must be qualified to
 * the SAME alias the content was read through -- no alias to qualify to (the probe's bare
 * `FROM entries_trash` with no filter at all) always needs a pinned exemption instead.
 *
 * No `[^)]*` gap between the alias and `NOT LIKE` (cloud re-review MINOR, round 2): the old,
 * permissive span let `v.tags = e.tags AND (e.tags NOT LIKE '%"quarantine:...')` read as "v is
 * filtered" -- the wildcard crossed straight over an unrelated alias's own filter, through an OPEN
 * paren, to reach a NOT LIKE that has nothing to do with v.tags at all. notHeldSqlFor/NOT_HELD_SQL's
 * own generated shape is always `alias.tags NOT LIKE '...' AND alias.tags NOT LIKE '...' ...` --
 * direct adjacency, so requiring the first occurrence to sit immediately after the alias (only
 * whitespace between) loses nothing real and closes the gap.
 */
function heldFilterAppliesTo(sql: string, alias: string | undefined): boolean {
  if (!alias) return false;
  // entries_trash has no `tags` column at all (it lives inside row_json, checked in JS after the
  // read -- trash-list.ts's own pattern) so there is no inline SQL shape to recognize for it here;
  // a trash hit always needs a pinned exemption. entry_versions DOES have a real `tags` column, so
  // an alias-qualified check on it is a genuine, recognizable inline filter.
  const qualified = new RegExp(`\\b${alias}\\.tags\\s+NOT LIKE '%"quarantine:|notHeldSqlFor\\(\\s*['"\`]${alias}['"\`]`);
  return qualified.test(sql);
}

interface Hit { file: string; line: number; sql: string; table: "entries" | "entries_trash" | "entry_versions" }

/**
 * Resolves `${CONST_NAME}` interpolations against `consts`, a name -> template-literal-text map
 * (cloud re-review MINOR, round 2: `SELECT ${HISTORY_COLUMNS} FROM entry_versions`, versions.ts,
 * never matched PROJECTS_CONTENT at all -- the literal span text is just the placeholder
 * "${HISTORY_COLUMNS}", not HISTORY_COLUMNS' own "...content..." value, since check-scope.mjs's
 * templateSpans (reused here) extracts spans without resolving interpolations between them). One
 * pass: every constant this guard has needed to resolve so far is itself interpolation-free.
 */
function resolveInterpolations(sql: string, consts: Readonly<Record<string, string>>): string {
  return sql.replace(/\$\{(\w+)\}/g, (whole, name: string) => consts[name] ?? whole);
}

/** The pure predicate, over one already-extracted SQL span: every hit this span produces. `consts`
 * resolves file-level `${NAME}` interpolations (see resolveInterpolations); split out from the
 * file-walking scan() so the reviewer's own probe strings can be asserted on directly, with no
 * fixture file needed (see the "structural probes" describe block below). */
export function hitsIn(sql: string, consts: Readonly<Record<string, string>> = {}): Pick<Hit, "sql" | "table">[] {
  const resolved = resolveInterpolations(sql, consts);
  const hits: Pick<Hit, "sql" | "table">[] = [];
  if (JOINS_ENTRIES.test(resolved) && PROJECTS_CONTENT.test(resolved) && !HOLD_FILTER.test(resolved)) hits.push({ sql, table: "entries" });
  const trashUnguarded = allMatches(resolved, TRASH_TABLE).some(m =>
    PROJECTS_CONTENT.test(selectListBefore(resolved, m.index)) && !heldFilterAppliesTo(resolved, aliasOf(m[1])));
  if (trashUnguarded) hits.push({ sql, table: "entries_trash" });
  const versionsUnguarded = allMatches(resolved, VERSIONS_TABLE).some(m =>
    PROJECTS_CONTENT.test(selectListBefore(resolved, m.index)) && !heldFilterAppliesTo(resolved, aliasOf(m[1])));
  if (versionsUnguarded) hits.push({ sql, table: "entry_versions" });
  return hits;
}

/** Every `const NAME = \`...\`;` template-literal declaration in `text` (no nested `${...}` of its
 * own -- see resolveInterpolations), keyed by name, so a SQL span elsewhere in the SAME file that
 * interpolates `${NAME}` can be resolved before this guard scans it. */
function fileConsts(text: string, spans: { start: number; end: number }[]): Record<string, string> {
  const consts: Record<string, string> = {};
  const DECL = /const\s+(\w+)\s*=\s*$/;
  for (const span of spans) {
    const before = text.slice(Math.max(0, span.start - 80), span.start);
    const name = DECL.exec(before)?.[1];
    if (name) consts[name] = text.slice(span.start + 1, span.end);
  }
  return consts;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(join(ROOT, "src"))) {
    const text = readFileSync(path, "utf8");
    const spans = templateSpans(text) as unknown as { start: number; end: number; balanced: boolean } & { balanced: boolean };
    if (!(spans as unknown as { balanced: boolean }).balanced) continue;
    const spanList = spans as unknown as { start: number; end: number }[];
    const consts = fileConsts(text, spanList);
    for (const span of spanList) {
      const sql = text.slice(span.start + 1, span.end);
      const line = text.slice(0, span.start).split("\n").length;
      for (const h of hitsIn(sql, consts)) hits.push({ file: relative(ROOT, path), line, sql: h.sql.replace(/\s+/g, " ").trim(), table: h.table });
    }
  }
  return hits;
}

/**
 * Readers that join into entries (or read entries_trash/entry_versions) and project content, but
 * are not in scope: an admin- or owner-facing activity log, a by-id operation on a row the caller
 * already authorized, or a read whose every consumer applies its own held/textHeldAt check before
 * content ever reaches a caller or model — each with why.
 */
const EXEMPT: { file: string; has: string; why: string }[] = [
  { file: "src/entries/export.ts", has: "AS entry_bytes", why: "export容量の件数・UTF8バイト数だけを返す。JOINを含んでも本文は射影しない。" },
  { file: "src/recall/distill.ts", has: "SELECT 1 FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id WHERE entries_fts MATCH", why: "distillation's document-frequency counts: content only feeds a LIKE predicate inside count(*), nothing is projected, and held rows must count here exactly as the LIKE pass over entries counts them, or df would depend on the route" },
  { file: "src/brief/changes.ts", has: "LEFT JOIN entries en ON en.id = e.entry_id", why: "the recent-changes feed deliberately lists 'held' events, with a preview, to the brain's own owner: surfacing a hold IS the point, not a bypass of it" },
  { file: "src/brief/changes.ts", has: "FROM (${scopedEvents}) e", why: "the same recent-changes feed, now visible here too since this guard resolves the ${scopedEvents} interpolation -- classify() (this same file) masks heldNow downstream in JS before a preview reaches the caller, the same reasoning as the entry above" },
  { file: "src/routes/admin.ts", has: "FROM admin_events ae", why: "the admin activity trail: a human admin's own audit log, not a model prompt or an agent-facing recall result" },
  { file: "src/routes/admin.ts", has: "FROM edges e LEFT JOIN entries m ON m.id = e.target_id", why: "insight review's source preview for a human admin reviewer; a held source renders as unreadable the same as a deleted one (see the comment above this query), never as ordinary content" },
  { file: "src/memory/trash-list.ts", has: "FROM entries_trash t", why: "T-0102 finding 4 fix: preview is masked in JS via isHeld(trashRowTags(tags_json)) before the item ever leaves listTrash, using the SAME tags_json this query reads" },
  { file: "src/memory/trash.ts", has: "SELECT t.id,", why: "restoreEntry's by-id restore (scope-exempt: by-id, the caller's own authorized trash row, pinned by nonce): copies the trashed row's stored state, tags included, back into entries unchanged -- not a content-projecting read to a caller or model" },
  { file: "src/recall/as-of.ts", has: "FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(?))", why: "resolveAtT (T-0102 MAJOR fix) redacts every rebuilt version's content to \"\" via textHeldAt (isHeld OR isHoldVersion) before it reaches a match, a synthesis prompt, or a reply -- the one choke point every consumer of these rows flows through" },
  { file: "src/memory/versions.ts", has: "FROM entry_versions WHERE entry_id = ? ORDER BY seq DESC LIMIT ?", why: "loadHistory's every consumer (revertEntry in undo.ts, buildEntryHistory/readEntryVersion in history-view.ts) applies its own held/textHeldAt check (now wasReleasedContent-aware too) before a version's content reaches a caller -- newly visible now that this guard resolves the ${HISTORY_COLUMNS} interpolation" },
];

describe("PROJECTS_CONTENT (review NIT)", () => {
  // The old, word-boundary-anchored pattern this replaced: content had to sit at a \b on both
  // sides. It happened to match `content AS text` and `substr(content, ...) AS snippet` (the
  // reviewer's own two examples: nothing else in either string touches "content" directly), but
  // missed a rename that butts straight up against "content" with no separator at all.
  const OLD_BOUNDARY_ANCHORED = /\b\w*\.?content\b|\bpreview\b/;

  it("matches a butted-up rename the boundary-anchored pattern missed", () => {
    const sql = "SELECT s.content_preview FROM edges g JOIN entries s ON s.id = g.source_id";
    expect(OLD_BOUNDARY_ANCHORED.test(sql)).toBe(false); // fails before this change
    expect(PROJECTS_CONTENT.test(sql)).toBe(true);
  });

  it("still matches the reviewer's own two examples", () => {
    expect(PROJECTS_CONTENT.test("SELECT s.content AS text FROM edges g JOIN entries s ON s.id = g.source_id")).toBe(true);
    expect(PROJECTS_CONTENT.test("SELECT substr(s.content, 1, 60) AS snippet FROM edges g JOIN entries s ON s.id = g.source_id")).toBe(true);
  });
});

describe("held-reader class guard (T-0089.2.2 review, MAJOR)", () => {
  const hits = scan();

  it("finds JOIN-entries content readers (the scan is not silently empty)", () => {
    expect(hits.length).toBeGreaterThan(0);
  });

  it("every content-projecting JOIN into entries carries the hold filter or is a pinned exemption", () => {
    const unexplained = hits.filter(h => !EXEMPT.some(e => e.file === h.file && h.sql.includes(e.has))).map(h => `${h.file}:${h.line}: ${h.sql.slice(0, 160)}`);
    expect(unexplained).toEqual([]);
    const stale = EXEMPT.filter(e => !hits.some(h => h.file === e.file && h.sql.includes(e.has))).map(e => `${e.file}: ${e.has}`);
    expect(stale).toEqual([]);
  });
});

// Cloud re-review MINOR on 0b970baa: three probes the guard above let through before this
// tightening. Asserted directly against hitsIn() -- a pure predicate over a SQL string, no
// fixture file needed -- so the guard's own logic is what is proven, not a stand-in for it.
describe("structural probes the reviewer found unguarded (held-reader-class tightening)", () => {
  it("rejects a bare entries_trash content read with no filter at all", () => {
    const hits = hitsIn("SELECT t.content FROM entries_trash;");
    expect(hits.some(h => h.table === "entries_trash")).toBe(true);
  });

  it("rejects a version's content covered only by a filter on the current row", () => {
    const sql = "SELECT v.content FROM entry_versions v JOIN entries e ON e.id = v.entry_id "
      + "WHERE e.tags NOT LIKE '%\"quarantine:instruction\"%'";
    const hits = hitsIn(sql);
    // The entries-JOIN half IS genuinely guarded (e.tags is the row that JOIN reaches) -- only
    // the entry_versions half is the bug: v.content leaves through a filter that never reads v.tags.
    expect(hits.some(h => h.table === "entry_versions")).toBe(true);
  });

  it("accepts a version read whose filter is qualified to the version's own alias", () => {
    const sql = "SELECT v.content FROM entry_versions v WHERE v.tags NOT LIKE '%\"quarantine:instruction\"%'";
    expect(hitsIn(sql).some(h => h.table === "entry_versions")).toBe(false);
  });
});

// Director round 2: four more probes the guard still let through.
describe("structural probes, round 2 (guard gaps)", () => {
  it("rejects a bare entries_trash row_json read -- row_json IS the trashed row's content, JSON-packed", () => {
    const hits = hitsIn("SELECT t.row_json FROM entries_trash t;");
    expect(hits.some(h => h.table === "entries_trash")).toBe(true);
  });

  it("rejects a second, unfiltered entry_versions reference when only the first was ever checked", () => {
    const sql = "SELECT v2.content FROM entry_versions v1 JOIN entry_versions v2 ON v2.entry_id = v1.entry_id "
      + "WHERE v1.tags NOT LIKE '%\"quarantine:instruction\"%'";
    // v1 IS genuinely guarded; v2, the SECOND reference, is not filtered at all, and its own
    // .content is what actually leaves the statement -- checking only the first regex match's
    // alias (v1) missed this entirely.
    expect(hitsIn(sql).some(h => h.table === "entry_versions")).toBe(true);
  });

  it("rejects a filter span that crosses into another table's own tags through an open paren", () => {
    const sql = "SELECT v.content FROM entry_versions v, entries e "
      + "WHERE v.tags = e.tags AND (e.tags NOT LIKE '%\"quarantine:instruction\"%')";
    // The NOT LIKE clause filters e.tags, not v.tags -- a `[^)]*` gap between "v.tags" and
    // "NOT LIKE" used to cross straight over that unrelated filter (no `)` sits between them,
    // only an OPEN paren) and read v as guarded when it is not.
    expect(hitsIn(sql).some(h => h.table === "entry_versions")).toBe(true);
  });

  it("resolves a template-interpolated column list before checking for content (versions.ts:489's own shape)", () => {
    const sql = "SELECT ${HISTORY_COLUMNS} FROM entry_versions WHERE entry_id = ?1 ORDER BY seq DESC LIMIT ?2";
    // Unresolved, this span contains only the literal text "${HISTORY_COLUMNS}" -- no "content" or
    // "preview" substring at all, so PROJECTS_CONTENT never matched it, guard or no guard.
    expect(hitsIn(sql).some(h => h.table === "entry_versions")).toBe(false);
    const withConsts = hitsIn(sql, { HISTORY_COLUMNS: "seq, workspace_id, content, prior_length, tags, state" });
    expect(withConsts.some(h => h.table === "entry_versions")).toBe(true);
  });
});
