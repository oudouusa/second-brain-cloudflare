import type { Config } from "../config";
import { QUERY_SIGNAL_CACHE_TTL_SECONDS } from "../constants";
import { EMBEDDING_PROFILE } from "../embedding/profile";
import type { Env } from "../env";
import type { EmbeddingQueryMode } from "./query-profile";

const CACHE_VERSION = 1;
export const QUERY_SIGNAL_CACHE_PREFIX = `recall:query-signals:v${CACHE_VERSION}:`;

export interface QuerySignalCacheInput {
  denseInput: string;
  lexicalQuery: string;
  tag?: string;
  embeddingMode: EmbeddingQueryMode;
  /** Readable-workspace partition for vocabulary-derived query tags. */
  scopeKey?: string;
}

export interface QuerySignals {
  values: number[];
  queryTags: string[];
}

interface CachedQuerySignals extends QuerySignals {
  version: number;
  embeddingProfileId: string;
  embeddingDimensions: number;
  embeddingPromptVersion: number;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

/**
 * An HMAC keeps private recall text out of both the KV key and value. Including
 * every model/profile input makes a settings or embedding migration an automatic
 * cache miss; rotating AUTH_TOKEN invalidates the namespace without a KV scan.
 */
async function cacheKey(
  input: Readonly<QuerySignalCacheInput>,
  env: Env,
  config: Readonly<Config>,
): Promise<string | null> {
  if (!env.AUTH_TOKEN) return null;
  const secret = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const material = JSON.stringify({
    version: CACHE_VERSION,
    embeddingProfileId: EMBEDDING_PROFILE.profileId,
    embeddingPromptVersion: EMBEDDING_PROFILE.promptVersion,
    embeddingMode: input.embeddingMode,
    embeddingModel: config.EMBEDDING_MODEL,
    tagInferenceModel: config.LLM_MODEL,
    denseInput: input.denseInput,
    lexicalQuery: input.lexicalQuery,
    tag: input.tag?.trim().toLowerCase() || null,
    scopeKey: input.scopeKey ?? null,
  });
  const digest = await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(material));
  return `${QUERY_SIGNAL_CACHE_PREFIX}${bytesToHex(digest)}`;
}

function parseCachedSignals(raw: string): QuerySignals | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CachedQuerySignals>;
    if (parsed.version !== CACHE_VERSION
      || parsed.embeddingProfileId !== EMBEDDING_PROFILE.profileId
      || parsed.embeddingDimensions !== EMBEDDING_PROFILE.dimensions
      || parsed.embeddingPromptVersion !== EMBEDDING_PROFILE.promptVersion
      || !Array.isArray(parsed.values)
      || parsed.values.length !== EMBEDDING_PROFILE.dimensions
      || parsed.values.some(value => typeof value !== "number" || !Number.isFinite(value))
      || !Array.isArray(parsed.queryTags)
      || parsed.queryTags.length > 50
      || parsed.queryTags.some(tag => typeof tag !== "string" || tag.length > 256)) {
      return null;
    }
    return { values: parsed.values, queryTags: parsed.queryTags } as QuerySignals;
  } catch {
    return null;
  }
}

/** Cache failures always degrade to the unchanged Workers AI path. */
export async function readQuerySignalCache(
  input: Readonly<QuerySignalCacheInput>,
  env: Env,
  config: Readonly<Config>,
): Promise<QuerySignals | null> {
  try {
    const key = await cacheKey(input, env, config);
    if (!key) return null;
    const raw = await env.OAUTH_KV.get(key);
    return raw ? parseCachedSignals(raw) : null;
  } catch (error) {
    console.error("Recall query-signal cache read failed (non-fatal):", error);
    return null;
  }
}

/**
 * Stores derived numeric/tag signals only. Query text and memory content are
 * deliberately absent; expiration bounds stale ranking hints and KV storage.
 */
export async function writeQuerySignalCache(
  input: Readonly<QuerySignalCacheInput>,
  signals: Readonly<QuerySignals>,
  env: Env,
  config: Readonly<Config>,
): Promise<void> {
  try {
    const key = await cacheKey(input, env, config);
    if (!key) return;
    const value: CachedQuerySignals = {
      version: CACHE_VERSION,
      embeddingProfileId: EMBEDDING_PROFILE.profileId,
      embeddingDimensions: EMBEDDING_PROFILE.dimensions,
      embeddingPromptVersion: EMBEDDING_PROFILE.promptVersion,
      values: [...signals.values],
      queryTags: [...signals.queryTags],
    };
    await env.OAUTH_KV.put(key, JSON.stringify(value), {
      expirationTtl: QUERY_SIGNAL_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.error("Recall query-signal cache write failed (non-fatal):", error);
  }
}
