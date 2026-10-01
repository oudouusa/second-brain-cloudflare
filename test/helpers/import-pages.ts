import { importExportPayload, type ImportOptions, type ImportSummary } from "../../src/entries/import";

/** fixtureを実際のcursorで全ページ処理する。単一ページの費用試験には使わない。 */
export async function importAllPages(
  env: Parameters<typeof importExportPayload>[0], payload: Parameters<typeof importExportPayload>[1],
  options: ImportOptions = {},
): Promise<ImportSummary> {
  let page = { ...options };
  let total: ImportSummary | undefined;
  const counters = ["imported", "skipped", "skipped_in_trash", "skipped_too_large", "failed",
    "edges_imported", "edges_skipped", "edges_failed", "projects_imported", "projects_skipped", "projects_failed"] as const;
  for (let n = 0; n < 10_000; n++) {
    const result = await importExportPayload(env, payload, page);
    if (!total) total = result;
    else {
      const sums = Object.fromEntries(counters.map(key => [key, total![key] + result[key]]));
      total = { ...result, ...sums, results: [...total.results, ...result.results] };
    }
    if (!result.remaining_entries && !result.remaining_edges && !result.remaining_projects) return total;
    const next = { ...page, offset: result.next_offset, edgeOffset: result.next_edge_offset, projectOffset: result.next_project_offset };
    if (next.offset === page.offset && next.edgeOffset === page.edgeOffset && next.projectOffset === page.projectOffset) {
      throw new Error("importのcursorが進まない");
    }
    page = next;
  }
  throw new Error("fixture importのページ上限に達した");
}
