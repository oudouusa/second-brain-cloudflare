# Issue #54: reproducible local recall load replay

This is an opt-in measurement experiment, not another retrieval implementation
or a deployment command. It calls production `recallEntries`, the existing
real-SQLite fixture (with the shipped schema and write fences), and the existing
AI/Vectorize doubles. It never connects to Cloudflare, reads operator credentials,
changes a client configuration, or seeds real memories. The normal Vitest suite
excludes `experiments/**`; only the comparator's unit tests run in ordinary CI.

## What it measures

The defaults are 200, 1,000 and 10,000 entries; English/Japanese; four provider
states (healthy, quota, embedding failure, initial Vectorize failure); and four
workloads: substring noise, deprecated canonical rows occupying the window,
more than 32 equally authoritative usable matches, and an absent identifier.
That is 96 conditions, repeated five times = 480 recorded invocations per tree.
One extra invocation per condition warms local code and is not recorded.

Each invocation gets fresh KV and provider doubles. Recall counters are reset
outside the timed region. All waitUntil work is drained before the next sample.
The data and query fingerprint must match between arms, as must the harness,
schema, Node version, platform and complete matrix. Production source and search
blob hashes identify the actual code. These hashes detect incompatible records;
they are not proof that a third party ran the program honestly.

The record distinguishes candidate SELECT count, rows actually returned by those
SELECTs, distinct candidates, rank/returned results, existing diagnostic binding
call counts, local SQL wall time, handler wall time, completion including
waitUntil, and Node process CPU. `d1BindingCalls` retains the existing diagnostic's
semantics: a batch is one binding call, not one count per contained statement.
The healthy absent-result fixture may make the existing second, unscoped vector
fallback query; that is not a retry introduced by this experiment.

Cloudflare `rows_read`, public Worker CPU and Durable Object CPU are **null**.
Local elapsed time, Node process CPU, and the D1 returned-row budget are not
substitutes. Real embedding relevance is not measured; healthy dense hits are
controlled. An HTTP/MCP entrypoint or Durable Object is not exercised here.

## Run once

From a reviewed checkout with dependencies already installed:

```sh
RECALL_LOAD_OUTPUT=/tmp/recall-candidate.json \
  node node_modules/vitest/vitest.mjs run \
  --config experiments/recall-load/vitest.config.ts
```

Optional `RECALL_LOAD_SIZES=200,1000,10000` accepts up to three distinct integers
between 200 and 10000. `RECALL_LOAD_REPEATS=5` accepts 1..20. The output is required,
mode 0600, and created exclusively: an existing file is never overwritten.
An error or failed budget assertion does not produce a completed report.
No hard timing threshold is used: CI-host load is not a production SLO.

## Compare the exact #64 baseline and candidate

Run from this follow-up checkout, with a clean reviewed `src/` and the same
lockfile/dependencies. The commands create an independent baseline worktree and
copy only the measurement harness, not candidate production code:

```sh
ROOT="$PWD"
RUN_DIR="$(mktemp -d)"
BASE=39289709e47b39111f5ea4554db0a1fe5aa98b42
git worktree add --detach "$RUN_DIR/baseline" "$BASE"
cmp package-lock.json "$RUN_DIR/baseline/package-lock.json"
cp -R experiments/recall-load "$RUN_DIR/baseline/experiments/"
ln -s "$ROOT/node_modules" "$RUN_DIR/baseline/node_modules"
(cd "$RUN_DIR/baseline" && RECALL_LOAD_OUTPUT="$RUN_DIR/baseline.json" \
  node node_modules/vitest/vitest.mjs run --config experiments/recall-load/vitest.config.ts)
RECALL_LOAD_OUTPUT="$RUN_DIR/candidate.json" \
  node node_modules/vitest/vitest.mjs run --config experiments/recall-load/vitest.config.ts
node experiments/recall-load/compare.mjs \
  --baseline "$RUN_DIR/baseline.json" --candidate "$RUN_DIR/candidate.json" \
  --output "$RUN_DIR/comparison.json"
```

The default matrix cannot silently lose a failed mode/size. Missing/duplicate
records, changed fixtures, incompatible hashes, mislabeled known limits and
fabricated remote metrics fail validation. Regression or missing required answers
produces exit code 1. This includes a previously successful `known-limit` sample
that starts missing: its success is not mandatory, but losing it is a regression.
Known-limit miss-to-miss remains allowed; miss-to-hit is reported as improvement.
Required-case denominators continue to exclude known limits. The 18 equal-authority degraded conditions are reported
separately, never counted as successful answers just because the harness ran.
Repeated samples are not independent quality examples. p50/p95 use nearest rank;
with five repeats the per-condition p95 is the maximum. Cross-tree timing is
sequential and descriptive, not a randomized controlled speedup experiment.
`remoteRolloutReady`, `realModelQualityMeasured` and `provenanceVerified` always
remain false, including on a successful comparison.

## Historical run (2026-09-06; pre-review code, not Cloudflare)

The results below describe the original #64/#65 heads, not a new run on later
review fixes. The updated comparator can recheck these saved reports without
relabelling their recorded code or harness hashes. It also counts regressions in
known-limit rows; earlier comparisons incorrectly excluded those transitions.
The hops=0 matrix does not cover the separately tested graph-only regression.

The base search blob was `e1db3ba764e285c5c9f08580a621153893964170`; the candidate
was `360992fd0ec137f2df99048bbcd836cf1fa1c525` from PR #64. Both ran 480 recorded
invocations with matching dataset/harness/schema fingerprints. Required conditions
went from 60/78 to 78/78 (300/390 to 390/390 recorded invocations); no previously
passing required result was lost. Eighteen known-limit conditions (90 repeated
invocations) still missed on both sides. Candidate cap 128 and late-failure
returned-row cap 160 held. The raw reports belong in the PR evidence artifact,
not in the normal runtime or the saved 60-query embedding benchmark.

No speedup is claimed. In this one run, aggregated local handler p95 was about
22.74 ms before / 23.54 ms after; it mixes different workloads and includes Node
instrumentation. The per-condition breakdown must be used for diagnosis. The
10,000-entry English ordinary-noise degraded candidate SELECTs took around
13.6..14.2 ms median locally: a small returned window is not proof of constant
query work. These values are neither public-Worker CPU nor D1 billing evidence.

## Remote evidence still required to close the operational gate

The opt-in [remote adapter](../recall-remote/README.md) prepares synthetic member
workspaces and drives the real HTTP/MCP/executor path. Its local checks and
runner summary do not certify Cloudflare CPU/cost or close this gate.

Do not send this fixture or injected failures to production. Separately authorize
isolated staging resources, pin baseline/candidate code and configuration, and
use an identical synthetic dataset/query schedule. Staging must keep the actual
HTTP -> MCP executor DO topology; this direct-function replay cannot certify it.
Never exhaust a real AI quota to simulate an outage. Use isolated test bindings.

Capture end-to-end latency and errors for every scheduled sample, then join the
public Worker invocation and DO invocation metrics separately. Obtain D1 read
counts from the actual D1 query metadata or isolated database analytics; the
current diagnostic's unknown aggregate must not be replaced by fetched rows.
Keep missing records/metrics unknown. Include initialization and warm/cold cache
state, code/fixture hashes, sampling settings, route, units and sample count.
Define acceptable CPU/error/latency/read-cost changes before running a rollout
gate. Do not auto-close #54 from the local comparator's exit code.

Primary documentation checked 2026-09-06:
- D1 row counts and query metrics: https://developers.cloudflare.com/d1/observability/metrics-analytics/
- D1 API `rows_read` includes index work; SQL duration excludes network time: https://developers.cloudflare.com/api/resources/d1/
- Worker invocation CPU and wall time: https://blog.cloudflare.com/introducing-workers-observability-logs-metrics-and-queries-all-in-one-place/
- Logs and sampling: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
