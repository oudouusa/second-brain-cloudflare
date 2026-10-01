import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { buildCorpus, CORE_DATA_DIR } from "./corpus/build";
import { loadCorpus } from "./corpus/loader";
import { replayPaths } from "./corpora";
import { EVAL_FULL } from "./full";
import { compareToLock } from "./lock";
import { runVariant } from "./runner";
import type { VariantReport } from "./types";
import { getVariant } from "./variants";

// 上流同梱replayはBGE専用。Gemmaの品質証拠へ転用しない。
const MODEL = "@cf/baai/bge-small-en-v1.5";
const LOCK = resolve(CORE_DATA_DIR, "../baselines", `core-1k.${MODEL.split("/").pop()}.json`);
const cache = replayPaths(MODEL, "core-1k").read;

// This default-suite tripwire replays on sqlite and checks RANKINGS only (sqlite reports no rows_read). The committed lock
// was recorded on workerd. Rankings were verified backend-independent: on core-1k every query's rankedIds from sqlite
// are identical to the workerd lock's (this test compares them, and passes). If the backends ever diverge, this test and
// the workerd tripwire (baseline-lock.workerd.test.ts, which also checks statements and rows_read) cannot both hold, so
// the divergence cannot go unnoticed.
// The presence check always runs: on a checkout missing the lock or the committed cache it must fail loudly, not pass by skipping.
// The two replays below are opt-in (EVAL_FULL=1, npm run test:eval:full): about 100 s each on the whole golden set.
describe("baseline lock (recall tripwire)", () => {
  it("the committed lock and replay layer are present", () => {
    expect(existsSync(LOCK), `${LOCK} missing: run npm run eval:recall -- lock and commit it`).toBe(true);
    expect(cache.length, "no replay cache: Task 9 Step 12 must be committed").toBeGreaterThan(0);
  });

  it.skipIf(!EVAL_FULL || String(DEFAULTS.EMBEDDING_MODEL) !== MODEL)("recall on core-1k still ranks every golden query exactly as the committed lock does", async () => {
    const lock = JSON.parse(readFileSync(LOCK, "utf8")) as VariantReport;
    const spec = buildCorpus("core-1k");
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore(cache), mode: "replay" }), embeddingModel: MODEL });
    try {
      const fresh = await runVariant({ corpus, variant: getVariant("baseline"), queries: spec.queries, isolate: "warm", embeddingModel: MODEL });
      const diff = compareToLock(lock, fresh);
      const how = "If intended, run: npm run eval:recall -- --compare baseline,<variant> with evidence, then npm run eval:recall -- lock (add --accept-data-change \"<reason>\" if golden data changed), and commit the new lock with the gate output in the message.";
      expect(diff.fingerprintMismatch, `the golden data differs from the data the lock was recorded on. ${how}`).toBe(false);
      expect(diff.missing, `queries in the lock but not in the golden set now. ${how}`).toEqual([]);
      expect(diff.extra, `queries in the golden set but not in the lock. ${how}`).toEqual([]);
      expect(diff.keywordGoldChanged, `keyword-arm gold coverage changed for ${diff.keywordGoldChanged.join(", ")}. ${how}`).toEqual([]);
      expect(diff.changed, `recall ranking changed for ${diff.changed.length} golden queries (first: ${diff.changed.slice(0, 5).join(", ")}). ${how}`).toEqual([]);
    } finally {
      await corpus.close();
    }
  }, 300_000);

  // The lock ranks the top 10; a topK 5 call must return exactly its first 5. The reverse (a larger topK reordering the
  // head) is what this catches, whether it comes from the candidate pool, the diversity pass, or the graph slot.
  it.skipIf(!EVAL_FULL || String(DEFAULTS.EMBEDDING_MODEL) !== MODEL)("a topK 5 call returns the first 5 of the locked top 10 on every golden query", async () => {
    const lock = JSON.parse(readFileSync(LOCK, "utf8")) as VariantReport;
    const locked = new Map(lock.results.map(r => [r.queryId, r.rankedIds]));
    const spec = buildCorpus("core-1k");
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore(cache), mode: "replay" }), embeddingModel: MODEL });
    try {
      const five = await runVariant({ corpus, variant: getVariant("baseline"), queries: spec.queries, isolate: "warm", embeddingModel: MODEL, topK: 5 });
      expect(five.results).toHaveLength(spec.queries.length);
      for (const r of five.results) {
        expect(r.error, r.queryId).toBeUndefined();
        expect(r.rankedIds, r.queryId).toEqual(locked.get(r.queryId)!.slice(0, 5));
      }
    } finally {
      await corpus.close();
    }
  }, 300_000);
});
