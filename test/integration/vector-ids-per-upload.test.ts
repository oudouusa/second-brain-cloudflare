import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { storeEntry } from "../../src/capture/store";
import { runNightlyVectorizePending } from "../../src/vectorize/pending";
import { newVectorIds, parentIdOfVectorId } from "../../src/vectorize/ids";
import { DEFAULTS } from "../../src/config";
import { writerSpans } from "../../scripts/check-scope.mjs";

// T-0089.1.1 close-out round 6: every upload mints its own vector ids (entry id, a per-upload
// suffix, the chunk index), so a writer's cleanup can only ever delete ids it uploaded. The row's
// vector_ids decides which upload won; 3.7's deterministic ids keep working with no backfill.

let t: TrashEnv;
afterEach(() => { t?.close(); vi.restoreAllMocks(); });

const OLD = Date.now() - 60 * 60_000;
const listed = async (id: string) => JSON.parse((await t.one<{ vector_ids: string }>(`SELECT vector_ids FROM entries WHERE id = ?`, id))!.vector_ids) as string[];

describe("vector ids", () => {
  it("each upload mints ids no other upload shares, and every form parses back to its entry", () => {
    const a = newVectorIds("e1", 3), b = newVectorIds("e1", 3);
    expect(a).toHaveLength(3);
    expect(new Set([...a, ...b]).size).toBe(6);
    for (const v of [...a, ...b]) expect(parentIdOfVectorId(v)).toBe("e1");
    // 3.7's deterministic forms, read with no backfill.
    expect(parentIdOfVectorId("e1")).toBe("e1");
    expect(parentIdOfVectorId("e1-chunk-4")).toBe("e1");
    expect(parentIdOfVectorId("e1-update-1790000000000")).toBe("e1");
    for (const v of a) expect(new TextEncoder().encode(v).length).toBeLessThanOrEqual(64); // Vectorize's id limit
  });

  it("two writers embedding the same content upload disjoint ids; the one whose read went stale loses and deletes only its own", async () => {
    t = await makeTrashEnv();
    t.seed("e", { content: "same text", created_at: 1 });
    const ctx = { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId };
    const deleted: string[] = [];
    const del = t.env.VECTORIZE.deleteByIds.bind(t.env.VECTORIZE);
    (t.env.VECTORIZE as any).deleteByIds = async (ids: string[]) => { deleted.push(...ids); return del(ids); };
    // Both read vector_ids = '[]'; the first commits, the second's compare-and-set then misses.
    const first = await storeEntry(t.env, "e", "same text", [], "api", 1, DEFAULTS, ctx, { expectedVectorIds: "[]" });
    const second = await storeEntry(t.env, "e", "same text", [], "api", 1, DEFAULTS, ctx, { expectedVectorIds: "[]" });
    expect(first.vectorIds.some((v) => second.vectorIds.includes(v))).toBe(false);
    expect([first.committed, second.committed]).toEqual([true, false]);
    expect(await listed("e")).toEqual(first.vectorIds);
    expect(deleted).toEqual(second.vectorIds);
  });

  it("a nightly upload that loses to a concurrent commit deletes only its own ids, never the winner's", async () => {
    t = await makeTrashEnv();
    t.seed("d", { content: "deferred", created_at: OLD });
    const ctx = { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId };
    const present = new Set<string>();
    const up = t.env.VECTORIZE.upsert.bind(t.env.VECTORIZE);
    const del = t.env.VECTORIZE.deleteByIds.bind(t.env.VECTORIZE);
    let winner: string[] = [];
    let raced = false;
    (t.env.VECTORIZE as any).upsert = async (vs: any[]) => {
      vs.forEach((v) => present.add(v.id));
      const r = await up(vs);
      // The nightly pass's upload lands, then another writer commits the row before the pass does.
      if (!raced) { raced = true; winner = (await storeEntry(t.env, "d", "deferred", [], "api", OLD, DEFAULTS, ctx)).vectorIds; }
      return r;
    };
    (t.env.VECTORIZE as any).deleteByIds = async (ids: string[]) => { ids.forEach((i) => present.delete(i)); return del(ids); };
    await runNightlyVectorizePending(t.env, DEFAULTS);
    expect(await listed("d")).toEqual(winner);
    for (const v of winner) expect(present.has(v), v).toBe(true);
    expect([...present]).toEqual(winner); // the loser left nothing behind
  });
});

describe("structural", () => {
  const SRC = join(__dirname, "../../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const all = files(SRC).map((p) => ({ file: p.slice(SRC.length + 1), src: readFileSync(p, "utf8") }));

  it("no writer builds a deterministic vector id; uploads mint theirs through newVectorIds", () => {
    for (const f of all) {
      if (f.file === "memory/trash.ts") continue; // deterministicVectorIds: reads 3.7 ids for Delete forever, never uploads
      expect(f.src, f.file).not.toMatch(/-chunk-\$\{|-update-\$\{/);
    }
    expect(all.find((f) => f.file === "capture/store.ts")!.src).toContain("crypto.randomUUID()");
  });

  it("every UPDATE that replaces vector_ids also compare-and-sets the vector_ids it read (the row decides which upload won)", () => {
    let n = 0;
    for (const f of all) {
      for (const span of writerSpans(f.src) as { start: number; end: number }[]) {
        const sql = f.src.slice(span.start + 1, span.end);
        if (!/^\s*UPDATE entries\b/.test(sql)) continue;
        const [set, ...rest] = sql.split(/\bWHERE\b/);
        if (!/\bvector_ids\s*=/.test(set) || /\bvector_ids\s*=\s*'\[\]'/.test(set)) continue;
        // An append adds its own chunk to whatever the row lists: nothing is replaced.
        if (/vector_ids\s*=\s*CASE WHEN [^]*json_insert\(vector_ids/.test(set)) continue;
        n++;
        const where = rest.join("WHERE");
        const guardVar = /buildCasGuard\(\w+, (\w+)\)/.exec(where)?.[1];
        const guardHasIds = guardVar ? new RegExp(`const ${guardVar} = \\{[^}]*vector_ids:`).test(f.src) : false;
        const ok = /\bvector_ids = \?/.test(where) || /\bvector_ids = '\[\]'/.test(where) || guardHasIds || /\$\{workspaceGuard\(/.test(where) && /readVectorIds/.test(where);
        expect(ok, `${f.file}: ${sql.slice(0, 110)}`).toBe(true);
      }
    }
    expect(n).toBeGreaterThanOrEqual(7);
  });
});

describe("failure counts expire", () => {
  it("the failure map is written with a 30-day TTL and drops entries whose last failure is older than that", async () => {
    t = await makeTrashEnv();
    t.seed("f", { content: "fails", created_at: OLD });
    const puts: { key: string; value: string; opts?: { expirationTtl?: number } }[] = [];
    const kv = t.env.OAUTH_KV as any;
    const put = kv.put.bind(kv);
    kv.put = async (key: string, value: string, opts?: any) => { puts.push({ key, value, opts }); return put(key, value, opts); };
    const old = Date.now() - 31 * 86_400_000;
    await put("vectorize-pending:failures", JSON.stringify({ gone: { n: 5, at: old } }));
    (t.env.VECTORIZE as any).upsert = async () => { throw new Error("503"); };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runNightlyVectorizePending(t.env, DEFAULTS);
    const last = puts.filter((p) => p.key === "vectorize-pending:failures").at(-1)!;
    expect(last.opts?.expirationTtl).toBeGreaterThanOrEqual(30 * 86_400);
    const map = JSON.parse(last.value);
    expect(map).not.toHaveProperty("gone");
    expect(map.f.n).toBe(1);
  });
});
