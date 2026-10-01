import { executeVectorCleanupMock } from "./vector-cleanup-mock";
import { COMPRESSION_IMPORTANCE_THRESHOLD, COMPRESSION_MIN_RECALL, isCompressionTag, isTopicTag } from "../../src/compression/eligibility";
import { SCHEMA_PROBE_RESULTS, TRIGGER_DDL, FTS_TABLE_DDL } from "./schema-probe";
import { NOT_HELD_SQL } from "../../src/quarantine/tags";
/**
 * Decode a `%"tag"%` bind parameter back to the tag, undoing tagLikePattern's escaping.
 *
 * Production escapes % and _ in the tag and pairs the clause with ESCAPE '\\', so a tag
 * `q3_planning` arrives here as `%"q3\\_planning"%`. Without this the double would look for
 * a tag spelled with a backslash and silently match nothing.
 */
const tagFromLikePattern = (pattern: string) =>
  pattern.replace(/%"/g, "").replace(/"%/g, "").replace(/\\([%_\\])/g, "$1");
/**
 * Does this tag array satisfy `tags LIKE '%"<tag>"%'`?
 *
 * MODELS: ASCII case-insensitivity. SQLite's LIKE matches `Work` for `%"work"%`, and
 * comparing case-sensitively here would make the double disagree with production on exactly
 * the inputs behind #278's rollup bug, where the candidate `Kind:Semantic` selected — and
 * rolled up — every entry carrying `kind:semantic`. test/unit/d1-mock-fidelity.test.ts pins
 * this; do not "simplify" it back to Array.includes.
 *
 * DOES NOT MODEL, so a green test here is NOT coverage of any of these:
 *   - LIKE wildcards in the tag. Real `%"q3_planning"%` also matches `q3-planning`, and
 *     `%"%"%` matches every row; this matches exactly one tag either way. That is why P1's
 *     escaping bug is covered against real SQLite in test/integration/, not here.
 *   - JSON escaping. A tag containing a quote is stored as \\" so real LIKE misses it;
 *     this compares the decoded strings and matches.
 *   - Unicode case folding. SQLite's LIKE is ASCII-only; toLowerCase is not, so this
 *     matches `Σ`/`σ` where real LIKE does not.
 * Anything whose subject is the pattern rather than the tag belongs in a real-SQLite test.
 */
const tagMatchesLike = (tags: string[], tag: string) =>
  tags.some(t => t.toLowerCase() === tag.toLowerCase());
/**
 * Values bound through a Params-numbered statement (`?1..?n`, dense, values reused by identity —
 * ADV-1/ADV-2/Task 6), in the order their placeholders appear in the SQL text. `Params` gives a
 * value REUSED verbatim (e.g. tags unchanged: the SET clause and the CAS guard bind the same
 * string) the SAME number, so `args` can be shorter than the number of semantic slots a statement
 * has — indexing positionally into `args` the way earlier, unnumbered branches in this file do
 * would silently misread every slot after the first reuse. This resolves each occurrence back to
 * its real value by placeholder number instead.
 */
function placeholderArgs(sql: string, args: unknown[]): unknown[] {
  return [...sql.matchAll(/\?(\d+)/g)].map(m => args[Number(m[1]) - 1]);
}
export class D1Mock {
  schemaVersion: number | null = 9;
  entries: any[] = [];
  edges: any[] = [];
  insightCandidates: any[] = [];
  /** entries_trash rows written by the forget batch (the statements the mock models are the trash ones only). */
  trash: any[] = [];
  // Tenancy rows, populated by the real ensureTenantBootstrap when a route's
  // requireIdentity runs against this double. The statements it issues are
  // modelled just faithfully enough for the owner identity to resolve; member
  // provisioning is covered against real SQLite in test/integration/.
  users: any[] = [];
  workspaces: any[] = [];
  memberships: any[] = [];
  maintenanceWorkspace = "";
  failEntryInsertIds = new Set<string>();
  failEdgeInsertIds = new Set<string>();
  migrationControl: {
    id: string;
    locked_at: number;
    reason: string;
    owner_id: string | null;
    final_delta_completed_at: number | null;
    active_delta_token: string | null;
    active_delta_expires_at: number | null;
  } | null = null;
  memoryWriteEpoch: string | null = "d1-mock-generation";
  memoryWriteAdmissions = new Map<string, { started_at: number; expires_at: number; generation: string | null }>();
  embeddingMigrationGeneration: string | null = null;
  integrationStateGeneration: { generation: string; restore_count: number } | null = {
    generation: "d1-mock-integration-generation",
    restore_count: 0,
  };
  integrationProviderGenerations = new Map<string, {
    generation: string;
    version: number;
    draining: number;
    lease_owner: string | null;
    lease_expires_at: number | null;
  }>();
  vectorCleanupOps: { op_id: string; entry_id: string; vector_ids: string; created_at: number; ready: number; expires_at: number; write_marker?: string | null }[] = [];
  appendReceipts: { entry_id: string; operation_id: string; request_hash: string; indexed: number; completed_at: number }[] = [];
  restoreState: {
    id: string;
    backup_id: string;
    backup_sha256: string | null;
    run_id: string;
    started_at: number;
    next_offset: number;
    next_edge_offset: number;
    next_project_offset?: number;
    next_history_offset?: number;
    completed_at: number | null;
    lease_owner: string | null;
    lease_expires_at: number | null;
  } | null = null;
  hasActiveMigrationLock(now = Date.now()): boolean {
    const control = this.migrationControl;
    return control !== null && !(control.reason === "r2-backup-snapshot"
      && control.active_delta_expires_at !== null
      && control.active_delta_expires_at <= now);
  }
  /**
   * Vector id -> the row that listed it, remembered across statements (T-0089.1.1): the index still
   * holds a row's vectors after the write that clears its vector_ids, until they are deleted. Read by
   * make-env's Vectorize double to answer deleteEntryVectors' parentId check the way real data would.
   */
  private listedVectors = new Map<string, string>();
  private rememberListed(): void {
    for (const r of [...this.entries, ...this.trash]) {
      let ids: string[] = [];
      try { ids = JSON.parse(r.vector_ids ?? "[]"); } catch { ids = []; }
      for (const v of ids) if (!this.listedVectors.has(v)) this.listedVectors.set(v, r.id);
    }
  }
  __vectorOwners(): Map<string, string> { this.rememberListed(); return this.listedVectors; }
  prepare(sql: string) {
    if (/^\s*(UPDATE entries|DELETE FROM entries|INSERT INTO entries_trash)/i.test(sql)) this.rememberListed();
    let s = sql.replace(/\s+/g, " ").trim();
    // T-0089.4.2 (quarantine): every read this double models predates held
    // rows, and none of its fixtures seed one, so the clause changes nothing a
    // test here could see. Stripped like the ESCAPE clause below, rather than
    // grown onto every exact-string branch, because it never changes which
    // query a statement IS. Held exclusion itself is covered against real
    // SQLite in test/integration/recall-held.test.ts.
    s = s.replace(new RegExp(` AND ${NOT_HELD_SQL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), "");
    // Team-edition workspace scoping. Production appends `AND workspace_id IN (?, ?)`
    // (or a bare `WHERE` form) whenever an Identity is in play. Every integration test
    // in this file runs as the owner whose bootstrap backfill has already moved all
    // seeded rows into the readable set, so filtering would change nothing — the honest
    // move is to strip the clause AND its bound values so the legacy shape handlers
    // keep matching. Workspace isolation itself is NOT modelled by this double; it is
    // covered against real SQLite in test/integration/team-recall-scoping.test.ts and
    // test/unit/team-scoping.test.ts.
    const scopeDrop = new Set<number>();
    if (/workspace_id IN \(/.test(s)) {
      // The alias prefix is optional: a statement that joins another table
      // qualifies the column (`e.workspace_id`), and missing that form would
      // leave the clause in place AND its workspace ids in `args`, where the
      // branch below reads them as entry ids.
      const clauseRe = /(?:AND |WHERE )(?:[A-Za-z_][A-Za-z0-9_]*\.)?workspace_id IN \(((?:\?(?:, )?)+)\)/g;
      for (const m of s.matchAll(clauseRe)) {
        const offset = (s.slice(0, m.index!).match(/\?/g) ?? []).length;
        const n = (m[1].match(/\?/g) ?? []).length;
        for (let i = 0; i < n; i++) scopeDrop.add(offset + i);
      }
      s = s.replace(clauseRe, " ")
        .replace(/\s{2,}/g, " ").trim()
        // A clause that was the only condition leaves a dangling connector.
        .replace(/^WHERE\s+(?=ORDER\b|LIMIT\b|GROUP\b|$)/i, "")
        .replace(/\bAND\s+\)/g, ")")
        .replace(/WHERE\s*\)/gi, ")")
        .replace(/\s+\)/g, ")");
    }
    // Round 6 (T-0089.1.1): writers that replace vector_ids also compare-and-set the vector_ids they
    // read (`AND e.vector_ids = ?N`). Modelled once here: the clause is checked against the row at run
    // time and stripped, so every existing branch below keeps matching the statement it always did.
    let vectorIdsGuard: { valueIdx: number; idIdx: number } | null = null;
    {
      const vg = /\s+AND e\.vector_ids (?:=|IS) \?(\d+)/.exec(s);
      const idm = /e\.id = \?(\d+)/.exec(s);
      if (vg && idm) {
        vectorIdsGuard = { valueIdx: Number(vg[1]) - 1, idIdx: Number(idm[1]) - 1 };
        s = s.replace(vg[0], "");
      }
    }
    // Production pairs every tag LIKE clause with `ESCAPE '\\'` (see tagLikePattern). The
    // escape clause never changes which query a statement IS, so branches that identify a
    // query by its exact text compare against this form rather than each growing a suffix.
    const sBare = s.replace(/ ESCAPE '\\'/g, "");
    const db = this;
    const makeStmt = (allArgs: any[]) => {
      // Drop the bindings that belonged to the stripped scope clauses, positionally.
      const args = scopeDrop.size ? allArgs.filter((_, i) => !scopeDrop.has(i)) : allArgs;
      // Recall candidate filters follow the actual SQL. Scope is handled above;
      // SQL-level admission/isolation regressions use sqlite-d1, not this double.
      const matchesRecallFilters = (row: any): boolean => {
        const tags: string[] = JSON.parse(row.tags ?? "[]");
        for (const match of s.matchAll(/tags (NOT )?LIKE '%"([^"%]+)"%'/g)) {
          const present = tagMatchesLike(tags, match[2]);
          if (match[1] ? present : !present) return false;
        }
        for (const match of s.matchAll(/created_at (>=|<) \?/g)) {
          const index = (s.slice(0, match.index).match(/\?/g) ?? []).length;
          const bound = Number(args[index]);
          if (match[1] === ">=" ? row.created_at < bound : row.created_at >= bound) return false;
        }
        return true;
      };
      const stmt: any = {
        sourceSql: () => sql,
      async run() {
        if (vectorIdsGuard) {
          const row = db.entries.find((e: any) => e.id === args[vectorIdsGuard!.idIdx]);
          const expected = args[vectorIdsGuard.valueIdx];
          if (row && expected !== null && (row.vector_ids ?? "[]") !== expected) return { meta: { changes: 0 } };
        }
        // D1 returns each batched statement's rows as well as its meta, and a
        // batch carries reads as well as writes: identity resolution pairs its
        // SELECT with the throttled last_used_at write so the pair costs one
        // subrequest. batch() below runs statements through run(), so a SELECT
        // has to answer with its rows here. Additive — writes are untouched.
        //
        // all() then first(): the branches in this double are split across the
        // two by what each query's only caller happened to use, so a
        // single-row SELECT like IDENTITY_SQL is modelled in first() and
        // answers all() with nothing. Asking both is what makes a batched read
        // see the same row the unbatched one does.
        if (/^\s*(SELECT|WITH)\b/i.test(s)) {
          const many = await stmt.all();
          if (many.results.length) return { ...many, meta: { changes: 0 } };
          const one = await stmt.first();
          return { results: one ? [one] : [], meta: { changes: 0 } };
        }
        if (s.startsWith("INSERT INTO workspaces")) {
          db.workspaces.push({ id: args[0], kind: args[1], name: args[2], created_at: args[3] });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO users")) {
          const [id, name, email, role, token_hash, suspended, created_at] = args;
          db.users.push({ id, name, email, role, token_hash, suspended, created_at,
            default_share: "", removed_at: null, last_used_at: null });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO memberships")) {
          const [userId, workspaceId, createdAt] = args;
          if (!db.memberships.some((m: any) => m.user_id === userId && m.workspace_id === workspaceId)) {
            db.memberships.push({ user_id: userId, workspace_id: workspaceId, created_at: createdAt });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("INSERT INTO maintenance_cursor")) { db.maintenanceWorkspace = String(args[s.includes("VALUES (1, ?, ?)") ? 0 : 1] ?? ""); return { meta: { changes: 1 } }; }
        if (/^UPDATE entries SET workspace_id = \?(?:, write_marker = \?)? WHERE workspace_id = ''$/.test(s)) {
          let changes = 0;
          for (const entry of db.entries) {
            if (!entry.workspace_id) {
              entry.workspace_id = args[0];
              if (s.includes("write_marker")) entry.write_marker = args[1];
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (/^UPDATE edges SET workspace_id = \?(?:, write_marker = \?)? WHERE workspace_id = ''$/.test(s)) {
          let changes = 0;
          for (const edge of db.edges) {
            if (!edge.workspace_id) {
              edge.workspace_id = args[0];
              if (s.includes("write_marker")) edge.write_marker = args[1];
              changes++;
            }
          }
          return { meta: { changes } };
        }
        const restoreActive = db.restoreState !== null
          && (db.restoreState.completed_at === null
            || (db.restoreState.lease_owner !== null
              && db.restoreState.lease_expires_at !== null
              && db.restoreState.lease_expires_at > Date.now()));
        const isOwnedMigrationVectorUpdate = db.migrationControl !== null
          && s.startsWith("UPDATE entries SET vector_ids = ?, migration_lease_owner = ?")
          && typeof args[1] === "string"
          && db.migrationControl.active_delta_token !== null
          && (db.migrationControl.active_delta_expires_at ?? 0) > Date.now()
          && args[1].startsWith(
            `${db.migrationControl.owner_id}:${db.migrationControl.active_delta_token}:`,
          );
        if ((restoreActive || db.hasActiveMigrationLock()) && (
          s.startsWith("UPDATE entries")
          || s.startsWith("DELETE FROM entries")
          || s.startsWith("UPDATE edges")
          || s.startsWith("DELETE FROM edges")
          || s.startsWith("INSERT INTO insight_candidates")
          || s.startsWith("UPDATE insight_candidates")
          || s.startsWith("DELETE FROM insight_candidates")
        ) && !(isOwnedMigrationVectorUpdate && !restoreActive)) {
          throw new Error("memory-write-locked");
        }
        if (s.startsWith("INSERT INTO schema_meta")) {
          db.schemaVersion = Number(args[0]);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO append_receipts")) {
          const [entry_id, operation_id, request_hash, indexed, completed_at] = args;
          if (s.includes("WHERE EXISTS ( SELECT 1 FROM entries")) {
            const hasPendingGuard = s.includes("pending_append_passages = ? AND write_marker IS ?");
            const [targetId, targetContent, targetTags, targetSource, targetCreatedAt,
              targetVectorIds, pendingOrMarker, guardedMarker] = args.slice(5);
            const targetPending = hasPendingGuard ? pendingOrMarker : undefined;
            const targetMarker = hasPendingGuard ? guardedMarker : pendingOrMarker;
            const target = db.entries.find((row: any) => row.id === targetId);
            if (!target
              || target.content !== targetContent
              || target.tags !== targetTags
              || target.source !== targetSource
              || target.created_at !== targetCreatedAt
              || target.vector_ids !== targetVectorIds
              || (hasPendingGuard && (target.pending_append_passages ?? "[]") !== targetPending)
              || (target.write_marker ?? null) !== (targetMarker ?? null)) {
              return { meta: { changes: 0 } };
            }
          }
          const operationOwner = db.appendReceipts.find(row => row.operation_id === operation_id);
          if (operationOwner && operationOwner.entry_id !== entry_id) {
            throw new Error("UNIQUE constraint failed: append_receipts.operation_id");
          }
          const receipt = { entry_id, operation_id, request_hash, indexed, completed_at } as {
            entry_id: string; operation_id: string; request_hash: string; indexed: number; completed_at: number;
          };
          const existingIndex = db.appendReceipts.findIndex(row => row.entry_id === entry_id);
          if (existingIndex >= 0) db.appendReceipts[existingIndex] = receipt;
          else db.appendReceipts.push(receipt);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE append_receipts SET indexed = 1")) {
          const [completedAt, entryId, operationId, targetId, targetVectorIds,
            targetPending, targetMarker] = args;
          const target = db.entries.find((row: any) => row.id === targetId);
          const receipt = db.appendReceipts.find(row =>
            row.entry_id === entryId && row.operation_id === operationId);
          const allowed = target
            && target.vector_ids === targetVectorIds
            && (target.pending_append_passages ?? "[]") === targetPending
            && (target.write_marker ?? null) === (targetMarker ?? null);
          if (!receipt || !allowed) return { meta: { changes: 0 } };
          receipt.indexed = 1;
          receipt.completed_at = completedAt;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("DELETE FROM memory_write_admissions WHERE expires_at <=")) {
          const now = Number(args[0]);
          let changes = 0;
          for (const [token, admission] of db.memoryWriteAdmissions) {
            if (admission.expires_at <= now) {
              db.memoryWriteAdmissions.delete(token);
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE memory_write_admissions SET expires_at =")) {
          const [expiresAt, token, now] = args;
          const admission = db.memoryWriteAdmissions.get(String(token));
          if (!admission || admission.expires_at <= Number(now)
            || admission.generation !== db.memoryWriteEpoch) return { meta: { changes: 0 } };
          admission.expires_at = Math.max(admission.expires_at, Number(expiresAt));
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO memory_write_admissions")) {
          const [token, started_at, expires_at] = args;
          const restoreBlocks = db.restoreState !== null
            && (db.restoreState.completed_at === null
              || (db.restoreState.lease_owner !== null
                && db.restoreState.lease_expires_at !== null
                && db.restoreState.lease_expires_at > started_at));
          if (db.hasActiveMigrationLock(started_at) || restoreBlocks) return { meta: { changes: 0 } };
          if (!db.memoryWriteEpoch) return { meta: { changes: 0 } };
          db.memoryWriteAdmissions.set(token, { started_at, expires_at, generation: db.memoryWriteEpoch });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("DELETE FROM memory_write_admissions WHERE token =")) {
          const changes = db.memoryWriteAdmissions.delete(String(args[0])) ? 1 : 0;
          return { meta: { changes } };
        }
        const cleanupResult = executeVectorCleanupMock(db, s, args);
        if (cleanupResult !== undefined) return cleanupResult;
        if (s.startsWith("INSERT INTO restore_state")) {
          const [id, backup_id, backup_sha256, run_id, started_at, lease_owner, lease_expires_at, now] = args;
          if (db.entries.length > 0 || db.edges.length > 0 || db.insightCandidates.length > 0
            || db.vectorCleanupOps.length > 0 || db.hasActiveMigrationLock(now)
            || [...db.memoryWriteAdmissions.values()].some(value => value.expires_at > now)) return { meta: { changes: 0 } };
          if (db.restoreState
            && db.restoreState.lease_owner !== null
            && db.restoreState.lease_expires_at !== null
            && db.restoreState.lease_expires_at > now) {
            return { meta: { changes: 0 } };
          }
          db.restoreState = {
            id, backup_id, backup_sha256, run_id, started_at,
            next_offset: 0, next_edge_offset: 0, next_project_offset: 0, completed_at: null,
            lease_owner, lease_expires_at,
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE restore_state SET backup_sha256 = COALESCE")) {
          const [backup_sha256, run_id, lease_owner, lease_expires_at, id, backup_id, expectedSha, now] = args;
          const state = db.restoreState;
          if (!state || state.id !== id || state.backup_id !== backup_id || db.hasActiveMigrationLock(now)
            || [...db.memoryWriteAdmissions.values()].some(value => value.expires_at > now)) return { meta: { changes: 0 } };
          if (state.backup_sha256 !== null && state.backup_sha256 !== expectedSha) return { meta: { changes: 0 } };
          if (state.backup_sha256 === null && (
            state.next_offset !== 0 || state.next_edge_offset !== 0 || state.completed_at !== null
            || db.entries.length > 0 || db.edges.length > 0
          )) return { meta: { changes: 0 } };
          if (state.lease_owner !== null && state.lease_expires_at !== null && state.lease_expires_at > now) {
            return { meta: { changes: 0 } };
          }
          state.backup_sha256 = backup_sha256;
          state.run_id = run_id;
          state.lease_owner = lease_owner;
          state.lease_expires_at = lease_expires_at;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE restore_state SET lease_expires_at = ?")) {
          const [lease_expires_at, id, backup_id, run_id, lease_owner, now] = args;
          const state = db.restoreState;
          if (!state || state.id !== id || state.backup_id !== backup_id
            || state.run_id !== run_id || state.lease_owner !== lease_owner
            || state.lease_expires_at === null || state.lease_expires_at <= now) {
            return { meta: { changes: 0 } };
          }
          state.lease_expires_at = lease_expires_at;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE restore_state SET next_offset = max")) {
          const [next_offset, next_edge_offset, next_project_offset, next_history_offset, completed_at, id, backup_id, backup_sha256, run_id, lease_owner, now] = args;
          const state = db.restoreState;
          if (!state || state.id !== id || state.backup_id !== backup_id || state.backup_sha256 !== backup_sha256
            || state.run_id !== run_id || state.lease_owner !== lease_owner
            || state.lease_expires_at === null || state.lease_expires_at <= now) {
            return { meta: { changes: 0 } };
          }
          state.next_offset = Math.max(state.next_offset, next_offset);
          state.next_edge_offset = Math.max(state.next_edge_offset, next_edge_offset);
          state.next_history_offset = Math.max(state.next_history_offset ?? 0, next_history_offset);
          state.next_project_offset = Math.max(state.next_project_offset ?? 0, next_project_offset);
          state.completed_at = completed_at;
          state.lease_owner = null;
          state.lease_expires_at = null;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE restore_state SET lease_owner = NULL")) {
          const [id, backup_id, run_id, lease_owner] = args;
          const state = db.restoreState;
          if (!state || state.id !== id || state.backup_id !== backup_id
            || state.run_id !== run_id || state.lease_owner !== lease_owner) {
            return { meta: { changes: 0 } };
          }
          state.lease_owner = null;
          state.lease_expires_at = null;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO migration_control")) {
          const [id, locked_at, reason, owner_id, active_delta_expires_at] = args;
          if ([...db.memoryWriteAdmissions.values()].some(value => value.expires_at > locked_at)) {
            return { meta: { changes: 0 } };
          }
          if (db.restoreState
            && (db.restoreState.completed_at === null
              || (db.restoreState.lease_owner !== null
                && db.restoreState.lease_expires_at !== null
                && db.restoreState.lease_expires_at > locked_at))) {
            return { meta: { changes: 0 } };
          }
          if (db.migrationControl && db.hasActiveMigrationLock(locked_at)) {
            return { meta: { changes: 0 } };
          }
          db.migrationControl = {
            id, locked_at, reason, owner_id, final_delta_completed_at: null,
            active_delta_token: null, active_delta_expires_at,
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO embedding_migration_generation")) {
          const [, generation] = args;
          if (s.includes("WHERE EXISTS ( SELECT 1 FROM restore_state")) {
            const [, , restoreId, runId, proof] = args;
            const state = db.restoreState;
            const ownsClaim = s.includes("lease_owner = ?") && state?.lease_owner === proof;
            const completedRun = s.includes("completed_at = ?")
              && state?.completed_at === proof && state?.lease_owner === null;
            if (!state || state.id !== restoreId || state.run_id !== runId
              || (!ownsClaim && !completedRun)) return { meta: { changes: 0 } };
          }
          if (s.includes("DO UPDATE")) {
            db.embeddingMigrationGeneration = generation;
            return { meta: { changes: 1 } };
          }
          if (db.embeddingMigrationGeneration !== null) return { meta: { changes: 0 } };
          db.embeddingMigrationGeneration = generation;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO integration_state_generation")) {
          const generation = args.length > 0
            ? String(args[0])
            : `repaired-${crypto.randomUUID()}`;
          if (s.includes("WHERE EXISTS ( SELECT 1 FROM restore_state")) {
            const [, restoreId, runId, completedAt] = args;
            const state = db.restoreState;
            if (!state || state.id !== restoreId || state.run_id !== runId
              || state.completed_at !== completedAt || state.lease_owner !== null) {
              return { meta: { changes: 0 } };
            }
          }
          const priorCount = db.integrationStateGeneration?.restore_count ?? 0;
          db.integrationStateGeneration = {
            generation,
            restore_count: priorCount + (s.includes("restore_count + 1") ? 1 : 0),
          };
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO integration_provider_generation")) {
          const provider = String(args[0]);
          if (db.integrationProviderGenerations.has(provider)) return { meta: { changes: 0 } };
          db.integrationProviderGenerations.set(provider, {
            generation: `provider-${crypto.randomUUID()}`,
            version: 0,
            draining: 0,
            lease_owner: null,
            lease_expires_at: null,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE integration_provider_generation SET lease_owner = ?, lease_expires_at = ?")) {
          const [owner, expiresAt, provider, now, mode] = args;
          const current = db.integrationProviderGenerations.get(String(provider));
          if (!current
            || (current.lease_owner !== null && (current.lease_expires_at ?? 0) > Number(now))
            || (String(mode) !== "disconnect" && current.draining !== 0)) {
            return { meta: { changes: 0 } };
          }
          current.lease_owner = String(owner);
          current.lease_expires_at = Number(expiresAt);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE integration_provider_generation SET lease_expires_at = ?")) {
          const [expiresAt, provider, generation, owner, now, mode] = args;
          const current = db.integrationProviderGenerations.get(String(provider));
          if (!current || current.generation !== String(generation)
            || current.lease_owner !== String(owner)
            || (current.lease_expires_at ?? 0) <= Number(now)
            || (String(mode) !== "disconnect" && current.draining !== 0)) {
            return { meta: { changes: 0 } };
          }
          current.lease_expires_at = Number(expiresAt);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE integration_provider_generation SET draining = 1")) {
          const [provider, generation, owner, now] = args;
          const current = db.integrationProviderGenerations.get(String(provider));
          if (!current || current.generation !== String(generation)
            || current.lease_owner !== String(owner)
            || (current.lease_expires_at ?? 0) <= Number(now)) {
            return { meta: { changes: 0 } };
          }
          current.draining = 1;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE integration_provider_generation SET lease_owner = NULL")) {
          const [provider, owner] = args;
          const current = db.integrationProviderGenerations.get(String(provider));
          if (!current || current.lease_owner !== String(owner)) return { meta: { changes: 0 } };
          current.lease_owner = null;
          current.lease_expires_at = null;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE integration_provider_generation SET generation =")) {
          const [next, provider, expected, globalGeneration, token, now, operationOwner, leaseOwner, leaseNow] = args;
          const current = db.integrationProviderGenerations.get(provider);
          const admission = db.memoryWriteAdmissions.get(String(token));
          if (!current || current.generation !== String(expected)
            || db.integrationStateGeneration?.generation !== String(globalGeneration)
            || !admission || admission.expires_at <= Number(now)
            || admission.generation !== db.memoryWriteEpoch) {
            return { meta: { changes: 0 } };
          }
          if (operationOwner !== null && (current.lease_owner !== String(leaseOwner)
            || (current.lease_expires_at ?? 0) <= Number(leaseNow))) {
            return { meta: { changes: 0 } };
          }
          current.generation = String(next);
          current.version++;
          current.draining = 0;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO memory_write_epoch")) {
          const generation = String(args[0]);
          if (s.includes("WHERE EXISTS (SELECT 1 FROM migration_control")) {
            const [, id, owner] = args;
            if (!db.migrationControl || db.migrationControl.id !== id
              || db.migrationControl.owner_id !== owner) return { meta: { changes: 0 } };
            db.memoryWriteEpoch = generation;
            return { meta: { changes: 1 } };
          }
          if (s.includes("WHERE EXISTS ( SELECT 1 FROM restore_state")) {
            const [, id, runId, owner] = args;
            if (!db.restoreState || db.restoreState.id !== id || db.restoreState.run_id !== runId
              || db.restoreState.lease_owner !== owner) return { meta: { changes: 0 } };
            db.memoryWriteEpoch = generation;
            return { meta: { changes: 1 } };
          }
          if (db.memoryWriteEpoch !== null) return { meta: { changes: 0 } };
          db.memoryWriteEpoch = generation;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE migration_control SET locked_at = ?")) {
          const [locked_at, reason, owner_id, id] = args;
          if (!db.migrationControl || db.migrationControl.id !== id || db.migrationControl.owner_id !== null) {
            return { meta: { changes: 0 } };
          }
          Object.assign(db.migrationControl, {
            locked_at, reason, owner_id, final_delta_completed_at: null,
            active_delta_token: null, active_delta_expires_at: null,
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE migration_control SET active_delta_token = ?")) {
          const [token, expires_at, id, owner_id] = args;
          const control = db.migrationControl;
          if (!control || control.id !== id || control.owner_id !== owner_id
            || control.active_delta_token !== null) {
            return { meta: { changes: 0 } };
          }
          control.active_delta_token = token;
          control.active_delta_expires_at = expires_at;
          control.final_delta_completed_at = null;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE migration_control SET active_delta_token = NULL")) {
          const [id, owner_id, token] = args;
          const control = db.migrationControl;
          if (!control || control.id !== id || control.owner_id !== owner_id
            || control.active_delta_token !== token) return { meta: { changes: 0 } };
          control.active_delta_token = null;
          control.active_delta_expires_at = null;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE migration_control SET active_delta_expires_at =")) {
          const [expires_at, id, owner_id, token, now] = args;
          const control = db.migrationControl;
          if (!control || control.id !== id || control.owner_id !== owner_id
            || control.active_delta_token !== token
            || (control.active_delta_expires_at ?? 0) <= now) return { meta: { changes: 0 } };
          control.active_delta_expires_at = expires_at;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE migration_control SET final_delta_completed_at =")) {
          const [completed_at, id, owner_id, token, now] = args;
          if (!db.migrationControl || db.migrationControl.id !== id
            || db.migrationControl.owner_id !== owner_id
            || db.migrationControl.active_delta_token !== token
            || (db.migrationControl.active_delta_expires_at ?? 0) <= now) {
            return { meta: { changes: 0 } };
          }
          db.migrationControl.final_delta_completed_at = completed_at;
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("DELETE FROM migration_control")) {
          const requiresComplete = s.includes("final_delta_completed_at IS NOT NULL");
          const control = db.migrationControl;
          const now = Number(args[2]);
          const changed = control
            && control.id === args[0]
            && control.owner_id === args[1]
            && (!requiresComplete || control.final_delta_completed_at !== null)
            && (control.active_delta_token === null || (control.active_delta_expires_at ?? 0) <= now) ? 1 : 0;
          if (changed) db.migrationControl = null;
          return { meta: { changes: changed } };
        }
        if (s === "INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)") {
          // The string-matching mock cannot execute FTS5; the real SQLite
          // integrity and corruption branches have separate integration tests.
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("INSERT INTO entries") && s.includes("SELECT ?, content, ?, source, created_at")) {
          if (db.hasActiveMigrationLock()) throw new Error("memory-write-locked");
          const [id, tags, updated_at, write_marker, sourceId, expectedContent,
            expectedTags, expectedSource, expectedCreatedAt, expectedVectorIds, expectedWorkspaceId] = args;
          const source = db.entries.find((entry: any) => entry.id === sourceId);
          const matches = source
            && source.content === expectedContent
            && source.tags === expectedTags
            && source.source === expectedSource
            && source.created_at === expectedCreatedAt
            && source.vector_ids === expectedVectorIds
            && String(source.workspace_id ?? "") === String(expectedWorkspaceId ?? "");
          if (!matches) return { meta: { changes: 0 } };
          if (db.failEntryInsertIds.has(String(id))) throw new Error("D1 injected insert failure");
          db.entries.push({
            id,
            content: source.content,
            tags,
            source: source.source,
            created_at: source.created_at,
            updated_at,
            vector_ids: "[]",
            recall_count: source.recall_count ?? 0,
            importance_score: source.importance_score ?? 0,
            contradiction_wins: source.contradiction_wins ?? 0,
            contradiction_losses: source.contradiction_losses ?? 0,
            memory_tier: "cold",
            pinned: 0,
            last_recalled_at: source.last_recalled_at ?? null,
            write_marker,
            workspace_id: source.workspace_id ?? "",
            actor_id: source.actor_id ?? "",
            pending_append_passages: "[]",
          });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO entries (")) {
          if (db.hasActiveMigrationLock()) throw new Error("memory-write-locked");
          const colMatch = s.match(/INSERT INTO entries \(([^)]+)\)/i);
          if (!colMatch) throw new Error("INSERT INTO entries missing column list");
          const cols = colMatch[1].split(",").map(c => c.trim());
          if (cols.length !== args.length) {
            throw new Error(`INSERT INTO entries column/bind mismatch: ${cols.length} vs ${args.length}`);
          }
          const row: Record<string, any> = {
            recall_count: 0,
            importance_score: 0,
            contradiction_wins: 0,
            contradiction_losses: 0,
            memory_tier: "warm",
            pinned: 0,
            last_recalled_at: null,
            pending_append_passages: "[]",
          };
          cols.forEach((col, i) => { row[col] = args[i]; });
          if (restoreActive) {
            const state = db.restoreState!;
            if (!row.restore_lease_owner
              || row.restore_lease_owner !== state.lease_owner
              || state.lease_expires_at === null
              || state.lease_expires_at <= Date.now()) {
              throw new Error("memory-write-locked");
            }
          }
          if (db.failEntryInsertIds.has(String(row.id))) throw new Error("D1 injected insert failure");
          if (row.updated_at === undefined) row.updated_at = row.created_at ?? Date.now();
          db.entries.push(row);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ?, tags = ?, pending_append_passages = ?")) {
          const appendArgs = [...args];
          const when = s.includes("when_at = ?") ? appendArgs.splice(6, 2) : null;
          const [content, vector_ids, tags, pending_append_passages, updated_at, write_marker, id,
            expectedContent, expectedTags, expectedSource, expectedCreatedAt, expectedVectorIds,
            expectedPending] = appendArgs;
          const row = db.entries.find((e: any) => e.id === id);
          const guarded = s.includes("AND content = ? AND tags = ? AND source = ? AND created_at = ?")
            && s.includes("AND vector_ids = ? AND pending_append_passages = ?");
          const matchesGuard = !guarded || (row
            && row.content === expectedContent
            && row.tags === expectedTags
            && row.source === expectedSource
            && row.created_at === expectedCreatedAt
            && row.vector_ids === expectedVectorIds
            && (row.pending_append_passages ?? "[]") === expectedPending);
          if (row && matchesGuard) Object.assign(row, {
            content, vector_ids, tags, pending_append_passages, updated_at, write_marker,
            ...(when ? { when_at: when[0], when_kind: when[1], when_source: "explicit", when_label: null } : {}),
          });
          return { meta: { changes: row && matchesGuard ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, source = ?, vector_ids = ?")) {
          const [content, tags, source, vector_ids, updated_at, write_marker, id,
            expectedContent, expectedTags, expectedSource, expectedCreatedAt, expectedVectorIds] = args;
          const row = db.entries.find((e: any) => e.id === id);
          const guarded = s.includes("AND content = ? AND tags = ? AND source = ? AND created_at = ?");
          const cleanupOpId = args[s.includes("AND workspace_id = ?") ? 13 : 12];
          const cleanupReady = !s.includes("EXISTS (SELECT 1 FROM vector_cleanup_ops")
            || db.vectorCleanupOps.some(op => op.op_id === cleanupOpId && op.ready === 1);
          const matchesGuard = !guarded || (row
            && row.content === expectedContent
            && row.tags === expectedTags
            && row.source === expectedSource
            && row.created_at === expectedCreatedAt
            && row.vector_ids === expectedVectorIds
            && (!s.includes("AND workspace_id = ?") || (row.workspace_id ?? "") === args[12])
            && !String(row.tags).includes('"status:deprecated"')
            && cleanupReady);
          if (row && matchesGuard) Object.assign(row, {
            content, tags, source, vector_ids, pending_append_passages: "[]", updated_at, write_marker,
          });
          return { meta: { changes: row && matchesGuard ? 1 : 0 } };
        }
        // Short append (T-0089.9/ADV-1/ADV-2, buildCasGuard/Params, dense-numbered): content is
        // concatenated in SQL, guarded on tags AND workspace_id (the row this call is authorized
        // for). updated_at is clamped strictly past its own previous value, a bare row reference
        // with no placeholder of its own (MAX(?N, COALESCE(e.updated_at, e.created_at) + 1)).
        if (s.startsWith("UPDATE entries AS e SET content = content || ")) {
          const args2 = placeholderArgs(s, args);
          const hasWhen = /when_at = \?\d+/.test(s);
          const [suffix, indexed, chunk, tags, updated_at, ...rest] = args2;
          const when = hasWhen ? rest.splice(0, 2) : [];
          const [id, readTags, workspace_id] = rest;
          const row = db.entries.find((e: any) => e.id === id && (e.tags ?? "[]") === readTags && (e.workspace_id ?? "") === workspace_id);
          if (row) {
            row.content = row.content + suffix;
            if (indexed === 1) row.vector_ids = JSON.stringify([...JSON.parse(row.vector_ids ?? "[]"), chunk]);
            row.tags = tags; row.updated_at = updated_at;
            if (hasWhen) { row.when_at = when[0]; row.when_kind = when[1]; row.when_source = "explicit"; }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // 4.0の番号付きCAS。本文・scope・索引の全guardを評価してから同時更新する。
        if (/^UPDATE entries AS e SET write_marker = \?\d+, (?:content|tags|when_at|valid_from|valid_until) = (?:\?\d+|NULL)/.test(s)) {
          const where = s.slice(s.indexOf(" WHERE "));
          const checks = [...where.matchAll(/e\.(\w+) (?:=|IS) \?(\d+)/g)];
          const row = db.entries.find((entry: any) => checks.every((m: RegExpMatchArray) =>
            (entry[m[1]] ?? (m[1] === "workspace_id" ? "" : null)) === args[Number(m[2]) - 1])
            && (!where.includes("COALESCE(e.actor_id, '') = ''") || !(entry.actor_id ?? "")));
          if (row) {
            const setters = s.slice(0, s.indexOf(" WHERE "));
            for (const m of setters.matchAll(/(?:SET |, )(write_marker|content|tags|vector_ids|staleness_checked_at|when_at|when_kind|when_source|when_label|valid_from|valid_until|updated_at) = \?(\d+)/g)) row[m[1]] = args[Number(m[2]) - 1];
            const at = /updated_at = MAX\(\?(\d+)/.exec(setters);
            if (at) row.updated_at = Math.max(Number(args[Number(at[1]) - 1]), Number(row.updated_at ?? row.created_at) + 1);
            for (const m of setters.matchAll(/(?:SET |, )(when_at|when_kind|when_source|when_label|valid_from|valid_until) = NULL/g)) row[m[1]] = null;
            for (const m of setters.matchAll(/(?:SET |, )(when_source) = '([^']*)'/g)) row[m[1]] = m[2];
            if (setters.includes("vector_ids = '[]'")) row.vector_ids = "[]";
            if (setters.includes("pending_append_passages = '[]'")) row.pending_append_passages = "[]";
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // A person's or a system's merge/replace commit (entry.ts), vector_ids folded into the same
        // guarded UPDATE (ADV-4 residual): SET content, tags, updated_at, vector_ids, guarded on
        // TAGS first then content (systemCasColumns/personCasColumns build tags before content —
        // the update/append branch below guards content first, which is how the two are told apart
        // here). The system form adds the actor/source identity check (an empty actor, its own source).
        if (/^UPDATE entries AS e SET content = \?\d+, tags = \?\d+, updated_at = (\?\d+, vector_ids = \?\d+ WHERE e\.id = \?\d+ AND e\.tags|MAX\(\?\d+, COALESCE\(e\.updated_at, e\.created_at\) \+ 1\), vector_ids = \?\d+ WHERE e\.id = \?\d+ AND e\.tags)/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const hasActorSourceTail = s.includes("COALESCE(e.actor_id, '') = ''");
          const [content, tags, updated_at, vector_ids, id, readTags, readContent, workspace_id, source] = args2;
          const row = db.entries.find((e: any) =>
            e.id === id && (e.tags ?? "[]") === readTags && e.content === readContent && (e.workspace_id ?? "") === workspace_id
            && (!hasActorSourceTail || ((e.actor_id ?? "") === "" && e.source === source)));
          if (row) { row.content = content; row.tags = tags; row.updated_at = updated_at; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // updateEntryContent's compare-and-set commit, and the append long branch (identical
        // shape): updated_at is clamped strictly past its own previous value in both
        // (`updated_at = MAX(?N, COALESCE(e.updated_at, e.created_at) + 1)`, a bare row reference
        // with no extra placeholder of its own), so the two forms need no special-casing here —
        // one placeholder for updated_at's own value, immediately followed by vector_ids, either way.
        // SET content, tags, updated_at, vector_ids atomically (ADV-4), guarded on content, tags AND
        // workspace_id (ADV-2, buildCasGuard).
        if (/^UPDATE entries AS e SET content = \?\d+, tags = \?\d+, updated_at = (\?\d+|MAX\(\?\d+)/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const hasWhen = /when_at = \?\d+/.test(s);
          const [content, tags, updated_at, vector_ids, ...rest] = args2;
          const when = hasWhen ? rest.splice(0, 2) : [];
          const [id, readContent, readTags, workspace_id] = rest;
          const row = db.entries.find((e: any) => e.id === id && e.content === readContent && (e.tags ?? "[]") === readTags && (e.workspace_id ?? "") === workspace_id);
          if (row) {
            row.content = content; row.tags = tags; row.updated_at = updated_at; row.vector_ids = vector_ids;
            if (hasWhen) { row.when_at = when[0]; row.when_kind = when[1]; row.when_source = "explicit"; }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // applyStatus's non-deprecated branch (lifecycle.ts, R2-3): SET tags alone, guarded on
        // workspace_id — the row moved out of the caller's authorized workspace misses.
        if (/^UPDATE entries AS e SET tags = \?\d+ WHERE e\.id = \?\d+ AND e\.workspace_id = \?\d+$/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const [tags, id, workspace_id] = args2;
          const row = db.entries.find((e: any) => e.id === id && (e.workspace_id ?? "") === workspace_id);
          if (row) row.tags = tags;
          return { meta: { changes: row ? 1 : 0 } };
        }
        // deprecateEntry (lifecycle.ts, R2-3): SET tags and empty vector_ids, guarded on workspace_id
        // alone — the caller already read tags to compute the deprecated set, so there is nothing
        // else to re-check. Checked first (a strict end anchor) so entry.ts's wider contradiction
        // shape below, which guards tags/content too, is not shadowed by this simpler prefix.
        if (/^UPDATE entries AS e SET tags = \?\d+, vector_ids = '\[\]' WHERE e\.id = \?\d+ AND e\.workspace_id = \?\d+$/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const [tags, id, workspace_id] = args2;
          const row = db.entries.find((e: any) => e.id === id && (e.workspace_id ?? "") === workspace_id);
          if (row) { row.tags = tags; row.vector_ids = "[]"; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // A system job's contradiction deprecation (entry.ts): SET tags and empty vector_ids, guarded
        // on tags, content, workspace_id and the same actor/source identity check.
        if (/^UPDATE entries AS e SET tags = \?\d+, vector_ids = '\[\]' WHERE e\.id/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const [tags, id, readTags, readContent, workspace_id, source] = args2;
          const row = db.entries.find((e: any) =>
            e.id === id && (e.tags ?? "[]") === readTags && e.content === readContent && (e.workspace_id ?? "") === workspace_id
            && (e.actor_id ?? "") === "" && e.source === source);
          if (row) { row.tags = tags; row.vector_ids = "[]"; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // Short append: content is concatenated in SQL and the write compares-and-sets on the tags it read.
        if (s.startsWith("UPDATE entries SET content = content || ?, vector_ids = CASE WHEN ? = 1")) {
          const hasWhen = s.includes("when_at = ?");
          const [suffix, indexed, chunk, tags, updated_at, ...rest] = args;
          const when = hasWhen ? rest.splice(0, 2) : [];
          const [id, readTags] = rest;
          const row = db.entries.find((e: any) => e.id === id && (e.tags ?? "[]") === readTags);
          if (row) {
            row.content = row.content + suffix;
            if (indexed === 1) row.vector_ids = JSON.stringify([...JSON.parse(row.vector_ids ?? "[]"), chunk]);
            row.tags = tags; row.updated_at = updated_at;
            if (hasWhen) { row.when_at = when[0]; row.when_kind = when[1]; row.when_source = "explicit"; }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // Long append: compare-and-set on content and tags. Also mirror.ts's sync commit, whose
        // updated_at is clamped strictly past its own previous value (a bare row reference, MAX(?,
        // COALESCE(updated_at, created_at) + 1)) — one placeholder for its own value either way.
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, vector_ids = ?, pending_append_passages = '[]', updated_at = MAX(?")) {
          const [content, tags, vector_ids, now, write_marker, id, oldContent, oldTags, oldVectors, workspaceId, createdAt] = args;
          const row = db.entries.find(e => e.id === id && e.content === oldContent && e.tags === oldTags
            && e.vector_ids === oldVectors && (e.workspace_id ?? "") === workspaceId && e.created_at === createdAt);
          if (row) Object.assign(row, { content, tags, vector_ids, pending_append_passages: "[]", write_marker,
            updated_at: Math.max(now, (row.updated_at ?? row.created_at) + 1) });
          return { meta: { changes: row ? 1 : 0 } };
        }
        if ((s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ?") || s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = MAX(?,")) && s.includes("WHERE id = ? AND content = ? AND tags = ?")) {
          const hasWhen = s.includes("when_at = ?");
          const [content, tags, updated_at, ...rest] = args;
          const when = hasWhen ? rest.splice(0, 2) : [];
          const [id, readContent, readTags] = rest;
          const row = db.entries.find((e: any) => e.id === id && e.content === readContent && (e.tags ?? "[]") === readTags);
          if (row) {
            row.content = content; row.tags = tags; row.updated_at = updated_at;
            if (hasWhen) { row.when_at = when[0]; row.when_kind = when[1]; row.when_source = "explicit"; }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // An append that also sets the time anchor (Task 3 folds the separate `when` UPDATE into the batch).
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ?, tags = ?, updated_at = ?, when_at = ?, when_kind = ?, when_source = 'explicit' WHERE id")) {
          const [content, vector_ids, tags, updated_at, when_at, when_kind, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { Object.assign(row, { content, vector_ids, tags, updated_at, when_at, when_kind, when_source: "explicit" }); }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ?, when_at = ?, when_kind = ?, when_source = 'explicit' WHERE id")) {
          const [content, tags, updated_at, when_at, when_kind, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { Object.assign(row, { content, tags, updated_at, when_at, when_kind, when_source: "explicit" }); }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ? WHERE id")) {
          const [content, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, vector_ids")) {
          const [tags, vector_ids, maybeUpdatedAt, maybeMarker, maybeId] = args;
          const hasUpdatedAt = s.includes("updated_at = ?");
          const id = hasUpdatedAt ? maybeId : maybeUpdatedAt;
          const row = db.entries.find((e: any) => e.id === id);
          const guarded = s.includes("AND tags = ? AND vector_ids = ?");
          const matchesGuard = !guarded || (row
            && row.tags === args[5]
            && row.vector_ids === args[6]);
          if (row && matchesGuard) {
            row.tags = tags;
            row.vector_ids = vector_ids;
            if (s.includes("pending_append_passages = '[]'")) row.pending_append_passages = "[]";
            if (hasUpdatedAt) row.updated_at = maybeUpdatedAt;
            if (hasUpdatedAt) row.write_marker = maybeMarker;
          }
          return { meta: { changes: row && matchesGuard ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = ?, workspace_id")) {
          const [vector_ids, workspace_id, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.vector_ids = vector_ids; row.workspace_id = workspace_id; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = ?, pending_append_passages = ?, write_marker = ?")) {
          const [vectorIds, pending, marker, id, expectedContent, expectedSource,
            expectedCreatedAt, expectedVectorIds, expectedPending, expectedWorkspace, expectedTags, cleanupOpId] = args;
          const row = db.entries.find((entry: any) => entry.id === id);
          const cleanupReady = db.vectorCleanupOps.some(op =>
            op.op_id === cleanupOpId && op.ready === 1);
          const matches = row
            && row.content === expectedContent
            && row.source === expectedSource
            && row.created_at === expectedCreatedAt
            && row.vector_ids === expectedVectorIds
            && (row.pending_append_passages ?? "[]") === expectedPending
            && (row.workspace_id ?? "") === expectedWorkspace && row.tags === expectedTags
            && !String(row.tags).includes('"status:deprecated"')
            && cleanupReady;
          if (matches) Object.assign(row, {
            vector_ids: vectorIds,
            pending_append_passages: pending,
            write_marker: marker,
          });
          return { meta: { changes: matches ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids")) {
          const owned = s.startsWith("UPDATE entries SET vector_ids = ?, migration_lease_owner = ?");
          const [vector_ids, ownerOrMarker, maybeId] = args;
          const id = maybeId;
          const row = db.entries.find((e: any) => e.id === id);
          const expectedOffset = 3;
          const guarded = s.includes("AND content = ? AND tags = ? AND source = ? AND created_at = ?");
          const cleanupOpId = args.at(-1);
          const cleanupReady = !s.includes("EXISTS (SELECT 1 FROM vector_cleanup_ops")
            || db.vectorCleanupOps.some(op => op.op_id === cleanupOpId && op.ready === 1);
          const ordinary = s.includes("WHERE id = ? AND content = ? AND source = ? AND created_at = ?");
          const matchesGuard = ordinary ? Boolean(row
            && row.content === args[3] && row.source === args[4] && row.created_at === args[5]
            && row.vector_ids === args[6] && (row.workspace_id ?? "") === args[7]
            && (!s.includes("AND tags = ?") || row.tags === args[8])
            && !/"(?:status:deprecated|conflict-held|quarantine:[^"]+)"/i.test(String(row.tags)) && cleanupReady)
            : !guarded || (row
            && row.content === args[expectedOffset]
            && row.tags === args[expectedOffset + 1]
            && row.source === args[expectedOffset + 2]
            && row.created_at === args[expectedOffset + 3]
            && (!s.includes("AND vector_ids = ?") || row.vector_ids === args[expectedOffset + 4])
            && (!s.includes("AND workspace_id = ?") || (row.workspace_id ?? "") === args[expectedOffset + 5])
            && !String(row.tags).includes('"status:deprecated"')
            && cleanupReady);
          if (row && matchesGuard) {
            row.vector_ids = vector_ids;
            if (s.includes("pending_append_passages = '[]'")) row.pending_append_passages = "[]";
            if (owned) row.migration_lease_owner = ownerOrMarker;
            else row.write_marker = ownerOrMarker;
          }
          return { meta: { changes: row && matchesGuard ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id = ? AND tags = ?")) {
          const [tags, id, expectedTags] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row && row.tags === expectedTags) {
            row.tags = tags;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?, updated_at = ?, write_marker = ? WHERE id = ? AND tags = ? AND content = ?")) {
          // Staleness CAS: guards content as well as tags, because the verdict being
          // written is derived from content and the tag mutation is often a no-op.
          const [tags, staleness_checked_at, updated_at, write_marker, id, expectedTags, expectedContent] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row && row.tags === expectedTags && row.content === expectedContent) {
            row.tags = tags;
            row.staleness_checked_at = staleness_checked_at;
            row.updated_at = updated_at;
            row.write_marker = write_marker;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("UPDATE entries SET staleness_checked_at = ?, write_marker = ? WHERE id = ?")) {
          const [staleness_checked_at, write_marker, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) Object.assign(row, { staleness_checked_at, write_marker });
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, updated_at = ?, write_marker = ? WHERE id")) {
          const [tags, updated_at, write_marker, id, expectedTags] = args;
          const row = db.entries.find((e: any) => e.id === id);
          const matchesGuard = !s.includes("AND tags = ?") || row?.tags === expectedTags;
          if (row && matchesGuard) {
            row.tags = tags;
            row.updated_at = updated_at;
            row.write_marker = write_marker;
          }
          return { meta: { changes: row && matchesGuard ? 1 : 0 } };
        }
        // classify writes: compare-and-set on the tags read (T-0089.10).
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id = ? AND tags = ?")) {
          const [tags, id, readTags] = args;
          const row = db.entries.find((e: any) => e.id === id && (e.tags ?? "[]") === readTags);
          if (row) row.tags = tags;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id")) {
          const [tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.tags = tags;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, pending_append_passages = '[]', updated_at = ?, write_marker = ? WHERE id")) {
          const [content, tags, updated_at, write_marker, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) Object.assign(row, { content, tags, pending_append_passages: "[]", updated_at, write_marker });
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ? AND content = ? AND tags = ?")) {
          const [content, tags, updated_at, id, readContent, readTags] = args;
          const row = db.entries.find((e: any) => e.id === id && e.content === readContent && (e.tags ?? "[]") === readTags);
          if (row) { row.content = content; row.tags = tags; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id")) {
          const [content, tags, updated_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, updated_at = ? WHERE id")) {
          const [content, updated_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags")) {
          const [content, tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ? WHERE id")) {
          const [content, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.content = content;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content ||")) {
          // digest.ts's markSourcesRolledUp (many-row, guarded on workspace_id + each source's own
          // (rowVersion = COALESCE(updated_at, created_at), byte length of content) — a JSON tuple
          // list, not a literal id per statement.
          const [addition, now, ...tail] = args;
          const [writeMarker, workspaceId, tuplesJson] = s.includes("write_marker") ? tail : [undefined, ...tail];
          const tuples = JSON.parse(tuplesJson) as [string, number, number][];
          let changes = 0;
          for (const [id, rowVersion, contentBytes] of tuples) {
            const row = db.entries.find((e: any) => e.id === id);
            if (!row) continue;
            if ((row.workspace_id ?? "") !== workspaceId) continue;
            if ((row.updated_at ?? row.created_at) !== rowVersion) continue;
            if (Buffer.byteLength(row.content ?? "") !== contentBytes) continue;
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes("rolled-up")) tags.push("rolled-up");
            row.tags = JSON.stringify(tags);
            row.content = row.content + addition;
            row.updated_at = now;
            if (writeMarker !== undefined) row.write_marker = writeMarker;
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]'")) {
          const [tag, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes(tag)) tags.push(tag);
            row.tags = JSON.stringify(tags);
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // Track 2 (T-0089.2.4): the retraction hooks are set-based SQL this double does not model; they
        // change nothing here (real SQLite covers them: test/integration/retraction-restore.test.ts).
        if (/'cause', '(?:un)?retraction'/.test(s) || /^UPDATE entries AS e SET valid_until = \(SELECT/.test(s) || (s.startsWith("INSERT INTO edges") && s.includes("z.id, y.id"))) {
          return { results: [], meta: { changes: 0 } };
        }
        if (s.startsWith("DELETE FROM entry_versions WHERE entry_id IN ( SELECT v.entry_id")) return { meta: { changes: 0 } };
        // Track 2 (T-0089.2.1): the supersede batch's statements, numbered placeholders throughout.
        const numbered = (n: string) => args[Number(n) - 1];
        const windowClosed = /AND EXISTS \(SELECT 1 FROM entries x WHERE x\.id = \?(\d+) AND x\.valid_until = \?(\d+)\)/.exec(s);
        const closedNow = () => !windowClosed || db.entries.some((e: any) => e.id === numbered(windowClosed[1]) && (e.valid_until ?? null) === numbered(windowClosed[2]));
        if (/^UPDATE entries SET contradiction_(wins|losses) = contradiction_\1 \+ 1 WHERE id = \?1 AND EXISTS/.test(s)) {
          const column = s.includes("contradiction_wins") ? "contradiction_wins" : "contradiction_losses";
          const row = db.entries.find((e: any) => e.id === args[0]);
          if (!row || !closedNow()) return { meta: { changes: 0 } };
          row[column] = (row[column] ?? 0) + 1;
          return { meta: { changes: 1 } };
        }
        if (/^UPDATE entries AS e SET valid_until = \?\d+ WHERE e\.id = \?\d+/.test(s)) {
          const [, untilN, idN] = /SET valid_until = \?(\d+) WHERE e\.id = \?(\d+)/.exec(s)!;
          const row = db.entries.find((e: any) => e.id === numbered(idN));
          if (!row) return { meta: { changes: 0 } };
          const where = s.slice(s.indexOf(" WHERE ") + 7);
          const value = (col: string) => col === "COALESCE(e.updated_at, e.created_at)" ? row.updated_at ?? row.created_at
            : col === "COALESCE(e.actor_id, '')" ? row.actor_id ?? ""
            : col === "e.workspace_id" ? row.workspace_id ?? "" : row[col.replace(/^e\./, "")] ?? null;
          const holds = [...where.matchAll(/(COALESCE\(e\.\w+, [^)]+\)|e\.\w+) (=|IS|NOT LIKE) (\?\d+|'[^']*')/g)].every(([, col, op, rhs]) => {
            const want = rhs.startsWith("?") ? numbered(rhs.slice(1)) : rhs.slice(1, -1);
            if (op === "NOT LIKE") return !String(value(col)).includes(String(want).replace(/%/g, ""));
            return op === "IS" ? (value(col) ?? null) === (want ?? null) : value(col) === want;
          });
          if (!holds) return { meta: { changes: 0 } };
          row.valid_until = numbered(untilN);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO edges") && /AND EXISTS \(SELECT 1 FROM entries x WHERE x\.id = \?\d+ AND x\.valid_until/.test(s)) {
          // Params reuses a number for a repeated value, so read the SELECT list's own placeholders.
          const list = /SELECT ((?:\?\d+(?:, )?)+) WHERE/.exec(s)![1].split(", ").map(t => numbered(t.slice(1)));
          const [id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id] = list;
          const readable = JSON.parse(String(numbered(/json_each\(\?(\d+)\)/.exec(s)![1]))) as string[];
          const inWs = (eid: unknown) => db.entries.some((e: any) => e.id === eid && readable.includes(e.workspace_id ?? ""));
          if (!inWs(source_id) || !inWs(target_id) || !closedNow()) return { meta: { changes: 0 } };
          const existing = db.edges.find((e: any) => e.source_id === source_id && e.target_id === target_id && e.type === type);
          if (existing) existing.updated_at = updated_at;
          else db.edges.push({ id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_wins = contradiction_wins + 1")) {
          const [, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_wins = (row.contradiction_wins ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_losses = contradiction_losses + 1")) {
          const [, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_losses = (row.contradiction_losses ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET recall_count")) {
          if (s.includes("WHERE id IN")) {
          const jsonIds = s.includes("id IN (SELECT value FROM json_each(?))");
          const ids: unknown[] = jsonIds ? JSON.parse(String(args[2])) : args;
          const workspaces = jsonIds && s.includes("workspace_id IN") ? JSON.parse(String(args[3])) : null;
          const rows = db.entries.filter((e: any) => ids.includes(e.id) && (!workspaces || workspaces.includes(e.workspace_id ?? "")));
          for (const row of rows) {
            row.recall_count = (row.recall_count ?? 0) + 1;
            if (jsonIds) { row.last_recalled_at = args[0]; row.write_marker = args[1]; }
          }
          return { meta: { changes: rows.length } };
          }
          const [last_recalled_at, write_marker, id] = s.includes("last_recalled_at") ? args : [undefined, undefined, args[0]];
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            row.recall_count = (row.recall_count ?? 0) + 1;
            if (last_recalled_at !== undefined) row.last_recalled_at = last_recalled_at;
            if (write_marker !== undefined) row.write_marker = write_marker;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET memory_tier")) {
          const [memory_tier, write_marker, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) Object.assign(row, { memory_tier, write_marker });
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET pinned")) {
          const [pinned, write_marker, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) Object.assign(row, { pinned, write_marker });
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET importance_score")) {
          const [score, write_marker, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) Object.assign(row, { importance_score: score, write_marker });
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET write_marker = ? WHERE id = ?")) {
          const [write_marker, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.write_marker = write_marker;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET write_marker = ? WHERE id IN (SELECT target_id FROM edges")) {
          const [write_marker, currentId] = args;
          const historyIds = new Set(db.edges
            .filter((edge: any) => edge.source_id === currentId
              && edge.type === "supersedes"
              && JSON.parse(edge.metadata ?? "{}").before_image?.version === 1)
            .map((edge: any) => edge.target_id));
          let changes = 0;
          for (const row of db.entries) {
            if (!historyIds.has(row.id)) continue;
            row.write_marker = write_marker;
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE insight_candidates SET write_marker = ?")) {
          const [write_marker, id] = args;
          let changes = 0;
          for (const row of db.insightCandidates) {
            if (row.a_id === id || row.b_id === args[2]) {
              row.write_marker = write_marker;
              changes++;
            }
          }
          return { meta: { changes } };
        }
        if (s.startsWith("DELETE FROM entries WHERE id IN (SELECT target_id FROM edges")) {
          const currentId = args[0];
          const historyIds = new Set(db.edges
            .filter((edge: any) => edge.source_id === currentId
              && edge.type === "supersedes"
              && JSON.parse(edge.metadata ?? "{}").before_image?.version === 1)
            .map((edge: any) => edge.target_id));
          const before = db.entries.length;
          db.entries = db.entries.filter((entry: any) => !historyIds.has(entry.id));
          return { meta: { changes: before - db.entries.length } };
        }
        // The trash batch (src/memory/trash.ts trashManyStatements): every id list is one JSON parameter.
        if (s.startsWith("INSERT INTO entries_trash")) {
          const [idsJson, now, by, channel, reason] = args;
          const withEdges = s.includes("json_group_array");
          const rows = db.entries.filter((e: any) => (JSON.parse(idsJson) as string[]).includes(e.id));
          for (const e of rows) {
            const { id, content, vector_ids, ...rest } = e;
            const edges = withEdges ? db.edges.filter((g: any) => g.source_id === id || g.target_id === id) : [];
            // A plain INSERT, as in SQLite: an id already in the trash is a PRIMARY KEY error.
            if (db.trash.some((t: any) => t.id === id)) throw new Error("UNIQUE constraint failed: entries_trash.id");
            db.trash.push({ id, workspace_id: e.workspace_id ?? "", actor_id: e.actor_id ?? "", content, row_json: JSON.stringify(rest), edges_json: JSON.stringify(edges), vector_ids: vector_ids ?? "[]", deleted_at: now, deleted_by: by, channel, reason });
          }
          return { meta: { changes: rows.length } };
        }
        if (s.startsWith("DELETE FROM entry_versions")) return { meta: { changes: 0 } };
        if (s.startsWith("DELETE FROM edges WHERE source_id IN (SELECT value FROM json_each")) {
          const ids = new Set(JSON.parse(args[0]) as string[]);
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => !ids.has(e.source_id) && !ids.has(e.target_id));
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM entries WHERE id IN (SELECT value FROM json_each")) {
          const ids = new Set(JSON.parse(args[0]) as string[]);
          const before = db.entries.length;
          db.entries = db.entries.filter((e: any) => !ids.has(e.id));
          return { meta: { changes: before - db.entries.length } };
        }
        if (s.startsWith("DELETE FROM entries WHERE id")) {
          const [id] = args;
          const before = db.entries.length;
          db.entries = db.entries.filter((e: any) => e.id !== id);
          return { meta: { changes: before - db.entries.length } };
        }
        if (s.startsWith("DELETE FROM insight_candidates WHERE a_id")) {
          const [aId, bId] = args;
          const before = db.insightCandidates.length;
          db.insightCandidates = db.insightCandidates.filter(row => row.a_id !== aId && row.b_id !== bId);
          return { meta: { changes: before - db.insightCandidates.length } };
        }
        if (s.startsWith("INSERT INTO edges")) {
          if (db.hasActiveMigrationLock()) throw new Error("memory-write-locked");
          const placeholderCount = (s.match(/\?/g) ?? []).length;
          if (placeholderCount !== args.length) {
            throw new Error(`INSERT INTO edges placeholder/bind mismatch: ${placeholderCount} vs ${args.length}`);
          }
          // The guarded form (edgeInsertStatement's onlyIfNoTypedEdge): the row's
          // ten values, then the pair the guard tests. Modelled here because the
          // rule lives in the statement, so a mock that ignored it would report
          // an insert production would have skipped.
          // The endpoint readability guard every edge insert carries (edgeEndpointsReadableSql): the
          // ten values, then source, readable JSON, target, readable JSON.
          const insertWidth = s.match(/^INSERT INTO edges \(([^)]+)\)/)?.[1].split(",").length;
          let guardEnd = insertWidth ?? (s.includes("write_marker") ? 11 : 10);
          if (s.includes("json_each") && !s.includes("FROM (VALUES")) {
            const [gs, gsr, gt, gtr] = args.slice(guardEnd, guardEnd + 4);
            guardEnd += 4;
            const readableIn = (id: unknown, json: unknown) => {
              const allowed = JSON.parse(String(json)) as string[];
              return db.entries.some((e: any) => e.id === id && allowed.includes(e.workspace_id ?? ""));
            };
            if (!readableIn(gs, gsr) || !readableIn(gt, gtr)) return { meta: { changes: 0 } };
          }
          if (s.includes("NOT EXISTS") && !s.includes("FROM (VALUES")) {
            const [ga, gb, gc, gd] = args.slice(guardEnd);
            if (db.edges.some((e: any) =>
              ((e.source_id === ga && e.target_id === gb) || (e.source_id === gc && e.target_id === gd))
              && e.type !== "relates_to")) return { meta: { changes: 0 } };
          }
          const hasRestoreOwner = s.includes("restore_lease_owner");
          const hasWorkspace = s.includes("workspace_id");
          const width = 9 + (hasRestoreOwner ? 2 : 1) + (hasWorkspace ? 1 : 0);
          let changes = 0;
          const edgeArgs = s.includes("FROM (VALUES") ? args : s.includes("json_each") ? args.slice(0, insertWidth ?? 11) : s.includes("WHERE NOT EXISTS") ? args.slice(0, 11) : args;
          for (let offset = 0; offset < edgeArgs.length; offset += width) {
            const rowArgs = edgeArgs.slice(offset, offset + width);
            const [id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at] = rowArgs;
            let cursor = 9;
            const restore_lease_owner = hasRestoreOwner ? rowArgs[cursor++] : null;
            const write_marker = rowArgs[cursor++];
            const workspace_id = hasWorkspace ? rowArgs[cursor++] : "";
            if (s.includes("FROM (VALUES") && s.includes("json_array(column11)")) {
              if (![source_id, target_id].every(endpoint => db.entries.some((e: any) => e.id === endpoint && (e.workspace_id ?? "") === workspace_id))) continue;
            }
            if (db.failEdgeInsertIds.has(String(id))) throw new Error("D1 injected edge insert failure");
            if (restoreActive) {
              const state = db.restoreState!;
              if (!restore_lease_owner
                || restore_lease_owner !== state.lease_owner
                || state.lease_expires_at === null
                || state.lease_expires_at <= Date.now()) {
                throw new Error("memory-write-locked");
              }
            }
            if (s.includes("FROM (VALUES") && type === "relates_to"
              && db.edges.some((e: any) => e.type !== "relates_to"
                && ((e.source_id === source_id && e.target_id === target_id)
                  || (e.source_id === target_id && e.target_id === source_id)))) continue;
            const existing = db.edges.find((e: any) => e.source_id === source_id && e.target_id === target_id && e.type === type);
            if (existing) {
              if ((!s.includes("WHERE edges.provenance = 'inferred'") || existing.provenance === "inferred")
                && (!s.includes("WHERE edges.provenance <> 'explicit'") || existing.provenance !== "explicit" || provenance === "explicit")) {
                existing.weight = Math.max(existing.weight, weight);
                if (s.includes("metadata = excluded.metadata")) existing.metadata = metadata;
                existing.updated_at = updated_at;
                existing.write_marker = write_marker;
                if (hasWorkspace) existing.workspace_id = workspace_id;
              }
            } else {
              db.edges.push({ id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, restore_lease_owner, write_marker, workspace_id });
            }
            changes++;
          }
          return { meta: { changes } };
        }
        // Exact-pair retirement and the weekly dangling sweep retain their
        // provenance guard; neither may delete explicit user assertions.
        if ((s.startsWith("UPDATE edges SET write_marker = ?") || s.startsWith("DELETE FROM edges"))
          && (s.includes("WHERE type = 'relates_to' AND provenance = 'inferred' AND (")
            || s.includes("NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = edges.source_id)"))) {
          const deleting = s.startsWith("DELETE");
          const bindings = deleting ? args : args.slice(1);
          const dangling = s.includes("NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = edges.source_id)");
          const matches = (edge: any) => edge.provenance === "inferred" && (dangling
            ? !db.entries.some((row: any) => row.id === edge.source_id)
              || !db.entries.some((row: any) => row.id === edge.target_id)
            : edge.type === "relates_to" && bindings.some((_: any, i: number) => i % 4 === 0
              && ((edge.source_id === bindings[i] && edge.target_id === bindings[i + 1])
                || (edge.source_id === bindings[i + 2] && edge.target_id === bindings[i + 3]))));
          const selected = db.edges.filter(matches);
          if (deleting) db.edges = db.edges.filter((edge: any) => !matches(edge));
          else for (const edge of selected) edge.write_marker = args[0];
          return { meta: { changes: selected.length } };
        }
        if (s.startsWith("UPDATE edges SET write_marker = ?")) {
          const marker = args[0];
          const idDelete = s.includes("WHERE id IN (") ? new Set(args.slice(1).map(String)) : null;
          const incidentIn = s.includes("source_id IN (") && s.includes("target_id IN (");
          const incidentCount = incidentIn ? (args.length - 1) / 2 : 0;
          const incidentIds = incidentIn ? new Set(args.slice(1, 1 + incidentCount).map(String)) : null;
          let changes = 0;
          for (const edge of db.edges) {
            const pairDelete = s.includes("((source_id")
              && ((edge.source_id === args[1] && edge.target_id === args[2])
                || (edge.source_id === args[3] && edge.target_id === args[4]))
              && (args[5] === undefined || edge.type === args[5]);
            const endpointDelete = s.includes("source_id = ? OR target_id = ?")
              && (edge.source_id === args[1] || edge.target_id === args[2]);
            const prune = s.includes("provenance = 'inferred'")
              && edge.provenance === "inferred" && edge.weight < args[1] && edge.updated_at < args[2];
            const byId = idDelete?.has(String(edge.id)) ?? false;
            const byIncident = incidentIds !== null
              && edge.provenance === "inferred" && edge.type === "relates_to"
              && (incidentIds.has(String(edge.source_id)) || incidentIds.has(String(edge.target_id)));
            if (!pairDelete && !endpointDelete && !prune && !byId && !byIncident) continue;
            edge.write_marker = marker;
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("DELETE FROM edges WHERE ((source_id")) {
          // deleteEdge: order-agnostic pair delete, optional trailing type filter.
          const [a, b, c, d, type] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => {
            const pairMatch = (e.source_id === a && e.target_id === b) || (e.source_id === c && e.target_id === d);
            if (!pairMatch) return true;
            if (type && e.type !== type) return true;
            return false;
          });
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE (source_id = ? OR target_id = ?")) {
          const currentId = args[0];
          const historyIds = new Set(db.edges
            .filter((edge: any) => edge.source_id === currentId
              && edge.type === "supersedes"
              && JSON.parse(edge.metadata ?? "{}").before_image?.version === 1)
            .map((edge: any) => edge.target_id));
          const before = db.edges.length;
          db.edges = db.edges.filter((edge: any) =>
            edge.source_id !== currentId
            && edge.target_id !== currentId
            && !historyIds.has(edge.source_id)
            && !historyIds.has(edge.target_id));
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE source_id")) {
          // Cascade delete on forget: source_id = ? OR target_id = ? (both bound to the same id).
          const [sid, tid] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => e.source_id !== sid && e.target_id !== tid);
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE id IN (")) {
          const ids = new Set(args.map(String));
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => !ids.has(String(e.id)));
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE provenance = 'inferred'") && s.includes("source_id IN (")) {
          const half = args.length / 2;
          const ids = new Set(args.slice(0, half).map(String));
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => !(e.provenance === "inferred" && e.type === "relates_to"
            && (ids.has(String(e.source_id)) || ids.has(String(e.target_id)))));
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE provenance")) {
          // runGraphPass prune: inferred edges below a weight, older than a cutoff.
          const [weight, age] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => !(e.provenance === "inferred" && e.weight < weight && e.updated_at < age));
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM append_receipts WHERE entry_id =")) {
          const before = db.appendReceipts.length;
          db.appendReceipts = db.appendReceipts.filter(row => row.entry_id !== args[0]);
          return { meta: { changes: before - db.appendReceipts.length } };
        }
        return { meta: {} };
      },
      async first() {
        if (s.startsWith("SELECT COALESCE(") && s.includes("maintenance_cursor")) {
          const ring = [...new Set(db.entries.map(e => e.workspace_id ?? ""))].sort();
          return { workspace_id: ring.find(ws => ws > db.maintenanceWorkspace) ?? ring[0] ?? null };
        }
        // ── ensureTenantBootstrap / resolveIdentity ──────────────────────────
        if (s.startsWith("SELECT id FROM workspaces WHERE kind")) {
          const kind = s.match(/kind = '(\w+)'/)?.[1];
          const row = db.workspaces
            .filter((workspace: any) => workspace.kind === kind)
            .sort((a: any, b: any) => a.created_at - b.created_at)[0];
          return row ? { id: row.id } : null;
        }
        if (s.includes("u.role = 'admin'")) {
          const admin = db.users
            .filter((user: any) => user.role === "admin")
            .sort((a: any, b: any) => a.created_at - b.created_at)[0];
          if (!admin) return null;
          const membership = db.memberships.find((candidate: any) =>
            candidate.user_id === admin.id
            && db.workspaces.some((workspace: any) => workspace.id === candidate.workspace_id
              && workspace.kind === "personal"));
          return membership ? { userId: admin.id, personalWorkspaceId: membership.workspace_id } : null;
        }
        if (s.startsWith("SELECT 1 AS ok FROM memberships")) {
          const found = db.memberships.some((membership: any) => membership.user_id === args[0]
            && db.workspaces.some((workspace: any) => workspace.id === membership.workspace_id
              && workspace.kind === "personal"));
          return found ? { ok: 1 } : null;
        }
        if (s.includes("u.token_hash = ?")) {
          const user = db.users.find((candidate: any) => candidate.token_hash === args[0]
            && !candidate.suspended && !candidate.removed_at);
          if (!user) return null;
          const workspaces = (kind: string) => db.memberships
            .filter((membership: any) => membership.user_id === user.id)
            .map((membership: any) => db.workspaces.find((workspace: any) =>
              workspace.id === membership.workspace_id && workspace.kind === kind))
            .filter(Boolean);
          const personalWorkspaceId = workspaces("personal")[0]?.id;
          if (!personalWorkspaceId) return null;
          const companyWorkspaces = workspaces("company")
            .map((workspace: any) => `${workspace.id}@${workspace.created_at ?? 0}`)
            .join(",");
          return {
            userId: user.id,
            role: user.role,
            defaultShare: user.default_share ?? "",
            personalWorkspaceId,
            companyWorkspaces: companyWorkspaces || null,
          };
        }
        if (s.startsWith("SELECT version")) {
          return db.schemaVersion === null ? null : { version: db.schemaVersion, capsule_definitions: JSON.stringify(Object.fromEntries([...TRIGGER_DDL, ["idx_entries_capsule", `CREATE INDEX idx_entries_capsule ON entries(workspace_id, id) WHERE instr(lower(tags), '"capsule:') > 0`]])) };
        }
        if (s.startsWith("SELECT entry_id, request_hash, indexed FROM append_receipts WHERE operation_id =")) {
          return db.appendReceipts.find(row => row.operation_id === args[0]) ?? null;
        }
        if (s.startsWith("SELECT 1 AS pending FROM vector_cleanup_ops")) {
          return db.vectorCleanupOps.length ? { pending: 1 } : null;
        }
        if (s.startsWith("SELECT 1 AS active FROM memory_write_admissions")) {
          const now = Number(args[0]);
          return [...db.memoryWriteAdmissions.values()].some(value => value.expires_at > now)
            ? { active: 1 }
            : null;
        }
        if (s.includes("AS entry_bytes") && s.includes("AS edge_bytes")) {
          const textCost = (values: unknown[]) => values.reduce<number>(
            (sum, value) => sum + 6 * new TextEncoder().encode(String(value ?? "")).byteLength,
            512,
          );
          return {
            entry_count: db.entries.length,
            entry_bytes: db.entries.reduce((sum: number, entry: any) => sum + textCost([
              entry.id, entry.content, entry.tags, entry.source,
            ]), 0),
            edge_count: db.edges.length,
            project_count: 0, project_bytes: 0, history_count: 0,
            edge_bytes: db.edges.reduce((sum: number, edge: any) => sum + textCost([
              edge.id, edge.source_id, edge.target_id, edge.type, edge.provenance, edge.metadata,
            ]), 0),
            dangling_edge_count: db.edges.filter((edge: any) =>
              !db.entries.some((entry: any) => entry.id === edge.source_id)
              || !db.entries.some((entry: any) => entry.id === edge.target_id)).length,
          };
        }
        if (s.startsWith("SELECT COUNT(*) AS dangling_edge_count FROM edges e")) {
          return {
            dangling_edge_count: db.edges.filter((edge: any) =>
              !db.entries.some((entry: any) => entry.id === edge.source_id)
              || !db.entries.some((entry: any) => entry.id === edge.target_id)).length,
          };
        }
        if (s.startsWith("SELECT backup_id, backup_sha256, run_id, started_at, next_offset, next_edge_offset")) {
          const state = db.restoreState;
          if (!state || state.id !== args[0]) return null;
          return {
            backup_id: state.backup_id,
            backup_sha256: state.backup_sha256,
            run_id: state.run_id,
            started_at: state.started_at,
            next_offset: state.next_offset,
            next_edge_offset: state.next_edge_offset,
            next_project_offset: state.next_project_offset ?? 0,
            next_history_offset: state.next_history_offset ?? 0,
            completed_at: state.completed_at,
            lease_owner: state.lease_owner,
            lease_expires_at: state.lease_expires_at,
          };
        }
        if (s.startsWith("SELECT (SELECT COUNT(*) FROM entries) AS entry_count")) {
          return {
            entry_count: db.entries.length,
            edge_count: db.edges.length,
            project_count: 0, project_bytes: 0, history_count: 0,
            candidate_count: db.insightCandidates.length,
            cleanup_count: db.vectorCleanupOps.length,
          };
        }
        if (s.startsWith("SELECT locked_at, reason, owner_id, active_delta_expires_at FROM migration_control")) {
          const control = db.migrationControl;
          if (!control || control.id !== args[0] || !db.hasActiveMigrationLock(Number(args[2]))) return null;
          return {
            locked_at: control.locked_at,
            reason: control.reason,
            owner_id: control.owner_id,
            active_delta_expires_at: control.active_delta_expires_at,
          };
        }
        if (s.startsWith("SELECT generation FROM embedding_migration_generation")) {
          return db.embeddingMigrationGeneration === null
            ? null
            : { generation: db.embeddingMigrationGeneration };
        }
        if (s.startsWith("SELECT i.generation, i.restore_count, p.generation AS provider_generation")
          && s.includes("LEFT JOIN integration_provider_generation")) {
          const provider = String(args[0]);
          const providerState = db.integrationProviderGenerations.get(provider);
          if (!db.integrationStateGeneration) return null;
          return {
            ...db.integrationStateGeneration,
            provider_generation: providerState?.generation ?? null,
            provider_version: providerState?.version ?? null,
          };
        }
        if (s.startsWith("SELECT generation, restore_count FROM integration_state_generation")) {
          return db.integrationStateGeneration === null ? null : { ...db.integrationStateGeneration };
        }
        if (s.startsWith("SELECT i.generation, i.restore_count, p.generation AS provider_generation")
          && s.includes("JOIN integration_provider_generation")) {
          const provider = String(args[0]);
          const admission = db.memoryWriteAdmissions.get(String(args[1]));
          const providerState = db.integrationProviderGenerations.get(provider);
          if (!db.integrationStateGeneration || !admission
            || !providerState
            || admission.expires_at <= Number(args[2])
            || admission.generation !== db.memoryWriteEpoch) return null;
          if (s.includes("p.lease_owner = ?")) {
            const [expectedGeneration, owner, operationNow, mode] = args.slice(3);
            if (providerState.generation !== String(expectedGeneration)
              || providerState.lease_owner !== String(owner)
              || (providerState.lease_expires_at ?? 0) <= Number(operationNow)
              || (String(mode) !== "disconnect" && providerState.draining !== 0)) return null;
          }
          return {
            ...db.integrationStateGeneration,
            provider_generation: providerState.generation,
            provider_version: providerState.version,
          };
        }
        if (s.startsWith("SELECT COUNT(*) AS mirror_count FROM entries") && s.includes("TRIM(source")) {
          const providers = new Set(args.map(String));
          return { mirror_count: db.entries.filter((entry: any) => providers.has(String(entry.source).trim())).length };
        }
        if (s.startsWith("SELECT COUNT(*) AS count FROM entries WHERE TRIM(source")) {
          const provider = String(args[0]);
          return { count: db.entries.filter((entry: any) => String(entry.source).trim() === provider).length };
        }
        if (s.startsWith("SELECT locked_at, reason, owner_id FROM (")) {
          const [migrationId, , migrationNow, restoreId, now] = args;
          const control = db.migrationControl;
          if (control && control.id === migrationId && db.hasActiveMigrationLock(migrationNow)) {
            return {
              locked_at: control.locked_at,
              reason: control.reason,
              owner_id: control.owner_id,
            };
          }
          const state = db.restoreState;
          if (state && state.id === restoreId && (state.completed_at === null
            || (state.lease_owner !== null
              && state.lease_expires_at !== null
              && state.lease_expires_at > now))) {
            return { locked_at: state.started_at, reason: "r2-restore", owner_id: state.run_id };
          }
          return null;
        }
        // captureEntry's conflict read (T-0089.2.1): the row version alias and the validity window.
        if (s.includes("AS row_version, valid_from, valid_until FROM entries WHERE id = ? AND workspace_id = ?")) {
          const row = db.entries.find((e: any) => e.id === args[0] && (e.workspace_id ?? "") === args[1]);
          return row ? { ...row, row_version: row.updated_at ?? row.created_at, valid_from: row.valid_from ?? null, valid_until: row.valid_until ?? null } : null;
        }
        // GET /entry. Models the COALESCE alias: a row written before the
        // updated_at column exists carries no value, and the route must see
        // created_at rather than undefined.
        if (s.includes("COALESCE(updated_at, created_at) AS last_updated") && s.includes("FROM entries WHERE id = ?")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { ...row, last_updated: row.updated_at ?? row.created_at } : null;
        }
        // appendToEntry's own read of the row it edits.
        if (s.includes("SELECT content, tags, source, vector_ids, workspace_id FROM entries WHERE id")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { content: row.content, tags: row.tags ?? "[]", source: row.source, vector_ids: row.vector_ids ?? "[]", workspace_id: row.workspace_id ?? "" } : null;
        }
        if (s.includes("SELECT vector_ids FROM entries WHERE id")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { vector_ids: row.vector_ids } : null;
        }
        if (s.includes("SELECT vector_ids FROM vector_cleanup_ops WHERE op_id")) {
          const row = db.vectorCleanupOps.find(op => op.op_id === args[0]);
          return row ? { vector_ids: row.vector_ids } : null;
        }
        if (s.includes("END AS kind") && s.includes("WHEN EXISTS") && s.includes("vector_ids = '[]'")) {
          const cutoff = Number(args[0]);
          const vectorPending = db.entries.some((e: any) =>
            ((e.vector_ids === '[]' && e.created_at < cutoff)
              || (e.vector_ids !== '[]' && (() => {
                try {
                  const passages = JSON.parse(e.pending_append_passages ?? "[]");
                  return Array.isArray(passages) && passages.length > 0;
                } catch { return false; }
              })()))
            && !String(e.tags).includes('"status:deprecated"'));
          if (vectorPending) return { kind: "vectorize" };
          const classificationPending = db.entries.some((e: any) =>
            !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:'));
          return { kind: classificationPending ? "classify" : null };
        }
        // These branches match `as count` in lower case only. src/migration/embedding.ts
        // writes `AS count`, so three of its queries fall through here and return null
        // rather than a row — pre-existing, and those paths are covered against real SQLite
        // in test/integration/embedding-migration.test.ts. Worth knowing before adding a
        // fourth caller and trusting the double.
        // GET /stats's summary. Matched on the two aggregate names that are stable
        // across its scoped and unscoped halves: `count`/`avg_importance` carry a
        // `CASE WHEN workspace_id IN (…)` so the admin's content totals agree with
        // /count, while unvectorized/unclassified stay corpus-wide for the repair
        // panel. This double ignores bindings, so it cannot see that scoping at all
        // — the assertion that it works lives in test/integration/team-isolation.ts
        // against real SQLite. Here the brain is single-user, where both halves
        // agree, so counting every entry is the faithful answer.
        if (s.includes("as unvectorized") && s.includes("as unclassified") && s.includes("AVG(")) {
          const count = db.entries.length;
          const scored = db.entries.filter((e: any) => typeof e.importance_score === "number");
          const avg_importance = scored.length > 0
            ? scored.reduce((sum: number, e: any) => sum + e.importance_score, 0) / scored.length
            : null;
          // The grace cutoff is the only numeric bind in this statement; the scope
          // bindings around it are workspace-id strings.
          const numeric = args.filter((a: any) => typeof a === "number");
          const cutoff = numeric.length > 0 ? Number(numeric[numeric.length - 1]) : undefined;
          const unvectorized = cutoff !== undefined
            ? db.entries.filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff).length
            : 0;
          const unclassified = db.entries.filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:')).length;
          const pending_append_passages = db.entries.reduce((sum: number, entry: any) => {
            if (entry.vector_ids === "[]" || String(entry.tags).includes('"status:deprecated"')) return sum;
            try {
              const passages = JSON.parse(entry.pending_append_passages ?? "[]");
              return sum + (Array.isArray(passages) ? passages.length : 0);
            } catch {
              return sum;
            }
          }, 0);
          return { count, avg_importance, unvectorized, pending_append_passages, unclassified };
        }
        // POST /vectorize-pending's remaining count (adv-final MAJOR 2): every unindexed row, no
        // grace cutoff, plus the oldest one's created_at so the route can compute retryAfterMs.
        if (s.includes("COUNT(*) as count") && s.includes("MIN(created_at) as oldest") && s.includes("vector_ids = '[]'")) {
          const unindexed = db.entries.filter((e: any) => e.vector_ids === '[]');
          const oldest = unindexed.length ? Math.min(...unindexed.map((e: any) => e.created_at)) : null;
          return { count: unindexed.length, oldest };
        }
        if (s.includes("COUNT(*) as count") && s.includes("vector_ids = '[]'")) {
          const cutoff = s.includes("created_at <") ? Number(args[0]) : Infinity;
          const includesAppendQueue = s.includes("json_array_length(pending_append_passages)");
          const count = db.entries.filter((e: any) => {
            if (String(e.tags).includes('"status:deprecated"')) return false;
            if (s.includes("quarantine:") && String(e.tags).includes('"quarantine:')) return false;
            if (e.vector_ids === '[]') return e.created_at < cutoff;
            if (!includesAppendQueue) return false;
            try {
              const passages = JSON.parse(e.pending_append_passages ?? "[]");
              return Array.isArray(passages) && passages.length > 0;
            } catch { return false; }
          }).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`)) {
          const count = db.entries.filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:')).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count")) {
          return { count: db.entries.length };
        }
        // Standing memory cap check (src/capture/t7-capture.ts, Design 2.1 point 3): the
        // workspace's live standing:active count, run before a standing capture's INSERT.
        if (s.includes(`instr(lower(tags), '"standing:active"')`) && s.includes("COUNT(*) AS n")) {
          const workspaceId = args[0];
          const n = db.entries.filter((e: any) => {
            if ((e.workspace_id ?? "") !== workspaceId) return false;
            const tags: string[] = JSON.parse(e.tags ?? "[]").map((t: string) => String(t).toLowerCase());
            return tags.includes("standing:active") && !tags.includes("status:deprecated");
          }).length;
          return { n };
        }
        if (s.includes("WHERE id") && !s.includes("json_each")) {
          return db.entries.find((e: any) => e.id === args[0]) ?? null;
        }
        if (s.includes("WHERE tags LIKE") && s.includes("created_at >")) {
          // Cooldown check: find entries matching arg LIKE patterns + any hardcoded tags in SQL
          // Binds are the LIKE pattern(s), the cutoff, and (since the held-digest clause) the workspace id.
          const likePatterns: string[] = args.filter((a: any) => typeof a === "string" && a.startsWith("%")).map((a: any) => String(a));
          const cutoff = args.find((a: any) => typeof a === "number") as number;
          const workspaceScoped = s.includes("workspace_id = ?");
          const workspaceId = workspaceScoped ? String(args[args.length - 1] ?? "") : undefined;
          // Extract hardcoded tags from SQL (e.g. '%"synthesized"%')
          const hardcoded = [...s.matchAll(/'%"(\w+)"%'/g)].map(m => m[1]);
          const match = db.entries.find((e: any) => {
            if (e.created_at <= cutoff) return false;
            if (workspaceId !== undefined && String(e.workspace_id ?? "") !== workspaceId) return false;
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!hardcoded.every(t => tags.includes(t))) return false;
            return likePatterns.every((p: string) => {
              const tag = tagFromLikePattern(p);
              return tagMatchesLike(tags, tag);
            });
          });
          return match ? { id: match.id } : null;
        }
        return null;
      },
      async all() {
        if (s.startsWith("SELECT generation FROM embedding_migration_generation")) return { results: db.embeddingMigrationGeneration ? [{ generation: db.embeddingMigrationGeneration }] : [] };
        if (s.includes("FROM sqlite_master") && s.includes("name = 'entries_fts'") && s.includes("entries_fts_insert")) {
          return { results: [
            { name: "entries_fts", sql: FTS_TABLE_DDL },
            ...["entries_fts_insert", "entries_fts_update", "entries_fts_delete"].map(name => ({ name, sql: TRIGGER_DDL.get(name) })),
          ] };
        }
        if (s.includes("FROM sqlite_master") && s.includes("entry_counts_insert") && s.includes("entry_counts_update")) {
          return { results: ["entry_counts_insert", "entry_counts_update", "entry_counts_delete"].map(name => ({ name, sql: TRIGGER_DDL.get(name) })) };
        }
        if (s.startsWith("SELECT version")) {
          return { results: db.schemaVersion === null ? [] : [{ version: db.schemaVersion, capsule_definitions: JSON.stringify(Object.fromEntries([...TRIGGER_DDL, ["idx_entries_capsule", `CREATE INDEX idx_entries_capsule ON entries(workspace_id, id) WHERE instr(lower(tags), '"capsule:') > 0`]])) }] };
        }
        if (s.startsWith("WITH schema_groups")) {
          // src/db/init.ts's schema probe. This mock stands in for a deployed brain, and
          // a deployed brain is migrated — its rows carry every ALTER column below — so
          // the honest answer is "all present", which is also what makes the mock report
          // the real cold-start cost of a cold isolate rather than a fresh install's.
          // The names are spelled out rather than imported from init.ts on purpose: a
          // mock that derives its answer from the code under test can only ever agree
          // with it. Fresh and partially-migrated brains are covered against real SQLite
          // in test/unit/db-init.test.ts.
          return { results: SCHEMA_PROBE_RESULTS };
        }
        if (s === "SELECT id FROM entries") {
          return { results: db.entries.map((e: any) => ({ id: e.id })) };
        }
        if (s.startsWith("SELECT id FROM entries WHERE TRIM(source") && s.includes("ORDER BY id LIMIT ?")) {
          const provider = String(args[0]);
          const limit = Number(args[1]);
          return {
            results: db.entries
              .filter((entry: any) => String(entry.source).trim() === provider)
              .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)))
              .slice(0, limit)
              .map((entry: any) => ({ id: entry.id })),
          };
        }
        if (s.startsWith("WITH incident_connections AS") && s.includes("JOIN entries n") && s.includes("entry_created_at")) {
          const requestedId = String(args[0]);
          const hasType = s.includes("AND type = ?");
          const type = hasType ? String(args[1]) : undefined;
          const limit = Number(args[args.length - 2]);
          const offset = Number(args[args.length - 1]);
          const results = db.edges
            .filter((edge: any) => edge.source_id === requestedId || edge.target_id === requestedId)
            .filter((edge: any) => !type || edge.type === type)
            .map((edge: any) => {
              const neighborId = edge.source_id === requestedId ? edge.target_id : edge.source_id;
              const entry = db.entries.find((candidate: any) => candidate.id === neighborId);
              return entry ? { edge, entry } : null;
            })
            .filter((value: any) => value && !String(value.entry.tags ?? "[]").includes('"status:deprecated"'))
            .sort((a: any, b: any) => b.edge.weight - a.edge.weight
              || b.edge.created_at - a.edge.created_at
              || String(a.edge.source_id).localeCompare(String(b.edge.source_id))
              || String(a.edge.target_id).localeCompare(String(b.edge.target_id))
              || String(a.edge.type).localeCompare(String(b.edge.type)))
            .slice(offset, offset + limit)
            .map(({ edge, entry }: any) => ({
              source_id: edge.source_id,
              target_id: edge.target_id,
              type: edge.type,
              weight: edge.weight,
              provenance: edge.provenance,
              created_at: edge.created_at,
              id: entry.id,
              content: entry.content,
              tags: entry.tags,
              source: entry.source,
              entry_created_at: entry.created_at,
            }));
          return { results };
        }
        if (s.startsWith("WITH incident AS") && s.includes("ROW_NUMBER() OVER") && s.includes("FROM ranked WHERE rank <= ?")) {
          const fanout = Number(args[args.length - 1]);
          const placeholderList = s.match(/source_id IN \(([^)]+)\)/)?.[1] ?? "";
          const frontierSize = (placeholderList.match(/\?/g) ?? []).length;
          const hasType = s.includes("AND type = ?");
          const type = hasType ? String(args[frontierSize]) : undefined;
          const secondFrontierStart = frontierSize + (hasType ? 1 : 0);
          const frontier = new Set([
            ...args.slice(0, frontierSize),
            ...args.slice(secondFrontierStart, secondFrontierStart + frontierSize),
          ].map(String));
          const byNode = new Map<string, any[]>();
          for (const edge of db.edges) {
            if (type && edge.type !== type) continue;
            for (const from of [edge.source_id, edge.target_id]) {
              if (!frontier.has(from)) continue;
              const rows = byNode.get(from) ?? [];
              rows.push({ from_id: from, source_id: edge.source_id, target_id: edge.target_id, type: edge.type, weight: edge.weight, provenance: edge.provenance, created_at: edge.created_at });
              byNode.set(from, rows);
            }
          }
          const results = [...byNode.values()].flatMap(rows => rows
            .sort((a, b) => b.weight - a.weight || b.created_at - a.created_at || String(a.source_id).localeCompare(String(b.source_id)) || String(a.target_id).localeCompare(String(b.target_id)))
            .slice(0, fanout))
            .sort((a, b) => b.weight - a.weight || b.created_at - a.created_at);
          return { results };
        }
        if (s.startsWith("SELECT op_id, entry_id, vector_ids, ready, expires_at FROM vector_cleanup_ops")) {
          const now = Number(args[0]);
          const eligible = s.includes("WHERE ready = 1")
            ? db.vectorCleanupOps.filter(op => op.ready === 1 || op.expires_at <= now)
            : db.vectorCleanupOps;
          return { results: [...eligible].sort((a, b) => a.created_at - b.created_at).slice(0, 10) };
        }
        if (s.startsWith("SELECT id, vector_ids FROM entries WHERE id IN")) {
          const ids = new Set(s.includes("json_each(?)") ? JSON.parse(args[0] as string) : args.map(String));
          return { results: db.entries.filter((row: any) => ids.has(row.id)).map((row: any) => ({ id: row.id, vector_ids: row.vector_ids })) };
        }
        if (s.includes("WHERE (pinned = 1 OR memory_tier = 'hot')")) {
          const results = [...db.entries]
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              return (e.pinned === 1 || e.memory_tier === "hot") && !tags.includes("status:deprecated");
            })
            .sort((a: any, b: any) =>
              (b.importance_score ?? 0) - (a.importance_score ?? 0)
              || (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at)
              || String(a.id).localeCompare(String(b.id)))
            .slice(0, 200)
            .map((e: any) => ({ ...e, last_updated: e.updated_at ?? e.created_at }));
          return { results };
        }
        if (s === "SELECT source_id, target_id, type FROM edges") {
          return {
            results: db.edges.map((e: any) => ({
              source_id: e.source_id,
              target_id: e.target_id,
              type: e.type,
            })),
          };
        }
        if (
          sBare === "SELECT id FROM entries WHERE tags LIKE ?" ||
          sBare === "SELECT id, vector_ids FROM entries WHERE tags LIKE ?" ||
          sBare.startsWith("SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ?")
        ) {
          const pattern = String(args[0]);
          const tag = tagFromLikePattern(pattern);
          const results = db.entries
            .filter((e: any) => tagMatchesLike(JSON.parse(e.tags ?? "[]"), tag) && matchesRecallFilters(e))
            .map((e: any) => ({ id: e.id, vector_ids: e.vector_ids ?? "[]", content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results };
        }
        if (!s.startsWith("WITH ") && /WHERE \(?content LIKE/.test(s) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(s)) {
          // Keyword (hybrid recall) query: content LIKE ? OR content LIKE ? ... LIMIT ?
          const limit = Number(args[args.length - 1]);
          const [whereSql, orderSql = ""] = s.split(" ORDER BY ");
          const unwrap = (a: any) => String(a).replace(/^%/, "").replace(/%$/, "").toLowerCase();
          const patterns = args.slice(0, (whereSql.match(/content LIKE \?/g) ?? []).length).map(unwrap);
          const orderPatterns = args.slice(-1 - (orderSql.match(/CASE WHEN content LIKE \?/g) ?? []).length, -1).map(unwrap);
          const wordHits = (e: any) => orderPatterns.filter((p: string) => String(e.content).toLowerCase().includes(p)).length;
          return { results: [...db.entries]
            .filter((e: any) => matchesRecallFilters(e) && patterns.some((p: string) => String(e.content).toLowerCase().includes(p)))
            .sort((a: any, b: any) => wordHits(b) - wordHits(a) || b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at })) };
        }
        if (/WHERE \(?content LIKE/.test(s) && s.includes("ORDER BY created_at DESC LIMIT")) {
          // Keyword (hybrid recall) query: content LIKE ? OR content LIKE ? ... LIMIT ?. The keyword arm asks for per-term match levels
          // instead of the text (src/recall/keyword-rows.ts): the binds end with the lowercased terms (each once, referenced by number) after the limit.
          const nTerms = (s.match(/ AS p\d+/g) ?? []).length;
          const tail = nTerms;
          const limit = Number(args[args.length - 1 - tail]);
          const patterns = args.slice(0, args.length - 1 - tail).map((a: any) => String(a).replace(/^%/, "").replace(/%$/, "").toLowerCase());
          const terms: string[] = args.slice(args.length - tail).map((a: any) => String(a));
          const alone = (lc: string, at: number, len: number) => !/\w/.test(lc[at - 1] ?? "") && !/\w/.test(lc[at + len] ?? "");
          const level = (lc: string, t: string): number => {
            const first = lc.indexOf(t);
            if (first < 0) return 0;
            if (alone(lc, first, t.length)) return 2;
            const second = lc.indexOf(t, first + 1);
            return second >= 0 && alone(lc, second, t.length) ? 2 : 1;
          };
          const rows = [...db.entries]
            .filter((e: any) => matchesRecallFilters(e) && patterns.some((p: string) => String(e.content).toLowerCase().includes(p)))
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => {
              const lc = String(e.content).toLowerCase();
              const row: Record<string, unknown> = { id: e.id, created_at: e.created_at, tags: e.tags, source: e.source, ...(s.includes("THEN content END AS content") && e.content.length > 400 ? { content: e.content } : {}) };
              terms.forEach((t, i) => { row[`l${i}`] = level(lc, t); });
              return row;
            });
          return { results: rows };
        }
        if (s.startsWith("SELECT x.id, x.weight, source.tags AS source_tags, target.tags AS target_tags FROM edges x")) {
          const ceiling = Number(args[0]);
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? Number(limitMatch[1]) : 90;
          const results = [...db.edges]
            .filter((edge: any) => edge.provenance === "inferred" && edge.type === "relates_to" && edge.weight < ceiling)
            .sort((a: any, b: any) => a.updated_at - b.updated_at)
            .flatMap((edge: any) => {
              const source = db.entries.find((entry: any) => entry.id === edge.source_id);
              const target = db.entries.find((entry: any) => entry.id === edge.target_id);
              return source && target ? [{ id: edge.id, weight: edge.weight, source_tags: source.tags, target_tags: target.tags }] : [];
            })
            .slice(0, limit);
          return { results };
        }
        if (s.startsWith("SELECT e.id, e.content, e.created_at FROM entries e") && s.includes("g.source_id = e.id")) {
          const marker = String(args[0]).replace(/^%|%$/g, "");
          const workspace = String(args[1]);
          const after = args.length > 3 ? { at: Number(args[2]), id: String(args[4]) } : null;
          const limit = Number(args.at(-1));
          const linked = new Set(db.edges.flatMap(edge => [edge.source_id, edge.target_id]));
          const results = db.entries.filter(entry => {
            const tags: string[] = JSON.parse(entry.tags ?? "[]");
            const older = !after || entry.created_at < after.at || (entry.created_at === after.at && entry.id < after.id);
            const legacy = db.edges.some(edge => edge.provenance === "inferred" && edge.type === "relates_to"
              && (edge.source_id === entry.id || edge.target_id === entry.id) && !String(edge.metadata ?? "").includes(marker));
            return (entry.workspace_id ?? "") === workspace && older && !tags.includes("status:deprecated")
              && !tags.includes("duplicate-candidate") && (legacy || !linked.has(entry.id));
          }).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
            .slice(0, limit).map(entry => ({ id: entry.id, content: entry.content, created_at: entry.created_at }));
          return { results };
        }
        if (s.startsWith("SELECT e.id, e.content FROM entries e") && s.includes("COALESCE(x.metadata, '') NOT LIKE ?")) {
          const marker = String(args[0]).replace(/^%|%$/g, "");
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? Number(limitMatch[1]) : 8;
          const results = [...db.entries]
            .filter((entry: any) => {
              const tags = JSON.parse(entry.tags ?? "[]") as string[];
              if (tags.includes("status:deprecated")) return false;
              return db.edges.some((edge: any) => edge.provenance === "inferred" && edge.type === "relates_to"
                && (edge.source_id === entry.id || edge.target_id === entry.id)
                && !String(edge.metadata ?? "").includes(marker));
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((entry: any) => ({ id: entry.id, content: entry.content }));
          return { results };
        }
        if (s.includes("FROM entries") && s.includes("id NOT IN (SELECT source_id FROM edges)")) {
          // runGraphPass backfill: entries not referenced by any edge, newest first.
          const linked = new Set(db.edges.flatMap((e: any) => [e.source_id, e.target_id]));
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => {
              if (linked.has(e.id)) return false;
              if (s.includes('"status:deprecated"') && (JSON.parse(e.tags ?? "[]") as string[]).includes("status:deprecated")) return false;
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, workspace_id: e.workspace_id ?? "" }));
          return { results: rows };
        }
        if (s.includes("SELECT id, workspace_id, tags, created_at, source FROM entries WHERE id IN")) {
          // inferEdgesOnWrite's one endpoint read: the source row's workspace (to
          // stamp the edge with), each candidate neighbour's (to refuse a pair that
          // disagrees), and — piggybacked on the same statement — the tags and
          // timestamps `follows` typing needs. Rows seeded without the column read
          // as "", the pre-tenancy value, so a fixture that says nothing about
          // workspaces still links exactly as it did.
          //
          // The projection is matched in full ON PURPOSE. When this branch listed
          // only `id, workspace_id` it silently stopped matching the moment
          // production widened the SELECT, and every mock-backed inference then saw
          // ZERO endpoint rows — no workspace refusal, no kind, no timestamps —
          // while the tests kept passing for the wrong reason.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({
              id: e.id,
              workspace_id: e.workspace_id ?? "",
              tags: e.tags ?? "[]",
              created_at: e.created_at ?? 0,
              source: e.source ?? "api",
            }));
          return { results };
        }
        // The disconnect purge's landed-ids read: which of this batch's ids actually got a trash row.
        if (s.startsWith("SELECT id FROM entries_trash WHERE reason = 'disconnect' AND deleted_at =")) {
          const [deletedAt, deletedBy, idsJson] = args;
          const ids = new Set(JSON.parse(idsJson) as string[]);
          const results = db.trash.filter((r: any) => r.reason === "disconnect" && r.deleted_at === deletedAt && r.deleted_by === deletedBy && ids.has(r.id))
            .map((r: any) => ({ id: r.id }));
          return { results };
        }
        // The trash size read (trashSizeSelect): sizes are not modelled beyond content, which is enough for tier 1.
        if (s.includes("length(CAST(e.content AS BLOB)) AS content_bytes")) {
          const ids = JSON.parse(args[0]) as string[];
          const results = db.entries.filter((e: any) => ids.includes(e.id)).map((e: any) => ({
            id: e.id, workspace_id: e.workspace_id ?? "", actor_id: e.actor_id ?? "", vector_ids: e.vector_ids ?? "[]",
            content_bytes: Buffer.byteLength(e.content ?? ""), row_json_bytes: 300, edges_json_bytes: 2,
            vector_ids_bytes: Buffer.byteLength(e.vector_ids ?? "[]"),
          }));
          return { results };
        }
        if (s.includes("SELECT id, tags FROM entries WHERE id IN")
          || s.includes("SELECT id, tags, workspace_id FROM entries WHERE id IN")) {
          const ids = new Set(args.map(String));
          const results = db.entries
            .filter((e: any) => ids.has(String(e.id)))
            .map((e: any) => ({
              id: e.id,
              tags: e.tags ?? "[]",
              ...(s.includes("workspace_id") ? { workspace_id: e.workspace_id ?? "" } : {}),
            }));
          return { results };
        }
        if (s.includes("SELECT id FROM entries WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id }));
          return { results };
        }
        if (s.includes("SELECT source_id, target_id, type FROM edges WHERE source_id IN") && s.includes("OR target_id IN")) {
          const ids = new Set(args.map((a: any) => String(a)));
          const results = db.edges
            .filter((e: any) => ids.has(e.source_id) || ids.has(e.target_id))
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id, type: e.type }));
          return { results };
        }
        if (s.includes("FROM edges WHERE source_id IN") && s.includes("OR target_id IN")) {
          // expandGraph BFS / graph edge fetch: every edge touching the frontier, strongest
          // first. Args are the frontier id list bound twice (source_id IN …, target_id IN …).
          const ids = new Set(args.map((a: any) => String(a)));
          const results = db.edges
            .filter((e: any) => ids.has(e.source_id) || ids.has(e.target_id))
            .sort((a: any, b: any) => b.weight - a.weight)
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id, type: e.type, weight: e.weight, provenance: e.provenance, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("FROM edges ORDER BY weight DESC")) {
          // buildGraph default mode: strongest edges first (to derive the node set).
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : db.edges.length;
          const results = [...db.edges]
            .sort((a: any, b: any) => b.weight - a.weight)
            .slice(0, limit)
            .map((e: any) => ({
              source_id: e.source_id, target_id: e.target_id, type: e.type,
              weight: e.weight, provenance: e.provenance, created_at: e.created_at,
            }));
          return { results };
        }
        if (s.includes("FROM entries e LEFT JOIN users u ON u.id = e.actor_id")) {
          // buildGraph node hydration. workspace_id/actor_id/source are what the
          // node's `workspace` layer and `actor_name` are derived from; a row
          // seeded without them reads as "", the pre-tenancy value. The join is
          // modelled rather than ignored — it is where the author's name comes
          // from now, and a soft-removed member must resolve to no name at all
          // so the caller falls through to "Former member".
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => {
              const author = db.users.find((u: any) =>
                u.id === (e.actor_id ?? "") && !u.removed_at);
              return {
                id: e.id, content: e.content, tags: e.tags,
                importance_score: e.importance_score ?? 0, created_at: e.created_at,
                workspace_id: e.workspace_id ?? "", actor_id: e.actor_id ?? "",
                source: e.source ?? "", actor_display_name: author?.name ?? null,
                valid_until: e.valid_until ?? null,
              };
            });
          return { results };
        }
        if (s.includes("SELECT id, tags, valid_from, valid_until, created_at FROM entries WHERE id IN")) {
          // expandGraph deprecation and validity check (T-0089.2.1/2.2).
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, tags: e.tags, valid_from: e.valid_from ?? null, valid_until: e.valid_until ?? null, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, source, created_at, valid_until FROM entries WHERE id IN") && !s.includes("tags NOT LIKE")) {
          // Graph node hydration (/connections, /graph). The `tags NOT LIKE` guard
          // keeps this from shadowing recall's hydration query (same columns, but it
          // applies the auto-pattern/deprecated/kind filters itself further down).
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at, valid_until: e.valid_until ?? null }));
          return { results };
        }
        if (s.includes("recall_count, importance_score") && s.includes("WHERE id IN")) {
          const includesContent = s.startsWith("SELECT id, content,");
          const includesHydrationFields = s.startsWith("SELECT id, content, source, created_at, COALESCE(updated_at, created_at) AS last_updated,");
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({
              id: e.id,
              ...(includesContent ? { content: e.content } : {}),
              ...(includesHydrationFields ? {
                source: e.source,
                created_at: e.created_at,
                last_updated: e.updated_at ?? e.created_at,
              } : {}),
              recall_count: e.recall_count ?? 0,
              importance_score: e.importance_score ?? 0,
              contradiction_wins: e.contradiction_wins ?? 0,
              contradiction_losses: e.contradiction_losses ?? 0,
              tags: e.tags ?? "[]",
            }));
          return { results };
        }
        if (s.includes("SELECT tags FROM entries WHERE id = ?")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return { results: row ? [{ tags: row.tags }] : [] };
        }
        if (s.startsWith("SELECT id, tags, content FROM entries WHERE id IN")) {
          // Staleness retry re-read: fresh tags and content for every row whose CAS lost,
          // in one statement. Rows deleted mid-pass simply do not come back.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, tags: e.tags, content: e.content }));
          return { results };
        }
        if (s.includes("COALESCE(updated_at, created_at) < ?") && s.includes("SELECT id, content, tags FROM entries")) {
          // Bind order (spec 14 5.8, T-0089.2.3): volatileCutoff, now (when_at), stateCutoff,
          // now (validity), workspace_id (only when the slice clause is present, always last).
          const hasSlice = s.includes("AND workspace_id = ?");
          let i = 0;
          const volatileCutoff = Number(args[i++]);
          const whenNowArg = Number(args[i++]);
          const stateCutoff = Number(args[i++]);
          const nowArg = Number(args[i++]);
          const workspaceId = hasSlice ? args[i++] : undefined;
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          // This handler, and the other `tags.includes("auto-pattern"/"auto-insight")`
          // checks below (the recall hydration branches and the digest-candidate
          // branch), enforce the exclusion UNCONDITIONALLY — in JS, on every row,
          // regardless of what the matched SQL string actually says. Unlike
          // `tagMatchesLike` above, which at least reads the bind parameter, these
          // never look at whether the real query has a `tags NOT LIKE
          // '%"auto-pattern"%'`-shaped clause at all. A production query that lost
          // that clause entirely would still be filtered here and the test would
          // stay green. Anything whose subject IS one of those exclusion clauses —
          // asserting it exists, asserting its exact shape — is untestable against
          // this mock and belongs in a `sqlite-d1`-backed test instead.
          const results = [...db.entries]
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              if (tags.includes("status:deprecated")) return false;
              if (tags.includes("auto-pattern")) return false;
              if (tags.includes("auto-insight")) return false;
              if (tags.includes("synthesized")) return false;
              if (tags.includes("rolled-up")) return false;
              const validUntil = e.valid_until ?? null;
              if (!(validUntil == null || validUntil > nowArg)) return false;
              if (hasSlice && (e.workspace_id ?? "") !== workspaceId) return false;
              const touched = e.updated_at ?? e.created_at;
              if (tags.includes("volatility:volatile")) {
                const whenAt = e.when_at ?? null;
                return touched < volatileCutoff || (whenAt != null && whenAt < whenNowArg);
              }
              return touched < stateCutoff;
            })
            .sort((a: any, b: any) => (a.staleness_checked_at ?? 0) - (b.staleness_checked_at ?? 0))
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, source, created_at, updated_at FROM entries WHERE id IN") || s.includes("SELECT id, content, tags, source, created_at, updated_at, workspace_id FROM entries WHERE id IN")) {
          const inMatch = s.match(/WHERE id IN \(([^)]*)\)/);
          const idCount = inMatch ? inMatch[1].split(",").length : 0;
          const ids = args.slice(0, idCount);
          const rest = args.slice(idCount);
          let argIdx = 0;
          const kindMatch = s.match(/tags LIKE '%"(kind:(?:episodic|semantic))"%'/);
          const explicitTag = s.includes("tags LIKE ?")
            ? tagFromLikePattern(String(rest[argIdx++]))
            : null;
          // Unconditional exclusion, not derived from `s` — see the note above the
          // first such check in this file.
          let rows = db.entries.filter((e: any) => {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!ids.includes(e.id)) return false;
            if (tags.includes("auto-pattern")) return false;
            if (tags.includes("auto-insight")) return false;
            if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
            if (explicitTag !== null && !tagMatchesLike(tags, explicitTag)) return false;
            if (kindMatch && !tags.includes(kindMatch[1])) return false;
            return true;
          });
          if (s.includes("created_at >= ?")) {
            const after = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          const results = rows.map((e: any) => ({
            id: e.id,
            content: e.content,
            tags: e.tags,
            source: e.source,
            created_at: e.created_at,
            updated_at: e.updated_at ?? e.created_at,
          }));
          return { results };
        }
        if (s.includes("FROM entries WHERE id IN") && s.includes("tags NOT LIKE")) {
          // recallEntries D1 hydration — filter by IDs, exclude auto-pattern/auto-insight entries, apply after/before
          const inMatch = s.match(/WHERE id IN \(([^)]*)\)/);
          const idCount = inMatch ? inMatch[1].split(",").length : 0;
          const ids = args.slice(0, idCount);
          const rest = args.slice(idCount);
          let argIdx = 0;
          const kindMatch = s.match(/tags LIKE '%"(kind:(?:episodic|semantic))"%'/);
          // Unconditional exclusion, not derived from `s` — see the note above the
          // first such check in this file.
          let rows = db.entries.filter((e: any) => {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!ids.includes(e.id)) return false;
            if (tags.includes("auto-pattern")) return false;
            if (tags.includes("auto-insight")) return false;
            if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
            if (kindMatch && !tags.includes(kindMatch[1])) return false;
            return true;
          });
          if (s.includes("created_at >= ?")) {
            const after = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          const results = rows.map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, COALESCE(updated_at, created_at) AS row_version FROM entries") && s.includes("WHERE tags LIKE") && s.includes("ORDER BY created_at DESC")) {
          // compressTag raw entries query — tag match, system-tag exclusion, and the
          // recall/age/contradiction eligibility predicate (cutoff is the 2nd bind param).
          const tagPattern = args[0] as string;
          const tag = tagFromLikePattern(tagPattern);
          const cutoff = Number(args[1]);
          const workspaceId = s.includes("workspace_id = ?") ? String(args[2] ?? "") : undefined;
          // The synthesized/auto-pattern/auto-insight/rolled-up exclusion below is
          // unconditional, not derived from `s` — see the note above the first such
          // check in this file.
          const results = [...db.entries]
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              if (!tagMatchesLike(tags, tag)) return false;
              if (workspaceId !== undefined && String(e.workspace_id ?? "") !== workspaceId) return false;
              if (tags.includes("synthesized") || tags.includes("auto-pattern") || tags.includes("auto-insight") || tags.includes("rolled-up")) return false;
              // Capsule definitions are never digest members (digest.ts `tags NOT LIKE '%"capsule:%'`).
              if (tags.some(t => t.toLowerCase().startsWith("capsule:"))) return false;
              // Codex review class E (T-0089.4.2): a held row's content must never reach the
              // digest model's prompt — excludeHeld's own behavior, mirrored here.
              if (tags.some(t => t.toLowerCase().startsWith("quarantine:"))) return false;
              if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) return false;
              const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
              if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) return false;
              if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) return false;
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, 50)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, row_version: e.updated_at ?? e.created_at }));
          return { results };
        }
        if (s.includes("SELECT id, content FROM entries WHERE id IN") || s.includes("SELECT id, content, tags, valid_until FROM entries WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, valid_until: e.valid_until ?? null }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("HAVING count > 10")) {
          // Digest-candidate query (nightly compression + /stats): per-tag count of
          // entries that pass the compression eligibility predicate. Cutoff is args[0].
          const cutoff = Number(args[0]);
          const counts = new Map<string, number>();
          // Unconditional exclusion, not derived from `s` — see the note above the
          // first such check in this file.
          for (const e of db.entries as any[]) {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (tags.includes("rolled-up") || tags.includes("synthesized") || tags.includes("auto-pattern") || tags.includes("auto-insight")) continue;
            if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) continue;
            const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
            if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) continue;
            if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) continue;
            for (const t of tags) {
              // The same predicate isCompressionTagSql() is generated from, rather than a second
              // copy of the rule: a double that filters differently from production hides
              // exactly the bugs it is supposed to catch.
              if (!isCompressionTag(t)) continue;
              counts.set(t, (counts.get(t) ?? 0) + 1);
            }
          }
          const results = [...counts.entries()]
            .filter(([, c]) => c > 10)
            .sort((a, b) => b[1] - a[1])
            .map(([tag, count]) => ({ tag, count }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("GROUP BY value")) {
          // Top tags by frequency — for /stats
          const freq = new Map<string, number>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => freq.set(t, (freq.get(t) ?? 0) + 1));
          });
          const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
          return { results: sorted.map(([value, n]) => ({ value, n })) };
        }
        if (s.includes("SELECT DISTINCT workspace_id, value") && s.includes("json_each(entries.tags)")) {
          // The general workspace-scope shim above strips the IN clause for
          // legacy mock handlers. An empty binding list therefore means this
          // double's documented "all seeded rows are readable" mode.
          const wanted = args.length
            ? new Set(args.map((value: unknown) => String(value ?? "")))
            : null;
          const seen = new Set<string>();
          const results: { workspace_id: string; value: string }[] = [];
          for (const entry of db.entries as any[]) {
            const workspaceId = String(entry.workspace_id ?? "");
            if (wanted && !wanted.has(workspaceId)) continue;
            for (const value of JSON.parse(entry.tags ?? "[]") as string[]) {
              const key = `${workspaceId}\u0000${value}`;
              if (seen.has(key)) continue;
              seen.add(key);
              results.push({ workspace_id: workspaceId, value });
            }
          }
          return { results };
        }
        if (s.includes("json_each(entries.tags)")) {
          // Distinct sorted tags — for /tags
          const tags = new Set<string>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => tags.add(t));
          });
          return { results: [...tags].sort().map(t => ({ value: t })) };
        }
        if (s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`) && s.includes("ORDER BY created_at ASC LIMIT")) {
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:'))
            .sort((a: any, b: any) => a.created_at - b.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags,
              ...(s.includes("workspace_id") ? { workspace_id: e.workspace_id ?? "" } : {}),
            }));
          return { results: rows };
        }
        if (s.includes("json_array_length(pending_append_passages)")
          && s.includes("ORDER BY CASE WHEN vector_ids = '[]' THEN 0 ELSE 1 END")) {
          const cutoff = Number(args[0]);
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => {
              if (String(e.tags).includes('"status:deprecated"')) return false;
              if (e.vector_ids === "[]") return e.created_at < cutoff;
              try {
                const passages = JSON.parse(e.pending_append_passages ?? "[]");
                return Array.isArray(passages) && passages.length > 0;
              } catch { return false; }
            })
            .sort((a: any, b: any) =>
              Number(a.vector_ids !== "[]") - Number(b.vector_ids !== "[]")
              || a.created_at - b.created_at)
            .slice(0, limit)
            .map((e: any) => ({
              id: e.id,
              content: e.content,
              tags: e.tags,
              source: e.source,
              created_at: e.created_at,
              vector_ids: e.vector_ids,
              workspace_id: e.workspace_id ?? "",
              actor_id: e.actor_id ?? "",
              pending_append_passages: e.pending_append_passages ?? "[]",
            }));
          return { results: rows };
        }
        if (s.includes("vector_ids = '[]' AND created_at <") && s.includes("ORDER BY created_at ASC LIMIT")) {
          const cutoff = Number(args[0]);
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff)
            .sort((a: any, b: any) => a.created_at - b.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results: rows };
        }
        if (s.startsWith("SELECT id, content, tags, source, created_at, COALESCE(updated_at, created_at) AS last_updated") && s.includes("FROM entries ORDER BY created_at ASC")) {
          // Complete and paged export share one deterministic projection.
          let results = [...db.entries]
            .sort((a: any, b: any) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)))
            .map((e: any) => ({
              id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at,
              last_updated: e.updated_at ?? e.created_at,
              recall_count: e.recall_count ?? 0, importance_score: e.importance_score ?? 0,
              contradiction_wins: e.contradiction_wins ?? 0, contradiction_losses: e.contradiction_losses ?? 0,
              memory_tier: e.memory_tier ?? "warm", pinned: e.pinned ?? 0,
              last_recalled_at: e.last_recalled_at ?? null,
              workspace_id: e.workspace_id ?? "", actor_id: e.actor_id ?? "",
            }));
          if (s.includes("LIMIT ? OFFSET ?")) {
            results = results.slice(Number(args[1]), Number(args[1]) + Number(args[0]));
          }
          return { results };
        }
        if (s.startsWith("SELECT id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id FROM edges")) {
          let results = [...db.edges]
            .sort((a: any, b: any) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)))
            .map((e: any) => ({
            id: e.id, source_id: e.source_id, target_id: e.target_id, type: e.type,
            weight: e.weight, provenance: e.provenance, metadata: e.metadata,
            created_at: e.created_at, updated_at: e.updated_at, workspace_id: e.workspace_id ?? "",
          }));
          if (s.includes("LIMIT ? OFFSET ?")) {
            results = results.slice(Number(args[1]), Number(args[1]) + Number(args[0]));
          }
          return { results };
        }
        if (s.includes("ORDER BY created_at DESC LIMIT")) {
          const limit = Number(args[args.length - 1]);
          const filterArgs = args.slice(0, -1);
          let argIdx = 0;
          let rows = [...db.entries];
          if (s.includes("tags LIKE ?")) {
            const pattern = String(filterArgs[argIdx++]);
            const tag = tagFromLikePattern(pattern);
            rows = rows.filter((e: any) => tagMatchesLike(JSON.parse(e.tags ?? "[]"), tag));
          }
          if (s.includes("created_at >= ?")) {
            const after = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          rows.sort((a: any, b: any) => b.created_at - a.created_at);
          return { results: rows.slice(0, limit) };
        }
        return { results: [] };
      }
      };
      return stmt;
    };
    return {
      __sql: s,
      bind(...args: any[]) { return makeStmt(args); },
      ...makeStmt([]),
    };
  }
  async exec(sql: string) {
    if (sql.startsWith("INSERT INTO memory_write_epoch") && this.memoryWriteEpoch === null) {
      this.memoryWriteEpoch = "d1-mock-generation";
    }
  }
  async batch(stmts: any[]) {
    return Promise.all(stmts.map((stmt: any) => stmt.run()));
  }
  reset() {
    this.schemaVersion = 9;
    this.entries = [];
    this.edges = [];
    this.users = [];
    this.workspaces = [];
    this.memberships = [];
    this.failEntryInsertIds.clear();
    this.migrationControl = null;
    this.memoryWriteAdmissions.clear();
    this.embeddingMigrationGeneration = null;
    this.vectorCleanupOps = [];
    this.appendReceipts = [];
    this.restoreState = null;
  }
}
