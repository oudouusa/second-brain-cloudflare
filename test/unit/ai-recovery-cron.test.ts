import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { resetDatabaseInit } from "../../src/db/init";
import { INTEGRATION_SYNC_CRON } from "../../src/integrations/mirror";
import {
  SCHEDULED_CLASSIFY_PENDING_BATCH,
  SCHEDULED_VECTORIZE_PENDING_BATCH,
  scheduledAiRecoverySlot,
} from "../../src/capture/pending";
import { observeWorkersAiQuotaError, readWorkersAiHealth } from "../../src/lib/ai";
import { makeMemoryKV, makeTestDb, makeTestEnv } from "../helpers/make-env";

const RECOVERY_DAY = Date.UTC(2026, 7, 29);
const atUtc = (hour: number, minute = 30) => RECOVERY_DAY + hour * 3_600_000 + minute * 60_000;

function pendingVectorEntry(id: string, now: number) {
  return {
    id,
    content: `Pending vector ${id}`,
    tags: '["work"]',
    source: "api",
    created_at: now - 600_000,
    updated_at: now - 600_000,
    vector_ids: "[]",
    recall_count: 0,
    importance_score: 0,
    contradiction_wins: 0,
    contradiction_losses: 0,
  };
}

function pendingClassificationEntry(id: string, now: number) {
  return {
    ...pendingVectorEntry(id, now),
    content: `Pending classification ${id}`,
    vector_ids: `["${id}"]`,
  };
}

function classifyingAi(): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/google/embeddinggemma-300m") {
        return { data: [new Array(768).fill(0.1)] };
      }
      return new ReadableStream({
        start(controller) {
          const result = JSON.stringify({ importance: 4, canonical: false, kind: "semantic" });
          controller.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(result)}}\n\n`));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
    }),
  } as unknown as Ai;
}

async function runScheduled(env: Env, scheduledTime: number): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
  } as unknown as ExecutionContext;
  const event = Object.assign(new Event("scheduled"), {
    cron: INTEGRATION_SYNC_CRON,
    scheduledTime,
  }) as ScheduledEvent;
  await worker.scheduled?.(
    event,
    env,
    ctx,
  );
  await Promise.allSettled(pending);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetDatabaseInit();
});

describe("scheduled Workers AI recovery", () => {
  it("reuses four alternating integration invocations after the UTC reset", () => {
    expect(scheduledAiRecoverySlot(atUtc(0))).toBe("vector");
    expect(scheduledAiRecoverySlot(atUtc(2))).toBe("vector");
    expect(scheduledAiRecoverySlot(atUtc(4))).toBe("vector");
    expect(scheduledAiRecoverySlot(atUtc(6))).toBe("final");
    expect(scheduledAiRecoverySlot(atUtc(1))).toBeNull();
    expect(scheduledAiRecoverySlot(atUtc(0, 29))).toBeNull();
    expect(scheduledAiRecoverySlot(undefined)).toBeNull();
  });

  it("vectorizes one bounded batch and leaves the rest for the next slot", async () => {
    const now = atUtc(0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = makeTestDb();
    for (let i = 0; i < SCHEDULED_VECTORIZE_PENDING_BATCH + 2; i++) {
      db.entries.push({
        ...pendingVectorEntry(`v-${i}`, now),
        created_at: now - (i + 1) * 600_000,
      });
    }
    const env = makeTestEnv(db, { OAUTH_KV: makeMemoryKV() });

    await runScheduled(env, now);

    expect(db.entries.filter(entry => entry.vector_ids !== "[]")).toHaveLength(SCHEDULED_VECTORIZE_PENDING_BATCH);
    expect(db.entries.filter(entry => entry.vector_ids === "[]")).toHaveLength(2);
    expect(db.entries.filter(entry => entry.vector_ids === "[]").map(entry => entry.id).sort())
      .toEqual(["v-0", "v-1"]);
  });

  it("classifies only in the final daily slot and bounds that pass", async () => {
    const now = atUtc(0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = makeTestDb();
    for (let i = 0; i < SCHEDULED_CLASSIFY_PENDING_BATCH + 2; i++) {
      db.entries.push(pendingClassificationEntry(`c-${i}`, now));
    }
    const env = makeTestEnv(db, { AI: classifyingAi(), OAUTH_KV: makeMemoryKV() });

    await runScheduled(env, atUtc(0));
    expect(db.entries.every(entry => !String(entry.tags).includes('"kind:'))).toBe(true);

    resetDatabaseInit();
    await runScheduled(env, atUtc(6));
    expect(db.entries.filter(entry => String(entry.tags).includes('"kind:semantic"')))
      .toHaveLength(SCHEDULED_CLASSIFY_PENDING_BATCH);
    expect(db.entries.filter(entry => !String(entry.tags).includes('"kind:'))).toHaveLength(2);
  });

  it("stops after the first quota error but probes the next bounded slot and self-heals", async () => {
    const now = atUtc(0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = makeTestDb();
    db.entries.push(pendingVectorEntry("quota-1", now), pendingVectorEntry("quota-2", now));
    const aiRun = vi.fn().mockRejectedValue(new Error("4006: daily free allocation used"));
    const env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });

    await runScheduled(env, atUtc(0));
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(await readWorkersAiHealth(env)).toMatchObject({ ok: false, status: "quota_exhausted" });

    aiRun.mockResolvedValue({ data: [new Array(768).fill(0.1)] });
    vi.mocked(Date.now).mockReturnValue(atUtc(2));
    resetDatabaseInit();
    await runScheduled(env, atUtc(2));
    expect(aiRun).toHaveBeenCalledTimes(3);
    expect(db.entries.every(entry => entry.vector_ids !== "[]")).toBe(true);
    expect(await readWorkersAiHealth(env)).toEqual({
      ok: null,
      status: "no_recent_quota_error",
    });
  });

  it("classifies through a stale marker and clears it after provider success", async () => {
    const markerAt = atUtc(0);
    vi.spyOn(Date, "now").mockReturnValue(markerAt);
    const db = makeTestDb();
    db.entries.push(pendingClassificationEntry("stale-classify", markerAt));
    const env = makeTestEnv(db, {
      AI: classifyingAi(),
      OAUTH_KV: makeMemoryKV(),
    });
    await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));

    vi.mocked(Date.now).mockReturnValue(atUtc(6));
    await runScheduled(env, atUtc(6));

    expect(String(db.entries[0].tags)).toContain('"kind:semantic"');
    expect(await readWorkersAiHealth(env)).toEqual({
      ok: null,
      status: "no_recent_quota_error",
    });
  });
});
