/**
 * A D1 facade over real SQLite, for tests whose subject is the SQL itself.
 *
 * `test/helpers/d1-mock.ts` matches query strings and returns canned rows. That
 * is the right tool for most tests — it is fast and it keeps fixtures obvious —
 * but it cannot evaluate SQL, so anything whose correctness *is* the query is
 * untestable against it. The embedding migration is exactly that: a keyset
 * cursor whose comparison decides whether entries are skipped or repeated, and
 * an aggregate that projects chunk counts with integer division.
 *
 * D1 is SQLite, and `node:sqlite` ships with Node, so those queries can be run
 * for real against the project's two-file reference schema. A wrong comparison then
 * fails the test instead of passing a string match.
 *
 * The schema migration in `src/db/init.ts` is the other case, and the sharper
 * one: `d1-mock`'s `exec()` is a no-op, so it cannot express "that column is
 * already there" or "that table is not" — the two facts the migration now reads
 * before it writes. Against real SQLite a probe that misreports an empty
 * database as migrated leaves the tables uncreated and the next statement fails,
 * which is exactly the regression worth catching. Pass `{ schema: false }` for a
 * database with nothing in it at all.
 *
 * Only the surface the code under test uses is implemented — `prepare`, `bind`,
 * `all`, `first`, `run`, `exec`. Reach for `d1-mock` for everything else.
 */
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { readReferenceSchema } from "./reference-schema";

/**
 * D1 accepts numbered placeholders (`?3`, referenced more than once); some `node:sqlite` builds reject them ("column index out of
 * range"). Rewrite to plain `?` with the bound values expanded in order, which every build takes and SQLite reads the same way:
 * a bare `?` is one past the highest number so far. Quoted text is left alone.
 */
export function positionalParams(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  if (!/\?\d/.test(sql)) return { sql, args };
  const out: unknown[] = [];
  let highest = 0;
  const rewritten = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?(\d+)?/g, (m, n?: string) => {
    if (m[0] !== "?") return m;
    const idx = n ? Number(n) : highest + 1;
    highest = Math.max(highest, idx);
    out.push(args[idx - 1]);
    return "?";
  });
  return { sql: rewritten, args: out };
}

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: unknown[] = [],
    private readonly fixtureMarker?: () => string,
    private readonly enqueue?: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly executed?: (sql: string) => void,
  ) {}

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, args, this.fixtureMarker, this.enqueue, this.executed);
  }

  isRead(): boolean {
    return /^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql);
  }

  /** SQL text retained so batch-aware assertions can inspect its members. */
  sourceSql(): string {
    return this.sql;
  }

  async all(): Promise<{ results: unknown[]; success: true; meta: { rows_written: 0 } }> {
    this.executed?.(this.sql);
    return this.enqueue ? this.enqueue(() => this.allDirect()) : this.allDirect();
  }

  private async allDirect(): Promise<{ results: unknown[]; success: true; meta: { rows_written: 0 } }> {
    const q = positionalParams(this.sql, this.args);
    const rows = this.db.prepare(q.sql).all(...(q.args as never[]));
    // SQLite can prove that this SELECT wrote no rows, but it cannot reproduce
    // Cloudflare D1's billed rows_read (which includes index/table work rather
    // than merely returned rows). Leave rows_read absent instead of inventing it.
    return { results: rows, success: true, meta: { rows_written: 0 } };
  }

  async first(): Promise<unknown | null> {
    this.executed?.(this.sql);
    const q = positionalParams(this.sql, this.args);
    const direct = async () => {
      try { return this.db.prepare(q.sql).get(...(q.args as never[])) ?? null; }
      catch (error) { if (error instanceof Error) error.message += ` SQL: ${q.sql}`; throw error; }
    };
    return this.enqueue ? this.enqueue(direct) : direct();
  }

  async run(): Promise<{ results?: unknown[]; success: true; meta: { rows_written: number; changes: number } }> {
    this.executed?.(this.sql);
    return this.enqueue ? this.enqueue(() => this.runDirect()) : this.runDirect();
  }

  private async runDirect(): Promise<{ results?: unknown[]; success: true; meta: { rows_written: number; changes: number } }> {
    // D1PreparedStatement.run() returns result rows for SELECT statements too.
    // Several budget-focused wrappers deliberately execute every member of a
    // mixed read/write batch through run(); modelling SELECT as a SQLite write
    // discards the identity row and turns every authenticated request into 401.
    if (this.isRead()) {
      const result = await this.allDirect();
      return result as unknown as { success: true; meta: { rows_written: number; changes: number } };
    }
    let { sql, args } = positionalParams(this.sql, [...this.args]);
    const fencedTable = sql.match(/\b(?:INTO|UPDATE)\s+(entries|edges|insight_candidates|vector_cleanup_ops|projects|entry_versions|entries_trash|recall_log)\b/i)?.[1];
    const hasWriteMarker = fencedTable
      ? Boolean(this.db.prepare(`SELECT 1 FROM pragma_table_info('${fencedTable}') WHERE name = 'write_marker'`).get())
      : false;
    if (this.fixtureMarker && hasWriteMarker
      && !/\b(?:write_marker|migration_lease_owner|restore_lease_owner)\b/i.test(sql)) {
      const insert = sql.match(
        /^(\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(?:entries|edges|insight_candidates|vector_cleanup_ops|projects|entry_versions|entries_trash|recall_log)\s*\()([^)]*)(\)\s*VALUES\s*\()([\s\S]*)(\)\s*)$/i,
      );
      if (insert) {
        // 複数VALUES行にも個別のmarkerを発行し、元のbind順を維持する。
        const tuples = `(${insert[4]})`;
        const rewritten: string[] = [];
        const nextArgs: unknown[] = [];
        let depth = 0, quoted = false, start = 0, argOffset = 0, tupleArgs = 0;
        for (let i = 0; i < tuples.length; i++) {
          const c = tuples[i];
          if (c === "'") {
            if (quoted && tuples[i + 1] === "'") { i++; continue; }
            quoted = !quoted;
          }
          if (quoted) continue;
          if (c === "?") tupleArgs++;
          if (c === "(") { if (depth === 0) start = i; depth++; }
          if (c === ")" && --depth === 0) {
            rewritten.push(`${tuples.slice(start, i)}, ?)`);
            nextArgs.push(...args.slice(argOffset, argOffset + tupleArgs), this.fixtureMarker());
            argOffset += tupleArgs;
            tupleArgs = 0;
          }
        }
        sql = `${insert[1]}${insert[2]}, write_marker) VALUES ${rewritten.join(", ")}`;
        args = nextArgs;
      } else {
        const update = sql.match(
          /^(\s*UPDATE\s+(?:entries|edges|insight_candidates|vector_cleanup_ops|projects|entry_versions|entries_trash|recall_log)\s+SET\s+)([\s\S]*?)(\s+WHERE\s+[\s\S]*)?$/i,
        );
        if (update) {
          const setArgCount = (update[2].match(/\?/g) ?? []).length;
          sql = `${update[1]}${update[2]}, write_marker = ?${update[3] ?? ""}`;
          args.splice(setArgCount, 0, this.fixtureMarker());
        }
      }
    }
    // workerd's meta.changes includes trigger and FTS shadow-table writes.
    // SQLite's StatementResult.changes counts only the directly changed rows;
    // total_changes() also counts the indirect writes on this connection.
    const before = (this.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    if (/\bRETURNING\b/i.test(sql)) {
      const rows = this.db.prepare(sql).all(...(args as never[]));
      const after = (this.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
      return { results: rows, success: true, meta: { rows_written: rows.length, changes: after - before } };
    }
    const result = this.db.prepare(sql).run(...(args as never[]));
    const after = (this.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    return { success: true, meta: { rows_written: Number(result.changes), changes: after - before } };
  }
}

export interface SqliteD1 {
  /** Shaped like `env.DB`. */
  db: {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): Promise<void>;
    batch(statements: SqliteStatement[]): Promise<{ results?: unknown[]; success: true; meta: { rows_written: number; changes?: number } }[]>;
    /** Vector id -> the row that listed it, remembered across statements (never counted). */
    __vectorOwners(): Map<string, string>;
  };
  /**
   * prepareしたSQLの台帳。未実行statementやbatch内部のSQLも含み、D1呼び出し回数ではない。
   */
  issued: string[];
  /** D1実行回数の別台帳。batchは1実行、issuedは従来のSQL文台帳を維持する。 */
  executions: string[];
  /** Attach a non-expiring test-only write capability after fixture seeding completes. */
  admitEnv<T extends object>(env: T): T & { WRITE_ADMISSION_TOKEN: string };
  /** Fresh row marker backed by a persistent test-only admission for direct fixture SQL. */
  fixtureMarker(purpose?: "write" | "delete"): string;
  /** 競合を起こす別writerなどのfixture専用削除。runtime SQLの許可検査は迂回しない。 */
  deleteFixtureRows(sql: string, ...args: unknown[]): Promise<void>;
  /** SQL members of each collapsed batch, without changing its one-subrequest count. */
  batches: string[][];
  /** Column names currently on `entries`, straight from SQLite. */
  columns(): string[];
  /** Insert an entry directly, bypassing the capture pipeline. */
  seed(entry: {
    id: string;
    content: string;
    createdAt: number;
    tags?: string[];
    source?: string;
    workspaceId?: string;
    vectorIds?: string[];
    /** Drives the compression and resurfacing rules; defaults to 0. */
    importanceScore?: number;
    /** Stated validity window (T-0089.2.1); both default to NULL (open, since created_at). */
    validFrom?: number | null;
    validUntil?: number | null;
  }): void;
  /** Every row, for assertions about what the code under test wrote. */
  rows(): Record<string, unknown>[];
  close(): void;
}

/**
 * A fresh in-memory database with the project's real schema applied.
 *
 * Using the reference schema rather than a hand-written CREATE TABLE means a
 * column rename breaks these tests, which is the point — the migration's SQL
 * names columns.
 */
/**
 * Remove `-- …` line comments, respecting single-quoted string literals so a
 * "--" inside a default value is not mistaken for a comment.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      // Skip to end of line, keeping the newline so line structure survives.
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Split top-level schema statements without cutting semicolons inside triggers. */
export function splitSchemaStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let trigger = false;
  for (const ch of sql) {
    current += ch;
    if (!trigger && /^\s*CREATE\s+TRIGGER\b/i.test(current)) trigger = true;
    if (ch !== ";") continue;
    if (trigger && !/\bEND\s*;\s*$/i.test(current)) continue;
    statements.push(current.slice(0, -1));
    current = "";
    trigger = false;
  }
  if (current.trim()) statements.push(current);
  return statements;
}

export function makeSqliteD1(
  { schema: applySchema = true, autoAdmitFixtureWrites = true }:
  { schema?: boolean; autoAdmitFixtureWrites?: boolean } = {},
): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  const schema = applySchema ? readReferenceSchema(process.env.SB_EVAL_ROOT) : "";
  // Execute as one SQLite script. Splitting on semicolons is not correct once the schema
  // contains CREATE TRIGGER ... BEGIN ...; END blocks: the inner semicolon is part of the
  // statement, not a script boundary.
  if (schema) raw.exec(schema);

  const issued: string[] = [];
  const executions: string[] = [];
  const batches: string[][] = [];
  // One SQLite connection: standalone work waits behind an open batch, while
  // statements the batch itself awaits may run inline. A finished batch's
  // async descendants lose that privilege and rejoin the FIFO queue.
  let tail: Promise<void> = Promise.resolve();
  const activeBatch = new AsyncLocalStorage<{ active: boolean }>();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    if (activeBatch.getStore()?.active) return work();
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  let fixtureToken: string | null = null;
  const ensureFixtureToken = () => {
    if (fixtureToken && raw.prepare("SELECT 1 FROM memory_write_admissions WHERE token = ?").get(fixtureToken)) return fixtureToken;
    const generation = (raw.prepare(
      `SELECT generation FROM memory_write_epoch WHERE id = 'current'`,
    ).get() as { generation?: string } | undefined)?.generation ?? "sqlite-fixture-generation";
    raw.prepare(
      `INSERT INTO memory_write_epoch (id, generation) VALUES ('current', ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(generation);
    fixtureToken = `sqlite-fixture-${crypto.randomUUID()}`;
    raw.prepare(
      `INSERT INTO memory_write_admissions (token, started_at, expires_at, generation)
       VALUES (?, ?, ?, ?)`,
    ).run(fixtureToken, Date.now(), Number.MAX_SAFE_INTEGER, generation);
    return fixtureToken;
  };
  const runBatch = async (statements: SqliteStatement[]) => {
    const out: ({ results: unknown[]; success: true; meta: { rows_written: 0 } }
      | { success: true; meta: { rows_written: number; changes: number } })[] = [];
    raw.exec("BEGIN");
    const token = { active: true };
    try {
      await activeBatch.run(token, async () => {
        for (const statement of statements) out.push(await statement.run());
      });
      raw.exec("COMMIT");
      return out;
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    } finally {
      token.active = false;
    }
  };
  // Test-infrastructure reads straight from SQLite, never counted in `issued` (T-0089.1.1).
  const listedVectors = new Map<string, string>();
  const rememberListed = () => {
    for (const table of ["entries", "entries_trash"]) {
      let rows: { id: string; vector_ids: string | null }[] = [];
      try { rows = raw.prepare(`SELECT id, vector_ids FROM ${table}`).all() as typeof rows; } catch { continue; }
      for (const r of rows) {
        let ids: string[] = [];
        try { ids = JSON.parse(r.vector_ids ?? "[]"); } catch { ids = []; }
        for (const v of ids) if (!listedVectors.has(v)) listedVectors.set(v, r.id);
      }
    }
  };
  let savepointCounter = 0;

  return {
    issued,
    executions,
    batches,
    db: {
      prepare: (sql: string) => {
        if (/^\s*(UPDATE entries|DELETE FROM entries|INSERT INTO entries_trash)/i.test(sql)) rememberListed();
        issued.push(sql);
        return new SqliteStatement(
          raw,
          sql,
          [],
          autoAdmitFixtureWrites ? () => `${ensureFixtureToken()}:write:${crypto.randomUUID()}` : undefined,
          enqueue,
          sql => { if (!activeBatch.getStore()?.active) executions.push(sql); },
        );
      },
      /** Vector id -> the row that listed it, remembered across statements; uncounted (see D1Mock.__vectorOwners). */
      __vectorOwners: () => { rememberListed(); return listedVectors; },
      // Present so a whole-Worker request against this facade runs the real
      // initializeDatabase path rather than failing on a missing method. The
      // schema is already applied above; that DDL is idempotent, and the ALTERs
      // raise the same "duplicate column name" D1 does, which init.ts expects.
      exec: async (sql: string) => {
        issued.push(sql);
        executions.push(sql);
        return enqueue(async () => { raw.exec(sql); });
      },
      // D1 executes a batch transactionally in one round trip, but Free's query limit
      // counts every statement. `prepare` has already recorded each statement, so keep
      // those entries intact for budget assertions.
      batch: (statements: SqliteStatement[]) => {
        executions.push("BATCH");
        batches.push(statements.map(s => typeof s.sourceSql === "function" ? s.sourceSql() : (s as unknown as { __inner?: SqliteStatement }).__inner?.sourceSql() ?? "[wrapped D1 statement]"));
        return enqueue(() => runBatch(statements));
      },
    },
    columns() {
      return (raw.prepare(`SELECT name FROM pragma_table_info('entries')`).all() as { name: string }[])
        .map(r => r.name);
    },
    seed({ id, content, createdAt, tags = [], source = "api", workspaceId = "", vectorIds = [], importanceScore = 0, validFrom = null, validUntil = null }) {
      const generation = (raw.prepare(
        `SELECT generation FROM memory_write_epoch WHERE id = 'current'`,
      ).get() as { generation?: string } | undefined)?.generation ?? "sqlite-seed-generation";
      const token = `sqlite-seed-${crypto.randomUUID()}`;
      const now = Date.now();
      raw.prepare(
        `INSERT INTO memory_write_epoch (id, generation) VALUES ('current', ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(generation);
      raw.prepare(
        `INSERT INTO memory_write_admissions (token, started_at, expires_at, generation)
         VALUES (?, ?, ?, ?)`,
      ).run(token, now, Number.MAX_SAFE_INTEGER, generation);
      try {
        const present = new Set((raw.prepare("SELECT name FROM pragma_table_info('entries')").all() as { name: string }[]).map(r => r.name));
        const fields = ["id", "content", "tags", "source", "created_at", "vector_ids", "recall_count", "importance_score", "write_marker"];
        const values: (string | number | null)[] = [id, content, JSON.stringify(tags), source, createdAt, JSON.stringify(vectorIds), 0, importanceScore, `${token}:write:${crypto.randomUUID()}`];
        for (const [field, value] of [["valid_from", validFrom], ["valid_until", validUntil], ["workspace_id", workspaceId]] as const) {
          if (present.has(field)) { fields.push(field); values.push(value); }
        }
        raw.prepare(`INSERT INTO entries (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...values);
      } finally {
        raw.prepare(`DELETE FROM memory_write_admissions WHERE token = ?`).run(token);
      }
    },
    rows() {
      return raw
        .prepare(`SELECT * FROM entries ORDER BY created_at ASC, id ASC`)
        .all() as Record<string, unknown>[];
    },
    deleteFixtureRows(sql: string, ...args: unknown[]): Promise<void> {
      return enqueue(async () => {
        const q = positionalParams(sql, args);
        const match = q.sql.match(/^\s*DELETE\s+FROM\s+(entries|edges|insight_candidates|vector_cleanup_ops|projects|entry_versions|entries_trash|recall_log)\b([\s\S]*)$/i);
        if (!match) throw new Error("fixture削除には保護対象テーブルのDELETEを指定する");
        const token = ensureFixtureToken();
        const ownTransaction = !activeBatch.getStore()?.active;
        if (ownTransaction) raw.exec("BEGIN");
        try {
          raw.prepare(`UPDATE ${match[1]} SET write_marker = ? ${match[2]}`)
            .run(`${token}:delete:${crypto.randomUUID()}`, ...(q.args as never[]));
          raw.prepare(q.sql).run(...(q.args as never[]));
          if (ownTransaction) raw.exec("COMMIT");
        } catch (error) {
          if (ownTransaction) raw.exec("ROLLBACK");
          throw error;
        }
      });
    },
    admitEnv<T extends object>(env: T): T & { WRITE_ADMISSION_TOKEN: string } {
      const generation = (raw.prepare(
        `SELECT generation FROM memory_write_epoch WHERE id = 'current'`,
      ).get() as { generation?: string } | undefined)?.generation ?? "sqlite-admission-generation";
      raw.prepare(
        `INSERT INTO memory_write_epoch (id, generation) VALUES ('current', ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(generation);
      const token = `sqlite-admission-${crypto.randomUUID()}`;
      raw.prepare(
        `INSERT INTO memory_write_admissions (token, started_at, expires_at, generation)
         VALUES (?, ?, ?, ?)`,
      ).run(token, Date.now(), Number.MAX_SAFE_INTEGER, generation);
      // fixtureのenvは従来どおりspread可能にする。runtimeのadmission envは
      // prototypeにbindingを保持するため、そこで取得したcapabilityとは区別する。
      const admitted = { ...env, WRITE_ADMISSION_TOKEN: token } as T & { WRITE_ADMISSION_TOKEN: string };
      return admitted;
    },
    fixtureMarker(purpose = "write") {
      return `${ensureFixtureToken()}:${purpose}:${crypto.randomUUID()}`;
    },
    close() {
      raw.close();
    },
  };
}
