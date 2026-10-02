# Prompt-cache path qualification

`qualify.mjs` is a strict operator tool for qualifying Prompt Capsules and LLM cache paths without putting content or credentials into evidence. Two explicit contracts cover different usage patterns.

This experiment documents the historical CLIProxyAPI path. It is not required by the current Worker's direct ChatGPT connection; see [CHATGPT_DIRECT.md](../../docs/fork/CHATGPT_DIRECT.md).

## For CLIProxyAPI-only configurations

Use `proxy-only` when relying solely on Codex OAuth held by CLIProxyAPI, without connecting directly to the OpenAI Platform API.

```text
Fetch production Capsule through MCP Managed OAuth
        ↓
Pinned CLIProxyAPI path
        ↓
Initial cache write + later cache read
        ↓
prompt-cache-proxy-qualification.v1
```

This mode does not read `OPENAI_API_KEY` or `SECOND_BRAIN_AUTH_TOKEN`. It explicitly marks direct access as follows instead of presenting it as successful:

```json
{
  "status": "not_applicable",
  "reason": "cliproxy_oauth_only"
}
```

### 1. Authorize the execution host once through MCP Managed OAuth

Register an OAuth client on the host running qualification and create a refreshable credential dedicated to that host. Do not use dashboard cookies. Initial consent requires entering the Second Brain setup credential once in the browser; the experiment client neither receives nor stores it. Subsequent qualification runs need no routine static bearer. Store the credential at an absolute path with mode `0600`; OAuth tokens and authorization codes are not printed.

```bash
install -d -m 700 "$HOME/.local/state/second-brain-cf"

node experiments/prompt-cache/mcp-authorize.mjs \
  --worker-url 'https://your-second-brain-worker.example' \
  --credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json"
```

The client derives the Access-independent `/oauth-mcp` endpoint from `--worker-url`. Do not substitute `/mcp`: production Cloudflare Access intercepts that path before the Worker and replaces its Managed OAuth challenge.

Complete the displayed temporary URL in a browser to return to the loopback callback. For a remote host, use SSH local forwarding of the same callback port to that host and open the browser on the forwarding PC. An iPhone alone returns `127.0.0.1` to itself and cannot complete this host-local authorization. Do not copy a credential file from another host.

Refresh tokens rotate automatically afterward. If reauthorization is required, noninteractive qualification fails closed with `mcp_oauth_authorization_required` and does not put authorization URLs into evidence.

### 2. Supply the CLIProxy inbound key as an internal credential

The CLIProxyAPI inbound key remains a defense layer, but the user need not export its value. Supply it through systemd `LoadCredential` or `LoadCredentialEncrypted` under fixed name `prompt-cache-proxy-api-key`. The runner reads only this file within `CREDENTIALS_DIRECTORY`.

`PROMPT_CACHE_PROXY_API_KEY` remains accepted for backward compatibility. The manifest records only its source, `environment` or `systemd-credential`, never its value.

### 3. Run proxy-only qualification

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode proxy-only \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --proxy-model 'gpt-5.6-luna' \
  --source-auth mcp-oauth \
  --mcp-credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json" \
  --runs 4 \
  --delay-ms 2000 \
  --min-later-hit-rate 0.5 \
  --pretty \
  > /private/path/prompt-cache-proxy-qualification.json
```

All acceptance conditions must hold:

- Capsule source is `worker-mcp-oauth` (or legacy `worker-access`).
- The CLIProxyAPI transport hash matches exactly, including scheme, host, port, and base path.
- This is not a dry run.
- Every explicit request succeeds.
- A run from run 2 onward reports `cached_tokens > 0`.
- The later-hit rate meets the selected threshold.
- The Capsule is complete unless explicitly relaxed.

If CLIProxyAPI/Codex OAuth returns `cache_write_tokens`, qualify both the initial write and later reads as before. If it returns only later `cached_tokens`, qualify with `cache_proof.basis=cache-read-observed` and `cache_write_observed=false`. This exception is allowed only when `initial_cache_write_missing` is the sole unmet condition and later reads, all-request success, transport, OAuth source, and every other condition pass.

Do not claim an unobserved write succeeded. Qualification establishes observed cache reads through CLIProxyAPI. Because the official direct path was not run, it does not establish equivalence with the official API.

### 4. Emit an operational measurement manifest

Use `--output measurement` to aggregate request-hit rate, cached-input-token ratio, and complete-response latency alongside qualification.

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode proxy-only \
  --output measurement \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --proxy-model 'gpt-5.6-luna' \
  --source-auth mcp-oauth \
  --mcp-credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json" \
  --runs 20 \
  --delay-ms 2000 \
  --min-later-hit-rate 0.8 \
  --pretty \
  > /private/path/prompt-cache-proxy-measurement.json
```

The output schema is `prompt-cache-proxy-measurement.v1`. It records separately:

- Request-hit rate from run 2 onward.
- Cached/input token ratios for all runs and for runs from run 2 onward.
- Min/median/p90/max/mean latency of complete non-streaming Responses.
- Later-hit and later-miss latency, plus cached tokens for each hit.
- Number of samples with an observed cache-write counter.
- Separate claims for the initial write and a write anywhere in the sample set.
- Unverified API discounts and official-API equivalence.

If any of `input_tokens`, `cached_tokens`, `output_tokens`, `total_tokens`, or `latency_ms` is missing, fail closed with `usage_counters_incomplete` rather than rounding aggregates to zero. CLIProxyAPI/Codex OAuth usage is not an OpenAI Platform invoice; `estimated_cost` is always `null`.

The first live 20-request measurement on 2026-09-03 passed with 84.21% later-request hits, 74.71% cached tokens across all input, and 78.64% in the warm portion. The authoritative standalone measurement aggregates and claim boundaries are in [`results/2026-09-03-cliproxy-cache-live-v1.md`](./results/2026-09-03-cliproxy-cache-live-v1.md). The paired manifests below are authoritative for the completed qualification goal.

### 5. Save qualification and measurement separately from one run

Use `--output artifacts` for goal-completion evidence. It builds `prompt-cache-proxy-qualification.v1` and `prompt-cache-proxy-measurement.v1` together from one temporary JSONL stream generated once.

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode proxy-only \
  --output artifacts \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --proxy-model 'gpt-5.6-luna' \
  --source-auth mcp-oauth \
  --mcp-credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json" \
  --runs 20 \
  --delay-ms 2000 \
  --min-later-hit-rate 0.8 \
  --pretty \
  > /private/path/prompt-cache-proxy-artifacts.json
```

The outer `prompt-cache-proxy-artifacts.v1` is a safe transfer envelope. Persist its inner `qualification` and `measurement` as separate authoritative JSON files. Matching `evidence_sha256` values mechanically establish that both came from the same measurement. Do not save raw JSONL or reconstruct qualification from an existing measurement. Completion evidence from 2026-09-03 is recorded in [`results/2026-09-03-cliproxy-cache-paired-v1.md`](./results/2026-09-03-cliproxy-cache-paired-v1.md).

## Existing official-direct versus proxy comparison

Use `compare` when an independent comparison with the official Responses API is required. This mode is retained for backward compatibility and remains the default.

```text
Production Worker Capsule
        ↓
Official Responses API A/B
        ↓ direct gate must pass
CLIProxyAPI
        ↓ proxy gate must pass
Compare identical Capsule / model / breakpoints
        ↓
prompt-cache-qualification.v1
```

Required credentials are:

```bash
export SECOND_BRAIN_AUTH_TOKEN='...'
export OPENAI_API_KEY='...'
export PROMPT_CACHE_PROXY_API_KEY='...'
```

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode compare \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --direct-model 'gpt-5.6-luna' \
  --proxy-model 'gpt-5.6-luna' \
  --pretty
```

Adding `--source-auth mcp-oauth --mcp-credential-file PATH` uses Managed OAuth instead of the Second Brain bearer in compare mode too. Official direct access still requires `OPENAI_API_KEY`. `--source-auth access` remains available for backward compatibility.

## Project and company Capsules

Add `--project-id` to include a project Capsule. Use `--workspace company` for company scope and specify `--team` when membership is ambiguous across multiple teams.

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode proxy-only \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --proxy-model 'gpt-5.6-luna' \
  --source-auth mcp-oauth \
  --mcp-credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json" \
  --project-id 'p-7f3a' \
  --workspace company \
  --team 'opaque-workspace-id' \
  --pretty
```

## Output and exit codes

Output contains only hashes, aggregate cache metrics, booleans, and fixed failure codes. It excludes Capsule content, model output, Worker/proxy URLs, Bearer tokens, Access JWTs, API keys, project/team IDs, and raw JSONL.

```text
0  Selected qualification contract passed
1  Invalid CLI, credential retrieval, child process, or evidence structure
2  Valid evidence structure but qualification criteria not met
```

Proxy-only uses `prompt-cache-proxy-qualification.v1`; the existing comparison uses `prompt-cache-qualification.v1`. Separate names prevent an untested direct path from later being mistaken for a success.

Separate child-process environments by path. Proxy-only removes inherited `OPENAI_API_KEY` and `SECOND_BRAIN_AUTH_TOKEN` even when they remain in the parent; it also does not forward the systemd credential directory. Transfer the CLIProxy inbound key only to the Authorization value of the child that needs it.
