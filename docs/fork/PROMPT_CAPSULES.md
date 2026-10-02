# Prompt Capsules

The fork's model-independent consumer pilot and its upstream rationale are
documented in [CONSUMER.md](../../experiments/prompt-cache/CONSUMER.md).
The pilot preserves the upstream representation and adds consumer-side
required-slot validation and append-only conversation updates. Model names do
not select behavior or prompting policy.

Prompt Capsules are a cache-friendly, deterministic projection of a very small
set of approved Second Brain memories. They do **not** replace recall or Hot
Context.

- `recall`: query-specific dynamic context
- `get_hot_context`: current working set, read only when useful
- Prompt Capsule: stable prefix material for a gateway that controls the LLM
  request shape

The Worker is **capsule-ready** when it can produce the same bytes from the same
canonical memory state. A provider path is **cache-ready** only after cache
writes and reads are measured on that exact path.

## Capsule definitions

The synchronization branch integrating upstream 3.1.0 adds
`prompt_capsule_revisions`, a dedicated index, and four invalidation triggers through
the automatic schema-v5 migration. Content remains in ordinary D1 entries; KV is
only a revisioned derived cache. Upgrading from v4 does not rewrite tags. Capsule
definitions use the following three tags:

```text
status:canonical
capsule:core                          # or capsule:project:<opaque-project-id>
capsule-slot:<slot>
```

Core slots, in fixed order:

```text
identity
preferences
constraints
principles
```

Project slots, in fixed order:

```text
current-state
decisions
open-questions
```

Example core constraint:

```json
{
  "content": "Never expose credentials in logs or generated artifacts.",
  "tags": [
    "capsule:core",
    "capsule-slot:constraints",
    "status:canonical"
  ],
  "source": "manual"
}
```

Example project state for opaque project id `p-7f3a`:

```json
{
  "content": "The current deployment target is Cloudflare Workers with D1 as the source of truth.",
  "tags": [
    "capsule:project:p-7f3a",
    "capsule-slot:current-state",
    "status:canonical"
  ],
  "source": "manual"
}
```

Draft and deprecated entries are excluded. Invalid or duplicate definitions are
reported, and valid slots form an ordered subset. A personal Capsule rejects
individually oversized or otherwise bounded-invalid rows with HTTP 409; shared
Capsules exclude and report those rows. When valid slots exceed the cumulative
budget, that slot and the following slots are omitted. Empty responses have
`populated: false` and `complete: false`; invalid entries or duplicate slots also
make the result incomplete. See the root README and upstream payload builder for
the current source contract. A consumer must separately check required slots.

`update` preserves the previous content in history. Omitting tags retains the
definition. To move slots, specify both the new `capsule:` and `capsule-slot:` tags.
New definitions are not published until explicitly made canonical; automatic
classification does not promote them. REST/MCP content and input tags reject NUL.
Imported and legacy data receive read-time protection.

## REST API

```text
GET /prompt-capsules/core
HEAD /prompt-capsules/core

GET /prompt-capsules/projects/<opaque-project-id>
HEAD /prompt-capsules/projects/<opaque-project-id>
```

The privacy-safe default is `workspace=personal`. A shared capsule requires:

```text
?workspace=company
```

When the caller belongs to more than one company workspace, `team=<workspace-id>`
is required. Project ids must be lowercase opaque ids containing only `a-z`,
`0-9`, `_`, and `-`, up to 64 characters. Do not put a human-readable private
project name in the URL.

A successful response contains:

```json
{
  "ok": true,
  "schema": "prompt-capsule.v1",
  "kind": "core",
  "workspace": "personal",
  "team": null,
  "prompt_hash": "sha256:...",
  "text": "{ ... deterministic prompt JSON ... }",
  "sections": [
    {
      "slot": "constraints",
      "source_entry_id": "..."
    }
  ],
  "omitted_slots": [],
  "complete": true,
  "char_count": 512,
  "max_chars": 12000
}
```

`text` contains only the fixed schema, capsule kind, slot names, and normalized
entry content. It excludes entry ids, timestamps, sources, recall counters, and
other mutable metadata. Line endings are normalized to LF and trailing spaces
are removed. Sections are never cut in half. If the character budget is reached,
the current and all lower-priority populated slots are omitted whole and listed
in `omitted_slots`.

## ETag contract

Responses include:

```http
ETag: "pcv1-..."
Cache-Control: private, max-age=0, must-revalidate
Vary: Authorization
```

A gateway should retain the prior response and revalidate with:

```http
If-None-Match: "pcv1-..."
```

An unchanged representation returns HTTP 304 with no body. The ETag is for HTTP
representation reuse. `prompt_hash` identifies the exact prompt text. Neither is
an LLM prompt-cache key.

## MCP Managed OAuth API

Machine-facing gateways should use the Access-independent `/oauth-mcp` OAuth
boundary instead of obtaining a Dashboard browser cookie or a static Second
Brain bearer. The existing `/mcp` path remains behind the owner-only
Cloudflare Access application for backwards compatibility:

```text
tool: get_prompt_capsule
arguments:
  kind: core | project
  project_id: required only for project
  workspace: personal | company
  team: company workspace id when membership is ambiguous
```

The tool returns `prompt-capsule-mcp.v1`, containing the exact same
`prompt-capsule.v1` payload as REST plus the strong ETag computed over that REST
representation. The gateway recomputes and verifies both `prompt_hash` and the
ETag before using `capsule.text`. The tool is a pure read and never takes D1
write admission.

OAuth client registration and refresh tokens are host-local credentials. Do
not copy them between machines or put them in evidence. The experiment client
stores them in an absolute path with mode `0600`; PKCE verifiers remain only in
process memory. The hosted consent page accepts the existing Second Brain setup
credential once; the experiment client never receives or stores it, and later
qualification runs do not read the routine static bearer.

## Gateway prompt order

A gateway that can control the provider request should assemble the prompt in
this order:

```text
stable tool definitions
stable agent instructions
core capsule
  -> explicit cache breakpoint
project capsule
  -> explicit cache breakpoint
current user request
dynamic recall/tool results
```

Use a stable, non-identifying cache routing key such as:

```text
sbcf:<hashed-workspace>:<agent-profile-version>
```

Do not put the capsule ETag in the cache key. Exact prefix matching prevents stale
content reuse; changing the routing key on every capsule revision unnecessarily
throws away reusable earlier prefixes.

## Readiness gates

1. **Capsule-ready**: serializer tests prove fixed ordering, normalization,
   metadata exclusion, and whole-section omission; REST tests prove scope,
   ETag, HEAD, and 304 behavior.
2. **Direct cache-verified**: For deployments using the official Responses API,
   change only the suffix and verify `cache_write_tokens > 0` on the first call
   and `cached_tokens > 0` on later calls.
3. **Proxy cache-verified**: In historical configurations using CLIProxyAPI as the
   only OpenAI path, use a proxy-origin fingerprint exactly matching the live
   Capsule obtained through MCP Managed OAuth and measure later `cached_tokens > 0`.
   If a write counter is returned, verify both writes and reads. Otherwise label
   it `cache-read-observed` and explicitly state that writes were not observed.
   Mark the direct path `not_applicable`, not successful.

The repository includes `experiments/prompt-cache/ab.mjs` for the direct A/B
measurement. It never logs prompt text.

`source-revalidate.mjs --require-304` proves the deployed 200 -> 304 strong-ETag
contract. `verify.mjs` is the single canonical `prompt-cache-evidence.v1`
verifier; its proxy gate requires an exact fingerprint of the intended route.
`qualify.mjs --mode compare` verifies direct access before proxy access and checks
exact agreement of the model, breakpoint count, and Worker Capsule source descriptor
before emitting `prompt-cache-qualification.v1`. Without an official OpenAI API key,
use `qualify.mjs --mode proxy-only`, which emits
`prompt-cache-proxy-qualification.v1`. That mode requires no direct evidence and
qualifies only the CLIProxyAPI path.

CLIProxyAPI Codex conversion may not return unsupported explicit-breakpoint fields
or write counters. The qualification manifest therefore distinguishes observed
writes and reads from observed reads alone through `cache_proof.basis`.

Official references:

- https://platform.openai.com/docs/guides/prompt-caching
- https://developers.openai.com/api/reference/cli/resources/responses/methods/create
