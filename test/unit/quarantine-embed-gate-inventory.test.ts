/**
 * Codex review class A (T-0089.4.2): "no call to Vectorize upsert or storeEntry outside the
 * gate." The gate is `upsertEntryVectors`'s own `if (isHeld(tags)) throw HeldRowEmbedRefusedError`
 * (src/capture/store.ts) — every caller that embeds a row's real content (storeEntry,
 * reembedOrThrow, reembedOrDegrade, undo's reembedForRevert/reembedForRelease, trash restore,
 * mirror sync, the embedding migration, vectorize-pending) already goes through it. This scans
 * src/ for every OTHER direct `env.VECTORIZE.upsert(`/`.insert(` call site — the ones the gate
 * cannot see — and requires each to be named here with why it is still safe, so a new one added
 * without routing through the gate (or without an equally explicit reason) fails loudly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HeldRowEmbedRefusedError, upsertEntryVectors } from "../../src/capture/store";
import { withHold } from "../../src/quarantine/tags";
import { makeAIMock, makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

const ROOT = join(import.meta.dirname, "../..");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

interface Site { file: string; line: number }

function scanDirectCalls(): Site[] {
  const sites: Site[] = [];
  const CALL = /\benv\.VECTORIZE\.(?:upsert|insert)\s*\(/g;
  for (const path of walk(join(ROOT, "src"))) {
    const file = relative(ROOT, path);
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(CALL)) {
      const line = text.slice(0, m.index).split("\n").length;
      sites.push({ file, line });
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Every direct `env.VECTORIZE.upsert`/`.insert` site OUTSIDE upsertEntryVectors itself, with why
 * it needs no gate. A writer added here without one of these two shapes is the bug class A
 * exists to catch: an embed of a row whose current tags were never checked.
 */
const ACCOUNTED_FOR: { file: string; line: number; why: string }[] = [
  {"file": "src/capture/store.ts", "line": 282, "why": "索引移行・普通storeの入口でisHeld(tags)を拒否する。"},
  {"file": "src/capture/store.ts", "line": 552, "why": "upsertEntryVectors自身の入口でisHeld(tags)を拒否する。"},
  {"file": "src/capture/store.ts", "line": 1072, "why": "appendはheldRowなら埋込みを省略し、空配列だけを渡す。競合後のholdも再検査する。"},
  {"file": "src/capture/store.ts", "line": 1328, "why": "保留追記の復旧はINDEXABLE_SQLとvalidateIndexableMemoryで現在のholdを拒否する。"},
  {"file": "src/capture/share.ts", "line": 172, "why": "既存vectorのworkspace再stampだけ。upsert直前に現在の親行のisHeldを再検査する。"},
];

describe("every direct Vectorize upsert/insert call outside upsertEntryVectors's own gate is accounted for", () => {
  const sites = scanDirectCalls();

  it("finds at least the known call sites (the scanner itself is not a no-op)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it("matches the accounted-for list exactly", () => {
    const actual = sites.map(s => `${s.file}:${s.line}`).sort();
    const expected = ACCOUNTED_FOR.map(s => `${s.file}:${s.line}`).sort();
    expect(actual).toEqual(expected);
  });
});

describe("upsertEntryVectors' own gate", () => {
  it("refuses tags that are still held", async () => {
    const env = makeTestEnv(makeTestDb(), { VECTORIZE: makeVectorizeMock(), AI: makeAIMock() });
    await expect(
      upsertEntryVectors(env, "e1", "content", withHold(["work"], "instruction"), "api", Date.now()),
    ).rejects.toThrow(HeldRowEmbedRefusedError);
  });

  it("embeds normally when the tags are not held", async () => {
    const env = makeTestEnv(makeTestDb(), { VECTORIZE: makeVectorizeMock(), AI: makeAIMock() });
    const result = await upsertEntryVectors(env, "e1", "content", ["work"], "api", Date.now());
    expect(result.vectorIds.length).toBeGreaterThan(0);
  });
});
