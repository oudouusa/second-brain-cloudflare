# Second Brain development-effect benchmark

This matched benchmark measures whether Second Brain context improves decisions
that occurred during real `second-brain-cf` development. It does **not** claim
that a score delta is a wall-clock productivity improvement.

## Arms

- `control`: no Second Brain context
- `core`: the authenticated deterministic Core Prompt Capsule
- `full`: the same Core Capsule plus one `second-brain-cf`-tagged current-state recall

Eight fixed decision tasks cover Access/OAuth routing, authenticated handler
normalization, cache-evidence claims, deterministic Capsule construction,
credential boundaries, deployment preflight, current release lineage, and
public-evidence privacy. Every task is run in every arm with a deterministic
rotating order. The default two repetitions produce 48 matched trials.

The model must return strict JSON and choose one enumerated value per criterion.
The grader accepts an exact key set and scores exact values, so negated prose or
discussion of rejected alternatives cannot receive accidental credit. Unsafe
choices are identified from the same structured answers. Evidence contains only
criterion booleans, scores, hashes, character counts, token usage, latency, and
transport metadata.
It never emits raw prompts, memories, model responses, URLs, credentials,
workspace/team identifiers, or project identifiers.

## Live run

Run on the host that already owns both the mode-0600 MCP Managed OAuth store
and local CLIProxyAPI credential. Do not copy either credential to another
host.

```bash
node experiments/prompt-cache/dev-effect.mjs \
  --worker-url 'https://your-worker.example' \
  --mcp-credential-file '/private/state/prompt-cache-oauth.json' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --model 'gpt-5.6-luna' \
  --experiment-id 'operator-selected-unique-id' \
  --repetitions 2 \
  --concurrency 2 \
  --pretty
```

CLIProxyAPI inbound protection is read through the existing bounded credential
resolver: `PROMPT_CACHE_PROXY_API_KEY`, or the fixed
`prompt-cache-proxy-api-key` systemd credential. The benchmark must not use
`OPENAI_API_KEY` or `SECOND_BRAIN_AUTH_TOKEN`.

## Interpretation

Primary measures are mean rubric score, exact-pass rate, safety-violation
rate, and the paired `full - control` score delta with an approximate 95%
interval across task/repetition pairs. Latency and token counts are secondary:
the memory arms intentionally contain more input, and provider caching may
reduce some repeated-prefix work.

Transport failures are not model observations: they are excluded from arm
scores and paired effects, and any incomplete run emits `incomplete-run`
instead of an effect conclusion.

A positive result establishes that the retrieved context improved this fixed
decision set for this model and run. It does not establish a general percentage
improvement in coding speed. Broader claims require additional unseen tasks,
multiple run IDs, and ideally a preregistered evaluator that was not derived
from the same development history.
