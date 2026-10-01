/**
 * Q3 (16-t3-t4-trust-spec.md 5.4): the pure hold builders. Lane W appends
 * holdStatements to a write's own batch; this pins their order and shape
 * with a stub snapshot builder, so no Track 1 module is imported here.
 */
import { describe, it, expect, vi } from "vitest";
import type { Env } from "../../src/env";
import { heldTagsFor, holdStatements, type HoldSnapshotInput } from "../../src/quarantine/hold";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

type Stmt = { sql: string; bindings: unknown[] };

function fakeEnv() {
  const prepared: Stmt[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => {
        const stmt: Stmt & { bind: (...b: unknown[]) => Stmt } = {
          sql, bindings: [], bind: (...b: unknown[]) => { stmt.bindings = b; return stmt; },
        };
        prepared.push(stmt);
        return stmt;
      },
    },
  } as unknown as Env;
  return { env, prepared };
}

describe("heldTagsFor", () => {
  it("adds quarantine:<primary reason> and status:draft to the write's tags", () => {
    expect(heldTagsFor(["work", "status:canonical"], ["instruction", "hidden"])).toEqual(["work", "quarantine:instruction", "status:draft"]);
    expect(heldTagsFor([], ["burst"])).toEqual(["quarantine:burst", "status:draft"]);
  });

  it("refuses an empty reason list, since a hold always has a primary reason", () => {
    expect(() => heldTagsFor(["work"], [])).toThrow();
  });
});

describe("holdStatements emits snapshot, guarded tags UPDATE with vector_ids '[]', and prune, in that order", () => {
  const change = { actorId: "u-1", channel: "mcp" as const, client: "Cursor" };

  it("builds the three statements from the injected builders", () => {
    const { env, prepared } = fakeEnv();
    const snapshot = vi.fn((_env: Env, s: HoldSnapshotInput<typeof change>) => ({ kind: "snapshot", s }) as unknown as D1PreparedStatement);
    const prune = vi.fn((_env: Env, id: string, keep: number) => ({ kind: "prune", id, keep }) as unknown as D1PreparedStatement);
    const heldTags = heldTagsFor(["work"], ["instruction"]);
    // Codex review, T-0102 D3: the same guard reference must reach BOTH the snapshot and the
    // UPDATE below, or a lost compare-and-set on the UPDATE leaves a phantom hold-version row
    // whose guard let it land unconditionally.
    const guard = (p: { add(v: unknown): string }) => `updated_at = ${p.add(123)} AND actor_id = ${p.add("u-1")}`;

    const stmts = holdStatements(env, { snapshotStatement: snapshot, pruneStatement: prune, versionKeep: 20 }, {
      entryId: "e-1", reasons: ["instruction", "hidden"], score: 1.8,
      signals: [{ id: "I4", weight: 0.6 }, { id: "I3", weight: 0.8 }, { id: "H3", weight: 0.6 }],
      change, heldTags, now: 1_790_000_000_000,
      guard,
    });

    expect(stmts).toHaveLength(4);
    expect(stmts[0]).toMatchObject({ kind: "snapshot" });
    expect(snapshot).toHaveBeenCalledWith(env, {
      entryId: "e-1", reason: "status", change, content: { kind: "unchanged" }, nextTags: heldTags,
      meta: { hold: { reasons: ["instruction", "hidden"], score: 1.8, signals: ["I4", "I3", "H3"] } },
      now: 1_790_000_000_000,
      guard,
    });

    expect(prepared).toHaveLength(2);
    expect(stmts[1]).toBe(prepared[1]);
    expect(prepared[1].sql).toContain("INSERT INTO vector_cleanup_ops");
    expect(stmts[2]).toBe(prepared[0]);
    expect(prepared[0].sql).toMatch(/^UPDATE entries SET write_marker = \?5, tags = \?1, vector_ids = '\[\]' WHERE id = \?2 AND \(updated_at = \?3 AND actor_id = \?4\)$/);
    expect(prepared[0].bindings).toEqual([JSON.stringify(heldTags), "e-1", 123, "u-1", null]);

    expect(stmts[3]).toEqual({ kind: "prune", id: "e-1", keep: 20 });
  });

  it("reuses a placeholder for a repeated value and omits the guard clause when there is none", () => {
    const { env, prepared } = fakeEnv();
    const noop = () => ({}) as D1PreparedStatement;
    holdStatements(env, { snapshotStatement: noop, pruneStatement: noop, versionKeep: 20 }, {
      entryId: "e-2", reasons: ["burst"], score: 1, signals: [], change, heldTags: ["quarantine:burst", "status:draft"], now: 1,
    });
    holdStatements(env, { snapshotStatement: noop, pruneStatement: noop, versionKeep: 20 }, {
      entryId: "e-3", reasons: ["burst"], score: 1, signals: [], change, heldTags: ["x"], now: 1,
      guard: p => `(id = ${p.add("e-3")} AND tags <> ${p.add("[]")})`,
    });
    expect(prepared[0].sql).toBe(`UPDATE entries SET write_marker = ?3, tags = ?1, vector_ids = '[]' WHERE id = ?2`);
    expect(prepared[2].sql).toBe(`UPDATE entries SET write_marker = ?4, tags = ?1, vector_ids = '[]' WHERE id = ?2 AND ((id = ?2 AND tags <> ?3))`);
    expect(prepared[2].bindings).toEqual([JSON.stringify(["x"]), "e-3", "[]", null]);
  });

  it("the UPDATE runs on real SQLite: sets the held tags, clears vector_ids, and respects the guard", async () => {
    const sq = makeSqliteD1();
    try {
      sq.seed({ id: "e-4", content: "text", createdAt: 1, tags: ["work"], vectorIds: ["v1", "v2"] });
      const env = sq.admitEnv({ DB: sq.db } as unknown as Env);
      const noop = () => ({}) as D1PreparedStatement;
      const heldTags = heldTagsFor(["work"], ["instruction"]);
      const deps = { snapshotStatement: noop, pruneStatement: noop, versionKeep: 20 };
      const base = { entryId: "e-4", reasons: ["instruction" as const], score: 1, signals: [], change, heldTags, now: 1 };

      await holdStatements(env, deps, { ...base, guard: p => `created_at = ${p.add(999)}` })[2].run();
      let row = await sq.db.prepare(`SELECT tags, vector_ids FROM entries WHERE id = 'e-4'`).first() as { tags: string; vector_ids: string };
      expect(JSON.parse(row.tags)).toEqual(["work"]);

      await holdStatements(env, deps, { ...base, guard: p => `created_at = ${p.add(1)}` })[2].run();
      row = await sq.db.prepare(`SELECT tags, vector_ids FROM entries WHERE id = 'e-4'`).first() as { tags: string; vector_ids: string };
      expect(JSON.parse(row.tags)).toEqual(heldTags);
      expect(row.vector_ids).toBe("[]");
    } finally {
      sq.close();
    }
  });
});
