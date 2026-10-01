/**
 * POST /update and the MCP `update` tool must leave the database in the SAME state.
 *
 * They were two implementations of one operation, and the MCP copy — the path every
 * assistant client actually calls — quietly drifted (#289): it committed content against
 * stale vectors when an embed failed, never moved updated_at, never reset the staleness
 * tags, and never extracted hashtags. Every one of those is invisible from the
 * MCP side alone; each only reads as a bug next to what the route does with the same
 * input. Nothing compared them, so nothing failed.
 *
 * So this suite does not assert what update *should* write. It runs each scenario through
 * both callers against the same starting row and asserts the resulting rows and vectors are
 * identical — then, separately, pins the handful of facts that both must satisfy so a
 * change that breaks them in both places is still caught. Add a scenario to CASES and both
 * callers are covered by construction.
 *
 * Real workerd D1 through Miniflare, not test/helpers/d1-mock. The mock matches query
 * strings, so it cannot tell a row that was written from one that was not — which is
 * exactly the distinction the fail-closed path turns on — and it has diverged from
 * production in this repo before, in both directions.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { requireIdentity } from "../../src/lib/identity";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeAIMock, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { beginMemoryWriteAdmission, memoryWriteMarker } from "../../src/migration/write-lock";
import { updateEntryContent } from "../../src/capture/store";
import { createEdge, inferEdgesOnWrite, replaceInferredEdgesOnWrite } from "../../src/graph/edges";
import { cleanTemp } from "../helpers/tmp";

afterAll(cleanTemp);

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;

const ENTRY_ID = "x1";
/** Fixed, so the two runs of a scenario are byte-identical everywhere the code does not write. */
const SEEDED_AT = Date.parse("2024-01-17T00:00:00Z");

// ── The world both callers run against ──────────────────────────────────────────────────

/** Vectorize with real insert/upsert/delete semantics, so "what is indexed" is observable. */
function makeStatefulVectorize(seed: { id: string; content: string }[], overrides: Partial<Vectorize> = {}) {
  const store = new Map<string, any>();
  // Real vectors name their entry in metadata.parentId (deleteEntryVectors checks it, T-0089.1.1).
  for (const v of seed) store.set(v.id, { id: v.id, values: [], metadata: { content: v.content, parentId: v.id.replace(/-chunk-\d+$/, "") } });
  const index = makeVectorizeMock({
    insert: vi.fn(async (vectors: any[]): Promise<any> => {
      for (const v of vectors) if (!store.has(v.id)) store.set(v.id, v);
      return { mutationId: "m" };
    }),
    upsert: vi.fn(async (vectors: any[]): Promise<any> => {
      for (const v of vectors) store.set(v.id, v);
      return { mutationId: "m" };
    }),
    deleteByIds: vi.fn(async (ids: string[]): Promise<any> => {
      for (const id of ids) store.delete(id);
      return { mutationId: "m" };
    }),
    getByIds: vi.fn(async (ids: string[]): Promise<any> => ids.filter(id => store.has(id)).map(id => store.get(id))),
    ...overrides,
  });
  return { store, index };
}

/** Workers AI that embeds normally, or refuses — a transient embed failure is one of these. */
function makeAI({ embedFails }: { embedFails: boolean }): Ai {
  if (!embedFails) return makeAIMock();
  return {
    run: vi.fn(async () => { throw new Error("AI binding overloaded"); }),
  } as unknown as Ai;
}

type World = {
  /** The entry as it exists before the update. */
  seed: {
    content: string;
    tags: string[];
    source?: string;
    vectorIds?: string[];
    createdAt?: number;
    updatedAt?: number | null;
  };
  /** What is in Vectorize before the update, keyed by vector id. */
  vectors?: { id: string; content: string }[];
  /** A single embed call fails, with the index itself healthy — #212's transient case. */
  embedFails?: boolean;
  /** describe() throws: Vectorize is not reachable at all — #270's keyword-only deployment. */
  vectorizeDown?: boolean;
  /** Retiring the orphaned vectors fails. Non-fatal: the content is already committed. */
  deleteFails?: boolean;
  /** A connected integration owns entries with this source, making them read-only. */
  connectedIntegration?: string;
  /** Parent-level candidates returned while refreshing inferred edges. */
  queryMatches?: { id: string; score: number; metadata?: Record<string, unknown> }[];
};

// ── State capture ───────────────────────────────────────────────────────────────────────

type Snapshot = {
  row: Record<string, unknown> | null;
  vectors: { id: string; content: unknown }[];
  /** entry_versions rows, oldest first. */
  versions: Record<string, unknown>[];
};

/**
 * updated_at is Date.now(), so the two runs cannot produce the same number. Collapsing it
 * to a marker keeps the comparison meaningful while still failing when one caller writes it
 * and the other leaves it NULL — which is divergence (b), and the whole reason it is here.
 * Freshness is asserted separately, against the clock.
 */
function normalize(snapshot: Snapshot): Snapshot {
  // The caller's channel, the clock and the row id are the only fields that may differ between REST and MCP.
  const versions = snapshot.versions.map(({ id: _id, channel: _channel, created_at: _created, valid_from: _valid, meta, ...rest }) => {
    // event_id (round 4 re-review MAJOR) is minted fresh per call -- legitimately different
    // between the REST and MCP writes this test compares, same reasoning as updated_at below.
    let metaRest: unknown = meta;
    if (typeof meta === "string") {
      try {
        const { event_id: _e, ...m } = JSON.parse(meta) as Record<string, unknown>;
        metaRest = JSON.stringify(m);
      } catch { /* not JSON: leave as-is */ }
    }
    if (typeof rest.write_marker === "string") rest.write_marker = "<capability>";
    return { ...rest, meta: metaRest };
  });
  if (!snapshot.row) return { ...snapshot, versions };
  const row = { ...snapshot.row };
  if (typeof row.updated_at === "number") row.updated_at = "<written>";
  if (typeof row.write_marker === "string") row.write_marker = "<capability>";
  const generated = [...new Set([
    ...snapshot.vectors.map(vector => vector.id),
    ...(JSON.parse((row.vector_ids as string) ?? "[]") as string[]),
  ].filter(id => /^v-[0-9a-f-]+-\d+$/.test(id)))].sort();
  const canonical = new Map(generated.map((id, index) => [id, `<generated-${index}>`]));
  row.vector_ids = JSON.stringify(
    (JSON.parse((row.vector_ids as string) ?? "[]") as string[]).map(id => canonical.get(id) ?? id),
  );
  return {
    row, versions,
    vectors: snapshot.vectors.map(vector => ({ ...vector, id: canonical.get(vector.id) ?? vector.id })),
  };
}

describe("POST /update and the MCP update tool write identical state (#289)", () => {
  let mf: Miniflare;
  let d1: D1Database;
  let fixtureToken: string;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DB: "update-parity" },
    });
    d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    // The real migration keeps this Miniflare database aligned with the complete
    // reference schema and exercises the same production initializer.
    resetDatabaseInit();
    await initializeDatabase({ DB: d1 } as Env);
    fixtureToken = `fixture-${crypto.randomUUID()}`;
    await d1.prepare(
      `INSERT INTO memory_write_admissions (token, started_at, expires_at, generation)
       SELECT ?, ?, ?, generation FROM memory_write_epoch WHERE id = 'current'`,
    ).bind(fixtureToken, Date.now(), Number.MAX_SAFE_INTEGER).run();
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  function makeEnv(world: World) {
    const { store, index } = makeStatefulVectorize(world.vectors ?? [], {
      ...(world.queryMatches ? { query: vi.fn().mockResolvedValue({ matches: world.queryMatches }) } : {}),
      ...(world.vectorizeDown ? { describe: vi.fn(async () => { throw new Error("no such index"); }) } : {}),
      ...(world.deleteFails ? { deleteByIds: vi.fn(async () => { throw new Error("delete failed"); }) } : {}),
    });
    const OAUTH_KV = makeMemoryKV();
    const env = {
      DB: d1,
      VECTORIZE: index,
      AI: makeAI({ embedFails: world.embedFails ?? world.vectorizeDown ?? false }),
      AUTH_TOKEN: "test-token",
      OAUTH_KV,
    } as unknown as Env;
    return { env, store, OAUTH_KV };
  }

  /**
   * A world, from scratch. Called once per caller, so the second run starts from exactly
   * the row the first one did rather than from what the first one left behind.
   */
  async function setUp(world: World) {
    await d1.prepare(`UPDATE entries SET write_marker = ?`)
      .bind(`${fixtureToken}:delete:${crypto.randomUUID()}`).run();
    await d1.prepare(`DELETE FROM entries`).run();
    const { env, store, OAUTH_KV } = makeEnv(world);
    // Provision tenancy BEFORE seeding so the seed lands in the owner's personal
    // workspace exactly like any post-bootstrap write — otherwise the first caller
    // in the file would get its row backfilled and later ones would not.
    const owner = await ownerOf(env);
    await d1.prepare(`UPDATE entries SET write_marker = ?`).bind(`${fixtureToken}:delete:${crypto.randomUUID()}`).run();
    await d1.prepare(`UPDATE entry_versions SET write_marker = ?`).bind(`${fixtureToken}:delete:${crypto.randomUUID()}`).run();
    await d1.prepare(`DELETE FROM entries`).run();
    await d1.prepare(`DELETE FROM entry_versions`).run();
    if (world.connectedIntegration) {
      await OAUTH_KV.put(
        `integrations:${world.connectedIntegration}`,
        JSON.stringify({ provider: world.connectedIntegration, status: "connected", itemMap: {} }),
      );
    }
    const s = world.seed;
    await d1.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, recall_count, importance_score, write_marker)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 3, ?)`,
    ).bind(
      ENTRY_ID,
      s.content,
      JSON.stringify(s.tags),
      s.source ?? "claude",
      s.createdAt ?? SEEDED_AT,
      s.updatedAt ?? null,
      JSON.stringify(s.vectorIds ?? [ENTRY_ID]),
      `${fixtureToken}:write:${crypto.randomUUID()}`,
    ).run();
    return { env, store };
  }

  async function capture(store: Map<string, any>): Promise<Snapshot> {
    const row = await d1.prepare(`SELECT * FROM entries WHERE id = ?`).bind(ENTRY_ID).first();
    const versions = (await d1.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(ENTRY_ID).all()).results as Record<string, unknown>[];
    // Vector ids are minted per upload (T-0089.1.1): a fresh one is compared as `<entry>~<chunk>`, so two
    // callers that did the same thing produce the same snapshot; 3.7's ids stay as they are.
    const canon = (id: string) => id.replace(/:[0-9a-f]{8}:(\d+)$/, "~$1");
    const r = (row as Record<string, unknown> | null) ?? null;
    if (r && typeof r.vector_ids === "string") r.vector_ids = JSON.stringify((JSON.parse(r.vector_ids) as string[]).map(canon));
    return {
      versions,
      row: r,
      vectors: [...store.values()]
        .map(v => ({ id: canon(v.id as string), content: v.metadata?.content }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  /** POST /update, through the whole Worker. */
  async function viaHttp(world: World, content: string) {
    const { env, store } = await setUp(world);
    const res = await worker.fetch(req("POST", "/update", { body: { id: ENTRY_ID, content } }), env, ctx);
    const body = await res.json() as any;
    return { snapshot: await capture(store), status: res.status, reply: body.message ?? body.error ?? "" };
  }

  /** The owner identity, resolved exactly as the API handler does before building the server. */
  async function ownerOf(env: Env) {
    const request = req("POST", "/mcp");
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) throw new Error("owner failed to resolve");
    return auth;
  }

  /** The MCP `update` tool, through a real MCP client and transport. */
  async function viaMcp(world: World, content: string) {
    const { env, store } = await setUp(world);
    const admitted = await beginMemoryWriteAdmission(env, ctx);
    const server = buildMcpServer(admitted.env, admitted.ctx, await ownerOf(env));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "parity-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: "update", arguments: { id: ENTRY_ID, content } });
      const reply = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      return { snapshot: await capture(store), reply };
    } finally {
      await client.close();
      await admitted.finish();
    }
  }

  // ── The scenarios ─────────────────────────────────────────────────────────────────────

  type Case = {
    name: string;
    world: World;
    content: string;
    /** Facts both callers must satisfy. Parity alone would pass if both were wrong. */
    expect: (snapshot: Snapshot) => void;
  };

  const tagsOf = (snapshot: Snapshot) => JSON.parse((snapshot.row!.tags as string) ?? "[]") as string[];

  const CASES: Case[] = [
    {
      name: "healthy re-index",
      world: { seed: { content: "I live in Berlin", tags: ["home"] }, vectors: [{ id: ENTRY_ID, content: "I live in Berlin" }] },
      content: "I live in Lisbon",
      expect: (s) => {
        expect(s.row!.content).toBe("I live in Lisbon");
        expect(s.vectors).toHaveLength(1);
        expect(s.vectors[0].content).toBe("I live in Lisbon");
        expect(s.vectors[0].id).toMatch(/^v-[0-9a-f-]+-0$/);
        expect(JSON.parse(s.row!.vector_ids as string)).toEqual([s.vectors[0].id]);
      },
    },
    {
      name: "(b) staleness verdicts are cleared and updated_at moves",
      world: {
        seed: {
          content: "I live in Berlin",
          tags: ["home", "volatility:state", "stale:as-of"],
          updatedAt: SEEDED_AT,
        },
      },
      content: "I live in Lisbon",
      expect: (s) => {
        // The verdicts described the content that was just replaced. Left behind, recall
        // reports a seconds-old correction as years stale and hedges the answer built on it.
        expect(tagsOf(s)).toEqual(["home"]);
        // And a stationary updated_at leaves the row a permanent staleness-pass candidate,
        // so the tag comes straight back on the next nightly run.
        expect(s.row!.updated_at as number).toBeGreaterThan(Date.parse("2025-01-01T00:00:00Z"));
      },
    },
    {
      name: "(c) hashtags are extracted from the new content",
      world: { seed: { content: "I live in Berlin", tags: ["home"] } },
      content: "Moving to Lisbon #relocation",
      expect: (s) => {
        expect(s.row!.content).toBe("Moving to Lisbon");
        expect(tagsOf(s)).toEqual(["home", "relocation"]);
      },
    },
    {
      name: "(c) extraction flattens whitespace, including inside a fenced code block",
      world: { seed: { content: "old runbook", tags: ["ops"] } },
      content: "Runbook:\n\n1. drain\n2. deploy\n\n```sh\nnpm run deploy\n```\n\nTicket #4821",
      expect: (s) => {
        // Spelled out because it is destructive and, for the MCP path, new: the private copy
        // stored content verbatim. extractHashtags collapses every whitespace run to one
        // space and removes named #tokens, so line breaks, list structure and code fences do
        // not survive a replacement. This is not a regression — captureEntry has always done
        // it, so `remember` through this same transport produces a byte-identical row, and
        // POST /update already did it. Divergence was the bug; this is what agreeing with
        // the rest of the write path costs.
        //
        // `#4821` stays in the content and does NOT become a tag: a bare number is an issue
        // reference, and reading it as a tag produced rows carrying twenty numeric "tags"
        // from synced PR bodies (src/text/hashtags.ts).
        //
        // `append` deliberately does NOT flatten: it embeds the addition verbatim after a
        // "[Update <date>]: " separator (src/capture/store.ts), so newlines survive there.
        // Reach for append, not update, when the text's shape matters.
        expect(s.row!.content).toBe("Runbook: 1. drain 2. deploy ```sh npm run deploy ``` Ticket #4821");
        expect(tagsOf(s)).toEqual(["ops"]);
      },
    },
    {
      name: "a hashtag already held as a tag is not duplicated",
      world: { seed: { content: "Berlin flat", tags: ["home"] } },
      content: "Lisbon flat #home",
      expect: (s) => expect(tagsOf(s)).toEqual(["home"]),
    },
    {
      name: "content that is nothing but hashtags is kept verbatim",
      world: { seed: { content: "Berlin flat", tags: ["home"] } },
      content: "#lisbon",
      expect: (s) => {
        expect(s.row!.content).toBe("#lisbon");
        expect(tagsOf(s)).toEqual(["home", "lisbon"]);
      },
    },
    {
      name: "rolled-up is dropped: the digest marker it annotated is gone with the old content",
      world: { seed: { content: "Berlin flat\n\n[Digest: d9]", tags: ["home", "rolled-up"] } },
      content: "Lisbon flat",
      expect: (s) => {
        expect(tagsOf(s)).toEqual(["home"]);
        expect(s.row!.content).toBe("Lisbon flat");
      },
    },
    {
      name: "(a) a transient embed failure against a healthy index fails closed",
      world: {
        seed: { content: "I live in Berlin", tags: ["home"] },
        vectors: [{ id: ENTRY_ID, content: "I live in Berlin" }],
        embedFails: true,
      },
      content: "I live in Lisbon",
      expect: (s) => {
        // Committing here would leave D1 saying Lisbon and Vectorize saying Berlin, with a
        // non-empty vector_ids — so /vectorize-pending and /stats.unvectorized, which both
        // select vector_ids = '[]', would never see it and recall would answer Berlin forever.
        expect(s.row!.content).toBe("I live in Berlin");
        expect(s.row!.updated_at).toBeNull();
        expect(s.vectors).toEqual([{ id: ENTRY_ID, content: "I live in Berlin" }]);
      },
    },
    {
      name: "Vectorize unreachable commits keyword-only and keeps the old index",
      world: {
        seed: { content: "I live in Berlin", tags: ["home"] },
        vectors: [{ id: ENTRY_ID, content: "I live in Berlin" }],
        vectorizeDown: true,
      },
      content: "I live in Lisbon",
      expect: (s) => {
        // Keyword search reads entries.content, so the correction is still findable.
        expect(s.row!.content).toBe("I live in Lisbon");
        // The old vectors are the entry's only remaining semantic index — retiring them
        // would make it unsearchable rather than merely stale.
        expect(JSON.parse(s.row!.vector_ids as string)).toEqual([ENTRY_ID]);
        expect(s.vectors).toEqual([{ id: ENTRY_ID, content: "I live in Berlin" }]);
      },
    },
    {
      name: "a multi-chunk entry shrinking to one chunk retires every old vector",
      world: {
        seed: { content: "long original", tags: ["work"], vectorIds: [ENTRY_ID, `${ENTRY_ID}-chunk-1`] },
        vectors: [
          { id: ENTRY_ID, content: "long original" },
          { id: `${ENTRY_ID}-chunk-1`, content: "long original tail" },
        ],
      },
      content: "short replacement",
      expect: (s) => {
        expect(s.vectors).toHaveLength(1);
        expect(s.vectors[0].content).toBe("short replacement");
        expect(s.vectors[0].id).toMatch(/^v-[0-9a-f-]+-0$/);
        expect(JSON.parse(s.row!.vector_ids as string)).toEqual([s.vectors[0].id]);
      },
    },
    {
      name: "a failed retirement of the orphaned vector does not undo the update",
      world: {
        seed: { content: "long original", tags: ["work"], vectorIds: [ENTRY_ID, `${ENTRY_ID}-chunk-1`] },
        vectors: [
          { id: ENTRY_ID, content: "long original" },
          { id: `${ENTRY_ID}-chunk-1`, content: "long original tail" },
        ],
        deleteFails: true,
      },
      content: "short replacement",
      expect: (s) => {
        // The new vectors are already in place, so the leftover orphan is a tidiness
        // problem, not a correctness one — rolling the content back would be worse.
        expect(s.row!.content).toBe("short replacement");
        const ids = JSON.parse(s.row!.vector_ids as string) as string[];
        expect(ids).toHaveLength(1);
        expect(ids[0]).toMatch(/^v-[0-9a-f-]+-0$/);
      },
    },
    {
      name: "an entry owned by a connected integration is refused before anything is written",
      world: { seed: { content: "Synced page", tags: ["notion"], source: "notion" }, connectedIntegration: "notion" },
      content: "Hand-edited",
      expect: (s) => {
        expect(s.row!.content).toBe("Synced page");
        expect(s.row!.updated_at).toBeNull();
      },
    },
  ];

  it.each(CASES)("$name — both callers agree", async ({ world, content, expect: assertFacts }) => {
    const http = await viaHttp(world, content);
    const mcp = await viaMcp(world, content);

    expect(normalize(mcp.snapshot)).toEqual(normalize(http.snapshot));
    assertFacts(http.snapshot);
    assertFacts(mcp.snapshot);
  }, 15_000);

  it("a missing entry leaves both callers with nothing to write", async () => {
    const world: World = { seed: { content: "present", tags: [] } };

    const { env: httpEnv, store: httpStore } = await setUp(world);
    const res = await worker.fetch(req("POST", "/update", { body: { id: "nope", content: "x" } }), httpEnv, ctx);
    expect(res.status).toBe(404);
    const httpSnapshot = await capture(httpStore);

    const { env: mcpEnv, store: mcpStore } = await setUp(world);
    const server = buildMcpServer(mcpEnv, ctx, await ownerOf(mcpEnv));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "parity-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    let reply = "";
    try {
      const result = await client.callTool({ name: "update", arguments: { id: "nope", content: "x" } });
      reply = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    } finally {
      await client.close();
    }

    expect(reply).toMatch(/No memory found with ID: nope/);
    expect(normalize(await capture(mcpStore))).toEqual(normalize(httpSnapshot));
  });

  it("a committed replacement recalculates only inferred relates_to edges on real D1", async () => {
    const world: World = {
      seed: { content: "old subject", tags: ["work", "second-brain"] },
      queryMatches: [
        { id: ENTRY_ID, score: 1, metadata: { parentId: ENTRY_ID } },
        { id: "fresh", score: 0.55, metadata: { parentId: "fresh" } },
        { id: "stale", score: 0.69, metadata: { parentId: "stale" } },
      ],
    };
    const { env } = await setUp(world);
    const admission = await beginMemoryWriteAdmission(env, ctx);
    const admitted = admission.env;
    try {
      for (const [id, tags] of [
        ["stale", ["upwork"]], ["fresh", ["second-brain"]], ["manual", ["context"]],
      ] as const) {
        await admitted.DB.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, write_marker)
           VALUES (?, ?, ?, 'api', 1, 1, '[]', ?)`,
        ).bind(id, id, JSON.stringify(tags), memoryWriteMarker(admitted)).run();
      }
      await createEdge(ENTRY_ID, "stale", "relates_to", { provenance: "inferred", weight: 0.8, readableWorkspaceIds: [""] }, admitted);
      await createEdge(ENTRY_ID, "manual", "relates_to", { provenance: "explicit", weight: 0.4, readableWorkspaceIds: [""] }, admitted);
      await createEdge(ENTRY_ID, "stale", "supersedes", { provenance: "system", weight: 1, readableWorkspaceIds: [""] }, admitted);

      expect((await updateEntryContent(admitted, ENTRY_ID, "replacement about the second brain", undefined, undefined, undefined, { workspaceId: "", actorId: "" }, { actorId: "", channel: "rest" as const }, "")).status)
        .toBe("updated");
      const edges = (await admitted.DB.prepare(
        `SELECT source_id, target_id, type, weight, provenance, metadata FROM edges ORDER BY provenance`,
      ).all()).results as Record<string, any>[];
      expect(edges.some(edge => edge.provenance === "inferred"
        && [edge.source_id, edge.target_id].includes("fresh")
        && JSON.parse(edge.metadata).inference_policy === "embeddinggemma-mrl128-v2")).toBe(true);
      expect(edges.some(edge => edge.provenance === "inferred"
        && [edge.source_id, edge.target_id].includes("stale"))).toBe(false);
      expect(edges.some(edge => edge.provenance === "explicit" && edge.weight === 0.4)).toBe(true);
      expect(edges.some(edge => edge.type === "supersedes" && edge.provenance === "system")).toBe(true);

      await inferEdgesOnWrite(ENTRY_ID, [{ id: "manual", score: 0.9 }], admitted);
      expect(await admitted.DB.prepare(
        `SELECT weight, provenance FROM edges WHERE type = 'relates_to' AND provenance = 'explicit'`,
      ).first()).toEqual({ weight: 0.4, provenance: "explicit" });

      await replaceInferredEdgesOnWrite([{ entryId: ENTRY_ID, neighbors: [] }], admitted);
      expect(await admitted.DB.prepare(
        `SELECT COUNT(*) AS count FROM edges WHERE provenance = 'inferred'`,
      ).first()).toEqual({ count: 0 });
    } finally {
      await admission.finish();
    }
  });

  it("one version per successful update, none on reembed_failed; REST and MCP differ only in channel", async () => {
    const ok: World = { seed: { content: "I live in Berlin", tags: ["home"] }, vectors: [{ id: ENTRY_ID, content: "I live in Berlin" }] };
    const http = await viaHttp(ok, "I live in Lisbon");
    const mcp = await viaMcp(ok, "I live in Lisbon");
    expect(http.snapshot.versions).toHaveLength(1);
    expect(mcp.snapshot.versions).toHaveLength(1);
    expect(http.snapshot.versions[0]).toMatchObject({ seq: 1, reason: "update", channel: "rest", content: "I live in Berlin" });
    expect(mcp.snapshot.versions[0]).toMatchObject({ seq: 1, reason: "update", channel: "mcp", content: "I live in Berlin" });
    expect(mcp.snapshot.versions[0].actor_id).toBe(http.snapshot.versions[0].actor_id);

    const failing: World = { ...ok, embedFails: true };
    expect((await viaHttp(failing, "I live in Lisbon")).snapshot.versions).toEqual([]);
    expect((await viaMcp(failing, "I live in Lisbon")).snapshot.versions).toEqual([]);
  });

  // ── The replies, which are the one thing that legitimately differs ─────────────────────

  it("the MCP tool reports a failed re-index as a failure, not as a success", async () => {
    // It used to answer "Updated entry x1. Re-embedded as 0 vector(s)." on this path, which
    // reads as success and is what let a mis-indexed entry go unnoticed. The route already
    // 500s here; the tool now says the same thing in its own voice.
    const world: World = {
      seed: { content: "I live in Berlin", tags: ["home"] },
      vectors: [{ id: ENTRY_ID, content: "I live in Berlin" }],
      embedFails: true,
    };

    const http = await viaHttp(world, "I live in Lisbon");
    expect(http.status).toBe(500);
    expect(http.reply).toMatch(/The memory is unchanged/);

    const mcp = await viaMcp(world, "I live in Lisbon");
    expect(mcp.reply).not.toMatch(/^Updated entry/);
    expect(mcp.reply).toMatch(/The memory is unchanged/);
  });

  it("the MCP tool flags the keyword-only degrade instead of claiming a re-index", async () => {
    const mcp = await viaMcp(
      { seed: { content: "I live in Berlin", tags: ["home"] }, vectorizeDown: true },
      "I live in Lisbon",
    );
    expect(mcp.reply).toMatch(/Updated memory x1/);
    expect(mcp.reply).toMatch(/Search by meaning is unavailable/);
    expect(mcp.reply).toMatch(/wrangler vectorize create/);
  });

  it("the MCP tool still reports the vector count on the healthy path", async () => {
    const mcp = await viaMcp({ seed: { content: "I live in Berlin", tags: ["home"] } }, "I live in Lisbon");
    expect(mcp.reply).toMatch(
      /^Updated entry x1\. Re-embedded as 1 vector\(s\)\.$/,
    );
  });
});
