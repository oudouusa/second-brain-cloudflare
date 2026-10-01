import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("wrangler");
  delete process.env.SB_EVAL_ROOT;
});

/** A stand-in for wrangler's getPlatformProxy so the workerd path's plumbing runs without booting workerd. */
function fakeWrangler(o: { failSchema?: boolean; failDispose?: boolean } = {}) {
  const seen: { options?: any; disposed: number } = { disposed: 0 };
  vi.doMock("wrangler", () => ({
    getPlatformProxy: async (options: unknown) => {
      seen.options = options;
      const stmt = { run: async () => { if (o.failSchema) throw new Error("schema boom"); return {}; } };
      return {
        env: { DB: { prepare: () => stmt } },
        dispose: async () => { seen.disposed++; if (o.failDispose) throw new Error("dispose boom"); },
      };
    },
  }));
  return seen;
}

describe("openD1 workerd plumbing (stubbed wrangler)", () => {
  it("runs local only, with the repo's compatibility_date, and removes its temp dir on close", async () => {
    const seen = fakeWrangler();
    const { openD1 } = await import("./d1");
    const d1 = await openD1("workerd");
    expect(seen.options.remoteBindings).toBe(false);
    const dir = dirname(seen.options.configPath);
    const config = JSON.parse(readFileSync(seen.options.configPath, "utf8"));
    const repo = readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8");
    expect(config.compatibility_date).toBe(/"compatibility_date"\s*:\s*"([^"]+)"/.exec(repo)![1]);
    expect(existsSync(dir)).toBe(true);
    await d1.close();
    expect(existsSync(dir)).toBe(false);
    expect(seen.disposed).toBe(1);
  });

  it("disposes the proxy and removes the temp dir when the schema fails to apply", async () => {
    const seen = fakeWrangler({ failSchema: true });
    const { openD1 } = await import("./d1");
    await expect(openD1("workerd")).rejects.toThrow("schema boom");
    expect(seen.disposed).toBe(1);
    expect(existsSync(dirname(seen.options.configPath))).toBe(false);
  });

  it("removes the temp dir even when dispose throws on close", async () => {
    const seen = fakeWrangler({ failDispose: true });
    const { openD1 } = await import("./d1");
    const d1 = await openD1("workerd");
    await expect(d1.close()).rejects.toThrow("dispose boom");
    expect(existsSync(dirname(seen.options.configPath))).toBe(false);
  });

  it("creates no temp dir when wrangler fails to import", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "sb-eval-scratch-"));
    const previous = process.env.TMPDIR;
    try {
      process.env.TMPDIR = scratch;
      vi.doMock("wrangler", () => { throw new Error("import boom"); });
      const { openD1 } = await import("./d1");
      await expect(openD1("workerd")).rejects.toThrow(/import boom|error when mocking/);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reads schema and compatibility_date from SB_EVAL_ROOT", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-eval-root-"));
    try {
      mkdirSync(join(root, "db"));
      writeFileSync(join(root, "db/fork-write-protection.sql"), "");
      writeFileSync(join(root, "db/schema.sql"), "SELECT 1;");
      writeFileSync(join(root, "wrangler.jsonc"), '{ "compatibility_date": "2001-01-01" }');
      const seen = fakeWrangler();
      process.env.SB_EVAL_ROOT = root;
      const { openD1 } = await import("./d1");
      const d1 = await openD1("workerd");
      expect(JSON.parse(readFileSync(seen.options.configPath, "utf8")).compatibility_date).toBe("2001-01-01");
      await d1.close();
      rmSync(join(root, "db/schema.sql"));
      await expect(openD1("workerd")).rejects.toThrow(/ENOENT.*schema\.sql/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SB_EVAL_ROOT on the sqlite facade", () => {
  it("loads db/schema.sql from the override root", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-eval-root-"));
    try {
      mkdirSync(join(root, "db"));
      writeFileSync(join(root, "db/fork-write-protection.sql"), "");
      writeFileSync(join(root, "db/schema.sql"), "CREATE TABLE eval_root_marker (id TEXT);");
      process.env.SB_EVAL_ROOT = root;
      const { makeSqliteD1 } = await import("../helpers/sqlite-d1");
      const sqlite = makeSqliteD1();
      const { results } = await sqlite.db.prepare("SELECT name FROM sqlite_master WHERE name = 'eval_root_marker'").all();
      expect(results).toHaveLength(1);
      sqlite.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
