import {
  CapsuleSourceError,
  PROMPT_CAPSULE_MIME,
  capsuleEndpoint,
  fetchPromptCapsule,
  sha256,
} from "./capsule-source.mjs";

export const PROMPT_CAPSULE_REVALIDATION_VERSION = "prompt-capsule-revalidation.v1";

const MAX_RESPONSE_BYTES = 64 * 1024;

function isStrongEtag(value) {
  return typeof value === "string"
    && !value.startsWith("W/")
    && /^"[^"\r\n]+"$/.test(value);
}

async function readBoundedText(response) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CapsuleSourceError("response_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CapsuleSourceError("response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Hold one authenticated Prompt Capsule representation in memory and revalidate
 * it with If-None-Match. The exact Capsule and raw ETag never appear in the
 * descriptor returned for logging.
 *
 * One instance is permanently bound to one Worker target and one credential
 * mode. This prevents a cached personal Capsule from being reused after an
 * identity or workspace switch. Call clear() when the surrounding credential
 * is retired.
 */
export function createPromptCapsuleRevalidator({
  workerUrl,
  kind,
  projectId,
  workspace = "personal",
  team,
  authMode = "bearer",
  authToken,
  accessToken,
  allowIncomplete = false,
  fetchImpl = fetch,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  // capsuleEndpoint validates the immutable target before any network request.
  const endpoint = capsuleEndpoint({ workerUrl, kind, projectId, workspace, team, authMode });
  const targetHash = sha256(endpoint.toString());
  let snapshot = null;
  let generation = 0;
  let epoch = 0;
  let refreshQueue = Promise.resolve();

  return {
    version: PROMPT_CAPSULE_REVALIDATION_VERSION,
    targetHash,
    get hasSnapshot() {
      return snapshot !== null;
    },
    clear() {
      snapshot = null;
      generation = 0;
      epoch += 1;
    },
    async refresh() {
      const refreshEpoch = epoch;
      const previousRefresh = refreshQueue;
      let releaseRefresh;
      refreshQueue = new Promise(resolve => { releaseRefresh = resolve; });
      await previousRefresh;
      try {
        if (epoch !== refreshEpoch) throw new CapsuleSourceError("revalidation_cleared");
        const previous = snapshot;
        let staged = null;
        let upstreamStatus = null;
        let reused = false;
        const startedAt = performance.now();

        const result = await fetchPromptCapsule({
          workerUrl,
          kind,
          projectId,
          workspace,
          team,
          authMode,
          authToken,
          accessToken,
          allowIncomplete,
          fetchImpl: async (url, init = {}) => {
            const headers = new Headers(init.headers);
            if (previous) headers.set("If-None-Match", previous.etag);

            const response = await fetchImpl(url, { ...init, headers });
            upstreamStatus = response.status;

            if (response.status === 304) {
              if (!previous) {
                await response.body?.cancel();
                throw new CapsuleSourceError("not_modified_without_snapshot");
              }
              const etag = response.headers.get("ETag");
              if (!isStrongEtag(etag) || etag !== previous.etag) {
                await response.body?.cancel();
                throw new CapsuleSourceError("not_modified_etag_mismatch");
              }
              await response.body?.cancel();
              reused = true;
              return new Response(previous.body, {
                status: 200,
                headers: {
                  "Content-Type": PROMPT_CAPSULE_MIME,
                  ETag: previous.etag,
                },
              });
            }

            if (!response.ok) return response;

            const body = await readBoundedText(response);
            const responseHeaders = new Headers(response.headers);
            // fetch() may have transparently decoded the body. Do not carry stale
            // transport framing into the reconstructed validation response.
            responseHeaders.delete("Content-Encoding");
            responseHeaders.delete("Content-Length");
            responseHeaders.delete("Transfer-Encoding");
            staged = {
              body,
              etag: responseHeaders.get("ETag"),
            };
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: responseHeaders,
            });
          },
        });

        if (epoch !== refreshEpoch) throw new CapsuleSourceError("revalidation_cleared");

        let revalidation;
        if (reused) {
          revalidation = "not-modified";
        } else {
          if (!staged || !isStrongEtag(staged.etag)) {
            // fetchPromptCapsule should already have rejected this. Keep an
            // explicit invariant so a future refactor cannot cache an unvalidated
            // representation.
            throw new CapsuleSourceError("invalid_revalidation_state");
          }
          const sameRepresentation = previous
            && previous.etag === staged.etag
            && previous.promptHash === result.promptHash;
          snapshot = {
            body: staged.body,
            etag: staged.etag,
            promptHash: result.promptHash,
          };
          generation += 1;
          revalidation = previous
            ? (sameRepresentation ? "refreshed" : "modified")
            : "initial";
        }

        return {
          ...result,
          revalidation,
          httpStatus: upstreamStatus,
          generation,
          latencyMs: Math.round(performance.now() - startedAt),
        };
      } finally {
        releaseRefresh();
      }
    },
  };
}

/** Return only fields safe for JSONL operational evidence. */
export function capsuleRefreshDescriptor(result) {
  if (!result || typeof result !== "object") throw new TypeError("result is required");
  return {
    version: PROMPT_CAPSULE_REVALIDATION_VERSION,
    revalidation: result.revalidation,
    http_status: result.httpStatus,
    generation: result.generation,
    source: result.source,
    prompt_hash: result.promptHash,
    prompt_chars: result.charCount,
    complete: result.complete,
    endpoint_hash: result.endpointHash,
    etag_hash: result.etagHash,
    latency_ms: result.latencyMs,
  };
}
