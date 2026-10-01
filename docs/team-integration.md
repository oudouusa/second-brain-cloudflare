# Team Edition 統合メモ

この文書は、個人用 Second Brain fork に upstream の Team Edition を取り込む際の設計判断と、安全な導入順序をまとめたものです。

## 統合後の構成

- 所有者は最初の管理者です。
- 各メンバー（AI エージェントを含む）には、個別の Bearer token と個人 workspace を1つ発行します。
- 全員が読める company workspace は1つだけです。
- 通常の記憶は個人 workspace に入り、明示的に共有した記憶だけが company workspace へ移動します。
- company workspace の記憶は全員が読めますが、変更、削除、共有解除は作成者または管理者だけが行えます。
- 管理者権限はメンバー管理用であり、他メンバーの個人 workspace を読む権限ではありません。

エージェントごとに記憶を分ける場合は、Team 画面でエージェントを1メンバーとして追加し、そのエージェント専用 token を MCP クライアントへ設定します。同じ token を複数エージェントで共有すると同一人物として扱われるため、分離したい単位ごとに token を分けます。

## 維持するモデル

Team Edition 統合ではモデルを変更しません。

| 用途 | モデル |
| --- | --- |
| 通常のテキスト生成、分類、recall 補助 | `@cf/meta/llama-4-scout-17b-16e-instruct` |
| embedding | `@cf/google/embeddinggemma-300m` |
| Vectorize | 128次元、cosine、EmbeddingGemma の MRL 128 profile |

週次 insight 用の独立設定も既存 fork の値をそのまま維持します。Team Edition を使うために embedding モデルを変更する必要はありません。

## Vectorize の workspace 分離

正確なアクセス制御は D1 の `workspace_id` 条件で行います。Vectorize の `workspace_id` filter は、他 workspace の候補が検索枠を消費しないようにする検索品質・効率上の補助です。filter が利用できない場合は一度だけ非絞り込み検索へ退避し、その候補を D1 で再度 workspace 絞り込みするため、他メンバーの個人記憶が応答へ混ざることはありません。

新しい Vectorize 索引を作る場合は、最初の vector を書く前に次を実行します。

```bash
npm run vectors:create
npm run vectors:index-parent
npm run vectors:index-workspace
```

`vectors:index-workspace` は `workspace_id` の string metadata index を作成します。

既に vector が入っている本番索引では、`vectors:index-workspace` だけを後付けしないでください。Cloudflare Vectorize は、metadata index 作成前に upsert 済みだった vector をその index へ自動登録しません。索引を追加しても、既存 vector を作成後に再 upsert するまでは filter 対象にならず、古い記憶の意味検索結果が減る可能性があります。

したがって既存環境の初回 Team 更新では、次のどちらかを選びます。

1. 現在の索引を維持し、workspace filter の非対応時フォールバックと D1 の厳密な絞り込みを使う。今回の既定方針です。
2. 別の128次元索引を作り、`parentId` と `workspace_id` の metadata index を先に作成してから全記憶を再構築し、検証後に binding を切り替える。モデルは同じままで構いません。

2は既存 vector の再構築と切替を伴うため、このマージコミットでは自動実行しません。

## cron 配分

Cloudflare Free plan の上限に合わせ、cron trigger は5本のままです。

| UTC | 用途 |
| --- | --- |
| `0 1 * * *` | nightly compression |
| `10 1 * * *` | graph backfill と staleness |
| `30 * * * *` | integration sync。割当リセット後の一部 slot は AI 復旧にも利用 |
| `45 1 * * *` | insight candidate accrual |
| `15 2 * * SUN` | 個人向け週次 insight |

Team の company insight は6本目を追加せず、日曜 02:30 UTC の integration slot を利用します。通常の integration sync、AI quota 復旧、company insight は同一 invocation で重ねず、D1 subrequest budget を守ります。

## 既存環境からの更新手順

統合作業中は deploy と push を行わず、全gateが成功した統合commitだけを次の順序で本番へ反映します。2026-08-30の最新同期では、この手順を完了しています。

1. 現行 Worker、D1、Vectorize、KV、R2 の read-only inventory を取得します。
2. 現行版で R2 backup を作成し、manifest と件数を確認します。
3. `npm run check:scope`、`npm run typecheck`、`npm test`、Wrangler dry-run が成功した統合 commit を選びます。
4. 既存の populated Vectorize には、この段階で `workspace_id` metadata index を後付けしません。
5. Worker を deploy します。初回起動時に owner、owner personal workspace、company workspace が作られ、既存 D1 記憶と edge は owner personal workspace へ移されます。
6. owner token で health、recall、remember、forget を smoke test します。
7. Team 画面からエージェント／メンバーを追加し、それぞれ専用 token を設定します。
8. 2人の個人 workspace が相互に見えず、company へ共有した記憶だけが双方から読めることを確認します。
9. 必要なら、別索引での metadata index 先行作成と全 vector 再構築を独立した移行作業として行います。

## R2 backup / restore の範囲

R2 の memory export は、各 entry の `workspace_id` と `actor_id`、各 edge の `workspace_id` を保持します。信頼済み restore ではこれらを復元し、通常の HTTP import では外部から渡された偽の tenancy metadata を採用しません。

ただし現在の R2 manifest は、Team directory の `users`、`workspaces`、`memberships`、token credential、admin audit を完全な別 D1 へ復元する disaster-recovery archive にはなっていません。同じ D1 の memory rollback には使えますが、新しい D1 へ Team 全体を復旧する場合は owner とメンバーを再作成し、token を再発行する必要があります。この制約が解消するまでは、Team directory を含む完全復旧済みとは扱いません。

## upstream 追従方針

- `upstream/feat/v3-team-edition` の変更は、隔離 worktree で監査してから fork の `main` 候補へ取り込みます。
- 2026-08-30時点では`7e30fde714c3f0b6106d49713f9b3d31400db8eb`まで取り込み、READMEの重複説明とupstreamで削除された`docs/local-testing.md`をfork側でも縮退しました。
- `npm run upstream:audit`はTeam Edition branchを差分基準にしつつ、`upstream/main`の未取込commitも同時に検知します。
- fork 固有のモデル、128次元 embedding profile、障害時の keyword fallback、quota 復旧、R2 整合性、5本 cron を回帰条件として固定します。
- upstream の同等修正が入ったときは fork 側の一時 patch を削除し、二重実装を避けます。
- scope checker と workspace 隔離テストを必須 gate とし、管理者 API であっても他メンバーの個人 memory を読み書きできるという扱いにはしません。

### 2026-08-30 同期結果

- active upstream: `upstream/feat/v3-team-edition@7e30fde714c3f0b6106d49713f9b3d31400db8eb`
- 旧READMEの一般説明と`docs/local-testing.md`はupstreamのwiki移行に合わせて削除し、fork固有README差分を運用プロファイルと参照リンクに限定しました。
- Cursor instructions、配布用Cursor Rule、`cursor-response`のaxis tagをupstream実装のまま採用しました。
- Team共有移動とlegacy tenancy backfillは、fork固有D1 write fenceのmarker契約へ合わせました。
- 検証: focused 140 tests、full 240 files / 3,307 tests、write-path focused 96 tests、TypeScript、scope 113 queries、60-query benchmark evidence、Wrangler 4.126.0 dry-run、startup analysis、active upstream auditがすべて成功しました。
- 生成モデル、EmbeddingGemma MRL-128 profile、Vectorize索引、D1 schema、Cloudflare本番resourceは変更していません。commit `5f437e8`を`origin/codex/team-edition-integration`へpushし、Worker version `8dac656b-98c2-4909-955a-d98b17e7bb74`として100%配備しました。
- 配備後は`team=false`のsolo mode、health、実MCP recall／append／get、D1 tenancy・write fence整合性、配備後brain-v3 backup `2026/08/1788063923062`を確認しました。
