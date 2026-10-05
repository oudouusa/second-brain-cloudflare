# Upstream synchronization

## Audit targets

The current audit target is `upstream/main`. The integrated revision is `4e30f973802e54740f7e709516c365078760febb`, which merged the upstream 4.0.0 release. Its tree matches the previously integrated release branch, so taking in the merge history did not change application files. No separate watch target is needed. The initial base tag, `upstream-base-2026-08-23`, points to upstream commit `99f1c1a2a005d8f835aef93c786cfe07f54780f3`.

```sh
git remote add upstream https://github.com/rahilp/second-brain-cloudflare.git
git config remote.upstream.pushurl DISABLED
npm run upstream:audit:boundary
npm run upstream:audit
```

If the upstream remote already exists, skip adding it and verify its URL and push URL. Fetch the base tag in public clones as well. GitHub CI fetches tags.

`upstream:audit:boundary` enforces ownership boundaries and reports new commits and merge conflicts. `upstream:audit` also fails on unintegrated commits and conflicts. The scheduled workflow runs weekly; it does not automatically update dependencies or deploy to production.

## Update sequence

1. Check the working tree, PRs, and deployment candidates; create an isolated branch.
2. Merge upstream history. Keep private operation records and credentials out of the public branch.
3. Check the 21 upstream-owned files, dependencies, lockfile, installer, and the allowlist for new modules.
4. Compare moved sources and destinations identified by the audit, preserving the contracts below.
5. Run the relevant tests and require successful Worker CI for the final SHA before merging.
6. For each owner's deployment, explicitly select the ignored configuration and record recovery points and verification results in separate owner-controlled storage.

## Moved code and preservation contracts

| Upstream change area | Fork checks |
| --- | --- |
| Capture, lifecycle, import, history | Admission, CAS, before-images, held rows, deletion receipts, pending index, restore actor/workspace |
| Schema and DB initialization | Fork write-protection DDL and ordering, upgrades from old schemas, FTS guards, entry counts |
| Search, tokenization, reranking | CJK adjustments, bind limits, eligibility before LIMIT, query-cache scope, failure recovery |
| Generation prompts and persistence | Per-operation ChatGPT scope, JSON validation, quotations, completion status, no fallback, bounded retries |
| Routes, MCP, HTTP bodies | Entry authentication, actual byte limits, reauthorization inside the DO, bounded responses, stream termination, admission release |
| Scheduled work, insights, digests | Five cron schedules, rotation SQL budgets, persistence limits, stopping when maintenance consumes the budget |
| Backup, export, restore | Memory-only format, temporal cursors, scope, restore write locks, credential exclusion |

Detailed move mappings are in `movedImplementationReviews` in `scripts/audit-upstream-sync.mjs`. A suggested mapping is not proof of semantic compatibility; verify it against the relevant regression tests.

## Publication boundary

Public candidates use an upstream commit as their parent and add audited fork changes. Preserve upstream history without making private main or private branches ancestors. Do not mirror-push a private origin to the public repository.

The upstream [ChatGPT connection proposal](https://github.com/rahilp/second-brain-cloudflare/issues/384) initially covers owner-only dashboard answers, off by default. It does not propose transplanting this entire fork or its other generation operations.
