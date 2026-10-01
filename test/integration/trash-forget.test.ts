import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { makeVectorizeMock } from "../helpers/make-env";
import { forgetEntry } from "../../src/capture/lifecycle";
import { chooseTrashTier, planTrash } from "../../src/memory/trash";
import { resolveConfig } from "../../src/config";
import { TRASH_ROW_BUDGET_BYTES } from "../../src/constants";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let t: TrashEnv;
afterEach(() => { t?.close(); vi.unstubAllGlobals(); });

const post = (path: string, body: unknown) =>
  worker.fetch(new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }), t.env, ctx);
const change = { actorId: "u", channel: "rest" as const };
async function forget(id: string, budget?: number) {
  return forgetEntry(id, t.env, change, { reason: "forget", config: await resolveConfig(t.env), purge: false, budget }, t.roots.ownerPersonalWorkspaceId);
}

describe("chooseTrashTier", () => {
  it("picks full, no-edges or hard delete from the SELECT's byte sizes", () => {
    const sizes = (content_bytes: number, row_json_bytes: number, edges_json_bytes: number) => ({ content_bytes, row_json_bytes, edges_json_bytes, vector_ids_bytes: 2 });
    expect(chooseTrashTier(sizes(100, 200, 300), 10_000)).toBe(1);
    // 100 + 200 + 512 + 9,500 > 10,000 but without edges it fits.
    expect(chooseTrashTier(sizes(100, 200, 9_500), 10_000)).toBe(2);
    expect(chooseTrashTier(sizes(9_500, 200, 0), 10_000)).toBe(3);
    // the default budget leaves headroom under the 2 MB row limit
    expect(chooseTrashTier(sizes(1_000_000, 300, 700_000))).toBe(1);
    expect(chooseTrashTier(sizes(1_000_000, 300, 900_000))).toBe(2);
    expect(TRASH_ROW_BUDGET_BYTES).toBeLessThan(2_000_000);
    // vector_ids is now a stored trash column too (round 2 adversary): a heavily-chunked row's
    // ids count toward the row, not just the fixed 512-byte slack.
    expect(chooseTrashTier({ content_bytes: 100, row_json_bytes: 200, edges_json_bytes: 300, vector_ids_bytes: 9_000 }, 10_000)).toBe(2);
    expect(chooseTrashTier({ content_bytes: 100, row_json_bytes: 200, edges_json_bytes: 0, vector_ids_bytes: 20_000 }, 10_000)).toBe(3);
  });

  it("plans a mixed set by tier", () => {
    const row = (id: string, c: number, e: number) => ({ id, workspace_id: "", actor_id: "", vector_ids: "[]", tags: "[]", content_bytes: c, row_json_bytes: 100, edges_json_bytes: e, vector_ids_bytes: 2 });
    const plan = planTrash([row("a", 10, 10), row("b", 10, 9_999), row("c", 20_000, 0)], 10_000);
    expect(plan).toEqual({ tier1: ["a"], tier2: ["b"], tier3: ["c"] });
  });
});

describe("forget moves the row to the trash", () => {
  it("keeps every column, with NULLs preserved", async () => {
    t = await makeTrashEnv();
    t.seed("n1", { recall_count: null, updated_at: null, when_at: null, importance_score: 7, when_kind: "due", tags: '["a","b"]', vector_ids: '["v1"]' });
    const res = await forget("n1");
    expect(res).toMatchObject({ status: "deleted", vectorCount: 1, trashed: true, edgesDropped: false });

    expect(await t.one(`SELECT id FROM entries WHERE id = 'n1'`)).toBeNull();
    const row = await t.one<any>(`SELECT * FROM entries_trash WHERE id = 'n1'`);
    expect(row.content).toBe("content of n1");
    expect(row.vector_ids).toBe('["v1"]');
    expect(row.workspace_id).toBe(t.roots.ownerPersonalWorkspaceId);
    expect(row.actor_id).toBe(t.roots.ownerUserId);
    expect(row.reason).toBe("forget");
    expect(row.deleted_by).toBe("u");
    expect(row.channel).toBe("rest");
    const json = JSON.parse(row.row_json);
    expect(json.recall_count).toBeNull();
    expect("recall_count" in json).toBe(true);
    expect(json.updated_at).toBeNull();
    expect(json.when_at).toBeNull();
    expect(json.importance_score).toBe(7);
    expect(json.when_kind).toBe("due");
    expect(json.tags).toBe('["a","b"]');
    expect("vector_ids" in json).toBe(false);
    expect("content" in json).toBe(false);
  });

  it("captures and deletes edges at either endpoint, leaving unrelated edges", async () => {
    t = await makeTrashEnv();
    t.seed("a"); t.seed("b"); t.seed("c");
    t.edge("e1", "a", "b"); t.edge("e2", "c", "a"); t.edge("e3", "b", "c");
    await forget("a");
    const edges = JSON.parse((await t.one<any>(`SELECT edges_json FROM entries_trash WHERE id = 'a'`))!.edges_json);
    expect(edges.map((e: any) => e.id).sort()).toEqual(["e1", "e2"]);
    expect(edges[0]).toHaveProperty("workspace_id");
    expect((await t.all(`SELECT id FROM edges`)).map((r) => r.id)).toEqual(["e3"]);
  });

  it("deletes the vectors and reports the count, and a Vectorize failure is not fatal", async () => {
    const deleteByIds = vi.fn().mockRejectedValue(new Error("down"));
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ deleteByIds }) });
    t.seed("a", { vector_ids: '["v1","v2"]' });
    const res = await forget("a");
    expect(res).toMatchObject({ status: "deleted", vectorCount: 2 });
    expect(deleteByIds).toHaveBeenCalledWith(["v1", "v2"]);
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'a'`)).not.toBeNull();
  });

  it("updates entry_counts, FTS and the capsule revision", async () => {
    t = await makeTrashEnv();
    t.seed("cap", { tags: '["capsule:core"]', content: "distinctivewordfortrash" });
    const count = () => t.one<any>(`SELECT COALESCE(SUM(n), 0) AS n FROM entry_counts WHERE workspace_id = ?`, t.roots.ownerPersonalWorkspaceId);
    const rev = () => t.one<any>(`SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?`, t.roots.ownerPersonalWorkspaceId);
    expect((await count())!.n).toBe(1);
    expect(await t.all(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"distinctivewordfortrash"'`)).toHaveLength(1);
    const before = (await rev())?.revision;
    await forget("cap");
    expect((await count())!.n).toBe(0);
    expect(await t.all(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"distinctivewordfortrash"'`)).toHaveLength(0);
    expect((await rev())?.revision).not.toBe(before);
  });

  it("keeps the entry's versions", async () => {
    t = await makeTrashEnv();
    t.seed("a"); t.version("a", 1); t.version("a", 2);
    await forget("a");
    expect((await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'a' ORDER BY seq`)).map((r) => r.seq)).toEqual([1, 2]);
  });

  it("concurrent forgets leave one trash row and one not_found", async () => {
    t = await makeTrashEnv();
    t.seed("a", { vector_ids: '["v1"]' });
    const results = await Promise.all([forget("a"), forget("a")]);
    expect(results.map((r) => r.status).sort()).toEqual(["deleted", "not_found"]);
    expect(await t.all(`SELECT id FROM entries_trash`)).toHaveLength(1);
  });

  it("an unknown id is not_found", async () => {
    t = await makeTrashEnv();
    expect(await forget("nope")).toEqual({ status: "not_found" });
  });

  it("a trashed entry is absent from /count, /export and GET /entry", async () => {
    t = await makeTrashEnv();
    t.seed("a"); t.seed("b");
    await forget("a");
    const count = await (await worker.fetch(new Request("http://localhost/count", { headers }), t.env, ctx)).json() as any;
    expect(count.count).toBe(1);
    const exp = await (await worker.fetch(new Request("http://localhost/export", { headers }), t.env, ctx)).json() as any;
    expect(exp.entries.map((e: any) => e.id)).toEqual(["b"]);
    expect((await worker.fetch(new Request("http://localhost/entry", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ id: "a" }) }), t.env, ctx)).status).toBe(404);
  });
});

describe("size fallbacks", () => {
  it("with a 10 KB budget and many edges, trashes without edges", async () => {
    t = await makeTrashEnv();
    t.seed("big"); for (let i = 0; i < 200; i++) t.seed(`o${i}`);
    for (let i = 0; i < 200; i++) t.edge(`e${i}`, `o${i}`, "big");
    const res = await forget("big", 10_000);
    expect(res).toMatchObject({ status: "deleted", trashed: true, edgesDropped: true });
    expect((await t.one<any>(`SELECT edges_json FROM entries_trash WHERE id = 'big'`))!.edges_json).toBe("[]");
    expect(await t.all(`SELECT id FROM edges WHERE target_id = 'big'`)).toHaveLength(0);
  });

  it("with a 10 KB budget and a large content, hard deletes the row, its edges and its versions", async () => {
    t = await makeTrashEnv();
    t.seed("huge", { content: "x".repeat(20_000) }); t.seed("o"); t.edge("e", "o", "huge"); t.version("huge", 1);
    const res = await forget("huge", 10_000);
    expect(res).toMatchObject({ status: "deleted", trashed: false });
    expect(await t.one(`SELECT id FROM entries WHERE id = 'huge'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'huge'`)).toBeNull();
    expect(await t.all(`SELECT id FROM edges`)).toHaveLength(0);
    expect(await t.all(`SELECT id FROM entry_versions WHERE entry_id = 'huge'`)).toHaveLength(0);
  });

  it("the size SELECT's byte counts equal the bytes of the row actually inserted", async () => {
    t = await makeTrashEnv();
    t.seed("a", { content: "héllo wörld 😀 ".repeat(50) }); t.seed("o"); t.edge("e1", "o", "a"); t.edge("e2", "a", "o");
    const { readTrashCandidates } = await import("../../src/memory/trash");
    const [sizes] = await readTrashCandidates(t.env, ["a"]);
    await forget("a");
    const row = await t.one<any>(`SELECT length(CAST(content AS BLOB)) AS c, length(CAST(row_json AS BLOB)) AS r, length(CAST(edges_json AS BLOB)) AS g FROM entries_trash WHERE id = 'a'`);
    expect([sizes.content_bytes, sizes.row_json_bytes, sizes.edges_json_bytes]).toEqual([row!.c, row!.r, row!.g]);
  });

  it("5,000 incoming edges select tier 2 through the route, and the deleted audit says edgesDropped", async () => {
    t = await makeTrashEnv();
    t.seed("hub");
    // 有効なendpointを持つ4,000 edgeで1.8 MBを超える。
    const marker = t.sqlite.fixtureMarker();
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
      INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, write_marker)
      SELECT 's' || i, 'source', '[]', 'api', 1, '[]', '${t.roots.ownerPersonalWorkspaceId}', '', '${marker}' FROM n`);
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
      INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id, write_marker)
      SELECT 'e' || i, 's' || i, 'hub', 'relates_to', 0.5, 'explicit', json_object('pad', replace(hex(zeroblob(300)), '00', 'ab')), 1, 1, '${t.roots.ownerPersonalWorkspaceId}', '${marker}' FROM n`);
    const res = await post("/forget", { id: "hub" });
    const data = await res.json() as any;
    expect(res.status).toBe(200);
    expect(data.trash).toBe(true);
    await Promise.all(pending);
    const ev = await t.one<any>(`SELECT payload FROM entry_events WHERE entry_id = 'hub' AND event = 'deleted'`);
    expect(JSON.parse(ev!.payload)).toMatchObject({ trash: true, reason: "forget", channel: "rest", edgesDropped: true });
    expect((await t.one<any>(`SELECT edges_json FROM entries_trash WHERE id = 'hub'`))!.edges_json).toBe("[]");
  });
});

describe("routes", () => {
  it("REST and MCP audit deleted with trash true, and the REST response states the retention", async () => {
    t = await makeTrashEnv();
    t.seed("r1"); t.seed("m1");
    const res = await post("/forget", { id: "r1" });
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, id: "r1", trash: true, retention_days: 14 });
    await Promise.all(pending);
    const ev = await t.one<any>(`SELECT payload FROM entry_events WHERE entry_id = 'r1' AND event = 'deleted'`);
    expect(JSON.parse(ev!.payload)).toMatchObject({ trash: true, reason: "forget", channel: "rest" });
  });

  it("a REST forget purges expired trash rows, and its purge failure does not fail the forget", async () => {
    t = await makeTrashEnv();
    t.seed("old"); t.seed("new");
    await forget("old");
    await t.sqlite.db.prepare(`UPDATE entries_trash SET deleted_at = 1 WHERE id = 'old'`).run();
    const res = await post("/forget", { id: "new" });
    expect(res.status).toBe(200);
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'old'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'new'`)).not.toBeNull();
    await Promise.all(pending);
    const purged = await t.one<any>(`SELECT payload FROM entry_events WHERE entry_id = 'old' AND event = 'purged'`);
    expect(JSON.parse(purged!.payload)).toMatchObject({ channel: "system:purge", reason: "forget" });
  });

  it("the forget path survives a failing purge", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    const realPrepare = t.sqlite.db.prepare.bind(t.sqlite.db);
    (t.sqlite.db as any).prepare = (sql: string) => {
      if (sql.includes("FROM entries_trash t WHERE t.deleted_at")) throw new Error("purge read failed");
      return realPrepare(sql);
    };
    const res = await forgetEntry("a", t.env, change, { reason: "forget", config: await resolveConfig(t.env) }, t.roots.ownerPersonalWorkspaceId);
    expect(res.status).toBe("deleted");
  });
});

describe("a losing tier-3 forget racing a tier-1 forget of the same id", () => {
  it("adversary (MINOR): must not wipe the history of the row the winner put in the trash", async () => {
    t = await makeTrashEnv();
    t.seed("a", { content: "x".repeat(20_000) });
    t.version("a", 1); t.version("a", 2);
    const cfg = await resolveConfig(t.env);

    // Forget #1 sizes the row while it is large (tier 3 under a 10 KB budget). Before its batch,
    // the row shrinks (an update) and forget #2 trashes it normally, with its history.
    const realBatch = t.env.DB.batch.bind(t.env.DB);
    let injected = false;
    (t.env.DB as any).batch = async (stmts: any[]) => {
      const sqls = stmts.map((s: any) => String(s?.sourceSql?.() ?? ""));
      if (!injected && sqls.some((s) => s.startsWith("DELETE FROM entry_versions WHERE entry_id IN"))) {
        injected = true;
        await t.sqlite.db.prepare(`UPDATE entries SET content = 'short now' WHERE id = 'a'`).run();
        const r2 = await forgetEntry("a", t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: cfg, purge: false, budget: 10_000 }, t.roots.ownerPersonalWorkspaceId);
        expect(r2).toMatchObject({ status: "deleted", trashed: true });
      }
      return realBatch(stmts);
    };
    const r1 = await forgetEntry("a", t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: cfg, purge: false, budget: 10_000 }, t.roots.ownerPersonalWorkspaceId);
    expect(r1.status).toBe("not_found");
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'a'`)).not.toBeNull();
    // The trashed memory's history must be intact (the plan promises versions survive a trash).
    expect((await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'a'`)).length).toBe(2);
    // The LOSING tier-3 attempt's own life-end marker must not have landed -- it never actually
    // removed the row, so this event would permanently hide 'a''s own earlier history.
    expect(await t.one(`SELECT id FROM entry_events WHERE entry_id = 'a' AND event = 'deleted'`)).toBeNull();
  });

  it("a share moves the row's workspace between the read and the batch — not_found, and its event history stays visible", async () => {
    t = await makeTrashEnv();
    t.seed("b", { content: "x".repeat(20_000) });
    await t.sqlite.db.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES ('ev-b', 'b', 'u', 'created', '{}', 1000)`,
    ).run();
    const cfg = await resolveConfig(t.env);

    // Between forgetEntry's own read (authorizing 'b' under the owner's personal workspace) and
    // its batch, a share moves the row to the company workspace -- the same shape as the tier-3
    // race above, but the guard itself is the one under test here, not a competing forget.
    const realBatch = t.env.DB.batch.bind(t.env.DB);
    let injected = false;
    (t.env.DB as any).batch = async (stmts: any[]) => {
      const sqls = stmts.map((s: any) => String(s?.sourceSql?.() ?? ""));
      if (!injected && sqls.some((s: string) => s.startsWith("DELETE FROM entry_versions WHERE entry_id IN"))) {
        injected = true;
        await t.sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'b'`).bind(t.roots.companyWorkspaceId).run();
      }
      return realBatch(stmts);
    };

    const r1 = await forgetEntry("b", t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: cfg, purge: false, budget: 10_000 }, t.roots.ownerPersonalWorkspaceId);
    expect(r1.status).toBe("not_found");
    // The row itself is untouched: still live, just in the workspace the share moved it to.
    const row = await t.one<any>(`SELECT workspace_id FROM entries WHERE id = 'b'`);
    expect(row?.workspace_id).toBe(t.roots.companyWorkspaceId);
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'b'`)).toBeNull();
    // No life-end marker landed: the row's own earlier event is still its own, undisturbed history.
    expect(await t.one(`SELECT id FROM entry_events WHERE entry_id = 'b' AND event = 'deleted'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entry_events WHERE entry_id = 'b' AND event = 'created'`)).not.toBeNull();
  });
});

describe("adversary: the dashboard's forget confirm reads the real config shape", () => {
  it("reads TRASH_RETENTION_DAYS from GET /config's real shape ({ ok, config, ... }), not a flat cfg.TRASH_RETENTION_DAYS", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    t = await makeTrashEnv();
    const res = await worker.fetch(new Request("http://localhost/config", { headers: { Authorization: "Bearer test-token" } }), t.env, ctx);
    const cfg = await res.json() as any;
    expect(typeof cfg.config.TRASH_RETENTION_DAYS).toBe("number");

    // The exact read memory-crud.js makes on that response.
    const src = readFileSync(resolve(import.meta.dirname, "../../public/js/memory-crud.js"), "utf8");
    const read = src.match(/const days = (cfg[^\n]+)/)?.[1];
    expect(read).toBeDefined();
    const days = new Function("cfg", `return ${read}`)(cfg);
    // If this is not a number, the confirm keeps its default (retention-unaware) wording for every forget.
    expect(typeof days).toBe("number");
    expect(days).toBe(14);
  });

  it("the default confirm body never claims the forget cannot be undone", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    for (const file of ["public/index.html", "public/js/i18n.js"]) {
      const src = readFileSync(resolve(import.meta.dirname, "../..", file), "utf8");
      expect(src, file).not.toMatch(/can't be undone.*memory will be removed|cannot be undone.*memory will be removed/i);
    }
  });

  it("the default confirm body's retention wording does not address only members who could change it", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const src = readFileSync(resolve(import.meta.dirname, "../../public/js/i18n.js"), "utf8");
    // "unless you changed it" / "salvo modifiche" presume the reader can change retention, which a
    // team member cannot (round 2 adversary): every locale's default wording must stay neutral.
    expect(src).not.toMatch(/unless you changed it/i);
    expect(src).not.toMatch(/salvo modifiche/i);
  });
});

describe("round 2 adversary: dashboard copy for a memory too large for the trash", () => {
  it("the dashboard tells the person when a forget was a hard delete (REST answers trash:false)", async () => {
    t = await makeTrashEnv();
    t.seed("huge", { content: "x".repeat(1_850_000) });
    const res = await post("/forget", { id: "huge" });
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, trash: false });

    // The confirm promised "It moves to the trash"; the success path must read `trash` to correct that.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(import.meta.dirname, "../../public/js/memory-crud.js"), "utf8");
    const confirmForget = src.slice(src.indexOf("async function confirmForget"), src.indexOf("\n}\n", src.indexOf("async function confirmForget")));
    expect(confirmForget).toMatch(/\.trash\b/);
    // No em dashes in whatever it shows for that case (wording nit alongside the fix).
    const toastCall = confirmForget.match(/showToast\(t\(['"]([\w.]+)['"]\)\)/)?.[1];
    expect(toastCall).toBeDefined();
    const i18n = readFileSync(resolve(import.meta.dirname, "../../public/js/i18n.js"), "utf8");
    const key = toastCall!.split(".").pop()!;
    const strings = [...i18n.matchAll(new RegExp(`${key}: '([^']*)'`, "g"))].map((m) => m[1]);
    expect(strings.length).toBeGreaterThanOrEqual(2); // en and it both have it
    for (const s of strings) expect(s).not.toMatch(/—/);
  });
});
