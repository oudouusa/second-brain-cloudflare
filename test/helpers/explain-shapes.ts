import { vi } from "vitest";
import { makeSqliteD1 } from "./sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "./make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { NOW, restRecall, mcpRecall } from "./explain-fixture";
import type { Env } from "../../src/env";

const DAY = 86_400_000;

interface Seed { id: string; content: string; tags?: string[]; age: number; updatedAge?: number }
interface Shape {
  seeds: Seed[];
  /** Dense hits in order, best first; "none" = the index answers with no matches, "throw" = it fails. */
  dense: string[] | "none" | "throw";
  edges?: [string, string][];
  query: string;
  hops?: number;
  topK?: number;
  /** The keyword arm returns nothing, so linked memories can only arrive through the graph. */
  noKeyword?: boolean;
}

const many = (n: number, mk: (i: number) => Seed): Seed[] => Array.from({ length: n }, (_, i) => mk(i + 1));

/** The query shapes explain must leave untouched. Each is a fresh, frozen-clock brain. */
export const SHAPES: Record<string, Shape> = {
  // Six dense hits and a linked neighbour that only the graph reaches: the graph slot is in play.
  graphSlot: {
    noKeyword: true,
    seeds: [
      ...many(4, i => ({ id: `g${i}`, content: `Orbit thrusters burn note ${i}: the burn schedule`, age: i })),
      { id: "g5", content: "Catering plan for the launch party", age: 5 },
      { id: "g6", content: "Orbit thrusters burn: the orbit thrusters burn decision record", age: 6 },
      { id: "gx", content: "Orbit thrusters burn: sign-off history for the burn schedule", age: 3 },
    ],
    dense: ["g1", "g2", "g3", "g4", "g5", "g6"],
    edges: [["g1", "gx"]],
    query: "orbit thrusters burn",
    hops: 1,
    topK: 5,
  },
  // One dense hit and a neighbour that shares its words: the linked memory is listed as a related result.
  linkedFew: {
    noKeyword: true,
    seeds: [
      { id: "l1", content: "Direct match on orbit burns", age: 1 },
      { id: "l2", content: "Direct match related orbit context", age: 5 },
    ],
    dense: ["l1"],
    edges: [["l1", "l2"]],
    query: "direct match orbit",
    hops: 1,
    topK: 5,
  },
  graphDeep: {
    noKeyword: true,
    seeds: [
      ...many(11, i => ({ id: `g${i}`, content: `Orbit planning note ${i}: thrusters, fuel and the burn schedule`, age: i })),
      { id: "gx", content: "Rollout checklist and range owners", age: 3 },
      { id: "gy", content: "Orbit thrusters burn: sign-off history for the burn schedule", age: 4 },
    ],
    dense: Array.from({ length: 11 }, (_, i) => `g${i + 1}`),
    edges: [["g1", "gx"], ["g2", "gy"]],
    query: "orbit thrusters burn",
    hops: 2,
    topK: 10,
  },
  keywordOnly: {
    seeds: many(4, i => ({ id: `k${i}`, content: `Quokka migration log ${i} with rare vocabulary`, age: i })),
    dense: "none",
    query: "quokka migration",
  },
  semanticDown: {
    seeds: many(3, i => ({ id: `d${i}`, content: `Quokka migration log ${i} with rare vocabulary`, age: i })),
    dense: "throw",
    query: "quokka migration",
  },
  empty: {
    seeds: many(2, i => ({ id: `n${i}`, content: `Unrelated gardening note ${i}`, age: i })),
    dense: "none",
    query: "zzyzx nonexistent",
  },
  truncated: {
    seeds: many(4, i => ({ id: `t${i}`, content: `Quokka survey ${i}. ` + "long paragraph of field notes. ".repeat(900), age: i })),
    dense: ["t1", "t2", "t3", "t4"],
    query: "quokka survey",
  },
  compoundStale: {
    seeds: many(3, i => ({ id: `s${i}`, content: `Quokka pricing as of last year, version ${i}`, tags: ["stale:as-of"], age: 200 + i, updatedAge: 200 + i })),
    dense: ["s1", "s2", "s3"],
    query: "quokka pricing",
  },
};

async function build(shape: Shape): Promise<Env> {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const byId = new Map(shape.seeds.map(s => [s.id, s]));
  const query = shape.dense === "throw" ? vi.fn().mockRejectedValue(new Error("vectorize down"))
    : vi.fn().mockResolvedValue({
      matches: shape.dense === "none" ? [] : shape.dense.map((id, i) => ({
        id, score: 0.9 - i * 0.03,
        metadata: { parentId: id, isUpdate: false, created_at: NOW - byId.get(id)!.age * DAY, tags: byId.get(id)!.tags ?? [] },
      })),
    });
  const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock({ query }) }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const ws = roots.ownerPersonalWorkspaceId;
  for (const s of shape.seeds) {
    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, ?, 'api', ?, ?, '[]', ?, ?)`,
    ).bind(s.id, s.content, JSON.stringify(s.tags ?? []), NOW - s.age * DAY, NOW - (s.updatedAge ?? s.age) * DAY, ws, roots.ownerUserId).run();
  }
  for (const [i, [a, b]] of (shape.edges ?? []).entries()) {
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES (?, ?, ?, 'relates_to', 0.9, 'explicit', '{}', ?, ?, ?)`,
    ).bind(`ed${i}`, a, b, NOW - DAY, NOW - DAY, ws).run();
  }
  if (shape.noKeyword) {
    const prepare = sqlite.db.prepare.bind(sqlite.db);
    (sqlite.db as any).prepare = (sql: string) => sql.includes("lower(content) AS lc")
      ? { bind: () => ({ all: async () => ({ results: [] }) }) }
      : prepare(sql);
  }
  (env as any).__close = () => { sqlite.close(); vi.restoreAllMocks(); };
  return env;
}

/** REST body and MCP text for one shape, each from a fresh brain (recall_count feeds the next ranking). */
export async function runShape(name: string, explain: boolean): Promise<{ rest: any; mcp: string; cost: number[] }> {
  const shape = SHAPES[name];
  const qs = `query=${encodeURIComponent(shape.query)}&topK=${shape.topK ?? 5}${shape.hops ? `&hops=${shape.hops}` : ""}${explain ? "&explain=1" : ""}`;
  const args: Record<string, unknown> = { query: shape.query, topK: shape.topK ?? 5, ...(shape.hops ? { hops: shape.hops } : {}), ...(explain ? { explain: true } : {}) };
  const a = await build(shape);
  const spies = [vi.spyOn(a.DB, "prepare"), vi.spyOn(a.AI as any, "run"), vi.spyOn(a.VECTORIZE, "query")];
  const rest = await restRecall(a, qs);
  const cost = spies.map(sp => sp.mock.calls.length);
  (a as any).__close();
  const b = await build(shape);
  const mcp = await mcpRecall(b, args);
  (b as any).__close();
  return { rest, mcp, cost };
}
