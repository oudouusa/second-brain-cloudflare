import { afterEach, describe, expect, it, vi } from "vitest";
import { BodyTooLargeError, readBoundedBytes, readBoundedResponseText } from "../../src/lib/body";
import { readBodyBytes } from "../../src/lib/http";
import { notionListPages } from "../../src/integrations/notion";
import { validateCalendarUrl } from "../../src/integrations/calendar";
import { readChatGptJson } from "../../src/lib/chatgpt-session";
import { makeTestEnv } from "../helpers/make-env";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function source(bytes: Uint8Array | null, finish: boolean, cancellation = "ok") {
  const cancel = vi.fn(() => cancellation === "reject"
    ? Promise.reject(new Error("後始末の失敗"))
    : cancellation === "pending" ? new Promise<void>(() => {}) : Promise.resolve());
  const body = new ReadableStream<Uint8Array>({
    start(c) { if (bytes) c.enqueue(bytes); if (finish) c.close(); }, cancel,
  }, { highWaterMark: 0 });
  return { body, cancel };
}

describe("バイト上限と読取終了", () => {
  it.each([null, "1", "not-a-number", "Infinity"])("宣言値%sに依存せず実バイト数で拒否する", async declared => {
    const { body, cancel } = source(new Uint8Array(5), false);
    await expect(readBoundedBytes(body, declared, 4)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("上限ちょうどの分割UTF-8を欠落させず読み、readerを解放する", async () => {
    const bytes = new TextEncoder().encode("日本語");
    const body = new ReadableStream<Uint8Array>({ start(c) {
      for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
      c.close();
    } });
    expect(await readBoundedResponseText(new Response(body), bytes.length)).toBe("日本語");
    expect(body.locked).toBe(false);
  });

  it("読取例外はHTTP 400へ変換し、readerを解放する", async () => {
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("private failure")); } });
    const result = await readBodyBytes(body, null, 4);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.text()).not.toContain("private failure");
    }
    expect(body.locked).toBe(false);
  });

  it.each(["reject", "pending"])("中止が%sでもHTTPのサイズ拒否は413で終了する", async cancellation => {
    const { body, cancel } = source(new Uint8Array(5), false, cancellation);
    const result = await readBodyBytes(body, null, 4);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each(["ok", "reject", "pending"])("HTTPの宣言超過も中止し、後始末が%sでも413を返す", async cancellation => {
    const { body, cancel } = source(null, false, cancellation);
    const result = await readBodyBytes(body, "5", 4);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("空bodyと既存のtextだけの試験ダブルを扱う", async () => {
    expect(await readBoundedResponseText(new Response(null), 4)).toBe("");
    const double = { text: async () => "日本語" } as Response;
    await expect(readBoundedResponseText(double, 9)).resolves.toBe("日本語");
    await expect(readBoundedResponseText(double, 8)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("provider固有の上限と拒否応答", () => {
  const providers = [
    { name: "Notion", limit: 128 * 1024, error: { name: "NotionResponseTooLargeError" },
      invoke: async (response: Response) => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response)); return notionListPages("test-token"); } },
    { name: "Calendar", limit: 32 * 1024, error: { message: "Couldn't reach that calendar link (Calendar response is too large). Double-check the secret iCal URL." },
      invoke: async (response: Response) => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response)); return validateCalendarUrl("https://example.test/calendar.ics"); } },
    { name: "ChatGPT JSON", limit: 128 * 1024, error: { code: "invalid_response" },
      invoke: (response: Response) => readChatGptJson(response) },
  ];
  for (const provider of providers) {
    it.each(["declared", "actual"].flatMap(kind => ["ok", "reject", "pending"].map(cancellation => ({ kind, cancellation }))))(
      `${provider.name}: $kind超過を拒否し中止が$cancellationでも終了する`, async ({ kind, cancellation }) => {
        const { body, cancel } = source(kind === "actual" ? new Uint8Array(provider.limit + 1) : null, false, cancellation);
        const response = new Response(body, { headers: kind === "declared" ? { "Content-Length": String(provider.limit + 1) } : {} });
        await expect(provider.invoke(response)).rejects.toMatchObject(provider.error);
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
      },
    );
  }
});
