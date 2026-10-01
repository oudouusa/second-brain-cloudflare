import { describe, expect, it } from "vitest";
import {
  graphSeedCeiling,
  graphSeedLimit,
  lexicalSeedLimit,
  queryCoverage,
  relatedSlotLimit,
  scoreLinkedEvidence,
} from "../../src/recall/neighborhood";

describe("graph-aware recall neighborhood policy", () => {
  it("bounds the dense arm's graph seeds at its overfetch scale and the Vectorize ceiling", () => {
    expect(graphSeedLimit(5, 40)).toBe(15);
    expect(graphSeedLimit(20, 90)).toBe(48);
    expect(graphSeedLimit(5, 8)).toBe(8);
  });

  // T-0083.6: one budget over the fused pool let keyword-only rows outbid the bottom of
  // the dense fetch, because fusion pays a keyword hit its matched IDF and a dense hit
  // only 1/(k + rank). The arms are counted separately now.
  it("does not spend the dense arm's seats on rows the dense arm never returned", () => {
    // 40 dense rows and 400 keyword-only ones: the dense arm still seats its whole window.
    expect(graphSeedLimit(5, 40)).toBe(15);
    expect(lexicalSeedLimit(5, 400, 15)).toBe(5);
  });

  it("gives the keyword arm the lexical view's share of the dense window, not a matching budget", () => {
    expect(lexicalSeedLimit(5, 400, 15)).toBe(5);   // ceil(15 * 0.3)
    expect(lexicalSeedLimit(10, 400, 30)).toBe(9);  // ceil(30 * 0.3)
    expect(lexicalSeedLimit(5, 2, 15)).toBe(2);     // never more than exist
  });

  it("keeps both arms' seats under the edge-scan ceiling", () => {
    expect(graphSeedLimit(50, 200) + lexicalSeedLimit(50, 200, 50)).toBe(graphSeedCeiling(0));
    expect(lexicalSeedLimit(50, 200, 50)).toBe(0);
  });

  // Review finding 1: with the dense arm empty — Vectorize down, a member with no
  // vectors, the keyword-only ablation — every root is keyword-only, and an allowance
  // alone would seat 9 of them at topK 10 where the old shared budget seated 30.
  it("hands the keyword arm the dense window the dense arm leaves unused", () => {
    expect(lexicalSeedLimit(10, 400, 0)).toBe(39);  // 30 unused + ceil(30 * 0.3)
    expect(lexicalSeedLimit(5, 400, 0)).toBe(20);   // 15 unused + ceil(15 * 0.3)
  });

  it("gives back only the part of the window the dense arm did not fill", () => {
    expect(lexicalSeedLimit(10, 400, 30)).toBe(9);  // dense filled its window: allowance only
    expect(lexicalSeedLimit(10, 400, 20)).toBe(19); // 10 unused + 9
    expect(lexicalSeedLimit(10, 400, 29)).toBe(10); // 1 unused + 9
  });

  it("keeps the total the same whichever arm fills it", () => {
    for (const denseCount of [0, 1, 7, 29, 30, 400]) {
      const dense = graphSeedLimit(10, denseCount);
      expect(dense + lexicalSeedLimit(10, 400, dense)).toBe(39);
    }
  });

  // expandGraph binds each frontier id twice, and a scoped caller's bindings come out
  // of the same budget, so the ceiling is the edge scan's own batch size.
  it("sizes the seed ceiling from the bound-parameter budget the edge scan has left", () => {
    expect(graphSeedCeiling(0)).toBe(48);
    expect(graphSeedCeiling(2)).toBe(47);
    expect(graphSeedCeiling(3)).toBe(46);
  });

  it("keeps a scoped caller's seats inside one edge-scan statement", () => {
    for (const bindings of [0, 1, 2, 3, 5]) {
      const dense = graphSeedLimit(20, 200, bindings);
      expect(dense + lexicalSeedLimit(20, 200, dense, bindings)).toBeLessThanOrEqual(graphSeedCeiling(bindings));
    }
  });

  it("reserves no related slot for tiny result sets and at most two otherwise", () => {
    expect(relatedSlotLimit(1)).toBe(0);
    expect(relatedSlotLimit(2)).toBe(0);
    expect(relatedSlotLimit(3)).toBe(1);
    expect(relatedSlotLimit(5)).toBe(1);
    expect(relatedSlotLimit(6)).toBe(2);
    expect(relatedSlotLimit(20)).toBe(2);
  });
});

describe("deterministic linked-evidence scoring", () => {
  const base = {
    parentScore: 0.8,
    queryTokens: ["anniversary", "childcare"],
    evidenceTokens: ["anniversary", "childcare"],
    corpus: { df: null, total: null },
    hop: 1,
    edgeWeight: 1,
    provenance: "explicit" as const,
    hopDecay: 0.6,
    replacementCoverage: 0,
    intent: "direct" as const,
    edgeType: "relates_to" as const,
  };

  it("rejects an explicit continuation when only the root carries query context", () => {
    const result = scoreLinkedEvidence({
      ...base,
      parentContent: "We changed the anniversary plan because the trip was impractical",
      content: "Chateau Elan solved the sitter constraint",
    });

    expect(result.eligible).toBe(false);
    expect(result.score).toBe(0);
    expect(result.rejection).toBe("no-linked-evidence");
  });

  it("rejects an inferred neighbor that contributes no query evidence", () => {
    const result = scoreLinkedEvidence({
      ...base,
      parentContent: "Enterprise architecture review",
      content: "Unrelated grocery list",
      queryTokens: ["architecture", "review"],
      provenance: "inferred",
    });

    expect(result.eligible).toBe(false);
    expect(result.score).toBe(0);
    expect(result.rejection).toBe("no-linked-evidence");
  });

  it("ranks a rare linked term above an equally connected common-term match", () => {
    const corpus = {
      df: new Map([
        ["platform", 90],
        ["dotnet", 2],
      ]),
      total: 100,
    };
    const common = scoreLinkedEvidence({
      ...base,
      parentContent: "The platform backend changed",
      content: "The platform supports teams",
      queryTokens: ["platform", "dotnet"],
      evidenceTokens: ["platform", "dotnet"],
      corpus,
    });
    const rare = scoreLinkedEvidence({
      ...base,
      parentContent: "The platform backend changed",
      content: "Dotnet aligned with enterprise support",
      queryTokens: ["platform", "dotnet"],
      evidenceTokens: ["platform", "dotnet"],
      corpus,
    });

    expect(rare.eligible).toBe(true);
    expect(rare.score).toBeGreaterThan(common.score);
  });

  it("applies hop decay so otherwise equal one-hop evidence outranks two-hop evidence", () => {
    const oneHop = scoreLinkedEvidence({
      ...base,
      parentContent: "Anniversary plan",
      content: "Anniversary childcare constraint",
      hop: 1,
    });
    const twoHop = scoreLinkedEvidence({
      ...base,
      parentContent: "Anniversary plan",
      content: "Anniversary childcare constraint",
      hop: 2,
    });

    expect(oneHop.score).toBeGreaterThan(twoHop.score);
  });

  it("rejects a linked memory that matches only a common term", () => {
    const score = scoreLinkedEvidence({
      ...base,
      parentContent: "Enterprise platform review",
      content: "The platform home page was redesigned",
      queryTokens: ["platform", "ledger"],
      evidenceTokens: ["platform", "ledger"],
      corpus: { df: new Map([["platform", 90], ["ledger", 2]]), total: 100 },
      replacementCoverage: 0.2,
      intent: "causal",
      edgeType: "relates_to",
    });

    expect(score.eligible).toBe(false);
    expect(score.rejection).toBe("weak-neighborhood");
  });

  it("rejects linked evidence that only contains a query token as a substring", () => {
    const score = scoreLinkedEvidence({
      ...base,
      parentContent: "Ledger status changed",
      content: "The ledgering job completed",
      queryTokens: ["ledger", "status"],
      evidenceTokens: ["ledger", "status"],
      corpus: { df: new Map([["ledger", 90], ["status", 80]]), total: 100 },
      replacementCoverage: 0,
    });

    expect(score.eligible).toBe(false);
    expect(score.rejection).toBe("weak-neighborhood");
  });

  it("rejects a favorable one-token substring-only neighborhood", () => {
    const score = scoreLinkedEvidence({
      ...base,
      parentScore: 1,
      parentContent: "",
      content: "platforms",
      queryTokens: ["platform"],
      evidenceTokens: ["platform"],
      corpus: { df: new Map([["platform", 90]]), total: 100 },
      hop: 0,
      hopDecay: 1,
      edgeWeight: 1,
      intent: "causal",
      edgeType: "decided",
    });

    expect(score.eligible).toBe(false);
    expect(score.rejection).toBe("weak-neighborhood");
  });

  const qualifying = {
    ...base,
    parentContent: "The backend direction changed",
    content: "Dotnet matched enterprise support skills",
    queryTokens: ["backend", "dotnet"],
    evidenceTokens: ["backend", "dotnet"],
    corpus: { df: new Map([["backend", 30], ["dotnet", 2]]), total: 100 },
    intent: "causal" as const,
    edgeType: "decided" as const,
  };

  it("accepts complementary rare evidence through a compatible decision edge", () => {
    const score = scoreLinkedEvidence({ ...qualifying, replacementCoverage: 0.1 });

    expect(score.eligible).toBe(true);
    expect(score.coverageGain).toBeGreaterThan(0.1);
  });

  it("uses a directionally compatible explicit follows edge as chronology evidence", () => {
    const score = scoreLinkedEvidence({
      ...base,
      parentContent: "Worlddoc second brain check",
      content: "The dashboard repair completed successfully",
      queryTokens: ["worlddoc", "check"],
      evidenceTokens: ["worlddoc", "check"],
      replacementCoverage: 1,
      intent: "chronology",
      edgeType: "follows",
      edgeDirection: "incoming",
      queryDirection: "incoming",
    });

    expect(score.eligible).toBe(true);
    expect(score.score).toBeGreaterThanOrEqual(0.5);
  });

  it("does not use a structured edge when its direction is opposite to the question", () => {
    const score = scoreLinkedEvidence({
      ...base,
      parentContent: "Worlddoc second brain check",
      content: "The dashboard repair completed successfully",
      queryTokens: ["worlddoc", "check"],
      evidenceTokens: ["worlddoc", "check"],
      replacementCoverage: 1,
      intent: "chronology",
      edgeType: "follows",
      edgeDirection: "outgoing",
      queryDirection: "incoming",
    });

    expect(score.eligible).toBe(false);
    expect(score.rejection).toBe("no-linked-evidence");
  });

  it("does not treat an inferred edge as self-authenticating structured evidence", () => {
    const score = scoreLinkedEvidence({
      ...base,
      parentContent: "Worlddoc second brain check",
      content: "The dashboard repair completed successfully",
      queryTokens: ["worlddoc", "check"],
      evidenceTokens: ["worlddoc", "check"],
      provenance: "inferred",
      replacementCoverage: 1,
      intent: "chronology",
      edgeType: "follows",
      edgeDirection: "incoming",
      queryDirection: "incoming",
    });

    expect(score.eligible).toBe(false);
    expect(score.rejection).toBe("no-linked-evidence");
  });

  it("uses full-query tokens for complementary evidence without weakening the precision gate", () => {
    const score = scoreLinkedEvidence({
      ...base,
      parentScore: 0.4,
      parentContent: "Cobalt ownership moved",
      content: "Cobalt runtime switched teams",
      queryTokens: ["cobalt", "runtime", "vendor"],
      evidenceTokens: ["reason", "cobalt", "runtime", "ownership", "switched"],
      corpus: {
        df: new Map([
          ["reason", 90],
          ["cobalt", 90],
          ["runtime", 90],
          ["ownership", 90],
          ["switched", 90],
        ]),
        total: 100,
      },
      replacementCoverage: 0.6,
      intent: "causal",
      edgeType: "caused_by",
    });

    expect(score.eligible).toBe(true);
    expect(score.coverageGain).toBeCloseTo(0.4, 10);
  });

  it("still rejects weak generic evidence when the full-query channel is broader", () => {
    const score = scoreLinkedEvidence({
      ...base,
      parentScore: 0.2,
      parentContent: "Planning status marker",
      content: "Planning status overview",
      queryTokens: ["planning", "status", "allocation"],
      evidenceTokens: ["neighborhood", "allocation", "status", "planning", "review", "update", "summary", "notes"],
      corpus: { df: null, total: null },
      edgeWeight: 0.18,
      provenance: "system",
      replacementCoverage: 0,
    });

    expect(score.eligible).toBe(false);
    expect(score.rejection).toBe("weak-neighborhood");
  });

  it("does not combine query terms scattered across an unbounded linked memory", () => {
    const noise = "x".repeat(600);
    const score = scoreLinkedEvidence({
      ...base,
      parentScore: 1,
      parentContent: "root context",
      content: `alpha ${noise} beta ${noise} gamma`,
      queryTokens: ["alpha", "beta", "gamma"],
      evidenceTokens: ["alpha", "beta", "gamma"],
      corpus: { df: null, total: null },
      edgeWeight: 1,
      replacementCoverage: 0,
      intent: "causal",
      edgeType: "decided",
    });

    expect(score.eligible).toBe(false);
    expect(score.rejection).toBe("weak-neighborhood");
  });

  it("keeps localized linked evidence at the start of a long memory", () => {
    const content = `alpha beta ${"noise ".repeat(100)}`;
    const score = scoreLinkedEvidence({
      ...base,
      parentScore: 1,
      parentContent: "root context",
      content,
      queryTokens: ["alpha", "beta"],
      evidenceTokens: ["alpha", "beta"],
      corpus: { df: null, total: null },
      edgeWeight: 1,
      replacementCoverage: 0,
      intent: "causal",
      edgeType: "decided",
    });

    expect(content.length).toBeGreaterThan(400);
    expect(score.rejection).toBeUndefined();
    expect(score.eligible).toBe(true);
    expect(score.coverage).toBe(1);
  });

  it("keeps a late compatibility-form match as linked evidence", () => {
    const score = scoreLinkedEvidence({
      ...base,
      parentScore: 1,
      parentContent: "root context",
      content: `${"unrelated ".repeat(80)}設定 Ｃｌｏｕｄｆｌａｒｅ target`,
      queryTokens: ["cloudflare"],
      evidenceTokens: ["cloudflare"],
      corpus: { df: new Map([["cloudflare", 1]]), total: 100 },
      replacementCoverage: 0,
    });

    expect(score.eligible).toBe(true);
    expect(score.rejection).toBeUndefined();
  });

  it("abstains when the neighborhood does not improve on the replaced direct evidence", () => {
    const score = scoreLinkedEvidence({ ...qualifying, replacementCoverage: 1 });

    expect(score.eligible).toBe(false);
    expect(score.rejection).toBe("no-evidence-gain");
  });
});

describe("query coverage details", () => {
  it("requires literal underscore and percent matches", () => {
    const corpus = { df: new Map([["err_tls_90412", 1], ["50%_off", 1]]), total: 100 };
    const tokens = ["err_tls_90412", "50%_off"];
    expect(queryCoverage("ERR_TLS_90412 has 50%_off", tokens, corpus).score).toBe(1);
    expect(queryCoverage("ERRXTLSX90412 has 50Xoff", tokens, corpus).score).toBe(0);
  });

  it("labels only exact rare token matches as high-IDF", () => {
    const corpus = { df: new Map([["dotnet", 10]]), total: 100 };

    expect(queryCoverage("Dotnet supports the backend", ["dotnet"], corpus)).toEqual({
      score: 1,
      exactHighIdf: true,
    });
    expect(queryCoverage("adotnetservice", ["dotnet"], corpus)).toEqual({
      score: 0.25,
      exactHighIdf: false,
    });
  });

  it("matches a full-width surface using the canonical corpus token (#326 compatibility probe)", () => {
    const raw = "Ｔｅｒｒａｆｏｒｍ";
    const corpus = { df: new Map([["terraform", 5]]), total: 100 };

    const result = queryCoverage(`We standardized on ${raw} for infra`, ["terraform"], corpus);

    expect(result.score).toBe(1);
    expect(result.exactHighIdf).toBe(true);
  });
});
