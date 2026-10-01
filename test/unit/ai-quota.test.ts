import { describe, expect, it, vi } from "vitest";
import {
  embedQuery,
  isWorkersAiQuotaError,
  nextWorkersAiQuotaReset,
  observeWorkersAiQuotaError,
  observeWorkersAiSuccess,
  readWorkersAiHealth,
  WorkersAiQuotaError,
} from "../../src/lib/ai";
import { classifyEntry } from "../../src/capture/classify";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";

describe("Workers AI quota observation", () => {
  it("recognises observed and documented quota codes without matching unrelated failures", () => {
    expect(isWorkersAiQuotaError(new Error("AiError 4006: daily free allocation used"))).toBe(true);
    expect(isWorkersAiQuotaError({ error: { code: 3036, message: "account limited" } })).toBe(true);
    expect(isWorkersAiQuotaError(new Error("Vectorize error 40001"))).toBe(false);
  });

  it("calculates the next 00:00 UTC reset across month and year boundaries", () => {
    const now = Date.UTC(2026, 11, 31, 23, 59, 59);
    expect(nextWorkersAiQuotaReset(now)).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
  });

  it("normalises embedding quota failures and makes them passively visible to health", async () => {
    const aiRun = vi.fn().mockRejectedValue({ code: 3036, message: "account limited" });
    const env = makeTestEnv(undefined, {
      AI: { run: aiRun } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });

    let quota: WorkersAiQuotaError | null = null;
    try {
      await embedQuery("quota health probe", env);
    } catch (error) {
      quota = error as WorkersAiQuotaError;
    }

    expect(quota).toBeInstanceOf(WorkersAiQuotaError);
    expect(quota?.message).not.toContain("3036");
    expect(await readWorkersAiHealth(env)).toMatchObject({
      ok: false,
      status: "quota_exhausted",
      resetAt: quota?.retryAt,
    });
    expect(aiRun).toHaveBeenCalledTimes(1);

    expect(await readWorkersAiHealth(env, (quota?.retryAt ?? 0) + 1)).toEqual({
      ok: null,
      status: "no_recent_quota_error",
    });
    expect(aiRun).toHaveBeenCalledTimes(1);
  });

  it("records classification quota failures without writing a false score", async () => {
    const aiRun = vi.fn().mockRejectedValue(new Error("4006: daily free allocation used"));
    const env = makeTestEnv(undefined, {
      AI: { run: aiRun } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });

    const result = await classifyEntry("defer this classification", env);

    expect(result).toMatchObject({ importance: 0, canonical: false, kind: null });
    expect(result.quotaRetryAt).toEqual(expect.any(Number));
    expect(await readWorkersAiHealth(env)).toMatchObject({
      ok: false,
      status: "quota_exhausted",
      resetAt: result.quotaRetryAt,
    });
    expect(aiRun).toHaveBeenCalledTimes(1);
  });

  it("clears a stale quota marker after a newer successful recovery probe", async () => {
    const env = makeTestEnv(undefined, { OAUTH_KV: makeMemoryKV() });
    const failureAt = Date.UTC(2026, 7, 29, 4, 0, 1);
    vi.spyOn(Date, "now").mockReturnValue(failureAt);

    await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));
    expect(await readWorkersAiHealth(env)).toMatchObject({ ok: false, status: "quota_exhausted" });

    await observeWorkersAiSuccess(env, failureAt + 1);
    expect(await readWorkersAiHealth(env)).toEqual({
      ok: null,
      status: "no_recent_quota_error",
    });
  });

  it("does not let an older in-flight success clear a newer quota failure", async () => {
    const env = makeTestEnv(undefined, { OAUTH_KV: makeMemoryKV() });
    const failureAt = Date.UTC(2026, 7, 29, 4, 0, 1);
    vi.spyOn(Date, "now").mockReturnValue(failureAt);

    await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));
    await observeWorkersAiSuccess(env, failureAt - 1);

    expect(await readWorkersAiHealth(env)).toMatchObject({
      ok: false,
      status: "quota_exhausted",
      observedAt: failureAt,
    });
  });
});
