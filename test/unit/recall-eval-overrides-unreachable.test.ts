import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Eval-only recall switches (RecallInternalOptions.variant: rerank, arms, rerankTuning with its timeoutMs, and the
 * keywordPreRankedOverride) must be unreachable from anything a caller can influence. Two pins: the only production
 * callers of recallEntries pass exactly identity/workspaceFilter/teamId as their internal options, and no file outside
 * src/recall names the tuning types or fields at all.
 */
const SRC = join(import.meta.dirname, "../../src");
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
});
const rel = (p: string) => relative(SRC, p);

describe("eval-only recall switches are unreachable from routes and MCP", () => {
  it("every recallEntries caller outside src/recall passes only identity, workspaceFilter, teamId and asOf as internal options", () => {
    const callers = files(SRC).filter(f => !rel(f).startsWith("recall/") && /\brecallEntries\(/.test(readFileSync(f, "utf8")));
    expect(callers.map(rel).sort()).toEqual(["mcp/server.ts", "routes/recall.ts"]);
    for (const f of callers) {
      const src = readFileSync(f, "utf8");
      const calls = [...src.matchAll(/recallEntries\([\s\S]*?\},\s*env,\s*ctx,\s*cfg,\s*(\{[^}]*\}),?\s*\)/g)];
      expect(calls.length, rel(f)).toBeGreaterThan(0);
      for (const c of calls) {
        const keys = c[1].slice(1, -1).split(",").map(part => part.split(":")[0].trim()).filter(Boolean);
        // asOf (T-0089.2.2) is a real, spec'd production option (as_of on both surfaces), not one
        // of the eval-only switches this guard exists to keep unreachable (see the file docstring).
        for (const k of keys) expect(["identity", "workspaceFilter", "teamId", "asOf"], `${rel(f)} passes "${k}" as an internal recall option`).toContain(k);
      }
    }
  });

  it("nothing outside src/recall mentions the tuning switches, the reranker timeout override, or variant.rerank", () => {
    for (const f of files(SRC).filter(f => !rel(f).startsWith("recall/"))) {
      const src = readFileSync(f, "utf8");
      expect(src, rel(f)).not.toMatch(/rerankTuning|RerankTuning|\bvariant\.rerank\b|keywordPreRankedOverride/);
    }
  });

  it("the timeout override exists only as a field of the typed variant flags", () => {
    const hits = files(SRC).filter(f => /timeoutMs\?:/.test(readFileSync(f, "utf8")) && readFileSync(f, "utf8").includes("RerankTuning"));
    expect(hits.map(rel)).toEqual(["recall/types.ts"]);
  });
});
