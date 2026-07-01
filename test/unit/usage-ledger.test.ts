import { describe, expect, it } from "vitest";
import worker, {
  classifyEntry,
  estimateAiInputChars,
  recordAiUsageEvent,
  summarizeAiUsage,
} from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("AI usage ledger", () => {
  it("estimates chars from text, prompt, and messages", () => {
    expect(estimateAiInputChars({
      text: ["abcd", "ef"],
      prompt: "ghi",
      messages: [{ role: "user", content: "jklm" }],
    })).toBe(13);
  });

  it("records successful AI calls without changing classifier behavior", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);

    const result = await classifyEntry("A durable decision worth remembering.", env);

    expect(result.importance).toBe(3);
    expect(db.usageEvents).toHaveLength(1);
    expect(db.usageEvents[0]).toMatchObject({
      operation: "classify",
      model: "@cf/meta/llama-4-scout-17b-16e-instruct",
      status: "success",
      max_output_tokens: 80,
    });
    expect(db.usageEvents[0].input_chars).toBeGreaterThan(0);
  });

  it("summarizes usage estimates by operation", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);

    await recordAiUsageEvent(env, {
      operation: "embedding",
      model: "@cf/baai/bge-small-en-v1.5",
      status: "success",
      inputChars: 400,
      maxOutputTokens: 0,
      durationMs: 12,
      createdAt: 1000,
    });
    await recordAiUsageEvent(env, {
      operation: "synthesize_insight",
      model: "@cf/meta/llama-4-scout-17b-16e-instruct",
      status: "success",
      inputChars: 800,
      maxOutputTokens: 300,
      durationMs: 34,
      createdAt: 1100,
    });

    const summary = await summarizeAiUsage(env, { after: 0, before: 2000 }) as any;

    expect(summary.totals.events).toBe(2);
    expect(summary.totals.estimated_input_tokens).toBe(300);
    expect(summary.totals.estimated_output_tokens_upper).toBe(300);
    expect(summary.totals.estimated_neurons_upper).toBeGreaterThan(0);
    expect(summary.by_operation.map((g: any) => g.operation)).toEqual([
      "embedding",
      "synthesize_insight",
    ]);
  });

  it("requires auth for HTTP usage summary", async () => {
    const env = makeTestEnv(makeTestDb());

    const res = await worker.fetch(req("GET", "/usage?after=0&before=2000", { token: null }), env, ctx);

    expect(res.status).toBe(401);
  });

  it("returns HTTP usage summary when authorized", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);
    await recordAiUsageEvent(env, {
      operation: "embedding",
      model: "@cf/baai/bge-small-en-v1.5",
      status: "success",
      inputChars: 40,
      maxOutputTokens: 0,
      durationMs: 5,
      createdAt: 1000,
    });

    const res = await worker.fetch(req("GET", "/usage?after=0&before=2000"), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.free_plan.workers_ai_neurons_per_utc_day).toBe(10000);
    expect(data.totals.events).toBe(1);
    expect(data.by_operation[0].operation).toBe("embedding");
  });
});
