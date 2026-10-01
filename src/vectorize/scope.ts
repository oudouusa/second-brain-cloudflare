import type { Identity } from "../lib/identity";
import { readScopeWorkspaces } from "../lib/scope";

/** Build the best-effort Vectorize workspace filter for a caller. */

export interface VectorizeWorkspaceFilter {
  // Vectorize metadata filter shape (equality on a metadata field).
  filter: { workspace_id: { $in: string[] } };
}

export function workspaceFilter(
  identity: Identity,
  only?: "personal" | "company",
  teamId?: string,
): VectorizeWorkspaceFilter | undefined {
  return { filter: { workspace_id: { $in: readScopeWorkspaces(identity, { layer: only, teamId }) } } };
}

/** Single-workspace variant for write-path checks (dedupe within the target). */
export function singleWorkspaceFilter(workspaceId: string): VectorizeWorkspaceFilter {
  return { filter: { workspace_id: { $in: [workspaceId] } } };
}

type Queryable = {
  query(...args: unknown[]): Promise<{ matches?: unknown[] }>;
};

/** Query with filtering, falling back when the index rejects the filter. */
let workspaceFiltersSupported: boolean | null = null;

// Counts unfiltered queries for the health signal.
let degradedQueryCount = 0;

// Maintenance callers may discover degradation without having a request context
// in which to report it, so notification has its own latch.
let degradeNotified = false;

/** Current filter support state for this isolate. Read by GET /health. */
export function vectorizeFilterState(): { supported: boolean | null; degradedQueries: number } {
  return { supported: workspaceFiltersSupported, degradedQueries: degradedQueryCount };
}

/** Test-only: clears the latch and counter, mirroring resetDatabaseInit's role. */
export function resetVectorizeFilterState(): void {
  workspaceFiltersSupported = null;
  degradedQueryCount = 0;
  degradeNotified = false;
}

export async function queryVectorizeScoped<M = unknown>(
  vectorize: Queryable,
  values: number[],
  opts: {
    topK: number;
    filter: VectorizeWorkspaceFilter["filter"];
    onDegrade?: () => void;
    /**
     * Recall-only upgrade compatibility. A Vectorize index without a
     * workspace_id metadata index can accept the filter yet silently return no
     * vectors, rather than rejecting it. Probe unfiltered once in that state;
     * D1's mandatory workspace predicate remains the security boundary.
     */
    fallbackOnEmpty?: boolean;
  },
): Promise<{ matches: M[]; degraded: boolean }> {
  const queryUnfiltered = async (): Promise<M[]> => {
    const result = await vectorize.query(values, {
      topK: opts.topK,
      returnMetadata: "all",
      returnValues: true,
    });
    return (result?.matches ?? []) as M[];
  };
  const unfiltered = async (): Promise<{ matches: M[]; degraded: boolean }> => {
    const matches = await queryUnfiltered();
    degradedQueryCount++;
    return { matches, degraded: true };
  };

  // Report degradation to the first caller that can record it.
  const notifyOnce = (): void => {
    if (degradeNotified || !opts.onDegrade) return;
    degradeNotified = true;
    opts.onDegrade();
  };

  // Do not retry a known-unsupported filter.
  if (workspaceFiltersSupported === false) {
    notifyOnce();
    return unfiltered();
  }
  try {
    const result = await vectorize.query(values, {
      topK: opts.topK,
      returnMetadata: "all",
      returnValues: true,
      filter: opts.filter,
    });
    const filteredMatches = (result.matches ?? []) as M[];
    if (opts.fallbackOnEmpty && filteredMatches.length === 0) {
      try {
        const unfilteredMatches = await queryUnfiltered();
        const readableWorkspaces = new Set(opts.filter.workspace_id.$in);
        const filterSilentlyHidCandidate = unfilteredMatches.some(match => {
          const workspaceId = (match as { metadata?: { workspace_id?: unknown } })?.metadata?.workspace_id;
          // Missing metadata is the upgraded-brain shape: D1 rows were
          // backfilled into a workspace, but their existing vectors were not
          // rewritten. A readable stamped id being absent is equally strong
          // evidence that the filter answer cannot be trusted.
          return typeof workspaceId !== "string" || readableWorkspaces.has(workspaceId);
        });
        if (filterSilentlyHidCandidate) {
          workspaceFiltersSupported = false;
          notifyOnce();
          degradedQueryCount++;
          return { matches: unfilteredMatches, degraded: true };
        }
      } catch (e) {
        // The filtered query itself succeeded. A failed compatibility probe
        // must not turn a valid empty result into a recall outage.
        console.error("Vectorize empty-filter probe failed (keeping filtered results):", e);
      }
    }
    workspaceFiltersSupported = true;
    return { matches: filteredMatches, degraded: false };
  } catch (e) {
    if (!/filter/i.test(String(e))) throw e;
    console.error("Vectorize rejected the workspace filter (falling back to unfiltered queries for this isolate):", e);
    workspaceFiltersSupported = false;
    // Fire the durable-marker callback only once per isolate, so a deployment
    // pays for this discovery exactly once — but on the first caller that can
    // report it rather than the first that hits it.
    notifyOnce();
    return unfiltered();
  }
}
