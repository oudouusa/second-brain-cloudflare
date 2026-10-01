/**
 * Shared metering helpers for the T1/ux-be free-tier budget audit (Second Brain 4.0).
 *
 * Extends the pattern in test/integration/brief-rows-read.workerd.test.ts: a Proxy over a real
 * D1 binding (openD1("workerd") from test/eval/d1.ts, or sqlite-d1 when workerd isn't needed)
 * that records, per statement, meta.rows_read, meta.rows_written, the bound-param count and the
 * statement's own SQL+binding byte size. db.batch() is metered as N member statements (one log
 * entry per member, all sharing one subrequest) so both the "50 D1 statements" and the "1,000
 * Cloudflare-service subrequests per invocation" free-tier ceilings can be checked from the same
 * log (countSubrequests collapses a contiguous batch run back into one subrequest).
 *
 * Also wraps KVNamespace (get/put/delete/list) and counts Ai.run / VectorizeIndex calls.
 */

export interface StatementLog {
  sql: string;
  rows_read: number;
  rows_written: number;
  params: number;
  bytes: number;
  inBatch: boolean;
}

export interface Meter {
  statements: StatementLog[];
  kv: { get: number; put: number; delete: number; list: number };
  ai: number;
  vectorizeUpsert: number;
  vectorizeQuery: number;
  vectorizeDelete: number;
  reset(): void;
  totals(): {
    statementCount: number; // every prepared+run/all/first/batch-member, matches the 50/invocation D1 doc figure
    subrequestCount: number; // every prepare-and-execute, OR one whole batch() call, matches the 1,000/invocation ceiling
    rowsRead: number;
    rowsWritten: number;
    maxParams: number;
    maxRowBytes: number;
    kvOps: number;
    ai: number;
    vectorize: number;
  };
}

function paramBytes(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (typeof v === "string") return Buffer.byteLength(v, "utf8");
  if (typeof v === "number") return 8;
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

function countSubrequests(statements: StatementLog[]): number {
  let n = 0;
  let i = 0;
  while (i < statements.length) {
    n++;
    if (!statements[i].inBatch) { i++; continue; }
    while (i < statements.length && statements[i].inBatch) i++;
  }
  return n;
}

/** Wrap a real D1 binding (workerd or sqlite) so every execution is logged. */
export function meterD1(db: D1Database): { db: D1Database; meter: Meter } {
  const statements: StatementLog[] = [];
  const kv = { get: 0, put: 0, delete: 0, list: 0 };
  const meter: Meter = {
    statements, kv, ai: 0, vectorizeUpsert: 0, vectorizeQuery: 0, vectorizeDelete: 0,
    reset() { statements.length = 0; kv.get = kv.put = kv.delete = kv.list = 0; meter.ai = 0; meter.vectorizeUpsert = 0; meter.vectorizeQuery = 0; meter.vectorizeDelete = 0; },
    totals() {
      return {
        statementCount: statements.length,
        subrequestCount: countSubrequests(statements),
        rowsRead: statements.reduce((n, s) => n + s.rows_read, 0),
        rowsWritten: statements.reduce((n, s) => n + s.rows_written, 0),
        maxParams: statements.reduce((n, s) => Math.max(n, s.params), 0),
        maxRowBytes: statements.reduce((n, s) => Math.max(n, s.bytes), 0),
        kvOps: kv.get + kv.put + kv.delete + kv.list,
        ai: meter.ai,
        vectorize: meter.vectorizeUpsert + meter.vectorizeQuery + meter.vectorizeDelete,
      };
    },
  };

  const note = (sql: string, args: unknown[], r: { meta?: { rows_read?: number; rows_written?: number; changes?: number } }, inBatch: boolean) => {
    const bytes = Buffer.byteLength(sql, "utf8") + args.reduce((n: number, a) => n + paramBytes(a), 0);
    statements.push({
      sql: sql.replace(/\s+/g, " ").trim().slice(0, 90),
      rows_read: r.meta?.rows_read ?? 0,
      rows_written: r.meta?.rows_written ?? r.meta?.changes ?? 0,
      params: args.length,
      bytes,
      inBatch,
    });
  };

  // Every wrapped statement carries its own {sql, args, real} closed over directly (no external
  // map needed): batch() receives these same wrapper objects back and reads their tag off a
  // symbol property instead of calling bind()/run() again.
  const TAG = Symbol("t1-meter");
  const wrapStmt = (real: any, sql: string, args: unknown[] = []): any => {
    const w: any = {
      bind: (...a: unknown[]) => wrapStmt(real.bind(...a), sql, a),
      all: async () => { const r = await real.all(); note(sql, args, r, false); return r; },
      run: async () => { const r = await real.run(); note(sql, args, r, false); return r; },
      first: async (col?: string) => { const r = await real.all(); note(sql, args, r, false); const row = r.results[0] ?? null; return col && row ? row[col] : row; },
      raw: async () => { const r = await real.all(); note(sql, args, r, false); return r.results.map((row: Record<string, unknown>) => Object.values(row)); },
    };
    w[TAG] = { sql, args, real };
    return w;
  };

  const wrapped: any = {
    prepare: (sql: string) => wrapStmt(db.prepare(sql), sql),
    exec: (sql: string) => db.exec(sql),
    dump: (db as any).dump?.bind(db),
    batch: async (stmts: any[]) => {
      const infos = stmts.map(s => s[TAG] ?? { sql: "?", args: [], real: s });
      const results = await db.batch(infos.map((i: any) => i.real));
      infos.forEach((info: any, i: number) => note(info.sql, info.args, results[i], true));
      return results;
    },
  };
  return { db: wrapped as D1Database, meter };
}

export function meterKV(kvns: KVNamespace, meter: Meter): KVNamespace {
  return {
    ...kvns,
    get: (...a: Parameters<KVNamespace["get"]>) => { meter.kv.get++; return (kvns.get as any)(...a); },
    put: (...a: Parameters<KVNamespace["put"]>) => { meter.kv.put++; return (kvns.put as any)(...a); },
    delete: (...a: Parameters<KVNamespace["delete"]>) => { meter.kv.delete++; return (kvns.delete as any)(...a); },
    list: (...a: Parameters<KVNamespace["list"]>) => { meter.kv.list++; return (kvns.list as any)(...a); },
  } as unknown as KVNamespace;
}

export function meterAI(ai: Ai, meter: Meter): Ai {
  return {
    ...ai,
    run: (...a: Parameters<Ai["run"]>) => { meter.ai++; return (ai.run as any)(...a); },
  } as unknown as Ai;
}

export function meterVectorize(v: Vectorize, meter: Meter): Vectorize {
  return {
    ...v,
    upsert: (...a: Parameters<VectorizeIndex["upsert"]>) => { meter.vectorizeUpsert++; return (v.upsert as any)(...a); },
    insert: (...a: Parameters<VectorizeIndex["insert"]>) => { meter.vectorizeUpsert++; return (v.insert as any)(...a); },
    query: (...a: Parameters<VectorizeIndex["query"]>) => { meter.vectorizeQuery++; return (v.query as any)(...a); },
    deleteByIds: (...a: Parameters<VectorizeIndex["deleteByIds"]>) => { meter.vectorizeDelete++; return (v.deleteByIds as any)(...a); },
  } as unknown as Vectorize;
}
