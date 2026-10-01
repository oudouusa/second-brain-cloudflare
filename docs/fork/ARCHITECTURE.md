# 現行アーキテクチャと保守責任

この文書は4.0.0統合branchのソースの責務を説明する。本番反映とは区別する。
同期時の移動先は `UPSTREAM_SYNC.md`、自己配備の手順は `DEPLOYMENT.md` を参照する。
配備ごとの実資産ID・実記憶・実測記録は、このソースとは別の所有者の保管場所で管理する。

```text
Claude / ChatGPT / Codex / Cursor / ブラウザー
                      |
         公開 Worker: 認証・routing
            /         |          \
     REST / Assets    MCP       既存scheduled処理
            |         |          |
            |   MCP_EXECUTOR     |
            |   Durable Object   |
            +---------+----------+
                      |
        D1: 本文・関係・履歴・運用台帳の正本
          |           |                 |
    Vectorize      Workers AI      OAUTH_KV
     派生索引      固定Gemma128     OAuth・連携・補助状態
          |
   vectorize/cleanup: D1の削除台帳と遠隔削除の整合

明示backup/restore ── R2: brain-v5 chunk / manifest
生成処理          ── 選択済みprovider（直接ChatGPT / Workers AI）
Dashboard等       ── Cloudflare Accessの検証
```

MCP_EXECUTORはMCPと夜間処理のCPU境界であり、記憶本文の別DBではない。
3.2.1ではMCPを `mcp-v1`、夜間を `nightly-v1` の別object名へ送り、同じclass/bindingを再利用する。
上図のscheduled処理のうち `0 1 * * *` だけがこの境界を通る。
MCPの利用者に依存しない入力スキーマはモジュール単位で再利用する。
server・callback・env・認証コンテキストはリクエストごとに作成し、記憶や権限を共有しない。
関数引数でスキーマを受け取るrolloverは呼出単位で組み立てる。
ChatGPT管理・直接回答、週次の読取専用プレビュー、`POST /recall`は認証後に `mcp-v1` へ転送する。
REST検索は転送前に実バイト32 KiBを確認し、同じREST本体でidentity・scopeと
usage/recall_logのwrite admissionを再適用する。検索本体と要約応答の解析を公開WorkerのCPU枠から移す。
移設と総計算量の削減は区別する。fork字句処理のSegmenterと短い語のUTF-8計数を再利用し、
上流tokenizerと検索結果の契約は維持する。検索語・本文・利用者情報の共有cacheは追加しない。
JSONを含む応答本文は送信完了・切断までDOの文脈を保持し、RPCの途中切断を防ぐ。
他のRESTと他4 cronは従来の実行先。夜間RPCはD1の権限解放と動的な背景処理が
全て終了するまで待つ。RPC失敗時にWorker内へ戻して重複実行することはない。
新しいclass/binding/migration、DO storageへの本文保存、alarm、queueは追加しない。

MCPの応答スキーマ互換処理は`mcp/sanitize.ts`を上流と完全一致で保つ。
forkのwrite admission判定は既存`mcp/handler.ts`内に置く。純読取8種類（get、list_projects、list_recent、get_hot_context、
get_prompt_capsule、connections、history、list_teams）とprotocol要求を許可する。
recall・未知tool・書込を含むbatchは書込として扱う。認証とworkspace認可は省略しない。

DOの無操作時稼働を防ぐため、MCPはstateless/JSON/keepAliveMs=0に加え、
SDKの `maxSubscriptions=0` でmodern `subscriptions/listen` の常時SSEを無効にする。
keep-aliveの無効化だけでは購読streamは閉じない。legacy GETは実SDKが405で閉じ、
通常の有限tools/call/listは維持する。ブラウザを開いたままにする購読接続は作らない。

夜間専用RPCはimport開始から背景処理・解放まで実時間5分を上限とし、
期限超過で `ctx.abort(..., { retryAlarm: false })` により専用objectを強制終了する。
Promiseの待機だけをやめて裏のI/Oを残す方式ではない。同時nightly呼出は拒否し、
新しい呼出で最初の期限を延長しない。正常終了・通常例外では必ずタイマーを解除する。
MCP用objectにはこの停止を適用しない。強制終了ではfinallyの解放を保証できないため、
既存の期限付きadmission（最終更新から16分）、CAS、journal、次回回復経路を維持する。
完了済みD1書込を巻き戻したり、途中処理を即時再試行したりしない。
この5分は1回の夜間稼働の上限であり、アカウント全体の日次費用上限ではない。


## 設定済みbindingの責任

`wrangler.jsonc`を配備設定の正本とする。以下は同じ設定を人間向けに説明する表であり、
新しい設定ファイルや汎用プラグイン基盤を作らない。binding名の一致をunit testで検査する。

<!-- runtime-bindings:start -->
| Binding | 種別 | 責任・欠落時の扱い |
| --- | --- | --- |
| `DB` | D1 | 本文、tags、tier、関係、履歴、write admission、復元cursor、削除台帳の正本。必須。 |
| `VECTORIZE` | Vectorize | 固定128次元の再生成可能な派生索引。障害時の文字検索は完全な検索品質を保証しない。 |
| `AI` | Workers AI | 固定EmbeddingGemma。ChatGPT未選択の構成では既存推論も担当。利用枠不足時は既存の縮退・回復処理を使う。 |
| `OAUTH_KV` | KV | OAuth、外部連携、quota観測、補助cache等。本文の正本やD1との同時点snapshotではない。 |
| `ARCHIVE` | R2 | privateな手動brain-v5 backup/restore。未設定時のbackup APIは503。通常保存とのdual-writeはしない。 |
| `MCP_EXECUTOR` | Durable Object | MCPと夜間処理のCPU隔離。別object名で実行。現行配備の運用要件。ローカルfallbackがあっても削除を推奨しない。 |
| `ASSETS` | Workers Assets | 同一WorkerのUI資産。Dashboard経路の認証はWorker側で先に処理する。 |
<!-- runtime-bindings:end -->

Accessはbindingではなく、次のsecretと `src/lib/cloudflare-access.ts` による認証境界である。
現行configの `secrets.required` は次のとおり。値は文書・ログ・テストへ保存しない。

<!-- deployment-secrets:start -->
| Secret | 用途 |
| --- | --- |
| `AUTH_TOKEN` | 既存の認証契約 |
| `ACCESS_TEAM_DOMAIN` | Accessの検証先 |
| `ACCESS_AUD` | MCP等のAccess audience |
| `DASHBOARD_ACCESS_AUD` | DashboardのAccess audience |
| `ACCESS_ALLOWED_EMAIL` | 許可する利用者 |
<!-- deployment-secrets:end -->

`CHATGPT_CREDENTIAL_KEY`は直接接続を使う所有者だけが設定する任意secret。通常起動の必須secretには含めない。

PR #117を2026-10-01に本番反映し、生成のVPS経路を撤去した。VPC binding、旧adapter、CLIProxyの旧選択設定と
API key要件は持たず、直接接続の通常モデルは `CHATGPT_MODEL` で選ぶ。
自己配備と更新の手順は `DEPLOYMENT.md` を参照する。
候補の生成モデルと選択処理は以下のとおり。

| operation | モデル | 障害時 |
| --- | --- | --- |
| classify | gpt-5.6-luna（CHATGPT_MODEL） | 分類は未処理のまま |
| recall-summary / answer | gpt-5.6-luna（CHATGPT_MODEL） | 要約は空、回答開始失敗は503、途中失敗はストリームエラー |
| smart-merge / contradiction | gpt-5.6-terra | 統合見送り、矛盾未判定 |
| digest / weekly-insight | gpt-5.6-terra | ダイジェスト保存見送り、週次候補は再試行可能 |

`CHATGPT_OPERATIONS`の明示選択を維持し、選択済み処理の障害でWorkers AIへ自動fallbackしない。

2026-09-30に公開Responses APIへのChatGPT直接接続を追加した。
`CHATGPT_OPERATIONS`へ明示した処理だけを直接接続へ送り、未選択の処理は上流のWorkers AI経路を使う。
新規導入の既定は未選択。`CHATGPT_OWNER_WORKSPACE_ID`と資格情報内のowner束縛が一致し、
実際の範囲が所有者の個人workspaceだけの場合に限って選択した処理を直接接続へ送る。
Team・member・別admin・範囲不明・混在は通常のWorkers AIを使う。
現行4.0のquery-tagsは既知タグの照合で、LLM呼出しを復活させない。
呼出元は`src/lib/chatgpt.ts`へ直接依存し、処理ごとの有限予算と保存JSONの検証も同じmoduleが所有する。
モデル選択と保存判断のJSON検証は変えず、直接接続の障害でも他のproviderへ自動fallbackしない。
初回認証はローカルの127.0.0.1 callbackで行い、署名・issuer・audience・nonceを検証して
Workerが保持するstable hostで認証し、資格情報を所有者専用APIへ転送する。WorkerもID/access tokenの署名とgrantを検証する。
接続管理APIと固定promptのprobeは所有者認証後に既存`mcp-v1` DOへforwardする。
直接接続の`/chat`も利用者認証後に同じDOへ送り、資格情報の復号・ResponsesのSSE解析を公開Workerの10 ms枠から隔離する。
転送は入口での認証・本文上限確認の直後に行い、DB初期化と回答用の利用者情報取得はDOで行う。
回答SSEの転送はDOのwaitUntilで完了・切断まで追跡し、RPC返却後も実行文脈と生成ログを保持する。
DOは資格情報を永続化せず、binding・class・cron・Gemma128を追加・変更しない。
公開Responsesは`store:false`、`stream:true`で呼び、systemをdeveloperへ変換する。
`response.completed`だけを成功として扱い、failed/incomplete/切断・不正JSON・出力超過は拒否する。
previewでは`max_output_tokens`を送れない。既存の入力・期限と、要求token数×8のローカル文字上限、
SSE全体256 KiBの上限で中止する。従来のserver側token上限や実消費の保証とは異なる。

`src/lib/chatgpt-session.ts`はowner接続時に専用D1 table `chatgpt_session`を作る。
memory schema versionは変えず、entries/edgesのwrite fenceとは分離する。
資格情報全体をランダムIVと固定AADのAES-256-GCMで暗号化する。鍵はWorker secretに置き、
R2 brain-v5 backup/exportへ資格情報も鍵も含めない。D1 Time Travelには暗号文が残る。
D1のprimary上の条件付きUPDATEで更新を排他し、replacementをrevision付きで原子的に保存する。
結果が不確かなrefreshを再送しない。中断した更新は再認証が必要になり得る。
接続・probe・失効と復旧手順は[CHATGPT_DIRECT.md](CHATGPT_DIRECT.md)を参照する。

検索要約・ダイジェスト・週次推論の単純テキスト生成は、既存`src/lib/ai.ts`の
`generateText`で接続先を選ぶ。プロンプト、トークン上限、Workers AI用のモデルは呼出元が渡し、
週次推論は`INSIGHT_LLM_MODEL`を維持する。結果の解釈・trim・失敗時の空応答や再試行可否は
呼出元に残す。分類のquota記録、smart mergeのJSON契約、chatのSSEはこの関数へ統合しない。
生成の共通化に新しいcache・再試行・状態・依存・bindingは追加しない。
全選択時もGemma128埋め込みはWorkers AIを使う。無料枠枯渇が絶対に起きない保証ではない。
本文・認証情報を記録せず、`ai_provider_call`にoperation/model/status/latencyを記録する。
短文処理は15秒、追加生成処理は25秒、入力と出力は処理別に制限する。超過入力を切り詰めて保存判断に使わない。
生成本文は完了イベント、空本文、保存判断のJSON型を検査する。
回答はsystem/userの役割を保持したSSEへ変換し、完了前にstopやDONEを返さない。

## 上流とフォークの分担

| 責任 | 実装の正本 | 変更時に守ること |
| --- | --- | --- |
| 基礎tokenizer・graph・通常recall | active upstream | `src/text/tokenize.ts` はbyte-identical。上流が同等機能を実装したら独自部分を縮める。 |
| 固定embedding profile | `src/embedding/profile.ts` | `embeddinggemma-mrl128-v1`、128次元、query/document入力、閾値を一組として扱う。 |
| 日本語・識別子のD1検索制約 | `src/text/lexical-query.ts` と既存recall | 上流scoringを複製しない。FTS5で全probeを表現できる語だけ派生索引へ送り、複合語・CJK bigramは従来のLIKEへ送る。128候補は走査・課金行数の上限ではない。 |
| write admission / migration / restore barrier | `src/migration/write-lock.ts` とD1 trigger | 保存・削除・graph更新が共通契約を通る。保護を無効化して差分を減らさない。 |
| 不要vectorの削除と再試行 | `src/vectorize/cleanup.ts` | D1台帳、参照確認、capability更新、mutation receipt、再確認、ページ上限を一か所に置く。 |
| 保存・更新・追記の調停 | `src/capture/store.ts` | cleanupを呼び、本文のCAS・before-image・graph更新順序を維持する。 |
| 履歴・論理tier・rollover | `src/memory/` の既存fork module | D1を正本とし、tier変更だけでvectorを再生成しない。 |
| Prompt Capsule | `src/prompt-capsule/` と既存route/tool | 決定性・認可・既存APIを維持。利用価値を測らず削除しない。 |
| HTTP運用保護・ChatGPT直接接続・MCP隔離 | 既存fork module | 上流共通helperへ独自ロジックを戻さない。外部接続には別の運用責任がある。 |
| 有限bodyの読取 | `src/lib/body.ts` | バイト上限・中止通知・reader解放だけを共通化する。HTTP応答、認証、provider、Envへ依存しない。 |

HTTP入力・Notion JSON・Calendar ICS・ChatGPTの認証・モデル一覧JSONは同じ読取処理を使う。
HTTPの呼出別上限、Notion 128 KiB、Calendar 32 KiB、ChatGPTの認証JSON 128 KiB・モデル一覧2 MiBは呼出元が決める。
Content-Lengthを信用せず実バイト数も検査し、超過時は読取を中止する。中止処理の失敗や停滞で
元のサイズ拒否を失わず、取得したreaderは成功・失敗のどちらでも解放する。
非有限・不正な宣言値は早期拒否の根拠にせず、実バイト数で判定する（Notion/CalendarのInfinity宣言も含む）。
HTTP 400/413への変換、JSON解析、ICS複雑度検査、ChatGPTの期限とエラー分類は各呼出元に残す。
読取moduleはタイマーや常設接続を追加しない。全ログ呼出元はobservabilityを直接参照し、httpからの互換再公開は撤去した。

cleanup moduleは `Env` の型、write-lock、呼出単位の `runtime/d1-budget` だけをimportし、
capture orchestrationへ依存しない。予算moduleのimportはEnvの型のみで、別サービスや永続台帳を作らない。
drain・bulk submit・schedule定数はcron・migration・adminからcleanupを直接参照する。
`store.ts` の互換再公開は撤去し、削除台帳・receipt・ページ上限の実装は維持する。
`lifecycle.ts`のforget/deprecateも確定後の索引削除を`submitLifecycleVectorCleanup()`へ委譲する。
本文CAS・履歴を含む削除transaction・公開結果と非致命的なログはlifecycle側に残す。
この経路は1回だけ送信し、従来の配列形式の台帳を60秒後の再確認へ残す。空配列は
既存のdelete marker＋DELETE batchで消す。通常cleanupの3回再送・receipt形式とは区別し、
権限更新→任意hook→遠隔削除→台帳更新の順序を維持する。

権限解放の3回retryは`migration/write-lock.ts:releaseMemoryWriteAdmissionWithRetry()`が正本。
通常要求の応答終端/waitUntil追跡と解放用Envは`beginMemoryWriteAdmission()`が持ち、
認証初期化は必要時だけ権限を取得して同じ解放を使う。失敗時のログは各callerに残し、
確定した処理を500へ変えず、既存の16分TTLを維持する。

entry/edgeのimportで使うwrite fence判定は、既存`isMemoryWriteFenceError()`が正本。
batchでロック拒否を受けた場合は逐次fallbackへ進まない。SQL生成と結果処理は上流と
同じ配置を維持し、個別行の失敗、hook、ページ上限、SQL本数、復元leaseの扱いを変えない。

通常更新と索引障害時の更新は、既存 `src/memory/history.ts` の
`commitSourceWithHistory()` で「旧版INSERT → 本文UPDATE → 履歴edge」の1 batchを共有する。
本文のCAS条件・成功判定・遠隔処理との順序は引き続き `store.ts` が決める。
履歴なしの更新は従来どおり本文UPDATEのrunだけを実行し、再試行や新しい書き込み権限を追加しない。
これで書き込み保護全体が分離されたわけではない。本文CASと遠隔更新の調停は依然として残る。

派生cacheのD1世代番号は、既存の調停module `migration/write-lock.ts` に置く。
世代番号の全呼出元は調停moduleを直接参照し、`migration/embedding.ts` の互換再公開は撤去済み。
これにより `store → vocabulary → embedding migration → store` の実行時import循環を解く。
世代番号のtable/key、作成時の競合処理、reset時の更新、SQL本数は変えず、新moduleも増やさない。


## 正本・復旧・運用の境界

Hot/Warm/ColdはD1の論理状態で、Cold本文をR2へ退避しない。Coldも通常recallから自動除外しない。
VectorizeはD1から再生成する派生索引で、異なるprofileを同じindexへ混ぜない。

HTTP exportの生成前見積り・生成後byte検査は`entries/export.ts`が担当し、
`routes/entries.ts`はR2実装を参照しない。内部例外は`ExportError`とし、
409/413のHTTP応答文言とpaged案内を維持する。完全exportの500行・見積り512 KiB・
生成後768 KiBはここを正本とする。`backup/r2.ts`は旧定数名を同じ値のaliasとして
直接importし、旧brain-v2復元の制限を保つ。互換再exportは撤去済み。R2操作の例外は従来の`BackupError`を使う。

4.0統合branchはschema 9と上流entry_versions／entries_trash／recall_logを採用する。
R2の現行形式は `brain-v5`。entry・型付きedge・Projects設定と4テーブルの履歴をchunk/manifestで保持し、
旧 `brain-v2` / `brain-v3` / `brain-v4` も読取り可能。復元はentry・edge・project・historyの
4種の永続cursorとleaseで再開する。3.7.0の配備済み版はschema 8／brain-v4である。
Projectsも通常のwrite admissionと復元排他へ参加する。memory-only backupであり、
OAuth、外部連携の資格情報、workspace定義、利用者config、同期cursor、Vectorize索引は復元しない。
rowのworkspace ID保持は、workspace定義や認証環境の復元とは別である。
現行backupは連携の明示切断・mirror除去を前提とする。自動purgeは追加せず、詳細手順は
`BACKUP_RESTORE.md` に一本化する。実運用の切断・purge・再接続・再埋め込みは別承認で行う。

3.2.1の構成も5 cronとし、圧縮・graph・stalenessは一つの夜間枠へ統合する。
解放した枠を上流のteam weekly triggerへ戻す。backup専用cronや常駐プロセスは追加しない。
夜間と時間別同期・PushはSQL送信前の共有計数を通り、最初にadmission解放3文を予約する。
cleanupは開始前に最大8文を予約し、最後は残予算を使う。遠隔操作の受付記録を先に予約する。
グラフのworkspace別候補はKVのkeyset cursorで進む。未処理・失敗・KV不整合は完了の証拠ではない。
[夜間予算と繰越](NIGHTLY_D1_BUDGET.md) に保持条件、回帰試験、残る走査量/性能課題を記載する。
CI成功・ローカルSQLite成功・dry-runは本番CPU、D1課金行数、p95応答時間の測定ではない。
ソースの統合と各所有者の配備を分ける。配備手順は `DEPLOYMENT.md`、測定条件は `SEARCH_QUALITY.md` を参照する。


## Workers AI枯渇時の縮退運転（2026-09-08）

新規保存と追記はD1へ保持し、意味検索用の索引作成を保留する。検索はキーワードへ縮退する。
新規保存時の分類は処理先で分け、ChatGPTを選択していれば埋め込みの枯渇中も非同期実行する。
ChatGPT失敗時はWorkers AIへ戻さず未分類のまま保持する。分類成功は埋め込みの回復証拠ではないため、
Workers AIのquota観測は解除しない。全文置換のupdateは従来どおり失敗時に本文を変えず、回復時刻を返す。

REST captureの`classification_status`は`scheduled`（非同期受付）または`deferred`（枯渇で延期）。
`scheduled`は分類成功を保証しない。既存`classification_pending`は枯渇による延期を示す互換フィールドで、
全ての未完了分類の件数・状態ではない。MCPと画面の保存レシートは保存成功と索引待ちを区別する。
`/health`の既存`ok`は準備状態の判定を維持し、`status: degraded`と`database.status: reachable`を追加する。
D1到達は読み取り・初期化経路の確認であり、全ての書込みや外部生成の成功保証ではない。
`no_known_outage`も能動的なAI成功確認ではなく、既知の障害を観測していない状態である。

索引回復は既存の少量バッチとcron枠を維持し、quota失敗時はそのバッチを停止する。
手動`/vectorize-pending`は既知のquota中でも一度実問い合わせするため、連打しない。
`/classify-pending`は外部分類の回復にも使えるが、既存の対象条件（status/kind未付与）を変えない。
D1/Workers本体の無料枠枯渇まで継続できる二重基盤やオフライン同期は今回追加しない。

AIだけが回復してもタグ検索で未索引の新規記憶を失わないよう、既存のタグ候補内で
`vector_ids=[]`かつ全検索語が明確に字面一致する行を統合候補へ戻す。
未索引救済では`Cedarの移行`や`SB-024を反映`の日本語と識別子の文字種境界も認めるが、
`Cedarwood`や`SB-0249`等の部分一致は認めず、通常の検索重みは変えない。
AIの可用性によらず、取得済みのD1適格性（workspace、タグ、kind、期間、廃止状態）で
MMRの上位選択前に除外し、対象外の行が必要な候補の枠を消費することを防ぐ。
候補数・SQL本数・workspace/時刻/kind/statusの絞り込みは変えない。
通常のタグなし検索の順位問題や、索引済み記憶の追記部分の検索保証を解決する変更ではない。

`/stats`の既存集計で`oldest_unvectorized_at`を返す。猶予期間と廃止済みを除く
新規未索引記憶の最古作成日時であり、追記passageの待ち時間ではない。
画面は既存の合計待ち件数とこの経過時間を表示し、手動修復は1操作で1バッチのみ実行する。
直近の処理・失敗・残件を表示し、残件があっても自動で次バッチを送らない。
復元フローの複数バッチ処理は別の既存契約として維持する。

生成の言語・根拠・引用は`experiments/answer-quality`の合成固定2ケースで確認する。
機械検査と目視評価を分け、モデル変更や自動再生成は追加しない。
この改善をIssue #54の固定比較用source・fixtureへ混ぜない。

検索連続性の回帰試験は、保存済みの合成行から実際の`/vectorize-pending`へ進む。
枯渇時の1件失敗での停止、復旧後の埋め込み・Vectorize upsert・D1更新、再検索、
write admission解放まで確認する。AIとVectorizeはテスト用応答で、実サービス品質の証拠ではない。
従来のSQLによる索引済み状態の直接設定は、この回帰試験から除去した。

上流所有の正本は監査の `UPSTREAM_OWNED_PATHS`。Projectsのfilter/resolveを追加し、
既存のPrompt Capsule本体・routeなどとともに上流との完全一致を必須とする。
Projectsのregistry/autocreateに残るwrite admission等は引き続きfork境界として保守する。
夜間SQL予算はFree/ Paidの明示定数を使い、未使用の旧名 `NIGHTLY_D1_SQL_LIMIT` は撤去した。

## 3.5.0の期限と通知

期限4列はD1 entriesの正本であり、capture・MCP追記・snooze/clear・夜間抽出が
既存admissionとsource更新triggerを通る。MCP追記は本文と期限を一緒にCAS確定する。
HTTP export / R2 brain-v5は任意列として期限を保持し、旧形式はnullにする。
夜間抽出はworkspace別cursor、最大2モデル呼出、古さの再判定も2件ずつとする。
失敗・競合・予算不足では完了summaryを作らず、cursorを残して次回に繰り越す。

Push購読はD1 push_subscriptions、VAPID鍵と配達補助状態は既存OAUTH_KVに置く。
これらの資格情報は記憶export/backupから除外する。追加のbinding/cronは持たない。
時間別同期後のPushは同じ50 SQL予算からworkspaceごと6文を予約し、
1回4 workspace・40送信まで。途中の端末はKV配達記録で再開する。
KVの結果整合性と外部配達があるため、厳密な一度きり配達の保証ではない。
AI回復専用時刻は従来の回復処理に使い、通知は通常同期時刻で行う。

期限通知の候補は日時・IDで巡回し、workspaceも送信上限にかかわらず巡回する。
配達途中の成功端末を保持し、失敗端末は次回の定期巡回で再試行する。
配達記録の整理はD1の現存期限と1回30記録を照合する。30日を超えた期限も、
現在の記憶に同じ期限が残っている限り配達記録を保持する。
夜間の期限抽出は末尾到達の次回から再走査する。古い記憶のタスク化を拾う一方、
候補2件のモデル予算を維持する。正常な辞退判断だけは入力の指紋で最大30日再利用し、
モデルの再実行を省略する。本文・タグ・workspace・モデル・timezone・判定方針が変わると
次の走査で再評価する。本文やモデル出力はキャッシュに保存しない。
キャッシュは既存KVの補助状態であり、欠落・破損・障害・期限切れは通常の判定へ戻る。
モデル失敗と必須判定のない応答はキャッシュせず、失敗回数も入力ごとに分ける。
D1列・SQL・依存は追加せず、候補ごとのKV読取と正常な辞退判断のKV書込だけを追加する。
