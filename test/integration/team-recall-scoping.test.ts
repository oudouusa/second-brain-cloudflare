/**
 * Team Edition scoping for the recall pipeline.
 *
 * Recall is where an isolation bug would actually leak: the dense arm can
 * surface a stranger's Vectorize hit, and every hydration step after it must
 * refuse to turn that id into content. Whether a scope clause excludes another
 * workspace's rows is a property of real SQLite, so these scenarios run the
 * full recallEntries path against the sqlite-d1 facade — d1-mock branches on
 * query strings and ignores bindings, which is exactly what scoping lives in.
 *
 * Most cases force the dense arm down so the keyword arm's SQL is the whole
 * candidate source. The dense-arm matrix exercises the leak-catcher directly.
 * The facade's `issued` array pins the byte-for-byte unscoped SQL contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recallEntries } from "../../src/recall/search";
import type { RecallInternalOptions } from "../../src/recall/types";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";
import { resetVectorizeFilterState, vectorizeFilterState } from "../../src/vectorize/scope";
import { DEFAULTS } from "../../src/config";

const memberOf = (personal: string): Identity => ({
  userId: "u1",
  role: "member",
  personalWorkspaceId: personal,
  companyWorkspaceIds: ["ws-co"],
  defaultShare: "" as const,
});

function makeCtx() {
  const pending: Promise<any>[] = [];
  return { ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext };
}

/** Dense arm always fails: the keyword arm's SQL becomes the entire candidate source. */
function recallEnv(sqlite: SqliteD1, vectorizeOverrides: Partial<Vectorize> = {}): Env {
  return makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockRejectedValue(new Error("index unavailable")),
      ...vectorizeOverrides,
    }),
  });
}

/** Seed through the normal insert, then relocate — the unit under test IS that column. */
function seedIn(sqlite: SqliteD1, id: string, workspaceId: string, content: string, createdAt = 1000) {
  sqlite.seed({ id, content, createdAt });
  sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

/** One entry per workspace that matches the same query word — isolation's minimal triangle. */
function seedTriangle(sqlite: SqliteD1) {
  seedIn(sqlite, "own", "ws-a", "alpha roadmap for my team");
  seedIn(sqlite, "co", "ws-co", "alpha offsite notes");
  seedIn(sqlite, "foreign", "ws-b", "alpha private diary");
}

describe("recallEntries with an Identity", () => {
  let sqlite: SqliteD1;
  let env: Env;
  beforeEach(async () => {
    resetDatabaseInit();
    resetVectorizeFilterState();
    sqlite = makeSqliteD1();
    env = recallEnv(sqlite);
    // The final hydration reads updated_at, a runtime-ALTER column: the schema
    // the nightly cron normally guarantees must actually exist here.
    await initializeDatabase(env);
    // Init's DDL pollutes `issued`; assertions below filter to entries reads.
    sqlite.issued.length = 0;
  });
  afterEach(() => sqlite.close());

  it("returns the caller's own and company rows, never another member's private rows", async () => {
    seedTriangle(sqlite);
    const { ctx } = makeCtx();
    const internal: RecallInternalOptions = { identity: memberOf("ws-a") };

    const res = await recallEntries({ query: "alpha", topK: 10, synthesize: false }, env, ctx, undefined, internal);

    const ids = res.matches.map(m => m.id);
    expect(ids).toContain("own");
    expect(ids).toContain("co"); // personal ∪ company: the shared row stays readable
    expect(ids).not.toContain("foreign");
  });

  it("recovers legacy unstamped dense vectors after a silent empty filter without leaking foreign rows", async () => {
    // Existing solo-era vectors have no workspace_id metadata. On an index
    // without that metadata index, Vectorize accepts the workspace filter but
    // returns an empty set instead of rejecting it. The recall-only probe must
    // recover those semantic candidates, while D1 remains the hard boundary.
    sqlite.seed({
      id: "legacy-own",
      content: "garment-supported silhouette and individual balance decisions",
      createdAt: 1000,
      tags: ["vestaos"],
    });
    sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`)
      .bind("ws-a", "legacy-own").run();
    sqlite.seed({
      id: "legacy-foreign",
      content: "private notes from another workspace",
      createdAt: 1000,
      tags: ["vestaos"],
    });
    sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`)
      .bind("ws-b", "legacy-foreign").run();

    const query = vi.fn().mockImplementation(async (_values: number[], opts: any) => opts?.filter
      ? { matches: [] }
      : { matches: [
        {
          id: "v-own",
          score: 0.95,
          metadata: { parentId: "legacy-own", tags: ["vestaos"] },
        },
        {
          id: "v-foreign",
          score: 0.9,
          metadata: { parentId: "legacy-foreign", tags: ["vestaos"] },
        },
      ] });
    const scopedEnv = recallEnv(sqlite, { query: query as never });
    const { ctx } = makeCtx();

    const res = await recallEntries(
      { query: "VestaOS", topK: 5, hops: 0, synthesize: false },
      scopedEnv,
      ctx,
      undefined,
      { identity: memberOf("ws-a") },
    );

    expect(res.matches.map(match => match.id)).toEqual(["legacy-own"]);
    expect(scopedEnv.VECTORIZE.query).toHaveBeenCalledTimes(2);
    expect((scopedEnv.VECTORIZE.query as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(
      expect.objectContaining({ filter: { workspace_id: { $in: ["ws-a", "ws-co"] } } }),
    );
    expect((scopedEnv.VECTORIZE.query as ReturnType<typeof vi.fn>).mock.calls[1][1]).not.toHaveProperty("filter");
    expect(vectorizeFilterState()).toEqual({ supported: false, degradedQueries: 1 });
  });

  it.each([
    ["member", "member", undefined, undefined, ["own", "co", "co-2"]],
    ["admin including legacy", "admin", undefined, undefined, ["own", "co", "co-2", "legacy"]],
    ["personal layer", "member", "personal", undefined, ["own"]],
    ["company layer", "member", "company", undefined, ["co", "co-2"]],
    ["named team", "member", undefined, "ws-co", ["co"]],
  ] as const)("rejects unreadable dense ids for %s", async (_name, role, workspaceFilter, teamId, expected) => {
    for (const [id, workspace] of [
      ["own", "ws-a"], ["co", "ws-co"], ["co-2", "ws-co-2"],
      ["legacy", ""], ["foreign", "ws-b"],
    ] as const) seedIn(sqlite, id, workspace, `dense result ${id}`);
    const denseIds = ["own", "co", "co-2", "legacy", "foreign"];
    const query = vi.fn().mockResolvedValue({
      matches: denseIds.map((id, i) => ({ id, score: 0.95 - i * 0.01, metadata: { parentId: id } })),
    });
    const denseEnv = recallEnv(sqlite, { query });
    const identity: Identity = {
      ...memberOf("ws-a"), role, companyWorkspaceIds: ["ws-co", "ws-co-2"],
    };
    const diagnostics: NonNullable<RecallInternalOptions["diagnostics"]> = {};
    const { ctx } = makeCtx();

    const result = await recallEntries(
      { query: "alpha", topK: 10, synthesize: false }, denseEnv, ctx, undefined,
      { identity, workspaceFilter, teamId, diagnostics },
    );

    expect(query).toHaveBeenCalled();
    expect(diagnostics.denseIds).toContain("foreign");
    expect(result.matches.map(match => match.id).sort()).toEqual([...expected].sort());
  });

  it("keeps unreadable rows out of a multi-keyword candidate window without date bounds", async () => {
    seedIn(sqlite, "own-answer", "ws-a", "alpha beta decision", 1000);
    for (let i = 0; i < 4; i++) {
      seedIn(sqlite, `own-filler-${i}`, "ws-a", `unrelated readable note ${i}`, 900 - i);
    }
    for (let i = 0; i < 50; i++) {
      seedIn(sqlite, `foreign-${i}`, "ws-b", `alpha private noise ${i}`, 2000 + i);
    }
    const { ctx } = makeCtx();
    const diagnostics: NonNullable<RecallInternalOptions["diagnostics"]> = {};

    const res = await recallEntries(
      { query: "alpha beta", topK: 5, synthesize: false },
      env,
      ctx,
      { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: 50 },
      { identity: memberOf("ws-a"), diagnostics },
    );

    expect(res.matches.map(m => m.id)).toContain("own-answer");
    expect(diagnostics.keywordIds).toEqual(["own-answer"]);
    expect(diagnostics.keywordIds!.some(id => id.startsWith("foreign-"))).toBe(false);
    const keywordSql = sqlite.issued.find(s => s.includes("ORDER BY created_at DESC LIMIT"));
    expect(keywordSql).toContain(
      "WHERE (content LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') AND workspace_id IN (?, ?)",
    );
  });

  it("直接候補の適格性を含め、全entries読取りのscopeを維持する", async () => {
    seedTriangle(sqlite);
    const { ctx } = makeCtx();
    const keywordSql = () => sqlite.issued.find(s => s.includes("ORDER BY created_at DESC LIMIT"));

    // Absent identity: the unscoped statement. (The hydration
    // projection now carries workspace_id so matches can report their layer —
    // what must never appear unscoped is the workspace_id *clause*.)
    await recallEntries({ query: "alpha", topK: 10, synthesize: false }, env, ctx);
    // The keyword arm returns match levels, not text (src/recall/keyword-rows.ts): its candidate SELECT is the CTE's body.
    expect(keywordSql()).toContain(
      `SELECT id, created_at, tags, source, lower(content) AS lc FROM entries WHERE content LIKE ? ESCAPE '\\' AND (valid_until IS NULL OR valid_until > ?) AND tags NOT LIKE '%"quarantine:instruction"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:hidden"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:burst"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:capsule"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:too\\_long"%' ESCAPE '\\' AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"auto-insight"%' AND tags NOT LIKE '%"status:deprecated"%' ORDER BY created_at DESC LIMIT ?`,
    );
    expect(sqlite.issued.some(s => s.includes("FROM entries") && s.includes("workspace_id IN"))).toBe(false);

    // With identity: the same statement plus the AND'd clause, nothing else moved.
    sqlite.issued.length = 0;
    await recallEntries({ query: "alpha", topK: 10, synthesize: false }, env, ctx, undefined,
      { identity: memberOf("ws-a") });
    expect(keywordSql()).toContain(
      `SELECT id, created_at, tags, source, lower(content) AS lc FROM entries WHERE content LIKE ? ESCAPE '\\' AND workspace_id IN (?, ?) AND (valid_until IS NULL OR valid_until > ?) AND tags NOT LIKE '%"quarantine:instruction"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:hidden"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:burst"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:capsule"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:too\\_long"%' ESCAPE '\\' AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"auto-insight"%' AND tags NOT LIKE '%"status:deprecated"%' ORDER BY created_at DESC LIMIT ?`,
    );
    // Both hydration steps carry the clause too — the candidate-signal read is
    // the leak-catcher for unscoped vectorize hits until namespaces land (P3).
    const hydrations = sqlite.issued.filter(s => s.includes("FROM entries WHERE id IN"));
    expect(hydrations.length).toBeGreaterThan(0);
    for (const sql of hydrations) expect(sql).toContain("AND +(workspace_id IN (?, ?))");
    // The recall_count bump stays by-id: those ids came from already-scoped rows.
    expect(sqlite.issued.some(s => s.includes("UPDATE entries SET recall_count") && s.includes("workspace_id")))
      .toBe(true);
  });

  it("scopes the ?tag= scan too", async () => {
    // Non-empty vector_ids keep the tag branch past its no-vectors early return,
    // and getByIds must hand back real vectors: unlike the main path, a ?tag=
    // recall never touches VECTORIZE.query, so without them fusion has no dense
    // arm and keyword-only rows are not admissible. parentId metadata is what
    // lets hydration resolve the vector hits back to entry rows.
    const vectorFor = (entryId: string) => ({
      id: `v-${entryId}`, values: new Array(384).fill(0.2), metadata: { parentId: entryId },
    });
    for (const [id, ws] of [["t-own", "ws-a"], ["t-co", "ws-co"], ["t-foreign", "ws-b"]] as const) {
      sqlite.seed({ id, content: `alpha tagged ${id}`, createdAt: 1000, tags: ["proj"], vectorIds: [`v-${id}`] });
      sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(ws, id).run();
    }
    const { ctx } = makeCtx();

    const res = await recallEntries(
      { query: "alpha", topK: 10, tag: "proj", synthesize: false },
      recallEnv(sqlite, { getByIds: vi.fn().mockResolvedValue([vectorFor("t-own"), vectorFor("t-co")]) }),
      ctx, undefined, { identity: memberOf("ws-a") },
    );

    expect(sqlite.issued.some(s =>
      s.includes("FROM entries WHERE tags LIKE ?") && s.includes("AND workspace_id IN (?, ?)"),
    )).toBe(true);
    const ids = res.matches.map(m => m.id);
    expect(ids).toContain("t-own");
    expect(ids).toContain("t-co");
    expect(ids).not.toContain("t-foreign");
  });

  it("narrows the keyword arm to the requested layer or team, like every other read", async () => {
    seedTriangle(sqlite);
    const { ctx } = makeCtx();
    const keywordSql = () => sqlite.issued.find(s => s.includes("ORDER BY created_at DESC LIMIT"));

    // Layer filter: only the personal workspace is bound.
    await recallEntries({ query: "alpha", topK: 10, synthesize: false }, env, ctx, undefined,
      { identity: memberOf("ws-a"), workspaceFilter: "personal" });
    expect(keywordSql()).toContain(
      `SELECT id, created_at, tags, source, lower(content) AS lc FROM entries WHERE content LIKE ? ESCAPE '\\' AND workspace_id IN (?) AND (valid_until IS NULL OR valid_until > ?) AND tags NOT LIKE '%"quarantine:instruction"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:hidden"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:burst"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:capsule"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:too\\_long"%' ESCAPE '\\' AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"auto-insight"%' AND tags NOT LIKE '%"status:deprecated"%' ORDER BY created_at DESC LIMIT ?`,
    );

    // Team filter: exactly one workspace id, and the result set is that team's row.
    sqlite.issued.length = 0;
    const res = await recallEntries({ query: "alpha", topK: 10, synthesize: false }, env, ctx, undefined,
      { identity: memberOf("ws-a"), teamId: "ws-co" });
    expect(keywordSql()).toContain(
      `SELECT id, created_at, tags, source, lower(content) AS lc FROM entries WHERE content LIKE ? ESCAPE '\\' AND workspace_id = ? AND (valid_until IS NULL OR valid_until > ?) AND tags NOT LIKE '%"quarantine:instruction"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:hidden"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:burst"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:capsule"%' ESCAPE '\\' AND tags NOT LIKE '%"quarantine:too\\_long"%' ESCAPE '\\' AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"auto-insight"%' AND tags NOT LIKE '%"status:deprecated"%' ORDER BY created_at DESC LIMIT ?`,
    );
    expect(res.matches.map(m => m.id)).toEqual(["co"]);
  });

  it("computes DF over the caller's readable corpus only", async () => {
    // "zeta" is rare inside ws-a but floods ws-b. Corpus-wide, 11/15 rows say
    // zeta — past the saturation cut, so distill drops it from the query.
    // Scoped, 1/5 clears the cut and the term survives into queryUsed.
    seedIn(sqlite, "zeta-hit", "ws-a", "zeta alpha discovery");
    for (let i = 0; i < 3; i++) seedIn(sqlite, `filler-${i}`, "ws-a", `alpha filler ${i}`);
    for (let i = 0; i < 10; i++) seedIn(sqlite, `flood-${i}`, "ws-b", `zeta private log ${i}`);
    const { ctx } = makeCtx();

    const unscoped = await recallEntries({ query: "alpha zeta", topK: 5, synthesize: false }, env, ctx);
    expect(unscoped.queryUsed).not.toContain("zeta");

    sqlite.issued.length = 0;
    const scoped = await recallEntries({ query: "alpha zeta", topK: 5, synthesize: false }, env, ctx,
      undefined, { identity: memberOf("ws-a") });
    expect(scoped.queryUsed).toContain("zeta");
    // And the aggregate itself was scoped — visible on the issued SQL directly.
    // No time bounds parsed from the query, so the scope clause IS the WHERE.
    const aggregate = sqlite.issued.find(s => s.includes("AS total") && s.includes("SUM(CASE WHEN content LIKE"));
    expect(aggregate).toBeDefined();
    expect(aggregate!).toContain("FROM entries WHERE workspace_id IN (?, ?)");
    expect(aggregate!).not.toContain("created_at");
  });
});
