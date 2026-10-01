import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileOAuthClientProvider,
  McpOAuthCredentialError,
  mcpServerUrl,
} from "./mcp-oauth-client.mjs";

test("MCP URL construction is HTTPS-only outside loopback and targets the Access-independent OAuth path", () => {
  assert.equal(mcpServerUrl("https://brain.example").toString(), "https://brain.example/oauth-mcp");
  assert.equal(mcpServerUrl("https://brain.example/base/").toString(), "https://brain.example/base/oauth-mcp");
  assert.equal(mcpServerUrl("https://brain.example/mcp").toString(), "https://brain.example/oauth-mcp");
  assert.equal(mcpServerUrl("https://brain.example/oauth-mcp").toString(), "https://brain.example/oauth-mcp");
  assert.throws(() => mcpServerUrl("http://brain.example"), /must use HTTPS/);
  assert.throws(() => mcpServerUrl("https://user:pass@brain.example"), /must not contain credentials/);
});

test("OAuth state persists only client registration, tokens and discovery at mode 0600", async () => {
  const root = mkdtempSync(join(tmpdir(), "sbcf-mcp-oauth-"));
  const path = join(root, "credentials.json");
  try {
    const provider = await FileOAuthClientProvider.create({
      credentialFile: path,
      redirectUrl: "http://127.0.0.1:8787/callback",
      onRedirect: () => {},
      oauthState: "state-value",
    });
    await provider.saveClientInformation({ client_id: "client", client_secret: "secret" });
    await provider.saveTokens({ access_token: "access", token_type: "bearer", refresh_token: "refresh" });
    await provider.saveDiscoveryState({ authorizationServerUrl: "https://auth.example" });
    provider.saveCodeVerifier("ephemeral-verifier");

    const stored = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(stored.schema, "second-brain-mcp-oauth.v1");
    assert.equal(stored.tokens.access_token, "access");
    assert.equal(JSON.stringify(stored).includes("ephemeral-verifier"), false);
    const mode = (await import("node:fs/promises")).stat(path).then(value => value.mode & 0o777);
    assert.equal(await mode, 0o600);

    const reloaded = await FileOAuthClientProvider.create({
      credentialFile: path,
      redirectUrl: "http://127.0.0.1:8787/callback",
      onRedirect: () => {},
    });
    assert.equal(reloaded.tokens().refresh_token, "refresh");
    assert.equal(reloaded.clientInformation().client_id, "client");
    assert.equal(reloaded.discoveryState().authorizationServerUrl, "https://auth.example");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OAuth credential loading rejects permissive files, symlinks and unknown fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "sbcf-mcp-oauth-"));
  const path = join(root, "credentials.json");
  try {
    writeFileSync(path, JSON.stringify({ schema: "second-brain-mcp-oauth.v1" }), { mode: 0o644 });
    await assert.rejects(
      FileOAuthClientProvider.create({ credentialFile: path, redirectUrl: "http://127.0.0.1:8787/callback", onRedirect: () => {} }),
      error => error instanceof McpOAuthCredentialError && error.code === "unsafe_file_permissions",
    );
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify({ schema: "second-brain-mcp-oauth.v1", extra: true }));
    await assert.rejects(
      FileOAuthClientProvider.create({ credentialFile: path, redirectUrl: "http://127.0.0.1:8787/callback", onRedirect: () => {} }),
      error => error instanceof McpOAuthCredentialError && error.code === "invalid_schema",
    );
    const link = join(root, "link.json");
    symlinkSync(path, link);
    await assert.rejects(
      FileOAuthClientProvider.create({ credentialFile: link, redirectUrl: "http://127.0.0.1:8787/callback", onRedirect: () => {} }),
      error => error instanceof McpOAuthCredentialError && error.code === "unsafe_file_type",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OAuth credential loading rejects oversized stores before parsing", async () => {
  const root = mkdtempSync(join(tmpdir(), "sbcf-mcp-oauth-"));
  const path = join(root, "credentials.json");
  try {
    writeFileSync(path, Buffer.alloc((64 * 1024) + 1, 0x20), { mode: 0o600 });
    await assert.rejects(
      FileOAuthClientProvider.create({ credentialFile: path, redirectUrl: "http://127.0.0.1:8787/callback", onRedirect: () => {} }),
      error => error instanceof McpOAuthCredentialError && error.code === "file_too_large",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
