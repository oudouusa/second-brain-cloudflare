import { runNightlyCleanup } from "../memory/cleanup";
import { runNightlyVectorizePending } from "../vectorize/pending";
import { runWhenExtractPass } from "../when/pass";
import { pushDueItemsAllWorkspaces, newPushBudget } from "../push/send";
import type { Env } from "../env";
import { beginMemoryWriteAdmission, MemoryWriteLockedError } from "../migration/write-lock";
import { initializeDatabase } from "../db/init";
import { withFtsWriteGuard } from "../db/fts-write-guard";
import { runFtsMaintenance } from "../db/fts-backfill";
import { drainPendingVectorCleanup, SCHEDULED_VECTOR_CLEANUP_MAX_PAGES } from "../vectorize/cleanup";
import { runScheduledAiRecovery } from "../capture/pending";
import { durationMs, errorName, logEvent, logErrorEvent } from "../lib/observability";
import { runNightlyCompression } from "../compression/nightly";
import { runGraphPass } from "../graph/pass";
import { INTEGRATION_SYNC_CRON, runScheduledIntegrationSync } from "../integrations/mirror";
import { runStalenessPass } from "../staleness/pass";
import { nextWorkspace } from "../runtime/rotation";
import { recordNightSummary } from "../runtime/night-summary";
import {
  ADMISSION_RELEASE_SQL_RESERVE,
  createNightlyD1Budget,
  reserveD1Sql,
  resolveNightlyD1SqlLimit,
  d1WorkWasDeferred,
  remainingD1Sql,
  recordD1BaseEnv,
} from "../runtime/d1-budget";
import { runInsightAccrual } from "../insight/candidates";
import { companyWorkspaceIds, runWeeklyInsights } from "../insight/weekly";
import { INSIGHT_ACCRUAL_CRON, INSIGHT_WEEKLY_CRON, INSIGHT_TEAM_WEEKLY_CRON } from "../insight/schedule";
import { resolveConfig } from "../config";

export const NIGHTLY_MAINTENANCE_CRON = "0 1 * * *";

/** 上流の5 cronと夜間allSettled処理を共有する実行本体。実行先の振分けは行わない。 */
export async function runScheduledJobs(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  // The jobs are independent, and each begins by awaiting the shared schema init. One
  // of them failing — including on that init — must not take the others down or surface
  // as an unhandled rejection inside waitUntil.
  // `Promise<unknown>` rather than `Promise<void>`: runInsightAccrual returns
  // a summary (seeds examined) for POST /insights/accrue to report, and this
  // scheduled path fires the same promise but never reads that value.
  const job = (name: string, run: (jobEnv: Env, jobCtx: ExecutionContext) => Promise<unknown>) => ctx.waitUntil((async () => {
    const startedAt = performance.now();
    let finishAdmission: (() => Promise<void>) | undefined;
    const budget = ["nightly_maintenance", "integration_schedule"].includes(name)
      ? createNightlyD1Budget(env, resolveNightlyD1SqlLimit(env), withFtsWriteGuard)
      : null;
    const executionEnv = budget?.env ?? withFtsWriteGuard(recordD1BaseEnv(env));
    const finalization = budget ? reserveD1Sql(executionEnv, ADMISSION_RELEASE_SQL_RESERVE)! : null;
    try {
      const initialized = await initializeDatabase(executionEnv);
      // Schema statements and job statements share this invocation's selected
      // ceiling. Converge the schema on this tick and run the job on the next;
      // every job is periodic and idempotent, while crossing either the default
      // Free ceiling or the explicitly selected Paid ceiling would abort work
      // unpredictably.
      if (initialized.changed) {
        logEvent("scheduled_job", {
          operation: name,
          outcome: "success",
          duration_ms: durationMs(startedAt),
          schema_initialized: true,
        });
        return;
      }
      const tracked = await beginMemoryWriteAdmission(executionEnv, ctx, { releaseEnv: finalization?.env });
      finishAdmission = tracked.finish;
      const result = await run(tracked.env, tracked.ctx);
      const partial = d1WorkWasDeferred(tracked.env)
        || (result != null && typeof result === "object" && "complete" in result && result.complete === false);
      logEvent("scheduled_job", { operation: name, outcome: partial ? "partial" : "success", duration_ms: durationMs(startedAt) });
    } catch (error) {
      if (error instanceof MemoryWriteLockedError) {
        logEvent("scheduled_job", {
          operation: name,
          outcome: "blocked",
          duration_ms: durationMs(startedAt),
        });
        return;
      }
      logErrorEvent("scheduled_job", {
        operation: name,
        outcome: "error",
        duration_ms: durationMs(startedAt),
        error_name: errorName(error),
      });
    } finally {
      try {
        await finishAdmission?.();
      } catch {
        logErrorEvent("scheduled_job", {
          operation: name,
          outcome: "error",
          duration_ms: durationMs(startedAt),
          error_name: "Error",
        });
      }
      if (budget) logEvent("nightly_budget", budget.stats());
    }
  })());

  // Two schedules, two budgets (#290). A Worker invocation gets 50 D1 queries and 10 ms
  // of CPU on the free plan; the maintenance jobs below already spend 30 of those
  // queries before the shared maintenance-barrier read, so the mirror sync gets its own
  // invocation rather than the remainder of
  // this one. Routing on the cron string is what makes that real — without the branch
  // both triggers would run everything and the split would cost budget instead of
  // buying it.
  if (event.cron === INTEGRATION_SYNC_CRON) {
    job("integration_schedule", async jobEnv => {
      const cfg = await resolveConfig(jobEnv);
      let recoveryHandled = false;
      try {
        const recovery = await runScheduledAiRecovery(jobEnv, event.scheduledTime);
        if (recovery.handled) {
          recoveryHandled = true;
          logEvent("ai_recovery", {
            operation: recovery.action,
            outcome: recovery.quotaRetryAt ? "blocked" : recovery.failed ? "partial" : "success",
            processed: recovery.processed,
            failed: recovery.failed,
            remaining: recovery.remaining,
            quota_retry_at: recovery.quotaRetryAt ?? null,
          });
          return;
        }
        await runScheduledIntegrationSync(jobEnv, cfg);
      } finally {
        try { if (!recoveryHandled) await pushDueItemsAllWorkspaces(jobEnv, cfg, newPushBudget(10)); }
        catch { logErrorEvent("scheduled_job", { operation: "push_due", outcome: "error", error_name: "Error" }); }
      }
    });
    return;
  }

  // Both dedicated insight schedules get their own invocation and therefore their own
  // D1 and CPU budget. They must be routed explicitly: the fallthrough below
  // is maintenance, so without these each new trigger would run compression,
  // the graph pass and staleness a second and third time every day.
  //
  // Accrual and the PERSONAL weekly pass stay whole-corpus: they are already
  // budget-managed on their own invocations (#290), and cross-workspace
  // candidate pairs were handled in P1a, so a maintenance-style rotation
  // slice would only stretch coverage over K nights without buying headroom.
  //
  // The Team pass has its own explicitly routed invocation below.
  if (event.cron === INSIGHT_ACCRUAL_CRON) {
    job("insight_accrual", (jobEnv, jobCtx) => runInsightAccrual(jobEnv, jobCtx));
    return;
  }
  if (event.cron === INSIGHT_WEEKLY_CRON) {
    job("weekly_insights", (jobEnv, jobCtx) => runWeeklyInsights(jobEnv, jobCtx));
    return;
  }

  // The upstream dedicated team trigger fits the five-trigger profile now
  // that maintenance is a single invocation. Keep default-off before admission.
  if (event.cron === INSIGHT_TEAM_WEEKLY_CRON) {
    const cfg = await resolveConfig(env);
    if (cfg.TEAM_INSIGHTS !== "on") return;
    job("team_weekly_insights", async (jobEnv, jobCtx) => {
      const ids = await companyWorkspaceIds(jobEnv);
      if (!ids.length) return;
      await runWeeklyInsights(jobEnv, jobCtx, { onlyWorkspaceIds: ids });
    });
    return;
  }

  // Anything else runs maintenance: the nightly cron, and any invocation whose cron we
  // do not recognise (a hand-fired trigger, or a schedule added to wrangler.jsonc and
  // not yet routed here). Maintenance is the safe default — skipping it degrades recall
  // quality silently, whereas a skipped mirror sync is picked up on the next hour.
  job("nightly_maintenance", async (jobEnv, jobCtx) => {
    const slice = await nextWorkspace(jobEnv);
    // 3種類の保守を先頭で巡回し、常に忙しいbrainでも履歴削除・索引修復を飢餓にしない。
    const phase = Math.floor((event.scheduledTime || Date.now()) / 86_400_000) % 3;
    const runV4Maintenance = async (kind: "cleanup" | "index") => {
      const allowance = Math.min(40, remainingD1Sql(jobEnv));
      if (allowance < 8) return;
      const reserved = reserveD1Sql(jobEnv, allowance);
      if (!reserved) return;
      try {
        if (kind === "cleanup") await runNightlyCleanup(reserved.env, jobCtx);
        else await runNightlyVectorizePending(reserved.env, () => resolveConfig(reserved.env), { maxRows: 1 });
      } catch { console.error("履歴・索引保守を次回へ繰り越します"); }
      finally { reserved.release(); }
    };
    if (phase === 1) await runV4Maintenance("cleanup");
    if (phase === 2) await runV4Maintenance("index");
    // Give existing deletion debt one bounded opportunity before new captures.
    // A busy corpus must not permanently starve cleanup. Its own reservation
    // includes authorization, receipt persistence and retirement, not just SELECT.
    let cleanupComplete = true;
    const cleanup = async (maxPages: number, sqlBudget: number) => {
      try { await drainPendingVectorCleanup(jobEnv, { maxPages, sqlBudget }); }
      catch { cleanupComplete = false; console.error("Nightly cleanup deferred (non-fatal)"); }
    };
    await cleanup(1, 8);
    // Await the passes' dynamically registered background writes before summary
    // and finalization. They still use the same admission and invocation budget.
    const background: Promise<unknown>[] = [];
    const maintenanceCtx = Object.create(jobCtx) as ExecutionContext;
    maintenanceCtx.waitUntil = (task: Promise<unknown>) => {
      background.push(task);
      jobCtx.waitUntil(task);
    };
    // 期限抽出2件と解放予約を確保するため、古さの再判定は夜間2件ずつ進める。
    const [compression, graph, staleness] = await Promise.allSettled([
      runNightlyCompression(jobEnv, maintenanceCtx, slice, 1),
      runGraphPass(jobEnv, maintenanceCtx, slice, 4),
      runStalenessPass(jobEnv, maintenanceCtx, slice, 2),
    ]);
    while (background.length) await Promise.allSettled(background.splice(0));
    if (compression.status === "rejected") console.error("Nightly compression failed (non-fatal)");
    if (graph.status === "rejected") console.error("Graph pass failed (non-fatal)");
    if (staleness.status === "rejected") console.error("Staleness pass failed (non-fatal)");
    let whenResult = { whenExtracted: 0, whenJudged: 0, whenSkipped: 0, ok: false };
    try { whenResult = await runWhenExtractPass(jobEnv, maintenanceCtx, slice, 2); }
    catch { console.error("期限抽出を次回へ繰り越します"); }
    // FTS is derived data. The admission above excludes restore and migration
    // locks. Use only spare SQL after the existing passes; an exhausted child
    // reservation fails before a batch and leaves its KV cursor for next night.
    if (phase !== 1) await runV4Maintenance("cleanup");
    if (phase !== 2) await runV4Maintenance("index");
    const ftsAllowance = remainingD1Sql(jobEnv);
    if (ftsAllowance >= 8) {
      const reserved = reserveD1Sql(jobEnv, Math.min(18, ftsAllowance));
      if (reserved) {
        try { await runFtsMaintenance(reserved.env); }
        catch (error) { console.error("FTS maintenance deferred (non-fatal):", error); }
        finally { reserved.release(); }
      }
    } else {
      logEvent("scheduled_job", { operation: "fts_maintenance", outcome: "partial", remaining_sql: ftsAllowance });
    }
    // Use remaining work budget, never the admission-release reservation.
    await cleanup(SCHEDULED_VECTOR_CLEANUP_MAX_PAGES, resolveNightlyD1SqlLimit(jobEnv));
    // Unknown is not a successful zero. Keep the last complete upstream record
    // (with its original ranAt) on failure, rather than publishing a partial run.
    // Empty string is a real legacy workspace; only null/undefined lack a slice.
    if (slice == null || !whenResult.ok || !cleanupComplete || d1WorkWasDeferred(jobEnv) || compression.status !== "fulfilled"
      || graph.status !== "fulfilled" || staleness.status !== "fulfilled") return { complete: false };
    if (compression.value.complete === false || graph.value.complete === false
      || staleness.value.complete === false) return { complete: false };
    await recordNightSummary(jobEnv, slice, {
      digestsWritten: compression.value.digestsWritten,
      linksInferred: graph.value.inserted,
      claimsFlagged: staleness.value.flagged,
      insightsProposed: 0,
      whenExtracted: whenResult.whenExtracted, whenJudged: whenResult.whenJudged, whenSkipped: whenResult.whenSkipped,
    });
  });
}
