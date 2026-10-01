import { vi } from "vitest";
import { D1Mock } from "./d1-mock";
import type { Env } from "../../src/env";
import { embeddingMetadata } from "../../src/embedding/profile";

export function makeVectorizeMock(overrides: Partial<Vectorize> = {}): Vectorize {
  const queryImpl = overrides.query ?? vi.fn().mockResolvedValue({ matches: [] });
  let getByIdsImpl: Vectorize["getByIds"];
  const index = {
    query: vi.fn(async (...args: Parameters<Vectorize["query"]>) => {
      const result = await queryImpl(...args as [never, never]);
      return {
        ...result,
        matches: result.matches.map((match: VectorizeMatch) => ({
          ...match,
          metadata: { ...embeddingMetadata(), ...((match.metadata as object | undefined) ?? {}) },
        })),
      };
    }),
    insert: vi.fn().mockResolvedValue({ mutationId: "m" }),
    deleteByIds: vi.fn().mockResolvedValue({ mutationId: "m" }),
    upsert: vi.fn().mockResolvedValue({ mutationId: "m" }),
    getByIds: vi.fn(async (...args: Parameters<Vectorize["getByIds"]>) => {
      const vectors = await getByIdsImpl(...args);
      return vectors.map((vector: VectorizeVector) => ({
        ...vector,
        metadata: { ...embeddingMetadata(), ...((vector.metadata as object | undefined) ?? {}) },
      }));
    }),
    describe: vi.fn().mockResolvedValue({
      vectorCount: 0,
      processedUpToMutation: "m",
      processedUpToDatetime: "9999-12-31T23:59:59.999Z",
    }),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "query" && key !== "getByIds")),
  } as unknown as Vectorize;
  getByIdsImpl = overrides.getByIds ?? indexedGetByIds(index);
  return index;
}

const callArgs = (fn: any): any[] => (fn?.mock?.calls ?? []).map((c: any[]) => c[0]);

/**
 * The default getByIds of a Vectorize double (T-0089.1.1: deleteEntryVectors reads each vector's
 * metadata.parentId before deleting). It answers the way real data looks: a vector written through
 * this double (upsert/insert spies) with its own metadata, else a vector for every id a row lists,
 * owned by that row (makeTestEnv wires `__owners` from the test's D1); minus ids deleted through it.
 * A test about aliasing or about reading vectors back supplies its own getByIds (or ownedBy()).
 */
function indexedGetByIds(index: any) {
  // The spies as created: a test that later wraps index.upsert still calls through to these.
  const spies = { upsert: index.upsert, insert: index.insert, deleteByIds: index.deleteByIds };
  return vi.fn(async (ids: string[]) => {
    const deleted = new Set(callArgs(spies.deleteByIds).flat());
    const written = new Map<string, any>();
    for (const batch of [...callArgs(spies.upsert), ...callArgs(spies.insert)]) for (const v of batch ?? []) written.set(v.id, v);
    const listed: Map<string, string> = index.__owners ? await index.__owners() : new Map();
    return ids.filter(id => !deleted.has(id) && (written.has(id) || listed.has(id)))
      .map(id => written.get(id) ?? { id, values: [] as number[], metadata: { parentId: listed.get(id) } });
  });
}

/** A getByIds double for vectors a test declares directly: `owners` maps vector id to its entry (parentId). */
export function ownedBy(owners: Record<string, string>) {
  return vi.fn(async (ids: string[]) => ids.filter(id => id in owners).map(id => ({ id, values: [] as number[], metadata: { parentId: owners[id] } })));
}

export function makeAIMock(): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string, input?: { text?: string | string[] }) => {
      // Every bge-* model here is an embedding call (bge-small is the
      // shipped default; bge-base/large/m3 are config-selectable) — anything
      // else is assumed to be an LLM chat completion, below.
      // One vector per input text, as the real binding returns for a batch.
      if (model === "@cf/google/embeddinggemma-300m")
        return { data: (Array.isArray(input?.text) ? input.text : [input?.text]).map(() => new Array(768).fill(0.1)) };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":"3"}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

export function makeTestDb() { return new D1Mock(); }

export function makeKVMock(): KVNamespace {
  return {
    // The real bulk form (get(keys: string[])) always returns a Map, even when
    // empty — never null. src/standing/cache.ts's readStandingCaches relies on
    // that platform contract; a bare mockResolvedValue(null) broke it the
    // moment a non-standing-specific caller (the brief) started exercising it.
    get: vi.fn(async (keyOrKeys: string | string[]) => (Array.isArray(keyOrKeys) ? new Map() : null)),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

// Stateful in-memory KV for tests where reads must see prior writes (the
// integrations flow) — makeKVMock above always returns null.
export function makeMemoryKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    // The real bulk form (get(keys: string[])) always returns a Map, even when
    // empty — never null (see makeKVMock's identical note). `type: "json"`
    // parses the stored string, matching real KV — callers like
    // readStandingCaches rely on getting a parsed object back, not a string.
    get: async (keyOrKeys: string | string[], type?: string) => {
      const read = (k: string) => {
        const v = store.get(k);
        if (v === undefined) return null;
        return type === "json" ? JSON.parse(v) : v;
      };
      if (Array.isArray(keyOrKeys)) {
        const out = new Map<string, unknown>();
        for (const k of keyOrKeys) out.set(k, read(k));
        return out;
      }
      return read(keyOrKeys);
    },
    put: async (key: string, value: string) => { store.set(key, String(value)); },
    delete: async (key: string) => { store.delete(key); },
    list: async (opts: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter(k => !opts.prefix || k.startsWith(opts.prefix))
        .map(name => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

export function makeTestEnv(db?: D1Mock, overrides: Partial<Env> = {}): Env {
  const env: Env = {
    DB: (db ?? new D1Mock()) as unknown as D1Database,
    VECTORIZE: makeVectorizeMock(),
    AI: makeAIMock(),
    AUTH_TOKEN: "test-token",
    OAUTH_KV: makeKVMock(),
    ...overrides,
  };
  // Vectors a row lists exist and belong to it (see indexedGetByIds); a double with no getByIds gets it too.
  const index = env.VECTORIZE as any;
  if (index && typeof index.getByIds !== "function") index.getByIds = indexedGetByIds(index);
  // The DB double remembers which row listed which vector id (D1Mock / the SQLite facade).
  if (index && index.__owners === undefined) {
    const db = env.DB as any;
    index.__owners = async () => (typeof db?.__vectorOwners === "function" ? db.__vectorOwners() : new Map());
  }
  return env;
}
