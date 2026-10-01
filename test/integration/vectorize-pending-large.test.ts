import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { runNightlyVectorizePending, VECTORIZE_PENDING_NIGHTLY_EMBEDS, VECTORIZE_PENDING_NIGHTLY_ROWS } from "../../src/vectorize/pending";
import { chunkText } from "../../src/text/chunk";
import { DEFAULTS } from "../../src/config";
import { embedBatchSize } from "../../src/lib/ai";
import { D1_ROW_MAX_BYTES } from "../../src/constants";

// T-0089.1.1 close-out round 3: the nightly pass indexes EVERY eligible row whatever its size. The
// oldest row always gets the night (all of it if it needs more than the budget); others share
// what is left, oldest first, and never jump a row that did not fit. Chunks go 100 per AI call.

let t: TrashEnv;
afterEach(() => t?.close());

const OLD = Date.now() - 60 * 60_000;
const KB128 = 128 * 1024;
/** Worst-case chunking: a period every 801 characters makes chunkText advance only ~600 at a time. */
const worstCase = (len: number) => ("x".repeat(800) + ".").repeat(Math.ceil(len / 801)).slice(0, len);
const indexed = async (id: string) =>
  JSON.parse((await t.one<{ vector_ids: string }>(`SELECT vector_ids FROM entries WHERE id = ?`, id))!.vector_ids).length > 0;

/** Counts every Cloudflare-service subrequest the pass makes: D1, Workers AI, Vectorize. */
function counted(env: TrashEnv["env"]) {
  let n = 0;
  // A batch is one subrequest; the helper's batch() runs each statement itself, which must not count again.
  let inBatch = false;
  const wrap = <T extends object>(obj: T, keys: string[]) => new Proxy(obj, { get(o: any, k) {
    const v = o[k];
    if (typeof v === "function" && keys.includes(String(k))) return (...a: unknown[]) => { if (!inBatch) n++; return v.apply(o, a); };
    return typeof v === "function" ? v.bind(o) : v;
  } });
  const db = env.DB as any;
  const DB = { ...db, batch: async (s: unknown[]) => { n++; inBatch = true; try { return await db.batch(s); } finally { inBatch = false; } }, prepare: (sql: string) => {
    const st = db.prepare(sql);
    return { bind: (...a: unknown[]) => wrap(st.bind(...a), ["first", "all", "run", "raw"]), first: () => { n++; return st.first(); }, all: () => { n++; return st.all(); }, run: () => { n++; return st.run(); } };
  } };
  return { env: { ...env, DB, AI: wrap(env.AI, ["run"]), VECTORIZE: wrap(env.VECTORIZE, ["upsert", "insert", "query", "getByIds", "deleteByIds"]) } as typeof env, count: () => n };
}

describe("nightly vectorize-pending: rows of any size", () => {
  it("a 128 KB row at the head of the queue is indexed in one night, in a handful of subrequests", async () => {
    t = await makeTrashEnv();
    const content = worstCase(KB128);
    const chunks = chunkText(content).length;
    expect(chunks).toBeGreaterThan(VECTORIZE_PENDING_NIGHTLY_EMBEDS / 2);
    t.seed("big", { content, created_at: OLD });
    const { env, count } = counted(t.env);
    await runNightlyVectorizePending(env, DEFAULTS);
    expect(await indexed("big")).toBe(true);
    expect(JSON.parse((await t.one<{ vector_ids: string }>(`SELECT vector_ids FROM entries WHERE id = 'big'`))!.vector_ids)).toHaveLength(chunks);
    // 固定Gemma25件batchと、候補2読取・outbox/CAS/receiptの7D1実行・upsertを固定する。
    expect(count()).toBe(Math.ceil(chunks / embedBatchSize(DEFAULTS.EMBEDDING_MODEL)) + 10);
    expect(count()).toBeLessThanOrEqual(50);
  });

  it("a legacy row over the 128 KB cap is skipped with one log line a night, takes no slot, and blocks nothing", async () => {
    t = await makeTrashEnv();
    // 3.7 had no size cap: a legacy note near D1's 2 MB row limit, the oldest deferred row.
    t.seed("legacy", { content: worstCase(Math.floor(D1_ROW_MAX_BYTES * 0.9)), created_at: OLD - 1000 });
    for (let i = 0; i < 12; i++) t.seed(`s${i}`, { content: `small fact ${i}`, created_at: OLD + i });
    const embedded: string[] = [];
    const run = t.env.AI.run.bind(t.env.AI);
    (t.env.AI as any).run = async (m: string, input: any) => { embedded.push(...(Array.isArray(input?.text) ? input.text : [input?.text])); return run(m, input); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runNightlyVectorizePending(t.env, DEFAULTS);
    // Ten small rows get the ten slots: the legacy row took none of them and embedded nothing.
    expect((await Promise.all(Array.from({ length: 12 }, (_, i) => indexed(`s${i}`)))).filter(Boolean)).toHaveLength(VECTORIZE_PENDING_NIGHTLY_ROWS);
    await runNightlyVectorizePending(t.env, DEFAULTS);
    for (let i = 0; i < 12; i++) expect(await indexed(`s${i}`), `s${i}`).toBe(true);
    expect(await indexed("legacy")).toBe(false);
    expect(embedded.some((x) => x.startsWith("x".repeat(800)))).toBe(false);
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes("128 KB"));
    expect(lines).toHaveLength(2); // one line a night
    warn.mockRestore();
  }, 60_000);

  it("POST /vectorize-pending, which a person runs on purpose, still indexes a legacy row over the cap", async () => {
    t = await makeTrashEnv();
    t.seed("legacy", { content: worstCase(KB128 * 2), created_at: OLD });
    const res = await worker.fetch(new Request("http://localhost/vectorize-pending", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" } }), t.env, { waitUntil: () => {} } as unknown as ExecutionContext);
    expect(await res.json()).toMatchObject({ processed: 1, failed: 0 });
    expect(await indexed("legacy")).toBe(true);
  });

  it("a big row that does not fit behind others waits at most one night, and nothing behind it overtakes it", async () => {
    t = await makeTrashEnv();
    t.seed("s1", { content: worstCase(40_000), created_at: OLD });
    t.seed("big", { content: worstCase(KB128), created_at: OLD + 1 });
    t.seed("s2", { content: "tiny", created_at: OLD + 2 });
    await runNightlyVectorizePending(t.env, DEFAULTS);
    expect([await indexed("s1"), await indexed("big"), await indexed("s2")]).toEqual([true, false, false]);
    await runNightlyVectorizePending(t.env, DEFAULTS);
    expect(await indexed("big")).toBe(true);
    // Bounded: every row is indexed within as many nights as there are rows ahead of it, plus one.
    for (let night = 0; night < 2 && !(await indexed("s2")); night++) await runNightlyVectorizePending(t.env, DEFAULTS);
    expect(await indexed("s2")).toBe(true);
  });
});
