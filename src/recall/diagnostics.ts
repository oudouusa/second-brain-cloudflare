import type { Env } from "../env";
import type { RecallDiagnostics, RecallOperationDiagnostics } from "./types";

function addKnown(total: number | null, value: unknown): number | null {
  if (total === null || typeof value !== "number" || !Number.isFinite(value)) return null;
  return total + value;
}

function initializeOperations(diagnostics: RecallDiagnostics): RecallOperationDiagnostics {
  return diagnostics.operations = {
    aiCalls: 0,
    embeddingCalls: 0,
    vectorizeQueries: 0,
    vectorizeGets: 0,
    d1Statements: 0,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    kvReads: 0,
    kvWrites: 0,
  };
}

function observeD1(database: D1Database, operations: RecallOperationDiagnostics, diagnostics: RecallDiagnostics): D1Database {
  const rawStatements = new WeakMap<object, object>();

  const recordMeta = (result: unknown) => {
    const meta = result && typeof result === "object"
      ? (result as { meta?: Record<string, unknown> }).meta
      : undefined;
    operations.d1RowsRead = addKnown(operations.d1RowsRead, meta?.rows_read);
    operations.d1RowsWritten = addKnown(operations.d1RowsWritten, meta?.rows_written);
  };

  const wrapStatement = (statement: object): object => {
    const wrapped = new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind") {
          return (...args: unknown[]) => wrapStatement(
            (Reflect.get(target, property, receiver) as (...values: unknown[]) => object).apply(target, args),
          );
        }
        // first() returns the bare row with no meta, so rows_read would go unseen. Run it as all() (the same statement,
        // the same rows_read) and hand back what first() would have: the first row, or one column of it.
        if (property === "first") {
          return async (column?: string) => {
            operations.d1Statements += 1;
            const result = await (target as unknown as { all: () => Promise<{ results?: Record<string, unknown>[] }> }).all();
            recordMeta(result);
            // Only single-row statements are safe to run as all(); flag any that would now fetch more than one row.
            if ((result.results?.length ?? 0) > 1) (diagnostics.warnings ??= []).push(`first() statement returned ${result.results!.length} rows: it fetches them all when observed`);
            const row = result.results?.[0] ?? null;
            return column === undefined || row === null ? row : (row[column] ?? null);
          };
        }
        if (property === "all" || property === "run" || property === "raw") {
          return async (...args: unknown[]) => {
            operations.d1Statements += 1;
            const result = await (Reflect.get(target, property, receiver) as (...values: unknown[]) => unknown).apply(target, args);
            recordMeta(result);
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rawStatements.set(wrapped, statement);
    return wrapped;
  };

  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql)) as D1PreparedStatement;
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          operations.d1Statements += statements.length;
          const result = await target.batch(statements.map(statement =>
            (rawStatements.get(statement as object) ?? statement) as D1PreparedStatement,
          ));
          for (const item of result) recordMeta(item);
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeMethods<T extends object>(
  target: T,
  counters: Readonly<Record<string, (...args: unknown[]) => void>>,
): T {
  // VECTORIZE is genuinely absent on a brain whose index was never created, and
  // recall degrades to keyword-only around that. Proxying it would throw, which
  // would make observing a recall the thing that broke it — the diagnostics are
  // for reading exactly this path, not for changing whether it works.
  if (target === null || typeof target !== "object") return target;
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof property === "string" && typeof value === "function" && counters[property]) {
        return (...args: unknown[]) => {
          counters[property](...args);
          return value.apply(object, args);
        };
      }
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

/**
 * Wraps existing recall bindings to count operations. The wrappers never start
 * work themselves; each counter advances only when its corresponding binding
 * method is invoked by the ordinary recall path.
 */
export function observeRecallEnv(env: Env, diagnostics: RecallDiagnostics): Env {
  const operations = initializeOperations(diagnostics);
  const observedAi = observeMethods(env.AI, {
      run: (_model: unknown, input: unknown) => {
        operations.aiCalls += 1;
        if (input && typeof input === "object" && Array.isArray((input as { text?: unknown }).text)) {
          operations.embeddingCalls += 1;
        }
      },
    });
  const observedVectorize = observeMethods(env.VECTORIZE, {
      query: () => { operations.vectorizeQueries += 1; },
      getByIds: () => { operations.vectorizeGets += 1; },
    });
  const observedDb = observeD1(env.DB, operations, diagnostics);
  const observedKv = observeMethods(env.OAUTH_KV, {
      get: () => { operations.kvReads += 1; },
      getWithMetadata: () => { operations.kvReads += 1; },
      list: () => { operations.kvReads += 1; },
      put: () => { operations.kvWrites += 1; },
      delete: () => { operations.kvWrites += 1; },
    });

  // Keep platform host bindings on the original request-scoped env object.
  return new Proxy(Object.create(env) as Env, {
    get(target, property) {
      if (property === "AI") return observedAi;
      if (property === "VECTORIZE") return observedVectorize;
      if (property === "DB") return observedDb;
      if (property === "OAUTH_KV") return observedKv;
      return Reflect.get(target, property, target);
    },
  }) as Env;
}
