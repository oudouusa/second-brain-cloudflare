import { vi } from "vitest";
// 上流の固定corpusは候補窓500件向け。これはfixture自体の整合性試験でありforkの順位評価ではない。
vi.mock("../../../src/constants", async importOriginal => ({ ...await importOriginal<object>(), KEYWORD_CANDIDATE_LIMIT: 500 }));
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMON_TOKENS, CORRELATED_TOKENS, DENSE_RATE_BY_SCALE, DENSE_TOKENS, IMPORTANCE_WEIGHTS, generateHaystack, type HaystackOptions } from "./haystack";
import { FTS_MATCH_BUDGET, KEYWORD_CANDIDATE_LIMIT, QUERY_SATURATION_FRACTION } from "../../../src/constants";
import { readScopeWorkspaces } from "../../../src/lib/scope";
import { HAYSTACK_ROWS } from "./build";
import { ACTORS, DAY_MS, EVAL_NOW, IDENTITIES, WORKSPACES, needleToEntry } from "./types";

const base: HaystackOptions = {
  count: 256,
  seed: 7,
  commonRate: 0.18,
  idPrefix: "f",
  now: EVAL_NOW,
  spanDays: 730,
  cjkRate: 0.08,
  longRate: 0.02,
  denseRate: 1.2,
  workspaces: [
    { workspaceId: WORKSPACES.avery, actorId: ACTORS.avery, weight: 45 },
    { workspaceId: WORKSPACES.company, actorId: ACTORS.blake, weight: 45 },
    { workspaceId: WORKSPACES.blake, actorId: ACTORS.blake, weight: 10 },
  ],
};

// The real corpus parameters (CORPUS_PARAMS; the 20k commonRate is 0.08 so a rare+common query keeps FTS). The
// haystack is HAYSTACK_ROWS whatever the needle count; `total` is the looser variant with 344 more rows.
const REAL = [
  { scale: "1k", total: HAYSTACK_ROWS["core-1k"] + 344, commonRate: 0.25, seed: 1001 },
  { scale: "5k", total: HAYSTACK_ROWS["scale-5k"] + 344, commonRate: 0.25, seed: 5001 },
  { scale: "20k", total: HAYSTACK_ROWS["scale-20k"] + 344, commonRate: 0.08, seed: 20_001 },
] as const;
type Real = (typeof REAL)[number];
const realRows = (config: Real, count = config.total - 344, seed: number = config.seed) =>
  generateHaystack({ ...base, count, commonRate: config.commonRate, seed, denseRate: DENSE_RATE_BY_SCALE[config.scale] });
const SCOPES = {
  avery: readScopeWorkspaces(IDENTITIES.avery, {}),
  blake: readScopeWorkspaces(IDENTITIES.blake, {}),
};
const inScope = <T extends { workspaceId: string }>(rows: T[], scope: keyof typeof SCOPES) => rows.filter(row => SCOPES[scope].includes(row.workspaceId));
const TRIPLES = DENSE_TOKENS.flatMap((a, i) => DENSE_TOKENS.slice(i + 1).flatMap((b, j) => DENSE_TOKENS.slice(i + j + 2).map(c => [a, b, c] as const)));

const PINNED_COMMON = {
  "1k": { roadmap: { avery: 151, blake: 137, company: 134 }, standup: { avery: 165, blake: 149, company: 146 }, invoice: { avery: 161, blake: 146, company: 143 } },
  "5k": { roadmap: { avery: 1135, blake: 1032, company: 997 }, standup: { avery: 1098, blake: 998, company: 968 }, invoice: { avery: 1122, blake: 1026, company: 991 } },
  "20k": { roadmap: { avery: 1534, blake: 1386, company: 1349 }, standup: { avery: 1517, blake: 1369, company: 1319 }, invoice: { avery: 1499, blake: 1341, company: 1300 } },
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const df = (rows: { content: string }[], token: string) =>
  rows.filter(row => row.content.toLowerCase().includes(token)).length;
const duplicateShare = (rows: { content: string }[]) => {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.content, (counts.get(row.content) ?? 0) + 1);
  return [...counts.values()].filter(count => count > 1).reduce((sum, count) => sum + count, 0) / rows.length;
};

describe("generateHaystack", () => {
  it("maps an authored needle to the frozen clock and workspace", () => {
    expect(needleToEntry({ id: "n1", content: "Invented note", tags: ["fiction"], workspace: "outsider", ageDays: 2 })).toEqual({
      id: "n1", content: "Invented note", tags: ["fiction"], source: "api",
      createdAt: EVAL_NOW - 2 * DAY_MS, workspaceId: WORKSPACES.outsider, actorId: ACTORS.outsider,
    });
  });

  it("carries an authored needle importance onto the entry, and none when unauthored", () => {
    const row = { id: "n2", content: "Invented note", tags: [], workspace: "avery" as const, ageDays: 1 };
    expect(needleToEntry(row)).not.toHaveProperty("importanceScore");
    expect(needleToEntry({ ...row, importance: 4 }).importanceScore).toBe(4);
  });

  it("draws every haystack row an importance score of 1-5 with the seeded 2-3 skew, without shifting the text", () => {
    const rows = generateHaystack({ ...base, count: 4000 });
    const share = (score: number) => rows.filter(row => row.importanceScore === score).length / rows.length;
    expect(rows.every(row => Number.isInteger(row.importanceScore) && row.importanceScore! >= 1 && row.importanceScore! <= 5)).toBe(true);
    IMPORTANCE_WEIGHTS.forEach((weight, i) => expect(share(i + 1), `score ${i + 1}`).toBeCloseTo(weight, 1));
    expect(share(2) + share(3)).toBeGreaterThan(0.6);
    const mean = rows.reduce((sum, row) => sum + row.importanceScore!, 0) / rows.length;
    expect(mean).toBeGreaterThan(2.6);
    expect(mean).toBeLessThan(3.0);
    // its own stream: flat weights change the scores and nothing else
    const flat = generateHaystack({ ...base, count: 4000, importanceWeights: [1, 1, 1, 1, 1] });
    expect(flat.map(row => row.content)).toEqual(rows.map(row => row.content));
    expect(flat.map(row => row.importanceScore)).not.toEqual(rows.map(row => row.importanceScore));
  });

  it("produces byte-identical output for a seed with pinned digests", () => {
    const first = generateHaystack(base);
    const second = generateHaystack(base);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(digest(first)).toBe("64006eab4db1f3dfe6131d1327ec9e2de57a4f161339cf56c06ebd6688e2099b");
    expect(digest(generateHaystack({ ...base, seed: 8 }))).toBe("644d027c32e34c48f93875b5922d2a43063b6370faaf51412c2e41accc3a6bcf");
    expect(first).not.toEqual(generateHaystack({ ...base, seed: 8 }));
  });

  it("produces the same digest under different locale and timezone settings", () => {
    const original = { lang: process.env.LANG, tz: process.env.TZ };
    const expected = digest(generateHaystack(base));
    try {
      process.env.LANG = "ja_JP.UTF-8";
      process.env.TZ = "Asia/Tokyo";
      expect(digest(generateHaystack(base))).toBe(expected);
    } finally {
      if (original.lang === undefined) delete process.env.LANG;
      else process.env.LANG = original.lang;
      if (original.tz === undefined) delete process.env.TZ;
      else process.env.TZ = original.tz;
    }
  });

  it("produces unique ids, bounded timestamps, CJK and multi-chunk notes across workspaces", () => {
    const rows = generateHaystack({ ...base, count: 3000 });
    expect(rows).toHaveLength(3000);
    expect(new Set(rows.map(row => row.id)).size).toBe(3000);
    expect(rows.every(row => row.createdAt <= EVAL_NOW && row.createdAt > EVAL_NOW - 731 * DAY_MS)).toBe(true);
    expect(rows.filter(row => /[぀-ヿ㐀-鿿가-힯]/u.test(row.content)).length).toBeGreaterThan(150);
    expect(rows.filter(row => row.content.length > 1600).length).toBeGreaterThan(30);
    expect(rows.filter(row => row.content.length > 1000).every(row => row.content.length > 1600)).toBe(true);
    expect(rows.filter(row => row.workspaceId === WORKSPACES.avery).length).toBeGreaterThan(1200);
    expect(rows.filter(row => row.workspaceId === WORKSPACES.company).length).toBeGreaterThan(1200);
  });

  it("has no exact-duplicate rows at any scale, for the test and the real corpus parameters", () => {
    const rows = generateHaystack({ ...base, count: 20_000 });
    for (const count of [1000, 5000, 20_000]) expect(duplicateShare(rows.slice(0, count))).toBe(0);
    for (const config of REAL) expect(duplicateShare(realRows(config))).toBe(0);
  });

  it("gives ordinary words realistic document frequency, with many dense tokens beyond the three common ones", () => {
    const rows = generateHaystack({ ...base, count: 5000 });
    const dfs = new Map<string, number>();
    for (const row of rows) for (const word of new Set(row.content.toLowerCase().match(/[a-z]{4,}/g) ?? [])) dfs.set(word, (dfs.get(word) ?? 0) + 1);
    const dense = [...dfs.entries()].filter(([word, count]) => count >= 100 && !(COMMON_TOKENS as readonly string[]).includes(word));
    expect(dense.length).toBeGreaterThanOrEqual(100);
    for (const word of ["thing", "time", "work", "idea", "feel"]) expect(df(rows, word), word).toBeGreaterThan(100);
  });

  it("realizes the requested common rate and exceeds the keyword window in each readable scope", () => {
    const rows = generateHaystack({ ...base, count: 20_000 });
    const pinned = {
      1000: { roadmap: { avery: 168, blake: 154, company: 149 }, standup: { avery: 169, blake: 144, company: 140 }, invoice: { avery: 184, blake: 174, company: 169 } },
      5000: { roadmap: { avery: 862, blake: 783, company: 766 }, standup: { avery: 871, blake: 783, company: 757 }, invoice: { avery: 839, blake: 769, company: 744 } },
      20000: { roadmap: { avery: 3530, blake: 3206, company: 3121 }, standup: { avery: 3452, blake: 3111, company: 3012 }, invoice: { avery: 3376, blake: 3066, company: 2966 } },
    } as const;
    const scopes = {
      avery: readScopeWorkspaces(IDENTITIES.avery, {}),
      blake: readScopeWorkspaces(IDENTITIES.blake, {}),
      company: readScopeWorkspaces(IDENTITIES.blake, { layer: "company" }),
    };
    for (const token of COMMON_TOKENS) {
      const realized = df(rows, token) / rows.length;
      expect(realized).toBeGreaterThan(base.commonRate * 0.75);
      expect(realized).toBeLessThan(base.commonRate * 1.25);
      for (const count of [1000, 5000, 20_000] as const) {
        const prefix = rows.slice(0, count);
        const actual: Record<string, number> = {};
        for (const [viewer, workspaces] of Object.entries(scopes)) {
          const visible = prefix.filter(row => workspaces.includes(row.workspaceId));
          const countDf = df(visible, token);
          actual[viewer] = countDf;
          if (count === 1000) expect(countDf, `${token} ${viewer} at 1k`).toBeLessThan(500);
          else expect(countDf, `${token} ${viewer} at ${count}`).toBeGreaterThan(500);
        }
        expect(actual).toEqual(pinned[count][token]);
      }
    }
  }, 30_000);

  it("keeps every viewer and the company layer past the keyword window at the real corpus parameters (45/45/10 weights)", () => {
    // The 1.9x company boost lifts the company layer over 500 at 5k; the real weights and rates are pinned here.
    const pinned: Record<string, Record<string, Record<string, number>>> = PINNED_COMMON;
    const scopes = { ...SCOPES, company: readScopeWorkspaces(IDENTITIES.blake, { layer: "company" }) };
    for (const config of REAL) {
      const rows = realRows(config);
      for (const token of COMMON_TOKENS) {
        const actual: Record<string, number> = {};
        for (const [viewer, workspaces] of Object.entries(scopes)) {
          actual[viewer] = df(rows.filter(row => workspaces.includes(row.workspaceId)), token);
          if (config.scale === "1k") expect(actual[viewer], `${token} ${viewer} at 1k`).toBeLessThan(KEYWORD_CANDIDATE_LIMIT);
          else expect(actual[viewer], `${token} ${viewer} at ${config.scale}`).toBeGreaterThan(KEYWORD_CANDIDATE_LIMIT);
          // A rare+common two-term query must stay on FTS: the common token alone leaves room under the budget.
          expect(actual[viewer], `${token} ${viewer} rare+common headroom`).toBeLessThan(FTS_MATCH_BUDGET * 0.85);
        }
        expect(actual).toEqual(pinned[config.scale][token]);
      }
    }
  }, 30_000);

  it("carries at most two dense-tier words per row and no other word contains one", () => {
    for (const rows of [generateHaystack({ ...base, count: 20_000 }), ...REAL.map(config => realRows(config))]) {
      const words = new Set<string>();
      for (const row of rows) {
        const text = row.content.toLowerCase();
        expect(DENSE_TOKENS.filter(token => text.includes(token)).length).toBeLessThanOrEqual(2);
        for (const word of text.match(/\p{L}+/gu) ?? []) words.add(word);
      }
      for (const token of DENSE_TOKENS) {
        expect(words.has(token), token).toBe(true);
        expect([...words].filter(word => word !== token && word.includes(token)), token).toEqual([]);
        for (const other of DENSE_TOKENS) if (other !== token) expect(other.includes(token)).toBe(false);
      }
    }
  }, 30_000);

  it("declares no pool or template word that contains a dense word", () => {
    let source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "haystack.ts"), "utf8");
    source = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1").replace(/export const DENSE_TOKENS[^;]*;/, "");
    const words = new Set<string>();
    for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const text = (match[1] ?? match[2]).replace(/\$\{[^}]*\}/g, " ").toLowerCase();
      for (const word of text.match(/\p{L}+/gu) ?? []) words.add(word);
    }
    expect(words.size).toBeGreaterThan(500);
    for (const token of DENSE_TOKENS) expect([...words].filter(word => word.includes(token)), token).toEqual([]);
  });

  it("has enough dense words for the common-word category and keeps them below the saturation fraction", () => {
    const n = DENSE_TOKENS.length;
    expect(TRIPLES).toHaveLength((n * (n - 1) * (n - 2)) / 6);
    expect(TRIPLES.length).toBeGreaterThanOrEqual(40);
    // At most 2 dense words per row: a word's df cannot exceed 2/n of the rows; keep margin under the ceiling.
    expect(2 / n).toBeLessThanOrEqual(QUERY_SATURATION_FRACTION - 0.03);
  });

  // Each dense word must overflow the LIKE window (500) at 5k/20k yet a three-word query must stay under the
  // router's FTS budget, so the baseline uses FTS and the `like` ablation differs. 1k must never truncate.
  it("holds each dense word in the keyword band per scope and scale, with margin", () => {
    const configs = REAL.flatMap(config => [
      { config, rows: realRows(config), loose: false },
      { config, rows: realRows(config, config.total), loose: true },
      ...(config.scale === "1k" ? [] : [{ config, rows: realRows(config, undefined, config.seed + 2), loose: false }]),
    ]);
    for (const { config, rows, loose } of configs) {
      for (const scope of ["avery", "blake"] as const) {
        const visible = inScope(rows, scope);
        const counts = Object.fromEntries(DENSE_TOKENS.map(token => [token, df(visible, token)]));
        const label = `${scope} ${config.scale}${loose ? " (total)" : ""}`;
        for (const token of DENSE_TOKENS) {
          const count = counts[token];
          expect(count / visible.length, `${token} ${label} saturation`).toBeLessThan(QUERY_SATURATION_FRACTION - 0.05);
          if (config.scale === "1k") continue;
          expect(count, `${token} ${label}`).toBeGreaterThan(loose ? KEYWORD_CANDIDATE_LIMIT : KEYWORD_CANDIDATE_LIMIT * 1.08);
        }
        for (const [a, b, c] of TRIPLES) {
          const dfSum = counts[a] + counts[b] + counts[c];
          const union = visible.filter(row => row.content.includes(a) || row.content.includes(b) || row.content.includes(c)).length;
          if (config.scale === "1k") {
            // Room for the needles merged in later: the union of any three must stay well under the window.
            expect(union, `${a} ${b} ${c} ${label} union`).toBeLessThanOrEqual(KEYWORD_CANDIDATE_LIMIT * 0.7);
          } else {
            expect(dfSum, `${a} ${b} ${c} ${label} dfSum`).toBeLessThan(FTS_MATCH_BUDGET * (loose ? 0.95 : 0.975));
          }
        }
      }
    }
  }, 30_000);

  it("puts the 501st most recent row of any three-word union at most 300 days back at 5k and 20k", () => {
    // A gold older than that is outside LIKE's ORDER BY created_at DESC LIMIT 500 window (measured max ~250 days).
    for (const config of REAL.filter(item => item.scale !== "1k")) {
      const rows = realRows(config);
      for (const scope of ["avery", "blake"] as const) {
        const visible = inScope(rows, scope);
        for (const [a, b, c] of TRIPLES) {
          const times = visible.filter(row => row.content.includes(a) || row.content.includes(b) || row.content.includes(c)).map(row => row.createdAt).sort((x, y) => y - x);
          expect((EVAL_NOW - times[KEYWORD_CANDIDATE_LIMIT]) / DAY_MS, `${a} ${b} ${c} ${scope} ${config.scale}`).toBeLessThanOrEqual(300);
        }
      }
    }
  }, 30_000);
});

describe("correlated tier", () => {
  const withRate = (correlatedRate?: number) => generateHaystack({ ...base, count: 2000, correlatedRate });
  const carries = (content: string) => CORRELATED_TOKENS.filter(token => content.toLowerCase().includes(token));

  it("leaves every row byte-identical at rate 0 or when unset", () => {
    expect(withRate(0)).toEqual(withRate());
  });
  it("puts all three words together in about the requested share of rows, and never one or two alone", () => {
    const rows = withRate(0.2);
    const together = rows.filter(row => carries(row.content).length === CORRELATED_TOKENS.length);
    expect(rows.filter(row => [1, 2].includes(carries(row.content).length))).toEqual([]);
    expect(together.length / rows.length).toBeGreaterThan(0.17);
    expect(together.length / rows.length).toBeLessThan(0.23);
  });
  it("only appends to a row: the rest of the corpus is unchanged", () => {
    const plain = withRate();
    withRate(0.2).forEach((row, i) => expect(row.content.startsWith(plain[i].content.replace(/ Logged .*$/, ""))).toBe(true));
  });
});
