# Isolated nightly diagnostics

Local diagnostics for the remaining performance acceptance work from PR #80. Use actual `Worker.scheduled()`, SQLite, and write fences, with provider responses and KV simulated. The original harness exercised the then-current CLIProxy adapter. Do not duplicate production entry points, processing, or SQL. No requests are sent to Cloudflare by the local probe.

## Running

Use Node 24 and dependencies from the existing lockfile. Select a new empty output directory and keep it out of Git.

```sh
NIGHTLY_PROBE_OUTPUT=/tmp/nightly-candidate \
  npx --no-install vitest run --config experiments/nightly-perf/vitest.config.ts
```

Run baseline main and candidate in separate worktrees using identical probe, configuration, `test/helpers/sqlite-d1.ts`, `test/helpers/make-env.ts`, and `vitest.setup.ts`. In particular, the baseline's old SQLite helper did not return `meta.changes` and caused unnecessary CAS retries; use the candidate's corrected helper for both arms. This aligns test adapters without changing baseline production code. The probe rejects uncommitted changes to `src/`, schema, wrangler, or package files. Run both arms on the same UTC day and verify identical fixed time, fixture, and adapter hashes.

```sh
node experiments/nightly-perf/summarize.mjs \
  /tmp/nightly-baseline /tmp/nightly-candidate \
  BASELINE_FULL_SHA CANDIDATE_FULL_SHA /tmp/nightly-comparison.json
```

Reject missing conditions among the six cases, SHA/adapter/schema/fixture mismatches, lost memories, changes to other workspaces, SQL failures, and inconsistent counters. Even success leaves `remoteAcceptancePassed=false`. This experiment is excluded from normal Vitest/coverage selection; Worker CI runs it as a separate step. Baseline comparison requires evidence from both arms and a separate check.

## Fixtures and counting

- 200/1,000/10,000 entries per workspace, with either one or two workspaces. The largest two-workspace database contains **20,000 entries total**. Each workspace has 77 eligible entries; the rest are excluded synthetic noise.
- The baseline uses two invocations for compression and graph/staleness; the candidate uses one. Count every statement inside SQL batches. Run EXPLAIN separately for diagnostics and exclude it from the counts.
- Check source-content, ID, and workspace hashes. To assess content preservation, strip only trailing upstream-style digest references pointing to an actual digest generated in this run.
- Verify all rows in other workspaces remain unchanged, including tags.
- Raw SQL and bound values are synthetic only. Create new output files with mode 0600.

Constant SQL counts do not imply constant rows scanned. EXPLAIN SCAN also covers small administration tables and VALUES, so not every scan is a problem. These diagnostics do not measure real CPU, D1 billed rows, KV cost, p95 latency, or live-model quality. The lower-cost arm also processes fewer items per night; do not compute performance improvements from the two arms' SQL counts alone.

Keep historical measurements in private operator storage. Before remote measurement, confirm isolated test resources, synthetic data, execution budgets, and credential destinations. Do not connect production memories.

## Isolated remote diagnostics

`prepare-remote.mjs OUTPUT_DIRECTORY` creates a 200-entry synthetic fixture, schema, hashes, and test secrets in a new empty directory, verifying insertion in local SQLite. Keep output out of Git. Bundle the same `remote-worker.ts` against both production revisions and bind separate temporary D1 databases. Authenticated `/run` invokes the real scheduled entry point. `/reset` verifies test-only tables before restoring the fixture through write admission. Normal Wrangler configuration does not reference this adapter.

Return per-result D1 metadata through authenticated responses and wait for all background work. Preserve existing log redaction; associate Cloudflare Tail CPU using allowlisted `http_request.operation` and sample IDs. Do not log SQL text or authentication secrets. Generation, Vectorize, and KV are simulated. CPU includes the HTTP measurement adapter; it does not measure live-model quality or the ordinary cron-trigger path.

Before measurement, pin source/bundle/adapter/fixture hashes, sample count, cost ceiling, and acceptance criteria in a private manifest. Read back deployed code, bindings, and version. Do not replace missing or failed measurements with zero. Include initialization, reset, and readback in the budget. After preserving evidence, remove only the temporary resources created for the test.

For the nightly-DO candidate, attach the same adapter's `NightlyProbeExecutor` subclass to a dedicated binding. It calls production `runNightly` and collects final D1 metadata once through RPC. Only the latest sample is held in memory; do not add this collection method to production. Match public-Worker and DO CPU in separate Tail events and also verify zero D1 executions in the public Worker. Predeclare cold/continuing measurements, conditions for continuing diagnostics, and acceptance criteria for each execution location.
