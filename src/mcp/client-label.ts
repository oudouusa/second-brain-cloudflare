import type { Env } from "../env";
import { hashToken } from "../lib/identity";

/**
 * OAuth grant props carrying the client name resolved at authorize time
 * (src/oauth/authorize.ts), or `via: "token"` for a static-bearer caller
 * (src/index.ts's resolveExternalToken), which never went through a grant and
 * so must never attempt the legacy grant lookup below.
 */
export interface McpClientProps {
  clientId?: string;
  clientName?: string;
  via?: "token";
  requestUrl?: string;
}

/** The slice of ToolCallback's `extra` this needs — see sdk shared/protocol.js. */
export interface McpClientExtra {
  _meta?: Record<string, unknown>;
  mcpReq?: { _meta?: Record<string, unknown>; envelope?: Record<string, unknown> };
  requestInfo?: { url?: string };
}

const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const MAX_CLIENT_LABEL_LENGTH = 48;

/**
 * Trim, strip control characters and angle brackets, collapse whitespace, cap
 * at 48 characters. An empty result counts as absent (BE-5 clamping rule) —
 * the value is otherwise stored raw, so "Claude" displays exactly as the
 * client registered it.
 */
function clampClientLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CLIENT_LABEL_LENGTH);
  return cleaned || null;
}

/**
 * Per-isolate memo of the legacy grant lookup (unwrapToken + lookupClient),
 * keyed by a hash of the bearer token — never the token itself. Isolates are
 * short-lived but reused across requests, so this saves the 2 KV reads on
 * every write after the first for a pre-4.0 grant.
 */
const legacyClientNameCache = new Map<string, string | null>();

/** Test-only: isolates in production never share this cache, but a test run does. */
export function __resetClientLabelCacheForTests(): void {
  legacyClientNameCache.clear();
}

async function legacyGrantClientName(env: Env, bearer: string): Promise<string | null> {
  const key = await hashToken(bearer);
  if (legacyClientNameCache.has(key)) return legacyClientNameCache.get(key)!;
  let name: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = (env as any).OAUTH_PROVIDER;
    const summary = await provider?.unwrapToken?.(bearer);
    const clientId = summary?.grant?.clientId;
    if (clientId) {
      const client = await provider?.lookupClient?.(clientId);
      name = clampClientLabel(client?.clientName);
    }
  } catch (e) {
    console.error("legacy OAuth client lookup failed (non-fatal):", e);
  }
  legacyClientNameCache.set(key, name);
  return name;
}

function clientNameFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return clampClientLabel(new URL(rawUrl).searchParams.get("client"));
  } catch {
    return null;
  }
}

/**
 * Resolve a client label for the calling AI tool, first match wins (spec BE-5):
 *   1. The OAuth grant's own `clientName`, set at authorize time from the
 *      client's DCR registration — free, no lookup.
 *   2. A legacy grant (pre-4.0, no stored clientName): one `unwrapToken` plus
 *      one `lookupClient`, memoized per isolate. Skipped outright for a
 *      static-bearer caller (`props.via === "token"`), which never held a
 *      grant to look up.
 *   3. `_meta["io.modelcontextprotocol/clientInfo"].name`, self-reported by
 *      clients on the 2026-07-28 MCP spec revision.
 *   4. `?client=` on the request URL, for static-bearer setups that cannot
 *      carry a grant or send `_meta` (e.g. Claude Desktop via mcp-remote).
 *   5. `null` — the caller renders "an AI tool".
 */
export async function resolveClientLabel(
  props: McpClientProps | undefined,
  extra: McpClientExtra | undefined,
  env: Env,
  bearer: string | null,
): Promise<string | null> {
  const fromGrant = clampClientLabel(props?.clientName);
  if (fromGrant) return fromGrant;

  if (props?.via !== "token" && bearer) {
    const fromLegacyGrant = await legacyGrantClientName(env, bearer);
    if (fromLegacyGrant) return fromLegacyGrant;
  }

  const meta = (extra?.mcpReq?.envelope?.[CLIENT_INFO_META_KEY] ?? extra?.mcpReq?._meta?.[CLIENT_INFO_META_KEY] ?? extra?._meta?.[CLIENT_INFO_META_KEY]) as { name?: unknown } | undefined;
  const fromMeta = clampClientLabel(meta?.name);
  if (fromMeta) return fromMeta;

  const fromUrl = clientNameFromUrl(extra?.requestInfo?.url ?? props?.requestUrl);
  if (fromUrl) return fromUrl;

  return null;
}
