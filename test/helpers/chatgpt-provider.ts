import { vi } from "vitest";
import * as session from "../../src/lib/chatgpt-session";

/** 合成provider試験だけで資格情報取得を置き換え、実際のResponses本文を通す。 */
export function mockChatGptFetch(fetcher: ReturnType<typeof vi.fn>) {
  vi.spyOn(session, "chatGptAccessToken").mockResolvedValue("synthetic-access-token");
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

export function chatGptResponse(content: string, finishReason = "stop", status = 200): Response {
  if (status !== 200) return Response.json({ error: { code: "synthetic_upstream_failure" } }, { status });
  const events = [
    { type: "response.output_text.delta", delta: content },
    finishReason === "stop"
      ? { type: "response.completed", response: { status: "completed" } }
      : { type: "response.incomplete" },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } });
}
