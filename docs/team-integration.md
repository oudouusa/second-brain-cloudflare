# Team Edition integration notes

This document records the design decisions and rollout sequence used to integrate upstream Team Edition into the personal Second Brain fork.

**Historical scope:** the topology, model defaults, cron allocation, upstream target, and deployment results below describe the 2026-08-30 integration. For current setup and ownership, use [DEPLOYMENT.md](fork/DEPLOYMENT.md), [ARCHITECTURE.md](fork/ARCHITECTURE.md), and [UPSTREAM_SYNC.md](fork/UPSTREAM_SYNC.md). The Vectorize metadata-index migration caveat remains relevant to existing indexes.

## Integrated topology

- The owner is the first administrator.
- Each member, including an AI agent, receives a separate Bearer token and one personal workspace.
- There is one company workspace readable by everyone.
- Normal memories enter a personal workspace; only explicitly shared memories move to company.
- Everyone can read company memories, but only their author or an administrator can modify, delete, or unshare them.
- Administrator authority manages members; it does not grant access to another member's personal workspace.

To separate agents' memories, add each agent as a member through the Team screen and configure its dedicated token in its MCP client. Sharing one token makes multiple agents the same identity, so use distinct tokens for each intended isolation boundary.

## Retained models

The Team Edition integration did not change models.

| Purpose | Model |
| --- | --- |
| Normal generation, classification, recall assistance | `@cf/meta/llama-4-scout-17b-16e-instruct` |
| Embedding | `@cf/google/embeddinggemma-300m` |
| Vectorize | 128 dimensions, cosine, EmbeddingGemma MRL 128 profile |

The separate weekly-insight configuration retained its existing fork value. Team Edition does not require changing the embedding model.

## Vectorize workspace isolation

Authoritative access control uses D1 `workspace_id` conditions. Vectorize's `workspace_id` filter helps quality and efficiency by preventing candidates from other workspaces from consuming search slots. If the filter is unavailable, search falls back once to an unfiltered query and then reapplies strict workspace filtering in D1. Other members' personal memories cannot enter the response.

For a new Vectorize index, run the following before writing its first vector:

```bash
npm run vectors:create
npm run vectors:index-parent
npm run vectors:index-workspace
```

`vectors:index-workspace` creates a string metadata index for `workspace_id`.

Do not simply add `vectors:index-workspace` to an already populated production index. Cloudflare Vectorize does not automatically include vectors upserted before creation of a metadata index. Until those vectors are re-upserted after index creation, they are unavailable to that filter, potentially reducing semantic results for older memories.

For the first Team upgrade of an existing deployment, choose either:

1. Retain the existing index, using the unsupported-workspace-filter fallback and strict D1 filtering. This was the integration's default approach.
2. Create another 128-dimensional index, create `parentId` and `workspace_id` metadata indexes first, rebuild all memories, verify results, then switch the binding. The model can remain unchanged.

Option 2 rebuilds existing vectors and changes the binding, so the integration merge did not run it automatically.

## Cron allocation

The integration retained five cron triggers to fit the Cloudflare Free plan limit.

| UTC | Purpose |
| --- | --- |
| `0 1 * * *` | Nightly compression |
| `10 1 * * *` | Graph backfill and staleness |
| `30 * * * *` | Integration sync; some slots after quota reset also handle AI recovery |
| `45 1 * * *` | Insight candidate accrual |
| `15 2 * * SUN` | Personal weekly insights |

Company insights used the Sunday 02:30 UTC integration slot instead of adding a sixth trigger. Normal integration sync, AI quota recovery, and company insights did not overlap in one invocation, protecting the D1 subrequest budget.

## Upgrade sequence for existing deployments

During integration, do not deploy or push. Deploy only an integration commit that has passed every gate, in the following order. This sequence was completed for the 2026-08-30 synchronization.

1. Obtain a read-only inventory of the current Worker, D1, Vectorize, KV, and R2.
2. Create an R2 backup with the current version and check its manifest and counts.
3. Select an integration commit passing `npm run check:scope`, `npm run typecheck`, `npm test`, and a Wrangler dry run.
4. Do not add a `workspace_id` metadata index to populated Vectorize at this stage.
5. Deploy the Worker. First startup creates the owner, owner personal workspace, and company workspace, then assigns existing D1 memories and edges to the owner personal workspace.
6. Smoke-test health, recall, remember, and forget with the owner token.
7. Add agents/members through the Team screen and configure dedicated tokens.
8. Verify two members cannot see each other's personal workspaces and can both read only memories shared to company.
9. If needed, separately migrate to a new index with metadata indexes created first and all vectors rebuilt.

## R2 backup / restore scope

R2 memory exports retain each entry's `workspace_id` and `actor_id`, and each edge's `workspace_id`. Trusted restore restores those fields. Ordinary HTTP import does not adopt forged tenancy metadata supplied externally.

The R2 manifest is not a disaster-recovery archive that restores Team directory `users`, `workspaces`, `memberships`, token credentials, and admin audit into an entirely separate D1. It supports memory rollback in the same D1. Restoring an entire Team into new D1 requires recreating the owner and members and reissuing tokens. Until this limitation is resolved, do not describe it as complete recovery of the Team directory.

## Upstream synchronization policy at integration time

- Audit `upstream/feat/v3-team-edition` changes in an isolated worktree before integrating them into the fork's main candidate.
- As of 2026-08-30, integration reached `7e30fde714c3f0b6106d49713f9b3d31400db8eb`. Duplicate README explanations and `docs/local-testing.md`, removed upstream, were also removed in the fork.
- At that time, `npm run upstream:audit` used Team Edition as its comparison base and also detected unintegrated commits on `upstream/main`.
- Pin fork-specific models, 128-dimensional embeddings, keyword fallback on failure, quota recovery, R2 consistency, and five cron schedules as regression conditions.
- Remove temporary fork patches when equivalent upstream fixes arrive, avoiding duplicate implementations.
- Require scope checking and workspace-isolation tests. Even administrator APIs do not imply permission to read or write another member's personal memories.

### 2026-08-30 synchronization results

- Active upstream: `upstream/feat/v3-team-edition@7e30fde714c3f0b6106d49713f9b3d31400db8eb`.
- General README explanations and `docs/local-testing.md` were removed in line with upstream's wiki migration, limiting fork README differences to the operational profile and reference links.
- Cursor instructions, the distributed Cursor Rule, and the `cursor-response` axis tag were adopted unchanged from upstream.
- Team sharing moves and legacy tenancy backfill were adapted to the fork's D1 write-fence marker contract.
- Successful checks: 140 focused tests; full suite of 240 files / 3,307 tests; 96 write-path tests; TypeScript; scope checks for 113 queries; 60-query benchmark evidence; Wrangler 4.126.0 dry run; startup analysis; active upstream audit.
- Generation model, EmbeddingGemma MRL-128 profile, Vectorize index, D1 schema, and Cloudflare production resources were unchanged. Commit `5f437e8` was pushed to `origin/codex/team-edition-integration` and deployed at 100% as Worker version `8dac656b-98c2-4909-955a-d98b17e7bb74`.
- Postdeployment checks covered solo mode with `team=false`, health, real MCP recall/append/get, D1 tenancy/write-fence consistency, and brain-v3 backup `2026/08/1788063923062`.
