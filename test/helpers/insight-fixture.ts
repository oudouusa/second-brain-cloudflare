/**
 * A small brain with known answers.
 *
 * The reference brain this feature was designed against is saturated with one
 * project, 97 days old, and 43% automated report exhaust — so it is the hardest
 * case for cross-topic connections and the easiest for recurring themes.
 * Tuning against it alone biases the pass toward one shape. This fixture is what
 * makes the pipeline evaluable without it.
 *
 * The assertion it supports is symmetric: every planted pair must surface, and
 * every decoy must not.
 */
import { vi } from "vitest";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "./make-env";
import { makeSqliteD1 } from "./sqlite-d1";

const DAY = 86400000;
export const FIXTURE_NOW = 400 * DAY;
const DIM = 384;

interface FixtureEntry {
  id: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: number;
  importance: number;
  vector: number[];
}

// --- Vector construction -----------------------------------------------
//
// An earlier version of this fixture built vectors as sin(seed + i * 0.001)
// for a hand-picked seed per entry, on the theory that seeds close together
// (1, 1.0005, ...) would cosine-cluster and seeds far apart (1 vs 2 vs 3)
// would not. Measured, that is false: any two seeds within about half a
// sine cycle of one another collapse to near-identical vectors regardless
// of how far apart the seeds are — cosine(near(1), near(2)) came out to
// 0.992, as high as the deliberately-planted contradiction pair itself.
// Every "unrelated topic" pair the fixture was supposed to keep apart
// (pricing vs onboarding, pricing vs support) was accidentally a neighbour
// of everything else in the 1-3 range, and the near-duplicate decoy could
// not be built at all: making it dissimilar enough to the entry it was
// supposed to fail against necessarily made it just as dissimilar to the
// entry it was supposed to succeed against, because those two were
// themselves cosine-indistinguishable. See task-9-report.md.
//
// This replaces it with topic clusters: each cluster is an independent
// random unit vector, and each cluster's members blend that shared
// direction with their own independent noise. In 384 dimensions,
// independently-drawn random unit vectors have cosine similarity
// clustered tightly around 0 (concentration of measure), so distinct
// clusters separate reliably without hand-tuning, and a member's
// similarity to its own cluster is controlled directly by `pull`.
//
// A second, narrower version of the same mistake showed up within the
// pricing cluster itself, after this fix: at the cluster default (0.92
// pull), plant-contradiction-old and plant-contradiction-new measured
// 0.9920 — so close that no third vector could be built similar to one and
// dissimilar to the other, which is exactly what decoy-recent needs (see
// its comment below). `PRICING_PULL` loosens that one cluster to ~0.87
// pairwise, leaving room underneath for the decoy without touching anything
// else. See task-9-report.md's second entry for the measured before/after.

/** FNV-1a, only so each label gets its own deterministic PRNG stream. */
function hashLabel(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small and dependency-free; the fixture only needs determinism. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normalize = (v: number[]): number[] => {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
};

/** A deterministic unit vector for a label — the same label always yields the same vector. */
const unit = (label: string): number[] => {
  const rand = mulberry32(hashLabel(label));
  return normalize(new Array(DIM).fill(0).map(() => rand() * 2 - 1));
};

/**
 * A member of a topic cluster: `pull` of the cluster's shared direction plus
 * `1 - pull` of the member's own independent noise, renormalised. Two
 * members of the same cluster at the default pull are close (~0.99) without
 * being identical.
 */
const clusterMember = (cluster: number[], label: string, pull = 0.92): number[] => {
  const noise = unit(label);
  return normalize(cluster.map((c, i) => c * pull + noise[i] * (1 - pull)));
};

/**
 * A near-duplicate of an already-built vector: `weight` of that vector plus
 * `1 - weight` of the label's own independent noise. Used for `decoy-recent`
 * below, which needs to be similarity-eligible against ONE specific entry
 * and not another — `clusterMember` can't express that, because every
 * member it builds is equally related to every other member of the same
 * cluster (they all share only the cluster direction, nothing pairwise).
 */
const similarTo = (vector: number[], label: string, weight: number): number[] => {
  const noise = unit(label);
  return normalize(vector.map((v, i) => v * weight + noise[i] * (1 - weight)));
};

const CLUSTER_PRICING = unit("cluster:pricing");
const CLUSTER_CONNECTION = unit("cluster:connection");
const CLUSTER_STATE = unit("cluster:state");

/**
 * How similar the core pricing-cluster entries (the two contradiction
 * entries, plus decoy-machine and decoy-mirror) are to one another —
 * measured ~0.87 pairwise, comfortably above MIN_SIMILARITY (0.82) with
 * headroom both above and below. Deliberately looser than the cluster
 * default (0.92 pull, ~0.99 pairwise): decoy-recent (below) needs to land
 * above the floor against ONE core member and below it against another, and
 * there is no room to do that when the two core members are themselves
 * cosine-indistinguishable — see task-9-report.md's second entry.
 */
const PRICING_PULL = 0.73;

// Every field has a default so a fixture entry states only what it is testing.
// The default content must clear MIN_INSIGHT_CONTENT_CHARS (80) from
// src/insight/eligibility.ts, or an entry that does not override it is silently
// ineligible and the fixture tests nothing. Count before shortening this.
const entry = (over: Partial<FixtureEntry> & { id: string }): FixtureEntry => ({
  content: "Placeholder fixture content, written long enough that it comfortably clears the eligibility floor used by the insight pass.",
  tags: ["pricing"],
  source: "claude-desktop",
  createdAt: FIXTURE_NOW,
  importance: 3,
  vector: clusterMember(CLUSTER_PRICING, "default"),
  ...over,
});

// Built once, by name, so decoy-recent (below) can be defined as a
// near-duplicate of this specific vector rather than of the pricing cluster
// in general.
const PLANT_CONTRADICTION_NEW_VECTOR = clusterMember(CLUSTER_PRICING, "plant-contradiction-new", PRICING_PULL);

export const PLANTED: FixtureEntry[] = [
  // contradiction — reversed decision, four months apart
  entry({
    id: "plant-contradiction-old",
    content: "Decision: price the first tier flat at $9 a month, because predictable billing is what small teams asked for.",
    createdAt: FIXTURE_NOW - 120 * DAY, tags: ["pricing"], importance: 4,
    vector: clusterMember(CLUSTER_PRICING, "plant-contradiction-old", PRICING_PULL),
  }),
  entry({
    id: "plant-contradiction-new",
    content: "Decision: move the first tier to usage-based billing. Flat pricing was leaving money on the table for heavy accounts.",
    createdAt: FIXTURE_NOW, tags: ["pricing"], importance: 4,
    vector: PLANT_CONTRADICTION_NEW_VECTOR,
  }),
  // connection — two topics never tagged together
  entry({
    id: "plant-connection-a",
    content: "Onboarding drop-off is worst at the credential step; people stall before they ever store a memory.",
    createdAt: FIXTURE_NOW - 95 * DAY, tags: ["onboarding"], importance: 4,
    vector: clusterMember(CLUSTER_CONNECTION, "plant-connection-a"),
  }),
  entry({
    id: "plant-connection-b",
    content: "Support volume is dominated by people who cannot get their token working on the first attempt.",
    createdAt: FIXTURE_NOW - 5 * DAY, tags: ["support"], importance: 4,
    vector: clusterMember(CLUSTER_CONNECTION, "plant-connection-b"),
  }),
];

export const DECOYS: FixtureEntry[] = [
  // successive measurements — similar, months apart, and worthless
  entry({
    id: "decoy-state-old",
    content: "Traffic snapshot: 1,462 clones and 485 unique cloners over the last fourteen days.",
    createdAt: FIXTURE_NOW - 100 * DAY, tags: ["metrics", "volatility:state"],
    vector: clusterMember(CLUSTER_STATE, "decoy-state-old"),
  }),
  entry({
    id: "decoy-state-new",
    content: "Traffic snapshot: 733 clones and 296 unique cloners over the last fourteen days.",
    createdAt: FIXTURE_NOW, tags: ["metrics", "volatility:state"],
    vector: clusterMember(CLUSTER_STATE, "decoy-state-new"),
  }),
  // machine-authored — must never be reasoned over
  entry({
    id: "decoy-machine",
    content: "[Synthesized from 34 entries tagged work] The project is being actively developed and promoted.",
    createdAt: FIXTURE_NOW - 60 * DAY, tags: ["synthesized", "work"], source: "system",
    // Deliberately still similarity-eligible (same pricing cluster) — the
    // point of this decoy is that the tag filter excludes it, not that it
    // was too dissimilar to reach the candidate stage in the first place.
    vector: clusterMember(CLUSTER_PRICING, "decoy-machine", PRICING_PULL),
  }),
  // integration-mirrored record
  entry({
    id: "decoy-mirror",
    content: "PR merged: chore(deps): bump the npm_and_yarn group across 2 directories with 3 updates.",
    createdAt: FIXTURE_NOW - 70 * DAY, tags: ["repo"], source: "git-hook",
    // Same reasoning as decoy-machine: similarity-eligible, excluded by source.
    vector: clusterMember(CLUSTER_PRICING, "decoy-mirror", PRICING_PULL),
  }),
  // near-duplicate written days apart, not months
  entry({
    id: "decoy-recent",
    content: "Decision: price the first tier flat at $9 a month for predictable billing on small teams.",
    createdAt: FIXTURE_NOW - 2 * DAY, tags: ["pricing"],
    // Built as a near-duplicate of plant-contradiction-new specifically
    // (weight 0.63), not of the pricing cluster in general — that is what
    // makes it similarity-eligible against ONE entry and not the other, the
    // asymmetry this decoy needs and clusterMember cannot express. Measured:
    // cosine 0.8552 against plant-contradiction-new (above MIN_SIMILARITY —
    // only the 2-day gap excludes that pairing) and 0.7473 against
    // plant-contradiction-old (below MIN_SIMILARITY — that pairing is
    // excluded by similarity; its 118-day gap alone would have cleared the
    // floor). Both exclusions fire, each for its own reason, never for the
    // other's. See task-9-report.md for the full pairwise matrix.
    vector: similarTo(PLANT_CONTRADICTION_NEW_VECTOR, "decoy-recent", 0.63),
  }),
];

export function makeInsightFixture() {
  const all = [...PLANTED, ...DECOYS];
  const byVectorId = new Map(all.map(e => [`vec-${e.id}`, e]));

  const vectorize = makeVectorizeMock({
    getByIds: vi.fn().mockImplementation(async (ids: string[]) =>
      ids.map(id => ({ id, values: byVectorId.get(id)?.vector })).filter(v => v.values),
    ),
    query: vi.fn().mockImplementation(async (values: number[]) => {
      const cosine = (a: number[], b: number[]) => {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        return na && nb ? dot / Math.sqrt(na * nb) : 0;
      };
      return {
        matches: all
          .map(e => ({
            id: `vec-${e.id}`,
            score: cosine(values, e.vector),
            metadata: {
              parentId: e.id, created_at: e.createdAt, tags: e.tags,
              content: e.content, source: e.source,
            },
          }))
          .sort((x, y) => y.score - x.score)
          .slice(0, 10),
      };
    }),
  });

  const sqlite = makeSqliteD1();
  for (const e of all) {
    sqlite.seed({
      id: e.id, content: e.content, createdAt: e.createdAt,
      tags: e.tags, source: e.source,
      vectorIds: [`vec-${e.id}`], importanceScore: e.importance,
    });
  }

  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as any, VECTORIZE: vectorize, OAUTH_KV: makeMemoryKV(),
  }));

  return {
    env, sqlite, all,
    planted: PLANTED.map(e => e.id),
    decoys: DECOYS.map(e => e.id),
    /** Every candidate pair accrual recorded, as `a_id|b_id` strings. */
    async pairs(): Promise<string[]> {
      const { results } = await sqlite.db.prepare(
        `SELECT a_id, b_id FROM insight_candidates ORDER BY score DESC`,
      ).all() as { results: { a_id: string; b_id: string }[] };
      return results.map(r => `${r.a_id}|${r.b_id}`);
    },
  };
}

/** 料金候補のseedと一致する原文引用。根拠の捏造・欠落は個別試験で別途検証する。 */
export function pricingInsight(text: string): string {
  return JSON.stringify({ insight: true, shape: "contradiction", text,
    evidence: {
      a: "flat at nine dollars a month",
      b: "usage-based billing",
    },
  });
}

export const PRICING_INSIGHTS: Record<string, string> = {
  "0": "月額9ドルの固定料金を採用していましたが、収益を取りこぼしていたため、利用量に応じた従量制へ切り替える判断に変更しています。",
  "1": "請求額の予測しやすさを重視する方針から、実際の使用量を収益に反映させる考え方へ移行することを決めています。",
  "2": "料金を一定に保つ以前の判断を改め、使われた分を課金する仕組みに変更することを決めています。",
};
