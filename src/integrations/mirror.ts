import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import { chatGptEnvForWorkspaces } from "../lib/chatgpt";
import { resolveConfig, type Config } from "../config";
import {
  INTEGRATION_PROVIDERS,
  getProvider,
  loadIntegration,
  updateIntegration,
  acquireIntegrationOperation, releaseIntegrationOperation, IntegrationOperationLockedError, renewIntegrationOperation, withIntegrationOperation,
} from "../integrations";
import type { IntegrationProvider, MirrorStore } from "./framework";
import { narrowMirrorLayer } from "./framework";
import { initializeDatabase } from "../db/init";
import { forgetEntry } from "../capture/lifecycle";
import { AUDIT_BATCH_MAX, writeAuditEvents, type AuditEventInput } from "../lib/audit";
import { deleteStaleVectors, embedContextForRow, storeEntry, upsertEntryVectors, discardUpload } from "../capture/store";
import { classifyEntry } from "../capture/classify";
import { withKind } from "../memory/kind";
import { withStatus } from "../memory/status";
import { tagsAfterWrite } from "../memory/stale";
import { rememberTags } from "../tags/vocabulary";
import { OWNER_WRITE_CONTEXT, scopeWrite, type WriteContext } from "../lib/scope";
import { resolveIdentityByUserId } from "../lib/identity";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { MIRROR_VERSION_KEEP, WRITE_CAS_ATTEMPTS } from "../constants";
import { changesOf, mirrorPruneStatement, pruneStatement, snapshotStatement } from "../memory/versions";
import { scoreWrite } from "../quarantine/score";
import { heldTagsFor, holdDecision, holdStatements } from "../quarantine/hold";
import { isHeld } from "../quarantine/tags";
import { normalizeTagList } from "../tags/system";
import { deleteEntryVectors } from "../vectorize/batch";

export function makeMirrorStore(env: Env, writeCtx: WriteContext = OWNER_WRITE_CONTEXT, resolved?: Readonly<Config>, providerId?: string): MirrorStore & { flushAudit(): Promise<void> } {
  // The write context is a property of the store rather than of each method because
  // the MirrorStore interface (integrations/framework.ts) is shared with providers
  // that must not learn about tenancy. A sync batch is one actor's work, so one
  // context per store is the right granularity anyway.
  // One config read per store, not one per mirrored item. A store is built once
  // per sync batch, so this is still the per-request scope every other caller
  // resolves at (src/config.ts) — but the batch writes up to SYNC_EVENT_BATCH
  // items, and resolving inside the write paths made each of those cost its own
  // KV read on top of its D1, Workers AI and Vectorize calls (#290).
  //
  // Lazy rather than eager so makeMirrorStore stays synchronous for its callers
  // and a sync with nothing to write still costs nothing. Memoising the promise
  // rather than the value is what makes concurrent writes share one read;
  // resolveConfig degrades to the defaults instead of rejecting, so there is no
  // failure to latch.
  let pending: Promise<Readonly<Config>> | null = resolved ? Promise.resolve(resolved) : null;
  const config = () => (pending ??= resolveConfig(env));
  const beforeMutation = () => renewIntegrationOperation(env);

  // Deletion events wait here and go out in batches, not one INSERT per delete: a
  // calendar retention prune is unbounded and a sync has a D1 budget. The caller
  // flushes once the sync ends; a full buffer flushes itself.
  let auditBuffer: AuditEventInput[] = [];
  const flushAudit = async () => {
    const events = auditBuffer;
    auditBuffer = [];
    await writeAuditEvents(env, events);
  };

  return {
    flushAudit,
    async createEntry(content, tags, source) {
      await assertMemoryWritesAllowed(env);
      // Re-checks live state, not the record this store was built from (T-0089.7.5, "3.7 had the
      // same problem"): runScheduledIntegrationSync and the manual sync route both check
      // disconnecting only once, before their whole batch starts, so a disconnect purge that
      // begins mid-batch was free to finish — snapshot its itemMap, trash it — while this same
      // batch kept creating mirrors the purge had already stopped looking for. Checked per item,
      // right before the row would exist, narrows that window from the whole batch's duration to
      // the gap between this read and the disconnect route's own next KV write; it does not close
      // it (see the round 2 adversary test for the residual). Absent entirely — never connected,
      // or the disconnect already finished and deleted the record — is not this check's job: a
      // caller that never verified the connection exists is a bug elsewhere, and treating "gone"
      // the same as "disconnecting" here misclassified plenty of tests that build a bare store
      // with no KV record at all, on purpose, to test mechanics this check has nothing to do with.
      if (providerId) {
        const live = await loadIntegration(env, providerId);
        if (live?.disconnecting) throw new Error(`${providerId} is being disconnected`);
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      // Classify like a normal capture so mirror entries (email, calendar,
      // Notion) get a kind/importance and don't sit in the "not classified"
      // bucket. Non-fatal — a failure just leaves it for the backfill to pick up.
      // Codex review class B (T-0089.4.2): normalized at the door — a provider's own tags are
      // untrusted input, same reasoning as import and restore.
      let finalTags = normalizeTagList(tags);
      let importance = 0;
      // Used for both the classify and the embed below: they must agree on the
      // model, and this function once resolved config for the embed while
      // classifying with the shipped default.
      const cfg = await config();

      // Codex review, T-0102 C: scored BEFORE classify, not after -- classifyEntry is a model
      // call, and a held row's content must never reach a model prompt (the class E rule this
      // whole gate exists to enforce), classification included. Track 4 (16-t3-t4-trust-spec.md
      // 5.1, 5.4 W-d): mirror writes are scored strictest -- channel system:mirror, x1.25, no
      // meta-discussion damping -- because an email or a calendar invite sets its own `source`
      // and can never declare itself `direct`. Scored on the tags as sync offered them: classify
      // only ever adds kind:/status:canonical, neither of which a hold signal depends on, so
      // scoring first changes no verdict, only the order content reaches the model in.
      const change = { actorId: writeCtx.actorId, channel: "system:mirror" as const };
      const score = scoreWrite({ content, tags: finalTags, source, channel: "system:mirror", kind: "create" }, cfg);
      // Codex review class D (T-0089.4.2): a `partial` score holds too, reason too_long.
      const decision = holdDecision(score);

      // Classify like a normal capture so mirror entries (email, calendar, Notion) get a
      // kind/importance and don't sit in the "not classified" bucket. Non-fatal — a failure just
      // leaves it for the backfill to pick up. Skipped entirely when held: nothing classifies
      // content a model may not see, and the backfill picks it up once released, the same as any
      // other held row's classification.
      if (!decision.hold) {
        try {
          const c = await classifyEntry(content, chatGptEnvForWorkspaces(env, [writeCtx.workspaceId]), cfg);
          importance = c.importance;
          if (c.kind) finalTags = withKind(finalTags, c.kind);
          if (c.canonical) finalTags = withStatus(finalTags, "canonical");
        } catch (e) {
          console.error("Mirror classify failed (non-fatal):", e);
        }
      }

      // versioning: exempt: creation — a new row has no prior state to keep
      const insertStatement = env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, importance_score, workspace_id, actor_id, write_marker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, content, JSON.stringify(finalTags), source, now, now, "[]", importance, writeCtx.workspaceId, writeCtx.actorId, memoryWriteMarker(env));

      await beforeMutation();
      if (decision.hold) {
        // Same shape as a held capture (W1): the INSERT (with the tags the sync asked for)
        // and the hold's own version, guarded UPDATE and prune all land in one batch, so a
        // crash between them can never leave an unheld row. No storeEntry call: a held
        // create is never vectorized.
        const heldTags = heldTagsFor(finalTags, decision.reasons);
        await env.DB.batch([
          insertStatement,
          ...holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: cfg.VERSION_KEEP }, {
            entryId: id, reasons: decision.reasons, score: decision.score, signals: decision.signals, change, heldTags, now,
          }),
        ]);
        await rememberTags(env, finalTags, writeCtx.workspaceId);
        return id;
      }

      await insertStatement.run();
      // Promptness, not correctness (#288). Every tag inserted here is a compile-time
      // constant — a provider id from the registry in integrations/index.ts, plus
      // whatever kind:/status: the classifier added — so the vocabulary's age limit
      // would admit them on its own. This just means a freshly connected integration
      // shows up in the dashboard's tag filter today rather than tomorrow.
      //
      // Awaited because the scheduled sync has no ExecutionContext to defer to. Costs
      // one KV get per created entry; the put fires only on the first item of a newly
      // connected provider.
      await rememberTags(env, finalTags, writeCtx.workspaceId);
      try {
        await storeEntry(env, id, content, finalTags, source, now, cfg, writeCtx, { expectedContent: content, expectedTagsJson: JSON.stringify(finalTags), expectedSource: source, expectedCreatedAt: now, expectedVectorIdsJson: "[]", beforeMutation });
      } catch (e) {
        console.error("Vectorize insert failed (non-fatal):", e);
      }
      return id;
    },
    async updateEntry(id, content) {
      await assertMemoryWritesAllowed(env);
      const cfg = await config();
      for (let attempt = 0; attempt < WRITE_CAS_ATTEMPTS; attempt++) {
        const row = await env.DB.prepare(
          // scope-exempt: 接続のitem mapから解決した既存行のみ更新する。
          `SELECT content, tags, source, vector_ids, workspace_id, created_at FROM entries WHERE id = ?`
        ).bind(id).first<Record<string, any>>();
        if (!row) return "not_found";
        const tags = JSON.parse(row.tags ?? "[]") as string[];
        const refreshedTags = tagsAfterWrite(tags);
        const now = Date.now();
        const change = { actorId: writeCtx.actorId, channel: "system:mirror" as const };
        const decision = isHeld(tags) ? { hold: false as const } : holdDecision(scoreWrite({ content,
          tags: refreshedTags, source: row.source, channel: "system:mirror", kind: "update" }, cfg));
        const heldTags = decision.hold ? heldTagsFor(refreshedTags, decision.reasons) : null;
        const embedCtx = embedContextForRow(row, writeCtx);
        // 本文と新vector参照を同じCASで確定する。remote部分成功もoutboxが追跡する。
        await beforeMutation();
        const uploaded = heldTags || isHeld(tags) ? null : await upsertEntryVectors(env, id, content, refreshedTags, row.source, now, cfg, embedCtx,
          { batchEmbeds: true, beforeMutation });
        const vectorIds = uploaded?.vectorIds ?? [];
        const guard = (p: { add(v: unknown): string }) => `e.content = ${p.add(row.content)} AND e.tags = ${p.add(row.tags)} AND e.vector_ids = ${p.add(row.vector_ids)} AND e.workspace_id = ${p.add(row.workspace_id)} AND e.created_at = ${p.add(row.created_at)}`;
        let results;
        try {
          await beforeMutation();
          results = await env.DB.batch([
            snapshotStatement(env, { entryId: id, reason: "mirror", change, content: { kind: "next", content }, nextTags: refreshedTags,
              meta: { provider: providerId }, now, guard }),
            // versioning: snapshot
            env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, vector_ids = ?, pending_append_passages = '[]', updated_at = MAX(?, COALESCE(updated_at, created_at) + 1), write_marker = ?
              WHERE id = ? AND content = ? AND tags = ? AND vector_ids = ? AND workspace_id = ? AND created_at = ?`)
              .bind(content, JSON.stringify(refreshedTags), JSON.stringify(vectorIds), now, memoryWriteMarker(env), id, row.content, row.tags, row.vector_ids, row.workspace_id, row.created_at),
            pruneStatement(env, id, cfg.VERSION_KEEP),
            mirrorPruneStatement(env, id, Math.min(MIRROR_VERSION_KEEP, cfg.VERSION_KEEP)),
            ...(heldTags && decision.hold ? holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: cfg.VERSION_KEEP }, {
              entryId: id, reasons: decision.reasons, score: decision.score, signals: decision.signals, change, heldTags, now,
              guard: p => `content = ${p.add(content)} AND tags = ${p.add(JSON.stringify(refreshedTags))} AND workspace_id = ${p.add(row.workspace_id)}`,
            }) : []),
            env.DB.prepare(`INSERT INTO vector_cleanup_ops (op_id, entry_id, vector_ids, created_at, ready, expires_at, write_marker)
              VALUES (?, ?, ?, ?, 1, ?, ?)`)
              .bind(crypto.randomUUID(), id, row.vector_ids, now, now, memoryWriteMarker(env)),
          ]);
        } catch (error) { await discardUpload(env, id, vectorIds); throw error; }
        if (changesOf(results[1]) === 0) { await discardUpload(env, id, vectorIds); continue; }
        try {
          await beforeMutation();
          await deleteEntryVectors(env, [{ entryId: id, vectorIds: JSON.parse(row.vector_ids) }]);
        } catch (error) { console.error("Mirror cleanup deferred:", error); }
        return "updated";
      }
      return "busy";
    },
    async deleteEntry(id) {
      await beforeMutation();
      // scope-exempt: 認証済接続のitem mapが指定したrowの現在workspaceを削除CASへ渡す。
      const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id).first<{ workspace_id: string }>();
      if (!row) return;
      const r = await forgetEntry(id, env, { actorId: writeCtx.actorId, channel: "system:mirror" }, { reason: "mirror", config: await config(), purge: false, beforeMutation }, row.workspace_id);
      if (r.status !== "deleted") return;
      auditBuffer.push({
        entryId: id,
        actorId: writeCtx.actorId,
        event: "deleted",
        payload: { reason: "mirror", provider: providerId ?? null, deletedVectors: r.vectorCount, trash: r.trashed, channel: "system:mirror" },
      });
      if (auditBuffer.length >= AUDIT_BATCH_MAX) await flushAudit();
    },
  };
}

export async function isManagedMirror(source: string, env: Env): Promise<boolean> {
  return getProvider(source) !== null && (await loadIntegration(env, source)) !== null;
}

export function mirrorEditError(source: string): string {
  const name = getProvider(source)?.name ?? source;
  return `This memory is synced from ${name}. Edit it in ${name} (the change syncs automatically), or disconnect the ${name} integration to make it editable.`;
}

/** Undo's own refusal text (T-0089.6.6): a revert would only be overwritten by the next sync. */
export function mirrorUndoError(source: string): string {
  const name = getProvider(source)?.name ?? source;
  return `This memory is synced from ${name}. Change it in ${name}; the change syncs back.`;
}

/** Restoring a mirror row from the trash works, but the integration still thinks it is gone. */
export function mirrorRestoreWarning(id: string, source: string): string {
  const name = getProvider(source)?.name ?? source;
  return `Restored entry ${id}. ${name} still has it archived, so the next sync will remove it again. Restore the page in ${name} to keep it.`;
}

/**
 * The schedule this job owns, and the reason it has one.
 *
 * Every Worker invocation gets only 10 ms of CPU on the free plan, and this
 * codebase holds itself to a self-imposed D1 budget of ~50 calls per
 * invocation for cost discipline (the platform's real ceiling is 1,000
 * D1/KV/Vectorize calls and 50 external fetch()es per invocation). The
 * nightly maintenance pass already spends 30 of that self-imposed budget,
 * which left a mirror sync sharing that invocation with room for nothing
 * useful: five batches cost 100 D1 queries on their own, and even one batch
 * put the shared invocation exactly at that self-imposed budget — over it as
 * soon as the batch was updates rather than creates, or a second provider was
 * connected (#290).
 *
 * So the sync runs on its own trigger with its own allowance. Must match the
 * second entry in wrangler.jsonc's `triggers.crons` exactly — scheduled() in
 * src/index.ts routes on it, and a mismatch would silently send this job's work
 * to the nightly invocation, which is the problem it exists to avoid.
 * test/unit/cron-triggers.test.ts fails if the two drift apart.
 */
export const INTEGRATION_SYNC_CRON = "30 * * * *";

/**
 * Batches per run.
 *
 * One. The caller has always been the thing that loops: every sync returns
 * `remaining`, and the dashboard's "Sync now" drains a backlog on demand. The
 * cron only has to make progress, and one batch an hour does, on a cursor the
 * next run resumes from. Raising this spends a budget that is now sized for one
 * batch — and it would spend the CPU cap too, since each batch re-fetches and
 * re-expands the whole feed.
 */
const CRON_SYNC_MAX_BATCHES = 1;

/**
 * Sync ONE provider per run, least-recently-attempted first.
 *
 * Syncing every connected provider in a single invocation multiplies the cost by
 * however many the user has connected — two calendars measured 70 D1 queries
 * against this codebase's self-imposed budget of 50 — and no per-provider batch
 * size can fix that, because the
 * multiplier is the provider count. Rotating keeps the cost of a run flat in the
 * number of connections; the hourly schedule is what keeps each one fresh.
 *
 * The rotation key is `updatedAt`, not `lastSyncedAt`. Providers write
 * `updatedAt` on every sync ATTEMPT but `lastSyncedAt` only on success, so
 * ordering by the latter would park the rotation on a provider whose token has
 * expired — it would be picked every hour, forever, and starve the ones that
 * still work.
 *
 * Advancing that key is this function's job, not the provider's — see
 * advanceRotationCursor. Under rotation a provider that never advances is not a
 * slow provider, it is a stuck queue.
 */
export async function runScheduledIntegrationSync(env: Env, resolved?: Readonly<Config>): Promise<void> {
  let due: IntegrationProvider | null = null;
  let dueSince = Infinity;
  for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
    const record = await loadIntegration(env, provider.id);
    if (!record || record.disconnecting) continue;
    // Strict <, so registry order breaks ties deterministically — which is what
    // orders the first run after two providers are connected together.
    const touchedAt = record.updatedAt ?? 0;
    if (touchedAt < dueSince) {
      due = provider;
      dueSince = touchedAt;
    }
  }
  if (!due) return;

  await initializeDatabase(env);
  let operation;
  try {
    operation = await acquireIntegrationOperation(env, due.id, "sync");
  } catch (error) {
    if (error instanceof IntegrationOperationLockedError) return;
    throw error;
  }
  const operationEnv = withIntegrationOperation(env, operation);
  try {
    const record = await loadIntegration(operationEnv, due.id);
    // 保存先未指定の旧接続は従来のlegacy workspaceを維持する。
    // layer/connectで明示された接続だけ、所有者の現行保存先を解決する。
    const writeCtx = record?.config?.mirrorWorkspace === undefined
      ? OWNER_WRITE_CONTEXT : await mirrorWriteContext(operationEnv, record);
    const store = makeMirrorStore(operationEnv, writeCtx, resolved, due.id);
    try {
    for (let i = 0; i < CRON_SYNC_MAX_BATCHES; i++) {
      const result = await due.sync(operationEnv, store);
      if (!result.ok || result.remaining === 0) break;
    }
    } finally { await store.flushAudit(); }
  } finally {
    try {
      await advanceRotationCursor(operationEnv, due.id);
    } finally {
      await releaseIntegrationOperation(env, operation);
    }
  }
}

/**
 * Where a mirrored item lands, for BOTH sync paths.
 *
 * An integration is one connection for the whole deployment
 * (`integrations:<provider>` in KV), so the memories it mirrors have to have one
 * home. This used to be decided in two places that disagreed: the cron resolved
 * the owner and wrote to the owner's workspace, while POST
 * /integrations/:provider/sync built a context from whoever called it. The same
 * connection therefore mirrored into different people's private workspaces
 * depending on who last pressed "Sync now" — and a member's manual sync put the
 * org's Notion pages somewhere the admin could not see them.
 *
 * One function, called by both, resolving the owner either way. Falls back to
 * OWNER_WRITE_CONTEXT's pre-team sentinel if identity cannot be resolved, which
 * is the behaviour a v2 brain had.
 */
export async function mirrorWriteContext(
  env: Env,
  record: { config?: { mirrorWorkspace?: string } } | null,
): Promise<WriteContext> {
  const mirrorWorkspace = narrowMirrorLayer(record?.config?.mirrorWorkspace);
  try {
    const roots = await ensureTenantBootstrap(env);
    const owner = await resolveIdentityByUserId(env, roots.ownerUserId);
    if (owner) return { workspaceId: scopeWrite(owner, mirrorWorkspace), actorId: owner.userId };
  } catch (e) {
    console.error("Integration identity resolve failed (non-fatal):", e);
  }
  return OWNER_WRITE_CONTEXT;
}

/**
 * Move the rotation past the provider that just had its turn, whatever happened
 * during it.
 *
 * Providers persist `updatedAt` themselves on success and on the errors their own
 * handlers catch, but a throw that escapes those handlers persists nothing.
 * `job()` in src/index.ts swallows it, the record keeps its old `updatedAt`, and
 * the selection above picks the same provider again — every hour, forever, while
 * every other connection waits. Its item map did not persist either, so each of
 * those runs re-mirrors the same batch under fresh ids: new memories and new D1
 * writes every hour for work already done. The old shape visited every provider
 * per run, so a throw cost the providers after it in registry order one turn;
 * under rotation it costs all of them every turn, which is why this is the
 * caller's responsibility now rather than a detail each provider gets right.
 *
 * Best effort by design. If this write is the thing failing there is nothing
 * further to try, and it must not replace the sync error that brought us here —
 * hence the catch, in a `finally` block.
 *
 * One case it deliberately cannot fix: a KV outage broad enough to fail this put
 * would have failed the provider's own save too. The cursor lives in KV, so
 * nothing in-process can advance it. What this does cover is the far likelier
 * shape — a provider throwing past its handlers while KV is perfectly healthy.
 */
async function advanceRotationCursor(env: Env, providerId: string): Promise<void> {
  try {
    // null when disconnected mid-run — nothing to advance.
    await updateIntegration(env, providerId, (r) => { r.updatedAt = Date.now(); });
  } catch (e) {
    console.error(`Integration rotation cursor did not advance for ${providerId} (non-fatal):`, e);
  }
}
