type LogField = string | number | boolean | null;

const SAFE_LOG_FIELDS: Record<string, ReadonlySet<string>> = {
  http_request: new Set(["event", "operation", "method", "status", "outcome", "duration_ms", "error_name"]),
  recall_complete: new Set([
    "event", "operation", "outcome", "duration_ms", "candidate_count", "fallback_used", "error_name",
    "graph_hops", "graph_seed_count", "graph_expanded_count", "graph_eligible_count", "graph_selected_count",
    "query_signal_cache_hit", "lineage_fallback_used",
  ]),
  recall_lineage_fallback: new Set(["event", "operation", "outcome", "error_name"]),
  nightly_budget: new Set(["event", "used", "calls", "deferred", "limit"]),
  scheduled_job: new Set(["event", "operation", "outcome", "duration_ms", "error_name", "schema_initialized"]),
  insight_weekly: new Set([
    "event", "candidates_drawn", "candidates_reasoned", "declined_by_model",
    "restatements_suppressed", "written",
    "validation_deferred", "validation_exhausted",
    "invalid_format", "invalid_language", "invalid_evidence", "invalid_restatement",
  ]),
  ai_provider_call: new Set([
    "event", "provider", "operation", "model", "status", "error_code", "upstream_status",
    "latency_ms", "prompt_chars", "completion_chars", "prompt_tokens", "completion_tokens", "total_tokens",
  ]),
};
type SafeConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_SANITIZER = Symbol.for("second-brain-cf.privacy-safe-console");
// 上流rerankerの1行ログ（eventなし）。経路と数値だけ残し、errorのreason文字列は捨てる。
const RERANK_LOG_ROUTES = new Set(["applied", "error", "timeout"]);
const RERANK_LOG_FIELDS = new Set(["rerank", "ms", "n", "reason"]);

/**
 * The Worker has legacy non-fatal console calls whose arguments can contain memory IDs,
 * tags, provider object IDs, URLs, Error messages, and stacks. Keep those calls useful as
 * a generic failure signal without persisting their arguments. Only the strict JSON shape
 * emitted by logEvent/logErrorEvent passes through unchanged.
 */
export function sanitizeConsoleArguments(
  method: SafeConsoleMethod,
  args: unknown[],
): [string] {
  if (args.length === 1 && typeof args[0] === "string") {
    try {
      const value = JSON.parse(args[0]) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (RERANK_LOG_ROUTES.has(record.rerank as string)
          && Object.keys(record).every(key => RERANK_LOG_FIELDS.has(key))
          && (record.ms === undefined || typeof record.ms === "number")
          && (record.n === undefined || typeof record.n === "number")) {
          return [JSON.stringify({ event: "reranker_step", rerank: record.rerank, ms: record.ms, n: record.n })];
        }
        const event = typeof record.event === "string" ? record.event : "";
        const fields = SAFE_LOG_FIELDS[event];
        const entries = Object.entries(record);
        if (fields
          && entries.every(([key, field]) => fields.has(key)
            && (field === null || ["string", "number", "boolean"].includes(typeof field))
            && (typeof field !== "string" || field.length <= 64))) {
          return [JSON.stringify(record)];
        }
      }
    } catch {
      // Any unstructured text is intentionally reduced below.
    }
  }
  const severity = method === "error" ? "error" : method === "warn" ? "warn" : "info";
  return [JSON.stringify({ event: "internal_log", severity })];
}

/** Install once at the Worker entrypoint; tests can exercise the pure sanitizer directly. */
export function installPrivacySafeConsole(): void {
  const target = console as Console & { [CONSOLE_SANITIZER]?: boolean };
  if (target[CONSOLE_SANITIZER]) return;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[method].bind(target) as (...args: unknown[]) => void;
    target[method] = ((...args: unknown[]) => {
      original(...sanitizeConsoleArguments(method, args));
    }) as typeof target[typeof method];
  }
  Object.defineProperty(target, CONSOLE_SANITIZER, { value: true });
}

export function durationMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

export function errorName(error: unknown): string {
  // Error.name is mutable and some provider errors copy attacker-controlled values into
  // it. Logs use a closed vocabulary so observability can never become a side channel.
  const allowed = new Set([
    "AbortError",
    "BackupError",
    "DataError",
    "Error",
    "MemoryWriteLockedError",
    "NotAllowedError",
    "QuotaExceededError",
    "RangeError",
    "SyntaxError",
    "TypeError",
  ]);
  return error instanceof Error && allowed.has(error.name) ? error.name : "UnknownError";
}

export function logEvent(event: string, fields: Record<string, LogField>): void {
  console.log(JSON.stringify({ ...fields, event }));
}

export function logErrorEvent(event: string, fields: Record<string, LogField>): void {
  console.error(JSON.stringify({ ...fields, event }));
}
