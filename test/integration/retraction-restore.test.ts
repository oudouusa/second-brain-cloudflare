/**
 * Track 2 Task A5 (T-0089.2.4, D-RET): retracting a fact that superseded an older one restores the
 * older fact's validity, as a version, so undo works both ways. Invariant: a closed window needs a
 * live, non-deprecated closer (spec 14 P3, 5.6). Real SQLite, real entry points.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeTrashEnv, trashNonce, type TrashEnv } from "../helpers/trash-env";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
import { applyInsightResolution } from "../../src/memory/actions";
import { deleteForever, getTrashedEntry, restoreEntry, trashMirroredEntries } from "../../src/memory/trash";
import { revertEntry } from "../../src/memory/undo";
import { planSupersede, supersedeStatements, type Window } from "../../src/memory/validity";
import { DEFAULTS } from "../../src/config";
import type { Identity } from "../../src/lib/identity";

let t: TrashEnv;
afterEach(() => t?.close());

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const change = () => ({ actorId: t.roots.ownerUserId, channel: "rest" as const });
const owner = (): Identity => ({
  userId: t.roots.ownerUserId, role: "admin", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId,
  companyWorkspaceIds: [t.roots.companyWorkspaceId], defaultShare: "",
});
const ws = () => t.roots.ownerPersonalWorkspaceId;
const row = async (id: string) => t.one<any>(`SELECT * FROM entries WHERE id = ?`, id);
const versions = async (id: string) => t.all<any>(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`, id);
const newestMeta = async (id: string) => JSON.parse((await versions(id)).at(-1)?.meta ?? "{}");
const supersedeEdges = async () => t.all<any>(`SELECT source_id, target_id FROM edges WHERE type = 'supersedes' ORDER BY source_id, target_id`);
const events = async (id: string) => t.all<any>(`SELECT event, payload FROM entry_events WHERE entry_id = ? ORDER BY created_at, rowid`, id);

async function win(id: string): Promise<Window> {
  const r = await row(id);
  return { id, from: r.valid_from ?? r.created_at, until: r.valid_until, workspaceId: r.workspace_id, status: null };
}
/** The real supersede (A3's batch): `newer` closes `older`. */
async function supersede(older: string, newer: string) {
  const o = await win(older);
  const n = await win(newer);
  await t.env.DB.batch(supersedeStatements(t.env, planSupersede(o, n), o, n, change(), DEFAULTS));
}
/** Y (Denver, 1000) replaced by X (Austin, 2000). */
async function replaced() {
  t = await makeTrashEnv();
  t.seed("y", { content: "Lives in Denver", created_at: 1000, vector_ids: '["y"]' });
  t.seed("x", { content: "Lives in Austin", created_at: 2000, vector_ids: '["x"]' });
  await supersede("y", "x");
  expect((await row("y")).valid_until).toBe(2000);
}
const deprecate = () => applyStatus("x", "deprecated", t.env, change(), DEFAULTS, ws());
const forget = (id = "x", reason: "forget" | "mirror" = "forget") => forgetEntry(id, t.env, change(), { reason, config: DEFAULTS, purge: false }, ws());
const undo = (id: string) => revertEntry(t.env, owner(), id, change(), DEFAULTS, undefined, ws());

describe("the restore rule", () => {
  it("marking the replacing fact wrong reopens the older one, as a validity version with cause retraction", async () => {
    await replaced();
    const r = await deprecate();
    expect(r).toMatchObject({ status: "ok", validity: { restored: [{ id: "y", preview: "Lives in Denver" }], reclosed: [] } });
    expect((await row("y")).valid_until).toBeNull();
    const vs = await versions("y");
    expect(vs.at(-1)).toMatchObject({ reason: "validity", channel: "rest" });
    expect(await newestMeta("y")).toMatchObject({ cause: "retraction", retracted: "x" });
    expect(JSON.parse(vs.at(-1).state)).toMatchObject({ valid_until: 2000 });
    const trail = await events("y");
    expect(trail.map((e: any) => e.event)).toContain("validity_changed");
    expect(JSON.parse(trail.find((e: any) => e.event === "validity_changed").payload)).toMatchObject({ cause: "retraction", retracted: "x", until: null });
  });

  it("forgetting the replacing fact reopens the older one; restoring it from the trash closes it again", async () => {
    await replaced();
    const f = await forget();
    expect(f).toMatchObject({ status: "deleted", validity: { restored: [{ id: "y", preview: "Lives in Denver" }] } });
    expect((await row("y")).valid_until).toBeNull();
    const trashed = (await getTrashedEntry(t.env, undefined, "x"))!;
    const r = await restoreEntry(t.env, trashed, change(), DEFAULTS);
    expect(r).toMatchObject({ status: "restored", validity: { reclosed: [{ id: "y", preview: "Lives in Denver" }] } });
    expect((await row("y")).valid_until).toBe(2000);
    expect(await newestMeta("y")).toMatchObject({ cause: "unretraction", by: "x" });
    expect(await supersedeEdges()).toEqual([{ source_id: "x", target_id: "y" }]);
  });

  it("Delete forever of the replacing fact keeps the older one current", async () => {
    await replaced();
    await forget();
    const d = await deleteForever(t.env, "x", change(), ws(), await trashNonce(t.env, "x"));
    expect(d.status).toBe("deleted");
    expect((await row("y")).valid_until).toBeNull();
    expect(await row("x")).toBeNull();
  });

  it("undo of the Wrong closes the older one again (unretraction), and undo again reopens it", async () => {
    await replaced();
    await deprecate();
    const u1 = await undo("x");
    expect(u1).toMatchObject({ status: "reverted", validity: { reclosed: [{ id: "y" }], restored: [] } });
    expect((await row("y")).valid_until).toBe(2000);
    expect(JSON.parse((await row("x")).tags)).not.toContain("status:deprecated");
    const u2 = await undo("x");
    expect(u2).toMatchObject({ status: "reverted", validity: { restored: [{ id: "y" }] } });
    expect((await row("y")).valid_until).toBeNull();
  });

  it("leaving deprecated through set_status closes the older one again", async () => {
    await replaced();
    await deprecate();
    const r = await applyStatus("x", "canonical", t.env, change(), DEFAULTS, ws());
    expect(r).toMatchObject({ status: "ok", validity: { reclosed: [{ id: "y" }] } });
    expect((await row("y")).valid_until).toBe(2000);
  });

  it("A replaced by B replaced by C: retracting B makes A end where B ended and adds C supersedes A", async () => {
    t = await makeTrashEnv();
    t.seed("a", { created_at: 1000 });
    t.seed("b", { created_at: 2000 });
    t.seed("c", { created_at: 3000 });
    await supersede("a", "b");
    await supersede("b", "c");
    await applyStatus("b", "deprecated", t.env, change(), DEFAULTS, ws());
    expect((await row("a")).valid_until).toBe(3000);
    expect(await supersedeEdges()).toEqual([{ source_id: "b", target_id: "a" }, { source_id: "c", target_id: "a" }, { source_id: "c", target_id: "b" }]);
    // Undo re-closes A where B began; C's edge to A stays (it no longer matches A's end).
    await revertEntry(t.env, owner(), "b", change(), DEFAULTS, undefined, ws());
    expect((await row("a")).valid_until).toBe(2000);
  });

  it("an older row whose end the user changed since is left alone (CAS)", async () => {
    await replaced();
    await t.sqlite.db.prepare(`UPDATE entries SET valid_until = 1500 WHERE id = 'y'`).run();
    const before = (await versions("y")).length;
    const r = await deprecate();
    expect(r).toMatchObject({ status: "ok", validity: { restored: [] } });
    expect((await row("y")).valid_until).toBe(1500);
    expect(await versions("y")).toHaveLength(before);
  });

  it("insight dismiss runs the hook", async () => {
    t = await makeTrashEnv();
    t.seed("y", { tags: '["auto-insight"]', source: "system", actor_id: "", created_at: 1000 });
    t.seed("x", { tags: '["auto-insight"]', source: "system", actor_id: "", created_at: 2000 });
    await supersede("y", "x");
    const found = await t.all<any>(`SELECT id, tags, vector_ids, workspace_id FROM entries WHERE id = 'x'`);
    const r = await applyInsightResolution(t.env, ctx, change(), found, 1, "dismiss");
    expect(r.resolved).toEqual(["x"]);
    expect((await row("y")).valid_until).toBeNull();
    expect(await newestMeta("y")).toMatchObject({ cause: "retraction", retracted: "x" });
  });

  it("a revert to a deprecated target runs the hook inside the revert batch and only if the revert landed", async () => {
    await replaced();
    await deprecate();
    await applyStatus("x", "draft", t.env, change(), DEFAULTS, ws()); // leaves deprecated: y closes again
    expect((await row("y")).valid_until).toBe(2000);
    // A lost revert: another version lands on x between undo's read and its batch.
    const db = t.sqlite.db as any;
    const realBatch = db.batch.bind(db);
    const race = db.prepare(`INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
      SELECT 'x', workspace_id, (SELECT MAX(seq) FROM entry_versions WHERE entry_id = 'x') + 1, content, NULL, tags, '', 'rest', 'update', 9e12, '${t.sqlite.fixtureMarker()}' FROM entries WHERE id = 'x'`);
    let raced = false;
    db.batch = async (stmts: any[]) => { if (!raced) { raced = true; await race.run(); } return realBatch(stmts); };
    expect((await undo("x")).status).toBe("stale");
    db.batch = realBatch;
    expect((await row("y")).valid_until).toBe(2000);
    // The same revert, landing: x goes back to deprecated and y reopens in the same batch.
    await t.sqlite.deleteFixtureRows(`DELETE FROM entry_versions WHERE entry_id = 'x' AND created_at = 9e12`);
    const u = await undo("x");
    expect(u).toMatchObject({ status: "reverted", validity: { restored: [{ id: "y" }] } });
    expect(JSON.parse((await row("x")).tags)).toContain("status:deprecated");
    expect((await row("y")).valid_until).toBeNull();
  });

  it("mirror delete and disconnect purge apply the restore rule", async () => {
    await replaced();
    await forget("x", "mirror");
    expect((await row("y")).valid_until).toBeNull();

    t.close();
    await replaced();
    const r = await trashMirroredEntries(t.env, owner(), ["x"], { provider: "notion" });
    expect(r.purged).toBe(1);
    expect((await row("y")).valid_until).toBeNull();
    expect(await newestMeta("y")).toMatchObject({ cause: "retraction", retracted: "x" });
  });

  it("a restore target in another workspace is never written", async () => {
    t = await makeTrashEnv();
    t.seed("y", { created_at: 1000, workspace_id: t.roots.companyWorkspaceId, valid_until: 2000 });
    t.seed("x", { created_at: 2000 });
    await t.sqlite.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
      VALUES ('e1', 'x', 'y', 'supersedes', 1, 'system', '{}', 1, 1, ?)`).bind(ws()).run();
    const r = await deprecate();
    expect(r).toMatchObject({ status: "ok", validity: { restored: [] } });
    expect((await row("y")).valid_until).toBe(2000);
    expect(await versions("y")).toHaveLength(0);
  });

  it("retracting twice changes nothing the second time", async () => {
    await replaced();
    await deprecate();
    const n = (await versions("y")).length;
    const again = await deprecate();
    expect(again).toMatchObject({ status: "ok", validity: { restored: [] } });
    expect(await versions("y")).toHaveLength(n);
    expect((await row("y")).valid_until).toBeNull();
  });

  it("a row with no supersede history is untouched and reports nothing", async () => {
    t = await makeTrashEnv();
    t.seed("x", { created_at: 2000 });
    expect(await applyStatus("x", "deprecated", t.env, change(), DEFAULTS, ws())).toMatchObject({ status: "ok", validity: { restored: [], reclosed: [] } });
  });
});

describe("execution counts", () => {
  it("deprecate stays read + batch, plus one audit batch only when something was restored", async () => {
    t = await makeTrashEnv();
    t.seed("x", { created_at: 2000 });
    t.sqlite.executions.length = 0;
    await applyStatus("x", "deprecated", t.env, change(), DEFAULTS, ws());
    expect(t.sqlite.executions, t.sqlite.executions.join("\n")).toHaveLength(4);
    t.close();

    await replaced();
    t.sqlite.executions.length = 0;
    await deprecate();
    expect(t.sqlite.executions, t.sqlite.executions.join("\n")).toHaveLength(8); // 原本3回 + validity監査1回 + 台帳の参照・admission・認可・送信記録4回
    expect(t.sqlite.executions[2]).toBe("BATCH");
  });

  it("forget stays read + batch, plus the audit batch only when something was restored", async () => {
    t = await makeTrashEnv();
    t.seed("x", { created_at: 2000 });
    t.sqlite.executions.length = 0;
    await forget();
    expect(t.sqlite.executions, t.sqlite.executions.join("\n")).toHaveLength(4);
    t.close();

    await replaced();
    t.sqlite.executions.length = 0;
    await forget();
    expect(t.sqlite.executions, t.sqlite.executions.join("\n")).toHaveLength(8);
  });

  it("restore from the trash adds only the audit batch when something was re-closed", async () => {
    t = await makeTrashEnv();
    t.seed("x", { created_at: 2000 });
    await forget();
    const plain = (await getTrashedEntry(t.env, undefined, "x"))!;
    t.sqlite.executions.length = 0;
    await restoreEntry(t.env, plain, change(), DEFAULTS);
    const baseline = t.sqlite.executions.length;
    t.close();

    await replaced();
    await forget();
    const trashed = (await getTrashedEntry(t.env, undefined, "x"))!;
    t.sqlite.executions.length = 0;
    await restoreEntry(t.env, trashed, change(), DEFAULTS);
    expect(t.sqlite.executions.length, t.sqlite.executions.join("\n")).toBe(baseline + 1);
  });
});

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { req } from "../helpers/make-request";
import { resolveIdentityFromToken } from "../../src/lib/identity";

async function mcpCall(name: string, args: Record<string, unknown>) {
  const identity = (await resolveIdentityFromToken("test-token", t.env))!;
  const server = buildMcpServer(t.env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retraction-test", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return String((result.content as { text?: string }[])[0]?.text ?? "");
  } finally {
    await client.close();
    await server.close();
  }
}

describe("replies name the restored memory", () => {
  it("set_status, forget and undo replies name the restored memory, with no em dash", async () => {
    await replaced();
    const wrong = await mcpCall("set_status", { id: "x", status: "deprecated" });
    expect(wrong).toBe(`Marked memory x as wrong: it is hidden from recall and kept in its history. Undo is available. Memory y ("Lives in Denver") is current again.`);
    const back = await mcpCall("undo", { id: "x" });
    expect(back).toContain(" Memory y is replaced by x again.");
    const gone = await mcpCall("forget", { id: "x" });
    expect(gone).toMatch(/^Moved entry x to the trash; it is removed for good after \d+ days\. The older memory y is current again\.$/);
    const restored = await mcpCall("undo", { id: "x" });
    expect(restored).toBe("Restored entry x from the trash. Memory y is replaced by x again.");
    for (const text of [wrong, back, gone, restored]) expect(text).not.toMatch(/—/);
  });

  it("POST /status, /forget, /restore and /undo return the validity fields", async () => {
    await replaced();
    const status = await (await worker.fetch(req("POST", "/status", { body: { id: "x", status: "deprecated" } }), t.env, ctx)).json() as any;
    expect(status.validity).toEqual({ restored: [{ id: "y", preview: "Lives in Denver" }], reclosed: [], flagged: 0, unflagged: 0 });
    const undo1 = await (await worker.fetch(req("POST", "/undo", { body: { id: "x" } }), t.env, ctx)).json() as any;
    expect(undo1.validity).toMatchObject({ reclosed: [{ id: "y", preview: "Lives in Denver" }] });
    const forgot = await (await worker.fetch(req("POST", "/forget", { body: { id: "x" } }), t.env, ctx)).json() as any;
    expect(forgot.validity).toMatchObject({ restored: [{ id: "y" }] });
    const back = await (await worker.fetch(req("POST", "/restore", { body: { id: "x" } }), t.env, ctx)).json() as any;
    expect(back.validity).toMatchObject({ reclosed: [{ id: "y" }] });
  });
});
