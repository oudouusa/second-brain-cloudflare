import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import {
  runNightlyVectorizePending, VECTORIZE_PENDING_NIGHTLY_ROWS,
} from "../../src/vectorize/pending";
import { DEFAULTS } from "../../src/config";

// T-0089.1.1 close-out, MAJOR 2: deferred rows (vector_ids = '[]', e.g. an undo's re-created merges
// past its inline re-embed budget) get indexed by the nightly cron with no caller action, a few per
// night inside a fixed row and embed budget, the rest carried to the next night.

let t: TrashEnv;
afterEach(() => t?.close());

const OLD = Date.now() - 60 * 60_000;
const indexed = async (id: string) =>
  JSON.parse((await t.one<{ vector_ids: string }>(`SELECT vector_ids FROM entries WHERE id = ?`, id))!.vector_ids).length > 0;
const nightly = async () => {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
  await worker.scheduled({ cron: "0 1 * * *", scheduledTime: Date.now() } as ScheduledEvent, t.env, ctx);
  await Promise.all(pending);
};

describe("nightly vectorize-pending pass", () => {
  it("the nightly cron indexes the oldest deferred rows up to its row cap and carries the rest to the next night", async () => {
    t = await makeTrashEnv();
    const n = VECTORIZE_PENDING_NIGHTLY_ROWS + 3;
    for (let i = 0; i < n; i++) t.seed(`d${i}`, { content: `deferred fact ${i}`, created_at: OLD + i });
    t.seed("fresh", { content: "still inside its grace window", created_at: Date.now() });
    t.seed("dep", { content: "deprecated", created_at: OLD - 1, tags: '["status:deprecated"]' });

    await nightly();
    const first = await Promise.all(Array.from({ length: n }, (_, i) => indexed(`d${i}`)));
    expect(first.filter(Boolean)).toHaveLength(1);
    expect(first.slice(0, 1).every(Boolean)).toBe(true); // oldest first
    expect(await indexed("fresh")).toBe(false);
    expect(await indexed("dep")).toBe(false);

    // forkの夜間は1件ずつ。毎回進捗し、有限回で全て索引化する。
    for (let pass = 1; pass < n; pass++) await nightly();
    const second = await Promise.all(Array.from({ length: n }, (_, i) => indexed(`d${i}`)));
    expect(second.every(Boolean)).toBe(true);
  }, 30000);

  // Large rows: test/integration/vectorize-pending-large.test.ts (a row is never skipped for its size).

  it("a failing row is counted and does not stop the rest", async () => {
    t = await makeTrashEnv();
    t.seed("a", { content: "first", created_at: OLD });
    t.seed("b", { content: "second", created_at: OLD + 1 });
    const upsert = t.env.VECTORIZE.upsert.bind(t.env.VECTORIZE);
    let once = true;
    (t.env.VECTORIZE as any).upsert = async (v: any) => { if (once) { once = false; throw new Error("vectorize 503"); } return upsert(v); };
    const result = await runNightlyVectorizePending(t.env, DEFAULTS);
    expect(result).toMatchObject({ processed: 1, failed: 1 });
    expect(await indexed("b")).toBe(true);
  });
});
