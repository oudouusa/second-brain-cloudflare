# Remote search measurements with synthetic memories

This tool observes search CPU and D1 metadata using only synthetic fixtures. It does not ingest real memories or measure production. Personal deployment and measurement records are excluded from public source.

Remote hostnames in the public version are examples. Start on localhost. For remote measurement, replace the fixed two-host allowlist in `protocol.mjs` with your dedicated test targets, then run the safety regressions. Before execution, explicitly authorize the isolated environment, revisions, budget, and credential destinations.

```sh
npx --no-install vitest run test/unit/remote-d1-metrics.test.ts test/unit/remote-measurement-safety.test.ts
```

Distinguish local timing, SQL-statement counts, and synthetic-fixture rankings from evidence of Cloudflare CPU, billed rows, or quality on real memories. Record revision, fixture hash, sample count, and incomplete conditions with measurements.

## Preparation and budget

Use Node 24+ and an empty private output directory:

```sh
node experiments/recall-remote/prepare.mjs /tmp/sb54-fixture
```

The script validates the entire reference schema and synthetic seed in SQLite,
then exclusively creates `seed.sql`, `fixture-manifest.json` and a mode-0600
`private-settings.json`. It does not call any remote service. The SQL includes
token hashes, never bearer tokens. Keep all three files outside Git. Existing
files are not overwritten. The seed is only for newly created, empty staging
databases; it must never be imported into an existing or production database.

There are 24 private workspaces: 200/1,000/10,000 entries × English/Japanese ×
ordinary noise, excluded priority rows, equal-authority overflow, and no answer.
Each database contains 89,600 synthetic entries in total. The workspace corpus
sizes must not be misreported as total database sizes. Each workspace has a
separate member token; returned IDs from another workspace fail the runner.
The recipe mirrors `recall-load`, with workspace-qualified IDs and real tenancy.

The schema retains all write-fence triggers. A temporary seed admission is
removed before the experiment. `/reset` uses production write admission to reset
only a selected synthetic workspace's recall counters between requests; it
requires the temporary owner bearer token and is never a production route.

## Explicitly authorized temporary resources

Before resource creation, record approval, the exact account, baseline/candidate
commits, names, hashes, maximum requests/time and cleanup. For the 2026-09-06 plan:

Create resources only in an empty test environment separate from production. See the [self-hosting guide](../../docs/fork/DEPLOYMENT.md) for fixed Gemma128, metadata indexes, existing DO migration, and secrets. Each operator privately records the measured profile, resource names/IDs, and Worker version.

## Collect and evaluate

Start a private JSON `wrangler tail` capture for each temporary Worker before the
first sample. After importing the identical seed into both new databases:

```sh
node experiments/recall-remote/run.mjs /tmp/sb54-fixture \
  https://sb54-candidate-20260907.staging-example.workers.dev /tmp/candidate.jsonl smoke /tmp/candidate-budget.json
```

The runner only accepts localhost or the two explicit staging Worker names. Use
`smoke` for the first fixture. Full mode has four provider modes, one warm-up and
three measured repetitions per condition: 384 recalls plus 384 resets per arm.
Run at most one call at a time per arm, two arms concurrently. The two-arm budget
is 1,536 calls plus setup/smoke, below 2,000 total and 60 minutes. Stop on errors;
do not silently omit failures, retry them into successes or exceed the budget.

The output manifest records source-tree, adapter/metrics/runner and fixture
hashes. Dirty source and source-tree changes during execution are rejected. Also
pin and record the **running deployment's** bundle/version; a local Git hash
alone does not prove the remote endpoint is running that code. The runner's
summary checks expected recall/empty results but always leaves
`remoteGatePassed=false`. It is not a remote CPU/cost acceptance checker.

For each sample, join the `sb54` and `sb54-d1` records in the public and DO
invocations separately. Header counters are joined by the same sample id. `sb54-d1` records use actual result metadata and include
background statements after the response; check contiguous sequence numbers.
Treat older logs as reference records; the corrected version uses public/DO headers with completion markers. Unknown
metadata stays null. The `first()` adapter uses the same SELECT via `all()` to
obtain metadata. Batches unwrap their original statements and execute once.

Read CPU/wall time, exceptions, outcome, version and sample association from the
Cloudflare invocation records. Missing/duplicate invocations, missing CPU or
truncated statement logs leave the gate incomplete. Local Miniflare timing and
metadata are not Cloudflare billing evidence. Preserve initialization and warm-up
separately; report per-condition p50/p95/max and sample count (three-repeat p95 is
the maximum), not only a mixed global percentile.

Predeclared staging gates, recorded before remote collection:

- All required expected hits/empty results pass; no baseline hit is lost,
  including a hit in a known-limit condition. No foreign-workspace result.
- No HTTP/MCP error, 1102, 5xx or uncaught exception; all required metrics present.
- Warm public Worker p95 CPU ≤10 ms.
- Candidate per-condition DO p95 CPU ≤max(1.25×baseline, baseline+20 ms).
- Candidate end-to-end p95 latency ≤max(1.25×baseline, baseline+200 ms).
- Candidate D1 rows_read ≤max(1.25×baseline, baseline+1,000 rows).

Failure requires diagnosis, not threshold relaxation. Equal-authority overflow
is an explicitly bounded-search limitation: 32 priority slots cannot guarantee
one arbitrary answer among more than 32 otherwise indistinguishable matches.
Report its misses separately; do not claim universal recall or label a lost
baseline hit acceptable. These measurements do not authorize production rollout.

After exporting synthetic evidence, delete both temporary Workers, DO namespaces
and D1 databases, and verify their absence. Do not close #54 merely because a
local command or this runner exits successfully.

Metric semantics: [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/),
[Worker invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
and [observability query fields](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/).

## Automated audit of saved smoke evidence

HTTP 200 and search results alone cannot detect the reset DO cancellation found
during this work. `audit-smoke.mjs` requires eight records: one fixture, four
provider modes, warmup and measurement. It uniquely matches public/do/reset logs
using the explicit deployment version and sample hash. Missing, duplicate,
canceled, exceptional, truncated, or unknown CPU/D1 records fail. Do not copy
raw request headers or exception bodies into reports.

```sh
node experiments/recall-remote/audit-smoke.mjs \
  /PRIVATE/samples.jsonl /PRIVATE/tail.jsonl DEPLOYMENT_VERSION /PRIVATE/audit.json
```

Success with `telemetryPassed=true` establishes only measurement-path integrity.
It does not replace acceptance of search quality, baseline comparison, all fixtures,
or p95/D1 thresholds; `remoteGatePassed=false` remains. Record input-file SHA-256
hashes and do not overwrite existing result files. Auditing saved evidence does
not connect to Cloudflare.
