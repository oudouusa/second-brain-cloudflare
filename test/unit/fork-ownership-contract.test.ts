import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVED_NEW_SRC_MODULES, auditWriteFenceSource } from "../../scripts/audit-upstream-sync.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
// Same bounded input format as cron-triggers.test.ts: only whole-line // comments.
// Unsupported JSONC syntax fails loudly instead of silently dropping config fields.
const config = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));
const architecture = read("docs/fork/ARCHITECTURE.md");

function documentedNames(section: string): string[] {
  const start = `<!-- ${section}:start -->`;
  const end = `<!-- ${section}:end -->`;
  expect(architecture.split(start)).toHaveLength(2);
  expect(architecture.split(end)).toHaveLength(2);
  const block = architecture.split(start)[1].split(end)[0];
  const names = [...block.matchAll(/^\| `([A-Z_]+)` \|/gm)].map(match => match[1]);
  expect(new Set(names).size).toBe(names.length);
  return names.sort();
}

describe("fork ownership and current architecture", () => {
  it("documents every currently configured binding without inventing a second registry", () => {
    const bindings: string[] = [
      ...["d1_databases", "vectorize", "kv_namespaces", "r2_buckets", "vpc_services"]
        .flatMap(key => (config[key] ?? []).map((row: { binding: string }) => row.binding)),
      ...(config.durable_objects?.bindings ?? []).map((row: { name: string }) => row.name),
      ...[config.ai?.binding, config.assets?.binding].filter(Boolean),
    ];
    expect(documentedNames("runtime-bindings")).toEqual(bindings.sort());
  });

  it("keeps required deployment secrets separate from runtime-optional TypeScript bindings", () => {
    expect(documentedNames("deployment-secrets")).toEqual([...config.secrets.required].sort());
  });

  it("語彙cacheから移行orchestrationへの逆依存を戻さない", () => {
    const vocabulary = read("src/tags/vocabulary.ts");
    expect(vocabulary).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*migration\/embedding["']/);
    expect(read("src/insight/candidates.ts")).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*migration\/embedding["']/);
    const coordination = read("src/migration/write-lock.ts");
    expect(coordination).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*(?:capture\/|tags\/|migration\/embedding)/);
  });

  it("共通読取がHTTP・認証・providerへ依存しない", () => {
    expect(read("src/lib/body.ts")).not.toMatch(/\b(?:import|require)\s*(?:\(|\{|\*)/);
    expect(read("src/lib/body.ts")).not.toMatch(/\b(?:Response|Env|fetch|setTimeout|setInterval)\s*\(/);
    expect(APPROVED_NEW_SRC_MODULES.has("src/lib/body.ts")).toBe(true);
    expect(read("src/lib/chatgpt.ts")).not.toMatch(/from\s*["']\.\/http["']/);
  });

  it("keeps cleanup below capture and preserves the write-fence audit", () => {
    const source = read("src/vectorize/cleanup.ts");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
    expect(imports.sort()).toEqual(["../constants", "../env", "../migration/write-lock", "../runtime/d1-budget", "./batch"]);
    // Only the invocation-local counter joins the lower layer, never capture/provider orchestration.
    const budget = read("src/runtime/d1-budget.ts");
    expect([...budget.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1])).toEqual(["../env"]);
    expect(budget).not.toMatch(/^import(?!\s+type\b)/m);
    expect(budget).not.toMatch(/\b(?:fetch|require|setInterval|setTimeout)\s*\(/);
    expect(APPROVED_NEW_SRC_MODULES.has("src/runtime/d1-budget.ts")).toBe(true);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(APPROVED_NEW_SRC_MODULES.has("src/vectorize/cleanup.ts")).toBe(true);
    const audit = auditWriteFenceSource(source, "src/vectorize/cleanup.ts");
    expect(audit.mutations).toBeGreaterThan(0);
    expect(audit.failures).toEqual([]);
    const store = read("src/capture/store.ts");
    expect(store).not.toMatch(/(?:function|const)\s+(?:drainPendingVectorCleanup|submitVectorCleanupBatch)\b/);
    expect(store).not.toContain("processedUpToMutation");
    expect(store).not.toContain("VECTOR_CLEANUP_REDELETE_MS");
  });

  it("lifecycleは確定後の遠隔削除をcleanupへ委譲する", () => {
    const lifecycle = read("src/capture/lifecycle.ts");
    expect(lifecycle).not.toContain("VECTORIZE.deleteByIds");
    expect(lifecycle).not.toContain("Vector cleanup capability was lost");
    expect(lifecycle).toContain('from "../vectorize/cleanup"');
    expect(lifecycle).toContain("submitLifecycleVectorCleanup");
    const batch = read("src/vectorize/batch.ts");
    expect(batch).toContain('await import("./cleanup")');
    for (const name of ["recordVectorCleanup", "markVectorCleanupReady", "settleVectorCleanupOp"]) expect(batch).toContain(name);
    expect(read("src/entries/import.ts")).not.toContain("function isRestoreFenceError");
  });

  it("追記待ちpassageとreceiptの再試行判定をpendingへ置く", () => {
    const store = read("src/capture/store.ts");
    const pending = read("src/capture/pending.ts");
    for (const name of ["parsePendingAppendPassages", "appendPendingPassage", "appendRequestHash", "readAppendReceipt", "replayedAppend"]) {
      expect(store).not.toContain(`function ${name}(`);
      expect(pending).toContain(`function ${name}(`);
    }
    expect(store).toContain('from "./pending"');
    expect(store).toContain("INSERT INTO append_receipts");
    expect(store).toContain("AND pending_append_passages = ?");
  });

  it("HTTP exportからR2 orchestrationへの逆依存を戻さない", () => {
    for (const file of ["src/routes/entries.ts", "src/entries/export.ts"]) {
      expect(read(file)).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*backup\/r2["']/);
    }
    expect(read("src/entries/export.ts")).not.toContain("ARCHIVE");
    expect(read("src/backup/r2.ts")).not.toMatch(/function\s+(?:assertExportWithinMemoryLimit|serializeExportWithinMemoryLimit)\b/);
  });
});
