import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, afterAll } from "vitest";
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { buildCorpus, CORE_DATA_DIR } from "./corpus/build";
import { loadCorpus } from "./corpus/loader";
import { replayPaths } from "./corpora";
import { compareToLock } from "./lock";
import { runVariant } from "./runner";
import type { VariantReport } from "./types";
import { getVariant } from "./variants";
import { cleanTemp } from "../helpers/tmp";

// wrangler and Miniflare leave a miniflare-* dir behind even after dispose().
afterAll(cleanTemp);

// 同梱lockはBGE専用。Gemma128の計測・順位証拠には転用しない。
const MODEL = "@cf/baai/bge-small-en-v1.5";
const LOCK = resolve(CORE_DATA_DIR, "../baselines", `core-1k.${MODEL.split("/").pop()}.json`);

// The committed lock was recorded on workerd, so this is the tripwire that covers everything the lock carries: rankings,
// D1 statements and rows_read. Opt-in (boots a local workerd); npm run test:eval:workerd and the eval-workerd CI job run it.
// rows_read may differ from the lock by a couple of rows per query (Task 14 measured 0-2 across runs, from rows such as
// users that a real deployment has and the eval does not); statements are deterministic and must match exactly.
const ROWS_READ_TOLERANCE = 2;

describe.skipIf(!process.env.EVAL_WORKERD || String(DEFAULTS.EMBEDDING_MODEL) !== MODEL)("baseline lock on workerd (rankings, statements, rows_read)", () => {
  it("core-1k on workerd matches the committed lock query by query", async () => {
    const lock = JSON.parse(readFileSync(LOCK, "utf8")) as VariantReport;
    expect(lock.d1Backend, "the committed lock must be a workerd recording").toBe("workerd");
    const spec = buildCorpus("core-1k");
    const corpus = await loadCorpus({ spec, backend: "workerd", replay: makeReplayAi({ store: new ReplayStore(replayPaths(MODEL, "core-1k").read), mode: "replay" }), embeddingModel: MODEL });
    try {
      const fresh = await runVariant({ corpus, variant: getVariant("baseline"), queries: spec.queries, isolate: "warm", embeddingModel: MODEL });
      // rows_read is measured for every query (recall's df probe is a first() that the observer runs as all()), so the cost rule can reach a verdict
      expect(fresh.results).toHaveLength(spec.queries.length);
      expect(fresh.results.filter(r => r.cost.d1RowsRead === null).map(r => r.queryId), "queries with no rows_read").toEqual([]);
      expect(fresh.results.every(r => (r.cost.d1RowsRead as number) > 0)).toBe(true);
      const diff = compareToLock(lock, fresh);
      const how = "If intended, re-lock on workerd: npm run eval:recall -- lock --d1 workerd (add --accept-data-change \"<reason>\" if golden data changed).";
      expect(diff.fingerprintMismatch, how).toBe(false);
      expect([diff.missing, diff.extra, diff.changed, diff.keywordGoldChanged], `rankings or keyword-arm gold coverage differ from the lock. ${how}`).toEqual([[], [], [], []]);
      const locked = new Map(lock.results.map(r => [r.queryId, r] as const));
      const statements = fresh.results.filter(r => r.cost.d1Statements !== locked.get(r.queryId)!.cost.d1Statements).map(r => r.queryId);
      expect(statements, `D1 statement counts differ from the lock. ${how}`).toEqual([]);
      const rows = fresh.results.filter(r => r.cost.d1RowsRead === null || Math.abs(r.cost.d1RowsRead - locked.get(r.queryId)!.cost.d1RowsRead!) > ROWS_READ_TOLERANCE).map(r => r.queryId);
      expect(rows, `rows_read moved by more than ${ROWS_READ_TOLERANCE} for ${rows.length} queries. ${how}`).toEqual([]);
    } finally {
      await corpus.close();
    }
  }, 3_000_000); // 1,683 queries on a real local D1: about 27 minutes when the machine is shared
});
