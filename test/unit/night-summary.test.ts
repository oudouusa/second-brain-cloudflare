/**
 * The nightly KV recorder GET /stats/night reads back from. Isolated from the
 * scheduled() wiring (test/integration/stats-night.test.ts covers that end to
 * end) so its own contract, one full record, one put, never throws, is
 * pinned directly.
 */
import { describe, it, expect, vi } from "vitest";
import { recordNightSummary, readNightSummary, nightSummaryKey } from "../../src/runtime/night-summary";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";

describe("recordNightSummary", () => {
  it("writes one full record under night:<workspaceId>", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });
    const before = Date.now();

    await recordNightSummary(env, "ws-a", {
      linksInferred: 3, insightsProposed: 0, digestsWritten: 1, claimsFlagged: 5, whenJudged: 0, whenExtracted: 0, whenSkipped: 0,
    });

    const raw = await kv.get(nightSummaryKey("ws-a"));
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw as string);
    expect(record).toMatchObject({ linksInferred: 3, insightsProposed: 0, digestsWritten: 1, claimsFlagged: 5 });
    expect(record.ranAt).toBeGreaterThanOrEqual(before);
  });

  it("keys each workspace's record separately", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });

    await recordNightSummary(env, "ws-a", { linksInferred: 1, insightsProposed: 0, digestsWritten: 0, claimsFlagged: 0, whenJudged: 0, whenExtracted: 0, whenSkipped: 0 });
    await recordNightSummary(env, "ws-b", { linksInferred: 9, insightsProposed: 0, digestsWritten: 0, claimsFlagged: 0, whenJudged: 0, whenExtracted: 0, whenSkipped: 0 });

    expect(await readNightSummary(env, "ws-a")).toMatchObject({ linksInferred: 1 });
    expect(await readNightSummary(env, "ws-b")).toMatchObject({ linksInferred: 9 });
  });

  it("swallows a failing put and never throws", async () => {
    const put = vi.fn().mockRejectedValue(new Error("KV unavailable"));
    const env = makeTestEnv(undefined, {
      OAUTH_KV: { get: vi.fn().mockResolvedValue(null), put, delete: vi.fn(), list: vi.fn() } as any,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordNightSummary(env, "ws-a", {
      linksInferred: 1, insightsProposed: 0, digestsWritten: 0, claimsFlagged: 0, whenJudged: 0, whenExtracted: 0, whenSkipped: 0,
    })).resolves.toBeUndefined();

    expect(put).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("readNightSummary", () => {
  it("returns null when nothing was ever recorded", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });
    expect(await readNightSummary(env, "ws-a")).toBeNull();
  });

  it("swallows a failing get and returns null", async () => {
    const get = vi.fn().mockRejectedValue(new Error("KV unavailable"));
    const env = makeTestEnv(undefined, {
      OAUTH_KV: { get, put: vi.fn(), delete: vi.fn(), list: vi.fn() } as any,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await readNightSummary(env, "ws-a")).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns null for unparseable stored JSON rather than throwing", async () => {
    const get = vi.fn().mockResolvedValue("not json");
    const env = makeTestEnv(undefined, {
      OAUTH_KV: { get, put: vi.fn(), delete: vi.fn(), list: vi.fn() } as any,
    });
    expect(await readNightSummary(env, "ws-a")).toBeNull();
  });
});


describe("complete record validation", () => {
  it.each([-1, 0.5, "3", null, Number.MAX_SAFE_INTEGER + 1])("refuses invalid counter %j without overwriting a good record", async invalid => {
    const kv = makeMemoryKV(); const env = makeTestEnv(undefined, { OAUTH_KV: kv });
    const counts = { whenExtracted: 0, whenJudged: 0, whenSkipped: 0, linksInferred: 1, insightsProposed: 0, digestsWritten: 2, claimsFlagged: 3 };
    await recordNightSummary(env, "ws-a", counts);
    const previous = await kv.get(nightSummaryKey("ws-a"));
    await recordNightSummary(env, "ws-a", { ...counts, linksInferred: invalid } as never);
    expect(await kv.get(nightSummaryKey("ws-a"))).toBe(previous);
    await kv.put(nightSummaryKey("ws-a"), JSON.stringify({ ...counts, ranAt: 1, linksInferred: invalid }));
    expect(await readNightSummary(env, "ws-a")).toBeNull();
  });
  it("treats missing fields as unknown rather than inventing completed zero counts", async () => {
    const kv = makeMemoryKV(); const env = makeTestEnv(undefined, { OAUTH_KV: kv });
    await kv.put(nightSummaryKey("ws-a"), JSON.stringify({ ranAt: 1, digestsWritten: 2 }));
    expect(await readNightSummary(env, "ws-a")).toBeNull();
  });
});
