/**
 * Pins /import's D1 subrequest cost per invocation, driven against real SQLite.
 *
 * The endpoint exists to migrate a brain, and this codebase holds itself to a
 * self-imposed budget of roughly 50 D1 calls per Worker invocation (the
 * platform's real free-plan ceiling is 1,000 D1/KV/Vectorize calls per
 * invocation, kept far tighter here for cost and 10 ms-CPU reasons). The
 * paging design holds the per-call cost flat — one chunked existence lookup
 * plus one insert batch per page, regardless of file size or how far in the
 * cursor is. An earlier version resolved ids lazily, one query per entry and
 * two per edge, which spent the whole self-imposed budget partway through a
 * real restore (measured: 201 round trips for page 5 of a 5,000-entry
 * export). These tests are what keeps that from coming back.
 *
 * Counting: `issued` logs binding round trips and collapses DB.batch() to one subrequest.
 * D1's separate 50-query limit counts every statement inside that batch, so the suite
 * also asserts the explicit worst-case query formula.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { importExportPayload, IMPORT_DEFAULT_LIMIT, IMPORT_MAX_LIMIT, IMPORT_MANUAL_WRITE_BUDGET } from "../../src/entries/import";
import type { Env } from "../../src/env";
import { memoryWriteMarker } from "../../src/migration/write-lock";
import { INTEGRATION_PROVIDERS } from "../../src/integrations";

let sq: SqliteD1 | null = null;
afterEach(() => { vi.restoreAllMocks(); sq?.close(); sq = null; setDbReady(false); });

function envOf(s: SqliteD1): Env {
  return s.admitEnv({
    DB: {
      prepare: (sql: string) => s.db.prepare(sql),
      exec: (sql: string) => s.db.exec(sql),
      async batch(stmts: { run(): Promise<unknown> }[]) {
        const out = [];
        for (const st of stmts) out.push(await st.run());
        return out;
      },
    },
  } as unknown as Env);
}

/** Fresh DB with the runtime ALTERs applied, subrequest log cleared. */
async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase(envOf(s));
  s.issued.length = 0;
  return s;
}

const MANUAL_NORMAL_PAGE = Math.floor(IMPORT_MANUAL_WRITE_BUDGET / 8);

const entry = (i: number) => ({
  id: `id-${i}`,
  content: `content ${i}`,
  created_at: 1_700_000_000_000 + i,
});

describe("/import subrequest budget (D1 free plan: ~50 per invocation)", () => {
  it("caps public pages so batch statements remain below 50 D1 queries", () => {
    const D1_FREE_QUERY_LIMIT = 50;
    // Manual import: schema probe + admission cleanup/insert + barrier + lookup +
    // A failed batch is still N attempted D1 queries, then fallback retries N more.
    // Restore adds acquire/renew/commit coordination around the same worst case.
    expect(1 + 2 + 1 + 1 + 2 * IMPORT_MAX_LIMIT + 1).toBeLessThanOrEqual(D1_FREE_QUERY_LIMIT);
    // Fresh final restore with a failed atomic batch is the expensive path:
    // schema probe + preflight ledger read + every provider generation read +
    // 6 acquire/claim statements + barrier + lookup + pre-batch renew + N failed
    // statements + fallback renew + N retries + count + commit renew + 3 atomic
    // commit statements + release. Keep two-query headroom below 50.
    // R2 restore checks every registered provider before acquiring its lease;
    // each load performs one strong D1 generation read.
    expect(Object.keys(INTEGRATION_PROVIDERS)).toHaveLength(6);
    const restoreColdPageWorst = 1 + 1 + Object.keys(INTEGRATION_PROVIDERS).length + 6
      + 1 + 1 + 1 + IMPORT_MAX_LIMIT + 1 + IMPORT_MAX_LIMIT + 1 + 1 + 3 + 1;
    expect(restoreColdPageWorst).toBeLessThanOrEqual(D1_FREE_QUERY_LIMIT);
    // An interrupted restore can additionally repair the integration singleton:
    // one bounded UPDATE plus one singleton re-read. The default page must leave
    // exactly this two-query recovery headroom on the Free plan.
    expect(restoreColdPageWorst + 2).toBeLessThanOrEqual(D1_FREE_QUERY_LIMIT);
    expect(IMPORT_MAX_LIMIT).toBe(IMPORT_DEFAULT_LIMIT);
  });
  it("a fresh default page costs one lookup and one batch", async () => {
    sq = await migrated();
    const entries = Array.from({ length: IMPORT_DEFAULT_LIMIT }, (_, i) => entry(i));
    const summary = await importExportPayload(envOf(sq), { entries }, {});

    expect(summary.imported).toBe(MANUAL_NORMAL_PAGE);
    expect(sq.rows()).toHaveLength(MANUAL_NORMAL_PAGE);
    // 1 cutover-lock read + 1 existence lookup + N insert statements.
    expect(sq.issued).toHaveLength(5 + MANUAL_NORMAL_PAGE);
  });

  it("a rejected batch plus every per-row fallback remains below 50 D1 queries", async () => {
    sq = await migrated();
    const baseEnv = envOf(sq);
    baseEnv.DB.batch = sq.db.batch as unknown as D1Database["batch"];
    const realBatch = baseEnv.DB.batch.bind(baseEnv.DB);
    let rejected = false;
    baseEnv.DB.batch = async (statements: Parameters<D1Database["batch"]>[0]) => {
      if (!rejected) {
        rejected = true;
        const breaker = baseEnv.DB.prepare(
          `INSERT INTO entries (id, write_marker) VALUES (NULL, ?)`,
        ).bind(memoryWriteMarker(baseEnv));
        return realBatch([...statements, breaker] as Parameters<D1Database["batch"]>[0]);
      }
      return realBatch(statements);
    };
    const entries = Array.from({ length: IMPORT_DEFAULT_LIMIT }, (_, i) => entry(i));

    const summary = await importExportPayload(baseEnv, { entries }, {});

    expect(summary.imported).toBe(MANUAL_NORMAL_PAGE);
    expect(sq.issued).toHaveLength(6 + 4 * MANUAL_NORMAL_PAGE);
    expect(sq.issued.length).toBeLessThan(50);
  });

  it.each([false, true])("全retryが失敗してもhold=%sの書込み予算を超えずcursorは進む", async held => {
    sq = await migrated();
    const env = envOf(sq);
    let attempted = 0;
    env.DB.batch = async stmts => {
      attempted += stmts.length;
      throw new Error("temporary failure");
    };
    const entries = Array.from({ length: IMPORT_DEFAULT_LIMIT }, (_, i) => ({
      ...entry(i), ...(held ? { tags: ["quarantine:instruction"] } : {}),
    }));
    const summary = await importExportPayload(env, { entries });
    const examined = held ? 1 : MANUAL_NORMAL_PAGE;
    expect(summary.next_offset).toBe(examined);
    expect(summary.remaining_entries).toBe(entries.length - examined);
    expect(summary.failed).toBe(examined);
    // batch内各statement、barrier/live/trash/duplicate照合、HTTP schema/admissionも数える。
    // issuedはprepare時点でbatch内statementも数えるためattemptedは加算しない。
    expect(attempted).toBeGreaterThan(0);
    expect(sq.issued.length + 3).toBeLessThanOrEqual(50);
  });

  it("holdを含む大きいファイルもcursorで最後まで原子的に取り込める", async () => {
    sq = await migrated();
    const env = envOf(sq);
    const entries = Array.from({ length: 15 }, (_, i) => ({
      ...entry(i), ...(i % 2 ? { tags: ["quarantine:instruction"] } : {}),
    }));
    let offset = 0;
    let imported = 0;
    while (offset < entries.length) {
      sq.issued.length = 0;
      const page = await importExportPayload(env, { entries }, { offset });
      expect(page.next_offset).toBeGreaterThan(offset);
      expect(sq.issued.length + 3).toBeLessThanOrEqual(50);
      offset = page.next_offset;
      imported += page.imported;
    }
    expect(imported).toBe(entries.length);
    expect(sq.rows()).toHaveLength(entries.length);
  });

  for (const kind of ["entry", "edge"] as const) {
    it.each(["transient", "fence", "hook"])(`${kind} batch失敗%sで結果形式・再試行順序・停止を維持する`, async (failure) => {
      sq = await migrated();
      const env = envOf(sq);
      for (let i = 0; i < 3; i++) sq.seed({ id: `seed-${i}`, content: "seed", createdAt: 1 });
      const trace: string[] = [];
      const prefix = kind === "entry" ? "INSERT INTO entries" : "INSERT INTO edges";
      const prepare = env.DB.prepare.bind(env.DB);
      vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
        const statement = prepare(sql);
        if (!sql.startsWith(prefix)) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          const bound = bind(...values);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            trace.push("row");
            if (trace.filter(x => x === "row").length >= 2) throw new Error("individual failure");
            return run();
          };
          return bound;
        };
        return statement;
      });
      const failureError = new Error(failure === "fence" ? "D1: MeMoRy-WrItE-LoCkEd" : "temporary");
      const realBatch = env.DB.batch.bind(env.DB);
      let attempts = 0;
      vi.spyOn(env.DB, "batch").mockImplementation(async stmts => {
        trace.push("batch");
        if (++attempts === 1 || kind === "edge") throw failureError;
        return realBatch(stmts);
      });
      const options = {
        async beforeWriteBatch() {
          expect(this).toBe(options);
          trace.push("hook");
          if (failure === "hook" && trace.length > 1) throw new Error("lease lost");
        },
      };
      const body = kind === "entry" ? { entries: [entry(10), entry(11)] } : {
        entries: [], edges: [
          { source_id: "seed-0", target_id: "seed-1", type: "relates_to" },
          { source_id: "seed-1", target_id: "seed-2", type: "relates_to" },
        ],
      };
      const result = importExportPayload(env, body, options);
      if (failure === "fence") {
        await expect(result).rejects.toBe(failureError);
        expect(trace).toEqual(["hook", "batch"]);
      } else if (failure === "hook") {
        await expect(result).rejects.toThrow("lease lost");
        expect(trace).toEqual(["hook", "batch", "hook"]);
      } else {
        const summary = await result;
        expect(trace).toEqual(kind === "entry"
          ? ["hook", "batch", "hook", "batch", "row", "batch", "row", "batch", "row"]
          : ["hook", "batch", "hook", "row", "row"]);
        expect(summary).toMatchObject(kind === "entry"
          ? { imported: 1, failed: 1 } : { edges_imported: 1, edges_failed: 1 });
        expect(summary.results.map(row => row.status)).toEqual(["imported", "failed"]);
        expect(summary.results[1]).toMatchObject({
          reason: kind === "entry" ? "insert_error" : "create_failed", detail: "individual failure",
        });
      }
    });
  }

  it("a late page of a large export costs the same as the first page", async () => {
    sq = await migrated();
    for (let i = 0; i < 160; i++) {
      sq.seed({ id: `id-${i}`, content: `content ${i}`, createdAt: 1_700_000_000_000 + i });
    }
    sq.issued.length = 0;

    const entries = Array.from({ length: 5000 }, (_, i) => entry(i));
    const summary = await importExportPayload(envOf(sq), { entries }, { offset: 160 });

    expect(summary.imported).toBe(MANUAL_NORMAL_PAGE);
    expect(summary.next_offset).toBe(160 + MANUAL_NORMAL_PAGE);
    expect(summary.remaining_entries).toBe(5000 - 160 - MANUAL_NORMAL_PAGE);
    expect(sq.rows()).toHaveLength(160 + MANUAL_NORMAL_PAGE);
    // Position in the file must not change the price: lock + lookup + batch.
    expect(sq.issued).toHaveLength(5 + MANUAL_NORMAL_PAGE);
  });

  it("an edges-only page stays in single digits", async () => {
    sq = await migrated();
    for (let i = 0; i < 41; i++) {
      sq.seed({ id: `id-${i}`, content: `content ${i}`, createdAt: 1_700_000_000_000 + i });
    }
    sq.issued.length = 0;

    const edges = Array.from({ length: 40 }, (_, i) => ({
      source_id: `id-${i}`,
      target_id: `id-${i + 1}`,
      type: "relates_to",
    }));
    const summary = await importExportPayload(envOf(sq), { entries: [], edges }, {});

    expect(summary.edges_imported).toBe(IMPORT_DEFAULT_LIMIT);
    // 1 cutover-lock read + 1 endpoint lookup + 1 edge-key lookup + 1 batch.
    expect(sq.issued).toHaveLength(3 + IMPORT_DEFAULT_LIMIT);
  });

  it("a rerun of an already-imported page is two lookups and no writes", async () => {
    sq = await migrated();
    const entries = Array.from({ length: IMPORT_DEFAULT_LIMIT }, (_, i) => entry(i));
    await importExportPayload(envOf(sq), { entries }, {});
    sq.issued.length = 0;

    const summary = await importExportPayload(envOf(sq), { entries }, {});
    expect(summary.skipped).toBe(MANUAL_NORMAL_PAGE);
    expect(summary.imported).toBe(0);
    // The cutover-lock read remains even when all entry ids already exist.
    expect(sq.issued).toHaveLength(3);
  });
});

describe("/import on a freshly deployed brain", () => {
  it("accepts an import immediately against the complete reference schema", async () => {
    sq = makeSqliteD1();
    resetDatabaseInit();
    setDbReady(true);
    const env = makeTestEnv(envOf(sq).DB as any);
    const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

    const res = await worker.fetch(req("POST", "/import", {
      body: { version: 2, entries: [{ id: "first", content: "First ever request", created_at: 1000 }] },
    }), env, ctx);

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.imported).toBe(1);
    expect(data.failed).toBe(0);
    expect(sq.rows()).toHaveLength(1);
    expect(sq.columns()).toContain("updated_at");
  });
});
