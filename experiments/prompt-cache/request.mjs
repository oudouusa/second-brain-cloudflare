import { createHash } from "node:crypto";

export const PROMPT_CACHE_EXPERIMENT_VERSION = "prompt-cache-ab.v1";

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Return a privacy-safe identity for the exact Responses API base endpoint.
 * Scheme, effective port, and path are part of the identity so evidence from
 * another compatible service cannot be certified as the intended proxy.
 */
export function transportLabel(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("baseUrl must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("baseUrl must not contain credentials, query, or fragment");
  }

  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const effectivePort = url.port || defaultPort;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const canonical = `${url.protocol}//${url.hostname.toLowerCase()}:${effectivePort}${path}`;
  if (canonical === "https://api.openai.com:443/v1") return "openai-official";
  return `custom-${sha256(canonical).slice(0, 12)}`;
}

export function promptCacheKey({ workspaceKey, profile, experimentId, arm }) {
  for (const [name, value] of Object.entries({ workspaceKey, profile, experimentId, arm })) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  }
  const digest = sha256(`${workspaceKey}\0${profile}\0${experimentId}\0${arm}`);
  return `sbcf-pcab-${digest.slice(0, 52)}`;
}

function textBlock(text, explicitBreakpoint) {
  if (typeof text !== "string" || !text) throw new TypeError("prompt content must be a non-empty string");
  return {
    type: "input_text",
    text,
    ...(explicitBreakpoint ? { prompt_cache_breakpoint: { mode: "explicit" } } : {}),
  };
}

/**
 * Build the exact request used by both the official Responses API A/B test and
 * later proxy re-evaluation. Stable material is always before the changing
 * user suffix. Explicit mode marks the end of core and, when present, project.
 */
export function buildResponsesRequest({
  model,
  cacheKey,
  coreText,
  projectText,
  userText,
  arm,
  effort,
  maxOutputTokens = 4096,
}) {
  if (arm !== "implicit" && arm !== "explicit") {
    throw new TypeError('arm must be "implicit" or "explicit"');
  }
  if (typeof model !== "string" || !model.trim()) throw new TypeError("model is required");
  if (effort !== undefined && (typeof effort !== "string" || !effort.trim())) {
    throw new TypeError("effort must be a non-empty string when provided");
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new TypeError("maxOutputTokens must be a positive integer");
  }
  if (typeof cacheKey !== "string" || !cacheKey.trim() || cacheKey.length > 64) {
    throw new TypeError("cacheKey must be a non-empty string of at most 64 characters");
  }
  if (typeof userText !== "string" || !userText) throw new TypeError("userText is required");
  if (projectText !== undefined && projectText !== null && (typeof projectText !== "string" || !projectText)) {
    throw new TypeError("projectText must be a non-empty string when provided");
  }

  const explicit = arm === "explicit";
  const input = [
    {
      role: "developer",
      content: [textBlock(
        "Follow the stable Second Brain capsule as background context. The changing user request remains authoritative.",
        false,
      )],
    },
    {
      role: "developer",
      content: [textBlock(coreText, explicit)],
    },
  ];
  if (projectText !== undefined && projectText !== null) {
    input.push({
      role: "developer",
      content: [textBlock(projectText, explicit)],
    });
  }
  input.push({
    role: "user",
    content: [textBlock(userText, false)],
  });

  return {
    model,
    store: false,
    prompt_cache_key: cacheKey,
    ...(explicit ? { prompt_cache_options: { mode: "explicit", ttl: "30m" } } : {}),
    input,
    max_output_tokens: maxOutputTokens,
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    text: { verbosity: "low" },
  };
}

export function requestDescriptor(request) {
  const input = Array.isArray(request.input) ? request.input : [];
  const core = input[1]?.content?.[0]?.text ?? "";
  const projectItem = input.length === 4 ? input[2] : null;
  const project = projectItem?.content?.[0]?.text ?? null;
  const user = input.at(-1)?.content?.[0]?.text ?? "";
  return {
    model: request.model,
    prompt_cache_key_hash: sha256(request.prompt_cache_key),
    mode: request.prompt_cache_options?.mode ?? "implicit",
    ttl: request.prompt_cache_options?.ttl ?? null,
    explicit_breakpoints: input
      .flatMap(item => item.content ?? [])
      .filter(part => part.prompt_cache_breakpoint?.mode === "explicit")
      .length,
    core_hash: sha256(core),
    core_chars: core.length,
    project_hash: project === null ? null : sha256(project),
    project_chars: project === null ? null : project.length,
    suffix_hash: sha256(user),
    suffix_chars: user.length,
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function usageMetrics(payload, latencyMs) {
  const usage = payload?.usage ?? {};
  const details = usage.input_tokens_details ?? {};
  const inputTokens = finiteNumber(usage.input_tokens);
  const cacheWriteTokens = finiteNumber(details.cache_write_tokens);
  const cachedTokens = finiteNumber(details.cached_tokens);
  return {
    input_tokens: inputTokens,
    cache_write_tokens: cacheWriteTokens,
    cached_tokens: cachedTokens,
    output_tokens: finiteNumber(usage.output_tokens),
    total_tokens: finiteNumber(usage.total_tokens),
    cache_hit_ratio: inputTokens && cachedTokens !== null
      ? Number((cachedTokens / inputTokens).toFixed(6))
      : null,
    cache_write_ratio: inputTokens && cacheWriteTokens !== null
      ? Number((cacheWriteTokens / inputTokens).toFixed(6))
      : null,
    latency_ms: Math.round(latencyMs),
  };
}

export function syntheticCapsule(kind, marker, targetChars = 9_000) {
  if (kind !== "core" && kind !== "project") throw new TypeError("invalid synthetic capsule kind");
  const stableSentence = kind === "core"
    ? `Stable core ${marker}: prefer evidence, preserve privacy boundaries, and keep canonical decisions explicit. `
    : `Stable project ${marker}: use D1 as source of truth, keep derived indexes rebuildable, and report uncertainty. `;
  let content = stableSentence;
  while (content.length < targetChars) content += stableSentence;
  return JSON.stringify({
    schema: "prompt-capsule.v1",
    kind,
    sections: [{
      slot: kind === "core" ? "principles" : "current-state",
      content: content.slice(0, targetChars),
    }],
  }, null, 2);
}
