import { timingSafeEqual } from "node:crypto";

// Cloudflare extends SubtleCrypto with timingSafeEqual. Node's Web Crypto does
// not expose that extension, so mirror it in the Node-based test environment.
if (!("timingSafeEqual" in crypto.subtle)) {
  const asBytes = (value: ArrayBuffer | ArrayBufferView) => value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) =>
      timingSafeEqual(asBytes(a), asBytes(b)),
    configurable: true,
  });
}
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, vi } from "vitest";

// Each test file gets its own temp root under the run's (see vitest.global-setup.ts) and fails if it leaves
// anything in it, after removing what it left so one leak cannot fill /tmp.
const runRoot = process.env.SB_TEST_TMP_ROOT;
let fileRoot: string | undefined;
beforeAll(() => {
  if (!runRoot) return;
  fileRoot = mkdtempSync(join(runRoot, "f-"));
  process.env.TMPDIR = fileRoot;
});
afterAll(() => {
  if (!runRoot || !fileRoot) return;
  process.env.TMPDIR = runRoot;
  const left = readdirSync(fileRoot);
  rmSync(fileRoot, { recursive: true, force: true });
  if (left.length) throw new Error(`this file leaked ${left.length} temp entries (first: ${left.slice(0, 10).join(", ")}); remove what a test creates in afterEach/afterAll or a finally`);
});


vi.mock("agents/mcp", () => ({
  createMcpHandler: vi.fn().mockReturnValue(() => new Response("mcp")),
}));

// The IMAP client imports `cloudflare:sockets` (connect()), which the node test
// loader can't resolve. Stub it so modules that transitively import imap.ts
// load; the email tests inject a fake socket rather than calling connect().
vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(() => {
    throw new Error("cloudflare:sockets connect() is not available in tests");
  }),
}));

// workers-oauth-provider and the MCP executor import `cloudflare:workers`,
// which the node test loader can't resolve. Stub the Durable Object base plus
// a minimal router that mirrors the real
// provider's behaviour for tests: delegate non-apiRoute requests to the
// defaultHandler, and gate the apiRoute with resolveExternalToken (the static
// AUTH_TOKEN path) so the existing auth tests still pass.
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthProvider: class {
    options: any;
    constructor(options: any) { this.options = options; }
    async fetch(request: Request, env: any, ctx: any): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          registration_endpoint: this.options.clientRegistrationEndpoint
            ? new URL(this.options.clientRegistrationEndpoint, url).toString()
            : undefined,
          // The config-level strict-public requirement has its own regression
          // test; this mirrors the provider option so accidental CIMD opt-in is
          // observable in Node tests without a Cloudflare runtime global.
          client_id_metadata_document_supported: !!this.options.clientIdMetadataDocumentEnabled,
        });
      }
      if (url.pathname === this.options.apiRoute) {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const grant = token ? await this.options.resolveExternalToken?.({ token, env }) : null;
        if (!grant) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401, headers: { "Content-Type": "application/json" },
          });
        }
        return this.options.apiHandler.fetch(request, env, ctx);
      }
      return this.options.defaultHandler.fetch(request, env, ctx);
    }
  },
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class<Env> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
