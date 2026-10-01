import { vi } from "vitest";
// 上流の固定corpusは候補窓500件向け。これはfixture自体の整合性試験でありforkの順位評価ではない。
vi.mock("../../../src/constants", async importOriginal => ({ ...await importOriginal<object>(), KEYWORD_CANDIDATE_LIMIT: 500 }));
import { describe, expect, it } from "vitest";
import { auditQueries, haystackVocabulary, keywordRouteModel, staleRouteGaps, type CorpusIntent } from "./audit";
import { ACTORS, DAY_MS, EVAL_NOW, WORKSPACES, type CorpusEdge, type CorpusEntry } from "./types";
import type { GoldenQuery } from "../types";

const entry = (id: string, content: string, workspace: keyof typeof WORKSPACES = "avery"): CorpusEntry => ({
  id, content, tags: [], source: "api", createdAt: EVAL_NOW,
  workspaceId: WORKSPACES[workspace], actorId: ACTORS.avery,
});
const query = (over: Partial<GoldenQuery> & Pick<GoldenQuery, "id" | "category" | "text">): GoldenQuery => ({
  gold: [{ id: "g", grade: 2 }], viewer: "avery", ...over,
});
// Small fixtures default to the tie intent (every union fits the LIKE window); scale fixtures pass "discriminate".
const rules = (entries: CorpusEntry[], queries: GoldenQuery[], edges: CorpusEdge[] = [], intent: CorpusIntent = "tie") =>
  auditQueries({ entries, edges, queries, intent }).map(finding => `${finding.queryId}:${finding.rule}`);
// Pairs only: no filler row holds the whole triple, so the gold stays the sole full match.
const pairText = (i: number) => ["garden window", "window coffee", "garden coffee"][i % 3];
const denseFiller = Array.from({ length: 40 }, (_, i) => entry(`d${i}`, `${pairText(i)} note ${i}`));
const dated = (id: string, content: string, ageDays: number, workspace: keyof typeof WORKSPACES = "avery"): CorpusEntry => ({ ...entry(id, content, workspace), createdAt: EVAL_NOW - ageDays * DAY_MS });
const filler = Array.from({ length: 40 }, (_, i) => entry(`f${i}`, `weekly review notes about budget planning number ${i}`));

describe("auditQueries", () => {
  it("requires the exact identifier in the query and gold, including token boundaries", () => {
    const gold = entry("g", "Invoice dispute INV-88213 was settled");
    expect(rules([...filler, gold], [query({ id: "ok", category: "identifier", text: "INV-88213" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "wrong", category: "identifier", text: "INV-99999" })])).toContain("wrong:identifier-not-in-gold");
    expect(rules([...filler, entry("g", "Invoice INV-88213X was settled")], [query({ id: "partial", category: "identifier", text: "INV-88213" })])).toContain("partial:identifier-not-in-gold");
    expect(rules([...filler, gold], [query({ id: "absent", category: "identifier", text: "invoice dispute" })])).toContain("absent:identifier-no-token");
    const repeats = Array.from({ length: 6 }, (_, i) => entry(`repeat-${i}`, `Another invoice INV-88213, copy ${i}`));
    expect(rules([...filler, gold, ...repeats], [query({ id: "flooded", category: "identifier", text: "INV-88213" })])).toContain("flooded:identifier-too-common");
    expect(rules([entry("g", "Invoice dispute INV-88213. settled")], [query({ id: "dot", category: "identifier", text: "INV-88213." })])).toEqual([]);
    for (const text of ["well-known", "decide.", "2027"]) {
      expect(rules([entry("g", text)], [query({ id: "ordinary", category: "identifier", text })])).toContain("ordinary:identifier-no-token");
    }
  });

  it("catches lexical leakage in paraphrases while accepting low-overlap wording", () => {
    const gold = entry("g", "The electrician upgraded the panel and replaced the breaker");
    const findings = rules([...filler, gold], [
      query({ id: "leaky", category: "paraphrase", text: "electrician panel breaker cost" }),
      query({ id: "clean", category: "paraphrase", text: "who fixed the wiring at home" }),
    ]);
    expect(findings).toContain("leaky:paraphrase-lexical-leak");
    expect(findings).not.toContain("clean:paraphrase-lexical-leak");
  });

  it("rejects one rare shared word in a paraphrase", () => {
    expect(rules([entry("g", "Quokka sighting on the harbor walk")], [
      query({ id: "quokka", category: "paraphrase", text: "quokka origin story" }),
    ])).toContain("quokka:paraphrase-lexical-leak");
  });

  it("rejects a paraphrase whose term occurs inside a gold word", () => {
    expect(rules([entry("g", "The electrician upgraded the panel")], [
      query({ id: "electric", category: "paraphrase", text: "electric fix cost" }),
    ])).toContain("electric:paraphrase-lexical-leak");
  });

  it("counts substrings when deciding whether a rare word floods the corpus", () => {
    const copies = Array.from({ length: 30 }, (_, i) => entry(`copy-${i}`, `Start the party smart cart ${i}`));
    expect(rules([entry("g", "art gallery visit"), ...copies], [
      query({ id: "art", category: "rare-word", text: "art" }),
    ])).toContain("art:rare-word-no-rare-token");
  });

  it("counts identifier prefixes in other rows for flooding, but requires a bounded identifier in gold", () => {
    const copies = Array.from({ length: 30 }, (_, i) => entry(`copy-${i}`, `Invoice INV-88213-${i} archived`));
    expect(rules([entry("g", "Invoice INV-88213 settled"), ...copies], [
      query({ id: "invoice", category: "identifier", text: "INV-88213" }),
    ])).toContain("invoice:identifier-too-common");
    expect(rules([entry("g", "Invoice INV-88213X settled")], [
      query({ id: "partial", category: "identifier", text: "INV-88213" }),
    ])).toContain("partial:identifier-not-in-gold");
  });

  it("matches Korean short words and detects Korean paraphrase leakage within a longer form", () => {
    const gold = entry("g", "민수와 예산에 대해 이야기했다");
    expect(rules([gold], [query({ id: "short-ko", category: "short-word", text: "민수" })])).toEqual([]);
    expect(rules([gold], [query({ id: "para-ko", category: "paraphrase", text: "민수 새 계획" })])).toContain("para-ko:paraphrase-lexical-leak");
  });

  it("checks rare, common, and short word category definitions", () => {
    const gold = entry("g", "budget review planning session zylophantine project v2");
    expect(rules([...filler, gold], [query({ id: "rare", category: "rare-word", text: "zylophantine" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "no-rare", category: "rare-word", text: "budget review" })])).toContain("no-rare:rare-word-no-rare-token");
    const dense = entry("g", "garden window coffee session zylophantine");
    expect(rules([...denseFiller, dense], [query({ id: "common", category: "common-word", text: "garden window coffee" })])).toEqual([]);
    expect(rules([...denseFiller, dense], [query({ id: "mixed", category: "common-word", text: "garden zylophantine" })])).toContain("mixed:common-word-rare-token");
    expect(rules([...denseFiller, dense], [query({ id: "missing", category: "common-word", text: "garden window kitchen" })])).toContain("missing:common-word-gold-missing-token");
    expect(rules([...filler, gold], [query({ id: "plain", category: "common-word", text: "budget review planning" })])).toContain("plain:common-word-not-dense");
    expect(rules([...filler, gold], [query({ id: "short", category: "short-word", text: "v2" })])).toEqual([]);
    expect(rules([...filler, gold], [query({ id: "long", category: "short-word", text: "project" })])).toContain("long:short-word-no-short-token");
  });

  it("rejects a common-word query that another readable entry also fully matches", () => {
    const gold = entry("g", "garden window coffee session");
    const ask = (entries: CorpusEntry[]) => rules(entries, [query({ id: "amb", category: "common-word", text: "garden window coffee" })]);
    expect(ask([...denseFiller, gold])).toEqual([]);
    expect(ask([...denseFiller, gold, entry("rival", "Notes on the coffee window and garden")])).toContain("amb:common-word-ambiguous");
    expect(ask([...denseFiller, gold, entry("rival", "GARDENS, windows and coffee")])).toContain("amb:common-word-ambiguous");
    // an unreadable rival does not make the query ambiguous
    expect(ask([...denseFiller, gold, entry("hidden", "garden window coffee", "blake")])).toEqual([]);
  });

  it("requires a rare-word or identifier key to occur in exactly one readable row, letting unreadable decoys repeat", () => {
    const rare = (extra: CorpusEntry[]) => rules([...filler, entry("g", "The petrichor after rain was lovely"), ...extra], [query({ id: "r", category: "rare-word", text: "petrichor" })]);
    expect(rare([])).toEqual([]);
    expect(rare([entry("twin", "Loved the petrichor smell", "company")])).toContain("r:key-not-unique");
    expect(rare([entry("decoy", "Another petrichor note", "blake")])).toEqual([]);
    const id = (extra: CorpusEntry[]) => rules([...filler, entry("g", "Ticket OPS-90210 rollback"), ...extra], [query({ id: "i", category: "identifier", text: "OPS-90210" })]);
    expect(id([entry("twin", "Also OPS-90210 was mentioned", "company")])).toContain("i:key-not-unique");
    expect(id([entry("decoy", "OPS-90210 elsewhere", "outsider")])).toEqual([]);
  });

  it("rejects missing, unreadable, or duplicated gold queries and missing tenancy decoys", () => {
    const gold = entry("g", "Ticket OPS-90210 rollback plan");
    const decoy = entry("d", "Ticket OPS-90210 rollback plan", "blake");
    const tenancy = query({ id: "tenant", category: "identifier", text: "OPS-90210", tags: ["tenancy"] });
    expect(rules([...filler, gold, decoy], [tenancy])).toEqual([]);
    expect(rules([...filler, gold], [tenancy])).toContain("tenant:tenancy-no-decoy");
    expect(rules([entry("g", "private thing xylo", "blake")], [query({ id: "leak", category: "rare-word", text: "xylo" })])).toContain("leak:gold-unreadable");
    expect(rules([], [query({ id: "gone", category: "rare-word", text: "xylo" })])).toContain("gone:gold-missing");
    expect(rules([gold], [tenancy, tenancy])).toContain("tenant:duplicate-id");
  });

  it("checks CJK text, multi-hop reachability, and long-context answer position", () => {
    const root = entry("root", "Meridian vendor decision was finalized after review");
    const gold = entry("g", "Because the audit found a gap, procurement chose a different supplier");
    const edge: CorpusEdge = { id: "e", sourceId: "root", targetId: "g", type: "caused_by", weight: 0.9, provenance: "explicit", workspaceId: WORKSPACES.avery };
    const multi = query({ id: "multi", category: "multi-hop", text: "Meridian vendor decision reason", hops: 1 });
    expect(rules([...filler, root, gold], [multi], [edge])).toEqual([]);
    expect(rules([...filler, root, gold], [multi])).toContain("multi:multi-hop-unreachable");
    expect(rules([...filler, root, gold], [{ ...multi, text: "Meridian vendor decision procurement supplier" }], [edge])).toContain("multi:multi-hop-lexical-leak");
    expect(rules([...filler, root, gold], [{ ...multi, hops: 2 }], [edge])).toContain("multi:multi-hop-needs-hops");
    expect(rules([...filler, entry("root", root.content, "blake"), gold], [multi], [edge])).toContain("multi:multi-hop-unreachable");
    expect(rules([...filler, gold], [query({ id: "cjk", category: "cjk", text: "来月の予算" })])).toContain("cjk:cjk-gold-not-cjk");
    expect(rules([entry("g", "来月の予算について話した")], [query({ id: "cjk-valid", category: "cjk", text: "来月の予算" })])).toEqual([]);
    expect(rules([entry("g", "来月の予算について話した")], [query({ id: "cjk-unlinked", category: "cjk", text: "採用計画" })])).toContain("cjk-unlinked:cjk-no-shared-substring");
    expect(rules([entry("g", "来月の予算について話した")], [query({ id: "cjk-one", category: "cjk", text: "budget 夢" })])).toContain("cjk-one:cjk-no-shared-substring");
    expect(rules([entry("g", "来月の予算について話した")], [query({ id: "xl", category: "cjk", text: "next month budget", tags: ["cross-lingual"] })])).toEqual([]);
    expect(rules([entry("g", "𠮷野家で食べた")], [query({ id: "cjk-ext", category: "cjk", text: "𠮷野家" })])).toEqual([]);
    expect(rules([entry("g", "﨑山で食べた")], [query({ id: "cjk-compat", category: "cjk", text: "﨑山" })])).toEqual([]);
    const long = entry("g", `${"Filler passage. ".repeat(120)}The answer is cobalt.`);
    expect(rules([long], [query({ id: "long", category: "long-context", text: "which color", answerSpan: "cobalt" })])).toEqual([]);
    expect(rules([entry("g", "The answer is cobalt.")], [query({ id: "short", category: "long-context", text: "which color", answerSpan: "cobalt" })])).toContain("short:long-context-single-chunk");
    expect(rules([entry("g", `The answer is cobalt. ${"Filler passage. ".repeat(120)}`)], [query({ id: "early", category: "long-context", text: "which color", answerSpan: "cobalt" })])).toContain("early:long-context-answer-in-first-chunk");
  });

  it("exposes deterministic haystack vocabulary for needle-key checks", () => {
    const vocabulary = haystackVocabulary();
    expect(vocabulary.has("roadmap")).toBe(true);
    expect(vocabulary.has("zylophantine")).toBe(false);
    for (const prefix of ["ops", "web", "app"]) {
      for (let number = 1000; number < 8000; number++) expect(vocabulary.has(`${prefix}-${number}`)).toBe(true);
    }
  }, 30_000);
});

describe("auditQueries fidelity and scale", () => {
  const gold = (content: string, workspace: keyof typeof WORKSPACES = "avery") => entry("g", content, workspace);
  const many = (count: number, content: (i: number) => string, workspace: keyof typeof WORKSPACES = "avery") =>
    Array.from({ length: count }, (_, i) => entry(`m${workspace}${i}`, content(i), workspace));

  it("does not let cross-lingual excuse CJK text or a shared Latin word", () => {
    const ja = gold("来月の予算について話した budget");
    expect(rules([ja], [query({ id: "cjk-in-xl", category: "cjk", text: "採用計画の見直し", tags: ["cross-lingual"] })])).toContain("cjk-in-xl:cross-lingual-has-cjk");
    expect(rules([ja], [query({ id: "leak", category: "cjk", text: "budget review", tags: ["cross-lingual"] })])).toContain("leak:cross-lingual-lexical-leak");
    expect(rules([ja], [query({ id: "ok", category: "cjk", text: "next month plan", tags: ["cross-lingual"] })])).toEqual([]);
  });

  it("checks CJK linkage on the tokens the arm searches, not on raw character pairs", () => {
    const ja = gold("来月の予算について話した");
    expect(rules([ja], [query({ id: "pair", category: "cjk", text: "月の予定" })])).toContain("pair:cjk-no-shared-substring");
    expect(rules([ja], [query({ id: "whole", category: "cjk", text: "来月の予算" })])).toEqual([]);
  });

  it("counts df over the rows the viewer can read", () => {
    const rows = [gold("garden window"), ...many(40, () => "garden window", "blake")];
    expect(rules(rows, [query({ id: "c", category: "common-word", text: "garden window" })])).toContain("c:common-word-rare-token");
    const decoys = many(6, () => "Ticket OPS-90210 rollback", "outsider");
    expect(rules([gold("Ticket OPS-90210 rollback"), ...decoys], [query({ id: "i", category: "identifier", text: "OPS-90210" })])).toEqual([]);
  });

  it("scales the paraphrase and common thresholds with the corpus", () => {
    const corpus = (total: number, dense: number) => [
      gold("zonkfrel appears in the answer garden window"),
      ...many(dense - 1, i => `zonkfrel filler note ${i} garden window`),
      ...many(total - dense, i => `plain unrelated note ${i}`),
    ];
    const para = query({ id: "p", category: "paraphrase", text: "zonkfrel origin story" });
    expect(rules(corpus(1000, 25), [para])).toEqual([]);
    expect(rules(corpus(5000, 30), [para])).toContain("p:paraphrase-lexical-leak");
    expect(rules(corpus(20_000, 300), [para])).toContain("p:paraphrase-lexical-leak");
    expect(rules(corpus(20_000, 500), [para])).toEqual([]);
    const common = query({ id: "c", category: "common-word", text: "garden window" });
    expect(rules(corpus(5000, 30), [common])).toContain("c:common-word-rare-token");
  });

  it("declares the outsider decoys-only and fails closed on unknown tags", () => {
    const decoyGold = gold("secret OPS-90210 plan", "outsider");
    const own = query({ id: "o", category: "identifier", text: "OPS-90210", viewer: "outsider" });
    expect(rules([decoyGold], [own])).toContain("o:outsider-not-tenancy");
    expect(rules([decoyGold, entry("d", "secret OPS-90210 plan")], [{ ...own, tags: ["tenancy"] }])).toEqual([]);
    expect(rules([gold("hello world")], [query({ id: "t", category: "paraphrase", text: "greeting", tags: ["tenency"] })])).toContain("t:unknown-tag");
  });

  it("requires a key token for tenancy queries instead of guessing one", () => {
    expect(rules([gold("hello world")], [query({ id: "t", category: "paraphrase", text: "greeting", tags: ["tenancy"] })])).toContain("t:tenancy-no-key-token");
  });

  it("keeps trailing punctuation the way production tokenizes it", () => {
    const g = gold("roadmap review scheduled");
    expect(rules([...filler, g], [query({ id: "dots", category: "common-word", text: "roadmap. review." })])).toContain("dots:common-word-gold-missing-token");
  });

  it("keeps common-word queries on the default read scope of a non-outsider viewer", () => {
    const g = gold("garden window coffee notes");
    const q = query({ id: "c", category: "common-word", text: "garden window coffee" });
    expect(rules([...denseFiller, g], [q])).toEqual([]);
    expect(rules([...denseFiller, g], [{ ...q, layer: "company" }])).toContain("c:common-word-layer-scoped");
    expect(rules([...denseFiller, g], [{ ...q, viewer: "outsider" }])).toContain("c:common-word-layer-scoped");
  });

  it("audits an underscore identifier like any other, with no waiver (T-0072 is fixed)", () => {
    const gold = entry("g", "Uploads failed with ERR_QUOTA_77120 after the bucket filled up");
    const q = (over: Partial<GoldenQuery> = {}) => query({ id: "u", category: "identifier", text: "ERR_QUOTA_77120", ...over });
    // production keeps "_" in the token, so the key matches the gold as written
    expect(rules([...filler, gold], [q()])).toEqual([]);
    // a key the gold lacks fails, tagged or not: no tag waives identifier-not-in-gold
    for (const tags of [undefined, ["known-gap", "gap:T-0073"], ["known-gap", "gap:T-0072"]]) {
      expect(rules([...filler, gold], [q({ text: "ERR_QUOTA_99999", ...(tags ? { tags } : {}) })]), String(tags)).toContain("u:identifier-not-in-gold");
    }
    // stripped in the gold, kept in the query: the pre-fix waiver case now fails
    expect(rules([...filler, entry("g", "Uploads failed with ERRQUOTA77120")], [q({ tags: ["known-gap", "gap:T-0073"] })])).toContain("u:identifier-not-in-gold");
    expect(rules([...filler, gold], [q({ text: "err_quota" })])).toContain("u:identifier-no-token");
    expect(rules([...filler, entry("g", gold.content, "blake")], [q()])).toContain("u:gold-unreadable");
  });

  it("keeps the known-gap machinery: a gap tag needs a reference, and waives no other rule", () => {
    const gold = entry("g", "Uploads failed with ERR_QUOTA_77120 after the bucket filled up");
    const q = (over: Partial<GoldenQuery> = {}) => query({ id: "u", category: "identifier", text: "ERR_QUOTA_77120", ...over });
    const gap = ["known-gap", "gap:T-0073"];
    // a well-formed gap on a query the audit otherwise accepts is allowed
    expect(rules([...filler, gold], [q({ tags: gap })])).toEqual([]);
    expect(rules([...filler, gold], [q({ tags: ["known-gap", "gap:T-15"] })])).toEqual([]);
    // the tag does not excuse an unreadable gold, a digitless key, or a key that is too common
    expect(rules([...filler, entry("g", gold.content, "blake")], [q({ tags: gap })])).toContain("u:gold-unreadable");
    expect(rules([...filler, gold], [q({ text: "err_quota", tags: gap })])).toContain("u:identifier-no-token");
    const flood = Array.from({ length: 6 }, (_, i) => entry(`x${i}`, `copy ERRQUOTA77120 ${i}`));
    expect(rules([...filler, entry("g", "ERRQUOTA77120 seen"), ...flood], [q({ text: "ERRQUOTA77120", tags: gap })])).toContain("u:identifier-too-common");
    // gap tags must be well-formed and paired
    expect(rules([...filler, gold], [q({ tags: ["known-gap"] })])).toContain("u:known-gap-no-ref");
    expect(rules([...filler, gold], [q({ tags: ["known-gap", "gap:T-0073", "gap:oops"] })])).toContain("u:unknown-tag");
    expect(rules([...filler, gold], [q({ tags: ["gap:T-0073"] })])).toContain("u:gap-ref-without-known-gap");
    expect(rules([...filler, gold], [q({ tags: ["gap"] })])).toContain("u:unknown-tag");
  });

  describe("common-word recency (LIKE keeps the 500 newest matching rows)", () => {
    const q = query({ id: "r", category: "common-word", text: "garden window coffee" });
    const corpus = (matching: number, goldAge: number, total: number) => [
      dated("g", "garden window coffee reunion", goldAge),
      ...Array.from({ length: matching }, (_, i) => dated(`m${i}`, `${pairText(i)} note ${i}`, 1 + (i % 100))),
      ...Array.from({ length: total - matching - 1 }, (_, i) => dated(`p${i}`, `plain note ${i}`, 1 + (i % 100))),
    ];

    const disc = (entries: CorpusEntry[]) => rules(entries, [q], [], "discriminate");

    it("needs the gold outside the newest 500 matching rows once the union overflows the window", () => {
      expect(disc(corpus(800, 300, 3000))).toEqual([]);
      expect(disc(corpus(800, 0.5, 3000))).toContain("r:common-word-gold-in-window");
    });

    it("never asks for recency when the union fits the window, since LIKE cannot truncate it", () => {
      // 3,000 entries with a 270-row union: the old size-keyed rule demanded an unsatisfiable gold-in-window
      const small = corpus(269, 300, 3000);
      expect(disc(small)).not.toContain("r:common-word-gold-in-window");
      expect(disc(small)).toContain("r:common-word-union-under-window");
      expect(rules(small, [q])).toEqual([]);
      expect(disc(corpus(400, 300, 3000))).toEqual(["r:common-word-union-under-window"]);
    });

    it("keys the intent off the corpus, not its size", () => {
      // tie: the union must stay inside the window, however many entries there are
      expect(rules(corpus(300, 300, 1000), [q])).toEqual([]);
      expect(rules(corpus(600, 300, 1000), [q])).toContain("r:common-word-union-truncates");
      expect(rules(corpus(600, 300, 3000), [q])).toContain("r:common-word-union-truncates");
      // discriminate: an overflowing union is required even in a 1,000-entry corpus
      expect(rules(corpus(600, 300, 1000), [q], [], "discriminate")).toEqual([]);
      expect(rules(corpus(300, 300, 1000), [q], [], "discriminate")).toContain("r:common-word-union-under-window");
    });

    it("counts the union within the viewer's scope only", () => {
      // avery reads 400 matching rows; the 800 in blake's workspace do not count toward her union
      const rows = [...corpus(400, 300, 3000), ...Array.from({ length: 800 }, (_, i) => dated(`b${i}`, `${pairText(i)} note ${i}`, 1 + (i % 100), "blake"))];
      expect(disc(rows)).toContain("r:common-word-union-under-window");
    });
  });

  describe("keyword route gaps (only the LIKE routes that remain can lose an old gold at scale)", () => {
    const gap73 = ["known-gap", "gap:T-0073"];
    const gap74 = ["known-gap", "gap:T-0074"];
    const scale = (entries: CorpusEntry[], queries: GoldenQuery[]) => rules(entries, queries, [], "discriminate");
    // pair rows put each dense word in ~2/3 of pairRows, roadmap rows add the common token
    const corpus = (pairRows: number, roadmapRows: number) => [
      dated("g", "garden window coffee roadmap reunion", 300),
      ...Array.from({ length: pairRows }, (_, i) => dated(`m${i}`, `${pairText(i)} note ${i}`, 1 + (i % 100))),
      ...Array.from({ length: roadmapRows }, (_, i) => dated(`r${i}`, `roadmap note ${i}`, 1 + (i % 100))),
      ...Array.from({ length: 3000 - 1 - pairRows - roadmapRows }, (_, i) => dated(`p${i}`, `plain note ${i}`, 1 + (i % 100))),
    ];
    const budget = (over: Partial<GoldenQuery> = {}) => query({ id: "b", category: "common-word", text: "garden window coffee roadmap", tags: ["over-budget"], ...over });
    // "io" sits inside every "ratio" row, so a query of short tokens only has the recency window to lean on
    const ineligible = (entries = 800) => [
      dated("g", "io id scheduler notes", 300),
      ...Array.from({ length: entries }, (_, i) => dated(`i${i}`, `ratio note ${i}`, 1 + (i % 100))),
      ...Array.from({ length: 3000 - 1 - entries }, (_, i) => dated(`p${i}`, `plain note ${i}`, 1 + (i % 100))),
    ];
    const short = (over: Partial<GoldenQuery> = {}) => query({ id: "s", category: "short-word", text: "io scheduler", ...over });
    const allShort = (over: Partial<GoldenQuery> = {}) => query({ id: "a", category: "short-word", text: "io id", ...over });
    // a lone eligible token that alone passes the budget, beside a short one
    const lone = (rows = 2500) => [
      dated("g", "garden io notes", 300),
      ...Array.from({ length: rows }, (_, i) => dated(`w${i}`, `garden note ${i}`, 1 + (i % 100))),
      ...Array.from({ length: 3000 - 1 - rows }, (_, i) => dated(`p${i}`, `plain note ${i}`, 1 + (i % 100))),
    ];
    const loneQuery = (over: Partial<GoldenQuery> = {}) => query({ id: "l", category: "short-word", text: "garden io", ...over });

    it("owes no tag for a query the bounded plan serves, however far past the budget", () => {
      expect(scale(corpus(800, 600), [budget()])).toEqual([]);
      expect(scale(corpus(800, 600), [budget({ tags: [] })])).not.toContain("b:keyword-route-unflagged-gap");
      expect(keywordRouteModel("garden window coffee roadmap", corpus(800, 600).map(entry => ({ entry, content: entry.content.toLowerCase() })), 0).route).toBe("fts-bounded");
    });

    it("requires T-0073 only where a lone eligible token past the budget still sends the query to LIKE", () => {
      expect(scale(lone(), [loneQuery()])).toContain("l:keyword-route-unflagged-gap");
      expect(scale(lone(), [loneQuery({ tags: gap73 })])).toEqual([]);
      expect(scale(lone(), [loneQuery({ tags: gap74 })])).toContain("l:keyword-route-unflagged-gap");
      // under budget the route is FTS, so nothing is owed
      expect(scale(lone(1500), [loneQuery()])).not.toContain("l:keyword-route-unflagged-gap");
    });

    it("owes no T-0074 tag to a query whose short token has an eligible one to retrieve with", () => {
      expect(scale(ineligible(), [short()])).toEqual([]);
      expect(keywordRouteModel("io scheduler", ineligible().map(entry => ({ entry, content: entry.content.toLowerCase() })), 0).route).toBe("fts");
    });

    it("requires T-0074 on a query made only of short tokens that LIKE loses", () => {
      expect(scale(ineligible(), [allShort()])).toContain("a:keyword-route-unflagged-gap");
      expect(scale(ineligible(), [allShort({ tags: gap74 })])).toEqual([]);
      expect(scale(ineligible(), [allShort({ tags: gap73 })])).toContain("a:keyword-route-unflagged-gap");
      // a gold inside the LIKE window is not lost, so no tag is owed
      expect(scale(ineligible(300), [allShort()])).not.toContain("a:keyword-route-unflagged-gap");
    });

    it("leaves non-lexical categories alone: a keyword loss there is by design", () => {
      const para = query({ id: "p", category: "paraphrase", text: "io id" });
      expect(scale(ineligible(), [para])).not.toContain("p:keyword-route-unflagged-gap");
    });

    it("demands the tie scale lose nothing", () => {
      expect(rules(ineligible(), [allShort({ tags: gap74 })])).toContain("a:route-gap-unanswerable-at-tie");
      expect(rules(ineligible(300), [allShort()])).toEqual([]);
    });

    it("flags a route gap tag that no discriminating scale earns, across scales", () => {
      const corpora = (rows: CorpusEntry[], q: GoldenQuery) => [{ entries: rows, queries: [q], intent: "discriminate" as const }, { entries: rows, queries: [q], intent: "tie" as const }];
      const tagged = allShort({ tags: gap74 });
      expect(staleRouteGaps(corpora(ineligible(), tagged))).toEqual([]);
      expect(staleRouteGaps(corpora(ineligible(300), tagged)).map(f => f.rule)).toEqual(["gap-not-reached"]);
      // T-0073 on a query whose route is the short-token one is not reached either
      const wrong = [{ entries: ineligible(), queries: [allShort({ tags: gap73 })], intent: "discriminate" as const }];
      expect(staleRouteGaps(wrong).map(f => f.rule)).toEqual(["gap-not-reached"]);
      // a tag on a query the index now serves is stale everywhere
      const fixed = [{ entries: corpus(800, 600), queries: [budget({ tags: gap73 })], intent: "discriminate" as const }];
      expect(staleRouteGaps(fixed).map(f => f.rule)).toEqual(["gap-not-reached"]);
      // reached at a larger scale is enough: the small corpus alone would not earn it
      const both = [{ entries: ineligible(300), queries: [tagged], intent: "discriminate" as const }, { entries: ineligible(), queries: [tagged], intent: "discriminate" as const }];
      expect(staleRouteGaps(both)).toEqual([]);
    });

    it("keeps an ordinary common-word query under the budget, and waives common-word-not-dense only for over-budget queries and the three common tokens", () => {
      const ordinary = query({ id: "o", category: "common-word", text: "garden window coffee" });
      expect(scale(corpus(1500, 0), [ordinary])).toContain("o:common-word-over-fts-budget");
      expect(scale(corpus(800, 0), [ordinary])).toEqual([]);
      expect(scale(corpus(800, 600), [budget({ tags: [] })])).toContain("b:common-word-not-dense");
      expect(scale(corpus(800, 600), [budget({ tags: [] })])).toContain("b:common-word-over-fts-budget");
      expect(scale(corpus(800, 600), [budget({ text: "garden window coffee budget" })])).toContain("b:common-word-not-dense");
      // an over-budget tag must be earned: the union has to cross the budget
      expect(scale(corpus(800, 100), [budget()])).toContain("b:over-budget-under-budget");
      expect(scale(corpus(800, 600), [query({ id: "i", category: "identifier", text: "garden", tags: ["over-budget"] })])).toContain("i:over-budget-not-common-word");
    });

    it("flags the review probe: three words at df 901 each (dfSum 2703) on an ordinary query", () => {
      const rows = [
        dated("g", "garden window coffee reunion", 300),
        ...["garden", "window", "coffee"].flatMap(word => Array.from({ length: 900 }, (_, i) => dated(`${word}${i}`, `${word} note ${i}`, 1 + (i % 100)))),
        ...Array.from({ length: 299 }, (_, i) => dated(`p${i}`, `plain note ${i}`, 1 + (i % 100))),
      ];
      const found = auditQueries({ entries: rows, edges: [], queries: [query({ id: "probe", category: "common-word", text: "garden window coffee" })], intent: "discriminate" });
      expect(found.filter(f => f.rule === "common-word-over-fts-budget").map(f => f.detail)).toEqual(["dfSum=2703"]);
      // the bounded plan serves it, so the keyword route is no longer a gap to board
      expect(found.map(f => f.rule)).not.toContain("keyword-route-unflagged-gap");
    });

    it("no longer accepts the retired router-budget tag", () => {
      expect(scale(corpus(800, 600), [budget({ tags: ["router-budget", "over-budget"] })])).toContain("b:unknown-tag");
    });
  });

  describe("correlated guard (prices the bounded plan's AND tier)", () => {
    const rows = (together: number) => [
      dated("g", "trellis compost seedling notes", 5),
      ...Array.from({ length: together }, (_, i) => dated(`t${i}`, `trellis compost seedling row ${i}`, 1 + (i % 100))),
      ...Array.from({ length: 3000 - 1 - together }, (_, i) => dated(`p${i}`, `plain note ${i}`, 1 + (i % 100))),
    ];
    const guard = (over: Partial<GoldenQuery> = {}) => query({ id: "c", category: "common-word", text: "trellis compost seedling", tags: ["over-budget", "correlated"], ...over });
    const scale = (entries: CorpusEntry[], queries: GoldenQuery[]) => rules(entries, queries, [], "discriminate");

    it("accepts three co-occurring words past both the window and the budget, and skips the dense-triple rules", () => {
      expect(scale(rows(700), [guard()])).toEqual([]);
    });
    it("requires the AND to overflow the window at a discriminating scale, or the guard prices nothing", () => {
      expect(scale(rows(300), [guard()])).toContain("c:correlated-and-under-window");
    });
    it("requires the budget to be crossed, the over-budget tag, and the correlated tokens", () => {
      expect(scale(rows(600), [guard()])).toContain("c:over-budget-under-budget");
      expect(scale(rows(700), [guard({ tags: ["correlated"] })])).toContain("c:correlated-not-over-budget");
      expect(scale(rows(700), [guard({ text: "garden window coffee" })])).toContain("c:correlated-wrong-tokens");
    });
  });

  describe("subset guard (covers the bounded plan's OR tier)", () => {
    // gold carries only "garden" (df 601); roadmap, standup and invoice are past the candidate limit too
    const rows = (mid: number) => [
      dated("g", "repotted the garden ferns", 400),
      ...Array.from({ length: mid }, (_, i) => dated(`m${i}`, `garden note ${i}`, 1 + (i % 100))),
      ...["roadmap", "standup", "invoice"].flatMap(word => Array.from({ length: 700 }, (_, i) => dated(`${word}${i}`, `${word} note ${i}`, 1 + (i % 100)))),
      ...Array.from({ length: 800 }, (_, i) => dated(`p${i}`, `plain note ${i}`, 1 + (i % 100))),
    ];
    const guard = (over: Partial<GoldenQuery> = {}) => query({ id: "s", category: "common-word", text: "roadmap standup invoice garden", tags: ["over-budget", "subset"], ...over });
    const scale = (entries: CorpusEntry[], queries: GoldenQuery[]) => rules(entries, queries, [], "discriminate");

    it("accepts a gold that carries a strict, mid-df subset of an over-budget query, and skips the all-tokens rules", () => {
      expect(scale(rows(600), [guard()])).toEqual([]);
    });
    it("requires the carried token's df to sit above the candidate limit and within the match budget", () => {
      expect(scale(rows(300), [guard()])).toContain("s:subset-token-not-mid-df");
      expect(scale(rows(2100), [guard()])).toContain("s:subset-token-not-mid-df");
    });
    it("waives only the all-tokens rule: a subset guard with rivals, or a gold inside the window, is still refused", () => {
      // rivals: non-gold rows carrying every token make the answer ambiguous
      const rivals = [...rows(600), dated("rv", "roadmap standup invoice garden all together", 5)];
      expect(scale(rivals, [guard()])).toContain("s:common-word-ambiguous");
      // a one-token-carried gold with rivals carrying both tokens
      const two = [dated("g", "repotted the garden ferns", 400), ...Array.from({ length: 700 }, (_, i) => dated(`b${i}`, `roadmap garden note ${i}`, 1 + (i % 100))), ...Array.from({ length: 800 }, (_, i) => dated(`p${i}`, `plain note ${i}`, 1 + (i % 100)))];
      expect(scale(two, [guard({ text: "roadmap garden" })])).toContain("s:common-word-ambiguous");
      // a gold newer than the window edge is found by LIKE anyway
      const recent = rows(600).map(entry => (entry.id === "g" ? { ...entry, createdAt: EVAL_NOW - DAY_MS } : entry));
      expect(scale(recent, [guard()])).toContain("s:common-word-gold-in-window");
      // layer-scoped and non-dense token rules still hold
      expect(scale(rows(600), [guard({ layer: "company" })])).toContain("s:common-word-layer-scoped");
      expect(scale(rows(600), [guard({ text: "roadmap standup invoice garden zebra" })])).toContain("s:common-word-not-dense");
    });
    it("requires a strict subset, and the over-budget tag", () => {
      expect(scale(rows(600), [guard({ text: "garden" })])).toContain("s:subset-not-strict");
      expect(scale(rows(600), [guard({ tags: ["subset"] })])).toContain("s:subset-not-over-budget");
    });
  });

  it("flags a Latin token that answers a CJK query", () => {
    const mixed = gold("来月の予算について話した budget review");
    expect(rules([mixed], [query({ id: "latin", category: "cjk", text: "budget 採用計画" })])).toContain("latin:cjk-no-shared-substring");
  });
});
