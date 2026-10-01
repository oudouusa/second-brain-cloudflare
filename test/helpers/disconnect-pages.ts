/** 累積件数とnext_cursorを使い、実際のdisconnect APIを全ページ処理するfixture。 */
export async function disconnectAllPages(send: (body: Record<string, unknown>) => Promise<Response>) {
  let cursor: string | undefined;
  let previous = "";
  for (let page = 0; page < 10_000; page++) {
    const response = await send({ purge: true, ...(cursor === undefined ? {} : { cursor }) });
    const body = await response.json() as { ok: boolean; done: boolean; purged: number; kept?: number; skipped?: number; next_cursor?: string };
    if (!body.ok || (response.status !== 200 && response.status !== 202)) throw new Error(`disconnect: ${response.status}`);
    if (body.done) return body;
    if (typeof body.next_cursor !== "string") throw new Error("disconnect cursorがない");
    const progress = JSON.stringify([body.next_cursor, body.purged, body.skipped]);
    if (progress === previous) throw new Error("disconnectが進まない");
    previous = progress;
    cursor = body.next_cursor;
  }
  throw new Error("disconnectのfixtureページ上限に達した");
}
