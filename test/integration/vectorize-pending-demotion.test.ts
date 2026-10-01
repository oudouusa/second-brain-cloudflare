import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { runNightlyVectorizePending, VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION } from "../../src/vectorize/pending";
import { DEFAULTS } from "../../src/config";

// T-0089.1.1 close-out round 5: a deferred row that keeps failing is moved behind the others after
// VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION consecutive failures, and keeps being retried there.

let t: TrashEnv;
afterEach(() => { t?.close(); vi.restoreAllMocks(); });

const OLD = Date.now() - 60 * 60_000;
const indexed = async (id: string) =>
  JSON.parse((await t.one<{ vector_ids: string }>(`SELECT vector_ids FROM entries WHERE id = ?`, id))!.vector_ids).length > 0;

describe("a deferred row that keeps failing does not block the queue", () => {
  it("after 3 consecutive failures, rows that fill every slot move behind the others, keep being retried, and log a line", async () => {
    t = await makeTrashEnv();
    // The oldest ten deferred rows always fail: without demotion they would take all ten nightly slots
    // forever and nothing behind them would ever be indexed.
    for (let i = 0; i < 10; i++) t.seed(`poison${i}`, { content: `never indexes ${i}`, created_at: OLD - 100 + i });
    for (let i = 0; i < 5; i++) t.seed(`ok${i}`, { content: `fact ${i}`, created_at: OLD + i });
    const up = t.env.VECTORIZE.upsert.bind(t.env.VECTORIZE);
    let poisonTries = 0;
    (t.env.VECTORIZE as any).upsert = async (vs: any[]) => {
      if (vs.some((v) => String(v.metadata?.parentId).startsWith("poison"))) { poisonTries++; throw new Error("vectorize 503"); }
      return up(vs);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let night = 0; night < VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION + 1; night++) await runNightlyVectorizePending(t.env, DEFAULTS);
    for (let i = 0; i < 5; i++) expect(await indexed(`ok${i}`), `ok${i}`).toBe(true);
    expect(await indexed("poison0")).toBe(false);
    // 3 nights x 10 rows, then still retried at the back once the others are done.
    expect(poisonTries).toBeGreaterThan(VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION * 10);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("poison0"))).toBe(true);
  });

  it("a demoted row that later succeeds is indexed and its failure count is cleared", async () => {
    t = await makeTrashEnv();
    t.seed("flaky", { content: "fails three times", created_at: OLD });
    const up = t.env.VECTORIZE.upsert.bind(t.env.VECTORIZE);
    let fails = VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION;
    (t.env.VECTORIZE as any).upsert = async (vs: any[]) => { if (fails > 0) { fails--; throw new Error("503"); } return up(vs); };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let night = 0; night <= VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION; night++) await runNightlyVectorizePending(t.env, DEFAULTS);
    expect(await indexed("flaky")).toBe(true);
    const raw = await t.env.OAUTH_KV.get("vectorize-pending:failures");
    expect(raw === null || !("flaky" in JSON.parse(raw))).toBe(true);
  });
});
