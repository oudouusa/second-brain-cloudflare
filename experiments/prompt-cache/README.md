# Prompt-cache A/B experiment

For the model-independent fork consumer, use [CONSUMER.md](./CONSUMER.md).
It documents required slots, background-data authority, append-only updates,
explicit API encoding, executable examples, primary sources, and evidence limits.
It does not choose behavior or reasoning settings from a model name.

The A/B and development-decision runners now omit reasoning effort by default
and use a common 4096-token output ceiling. Use `--effort` and
`--max-output-tokens` to pin experiment conditions explicitly; older recorded
runs used different defaults. See [compatibility notes](./CONSUMER.md#existing-experiment-compatibility).

This experiment proves the provider path separately from the Second Brain
Capsule serializer.

It sends the same stable core prefix, an optional project prefix, and a different
final user suffix on every request:

- `implicit`: stable `prompt_cache_key`, no explicit cache fields
- `explicit`: `prompt_cache_options.mode=explicit` and a breakpoint at the end
  of each stable Capsule that is present

The script prints JSON Lines containing hashes, character counts, latency, and
usage metrics. It never prints prompt text, model output, API credentials,
Second Brain bearer tokens, or an upstream error body.

## Dry run

```bash
node --test experiments/prompt-cache/*.test.mjs
node experiments/prompt-cache/ab.mjs --dry-run
```

The built-in synthetic Capsules are deliberately long enough to cross the
provider's minimum cacheable prefix size. A dry run validates the request shape
without calling any provider.

## Official Responses API

```bash
export OPENAI_API_KEY='...'
export OPENAI_MODEL='gpt-5.6-luna'

node experiments/prompt-cache/ab.mjs \
  --arm both \
  --runs 4 \
  --delay-ms 2000 \
  --require-explicit-hit
```

Use the official endpoint first. The expected explicit-arm pattern is:

```text
run 1: cache_write_tokens > 0
run 2+: cached_tokens > 0 while the user suffix changes
```

The implicit arm is a control, not a required failure. Provider behavior can
change, so the result is recorded rather than hard-coded.

## Deployed Worker Capsules

The experiment can fetch the exact Capsule text from a deployed Second Brain
Worker without saving the memory text to disk. For proxy-only operation, use
the existing MCP Managed OAuth boundary and keep its refreshable credential on
the same host that runs the gateway:

```bash
node experiments/prompt-cache/mcp-authorize.mjs \
  --worker-url 'https://second-brain-cf.example.workers.dev' \
  --credential-file '/private/state/prompt-cache-oauth.json'

node experiments/prompt-cache/ab.mjs \
  --worker-url 'https://second-brain-cf.example.workers.dev' \
  --source-auth mcp-oauth \
  --mcp-credential-file '/private/state/prompt-cache-oauth.json' \
  --arm explicit \
  --runs 4 \
  --require-explicit-hit
```

This calls `get_prompt_capsule` over the Access-independent `/oauth-mcp` route, validates the payload hash and the
strong ETag for the equivalent REST representation, and reports the source as
`worker-mcp-oauth`. OAuth tokens and the credential path are never written to
evidence. Dashboard Access (`worker-access`) and static bearer (`worker`) modes
remain available explicitly for backward compatibility.

Core-only run:

```bash
export SECOND_BRAIN_AUTH_TOKEN='...'
export OPENAI_API_KEY='...'

node experiments/prompt-cache/ab.mjs \
  --worker-url 'https://second-brain-cf.example.workers.dev' \
  --source-auth bearer \
  --arm both \
  --runs 4 \
  --require-explicit-hit
```

Core plus one project Capsule:

```bash
node experiments/prompt-cache/ab.mjs \
  --worker-url 'https://second-brain-cf.example.workers.dev' \
  --project-id 'p-7f3a' \
  --arm explicit \
  --runs 4 \
  --require-explicit-hit
```

For a shared workspace:

```bash
node experiments/prompt-cache/ab.mjs \
  --worker-url 'https://second-brain-cf.example.workers.dev' \
  --workspace company \
  --team 'ws-opaque-id' \
  --project-id 'p-7f3a' \
  --arm explicit \
  --runs 4
```

The live source rejects non-HTTPS remote URLs, credentials or query parameters
inside the Worker URL, redirects, oversized responses, the wrong MIME type,
kind/project/workspace mismatches, an incorrect `char_count` or `prompt_hash`,
and missing or weak ETags. An incomplete Capsule with omitted low-priority slots
fails closed unless `--allow-incomplete-capsules` is supplied deliberately.

Only source classes (`worker-mcp-oauth`, `worker-access`, or `worker`), prompt hashes, character counts, completeness, and hashes of
the endpoint and ETag are logged. The Worker URL, team id, project id, Capsule
text, and bearer token are not written to the JSONL output.

A sparse real Capsule may be below the provider's minimum cacheable prefix
length. That is a valid measurement result, not a reason for the Worker to pad
or duplicate user memory. Use the synthetic run to verify transport capability,
then evaluate real Capsules at representative sizes.

## Real Capsule files

An authenticated Capsule response can also be supplied from a private local file:

```bash
node experiments/prompt-cache/ab.mjs \
  --core-file /private/path/core.json \
  --project-file /private/path/project.json \
  --arm explicit \
  --require-explicit-hit
```

If a JSON file contains a valid top-level Capsule response, only its exact `text`
is used after its SHA-256 and length are verified. A serialized Capsule JSON file
or plain text file is also accepted. A serialized `core` Capsule cannot be
silently relabelled as `project`, or vice versa. File paths and contents are not
logged.

`--worker-url` cannot be combined with `--core-file` or `--project-file`, keeping
the source of each experiment unambiguous.

## Proxy re-evaluation

Run the exact same request builder through the proxy only after the official API
has passed:

```bash
export OPENAI_BASE_URL='http://127.0.0.1:8317/v1'
export OPENAI_API_KEY='the-local-proxy-key'

node experiments/prompt-cache/ab.mjs \
  --arm explicit \
  --runs 4 \
  --require-explicit-hit
```

The deployed Worker source flags can be added to this command as well. The
Capsule is fetched from the Worker first, then the resulting request is sent to
the configured Responses-compatible endpoint.

A successful HTTP response is not enough. The path is `proxy cache-verified`
only when the first request reports cache writes and later changing-suffix
requests report cache reads. This catches translators that accept or silently
strip explicit breakpoint fields.

Use [`EVIDENCE.md`](./EVIDENCE.md) for the strict direct/proxy evidence gates,
including exact proxy transport binding. Use [`QUALIFICATION.md`](./QUALIFICATION.md)
for both the legacy direct/proxy comparison and the preferred CLIProxy OAuth
`proxy-only` operator. Proxy-only never reads the official `OPENAI_API_KEY` and
records whether cache write/read were both observed or only a provider-reported
cache read was observed.

## Strong ETag source revalidation

Probe the deployed Worker independently before provider qualification:

```bash
cloudflared access login \
  'https://second-brain-cf.example.workers.dev/dashboard'

node experiments/prompt-cache/source-revalidate.mjs \
  --worker-url 'https://second-brain-cf.example.workers.dev' \
  --source-auth access \
  --runs 3 \
  --require-304 \
  > /private/path/capsule-revalidation.jsonl
```

The process keeps the validated response and raw strong ETag in memory only.
Later requests send `If-None-Match`; a matching 304 reuses the validated bytes.
A 304 without a snapshot, a weak or changed ETag, an oversized response, or a
target mismatch fails closed. Operational JSONL excludes Capsule text, raw
ETags, bearer credentials, Worker URLs, and project/team ids.

## Output fields

Each request record includes:

```text
transport
model
arm
run
prompt_cache_key_hash
core_hash / core_chars
project_hash / project_chars (null for a core-only run)
suffix_hash / suffix_chars
input_tokens
cache_write_tokens
cached_tokens
cache_hit_ratio
cache_write_ratio
latency_ms
```

The start record additionally reports the Capsule source class, completeness,
and hashed endpoint/ETag metadata. Request IDs are hashed before logging. The
summary reports whether a cache write and a later cache read were observed for
each arm.

Official references:

- https://platform.openai.com/docs/guides/prompt-caching
- https://developers.openai.com/api/reference/cli/resources/responses/methods/create
