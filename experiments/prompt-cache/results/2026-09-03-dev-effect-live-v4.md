# Second Brain development-effect result — live v4

## Verdict

Core Capsule alone showed no significant improvement on this fixed task set. The Full arm, combining Core with tagged current-state recall, showed a small positive effect relative to Control.

This supports a context effect when recovering history-dependent development decisions, not an improvement rate for overall development speed.

Canonical evidence:
[`2026-09-03-dev-effect-live-v4.json`](./2026-09-03-dev-effect-live-v4.json)

```text
schema:           second-brain-development-effect.v2
evidence SHA-256: 60122ecf8346303f9c6229a4488e2714ff340bef40674bd5762282a39c5809c7
model:            gpt-5.6-luna
trials:           48 / 48 successful
JSON-valid:       48 / 48
```

Capsule/recall used MCP Managed OAuth; inference used CLIProxyAPI/Codex OAuth. No official OpenAI API key or Second Brain static bearer was used.

## Primary result

| Arm | Mean score | Exact pass | Unsafe-choice rate | Paired delta vs control |
| --- | ---: | ---: | ---: | ---: |
| Control | 0.8000 | 68.75% | 18.75% | — |
| Durable Core Capsule | 0.8083 | 62.50% | 25.00% | +0.0083 (95% interval -0.0407 to +0.0573) |
| Core + tagged current-state recall | 0.9771 | 87.50% | 12.50% | +0.1771 (95% interval +0.0009 to +0.3533) |


The `full-context-effect-observed` criterion was met, but the interval's lower bound is very close to zero. This is an approximate interval from only 16 paired observations and does not support strong generalization.

## What produced the effect

Only two tasks contributed to the Full-versus-Control difference:

- Current production lineage: Control 0.0, Core 0.0, Full 1.0.
- Deployment preflight: Control 0.5000, Core 0.6667, Full 0.9167.

Access/OAuth boundaries, handler normalization, Capsule determinism, credential boundaries, and public-evidence privacy scored 1.0 in every arm. They could be inferred from the questions and choices, so this experiment did not isolate a Second Brain-specific effect for them.

Cache-evidence classification scored Control 0.9, Core 0.8, and Full 0.9. Some trials classified `cache_write_tokens=0` as “observed” despite context. Qualification still requires deterministic machine gates.

## Cost and latency

| Arm | Mean input tokens | Total cached tokens | Approx. cache ratio | Median latency | p90 latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control | 501.0 | 0 | 0% | 3,280 ms | 5,068 ms |
| Core | 2,088.0 | 3,584 | 10.7% | 3,233 ms | 3,879 ms |
| Full | 4,398.0 | 15,104 | 21.5% | 2,920 ms | 5,945 ms |


Full used about 8.8 times Control's input tokens. Median model latency was about 11% lower, while p90 was about 17% higher. Provider caching and the small sample prevent a claim of improved latency.

Core acquisition took 1,333 ms and tagged recall 2,319 ms. Each was fetched once before trials; these are not measurements of latency when recalling on every conversational turn.

## Review correction

Initial v3 scored free text with regular expressions, allowing keywords in negations or rejected alternatives to earn points. Transport failures could also enter effect estimates as zero-score model observations.

V4 corrected this and repeated measurement:

- Use enumerated structured answers for every criterion.
- Accept only the exact key set and allowed values.
- Determine unsafe choices from structured values too.
- Exclude transport failures from arm scores and paired effects.
- Force the effect conclusion to `incomplete-run` if even one HTTP failure occurs.
- Update the schema to `second-brain-development-effect.v2`.

The larger v3 effect is therefore not canonical evidence; v4 is authoritative.

## Limits

- Eight historical decision-recovery tasks were built from the same completed development history.
- Only 16 pairs, one model, one proxy path, and two repetitions.
- Enumerated choices prevent negation-scoring errors but make the task easier than free-form responses.
- One current-lineage task contributes most of the effect.
- Unsafe-choice rates describe selected answers, not actual unsafe actions executed.
- No comparison of implementation, tests, and review in independent repositories was performed, so improvements in wall-clock speed, defect rate, and clarification count remain unverified.

A stronger next evaluation would fix unfamiliar small issues before saving them into memory, have isolated Control/Full agents implement them, and compare passing tests, review findings, unsafe actions, clarification turns, and elapsed time.
