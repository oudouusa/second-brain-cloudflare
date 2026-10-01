/** HTTP応答やprovider固有の例外へ変換する前の、バイト数による拒否。 */
export class BodyTooLargeError extends Error {
  constructor() {
    super("Body exceeds the byte limit");
    this.name = "BodyTooLargeError";
  }
}

export function cancelBody(source: { cancel(): Promise<void> } | null): void {
  // 中止を通知するが、外部sourceの後始末で拒否応答を待たせない。
  try { void source?.cancel().catch(() => {}); } catch { /* 元の拒否理由を保持する。 */ }
}

export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  declared: string | null,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredBytes = Number(declared);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    cancelBody(body);
    throw new BodyTooLargeError();
  }
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    cancelBody(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const bytes = await readBoundedBytes(response.body ?? null, response.headers?.get("Content-Length") ?? null, maxBytes);
  if (response.body) return new TextDecoder().decode(bytes);
  // bodyを持たずtext()だけを提供する既存provider試験の互換経路。
  // 実Responseではbodyがnullならtext()も空。外部streamは必ず上の経路で制限する。
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new BodyTooLargeError();
  return text;
}
