# Fork ownership and boundaries

This self-hosted fork preserves the history of [rahilp/second-brain-cloudflare](https://github.com/rahilp/second-brain-cloudflare). Personal deployment records and credentials do not belong in public history.

## Upstream base

- Initial base: `99f1c1a2a005d8f835aef93c786cfe07f54780f3`.
- Tag for that base: `upstream-base-2026-08-23`. Public candidates include this tag pointing to the upstream commit.
- Current audit target: `upstream/main`. The integrated revision is `4e30f973802e54740f7e709516c365078760febb`, which merged the upstream 4.0.0 release.
- No separate watch target: both CI boundary checks and the scheduled synchronization audit now follow `upstream/main`.

## Contracts to preserve

D1 is authoritative for memories; Vectorize is a derived index. Preserve fixed 128-dimensional EmbeddingGemma, write admission, CAS, before-image history, held-row isolation, deletion receipts, workspace isolation, and the CPU boundaries for MCP and nightly work.

Do not replace the system with another agent framework or search engine. Delegate to active upstream implementations and separate fork safety requirements from common upstream work. See [ARCHITECTURE.md](ARCHITECTURE.md) for modules and bindings.

## Upstream-owned components

The 21 files listed in `UPSTREAM_OWNED_PATHS` in `scripts/audit-upstream-sync.mjs` must be byte-identical to the audit target. Do not independently rewrite the tokenizer, Prompt Capsule, FTS maintenance, reranker, or project resolution.

Keep `installer/`, `package-lock.json`, dependencies, devDependencies, overrides, and install lifecycle scripts aligned with upstream as well. Do not weaken this audit for publication. Review dependency findings using [DEPENDENCY_SECURITY.md](DEPENDENCY_SECURITY.md) and prefer fixes aligned with upstream.

## Fork-owned components

- The fixed Gemma128 profile, Vectorize generations, and bounded degradation and reindexing when embeddings are unavailable.
- Search adjustments for CJK text and full-width identifiers, using normal upstream search paths with only the necessary compatibility paths added.
- R2 memory backup/restore, logical tiers, version history, and write protection.
- Cloudflare Access, authentication for owner administration, and dispatch of MCP, REST, and nightly work to the existing DO.
- Optional ChatGPT Responses connectivity limited to the owner's personal workspace.
- Japanese weekly insights, source-quotation and stored-JSON validation, and bounded retries.

ChatGPT is off by default. Even when enabled by the owner, the owner's plan is not available to Team, member, other-admin, mixed, or unknown scopes. A failure in a selected operation does not automatically fall back to Workers AI. VPS, CLIProxy, and VPC service bindings are not used.

Moving CPU work to a DO does not guarantee lower total CPU, latency, or cost. Retain the existing DO class and binding without adding persistent subscriptions or another state database.

## Verification during updates

Run the boundary audit in [UPSTREAM_SYNC.md](UPSTREAM_SYNC.md) first. For upstream changes to moved code, compare the source and destination identified by the audit and run the related tests. CI retains type, scope, coverage, CPU budget, nightly SQL, benchmark, build, and startup checks.

Worker deployment, memory mutation, and GitHub publication each require an explicit target and authorization. Merging source does not automatically deploy to every user's account.
