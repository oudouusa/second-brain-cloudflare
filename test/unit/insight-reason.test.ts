import { describe, it, expect, vi } from "vitest";
import { parseInsightResponse, sharesVocabulary, isRestatementFraming, restatesRecent, reasonOverPair } from "../../src/insight/reason";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { DEFAULTS } from "../../src/config";

function makeAI(payload: string) {
  return {
    run: vi.fn().mockResolvedValue(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    })),
  } as unknown as Ai;
}

describe("parseInsightResponse()", () => {
  it("accepts a well-formed insight", () => {
    const out = parseInsightResponse(`{"insight": true, "shape": "contradiction", "text": "In March you chose flat pricing; in July you chose usage-based."}`);
    expect(out?.shape).toBe("contradiction");
  });

  it("tolerates prose around the JSON", () => {
    const out = parseInsightResponse(`Sure!\n{"insight": true, "shape": "throughline", "text": "You return to onboarding friction every few weeks."}\nHope that helps.`);
    expect(out?.shape).toBe("throughline");
  });

  it("returns null on an explicit refusal", () => {
    expect(parseInsightResponse(`{"insight": false}`)).toBeNull();
  });

  it("returns null on a refusal even when shape and text would otherwise pass", () => {
    expect(parseInsightResponse(`{"insight": false, "shape": "connection", "text": "This text is long enough to clear the forty character floor easily."}`)).toBeNull();
  });

  it("returns null on unparseable output", () => {
    expect(parseInsightResponse("I could not find anything.")).toBeNull();
  });

  it("returns null when a brace-delimited substring is not valid JSON", () => {
    expect(parseInsightResponse("Here is my answer: {not json at all}")).toBeNull();
  });

  it("returns null on an invalid shape", () => {
    expect(parseInsightResponse(`{"insight": true, "shape": "vibes", "text": "Something long enough to pass the length floor easily."}`)).toBeNull();
  });

  it("returns null when the text is too short to say anything", () => {
    expect(parseInsightResponse(`{"insight": true, "shape": "connection", "text": "Related."}`)).toBeNull();
  });

  it("accepts text exactly at the 600 character upper bound", () => {
    const text = "A".repeat(600);
    const out = parseInsightResponse(`{"insight": true, "shape": "connection", "text": "${text}"}`);
    expect(out?.text.length).toBe(600);
  });

  it("returns null when text is one character past the 600 character upper bound", () => {
    const text = "A".repeat(601);
    expect(parseInsightResponse(`{"insight": true, "shape": "connection", "text": "${text}"}`)).toBeNull();
  });
});

describe("sharesVocabulary()", () => {
  it("is true when the insight draws on vocabulary distinctive to each side", () => {
    expect(sharesVocabulary(
      "In March you chose flat pricing, and in July usage-based billing.",
      "We should adopt flat pricing for the first tier in March.",
      "Decision: switch to usage-based billing in July, flat tiers were leaving money on the table.",
    )).toBe(true);
  });

  it("is false for a centroid statement that only echoes the shared topic", () => {
    // "pricing" and "tier(s)" are in the intersection of a and b — the
    // shared topic that made them a candidate pair. The insight text below
    // draws only on that intersection and names nothing particular to
    // either side, which is exactly the failure this rule replaced the old
    // symmetric one to catch.
    expect(sharesVocabulary(
      "You often think about pricing tiers for the product.",
      "We should adopt flat pricing for the first tier of the product.",
      "Decision: switch to usage-based pricing, flat tiers were leaving money on the table for the product.",
    )).toBe(false);
  });

  it("is false for a pure stopword echo against two real sources", () => {
    expect(sharesVocabulary(
      "You often talk about this and that.",
      "Kubernetes autoscaling thresholds were raised for the ingest workers.",
      "The on-call rotation was shortened to one week per engineer.",
    )).toBe(false);
  });

  it("is false when the text names only one side, nothing distinctive to the other", () => {
    expect(sharesVocabulary(
      "You chose flat pricing for the first tier.",
      "We should adopt flat pricing for the first tier of the product.",
      "Decision: switch to usage-based billing, the SLA response window was tightened to four hours.",
    )).toBe(false);
  });

  it("degenerate case: is true when b's distinctive vocabulary is wholly a subset of a's", () => {
    // b has nothing distinctively its own to require — everything about it
    // is already said in a — so it cannot veto. This is the asymmetric
    // analogue of the old rule's "source has no distinctive vocabulary of
    // its own"; see the comment above the function in src/insight/reason.ts.
    expect(sharesVocabulary(
      "Kubernetes autoscaling thresholds were raised for the ingest workers.",
      "Kubernetes autoscaling thresholds were raised for the ingest workers, and alerting was tuned too.",
      "Kubernetes autoscaling thresholds were raised.",
    )).toBe(true);
  });

  it("degenerate case: is true when NEITHER side has vocabulary of its own (fully overlapping entries)", () => {
    // Handled explicitly, not by accident: when the two entries are this
    // similar the vocabulary floor has nothing to check against on either
    // side, so it passes anything — the prompt-level judgment and the
    // restatement blocklist are what's left to catch a bad answer here.
    expect(sharesVocabulary(
      "Anything you like, even off topic.",
      "Kubernetes autoscaling thresholds were raised for the ingest workers.",
      "Kubernetes autoscaling thresholds were raised for the ingest workers.",
    )).toBe(true);
  });
});

describe("isRestatementFraming()", () => {
  it.each([
    ["mentioned in both", "The idea is mentioned in both entries, though nothing changed."],
    ["in both memories", "This topic appears in both memories from what I can tell."],
    ["appears in both", "The word appears in both, but nothing else connects them."],
    ["memory a", "This was true in Memory A as well as later on."],
    ["memory b", "It resurfaces again in Memory B, unchanged."],
  ])("flags text containing %s", (_label, text) => {
    expect(isRestatementFraming(text)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isRestatementFraming("This is MENTIONED IN BOTH entries.")).toBe(true);
  });

  it("does not flag ordinary use of 'recurring concern' and its siblings", () => {
    // Deliberately not blocked — see the comment above RESTATEMENT_PHRASES
    // in src/insight/reason.ts for why. A genuine insight can legitimately
    // use this language; the phrase alone isn't the tell.
    expect(isRestatementFraming(
      "Your recurring concern about onboarding friction resolved when you shipped the installer.",
    )).toBe(false);
  });

  it("does not flag a genuine insight with no restatement language", () => {
    expect(isRestatementFraming(
      "You chose flat pricing in March, then reversed course in July once usage data showed heavy accounts were being undercharged.",
    )).toBe(false);
  });
});

describe("the eight captured samples", () => {
  // These are the eight real proposals captured off the live endpoint that
  // motivated this floor tightening. All eight cleared the old symmetric
  // vocabulary floor; of the eight, only #7 was judged a real insight.
  // Keeping the literal text as fixtures is what makes the rest of this
  // suite testable against the actual failure this pass exists to catch,
  // rather than against invented text that might not reproduce it.
  const SAMPLE_1 = "You solicited feedback on setup complexity for non-devs in Memory A, and in Memory B, you noted that there were  replies posted,  upvotes clicked...";
  const SAMPLE_2 = "You maintained a focus on promoting your Second Brain Cloudflare project through Twitter/X, first planning a promotional strategy in Memory A and then executing it in Memory B by posting replies on X.";
  const SAMPLE_3 = "The concept of vectorization is mentioned in both memories, with Memory A discussing it in the context of a DM from 'Tumes' about building an Obsidian second brain, and Memory B describing the technical stack used in Second Brain v2, which includes Vectorize.";
  const SAMPLE_4 = "The challenge of managing information recall, specifically balancing relevance and context, is a recurring concern, as seen in Memory A's discussion of...";
  const SAMPLE_5 = "You highlight the problem of AI tools not being able to retain memories between sessions in both posts, showing a consistent concern over time.";
  const SAMPLE_6 = "You explored the technical implementation and limitations of using D1 and Vectorize together in both a GitHub discussion and a Reddit post, indicating a ongoing concern with the consistency and development of this technology stack.";
  const SAMPLE_7 = "The concept of memory in AI ... is a recurring concern that evolved in your thinking from identifying the problem of recency bias and episodic vs semantic memory distinction to developing a solution, second-brain-cloudflare, to address this issue.";
  const SAMPLE_8 = "You engaged with the Claude AI community about recall hit rates and token costs in Memory A, and later drafted YouTube comments ... suggesting a continued exploration of AI memory and cost optimization.";

  describe("caught by the restatement blocklist (leaked labels or bare co-occurrence)", () => {
    it("sample 1 — leaks 'Memory A' and 'Memory B'", () => {
      expect(isRestatementFraming(SAMPLE_1)).toBe(true);
    });

    it("sample 2 — leaks 'Memory A' and 'Memory B'", () => {
      expect(isRestatementFraming(SAMPLE_2)).toBe(true);
    });

    it("sample 3 — 'mentioned in both memories' plus leaked labels", () => {
      expect(isRestatementFraming(SAMPLE_3)).toBe(true);
    });

    it("sample 4 — leaks 'Memory A'", () => {
      expect(isRestatementFraming(SAMPLE_4)).toBe(true);
    });

    it("sample 8 — leaks 'Memory A'", () => {
      expect(isRestatementFraming(SAMPLE_8)).toBe(true);
    });

    it("sample 1 is declined end to end through reasonOverPair", async () => {
      const a = { content: "Setup requires four separate config values and no non-dev has gotten through it without help." };
      const b = { content: "Reception on the launch post: a handful of replies, a modest number of upvotes, nothing viral." };
      const env = makeTestEnv(makeTestDb(), {
        AI: makeAI(`{"insight": true, "shape": "connection", "text": ${JSON.stringify(SAMPLE_1)}}`),
      });
      expect(await reasonOverPair(a, b, env)).toEqual({ outcome: "invalid", reason: "restatement" });
    });
  });

  describe("caught by the asymmetric vocabulary rule instead (clears the narrowed blocklist)", () => {
    it("sample 5 does not trip the narrowed blocklist", () => {
      // "in both posts" and "consistent concern" were deliberately dropped
      // from RESTATEMENT_PHRASES — this sample is exactly why the
      // vocabulary rule still needs to carry weight on its own.
      expect(isRestatementFraming(SAMPLE_5)).toBe(false);
    });

    it("sample 5 fails the vocabulary floor: it names nothing distinctive to either side", () => {
      // Constructed source content standing in for the two real memories —
      // the point being tested is that text this generic (no platform, no
      // specific claim, only the shared complaint) fails regardless of what
      // plausible specifics the real sources contained, because the
      // insight text never reaches for any of them.
      const a = "Posted on Reddit: AI tools have no memory between sessions, so every session starts from zero and you must restate context each time.";
      const b = "Left a comment on a YouTube video: these AI tools do not keep any memory across sessions either, forcing people to repeat the same background info constantly.";
      expect(sharesVocabulary(SAMPLE_5, a, b)).toBe(false);
    });

    it("sample 5 is declined end to end through reasonOverPair", async () => {
      const a = { content: "Posted on Reddit: AI tools have no memory between sessions, so every session starts from zero and you must restate context each time." };
      const b = { content: "Left a comment on a YouTube video: these AI tools do not keep any memory across sessions either, forcing people to repeat the same background info constantly." };
      const env = makeTestEnv(makeTestDb(), {
        AI: makeAI(`{"insight": true, "shape": "throughline", "text": ${JSON.stringify(SAMPLE_5)}}`),
      });
      expect(await reasonOverPair(a, b, env)).toEqual({ outcome: "invalid", reason: "language" });
    });
  });

  describe("sample 6 — an honest gap, not tuned away", () => {
    // Reported as required rather than papered over. Sample 6 names GitHub
    // and Reddit specifically — one platform per side — so it clears the
    // asymmetric vocabulary rule the same way a genuine "connection" insight
    // would, and it uses none of the five narrowed blocklist phrases.
    // Mechanically this text is indistinguishable from good output: it does
    // name something concrete from each side. What makes it bad is that it
    // only narrates "explored X on platform 1, Y on platform 2" instead of
    // connecting them — a judgment neither mechanical rule can make. That is
    // exactly why the prompt now says not to write this way, rather than
    // pushing the blocklist to get specific enough to catch it (which would
    // mean matching on "GitHub"/"Reddit"-shaped narration in general, and
    // rejecting good output about real platforms along with it).
    it("does not trip the narrowed blocklist", () => {
      expect(isRestatementFraming(SAMPLE_6)).toBe(false);
    });

    it("clears the vocabulary floor too — names GitHub and Reddit, one per side", () => {
      const a = "GitHub discussion: opened an issue asking whether D1 can be joined with Vectorize results in a single query, or whether the app has to fetch vector matches first and then hit D1 separately for each row. Got a reply confirming there is no native join, so every retrieval does two round trips.";
      const b = "Posted on Reddit asking how others handle D1 latency when paired with Vectorize for a RAG-style app, getting inconsistent read replication delay after writes, where D1 returns stale rows right after a Vectorize-triggered insert until the replica catches up.";
      expect(sharesVocabulary(SAMPLE_6, a, b)).toBe(true);
    });

    it("旧形式の英語応答は言語検証で見送る。意味の品質問題そのものを解消した証明ではない", async () => {
      const a = { content: "GitHub discussion: opened an issue asking whether D1 can be joined with Vectorize results in a single query, or whether the app has to fetch vector matches first and then hit D1 separately for each row. Got a reply confirming there is no native join, so every retrieval does two round trips." };
      const b = { content: "Posted on Reddit asking how others handle D1 latency when paired with Vectorize for a RAG-style app, getting inconsistent read replication delay after writes, where D1 returns stale rows right after a Vectorize-triggered insert until the replica catches up." };
      const env = makeTestEnv(makeTestDb(), {
        AI: makeAI(`{"insight": true, "shape": "connection", "text": ${JSON.stringify(SAMPLE_6)}}`),
      });
      expect(await reasonOverPair(a, b, env)).toEqual({ outcome: "invalid", reason: "language" });
    });
  });

  describe("sample 7 — the one real insight", () => {
    it("does not trip the narrowed blocklist", () => {
      // Under the original, broader blocklist this collided on "recurring
      // concern" — see the comment above RESTATEMENT_PHRASES in reason.ts.
      // Narrowing to structurally-unambiguous phrases resolves that
      // collision without tuning anything to this sample specifically.
      expect(isRestatementFraming(SAMPLE_7)).toBe(false);
    });

    it("clears the vocabulary floor — names recency/episodic/semantic from the earlier memory and second-brain-cloudflare from the later one", () => {
      const a = "Been turning over why AI chat memory feels wrong: it's a recency bias problem, everything treated as equally salient no matter how old, and it conflates episodic memory, what actually happened, with semantic memory, general facts, into one undifferentiated blob.";
      const b = "Started building second-brain-cloudflare: entries get weighted by time instead of always surfacing whatever was said most recently, and the store keeps separate lanes so old and new information doesn't collapse into one bucket.";
      expect(sharesVocabulary(SAMPLE_7, a, b)).toBe(true);
    });

    it("passes the full floor end to end through reasonOverPair", async () => {
      const a = { content: "Been turning over why AI chat memory feels wrong: it's a recency bias problem, everything treated as equally salient no matter how old, and it conflates episodic memory, what actually happened, with semantic memory, general facts, into one undifferentiated blob." };
      const b = { content: "Started building second-brain-cloudflare: entries get weighted by time instead of always surfacing whatever was said most recently, and the store keeps separate lanes so old and new information doesn't collapse into one bucket." };
      const env = makeTestEnv(makeTestDb(), {
        AI: makeAI(JSON.stringify({insight:true, shape:"throughline", text:"情報の新しさに偏ることへの懸念を、時間による重み付けと記憶の種類を分ける設計へ反映しています。", evidence:{a:"a recency bias problem",b:"entries get weighted by time"}})),
      });
      expect(await reasonOverPair(a, b, env)).toEqual({
        outcome: "insight",
        shape: "throughline",
        text: "情報の新しさに偏ることへの懸念を、時間による重み付けと記憶の種類を分ける設計へ反映しています。",
      });
    });
  });
});

describe("restatesRecent()", () => {
  const earlier = "The ledger table you added for the audit feature became the implementation of the reconciliation ledger you only sketched earlier.";

  it("catches a conclusion already written in different words", () => {
    const restated = "The ledger table added for the audit feature is the concrete implementation of the reconciliation ledger sketched earlier.";
    expect(restatesRecent(restated, [earlier])).toBe(true);
  });

  it("allows an insight about a different subject", () => {
    const fresh = "Your habit of drafting release notes before the code is finished shows up again in the migration rollout.";
    expect(restatesRecent(fresh, [earlier])).toBe(false);
  });

  it("allows the first insight on a brain with none written yet", () => {
    expect(restatesRecent(earlier, [])).toBe(false);
  });

  it("compares against each recent insight independently, not their concatenation", () => {
    // Two unrelated insights must not pool their vocabulary into a match that
    // neither of them would have made alone.
    const a = "The ledger table you added for the audit feature is load-bearing.";
    const b = "Your release notes are drafted before the code is finished.";
    const unrelated = "The ledger release notes finished audit habit table code.";
    expect(restatesRecent(unrelated, [a, b])).toBe(false);
  });
});

describe("reasonOverPair()", () => {
  const a = { content: "We should adopt flat pricing for the first tier of the product." };
  const b = { content: "Decision: switch to usage-based pricing, flat tiers were leaving money on the table." };

  it("returns the insight when it names something from both entries", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(JSON.stringify({insight:true,shape:"contradiction",text:'当初は固定料金を採用する方針でしたが、収益を取りこぼしていたため、従量制の料金へ切り替える判断に変更しています。',evidence:{a:"first tier of the product",b:"usage-based pricing"}})),
    });
    const out = await reasonOverPair(a, b, env);
    expect(out).toEqual({
      outcome: "insight",
      shape: "contradiction",
      text: '当初は固定料金を採用する方針でしたが、収益を取りこぼしていたため、従量制の料金へ切り替える判断に変更しています。',
    });
  });

  it("declines a generic statement that echoes neither entry specifically", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"insight": true, "shape": "throughline", "text": "You often talk about building a second brain and thinking about things."}`),
    });
    expect(await reasonOverPair(a, b, env)).toEqual({ outcome: "invalid", reason: "language" });
  });

  it("declines text that blows past the 600 character ceiling, with the same outcome as any other quality-floor failure", async () => {
    // A model that ignored "one or two sentences" and wrote paragraphs
    // instead. The dashboard renders `text` in full with no clipping (see
    // the comment on MAX_INSIGHT_TEXT_CHARS in src/insight/reason.ts), so
    // 検証失敗として版ごとの限定再試行に渡す。モデル自身の拒否とは区別する。
    const longText = "You chose flat pricing for the first tier, then switched to usage-based pricing. ".repeat(10);
    expect(longText.length).toBeGreaterThan(600);
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"insight": true, "shape": "contradiction", "text": ${JSON.stringify(longText)}}`),
    });
    expect(await reasonOverPair(a, b, env)).toEqual({ outcome: "invalid", reason: "format" });
  });

  it("declines an explicit refusal", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"insight": false}`),
    });
    expect(await reasonOverPair(a, b, env)).toEqual({ outcome: "declined" });
  });

  it("reports failed, not declined, when the model call itself throws", async () => {
    // The distinction is load-bearing: src/insight/weekly.ts marks a "declined"
    // candidate rejected permanently and leaves a "failed" one pending to
    // retry. Collapsing this into one outcome (as a bare null once did) made a
    // transient model outage indistinguishable from a considered refusal.
    const env = makeTestEnv(makeTestDb(), {
      AI: { run: vi.fn().mockRejectedValue(new Error("AI down")) } as unknown as Ai,
    });
    await expect(reasonOverPair(a, b, env)).resolves.toEqual({ outcome: "failed" });
  });

  it("calls the model with config.INSIGHT_LLM_MODEL, never config.LLM_MODEL", async () => {
    // LLM_MODEL is shared with classification, contradiction detection, smart
    // merge, digests and recall synthesis; INSIGHT_LLM_MODEL is this call's
    // own setting (see src/constants.ts). Set the two to different,
    // recognisable strings so a regression that reads the wrong one is
    // visible here rather than passing by coincidence.
    const ai = makeAI(`{"insight": false}`);
    const env = makeTestEnv(makeTestDb(), { AI: ai });
    const config = {
      ...DEFAULTS,
      LLM_MODEL: "should-not-be-used-by-insight-reasoning",
      INSIGHT_LLM_MODEL: "insight-only-model-for-test",
    };

    await reasonOverPair(a, b, env, config);

    expect((ai.run as any).mock.calls[0][0]).toBe("insight-only-model-for-test");
  });
});
