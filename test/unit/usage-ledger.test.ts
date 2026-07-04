import { describe, expect, it, vi } from "vitest";
import worker, {
  buildMcpServer,
  classifyEntry,
  estimateAiInputChars,
  getTodayEstimatedNeurons,
  NeuronBudgetExceededError,
  recordAiUsageEvent,
  recallEntries,
  summarizeAiUsage,
} from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;
const LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

function seedUsageEvent(
  db: D1Mock,
  overrides: Partial<{
    operation: string;
    model: string;
    status: "success" | "error" | "blocked";
    input_chars: number;
    max_output_tokens: number;
    duration_ms: number;
    metadata: string;
    created_at: number;
  }> = {},
): void {
  db.usageEvents.push({
    id: crypto.randomUUID(),
    operation: "seed",
    model: LLM_MODEL,
    status: "success",
    input_chars: 0,
    max_output_tokens: 1000,
    duration_ms: 1,
    error: null,
    metadata: "{}",
    created_at: Date.now(),
    ...overrides,
  });
}

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

  it("leaves the AI gate disabled when the budget var is unset", async () => {
    const db = makeTestDb();
    seedUsageEvent(db);
    const env = makeTestEnv(db);

    await classifyEntry("This should still classify with no budget configured.", env);

    expect(env.AI.run).toHaveBeenCalled();
    expect(db.usageEvents.some(e => e.status === "blocked")).toBe(false);
  });

  it("allows AI calls under an enabled daily budget without recording blocked events", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db, { NEURON_DAILY_BUDGET: "8000" });

    await classifyEntry("This is comfortably under budget.", env);

    expect(env.AI.run).toHaveBeenCalled();
    expect(db.usageEvents.some(e => e.status === "blocked")).toBe(false);
  });

  it("blocks AI calls at or above the daily budget before Workers AI runs", async () => {
    const db = makeTestDb();
    seedUsageEvent(db);
    const env = makeTestEnv(db, { NEURON_DAILY_BUDGET: "1" });

    await expect(recallEntries({ query: "budget check", topK: 5 }, env, ctx))
      .rejects.toThrow(NeuronBudgetExceededError);

    expect(env.AI.run).not.toHaveBeenCalled();
    const blocked = db.usageEvents.filter(e => e.status === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      operation: "embedding",
      model: "none",
      input_chars: 0,
      max_output_tokens: 0,
    });
    expect(JSON.parse(blocked[0].metadata)).toMatchObject({
      blocked_model: "@cf/baai/bge-small-en-v1.5",
      budget: 1,
    });
    expect(JSON.parse(blocked[0].metadata).estimated_today).toBeGreaterThanOrEqual(1);
  });

  it("does not add estimated neurons for the blocked marker event", async () => {
    const db = makeTestDb();
    seedUsageEvent(db);
    const env = makeTestEnv(db, { NEURON_DAILY_BUDGET: "1" });
    const before = await getTodayEstimatedNeurons(env);

    await expect(recallEntries({ query: "budget check", topK: 5 }, env, ctx))
      .rejects.toThrow(NeuronBudgetExceededError);

    expect(await getTodayEstimatedNeurons(env)).toBe(before);
    const summary = await summarizeAiUsage(env, { after: 0, before: Date.now() }) as any;
    const blockedGroup = summary.by_operation.find((g: any) => g.status === "blocked");
    expect(blockedGroup).toMatchObject({
      model: "none",
      estimated_neurons_upper: 0,
    });
  });

  it("fails open when the budget check usage read fails", async () => {
    class FailingUsageReadDb extends D1Mock {
      override prepare(sql: string) {
        if (sql.includes("FROM usage_events")) throw new Error("usage read failed");
        return super.prepare(sql);
      }
    }
    const db = new FailingUsageReadDb();
    const env = makeTestEnv(db, { NEURON_DAILY_BUDGET: "1" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await classifyEntry("Budget bookkeeping failures should not block AI.", env);

    expect(env.AI.run).toHaveBeenCalled();
    expect(db.usageEvents.some(e => e.status === "blocked")).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns a readable MCP tool response when the budget is exhausted", async () => {
    const db = makeTestDb();
    seedUsageEvent(db);
    const env = makeTestEnv(db, { NEURON_DAILY_BUDGET: "1" });
    const server = buildMcpServer(env, ctx);
    const recallTool = (server as any)._registeredTools.recall;

    const result = await recallTool.handler({ query: "budget check", topK: 5 });

    expect(result.content[0].text).toContain("quota-fallback: daily neuron budget exhausted");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("reports daily budget state in usage summaries", async () => {
    const db = makeTestDb();
    seedUsageEvent(db);
    const env = makeTestEnv(db, { NEURON_DAILY_BUDGET: "1" });

    const summary = await summarizeAiUsage(env, { after: 0, before: Date.now() }) as any;

    expect(summary.budget.daily_neuron_budget).toBe(1);
    expect(summary.budget.estimated_today).toBeGreaterThanOrEqual(1);
    expect(summary.budget.exhausted).toBe(true);
  });

  it("reports a null daily budget when the gate is disabled", async () => {
    const db = makeTestDb();
    seedUsageEvent(db);
    const env = makeTestEnv(db);

    const summary = await summarizeAiUsage(env, { after: 0, before: Date.now() }) as any;

    expect(summary.budget.daily_neuron_budget).toBeNull();
    expect(summary.budget.estimated_today).toBeGreaterThanOrEqual(1);
    expect(summary.budget.exhausted).toBe(false);
  });

  it.each(["0", "not-a-number"])("treats NEURON_DAILY_BUDGET=%s as disabled", async (budget) => {
    const db = makeTestDb();
    seedUsageEvent(db);
    const env = makeTestEnv(db, { NEURON_DAILY_BUDGET: budget });

    await classifyEntry("Invalid budgets should preserve existing behavior.", env);

    expect(env.AI.run).toHaveBeenCalled();
    expect(db.usageEvents.some(e => e.status === "blocked")).toBe(false);
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
