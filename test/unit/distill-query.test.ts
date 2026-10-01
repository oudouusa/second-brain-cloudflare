import { describe, it, expect } from "vitest";
import { distillToRareTerms } from "../../src/recall/distill";
import { tokenizeQuery } from "../../src/text/lexical-query";

// A minimal env whose D1 aggregation returns crafted document-frequencies. The columns
// d0..dN map to the query's unique content tokens in order (as distillToRareTerms builds
// them), so `dfByToken` lets each test declare how common each token is.
function envWith(total: number, dfByToken: Record<string, number>, tokenOrder: string[]) {
  const row: Record<string, number> = { total };
  tokenOrder.forEach((t, i) => { row[`d${i}`] = dfByToken[t] ?? 0; });
  return {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    },
  } as any;
}

describe("distillToRareTerms", () => {
  it("pushes supplied time bounds into the existing frequency statement", async () => {
    let sql = "";
    let bindings: unknown[] = [];
    const env = {
      DB: {
        prepare: (value: string) => {
          sql = value;
          return {
            bind: (...values: unknown[]) => {
              bindings = values;
              return { first: async () => ({ total: 1, d0: 1, d1: 1 }) };
            },
          };
        },
      },
    } as any;

    await distillToRareTerms("quartz ledger", env, undefined, { after: 100, before: 200 });

    expect(sql).toContain("WHERE created_at >= ? AND created_at < ?");
    expect(bindings.slice(-2)).toEqual([100, 200]);
  });

  it("counts raw and NFKC probes as one document-frequency term", async () => {
    let sql = "";
    let bindings: unknown[] = [];
    const env = {
      DB: {
        prepare: (value: string) => {
          sql = value;
          return {
            bind: (...values: unknown[]) => {
              bindings = values;
              return { first: async () => ({ total: 10, d0: 1, d1: 2 }) };
            },
          };
        },
      },
    } as any;

    const out = await distillToRareTerms("Ｃｌｏｕｄｆｌａｒｅ quartz", env);

    expect(sql).toContain("(content LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
    expect(bindings.slice(0, 3)).toEqual([
      "%cloudflare%",
      "%Ｃｌｏｕｄｆｌａｒｅ%",
      "%quartz%",
    ]);
    expect(out.df?.get("cloudflare")).toBe(1);
    expect(out.terms?.find(term => term.value === "cloudflare")?.probes).toHaveLength(2);
  });
  it("drops corpus-saturating terms and keeps the rare, discriminative ones", async () => {
    // "second"/"brain" saturate the corpus (>30%); "dictawiz"/"reddit" are rare.
    const order = ["second", "brain", "dictawiz", "reddit"];
    const env = envWith(100, { second: 80, brain: 85, dictawiz: 2, reddit: 6 }, order);
    const out = await distillToRareTerms("second brain dictawiz reddit", env);
    expect(out.query).toBe("dictawiz reddit");
  });

  it("caps the query at the rarest MAX_QUERY_TERMS (3)", async () => {
    // None saturating; keep the 3 rarest, drop the most common ("review").
    const order = ["quarterly", "review", "budget", "finance"];
    const env = envWith(100, { quarterly: 4, review: 25, budget: 3, finance: 2 }, order);
    const out = await distillToRareTerms("quarterly review budget finance", env);
    // "review" (df 25) is the most common of the four → dropped; order preserved.
    expect(out.query).toBe("quarterly budget finance");
  });

  it("does not spend rare-term slots on tokens absent from the corpus", async () => {
    // CJK fallback bigrams can cross grammatical boundaries. In this real
    // query, "じロ" occurs zero times; treating df=0 as maximally rare used a
    // slot on a term that cannot retrieve anything and dropped the observed
    // subject word "ダッシュボード".
    const query = "ダッシュボードとMCPを同じログインのCloudflare Accessにした最終構成は？";
    const order = tokenizeQuery(query);
    const env = envWith(44, {
      "ダッシュボード": 3, "ダッ": 7, "ッシ": 7, mcp: 12, "を同": 6,
      "同じ": 8, "ログイン": 3, "ログ": 6, "イン": 8, cloudflare: 9,
      access: 10, "した": 20, "最終": 6, "終構": 0, "構成": 3, "成は": 0,
    }, order);

    const out = await distillToRareTerms(query, env);

    expect(out.query).toBe("ダッシュボード ログイン 構成");
    expect(out.query).not.toContain("終構");
  });

  it("希少な質問語よりも観測済みの識別子を1枠だけ保持する", async () => {
    const query = "#730 alpha beta gamma";
    const out = await distillToRareTerms(query,
      envWith(100, { "#730": 20, alpha: 1, beta: 2, gamma: 3 }, tokenizeQuery(query)));
    expect(out.query).toBe("#730 alpha beta");
  });

  it.each([0, 70])("未観測・頻出の識別子を優先しない (df=%i)", async frequency => {
    const query = "#730 alpha beta gamma";
    const out = await distillToRareTerms(query,
      envWith(100, { "#730": frequency, alpha: 1, beta: 2, gamma: 3 }, tokenizeQuery(query)));
    expect(out.query).toBe("alpha beta gamma");
  });

  it("全語頻出のfallbackでも識別子に特別な枠を与えない", async () => {
    const query = "#730 alpha beta gamma";
    const out = await distillToRareTerms(query,
      envWith(100, { "#730": 90, alpha: 40, beta: 50, gamma: 60 }, tokenizeQuery(query)));
    expect(out.query).toBe("alpha beta gamma");
  });

  it("複数の識別子があっても予約枠は1つにとどめる", async () => {
    const query = "#730 /runbook.md alpha beta gamma";
    const out = await distillToRareTerms(query,
      envWith(100, { "#730": 20, "/runbook.md": 25, alpha: 1, beta: 2, gamma: 3 }, tokenizeQuery(query)));
    expect(out.query).toBe("#730 alpha beta");
  });

  it("略語だけでは希少語より優先しない", async () => {
    const query = "MCP alpha beta gamma";
    const out = await distillToRareTerms(query,
      envWith(100, { mcp: 20, alpha: 1, beta: 2, gamma: 3 }, tokenizeQuery(query)));
    expect(out.query).toBe("alpha beta gamma");
  });

  it("単語の部分bigramを重複選択せず別の質問語を残す", async () => {
    const query = "スキル 再開 個人";
    const out = await distillToRareTerms(query,
      envWith(100, { "スキル": 1, "スキ": 1, "キル": 1, "再開": 2, "個人": 3 }, tokenizeQuery(query)));
    expect(out.query).toBe("スキル 再開 個人");
  });

  it("単語が未観測なら部分bigramの救済を維持する", async () => {
    const query = "スキル 再開 個人";
    const out = await distillToRareTerms(query,
      envWith(100, { "スキル": 0, "スキ": 1, "キル": 1, "再開": 2, "個人": 3 }, tokenizeQuery(query)));
    expect(out.query).toBe("スキ キル 再開");
  });

  it("strips grammatical stopwords, then drops saturating content words", async () => {
    // "what/on/the/to" are grammatical stopwords (removed first); "happened" is a content
    // word but saturates the corpus (>30%) so it's dropped, leaving the rare subject.
    const order = ["happened", "trip", "cleveland"];
    const env = envWith(100, { happened: 45, trip: 12, cleveland: 3 }, order);
    const out = await distillToRareTerms("what happened on the trip to cleveland", env);
    expect(out.query).toBe("trip cleveland");
  });

  it("returns corpus df and total for a single content word", async () => {
    const out = await distillToRareTerms("dictawiz", envWith(40, { dictawiz: 1 }, ["dictawiz"]));
    expect(out.query).toBe("dictawiz");
    expect(out.df?.get("dictawiz")).toBe(1);
    expect(out.total).toBe(40);
    expect(out.distillSource).toBe("like");
  });

  it("falls back to the content words if the frequency scan fails", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("db down"); } }) }) } } as any;
    const out = await distillToRareTerms("alpha beta gamma", env);
    expect(out.query).toBe("alpha beta gamma");
  });

  // ── Corpus statistics passthrough ──────────────────────────────────────────
  //
  // The DF scan above is corpus-wide truth, and fuseDenseAndKeyword previously
  // re-estimated the same statistic from its ≤LIMIT fetched rows — a biased
  // sample. These tests pin the contract that lets fusion reuse the real
  // numbers: on success df covers EVERY scanned term (dropped ones included,
  // since fusion's tokens come from the distilled query but fallback paths can
  // widen), and on any fallback both stats are null so fusion knows not to
  // trust half a result.

  it("returns corpus df and total for every scanned term on success", async () => {
    const order = ["second", "brain", "dictawiz", "reddit"];
    const env = envWith(100, { second: 80, brain: 85, dictawiz: 2, reddit: 6 }, order);
    const out = await distillToRareTerms("second brain dictawiz reddit", env);
    expect(out.total).toBe(100);
    expect(out.df?.get("dictawiz")).toBe(2);
    expect(out.df?.get("reddit")).toBe(6);
    // Dropped terms still carry their frequencies — the scan already paid for them.
    expect(out.df?.get("second")).toBe(80);
    expect(out.df?.get("brain")).toBe(85);
  });

  it("returns null stats when the query has no content terms", async () => {
    const env = { DB: { prepare: () => { throw new Error("should not query"); } } } as any;
    const out = await distillToRareTerms("the", env);
    expect(out.df).toBeNull();
    expect(out.total).toBeNull();
    expect(out.distillSource).toBe("shortcut");
  });

  it("returns null stats when the frequency scan fails", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("db down"); } }) }) } } as any;
    const out = await distillToRareTerms("alpha beta gamma", env);
    expect(out.df).toBeNull();
    expect(out.total).toBeNull();
  });

  it("returns null stats when the corpus is empty", async () => {
    const env = envWith(0, {}, []);
    const out = await distillToRareTerms("alpha beta gamma", env);
    expect(out.query).toBe("alpha beta gamma");
    expect(out.df).toBeNull();
    expect(out.total).toBeNull();
  });

  // ── #326: one vocabulary for distill and the keyword arm ────────────────────

  it("counts CJK words as their own terms so corpus IDF covers what the keyword arm binds", async () => {
    // One whitespace word carries four terms. Before #326 the word normalized to
    // "" and the scan never ran; the mixed query lost its CJK half entirely.
    const order = ["cloudflare", "認証", "方式", "変更", "理由"];
    const env = envWith(100, { cloudflare: 5, 認証: 20, 方式: 40, 変更: 60, 理由: 3 }, order);
    const out = await distillToRareTerms("Cloudflare 認証方式を変更した理由", env);
    expect([...out.df!.keys()]).toEqual(order);
    // The fork embeds the original semantic query by default; this field stays
    // the bounded rare-term lexical query.
    expect(out.query).toBe("cloudflare 認証 理由");
    expect(out.terms?.map(term => term.value)).toEqual(["cloudflare", "認証", "理由"]);
  });

  it("scans a single CJK word when it carries more than one term", async () => {
    const order = ["認証", "方式", "変更", "理由"];
    const env = envWith(100, { 認証: 2, 方式: 4, 変更: 6, 理由: 8 }, order);
    const out = await distillToRareTerms("認証方式を変更した理由", env);
    expect(out.df?.get("方式")).toBe(4);
    expect(out.total).toBe(100);
    expect(out.query).toBe("認証 方式 変更");
  });
});
