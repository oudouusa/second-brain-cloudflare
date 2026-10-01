import { createHash } from "node:crypto";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  CapsuleSourceError,
  validateCapsulePayload,
} from "./capsule-source.mjs";
import { createMcpOAuthSession } from "./mcp-oauth-client.mjs";

export const PROMPT_CAPSULE_MCP_SCHEMA = "prompt-capsule-mcp.v1";
export const MCP_OAUTH_SOURCE = "worker-mcp-oauth";
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const NONINTERACTIVE_REDIRECT = "http://127.0.0.1:8787/callback";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function assertEnvelope(value) {
  const root = asRecord(value);
  const keys = root ? Object.keys(root) : [];
  if (!root || keys.length !== 4 || !["ok", "schema", "etag", "capsule"].every(key => keys.includes(key))) {
    throw new CapsuleSourceError("invalid_mcp_envelope");
  }
  if (root.ok !== true || root.schema !== PROMPT_CAPSULE_MCP_SCHEMA) {
    throw new CapsuleSourceError("invalid_mcp_envelope");
  }
  if (typeof root.etag !== "string" || !/^"pcv1-[0-9a-f]{64}"$/.test(root.etag)) {
    throw new CapsuleSourceError("invalid_etag");
  }
  return root;
}

export function parseMcpCapsuleToolResult(result, serverUrl, options) {
  if (result.isError || !Array.isArray(result.content) || result.content.length !== 1
    || result.content[0]?.type !== "text" || typeof result.content[0].text !== "string") {
    throw new CapsuleSourceError("mcp_tool_error");
  }
  const raw = result.content[0].text;
  if (Buffer.byteLength(raw, "utf8") > MAX_TOOL_RESULT_BYTES) {
    throw new CapsuleSourceError("response_too_large");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CapsuleSourceError("invalid_json");
  }
  const envelope = assertEnvelope(parsed);
  const validated = validateCapsulePayload(envelope.capsule, options);
  const bodyText = JSON.stringify(envelope.capsule, null, 2);
  const expectedEtag = `"pcv1-${sha256(`pcv1\0${bodyText}`)}"`;
  if (envelope.etag !== expectedEtag) throw new CapsuleSourceError("etag_mismatch");
  return {
    ...validated,
    source: MCP_OAUTH_SOURCE,
    endpointHash: sha256(serverUrl.toString()),
    etagHash: sha256(envelope.etag),
  };
}

async function callCapsule(client, serverUrl, options) {
  let result;
  try {
    result = await client.callTool({
      name: "get_prompt_capsule",
      arguments: {
        kind: options.kind,
        ...(options.projectId ? { project_id: options.projectId } : {}),
        workspace: options.workspace,
        ...(options.team ? { team: options.team } : {}),
      },
    });
  } catch {
    throw new CapsuleSourceError("mcp_tool_call_failed");
  }
  return parseMcpCapsuleToolResult(result, serverUrl, options);
}

export async function fetchPromptCapsulesViaMcp({
  workerUrl,
  credentialFile,
  projectId,
  workspace = "personal",
  team,
  allowIncomplete = false,
}) {
  if (typeof credentialFile !== "string" || !credentialFile) {
    throw new CapsuleSourceError("mcp_oauth_credential_file_missing");
  }
  const session = await createMcpOAuthSession({
    workerUrl,
    credentialFile,
    redirectUrl: NONINTERACTIVE_REDIRECT,
  });
  try {
    if (!session.provider.tokens()) {
      throw new CapsuleSourceError("mcp_oauth_authorization_required");
    }
    try {
      await session.client.connect(session.transport);
    } catch (error) {
      if (error instanceof UnauthorizedError) throw new CapsuleSourceError("mcp_oauth_authorization_required");
      throw new CapsuleSourceError("mcp_connection_failed");
    }
    const common = { workspace, team, allowIncomplete };
    const core = await callCapsule(session.client, session.serverUrl, { ...common, kind: "core" });
    const project = projectId
      ? await callCapsule(session.client, session.serverUrl, { ...common, kind: "project", projectId })
      : null;
    return { core, project };
  } finally {
    await session.client.close().catch(() => {});
  }
}
