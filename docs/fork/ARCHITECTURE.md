# Current architecture and maintenance ownership

This document describes source responsibilities on the 4.0.0 integration branch, separately from production deployment. See `UPSTREAM_SYNC.md` for moved implementations and `DEPLOYMENT.md` for self-hosting. Keep each deployment's real resource IDs, memories, and measurements in separate owner-controlled storage.

```text
Claude / ChatGPT / Codex / Cursor / Browser
                      |
         Public Worker: authentication and routing
            /         |          \
     REST / Assets    MCP       Existing scheduled work
            |         |          |
            |   MCP_EXECUTOR     |
            |   Durable Object   |
            +---------+----------+
                      |
        D1: authoritative content, relationships, history, ledgers
          |           |                 |
    Vectorize      Workers AI      OAUTH_KV
   Derived index   Fixed Gemma128  OAuth, integrations, auxiliary state
          |
   vectorize/cleanup: reconcile D1 deletion records and remote deletion

Explicit backup/restore -- R2: brain-v5 chunks / manifest
Generation              -- Selected provider (direct ChatGPT / Workers AI)
Dashboard and others    -- Cloudflare Access validation
```

MCP_EXECUTOR is a CPU boundary for MCP and nightly work, not another memory-content database. In 3.2.1, MCP uses object `mcp-v1` and nightly work uses `nightly-v1`, sharing one class/binding. Of the scheduled jobs above, only `0 1 * * *` crosses this boundary. User-independent MCP input schemas are reused at module scope. Servers, callbacks, env, and authentication contexts are created per request, without sharing memories or permissions. Rollover, which receives schemas as function arguments, assembles them per call.

ChatGPT administration, direct answers, the read-only weekly preview, and `POST /recall` are forwarded to `mcp-v1` after authentication. REST search checks the actual 32 KiB body limit before forwarding. The same REST implementation reapplies identity, scope, and write admission for usage/recall_log. Search and summary-response parsing move out of the public Worker's CPU allowance. Relocation is distinct from reducing total computation. Reuse the fork lexical Segmenter and UTF-8 counts for short terms while retaining upstream tokenizer and search-result contracts. Do not add shared caches of search terms, content, or user information. Response bodies, including JSON, retain the DO execution context until transmission finishes or disconnects, preventing RPC interruption.

Other REST paths and the other four cron schedules keep their existing execution locations. Nightly RPC waits until D1 admission release and all dynamically scheduled background work finish. RPC failure does not fall back to duplicate execution in the Worker. No new class, binding, migration, DO content storage, alarm, or queue is added.

Keep MCP response-schema compatibility in `mcp/sanitize.ts` byte-identical to upstream. Fork write-admission checks remain in `mcp/handler.ts`. Allow protocol requests and eight pure reads: get, list_projects, list_recent, get_hot_context, get_prompt_capsule, connections, history, and list_teams. Treat recall, unknown tools, and batches containing writes as writes. Authentication and workspace authorization still apply.

To avoid idle DO activity, MCP is stateless, uses JSON and keepAliveMs=0, and sets SDK `maxSubscriptions=0` to disable persistent modern `subscriptions/listen` SSE. Disabling keep-alive alone does not close subscription streams. The real SDK closes legacy GET with 405 while preserving finite tools/call/list requests. Do not create subscriptions that remain open with a browser tab.

Nightly-only RPC has a five-minute wall-clock limit from import start through background work and admission release. On expiry, `ctx.abort(..., { retryAlarm: false })` terminates the dedicated object rather than merely abandoning a promise while I/O continues. Concurrent nightly calls are rejected and cannot extend the first deadline. Normal completion and exceptions clear the timer. This termination does not apply to the MCP object. Since forced termination cannot guarantee finally-block release, retain expiring admission (16 minutes after its last update), CAS, journals, and subsequent recovery paths. Do not roll back completed D1 writes or immediately retry interrupted work. Five minutes bounds one nightly invocation, not total daily account cost.

## Configured binding responsibilities

`wrangler.jsonc` is authoritative for the shared deployment configuration. These tables explain it for readers; they do not introduce another configuration file or generic plugin framework. Unit tests check binding-name parity.

<!-- runtime-bindings:start -->
| Binding | Type | Responsibility and behavior when unavailable |
| --- | --- | --- |
| `DB` | D1 | Authoritative content, tags, tiers, relationships, history, write admission, restore cursors, and deletion records. Required. |
| `VECTORIZE` | Vectorize | Rebuildable fixed 128-dimensional derived index. Lexical degradation during outages does not guarantee full search quality. |
| `AI` | Workers AI | Fixed EmbeddingGemma, plus existing inference when ChatGPT is unselected. Existing degradation/recovery applies when quota is exhausted. |
| `OAUTH_KV` | KV | OAuth, external integrations, quota observations, auxiliary caches. Neither authoritative memory content nor a point-in-time snapshot with D1. |
| `ARCHIVE` | R2 | Private manual brain-v5 backup/restore. Backup APIs return 503 when unconfigured. No dual writes with normal persistence. |
| `MCP_EXECUTOR` | Durable Object | CPU isolation for MCP and nightly work using separate object names. An operational requirement of the current deployment; local fallback does not make removal advisable. |
| `ASSETS` | Workers Assets | UI assets on the same Worker. The Worker authenticates dashboard routes first. |
<!-- runtime-bindings:end -->

Access is an authentication boundary using the following secrets and `src/lib/cloudflare-access.ts`, not a binding. The current configuration's `secrets.required` is listed below. Do not store values in documentation, logs, or tests.

<!-- deployment-secrets:start -->
| Secret | Purpose |
| --- | --- |
| `AUTH_TOKEN` | Existing authentication contract |
| `ACCESS_TEAM_DOMAIN` | Access validation domain |
| `ACCESS_AUD` | Access audience for MCP and related paths |
| `DASHBOARD_ACCESS_AUD` | Dashboard Access audience |
| `ACCESS_ALLOWED_EMAIL` | Allowed user |
<!-- deployment-secrets:end -->

`CHATGPT_CREDENTIAL_KEY` is optional and configured only by owners using direct access. It is not required for normal startup.

PR #117 was deployed on 2026-10-01 and removed the VPS generation path. There is no VPC binding, legacy adapter, CLIProxy selection setting, or API-key requirement. `CHATGPT_MODEL` selects the normal direct-connection model. See `DEPLOYMENT.md` for self-hosting and updates. Candidate generation models and operations are:

| Operation | Model | Failure behavior |
| --- | --- | --- |
| classify | gpt-5.6-luna (CHATGPT_MODEL) | Classification remains pending |
| recall-summary / answer | gpt-5.6-luna (CHATGPT_MODEL) | Empty summary; 503 if answer startup fails; stream error on interruption |
| smart-merge / contradiction | gpt-5.6-terra | Skip merging; contradiction remains undetermined |
| digest / weekly-insight | gpt-5.6-terra | Skip digest persistence; weekly candidates remain retryable |

Keep explicit `CHATGPT_OPERATIONS` selection. Failed selected operations do not automatically fall back to Workers AI.

Direct ChatGPT access through the public Responses API was added on 2026-09-30. Only operations explicitly listed in `CHATGPT_OPERATIONS` use it; unselected operations use upstream Workers AI. New installations default to no selection. Direct dispatch requires matching `CHATGPT_OWNER_WORKSPACE_ID` and credential owner binding, with actual scope limited to the owner's personal workspace. Team, member, other-admin, unknown, and mixed scopes use normal Workers AI. Current 4.0 query-tags matches known tags; do not restore an LLM call.

Callers depend directly on `src/lib/chatgpt.ts`, which also owns per-operation bounded budgets and persistence-JSON validation. Preserve model selection and JSON validation of persistence decisions; direct-access failures never automatically switch providers. Initial authentication uses a local 127.0.0.1 callback with signature, issuer, audience, and nonce validation, authenticates for the Worker's stable host, and transfers credentials to an owner-only API. The Worker also verifies ID/access token signatures and grant.

Connection-management APIs and fixed-prompt probes forward to existing `mcp-v1` after owner authentication. Direct `/chat` likewise forwards after user authentication, isolating credential decryption and Responses SSE parsing from the public Worker's 10 ms allowance. Forward immediately after entry authentication and body-limit checks; DB initialization and answer-user lookup happen inside the DO. DO waitUntil tracks answer SSE through completion/disconnect, retaining execution context and generation logs after RPC returns. The DO does not persist credentials or add/change bindings, classes, cron schedules, or Gemma128.

Call public Responses with `store:false`, `stream:true`, and system converted to developer. Only `response.completed` counts as success; reject failed/incomplete streams, disconnects, invalid JSON, and excess output. Preview does not accept `max_output_tokens`. Existing input limits and deadlines, a local character cap of requested tokens × 8, and a total SSE limit of 256 KiB bound processing. These differ from a server-enforced token limit or a guarantee about actual consumption.

`src/lib/chatgpt-session.ts` creates dedicated D1 table `chatgpt_session` during owner connection without changing the memory schema version; it is separate from entries/edges write fences. Encrypt the entire credential with AES-256-GCM, a random IV, and fixed AAD. The key is a Worker secret. R2 brain-v5 backups/exports contain neither credentials nor the key, while D1 Time Travel retains ciphertext. Conditional UPDATE on D1 primary serializes refresh and atomically stores the replacement with a revision. Do not resend uncertain refreshes; interrupted refresh may require reauthentication. See [CHATGPT_DIRECT.md](CHATGPT_DIRECT.md) for connection, probes, revocation, and recovery.

Simple text generation for recall summaries, digests, and weekly reasoning selects the provider through existing `generateText` in `src/lib/ai.ts`. Callers supply prompts, token limits, and Workers AI models; weekly reasoning retains `INSIGHT_LLM_MODEL`. Interpretation, trimming, empty responses on failure, and retry eligibility remain with callers. Do not fold classification quota records, smart-merge JSON contracts, or chat SSE into this function. Shared generation adds no new cache, retry, state, dependency, or binding.

Gemma128 embeddings continue using Workers AI even when every operation is selected; this does not guarantee free allowances will never be exhausted. Record operation/model/status/latency in `ai_provider_call`, without content or authentication information. Short operations have 15-second deadlines; additional generation operations have 25 seconds. Inputs and outputs have per-operation bounds. Do not truncate oversized input and use it for persistence decisions. Validate completion events, empty text, and persistence-JSON types. Convert answers to SSE while preserving system/user roles, and do not emit stop or DONE before completion.

## Upstream and fork responsibilities

| Responsibility | Authoritative implementation | Constraints on changes |
| --- | --- | --- |
| Base tokenizer, graph, ordinary recall | Active upstream | Keep `src/text/tokenize.ts` byte-identical. Reduce fork code when upstream provides equivalent functionality. |
| Fixed embedding profile | `src/embedding/profile.ts` | Treat `embeddinggemma-mrl128-v1`, 128 dimensions, query/document inputs, and thresholds as one unit. |
| D1 search constraints for Japanese and identifiers | `src/text/lexical-query.ts` and existing recall | Do not duplicate upstream scoring. Use the derived index only when FTS5 can express every probe; compounds and CJK bigrams retain LIKE. A 128-candidate cap is not a scan or billed-row cap. |
| Write admission, migration, restore barrier | `src/migration/write-lock.ts` and D1 triggers | Persistence, deletion, and graph updates share one contract. Do not disable protection to reduce differences. |
| Obsolete-vector deletion and retry | `src/vectorize/cleanup.ts` | Centralize D1 records, reference checks, capability refresh, mutation receipts, rechecks, and page limits. |
| Store, update, append coordination | `src/capture/store.ts` | Call cleanup while preserving source CAS, before-images, and graph-update ordering. |
| History, logical tiers, rollover | Existing fork modules in `src/memory/` | D1 is authoritative; a tier change alone does not regenerate vectors. |
| Prompt Capsule | `src/prompt-capsule/` and existing route/tool | Preserve determinism, authorization, and existing APIs. Do not remove it without assessing utility. |
| HTTP operational protection, direct ChatGPT, MCP isolation | Existing fork modules | Do not move fork logic back into upstream common helpers. External connections have separate operational ownership. |
| Bounded body reading | `src/lib/body.ts` | Share only byte limits, abort notification, and reader release. Do not depend on HTTP responses, authentication, providers, or Env. |

HTTP input, Notion JSON, Calendar ICS, and ChatGPT authentication/model-catalog JSON share the reader. Callers choose limits: per-HTTP-call bounds, Notion 128 KiB, Calendar 32 KiB, ChatGPT auth JSON 128 KiB, and catalog 2 MiB. Check actual bytes rather than trusting Content-Length, and stop on overflow. Cancellation failure or stalling must not mask the original size rejection; always release an acquired reader. Nonfinite or malformed declared lengths are not grounds for early rejection; decide using actual bytes, including Infinity from Notion/Calendar. HTTP 400/413 mapping, JSON parsing, ICS complexity checks, and ChatGPT deadlines/error classification remain with callers. The reader adds no timers or permanent connections. Log callers import observability directly; compatibility re-exports from http were removed.

The cleanup module imports only the Env type, write-lock, per-invocation `runtime/d1-budget`, constants, and the batch module; it does not depend on capture orchestration. The budget module imports only the Env type and creates no service or persistent ledger. Cron, migration, and admin import drain, bulk-submit, and scheduling constants directly from cleanup. Compatibility re-exports from `store.ts` were removed while preserving deletion-ledger, receipt, and page-limit implementations.

Lifecycle forget/deprecate also delegates post-commit index deletion to `submitLifecycleVectorCleanup()`. Source CAS, the deletion transaction including history, public results, and nonfatal logs remain in lifecycle. This path submits once and leaves its legacy array-form ledger for a recheck after 60 seconds. Empty arrays are cleared through the existing delete marker plus DELETE batch. Keep this distinct from ordinary cleanup's three retries and receipt format, preserving capability refresh → optional hook → remote deletion → ledger update ordering.

The authoritative three-attempt admission release is `migration/write-lock.ts:releaseMemoryWriteAdmissionWithRetry()`. `beginMemoryWriteAdmission()` owns ordinary response-end/waitUntil tracking and the release Env. Authentication initialization acquires admission only when needed and uses the same release. Failure logging remains with callers; do not turn a committed operation into HTTP 500. Retain the existing 16-minute TTL.

Entry/edge import uses existing `isMemoryWriteFenceError()` for fence classification. A batch rejected by the lock must not proceed to sequential fallback. Keep SQL generation and result handling in their upstream locations; preserve individual-row failures, hooks, page limits, SQL counts, and restore-lease behavior.

Normal updates and index-failure updates share existing `src/memory/history.ts:commitSourceWithHistory()` for one batch: old-version INSERT → source UPDATE → history edge. `store.ts` still decides source CAS conditions, success detection, and ordering relative to remote operations. Updates without history execute only the existing source UPDATE run, without adding retries or new admission. Write protection is not fully separated by this extraction: source CAS and remote-update coordination remain.

Derived-cache D1 generations belong to existing coordinator `migration/write-lock.ts`. All generation callers import it directly; compatibility re-exports from `migration/embedding.ts` were removed. This breaks the runtime cycle `store → vocabulary → embedding migration → store` without changing generation tables/keys, creation-race handling, reset updates, SQL counts, or adding modules.

## Source of truth, recovery, and operations

Hot/Warm/Cold are logical D1 states; Cold content is not offloaded to R2 or automatically excluded from normal recall. Vectorize is rebuildable from D1; never mix different profiles in one index.

`entries/export.ts` owns pre-generation estimates and post-generation byte checks for HTTP export; `routes/entries.ts` does not import R2 implementation. Internal failures use `ExportError`, preserving HTTP 409/413 wording and paged guidance. This module owns the complete-export limits of 500 rows, estimated 512 KiB, and actual 768 KiB. `backup/r2.ts` imports the same values under legacy constant aliases to preserve brain-v2 restore bounds. Compatibility re-exports were removed. R2 failures retain `BackupError`.

The 4.0 integration branch uses schema 9 and upstream entry_versions / entries_trash / recall_log. Current R2 format `brain-v5` stores entries, typed edges, Project settings, and four history tables in chunks/manifests; it also reads `brain-v2` / `brain-v3` / `brain-v4`. Restore resumes with four durable cursors (entries, edges, projects, history) and a lease. The deployed 3.7.0 version used schema 8 / brain-v4. Projects participate in ordinary write admission and exclusive restore. Backups are memory-only: they do not restore OAuth, integration credentials, workspace definitions, user configuration, sync cursors, or Vectorize indexes. Preserving a row's workspace ID is separate from restoring workspace definitions or authentication.

Current backups require explicit integration disconnection and mirror removal. No automatic purge is added. Keep detailed procedures in `BACKUP_RESTORE.md`. Real disconnection, purge, reconnection, and re-embedding require separate authorization.

The 3.2.1 configuration also has five cron schedules, combining compression, graph, and staleness in one nightly slot and returning the freed slot to upstream's team-weekly trigger. No backup cron or resident process is added. Nightly work and hourly sync/Push share pre-dispatch SQL counting and first reserve three statements for admission release. Cleanup reserves up to eight statements before starting; final cleanup uses remaining budget. Reserve remote-operation acceptance records before dispatch. Per-workspace graph candidates advance using KV keyset cursors. Unprocessed work, failure, or KV inconsistency is not evidence of completion. [Nightly budgets and carry-over](NIGHTLY_D1_BUDGET.md) documents preservation rules, regression tests, and remaining scan/performance concerns.

CI success, local SQLite success, and dry runs do not measure production CPU, D1 billed rows, or p95 latency. Source integration and each owner's deployment are separate. See `DEPLOYMENT.md` for deployment and `SEARCH_QUALITY.md` for measurement conditions.

## Degraded operation during Workers AI exhaustion (2026-09-08)

New memories and appends remain in D1 with semantic indexing deferred; search degrades to keywords. New-memory classification follows its selected provider: with ChatGPT selected, it still runs asynchronously during embedding exhaustion. ChatGPT failure leaves the memory unclassified without falling back to Workers AI. Classification success is not evidence of embedding recovery and does not clear Workers AI quota observations. Full-replacement update retains its existing contract: failure leaves content unchanged and returns the recovery time.

REST capture reports `classification_status` as `scheduled` (accepted asynchronously) or `deferred` (postponed by exhaustion). Scheduled does not guarantee classification success. Existing `classification_pending` is a compatibility field for exhaustion deferral, not a count/state of all incomplete classification. MCP/UI receipts distinguish storage success from pending indexing. `/health` retains the existing readiness meaning of `ok` and adds `status: degraded` and `database.status: reachable`. D1 reachability verifies read/initialization paths, not all writes or external generation. `no_known_outage` is a passive absence of observed outages, not an active AI-success check.

Index recovery retains existing small batches and cron slots, stopping a batch on quota failure. Manual `/vectorize-pending` makes one real request even during a known quota outage; do not repeatedly trigger it. `/classify-pending` can also recover external classification, with existing eligibility (missing status/kind) unchanged. This work adds no second platform or offline synchronization to survive exhaustion of D1/Workers allowances themselves.

To retain newly stored, unindexed memories in tagged search after AI recovers, return rows with `vector_ids=[]` and clear lexical matches for every query term to the merged candidate pool within existing tag candidates. This rescue accepts script boundaries between Japanese and identifiers, such as `Cedarの移行` or `SB-024を反映`, but rejects substrings such as `Cedarwood` or `SB-0249`; normal search weights stay unchanged. Regardless of AI availability, filter using already-fetched D1 eligibility (workspace, tag, kind, time, deprecated state) before MMR top selection so ineligible rows cannot consume needed slots. Candidate counts, SQL counts, and workspace/time/kind/status filters are unchanged. This does not solve ordinary untagged ranking or guarantee retrieval of appended text in already-indexed memories.

Existing `/stats` aggregation returns `oldest_unvectorized_at`: the oldest creation time of newly unindexed memories outside the grace period and excluding deprecated rows, not append-passage waiting time. The UI shows total pending count and age. Each manual repair action runs one batch and reports recent work, failures, and remaining items without automatically submitting another batch. Restore's multi-batch flow retains its separate contract.

Generation language, evidence, and quotations are checked with two fixed synthetic cases in `experiments/answer-quality`. Separate mechanical checks from human review; do not add model changes or automatic regeneration. Keep this improvement out of Issue #54's fixed comparison source and fixtures.

Search-continuity regression tests start from stored synthetic rows and call the real `/vectorize-pending` route. They check stopping after one quota failure, then recovered embedding, Vectorize upsert, D1 update, repeat search, and admission release. AI and Vectorize use test responses; this is not evidence of live-service quality. Direct SQL assignment of indexed state was removed from this regression test.

`UPSTREAM_OWNED_PATHS` is authoritative for upstream ownership. Project filter/resolve were added alongside existing Prompt Capsule implementation/routes and must match upstream exactly. Project registry/autocreate write admission remains a fork boundary. Nightly SQL budgets use explicit Free/Paid constants; the unused legacy `NIGHTLY_D1_SQL_LIMIT` name was removed.

## Deadlines and notifications in 3.5.0

Four deadline columns are authoritative in D1 entries. Capture, MCP append, snooze/clear, and nightly extraction pass through existing admission and source-update triggers. MCP append commits content and deadline together through CAS. HTTP export / R2 brain-v5 retain deadlines as optional columns; legacy formats set them to null. Nightly extraction uses per-workspace cursors, at most two model calls, and stale reassessment in batches of two. Failure, conflict, or insufficient budget does not produce a completion summary; retain the cursor for the next run.

Push subscriptions are in D1 push_subscriptions; VAPID keys and delivery support state use existing OAUTH_KV. Exclude those credentials from memory exports/backups. Add no binding or cron. After hourly sync, Push reserves six statements per workspace from the shared 50-SQL budget, with at most four workspaces and 40 sends per invocation. Resume partial device delivery from KV records. KV eventual consistency and external delivery preclude strict exactly-once guarantees. Dedicated AI-recovery times remain for recovery; notifications run at normal sync times.

Deadline candidates rotate by date/time and ID; workspaces rotate regardless of send limits. Preserve successful devices during partial delivery and retry failed devices on the next scheduled pass. Delivery-record cleanup compares at most 30 records with current D1 deadlines. Keep records even for deadlines older than 30 days while the same deadline remains on the current memory.

Nightly deadline extraction restarts scanning on the invocation after reaching the end, catching old memories newly classified as tasks while retaining the two-candidate model budget. Reuse only successful abstention decisions by input fingerprint for at most 30 days to skip model reruns. Changes to content, tags, workspace, model, timezone, or decision policy force reassessment on the next scan. Cache no content or model output. This is auxiliary state in existing KV; missing, corrupt, unavailable, or expired cache falls back to normal assessment. Do not cache model failures or responses lacking required decisions; track failure counts per input. Add no D1 columns, SQL, or dependencies—only per-candidate KV reads and writes for successful abstentions.
