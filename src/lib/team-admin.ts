import { memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import { resolveConfig } from "../config";
import { hashToken } from "./identity";
import {
  D1_MAX_BOUND_PARAMS, MEMBER_HISTORY_CHUNK, MEMBER_HISTORY_MAX_CHUNKS, MEMBER_HISTORY_SLICE,
} from "../constants";
import type { OwnedVectors } from "../vectorize/batch";
import { standingTouched } from "../standing/cache";

/** Team membership, workspace, and offboarding operations. */

export interface TeamMember {
  userId: string;
  name: string;
  email: string | null;
  role: "admin" | "member";
  suspended: boolean;
  createdAt: number;
  /**
   * Last successful identity resolution for this member's token, or null for a
   * member who has not authenticated since the column shipped. Up to an hour
   * stale by design — see LAST_USED_THROTTLE_MS in src/lib/identity.ts.
   */
  lastUsedAt: number | null;
  personalWorkspaceId: string;
  /** Entries living in the member's personal workspace. */
  privateEntries: number;
  /** Capture-visibility override: "personal", "company", or "" (inherit org default). */
  defaultShare: "personal" | "company" | "";
}

export async function generateToken(): Promise<{ token: string; tokenHash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64url: safe in URLs, shell arguments and JSON without escaping.
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { token, tokenHash: await hashToken(token) };
}

/** Count active and suspended users; suspension does not remove team membership. */
export async function countActiveMembers(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    // scope-exempt: deployment-wide headcount, with no content exposed
    `SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL OR removed_at = 0`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Resolve team mode from the stored intent and current membership count.
 *
 * "off" is deliberately soft: it hits the same floor (activeMembers > 1) as an
 * unset mode, and POST /config refuses to even store an explicit "off" while
 * that floor holds (src/routes/config.ts). This function is the backstop for a
 * stored "off" that predates the members it now governs — which is why there is
 * no separate branch for it.
 */
export function resolveTeamFlag(mode: string, activeMembers: number): boolean {
  if (mode === "on") return true;
  return activeMembers > 1;
}

/** Return the effective team-mode flag published by GET /health. */
export async function isTeamBrain(env: Env): Promise<boolean> {
  const config = await resolveConfig(env);
  if (config.TEAM_MODE === "on") return true;
  return resolveTeamFlag(config.TEAM_MODE, await countActiveMembers(env));
}

export async function listMembers(env: Env): Promise<TeamMember[]> {
  const { results } = await env.DB.prepare(
    // scope-exempt: admin member list: the subselect counts rows in each member's OWN workspace (e.workspace_id = w.id) and yields a number, never content
    `SELECT u.id AS userId, u.name, u.email, u.role, u.suspended, u.created_at AS createdAt,
            u.default_share AS defaultShare, u.last_used_at AS lastUsedAt,
            w.id AS personalWorkspaceId,
            (SELECT COUNT(*) FROM entries e WHERE e.workspace_id = w.id) AS privateEntries
     FROM users u
     JOIN memberships m ON m.user_id = u.id
     JOIN workspaces w ON w.id = m.workspace_id AND w.kind = 'personal'
     WHERE u.removed_at IS NULL OR u.removed_at = 0
     ORDER BY u.created_at ASC, u.id ASC`
  ).all<TeamMember & { defaultShare: string | null }>();
  return (results ?? []).map((r) => ({
    ...r,
    suspended: !!r.suspended,
    // SQLite hands NULL back as null already; the coalesce is for D1's own
    // undefined-for-absent-column behaviour on a brain mid-migration.
    lastUsedAt: r.lastUsedAt ?? null,
    defaultShare: r.defaultShare === "company" ? "company" : r.defaultShare === "personal" ? "personal" : "",
  }));
}

/**
 * One person as a PEER may see them. Three fields, and the type is the
 * allowlist: everything on TeamMember above that is missing here is missing
 * deliberately.
 *   - `email`, `createdAt` and `lastUsedAt` are personal data about a colleague.
 *   - `privateEntries` counts rows in a workspace the caller cannot read, and a
 *     count is still a fact about someone's private memory.
 *   - `personalWorkspaceId` is a scoping key, so publishing it hands every
 *     member the identifier every other member's rows are keyed by.
 *   - `defaultShare` is a policy no peer has a say over.
 *   - `suspended` is an employment fact; see listRoster's WHERE.
 * `userId` stays because the client needs a stable key to mark "you".
 */
export interface RosterMember {
  userId: string;
  name: string;
  role: "admin" | "member";
}

/**
 * The people in the caller's own teams: names and roles, nothing else.
 *
 * The member-facing twin of listMembers. Two things make it safe to hand to a
 * non-admin, and both are properties of the query rather than of the caller:
 *
 * 1. The columns are named POSITIVELY. It is a three-column SELECT, not
 *    `u.*` with fields deleted afterwards — so a column added to `users`
 *    tomorrow (the next `lastUsedAt`) cannot appear here by default. Widening
 *    this list has to be a deliberate edit to this line, which is what
 *    test/integration/team-roster.test.ts's exhaustive key assertion pins.
 * 2. The set of PEOPLE is scoped through `memberships` to the workspace ids on
 *    the caller's resolved identity — never a bare `FROM users`. Constraint 1
 *    applies to people as much as to memories: on a deployment with two company
 *    workspaces, this join is the thing that stops one team's roster reaching
 *    the other.
 *
 * Suspended members are omitted rather than flagged. A suspended member cannot
 * authenticate, so they are not someone you can share with; and publishing the
 * flag would publish an employment fact only an admin has business knowing.
 * Admins keep the full picture — suspension included — through GET /team/members.
 *
 * DISTINCT because a colleague in two of the caller's teams is two membership
 * rows and one person.
 *
 * COLLATE NOCASE on the sort because SQLite's default BINARY collation orders
 * every uppercase letter before every lowercase one, so "alice" would come
 * after "Zoe" and a team with mixed-case names would read as unsorted. `u.id`
 * stays as the tiebreaker so two people with the same name still have a stable
 * order.
 */
export async function listRoster(env: Env, companyWorkspaceIds: string[]): Promise<RosterMember[]> {
  // A member of no team has no peers. Returning early also keeps the IN () list
  // from rendering empty, which SQLite rejects.
  if (!companyWorkspaceIds.length) return [];
  const placeholders = companyWorkspaceIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT u.id AS userId, u.name AS name, u.role AS role
       FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE m.workspace_id IN (${placeholders})
        AND u.suspended = 0
        AND (u.removed_at IS NULL OR u.removed_at = 0)
      ORDER BY u.name COLLATE NOCASE ASC, u.id ASC`,
  ).bind(...companyWorkspaceIds).all<{ userId: string; name: string | null; role: string }>();
  return (results ?? []).map((r) => ({
    userId: r.userId,
    name: r.name || "",
    // Narrowed rather than cast: the column is free text in SQLite, and an
    // unexpected value reading as "member" is the safe direction.
    role: r.role === "admin" ? "admin" : "member",
  }));
}

/**
 * Display names for ids that appear in an audit trail.
 *
 * NOT listRoster, and the difference is the whole point: listRoster excludes
 * suspended and removed people, and the two events an auditor most needs to
 * read are `member_suspended` and `member_removed`, whose subjects are
 * exactly those people. A trail that cannot name the person it is about is
 * not a trail.
 *
 * By-id, on ids that came out of admin_events / entry_events — the same
 * shape lookupActorLabels already uses — and it returns nothing but id and
 * name. It is reached only from GET /team/activity, which is requireAdmin,
 * and it publishes strictly less about a person than GET /team/members
 * already does on the same deployment.
 */
export async function lookupAuditNames(env: Env, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  // No ids, no statement. A feed whose every row carries an empty actor and an
  // empty subject — a solo brain's, typically — costs one subrequest, not two.
  // It also keeps `IN ()` from rendering empty, which SQLite rejects.
  if (!unique.length) return new Map();
  const names = new Map<string, string>();
  // Chunked against the platform's bound-parameter ceiling, the way every other
  // dynamic IN-list in src/ is (entries/import.ts, graph/traverse.ts,
  // insight/weekly.ts). The caller is GET /team/activity, whose `limit` is
  // admitted up to 100 and whose every admin row can carry TWO different people
  // — an actor and a subject — so one page can name up to 200 people. Unchunked
  // that is 200 bound parameters against a ceiling of 100: D1 rejects the
  // statement outright, and there is no try/catch between this line and the
  // platform, so the rejection is a 500 on every page of that team's compliance
  // feed rather than a degraded one. See the note at the route.
  //
  // Each id is bound ONCE, so the chunk is the whole ceiling rather than the
  // halved one the two-alias slice in insight/weekly.ts needs. That makes the
  // worst case two statements — two of the ~5 subrequests this route spends of
  // its 50 — and the common case, a page naming a hundred people or fewer, is
  // the one statement it has always been.
  //
  // The maps are MERGED, not replaced: a person whose id lands in the second
  // chunk is named in the response exactly like one in the first.
  for (let i = 0; i < unique.length; i += D1_MAX_BOUND_PARAMS) {
    const chunk = unique.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      // Removed and suspended rows are INCLUDED, unlike lookupActorLabels and
      // listRoster. See the doc comment: those are the subjects of the rows an
      // auditor came for.
      `SELECT id, name FROM users WHERE id IN (${placeholders})`,
    ).bind(...chunk).all<{ id: string; name: string | null }>();
    // A blank name is NOT an entry. Callers publish this as "a name or null" —
    // two states — and mapping a NULL or empty `users.name` to "" invents a
    // third that no consumer's contract admits: one written `actor ?? "System"`
    // renders an empty cell, one written `actor || "Removed account"` renders a
    // label, for the same row. Dropping the row makes the caller's `?? null`
    // produce the null it already documents.
    for (const r of results ?? []) if (r.name) names.set(r.id, r.name);
  }
  return names;
}

export class TeamAdminError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function changedRows(result: D1Result<unknown>): number {
  const meta = result.meta as Record<string, number>;
  return meta.changes ?? meta.rows_written ?? 0;
}

/** Same cap the team-name field enforces (renameTeamWorkspace). */
const MAX_MEMBER_NAME_LENGTH = 60;
/** RFC 5321 caps the forward-path at 254 octets. */
const MAX_MEMBER_EMAIL_LENGTH = 254;
/** Deliberately loose — shape, not deliverability: something, an @, a dot. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateMemberName(name: string): string {
  if (!name) throw new TeamAdminError(400, "name is required");
  if (name.length > MAX_MEMBER_NAME_LENGTH) {
    throw new TeamAdminError(400, `Member names are limited to ${MAX_MEMBER_NAME_LENGTH} characters`);
  }
  return name;
}

function validateMemberEmail(email: string): string {
  if (email.length > MAX_MEMBER_EMAIL_LENGTH) {
    throw new TeamAdminError(400, `Email addresses are limited to ${MAX_MEMBER_EMAIL_LENGTH} characters`);
  }
  if (!EMAIL_SHAPE.test(email)) {
    throw new TeamAdminError(400, "That does not look like an email address");
  }
  return email;
}

/**
 * The one INSERT/UPDATE failure that is a member-visible refusal rather than a
 * fault: idx_users_email (db/schema.sql) said no. Both D1 and node:sqlite surface
 * SQLite's own message.
 */
function isUniqueEmailViolation(e: unknown): boolean {
  return /UNIQUE constraint failed: users\.email/i.test(String((e as { message?: string })?.message ?? e));
}

export async function createMember(
  env: Env,
  input: { name?: string; email?: string | null; role?: "admin" | "member" },
): Promise<{ member: TeamMember; token: string }> {
  const name = validateMemberName(input.name?.trim() ?? "");
  const role = input.role === "admin" ? "admin" : "member";
  const email = input.email?.trim() || null;
  if (email) validateMemberEmail(email);

  if (email) {
    const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
    if (existing) throw new TeamAdminError(409, `A member with that email already exists`);
  }

  const now = Date.now();
  const userId = `usr-${crypto.randomUUID()}`;
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const companyId = await env.DB.prepare(
    `SELECT id FROM workspaces WHERE kind = 'company' ORDER BY created_at LIMIT 1`,
  ).first<{ id: string }>();
  if (!companyId) throw new TeamAdminError(500, "Deployment is not provisioned");

  const { token, tokenHash } = await generateToken();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).bind(userId, name, email, role, tokenHash, now),
      env.DB.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'personal', ?, ?)`).bind(workspaceId, name, now),
      env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`).bind(userId, workspaceId, now),
      env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`).bind(userId, companyId.id, now),
    ]);
  } catch (e) {
    // The pre-check above is advisory: two concurrent POSTs can both pass it.
    // idx_users_email is the real constraint, and the race's loser surfaces here
    // as the same 409 the winner's pre-check would have produced.
    if (isUniqueEmailViolation(e)) throw new TeamAdminError(409, `A member with that email already exists`);
    throw e;
  }

  return {
    member: {
      userId, name, email, role, suspended: false, createdAt: now,
      lastUsedAt: null,
      personalWorkspaceId: workspaceId, privateEntries: 0, defaultShare: "",
    },
    token,
  };
}

/** Rotates a member's token; the previous one stops resolving immediately. */
export async function rotateMemberToken(env: Env, userId: string): Promise<string> {
  const { token, tokenHash } = await generateToken();
  // Removed members are 404s, like every sibling write: a token minted for a
  // tombstoned row could never authenticate (identity excludes removed_at), and
  // handing an admin a credential-shaped dead end invites sharing it.
  const result = await env.DB.prepare(
    `UPDATE users SET token_hash = ? WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`,
  ).bind(tokenHash, userId).run();
  if (!changedRows(result)) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
  return token;
}

export async function setMemberSuspended(env: Env, actorId: string, userId: string, suspended: boolean): Promise<void> {
  if (userId === actorId && suspended) {
    throw new TeamAdminError(400, "You cannot suspend your own account");
  }
  const value = suspended ? 1 : 0;
  // Keep the last-admin check inside the write. Concurrent updates are
  // serialized by D1, so the second writer sees the first writer's result.
  const result = await env.DB.prepare(
    `UPDATE users AS target
        SET suspended = ?
      WHERE target.id = ?
        AND (target.removed_at IS NULL OR target.removed_at = 0)
        AND (
          ? = 0
          OR target.role != 'admin'
          OR EXISTS (
            SELECT 1 FROM users AS other
             WHERE other.id != target.id
               AND other.role = 'admin'
               AND other.suspended = 0
               AND (other.removed_at IS NULL OR other.removed_at = 0)
          )
        )`,
  ).bind(value, userId, value).run();
  if (changedRows(result)) return;

  const target = await env.DB.prepare(
    `SELECT role, removed_at FROM users WHERE id = ?`,
  ).bind(userId).first<{ role: string; removed_at: number | null }>();
  if (!target || Number(target.removed_at) > 0) {
    throw new TeamAdminError(404, `No member found with ID: ${userId}`);
  }
  if (suspended && target.role === "admin") {
    throw new TeamAdminError(400, "Cannot suspend the last active admin");
  }
  throw new TeamAdminError(409, "Member state changed concurrently; try again");
}

/**
 * Sets one member's capture-visibility override. "inherit" clears it, falling
 * back to the org's TEAM_DEFAULT_WORKSPACE config. Existing rows are untouched:
 * this governs where NEW captures land.
 */
export async function setMemberDefaultShare(
  env: Env,
  userId: string,
  value: "personal" | "company" | "inherit",
): Promise<void> {
  const stored = value === "inherit" ? "" : value;
  // Removed members are 404s, like the sibling writes — a tombstone has no
  // capture policy left to set.
  const result = await env.DB.prepare(
    `UPDATE users SET default_share = ? WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`,
  ).bind(stored, userId).run();
  if (!changedRows(result)) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
}

/**
 * Soft offboarding: marks the member removed, deletes their personal workspace
 * and everything in it. Company-layer entries they authored STAY — they are the
 * team's shared memory now, and actor_id remains as history. The caller (route
 * layer) owns the confirmation UX; this function owns the guardrails:
 *   - you cannot remove yourself (suspending yourself is already blocked, and
 *     removal is strictly more final);
 *   - the last active admin cannot be removed.
 * Vectors for removed entries are returned so the caller can drop them from
 * Vectorize the same way forget does.
 */
export async function removeMember(
  env: Env,
  actorId: string,
  userId: string,
): Promise<RemovalProgress> {
  if (userId === actorId) {
    throw new TeamAdminError(400, "You cannot remove your own account");
  }
  let target = await env.DB.prepare(
    `SELECT role, removed_at FROM users WHERE id = ?`,
  ).bind(userId).first<{ role: string; removed_at: number | null }>();
  if (!target) throw new TeamAdminError(404, `No member found with ID: ${userId}`);

  if (!Number(target.removed_at)) {
    // Claim removal before cleanup. This atomic transition protects the admin
    // invariant; the idempotent cleanup below can be retried after a failure.
    const claimed = await env.DB.prepare(
      `UPDATE users AS target
          SET removed_at = ?
        WHERE target.id = ?
          AND target.id != ?
          AND (target.removed_at IS NULL OR target.removed_at = 0)
          AND (
            target.role != 'admin'
            OR EXISTS (
              SELECT 1 FROM users AS other
               WHERE other.id != target.id
                 AND other.role = 'admin'
                 AND other.suspended = 0
                 AND (other.removed_at IS NULL OR other.removed_at = 0)
            )
          )`,
    ).bind(Date.now(), userId, actorId).run();
    if (!changedRows(claimed)) {
      target = await env.DB.prepare(
        `SELECT role, removed_at FROM users WHERE id = ?`,
      ).bind(userId).first<{ role: string; removed_at: number | null }>();
      if (!target) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
      if (!Number(target.removed_at) && target.role === "admin") {
        throw new TeamAdminError(400, "Cannot remove the last active admin");
      }
      if (!Number(target.removed_at)) {
        throw new TeamAdminError(409, "Member state changed concurrently; try again");
      }
    }
  }

  const personal = await env.DB.prepare(
    `SELECT w.id AS wid FROM memberships m JOIN workspaces w ON w.id = m.workspace_id AND w.kind = 'personal' WHERE m.user_id = ?`,
  ).bind(userId).first<{ wid: string }>();
  if (!personal) throw new TeamAdminError(404, `No member found with ID: ${userId}`);

  return cleanupMemberData(env, userId, personal.wid);
}

export interface RemovalProgress {
  /** False while history remains: the caller answers 202, and writes no audit and deletes no vectors yet. */
  done: boolean;
  removedEntries: number;
  vectorIds: string[];
  /** The same ids grouped by the entry that listed them, for the parentId-checked delete (T-0089.1.1). */
  ownedVectors: OwnedVectors[];
  /** Entry ids whose history is not fully cleaned yet (done: false only). */
  remaining?: number;
  /** Rows written by this call, for the nightly budget. */
  rowsWritten?: number;
  /**
   * True only for the specific done:false case where every history chunk is already clear and
   * the one thing left is a final batch too big for what `rowsLeft` has left this call (the
   * nightly resume, never the dashboard's unbounded call). Distinct from an ordinary done:false
   * (still working through history, making progress every night on its own): a removal whose
   * final batch alone exceeds the whole nightly budget stalls HERE forever on a brain where the
   * trash purge writes something every night, since `allowOversize` never sees a night to fire on
   * its own (T-0089.7.5) — the caller uses this flag to force one.
   */
  blockedByBudget?: boolean;
}

/**
 * A member's data cleanup, chain-safe and resumable. History goes first, in bounded bottom-up
 * chunks (so no chain is ever left with a gap or an orphan); only when none remains does the
 * one final batch delete the rows themselves, the trash rows, the membership and the workspace.
 * `rowsLeft` (the nightly resume) shrinks each chunk and defers a final batch that would not fit,
 * unless `allowOversize` (a night when the purge wrote nothing, or one the caller is forcing —
 * see `RemovalProgress.blockedByBudget`).
 */
export async function cleanupMemberData(
  env: Env,
  userId: string,
  personalWid: string,
  opts: { rowsLeft?: number; allowOversize?: boolean; ctx?: ExecutionContext } = {},
): Promise<RemovalProgress> {
  let rowsWritten = 0;
  const left = () => (opts.rowsLeft ?? Infinity) - rowsWritten;

  // Affected ids, collected once per call. A: rows and trash rows the member owns; B: entries whose
  // history carries the member's personal-era versions (shared out since), minus A.
  const idsA = new Set<string>();
  {
    const { results } = await env.DB.prepare(
      // scope-exempt: offboarding: ids in the removed member's own workspace
      `SELECT id FROM entries WHERE workspace_id = ?1 UNION SELECT id FROM entries_trash WHERE workspace_id = ?1`,
    ).bind(personalWid).all<{ id: string }>();
    for (const r of results ?? []) idsA.add(r.id);
  }
  const idsB: string[] = [];
  {
    const { results } = await env.DB.prepare(
      // scope-exempt: offboarding: versions stamped with the removed member's personal workspace
      `SELECT DISTINCT entry_id FROM entry_versions WHERE workspace_id = ?1`,
    ).bind(personalWid).all<{ entry_id: string }>();
    for (const r of results ?? []) if (!idsA.has(r.entry_id)) idsB.push(r.entry_id);
  }

  // Work units: slices of ids, each deleted a chunk at a time until it returns fewer than asked.
  type Unit = { kind: "A" | "B"; ids: string[] };
  const slices = (kind: "A" | "B", ids: string[]): Unit[] => {
    const out: Unit[] = [];
    for (let i = 0; i < ids.length; i += MEMBER_HISTORY_SLICE) out.push({ kind, ids: ids.slice(i, i + MEMBER_HISTORY_SLICE) });
    return out;
  };
  const units = [...slices("A", [...idsA]), ...slices("B", idsB)];
  let executions = 0;
  while (units.length && executions < MEMBER_HISTORY_MAX_CHUNKS) {
    const chunk = Math.min(MEMBER_HISTORY_CHUNK, Math.floor(left() / 3));
    if (chunk < 1) break;
    const unit = units[0];
    const predicate = unit.kind === "A"
      ? `entry_id IN (SELECT value FROM json_each(?1))`
      : `entry_id IN (SELECT value FROM json_each(?1)) AND seq <= (SELECT MAX(w.seq) FROM entry_versions w WHERE w.entry_id = entry_versions.entry_id AND w.workspace_id = ?2)`;
    const args = unit.kind === "A" ? [JSON.stringify(unit.ids)] : [JSON.stringify(unit.ids), personalWid];
    const limitParam = `?${args.length + 1}`;
    const markerParam = `?${args.length + 2}`;
    // scope-checked: predicateは削除対象の所有ID集合かそのworkspaceの旧version境界。
    const selected = `id IN (SELECT id FROM entry_versions WHERE ${predicate} ORDER BY seq LIMIT ${limitParam})`;
    const [, res] = await env.DB.batch([
      env.DB.prepare(`UPDATE entry_versions SET write_marker = ${markerParam} WHERE ${selected}`).bind(...args, chunk, memoryWriteMarker(env, "delete")),
      // scope-checked: 上のpredicateと同じremoved-member集合を同一batchで削除する。
    // write-fence: parent-capability=entries（同batchのsnapshot・認可済み記憶をtriggerで検証）
      env.DB.prepare(`DELETE FROM entry_versions WHERE ${selected}`).bind(...args, chunk),
    ]);
    executions++;
    const n = changedRows(res);
    rowsWritten += 3 * n;
    if (n < chunk) units.shift();
  }
  if (units.length) {
    return { done: false, removedEntries: 0, vectorIds: [], ownedVectors: [], remaining: units.reduce((n, u) => n + u.ids.length, 0), rowsWritten };
  }

  // Collect the doomed rows' vectors first: D1 rows go in one batch, the
  // Vectorize delete is the caller's (it may be absent entirely).
  const { results: vectorRows } = await env.DB.prepare(
    `SELECT id, vector_ids FROM entries WHERE workspace_id = ? AND vector_ids != '[]'`,
  ).bind(personalWid).all<{ id: string; vector_ids: string }>();
  const ownedVectors: OwnedVectors[] = (vectorRows ?? []).map((r) => {
    try { return { entryId: r.id, vectorIds: JSON.parse(r.vector_ids) as string[] }; } catch { return { entryId: r.id, vectorIds: [] }; }
  });
  const vectorIds = ownedVectors.flatMap((o) => [...o.vectorIds]);

  const count = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM entries WHERE workspace_id = ?1) AS entries,
            (SELECT COUNT(*) FROM entries_trash WHERE workspace_id = ?1) AS trashed,
            (SELECT COUNT(*) FROM edges WHERE workspace_id = ?1) AS edges,
            (SELECT COUNT(*) FROM entries WHERE workspace_id = ?1 AND instr(lower(tags), '"standing:active"') > 0) AS standing`,
  ).bind(personalWid).first<{ entries: number; trashed: number; edges: number; standing: number }>();
  const removedEntries = count?.entries ?? 0;
  // A final batch that would not fit the night's budget waits for a night when nothing else wrote,
  // unless it is the only thing left to do (the 3.7 route paid this cost at click time).
  // +6 per entries row and +6 per trashed row for their own life-end marker INSERT: one
  // entry_events row costs 6 rows written on this schema (the row, its own PK autoindex,
  // idx_entry_events_entry, idx_entry_events_created, idx_entry_events_actor, and
  // idx_entry_events_life_end -- R23 -- since a life-end marker always matches that last index's
  // own predicate).
  // markerのstage書込みも予算に含める。
  const estimate = 11 * removedEntries + 4 * (count?.trashed ?? 0) + 7 * (count?.edges ?? 0)
    + 6 * removedEntries + 6 * (count?.trashed ?? 0);
  if (opts.rowsLeft !== undefined && estimate > left() && !opts.allowOversize) {
    return { done: false, removedEntries: 0, vectorIds: [], ownedVectors: [], remaining: removedEntries + (count?.trashed ?? 0), rowsWritten, blockedByBudget: true };
  }

  const edgePredicate = `source_id IN (SELECT id FROM entries WHERE workspace_id = ?)
    OR target_id IN (SELECT id FROM entries WHERE workspace_id = ?)`;
  const offboardNow = Date.now();
  // versioning: exempt: 同batchのoffboarding削除を認可するmarkerのみ。
  const entryStamp = env.DB.prepare(`UPDATE entries SET write_marker = ? WHERE workspace_id = ?`).bind(memoryWriteMarker(env, "delete"), personalWid);
  // versioning: hard-delete: offboardingの同batchでライフサイクル終端を記録する。
  // validity: retraction-exempt: 個人workspaceのoffboardingは閉じた行と対象を同時に削除する。
  const entryDelete = env.DB.prepare(`DELETE FROM entries WHERE workspace_id = ?`).bind(personalWid);
  const trashStamp = env.DB.prepare(`UPDATE entries_trash SET write_marker = ? WHERE workspace_id = ?`).bind(memoryWriteMarker(env, "delete"), personalWid);
  const trashDelete = env.DB.prepare(`DELETE FROM entries_trash WHERE workspace_id = ?`).bind(personalWid);
  await env.DB.batch([
    // versioning: exempt: offboardingの同batch削除を認可するmarkerのみを更新。
    entryStamp,
    trashStamp,
    // A version written between the chunks and here (a racing writer) must not outlive its entry.
    env.DB.prepare(
      // scope-exempt: offboarding: leftover versions of the removed member's rows and trash rows
    // write-fence: parent-capability=entries（同batchのsnapshot・認可済み記憶をtriggerで検証）
      `DELETE FROM entry_versions WHERE entry_id IN (SELECT id FROM entries WHERE workspace_id = ?1 UNION SELECT id FROM entries_trash WHERE workspace_id = ?1)`,
    ).bind(personalWid),
    // A life-end marker, in the SAME batch as the DELETE below -- a fire-and-forget write here
    // could be lost, leaking a removed member's history into whoever reuses the id later.
    env.DB.prepare(
      // scope-exempt: offboarding: one life-end marker per entry this batch's own DELETE removes
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
         SELECT lower(hex(randomblob(16))), id, '', 'deleted',
                json_object('reason', 'offboarding', 'trash', json('false'), 'channel', 'system:offboarding'), ?2
           FROM entries WHERE workspace_id = ?1`,
    ).bind(personalWid, offboardNow),
    // Already trashed: the same life-end marker every retention purge writes.
    env.DB.prepare(
      // scope-exempt: offboarding: one life-end marker per trash row this batch's own DELETE removes
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
         SELECT lower(hex(randomblob(16))), id, '', 'purged',
                json_object('reason', 'offboarding', 'channel', 'system:offboarding'), ?2
           FROM entries_trash WHERE workspace_id = ?1`,
    ).bind(personalWid, offboardNow),
    // Edges before entries: the edge delete resolves endpoints through the
    // entries table, so it has to run while the rows still exist.
    env.DB.prepare(
      `UPDATE edges SET write_marker = ? WHERE ${edgePredicate}`,
    ).bind(memoryWriteMarker(env, "delete"), personalWid, personalWid),
    env.DB.prepare(
      // scope-exempt: offboarding: deletes exactly the edges whose endpoints are in the removed member's workspace, per the two subselects
      `DELETE FROM edges WHERE ${edgePredicate}`,
    ).bind(personalWid, personalWid),
    // versioning: exempt: offboarding。直前にライフサイクル終端を同batchへ記録済み。
    entryDelete,
    trashDelete,
    env.DB.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM workspaces WHERE id = ?`).bind(personalWid),
  ]);

  // Bulk: once for the whole workspace, not per row (spec 15 2.6) — it no longer exists to narrow further.
  if (opts.ctx && (count?.standing ?? 0) > 0) standingTouched(env, opts.ctx, await resolveConfig(env), [personalWid]);
  return { done: true, removedEntries, vectorIds, ownedVectors, rowsWritten: rowsWritten + estimate };
}

/**
 * The oldest removal still waiting on its history cleanup (the dashboard may never re-call
 * after a 202, and the roster hides removed members), for the nightly resume.
 */
export async function findPendingRemoval(env: Env): Promise<{ userId: string; personalWid: string } | null> {
  const row = await env.DB.prepare(
    `SELECT m.user_id AS user_id, m.workspace_id AS wid FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN workspaces w ON w.id = m.workspace_id AND w.kind = 'personal'
      WHERE u.removed_at > 0 LIMIT 1`,
  ).first<{ user_id: string; wid: string }>();
  return row ? { userId: row.user_id, personalWid: row.wid } : null;
}

/** Rename a member, or set their email. At least one of name or email must be supplied. */
export async function setMemberProfile(
  env: Env,
  userId: string,
  input: { name?: string; email?: string | null },
): Promise<void> {
  const name = input.name === undefined ? undefined : validateMemberName(input.name.trim());
  const email = input.email === undefined ? undefined : (input.email?.trim() || null);
  if (email) validateMemberEmail(email);
  if (name === undefined && email === undefined) {
    throw new TeamAdminError(400, "name or email is required");
  }
  if (email) {
    // Unlike the roster's exclusions this lookup deliberately INCLUDES removed
    // rows, matching idx_users_email, which covers tombstones too: the loser of
    // that race gets the friendly 409 here rather than the constraint's.
    const existing = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ? AND id != ?`,
    ).bind(email, userId).first();
    if (existing) throw new TeamAdminError(409, "A member with that email already exists");
  }

  const sets: string[] = [];
  const bindings: (string | null)[] = [];
  if (name !== undefined) { sets.push("name = ?"); bindings.push(name); }
  if (email !== undefined) { sets.push("email = ?"); bindings.push(email); }
  bindings.push(userId);

  let result: D1Result<unknown>;
  try {
    result = await env.DB.prepare(
      `UPDATE users SET ${sets.join(", ")} WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`,
    ).bind(...bindings).run();
  } catch (e) {
    // Same story as createMember: the pre-check is advisory, the index rules.
    if (isUniqueEmailViolation(e)) throw new TeamAdminError(409, "A member with that email already exists");
    throw e;
  }
  if (!changedRows(result)) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
}

/** One company workspace, as members and admins both see it. */
export interface TeamWorkspace {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * The company workspaces a caller belongs to, oldest first — the same order
 * Identity.companyWorkspaceIds uses, so the first entry is the team a "share
 * with the team" with no target lands in.
 *
 * Takes the ids from the resolved identity rather than querying memberships
 * again: the identity already resolved them, and re-deriving the caller's teams
 * from the request is how a scoping helper stops being the only place scoping
 * is decided.
 */
export async function listTeamWorkspaces(env: Env, workspaceIds: string[]): Promise<TeamWorkspace[]> {
  if (!workspaceIds.length) return [];
  const placeholders = workspaceIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    // COUNT over the USER, not the membership row: the join to users is
    // filtered to active people, so a suspended or removed member leaves a NULL
    // that COUNT skips. Counting m.user_id would have counted them anyway.
    `SELECT w.id AS id, w.name AS name, COUNT(DISTINCT u.id) AS memberCount
       FROM workspaces w
       LEFT JOIN memberships m ON m.workspace_id = w.id
       LEFT JOIN users u ON u.id = m.user_id
         AND u.suspended = 0 AND (u.removed_at IS NULL OR u.removed_at = 0)
      WHERE w.id IN (${placeholders})
      GROUP BY w.id`,
  ).bind(...workspaceIds).all<{ id: string; name: string; memberCount: number }>();

  const byId = new Map((results ?? []).map((r) => [r.id, r]));
  // Ordered by the caller's own list, not by what the database returned, so the
  // primary team is always first.
  return workspaceIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [{ id, name: row.name || "", memberCount: Number(row.memberCount) || 0 }] : [];
  });
}

/** Rename a team. The caller must already have been checked as an admin of it. */
export async function renameTeamWorkspace(env: Env, workspaceId: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new TeamAdminError(400, "Give the team a name");
  if (trimmed.length > 60) throw new TeamAdminError(400, "Team names are limited to 60 characters");
  const changed = await env.DB.prepare(
    `UPDATE workspaces SET name = ? WHERE id = ? AND kind = 'company'`,
  ).bind(trimmed, workspaceId).run();
  if (!changedRows(changed)) throw new TeamAdminError(404, "No team found with that ID");
  return trimmed;
}
