# Optional direct ChatGPT connection and upstream proposal

Connect to the public Responses API through OAuth only after the owner explicitly authorizes the connection and its scope. Workers AI remains the default. This does not depend on an API key, ChatGPT backend-api, VPS, or CLIProxy. The initial upstream proposal is limited to **the deployment owner's personal workspace**. Team, member, another admin's personal workspace, unknown scopes, and mixed scopes cannot consume the owner's plan.

The implementation follows [Sign in with ChatGPT for open source](https://developers.openai.com/siwc/token-sharing-open-source) and the [public Responses specification](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference). OpenAI directs paid or remotely hosted apps to a separate application process. A successful connection from a personal Worker does not establish eligibility for a publicly hosted or commercial service. Treating one Worker as one host applies the [self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) to Workers; it is a design judgment, not Workers-specific official approval.

PR #117 was deployed on 2026-10-01, removing the VPC binding, private adapter, and legacy API-key requirement. Generation callers now connect directly to public Responses. Legacy secrets were also removed from that production deployment. See [DEPLOYMENT.md](DEPLOYMENT.md) for preservation and verification procedures; individual deployment records belong in owner-controlled storage. Removing code dependencies does not establish that external resources have been shut down.

## Setup and explicit enablement

`CHATGPT_OPERATIONS` and `CHATGPT_OWNER_WORKSPACE_ID` default to empty in `wrangler.jsonc`. `CHATGPT_CREDENTIAL_KEY` is optional and is not required for normal startup or Workers AI. Only for direct access, configure a key containing 32 random bytes encoded as base64. Pass the key and owner token from protected files; do not expose secrets in logs, Git, or command arguments. Follow [DEPLOYMENT.md](DEPLOYMENT.md) for account checks, Time Travel, and version preservation.

The following example is for Linux/macOS. Safely store this Worker's existing AUTH_TOKEN in `owner-token` first. Node.js 22 or later is required; systemd, sudo, and VPS access are not. Verify your Wrangler profile, account, and Worker. Include the profile selection described in `DEPLOYMENT.md`. Windows uses the same Node CLI; restrict token and configuration directory ACLs to the owner. The CLI checks POSIX token-file permissions but does not automatically validate Windows ACLs.

```sh
umask 077
mkdir -p "$HOME/.config/second-brain-cf"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' \
  > "$HOME/.config/second-brain-cf/credential-key"
sb_cf_profile=your-profile
npx --yes wrangler@4.146.0 secret put CHATGPT_CREDENTIAL_KEY --profile "$sb_cf_profile" --config wrangler.personal.jsonc \
  < "$HOME/.config/second-brain-cf/credential-key"

sb_worker_url=https://your-brain.workers.dev
sb_token_file="$HOME/.config/second-brain-cf/owner-token"
chmod 600 "$sb_token_file"
node scripts/chatgpt-auth.mjs login --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file"
node scripts/chatgpt-auth.mjs import --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file"
node scripts/chatgpt-auth.mjs status --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file"
node scripts/chatgpt-auth.mjs models --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file"
node scripts/chatgpt-auth.mjs probe --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file" --model gpt-5.6-luna
node scripts/chatgpt-auth.mjs enable --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file" --operations answer
```

Open the 127.0.0.1 page printed by login in a browser on the machine running the listener, then choose `Continue with ChatGPT`. The page shows the target Worker, profile, explanation of plan usage, and usage-management link. The OpenAI authorization URL can contain a reauthentication ID-token hint, so it is not printed to the terminal or logs. The callback is `/auth/callback` on 127.0.0.1, using port 1455 by default; change it with `--port`.

`status` returns the connected client/subject, signed display information, connection state, owner workspace, and current settings. `models` returns displayable entries from the catalog fetched with the same access token, in server order. Current quality qualification covers only Luna/Terra; new catalog models are not adopted automatically. `enable` checks the catalog and allowed models and **only prints suggested configuration**. It does not run inference, enable the provider, or deploy. The default suggestion is `answer` only. Copy the returned `CHATGPT_OWNER_WORKSPACE_ID` and operation selection to ignored `wrangler.personal.jsonc`, check a probe for the selected model, and enable through the normal deployment procedure. Selecting persistence decisions also requires a Terra probe.

## Scope and operation selection

| Setting or operation | Behavior |
| --- | --- |
| Empty `CHATGPT_OPERATIONS` | Normal Workers AI; connection management and explicit probes remain available |
| Empty `CHATGPT_OWNER_WORKSPACE_ID` | ChatGPT is not used for normal generation |
| Explicitly owner-personal operation | Only selected operations use ChatGPT |
| Team, member, other admin, unknown, or mixed scope | Normal Workers AI; the owner's plan is not used even when the operation is selected |
| Failure of a selected personal operation | Preserve the existing skip-persistence, retry, or 503 contract; do not automatically resend through another provider |

Supported settings are `classify,query-tags,smart-merge,contradiction,recall-summary,digest,answer,weekly-insight`. In current 4.0 code, query-tags only matches known tags and does not generate text. Keep the setting name and budget compatibility; this proposal does not restore tag inference. `classify`, `recall-summary`, and `answer` use `CHATGPT_MODEL`, defaulting to Luna. `smart-merge`, `contradiction`, `digest`, and `weekly-insight` use fixed Terra. Unselected or ineligible operations, fixed Gemma128, and existing rerankers continue using Workers AI.

Scope comes from authenticated HTTP/MCP identity, capture/mirror WriteContext, or the actual rows processed by nightly work. The encrypted session is also bound to the actual owner workspace. A configuration pointing to another workspace is rejected before refresh or Responses dispatch. Internal `CHATGPT_WORKSPACE_ID` is not a binding and is never taken from request headers or JSON. Scoping Env preserves KV, D1 budgets, and hidden write admission.

`POST /chat` selects ChatGPT only for `workspace:"personal"` from the authenticated owner. It ignores client-built `memories`, entry IDs, and receipts as evidence: the server runs the existing `recallEntries` pipeline for that owner's personal workspace, with `synthesize:false`, five results, one graph hop, and the supplied tag/project filters. Existing D1 workspace, held-row, deletion, and validity predicates apply. Empty results return `409` with `code:"no_personal_memories"` before answer generation; search or generation failure does not fall back to client context or Workers AI.

The answer stream begins with a `data:` JSON event `{type:"sources",sources:[...]}` containing the exact selected source text and citation order. The dashboard replaces its earlier search cards with these sources, requires both sources and completion before retaining an answer, and shows “Using ChatGPT plan” and [Manage usage](https://chatgpt.com/settings/usage). A source removed or moved before the answer's retrieval is excluded. Retrieval establishes a read-time snapshot: a later mutation cannot retract content already read or sent to the provider, and no lock spans inference. The user's question remains user-supplied text; this is a provenance guarantee for retrieved memory context, not for the question itself. Workers AI retains its existing client-context contract.

This adds a second bounded retrieval for ChatGPT answers after the dashboard's initial search. It stays inside the existing executor DO and adds no synthesis pass, binding, dependency, or persistent authorization receipt. Local synthetic tests establish isolation and stream behavior, not production latency, billed D1 rows, or OpenAI eligibility.

## Registration and credentials

Generate fresh state, nonce, and PKCE on every login, following the [sign-in procedure](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). Register through the dynamic client only on first use and retain the issued client ID. Reauthentication for the same profile preserves that client ID and the signature-verified subject. Do not use email as the registration or workspace identifier.

The Worker saves a UUID host ID once in D1 `chatgpt_host`. The CLI authenticates for that ID; import accepts only credentials matching the target Worker's ID. Changing terminals, switching accounts, or disconnecting does not regenerate it. Credential-management tables are created through runtime DDL during owner administration, without changing the memory schema/version.

Local storage is `~/.config/second-brain-cf/hosts/<SHA-256 of Worker origin>/profiles/<profile>/`. Select the root with `--config-dir` and registration with `--profile`. `registration.json` retains the client, verified subject, display information, retained ID hint, and Worker host. `pending.json` holds credentials before transfer and is removed after import confirms Worker persistence. Files are written atomically with mode 0600; directories use 0700. Login/import/disconnect for the same profile are serialized with operation.lock. After a forced termination, verify that no CLI is operating on that profile before deleting only operation.lock. If transfer outcome is uncertain, inspect the connected account with status and reauthenticate rather than refreshing an old pending credential. No private URL or systemd-creds storage is used implicitly; specify the target and token file.

Use `profiles` to inspect registrations and `login --profile another` to add a separate one. Different client/subject pairs remain separate even for the same email. The Worker currently has one active session; switching requires login → import for the selected profile. Do not use an old refresh token on the terminal after transfer. Keeping multiple inactive account credentials in the Worker for immediate UI switching is outside this initial proposal. A valid ID token without plan-usage scope retains identity but does not create inference credentials. Use `login --consent` for the selected profile to obtain consent again.

The Worker also verifies ID/access token signatures, issuer, audience, expiry, initial nonce, and direct grant. Access, refresh, and ID tokens plus account information are AES-GCM encrypted in D1 `chatgpt_session`. Status, logs, and normal brain-v5 exports exclude credentials. D1 snapshots and Time Travel retain ciphertext and host ID; the ciphertext is decryptable with the key.

## Refresh, disconnect, and recovery

The Worker alone owns refreshes. D1 CAS serializes rotation and atomically replaces tokens, expiry, and grant. A refreshed ID token is checked for signature, issuer, audience, subject, and expiry without requiring the initial nonce. Do not resend an uncertain refresh using the old refresh token.

- `refresh_in_progress`: wait for the other request's refresh, then retry.
- `reauth_required`, interrupted refresh, or lost response: login → import for the selected profile. A delayed old refresh cannot overwrite the new revision.
- Usage limit or unavailability: open usage management and check consent and limits. Do not bypass them through another route.
- Lost key or Time Travel restore: reauthenticate using the recovered correct key or a new key instead of reusing old tokens. Do not overwrite the key during normal deployment.

To stop, deploy with empty `CHATGPT_OPERATIONS`, then run `disconnect` for the selected profile. The CLI checks the Worker's active client against the profile and includes the target client in DELETE. Disconnect sends the refresh token to the discovered revocation endpoint on the OpenAI origin and removes ciphertext. `revoked:false` means remote revocation is unconfirmed; remove the connection in usage management or ChatGPT settings. Local pending credentials and ID hints are also removed; client/subject registration and Worker host remain. A concurrent new authentication revision is not deleted.

Sessions predating this change lack owner binding and account display information. **Disable direct generation, fetch the Worker host with the new CLI, reauthenticate and import, then re-enable.** The CLI does not implicitly migrate or resend old files or inference credentials. Even when explicitly retaining only an issued client and verified subject from the selected registration, reauthenticate to verify signatures and grant. Consult [DEPLOYMENT.md](DEPLOYMENT.md) and the actual deployment readback for production migration and settings.

Public HTTP calls reject 3xx responses and do not forward credentials to another origin. Responses requests use `store:false`, `stream:true`, and `developer/user`. They omit preview-unsupported `max_output_tokens` and temperature. Validate SSE through completion; incomplete streams, mid-stream failure, invalid JSON, and oversized bodies must not count as success. Local character limits, the 256 KiB SSE limit, and 15/25-second deadlines are not caps on plan consumption or generated token counts.

## Upstream proposal draft

Published as [upstream issue #384](https://github.com/rahilp/second-brain-cloudflare/issues/384).

### Proposal: optional ChatGPT plan usage for owner-only dashboard answers

#### Summary

Would an optional ChatGPT provider for the built-in dashboard's answers be useful?
An owner who already has an eligible ChatGPT plan could explicitly authorize
Second Brain to use that plan through Sign in with ChatGPT and the public
Responses API. Workers AI would remain the default, with no sign-in required.

The benefit is an additional inference option for the dashboard. I am not claiming
better answer quality, lower cost, or lower latency without a paired evaluation.
This is a design discussion, not a ready-to-merge upstream implementation.

#### Initial scope

- Disabled by default; explicitly enabled by the deployment owner.
- Dashboard answer generation only, using the owner's personal workspace.
- No team/member usage, background classification, merges, or nightly jobs.
- Preserve MCP recall without server-side synthesis, as in [#219](https://github.com/rahilp/second-brain-cloudflare/pull/219).
- No access to ChatGPT conversation history. No changes to search, embeddings,
  memory storage, the desktop installer, or existing authentication.

The fork now establishes personal retrieval scope on the server for answers.
An upstream patch should retain that boundary: client-supplied workspace labels
and memory text are not provenance evidence. Hosting eligibility still requires confirmation.

#### Authentication and inference boundaries

- Bind one active credential session to the deployment owner. Keep a stable,
  opaque host ID and separate registrations by Worker origin and account profile.
- Complete OAuth locally with state, nonce, PKCE and signed ID-token validation;
  securely transfer credentials to the owner-authenticated Worker. Let the Worker
  own refreshes, with encrypted D1 storage and conditional updates preventing
  stale refreshes or disconnects from overwriting a newer session.
- Use the signed-in account's model catalog and an explicitly qualified model
  allowlist. Missing models must produce an actionable error.
- Call the public Responses endpoint with `store: false` and `stream: true`.
  Require `response.completed`; interrupted or failed streams must not leave a
  partial answer presented as complete. Bound response size and request lifetime.
- Show the active provider and a Manage usage link using existing translations.
  Distinguish usage limits, expired/revoked sessions and transient failures. Do not
  automatically retry a selected ChatGPT request through a billable API provider.

This would add credential lifecycle maintenance. A first experimental flow could
use an advanced-owner CLI; a complete dashboard account/recovery UI would need
separate work. The proposal does not require a VPS, proxy service, new runtime
dependencies, or a new Durable Object binding.

#### Evidence and checks before adoption

A fork prototype exercises owner/workspace isolation, encrypted credentials,
refresh/disconnect races, loopback OAuth and stream completion with synthetic
tests. These checks are not a Workers AI comparison or proof of production
latency, resource cost, or general deployment eligibility. The fork also explores
other operations; those are outside this first upstream proposal.

Before adoption, I would prepare a minimal upstream patch and check:

1. Default installations still work without ChatGPT credentials; team, member,
   mixed-context and unconfigured requests cannot consume the owner's plan.
2. Credential rotation, account mismatch, revoked consent, usage limits and
   interrupted streams have reproducible tests and clear recovery steps.
3. A shared answer fixture set compares Workers AI and ChatGPT for source-backed
   accuracy, citations, dates, time to first text, and completion time.
4. Worker CPU/wall time and storage usage are measured on the upstream route,
   rather than inferred from the fork's execution architecture.

#### Open questions

OpenAI's [overview](https://developers.openai.com/siwc/token-sharing-open-source)
describes open-source/local apps and directs paid or remotely hosted apps to an
interest form. Its [self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
describes credential transfer and remote refresh ownership; I am treating that as
a design reference, not confirmation that an owner-managed Cloudflare Worker is
eligible. Deployment eligibility needs confirmation before general distribution.
The [inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
defines the public endpoint and completion contract above.

Would this limited, owner-only answer provider be worth exploring, and is an
advanced-owner experiment an acceptable starting point for the project?
