import type { Env } from "../env";

/** Invocation-local SQL accounting, not a D1 billing/CPU meter. No shared state or I/O. */
export const NIGHTLY_D1_FREE_SQL_LIMIT = 50;
export const NIGHTLY_D1_PAID_SQL_LIMIT = 1000;
export const ADMISSION_RELEASE_SQL_RESERVE = 3;

export type NightlyD1ExecutionProfile = "free" | "paid";

/**
 * Cloudflare does not expose the account plan to a Worker. Paid headroom is
 * therefore explicit; absent, mixed-case unknown or misspelled values fail
 * safely to the Free ceiling instead of accidentally overrunning it.
 */
export function resolveNightlyD1SqlLimit(
  env: Pick<Env, "NIGHTLY_D1_EXECUTION_PROFILE">,
): number {
  return env.NIGHTLY_D1_EXECUTION_PROFILE?.trim().toLowerCase() === "paid"
    ? NIGHTLY_D1_PAID_SQL_LIMIT
    : NIGHTLY_D1_FREE_SQL_LIMIT;
}

export class D1BudgetExceededError extends Error {
  constructor() { super("Nightly D1 work deferred: SQL budget exhausted"); this.name = "D1BudgetExceededError"; }
}

type Ledger = { used: number; calls: number; deferred: number; limit: number; decorate?: (env: Env) => Env };
const allocations = new WeakMap<object, SqlAllocation>();
const statements = new WeakMap<object, { inner: D1PreparedStatement; owner: SqlAllocation }>();
const unguardedMethods = new WeakMap<object, Pick<D1Database, "prepare" | "batch" | "exec">>();

/** Capture the native methods before upstream's in-place guard patches this binding. */
export function recordD1BaseEnv(env: Env): Env {
  if (!unguardedMethods.has(env.DB)) {
    unguardedMethods.set(env.DB, {
      prepare: env.DB.prepare.bind(env.DB),
      batch: env.DB.batch.bind(env.DB),
      exec: env.DB.exec.bind(env.DB),
    });
  }
  return env;
}

function budgetBaseEnv(env: Env): Env {
  const methods = unguardedMethods.get(env.DB);
  if (!methods) return env;
  const result = Object.create(env) as Env;
  const db = Object.create(env.DB) as D1Database;
  Object.assign(db, methods);
  Object.defineProperty(result, "DB", { value: db, enumerable: true });
  return result;
}

/** A reservation cannot be spent by sibling tasks while its owner awaits a provider. */
class SqlAllocation {
  private available: number;
  private closed = false;
  constructor(
    readonly raw: D1Database,
    readonly ledger: Ledger,
    amount: number,
    private readonly parent?: SqlAllocation,
  ) { this.available = amount; }

  get remaining(): number { return this.closed ? 0 : this.available; }
  reserve(amount: number): SqlAllocation | null {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("Invalid SQL reservation");
    if (this.closed || amount > this.available) { this.ledger.deferred++; return null; }
    // Synchronous deduction, before the caller can await; siblings cannot double-spend.
    this.available -= amount;
    return new SqlAllocation(this.raw, this.ledger, amount, this);
  }
  charge(amount: number): void {
    if (this.closed || amount > this.available) { this.ledger.deferred++; throw new D1BudgetExceededError(); }
    this.available -= amount;
    this.ledger.used += amount;
    this.ledger.calls++;
  }
  release(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.parent && !this.parent.closed) this.parent.available += this.available;
    this.available = 0;
  }
  database(): D1Database {
    const allocation = this;
    const raw = this.raw;
    const wrap = (inner: D1PreparedStatement): D1PreparedStatement => {
      const statement = new Proxy(inner, {
        get(target, key) {
          // Upstream's guard unwraps __inner before batch(). Keep the counted
          // statement here; this adapter alone unwraps it at the native edge.
          if (key === "__inner") return undefined;
          if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
          if (key === "run" || key === "all" || key === "first" || key === "raw") {
            return async (...args: unknown[]) => {
              allocation.charge(1);
              return (Reflect.get(target, key) as Function).apply(target, args);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      statements.set(statement, { inner, owner: allocation });
      return statement;
    };
    // The proxy target is invocation-local. Upstream's guard assigns prepare
    // and batch in place; those assignments must never mutate the D1 binding.
    const db = new Proxy(Object.create(null) as D1Database, {
      get(target, key, receiver) {
        if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
        if (key === "prepare") return (sql: string) => wrap(raw.prepare(sql));
        if (key === "batch") return async (batch: D1PreparedStatement[]) => {
          const native = batch.map(statement => {
            const wrapped = statements.get(statement);
            if (!wrapped || wrapped.owner !== allocation) throw new TypeError("Mixed SQL reservations in batch");
            return wrapped.inner;
          });
          // Even an empty/invalid batch is a native call; never allow zero-cost dispatch loops.
          allocation.charge(Math.max(1, batch.length));
          return raw.batch(native);
        };
        if (key === "exec") return async (sql: string) => {
          // Conservative for schema/bootstrap only: semicolons in a literal/trigger
          // overcount, never undercount. Prepared/batched domain SQL is exact.
          allocation.charge(Math.max(1, sql.split(";").filter(part => part.trim()).length));
          return raw.exec(sql);
        };
        // A new session would evade this accounting. Nightly paths use the primary
        // binding only; adding a session/export needs an explicitly counted adapter.
        if (key === "withSession" || key === "dump") return () => { throw new TypeError("Unsupported nightly D1 operation"); };
        const value = Reflect.get(raw, key);
        return typeof value === "function" ? value.bind(raw) : value;
      },
      set(target, key, value) { return Reflect.set(target, key, value); },
      defineProperty(target, key, descriptor) { return Reflect.defineProperty(target, key, descriptor); },
    });
    allocations.set(db, allocation);
    return db;
  }
}

function view(env: Env, allocation: SqlAllocation): Env {
  const result = Object.create(env) as Env;
  Object.defineProperty(result, "DB", { value: allocation.database(), enumerable: true });
  const decorated = allocation.ledger.decorate?.(result) ?? result;
  allocations.set(decorated.DB, allocation);
  return decorated;
}

export function createNightlyD1Budget(
  env: Env, limit = resolveNightlyD1SqlLimit(env), decorate?: (budgetEnv: Env) => Env,
) {
  if (!Number.isSafeInteger(limit) || limit < ADMISSION_RELEASE_SQL_RESERVE) throw new RangeError("Invalid nightly SQL limit");
  const ledger: Ledger = { used: 0, calls: 0, deferred: 0, limit, decorate };
  const base = budgetBaseEnv(env);
  const root = new SqlAllocation(base.DB, ledger, limit);
  return { env: view(base, root), stats: () => ({ used: ledger.used, calls: ledger.calls, deferred: ledger.deferred, limit: ledger.limit }) };
}

export function remainingD1Sql(env: Env): number { return allocations.get(env.DB)?.remaining ?? Infinity; }
export function hasD1Budget(env: Env): boolean { return allocations.has(env.DB); }
export function d1WorkWasDeferred(env: Env): boolean { return (allocations.get(env.DB)?.ledger.deferred ?? 0) > 0; }

/** Null means do not start; unbudgeted HTTP/manual callers retain their existing behavior. */
export function reserveD1Sql(env: Env, amount: number): { env: Env; release: () => void } | null {
  const owner = allocations.get(env.DB);
  if (!owner) return { env, release: () => {} };
  const child = owner.reserve(amount);
  return child ? { env: view(env, child), release: () => child.release() } : null;
}
