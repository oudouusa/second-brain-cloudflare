import { describe, it, expect, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  createNightlyD1Budget, reserveD1Sql, remainingD1Sql, hasD1Budget,
  d1WorkWasDeferred, D1BudgetExceededError, resolveNightlyD1SqlLimit,
  NIGHTLY_D1_FREE_SQL_LIMIT, NIGHTLY_D1_PAID_SQL_LIMIT,
} from "../../src/runtime/d1-budget";
import { sanitizeConsoleArguments } from "../../src/lib/observability";

function fixture() {
  const dispatched = vi.fn(async () => ({ success: true, results: [], meta: { changes: 0 } }));
  const statement = (): any => ({ bind: () => statement(), run: dispatched, all: dispatched,
    first: dispatched, raw: dispatched });
  const DB = { prepare: () => statement(), batch: dispatched, exec: dispatched } as unknown as D1Database;
  const env = { DB, CHATGPT_MODEL: "private-fixture" } as Env;
  Object.defineProperty(env, "WRITE_ADMISSION_TOKEN", { value: "private-capability" });
  return { env, dispatched };
}

describe("invocation-local nightly SQL reservations", () => {
  it.each([
    [undefined, NIGHTLY_D1_FREE_SQL_LIMIT],
    ["free", NIGHTLY_D1_FREE_SQL_LIMIT],
    [" FREE ", NIGHTLY_D1_FREE_SQL_LIMIT],
    ["unknown", NIGHTLY_D1_FREE_SQL_LIMIT],
    ["paid", NIGHTLY_D1_PAID_SQL_LIMIT],
    [" PAID ", NIGHTLY_D1_PAID_SQL_LIMIT],
  ])("selects an explicit execution profile %s with a fail-safe default", (profile, expected) => {
    const { env } = fixture();
    env.NIGHTLY_D1_EXECUTION_PROFILE = profile;
    expect(resolveNightlyD1SqlLimit(env)).toBe(expected);
    expect(createNightlyD1Budget(env).stats().limit).toBe(expected);
  });

  it("keeps hidden admission and provider bindings, without mutating the original Env", () => {
    const { env } = fixture(); const b = createNightlyD1Budget(env);
    expect(b.env.WRITE_ADMISSION_TOKEN).toBe("private-capability");
    expect(b.env.CHATGPT_MODEL).toBe("private-fixture");
    expect(b.env.DB).not.toBe(env.DB);
    expect(hasD1Budget(env)).toBe(false); expect(hasD1Budget(b.env)).toBe(true);
    expect(remainingD1Sql(env)).toBe(Infinity);
  });

  it("keeps prepare and batch overrides local to each budget proxy", async () => {
    const { env, dispatched } = fixture();
    const rawPrepare = env.DB.prepare;
    const rawBatch = env.DB.batch;
    const budget = createNightlyD1Budget(env, 8);
    const sibling = reserveD1Sql(budget.env, 3)!;
    const replacement = vi.fn(() => budget.env.DB.prepare("unused"));
    // Upstream's guard uses assignment; other callers may define a method.
    budget.env.DB.prepare = replacement as D1Database["prepare"];
    Object.defineProperty(budget.env.DB, "batch", { value: vi.fn(), configurable: false });
    expect(budget.env.DB.prepare).toBe(replacement);
    expect(env.DB.prepare).toBe(rawPrepare);
    expect(env.DB.batch).toBe(rawBatch);
    expect(sibling.env.DB.prepare).not.toBe(replacement);
    await sibling.env.DB.prepare("SELECT 1").first();
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(remainingD1Sql(sibling.env)).toBe(2);
    sibling.release();
  });

  it("reserves before awaiting and cannot double-spend across parallel tasks", async () => {
    const { env, dispatched } = fixture(); const b = createNightlyD1Budget(env, 5);
    const final = reserveD1Sql(b.env, 3)!;
    const tasks = Array.from({ length: 8 }, () => b.env.DB.prepare("SELECT secret").first());
    const results = await Promise.allSettled(tasks);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(dispatched).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 3; i++) await final.env.DB.prepare("DELETE finalizer").run();
    expect(b.stats()).toEqual({ used: 5, calls: 5, deferred: 6, limit: 5 });
    expect(d1WorkWasDeferred(b.env)).toBe(true);
  });

  it("rejects an entire batch before dispatch; counts its SQL separately from calls", async () => {
    const { env, dispatched } = fixture(); const b = createNightlyD1Budget(env, 5);
    await b.env.DB.batch([b.env.DB.prepare("A"), b.env.DB.prepare("B"), b.env.DB.prepare("C")]);
    expect(b.stats()).toMatchObject({ used: 3, calls: 1 });
    await expect(b.env.DB.batch(Array.from({ length: 3 }, () => b.env.DB.prepare("D"))))
      .rejects.toBeInstanceOf(D1BudgetExceededError);
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(remainingD1Sql(b.env)).toBe(2);
  });

  it("does not permit unbounded zero-cost empty batch calls", async () => {
    const { env, dispatched } = fixture(); const b = createNightlyD1Budget(env, 3);
    for (let i = 0; i < 3; i++) await b.env.DB.batch([]);
    await expect(b.env.DB.batch([])).rejects.toBeInstanceOf(D1BudgetExceededError);
    expect(dispatched).toHaveBeenCalledTimes(3); expect(b.stats()).toMatchObject({ used: 3, calls: 3 });
  });

  it("failed native calls still consume their reserved SQL", async () => {
    const { env, dispatched } = fixture(); const b = createNightlyD1Budget(env, 3);
    dispatched.mockRejectedValueOnce(new Error("synthetic DB failure"));
    await expect(b.env.DB.prepare("A").run()).rejects.toThrow("synthetic");
    expect(remainingD1Sql(b.env)).toBe(2);
    await b.env.DB.prepare("B").bind(1).all(); await b.env.DB.prepare("C").raw();
    await expect(b.env.DB.prepare("D").run()).rejects.toBeInstanceOf(D1BudgetExceededError);
    expect(dispatched).toHaveBeenCalledTimes(3);
  });

  it("refunds only unspent reservations and release is idempotent", async () => {
    const { env } = fixture(); const b = createNightlyD1Budget(env, 10);
    const child = reserveD1Sql(b.env, 6)!; const grand = reserveD1Sql(child.env, 3)!;
    await grand.env.DB.prepare("A").run(); grand.release(); grand.release();
    expect(remainingD1Sql(child.env)).toBe(5);
    child.release(); child.release(); expect(remainingD1Sql(b.env)).toBe(9);
    expect(reserveD1Sql(child.env, 1)).toBe(null);
    await expect(child.env.DB.prepare("B").run()).rejects.toBeInstanceOf(D1BudgetExceededError);
    expect(b.stats().used).toBe(1);
  });

  it("does not resurrect a released parent when a late child releases", async () => {
    const { env } = fixture(); const b = createNightlyD1Budget(env, 10);
    const child = reserveD1Sql(b.env, 6)!; const grand = reserveD1Sql(child.env, 3)!;
    child.release(); grand.release(); expect(remainingD1Sql(b.env)).toBe(7);
    // No overspend; unused child credit is deliberately not resurrected through a closed parent.
    expect(remainingD1Sql(child.env)).toBe(0);
  });

  it("cannot mix raw statements or a sibling reservation in a batch", async () => {
    const { env, dispatched } = fixture(); const b = createNightlyD1Budget(env, 5);
    const child = reserveD1Sql(b.env, 2)!;
    await expect(b.env.DB.batch([child.env.DB.prepare("A")])).rejects.toThrow("Mixed");
    await expect(b.env.DB.batch([env.DB.prepare("B")])).rejects.toThrow("Mixed");
    expect(dispatched).not.toHaveBeenCalled(); expect(b.stats().used).toBe(0);
  });

  it("counts exec conservatively and refuses uncounted session/export escapes", async () => {
    const { env, dispatched } = fixture(); const b = createNightlyD1Budget(env, 5);
    await b.env.DB.exec("SELECT 1; SELECT 'a;b';");
    expect(b.stats().used).toBe(3);
    expect(() => b.env.DB.withSession()).toThrow("Unsupported");
    expect(() => b.env.DB.dump()).toThrow("Unsupported");
    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it.each([NaN, Infinity, -1, 2, 3.5])("rejects invalid total budget %s", limit => {
    expect(() => createNightlyD1Budget(fixture().env, limit)).toThrow(RangeError);
  });
  it.each([NaN, Infinity, -1, 0.1])("rejects invalid reservation %s", size => {
    expect(() => reserveD1Sql(createNightlyD1Budget(fixture().env).env, size)).toThrow(RangeError);
  });

  it("does not change unbudgeted request/manual behavior", async () => {
    const { env, dispatched } = fixture(); const a = reserveD1Sql(env, 1000)!;
    expect(a.env).toBe(env); a.release();
    await env.DB.prepare("A").run(); expect(dispatched).toHaveBeenCalledTimes(1);
    expect(d1WorkWasDeferred(env)).toBe(false);
  });

  it("budget diagnostics accept counters, never SQL, credentials or workspace ids", () => {
    const clean = JSON.stringify({ event: "nightly_budget", used: 48, calls: 35, deferred: 2, limit: 50 });
    expect(sanitizeConsoleArguments("log", [clean])).toEqual([clean]);
    for (const key of ["workspaceId", "sql", "token", "content"]) {
      const result = sanitizeConsoleArguments("log", [JSON.stringify({ event: "nightly_budget", [key]: "private-fixture" })]);
      expect(result.join()).not.toContain("private-fixture");
    }
    expect(new D1BudgetExceededError().message).not.toContain("private");
  });
});
