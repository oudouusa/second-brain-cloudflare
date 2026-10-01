import type { Env } from "../env";
import { resolveConfig } from "../config";
import { initializeDatabase } from "../db/init";
import { COMPRESSION_MIN_AGE_MS, compressionEligibilitySql, isCompressionTagSql } from "./eligibility";
import { compressTag, HELD_DIGESTS_READ_LIMIT, heldSetFrom, prepareHeldDigests } from "./digest";
import { prepareActiveProjects, projectRowsOf, type ProjectRow } from "../projects/registry";
import { PROJECT_TAG_PREFIX } from "../tags/system";

/**
 * How many tags one nightly run may compress.
 *
 * This bound is what keeps the cron inside a free-plan invocation, and it is protecting
 * two independent ceilings, not one — raising it needs both re-measured:
 *
 *   - D1 subrequests. All four nightly jobs share a single scheduled() invocation and
 *     therefore one budget. Each compressed tag costs about six.
 *   - CPU. Cron Triggers get 10 ms on the free plan, and the work per tag is linear:
 *     measured 1.6 ms at 7 tags, 9.6 ms at 30, 20.2 ms at 60.
 *
 * Nothing bounded this before: every tag with more than ten eligible entries was
 * compressed on every run, so both costs grew with how many distinct tags a user had.
 */
export const COMPRESSION_MAX_TAGS_PER_RUN = 2;

/** Where the rotation resumes from. Operational state, so KV rather than a tags value. */
const TAG_CURSOR_KEY = "compression:tag-cursor";

/**
 * Pick this run's tags, resuming after the last one processed.
 *
 * Deferring rather than truncating is the whole point: a plain `LIMIT` would compress the
 * same head of the list every night and never reach the tail. The cursor stores a tag NAME
 * rather than an index because the candidate list is re-derived each run and its ordering
 * shifts as entries are rolled up — an index would silently skip whatever moved.
 * An unknown or missing cursor starts from the top, which is also the first-run path.
 */
async function selectTagsForRun(env: Env, tags: string[], maxTags: number): Promise<string[]> {
  if (tags.length <= maxTags) return tags;

  let start = 0;
  try {
    const last = await env.OAUTH_KV.get(TAG_CURSOR_KEY);
    const at = last ? tags.indexOf(last) : -1;
    if (at >= 0) start = (at + 1) % tags.length;
  } catch (e) {
    console.error("Compression tag cursor read failed; starting from the top (non-fatal):", e);
  }

  const picked = Array.from(
    { length: Math.min(maxTags, tags.length) },
    (_, i) => tags[(start + i) % tags.length],
  );

  try {
    await env.OAUTH_KV.put(TAG_CURSOR_KEY, picked[picked.length - 1]);
  } catch (e) {
    // A lost cursor repeats this run's tags next time rather than losing any, so it is
    // safe to continue — the 24h guard in compressTag makes the repeat a cheap no-op.
    console.error("Compression tag cursor write failed (non-fatal):", e);
  }
  return picked;
}

/**
 * `workspaceId` narrows this run to one workspace's slice of the ring (v3 Team Edition,
 * see src/runtime/rotation.ts). Undefined/null — every direct and manual caller, plus a
 * scheduled run whose rotation read failed — keeps the pre-v3 whole-corpus scan, whose
 * SQL must stay byte-for-byte identical.
 */
export async function runNightlyCompression(
  env: Env,
  ctx: ExecutionContext,
  workspaceId?: string | null,
  maxTags = COMPRESSION_MAX_TAGS_PER_RUN,
): Promise<{ digestsWritten: number; complete?: false }> {
  if (!Number.isInteger(maxTags) || maxTags < 1 || maxTags > COMPRESSION_MAX_TAGS_PER_RUN) {
    throw new RangeError("Invalid compression tag limit");
  }
  const cfg = await resolveConfig(env);
  await initializeDatabase(env);

  // The slice clause goes last in the WHERE so its placeholder binds after the
  // eligibility cutoff.
  const sliceSql = workspaceId != null ? `\n      AND entries.workspace_id = ?` : "";
  // scope-exempt: cron: nightly compression, narrowed by the workspace slice in sliceSql
  const candidateQuery = env.DB.prepare(`
    SELECT value as tag, COUNT(*) as count
    FROM entries, json_each(entries.tags)
    WHERE ${isCompressionTagSql()}
      AND entries.tags NOT LIKE '%"rolled-up"%'
      AND entries.tags NOT LIKE '%"synthesized"%'
      AND entries.tags NOT LIKE '%"auto-pattern"%'
      AND entries.tags NOT LIKE '%"auto-insight"%'
      AND ${compressionEligibilitySql("entries.", cfg)}${sliceSql}
    GROUP BY value
    HAVING count > 10
    ORDER BY count DESC
  `).bind(...(workspaceId != null
    ? [Date.now() - cfg.COMPRESSION_MIN_AGE_MS, workspaceId]
    : [Date.now() - cfg.COMPRESSION_MIN_AGE_MS]));

  // Registry-driven project digests join the topic candidates, keyed `project:<slug>`, and
  // share the one bound and cursor: the key space just gains project members. The registry
  // read is batched with the candidate query. D1 counts both SQL statements against
  // the cron's shared budget. Members are decided by compressTag (the tag or any alias, and
  // the usual >= 10 eligible entries), so a thin project costs one rotation slot and two
  // statements, never a wrong digest.
  //
  // The same batch also carries the held-draft read: which (workspace, tag) pairs already have a live
  // held digest, so the loop below skips them without a statement per tag. It rides in the batch, so
  // it costs no extra subrequest. If the batch fails it is left undefined and compressTag asks per tag.
  const projectsBySlug = new Map<string, ProjectRow[]>();
  let results: Record<string, unknown>[];
  let heldDigests: Set<string> | undefined;
  try {
    const [candidates, projects, held] = await env.DB.batch<Record<string, unknown>>([
      candidateQuery,
      prepareActiveProjects(env.DB, workspaceId ?? null),
      prepareHeldDigests(env, workspaceId ?? null),
    ]);
    // A full read may have been cut off, and a tag beyond the cut would look "not held": treat it as
    // unknown so compressTag falls back to its exact per-tag check.
    heldDigests = (held?.results?.length ?? 0) >= HELD_DIGESTS_READ_LIMIT ? undefined : heldSetFrom(held?.results);
    results = candidates.results ?? [];
    for (const row of projectRowsOf(projects.results)) {
      projectsBySlug.set(row.id, [...(projectsBySlug.get(row.id) ?? []), row]);
    }
  } catch (e) {
    // The topic digests must not depend on the registry being readable: retry the
    // candidate query alone rather than lose the night.
    console.error("Nightly candidate batch failed; running topic digests only (non-fatal):", e);
    projectsBySlug.clear();
    results = (await candidateQuery.all<Record<string, unknown>>()).results ?? [];
  }
  const projectKeys = [...projectsBySlug.keys()].sort().map(slug => `${PROJECT_TAG_PREFIX}${slug}`);

  const tags = await selectTagsForRun(env, [...results.map(r => r.tag as string), ...projectKeys], maxTags);



  let digestsWritten = 0;
  let complete = true;
  for (const tag of tags) {
    try {
      const rows = tag.startsWith(PROJECT_TAG_PREFIX) ? projectsBySlug.get(tag.slice(PROJECT_TAG_PREFIX.length)) : undefined;
      const result = await compressTag(tag, env, ctx, rows
        ? { workspaceIds: [...new Set(rows.map(r => r.workspace_id))], project: rows, heldDigests }
        : { heldDigests, ...(workspaceId == null ? {} : { workspaceIds: [workspaceId] }) });
      if (result.synthesizedId) digestsWritten++;
      if (result.complete === false) complete = false;
    } catch (e) {
      complete = false;
      console.error(`Compression failed for tag "${tag}" (non-fatal):`, e);
    }
  }

  return complete ? { digestsWritten } : { digestsWritten, complete: false };
}
