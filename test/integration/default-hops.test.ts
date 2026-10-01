/**
 * #246 — the "How far to follow connections" control sets a *default* hops
 * value, applied only when the caller does not supply one.
 *
 * #245 shipped GRAPH_MAX_HOPS (the hard cap) and GRAPH_HOP_DECAY, but no
 * default: search.ts hardcoded `params.hops ?? 0`. Without DEFAULT_HOPS the
 * control has nothing to write to.
 *
 * The caller-wins property is the important one — an explicit `hops: 0` from an
 * MCP client must not be silently overridden by the user's default, or callers
 * lose the ability to ask for direct matches only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { CONFIG_KEY, DEFAULTS } from "../../src/config";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function seed(db: D1Mock, id: string, content = id) {
  db.entries.push({
    id, content, tags: "[]", source: "api", created_at: 1000,
    vector_ids: "[]", recall_count: 0, importance_score: 0,
  });
}
function edge(db: D1Mock, a: string, b: string) {
  db.edges.push({
    id: `${a}-${b}`, source_id: a, target_id: b, type: "relates_to",
    weight: 1, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1,
  });
}

function env(db: D1Mock, overrides?: Record<string, unknown>) {
  const kv = makeMemoryKV();
  if (overrides) kv.put(CONFIG_KEY, JSON.stringify(overrides));
  return makeTestEnv(db, {
    DB: {
      prepare: (sql: string) => {
        if (/WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)) {
          return { bind: () => ({ all: async () => ({ results: [] }) }) };
        }
        return db.prepare(sql);
      },
    } as unknown as D1Database,
    OAUTH_KV: kv,
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "seed", score: 0.9, metadata: { parentId: "seed", isUpdate: false } }],
      }),
    }),
  });
}

describe("DEFAULT_HOPS (#246 connections control)", () => {
  let db: D1Mock;
  beforeEach(() => {
    db = makeTestDb();
    seed(db, "seed", "topic seed"); seed(db, "neighbor", "topic neighbor");
    edge(db, "seed", "neighbor");
  });

  it("ships defaulting to direct matches only, preserving today's behaviour", async () => {
    expect(DEFAULTS.DEFAULT_HOPS).toBe(0);
  });

  it("follows connections when the user raises the default and the caller says nothing", async () => {
    const res = await recallEntries({ query: "topic neighbor", topK: 5 }, env(db, { DEFAULT_HOPS: 1 }), ctx);
    expect(res.matches.map(m => m.id)).toContain("neighbor");
  });

  it("returns direct matches only under the shipped default", async () => {
    const res = await recallEntries({ query: "topic neighbor", topK: 5 }, env(db), ctx);
    expect(res.matches.map(m => m.id)).not.toContain("neighbor");
  });

  // The property that protects MCP clients: an explicit request wins over the
  // stored preference, including an explicit 0.
  it("lets an explicit hops:0 from the caller override a raised default", async () => {
    const res = await recallEntries({ query: "topic neighbor", topK: 5, hops: 0 }, env(db, { DEFAULT_HOPS: 2 }), ctx);
    expect(res.matches.map(m => m.id)).not.toContain("neighbor");
  });

  it("lets an explicit hops:1 win when the default is 0", async () => {
    const res = await recallEntries({ query: "topic neighbor", topK: 5, hops: 1 }, env(db), ctx);
    expect(res.matches.map(m => m.id)).toContain("neighbor");
  });

  it("clamps a raised default to GRAPH_MAX_HOPS, which stays a hard cap", async () => {
    // A chain one hop longer than the cap. GRAPH_MAX_HOPS is 3, so with
    // DEFAULT_HOPS asking for 99 the third link must still be reachable and the
    // fourth must not — which is what distinguishes a clamp from no cap at all.
    //
    // The cap is enforced three times over: the DEFAULT_HOPS rule in config.ts
    // clamps at resolve time, search.ts clamps again when it picks the hop
    // count, and traverse.ts clamps once more. Removing any single one leaves the
    // other two, so this asserts the end-to-end property rather than any one
    // implementation — verified by mutation: it only goes red when all three are
    // removed together, and it does go red then.
    seed(db, "h1");
    seed(db, "h2");
    seed(db, "h3", "topic neighbor h3");
    seed(db, "h4", "topic h4");
    edge(db, "seed", "h1");
    edge(db, "h1", "h2");
    edge(db, "h2", "h3");
    edge(db, "h3", "h4");

    // topK is generous so the assertion is about traversal depth, not truncation.
    const res = await recallEntries({ query: "topic neighbor", topK: 50 }, env(db, { DEFAULT_HOPS: 99 }), ctx);
    const ids = res.matches.map(m => m.id);

    expect(ids).toContain("h3");
    expect(ids).not.toContain("h4");
  });
});
