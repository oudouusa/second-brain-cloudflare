# Prompt-cache evidence verification

`ab.mjs` emits sanitized JSON Lines. `verify.mjs` turns that stream into a
strict, deterministic readiness manifest. This is the boundary between an
experiment that merely returned HTTP 200 and a provider path that has actually
shown cache writes and later cache reads.

The verifier never needs a Second Brain token or provider credential. Run it
after the experiment, against the JSONL file or stdin.

## Why a separate verifier exists

The experiment runner already avoids printing prompt text, model output, bearer
tokens, Worker URLs, project ids, team ids, and upstream error bodies. The
verifier adds a second fail-closed layer before evidence is shared or committed:

- every JSON object must use the exact versioned field set;
- URL and credential-shaped string values are rejected;
- the start record, every request record, and the final summary must agree;
- the core/project prefix hashes and character counts must remain unchanged;
- the suffix hash must change on every request within an arm;
- cache keys must remain stable within an arm and differ between A/B arms;
- explicit breakpoint count must match core-only or core+project input;
- usage ratios and token counts must be internally consistent;
- cache-read and cache-write token subsets must not jointly exceed input tokens;
- source Capsule hashes, completeness, endpoint hashes, and ETag hashes are
  preserved in the safe manifest.

`worker-mcp-oauth` denotes a live production Worker Capsule fetched through
authenticated MCP `get_prompt_capsule`, with the strong ETag of the equivalent
REST representation recomputed. `worker-access` uses the Dashboard Access API;
`worker` is the legacy Bearer path. All are live sources, but proxy-only
qualification accepts only `worker-mcp-oauth` or backward-compatible
`worker-access`, recording the actual authentication boundary in the manifest.

The output contains hashes and aggregate metrics only. It does not copy arbitrary
unknown fields from the input.

## Structural validation

A dry run can prove the request and evidence contracts without claiming that a
provider cache worked:

```bash
node experiments/prompt-cache/ab.mjs \
  --dry-run \
  --arm both \
  --runs 2 \
  --delay-ms 0 \
  > /tmp/prompt-cache-dry.jsonl

node experiments/prompt-cache/verify.mjs \
  --input /tmp/prompt-cache-dry.jsonl \
  --gate structure \
  --pretty
```

`structure` accepts a valid dry run. It does not confer direct or proxy cache
readiness.

## Official Responses API gate

Use a fresh experiment id (the default) so the first explicit request is
expected to create a cache entry. For a deployed Worker Capsule:

```bash
export SECOND_BRAIN_AUTH_TOKEN='...'
export OPENAI_API_KEY='...'
export OPENAI_MODEL='gpt-5.6-luna'

node experiments/prompt-cache/ab.mjs \
  --worker-url 'https://your-worker.example' \
  --arm both \
  --runs 4 \
  --delay-ms 2000 \
  > /private/path/direct.jsonl

node experiments/prompt-cache/verify.mjs \
  --input /private/path/direct.jsonl \
  --gate direct \
  --require-worker-source \
  --pretty \
  > /private/path/direct-evidence.json
```

The `direct` gate requires:

- `transport=openai-official`;
- a live, non-dry-run measurement;
- an explicit arm;
- every explicit request to succeed;
- `cache_write_tokens > 0` on explicit run 1;
- at least one later explicit request with `cached_tokens > 0`;
- a later explicit hit rate of at least 0.5 by default;
- complete source Capsules unless explicitly relaxed.

Use `--min-later-hit-rate 0.75` or `1` for a stricter acceptance threshold.

## CLIProxyAPI / OAuth gate

After the official path passes, run the same request builder through the exact
proxy path used in production:

```bash
export OPENAI_BASE_URL='http://127.0.0.1:8317/v1'
export OPENAI_API_KEY='the-local-proxy-key'
export SECOND_BRAIN_AUTH_TOKEN='...'

export PROMPT_CACHE_EXPECTED_TRANSPORT="$(
  node --input-type=module -e \
    'import { transportLabel } from "./experiments/prompt-cache/request.mjs"; process.stdout.write(transportLabel(process.env.OPENAI_BASE_URL))'
)"

node experiments/prompt-cache/ab.mjs \
  --worker-url 'https://your-worker.example' \
  --arm explicit \
  --runs 4 \
  --delay-ms 2000 \
  > /private/path/proxy.jsonl

node experiments/prompt-cache/verify.mjs \
  --input /private/path/proxy.jsonl \
  --gate proxy \
  --expected-transport "$PROMPT_CACHE_EXPECTED_TRANSPORT" \
  --require-worker-source \
  --pretty \
  > /private/path/proxy-evidence.json
```

The `proxy` gate applies the same cache-write/read rules and requires the exact
precomputed custom transport label. The fingerprint includes scheme, host,
effective port, and normalized base path. A missing or different fingerprint
fails closed, so evidence from another compatible server cannot certify the
intended CLIProxyAPI route. A successful response without cache usage evidence
does not pass.

Without an official OpenAI API key, use `qualify.mjs --mode proxy-only`. It
qualifies only CLIProxyAPI and records direct access as `not_applicable`, not
successful. It requires the MCP Managed OAuth Capsule source and an exactly
matching expected proxy-transport fingerprint. If CLIProxyAPI exposes no write
counter, but `initial_cache_write_missing` is the sole strict-gate failure and
later `cached_tokens` plus all other conditions pass, the separate schema may
qualify `cache-read-observed`. Original strict evidence remains `verified: false`;
unobserved writes are not rewritten as observed.

## Stdin and exit codes

Evidence can be checked without creating the raw JSONL file:

```bash
node experiments/prompt-cache/ab.mjs --dry-run --runs 2 --delay-ms 0 \
  | node experiments/prompt-cache/verify.mjs --input - --gate structure
```

Exit codes:

```text
0  structurally valid and the requested gate passed
1  malformed, unsafe, inconsistent evidence, or invalid CLI/I/O
2  structurally valid evidence that did not meet the requested readiness gate
```

On exit 2, stdout still contains the safe manifest with stable failure codes such
as `initial_cache_write_missing`, `later_cache_read_missing`, or
`official_transport_required`. On exit 1, stderr contains only a machine-readable
error code; raw input is never echoed.

Input is capped at 2 MiB. File size is checked before reading and stdin is
counted while streaming, so an oversized pipe is stopped before it can be held
in memory in full.

## Manifest contract

The output schema is `prompt-cache-evidence.v1`. Important fields include:

```text
evidence_sha256
transport
model
dry_run
sources.core / sources.project
request_plan
criteria
arms[].run1_cache_write_tokens
arms[].later_cache_hit_rate
arms[].later_cached_tokens_min / max
verified
failures[]
```

The manifest is deterministic for the same JSONL bytes and verifier options. It
contains no current timestamp. Store or commit only the manifest after reviewing
that the source JSONL was produced in the intended environment. Keep the raw
JSONL private because it contains hashed operational identifiers and per-request
metrics even though it is designed not to contain memory text or credentials.

Official references:

- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/reference/cli/resources/responses/methods/create
