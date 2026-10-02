# Smoke test matrix

## Local / CI gate

| Surface | Main automated checks |
|---|---|
| remember / capture | `test/integration/capture.test.ts`, `test/unit/capture-entry.test.ts` |
| recall (Japanese, English, identifiers) | `test/integration/recall.test.ts`, `test/unit/fork-recall-corpus.test.ts`, versioned benchmark JSON |
| append | `test/integration/append.test.ts` |
| append rollover | `test/integration/rollover.test.ts`, `test/integration/append.test.ts` (rollover advice: none/required) |
| update / version history | `test/integration/update.test.ts`, `test/integration/update-parity.test.ts`, `test/integration/history.test.ts` |
| forget / delete | `test/integration/entry.test.ts`, `test/integration/forget.test.ts` |
| export v3 (including v2 compatibility) | `test/integration/export.test.ts` |
| import v3 (including v2 compatibility) | `test/integration/import.test.ts`, `test/integration/import-subrequests.test.ts` |
| MCP contract | `test/integration/mcp-tools-contract.test.ts`, `test/integration/mcp-handler-http.test.ts` |
| Prompt Capsule REST / MCP parity | `test/integration/prompt-capsule-route.test.ts`, `experiments/prompt-cache/mcp-capsule-source.test.mjs` |
| tag / LIKE escape | `test/integration/tag-filter-escaping.test.ts`, `test/unit/extract-hashtags.test.ts` |
| graph / multi-hop | `test/unit/edges.test.ts`, `test/integration/multi-hop.test.ts` |
| migration resume / lock | `test/integration/embedding-migration.test.ts`, `test/integration/migration-write-lock.test.ts` |
| R2 backup / restore | `test/integration/r2-backup.test.ts` |
| Hot / Warm / Cold | `test/integration/memory-tiers.test.ts` |
| auth fail closed | `test/unit/auth-token.test.ts` |

## Production smoke sequence

After production deployment, use just one short test memory with a unique private prefix and follow this sequence.

1. Check `/health` and the embedding profile.
2. Check REST remember → recall → append → rollover → update → history → tag recall → graph → export.
3. Check MCP `tools/list` → remember → recall → rollover → update → history → tier warm/hot/cold → pin/unpin → hot context → `get_prompt_capsule`.
4. Create an R2 snapshot and verify the manifest hash and counts.
5. Restore only into an empty test target; do not overwrite production D1.
6. Forget the test memory through REST or MCP and verify removal from D1 and Vectorize.

Record only the date/time, commit, HTTP status, counts, and hashes. Do not record test content, tokens, or Authorization headers.

## Historical results

Keep results in owner-controlled storage. Do not put memory content or credentials in public Git history.
