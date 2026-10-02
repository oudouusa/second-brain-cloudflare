# CLIProxyAPI Prompt Cache paired certification — live v1

## Verdict

Separate qualification and operational-measurement manifests were generated from the same temporary JSONL. Both have `evidence_sha256` equal to `b2b8e9fbf23cbb0e4ef775f32a95a4aa0754164cf963f1360876e8ad5eadfa41` and both report `verified: true`.

- [Qualification](./2026-09-03-cliproxy-cache-paired-v1.qualification.json)
- [Measurement](./2026-09-03-cliproxy-cache-paired-v1.measurement.json)

```text
qualification schema:       prompt-cache-proxy-qualification.v1
measurement schema:         prompt-cache-proxy-measurement.v1
mode:                       proxy-only
basis:                      cache-read-observed
direct:                     not_applicable
requests:                   20 / 20 successful
later request hit rate:     17 / 19 = 89.47%
all-input cache ratio:      30,464 / 38,380 = 79.37%
warm-input cache ratio:     30,464 / 36,461 = 83.55%
cached tokens per hit:      1,792
```

The complete 8,727-character Core Capsule was fetched from the production Worker through MCP Managed OAuth and was byte-identical across requests. Inference used the fixed CLIProxyAPI transport. No official OpenAI API key or Second Brain static bearer was used.

## Qualification attempts

The first candidate under the same fixed conditions had 20/20 successful requests but only 15/19 later hits (78.95%), one hit short of the 80% threshold, so it failed. It was not relabeled successful. The next batch under identical conditions produced the canonical manifest with 17/19 hits (89.47%). This variation also shows why hit rate is an operational metric across multiple requests, not a per-request guarantee.

## Claim boundary

- Actual cache reads: qualified.
- Initial cache write: unobserved.
- Cache-write counter: zero for all 20 responses.
- Equivalence with official Responses: unverified.
- Provider pricing discount: unverified.
- API cost estimate: not calculated.
- Causal latency improvement: not established.

Hits were slower than misses in this run. Complete non-streaming response time includes generation, network, and proxy processing, so observed cache reads must not be reinterpreted as improved latency.

## Credential boundary

The live CLIProxy inbound key came from `environment`. Its value was not saved in manifests, logs, or the repository. `systemd-credential` support is implemented and tested as the recommended operational path, but it was not part of these live measurement conditions.

Neither the outer `prompt-cache-proxy-artifacts.v1` envelope nor raw JSONL was retained as shared evidence. Only the two sanitized manifests with matching evidence hashes were persisted.
