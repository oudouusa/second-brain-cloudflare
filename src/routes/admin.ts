import { deleteEntryVectors, persistPendingVectorDeletes } from "../vectorize/batch";
import { auditEvent } from "../lib/audit";
import { hasCapsuleTag } from "../tags/system";
import type { Env } from "../env";
import { chatGptEnvForWorkspaces } from "../lib/chatgpt";
import { readOverrides, resetOverride, resolveConfig } from "../config";
import { SB_VERSION } from "../env";
import { COMPRESSION_MIN_AGE_MS, compressionEligibilitySql, isTopicTagSql, isCompressionTagSql } from "../compression/eligibility";
import { intParam, json } from "../lib/http";
import { D1_MAX_BOUND_PARAMS, VECTORIZE_DELETE_MAX_IDS_PER_CALL, VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY, VERSIONS_SINCE_KV_KEY } from "../constants";
import { requireAdmin, requireIdentity, type Identity } from "../lib/identity";
import { effectiveWriteTarget, layerOf, primaryCompanyWorkspaceId, readableWorkspaces, scopeWhere, scopeWhereForIdRead } from "../lib/scope";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { classifyEntry } from "../capture/classify";
import { storeEntry } from "../capture/store";
import { adminAuditEvent } from "../lib/admin-audit";
import { auditEvents, type AuditEventInput } from "../lib/audit";
import {
  createMember,
  isTeamBrain,
  listMembers,
  listRoster,
  listTeamWorkspaces,
  lookupAuditNames,
  removeMember,
  renameTeamWorkspace,
  rotateMemberToken,
  setMemberDefaultShare,
  setMemberProfile,
  setMemberSuspended,
  TeamAdminError,
} from "../lib/team-admin";
import { graceMs, readWorkersAiHealth } from "../lib/ai";
import { submitVectorCleanupBatch } from "../vectorize/cleanup";
import { processPendingClassification, processPendingVectorization } from "../capture/pending";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { PENDING_INSIGHT_SQL } from "../memory/patterns";
import { STALE_REVIEW_SQL, hasStaleAsOf, withoutStaleAsOf, staleReasonFor } from "../memory/stale";
import { openLoopSql, withTaskDone, withoutTask } from "../memory/loops";
import { openOutboundSql, openInboundSql, directionOf, counterpartyOf, dueKindOf } from "../commitments/direction";
import { getStatus, withStatus } from "../memory/status";
import { assertCanEditContent, getReadableEntry } from "../lib/entry-access";
import { withKind } from "../memory/kind";
import { checkVectorizeHealth } from "../vectorize/health";
import { vectorizeFilterState } from "../vectorize/scope";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { notHeldSqlFor } from "../quarantine/tags";
import { reasonOverPair, restatesRecent } from "../insight/reason";
import { MAX_INSIGHTS_PER_RUN, RECENT_INSIGHT_WINDOW, rawInsightText, INSIGHT_CANDIDATE_SQL } from "../insight/weekly";
import { runInsightAccrual, isEligiblePair, parseTags } from "../insight/candidates";
import { initializeDatabase } from "../db/init";
import { memoryWriteMarker } from "../migration/write-lock";
import { resolveEntryAction, applyInsightResolution } from "../memory/actions";
import { readNightSummary, type NightSummary } from "../runtime/night-summary";
import { readWhenCursor, fetchWhenCandidates, judgeCommitment } from "../when/pass";
import { DUE_WITHIN_MS, dueSql, parseExplicitWhen } from "../when/input";

/**
 * Ids accepted by one bulk resolve. D1 allows 100 bound parameters per
 * statement and the id list is the whole of the SELECT's binding, so this is
 * the hard limit rather than a policy. The client pages against it.
 */
const MAX_PATTERN_BULK = 16;

/** How many nodes the degree ranking returns: a ranking, not a dump of the graph. */
const GRAPH_STATS_TOP_DEGREE = 20;

/** Rows per bucket on GET /due — a feed, not a full export. */
const DUE_FEED_LIMIT = 20;
/** How much of an entry's content GET /due and GET /extract/dry-run print. */
const DUE_CONTENT_CHARS = 200;

export async function handleAdminRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // Team administration requires admin access; roster and workspace reads only
  // require a member identity and are scoped to that identity.
  if (url.pathname === "/team/members" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    return json({ ok: true, members: await listMembers(env), you: auth.userId });
  }

  // Member-facing roster: names and roles only. Sensitive member details remain
  // behind the admin-only endpoint.
  if (url.pathname === "/team/roster" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    // These independent reads share the same resolved workspace list.
    const [teams, members] = await Promise.all([
      listTeamWorkspaces(env, auth.companyWorkspaceIds),
      listRoster(env, auth.companyWorkspaceIds),
    ]);
    return json({
      ok: true,
      teams,
      members,
      you: auth.userId,
      admin: auth.role === "admin",
    });
  }

  if (url.pathname === "/team/members" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { name?: string; email?: string; role?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") {
      return json({ ok: false, error: 'role must be "admin" or "member"' }, 400);
    }
    try {
      const { member, token } = await createMember(env, {
        name: body.name,
        email: body.email,
        role: body.role as "admin" | "member" | undefined,
      });
      // Never the token or its hash: this trail is read by more people than the
      // token is, and a role plus "was an email supplied" is the whole of what an
      // auditor needs to reconstruct the decision.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: member.userId,
        event: "member_created",
        payload: { role: member.role, hasEmail: !!member.email },
      });
      // A new member makes team mode effective. Clear a stale explicit "off"
      // override without turning it into a permanent "on" override.
      const overrides = await readOverrides(env);
      if (overrides.TEAM_MODE === "off") await resetOverride(env, "TEAM_MODE").catch(() => {});
      // The token is returned exactly once, only its hash is stored.
      return json({ ok: true, member, token }, 201);
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  if (url.pathname === "/team/members/token" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    try {
      const token = await rotateMemberToken(env, body.id.trim());
      // Deliberately an empty payload: that the rotation happened, to whom and by
      // whom is the whole record. The new secret is not part of it.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: body.id.trim(),
        event: "member_token_rotated",
      });
      return json({ ok: true, id: body.id.trim(), token });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  if (url.pathname === "/team/members/suspend" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; suspended?: boolean };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    try {
      const suspended = body.suspended !== false;
      await setMemberSuspended(env, auth.userId, body.id.trim(), suspended);
      // Two event names rather than one with a boolean: an auditor scanning for
      // "who lost access" should not have to read a payload to find out.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: body.id.trim(),
        event: suspended ? "member_suspended" : "member_unsuspended",
      });
      return json({ ok: true, id: body.id.trim(), suspended });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // POST /team/members/default-share, per-member capture-visibility override.
  // "inherit" clears it; the org-level default lives in config
  // (TEAM_DEFAULT_WORKSPACE) and is what "inherit" falls back to.
  if (url.pathname === "/team/members/default-share" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; default?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (body.default !== "personal" && body.default !== "company" && body.default !== "inherit") {
      return json({ ok: false, error: 'default must be "personal", "company", or "inherit"' }, 400);
    }
    try {
      await setMemberDefaultShare(env, body.id.trim(), body.default as "personal" | "company" | "inherit");
      // Where a member's future captures land is a visibility decision, so the
      // value set is the point of the record.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: body.id.trim(),
        event: "member_default_share_set",
        payload: { default: body.default },
      });
      return json({ ok: true, id: body.id.trim(), default: body.default });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // POST /team/me/default-share, a member's own capture-visibility override.
  //
  // requireIdentity, and the body has NO id field. That is the security
  // property: the admin route above takes a target and must therefore be gated
  // on who the caller is, while this one cannot name a target at all, so there
  // is no branch to get wrong. The subject is auth.userId, which came from the
  // resolved identity and not from anything the request could say. An `id` in
  // the body is not rejected, it is simply unreadable from here.
  //
  // Returns the three recomputed fields rather than { ok: true } so the caller
  // re-renders from the server's own precedence answer instead of predicting
  // it, the same drift GET /team/me's effectiveDefault exists to prevent.
  if (url.pathname === "/team/me/default-share" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { default?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body.default !== "personal" && body.default !== "company" && body.default !== "inherit") {
      return json({ ok: false, error: 'default must be "personal", "company", or "inherit"' }, 400);
    }
    // setMemberDefaultShare throws TeamAdminError(404) when no row changed, and
    // that cannot happen here: requireIdentity already resolved this row. No
    // try/catch, the same argument GET /team/me's unreachable 404 records
    // above. If the invariant ever breaks, it should reach the 500 handler.
    await setMemberDefaultShare(env, auth.userId, body.default);
    const cfg = await resolveConfig(env);
    const orgDefault = cfg.TEAM_DEFAULT_WORKSPACE === "company" ? "company" : "personal";
    const defaultShare = body.default === "inherit" ? "" : body.default;
    // Audited like the admin twin, with self: true. Where a person's captures
    // land is a visibility decision whether or not an admin made it, so the
    // compliance view must not go blind the moment members can act.
    adminAuditEvent(env, ctx, {
      actorId: auth.userId,
      targetUserId: auth.userId,
      event: "member_default_share_set",
      payload: { default: body.default, self: true },
    });
    return json({
      ok: true,
      default: body.default,
      defaultShare,
      orgDefault,
      effectiveDefault: effectiveWriteTarget({ ...auth, defaultShare }, undefined, orgDefault),
    });
  }

  // POST /team/members/remove, soft offboarding. Marks the member removed,
  // deletes the personal workspace and everything in it; company-layer entries
  // the member authored stay (they are shared memory now). Guardrails inside
  // removeMember: not self, not the last active admin. The confirmation UX is
  // the dashboard's.
  if (url.pathname === "/team/members/remove" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    try {
      const result = await removeMember(env, auth.userId, body.id.trim());
      // History remains: nothing is audited or deleted from the index yet. The dashboard calls
      // again, and the nightly run resumes it if nobody does.
      // FX3 finding 7: keeps the 3.7 removedEntries/removedVectors fields on the 202 too, rather
      // than omitting them — both are genuinely 0 at this stage, since removeMember touches
      // neither D1 rows nor vectors until the history cleanup finishes and done flips true.
      if (!result.done) {
        return json({ ok: true, done: false, id: body.id.trim(), remaining: result.remaining, removedEntries: 0, removedVectors: 0 }, 202);
      }
      // Audited before the Vectorize delete, not after: the D1 rows are already
      // gone by here, so a Vectorize failure must not also cost the record of the
      // destruction. The counts, never the content, this is the one
      // administration action that destroys memories, so how many is what a later
      // reader needs.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: body.id.trim(),
        event: "member_removed",
        payload: { removedEntries: result.removedEntries, removedVectors: result.vectorIds.length },
      });
      // Capped (FX3 finding 2): a removed member's vectors can run into the tens of thousands, and
      // an uncapped delete can exceed the platform's subrequest ceiling before anything is deleted.
      // removedVectors defaults to the full intended count (unchanged on success or on a Vectorize
      // failure, matching the existing "report the truth about the D1-side removal" contract below)
      // and is trimmed only when the cap left something for the nightly drain to queue and finish.
      let removedVectors = result.vectorIds.length;
      if (result.vectorIds.length) {
        try {
          const deletion = await deleteEntryVectors(env, result.ownedVectors, { maxIds: VECTORIZE_DELETE_MAX_IDS_PER_CALL });
          if (!deletion.done) {
            removedVectors -= deletion.remaining.reduce((n, o) => n + o.vectorIds.length, 0);
            await persistPendingVectorDeletes(env, deletion.remaining);
          }
        } catch (e) {
          // The D1 rows and the audit row are already committed: the removal
          // succeeded. A failed index delete only leaves dead vectors behind,
          // the same degradation /patterns/resolve accepts, so the admin sees
          // the truth (member removed) instead of a 500 for work that happened.
          console.error("Vectorize deleteByIds failed during member removal (non-fatal):", e);
        }
      }
      return json({ ok: true, done: true, id: body.id.trim(), removedEntries: result.removedEntries, removedVectors });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // GET /team/me, caller's own profile row (any signed-in identity).
  if (url.pathname === "/team/me" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const row = await env.DB.prepare(
      `SELECT id AS userId, name, email, role FROM users WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`,
    ).bind(auth.userId).first<{ userId: string; name: string; email: string | null; role: string }>();
    // Unreachable through a bearer token, and kept anyway. IDENTITY_SQL and
    // IDENTITY_BY_ID_SQL (src/lib/identity.ts) both exclude suspended and removed
    // users, so a caller who got past requireIdentity always has a row here, a
    // removed member gets 401 from the auth layer, never this 404. The
    // unreachability is therefore an invariant maintained in a DIFFERENT file:
    // deleting this branch would trade one line for a non-null assertion or a
    // crash if that invariant ever loosened, so it stays and fails closed.
    // Do not write a test for this 404 through the HTTP surface, the state it
    // guards cannot be reached from one.
    if (!row) return json({ ok: false, error: "Not found" }, 404);
    // Where this member's next capture lands, and the two inputs that decided
    // it. All three are additive, the four fields above keep their names and
    // values, so loadProfileName() in public/js/settings.js is untouched.
    //
    // TEAM_DEFAULT_WORKSPACE is a free-text config key, so it is narrowed to the
    // enum here rather than passed through: anything that is not "company" is
    // private-by-default, matching effectiveWriteTarget's own reading of it.
    const cfg = await resolveConfig(env);
    const orgDefault = cfg.TEAM_DEFAULT_WORKSPACE === "company" ? "company" : "personal";
    // Who owns the deployment, the one thing `role` cannot say. tenancy.ts
    // hashes this brain's AUTH_TOKEN into a users row with role 'admin'
    // (invariant 4), and rowToIdentity narrows role to "admin" | "member", so
    // the person who created the brain and a colleague they promoted are the
    // same value on this route. The desktop app has to tell them apart: a
    // password change and a Worker update both need a Cloudflare session for
    // the account the Worker is deployed into, and only the owner has one.
    // Offering either to a promoted admin dead-ends at ErrorWrongCfAccount
    // after a full sign-in; withholding them from the owner takes away their
    // only in-app route to both.
    //
    // Free: requireIdentity above has already awaited this bootstrap, which is
    // memoised per DB binding, so no second query is issued and the scope
    // checker sees no new statement.
    const roots = await ensureTenantBootstrap(env);
    return json({
      ok: true,
      profile: {
        ...row,
        // Consumed by installer/src-tauri/src/commands.rs::connection_role,
        // which hands it to installer/src/connection-role.ts.
        owner: row.userId === roots.ownerUserId,
        // Already on the resolved Identity, no second column read, no second query.
        defaultShare: auth.defaultShare,
        orgDefault,
        // Resolved by the same function the write path calls (src/lib/scope.ts),
        // with no explicit target, because that is the case the composer's
        // "Default" option describes. Computed here rather than in the client:
        // a client that re-derives the precedence order drifts from it silently,
        // showing "Personal" while the capture lands in the company layer.
        effectiveDefault: effectiveWriteTarget(auth, undefined, orgDefault),
      },
    });
  }

  // GET /team/workspaces, the teams the caller belongs to, with names.
  //
  // Open to every member, not just admins: the name is how a member knows which
  // company they are sharing into, and the dashboard shows it in the sidebar for
  // everyone. Only the caller's own teams are ever returned, because the ids come
  // from their resolved identity.
  if (url.pathname === "/team/workspaces" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    return json({
      ok: true,
      teams: await listTeamWorkspaces(env, auth.companyWorkspaceIds),
      admin: auth.role === "admin",
    });
  }

  // POST /team/workspaces/rename, name a team. Admin-only.
  if (url.pathname === "/team/workspaces/rename" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; name?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    // Defaults to the caller's primary team so a single-team brain, every brain
    // today, need not know its own workspace id to name itself.
    const id = body.id?.trim() || primaryCompanyWorkspaceId(auth);
    // An admin of one company cannot rename another's: the id has to be a team
    // this caller is actually in.
    if (!id || !auth.companyWorkspaceIds.includes(id)) {
      return json({ ok: false, error: "No team found with that ID" }, 404);
    }
    try {
      const name = await renameTeamWorkspace(env, id, body.name ?? "");
      // The only administration event whose subject is a workspace rather than a
      // member, so target_user_id stays empty and workspace_id carries the team.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: "",
        workspaceId: id,
        event: "team_renamed",
        payload: { name },
      });
      return json({ ok: true, id, name });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // POST /team/profile, rename self, or any member when caller is admin.
  if (url.pathname === "/team/profile" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; name?: string; email?: string | null };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const targetId = body.id?.trim() || auth.userId;
    if (targetId !== auth.userId && auth.role !== "admin") {
      return json({ ok: false, error: "Forbidden" }, 403);
    }
    try {
      await setMemberProfile(env, targetId, { name: body.name, email: body.email });
      // `self` separates a member renaming themselves, routine, and the common
      // case, from an admin renaming someone else, which is administration.
      // The new name and email are omitted: they are member-supplied content.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: targetId,
        event: "member_profile_updated",
        payload: { self: targetId === auth.userId },
      });
      return json({ ok: true, id: targetId });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // GET /team/activity, the compliance feed. Two INSERT-only trails, one
  // time-ordered answer.
  //
  // WHAT EACH ARM GUARANTEES, stated exactly rather than implied. A comment
  // here that claims more than its arm delivers is the defect, not a rounding
  // error: it is what a future reader will trust when deciding whether a new
  // field on this route needs scoping.
  //
  //  - The MEMORY arm is SCOPED AT THE ROW, not at the title. Its join is an
  //    INNER join carrying the caller's own scope, so a row appears only when
  //    the memory it names is one this caller could read through GET /entry.
  //    Nothing about an unreadable memory is emitted: not its text, not its
  //    id, not its actor, and not the target workspace id in `detail`. That
  //    last one is why a title-only predicate was not enough, a row hidden in
  //    one column and disclosed in three others is not scoped, and
  //    listTeamWorkspaces binds only the caller's own workspace ids, so
  //    another company's id is reachable nowhere else on this deployment.
  //
  //    THE PRICE, accepted and pinned by a test: entry_events has no workspace
  //    column, so the joined entry is the only thing that can attribute a row.
  //    Share/unshare history for a memory that has since been DELETED can no
  //    longer be attributed and therefore DOES NOT APPEAR in this feed. The two
  //    ways to keep it are both worse, a workspace column on entry_events is
  //    blank for every row already written, and a second unscoped join proving
  //    the id is dead would disclose "some deleted memory was shared to
  //    ws-companyY" to an admin of company X. The per-entry trail
  //    (idx_entry_events_entry) still holds those rows; this feed is the one
  //    place that cannot show them.
  //
  //  - The ADMIN-EVENT arm is DEPLOYMENT-WIDE and is not scoped at all.
  //    admin_events.workspace_id is populated only by `team_renamed`; every
  //    member event stores "". So on a deployment with two companies, an admin
  //    of one sees the other's member events. That is accepted, not overlooked:
  //    it is exactly as wide as GET /team/members already is, listMembers is
  //    scope-exempt with no membership filter, so it adds NO new exposure.
  //    Narrowing it would mean stamping workspace_id on every admin event from
  //    here on, which cannot repair rows already written, and would leave a feed
  //    that is narrow for new rows and wide for old ones.
  //
  // WHY THIS ROUTE IS UNCAUGHT, decided rather than inherited.
  //
  // Nothing between here and the platform catches: createDefaultHandler
  // (src/routes/index.ts) awaits each handler bare, so a rejected statement
  // here is a 500 with no body of ours. That was raised as a defect on the
  // grounds that a route which 500s on a valid request is worse than one that
  // degrades, and for most routes it would be. It is the wrong trade HERE, on
  // this surface specifically, for three reasons:
  //
  //  1. Every degradation available to this route is a LIE. Answering
  //     `{ ok: true, events: [] }` says nothing happened, public/js/activity.js
  //     states the principle in its own words, "an empty audit log is not an
  //     empty result, it is a claim that nothing happened". Answering the rows
  //     with the names dropped is no better: `actor` is defined on this wire as
  //     a NAME OR NULL, and null means "no actor", so a page of unresolved
  //     names claims a hundred administrative acts nobody performed. A
  //     compliance feed that cannot be read has to say so.
  //  2. The client already degrades, visibly and correctly. A non-200 renders
  //     `activity.loadFailed` and leaves the rows that are on screen alone
  //     (public/js/activity.js). That is the same information, shown to the
  //     person who can act on it, without the server asserting anything false.
  //  3. No route in this worker is individually wrapped, and a catch here alone
  //     would be a local exception with no principle behind it, the next
  //     reader would copy it onto a route where swallowing IS wrong.
  //
  // So the disposal for the bound-parameter defect that raised the question is
  // to remove the CAUSE, not to hide the symptom: lookupAuditNames now chunks
  // (src/lib/team-admin.ts), and the ceiling is driven by a test that enforces
  // the 100 node:sqlite does not. The one thing this route does swallow stays
  // swallowed, and it is swallowed because it is not a failure: a hand-edited
  // `payload` column is bad data in one cell of one row, not an unreadable
  // feed, and safeParse below answers it with {} rather than losing the page.
  //
  // requireAdmin, not requireIdentity: the feed names who suspended whom, which
  // is administration and not a peer fact. The gate authorises this SURFACE and
  // widens nothing about which memory rows may be read, that is the scope
  // clause's job, below.
  if (url.pathname === "/team/activity" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;
    const scope = scopeWhere(auth);
    // ONE compound statement, not two selects merged in JavaScript. Paging is
    // the reason: LIMIT/OFFSET over a merged list is only correct if the merge
    // happens before the window, and two independently-paged selects stitched
    // together in JS silently drop rows the moment one trail is busier than
    // the other. SQLite applies the ORDER BY and LIMIT to the whole compound.
    //
    // The entries side is an INNER JOIN carrying the caller's scope, so the
    // scope predicate decides WHICH ROWS EXIST rather than merely which of
    // them gets a title. See the arm-by-arm note above the route for what that
    // costs and why the cheaper spellings are worse.
    //
    // substr in the projection, not the whole column: a compliance feed names
    // a memory, it does not reproduce it.
    //
    // ORDER BY carries a tiebreaker because ties are built here on purpose:
    // POST /patterns/resolve stamps one entry_events row per resolved id in a
    // tight loop, so ~97 rows share a millisecond, and LIMIT/OFFSET over a tie
    // group the sorter may emit in any order is how a row lands on two pages or
    // on none. `event_id` is each trail's own primary key, unique within its
    // table and a UUID across both, so `created_at DESC, event_id DESC` is a
    // total order, arbitrary within a tie, but the SAME arbitrary order for
    // every page of the same data, which is the whole requirement. It is
    // projected only to be sorted on; the response does not carry it.
    //
    // Round 3 re-review MAJOR: a reused id's earlier life always ends with a "purged" event or a
    // "deleted" event with payload.trash false (tier 3) -- everything at or before the LATEST such
    // end event for this id belongs to whoever's row is now gone, not the live row just joined in
    // below. The extra AND clause is rowid, not created_at: insertion order is the true order this
    // Worker wrote these two events in, whatever either one's own created_at claims.
    // First conjunct matches idx_entry_events_life_end's own WHERE syntactically (no json_extract
    // in the index) -- see src/brief/changes.ts's lifeFilter for the full reasoning.
    const { results } = await env.DB.prepare(
      `SELECT 'admin' AS kind, ae.id AS event_id, ae.event AS event, ae.actor_id AS actor_id,
              ae.target_user_id AS subject_id, '' AS entry_id, NULL AS title,
              ae.payload AS payload, ae.created_at AS created_at
         FROM admin_events ae
        WHERE substr(ae.event, 1, 8) <> 'project_'
       UNION ALL
       SELECT 'entry', ev.id, ev.event, ev.actor_id, '', ev.entry_id,
              substr(m.content, 1, 160), ev.payload, ev.created_at
         FROM entry_events ev
         JOIN entries m ON m.id = ev.entry_id AND m.${scope.clause}
        WHERE ev.event IN ('shared', 'unshared', 'insight_confirmed', 'insight_dismissed')
          AND ev.rowid > COALESCE((SELECT MAX(g.rowid) FROM entry_events g WHERE g.entry_id = ev.entry_id
                AND g.event IN ('purged', 'deleted') AND (g.event = 'purged' OR json_extract(g.payload, '$.trash') = 0)), 0)
       ORDER BY created_at DESC, event_id DESC
       LIMIT ? OFFSET ?`,
    ).bind(...scope.bindings, limit, offset).all();

    const rows = results as Record<string, unknown>[];
    // Resolved once for the page, and through lookupAuditNames rather than
    // listRoster: see that function. `actor` and `subject` are NAMES OR NULL,
    // never ids, the rule Phase 2 established for the roster and Phase 3 for
    // connectedBy, applied to every people-shaped field this codebase publishes.
    const names = await lookupAuditNames(env, rows.flatMap((r) =>
      [String(r.actor_id ?? ""), String(r.subject_id ?? "")]));
    const nameOf = (id: unknown) => {
      const key = String(id ?? "");
      return key ? names.get(key) ?? null : null;
    };
    // A hand-edited payload must not 500 the feed.
    const safeParse = (x: string) => { try { return JSON.parse(x); } catch { return {}; } };
    return json({
      ok: true,
      events: rows.map((r) => ({
        at: Number(r.created_at) || 0,
        kind: String(r.kind),
        event: String(r.event),
        actor: nameOf(r.actor_id),
        subject: nameOf(r.subject_id),
        entryId: String(r.entry_id ?? "") || null,
        title: r.title == null ? null : String(r.title).split("\n")[0].slice(0, 120),
        detail: safeParse(String(r.payload ?? "{}")),
      })),
      // There is no `total`: a COUNT(*) over the same compound is a second full
      // scan for a number nobody acts on, and "the page came back full, so
      // there may be more" is the same information at no cost. The client's
      // Show-more button reads events.length === limit.
      limit,
      offset,
    });
  }


  // GET /stats
  if (url.pathname === "/stats" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const cfg = await resolveConfig(env);
    const graceCutoff = Date.now() - graceMs(env);
    // This route answers two different questions and they need two different
    // scopes, which is why the first query carries the scope as a CASE rather
    // than a WHERE.
    //
    //  - Deployment health, `unvectorized`, `unclassified`, `digest_candidates`
    //   , stays corpus-wide. They drive repairs (POST /vectorize-pending,
    //    /classify-pending) and the nightly compression pass, all of which act on
    //    every workspace, so a scoped count would under-report the work and leave
    //    rows unrepairable with no sign of it.
    //
    //  - "What is my brain about", `count`, `avg_importance`, `top_tags`, is
    //    content, and is scoped to the admin's own readable set. Unscoped, it
    //    reported colleagues' memories as the admin's own: `brain stats` in the
    //    CLI prints `top_tags` under "Top tags", so an admin's terminal listed
    //    members' private tag names, and "Total memories" disagreed with the
    //    /count and /list the same token got back.
    const scope = scopeWhere(auth);
    const [summary, tagRows, candidateRows] = await Promise.all([
      env.DB.prepare(
        // unvectorized skips deprecated entries: their vectors were deleted
        // deliberately, so counting them here offered the user a repair for
        // something that is not broken.
        // scope-exempt: the row set here is deliberately corpus-wide, unvectorized and unclassified are deployment repair counters and would under-report if narrowed (see the block comment above and team-isolation.test.ts). The caller's clause is applied INSIDE the CASE for count/avg_importance, which scopes those two numbers and not the rows read; that is why it is spelled as a CASE and not a WHERE
        // validity: any: 管理者の集計・活動・索引保守・変更前の状態確認は過去分も扱う。
        `SELECT
           SUM(CASE WHEN ${scope.clause} THEN 1 ELSE 0 END) as count,
           AVG(CASE WHEN ${scope.clause} THEN importance_score END) as avg_importance,
           SUM(CASE WHEN vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL} THEN 1 ELSE 0 END) as unvectorized,
           MIN(CASE WHEN vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL} THEN created_at END) as oldest_unvectorized_at,
           SUM(CASE WHEN vector_ids <> '[]' AND json_valid(pending_append_passages)
             AND json_array_length(pending_append_passages) > 0 AND ${INDEXABLE_SQL}
             THEN json_array_length(pending_append_passages) ELSE 0 END) as pending_append_passages,
           SUM(CASE WHEN tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%' THEN 1 ELSE 0 END) as unclassified
         FROM entries`
      ).bind(...scope.bindings, ...scope.bindings, graceCutoff, graceCutoff).first() as Promise<Record<string, any> | null>,
      // Reserved namespaces and pipeline markers are excluded here rather than
      // hidden in the client: this panel answers "what is my brain about?", and
      // kind:episodic outranked every real topic on a production brain. Numeric
      // tags are legacy issue references (see src/text/hashtags.ts). LIMIT is
      // raised because the filter now discards rows the ORDER BY ranked first.
      env.DB.prepare(
        // validity: any: 管理者の集計・活動・索引保守・変更前の状態確認は過去分も扱う。
        `SELECT value, COUNT(*) as n FROM entries, json_each(entries.tags)
         WHERE ${isTopicTagSql()}
           AND value NOT GLOB '[0-9]*'
           AND ${scope.clause}
         GROUP BY value ORDER BY n DESC LIMIT 5`,
      ).bind(...scope.bindings).all(),
      // Scoped like top_tags directly above, and for the same reason: this list
      // is tag NAMES, and it is rendered on the admin's dashboard. Unscoped it
      // named colleagues' private topics, "divorce-paperwork" beside a count,
      // from workspaces the same token gets a 404 from /entry for. The nightly
      // compression pass picks its own tags per workspace (src/compression), so
      // narrowing this display list costs no repair coverage.
      // validity: current: 既存のPENDING_INSIGHT_SQL・STALE_REVIEW_SQL・compressionEligibilitySqlで現在の適格性を検査する。
      env.DB.prepare(`
        SELECT value as tag, COUNT(*) as count
        FROM entries, json_each(entries.tags)
        WHERE ${isCompressionTagSql()}
          AND entries.tags NOT LIKE '%"rolled-up"%'
          AND entries.tags NOT LIKE '%"synthesized"%'
          AND entries.tags NOT LIKE '%"auto-pattern"%'
          AND entries.tags NOT LIKE '%"auto-insight"%'
          AND ${compressionEligibilitySql("entries.", cfg)}
          AND entries.${scope.clause}
        GROUP BY value
        HAVING count > 10
        ORDER BY count DESC
        LIMIT 10
      `).bind(Date.now() - cfg.COMPRESSION_MIN_AGE_MS, ...scope.bindings).all(),
    ]);

    const cutoff = Date.now() - 86400000;
    const digestCandidates: { tag: string; count: number }[] = [];
    for (const row of candidateRows.results as any[]) {
      // Scoped to match the query that produced `row`: "has this tag already
      // been digested?" has to be asked of the same rows the tag was counted
      // over, or a colleague's digest in an unreadable workspace silently
      // removes a real candidate from the admin's own list.
      const existing = await env.DB.prepare(
        // validity: any: 管理者の集計・活動・索引保守・変更前の状態確認は過去分も扱う。
        `SELECT id FROM entries WHERE tags LIKE '%"synthesized"%' AND tags LIKE ? ${TAG_LIKE_ESCAPE} AND created_at > ? AND ${scope.clause} LIMIT 1`
      ).bind(tagLikePattern(row.tag as string), cutoff, ...scope.bindings).first();
      if (!existing) digestCandidates.push({ tag: row.tag as string, count: row.count as number });
    }

    return json({
      count: (summary?.count as number) ?? 0,
      avg_importance: summary?.avg_importance != null ? Math.round((summary.avg_importance as number) * 10) / 10 : null,
      top_tags: (tagRows.results as any[]).map(r => r.value as string),
      digest_candidates: digestCandidates,
      unvectorized: (summary?.unvectorized as number) ?? 0,
      pending_append_passages: (summary?.pending_append_passages as number) ?? 0,
      oldest_unvectorized_at: summary?.oldest_unvectorized_at ?? null,
      vectorize_grace_ms: graceMs(env),
      unclassified: (summary?.unclassified as number) ?? 0,
    });
  }

  // GET /stats/graph, the edge-quality audit surface. The type histogram is a
  // single grouped scan and always runs; the endpoint join, the degree ranking
  // and the capture-gap histogram each cost their own pass over a table, so an
  // operator polling the cheap half does not pay for them unless ?deep=1.
  //
  // ?deep=1 IS A MANUAL AUDIT. DO NOT SCHEDULE OR POLL IT.
  //
  // edges has no index on workspace_id, so a deep call is four full scans of
  // the edge table plus two indexed endpoint seeks per edge, around 5M row
  // visits at roughly 800k edges, which is D1's entire free daily allowance.
  // Spending it fails every query on the ACCOUNT, not just this route, until
  // 00:00 UTC. Run it by hand a few times, not on a timer.
  //
  // Indexing edges(workspace_id) would turn the scans into seeks, and was
  // deliberately NOT taken: it taxes a write on every edge insert against the
  // 100k/day write budget, to speed up a tool run manually. If this ever does
  // get polled, cache a rollup then rather than reaching for the index.
  if (url.pathname === "/stats/graph" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    // edges.workspace_id is denormalized from the source entry, so scoping the
    // edge reads needs no join back to entries.
    const edgeScope = scopeWhere(auth, undefined, "edges.workspace_id");
    const typeRows = await env.DB.prepare(
      `SELECT type, COUNT(*) AS n FROM edges WHERE ${edgeScope.clause} GROUP BY type`,
    ).bind(...edgeScope.bindings).all();
    const edgeTypes: Record<string, number> = {};
    for (const r of typeRows.results as any[]) edgeTypes[r.type as string] = Number(r.n);

    if (url.searchParams.get("deep") !== "1") return json({ ok: true, deep: false, edgeTypes });

    // Edges with an endpoint that is not a live entry OF THE EDGE'S OWN
    // WORKSPACE.
    //
    // Deliberately a SUPERSET of what the nightly sweep removes, so this number
    // is not expected to reach zero. The sweep deletes only `inferred` edges
    // whose endpoint has no `entries` row at all; this also counts an explicit
    // link to a forgotten entry (deleting a link someone stated would lose it)
    // and an edge whose endpoint exists but in another workspace (corrupt, but
    // legacy data rather than obviously safe to delete). A reading that GROWS
    // between sweeps is the signal worth acting on, not a non-zero one.
    //
    // Matching on edges.workspace_id rather than on the caller's readable list
    // does two things. It makes the number mean the same thing for every
    // caller: scoping the lookup to whoever is asking would count a correct
    // edge as broken for an admin who cannot read its workspace, and count a
    // genuinely corrupt cross-workspace edge as fine for one who can. And it
    // costs no bindings, where repeating the scope list twice more put this
    // statement at 3x the workspace count, past D1's 100-parameter ceiling for
    // an admin in ~32 teams, which fails the whole request rather than
    // degrading.
    //
    // It stays scoped for privacy by the outer clause: only edges the caller
    // may read are counted at all.
    const invalidEndpoints = await env.DB.prepare(
      // scope-exempt: the entries reads are existence checks bound to edges.workspace_id, and the outer clause already limits the counted rows to edges the caller may read, so neither can reach or probe for an entry outside the caller's scope
      // validity: any: 管理者の集計・活動・索引保守・変更前の状態確認は過去分も扱う。
      `SELECT COUNT(*) AS n FROM edges
       WHERE ${edgeScope.clause}
         AND (NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = edges.source_id AND entries.workspace_id = edges.workspace_id)
           OR NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = edges.target_id AND entries.workspace_id = edges.workspace_id))`,
    ).bind(...edgeScope.bindings).first() as Record<string, any> | null;

    // Both endpoints count, so a self-edge scores 2, the same expansion a walk
    // from that node would see.
    const degreeRows = await env.DB.prepare(
      `SELECT id, COUNT(*) AS degree FROM (
         SELECT source_id AS id FROM edges WHERE ${edgeScope.clause}
         UNION ALL
         SELECT target_id AS id FROM edges WHERE ${edgeScope.clause}
       ) GROUP BY id ORDER BY degree DESC, id ASC LIMIT ${GRAPH_STATS_TOP_DEGREE}`,
    ).bind(...edgeScope.bindings, ...edgeScope.bindings).all();

    // Bucketed in SQL: one row back however large the brain is. Reads the gap
    // between consecutive captures, which is what sizes the `follows` window.
    //
    // PARTITIONED BY WORKSPACE, because that window is only ever applied within
    // one: an unpartitioned LAG over a caller who reads three workspaces
    // interleaves them and reports gaps between captures that no `follows` edge
    // could ever join, biasing the whole distribution short.
    const gapScope = scopeWhere(auth);
    const gaps = await env.DB.prepare(
      // validity: any: 管理者の集計・活動・索引保守・変更前の状態確認は過去分も扱う。
      `WITH gaps AS (
         SELECT created_at - LAG(created_at) OVER (PARTITION BY workspace_id ORDER BY created_at) AS gap
         FROM entries WHERE ${gapScope.clause}
       )
       SELECT SUM(CASE WHEN gap <      300000 THEN 1 ELSE 0 END) AS under5m,
              SUM(CASE WHEN gap >=     300000 AND gap <    1800000 THEN 1 ELSE 0 END) AS under30m,
              SUM(CASE WHEN gap >=    1800000 AND gap <    7200000 THEN 1 ELSE 0 END) AS under2h,
              SUM(CASE WHEN gap >=    7200000 AND gap <   86400000 THEN 1 ELSE 0 END) AS under1d,
              SUM(CASE WHEN gap >=   86400000 AND gap <  604800000 THEN 1 ELSE 0 END) AS under7d,
              SUM(CASE WHEN gap >=  604800000 THEN 1 ELSE 0 END) AS older
       FROM gaps WHERE gap IS NOT NULL`,
    ).bind(...gapScope.bindings).first() as Record<string, any> | null;

    return json({
      ok: true,
      deep: true,
      edgeTypes,
      invalidEndpointEdges: Number(invalidEndpoints?.n ?? 0),
      topDegree: (degreeRows.results as any[]).map(r => ({ id: r.id as string, degree: Number(r.degree) })),
      gapBuckets: {
        under5m: Number(gaps?.under5m ?? 0),
        under30m: Number(gaps?.under30m ?? 0),
        under2h: Number(gaps?.under2h ?? 0),
        under1d: Number(gaps?.under1d ?? 0),
        under7d: Number(gaps?.under7d ?? 0),
        older: Number(gaps?.older ?? 0),
      },
    });
  }

  // GET /stats/activity, per-source capture volume over N days, for the
  // dashboard's growth chart. Per-caller, not admin (see the /patterns
  // precedent above): same shape as GET /brief's activity strip, widened to
  // bucket by source as well as by day.
  if (url.pathname === "/stats/activity" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const days = intParam(url, "days", { fallback: 90, min: 7, max: 365 });
    if (days instanceof Response) return days;

    const scope = scopeWhere(auth);
    const now = Date.now();
    const since = now - days * 86400000;
    // Uses idx_entries_workspace_created: the workspace predicate seeks, the
    // created_at cutoff range-scans from there, the same cost class as
    // GET /brief's activity query. One statement, pivoted into per-source
    // series below.
    const { results } = await env.DB.prepare(
      // validity: any: 管理者の集計・活動・索引保守・変更前の状態確認は過去分も扱う。
      `SELECT source, CAST(created_at / 86400000 AS INTEGER) AS day, COUNT(*) AS n
       FROM entries WHERE created_at >= ? AND ${scope.clause}
       GROUP BY source, day`,
    ).bind(since, ...scope.bindings).all();

    const today = Math.floor(now / 86400000);
    const start = today - (days - 1);
    const bySource = new Map<string, Map<number, number>>();
    for (const r of results as { source: string | null; day: number; n: number }[]) {
      const source = r.source ?? "unknown";
      const byDay = bySource.get(source) ?? new Map<number, number>();
      byDay.set(r.day, Number(r.n));
      bySource.set(source, byDay);
    }

    const series = [...bySource.entries()]
      .map(([source, byDay]) => {
        const counts: number[] = [];
        for (let d = start; d <= today; d++) counts.push(byDay.get(d) ?? 0);
        return { source, counts, total: counts.reduce((a, b) => a + b, 0) };
      })
      .sort((a, b) => b.total - a.total)
      .map(({ source, counts }) => ({ source, counts }));

    return json({ ok: true, days, start, series });
  }

  // GET /stats/recalled, the dashboard's "most recalled" panel. No index on
  // recall_count: ORDER BY ... LIMIT sorts the caller's own scoped rows
  // (already narrowed to the caller by idx_entries_workspace_created's
  // leading column) once per dashboard open, which the worker cookbook
  // accepts as a cost at this scale. Do not add an index for this alone.
  if (url.pathname === "/stats/recalled" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 5, min: 1, max: 20 });
    if (limit instanceof Response) return limit;

    const scope = scopeWhere(auth);
    // Same exclusions as /stats' digest-candidate query above: rollups,
    // proposed patterns and insights are not "your own" recalled memories.
    const exclusions = `tags NOT LIKE '%"rolled-up"%'
       AND tags NOT LIKE '%"synthesized"%'
       AND tags NOT LIKE '%"auto-pattern"%'
       AND tags NOT LIKE '%"auto-insight"%'`;

    const [rows, totalRow] = await Promise.all([
      env.DB.prepare(
        // validity: any: 管理者の集計・活動・索引保守・変更前の状態確認は過去分も扱う。
        `SELECT id, content, source, created_at, recall_count
         FROM entries WHERE ${scope.clause} AND ${exclusions}
         ORDER BY recall_count DESC, created_at DESC LIMIT ?`,
      ).bind(...scope.bindings, limit).all(),
      env.DB.prepare(
        // validity: any: 管理者の集計・活動・索引保守・変更前の状態確認は過去分も扱う。
        `SELECT SUM(recall_count) AS total, SUM(contradiction_wins) AS contradictions
         FROM entries WHERE ${scope.clause} AND ${exclusions}`,
      ).bind(...scope.bindings).first() as Promise<Record<string, any> | null>,
    ]);

    return json({
      ok: true,
      total_recalls: Number(totalRow?.total ?? 0),
      total_contradictions: Number(totalRow?.contradictions ?? 0),
      entries: (rows.results as any[]).map(r => ({
        id: r.id as string,
        content: r.content as string,
        source: r.source as string,
        created_at: r.created_at as number,
        recall_count: Number(r.recall_count ?? 0),
      })),
    });
  }

  // GET /stats/night, last night's maintenance summary, read from KV. Never
  // derived from D1 at read time: edges has no index on workspace_id or
  // created_at, so counting "links inferred since last night" here would be a
  // full scan of the edge table on every dashboard open (the same cost class
  // GET /stats/graph?deep=1 refuses to let run on a schedule). The nightly
  // scheduled() handler writes the summary once per workspace per night
  // instead (src/runtime/night-summary.ts); this only reads it back.
  if (url.pathname === "/stats/night" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    // readableWorkspaces, not a hand-built list: it appends "" for admins,
    // the legacy pre-team bucket the maintenance rotation can still land on
    // (src/runtime/rotation.ts), which every other scoped read already covers.
    const workspaceIds = readableWorkspaces(auth);
    const records = (await Promise.all(
      workspaceIds.map(id => readNightSummary(env, id)),
    )).filter((r): r is NightSummary => r !== null);

    if (!records.length) return json({ ok: true, ranAt: null });

    return json({
      ok: true,
      ranAt: Math.max(...records.map(r => r.ranAt)),
      linksInferred: records.reduce((sum, r) => sum + r.linksInferred, 0),
      insightsProposed: records.reduce((sum, r) => sum + r.insightsProposed, 0),
      digestsWritten: records.reduce((sum, r) => sum + r.digestsWritten, 0),
      claimsFlagged: records.reduce((sum, r) => sum + r.claimsFlagged, 0),
    });
  }

  // GET /health, index/runtime health, used by the dashboard banner, the
  // README verify step, and external uptime checks. Authenticated like the
  // rest of the API but deliberately NOT admin-gated: it reports index state,
  // not cross-workspace data, and every signed-in member's dashboard banner
  // reads it.
  if (url.pathname === "/health" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    // This is the deployment readiness endpoint. Unlike the background cold-start
    // optimisation in ensureDbReady, success here guarantees every ordered ALTER and
    // trigger upgrade has completed, so a fresh D1 needs no unsafe direct schema script.
    await initializeDatabase(env);
    const [vectorize, ai, team] = await Promise.all([
      checkVectorizeHealth(env),
      readWorkersAiHealth(env),
      isTeamBrain(env),
    ]);
    const { supported, degradedQueries } = vectorizeFilterState();
    const latchedAtRaw = await env.OAUTH_KV.get(VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY).catch(() => null);
    const latchedAt = latchedAtRaw ? Number(latchedAtRaw) : null;
    // T-0101.8.5: the KV marker set once history starts being recorded (T-0089.1.1),
    // read here only — no D1 fallback. Omitted, not null, when it has never been set.
    const historySinceRaw = await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY).catch(() => null);
    return json({
      ok: vectorize.ok && ai.ok !== false,
      // 既存okは完全な準備状態を維持。D1到達とAIの受動的観測を区別する。
      status: !vectorize.ok || ai.ok === false ? "degraded" : "no_known_outage",
      database: { status: "reachable" },
      version: SB_VERSION,
      vectorize: { ...vectorize, workspaceFilter: { supported, degradedQueries, latchedAt } },
      ai,
      team,
      ...(historySinceRaw ? { history_since: Number(historySinceRaw) } : {}),
    });
  }

  // GET /patterns, the whole review queue, paged.
  //
  // The dashboard used to build this list from `/list?n=20&tag=auto-pattern`
  // (the old producer) and drop the deprecated rows in the browser, which
  // cannot work on a brain that has been running a while: dismissed insight
  // proposals keep their tag forever, so once there are more than a page of
  // them the filter throws away every row and the panel renders empty while
  // real proposals wait behind them. Filtering belongs in the query.
  // The three review surfaces below are per-caller, not administration: each
  // member confirms or dismisses their OWN pending insights and stale claims, and
  // every query is scoped to their readable set.
  //
  // They were requireAdmin, which cost nothing while a brain had one user and two
  // things once it had more. A member's Home screen calls /patterns on every load
  // (public/js/brief.js) and got a 403, so the insight feature was invisible to
  // everyone but the admin; and the admin's queues were unscoped, so they printed
  // colleagues' private memories in full, the same rows GET /entry answers 404
  // for with the same token. Scoping alone would have left members' flagged
  // memories reviewable by nobody at all.
  if (url.pathname === "/patterns" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;

    // Scoped, like every other route that returns memory content. This queue is
    // admin-only, but "admin" does not mean "may read a member's personal
    // workspace" anywhere else in this codebase: the same token gets a 404 from
    // GET /entry for the very row this queue was printing in full. An insight is
    // drawn from the memories it cites, so an unscoped queue handed the admin a
    // member's private material verbatim.
    const scope = scopeWhere(auth);
    const [rows, countRow] = await Promise.all([
      env.DB.prepare(
        // workspace_id, actor_id and source ride along on the query that
        // already runs: the queue's rows have to say which layer they belong
        // to and who wrote them, and three more columns on an existing
        // projection is no new statement and no check:scope movement.
        // validity: current: 既存のPENDING_INSIGHT_SQL・STALE_REVIEW_SQL・compressionEligibilitySqlで現在の適格性を検査する。
        `SELECT id, content, created_at, workspace_id, actor_id, source FROM entries
         WHERE ${PENDING_INSIGHT_SQL} AND ${scope.clause}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).bind(...scope.bindings, limit, offset).all(),
      // The total drives "N waiting" and the pager. It is a second query rather
      // than a window function so the shape survives D1's SQLite build.
      env.DB.prepare(
        // validity: current: 既存のPENDING_INSIGHT_SQL・STALE_REVIEW_SQL・compressionEligibilitySqlで現在の適格性を検査する。
        `SELECT COUNT(*) AS n FROM entries WHERE ${PENDING_INSIGHT_SQL} AND ${scope.clause}`,
      ).bind(...scope.bindings).first() as Promise<Record<string, any> | null>,
    ]);

    const pageRows = rows.results as Record<string, any>[];
    const pageIds = pageRows.map(r => r.id as string);
    // One query for the whole page rather than one per insight. LEFT JOIN so a
    // source deleted after the edge was written still surfaces as a row, the
    // edges table has no foreign keys, so an edge can outlive its target, and
    // the reviewer needs to be told the source is gone rather than shown a gap.
    const sourcesByInsight = new Map<string, ({ id: string; content: string } | { id: string; missing: true })[]>();
    if (pageIds.length) {
      // The scope goes in the JOIN's ON clause, not the WHERE. Only `e.source_id`
      // was ever constrained here, those are the scoped page's insight ids, but
      // the CONTENT returned comes from `e.target_id`, which nothing constrained,
      // so an insight the caller may read handed back the full text of a memory
      // in a colleague's personal workspace. It is the same defect as the
      // /insights/dry-run pair query: a join through an unscoped table, not a
      // by-id lookup.
      //
      // In the ON clause rather than the WHERE because this is a LEFT JOIN whose
      // whole point is that a source deleted after the edge was written still
      // surfaces as a row. A WHERE predicate would drop those rows (NULL IN (...)
      // is never true) and take the "missing" signal with them. In the ON clause,
      // an unreadable source reads exactly like a deleted one, the reviewer is
      // told the source is unavailable rather than shown a colleague's memory,
      // which is the same answer GET /entry gives for that id.
      //
      // Written `m.${scope.clause}` rather than building the clause with the
      // alias baked in, so the alias is visible in the template itself: that is
      // what lets scripts/check-scope.mjs attribute the clause to `m` instead of
      // counting it against whichever table reference it reaches first.
      const mScope = scopeWhere(auth);
      // scope-outer-join: the edges alias e is pinned by source_id IN (the scoped insight page above), so every row here already belongs to the caller; the entries alias m is reached by a LEFT JOIN and its clause is in the ON, which nulls a column rather than dropping a row. That is sufficient HERE and only here, because m contributes exactly one column: `content`. The row itself, and the `id` beside it, come from `e.target_id`, an edge of the caller's own insight, so an unreadable source renders as { missing: true }, which is what a source DELETED after the edge was written renders as, and what GET /entry answers for that id. A WHERE predicate would drop those rows and take the "missing" signal with them
      const sourceRows = (await env.DB.prepare(
        `SELECT e.source_id AS insight_id, e.target_id AS id, m.content AS content
         FROM edges e LEFT JOIN entries m ON m.id = e.target_id AND m.${mScope.clause}
         WHERE e.type = 'drawn_from' AND e.source_id IN (${pageIds.map(() => "?").join(",")})`,
      ).bind(...mScope.bindings, ...pageIds).all()).results as Record<string, any>[];
      for (const r of sourceRows) {
        const list = sourcesByInsight.get(r.insight_id as string) ?? [];
        list.push(
          r.content == null
            ? { id: r.id as string, missing: true }
            : { id: r.id as string, content: r.content as string },
        );
        sourcesByInsight.set(r.insight_id as string, list);
      }
    }

    // Exactly GET /list's layer rule, because it is literally that function
    // (src/lib/scope.ts). The client cannot infer this itself: it holds no
    // workspace ids, and the one thing it could read a layer off (`sources`)
    // describes the INPUTS, not the insight.
    // Issues NO statement for an empty list, and in practice it always is
    // empty, because every row in this queue carries `auto-insight` and every
    // auto-insight row is written with actorId "". The call is made anyway
    // rather than skipped on that basis: "every row here is system-authored"
    // is an invariant of a different file, and the cost of not relying on it
    // is zero.
    const labelMap = await lookupActorLabels(
      env,
      pageRows.filter(r => layerOf(auth, r.workspace_id) === "company").map(r => String(r.actor_id ?? "")),
    );

    return json({
      ok: true,
      patterns: pageRows.map(r => ({
        id: r.id as string,
        content: r.content as string,
        created_at: r.created_at as number,
        sources: sourcesByInsight.get(r.id as string) ?? [],
        workspace: layerOf(auth, r.workspace_id),
        // The same resolver /list, /entry and /graph call, given the same
        // inputs, so an insight cannot be attributed one way in the review
        // queue and another way on the card the reader opens next.
        actor_name: resolveActorLabel(String(r.actor_id ?? ""), labelMap, {
          viewerId: auth.userId,
          source: String(r.source ?? ""),
        }),
      })),
      total: (countRow?.n as number) ?? 0,
      limit,
      offset,
    });
  }

  // GET /stale, the out-of-date review queue.
  //
  // Home's chip reads "N may be out of date" off an exact tag predicate, so the
  // entries behind that number are knowable exactly. It used to be wired to a
  // free-text recall for the phrase "What might be out of date?", a vector
  // search over the whole brain, which returns the flagged entries only by
  // coincidence, and on a real brain returned two memories that merely contained
  // the words while the one actually flagged never appeared.
  //
  // A client-side filter over /list is not the alternative: the dashboard holds
  // the 50 most recent entries, and a memory old enough to be flagged stale is
  // almost never among them. That is the same mistake the insight panel made
  // before /patterns existed, and it renders an empty list rather than a wrong
  // one. Filtering belongs in the query.
  if (url.pathname === "/stale" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;

    // Scoped for the same reason as /patterns: this queue prints memory content,
    // and an admin gets a 404 from GET /entry for a member's personal row. The
    // reviewer confirms or corrects their own claims, not a colleague's.
    const scope = scopeWhere(auth);
    const now = Date.now();
    const [rows, countRow] = await Promise.all([
      env.DB.prepare(
        // validity: current: 既存のPENDING_INSIGHT_SQL・STALE_REVIEW_SQL・compressionEligibilitySqlで現在の適格性を検査する。
        `SELECT id, content, tags, source, created_at, when_at, valid_until, COALESCE(updated_at, created_at) AS last_updated
         FROM entries
         WHERE ${STALE_REVIEW_SQL} AND ${scope.clause}
         ORDER BY COALESCE(updated_at, created_at) ASC LIMIT ? OFFSET ?`,
      ).bind(...scope.bindings, limit, offset).all(),
      env.DB.prepare(
        // validity: current: 既存のPENDING_INSIGHT_SQL・STALE_REVIEW_SQL・compressionEligibilitySqlで現在の適格性を検査する。
        `SELECT COUNT(*) AS n FROM entries WHERE ${STALE_REVIEW_SQL} AND ${scope.clause}`,
      ).bind(...scope.bindings).first() as Promise<Record<string, any> | null>,
    ]);

    return json({
      ok: true,
      // Oldest-touched first: the least recently confirmed claim is the one most
      // worth a human's attention, and it keeps paging stable while entries drop
      // out of the queue as they are edited.
      entries: (rows.results as Record<string, any>[]).map(r => {
        const tags = JSON.parse((r.tags as string) ?? "[]") as string[];
        return {
          id: r.id as string,
          content: r.content as string,
          tags,
          source: r.source as string,
          created_at: r.created_at as number,
          last_updated: r.last_updated as number,
          valid_until: r.valid_until as number | null,
          reason: staleReasonFor(tags, r.when_at as number | null, now),
        };
      }),
      total: (countRow?.n as number) ?? 0,
      limit,
      offset,
    });
  }

  // POST /stale/keep, confirm a flagged memory is still true without editing it.
  // Agents may settle this on the user's word through MCP resolve. The audit
  // event records the prior values. Clears stale:as-of and bumps updated_at so the
  // nightly pass does not immediately re-flag the same claim.
  if (url.pathname === "/stale/keep" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

    const result = await resolveEntryAction(env, ctx, auth, body.id.trim(), "still_true", undefined, { actorId: auth.userId, channel: "rest" });
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    return json({ ok: true, id: result.id });
  }

  // GET /loops, the open-commitments review queue. Mirrors GET /stale: the
  // predicate is shared with the count GET /brief puts on its chip
  // (OPEN_LOOP_SQL) so the two cannot disagree, and this queue exists for the
  // same reason that one does — a member re-reading a scrollback for "what did
  // I say I'd do" cannot ask a vector index that question reliably.
  if (url.pathname === "/loops" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;
    // P7.8: defaults to "out" so every existing client (none of which send
    // direction) keeps today's meaning, "things I owe". The dashboard asks
    // for both explicitly.
    const direction = url.searchParams.get("direction") ?? "out";
    if (direction !== "out" && direction !== "in" && direction !== "all") {
      return json({ ok: false, error: 'direction must be "out", "in" or "all"' }, 400);
    }
    const now = Date.now();
    const directionSql = direction === "out" ? openOutboundSql(now) : direction === "in" ? openInboundSql(now) : openLoopSql(now);

    const scope = scopeWhere(auth);
    // validity: current: a replaced loop is not open (5.5)
    const [rows, countRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, content, tags, source, created_at FROM entries
         WHERE ${directionSql} AND ${scope.clause}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).bind(...scope.bindings, limit, offset).all(),
      // validity: current: the pager's total must match the same replaced-loop exclusion as the rows above (5.5)
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE ${directionSql} AND ${scope.clause}`,
      ).bind(...scope.bindings).first() as Promise<Record<string, any> | null>,
    ]);

    return json({
      ok: true,
      entries: (rows.results as Record<string, any>[]).map(r => {
        const tags = parseTags(r.tags as string);
        return {
          id: r.id as string,
          content: r.content as string,
          source: r.source as string,
          tags,
          created_at: r.created_at as number,
          direction: directionOf(tags),
          ...(counterpartyOf(tags) ? { counterparty: counterpartyOf(tags) } : {}),
        };
      }),
      total: (countRow?.n as number) ?? 0,
      limit,
      offset,
    });
  }

  // POST /loops/resolve, close out one open commitment. "done" marks it
  // finished without disturbing the "task" tag, which is history; "not-task"
  // means the tag never belonged, so it comes off outright.
  //
  // CAS on tags AND content, three attempts — the same guard shape as the
  // staleness pass's per-row write (src/staleness/pass.ts): tags alone would
  // not catch a concurrent content-only rewrite landing between the read here
  // and the write below, and re-reading the row for each attempt means a
  // retry classifies from what is actually there rather than a snapshot that
  // just lost a race.
  if (url.pathname === "/loops/resolve" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; action?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (body.action !== "done" && body.action !== "not-task") {
      return json({ ok: false, error: `action must be "done" or "not-task"` }, 400);
    }

    const result = await resolveEntryAction(env, ctx, auth, body.id.trim(), body.action === "done" ? "done" : "not_a_task", undefined, { actorId: auth.userId, channel: "rest" });
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    return json({ ok: true, id: result.id, action: body.action });
  }

  // GET /due, the time-anchored feed: overdue commitments (when_at already
  // passed) and upcoming ones (within the next 48 hours), each capped and
  // counted. This is the only source scripts/brief-preview.mjs's --dry-run
  // check and the future push sender both read from — a due date exists on
  // an entry the moment when_at is set, by whichever of the three producers
  // (explicit, src/when/heuristic.ts, src/when/pass.ts) set it.
  if (url.pathname === "/due" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const scope = scopeWhere(auth);
    const now = Date.now();
    const upcomingBefore = now + DUE_WITHIN_MS;

    const rowShape = (r: Record<string, any>) => {
      const tags = parseTags(r.tags as string);
      return {
        id: r.id as string,
        content: (r.content as string).slice(0, DUE_CONTENT_CHARS),
        // The nightly pass's short label when it set the when (src/when/pass.ts),
        // else the first 80 characters of content as a fallback for the
        // explicit/regex paths, which never generate one.
        label: (r.when_label as string | null) || (r.content as string).slice(0, 80),
        tags,
        when_at: r.when_at as number,
        when_kind: r.when_kind as string,
        when_source: r.when_source as string,
        // Design 5.3: derived from tags in JS, no SQL change — rows already carry tags.
        kind: dueKindOf(tags),
      };
    };

    // validity: current: a replaced "dentist Tuesday" must not appear in GET /due (5.5)
    const [overdueRows, overdueCount, upcomingRows, upcomingCount] = await Promise.all([
      env.DB.prepare(
        `SELECT id, content, tags, when_at, when_kind, when_source, when_label FROM entries
         WHERE ${dueSql(now)} AND when_at < ? AND ${scope.clause}
         ORDER BY when_at ASC LIMIT ?`,
      ).bind(now, ...scope.bindings, DUE_FEED_LIMIT).all(),
      // validity: current: the overdue pager's total must match the same replaced-fact exclusion as the rows above (5.5)
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE ${dueSql(now)} AND when_at < ? AND ${scope.clause}`,
      ).bind(now, ...scope.bindings).first() as Promise<Record<string, any> | null>,
      // validity: current: a replaced "dentist Tuesday" must not appear in the upcoming feed either (5.5)
      env.DB.prepare(
        `SELECT id, content, tags, when_at, when_kind, when_source, when_label FROM entries
         WHERE ${dueSql(now)} AND when_at >= ? AND when_at <= ? AND ${scope.clause}
         ORDER BY when_at ASC LIMIT ?`,
      ).bind(now, upcomingBefore, ...scope.bindings, DUE_FEED_LIMIT).all(),
      // validity: current: the upcoming pager's total must match the same replaced-fact exclusion as the rows above (5.5)
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE ${dueSql(now)} AND when_at >= ? AND when_at <= ? AND ${scope.clause}`,
      ).bind(now, upcomingBefore, ...scope.bindings).first() as Promise<Record<string, any> | null>,
    ]);

    return json({
      ok: true,
      overdue: (overdueRows.results as Record<string, any>[]).map(rowShape),
      upcoming: (upcomingRows.results as Record<string, any>[]).map(rowShape),
      counts: {
        overdue: (overdueCount?.n as number) ?? 0,
        upcoming: (upcomingCount?.n as number) ?? 0,
      },
    });
  }

  // POST /due/snooze, push a time anchor out to a new date without touching
  // when_kind or when_label. Validated the same way an explicit when is
  // (future, no more than 5 years out) plus a floor parseExplicitWhen does
  // not itself enforce: a snooze into the past is not a snooze.
  //
  // CAS on tags AND content, three attempts — same guard shape as
  // /loops/resolve above, so a concurrent edit or delete between the read and
  // the write below is caught rather than clobbered.
  if (url.pathname === "/due/snooze" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; until?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (!body.until?.trim()) return json({ ok: false, error: "until is required" }, 400);

    const result = await resolveEntryAction(env, ctx, auth, body.id.trim(), "snooze", body.until, { actorId: auth.userId, channel: "rest" });
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    return json({ ok: true, id: result.id, when_at: result.when_at });
  }

  // POST /due/clear, drop the time anchor entirely: not a commitment, or
  // already handled outside the loop-resolve flow. when_source becomes
  // 'cleared' rather than NULL so the nightly pass's prefilter (when_at IS
  // NULL AND when_source IS NULL, src/when/pass.ts) never re-stamps it — a
  // cleared entry stays cleared until a caller sets a when explicitly again.
  //
  // CAS on tags AND content, same shape as /loops/resolve and /due/snooze above.
  if (url.pathname === "/due/clear" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

    const result = await resolveEntryAction(env, ctx, auth, body.id.trim(), "clear_date", undefined, { actorId: auth.userId, channel: "rest" });
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    return json({ ok: true, id: result.id });
  }

  // GET /extract/dry-run, a preview of the nightly when-extraction pass
  // (src/when/pass.ts) against the live brain: the exact prefilter and the
  // exact model call, on the next N candidates past the pass's own cursor,
  // reporting every verdict without persisting anything or moving the
  // cursor. Mirrors GET /insights/dry-run's shape and purpose — testing
  // extraction quality on real data is the whole reason this exists.
  if (url.pathname === "/extract/dry-run" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 5, min: 1, max: 10 });
    if (limit instanceof Response) return limit;

    const cursor = await readWhenCursor(env);
    const scope = scopeWhere(auth);
    const candidates = await fetchWhenCandidates(env, cursor, scope, limit);

    const cfg = await resolveConfig(env);
    const verdicts = [];
    for (const candidate of candidates) {
      const outcome = await judgeCommitment(candidate.content, Date.now(), env, cfg);
      verdicts.push({
        id: candidate.id,
        content: candidate.content.slice(0, DUE_CONTENT_CHARS),
        outcome: outcome.outcome,
        what: outcome.outcome === "commitment" ? outcome.what : null,
        due_at: outcome.outcome === "commitment" ? outcome.dueAt : null,
        kind: outcome.outcome === "commitment" ? outcome.kind : null,
        confidence: outcome.outcome === "commitment" ? outcome.confidence : null,
      });
      // A failed call means the batch stops here in production (the pass
      // does not risk skipping it); the preview keeps going so a reviewer
      // sees every candidate in the window, not just the ones before the
      // first hiccup.
    }

    return json({ ok: true, candidates: verdicts });
  }

  // POST /patterns/resolve, confirm or dismiss a proposed insight.
  // Agents may settle one insight on the user's word through MCP resolve;
  // the audit event records each prior value. Confirm promotes it into a real recallable
  // memory; dismiss deprecates it (audit row kept, vectors removed).
  //
  // Takes `id` for one or `ids` for many. Ruling on a backlog one at a time is
  // the actual complaint this answers, and doing it as N single requests would
  // be N round trips against a Worker that gets ~50 D1 queries per invocation.
  if (url.pathname === "/patterns/resolve" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; ids?: unknown; action?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const action = body.action;
    if (action !== "confirm" && action !== "dismiss") {
      return json({ ok: false, error: `action must be "confirm" or "dismiss"` }, 400);
    }

    // Scoped like the /patterns queue these ids come from. Confirm promotes a
    // memory and dismiss deprecates it and drops its vectors, so an unscoped
    // lookup let an admin rewrite rows in a member's personal workspace, rows
    // the same token cannot read through GET /entry.
    const scope = scopeWhere(auth);
    const bulkLimit = D1_MAX_BOUND_PARAMS - scope.bindings.length;

    const single = body.id?.trim();
    let ids: string[];
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.some(i => typeof i !== "string")) {
        return json({ ok: false, error: "ids must be an array of strings" }, 400);
      }
      // De-duplicated because the same id twice would bind two parameters and
      // count the same row twice in the reply.
      ids = [...new Set((body.ids as string[]).map(i => i.trim()).filter(Boolean))];
      if (!ids.length) return json({ ok: false, error: "ids must not be empty" }, 400);
      // D1 allows 100 bound parameters per statement, and the id list is the
      // whole of the SELECT's binding. The client pages; this refuses rather
      // than silently truncating, because a silent truncation here reads as
      // "those patterns were resolved" when they were not.
      if (ids.length > bulkLimit) {
        return json({ ok: false, error: `ids must not exceed ${bulkLimit} per request` }, 400);
      }
    } else {
      if (!single) return json({ ok: false, error: "id is required" }, 400);
      ids = [single];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      // validity: any: 管理者の集計・活動・索引保守・変更前の状態確認は過去分も扱う。
      `SELECT id, tags, vector_ids, workspace_id FROM entries WHERE id IN (${placeholders}) AND ${scopeWhereForIdRead(scope).clause}`,
    ).bind(...ids, ...scope.bindings).all();
    const found = results as Record<string, any>[];

    // The single-id form keeps its precise errors, because a client asking about
    // one pattern can act on "not found" and the bulk form cannot.
    if (body.ids === undefined) {
      if (!found.length) return json({ ok: false, error: `No memory found with ID: ${ids[0]}` }, 404);
      if (!(JSON.parse(found[0].tags ?? "[]") as string[]).includes("auto-insight")) {
        return json({ ok: false, error: "Entry is not a derived insight" }, 400);
      }
    }

    const result = await applyInsightResolution(env, ctx, { actorId: auth.userId, channel: "rest" }, found, ids.length, action);
    return json({
      ok: true,
      action,
      resolved: result.resolved.length,
      ids: result.resolved,
      skipped: result.skipped,
      ...(body.ids === undefined ? { id: ids[0] } : {}),
    });
  }

  // POST /vectorize-pending
  if (url.pathname === "/vectorize-pending" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const { quotaRetryAt, ...result } = await processPendingVectorization(env);
    return json({ ...result, ...(quotaRetryAt ? { quota_retry_at: quotaRetryAt } : {}) });
  }

  // POST /classify-pending
  // Manual accelerator for the same resumable queue the scheduled quota-recovery
  // pass drains conservatively. It also remains useful as an opt-in backfill for
  // entries that predate status (#119) and kind (#12). No schema migration — only
  // status:/kind: tags are written.
  if (url.pathname === "/classify-pending" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const { quotaRetryAt, ...result } = await processPendingClassification(env);
    return json({ ...result, ...(quotaRetryAt ? { quota_retry_at: quotaRetryAt } : {}) });
  }

  // POST /insights/accrue, run one accrual pass on demand, right now.
  //
  // The nightly cron (runInsightAccrual, src/insight/candidates.ts) examines
  // only ACCRUAL_SEED_LIMIT (25) entries per run, topped up from a backfill
  // cursor on quiet nights. That is fine for a brain that grows a little
  // every day, but a self-hoster installing this against an EXISTING brain
  // of a few thousand entries would otherwise wait months for the backfill
  // cursor to cross it once, the weekly pass would have almost nothing to
  // reason over, and the feature would look broken with no way to prime it.
  //
  // This calls the exact same function the cron does, once, synchronously,
  // and reports what it found, no separate accrual logic lives here. The
  // cursor it walks is the SAME cursor the nightly cron uses (KV key
  // ACCRUAL_CURSOR_KEY), so calling this repeatedly walks it forward exactly
  // like repeated nights would: that is the intended way to prime a large
  // brain, not a one-shot backfill. Call it until `seeds_examined` comes back
  // small, that means the cursor has caught up to the present.
  if (url.pathname === "/insights/accrue" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const pendingCount = () =>
      env.DB.prepare(`SELECT COUNT(*) AS n FROM insight_candidates WHERE status = 'pending'`)
        .first() as Promise<Record<string, any> | null>;

    // Before/after rather than threading a write-count out of
    // runInsightAccrual itself: every row it inserts starts 'pending' and
    // nothing else in this request can change that count concurrently, so
    // the delta is exactly how many candidates this pass newly recorded,
    // including the ON CONFLICT(a_id, b_id) DO NOTHING case, where an
    // attempted insert did not actually add a row.
    const before = await pendingCount();
    const { seedsExamined } = await runInsightAccrual(env, ctx);
    const after = await pendingCount();

    const pendingTotal = (after?.n as number) ?? 0;
    const pendingBefore = (before?.n as number) ?? 0;

    return json({
      ok: true,
      seeds_examined: seedsExamined,
      candidates_recorded: pendingTotal - pendingBefore,
      pending_total: pendingTotal,
    });
  }

  // GET /insights/dry-run, what the weekly pass would say, without saying it.
  //
  // Ships ahead of the weekly writer being enabled. The design was validated
  // against a brain that is not representative, so the first question is
  // whether the shortlist is any good on real data, and this answers it for
  // the price of a few model calls and no writes at all. A declined candidate
  // is reported with null shape/text rather than dropped, so a reader can see
  // a high-scoring pair was considered and rejected, not just what survived.
  if (url.pathname === "/insights/dry-run" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const cfg = await resolveConfig(env);

    const limit = intParam(url, "limit", { fallback: 10, min: 1, max: 25 });
    if (limit instanceof Response) return limit;

    // a.tags/b.tags added so this can apply the same D1 pair rule the weekly
    // pass applies (src/insight/weekly.ts), without them, this endpoint
    // could not tell an assistant-authored pair from any other and would
    // report exactly what production refuses as if it would be written.
    //
    // requireAdmin authorises this surface; it does not widen the readable row
    // set (src/lib/scope.ts). Both sides of the pair are scoped independently:
    // a candidate is previewable only when the caller could have read BOTH of
    // the memories it draws on, which is the same rule GET /entry applies one
    // row at a time. This one reaches `entries` through JOIN rather than FROM,
    // which is how it stayed unscoped while every sibling query was fixed.
    const aScope = scopeWhere(auth, undefined, "a.workspace_id");
    const bScope = scopeWhere(auth, undefined, "b.workspace_id");
    const dryRunNow = Date.now();
    // validity: current: a replaced side of a candidate pair is not insight material (5.5)
    // Codex review class E (T-0089.4.2): same gap and same fix as src/insight/weekly.ts's own
    // draw query — a candidate accrued clean can be held by the time this preview reads it.
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.a_id, c.b_id, c.score, a.content AS a_content, b.content AS b_content,
              a.tags AS a_tags, b.tags AS b_tags, a.workspace_id AS a_workspace_id, b.workspace_id AS b_workspace_id
       FROM insight_candidates c
       JOIN entries a ON a.id = c.a_id
       JOIN entries b ON b.id = c.b_id
       WHERE ${INSIGHT_CANDIDATE_SQL}
         AND a.tags NOT LIKE '%"status:deprecated"%'
         AND b.tags NOT LIKE '%"status:deprecated"%'
         AND (a.valid_until IS NULL OR a.valid_until > ${dryRunNow})
         AND (b.valid_until IS NULL OR b.valid_until > ${dryRunNow})
         AND ${notHeldSqlFor("a")}
         AND ${notHeldSqlFor("b")}
         AND ${aScope.clause} AND ${bScope.clause}
       ORDER BY c.score DESC
       LIMIT ?`,
    ).bind(...aScope.bindings, ...bScope.bindings, limit).all() as { results: Record<string, any>[] };

    // D2's comparison list, built exactly as src/insight/weekly.ts builds it:
    // insights still unreviewed from earlier runs, seeded before the loop and
    // grown as this preview accepts candidates. Without this, the dry run
    // could not reproduce the spec's own motivating case, a candidate
    // restating an insight a PRIOR run already wrote is invisible to a
    // same-run-only check.
    //
    // Scoped for the same reason the candidate query is, and the leak here is
    // quieter: the comparison text is never printed, but an unscoped list lets a
    // colleague's private proposal suppress the caller's own candidate with the
    // reason "restates a recently written insight", an admin told her preview
    // duplicates something she cannot see and did not write.
    const scope = scopeWhere(auth);
    const { results: recentInsightRows } = await env.DB.prepare(
      // validity: current: 既存のPENDING_INSIGHT_SQL・STALE_REVIEW_SQL・compressionEligibilitySqlで現在の適格性を検査する。
      `SELECT content FROM entries WHERE ${PENDING_INSIGHT_SQL} AND ${scope.clause}
       ORDER BY created_at DESC LIMIT ?`,
    ).bind(...scope.bindings, RECENT_INSIGHT_WINDOW).all() as { results: { content: string }[] };
    const writtenThisRun: string[] = recentInsightRows.map(r => rawInsightText(r.content));

    const candidates = [];
    // Reasons over every row the query returned, deliberately past the three
    // production would ever write (src/insight/weekly.ts's own
    // MAX_INSIGHTS_PER_RUN cap), seeing candidates four and beyond is how the
    // ranking itself gets judged. `would_write` marks the first three
    // candidates, in score order, that clear D1 (pair-eligible), the model
    // (an "insight" outcome), AND D2 (not restatesRecent against
    // writtenThisRun), the same three gates runWeeklyInsights applies before
    // it ever calls captureEntry. This is close to but not exactly what
    // production's `written` counter tracks: that increments only when
    // captureEntry returns `status: "stored"`, so an accepted, non-restating
    // insight that turns out to duplicate an earlier ENTRY (not a recent
    // insight, captureEntry's own separate duplicate check) consumes no slot
    // there but is still counted here. A dry run cannot resolve that without
    // calling captureEntry, which would make it a write rather than a preview
    //, this is the one place that gap between preview and production is
    // recorded.
    let written = 0;
    for (const row of results) {
      // D1 at the draw (src/insight/weekly.ts): a pair this disqualified is
      // never sent to the model in production, so the preview must not spend
      // a model call on it either, otherwise the dry run reports as
      // writable exactly what production refuses, which is the bug the
      // Rollout section's comparison exists to catch.
      const aTags = parseTags(row.a_tags as string);
      const bTags = parseTags(row.b_tags as string);
      if (!isEligiblePair({ tags: aTags }, { tags: bTags })) {
        candidates.push({
          a_id: row.a_id as string,
          b_id: row.b_id as string,
          score: row.score as number,
          outcome: "pair_rejected",
          shape: null,
          text: null,
          would_write: false,
          reason: "both memories are assistant-authored (D1)",
        });
        continue;
      }

      // cfg carries the user's LLM_MODEL choice, same as the real weekly pass
      // (src/insight/weekly.ts), without it this would preview reasoning from
      // the shipped default model rather than the one that will actually run.
      const result = await reasonOverPair(
        { content: row.a_content as string },
        { content: row.b_content as string },
        chatGptEnvForWorkspaces(env, [row.a_workspace_id as string, row.b_workspace_id as string]),
        cfg,
      );

      // would_write and `reason` are worked out in the same order
      // runWeeklyInsights actually applies its checks: the cap (a candidate
      // reached only after production's loop would already have broken),
      // then D2's novelty floor, then acceptance. A decline or a failed call
      // is definitive regardless of where it falls in that order.
      let would_write = false;
      let reason: string | null = null;
      if (result.outcome === "declined") {
        reason = "the model declined this pair";
      } else if (result.outcome === "failed") {
        reason = "the model call itself failed";
      } else if (result.outcome === "invalid") {
        reason = `validation failed: ${result.reason}`;
      } else if (written >= MAX_INSIGHTS_PER_RUN) {
        reason = `the weekly cap of ${MAX_INSIGHTS_PER_RUN} insights would already be reached`;
      } else if (restatesRecent(result.text, writtenThisRun)) {
        // Same rule src/insight/weekly.ts applies (D2): reasoned to a real
        // insight, but the text lands where a reader has already been.
        reason = "restates a recently written insight";
      } else {
        would_write = true;
        written++;
        writtenThisRun.push(result.text);
      }

      candidates.push({
        a_id: row.a_id as string,
        b_id: row.b_id as string,
        score: row.score as number,
        // 見送り・検証失敗・通信失敗を区別して報告し、候補状態は変更しない。
        // "declined" and "failed" are both reported, distinctly, rather than
        // collapsed to null: a human reading the shortlist can tell "the model
        // looked and said no" apart from "the call itself never answered",
        // which matters for judging whether the ranking or the model call is
        // the thing worth investigating.
        outcome: result.outcome,
        shape: result.outcome === "insight" ? result.shape : null,
        text: result.outcome === "insight" ? result.text : null,
        would_write,
        reason,
      });
    }

    return json({ ok: true, candidates });
  }

  return null;
}
