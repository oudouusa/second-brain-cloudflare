# Smoke test matrix

## Local / CI gate

| Surface | 主な自動検証 |
|---|---|
| remember / capture | `test/integration/capture.test.ts`、`test/unit/capture-entry.test.ts` |
| recall（日本語・英語・識別子） | `test/integration/recall.test.ts`、`test/unit/fork-recall-corpus.test.ts`、versioned benchmark JSON |
| append | `test/integration/append.test.ts` |
| append rollover | `test/integration/rollover.test.ts`、`test/integration/append.test.ts`（rollover の助言 none/required） |
| update / version history | `test/integration/update.test.ts`、`test/integration/update-parity.test.ts`、`test/integration/history.test.ts` |
| forget / delete | `test/integration/entry.test.ts`、`test/integration/forget.test.ts` |
| export v3（旧v2の互換を含む） | `test/integration/export.test.ts` |
| import v3（旧v2の互換を含む） | `test/integration/import.test.ts`、`test/integration/import-subrequests.test.ts` |
| MCP contract | `test/integration/mcp-tools-contract.test.ts`、`test/integration/mcp-handler-http.test.ts` |
| Prompt Capsule REST / MCP parity | `test/integration/prompt-capsule-route.test.ts`、`experiments/prompt-cache/mcp-capsule-source.test.mjs` |
| tag / LIKE escape | `test/integration/tag-filter-escaping.test.ts`、`test/unit/extract-hashtags.test.ts` |
| graph / multi-hop | `test/unit/edges.test.ts`、`test/integration/multi-hop.test.ts` |
| migration resume / lock | `test/integration/embedding-migration.test.ts`、`test/integration/migration-write-lock.test.ts` |
| R2 backup / restore | `test/integration/r2-backup.test.ts` |
| Hot / Warm / Cold | `test/integration/memory-tiers.test.ts` |
| auth fail closed | `test/unit/auth-token.test.ts` |

## Production smoke順序

production deploy後は、privateな一意prefixを持つ短い検証memory 1件だけを用いて次を順番に行う。

1. `/health`とembedding profileを確認する。
2. RESTでremember → recall → append → rollover → update → history → tag recall → graph → exportを確認する。
3. MCPで`tools/list` → remember → recall → rollover → update → history → tier warm/hot/cold → pin/unpin → hot context → `get_prompt_capsule`を確認する。
4. R2 snapshotを作成し、manifest hashと件数を照合する。
5. restoreは空の検証先だけで行い、production D1へ上書きrestoreしない。
6. RESTまたはMCPで検証memoryをforgetし、D1とVectorizeから消えたことを確認する。

実行結果には日時、commit、HTTP status、件数、hashだけを記録する。検証本文、token、Authorization headerは記録しない。

## 過去の結果

実施結果は所有者の保管場所へ保存し、記憶本文や資格情報を公開Gitへ入れない。
