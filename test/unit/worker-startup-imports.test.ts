import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = resolve(import.meta.dirname, "../../src/index.ts");
const MCP_DISPATCH = resolve(import.meta.dirname, "../../src/mcp/dispatch.ts");
const MCP_EXECUTOR = resolve(import.meta.dirname, "../../src/mcp/executor.ts");

describe("Worker startup import budget", () => {
  it("loads the MCP implementation only after an MCP request starts", () => {
    const entrypoint = readFileSync(ENTRYPOINT, "utf8");
    const dispatch = readFileSync(MCP_DISPATCH, "utf8");
    const executor = readFileSync(MCP_EXECUTOR, "utf8");

    expect(entrypoint).not.toMatch(/^import\s+.*["']\.\/mcp\/handler["'];?$/mu);
    expect(dispatch).not.toMatch(/^import\s+.*["']\.\/handler["'];?$/mu);
    expect(executor).not.toMatch(/^import\s+.*["']\.\/handler["'];?$/mu);
    expect(dispatch).toContain('await import("./handler")');
    expect(executor).toContain('await import("./handler")');
  });
});
