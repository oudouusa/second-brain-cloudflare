# Working on second-brain-cf

## Goal and context
Preserve behavior and safety while reducing the fork-specific work required for
upstream updates. Prefer active upstream implementations; do not build another
agent framework or replace the search engine to make a local change easier.

Read code, tests and docs relevant to the change. Use `docs/fork/FORK_SCOPE.md`
and `docs/fork/UPSTREAM_SYNC.md` for ownership or upstream integration,
`docs/fork/ARCHITECTURE.md` for runtime boundaries, and `wrangler.jsonc` when
preparing a deployment. Use `package.json` and `.github/workflows/ci.yml` to
select checks. When docs disagree with code, verify and fix the specific
discrepancy. These references are not a reading list for every edit.

## Boundaries
D1 is authoritative; Vectorize is derived. Preserve fixed Gemma128, write
admission, CAS/history, deletion receipts, workspace isolation, authentication
and the MCP CPU boundary. Do not weaken tests or guards to make a refactor pass.
Keep upstream history, leave upstream-owned files identical where required, and
avoid new runtime dependencies, installer changes or unrelated abstractions.

Read current branch/PR state before publishing. Do not overwrite concurrent work,
force-push, bypass branch protection or push to public upstream. Unless the user
explicitly extends the task, implementation authorization permits an isolated
branch and reviewable PR, not main merge,
production deployment, real-memory mutation, client-global instruction changes
or external-service configuration. Resolve authorization from the user's
instructions for this task: an explicit request to merge or deploy authorizes
that operation and its necessary preparation and verification. Do not request
the same authorization again. Approval for unrelated tasks does not carry over.

## Finish the agreed unit
Define the outcome, relevant constraints and evidence needed. Choose the steps
that fit the change; continue through implementation, appropriate tests, fixes,
existing-doc updates and a reviewable PR without seeking approval for every
internal step. Keep PRs reviewable, but do not mistake one extracted helper for
completion of the whole agreed goal. Ask only when missing authority or a
material decision cannot be resolved from available context. Report actual
blockers and completed work instead of promising later background work.

## Verification
Choose local checks from the changed behavior and files. Run affected regression
tests for code changes; prose-only edits do not need new tests or a full local
Worker suite. Before merge, require successful Worker CI for the final revision:
fork boundary audit, typecheck, scope check, test:coverage, benchmark:validate and
the other existing CI commands (including build/startup). Successful CI covers
those gates; do not duplicate the full suite locally without a specific reason.
Do not repeat an unchanged successful gate without a new change, failure or
unresolved risk. Never substitute an old SHA's CI for the current one. Report
what ran, what did not, and why; synthetic/static checks are not live retrieval
quality, CPU, latency or D1 billed-row measurements. Preserve existing evidence.

For `AGENTS.md` edits, run `test/unit/ai-instructions.test.ts`. For client memory
policy, renderer or installation changes, also run
`node scripts/render-ai-instructions.mjs --check` and
`test/unit/connect-ai-clients.test.ts`. `AI_Instructions/README.md` explains
the common memory policy and explicitly opt-in installation. Client memory
instructions are not repository development instructions: do not install this
file globally or load client policies as development requirements. No memory
lookup or memory write is required merely to work in this repository.
