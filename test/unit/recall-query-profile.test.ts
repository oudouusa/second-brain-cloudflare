import { describe, expect, it } from "vitest";
import {
  buildQueryProfile,
  edgeIntentCompatibility,
  embeddingInput,
} from "../../src/recall/query-profile";

describe("recall query profile", () => {
  it.each([
    ["why did the backend change", "causal"],
    ["なぜバックエンドを変更したのか", "causal"],
    ["what happened before the launch", "chronology"],
    ["リリース後の経緯を確認したい", "chronology"],
    ["what is the current archive direction", "current"],
    ["現時点のアーカイブ方針", "current"],
    ["latest current state of deployment history and rollover", "current"],
    ["現在の更新履歴と運用状態", "current"],
    ["latest history after the deployment", "chronology"],
    ["現在から見てリリース前の経緯", "chronology"],
    ["最新の採用状況を確認したい", "current"],
    ["現状の採用状況を確認したい", "current"],
    ["今の本番構成はどうなっているか", "current"],
    ["今後の運用計画", "chronology"],
    ["what is the latest adopted release", "current"],
    ["what changed before the current release", "chronology"],
    ["現在の版より前の判断を確認したい", "chronology"],
    ["直近の本番反映で採用した版を確認したい", "current"],
    ["what is the current choice for the deployment", "current"],
    ["why did we change the current deployment", "causal"],
    ["最新の構成を採用した理由", "causal"],
    ["quartz archive architecture", "direct"],
  ] as const)("classifies %s", (query, intent) => {
    expect(buildQueryProfile(query, { query: "backend platform", df: null, total: null }).intent).toBe(intent);
  });

  it.each([
    ["why did the backend change", "outgoing"],
    ["what happened after the launch", "incoming"],
    ["what happened before the launch", "outgoing"],
    ["リリース後に何が起きたか", "incoming"],
    ["リリース前の決定", "outgoing"],
    ["変更の経緯", "either"],
    ["quartz archive architecture", "either"],
  ] as const)("derives graph direction for %s", (query, graphDirection) => {
    expect(buildQueryProfile(query, { query, df: null, total: null }).graphDirection).toBe(graphDirection);
  });

  it("keeps semantic and lexical representations separate", () => {
    const profile = buildQueryProfile(
      "why did we change the quartz ledger direction",
      { query: "quartz ledger", df: null, total: null },
    );
    expect(profile.semanticQuery).toBe("why did we change the quartz ledger direction");
    expect(profile.lexicalQuery).toBe("quartz ledger");
    expect(profile.evidenceTokens).toEqual(["change", "quartz", "ledger", "direction"]);
    expect(embeddingInput(profile, "distilled")).toBe("quartz ledger");
    expect(embeddingInput(profile, "semantic")).toBe(profile.semanticQuery);
    expect(embeddingInput(profile, "hybrid")).toBe(
      "why did we change the quartz ledger direction quartz ledger",
    );
  });

  it("bounds full cleaned-query evidence tokens deterministically", () => {
    const query = Array.from({ length: 20 }, (_, index) => `signal${index}`).join(" ");
    const tokens = buildQueryProfile(
      query,
      { query: "signal19 signal18 signal17", df: null, total: null },
    ).evidenceTokens;

    expect(tokens).toHaveLength(16);
    expect(tokens).toEqual([...tokens].sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))));
    expect(tokens).toContain("signal0");
    expect(tokens).toContain("signal19");
    expect(tokens).not.toEqual(Array.from({ length: 16 }, (_, index) => `signal${index}`));
  });

  it("keeps distilled terms first and adds rarer full-query anchors", () => {
    const df = new Map([
      ["quartz", 90], ["ledger", 4], ["support", 8], ["protocol", 12],
    ]);
    const profile = buildQueryProfile(
      "why did the quartz ledger change for support protocol",
      { query: "ledger", df, total: 100 },
    );

    expect(profile.retrievalTokens).toEqual(["ledger", "support", "protocol", "quartz", "change"]);
  });

  it("preserves identifier-shaped anchors within the existing token cap", () => {
    const query = "why issue #311 changed v2.3.2 "
      + Array.from({ length: 30 }, (_, index) => `signal${index}`).join(" ");
    const tokens = buildQueryProfile(query, { query: "changed", df: null, total: null }).retrievalTokens;

    expect(tokens).toEqual(expect.arrayContaining(["#311", "v2.3.2"]));
    expect(tokens).toHaveLength(16);
  });

  it("retains underscored and percent-bearing anchors without fabricating stripped variants", () => {
    const query = "why ERR_TLS_90412 DATABASE_URL 50%_off "
      + Array.from({ length: 20 }, (_, index) => `signal${index}`).join(" ");
    const profile = buildQueryProfile(query, { query: "signal0", df: null, total: null, distillSource: "shortcut" });
    expect(profile.retrievalTokens.slice(0, 4)).toEqual(["signal0", "err_tls_90412", "database_url", "50%_off"]);
    expect(profile.retrievalTokens).not.toEqual(expect.arrayContaining(["errtls90412", "databaseurl", "50off"]));
  });

  it("uses bounded deterministic variants without replacing original evidence", () => {
    const tokens = buildQueryProfile(
      "Did North Harbor teams review launch-plans on June 3?",
      { query: "review", df: null, total: null },
    ).retrievalTokens;

    expect(tokens.slice(0, 6)).toEqual(["review", "launch-plans", "north", "harbor", "teams", "june"]);
    expect(tokens).toEqual(expect.arrayContaining([
      "launchplans", "launch", "plans", "nh", "june 3", "team", "plan",
    ]));
    expect(tokens.length).toBeLessThanOrEqual(16);
  });

  it("never lets variants displace the capped original token set", () => {
    const query = Array.from({ length: 20 }, (_, index) => `records${index}`).join(" ");
    const tokens = buildQueryProfile(query, { query: "records19", df: null, total: null }).retrievalTokens;

    expect(tokens).toHaveLength(16);
    expect(tokens[0]).toBe("records19");
    expect(tokens).not.toContain("record19");
  });

  it("uses edge types as soft intent compatibility", () => {
    expect(edgeIntentCompatibility("causal", "caused_by")).toBeGreaterThan(
      edgeIntentCompatibility("causal", "relates_to"),
    );
    expect(edgeIntentCompatibility("chronology", "follows")).toBeGreaterThan(
      edgeIntentCompatibility("chronology", "relates_to"),
    );
    expect(edgeIntentCompatibility("direct", "decided")).toBe(0.5);
  });
});
