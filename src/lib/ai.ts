import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { isChatGptOperationEnabled, runChatGptGeneration, type ChatGptOperation } from "./chatgpt";
import {
  assertEmbeddingConfig,
  embeddingInput,
  projectEmbedding,
  type EmbeddingPurpose,
} from "../embedding/profile";

export const WORKERS_AI_QUOTA_CODE = "workers_ai_quota_exhausted";
const WORKERS_AI_QUOTA_STATE_KEY = "runtime:workers-ai:quota:v1";

type WorkersAiQuotaState = {
  status: "quota_exhausted";
  observedAt: number;
  resetAt: number;
};

export type WorkersAiHealth =
  | { ok: false; status: "quota_exhausted"; observedAt: number; resetAt: number }
  | { ok: null; status: "no_recent_quota_error" }
  | { ok: null; status: "unknown" };

/** A provider quota failure with the raw provider response deliberately removed. */
export class WorkersAiQuotaError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number) {
    super(workersAiQuotaRetryMessage(retryAt));
    this.name = "QuotaExceededError";
    this.retryAt = retryAt;
  }
}

/** Workers AI daily allocations reset at 00:00 UTC (09:00 JST). */
export function nextWorkersAiQuotaReset(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function workersAiQuotaRetryMessage(retryAt: number): string {
  return `Workers AI daily quota is exhausted. Retry after ${new Date(retryAt).toISOString()} (daily reset at 00:00 UTC / 09:00 JST).`;
}

export function workersAiRetryAfterSeconds(retryAt: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((retryAt - now) / 1000));
}

function providerErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!(error && typeof error === "object")) return "";
  const record = error as Record<string, unknown>;
  const nested = record.error && record.error !== error ? providerErrorText(record.error) : "";
  return [record.code, record.message, nested].filter(value => value !== undefined && value !== null).join(" ");
}

/** Recognise both the observed binding error (4006) and Cloudflare's documented 3036 code. */
export function isWorkersAiQuotaError(error: unknown): boolean {
  if (error instanceof WorkersAiQuotaError) return true;
  const text = providerErrorText(error).toLowerCase();
  return /(?:^|\D)(?:4006|3036)(?:\D|$)/.test(text)
    || text.includes("daily free allocation")
    || text.includes("out of neurons")
    || text.includes("neurons daily limit")
    || text.includes("daily quota")
    || text.includes("quota exceeded");
}

async function rememberWorkersAiQuotaFailure(env: Env, state: WorkersAiQuotaState): Promise<void> {
  try {
    await env.OAUTH_KV.put(WORKERS_AI_QUOTA_STATE_KEY, JSON.stringify(state), {
      // KV requires expiration to be at least 60 seconds in the future. Keeping
      // the marker for one minute past reset also avoids a boundary-time flap.
      expiration: Math.ceil((state.resetAt + 60_000) / 1000),
    });
  } catch (error) {
    // Health reporting is advisory and must never replace the AI failure the
    // caller needs to handle.
    console.error("Workers AI quota health marker write failed (non-fatal):", error);
  }
}

/**
 * Convert a provider-specific quota failure into the stable error used by the
 * rest of the Worker, and persist the passive health marker at the same time.
 * Non-quota errors return null so callers can keep their existing degradation
 * policy without duplicating provider-code matching or marker writes.
 */
export async function observeWorkersAiQuotaError(
  env: Env,
  error: unknown,
): Promise<WorkersAiQuotaError | null> {
  if (!isWorkersAiQuotaError(error)) return null;
  const quotaError = error instanceof WorkersAiQuotaError
    ? error
    : new WorkersAiQuotaError(nextWorkersAiQuotaReset());
  await rememberWorkersAiQuotaFailure(env, {
    status: "quota_exhausted",
    observedAt: Date.now(),
    resetAt: quotaError.retryAt,
  });
  return quotaError;
}

/**
 * Clear a quota marker after a newer Workers AI request succeeds.
 *
 * KV does not offer compare-and-delete, so the timestamp check prevents an
 * already-running older request from clearing a quota failure that was
 * observed after that request started. Recovery jobs still perform bounded
 * probes so KV propagation or a residual race cannot stall the queue.
 */
export async function observeWorkersAiSuccess(
  env: Env,
  attemptStartedAt: number,
): Promise<void> {
  try {
    const raw = await env.OAUTH_KV.get(WORKERS_AI_QUOTA_STATE_KEY);
    if (!raw) return;

    let state: Partial<WorkersAiQuotaState>;
    try {
      state = JSON.parse(raw) as Partial<WorkersAiQuotaState>;
    } catch {
      return;
    }

    if (
      state.status === "quota_exhausted" &&
      typeof state.observedAt === "number" &&
      state.observedAt < attemptStartedAt
    ) {
      await env.OAUTH_KV.delete(WORKERS_AI_QUOTA_STATE_KEY);
    }
  } catch (error) {
    console.error(
      "Workers AI quota health marker clear failed (non-fatal):",
      error,
    );
  }
}

/** Passive health: no billable probe, only a recently observed quota failure. */
export async function readWorkersAiHealth(env: Env, now = Date.now()): Promise<WorkersAiHealth> {
  let raw: string | null;
  try {
    raw = await env.OAUTH_KV.get(WORKERS_AI_QUOTA_STATE_KEY);
  } catch (error) {
    console.error("Workers AI quota health marker read failed (non-fatal):", error);
    return { ok: null, status: "unknown" };
  }
  if (!raw) return { ok: null, status: "no_recent_quota_error" };

  try {
    const state = JSON.parse(raw) as Partial<WorkersAiQuotaState>;
    if (state.status === "quota_exhausted"
      && typeof state.observedAt === "number"
      && typeof state.resetAt === "number"
      && state.resetAt > now) {
      return {
        ok: false,
        status: "quota_exhausted",
        observedAt: state.observedAt,
        resetAt: state.resetAt,
      };
    }
    return { ok: null, status: "no_recent_quota_error" };
  } catch {
    return { ok: null, status: "unknown" };
  }
}

/** 接続先の選択だけを共有し、失敗時の扱いと応答の解釈は呼出元に残す。 */
export async function generateText(
  env: Env,
  operation: Extract<ChatGptOperation, "query-tags" | "recall-summary" | "digest" | "weekly-insight">,
  prompt: string,
  maxTokens: number,
  model: string,
): Promise<string> {
  if (isChatGptOperationEnabled(env, operation)) {
    return runChatGptGeneration(env, operation, prompt, maxTokens);
  }
  const stream = await env.AI.run(model as keyof AiModels, {
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    stream: true,
  });
  return readStreamText(stream as ReadableStream);
}

export function graceMs(env: Env): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}

/**
 * Workers AI streams two different answer shapes depending on model lineage.
 * Llama-family models (the shipped default) put the text directly on
 * `response`. OpenAI-lineage models (`@cf/openai/gpt-oss-*`) stream an
 * OpenAI-style chat-completion delta instead, under `choices[0].delta.content`
 * — and the reasoning ones in that family emit chain-of-thought first, as
 * `delta.reasoning` / `delta.reasoning_content`, before any `delta.content`.
 * That chain-of-thought is deliberately never returned here: every caller of
 * `readStreamText` treats the result as the answer — JSON.parse'ing it or
 * feeding it straight into a digest — not as reasoning prose.
 *
 * POST /chat (src/routes/recall.ts) is the one caller that does NOT go
 * through `readStreamText` — it streams the raw Workers AI response
 * straight to the browser, so public/js/recall.js hand-mirrors this exact
 * function (extractChatChunkText) and the buffering below it. Keep the two
 * in sync: a change here is a prompt to check there, and vice versa.
 */
function extractChunkText(d: any): string {
  if (d?.response) return d.response;
  const content = d?.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : "";
}

function consumeSseLine(line: string, onText: (chunk: string) => void): void {
  if (!line.startsWith("data:")) return;
  // SSE permits exactly one optional space after the field colon.
  const payload = line.slice(line.startsWith("data: ") ? 6 : 5);
  // The completion sentinel is the WHOLE payload, never a substring of one —
  // an answer may legitimately contain the text "[DONE]". trimEnd() tolerates
  // the trailing \r a CRLF stream leaves after splitting on \n.
  if (payload.trimEnd() === "[DONE]") return;
  try {
    const d = JSON.parse(payload);
    const text = extractChunkText(d);
    if (text) onText(text);
  } catch (e) {
    // A parse failure here is on a COMPLETE line (buffering already held back
    // any partial one), so it's a genuine anomaly rather than a chunk-boundary
    // artifact — worth a log, but it must not interrupt the stream: dropping
    // one malformed SSE line is far better than losing everything read so far.
    console.error("readStreamText: malformed SSE line (non-fatal):", e);
  }
}

export async function readStreamText(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // { stream: true } holds back a trailing partial multi-byte sequence
      // until the bytes that complete it arrive in the next chunk.
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // The last element is either "" (buffer ended on a newline) or an
      // incomplete line — either way it isn't a complete line yet, so it stays
      // buffered for the next read rather than being parsed now.
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeSseLine(line, chunk => { text += chunk; });
    }
    // Flush any bytes the decoder was holding back for a not-yet-complete
    // multi-byte character.
    buffer += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  // The stream may end without a trailing newline after its last line —
  // process whatever is left in the buffer rather than dropping it.
  if (buffer) consumeSseLine(buffer, chunk => { text += chunk; });
  return text;
}

async function embedForPurpose(
  text: string,
  purpose: EmbeddingPurpose,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  title?: string,
): Promise<number[]> {
  const profile = assertEmbeddingConfig(config);
  let result: unknown;
  try {
    result = await env.AI.run(profile.model, {
      text: [embeddingInput(text, purpose, title)],
    });
  } catch (error) {
    const quotaError = await observeWorkersAiQuotaError(env, error);
    if (quotaError) throw quotaError;
    throw error;
  }
  return projectEmbedding((result as { data?: unknown[] }).data?.[0]);
}

export function embedQuery(
  text: string,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<number[]> {
  return embedForPurpose(text, "query", env, config);
}

export function embedDocument(
  text: string,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  title?: string,
): Promise<number[]> {
  return embedForPurpose(text, "document", env, config, title);
}

/** 固定Gemmaの入力形式とMRLを保って、複数入力をまとめて処理する。 */
export function embedBatchSize(_model: string): number { return 25; }

export async function embedMany(
  texts: readonly string[], env: Env, config: Readonly<Config> = DEFAULTS,
  purpose: EmbeddingPurpose = "query", title?: string,
): Promise<number[][]> {
  const profile = assertEmbeddingConfig(config);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += embedBatchSize(profile.model)) {
    const batch = texts.slice(i, i + embedBatchSize(profile.model));
    let result: unknown;
    try {
      result = await env.AI.run(profile.model, { text: batch.map(text => embeddingInput(text, purpose, title)) });
    } catch (error) {
      const quotaError = await observeWorkersAiQuotaError(env, error);
      throw quotaError ?? error;
    }
    const data = (result as { data?: unknown[] }).data;
    if (!Array.isArray(data) || data.length !== batch.length) throw new Error("埋込み応答の件数が入力と一致しません");
    out.push(...data.map(projectEmbedding));
  }
  return out;
}
