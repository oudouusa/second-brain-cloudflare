import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import * as compression from "../../src/compression/nightly";
import * as graph from "../../src/graph/pass";
import * as staleness from "../../src/staleness/pass";
import * as rotation from "../../src/runtime/rotation";
import * as database from "../../src/db/init";
import { nightSummaryKey } from "../../src/runtime/night-summary";
import { makeMemoryKV, makeTestDb, makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

async function scheduled(env: Env, at = Date.UTC(2026, 8, 12, 1)) {
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
  await worker.scheduled({ cron: "0 1 * * *", scheduledTime: at } as ScheduledEvent, env, ctx);
  while (tasks.length) await Promise.all(tasks.splice(0));
}

function passes(slice: string | null = "ws-a") {
  const next = vi.spyOn(rotation, "nextWorkspace").mockResolvedValue(slice);
  const compress = vi.spyOn(compression, "runNightlyCompression").mockResolvedValue({ digestsWritten: 1 });
  const infer = vi.spyOn(graph, "runGraphPass").mockResolvedValue({ inserted: 2 });
  const stale = vi.spyOn(staleness, "runStalenessPass").mockResolvedValue({ flagged: 3 });
  return { next, compress, infer, stale };
}

beforeEach(() => { vi.restoreAllMocks(); database.resetDatabaseInit(); });
afterEach(() => { vi.restoreAllMocks(); database.resetDatabaseInit(); });

describe("upstream nightly orchestration with the production safety profile", () => {
  it.each(["ws-a", ""])("uses one admitted slice and one complete KV put for %j", async slice => {
    const p = passes(slice);
    const kv = makeMemoryKV();
    const put = vi.spyOn(kv, "put");
    const env = makeTestEnv(makeTestDb(), { OAUTH_KV: kv });
    await scheduled(env);
    expect(p.next).toHaveBeenCalledTimes(1);
    for (const pass of [p.compress, p.infer, p.stale]) {
      expect(pass).toHaveBeenCalledTimes(1);
      expect(pass.mock.calls[0][0].WRITE_ADMISSION_TOKEN).toBeTruthy();
      expect(pass.mock.calls[0][2]).toBe(slice);
    }
    expect(p.compress.mock.calls[0][3]).toBe(1);
    expect(p.infer.mock.calls[0][3]).toBe(4);
    expect(p.stale.mock.calls[0][3]).toBe(2);
    const records = put.mock.calls.filter(([key]) => key.startsWith("night:"));
    expect(records).toHaveLength(1);
    expect(records[0][0]).toBe(nightSummaryKey(slice));
    expect(JSON.parse(records[0][1] as string)).toEqual({
      whenJudged: 0, whenExtracted: 0, whenSkipped: 0, ranAt: expect.any(Number), digestsWritten: 1, linksInferred: 2, claimsFlagged: 3, insightsProposed: 0,
    });
    expect(env.WRITE_ADMISSION_TOKEN).toBeUndefined();
  });

  it.each(["compression", "graph", "staleness"])("does not publish a false zero when %s rejects", async failed => {
    const p = passes();
    const failing = failed === "compression" ? p.compress : failed === "graph" ? p.infer : p.stale;
    failing.mockRejectedValue(new Error("private failure"));
    const kv = makeMemoryKV();
    const old = JSON.stringify({ ranAt: 1, digestsWritten: 4, linksInferred: 5, claimsFlagged: 6, insightsProposed: 0 });
    await kv.put(nightSummaryKey("ws-a"), old);
    const put = vi.spyOn(kv, "put");
    await scheduled(makeTestEnv(makeTestDb(), { OAUTH_KV: kv }));
    expect(p.compress).toHaveBeenCalledOnce();
    expect(p.infer).toHaveBeenCalledOnce();
    expect(p.stale).toHaveBeenCalledOnce();
    expect(await kv.get(nightSummaryKey("ws-a"))).toBe(old);
    expect(put.mock.calls.filter(([key]) => key.startsWith("night:"))).toHaveLength(0);
  });

  it.each(["compression", "graph", "staleness"])("keeps partial committed %s work out of the completed summary", async failed => {
    const p = passes();
    if (failed === "compression") p.compress.mockResolvedValue({ digestsWritten: 0, complete: false });
    if (failed === "graph") p.infer.mockResolvedValue({ inserted: 1, complete: false });
    if (failed === "staleness") p.stale.mockResolvedValue({ flagged: 1, complete: false });
    const kv = makeMemoryKV();
    await scheduled(makeTestEnv(makeTestDb(), { OAUTH_KV: kv }));
    expect(await kv.get(nightSummaryKey("ws-a"))).toBeNull();
    expect(p.compress).toHaveBeenCalledOnce();
    expect(p.infer).toHaveBeenCalledOnce();
    expect(p.stale).toHaveBeenCalledOnce();
  });

  it("does not attribute an unsliced fallback to any workspace", async () => {
    const p = passes(null);
    const kv = makeMemoryKV(); const put = vi.spyOn(kv, "put");
    await scheduled(makeTestEnv(makeTestDb(), { OAUTH_KV: kv }));
    expect(p.compress.mock.calls[0][2]).toBeNull();
    expect(put.mock.calls.filter(([key]) => key.startsWith("night:"))).toHaveLength(0);
  });

  it("does no domain work or summary write on a schema-initialization tick", async () => {
    const p = passes();
    vi.spyOn(database, "initializeDatabase").mockResolvedValue({ changed: true });
    const kv = makeMemoryKV(); const put = vi.spyOn(kv, "put");
    await scheduled(makeTestEnv(makeTestDb(), { OAUTH_KV: kv }));
    expect(p.next).not.toHaveBeenCalled();
    expect(p.compress).not.toHaveBeenCalled();
    expect(p.infer).not.toHaveBeenCalled();
    expect(p.stale).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("replays replace a complete result rather than double-counting it", async () => {
    passes();
    const kv = makeMemoryKV(); const env = makeTestEnv(makeTestDb(), { OAUTH_KV: kv });
    await scheduled(env); await scheduled(env);
    expect(JSON.parse((await kv.get(nightSummaryKey("ws-a")))!)).toMatchObject({
      digestsWritten: 1, linksInferred: 2, claimsFlagged: 3,
    });
  });
});

describe("bounded pass arguments", () => {
  it.each([0, -1, 1.5, NaN, Infinity, 100])("rejects invalid work limits %s before any database work", async limit => {
    const env = makeTestEnv();
    const ctx = {} as ExecutionContext;
    await expect(compression.runNightlyCompression(env, ctx, "ws-a", limit)).rejects.toThrow(RangeError);
    await expect(graph.runGraphPass(env, ctx, "ws-a", limit)).rejects.toThrow(RangeError);
    await expect(staleness.runStalenessPass(env, ctx, "ws-a", limit)).rejects.toThrow(RangeError);
  });
});
