/**
 * Budget guard for v4/hooks x release/v4's GET /recall (src/routes/recall.ts).
 *
 * UPDATED (4.0 decision, director + UX advisor, after the original finding
 * below): every hook now sends `synthesize=0` on every /recall request
 * (agent-hooks-core/core.js's buildRecallUrl). The first test in this file
 * used to prove the opposite — that no client ever asked for synthesis to be
 * off — and is now a regression guard proving the fix stays in place.
 *
 * Original finding, still true server-side and worth keeping for context:
 * src/routes/recall.ts builds recallEntries' params as
 * `{ query, topK, tag, after, before, kind, hops, project, explain }` — no
 * `synthesize` field read from the query string yet (a separate BE lane is
 * adding it on v4/ux-be-2). src/recall/search.ts: `const synthesize =
 * params.synthesize ?? true`, and `synthesize && matches.length > 1` gates one
 * env.AI.run(LLM_MODEL, ...) call (synthesizeInsight, src/recall/insight.ts)
 * per /recall request that finds more than one match. Until the BE lane
 * merges, the Worker ignores the `synthesize=0` this hooks lane now sends and
 * still synthesizes by default — sending it now is forward compatible and
 * costs nothing, but does not yet stop the spend on its own. The neuron-cost
 * pins below describe what is actually saved once server-side wiring lands.
 *
 * LLM_MODEL is @cf/meta/llama-4-scout-17b-16e-instruct (src/constants.ts:1),
 * capped at INSIGHT_MAX_TOKENS (src/constants.ts, 300) output tokens. Using
 * the published Workers AI rates for that model — 24,545 neurons/M input
 * tokens, 77,273 neurons/M output tokens — this pins the neuron cost of one
 * synthesis call for a typical and a worst-case recall, then projects it
 * across a user running all 5 hook clients (Claude Code, Codex, Cursor,
 * Gemini CLI, VS Code Copilot) each doing several sessions a day.
 *
 * At most ONE of buildRecallPlan's two arms ever synthesizes per session
 * start: the loop (core.js performRecall) returns as soon as an arm's
 * results are non-empty, and only a non-empty result (matches.length > 1)
 * triggers synthesis — so the unscoped fallback arm costs an extra /recall
 * request (and its own embed) on a project-arm miss, but never a SECOND
 * synthesis call in the same performRecall run.
 */
import { describe, expect, it } from "vitest";
import { INSIGHT_MAX_TOKENS, LLM_MODEL } from "../../src/constants";

const coreJs = require("../../integrations/agent-hooks-core/core.js");

// Published Workers AI rates for @cf/meta/llama-4-scout-17b-16e-instruct, per the
// director's brief (not derivable from this repo — Cloudflare's own pricing page).
const INPUT_NEURONS_PER_M_TOKENS = 24_545;
const OUTPUT_NEURONS_PER_M_TOKENS = 77_273;
const CHARS_PER_TOKEN_ESTIMATE = 4;

function neuronsFor(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * INPUT_NEURONS_PER_M_TOKENS
    + (outputTokens / 1_000_000) * OUTPUT_NEURONS_PER_M_TOKENS;
}

describe("hookのPOST /recallでは合成を要求しない", () => {
  it("本文にsynthesize:falseを送り、検索語をURLへ含めない", () => {
    const url = coreJs.buildRecallUrl("https://w.example", { query: "q", topK: 5, workspace: "personal" });
    expect(new URL(url).search).toBe("");
    expect(JSON.parse(coreJs.buildRecallBody({ query: "q", topK: 5, workspace: "personal" })).synthesize).toBe(false);
  });
});

describe("neuron cost of one hook-triggered synthesis call", () => {
  it("typical: topK 5, ~1 KB memories each — pins the estimate against the published scout rates", () => {
    const PROMPT_BOILERPLATE_TOKENS = 160; // the fixed instructions/rules text in synthesizeInsight's prompt
    const QUERY_TOKENS = 10;
    const MEMORIES = 5;
    const BYTES_PER_MEMORY = 1024;
    const contentTokens = MEMORIES * (BYTES_PER_MEMORY / CHARS_PER_TOKEN_ESTIMATE);
    const inputTokens = PROMPT_BOILERPLATE_TOKENS + QUERY_TOKENS + contentTokens;
    const outputTokens = 150; // a 2-4 sentence insight, well under the 300-token cap

    const neurons = neuronsFor(inputTokens, outputTokens);

    expect(inputTokens).toBe(1450);
    expect(neurons).toBeGreaterThan(40);
    expect(neurons).toBeLessThan(60); // ~47 neurons/call
  });

  it("worst case: topK 5, memories at CHUNK_MAX_CHARS (1600), full 300-token output budget used", () => {
    const PROMPT_BOILERPLATE_TOKENS = 160;
    const QUERY_TOKENS = 10;
    const MEMORIES = 5;
    const CHUNK_MAX_CHARS = 1600; // src/constants.ts CHUNK_MAX_CHARS — the largest one memory's content chunk gets
    const contentTokens = MEMORIES * (CHUNK_MAX_CHARS / CHARS_PER_TOKEN_ESTIMATE);
    const inputTokens = PROMPT_BOILERPLATE_TOKENS + QUERY_TOKENS + contentTokens;
    const outputTokens = INSIGHT_MAX_TOKENS; // model uses its full output budget

    const neurons = neuronsFor(inputTokens, outputTokens);

    expect(LLM_MODEL).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(inputTokens).toBe(2170);
    expect(neurons).toBeGreaterThan(70);
    expect(neurons).toBeLessThan(90); // ~76.5 neurons/call
  });

  it("projects across 5 hook clients (Claude Code, Codex, Cursor, Gemini CLI, VS Code Copilot) for one active user", () => {
    const HOOK_CLIENTS = 5;
    const typicalPerCall = neuronsFor(160 + 10 + 5 * (1024 / CHARS_PER_TOKEN_ESTIMATE), 150);
    const worstPerCall = neuronsFor(160 + 10 + 5 * (1600 / CHARS_PER_TOKEN_ESTIMATE), INSIGHT_MAX_TOKENS);

    // One session-start recall per client per day (the floor: a solo user who
    // opens each tool once). Even here this is a small fraction of the
    // 10,000 neurons/day cap.
    const dailyFloorTypical = typicalPerCall * HOOK_CLIENTS;
    const dailyFloorWorst = worstPerCall * HOOK_CLIENTS;
    expect(dailyFloorTypical).toBeLessThan(300);
    expect(dailyFloorWorst).toBeLessThan(500);

    // But this cost is PER SESSION START, not per day: a user bouncing between
    // tools all day (say 20 sessions per client = 100 session starts/day, not
    // unusual for someone switching editors/terminals repeatedly) crosses into
    // a meaningful fraction of the daily neuron budget on synthesis ALONE —
    // this is the material finding, not the single-call cost.
    const SESSIONS_PER_CLIENT_PER_DAY = 20;
    const busyDayTypical = typicalPerCall * HOOK_CLIENTS * SESSIONS_PER_CLIENT_PER_DAY;
    const busyDayWorst = worstPerCall * HOOK_CLIENTS * SESSIONS_PER_CLIENT_PER_DAY;
    const NEURON_DAILY_CAP = 10_000;

    expect(busyDayTypical).toBeGreaterThan(NEURON_DAILY_CAP * 0.4); // ~4,650
    expect(busyDayWorst).toBeGreaterThan(NEURON_DAILY_CAP * 0.7); // ~7,650 — most of the free daily budget from hook recalls alone
    expect(busyDayWorst).toBeLessThan(NEURON_DAILY_CAP); // not an outright breach on its own, but close enough that it is not headroom
  });
});
