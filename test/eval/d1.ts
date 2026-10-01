import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readReferenceSchema } from "../helpers/reference-schema";
import { makeSqliteD1, splitSchemaStatements, stripSqlComments } from "../helpers/sqlite-d1";

export interface EvalD1 { db: D1Database; kind: "sqlite" | "workerd"; close(): Promise<void> }

// Read per call so SB_EVAL_ROOT (set by the bundled CLI) is honored whenever it is set.
const root = () => process.env.SB_EVAL_ROOT ?? resolve(import.meta.dirname, "../..");

/** The repo's own compatibility_date, so the workerd backend measures the runtime production runs. */
function compatibilityDate(): string {
  const found = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(readFileSync(join(root(), "wrangler.jsonc"), "utf8"));
  if (!found) throw new Error("wrangler.jsonc has no compatibility_date");
  return found[1];
}

export async function openD1(kind: "sqlite" | "workerd"): Promise<EvalD1> {
  if (kind === "sqlite") {
    const sqlite = makeSqliteD1();
    return { db: sqlite.db as unknown as D1Database, kind, close: async () => sqlite.close() };
  }
  // workerd: wrangler's local D1 (real rows_read in meta). Local only: no remote binding, throwaway state dir.
  const schema = readReferenceSchema(root());
  const compatibility_date = compatibilityDate();
  const { getPlatformProxy } = await import("wrangler");
  const dir = mkdtempSync(join(tmpdir(), "sb-eval-d1-"));
  let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
  try {
    const configPath = join(dir, "wrangler.jsonc");
    writeFileSync(configPath, JSON.stringify({
      name: "sb-eval",
      compatibility_date,
      d1_databases: [{ binding: "DB", database_name: "sb-eval", database_id: "eval-local-only" }],
    }));
    // remoteBindings: false makes "never a remote D1" structural, not just a property of this config.
    proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath, persist: { path: join(dir, "state") }, remoteBindings: false });
    for (const statement of splitSchemaStatements(stripSqlComments(schema))) {
      const sql = statement.trim();
      if (sql) await proxy.env.DB.prepare(sql).run();
    }
  } catch (e) {
    try { await proxy?.dispose(); } finally { rmSync(dir, { recursive: true, force: true }); }
    throw e;
  }
  const opened = proxy;
  return {
    db: opened.env.DB,
    kind,
    close: async () => {
      try { await opened.dispose(); } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}
