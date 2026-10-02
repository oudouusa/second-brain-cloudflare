# Nightly D1 budgets and safe carry-over

This work began as a follow-up to PR #80's initial candidate `14dcea320b5c30edf63277807ffad91d5d23c412` on 2026-09-12. It preserved the then-current division between upstream combined nightly processing, CLIProxy generation, Gemma128/Vectorize, and authoritative D1. SQL controls were included in main and the 3.6.0 deployment. This document alone does not establish acceptance of the full P5 CPU, billed-row, and quality evaluation.

The CLIProxy references and deployment statements below describe that historical change. For the current direct ChatGPT connection and execution layout, see [ARCHITECTURE.md](ARCHITECTURE.md) and [CHATGPT_DIRECT.md](CHATGPT_DIRECT.md).

## Problem and scope

The initial limits of one tag, four graph candidates, and five stale candidates did not protect cleanup and retry budgets. Earlier investigation measured 99 SQL statements for just 30 pending deletions and 144 for the extracted nightly pipeline. Graph processing with no neighbors also repeatedly selected the newest four entries.

The SQL-budget implementation added one production module, `src/runtime/d1-budget.ts`, with no imports except the Env type and no persistent ledger, custom database, cron, DO, queue, or external service. Its audit allowlist is explicit; existing write-fence, ownership, dependency, scope, and coverage gates remain. A later CPU-boundary change moved the existing implementation to `runtime/scheduled.ts` and forwarded only nightly work to the existing DO. The same default Free budget of 50 statements, explicit Paid budget of 1,000, and reservations apply inside the DO. Cleanup's lower-layer dependency contract was extended only for this counter, prohibiting reverse dependencies on capture/provider orchestration.

## Per-invocation reservations

Attach a SQL ledger only to `nightly_maintenance` in `src/index.ts`, according to the execution profile. The default is a Free-compatible 50. Only an environment confirmed to use Workers Paid should explicitly set `NIGHTLY_D1_EXECUTION_PROFILE=paid` to expand to 1,000. No Worker API discovers the subscription plan. Unset, unknown, or misspelled values safely select 50; case differences are accepted. This profile is a safeguard against published execution limits, not a billing meter. Do not implicitly apply it to HTTP, manual operations, or other integration/weekly cron jobs. Initialization, admission acquisition, workspace selection, three passes, deferred writes, cleanup, and admission release share one ledger.

- Consume one slot before dispatching run/all/first/raw, not at prepare/bind time.
- Reserve all statements in a batch before dispatch; if insufficient, send none of it.
- Do not refund failed dispatches. Count SQL slots separately from D1 calls.
- Count exec statements conservatively by semicolons, potentially overcounting literals/triggers. Even an empty batch costs at least one slot, preventing unlimited zero-cost dispatch.
- Deduct reservations synchronously before await. Sibling work cannot use reserved capacity while its owner waits for a provider.
- Return only unused slots. Double release or reuse of a closed reservation cannot replenish capacity.
- Reject mixing raw and reserved statements, batches from different reservations, and uncounted session/dump paths.
- Preserve the original Env and authentication token, including inherited nonenumerable admission tokens.

Reserve three SQL statements for release at invocation start; ordinary work cannot consume them. Preserve up to three existing release attempts. If the DB keeps rejecting release, rely on existing fail-closed expiry recovery without claiming guaranteed release.

## Conditions for remote side effects

Cleanup first reserves up to eight slots for old debt. After all three passes and dynamic waitUntil work finish, return the actual unreserved remainder to cleanup. Free carries over small amounts as before. Paid can advance up to three pages per invocation, so splitting work across 12 nights solely to fit 50 is not the standard Paid behavior. Both obey the existing three-page maximum and shared ledger. Reserve according to item state rather than sending large amounts based only on page count.

| Unit | Reservation | Preserved guarantee |
| --- | ---: | --- |
| Retire completed cleanup row | 2 | Refresh capability and DELETE in one batch |
| Remote deletion/redeletion | 3 | Admission refresh, remote marker, returned receipt persistence |
| Upsert new vectors | 6 | Authority, acceptance, source CAS, journal retirement |
| Source mutation with history | 2 additional | Preserve before-image and history edge in the existing batch |
| Retry stale CAS | 1 reread + affected row count | Keep write slots reserved while awaiting the reread |

For source upsert, create the original durable journal before reserving the required capacity. If capacity is unavailable, defer before remote dispatch and retain content, old vector references, and the cleanup journal. Provider, receipt, or source-write failure uses existing compensation and journals. If extra compensation does not fit, do not discard a journal while the remote outcome is unknown. An acceptance receipt is distinct from confirmed deletion visibility.

Cleanup with `sqlBudget` requires an already budgeted Env. Passing a number from an uncounted caller must not create an appearance of enforcement. Existing manual operation without the argument remains supported.

## Retries and incomplete work

A nightly stale batch rejected by a DB error does not amplify into repeated per-row fallback. CAS conflicts retry only within the existing three-attempt maximum and only when reread/write rounds can be reserved. Do not advance the confirmation cursor for unprocessed rows as if successful; leave them eligible for the next invocation.

If the bulk rolled-up UPDATE of compression sources fails, nightly work does not expand into up to 50 individual updates. Preserve source memories and report `complete:false`. If a saved digest remains, the existing cooldown applies. This change added no new exactly-once or digest-repair protocol.

Deferred nightly work uses the same budget/admission, and results are finalized only after registered work finishes. Budget deferral, incomplete passes, and cleanup errors retain the previous complete night summary and ranAt, with outcomes such as `scheduled_job.outcome=partial`. A summary does not imply that every waiting row was processed that night. `nightly_budget` emits only used/calls/deferred/limit, never SQL, content, workspace IDs, or credentials.

## Fair graph candidate selection

For a known workspace, graph processing combines memories with old-policy edges and unconnected memories in one candidate set, advancing by keyset `created_at DESC, id DESC`. Existing KV stores cursors separately by workspace and policy. Zero neighbors or a per-candidate failure does not stop scanning. Wrap at the end to revisit failures, content changes, and new entries. IDs distinguish equal timestamps and allow continuation after deletion of the cursor's original row. Existing manual/legacy paths without a workspace remain unchanged.

KV is neither transactional nor a monotonic concurrent register. Delayed reads or failed writes can revisit windows. A cursor does not prove edge commitment or guarantee immediate reassessment, exactly-once processing, or a sweep duration under unlimited arrivals. One new workspace-bound SELECT changed the scope inventory to 141/76/19/2. No exemptions were added or safety assertions removed to make counts fit.

## Regression tests and local ledger

Four added files covered `d1-budget` (20 cases), `nightly-d1-budget` (22), `vector-budget-reservation` (5), and `graph-refresh-rotation` (11). Existing ownership/scope/cron exact-count checks were adjusted for the new boundaries. Nightly tests used the actual Worker.scheduled entry, real SQLite and write fences, and the then-current real CLIProxy adapter, with only CLIProxy/AI/Vectorize responses synthesized. No external communication or production data was used. The test native facade also rejects more than 50 SQL slots in Free fixtures or 1,000 in Paid fixtures, including release and dynamic waitUntil work.

| Synthetic fixture | SQL slots | D1 calls | Result |
| --- | ---: | ---: | --- |
| Normal/first cursor, short and long text | 45 | 36 | Actually commits digest/edge/stale changes |
| Additional Sunday cleanup | 47 | 37 | Same |
| Concurrent 30 pending remote deletions | 46 | 38 | Sends a bounded subset and retains remaining work/journals |
| Concurrent 30 confirmed deletions | 48 | 38 | Partial retirement; remainder retained |
| 30 rows still visible after deletion | 48 | 39 | Bounded resend with receipts retained |
| Persistent stale CAS conflicts | 48 | 32 | Defers without advancing unprocessed confirmation cursors |
| Stale DB write rejection | 45 | 36 | Incomplete, without individual fallback |
| Bulk update of 50 compression sources rejected | 45 | 36 | One rejection does not become 50 individual attempts |
| First two admission-release attempts fail | 47 | 38 | Third reserved attempt releases admission |
| Paid, 30 confirmed deletions | 57 | 45 | Clears within one night with the same journal/retirement boundaries |

The Paid row verifies increased work per invocation, not billed rows, CPU, or production performance.

A Free test simulated 24 nights with the same finite fixture. The original debt of 30 deletions reached zero on invocation 12. All 24 invocations stayed at or below 50 and retained 77 source memories. This is a synthetic-load result, not an operational SLO or a claim that 30 deletions completed in one night. Backlog can grow if arrivals exceed capacity. Indexing an already-created source may also be deferred for lack of budget; combined throughput with pending recovery belongs in P5 measurement. Twelve graph memories without neighbors were all visited in three passes of four, wrapping on the fourth. Separate cases check new-DB initialization, all-release-attempt failure, provider/receipt failure, and compound failures.

These are local fixture measurements, not Cloudflare billed rows, real CPU, live API enforcement, or model-quality measurements. Record tests and CI for the actual HEAD in its PR; do not reuse the initial candidate's green CI for later HEADs.

## Deferred work and removal criteria

- The original change did not modify schema, indexes, dependencies, installer, secrets, five cron schedules, or CLIProxy configuration.
- The only new optional binding was `NIGHTLY_D1_EXECUTION_PROFILE`. Existing deployments without it retain a Free-compatible 50. Selecting Paid, merging main, and production deployment require authorization separate from that PR's code changes.
- Rows scanned by JSON tag aggregation, staleness sorting, graph sweeps, and cleanup queries remain separate concerns. Review indexes separately, including build/update rows_written and fresh/upgrade migrations. Bounded SQL dispatch count does not bound a full-table scan or large UPDATE's daily consumption.
- Staying within a budget is distinct from sufficient throughput. This work did not qualify real 10 ms CPU compliance, remaining daily allowance, or latency.
- Reserved receipt writes do not guarantee DB/provider success. Preserve durable journals and expiry recovery on failure.
- If upstream provides equivalent common budgets, reservations, and fair candidate selection, retain tests while reducing this fork difference.
- Run P5 only in an authorized isolated environment with synthetic data, cost limits, and stop conditions. Main merge, production deployment, real-memory operations, new infrastructure, paid upgrades, and PR #73/#68 integration were outside that fix's scope.
