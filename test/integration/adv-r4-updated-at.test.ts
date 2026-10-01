/**
 * Adversary round 4 against 7d96df69 ("every content writer clamps updated_at strictly past its own
 * previous value": updated_at = MAX(now, COALESCE(prev, created_at) + 1)). Real SQLite (node:sqlite).
 * Every test here FAILS on aeb02700 and names the invariant it breaks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { compressTag } from "../../src/compression/digest";
import { updateEntryContent } from "../../src/capture/store";
import { importAllPages as importExportPayload } from "../helpers/import-pages";
import { runStalenessPass } from "../../src/staleness/pass";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let digestEdit: (() => Promise<void>) | null = null;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const DAY = 86_400_000;

const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
} });

beforeEach(async () => {
  resetDatabaseInit();
  digestEdit = null;
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn(async (): Promise<any> => ({ matches: [] })) }),
    AI: { run: vi.fn(async (model: string, opts: any) => {
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (prompt.includes("write a single cohesive paragraph")) {
        // The digest has read its sources and is synthesizing: a user edit lands now.
        if (digestEdit) { const e = digestEdit; digestEdit = null; await e(); }
        return stream("A summary of the Q3 launch notes.");
      }
      return stream("3");
    }) } as any,
  })) as Env;
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

const wctx = () => ({ workspaceId: owner.personalWorkspaceId, actorId: owner.userId });
const change = () => ({ actorId: owner.userId, channel: "rest" as const });
const live = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const edit = (id: string, text: string) =>
  updateEntryContent(env, id, text, DEFAULTS, undefined, undefined, wctx(), change(), owner.personalWorkspaceId);

describe("R4-U1 (MAJOR): an imported updated_at >= 2^53 makes the +1 clamp a no-op, and the digest guard rolls up an edit it never saw", () => {
  // import.ts:762-765 accepts any finite updated_at. Stored as REAL (1e300 cannot become an INTEGER), so the
  // clamp's `COALESCE(e.updated_at, e.created_at) + 1` (store.ts:417, and every other clamped writer) rounds
  // back to the same value: MAX(now, 1e300 + 1) = 1e300. updated_at does not move, so digest.ts:102-110's
  // (rowVersion, byte length) guard matches a same-length edit made during synthesis, and markSourcesRolledUp
  // appends the note and `rolled-up` (0.4x recall, barred from later digests) to text the digest never read.
  it("a same-length edit during synthesis is not marked rolled-up", async () => {
    const old = Date.now() - 200 * DAY;
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `q${i}`, content: `Q3 launch note ${i}: ship the beta to design partners`, tags: ["rocket-project"],
      created_at: old + i, updated_at: i === 0 ? 1e300 : old + i,
    }));
    const summary = await importExportPayload(env, { entries }, { writeCtx: wctx() });
    expect(summary.imported).toBe(12);

    const edited = "Q4 launch note 0: ship the beta to design partners"; // same byte length as the original
    expect(new TextEncoder().encode(edited).length).toBe(new TextEncoder().encode(entries[0].content).length);
    let before = 0, after = 0;
    digestEdit = async () => {
      before = (await live("q0")).updated_at;
      await edit("q0", edited);
      after = (await live("q0")).updated_at;
    };
    await compressTag("rocket-project", env, ctx);

    const row = await live("q0");
    expect(row.content.startsWith(edited)).toBe(true); // the user's edit committed
    expect(after).not.toBe(before); // FAILS: the clamp promises "strictly past"; 1e300 before and after
    expect(JSON.parse(row.tags)).not.toContain("rolled-up"); // FAILS: marked rolled-up over text the digest never saw
  });
});

describe("R4-U2 (MINOR): a future updated_at is now sticky: every edit clamps past it instead of healing it", () => {
  // Before 7d96df69 an edit set updated_at = now, so a bad imported value (import.ts:762 has no upper bound; a
  // microsecond-epoch export is the realistic source) lasted until the first edit. Now store.ts:417 (and entry.ts
  // :244/:283, store.ts:585/:671, mirror.ts:148, undo.ts:233) keep it at F+1, F+2, ... forever: the row sorts as
  // freshest in recall, and runStalenessPass (pass.ts:204, `COALESCE(updated_at, created_at) < cutoff`) never
  // examines it again, however long ago the user last really touched it.
  it("an edit moves updated_at to the edit's own time, and the row becomes a staleness candidate 90 days later", async () => {
    const now = Date.now();
    const F = now * 1000; // updated_at exported in microseconds: year ~57,000
    const summary = await importExportPayload(env, { entries: [{
      id: "f1", content: "The office wifi password is hunter2", tags: ["rocket-project"], created_at: now - 400 * DAY, updated_at: F,
    }] }, { writeCtx: wctx() });
    expect(summary.imported).toBe(1);

    await edit("f1", "The office wifi password is correcthorse");
    const row = await live("f1");
    expect(row.content).toBe("The office wifi password is correcthorse");
    expect(row.updated_at).toBeLessThanOrEqual(Date.now()); // FAILS: F + 1

    // 91 days later, with nothing touching it since the edit.
    vi.spyOn(Date, "now").mockReturnValue(now + 91 * DAY);
    await runStalenessPass(env, ctx);
    expect((await live("f1")).staleness_checked_at).not.toBeNull(); // FAILS: never a candidate
  });
});

describe("R4-U3 (MINOR): one future value poisons every later version's valid_from/created_at", () => {
  // versions.ts:93-96: valid_from = the newest version's created_at (else the row's COALESCE(updated_at,
  // created_at)); created_at = MAX(now, that). The first snapshot of a row whose updated_at is F lands at F,
  // and every later version floors on it, so the whole history timeline Track 2 computes validity from sits at F.
  // The digest mark (digest.ts:102, `updated_at = now`, unclamped) meanwhile resets the row itself to now,
  // leaving version.created_at > row.updated_at: the history and the row disagree about when the edit happened.
  it("version created_at never exceeds the time of the write, and never exceeds the row's own updated_at", async () => {
    const now = Date.now();
    const F = now + 5 * 365 * DAY; // five years ahead
    const old = now - 200 * DAY;
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`, content: `Roadmap item ${i} for the platform team`, tags: ["rocket-project"], created_at: old + i,
      updated_at: i === 0 ? F : old + i,
    }));
    expect((await importExportPayload(env, { entries }, { writeCtx: wctx() })).imported).toBe(12);

    await compressTag("rocket-project", env, ctx); // rollup: snapshot + mark on r0
    const afterMark = await live("r0");
    expect(JSON.parse(afterMark.tags)).toContain("rolled-up");
    const [v1] = await versions("r0");
    expect(v1.reason).toBe("rollup");
    expect(v1.created_at).toBeLessThanOrEqual(afterMark.updated_at); // FAILS: v1.created_at = F, row.updated_at = now
    expect(v1.created_at).toBeLessThanOrEqual(Date.now()); // FAILS: five years ahead

    await edit("r0", "Roadmap item 0 for the platform team, moved to Q2");
    const vs = await versions("r0");
    const v2 = vs[vs.length - 1];
    expect(v2.valid_from).toBeLessThanOrEqual(Date.now()); // FAILS: F, inherited from v1
    expect(v2.created_at).toBeLessThanOrEqual(Date.now()); // FAILS: F
  });
});
