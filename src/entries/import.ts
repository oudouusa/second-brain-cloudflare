import type { Env } from "../env";
import { assertMemoryWritesAllowed, isMemoryWriteFenceError, memoryWriteMarker } from "../migration/write-lock";
import { D1_MAX_BOUND_PARAMS } from "../constants";
import { edgeEndpointsReadableSql, isSymmetric, isValidEdgeType } from "../graph/edges";
import type { EdgeProvenance } from "../graph/types";
import { PROVENANCE_VALUES } from "../graph/types";
import { isMemoryTier, type MemoryTier } from "../memory/tier";
import { MemoryInputError, validateIndexableMemory } from "../capture/store";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import type { ChangeContext } from "../lib/audit";
// MAX_ENTRY_ID_BYTES: the one bound on a caller-chosen entry id, applied through boundedEntryId.
import { boundedEntryId } from "../vectorize/ids";
import { parseImportedProject, type ImportedProject } from "../projects/registry";
import { isOverContentLimit } from "../lib/content-size";
import { resolveConfig, type Config } from "../config";
import { standingTouched } from "../standing/cache";
import { normalizeTagList, stripNewReservedTags } from "../tags/system";
import { heldReason, type HoldReason } from "../quarantine/tags";
import { scoreWrite, type SignalHit } from "../quarantine/score";
import { holdDecision, heldTagsFor, holdStatements, type PlaceholderSink } from "../quarantine/hold";
import { Params, pruneStatement, snapshotStatement } from "../memory/versions";
import { changedRows } from "../memory/trash";

/**
 * Default page size: array positions examined per call, inserts and skips alike.
 * Sized so a failed atomic batch plus all per-row retries still stays inside D1
 * Free's 50 queries per invocation, with restore lease coordination room.
 */
export const IMPORT_DEFAULT_LIMIT = 12;
// Each statement inside DB.batch counts as a D1 query even though the batch is one
// network round trip. Public callers may not raise a page beyond the safe default.
export const IMPORT_MAX_LIMIT = 12;
// 手動importは履歴掃除・hold・衝突時の2回retryまで含めて予算化する。
// 残り10 queryはschema/admission/barrier/存在照合とbatch共通処理に確保する。
export const IMPORT_MANUAL_WRITE_BUDGET = 40;
export const MANUAL_IMPORT_MAX_ROWS = 10_000;
/** D1 batch chunk size for inserts. */
export const IMPORT_D1_BATCH_SIZE = 50;
/** Edge endpoint lookups bind each id twice (source IN + target IN). */
export const EDGE_ENDPOINT_QUERY_BATCH = Math.floor(D1_MAX_BOUND_PARAMS / 2);

// Ids are unique across entries and entries_trash (T-0089.1.1): a row inserts only when NEITHER
// table already has this id, atomically, in the same statement -- not a race between this
// module's own pre-read (loadExistingIds) and this INSERT. `changes` is 0 either way a collision
// happens (already live, or trashed since the pre-read) rather than a thrown PRIMARY KEY error
// for one case and a silent no-op for the other, so flushInsertBatch checks it uniformly.
//
// Codex review, T-0102, director follow-up MAJOR: no longer a CASE WHEN that let the database
// silently substitute a different id on collision -- this module cannot know that id in advance
// to build the hold statements (holdStatements, the held event) against it in the SAME batch, the
// atomicity this fix closes a gap for. Collision now means `changes: 0`, not a substituted id;
// flushInsertBatch mints a fresh one itself and retries under it, as its OWN new atomic attempt.
// versioning: exempt: creation — an imported row has no prior state to keep
// scope-exempt: by-id existence probes across every workspace: an id is unique deployment-wide
const ENTRY_INSERT_SQL_TEMPLATE =
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses, memory_tier, pinned, last_recalled_at, restore_lease_owner, write_marker, workspace_id, actor_id, when_at, when_kind, when_source, when_label, valid_from, valid_until) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24 WHERE NOT EXISTS (SELECT 1 FROM entries WHERE id = ?1) AND NOT EXISTS (SELECT 1 FROM entries_trash WHERE id = ?1)`;

function parseInsertColumns(sql: string): readonly string[] {
  const match = sql.match(/INSERT INTO entries \(([^)]+)\)/i);
  if (!match) throw new Error("INSERT INTO entries missing column list");
  return match[1].split(",").map(c => c.trim());
}

export const ENTRY_INSERT_COLUMNS = parseInsertColumns(ENTRY_INSERT_SQL_TEMPLATE);
export const ENTRY_INSERT_SQL = ENTRY_INSERT_SQL_TEMPLATE;

export type ImportEntryStatus = "imported" | "skipped" | "failed";
export type ImportEdgeStatus = "imported" | "skipped" | "failed";

export interface ImportEntryResult {
  id: string;
  status: ImportEntryStatus;
  reason?: string;
  detail?: string;
  /** Set when the export's id was taken by the time of the insert: the row was imported as `id`. */
  original_id?: string;
}

export interface ImportEdgeResult {
  source_id: string;
  target_id: string;
  type: string;
  status: ImportEdgeStatus;
  reason?: string;
  detail?: string;
}

export interface ImportProjectResult {
  project_id: string;
  status: "imported" | "skipped" | "failed";
  reason?: string;
  detail?: string;
}

export type ImportResultItem = ImportEntryResult | ImportEdgeResult | ImportProjectResult;

export interface ExportEntry {
  id: string;
  content: string;
  tags?: string[];
  source?: string;
  created_at?: number;
  updated_at?: number;
  recall_count?: number;
  importance_score?: number;
  contradiction_wins?: number;
  contradiction_losses?: number;
  memory_tier?: MemoryTier;
  pinned?: boolean;
  last_recalled_at?: number | null;
  when_at?: number | null;
  when_kind?: string | null;
  when_source?: string | null;
  when_label?: string | null;
  workspace_id?: string;
  actor_id?: string;
  /** Track 2 (T-0089.2.1): absent in exports taken before validity windows; restored as NULL. */
  valid_from?: number | null;
  valid_until?: number | null;
}

export interface ExportEdge {
  id?: string;
  source_id: string;
  target_id: string;
  type?: string;
  weight?: number;
  provenance?: string;
  metadata?: Record<string, unknown>;
  created_at?: number;
  updated_at?: number;
  workspace_id?: string;
}

export interface ExportProject {
  workspace_id?: string;
  id: string;
  name: string;
  description?: string;
  aliases?: string[];
  status?: string;
  created_at?: number;
  updated_at?: number | null;
}

export interface ExportPayload {
  version?: number;
  entries: ExportEntry[];
  edges?: ExportEdge[];
  /** Absent in exports taken before projects existed (version 2). */
  projects?: ExportProject[];
}

export interface ImportOptions {
  /** Page size — how many array positions of `entries` (then `edges`) one call examines. */
  limit?: number;
  /** Index into `entries` where this call's page starts. */
  offset?: number;
  /** Index into `edges` where this call's page starts. */
  edgeOffset?: number;
  /** Internal maintenance-barrier owner. Public import callers must not set this. */
  writeLockOwner?: string;
  /** Current D1 restore-page lease. Written into rows for the database trigger fence. */
  restoreLeaseOwner?: string;
  /** Renews and validates the restore lease immediately before every write batch. */
  beforeWriteBatch?: () => Promise<void>;
  /** Manual imports must be indexable; trusted R2 restores preserve legacy bytes. */
  enforceIndexLimits?: boolean;
  /** Workspace and author stamped on restored rows. */
  projectOffset?: number;
  writeCtx?: WriteContext;
  /** Trusted R2 restores preserve each exported row's original tenant metadata. */
  preserveWriteContext?: boolean;
  /** Present, a standing:active row landing on this page invalidates the importer's own workspace cache (spec 15 2.6). */
  ctx?: ExecutionContext;
}

export interface ImportSummary {
  ok: true;
  imported: number;
  skipped: number;
  /** Of `skipped`, ids in the importer's own trash: restore them instead of importing over them. */
  skipped_in_trash: number;
  /** Rahil's decision (18-copy-deck.md 6.8): entries skipped for being over the 128 KB cap, a
   * subset of `skipped` broken out so the dashboard's "{n} memory was too long to import"
   * summary line has its own clear count. */
  skipped_too_large: number;
  failed: number;
  edges_imported: number;
  edges_skipped: number;
  edges_failed: number;
  projects_imported: number;
  projects_skipped: number;
  projects_failed: number;
  remaining_entries: number;
  remaining_edges: number;
  remaining_projects: number;
  /** R2履歴chunkのみ。通常HTTP importには存在しない。 */
  remaining_history?: number;
  next_history_offset?: number;
  /** Pass back as ?offset= to continue. Equals entries.length when entries are done. */
  next_offset: number;
  /** Pass back as ?edge_offset= to continue. Advances only once entries are done. */
  next_edge_offset: number;
  /** Pass back as ?project_offset= to continue. Advances only once entries are done. */
  next_project_offset: number;
  results: ImportResultItem[];
  vectorize_hint: string;
}

interface PendingEdge {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  provenance: EdgeProvenance;
  metadata: string;
  created_at: number;
  updatedAt: number;
  workspaceId: string;
}

const DEFAULT_EDGE_WEIGHT = 0.5;
export const MAX_IMPORT_ID_BYTES = 512;

interface PendingInsert {
  id: string;
  /** The export's own id, when it was over MAX_ENTRY_ID_BYTES and the row takes a minted one instead. */
  originalId?: string;
  content: string;
  tags: string[];
  source: string;
  created_at: number;
  /** Validated payload value, defaulted to created_at — camelCase per the in-memory convention (see recall's updatedAt). */
  updatedAt: number;
  recall_count: number;
  importance_score: number;
  contradiction_wins: number;
  contradiction_losses: number;
  memory_tier: MemoryTier;
  pinned: boolean;
  last_recalled_at: number | null;
  when_at: number | null;
  when_kind: string | null;
  when_source: string | null;
  when_label: string | null;
  workspaceId: string;
  actorId: string;
  valid_from: number | null;
  valid_until: number | null;
  /** The export's own row was held under one of the five recognized reasons, before
   * stripNewReservedTags removed the quarantine: tag along with every other reserved one
   * (Codex review, T-0102 B1): a real hold must not silently become an ordinary row on import. */
  originalHoldReason: HoldReason | null;
  /** Set by importHoldPlan once content and tags are final; null for a row that imports ordinary. */
  holdPlan?: ImportHoldPlan | null;
}

function isValidProvenance(p: string): p is EdgeProvenance {
  return (PROVENANCE_VALUES as readonly string[]).includes(p);
}

export function isImportRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseTags(
  tags: unknown,
): { ok: true; tags: string[] } | { ok: false; reason: "invalid_tag" } {
  if (tags === undefined || tags === null) return { ok: true, tags: [] };
  if (!Array.isArray(tags)) return { ok: false, reason: "invalid_tag" };
  if (!tags.every(t => typeof t === "string")) return { ok: false, reason: "invalid_tag" };
  // Codex review class B (T-0089.4.2): trimmed here, at the one place an import's tags first
  // become this row's stored tags — a leading/trailing space around a quarantine: tag would
  // otherwise still read as held in JS (isHeld trims) but miss the SQL LIKE filters that keep a
  // held row out of recall and re-indexing (NOT_HELD_SQL, INDEXABLE_SQL match the literal text).
  // Codex recheck (T-0089.4.2): an import is a caller-supplied tag path like any other -- the
  // same stripNewReservedTags guard captureEntry and updateEntryContent already apply, so an
  // import can no longer forge quarantine:*, edited-canonical:* or a Track 7 tag onto a row.
  return { ok: true, tags: stripNewReservedTags(normalizeTagList(tags)).kept };
}

export function normalizedEdgeKey(sourceId: string, targetId: string, type: string): string {
  let source = sourceId;
  let target = targetId;
  if (isValidEdgeType(type) && isSymmetric(type) && source > target) {
    [source, target] = [target, source];
  }
  return JSON.stringify([source, target, type]);
}

function validateImportId(
  value: string,
  invalidReason: "invalid_id" | "invalid_endpoint",
): { ok: true; value: string } | { ok: false; reason: "invalid_id" | "invalid_endpoint" } {
  if (value.includes("\0") || new TextEncoder().encode(value).byteLength > MAX_IMPORT_ID_BYTES) {
    return { ok: false, reason: invalidReason };
  }
  return { ok: true, value };
}

export function parseRequiredString(
  value: unknown,
  missingReason: string,
  invalidReason: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: false, reason: missingReason };
  }
  if (typeof value !== "string") {
    return { ok: false, reason: invalidReason };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: missingReason };
  return { ok: true, value: trimmed };
}

function parseContent(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: false, reason: "missing_content" };
  }
  if (typeof value !== "string") return { ok: false, reason: "invalid_content" };
  if (!value.trim()) return { ok: false, reason: "missing_content" };
  // Whitespace is part of the memory: Markdown indentation, fenced-code trailing
  // newlines, and deliberately padded plain text must round-trip byte for byte.
  return { ok: true, value };
}

export function formatDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

export function parseImportBody(
  body: unknown,
): { ok: true; payload: ExportPayload } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const o = body as Record<string, unknown>;
  // 3 added projects; 2 (no projects) restores as before.
  if (o.version !== undefined && o.version !== 1 && o.version !== 2 && o.version !== 3) return { ok: false, error: "version must be 1, 2 or 3" };
  if (!Array.isArray(o.entries)) return { ok: false, error: "entries must be an array" };
  if (o.edges !== undefined && !Array.isArray(o.edges)) {
    return { ok: false, error: "edges must be an array" };
  }
  if (o.projects !== undefined && !Array.isArray(o.projects)) return { ok: false, error: "projects must be an array" };
  const edges = (o.edges ?? []) as ExportEdge[];
  if (o.entries.length + edges.length + ((o.projects as unknown[] | undefined)?.length ?? 0) > MANUAL_IMPORT_MAX_ROWS) {
    return { ok: false, error: `manual import is limited to ${MANUAL_IMPORT_MAX_ROWS} rows` };
  }
  return {
    ok: true,
    payload: {
      version: o.version as number | undefined,
      entries: o.entries as ExportEntry[],
      edges,
      projects: o.projects as ExportProject[] | undefined,
    },
  };
}

export function parseImportOffset(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function parseImportLimit(raw: string | null): number {
  if (!raw) return IMPORT_DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return IMPORT_DEFAULT_LIMIT;
  return Math.min(n, IMPORT_MAX_LIMIT);
}

/** Ids already present, split into live entries and trashed ones (a trashed id is restored, never overwritten). */
async function loadExistingIds(env: Env, ids: string[], withTrash = true): Promise<{ live: Set<string>; trashed: Map<string, string> }> {
  const live = new Set<string>();
  /** id -> the trash row's workspace, so a skip only names the trash for the importer's own rows. */
  const trashed = new Map<string, string>();
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      // scope-exempt: by-id: primary-key existence check for dedupe; a collision is skipped, never read
      `SELECT id FROM entries WHERE id IN (${placeholders})`,
    ).bind(...batch).all() as { results: { id: string }[] };
    for (const row of results) live.add(row.id);
    if (!withTrash) continue;
    const { results: inTrash } = await env.DB.prepare(
      // scope-exempt: by-id: primary-key existence check for dedupe; a trashed id is skipped, never read
      `SELECT id, workspace_id FROM entries_trash WHERE id IN (${placeholders})`,
    ).bind(...batch).all() as { results: { id: string; workspace_id: string }[] };
    for (const row of inTrash) trashed.set(row.id, row.workspace_id);
  }
  return { live, trashed };
}

/** Versions left behind by an earlier life of an id are dropped in the same batch that inserts it,
 * unless the id is live or trashed now (then the insert takes a fresh id and this history is theirs). */
function orphanVersionsStamp(env: Env, ids: string[]) {
  return env.DB.prepare(
    // scope-exempt: by-id: only orphan history for this import batch can be marked for deletion
    `UPDATE entry_versions SET write_marker = ?2 WHERE entry_id IN (SELECT value FROM json_each(?1))
       AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = entry_versions.entry_id)
       AND NOT EXISTS (SELECT 1 FROM entries_trash t WHERE t.id = entry_versions.entry_id)`,
  ).bind(JSON.stringify(ids), memoryWriteMarker(env, "delete"));
}
function orphanVersionsDelete(env: Env, ids: string[]) {
  return env.DB.prepare(
    // scope-exempt: by-id: history of ids this batch inserts fresh; an imported row starts with none
    `DELETE FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(?1))
       AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = entry_versions.entry_id)
       AND NOT EXISTS (SELECT 1 FROM entries_trash t WHERE t.id = entry_versions.entry_id)`,
  ).bind(JSON.stringify(ids));
}
/**
 * Codex review, T-0102, director follow-up MAJOR: the INSERT is a plain statement now, always
 * under the id this module already chose and pre-checked (see ENTRY_INSERT_SQL_TEMPLATE's own
 * comment) -- no more RETURNING, no more asking the database which id won. `original_id` reports
 * whichever earlier id this row's own id replaced -- only boundedEntryId's own length-based mint
 * now (round 2 re-review: a reused id is kept, never remapped), tracked in row.originalId.
 */
function importedResult(row: PendingInsert): ImportEntryResult {
  return row.originalId === undefined
    ? { id: row.id, status: "imported" }
    : { id: row.id, status: "imported", original_id: row.originalId };
}

/** A row already at this exact id with this exact content: the row this INSERT wanted to write
 * already exists, so a failed retry (a genuine concurrent-insert race resolved in this row's
 * favor by someone else, or this same import request itself retried by its caller) is this row's
 * own success arriving under someone else's write, not a new failure (director follow-up MAJOR:
 * "counts as a duplicate, not a new row"). */
async function isDuplicateRow(env: Env, row: PendingInsert): Promise<boolean> {
  const existing = await env.DB.prepare(
    // scope-exempt: by-id: this batch's own chosen id, already authorized to insert under writeCtx
    `SELECT content FROM entries WHERE id = ?`,
  ).bind(row.id).first<{ content: string }>();
  return existing?.content === row.content;
}

/** Whether an INSERT ... SELECT ... WHERE statement actually wrote its row (`changedRows`, D1's
 * `meta.changes` or the test doubles' own `meta.rows_written`, is the only signal: a false WHERE
 * is not an error). */
function insertLanded(res: { meta?: { changes?: number; rows_written?: number } } | undefined): boolean {
  return changedRows(res) > 0;
}

/** The compare-and-set every one of a row's OWN statements (its hold, its held event) shares
 * with its own INSERT (director follow-up MAJOR): content and created_at together are what this
 * row's own INSERT wrote, so a collision -- the id already belonged to a different, unrelated row
 * -- leaves every one of these guarded statements matching nothing, never corrupting that row. */
function rowGuard(row: PendingInsert): (p: PlaceholderSink) => string {
  return p => `content = ${p.add(row.content)} AND created_at = ${p.add(row.created_at)}`;
}

/** `auditEventStatement`'s (src/lib/audit.ts) plain, unconditional form would write a "held"
 * event even when this row's own INSERT lost its guard to a collision -- an orphaned event on
 * whatever unrelated row already owned the id. Guarded the same way holdStatements' own UPDATE
 * is, via rowGuard. */
function heldEventStatement(env: Env, row: PendingInsert, change: ChangeContext, reasons: HoldReason[], score: number, now: number): D1PreparedStatement {
  const p = new Params();
  const idIdx = p.add(row.id);
  const actorIdx = p.add(change.actorId);
  const payloadIdx = p.add(JSON.stringify({ reasons, score, channel: "rest" }));
  const nowIdx = p.add(now);
  // scope-exempt: by-id: this batch's own chosen id, already authorized to insert under writeCtx
  return env.DB.prepare(
    `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
     SELECT ${p.add(crypto.randomUUID())}, ${idIdx}, ${actorIdx}, 'held', ${payloadIdx}, ${nowIdx}
     WHERE EXISTS (SELECT 1 FROM entries WHERE id = ${idIdx} AND ${rowGuard(row)(p)})`,
  ).bind(...p.values());
}

async function loadExistingEdgeKeys(env: Env, endpoints: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!endpoints.length) return keys;
  for (let i = 0; i < endpoints.length; i += EDGE_ENDPOINT_QUERY_BATCH) {
    const batch = endpoints.slice(i, i + EDGE_ENDPOINT_QUERY_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      // scope-exempt: by-id: edge-key existence check for dedupe; endpoints are not read
      `SELECT source_id, target_id, type FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
    ).bind(...batch, ...batch).all() as {
      results: { source_id: string; target_id: string; type: string }[];
    };
    for (const row of results) keys.add(normalizedEdgeKey(row.source_id, row.target_id, row.type));
  }
  return keys;
}

export function parseEdgeWeight(
  weight: unknown,
): { ok: true; value: number } | { ok: false; reason: "invalid_weight" } {
  if (weight === undefined || weight === null) return { ok: true, value: DEFAULT_EDGE_WEIGHT };
  if (typeof weight !== "number" || !Number.isFinite(weight)) return { ok: false, reason: "invalid_weight" };
  return { ok: true, value: Math.max(0, Math.min(1, weight)) };
}

type NumericFieldReason =
  | "invalid_recall_count"
  | "invalid_importance_score"
  | "invalid_contradiction_wins"
  | "invalid_contradiction_losses";

export function parseOptionalNumber(
  value: unknown,
  invalidReason: NumericFieldReason,
): { ok: true; value: number } | { ok: false; reason: NumericFieldReason } {
  if (value === undefined || value === null) return { ok: true, value: 0 };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: invalidReason };
  return { ok: true, value };
}

export function parseCreatedAt(
  value: unknown,
): { ok: true; value: number } | { ok: false; reason: "invalid_created_at" } {
  if (value === undefined || value === null) return { ok: true, value: Date.now() };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "invalid_created_at" };
  return { ok: true, value };
}

function bindInsert(
  env: Env,
  row: PendingInsert,
  restoreLeaseOwner?: string,
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT,
) {
  return env.DB.prepare(ENTRY_INSERT_SQL).bind(
    row.id,
    row.content,
    JSON.stringify(row.tags),
    row.source,
    row.created_at,
    row.updatedAt,
    "[]",
    row.recall_count,
    row.importance_score,
    row.contradiction_wins,
    row.contradiction_losses,
    row.memory_tier,
    row.pinned ? 1 : 0,
    row.last_recalled_at,
    restoreLeaseOwner ?? null,
    restoreLeaseOwner ? null : memoryWriteMarker(env),
    writeCtx.workspaceId,
    writeCtx.actorId,
    row.when_at, row.when_kind, row.when_source, row.when_label,
    row.valid_from,
    row.valid_until,
  );
}

/**
 * Codex review, T-0102, director follow-up MAJOR: every statement one row's own write needs --
 * the INSERT, and for a held row `holdStatements` (the same real hold path captureEntry and
 * mirror.ts use) plus the held event -- in the SAME batch as the insert, so a row can never land
 * unheld. Every statement past the insert carries `rowGuard(row)`, the same compare-and-set the
 * insert's own `WHERE NOT EXISTS` guards against: a row whose insert lost to a collision leaves
 * its hold and event statements matching nothing, never landing on the unrelated row that already
 * held the id. `heldEventStatement` is this row's own guarded twin of the unconditional
 * `auditEventStatement` (src/lib/audit.ts) -- a dropped held event on an unattended, many-row
 * import is not the same risk as one on a single interactive capture, so this never fires blind.
 */
function rowStatements(
  env: Env, row: PendingInsert, writeCtx: WriteContext, change: ChangeContext, config: Readonly<Config>, now: number,
): D1PreparedStatement[] {
  const insert = bindInsert(env, row, undefined, writeCtx);
  if (!row.holdPlan) return [insert];
  const { reasons, score, signals } = row.holdPlan;
  const hold = holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: config.VERSION_KEEP }, {
    entryId: row.id, reasons, score, signals, change, heldTags: heldTagsFor(row.tags, reasons), now, guard: rowGuard(row),
  });
  const event = heldEventStatement(env, row, change, reasons, score, now);
  return [insert, ...hold, event];
}

/** One row's own atomic attempt, alone in its own batch: the row's insert, its orphan-version
 * cleanup, and (for a held row) its guarded hold and held event, all together or none at all. */
async function attemptInsertRow(
  env: Env, row: PendingInsert, writeCtx: WriteContext, change: ChangeContext, config: Readonly<Config>, now: number,
): Promise<boolean> {
  const written = await env.DB.batch([orphanVersionsStamp(env, [row.id]), orphanVersionsDelete(env, [row.id]), ...rowStatements(env, row, writeCtx, change, config, now)]);
  return insertLanded(written[2]);
}

/**
 * A row whose own INSERT did not land in the shared batch, whether the batch itself threw or the
 * row's own `WHERE NOT EXISTS` guard simply matched nothing (director follow-up MAJOR: "retry only
 * the rows that failed, keep their ids"). The retry is idempotent -- same id, same content, same
 * hold plan -- so it is safe to run even when the original failure had nothing to do with this row
 * (noisy neighbors in the shared batch). Only once that retry ALSO does not land -- a genuine,
 * still-live collision -- does this fall back to the pre-existing "mint a fresh id" behaviour
 * (round 2 re-review, id-uniqueness T-0089.1.1: "the row gets a fresh id"), itself one more fully
 * atomic attempt under a brand new id.
 */
async function retryInsertRow(
  env: Env, row: PendingInsert, writeCtx: WriteContext, change: ChangeContext, config: Readonly<Config>, now: number,
  existingIds: Set<string>, results: ImportResultItem[], counters: { imported: number; failed: number },
): Promise<void> {
  try {
    if (await attemptInsertRow(env, row, writeCtx, change, config, now)) {
      existingIds.add(row.id);
      counters.imported++;
      results.push(importedResult(row));
      return;
    }
  } catch (error) {
    if (isMemoryWriteFenceError(error)) throw error;
    // A thrown error on the same-id retry is treated the same as a silent `changes: 0` below:
    // either way this attempt did not land the row.
  }
  if (await isDuplicateRow(env, row)) {
    existingIds.add(row.id);
    results.push({ id: row.id, status: "skipped", reason: "already_imported" });
    return;
  }
  const fresh: PendingInsert = { ...row, id: crypto.randomUUID(), originalId: row.originalId ?? row.id };
  try {
    if (await attemptInsertRow(env, fresh, writeCtx, change, config, now)) {
      existingIds.add(fresh.id);
      counters.imported++;
      results.push(importedResult(fresh));
      return;
    }
    counters.failed++;
    results.push({ id: row.id, status: "failed", reason: "insert_error", detail: "collision persisted under a freshly minted id" });
  } catch (e) {
    if (isMemoryWriteFenceError(e)) throw e;
    counters.failed++;
    results.push({ id: row.id, status: "failed", reason: "insert_error", detail: formatDbError(e) });
  }
}

async function flushInsertBatch(
  env: Env,
  batch: PendingInsert[],
  existingIds: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number },
  writeCtx: WriteContext,
  config: Readonly<Config>,
  opts: ImportOptions,
): Promise<void> {
  if (!batch.length) return;

  await opts.beforeWriteBatch?.();
  if (opts.restoreLeaseOwner) {
    const stmts = batch.map(row => bindInsert(env, row, opts.restoreLeaseOwner,
      opts.preserveWriteContext ? { workspaceId: row.workspaceId, actorId: row.actorId } : writeCtx));
    let written: D1Result[];
    try { written = await env.DB.batch(stmts); }
    catch (error) {
      if (isMemoryWriteFenceError(error)) throw error;
      counters.failed += batch.length;
      for (const row of batch) results.push({ id: row.id, status: "failed", reason: "insert_error", detail: formatDbError(error) });
      return;
    }
    for (const [i, row] of batch.entries()) {
      existingIds.add(row.id);
      if (insertLanded(written[i])) { counters.imported++; results.push(importedResult(row)); }
      else results.push({ id: row.id, status: "skipped", reason: "already_imported" });
    }
    return;
  }
  const change: ChangeContext = { actorId: writeCtx.actorId, channel: "rest" };
  // trusted restoreの通常admission経路でも、各行の保存済みtenant/actorを保持する。
  const contextFor = (row: PendingInsert): WriteContext => opts.preserveWriteContext
    ? { workspaceId: row.workspaceId, actorId: row.actorId } : writeCtx;
  const now = Date.now();
  const orphanIds = batch.map(row => row.id);
  const perRow = batch.map(row => rowStatements(env, row, contextFor(row),
    { ...change, actorId: contextFor(row).actorId }, config, now));
  const stmts = [orphanVersionsStamp(env, orphanIds), orphanVersionsDelete(env, orphanIds), ...perRow.flat()];
  const collided: PendingInsert[] = [];
  try {
    const written = await env.DB.batch(stmts);
    // D1 batch() is one transaction (director follow-up MAJOR): every row above landed with its
    // own hold and held event together, or none of its statements landed at all. A row whose own
    // INSERT lost its `WHERE NOT EXISTS` guard to a genuine collision writes nothing here -- not a
    // thrown error, just `changes: 0` on its own INSERT -- and is retried alone below, same as a
    // row from a batch that threw outright.
    let offset = 2;
    for (const [i, row] of batch.entries()) {
      if (insertLanded(written[offset])) {
        existingIds.add(row.id);
        counters.imported++;
        results.push(importedResult(row));
      } else {
        collided.push(row);
      }
      offset += perRow[i].length;
    }
  } catch (error) {
    if (isMemoryWriteFenceError(error)) throw error;
    collided.push(...batch);
  }

  if (collided.length) await opts.beforeWriteBatch?.();
  for (const row of collided) {
    await retryInsertRow(env, row, contextFor(row), { ...change, actorId: contextFor(row).actorId }, config, now, existingIds, results, counters);
  }
}

/** Endpoint ids the importer can read: an id outside its workspaces reads exactly like a missing one. */
async function loadReadableIds(env: Env, ids: string[], readable: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const step = D1_MAX_BOUND_PARAMS - 1;
  for (let i = 0; i < ids.length; i += step) {
    const batch = ids.slice(i, i + step);
    const { results } = await env.DB.prepare(
      // scope-checked: workspace_id IN the importer's readable workspaces, bound as one JSON array
      `SELECT id FROM entries WHERE id IN (${batch.map(() => "?").join(", ")}) AND workspace_id IN (SELECT value FROM json_each(?))`,
    ).bind(...batch, JSON.stringify(readable)).all() as { results: { id: string }[] };
    for (const row of results) found.add(row.id);
  }
  return found;
}

function bindEdgeInsert(env: Env, edge: PendingEdge, restoreLeaseOwner: string | undefined, writeCtx: WriteContext, readable: string[] = [writeCtx.workspaceId]) {
  let source = edge.source_id;
  let target = edge.target_id;
  if (isValidEdgeType(edge.type) && isSymmetric(edge.type) && source > target) {
    [source, target] = [target, source];
  }
  return env.DB.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, restore_lease_owner, write_marker, workspace_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ${restoreLeaseOwner ? "1" : edgeEndpointsReadableSql("?", "?", "?")}
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET
       weight = max(weight, excluded.weight),
       updated_at = excluded.updated_at,
       restore_lease_owner = excluded.restore_lease_owner,
       write_marker = excluded.write_marker,
       workspace_id = excluded.workspace_id`,
  ).bind(
    edge.id, source, target, edge.type, edge.weight, edge.provenance, edge.metadata,
    edge.created_at, edge.updatedAt, restoreLeaseOwner ?? null,
    restoreLeaseOwner ? null : memoryWriteMarker(env), writeCtx.workspaceId,
    ...(restoreLeaseOwner ? [] : [source, JSON.stringify(readable), target, JSON.stringify(readable)]),
  );
}

async function flushEdgeBatch(
  env: Env,
  batch: PendingEdge[],
  existingEdgeKeys: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number; skipped: number },
  opts: Pick<ImportOptions, "restoreLeaseOwner" | "beforeWriteBatch" | "writeCtx" | "preserveWriteContext">,
): Promise<void> {
  if (!batch.length) return;

  await opts.beforeWriteBatch?.();
  const writeCtx = opts.writeCtx ?? OWNER_WRITE_CONTEXT;
  const contextFor = (row: PendingEdge): WriteContext => opts.preserveWriteContext
    ? { workspaceId: row.workspaceId, actorId: "" }
    : writeCtx;
  const stmts = batch.map(row => bindEdgeInsert(env, row, opts.restoreLeaseOwner, contextFor(row)));
  try {
    const written = await env.DB.batch(stmts);
    for (const [i, row] of batch.entries()) {
      const key = normalizedEdgeKey(row.source_id, row.target_id, row.type);
      existingEdgeKeys.add(key);
      // The guard refused it (an endpoint left the importer's reach since the pre-read): a plain skip.
      if ((written[i]?.meta?.changes ?? 1) === 0) { counters.skipped++; continue; }
      counters.imported++;
      results.push({
        source_id: row.source_id,
        target_id: row.target_id,
        type: row.type,
        status: "imported",
      });
    }
  } catch (error) {
    if (isMemoryWriteFenceError(error)) throw error;
    await opts.beforeWriteBatch?.();
    for (const row of batch) {
      try {
        const res = await bindEdgeInsert(env, row, opts.restoreLeaseOwner, contextFor(row)).run();
        const key = normalizedEdgeKey(row.source_id, row.target_id, row.type);
        existingEdgeKeys.add(key);
        if ((res?.meta?.changes ?? 1) === 0) { counters.skipped++; continue; }
        counters.imported++;
        results.push({
          source_id: row.source_id,
          target_id: row.target_id,
          type: row.type,
          status: "imported",
        });
      } catch (e) {
        counters.failed++;
        results.push({
          source_id: row.source_id,
          target_id: row.target_id,
          type: row.type,
          status: "failed",
          reason: "create_failed",
          detail: formatDbError(e),
        });
      }
    }
  }
}

const PROJECT_INSERT_SQL =
  `INSERT INTO projects (id, workspace_id, name, description, aliases, status, created_at, updated_at, restore_lease_owner, write_marker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO NOTHING`;

type ProjectImportRow = ImportedProject & { workspaceId: string };
function bindProjectInsert(env: Env, p: ProjectImportRow, opts: ImportOptions) {
  return env.DB.prepare(PROJECT_INSERT_SQL).bind(
    p.id, p.workspaceId, p.name, p.description, JSON.stringify(p.aliases), p.status, p.created_at, p.updatedAt,
    opts.restoreLeaseOwner ?? null, memoryWriteMarker(env),
  );
}

/** workspaceとslugの組を維持する。手動importでは呼出元workspaceへ正規化する。 */
async function importProjectsPage(
  env: Env,
  page: ExportProject[],
  writeCtx: WriteContext,
  results: ImportResultItem[],
  opts: ImportOptions,
): Promise<{ imported: number; skipped: number; failed: number }> {
  const counts = { imported: 0, skipped: 0, failed: 0 };
  if (!page.length) return counts;
  const valid: ProjectImportRow[] = [];
  for (const raw of page) {
    const p = parseImportedProject(raw);
    if (!p.ok) {
      counts.failed++;
      results.push({ project_id: p.id, status: "failed", reason: "invalid_project", detail: p.detail });
    } else {
      valid.push({ ...p.project, workspaceId: opts.preserveWriteContext && typeof raw.workspace_id === "string" ? raw.workspace_id : writeCtx.workspaceId });
    }
  }
  if (!valid.length) return counts;
  const existing = new Set<string>();
  const key = (ws: string, id: string) => JSON.stringify([ws, id]);
  for (let i = 0; i < valid.length; i += Math.floor(D1_MAX_BOUND_PARAMS / 2)) {
    const slice = valid.slice(i, i + Math.floor(D1_MAX_BOUND_PARAMS / 2));
    const rows = await env.DB.prepare(
      `SELECT workspace_id, id FROM projects WHERE ${slice.map(() => "(workspace_id = ? AND id = ?)").join(" OR ")}`,
    ).bind(...slice.flatMap(p => [p.workspaceId, p.id])).all<{ workspace_id: string; id: string }>();
    for (const row of rows.results) existing.add(key(row.workspace_id, row.id));
  }
  const pending: ProjectImportRow[] = [];
  for (const p of valid) {
    const k = key(p.workspaceId, p.id);
    if (existing.has(k)) { counts.skipped++; continue; }
    existing.add(k);
    pending.push(p);
  }
  for (let i = 0; i < pending.length; i += IMPORT_D1_BATCH_SIZE) {
    const chunk = pending.slice(i, i + IMPORT_D1_BATCH_SIZE);
    const settle = (p: ProjectImportRow) => { counts.imported++; results.push({ project_id: p.id, status: "imported" }); };
    await opts.beforeWriteBatch?.();
    try {
      await env.DB.batch(chunk.map(p => bindProjectInsert(env, p, opts)));
      chunk.forEach(settle);
    } catch (e) {
      if (isMemoryWriteFenceError(e)) throw e;
      await opts.beforeWriteBatch?.();
      for (const p of chunk) {
        try { await bindProjectInsert(env, p, opts).run(); settle(p); }
        catch (e) {
          if (isMemoryWriteFenceError(e)) throw e;
          counts.failed++;
          results.push({ project_id: p.id, status: "failed", reason: "insert_error", detail: formatDbError(e) });
        }
      }
    }
  }
  return counts;
}

/**
 * One page of a restore. `offset`/`edgeOffset` are positions in the payload arrays,
 * and a call examines exactly one phase: entries[offset .. offset+limit), or — only
 * when the call starts with entries exhausted — edges[edgeOffset .. edgeOffset+limit).
 *
 * Positional paging is what keeps the cost flat on the D1 free plan (~50 queries per
 * invocation). Each page resolves only its own ids: one chunked existence lookup plus
 * one insert batch, so a default page costs 2-3 round trips whether the file holds
 * 12 entries or 50,000, and page 500 costs the same as page 1. The alternative —
 * scanning from the top and skipping — re-resolves every already-imported id on
 * every call, which is how a 5,000-entry restore spends its whole daily budget
 * before finishing.
 *
 * Re-running a page is safe: existing ids and edge keys are skipped, and the
 * ON CONFLICT upsert makes a re-inserted edge a weight merge rather than an error.
 * Projects page the same way once entries are done, and an existing project is kept.
 */
/**
 * Entries in insertion order for a restore: oldest created_at first, ties in file order, a missing
 * created_at last (it is stamped with now) and an unusable one last too (parseEntryRow will fail it anyway). rowids then follow time on a restored brain,
 * which the keyword AND tier's newest-first index scan relies on, whatever order the file is in
 * (exports before that order was fixed are newest first). Pages are positions in this order, so a
 * client must resend the same file for every page, which every client already does.
 */
function oldestFirst(entries: ExportEntry[]): ExportEntry[] {
  // Mirrors parseCreatedAt: null and undefined are stamped with the current time (newest), and anything
  // else that is not a finite number is rejected, so its position is moot; all of them sort last.
  const at = (entry: ExportEntry) => {
    const value = (entry as { created_at?: unknown } | null)?.created_at;
    return typeof value === "number" && Number.isFinite(value) ? value : Infinity;
  };
  return entries.map((entry, order) => ({ entry, order, at: at(entry) }))
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map(({ entry }) => entry);
}

export async function importExportPayload(
  env: Env,
  body: ExportPayload,
  opts: ImportOptions = {},
): Promise<ImportSummary> {
  await assertMemoryWritesAllowed(env, opts.writeLockOwner);
  const limit = opts.limit ?? IMPORT_DEFAULT_LIMIT;
  // R2の再開cursorは旧ファイル内位置を指す。新規HTTP importだけ時系列へ並べる。
  const entries = opts.restoreLeaseOwner ? body.entries : oldestFirst(body.entries);
  const edges = body.edges ?? [];
  const projects = body.projects ?? [];
  const projectOffset = Math.min(Math.max(opts.projectOffset ?? 0, 0), projects.length);
  const writeCtx = opts.writeCtx ?? OWNER_WRITE_CONTEXT;
  const offset = Math.min(Math.max(opts.offset ?? 0, 0), entries.length);
  const edgeOffset = Math.min(Math.max(opts.edgeOffset ?? 0, 0), edges.length);
  // Import edges are automatic (round 5): both endpoints in the importer's own workspace, where the
  // imported entries land and the edge is stamped. Anything else is skipped like a missing endpoint.
  const readable = [writeCtx.workspaceId];

  const results: ImportResultItem[] = [];
  let imported = 0;
  let skipped = 0;
  let skipped_too_large = 0;
  let failed = 0;
  let edges_imported = 0;
  let edges_skipped = 0;
  let edges_failed = 0;

  // ---- entries page ------------------------------------------------------------
  const page = entries.slice(offset, offset + limit);
  let next_offset = offset;

  // Codex review, T-0102 B1: an import is scored on the rest channel like any other REST write,
  // so genuinely suspicious imported content is held rather than landing straight into recall.
  // Resolved once, even for an empty page -- cheap, and cached the same as every other config read.
  const config: Readonly<Config> = await resolveConfig(env);

  // Parse the whole page before touching D1, so the existence lookup can be one
  // chunked query over exactly the ids that might insert.
  const parsedPage: ({ row: PendingInsert } | { failure: ImportEntryResult })[] = [];
  let manualWriteBudget = 0;
  for (const entry of page) {
    const parsed = parseEntryRow(entry, opts.enforceIndexLimits === true, opts.preserveWriteContext === true);
    // One rule for every caller-chosen id (T-0089.1.1): over MAX_ENTRY_ID_BYTES it would leave no room
    // for the per-upload vector suffix under Vectorize's 64-byte limit, so the row takes a minted id.
    if ("row" in parsed && !opts.restoreLeaseOwner) {
      const bounded = await boundedEntryId(parsed.row.id);
      if (bounded !== parsed.row.id) parsed.row = { ...parsed.row, originalId: parsed.row.id, id: bounded };
      parsed.row = { ...parsed.row, holdPlan: importHoldPlan(parsed.row, config) };
    }
    if (!opts.restoreLeaseOwner && "row" in parsed) {
      // 通常1 statement、holdはINSERT + snapshot/cleanup/update/prune + eventの6。
      // 初回 + 同ID retry + 衝突照合 + 新ID retry、retryごとのorphan stamp/delete。
      const cost = 3 * (parsed.row.holdPlan ? 6 : 1) + 5;
      if (manualWriteBudget + cost > IMPORT_MANUAL_WRITE_BUDGET) break;
      manualWriteBudget += cost;
    }
    parsedPage.push(parsed);
    next_offset++;
  }

  // Codex review, T-0102 B3, then director follow-up MAJOR (round 2 re-review): a reused id used
  // to mint a fresh one instead, which drops edges (endpoints are matched by id) and makes a
  // repeated import of the same file re-insert everything under new ids on every run. Reversed:
  // the id is always kept, and no entry_events row is ever deleted -- a purged row's audit trail
  // is permanent, and reusing its freed id no longer inherits it, because readEntryTimeline (and
  // every other caller of it) now filters events to the live row's own created_at forward. Edges
  // and repeated imports work the same way 3.7 always did.
  const pageIds = [...new Set(parsedPage.flatMap(p => ("row" in p ? [p.row.id] : [])))];
  const { live: existingIds, trashed: trashedIds } = await loadExistingIds(env, pageIds);

  let skipped_in_trash = 0;

  const pendingBatch: PendingInsert[] = [];
  const batchCounters = { imported: 0, failed: 0 };
  let importedStanding = false;
  for (const p of parsedPage) {
    if ("failure" in p) {
      // "skipped" (currently only the too_large case) is not a validation failure: the record
      // is well-formed, it is simply over Rahil's 128 KB cap, and the whole import must not
      // fail because of it — see the copy deck's own distinct import summary line for it.
      if (p.failure.status === "skipped") {
        skipped++;
        skipped_too_large++;
      } else {
        failed++;
      }
      results.push(p.failure);
      continue;
    }
    if (trashedIds.has(p.row.id)) {
      skipped++;
      // Only the importer's own trash is named (restore it instead); another workspace's trash row
      // is a plain skip, the same as a live id elsewhere, so the reply never says where an id lives.
      if (trashedIds.get(p.row.id) === writeCtx.workspaceId) {
        skipped_in_trash++;
        results.push({ id: p.row.id, status: "skipped", reason: "in_trash" });
      }
      continue;
    }
    if (existingIds.has(p.row.id)) {
      skipped++;
      continue;
    }
    // Marking the id as seen at queue time makes a duplicate later in the same page
    // a skip; letting it into the batch would be a PRIMARY KEY conflict that fails
    // the whole batch into the per-row fallback.
    existingIds.add(p.row.id);
    pendingBatch.push(p.row);
    if (p.row.tags.includes("standing:active")) importedStanding = true;

    if (pendingBatch.length >= IMPORT_D1_BATCH_SIZE) {
      await flushInsertBatch(env, pendingBatch.splice(0), existingIds, results, batchCounters, writeCtx, config, opts);
    }
  }
  if (pendingBatch.length) {
    await flushInsertBatch(env, pendingBatch.splice(0), existingIds, results, batchCounters, writeCtx, config, opts);
  }
  imported += batchCounters.imported;
  failed += batchCounters.failed;
  if (opts.ctx && importedStanding) standingTouched(env, opts.ctx, await resolveConfig(env), [writeCtx.workspaceId]);

  const remaining_entries = entries.length - next_offset;

  // ---- edges page --------------------------------------------------------------
  // Deferred until the entries array is exhausted, so every endpoint an edge can
  // name either predates this import or was written by an earlier page.
  let next_edge_offset = edgeOffset;
  let next_project_offset = projectOffset;
  let projectCounts = { imported: 0, skipped: 0, failed: 0 };
  if (offset >= entries.length) {
    const edgePage = edges.slice(edgeOffset, edgeOffset + limit);
    next_edge_offset = edgeOffset + edgePage.length;

    type ParsedEdge = { edge: PendingEdge } | { failure: ImportEdgeResult };
    const parsedEdges: ParsedEdge[] = [];
    for (const edge of edgePage) {
      const parsed = parseEdgeRow(edge, opts.preserveWriteContext === true);
      // An endpoint over MAX_ENTRY_ID_BYTES was imported under its minted id: follow it there.
      if ("edge" in parsed && !opts.restoreLeaseOwner) {
        const [source_id, target_id] = await Promise.all([boundedEntryId(parsed.edge.source_id), boundedEntryId(parsed.edge.target_id)]);
        parsed.edge = { ...parsed.edge, source_id, target_id };
      }
      parsedEdges.push(parsed);
    }

    // Endpoints the importer can READ, in one chunked scoped query. existingIds is not enough: it
    // also holds ids that exist in other workspaces (the entries page skips those), and an edge to
    // one would put a private id in this importer's export.
    const endpoints = [
      ...new Set(parsedEdges.flatMap(p => ("edge" in p ? [p.edge.source_id, p.edge.target_id] : []))),
    ];
    const readableIds = opts.preserveWriteContext ? (await loadExistingIds(env, endpoints, false)).live : await loadReadableIds(env, endpoints, readable);
    const existingEdgeKeys = await loadExistingEdgeKeys(env, endpoints);

    const pendingEdgeBatch: PendingEdge[] = [];
    const edgeBatchCounters = { imported: 0, failed: 0, skipped: 0 };
    for (const p of parsedEdges) {
      if ("failure" in p) {
        edges_failed++;
        results.push(p.failure);
        continue;
      }
      const { source_id, target_id, type } = p.edge;
      // Missing or not readable: the same plain skip, so the reply never says an id exists elsewhere.
      if (!readableIds.has(source_id) || !readableIds.has(target_id)) {
        edges_skipped++;
        continue;
      }
      const edgeKey = normalizedEdgeKey(source_id, target_id, type);
      if (existingEdgeKeys.has(edgeKey)) {
        edges_skipped++;
        continue;
      }
      existingEdgeKeys.add(edgeKey);
      pendingEdgeBatch.push(p.edge);

      if (pendingEdgeBatch.length >= IMPORT_D1_BATCH_SIZE) {
        await flushEdgeBatch(env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters, opts);
      }
    }
    if (pendingEdgeBatch.length) {
      await flushEdgeBatch(env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters, opts);
    }
    edges_imported += edgeBatchCounters.imported;
    edges_failed += edgeBatchCounters.failed;
    edges_skipped += edgeBatchCounters.skipped;

    // Projectsは次の呼出しで処理し、edge書込みとSQL予算を分ける。
  }
  if (offset >= entries.length && edgeOffset >= edges.length) {
    const projectPage = projects.slice(projectOffset, projectOffset + limit);
    next_project_offset = projectOffset + projectPage.length;
    projectCounts = await importProjectsPage(env, projectPage, writeCtx, results, opts);
  }

  return {
    ok: true,
    imported,
    skipped,
    skipped_in_trash,
    skipped_too_large,
    failed,
    edges_imported,
    edges_skipped,
    edges_failed,
    projects_imported: projectCounts.imported,
    projects_skipped: projectCounts.skipped,
    projects_failed: projectCounts.failed,
    remaining_entries,
    remaining_edges: edges.length - next_edge_offset,
    remaining_projects: projects.length - next_project_offset,
    next_offset,
    next_edge_offset,
    next_project_offset,
    results,
    vectorize_hint: "POST /vectorize-pending until remaining is 0",
  };
}

/** Parse one entry row into an insertable record, or the failure to report. */
function parseEntryRow(
  entry: ExportEntry,
  enforceIndexLimits: boolean,
  preserveWriteContext = false,
): { row: PendingInsert } | { failure: ImportEntryResult } {
  if (!isImportRecordObject(entry)) {
    return { failure: { id: "", status: "failed", reason: "invalid_entry" } };
  }
  const idParsed = parseRequiredString(entry.id, "missing_id", "invalid_id");
  if (!idParsed.ok) {
    const id = typeof entry.id === "string" ? entry.id : String(entry.id ?? "");
    return { failure: { id, status: "failed", reason: idParsed.reason } };
  }
  const validId = validateImportId(idParsed.value, "invalid_id");
  if (!validId.ok) {
    return { failure: { id: idParsed.value, status: "failed", reason: validId.reason } };
  }
  const id = validId.value;

  const contentParsed = parseContent(entry.content);
  if (!contentParsed.ok) return { failure: { id, status: "failed", reason: contentParsed.reason } };
  // Rahil's decision (18-copy-deck.md 6.8): 128 KB per note is the cap on a NEW capture. A 3.7
  // export can carry a note that was already over it (Codex review, T-0102 B2: skipping it here
  // silently lost real data on an upgrade). Import keeps the row instead, forced held too_long by
  // applyImportHold below -- the same state a too-long note reaches on a fresh 4.0 write, never
  // scanned or embedded until the owner reads it and releases it.

  // Read before parseTags strips it along with every other reserved tag: a real hold
  // (quarantine:<recognized reason>) on the exported row must survive the import, not silently
  // become an ordinary, indexable row (Codex review, T-0102 B1, then director follow-up: honored
  // unconditionally, matching isHeld/heldReason's own simplified rule -- a recognized reason is
  // never coincidental, whatever its other tags, status:draft included or not).
  const rawTags = Array.isArray(entry.tags) ? normalizeTagList(entry.tags) : [];
  const originalHoldReason = heldReason(rawTags);
  const tagsParsed = preserveWriteContext && Array.isArray(entry.tags) && entry.tags.every(t => typeof t === "string")
    ? { ok: true as const, tags: entry.tags } : parseTags(entry.tags);
  if (!tagsParsed.ok) return { failure: { id, status: "failed", reason: tagsParsed.reason } };

  let source = "import";
  if (entry.source !== undefined && entry.source !== null) {
    if (typeof entry.source !== "string") {
      return { failure: { id, status: "failed", reason: "invalid_source" } };
    }
    // Export/restore is a round trip, not a data-cleaning boundary. New capture
    // already canonicalizes source, while a legacy owner-defined value must not
    // change merely because it passed through R2. The backup mirror gate trims
    // only for classification, so padded provider IDs are rejected, not laundered.
    source = entry.source;
  }

  const createdAtParsed = parseCreatedAt(entry.created_at);
  if (!createdAtParsed.ok) return { failure: { id, status: "failed", reason: createdAtParsed.reason } };
  const created_at = createdAtParsed.value;

  // Absent in exports taken before /export carried the field; created_at is what the
  // column would have coalesced to anyway. A restore must not launder a bad value into
  // a "recently touched" ranking signal, so a malformed one fails the row instead.
  const rawUpdatedAt = entry.updated_at ?? created_at;
  if (typeof rawUpdatedAt !== "number" || !Number.isFinite(rawUpdatedAt)) {
    return { failure: { id, status: "failed", reason: "invalid_updated_at" } };
  }
  // Cap at now (R4-U1/U2/U3): every writer clamps updated_at to MAX(now, prev + 1) to keep it
  // strictly increasing, but that clamp is a no-op once prev is already >= now (a future date or
  // a huge exported value) — the next edit's own clamp can never move it, the digest guard then
  // treats every later edit as unseen, and entry_versions.created_at/valid_from (themselves
  // clamped against this column) inherit the poisoned value forever. An uncapped import launders
  // exactly the bad value the check above already refuses to accept unbounded.
  const updatedAt = Math.min(rawUpdatedAt, Date.now());

  const recallCountParsed = parseOptionalNumber(entry.recall_count, "invalid_recall_count");
  if (!recallCountParsed.ok) return { failure: { id, status: "failed", reason: recallCountParsed.reason } };
  const importanceParsed = parseOptionalNumber(entry.importance_score, "invalid_importance_score");
  if (!importanceParsed.ok) return { failure: { id, status: "failed", reason: importanceParsed.reason } };
  const winsParsed = parseOptionalNumber(entry.contradiction_wins, "invalid_contradiction_wins");
  if (!winsParsed.ok) return { failure: { id, status: "failed", reason: winsParsed.reason } };
  const lossesParsed = parseOptionalNumber(entry.contradiction_losses, "invalid_contradiction_losses");
  if (!lossesParsed.ok) return { failure: { id, status: "failed", reason: lossesParsed.reason } };

  const memoryTier = entry.memory_tier ?? "warm";
  if (!isMemoryTier(memoryTier)) {
    return { failure: { id, status: "failed", reason: "invalid_memory_tier" } };
  }
  const pinned = entry.pinned ?? false;
  if (typeof pinned !== "boolean") {
    return { failure: { id, status: "failed", reason: "invalid_pinned" } };
  }
  const lastRecalledAt = entry.last_recalled_at ?? null;
  if (lastRecalledAt !== null && (typeof lastRecalledAt !== "number" || !Number.isFinite(lastRecalledAt))) {
    return { failure: { id, status: "failed", reason: "invalid_last_recalled_at" } };
  }

  const whenAt = entry.when_at ?? null;
  const whenKind = entry.when_kind ?? null;
  const whenSource = entry.when_source ?? null;
  const whenLabel = entry.when_label ?? null;
  if ((whenAt !== null && (typeof whenAt !== "number" || !Number.isSafeInteger(whenAt) || !Number.isFinite(new Date(whenAt).getTime())))
    || (whenKind !== null && !["due", "event", "wake"].includes(whenKind))
    || (whenSource !== null && !["explicit", "regex", "model", "cleared"].includes(whenSource))
    || (whenLabel !== null && (typeof whenLabel !== "string" || whenLabel.length > 120 || whenLabel.includes("\0")))) {
    return { failure: { id, status: "failed", reason: "invalid_when" } };
  }

  const workspaceId = preserveWriteContext ? entry.workspace_id ?? "" : "";
  const actorId = preserveWriteContext ? entry.actor_id ?? "" : "";
  if (typeof workspaceId !== "string" || typeof actorId !== "string"
    || workspaceId.includes("\0") || actorId.includes("\0")
    || new TextEncoder().encode(workspaceId).byteLength > MAX_IMPORT_ID_BYTES
    || new TextEncoder().encode(actorId).byteLength > MAX_IMPORT_ID_BYTES) {
    return { failure: { id, status: "failed", reason: "invalid_write_context" } };
  }

  if (enforceIndexLimits) {
    try {
      validateIndexableMemory(id, contentParsed.value, tagsParsed.tags, source);
    } catch (error) {
      if (error instanceof MemoryInputError) {
        return { failure: { id, status: "failed", reason: "index_limit", detail: error.message } };
      }
      throw error;
    }
  }

  return {
    row: {
      id,
      content: contentParsed.value,
      tags: tagsParsed.tags,
      source,
      created_at,
      updatedAt,
      recall_count: recallCountParsed.value,
      importance_score: importanceParsed.value,
      contradiction_wins: winsParsed.value,
      contradiction_losses: lossesParsed.value,
      memory_tier: memoryTier,
      pinned,
      last_recalled_at: lastRecalledAt,
      when_at: whenAt, when_kind: whenKind, when_source: whenSource, when_label: whenLabel,
      workspaceId,
      actorId,
      originalHoldReason,
      ...importedWindow(entry.valid_from, entry.valid_until, created_at),
    },
  };
}

/** What a held imported row needs to write a real hold (holdStatements): the reasons, and the
 * score/signals a fresh scoreWrite computed regardless of which reason ultimately wins. */
interface ImportHoldPlan { reasons: HoldReason[]; score: number; signals: SignalHit[] }

/**
 * Codex review, T-0102 B1: an imported row is scored on the rest channel like any other REST
 * write (import previously reached storeEntry/scoreWrite never at all), and a real hold the
 * export's own tags carried (originalHoldReason, read before parseTags stripped it, honored
 * unconditionally -- director follow-up) survives the import rather than silently becoming an
 * ordinary, indexable row. Scoring wins the reason when both apply -- it is the richer,
 * freshly-computed signal; the export's own reason is the fallback when scoring alone would not
 * have held this content today.
 *
 * Director follow-up MAJOR: a held import used to be nothing more than these tags stamped
 * straight into the INSERT -- no hold version, no held event, so Release (which resolves through
 * a version chain) and the Held feed (which reads from entry_events) never worked on it. The plan
 * this returns is null for an ordinary row and the reasons/score/signals a held one needs; the
 * caller runs holdStatements for it once the INSERT's own RETURNING id is known (see
 * flushInsertBatch), the same real hold path captureEntry and mirror.ts use.
 */
function importHoldPlan(row: PendingInsert, config: Readonly<Config>): ImportHoldPlan | null {
  const score = scoreWrite(
    { content: row.content, tags: row.tags, source: row.source, channel: "rest", kind: "create" },
    config,
  );
  const decision = holdDecision(score);
  // Over the 128 KB cap is too_long regardless of what the scorer itself concluded (it would
  // already agree in practice -- the cap is well past the scorer's own 32 KB scan budget, so
  // this content is always `partial` -- but explicit here rather than relying on that overlap).
  const reasons: HoldReason[] | null = isOverContentLimit(row.content)
    ? ["too_long"]
    : decision.hold ? decision.reasons : row.originalHoldReason ? [row.originalHoldReason] : null;
  return reasons ? { reasons, score: score.score, signals: score.signals } : null;
}

/**
 * The validity window an exported row carried (T-0089.2.1). An import only inserts, so it never
 * supersedes anything; a malformed or inverted window is dropped (NULL, "since created_at, still
 * true") rather than failing the memory, since the writers' invariant is until >= effective start.
 * So is a date in the future: validity dates are for what has already happened (P5), and an export
 * only ever holds dates at or before the moment it was taken.
 */
function importedWindow(from: unknown, until: unknown, createdAt: number, now = Date.now()): { valid_from: number | null; valid_until: number | null } {
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= now ? v : v === undefined || v === null ? null : NaN;
  const f = num(from);
  const u = num(until);
  if (Number.isNaN(f) || Number.isNaN(u)) return { valid_from: null, valid_until: null };
  if (u !== null && u < (f ?? createdAt)) return { valid_from: null, valid_until: null };
  return { valid_from: f, valid_until: u };
}

/** Parse one edge row into an insertable record, or the failure to report. */
function parseEdgeRow(
  edge: ExportEdge,
  preserveWriteContext = false,
): { edge: PendingEdge } | { failure: ImportEdgeResult } {
  if (!isImportRecordObject(edge)) {
    return { failure: { source_id: "", target_id: "", type: "", status: "failed", reason: "invalid_edge" } };
  }
  const sourceParsed = parseRequiredString(edge.source_id, "missing_endpoint", "invalid_endpoint");
  const targetParsed = parseRequiredString(edge.target_id, "missing_endpoint", "invalid_endpoint");
  const type = typeof edge.type === "string" ? edge.type.trim() || "relates_to" : "relates_to";
  const workspaceId = preserveWriteContext ? edge.workspace_id ?? "" : "";
  if (typeof workspaceId !== "string" || workspaceId.includes("\0")
    || new TextEncoder().encode(workspaceId).byteLength > MAX_IMPORT_ID_BYTES) {
    return {
      failure: {
        source_id: typeof edge.source_id === "string" ? edge.source_id : "",
        target_id: typeof edge.target_id === "string" ? edge.target_id : "",
        type,
        status: "failed",
        reason: "invalid_write_context",
      },
    };
  }

  if (!sourceParsed.ok || !targetParsed.ok) {
    const reason = !sourceParsed.ok ? sourceParsed.reason : !targetParsed.ok ? targetParsed.reason : "missing_endpoint";
    return {
      failure: {
        source_id: typeof edge.source_id === "string" ? edge.source_id : String(edge.source_id ?? ""),
        target_id: typeof edge.target_id === "string" ? edge.target_id : String(edge.target_id ?? ""),
        type,
        status: "failed",
        reason,
      },
    };
  }
  const validSource = validateImportId(sourceParsed.value, "invalid_endpoint");
  const validTarget = validateImportId(targetParsed.value, "invalid_endpoint");
  if (!validSource.ok || !validTarget.ok) {
    return {
      failure: {
        source_id: sourceParsed.value,
        target_id: targetParsed.value,
        type,
        status: "failed",
        reason: "invalid_endpoint",
      },
    };
  }
  const source_id = validSource.value;
  const target_id = validTarget.value;

  if (!isValidEdgeType(type)) {
    return { failure: { source_id, target_id, type, status: "failed", reason: "invalid_type" } };
  }
  // The capture path never creates these (graph/edges.ts returns null), so one in a
  // payload is hand-edited data the graph should not inherit.
  if (source_id === target_id) {
    return { failure: { source_id, target_id, type, status: "failed", reason: "self_edge" } };
  }
  const weightParsed = parseEdgeWeight(edge.weight);
  if (!weightParsed.ok) {
    return { failure: { source_id, target_id, type, status: "failed", reason: weightParsed.reason } };
  }
  const provenance =
    edge.provenance && typeof edge.provenance === "string" && isValidProvenance(edge.provenance)
      ? edge.provenance
      : "explicit";
  const rawId = edge.id ?? crypto.randomUUID();
  const idParsed = parseRequiredString(rawId, "missing_id", "invalid_id");
  if (!idParsed.ok) {
    return { failure: { source_id, target_id, type, status: "failed", reason: idParsed.reason } };
  }
  const validId = validateImportId(idParsed.value, "invalid_id");
  if (!validId.ok) {
    return { failure: { source_id, target_id, type, status: "failed", reason: validId.reason } };
  }
  const metadata = edge.metadata ?? {};
  if (!isImportRecordObject(metadata)) {
    return { failure: { source_id, target_id, type, status: "failed", reason: "invalid_metadata" } };
  }
  const createdAtParsed = parseCreatedAt(edge.created_at);
  if (!createdAtParsed.ok) {
    return { failure: { source_id, target_id, type, status: "failed", reason: createdAtParsed.reason } };
  }
  const created_at = createdAtParsed.value;
  const updatedAt = edge.updated_at ?? created_at;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    return { failure: { source_id, target_id, type, status: "failed", reason: "invalid_updated_at" } };
  }

  return {
    edge: {
      id: validId.value,
      source_id,
      target_id,
      type,
      weight: weightParsed.value,
      provenance,
      metadata: JSON.stringify(metadata),
      created_at,
      updatedAt,
      workspaceId,
    },
  };
}
