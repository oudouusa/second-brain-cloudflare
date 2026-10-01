import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { createMember } from "../../src/lib/team-admin";
import { importExportPayload } from "../../src/entries/import";
import { createEdge } from "../../src/graph/edges";
import { forgetEntry } from "../../src/capture/lifecycle";
import { getTrashedEntry, restoreEntry } from "../../src/memory/trash";
import { resolveConfig } from "../../src/config";

// T-0089.1.1 close-out round 3: every edge insert accepts only endpoints the actor can read
// (readableWorkspaces), checked in the same statement that writes the edge.

let t: TrashEnv;
afterEach(() => t?.close());

const edge = (source_id: string, target_id: string) => ({ source_id, target_id, type: "relates_to", weight: 1, provenance: "explicit", created_at: 1000 });
const edgeRows = () => t.all<{ source_id: string; target_id: string }>(`SELECT source_id, target_id FROM edges`);

describe("import edges", () => {
  it("an edge to another member's private entry is skipped without a reason, exactly like one to a missing id", async () => {
    t = await makeTrashEnv();
    const { member: bob } = await createMember(t.env, { name: "Bob" });
    t.seed("mine");
    t.seed("secret", { actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
    const mine = t.roots.ownerPersonalWorkspaceId;
    const summary = await importExportPayload(t.env, { entries: [], edges: [edge("mine", "secret"), edge("mine", "nowhere")] },
      { writeCtx: { workspaceId: mine, actorId: t.roots.ownerUserId } });
    expect(summary).toMatchObject({ edges_imported: 0, edges_skipped: 2, edges_failed: 0 });
    expect(JSON.stringify(summary.results)).not.toMatch(/secret|nowhere/);
    expect(await edgeRows()).toEqual([]);
  });

  it("an endpoint moved out of reach after the pre-read gets no edge (the insert re-checks)", async () => {
    t = await makeTrashEnv();
    const { member: bob } = await createMember(t.env, { name: "Bob" });
    const mine = t.roots.ownerPersonalWorkspaceId;
    t.seed("a"); t.seed("b");
    const db = t.sqlite.db as any;
    const realBatch = db.batch.bind(db);
    let moved = false;
    db.batch = async (stmts: any[]) => {
      if (!moved && String(stmts[0]?.sourceSql?.() ?? stmts[0]?.sql ?? "").includes("INSERT INTO edges")) {
        moved = true;
        await t.sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'b'`).bind(bob.personalWorkspaceId).run();
      }
      return realBatch(stmts);
    };
    await importExportPayload(t.env, { entries: [], edges: [edge("a", "b")] },
      { writeCtx: { workspaceId: mine, actorId: t.roots.ownerUserId } });
    expect(moved).toBe(true);
    expect(await edgeRows()).toEqual([]);
  });
});

describe("automatic edges stay inside one workspace (round 5)", () => {
  it("import skips an edge to an entry in another workspace the importer CAN read (its company one)", async () => {
    t = await makeTrashEnv();
    const mine = t.roots.ownerPersonalWorkspaceId;
    t.seed("p"); t.seed("c", { workspace_id: t.roots.companyWorkspaceId }); t.seed("p2");
    void mine;
    const worker = (await import("../../src/index")).default;
    const res = await worker.fetch(new Request("http://localhost/import", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ version: 2, entries: [], edges: [edge("p", "c"), edge("p", "p2")] }) }), t.env, { waitUntil: () => {} } as unknown as ExecutionContext);
    expect(await res.json()).toMatchObject({ edges_imported: 1, edges_skipped: 1 });
    expect(await edgeRows()).toEqual([{ source_id: "p", target_id: "p2" }]);
  });

  it("sameWorkspaceEdge refuses a pair across two workspaces, even ones the same person reads", async () => {
    t = await makeTrashEnv();
    const { sameWorkspaceEdge } = await import("../../src/graph/edges");
    t.seed("p"); t.seed("c", { workspace_id: t.roots.companyWorkspaceId });
    await createEdge("p", "c", "supersedes", { provenance: "system", ...sameWorkspaceEdge(t.roots.ownerPersonalWorkspaceId) }, t.env);
    await createEdge("c", "p", "supersedes", { provenance: "system", ...sameWorkspaceEdge(t.roots.companyWorkspaceId) }, t.env);
    expect(await edgeRows()).toEqual([]);
  });
});

describe("the shared edge writer", () => {
  it("createEdge writes nothing when an endpoint is outside the actor's readable workspaces", async () => {
    t = await makeTrashEnv();
    const { member: bob } = await createMember(t.env, { name: "Bob" });
    const mine = t.roots.ownerPersonalWorkspaceId;
    t.seed("a"); t.seed("b", { workspace_id: bob.personalWorkspaceId });
    await createEdge("a", "b", "relates_to", { provenance: "explicit", workspaceId: mine, readableWorkspaceIds: [mine] }, t.env);
    expect(await edgeRows()).toEqual([]);
    t.seed("c");
    await createEdge("a", "c", "relates_to", { provenance: "explicit", workspaceId: mine, readableWorkspaceIds: [mine] }, t.env);
    expect(await edgeRows()).toEqual([{ source_id: "a", target_id: "c" }]);
  });
});

describe("restore", () => {
  it("does not bring back an edge whose other endpoint moved to a workspace the restored row's readers cannot see", async () => {
    t = await makeTrashEnv();
    const { member: bob } = await createMember(t.env, { name: "Bob" });
    const mine = t.roots.ownerPersonalWorkspaceId;
    t.seed("r"); t.seed("keep"); t.seed("moves");
    t.edge("e1", "r", "keep"); t.edge("e2", "r", "moves");
    await forgetEntry("r", t.env, { actorId: t.roots.ownerUserId, channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false }, mine);
    await t.sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'moves'`).bind(bob.personalWorkspaceId).run();
    const trashed = (await getTrashedEntry(t.env, undefined, "r"))!;
    expect((await restoreEntry(t.env, trashed, { actorId: t.roots.ownerUserId, channel: "rest" }, await resolveConfig(t.env))).status).toBe("restored");
    expect(await edgeRows()).toEqual([{ source_id: "r", target_id: "keep" }]);
  });
});

describe("structural: every edge insert checks endpoint readability in the same statement", () => {
  const SRC = join(__dirname, "../../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const sites = files(SRC).flatMap((p) => {
    const src = readFileSync(p, "utf8");
    return [...src.matchAll(/`(INSERT(?:\s+OR\s+\w+)?\s+INTO\s+edges\b[^`]*)`/g)].map((m) => ({ file: p.slice(SRC.length + 1), sql: m[1] }));
  });

  it("finds the reviewed edge-insert sites", () => {
    expect(sites.map((s) => s.file).sort()).toEqual(["entries/import.ts", "graph/edges.ts", "graph/edges.ts", "graph/edges.ts", "graph/edges.ts", "memory/trash.ts", "memory/validity.ts", "memory/validity.ts"]);
  });

  it("each one carries the shared readability guard", () => {
    for (const s of sites) {
      expect(s.sql, s.file).toMatch(/edgeEndpointsReadableSql\(/);
      if (s.file === "entries/import.ts") {
        // 全体restoreの専用leaseのみ、保存済みの共有関係をそのまま復元する。
        expect(s.sql).toContain('restoreLeaseOwner ? "1" : edgeEndpointsReadableSql("?", "?", "?")');
      } else expect(s.sql, s.file).toMatch(/\$\{edgeEndpointsReadableSql\(/);
    }
  });

  it("automatic edge writers go through sameWorkspaceEdge; only the explicit link surfaces pass a reader's workspaces", () => {
    const calls: { file: string; args: string }[] = [];
    for (const f of files(SRC).map((p) => ({ file: p.slice(SRC.length + 1), src: readFileSync(p, "utf8") }))) {
      for (const m of f.src.matchAll(/(?<!function )\b(?:createEdge|edgeInsertStatement)\(([^;]*?)\},\s*env\s*,?\s*\)/g)) calls.push({ file: f.file, args: m[1] });
    }
    const explicit = new Set(["routes/graph.ts", "mcp/server.ts"]);
    // MOVED 7 -> 6 (T-0089.2.1): capture's supersedes edge now rides in the supersede batch
    // (src/memory/validity.ts supersedeStatements), which carries the same readability guard.
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const c of calls) {
      if (explicit.has(c.file)) expect(c.args, c.file).toMatch(/readableWorkspaceIds: identity \? readableWorkspaces\(identity\)|readableWorkspaceIds: readableWorkspaces\(auth\)/);
      else expect(c.args, `${c.file}: ${c.args.slice(0, 120)}`).toMatch(/\.\.\.sameWorkspaceEdge\(/);
    }
    // Import edges are automatic too: one workspace, the importer's own.
    expect(readFileSync(join(SRC, "entries/import.ts"), "utf8")).toMatch(/const readable = \[writeCtx\.workspaceId\];/);
  });

  it("the writers that take an actor require its readable workspaces", () => {
    const edges = readFileSync(join(SRC, "graph/edges.ts"), "utf8");
    expect(edges).toMatch(/readableWorkspaceIds: string\[\];/);
    // Import is an automatic writer (round 5): one workspace, pinned below in the same-workspace test.
  });
});
