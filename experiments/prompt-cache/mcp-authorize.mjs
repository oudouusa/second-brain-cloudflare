#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpOAuthSession, mcpServerUrl } from "./mcp-oauth-client.mjs";

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

class McpAuthorizationError extends Error {
  constructor(code) {
    super(`MCP authorization failed: ${code}`);
    this.name = "McpAuthorizationError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseArgs(argv) {
  const options = { workerUrl: null, credentialFile: null, callbackPort: 8787, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new McpAuthorizationError("missing_argument_value");
      return value;
    };
    if (arg === "--worker-url") options.workerUrl = next();
    else if (arg === "--credential-file") options.credentialFile = next();
    else if (arg === "--callback-port") options.callbackPort = Number(next());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new McpAuthorizationError("unknown_argument");
  }
  if (options.help) return options;
  if (!options.workerUrl) throw new McpAuthorizationError("worker_url_required");
  if (!options.credentialFile) throw new McpAuthorizationError("credential_file_required");
  if (!Number.isInteger(options.callbackPort) || options.callbackPort < 1 || options.callbackPort > 65_535) {
    throw new McpAuthorizationError("invalid_callback_port");
  }
  mcpServerUrl(options.workerUrl);
  return options;
}

function printHelp() {
  process.stdout.write(
    "Usage: node experiments/prompt-cache/mcp-authorize.mjs --worker-url URL --credential-file ABSOLUTE_PATH [options]\n\n" +
    "Authorize this host directly against the Worker's Managed OAuth MCP boundary.\n" +
    "The resulting refreshable OAuth credential is stored mode 0600 and is never printed.\n\n" +
    "Options:\n" +
    "  --callback-port N       Loopback callback port (default: 8787)\n",
  );
}

function callbackListener(port, expectedState) {
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error || !code || state !== expectedState) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end("<!doctype html><title>Authorization failed</title><h1>Authorization failed</h1>");
      settle.reject(new McpAuthorizationError(error ? "provider_rejected" : "invalid_callback"));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end("<!doctype html><title>Authorization complete</title><h1>Authorization complete</h1><p>You may close this window.</p>");
    settle.resolve(code);
  });
  const timeout = setTimeout(() => settle.reject(new McpAuthorizationError("callback_timeout")), CALLBACK_TIMEOUT_MS);
  return {
    result,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    },
    async close() {
      clearTimeout(timeout);
      if (!server.listening) return;
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const redirectUrl = `http://127.0.0.1:${options.callbackPort}/callback`;
  const oauthState = randomUUID();
  const callback = callbackListener(options.callbackPort, oauthState);
  let session = null;
  let authorizationUrl = null;
  try {
    await callback.listen();
    session = await createMcpOAuthSession({
      workerUrl: options.workerUrl,
      credentialFile: options.credentialFile,
      redirectUrl,
      oauthState,
      onRedirect: url => {
        authorizationUrl = url;
        process.stderr.write(`Open this one-time authorization URL in a browser:\n${url.toString()}\n`);
      },
    });
    try {
      await session.client.connect(session.transport);
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !authorizationUrl) {
        throw new McpAuthorizationError("connection_failed");
      }
      const code = await callback.result;
      await session.transport.finishAuth(code);
      session.provider.clearCodeVerifier();
      const retry = await createMcpOAuthSession({
        workerUrl: options.workerUrl,
        credentialFile: options.credentialFile,
        redirectUrl,
      });
      try {
        await retry.client.connect(retry.transport);
      } finally {
        await retry.client.close().catch(() => {});
      }
    }
    process.stdout.write(`${JSON.stringify({
      authorized: true,
      server_hash: sha256(session.serverUrl.toString()),
      credential_store: "oauth-0600",
    })}\n`);
  } finally {
    await callback.close();
    await session?.client.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({
      event: "mcp_oauth_authorization_error",
      code: error instanceof McpAuthorizationError ? error.code : error?.code ?? "invalid_cli_or_runtime",
    })}\n`);
    process.exitCode = 1;
  });
}
