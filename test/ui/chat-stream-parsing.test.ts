/**
 * The dashboard's /chat reader (public/js/recall.js) independently parses
 * Workers AI's SSE stream, because POST /chat (src/routes/recall.ts)
 * streams the raw response straight to the browser instead of going
 * through src/lib/ai.ts's readStreamText. Same two answer shapes, same
 * chunk-boundary hazard, kept in sync by hand — this is the browser-side
 * counterpart to test/unit/read-stream-text.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load(globals: Record<string, unknown> = {}): any {
  const ctx: any = { console, ...globals };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/recall.js"), "utf8"), ctx);
  return ctx;
}

describe("extractChatChunkText()", () => {
  it("reads the Llama-shape d.response field", () => {
    const ctx = load();
    expect(ctx.extractChatChunkText({ response: "hi" })).toBe("hi");
  });

  it("reads the OpenAI-shape choices[0].delta.content field", () => {
    const ctx = load();
    expect(ctx.extractChatChunkText({ choices: [{ delta: { content: "hi" } }] })).toBe("hi");
  });

  it("never returns delta.reasoning or delta.reasoning_content", () => {
    const ctx = load();
    const d = { choices: [{ delta: { reasoning: "think", reasoning_content: "think" } }] };
    expect(ctx.extractChatChunkText(d)).toBe("");
  });

  it("tolerates choices: [], a missing delta, and a missing content without throwing", () => {
    const ctx = load();
    expect(() => ctx.extractChatChunkText({ choices: [] })).not.toThrow();
    expect(ctx.extractChatChunkText({ choices: [] })).toBe("");
    expect(ctx.extractChatChunkText({ choices: [{}] })).toBe("");
    expect(ctx.extractChatChunkText({ choices: [{ delta: {} }] })).toBe("");
    expect(ctx.extractChatChunkText({})).toBe("");
    expect(ctx.extractChatChunkText(null)).toBe("");
  });
});

describe("dashboard recall quota budget", () => {
  it("disables /recall synthesis because /chat generates the answer", () => {
    const source = readFileSync(resolve(ROOT, "public/js/recall.js"), "utf8");
    expect(source).toMatch(/const recallBody = \{[^\n]*synthesize: false[^\n]*\}/);
  });
});

describe("consumeChatSseLine()", () => {
  it("calls onText with the extracted content for a data line", () => {
    const ctx = load();
    let out = "";
    ctx.consumeChatSseLine('data: {"response":"hello"}', (t: string) => (out += t));
    expect(out).toBe("hello");
  });

  it("ignores [DONE] and non-data lines", () => {
    const ctx = load();
    const onText = vi.fn();
    ctx.consumeChatSseLine("data: [DONE]", onText);
    ctx.consumeChatSseLine(": comment", onText);
    ctx.consumeChatSseLine("", onText);
    expect(onText).not.toHaveBeenCalled();
  });

  it("swallows a malformed complete line without throwing", () => {
    const ctx = load();
    expect(() => ctx.consumeChatSseLine("data: not-json", () => {})).not.toThrow();
  });

  it("keeps literal [DONE] text inside a JSON payload (response shape)", () => {
    const ctx = load();
    let out = "";
    ctx.consumeChatSseLine('data: {"response":"Keep [DONE] in this sentence."}', (t: string) => (out += t));
    expect(out).toBe("Keep [DONE] in this sentence.");
  });

  it("keeps literal [DONE] text inside a JSON payload (choices delta shape)", () => {
    const ctx = load();
    let out = "";
    ctx.consumeChatSseLine('data: {"choices":[{"delta":{"content":"Keep [DONE] here."}}]}', (t: string) => (out += t));
    expect(out).toBe("Keep [DONE] here.");
  });

  it("still treats the bare completion sentinel as a sentinel, with or without CR", () => {
    const ctx = load();
    let out = "";
    ctx.feedChatStream("", 'data: {"response":"before "}\n\ndata: [DONE]\r\n\n', (t: string) => (out += t));
    expect(out).toBe("before ");
  });

  it("parses a data: line without the optional space after the colon", () => {
    const ctx = load();
    let out = "";
    ctx.consumeChatSseLine('data:{"response":"hello"}', (t: string) => (out += t));
    expect(out).toBe("hello");
  });
});

describe("feedChatStream() — assembling the /chat answer", () => {
  it("分割された完了通知を検出し、JSON本文中の同じ文字列では完了しない", () => {
    const ctx = load();
    const onComplete = vi.fn();
    const onText = vi.fn();
    let buffer = ctx.feedChatStream("", 'data: {"response":"[DONE]"}\n', onText, onComplete);
    expect(onText).toHaveBeenCalledWith("[DONE]");
    expect(onComplete).not.toHaveBeenCalled();
    buffer = ctx.feedChatStream(buffer, "data: [DO", onText, onComplete);
    expect(onComplete).not.toHaveBeenCalled();
    ctx.feedChatStream(buffer, "NE]\r\n\n", onText, onComplete);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("末尾改行のない完了通知をEOFのflushで検出する", () => {
    const ctx = load();
    const onComplete = vi.fn();
    const buffer = ctx.feedChatStream("", "data: [DONE]", vi.fn(), onComplete);
    expect(onComplete).not.toHaveBeenCalled();
    ctx.consumeChatSseLine(buffer, vi.fn(), onComplete);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("assembles an OpenAI-shape answer delivered across several complete lines", () => {
    const ctx = load();
    let fullText = "";
    const onText = (t: string) => (fullText += t);
    let buffer = "";
    buffer = ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"content":"Hello","role":"assistant"}}]}\n', onText);
    buffer = ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"content":" from"}}]}\n', onText);
    buffer = ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"content":" gpt-oss"}}]}\ndata: [DONE]\n', onText);
    expect(fullText).toBe("Hello from gpt-oss");
  });

  it("still handles the Llama d.response shape unchanged", () => {
    const ctx = load();
    let fullText = "";
    ctx.feedChatStream("", 'data: {"response":"the quick brown fox"}\n', (t: string) => (fullText += t));
    expect(fullText).toBe("the quick brown fox");
  });

  it("excludes reasoning fields from the assembled answer, even when they arrive first", () => {
    const ctx = load();
    let fullText = "";
    const onText = (t: string) => (fullText += t);
    let buffer = ctx.feedChatStream("", 'data: {"choices":[{"delta":{"reasoning":"We","reasoning_content":"We"}}]}\n', onText);
    buffer = ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"reasoning":" need to think.","reasoning_content":" need to think."}}]}\n', onText);
    ctx.feedChatStream(buffer, 'data: {"choices":[{"delta":{"content":"42"}}]}\n', onText);
    expect(fullText).toBe("42");
  });

  it("reassembles an SSE line split across a network chunk boundary", () => {
    const ctx = load();
    let fullText = "";
    const onText = (t: string) => (fullText += t);
    const line = 'data: {"choices":[{"delta":{"content":"streamed across a boundary"}}]}\n';
    const splitAt = 40; // lands inside the JSON string value, not on a line boundary
    let buffer = ctx.feedChatStream("", line.slice(0, splitAt), onText);
    // Nothing should render yet — the line isn't complete, so it must stay buffered.
    expect(fullText).toBe("");
    ctx.feedChatStream(buffer, line.slice(splitAt), onText);
    expect(fullText).toBe("streamed across a boundary");
  });

  it("holds back a final line with no trailing newline until the caller flushes it", () => {
    const ctx = load();
    let fullText = "";
    const onText = (t: string) => (fullText += t);
    const buffer = ctx.feedChatStream("", 'data: {"response":"tail-no-newline"}', onText);
    expect(fullText).toBe("");
    ctx.consumeChatSseLine(buffer, onText); // what sendRecall does once the reader is done
    expect(fullText).toBe("tail-no-newline");
  });
});

describe("sendRecall()の直接接続完了確認", () => {
  it.each([
    { name: "直接接続の完了通知があれば英語の使用量表示・回答・出典を表示する", provider: "chatgpt", terminal: "data: [DONE]", readError: false, success: true },
    { name: "イタリア語設定では直接接続の使用量表示も翻訳する", provider: "chatgpt", terminal: "data: [DONE]", readError: false, success: true, locale: "it" as const },
    { name: "直接接続の途中EOFでは部分回答を除去してエラーを表示する", provider: "chatgpt", terminal: "", readError: false, success: false },
    { name: "本文中のDONE文字列を直接接続の完了と誤認しない", provider: "chatgpt", terminal: 'data: {"response":"[DONE]"}\n', readError: false, success: false },
    { name: "直接接続のread失敗でも部分回答を残さない", provider: "chatgpt", terminal: "", readError: true, success: false },
    { name: "通常Workers AIのEOFで従来どおり回答と出典を表示する", provider: "workers-ai", terminal: "", readError: false, success: true },
  ])("$name", async ({ provider, terminal, readError, success, locale }) => {
    // DOMの接続状態を保持し、実際のsendRecallによる描画・除去を検査する。
    const makeElement = (): any => ({
      className: "", textContent: "", innerHTML: "", style: {}, dataset: {}, children: [], parent: null,
      appendChild(child: any) { child.parent = this; this.children.push(child); },
      prepend(child: any) { child.parent = this; this.children.unshift(child); },
      remove() {
        if (this.parent) this.parent.children = this.parent.children.filter((child: any) => child !== this);
        this.parent = null;
      },
      querySelector() { return makeElement(); },
      querySelectorAll() { return []; },
    });
    const messages = makeElement();
    const input = { value: "個人記憶の質問" };
    const clear = makeElement();
    const bubbles = vi.fn();
    const render = vi.fn((text: string) => `<p>${text}</p>`);
    const encoder = new TextEncoder();
    let chunk = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunk++ === 0) {
          controller.enqueue(encoder.encode('data: {"response":"途中の回答"}\n'));
        } else if (readError) {
          controller.error(new Error("通信中断"));
        } else {
          if (terminal) controller.enqueue(encoder.encode(terminal));
          controller.close();
        }
      },
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, results: [{
        id: "private-memory", content: "個人の記憶", score: 80, workspace: "personal", created_at: "2026-10-01",
      }] }))
      .mockResolvedValueOnce(new Response(stream, { headers: { "X-Second-Brain-AI-Provider": provider } }));
    const ctx = load({
      document: {
        getElementById(id: string) {
          return ({ "recall-input": input, "recall-messages": messages, "recall-clear-btn": clear } as Record<string, unknown>)[id] ?? null;
        },
        createElement: makeElement,
      },
      fetch, TextDecoder, WORKER_URL: "https://worker.invalid", AUTH_TOKEN: "synthetic-test-auth",
      selectedTag: "", selectedProject: "", autoResize: vi.fn(), appendUserBubble: vi.fn(),
      appendLoading: () => makeElement(), appendBrainBubble: bubbles,
      escHtml: (text: string) => text,
      renderAnswerMarkdown: render,
    });
    installI18n(ctx, locale ?? "en");
    ctx.renderStandingFires = vi.fn();
    ctx.makeRecallCard = () => makeElement();
    await ctx.sendRecall();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body).workspace).toBe("personal");
    expect(messages.children.filter((el: any) => el.className === "ex-a-row")).toHaveLength(success ? 1 : 0);
    expect(messages.children.filter((el: any) => el.className === "sources-toggle")).toHaveLength(success ? 1 : 0);
    if (success) {
      expect(render).toHaveBeenCalledWith("途中の回答");
      expect(bubbles).not.toHaveBeenCalled();
      const answer = messages.children.find((el: any) => el.className === "ex-a-row");
      const usage = answer.children.find((el: any) => el.className === "ex-a-provider");
      if (provider === "chatgpt") {
        expect(usage.innerHTML).toContain(locale === "it" ? "Piano ChatGPT in uso" : "Using ChatGPT plan");
        expect(usage.innerHTML).toContain(locale === "it" ? "Gestisci utilizzo" : "Manage usage");
        expect(usage.innerHTML).toContain('href="https://chatgpt.com/settings/usage"');
        expect(usage.innerHTML).toContain('rel="noopener noreferrer"');
      } else {
        expect(usage).toBeUndefined();
      }
    } else {
      expect(render).not.toHaveBeenCalled();
      expect(bubbles).toHaveBeenCalledWith(messages, ctx.t("recall.error"), "recall-sys");
    }
    expect(clear.style.display).toBe("flex");
  });
});
