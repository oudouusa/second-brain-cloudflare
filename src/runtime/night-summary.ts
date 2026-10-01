import type { Env } from "../env";

/**
 * What the nightly maintenance passes did, written once per workspace per
 * night by src/index.ts's scheduled() handler and read back by GET
 * /stats/night. Never derived from D1 at read time, see the comment on that
 * route for why (edges has no index to make "since last night" cheap).
 */
export interface NightSummary {
  ranAt: number;
  linksInferred: number;
  insightsProposed: number;
  digestsWritten: number;
  claimsFlagged: number;
  /** How many candidates the when-extraction pass (src/when/pass.ts) judged. */
  whenJudged: number;
  /** Of those, how many were persisted as commitments. */
  whenExtracted: number;
  /** How many permanently-failing entries the pass quarantined this run. */
  whenSkipped: number;
}

export function nightSummaryKey(workspaceId: string): string {
  return `night:${workspaceId}`;
}

const COUNT_FIELDS = ["linksInferred", "insightsProposed", "digestsWritten", "claimsFlagged", "whenJudged", "whenExtracted", "whenSkipped"] as const;
function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Writes the whole record in one KV put, never partially. Callers pass every
 * count they have in hand at once, there is no append/patch form, so a pass
 * that threw before this runs simply leaves last night's record in place
 * rather than corrupting it with a half-built one.
 *
 * Never throws: a failed put is logged and swallowed, matching every other
 * nightly-pass error path (src/graph/pass.ts, src/staleness/pass.ts,
 * src/compression/nightly.ts all log and continue on their own failures).
 */
export async function recordNightSummary(
  env: Env,
  workspaceId: string,
  counts: Omit<NightSummary, "ranAt">,
): Promise<void> {
  if (!COUNT_FIELDS.every(field => validCounter(counts[field]))) return;
  const record: NightSummary = { ranAt: Date.now(), ...counts };
  try {
    await env.OAUTH_KV.put(nightSummaryKey(workspaceId), JSON.stringify(record));
  } catch {
    console.error("Night summary write failed (non-fatal)");
  }
}

/** Reads one workspace's record, or null if none was ever written (or the read failed). */
export async function readNightSummary(env: Env, workspaceId: string): Promise<NightSummary | null> {
  try {
    const raw = await env.OAUTH_KV.get(nightSummaryKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NightSummary>;
    if (!parsed || !validCounter(parsed.ranAt)
      || !COUNT_FIELDS.every(field => validCounter(parsed[field] ?? (field.startsWith("when") ? 0 : undefined)))) return null;
    return {
      ranAt: parsed.ranAt,
      linksInferred: parsed.linksInferred ?? 0,
      insightsProposed: parsed.insightsProposed ?? 0,
      digestsWritten: parsed.digestsWritten ?? 0,
      claimsFlagged: parsed.claimsFlagged ?? 0,
      // Absent on a record written before this pass existed — reads as 0,
      // same as every other count here.
      whenJudged: parsed.whenJudged ?? 0,
      whenExtracted: parsed.whenExtracted ?? 0,
      whenSkipped: parsed.whenSkipped ?? 0,
    };
  } catch {
    console.error("Night summary read failed (non-fatal)");
    return null;
  }
}
