import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { GoldenQuery } from "../types";
import { longContextNeedles, mechanicalQueries } from "./author";
import { readJsonl, type CoreData, type EdgeRow, type LongHaystackRow } from "./build";
import type { NeedleRow } from "./types";

const MECHANICAL = /^q-(id|rare)-/;

/**
 * The committed core data plus part directories (needles.jsonl, queries.jsonl, edges.jsonl each, all optional).
 * Long-context needles are regenerated from long-anchors.ts and identifier/rare-word queries from the needle keys,
 * exactly as the committed data is produced.
 */
export function mergeData(base: CoreData, partDirs: readonly string[]): CoreData {
  const rd = <T>(dir: string, name: string): T[] => (existsSync(resolve(dir, name)) ? readJsonl<T>(resolve(dir, name)) : []);
  const needles: NeedleRow[] = [...base.needles];
  const edges: EdgeRow[] = [...base.edges];
  const haystack: LongHaystackRow[] = [...(base.haystack ?? [])];
  const others: GoldenQuery[] = base.queries.filter(q => !MECHANICAL.test(q.id));
  for (const dir of partDirs) {
    needles.push(...rd<NeedleRow>(dir, "needles.jsonl"));
    edges.push(...rd<EdgeRow>(dir, "edges.jsonl"));
    haystack.push(...rd<LongHaystackRow>(dir, "haystack.jsonl"));
    others.push(...rd<GoldenQuery>(dir, "queries.jsonl").filter(q => !MECHANICAL.test(q.id)));
  }
  const long = longContextNeedles();
  // only the generated n-long-* notes are regenerated; hand-authored long-context needles (other ids) are kept as data
  const merged = [...needles.filter(n => !n.id.startsWith("n-long-")), ...long];
  return { needles: merged, edges, queries: [...mechanicalQueries(merged), ...others], haystack };
}
