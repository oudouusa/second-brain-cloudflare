import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { captureEntry } from "../../src/capture/entry";
import { applyStatus, deprecateEntry } from "../../src/capture/lifecycle";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { DEFAULTS } from "../../src/config";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
} });
const person = { workspaceId: "", actorId: "u1" };
const system = { workspaceId: "", actorId: "" };

let sqlite: SqliteD1;
let env: Env;
let deleteByIds: any;

/** A brain whose duplicate check finds row "old" at `score` and whose model answers `decision`. */
async function setup(score: number, decision: string) {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  deleteByIds = vi.fn(async (_ids: string[]): Promise<any> => ({ mutationId: "m" }));
  env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as any,
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [{ id: "old", score, metadata: { parentId: "old" } }] }),
      deleteByIds,
    }),
    AI: { run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m" ? { data: [new Array(768).fill(0.1)] } : stream(decision)) } as any,
  })) as Env;
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
}
afterEach(() => sqlite?.close());

const versions = async (id: string) =>
  (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const row = async (id: string) => (await env.DB.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const merge = (text: string) => JSON.stringify({ action: "merge", target_id: "old", merged_content: text });
const replace = () => JSON.stringify({ action: "replace", target_id: "old" });
const contradicts = () => JSON.stringify({ contradicts: true, conflicting_id: "old", reason: "changed" });

describe("versioning: capture merge and replace", () => {
  it("a merge records the target's prior text and the raw incoming text", async () => {
    await setup(0.9, merge("combined text"));
    sqlite.seed({ id: "old", content: "Old text", tags: ["work"], source: "api", createdAt: 1000 });
    const r = await captureEntry("Incoming fact #newtag", ["x"], "claude", env, ctx, undefined, person, undefined, { channel: "rest" });
    expect(r.status).toBe("merged");
    const [v] = await versions("old");
    expect(v).toMatchObject({ seq: 1, reason: "merge", content: "Old text", channel: "rest", actor_id: "u1" });
    expect(JSON.parse(v.meta)).toEqual({ incoming: "Incoming fact", incomingTags: expect.arrayContaining(["x", "newtag"]), incomingSource: "claude" });
    expect((await row("old")).content).toBe("combined text");
  });

  it("a replace records reason replace", async () => {
    await setup(0.9, replace());
    sqlite.seed({ id: "old", content: "Old text", tags: ["work"], source: "api", createdAt: 1000 });
    const r = await captureEntry("Newer text", [], "claude", env, ctx, undefined, person, undefined, { channel: "mcp" });
    expect(r.status).toBe("replaced");
    const [v] = await versions("old");
    expect(v).toMatchObject({ reason: "replace", content: "Old text", channel: "mcp" });
    expect(JSON.parse(v.meta).incoming).toBe("Newer text");
  });

  it("a CJK-heavy incoming over the byte budget records incomingTruncated and still merges", async () => {
    await setup(0.9, merge("combined"));
    sqlite.seed({ id: "old", content: "Old text", tags: ["work"], source: "api", createdAt: 1000 });
    const incoming = "日本語".repeat(1400); // 4,200 characters, 12,600 bytes
    const r = await captureEntry(incoming, [], "claude", env, ctx, undefined, person, undefined, { channel: "rest", versionRowBudgetBytes: 10_000 });
    expect(r.status).toBe("merged");
    const [v] = await versions("old");
    expect(JSON.parse(v.meta)).toEqual({ incomingTruncated: true, incomingBytes: 12_600 });
    expect(v.content).toBe("Old text");
  });

  it("a system job merging into its own untouched row records system:digest; it cannot reach a user row, an edited digest or the other job's row", async () => {
    await setup(0.9, merge("digest v2"));
    sqlite.seed({ id: "old", content: "Digest v1", tags: ["synthesized"], source: "system", createdAt: 1000 });
    const r = await captureEntry("Digest v2 draft", ["synthesized"], "system", env, ctx, undefined, system, undefined, { systemWrite: "digest", channel: "system:digest" });
    expect(r.status).toBe("merged");
    expect(await versions("old")).toEqual([expect.objectContaining({ reason: "merge", channel: "system:digest", actor_id: "", content: "Digest v1" })]);

    for (const [label, tags, source, actor] of [
      ["a user row", ["work"], "api", "u1"],
      ["an edited digest", ["synthesized", "user-edited"], "system", ""],
      ["the other job's row", ["auto-insight"], "system", ""],
    ] as const) {
      sqlite.close();
      await setup(0.9, merge("digest v2"));
      sqlite.seed({ id: "old", content: "Untouchable", tags: [...tags], source, createdAt: 1000 });
      if (actor) sqlite.db.prepare(`UPDATE entries SET actor_id = ? WHERE id = 'old'`).bind(actor).run();
      const res = await captureEntry("Digest v2 draft", ["synthesized"], "system", env, ctx, undefined, system, undefined, { systemWrite: "digest", channel: "system:digest" });
      expect(res.status, label).not.toBe("merged");
      expect(await versions("old"), label).toEqual([]);
      expect((await row("old")).content, label).toBe("Untouchable");
    }
  });

  it("a system merge that loses its compare-and-set to a person's concurrent edit writes no version", async () => {
    await setup(0.9, merge("digest v2"));
    sqlite.seed({ id: "old", content: "Digest v1", tags: ["synthesized"], source: "system", createdAt: 1000 });
    const db = env.DB as any;
    const prepare = db.prepare.bind(db);
    let raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true;
        sqlite.db.prepare(`UPDATE entries SET content = 'MY CORRECTION', tags = '["synthesized","user-edited"]' WHERE id = 'old'`).run();
      }
      return prepare(sql);
    };
    const r = await captureEntry("Digest v2 draft", ["synthesized"], "system", env, ctx, undefined, system, undefined, { systemWrite: "digest", channel: "system:digest" });
    expect(raced).toBe(true);
    expect(r.status).not.toBe("merged");
    expect(await versions("old")).toEqual([]);
    expect((await row("old")).content).toBe("MY CORRECTION");
  });

  it("a person's merge into a digest records the version, and the new tags carry user-edited", async () => {
    await setup(0.9, merge("digest with my fact"));
    sqlite.seed({ id: "old", content: "Digest v1", tags: ["synthesized", "work"], source: "system", createdAt: 1000 });
    const r = await captureEntry("my fact", [], "api", env, ctx, undefined, person, undefined, { channel: "rest" });
    expect(r.status).toBe("merged");
    const [v] = await versions("old");
    expect(JSON.parse(v.tags)).not.toContain("user-edited");
    expect(JSON.parse((await row("old")).tags)).toContain("user-edited");
  });
});

describe("versioning: contradiction", () => {
  it("the contradiction branch versions the superseded row (a person's capture)", async () => {
    await setup(0.72, contradicts());
    sqlite.seed({ id: "old", content: "We decided X", tags: ["decisions"], source: "api", vectorIds: ["old"], createdAt: 1000 });
    const r = await captureEntry("Actually Y", [], "api", env, ctx, undefined, person, undefined, { channel: "rest" });
    expect(r.status).toBe("contradiction");
    const [v] = await versions("old");
    // T-0089.2.1: a validity version; the row keeps its tags (no deprecation) and its window closes.
    expect(v).toMatchObject({ reason: "validity", channel: "rest", actor_id: "u1" });
    expect(JSON.parse(v.tags)).toEqual(["decisions"]);
    expect(JSON.parse(v.meta)).toEqual({ cause: "supersede", by: (r as any).id });
    expect(JSON.parse((await row("old")).tags)).not.toContain("status:deprecated");
    expect((await row("old")).valid_until).not.toBeNull();
  });

  it("the system compare-and-set supersede versions its row with the same guard, and a lost guard writes no version", async () => {
    await setup(0.72, contradicts());
    sqlite.seed({ id: "old", content: "Digest v1", tags: ["synthesized"], source: "system", vectorIds: ["old"], createdAt: 1000 });
    const r = await captureEntry("Digest contradicting", ["synthesized"], "system", env, ctx, undefined, system, undefined, { systemWrite: "digest", channel: "system:digest" });
    expect(r.status).toBe("contradiction");
    const [v] = await versions("old");
    expect(v).toMatchObject({ reason: "validity", channel: "system:digest", actor_id: "" });
    expect(JSON.parse(v.meta).cause).toBe("supersede");
    expect(deleteByIds).not.toHaveBeenCalled();

    // Lost race: a person edits the row between the read and the batch.
    sqlite.close();
    await setup(0.72, contradicts());
    sqlite.seed({ id: "old", content: "Digest v1", tags: ["synthesized"], source: "system", vectorIds: ["old"], createdAt: 1000 });
    const db = env.DB as any;
    const prepare = db.prepare.bind(db);
    let raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true;
        sqlite.db.prepare(`UPDATE entries SET content = 'MY CORRECTION', tags = '["synthesized","user-edited"]' WHERE id = 'old'`).run();
      }
      return prepare(sql);
    };
    const lost = await captureEntry("Digest contradicting", ["synthesized"], "system", env, ctx, undefined, system, undefined, { systemWrite: "digest", channel: "system:digest" });
    expect(raced).toBe(true);
    expect(lost.status).toBe("contradiction_protected");
    expect(await versions("old")).toEqual([]);
  });
});

describe("versioning: status", () => {
  const change = { actorId: "u1", channel: "rest" as const };
  beforeEach(async () => {
    await setup(0.1, "{}");
    sqlite.seed({ id: "e1", content: "Some fact", tags: ["b", "a"], source: "api", vectorIds: ["v1", "v2"], createdAt: 1000 });
  });

  it("set_status canonical then draft writes two status versions", async () => {
    await applyStatus("e1", "canonical", env, change, DEFAULTS, "");
    await applyStatus("e1", "draft", env, change, DEFAULTS, "");
    const vs = await versions("e1");
    expect(vs.map(v => [v.seq, v.reason, JSON.parse(v.meta).status])).toEqual([[1, "status", "canonical"], [2, "status", "draft"]]);
    expect(JSON.parse(vs[0].tags)).toEqual(["b", "a"]);
    expect(JSON.parse(vs[1].tags)).toContain("status:canonical");
  });

  it("set_status to the current status writes no version even when withStatus reorders the tags", async () => {
    await applyStatus("e1", "canonical", env, change, DEFAULTS, "");
    expect(await versions("e1")).toHaveLength(1);
    // Stored order differs from what withStatus produces; the set is unchanged.
    sqlite.db.prepare(`UPDATE entries SET tags = '["status:canonical","a","b"]' WHERE id = 'e1'`).run();
    await applyStatus("e1", "canonical", env, change, DEFAULTS, "");
    expect(await versions("e1")).toHaveLength(1);
  });

  it("deprecate records the prior tags and still deletes the vectors", async () => {
    expect(await deprecateEntry("e1", env, change, DEFAULTS, "")).toBe(true);
    const [v] = await versions("e1");
    expect(JSON.parse(v.tags)).toEqual(["b", "a"]);
    expect(v.reason).toBe("status");
    expect((await row("e1")).vector_ids).toBe("[]");
    expect(deleteByIds).toHaveBeenCalledWith(["v1", "v2"]);
  });

  it("a deprecate pinned to another workspace writes neither the change nor a version", async () => {
    sqlite.db.prepare(`UPDATE entries SET workspace_id = 'w-elsewhere' WHERE id = 'e1'`).run();
    expect(await deprecateEntry("e1", env, change, DEFAULTS, "")).toBe(false);
    expect(await versions("e1")).toEqual([]);
    expect(JSON.parse((await row("e1")).tags)).toEqual(["b", "a"]);
  });

  it("REST and MCP status versions are identical except channel", async () => {
    const roots = await ensureTenantBootstrap(env);
    const owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
    const res = await worker.fetch(req("POST", "/status", { body: { id: "e1", status: "canonical" } }), env, ctx);
    expect(res.status).toBe(200);
    const restV = await versions("e1");
    sqlite.db.prepare(`UPDATE entries SET tags = '["b","a"]' WHERE id = 'e1'`).run();
    sqlite.db.prepare(`DELETE FROM entry_versions`).run();
    const server = buildMcpServer(env, ctx, owner);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    await client.callTool({ name: "set_status", arguments: { id: "e1", status: "canonical" } });
    await client.close();
    const mcpV = await versions("e1");
    // meta.event_id (round 3 re-review MAJOR) is minted fresh per call -- legitimately different
    // between the REST and MCP writes this test compares, so it is stripped the same way id/
    // channel/created_at/valid_from already are.
    const strip = ({ write_marker: _wm, restore_lease_owner: _ro, id: _i, channel: _c, created_at: _t, valid_from: _v, meta, ...rest }: any) => {
      const { event_id: _e, ...metaRest } = JSON.parse(meta || "{}");
      return { ...rest, meta: metaRest };
    };
    expect(restV[0].channel).toBe("rest");
    expect(mcpV[0].channel).toBe("mcp");
    expect(strip(mcpV[0])).toEqual(strip(restV[0]));
  });
});
