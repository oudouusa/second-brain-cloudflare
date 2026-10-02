# CLIProxyAPI Prompt Cache measurement — live v1

## Verdict

Observed cache reads were reproduced across 20 consecutive Responses requests through CLIProxyAPI and Codex OAuth. Sixteen of the later 19 requests reported `cached_tokens > 0`, exceeding the predeclared 80% acceptance threshold.

Canonical evidence:
[`2026-09-03-cliproxy-cache-live-v1.json`](./2026-09-03-cliproxy-cache-live-v1.json)

```text
schema:                  prompt-cache-proxy-measurement.v1
model:                   gpt-5.6-luna
requests:                20 / 20 successful
later request hit rate:  16 / 19 = 84.21%
all-input cache ratio:   28,672 / 38,380 = 74.71%
warm-input cache ratio:  28,672 / 36,461 = 78.64%
cached tokens per hit:   1,792
```

The Capsule was fetched from the production Worker through MCP Managed OAuth; inference used a fixed CLIProxyAPI transport. No official OpenAI API key or Second Brain static bearer was used. The Core Capsule was complete, 8,727 characters long, and byte-identical across all requests.

## Latency observation

| Sample | n | Median | Mean | p90 |
| --- | ---: | ---: | ---: | ---: |
| All requests | 20 | 1,244 ms | 1,417.65 ms | 1,911 ms |
| Later cache hits | 16 | 1,244 ms | 1,392.06 ms | 1,911 ms |
| Later cache misses | 3 | 1,332 ms | 1,630.67 ms | 2,440 ms |


Mean latency for hits was about 14.6% lower than for misses. However, only three misses were observed, and complete non-streaming response time includes generation, network, and proxy processing. This does not establish that caching caused a latency improvement.

## Claim boundary

- `cache-read-observed`: qualified.
- Initial cache write: unobserved.
- Cache write across all samples: unobserved; every one of the 20 responses reported zero.
- Equivalence with the official OpenAI Responses API: unverified.
- Provider pricing discount: unverified.
- API cost estimate: not calculated.

`cached_tokens` is a usage counter returned through CLIProxyAPI/Codex OAuth, not an OpenAI Platform invoice. This result establishes only frequent reuse of 1,792 tokens from a stable Core Capsule.

## Reproduction contract

The measurement used `qualify.mjs --mode proxy-only --output measurement`, requiring:

- A complete production Capsule fetched through MCP Managed OAuth.
- An exact CLIProxy transport hash including scheme, host, port, and base path.
- HTTP success for all 20 requests.
- A different suffix for each run.
- Stable cache key and Core hash.
- At least 80% later cache hits.
- Input, cached, output, total-token, and latency counters for every request.

Content, model output, Worker URL, OAuth tokens, proxy key, raw ETag, and raw JSONL were not retained.
