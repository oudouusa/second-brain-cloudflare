/**
 * Every caller of a config-taking function must pass config explicitly.
 *
 * `config: Readonly<Config> = DEFAULTS` is a convenient signature and a
 * dangerous one: forget the argument and the call silently uses the shipped
 * default instead of the user's setting. Nothing throws, nothing fails a type
 * check, and the wrong value is indistinguishable from the right one until
 * someone changes a setting and notices it did nothing.
 *
 * Four call sites had already drifted when this test was written:
 *
 * - `POST /vectorize-pending` embedded with `DEFAULTS.EMBEDDING_MODEL` while
 *   capture and recall used the configured one, writing vectors from the wrong
 *   model into the index. Scores go quietly wrong; nothing throws. This is the
 *   exact failure `config-embedding-consistency.test.ts` exists to prevent, on a
 *   route that test does not reach.
 * - `POST /classify-pending` and `scheduleClassifyAndTag` classified with
 *   `DEFAULTS.LLM_MODEL`, ignoring the model the user picked in the desktop app.
 * - `mirror.createEntry` resolved config for its embed and then classified with
 *   the default, so one function used two different models.
 *
 * `config-threading-complete.test.ts` cannot catch any of these: it looks for
 * module-scope *reads* of tunables, and an omitted argument reads nothing.
 *
 * Passing `DEFAULTS` explicitly is allowed — it documents the intent at the call
 * site, which is the whole point.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const SRC = resolve(import.meta.dirname, "../../src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const FILES = sourceFiles(SRC).map(path => ({
  path,
  rel: path.slice(SRC.length + 1),
  text: readFileSync(path, "utf8"),
}));

/** Functions declaring a defaulted config parameter, by name. */
function configTakingFunctions(): Map<string, string> {
  const found = new Map<string, string>();
  const decl = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gs;
  for (const { rel, text } of FILES) {
    for (const m of text.matchAll(decl)) {
      const [, name, params] = m;
      if (/config\s*:\s*Readonly<Config>\s*=/.test(params)) found.set(name, rel);
    }
  }
  return found;
}

/**
 * Argument list of each call to `name`, found by matching parentheses so nested
 * calls and object literals are not truncated.
 */
function callsTo(name: string, text: string): string[] {
  const calls: string[] = [];
  const needle = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const m of text.matchAll(needle)) {
    // Skip the declaration itself.
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (/function\s+$/.test(before)) continue;

    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    calls.push(text.slice(m.index + m[0].length, i - 1));
  }
  return calls;
}

describe("config is passed, never left to the default", () => {
  const functions = configTakingFunctions();

  it("finds the config-taking functions it is meant to guard", () => {
    // A rename that broke the detector would otherwise make this whole file
    // pass by testing nothing.
    expect(functions.size).toBeGreaterThanOrEqual(5);
    for (const expected of ["storeEntry", "embedDocument", "embedQuery", "classifyEntry"]) {
      expect([...functions.keys()], `${expected} should be detected`).toContain(expected);
    }
  });

  it("every call inside src/ passes config explicitly", () => {
    const offenders: string[] = [];

    for (const [fn, declaredIn] of functions) {
      for (const { rel, text } of FILES) {
        for (const args of callsTo(fn, text)) {
          // The recursive call inside the function's own file is its business —
          // e.g. reembedOrThrow forwarding to storeEntry — but it still has to
          // name config, which the check below covers.
          const passesConfig = /\b(cfg|config|DEFAULTS|resolveConfig)\b/.test(args);
          if (!passesConfig) {
            offenders.push(
              `${rel}: ${fn}(…) omits config (declared in ${declaredIn})\n      args: ${args
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 120)}`,
            );
          }
        }
      }
    }

    expect(
      offenders,
      `these calls fall back to DEFAULTS instead of the user's settings:\n  ${offenders.join(
        "\n  ",
      )}\n\nPass the resolved config, or pass DEFAULTS explicitly to say you meant it.`,
    ).toEqual([]);
  });
});
