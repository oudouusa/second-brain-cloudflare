import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const STORE_SCHEMA = "second-brain-mcp-oauth.v1";
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const STORE_KEYS = new Set(["schema", "client_information", "tokens", "discovery_state"]);

export class McpOAuthCredentialError extends Error {
  constructor(code) {
    super(`MCP OAuth credential store failed: ${code}`);
    this.name = "McpOAuthCredentialError";
    this.code = code;
  }
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

async function loadStore(path) {
  if (!isAbsolute(path)) throw new McpOAuthCredentialError("path_must_be_absolute");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error?.code === "ELOOP") throw new McpOAuthCredentialError("unsafe_file_type");
    throw new McpOAuthCredentialError("read_failed");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new McpOAuthCredentialError("unsafe_file_type");
    if ((stat.mode & 0o077) !== 0) throw new McpOAuthCredentialError("unsafe_file_permissions");
    if (stat.size > MAX_CREDENTIAL_BYTES) throw new McpOAuthCredentialError("file_too_large");
    // Read through the already-open, no-follow descriptor and cap the actual
    // allocation. This stays bounded even if the file grows after fstat().
    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_CREDENTIAL_BYTES) throw new McpOAuthCredentialError("file_too_large");
    let parsed;
    try {
      parsed = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new McpOAuthCredentialError("invalid_json");
    }
    const root = asRecord(parsed);
    if (!root || root.schema !== STORE_SCHEMA || !exactKeys(root, STORE_KEYS)) {
      throw new McpOAuthCredentialError("invalid_schema");
    }
    for (const key of ["client_information", "tokens", "discovery_state"]) {
      if (root[key] !== undefined && !asRecord(root[key])) {
        throw new McpOAuthCredentialError("invalid_schema");
      }
    }
    return {
      clientInformation: root.client_information,
      tokens: root.tokens,
      discoveryState: root.discovery_state,
    };
  } catch (error) {
    if (error instanceof McpOAuthCredentialError) throw error;
    throw new McpOAuthCredentialError("read_failed");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function persistStore(path, state) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({
    schema: STORE_SCHEMA,
    ...(state.clientInformation ? { client_information: state.clientInformation } : {}),
    ...(state.tokens ? { tokens: state.tokens } : {}),
    ...(state.discoveryState ? { discovery_state: state.discoveryState } : {}),
  }, null, 2);
  if (Buffer.byteLength(body, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw new McpOAuthCredentialError("file_too_large");
  }
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error instanceof McpOAuthCredentialError) throw error;
    throw new McpOAuthCredentialError("write_failed");
  }
}

export class FileOAuthClientProvider {
  static async create({ credentialFile, redirectUrl, onRedirect, oauthState = randomUUID() }) {
    const state = await loadStore(credentialFile);
    return new FileOAuthClientProvider({ credentialFile, redirectUrl, onRedirect, oauthState, state });
  }

  constructor({ credentialFile, redirectUrl, onRedirect, oauthState, state }) {
    this.credentialFile = credentialFile;
    this._redirectUrl = redirectUrl;
    this.onRedirect = onRedirect;
    this.oauthState = oauthState;
    this.stored = state;
    this.verifier = null;
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: "Second Brain Prompt Capsule Gateway",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  state() {
    return this.oauthState;
  }

  clientInformation() {
    return this.stored.clientInformation;
  }

  async saveClientInformation(value) {
    this.stored.clientInformation = value;
    await persistStore(this.credentialFile, this.stored);
  }

  tokens() {
    return this.stored.tokens;
  }

  async saveTokens(value) {
    this.stored.tokens = value;
    await persistStore(this.credentialFile, this.stored);
  }

  redirectToAuthorization(url) {
    this.onRedirect(url);
  }

  saveCodeVerifier(value) {
    this.verifier = value;
  }

  codeVerifier() {
    if (!this.verifier) throw new McpOAuthCredentialError("code_verifier_missing");
    return this.verifier;
  }

  clearCodeVerifier() {
    this.verifier = null;
  }

  async saveDiscoveryState(value) {
    this.stored.discoveryState = value;
    await persistStore(this.credentialFile, this.stored);
  }

  discoveryState() {
    return this.stored.discoveryState;
  }

  async invalidateCredentials(scope) {
    if (scope === "all" || scope === "client") this.stored.clientInformation = undefined;
    if (scope === "all" || scope === "tokens") this.stored.tokens = undefined;
    if (scope === "all" || scope === "discovery") this.stored.discoveryState = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = null;
    await persistStore(this.credentialFile, this.stored);
  }
}

export function mcpServerUrl(workerUrl) {
  let url;
  try {
    url = new URL(workerUrl);
  } catch {
    throw new TypeError("workerUrl must be an absolute URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TypeError("workerUrl must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("workerUrl must not contain credentials, query parameters, or a fragment");
  }
  let prefix = url.pathname.replace(/\/+$/, "");
  for (const suffix of ["/oauth-mcp", "/mcp"]) {
    if (prefix.endsWith(suffix)) {
      prefix = prefix.slice(0, -suffix.length);
      break;
    }
  }
  url.pathname = `${prefix}/oauth-mcp`;
  return url;
}

export async function createMcpOAuthSession({
  workerUrl,
  credentialFile,
  redirectUrl,
  onRedirect = () => {},
  oauthState = randomUUID(),
}) {
  const serverUrl = mcpServerUrl(workerUrl);
  const provider = await FileOAuthClientProvider.create({ credentialFile, redirectUrl, onRedirect, oauthState });
  const client = new Client({ name: "second-brain-prompt-capsule", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });
  return { client, transport, provider, serverUrl };
}
