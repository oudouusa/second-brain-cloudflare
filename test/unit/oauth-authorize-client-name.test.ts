/**
 * BE-5 (T-0101.5.1): the OAuth grant records the client's registered name at
 * sign-in, so it is free to read on every later request (source 1 of
 * resolveClientLabel's fallback chain — see src/mcp/client-label.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { handleOAuthAuthorize } from "../../src/oauth/authorize";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

function envWithProvider(overrides: { lookupClient?: any } = {}): Env {
  const env = makeTestEnv();
  (env as any).OAUTH_PROVIDER = {
    parseAuthRequest: vi.fn().mockResolvedValue({ clientId: "client-1", scope: [] }),
    lookupClient: overrides.lookupClient ?? vi.fn().mockResolvedValue({ clientName: "Cursor" }),
    completeAuthorization: vi.fn().mockResolvedValue({ redirectTo: "https://client.example/cb" }),
  };
  return env;
}

function postAuthorize(password: string) {
  const form = new URLSearchParams({ password, csrf_token: "client-name-test" });
  return new Request("http://localhost/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "sb_oauth_csrf=client-name-test" },
    body: form.toString(),
  });
}

describe("handleOAuthAuthorize — client name capture", () => {
  it("props gain clientId and the client's registered name for the owner static-token sign-in", async () => {
    const env = envWithProvider();
    const res = await handleOAuthAuthorize(postAuthorize(env.AUTH_TOKEN), env);
    expect(res.status).toBe(302);
    const helpers = (env as any).OAUTH_PROVIDER;
    expect(helpers.lookupClient).toHaveBeenCalledWith("client-1");
    expect(helpers.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ props: expect.objectContaining({ userId: "owner", clientId: "client-1", clientName: "Cursor" }) }),
    );
  });

  it("props omit clientName when the client registered without one", async () => {
    const env = envWithProvider({ lookupClient: vi.fn().mockResolvedValue({ clientName: undefined }) });
    await handleOAuthAuthorize(postAuthorize(env.AUTH_TOKEN), env);
    const helpers = (env as any).OAUTH_PROVIDER;
    const props = helpers.completeAuthorization.mock.calls[0][0].props;
    expect(props.clientId).toBe("client-1");
    expect(props).not.toHaveProperty("clientName");
  });
});
