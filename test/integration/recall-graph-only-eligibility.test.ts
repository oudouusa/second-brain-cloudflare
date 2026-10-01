/** Direct answer filters must not suppress authorized graph-only evidence. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { observeWorkersAiQuotaError } from "../../src/lib/ai";
import type { Identity } from "../../src/lib/identity";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const NOW = Date.UTC(2026, 8, 6);
const ANSWER_TIME = NOW - 2_000;
const MODES = ["quota", "embedding-failure", "vector-failure"] as const;
type Mode = typeof MODES[number] | "healthy";
const open: SqliteD1[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  try { for (let i = 0; i < pending.length; i++) await pending[i]; }
  finally { pending.length = 0; open.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); }
});

async function fixture(mode: Mode) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const sqlite = makeSqliteD1(); open.push(sqlite);
  sqlite.seed({ id: "event", content: "cat adoption event", createdAt: NOW - 1_000, tags: ["kind:episodic"] });
  sqlite.seed({ id: "answer", content: "Veterinary guidance required indoor housing.",
    createdAt: ANSWER_TIME, tags: ["kind:semantic"] });
  await sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE 1").bind("own").run();
  const link = async (from: string, to: string) => {
    await sqlite.db.prepare(`INSERT INTO edges
      (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
      VALUES (?, ?, ?, 'caused_by', .9, 'explicit', '{}', ?, ?, 'own')`)
      .bind(`${from}-${to}`, from, to, NOW, NOW).run();
  };
  await link("event", "answer");
  const remove = async (table: "entries" | "edges", id: string) => {
    await sqlite.db.prepare(`UPDATE ${table} SET write_marker = ? WHERE id = ?`)
      .bind(sqlite.fixtureMarker("delete"), id).run();
    await sqlite.db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  };
  const vector = vi.fn().mockResolvedValue({ matches: [{ id: "v-event", score: .99,
    values: new Array(128).fill(.1), metadata: { parentId: "event", created_at: NOW - 1_000, workspace_id: "own" } }] });
  if (mode === "vector-failure") vector.mockRejectedValue(new Error("synthetic Vectorize outage"));
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vector }),
  }));
  if (mode === "quota") await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));
  if (mode === "embedding-failure") vi.mocked(env.AI.run).mockRejectedValue(new Error("synthetic embedding outage"));
  const identity: Identity = { userId: "reviewer", role: "member", personalWorkspaceId: "own",
    companyWorkspaceIds: [], defaultShare: "" };
  return { sqlite, vector, link, remove, async recall(options: { hops?: number; after?: number; before?: number } = {}) {
    const diagnostics: RecallDiagnostics = {};
    const ctx = { waitUntil: (task: Promise<unknown>) => { pending.push(task); } } as ExecutionContext;
    const result = await recallEntries({ query: "why cat", topK: 5, hops: 1, kind: "semantic",
      synthesize: false, ...options }, env, ctx, DEFAULTS, { identity, diagnostics });
    for (let i = 0; i < pending.length; i++) await pending[i];
    expect(result.matches.map(row => row.id)).not.toContain("event");
    expect(result.matches.length).toBeLessThanOrEqual(5);
    expect(diagnostics.keywordIds?.length ?? 0).toBeLessThanOrEqual(128);
    expect(diagnostics.operations?.d1RowsRead).toBeNull();
    if (mode === "quota") { expect(env.AI.run).not.toHaveBeenCalled(); expect(vector).not.toHaveBeenCalled(); }
    else if (mode === "embedding-failure") expect(vector).not.toHaveBeenCalled();
    else expect(vector).toHaveBeenCalledTimes(1);
    expect(result.semanticUnavailableReason).toBe(mode === "quota" ? "workers_ai_quota_exhausted"
      : mode === "embedding-failure" ? "embedding_unavailable"
        : mode === "vector-failure" ? "vectorize_unavailable" : undefined);
    return { result, diagnostics };
  } };
}

describe("graph-only answers after direct eligibility filtering", () => {
  it.each([...MODES, "healthy"] as const)("%s: returns semantic evidence through an episodic root", async mode => {
    const f = await fixture(mode);
    const { result, diagnostics } = await f.recall();
    expect(result.matches).toEqual([expect.objectContaining({ id: "answer", hop: 1,
      viaFrom: "event", viaType: "caused_by", viaDirection: "outgoing", workspace: "personal" })]);
    expect(diagnostics.rootSelections?.map(row => row.id)).toContain("event");
    expect(result.graphContribution).toMatchObject({ seedCount: 1, expandedCount: 1, selectedCount: 1 });
  });

  it.each(MODES)("%s: hops=0 stays empty rather than returning the wrong-kind root", async mode => {
    const { result, diagnostics } = await (await fixture(mode)).recall({ hops: 0 });
    expect(result.matches).toEqual([]);
    expect(result.graphContribution?.seedCount).toBe(0);
    expect(diagnostics.expandedIds ?? []).toEqual([]);
  });

  it.each(MODES)("%s: a root without a link cannot manufacture a related answer", async mode => {
    const f = await fixture(mode);
    await f.remove("edges", "event-answer");
    const { result } = await f.recall();
    expect(result.matches).toEqual([]);
    expect(result.graphContribution).toMatchObject({ seedCount: 1, expandedCount: 0 });
  });

  it.each(["kind:episodic", "status:deprecated", "auto-pattern", "auto-insight"])(
    "keeps final answer exclusion for %s", async exclusion => {
      const f = await fixture("quota");
      const tags = exclusion.startsWith("kind:") ? [exclusion] : ["kind:semantic", exclusion];
      await f.sqlite.db.prepare("UPDATE entries SET tags = ? WHERE id = ?").bind(JSON.stringify(tags), "answer").run();
      const { result } = await f.recall();
      expect(result.graphContribution?.seedCount).toBe(1);
      expect(result.matches).toEqual([]);
    },
  );

  it.each([
    { name: "inclusive after", after: ANSWER_TIME, expected: true },
    { name: "after excludes older answer", after: ANSWER_TIME + 1, expected: false },
    { name: "exclusive before", before: ANSWER_TIME, expected: false },
    { name: "before permits answer", before: ANSWER_TIME + 1, expected: true },
  ])("retains $name when the root itself fails the requested kind", async ({ after, before, expected }) => {
    // The controlled dense hit supplies a readable root outside the window;
    // final hydration must still apply the answer's own dates.
    const f = await fixture("healthy");
    const { result } = await f.recall({ after, before });
    expect(result.matches.some(row => row.id === "answer")).toBe(expected);
  });

  it.each(MODES)("%s: a foreign answer is neither returned nor traversed", async mode => {
    const f = await fixture(mode);
    await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind("foreign", "answer").run();
    const { result, diagnostics } = await f.recall();
    expect(diagnostics.expandedIds ?? []).not.toContain("answer");
    expect(result.matches).toEqual([]);
  });

  it.each(MODES)("%s: cannot reach own evidence through a foreign bridge", async mode => {
    const f = await fixture(mode);
    await f.remove("edges", "event-answer");
    f.sqlite.seed({ id: "foreign-bridge", content: "Unrelated private note.", createdAt: NOW, tags: ["kind:episodic"] });
    await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind("foreign", "foreign-bridge").run();
    await f.link("event", "foreign-bridge"); await f.link("foreign-bridge", "answer");
    const { result, diagnostics } = await f.recall({ hops: 2 });
    expect(diagnostics.expandedIds ?? []).not.toContain("foreign-bridge");
    expect(diagnostics.expandedIds ?? []).not.toContain("answer");
    expect(result.matches).toEqual([]);
  });

  it.each(["foreign", "missing"])("does not reserve a root slot for a %s dense hit", async state => {
    const f = await fixture("healthy");
    if (state === "foreign") {
      await f.sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind("foreign", "event").run();
    } else await f.remove("entries", "event");
    // The controlled provider deliberately returns a stale/unscoped event hit.
    const { result, diagnostics } = await f.recall();
    expect(diagnostics.denseIds).toContain("event");
    expect(diagnostics.rootSelections ?? []).toEqual([]);
    expect(result.graphContribution?.seedCount).toBe(0);
    expect(result.matches).toEqual([]);
  });
});
