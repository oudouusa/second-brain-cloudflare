/**
 * judgeCommitment (src/when/pass.ts): one entry in, at most one judgment out.
 * Mirrors test/unit/insight-reason.test.ts's shape for the same
 * declined/failed distinction.
 */
import { describe, it, expect, vi } from "vitest";
import { judgeCommitment, parseWhenCursor, WHEN_CONFIDENCE_THRESHOLD, WHEN_MAX_PAST_MS } from "../../src/when/pass";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { DEFAULTS } from "../../src/config";

function makeAI(payload: string) {
  return {
    run: vi.fn().mockResolvedValue(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    })),
  } as unknown as Ai;
}

const REFERENCE_DATE = Date.UTC(2026, 0, 15);

describe("judgeCommitment()", () => {
  const content = "Need to file the annual report with the registrar by January 30th.";

  it("persists a well-formed, confident commitment, defaulting kind to due", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "File the annual report", "due_at": "2026-01-30", "confidence": 0.9}`),
    });
    expect(await judgeCommitment(content, REFERENCE_DATE, env)).toEqual({
      outcome: "commitment", what: "File the annual report", dueAt: Date.parse("2026-01-30"), confidence: 0.9, kind: "due",
    });
  });

  it("distinguishes an event from a due deadline (Nit b)", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "Dentist appointment", "due_at": "2026-01-30", "kind": "event", "confidence": 0.9}`),
    });
    const out = await judgeCommitment("Dentist appointment on the 30th", REFERENCE_DATE, env);
    expect(out).toEqual({
      outcome: "commitment", what: "Dentist appointment", dueAt: Date.parse("2026-01-30"), confidence: 0.9, kind: "event",
    });
  });

  it("falls back to due for an invalid kind value", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "Do it", "due_at": "2026-01-30", "kind": "someday", "confidence": 0.9}`),
    });
    const out = await judgeCommitment(content, REFERENCE_DATE, env);
    expect(out.outcome).toBe("commitment");
    if (out.outcome === "commitment") expect(out.kind).toBe("due");
  });

  it("declines an explicit non-commitment", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": false, "what": "", "due_at": null, "confidence": 0.9}`),
    });
    expect(await judgeCommitment(content, REFERENCE_DATE, env)).toEqual({ outcome: "declined" });
  });

  it("declines a commitment below the confidence threshold", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "File the report", "due_at": "2026-01-30", "confidence": ${WHEN_CONFIDENCE_THRESHOLD - 0.01}}`),
    });
    expect(await judgeCommitment(content, REFERENCE_DATE, env)).toEqual({ outcome: "declined" });
  });

  it("accepts a commitment exactly at the confidence threshold", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "File the report", "due_at": "2026-01-30", "confidence": ${WHEN_CONFIDENCE_THRESHOLD}}`),
    });
    const out = await judgeCommitment(content, REFERENCE_DATE, env);
    expect(out.outcome).toBe("commitment");
  });

  it("declines a commitment with no due date", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "Do the thing", "due_at": null, "confidence": 0.95}`),
    });
    expect(await judgeCommitment(content, REFERENCE_DATE, env)).toEqual({ outcome: "declined" });
  });

  it("declines a commitment with an unparseable due date", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "Do the thing", "due_at": "not a date", "confidence": 0.95}`),
    });
    expect(await judgeCommitment(content, REFERENCE_DATE, env)).toEqual({ outcome: "declined" });
  });

  it("declines a commitment with an empty what", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "", "due_at": "2026-01-30", "confidence": 0.95}`),
    });
    expect(await judgeCommitment(content, REFERENCE_DATE, env)).toEqual({ outcome: "declined" });
  });

  it("declines a due date more than 30 days in the past (a bad extraction, not a genuine reminder)", async () => {
    const tooOld = new Date(REFERENCE_DATE - WHEN_MAX_PAST_MS - 86400000).toISOString().slice(0, 10);
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "Do the thing", "due_at": "${tooOld}", "confidence": 0.95}`),
    });
    expect(await judgeCommitment(content, REFERENCE_DATE, env)).toEqual({ outcome: "declined" });
  });

  it("accepts a due date within the 30-day overdue window", async () => {
    const overdue = new Date(REFERENCE_DATE - WHEN_MAX_PAST_MS + 86400000).toISOString().slice(0, 10);
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "Do the thing", "due_at": "${overdue}", "confidence": 0.95}`),
    });
    expect((await judgeCommitment(content, REFERENCE_DATE, env)).outcome).toBe("commitment");
  });

  it("truncates what to 120 characters", async () => {
    const long = "x".repeat(200);
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": ${JSON.stringify(long)}, "due_at": "2026-01-30", "confidence": 0.95}`),
    });
    const out = await judgeCommitment(content, REFERENCE_DATE, env);
    expect(out.outcome).toBe("commitment");
    if (out.outcome === "commitment") expect(out.what.length).toBe(120);
  });

  it("declines malformed JSON output", async () => {
    const env = makeTestEnv(makeTestDb(), { AI: makeAI("not json at all") });
    expect(await judgeCommitment(content, REFERENCE_DATE, env)).toEqual({ outcome: "failed" });
  });

  it("is_commitmentのない応答は判断失敗として再試行する", async () => {
    const env = makeTestEnv(makeTestDb(), { AI: makeAI(`{"what": "x", "due_at": "2026-01-30"}`) });
    expect(await judgeCommitment(content, REFERENCE_DATE, env)).toEqual({ outcome: "failed" });
  });

  it("reports failed, not declined, when the model call itself throws", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: { run: vi.fn().mockRejectedValue(new Error("AI down")) } as unknown as Ai,
    });
    await expect(judgeCommitment(content, REFERENCE_DATE, env)).resolves.toEqual({ outcome: "failed" });
  });

  it("calls the model with config.WHEN_LLM_MODEL, never config.LLM_MODEL", async () => {
    const ai = makeAI(`{"is_commitment": false}`);
    const env = makeTestEnv(makeTestDb(), { AI: ai });
    const config = { ...DEFAULTS, LLM_MODEL: "should-not-be-used", WHEN_LLM_MODEL: "when-only-model-for-test" };

    await judgeCommitment(content, REFERENCE_DATE, env, config);

    expect((ai.run as any).mock.calls[0][0]).toBe("when-only-model-for-test");
  });

  it("includes the reference date in the prompt", async () => {
    const ai = makeAI(`{"is_commitment": false}`);
    const env = makeTestEnv(makeTestDb(), { AI: ai });

    await judgeCommitment(content, REFERENCE_DATE, env);

    const prompt = (ai.run as any).mock.calls[0][1].messages[0].content as string;
    expect(prompt).toContain("2026-01-15");
  });

  it("anchors due_at at midnight in config.TIMEZONE, not UTC", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"is_commitment": true, "what": "File the annual report", "due_at": "2026-01-30", "confidence": 0.9}`),
    });
    const config = { ...DEFAULTS, TIMEZONE: "America/New_York" };

    const out = await judgeCommitment(content, REFERENCE_DATE, env, config);

    // January is standard time (EST, UTC-5): midnight Eastern is 05:00 UTC.
    expect(out).toEqual({
      outcome: "commitment", what: "File the annual report", dueAt: Date.UTC(2026, 0, 30, 5), confidence: 0.9, kind: "due",
    });
  });
});

describe("parseWhenCursor()", () => {
  it("parses a well-formed cursor", () => {
    expect(parseWhenCursor(JSON.stringify({ createdAt: 100, id: "e1" }))).toEqual({ createdAt: 100, id: "e1" });
  });

  it("returns null for absent, malformed, or shape-mismatched input", () => {
    expect(parseWhenCursor(null)).toBeNull();
    expect(parseWhenCursor("not json")).toBeNull();
    expect(parseWhenCursor(JSON.stringify({ createdAt: "100", id: "e1" }))).toBeNull();
    expect(parseWhenCursor(JSON.stringify({ id: "e1" }))).toBeNull();
  });
});
