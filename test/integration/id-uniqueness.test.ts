import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { importExportPayload } from "../../src/entries/import";
import { forgetEntry } from "../../src/capture/lifecycle";
import { resolveConfig } from "../../src/config";

// T-0089.1.1 close-out round 2: an id is never live and in the trash at once. Every insert into
// entries or entries_trash either mints a fresh id, moves the one row that owns the id, or checks
// both tables in the same statement; the trash insert fails closed instead of replacing a row.

let t: TrashEnv;
afterEach(() => t?.close());

const entry = (id: string, content = `imported ${id}`) => ({ id, content, tags: [], source: "api", created_at: 1000 });
const forgetIn = async (id: string, ws: string, actorId = t.roots.ownerUserId) =>
  forgetEntry(id, t.env, { actorId, channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false }, ws);

/** Runs `mutate` once, right after import's existence pre-read of the trash returns: the race window. */
function afterTrashPreRead(mutate: () => Promise<void>) {
  const db = t.sqlite.db as any;
  const realPrepare = db.prepare.bind(db);
  let fired = false;
  db.prepare = (sql: string) => {
    const st = realPrepare(sql);
    if (fired || !/FROM entries_trash WHERE id IN/.test(sql)) return st;
    return { bind: (...a: unknown[]) => ({ all: async () => {
      const r = await st.bind(...a).all();
      fired = true;
      await mutate();
      return r;
    } }) };
  };
  return () => fired;
}

describe("ids are unique across entries and entries_trash", () => {
  it("trashing a live row whose id already has a trash row fails closed: neither row is lost", async () => {
    t = await makeTrashEnv();
    const ws = t.roots.ownerPersonalWorkspaceId;
    t.seed("x", { content: "older memory" });
    await forgetIn("x", ws);
    const old = (await t.one<{ nonce: string; content: string }>(`SELECT nonce, content FROM entries_trash WHERE id = 'x'`))!;
    // A state the invariant forbids, forced directly: the trash write must refuse, not replace.
    t.seed("x", { content: "newer memory" });
    await expect(forgetIn("x", ws)).rejects.toThrow();
    expect(await t.one(`SELECT nonce, content FROM entries_trash WHERE id = 'x'`)).toEqual(old);
    expect((await t.one<{ content: string }>(`SELECT content FROM entries WHERE id = 'x'`))!.content).toBe("newer memory");
  });

  it("an id trashed after import's pre-read is not imported over: the row gets a fresh id and the trash row keeps its history", async () => {
    t = await makeTrashEnv();
    const company = t.roots.companyWorkspaceId;
    const fired = afterTrashPreRead(async () => {
      t.seed("x", { content: "a teammate's memory", workspace_id: company });
      t.version("x", 1, { workspace_id: company }); t.version("x", 2, { workspace_id: company });
      await forgetIn("x", company);
    });
    const summary = await importExportPayload(t.env, { entries: [entry("x")] }, { writeCtx: { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId } });
    expect(fired()).toBe(true);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'x'`)).toBeNull();
    expect(await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'x'`)).toHaveLength(2);
    expect(summary.imported).toBe(1);
    const item = summary.results.find((r: any) => r.status === "imported") as any;
    expect(item.id).not.toBe("x");
    expect(item.original_id).toBe("x");
    expect((await t.one<{ content: string }>(`SELECT content FROM entries WHERE id = ?`, item.id))!.content).toBe("imported x");
  });

  it("an id made live after import's pre-read is imported under a fresh id, not failed and not merged", async () => {
    t = await makeTrashEnv();
    const fired = afterTrashPreRead(async () => { t.seed("y", { content: "someone else's row", workspace_id: t.roots.companyWorkspaceId }); });
    const summary = await importExportPayload(t.env, { entries: [entry("y")] }, { writeCtx: { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId } });
    expect(fired()).toBe(true);
    expect(summary).toMatchObject({ imported: 1, failed: 0 });
    expect((await t.one<{ content: string }>(`SELECT content FROM entries WHERE id = 'y'`))!.content).toBe("someone else's row");
    const item = summary.results.find((r: any) => r.status === "imported") as any;
    expect(item).toMatchObject({ original_id: "y" });
    expect(item.id).not.toBe("y");
  });
});

describe("import's skip does not say where another workspace's id lives", () => {
  it("an id in another workspace's trash is a plain skip; the importer's own trash still says in_trash", async () => {
    t = await makeTrashEnv();
    const mine = t.roots.ownerPersonalWorkspaceId;
    t.seed("theirs", { workspace_id: t.roots.companyWorkspaceId }); await forgetIn("theirs", t.roots.companyWorkspaceId);
    t.seed("own"); await forgetIn("own", mine);
    const summary = await importExportPayload(t.env, { entries: [entry("theirs"), entry("own")] }, { writeCtx: { workspaceId: mine, actorId: t.roots.ownerUserId } });
    expect(summary).toMatchObject({ imported: 0, skipped: 2, skipped_in_trash: 1 });
    expect(summary.results).toContainEqual({ id: "own", status: "skipped", reason: "in_trash" });
    // Counted under skipped only, exactly like a live id in another workspace: no item names it.
    expect(summary.results.find((r: any) => r.id === "theirs")).toBeUndefined();
  });
});

// Structural: every INSERT into entries or entries_trash under src/ is one of the reviewed kinds.
describe("structural: every insert into entries or entries_trash keeps ids unique", () => {
  const SRC = join(__dirname, "../../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const sites = files(SRC).flatMap((p) => {
    const src = readFileSync(p, "utf8");
    const rel = p.slice(SRC.length + 1);
    return [...src.matchAll(/`((?:WITH[^`]*?)?INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(entries|entries_trash)\b[^`]*)`/g)]
      .map((m) => ({ file: rel, table: m[2], sql: m[1], src }));
  });

  // A fresh random id: the file mints it with crypto.randomUUID() for exactly this insert.
  const FRESH = new Set(["capture/entry.ts", "integrations/mirror.ts", "memory/history.ts", "memory/undo.ts"]);

  it("finds the reviewed insert sites and no others", () => {
    expect(sites.map((s) => `${s.file}:${s.table}`).sort()).toEqual([
      "capture/entry.ts:entries",
      "entries/import.ts:entries",
      "integrations/mirror.ts:entries",
      "memory/history.ts:entries",
      "memory/rollover.ts:entries",
      "memory/trash.ts:entries",
      "memory/trash.ts:entries_trash",
      "memory/undo.ts:entries",
    ]);
  });

  it("no insert replaces or ignores a conflicting row", () => {
    for (const s of sites) expect(s.sql, s.file).not.toMatch(/INSERT\s+OR\s+/i);
  });

  it("each site mints a fresh id, moves the trash row that owns the id, or checks both tables in the same statement", () => {
    for (const s of sites) {
      if (FRESH.has(s.file)) {
        expect(s.src, s.file).toMatch(/crypto\.randomUUID\(\)/);
      } else if (s.file === "memory/rollover.ts") {
        expect(s.src).toContain("async function rolloverEntryId(operationId: string)");
        expect(s.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM entries_trash/);
        // live衝突は通常INSERTのPRIMARY KEYがbatchを中断する。trashは同SQLで照合する。
        expect(s.sql).toMatch(/^INSERT INTO entries/);
      } else if (s.file === "entries/import.ts") {
        expect(s.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM entries /);
        expect(s.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM entries_trash /);
      } else if (s.file === "memory/trash.ts" && s.table === "entries") {
        // restoreEntry: the id comes from the trash row it deletes in the same batch, pinned by nonce.
        expect(s.sql).toMatch(/FROM entries_trash t\s+WHERE t\.id = .* AND t\.nonce = /s);
      } else {
        // trashManyStatements: the id comes from the live row it deletes in the same batch; a
        // collision with an existing trash row is a PRIMARY KEY error that fails the batch.
        expect(s.table).toBe("entries_trash");
        expect(s.sql).toMatch(/^INSERT INTO entries_trash/);
      }
    }
  });

  it("undo re-creates a merged-in memory under a freshly minted id", () => {
    const undo = sites.find((s) => s.file === "memory/undo.ts")!.src;
    expect(undo).toMatch(/mergesToCreate\.push\(\{ merge, meta: mergeMeta, id: crypto\.randomUUID\(\) \}\)/);
  });
});
