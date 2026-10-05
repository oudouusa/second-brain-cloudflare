# Second Brain Cloudflare Fork

A fork of [Second Brain](https://github.com/rahilp/second-brain-cloudflare) for deployment to your own Cloudflare account. It retains upstream MCP, REST, dashboard, and Team features, and adds fixed 128-dimensional EmbeddingGemma, Japanese search adjustments, R2 backups, version history, and write protection. The MIT license and upstream copyright notices are preserved.

## What this fork provides

- **D1 as the source of truth.** Memory content, relationships, history, and deletion records live in D1. Vectorize is a derived index that can be rebuilt.
- **Fixed 128-dimensional EmbeddingGemma.** Do not mix embedding models or dimensions in an existing index. Search adjustments for Japanese text and full-width identifiers are retained.
- **Bounded work and storage protection.** Write admission, workspace isolation, CAS, held-row isolation, and deletion receipts remain in place. MCP, generation, and nightly work run in the existing Durable Object.
- **Optional direct ChatGPT connection.** Workers AI is the default. A ChatGPT plan is used only for the owner's personal workspace after the owner connects and enables it. No VPS or CLIProxyAPI is required.

The current upstream base is `main` at `4e30f973802e54740f7e709516c365078760febb`, which merged the upstream 4.0.0 release. Audits now track `upstream/main`. This remains an independently maintained fork.

## Self-hosting

The [deployment guide](docs/fork/DEPLOYMENT.md) covers account checks, D1, KV, Vectorize, R2, Cloudflare Access, secrets, initialization, and verification.

```sh
git clone https://github.com/YOUR_ACCOUNT/YOUR_PUBLIC_FORK.git second-brain
cd second-brain
npm ci --legacy-peer-deps
cp wrangler.jsonc wrangler.personal.jsonc
```

Replace the URL with the URL of this public fork. `wrangler.jsonc` is a shared template without resource IDs. Store your resource IDs, Worker name, and owner settings in the ignored `wrangler.personal.jsonc`. When updating an existing deployment, explicitly select its deployment configuration.

The [upstream Deploy button](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare) and [desktop app](https://github.com/rahilp/second-brain-cloudflare/releases/latest) target upstream. Use this fork's deployment guide for its 128-dimensional index, Access, and R2 configuration. The `installer/` implementation matches upstream, but this fork does not distribute or sign its own installer.

Workers, Durable Objects, Workers AI, D1, KV, Vectorize, and R2 have separate usage allowances. Staying within free allowances is not guaranteed. Check service availability and pricing for your account.

## Connecting clients

| Connection | URL and authentication |
| --- | --- |
| Browser | `https://YOUR-WORKER-URL/dashboard`. Sign in through owner-only Cloudflare Access. |
| OAuth-capable MCP client | `https://YOUR-WORKER-URL/oauth-mcp`. Authenticate through the Worker's OAuth flow. Do not cover this path with an Access application. |
| Static-token MCP client | `https://YOUR-WORKER-URL/mcp`. Use `Authorization: Bearer <token>`. If an Access application also protects this endpoint, its authentication is required too. |
| REST | Pass the owner token or a supported user token in the Authorization header. Do not put tokens in URLs. |

For common client issues, see upstream [Connect to AI Clients → Troubleshooting](https://github.com/rahilp/second-brain-cloudflare/wiki/Connect-to-AI-Clients#troubleshooting), including Opera warnings, Cursor OAuth, and Claude Code tool visibility. Use the fork-specific endpoints in the table above.

<a id="memory-tools"></a>

### Memory tools

| Tool | Purpose |
| --- | --- |
| `remember` | Save opinions, decisions, preferences, and context. Set `valid_from` when a fact became true and `valid_until` when it stopped being true. |
| `append` | Add a timestamped addition to an existing memory. |
| `rollover` | Continue a long journal as a short current-state memory while retaining the original. |
| `update` | Update a memory. Set `valid_until` when a fact stopped being true. |
| `recall` | Search semantically. Use `as_of` to find facts valid on a past date. |
| `brief` | Review deadlines, open commitments, stale memories, and unreviewed insights. |
| `resolve` | Resolve tracked tasks, dates, insights, and stale facts. |
| `digest` | Read an existing automatic summary for a project or tag. |
| `history` | Read changes to a memory and the content before each change. |
| `list_recent` | List recently saved memories. |
| `list_projects` | List projects you can read. |
| `list_teams` | List your shared teams and their workspace IDs. |
| `get` | Read a memory by ID. |
| `forget` | Move a memory to trash. Use `undo` to restore it. |
| `undo` | Undo the most recent change to a memory or restore it from trash. |
| `set_status` | Mark a memory as `canonical`, `draft`, or `deprecated`. |
| `set_memory_tier` | Change the manual storage tier to `hot`, `warm`, or `cold`. Cold memories remain searchable. |
| `pin_memory` | Pin a user-confirmed current goal or constraint to Hot context. |
| `unpin_memory` | Remove a manual pin without changing the storage tier. |
| `get_hot_context` | Read a bounded set of manually hot or pinned memories. |
| `get_prompt_capsule` | Read a deterministic Prompt Capsule and strong ETag through authenticated MCP. |
| `link` | Create an explicit relationship between two memories. |
| `unlink` | Remove a relationship between memories. |
| `connections` | List memories connected to a given memory. |
| `share` | Move a memory between personal and shared workspaces. |

Fact validity and change history are distinct. `as_of` finds facts valid at a past time; original content superseded by new facts remains in history. In Team configurations, `workspace=personal` selects the personal workspace and `workspace=company` selects the shared workspace. Searches always stay within the caller's readable scope.

<a id="projects"></a>

### Projects

Projects group related memories. Use `list_projects` to discover available projects, then select a project in supported searches, listings, and summaries. Team membership alone does not grant access to another user's personal workspace.

## Development and updates

```sh
npm run typecheck
npm test
npm run check:scope
npm run benchmark:validate
```

See the [upstream synchronization guide](docs/fork/UPSTREAM_SYNC.md) and [ownership boundaries](docs/fork/FORK_SCOPE.md). Keep the 21 upstream-owned files, dependency declarations, lockfile, and installer aligned with upstream.

The [dependency security review](docs/fork/DEPENDENCY_SECURITY.md) records current findings, usage conditions, and why upstream dependencies are retained. Success of the report-only CI job does not mean there are no vulnerabilities.

See also [direct ChatGPT connection](docs/fork/CHATGPT_DIRECT.md), [R2 backup and restore](docs/fork/BACKUP_RESTORE.md), and the [fork documentation index](docs/fork/README.md). Keep credentials, real memories, and personal deployment records out of public Git history.
