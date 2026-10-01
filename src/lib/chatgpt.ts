import type { Env } from "../env";
import { z } from "zod";
import { ChatGptError, chatGptAccessToken, chatGptUpstreamCode, checkChatGptResponse, readChatGptJson } from "./chatgpt-session";
import { logEvent, logErrorEvent } from "./observability";

export type ChatGptOperation = "classify" | "query-tags" | "smart-merge"
  | "contradiction" | "recall-summary" | "digest" | "answer" | "weekly-insight";

// 処理ごとの予算を固定し、保存判断には比較済みのTerraを使う。
const POLICIES: Record<ChatGptOperation, { chars: number; tokens: number; timeout: number; terra?: true }> = {
  classify: { chars: 12_000, tokens: 256, timeout: 15_000 },
  "query-tags": { chars: 12_000, tokens: 256, timeout: 15_000 },
  "smart-merge": { chars: 64_000, tokens: 1024, timeout: 25_000, terra: true },
  contradiction: { chars: 64_000, tokens: 512, timeout: 25_000, terra: true },
  "recall-summary": { chars: 64_000, tokens: 1024, timeout: 25_000 },
  digest: { chars: 32_000, tokens: 1024, timeout: 25_000, terra: true },
  answer: { chars: 64_000, tokens: 2048, timeout: 25_000 },
  "weekly-insight": { chars: 16_000, tokens: 1600, timeout: 25_000, terra: true },
};
export type ChatGptMessage = { role: "system" | "user"; content: string };
function operationModel(env: Env, operation: ChatGptOperation): string {
  return POLICIES[operation].terra ? "gpt-5.6-terra" : env.CHATGPT_MODEL?.trim() || "gpt-5.6-luna";
}

const idField = z.string().min(1);
const reasonField = z.string().max(500).optional();
const RESPONSE_SCHEMAS = {
  classify: z.object({ importance: z.number().int().min(1).max(5), canonical: z.boolean(), kind: z.enum(["episodic", "semantic"]) }),
  "smart-merge": z.discriminatedUnion("action", [
    z.object({ action: z.literal("keep_both") }),
    z.object({ action: z.literal("replace"), target_id: idField }),
    z.object({ action: z.literal("merge"), target_id: idField, merged_content: z.string().trim().min(1).max(400) }),
    z.object({ action: z.literal("contradiction"), conflicting_id: idField, reason: reasonField }),
  ]),
  contradiction: z.discriminatedUnion("contradicts", [
    z.object({ contradicts: z.literal(false) }),
    z.object({ contradicts: z.literal(true), conflicting_id: idField, reason: reasonField }),
  ]),
  "weekly-insight": z.object({ insight: z.boolean() }),
};

/** 処理ごとの有限予算と保存判断の検証を保った、公開Responsesへの直接接続。 */
export async function runChatGptGeneration(env: Env, operation: ChatGptOperation,
  prompt: string | ChatGptMessage[], maxTokens: number): Promise<string> {
  if (!isChatGptOperationEnabled(env, operation)) throw new ChatGptError("operation_not_enabled");
  requirePersonalScope(env);
  const policy = POLICIES[operation];
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > policy.tokens) {
    throw new ChatGptError("invalid_request");
  }
  const messages: ChatGptMessage[] = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
  const content = await runChatGptText(env, operation, operationModel(env, operation), messages, {
    chars: policy.chars, outputChars: maxTokens * 8, timeout: policy.timeout,
  });
  if (operation in RESPONSE_SCHEMAS) {
    try { RESPONSE_SCHEMAS[operation as keyof typeof RESPONSE_SCHEMAS].parse(JSON.parse(content)); }
    catch { throw new ChatGptError("invalid_response"); }
  }
  return content;
}

/** 既存の回答SSE契約へ変換し、完了・打切り・切断を直接経路で検証する。 */
export async function runChatGptGenerationAnswerStream(env: Env,
  messages: ChatGptMessage[]): Promise<ReadableStream<Uint8Array>> {
  if (!isChatGptOperationEnabled(env, "answer")) throw new ChatGptError("operation_not_enabled");
  requirePersonalScope(env);
  const policy = POLICIES.answer;
  return runChatGptAnswerStream(env, operationModel(env, "answer"), messages, {
    chars: policy.chars, outputChars: policy.tokens * 8, timeout: policy.timeout,
  });
}

export function isChatGptOperationEnabled(env: Env, operation: ChatGptOperation): boolean {
  return (env.CHATGPT_OPERATIONS ?? "").split(",").some(value => value.trim().toLowerCase() === operation);
}

/** 実際の範囲が所有者の個人領域だけの場合に限る。未知・混在・Teamは通常のWorkers AIへ送る。 */
export function chatGptEnvForWorkspaces(env: Env, workspaceIds: readonly string[]): Env {
  const ownerWorkspace = env.CHATGPT_OWNER_WORKSPACE_ID?.trim();
  const allowed = !!ownerWorkspace && workspaceIds.length > 0
    && workspaceIds.every(id => id === ownerWorkspace);
  return Object.assign(Object.create(env) as Env, {
    CHATGPT_OPERATIONS: allowed ? env.CHATGPT_OPERATIONS : "",
    CHATGPT_WORKSPACE_ID: allowed ? ownerWorkspace : undefined,
  });
}
function requirePersonalScope(env: Env): void {
  const ownerWorkspace = env.CHATGPT_OWNER_WORKSPACE_ID?.trim();
  if (!ownerWorkspace || env.CHATGPT_WORKSPACE_ID !== ownerWorkspace) {
    throw new ChatGptError("personal_scope_required");
  }
}
const MODEL_ALLOWLIST = new Set(["gpt-5.6-luna", "gpt-5.6-terra"]);
const MAX_STREAM_BYTES = 256 * 1024;
const encoder = new TextEncoder();
interface Limits { chars: number; outputChars: number; timeout: number }
interface Model { slug: string; display_name: string }

export async function listChatGptModels(env: Env): Promise<Model[]> {
  const response = await fetch("https://api.openai.com/v1/models", { redirect: "manual", cache: "no-store",
    headers: { Authorization: `Bearer ${await chatGptAccessToken(env)}` }, signal: AbortSignal.timeout(15_000) });
  await checkChatGptResponse(response);
  const payload = await readChatGptJson(response, 2 * 1024 * 1024);
  if (!Array.isArray(payload.models) || payload.models.length > 500) throw new ChatGptError("invalid_model_catalog");
  return payload.models.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const model = value as Record<string, unknown>;
    return model.visibility === "list" && typeof model.slug === "string" && model.slug.length < 100
      && typeof model.display_name === "string" && model.display_name.length < 200
      ? [{ slug: model.slug, display_name: model.display_name }] : [];
  });
}

async function* textDeltas(env: Env, model: string, messages: ChatGptMessage[], limits: Limits, signal?: AbortSignal): AsyncGenerator<string> {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (!MODEL_ALLOWLIST.has(model)) throw new ChatGptError("model_not_allowlisted");
  if (!chars || chars > limits.chars) throw new ChatGptError("invalid_request");
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", redirect: "manual", cache: "no-store",
    headers: { Authorization: `Bearer ${await chatGptAccessToken(env, env.CHATGPT_WORKSPACE_ID)}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    // ChatGPTプランのpreviewではmax_output_tokens・temperature・system messageを送れない。
    body: JSON.stringify({ model, input: messages.map(message => ({
      role: message.role === "system" ? "developer" : message.role, content: message.content,
    })), store: false, stream: true }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(limits.timeout)]) : AbortSignal.timeout(limits.timeout) });
  await checkChatGptResponse(response);
  const contentType = response.headers.get("Content-Type");
  // ChatGPT直接経路ではSSEでもこのheaderが無い実応答がある。本文と完了イベントは下で必ず検証する。
  if (!response.body || (contentType !== null && !contentType.toLowerCase().includes("text/event-stream"))) {
    await response.body?.cancel(); throw new ChatGptError("invalid_response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0, outputChars = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new ChatGptError("incomplete_response");
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new ChatGptError("response_too_large");
      buffer += decoder.decode(chunk.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(data); } catch { throw new ChatGptError("invalid_response"); }
        if (!payload || typeof payload !== "object") throw new ChatGptError("invalid_response");
        if (payload.type === "error" || payload.type === "response.failed") {
          const value = payload.type === "response.failed" ? payload.response : { error: payload };
          throw new ChatGptError(chatGptUpstreamCode(value));
        }
        if (payload.type === "response.incomplete") throw new ChatGptError("incomplete_response");
        if (payload.type === "response.output_item.added") {
          const item = payload.item as { type?: unknown } | undefined;
          if (item?.type !== "message" && item?.type !== "reasoning") throw new ChatGptError("unsupported_output");
        }
        if (payload.type === "response.output_text.delta") {
          if (typeof payload.delta !== "string") throw new ChatGptError("invalid_response");
          outputChars += payload.delta.length;
          if (outputChars > limits.outputChars) throw new ChatGptError("response_too_large");
          yield payload.delta;
        }
        if (payload.type === "response.completed") {
          const completed = payload.response as { status?: unknown; error?: unknown; usage?: unknown } | undefined;
          if (completed?.status !== "completed" || completed.error) throw new ChatGptError("invalid_response");
          return;
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function safeError(error: unknown): ChatGptError {
  if (error instanceof ChatGptError) return error;
  return new ChatGptError(error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name) ? "timeout" : "network");
}
function record(operation: string, model: string, started: number, error?: ChatGptError): void {
  const fields = { provider: "chatgpt", operation, model, status: error ? "error" : "ok",
    latency_ms: Math.round(performance.now() - started), ...(error ? { error_code: error.code } : {}),
    ...(error?.upstreamStatus !== undefined ? { upstream_status: error.upstreamStatus } : {}) };
  if (error) logErrorEvent("ai_provider_call", fields); else logEvent("ai_provider_call", fields);
}
export async function runChatGptText(env: Env, operation: ChatGptOperation, model: string,
  messages: ChatGptMessage[], limits: Limits): Promise<string> {
  const started = performance.now();
  try {
    let text = "";
    for await (const delta of textDeltas(env, model, messages, limits)) text += delta;
    if (operation !== "query-tags" && !text.trim()) throw new ChatGptError("invalid_response");
    record(operation, model, started);
    return text;
  } catch (error) { const safe = safeError(error); record(operation, model, started, safe); throw safe; }
}
export async function runChatGptAnswerStream(env: Env, model: string, messages: ChatGptMessage[], limits: Limits): Promise<ReadableStream<Uint8Array>> {
  const started = performance.now();
  const abort = new AbortController();
  const iterator = textDeltas(env, model, messages, limits, abort.signal);
  let first: IteratorResult<string> | undefined;
  try { first = await iterator.next(); }
  catch (error) { const safe = safeError(error); record("answer", model, started, safe); throw safe; }
  let nonEmpty = false, cancelled = false;
  const emit = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = first ?? await iterator.next();
        first = undefined;
        if (cancelled) return;
        if (next.done) {
          if (!nonEmpty) throw new ChatGptError("invalid_response");
          record("answer", model, started);
          controller.enqueue(emit({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close();
        } else {
          nonEmpty ||= Boolean(next.value.trim());
          controller.enqueue(emit({ choices: [{ index: 0, delta: { content: next.value }, finish_reason: null }] }));
        }
      } catch (error) {
        if (cancelled) return;
        const safe = safeError(error); record("answer", model, started, safe); controller.error(safe);
      }
    },
    async cancel() { cancelled = true; abort.abort(); record("answer", model, started, new ChatGptError("cancelled")); await iterator.return(undefined); },
  });
}
