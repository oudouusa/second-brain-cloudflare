import { syntheticGemmaPricing } from "../fork-synthetic";
syntheticGemmaPricing();
import { parentIdOfVectorId } from "../../../src/vectorize/ids";
import { describe, expect, it, vi } from "vitest";
import type { storeEntry } from "../../../src/capture/store";
import { FTS_READY_KV_KEY } from "../../../src/constants";
import { ReplayStore, makeReplayAi } from "../ai-replay";
import type { EvalD1 } from "../d1";
import { applySupportedTemporalMetadata, loadCorpus } from "./loader";
import { ACTORS, EVAL_NOW, WORKSPACES, type CorpusEntry, type CorpusSpec } from "./types";

// Wraps the real backend so tests can see every database the loader opened and how often it was closed.
const opened: { d1: EvalD1; closes: number }[] = [];
vi.mock("../d1", async importOriginal => {
  const real = await importOriginal<typeof import("../d1")>();
  return {
    ...real,
    openD1: async (kind: "sqlite" | "workerd") => {
      const d1 = await real.openD1(kind);
      const rec = { d1, closes: 0 };
      opened.push(rec);
      return { ...d1, close: async () => { rec.closes++; await d1.close(); } };
    },
  };
});

const entry = (id: string, content: string, ws: keyof typeof WORKSPACES = "avery"): CorpusEntry => ({
  id, content, tags: ["t1"], source: "api", createdAt: EVAL_NOW - 1000, workspaceId: WORKSPACES[ws], actorId: ACTORS.avery,
});
const long = `${"Opening paragraph about the renovation plan. ".repeat(50)}${"Later paragraph about the panel upgrade cost. ".repeat(50)}`;
const spec: CorpusSpec = {
  id: "tiny",
  intent: "tie",
  entries: [entry("a", "alpha widget plan"), entry("b", "東京の会議メモ"), entry("c", "shared note", "company"), entry("d", long)],
  edges: [{ id: "e1", sourceId: "a", targetId: "c", type: "relates_to", weight: 0.9, provenance: "explicit", workspaceId: WORKSPACES.avery }],
  queries: [],
};
const dry = () => makeReplayAi({ store: new ReplayStore([]), mode: "dry" });
const MODEL = "@cf/google/embeddinggemma-300m";

describe("loadCorpus (sqlite backend)", () => {
  it("indexes through the real write path: rows, FTS, counters, vectors, edges, and the ready flag", async () => {
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: dry(), embeddingModel: MODEL });
    try {
      const counts = await corpus.env.DB.prepare(
        `SELECT (SELECT count(*) FROM entries) AS e, (SELECT count(*) FROM entries_fts) AS f, (SELECT COALESCE(SUM(n), 0) FROM entry_counts) AS c, (SELECT count(*) FROM edges) AS g`,
      ).first<{ e: number; f: number; c: number; g: number }>();
      expect(counts).toEqual({ e: 4, f: 4, c: 4, g: 1 });
      const hit = await corpus.env.DB.prepare(`SELECT id FROM entries_fts WHERE entries_fts MATCH '"widget"'`).all();
      expect(hit.results).toHaveLength(1);
      expect(await corpus.env.OAUTH_KV.get(FTS_READY_KV_KEY)).toBe("1");
      // The long entry is multi-chunk, exactly as storeEntry writes it.
      const ids = (await corpus.vectorize.query(new Array(128).fill(0.01), { topK: 50, returnMetadata: "all" })).matches.filter(m => m.metadata?.parentId === "d").map(m => m.id);
      expect(ids.length).toBeGreaterThan(1);
      const stored = await corpus.env.DB.prepare(`SELECT vector_ids FROM entries WHERE id = 'd'`).first<{ vector_ids: string }>();
      expect(JSON.parse(stored!.vector_ids).length).toBeGreaterThan(1);
      expect(corpus.workspaceOf.get("c")).toBe(WORKSPACES.company);
      expect(corpus.entryCount).toBe(4);
      expect(corpus.indexId).toBe("shipped");
    } finally {
      await corpus.close();
    }
  });

  it("stamps workspace_id on every vector so the scoped Vectorize filter can work", async () => {
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: dry(), embeddingModel: MODEL });
    try {
      const scoped = await corpus.vectorize.query(new Array(128).fill(0.01), { topK: 50, returnMetadata: "all", filter: { workspace_id: { $in: [WORKSPACES.company] } } });
      expect(scoped.matches.map(m => m.metadata?.parentId)).toEqual(["c"]);
    } finally {
      await corpus.close();
    }
  });

  it("indexes through an index variant's storeEntry when one is supplied", async () => {
    const custom = vi.fn(async (...args: Parameters<typeof import("../../../src/capture/store").storeEntry>) => {
      const real = await import("../../../src/capture/store");
      return real.storeEntry(...args);
    });
    const corpus = await loadCorpus({ spec, backend: "sqlite", replay: dry(), embeddingModel: MODEL, index: { id: "test-variant", storeEntry: custom } });
    expect(corpus.indexId).toBe("test-variant");
    await corpus.close();
    expect(custom).toHaveBeenCalledTimes(4);
  });

  it("fails closed and releases the database when a replay miss aborts the load", async () => {
    const replay = makeReplayAi({ store: new ReplayStore([]), mode: "replay" });
    const before = opened.length;
    await expect(loadCorpus({ spec, backend: "sqlite", replay, embeddingModel: MODEL })).rejects.toThrow(/replay|miss/i);
    const rec = opened[before];
    expect(opened.length).toBe(before + 1);
    expect(rec.closes).toBe(1);
    await expect(rec.d1.db.prepare("SELECT 1").first()).rejects.toThrow();
  });
});

const load = (s: CorpusSpec, extra: Partial<Parameters<typeof loadCorpus>[0]> = {}) =>
  loadCorpus({ spec: s, backend: "sqlite", replay: dry(), embeddingModel: MODEL, ...extra });
const rowsOf = async (corpus: Awaited<ReturnType<typeof load>>, sql: string) =>
  (await corpus.env.DB.prepare(sql).all()).results as Record<string, unknown>[];
const withEntries = (...entries: CorpusEntry[]): CorpusSpec => ({ id: "t", intent: "tie", entries, edges: [], queries: [] });

describe("loadCorpus importance_score", () => {
  it("defaults to 3 (the classifier fallback), never 0, and binds an explicit value", async () => {
    const corpus = await load(withEntries(entry("a", "alpha"), { ...entry("b", "beta"), importanceScore: 5 }, { ...entry("c", "gamma"), importanceScore: 1 }));
    try {
      const rows = await rowsOf(corpus, "SELECT id, importance_score FROM entries ORDER BY id");
      expect(rows).toEqual([{ id: "a", importance_score: 3 }, { id: "b", importance_score: 5 }, { id: "c", importance_score: 1 }]);
    } finally {
      await corpus.close();
    }
  });

  it.each([0, 6, 2.5, -1, Number.NaN])("rejects importanceScore %s before opening a database", async bad => {
    const before = opened.length;
    await expect(load(withEntries({ ...entry("a", "alpha"), importanceScore: bad }))).rejects.toThrow(/importanceScore/);
    expect(opened.length).toBe(before);
  });

  it("passes classifier tags through as plain tags", async () => {
    const corpus = await load(withEntries({ ...entry("a", "alpha"), tags: ["status:canonical", "kind:semantic"] }));
    try {
      const [row] = await rowsOf(corpus, "SELECT tags FROM entries WHERE id = 'a'");
      expect(JSON.parse(row.tags as string)).toEqual(["status:canonical", "kind:semantic"]);
    } finally {
      await corpus.close();
    }
  });
});

describe("loadCorpus tenancy binding", () => {
  it("stores workspace_id and actor_id on the D1 row, each in its own column", async () => {
    const blake: CorpusEntry = { ...entry("b", "beta", "blake"), actorId: ACTORS.blake };
    const outsider: CorpusEntry = { ...entry("o", "omega", "outsider"), actorId: ACTORS.outsider };
    const corpus = await load(withEntries(entry("a", "alpha"), blake, entry("c", "gamma", "company"), outsider));
    try {
      const rows = await rowsOf(corpus, "SELECT id, workspace_id, actor_id FROM entries ORDER BY id");
      expect(rows).toEqual([
        { id: "a", workspace_id: WORKSPACES.avery, actor_id: ACTORS.avery },
        { id: "b", workspace_id: WORKSPACES.blake, actor_id: ACTORS.blake },
        { id: "c", workspace_id: WORKSPACES.company, actor_id: ACTORS.avery },
        { id: "o", workspace_id: WORKSPACES.outsider, actor_id: ACTORS.outsider },
      ]);
    } finally {
      await corpus.close();
    }
  });

  it("stores each edge's workspace on the edge row", async () => {
    const corpus = await load(spec);
    try {
      expect(await rowsOf(corpus, "SELECT source_id, target_id, workspace_id FROM edges")).toEqual([
        { source_id: "a", target_id: "c", workspace_id: WORKSPACES.avery },
      ]);
    } finally {
      await corpus.close();
    }
  });
});

describe("loadCorpus normalization", () => {
  it("runs content and tags through the same normalization as captureEntry", async () => {
    const corpus = await load(withEntries({ ...entry("a", "the #renovation quote landed  "), tags: ["Work", " Task "] }));
    try {
      const [row] = await rowsOf(corpus, "SELECT content, tags FROM entries WHERE id = 'a'");
      expect(row.content).toBe("the quote landed");
      expect(JSON.parse(row.tags as string)).toEqual(["work", "task", "renovation"]);
      // The vectors are written from the normalized text and tags too.
      const [hit] = (await corpus.vectorize.query(new Array(128).fill(0.01), { topK: 5, returnMetadata: "all" })).matches;
      expect(hit.metadata).toMatchObject({ content: "the quote landed", tag_renovation: true, tag_work: true });
    } finally {
      await corpus.close();
    }
  });
});

describe("loadCorpus safety nets", () => {
  // Each variant breaks one of the three parity legs after the real write, leaving the other two intact.
  const drifting = (sql: string): typeof storeEntry => async (env, id, ...rest) => {
    const real = await import("../../../src/capture/store");
    const stored = await real.storeEntry(env, id, ...rest);
    await env.DB.prepare(sql).bind(id).run();
    return stored;
  };
  it.each([
    ["FTS rows", "DELETE FROM entries_fts WHERE id = ?", "index drift"],
    ["entry counters", "UPDATE entry_counts SET n = n + 1 WHERE ? IS NOT NULL", "index drift"],
    ["削除receiptのないentries削除", "DELETE FROM entries WHERE id = ?", "memory-write-locked"],
  ])("throws on index drift in the %s instead of flagging the corpus ready", async (_leg, sql, expected) => {
    const before = opened.length;
    await expect(load(spec, { index: { id: "drift", storeEntry: drifting(sql) } })).rejects.toThrow(expected);
    expect(opened[before].closes).toBe(1);
  });

  it("rejects an embedding model with no known dimensions", async () => {
    await expect(load(spec, { embeddingModel: "@cf/unknown/model" })).rejects.toThrow(/no known embedding dimensions/);
  });

  it("close() closes the database", async () => {
    const corpus = await load(spec);
    const rec = opened[opened.length - 1];
    await corpus.close();
    expect(rec.closes).toBe(1);
    await expect(rec.d1.db.prepare("SELECT 1").first()).rejects.toThrow();
  });

  it("runs up to `concurrency` writers, clamps below 1, and lands the same corpus either way", async () => {
    const many = withEntries(...Array.from({ length: 12 }, (_, i) => entry(`e${i}`, `entry number ${i} about topic ${i}`)));
    const snapshot = async (concurrency: number) => {
      let inFlight = 0;
      let peak = 0;
      const progress: number[] = [];
      const tracked: typeof storeEntry = async (...args) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise(r => setTimeout(r, 2));
        const real = await import("../../../src/capture/store");
        try { return await real.storeEntry(...args); } finally { inFlight--; }
      };
      const corpus = await load(many, { concurrency, index: { id: "tracked", storeEntry: tracked }, onProgress: (done, total) => progress.push(done * 1000 + total) });
      try {
        const rows = await rowsOf(corpus, "SELECT id, json_array_length(vector_ids) AS vector_count FROM entries ORDER BY id");
        return { peak, progress, rows, size: corpus.vectorize.size };
      } finally {
        await corpus.close();
      }
    };
    const serial = await snapshot(1);
    const parallel = await snapshot(4);
    const clamped = await snapshot(0);
    expect(serial.peak).toBe(1);
    expect(parallel.peak).toBeGreaterThan(1);
    expect(parallel.peak).toBeLessThanOrEqual(4);
    expect(clamped.peak).toBe(1);
    expect(clamped.rows).toEqual(serial.rows);
    expect(parallel.rows).toEqual(serial.rows);
    expect(parallel.size).toBe(serial.size);
    const expected = Array.from({ length: 12 }, (_, i) => (i + 1) * 1000 + 12);
    expect(serial.progress).toEqual(expected);
    expect(parallel.progress).toEqual(expected);
  });
});

describe("loadCorpus temporal metadata", () => {
  const dated: CorpusSpec = {
    id: "dated", intent: "tie", queries: [],
    entries: [
      { ...entry("old", "studio lease at Maple Street"), validFrom: EVAL_NOW - 5000, validUntil: EVAL_NOW - 2000, updatedAt: EVAL_NOW - 500 },
      { ...entry("new", "studio lease at Cedar Lane"), retractedAt: EVAL_NOW - 100 },
      entry("plain", "unrelated note"),
    ],
    edges: [{ id: "s1", sourceId: "new", targetId: "old", type: "supersedes", weight: 1, provenance: "explicit", workspaceId: WORKSPACES.avery }],
  };

  it("writes updated_at and the supersedes edge", async () => {
    const corpus = await loadCorpus({ spec: dated, backend: "sqlite", replay: dry(), embeddingModel: MODEL });
    try {
      const row = await corpus.env.DB.prepare("SELECT created_at, updated_at FROM entries WHERE id = 'old'").first<{ created_at: number; updated_at: number }>();
      expect(row!.updated_at).toBe(EVAL_NOW - 500);
      expect(row!.created_at).toBe(EVAL_NOW - 1000);
      const unedited = await corpus.env.DB.prepare("SELECT created_at, updated_at FROM entries WHERE id = 'plain'").first<{ created_at: number; updated_at: number }>();
      expect(unedited!.updated_at).toBe(unedited!.created_at);
      expect((await corpus.env.DB.prepare("SELECT type FROM edges WHERE id = 's1'").first<{ type: string }>())!.type).toBe("supersedes");
    } finally { await corpus.close(); }
  });

  it("hands the declared metadata to a replaceable writer once entries and edges are in", async () => {
    const seen: { ids: string[]; edges: number }[] = [];
    const corpus = await loadCorpus({
      spec: dated, backend: "sqlite", replay: dry(), embeddingModel: MODEL,
      temporalMetadata: async (env, entries) => { seen.push({ ids: entries.map(e => e.id), edges: (await env.DB.prepare("SELECT count(*) AS n FROM edges").first<{ n: number }>())!.n }); },
    });
    await corpus.close();
    expect(seen).toEqual([{ ids: ["old", "new", "plain"], edges: 1 }]);
  });

  it("populates valid_from and valid_until when Track 2's columns exist, with a retraction closing validity", async () => {
    const corpus = await loadCorpus({ spec: dated, backend: "sqlite", replay: dry(), embeddingModel: MODEL });
    try {
      await applySupportedTemporalMetadata(corpus.env, dated.entries);
      // Track 2 lane A (T-0089.2.1) adds these via src/db/init.ts's own runtime ALTER, the same path
      // loadCorpus() already runs; before that lands, applySupportedTemporalMetadata already no-oped above.
      const columns = ((await corpus.env.DB.prepare("PRAGMA table_info(entries)").all<{ name: string }>()).results ?? []).map(c => c.name);
      if (!columns.includes("valid_from") || !columns.includes("valid_until")) return;
      const rows = (await corpus.env.DB.prepare("SELECT id, valid_from, valid_until FROM entries ORDER BY id").all<{ id: string; valid_from: number | null; valid_until: number | null }>()).results!;
      expect(rows).toEqual([
        { id: "new", valid_from: EVAL_NOW - 1000, valid_until: EVAL_NOW - 100 },
        { id: "old", valid_from: EVAL_NOW - 5000, valid_until: EVAL_NOW - 2000 },
        { id: "plain", valid_from: null, valid_until: null },
      ]);
    } finally { await corpus.close(); }
  });
});
