# 夜間D1予算・安全な繰越

2026-09-12のPR #80初回候補 `14dcea320b5c30edf63277807ffad91d5d23c412` に対する追加修正として始めた。
上流の一括夜間処理、CLIProxy生成、Gemma128/Vectorize、D1正本という分担は変えない。
SQL制御は現在のmainと3.6.0本番に含まれる。実CPU/課金行数/品質のP5全体の受入は、この文書だけでは確認できない。

## 問題と変更範囲

初回候補の1タグ/4 graph候補/5 stale候補だけでは、cleanupと再試行の予算を守れなかった。
前の調査では削除送信待ち30件だけで99 SQL、抽出した夜間処理全体では144 SQLとなった。
近傍なしのgraphも、新しい4件を繰り返し選んでいた。

SQL予算の実装で追加するproduction moduleは `src/runtime/d1-budget.ts` 一つ。
Env型以外のimport、永続台帳、独自DB、cron、DO、キュー、外部サービスは追加しない。
この計数moduleの監査allowlistを明記し、既存のwrite fence、所有権、依存、scope、coverage gateは維持する。
後続のCPU境界修正では既存実行本体を `runtime/scheduled.ts` へ移動し、既存DOへ夜間だけを転送する。
DO内でも同じFree既定50文/Paid明示1,000文のSQL予算と予約を適用する。
cleanupの低層依存契約はこの計数moduleだけ拡張し、capture/provider orchestrationへの逆依存を禁止する。

## 実行単位の予約

`src/index.ts` の `nightly_maintenance` だけに、実行プロファイルに応じたSQL台帳を付ける。
既定はFree互換の50で、Workers Paidを確認した環境だけ
`NIGHTLY_D1_EXECUTION_PROFILE=paid`を明示して1,000へ広げる。Workerから契約プランを判定するAPIは
使わず、未設定・大文字小文字の違いを除く未知値・スペルミスは50へfail-safeする。
このプロファイルは料金メーターではなく、公開されている実行上限に対する安全弁である。
HTTP、手動、別のintegration/weekly cronには今回の制御を暗黙適用しない。
初期化、admission取得、workspace選択、3 pass、遅延書込、cleanup、admission解放まで同じ台帳を使う。

- prepare/bindではなく、run/all/first/rawの送信前に1を消費する。
- batchは送信前に全statement分を一括消費する。予算不足ならbatch全体を送らない。
- 失敗した送信も返金しない。SQL枠とD1呼出回数を別々に数える。
- execはセミコロンで保守的に数える。literal/trigger内部の過大計数はあり得る。
  空batchも最低1枠とし、無制限の0コストdispatchを認めない。
- 予約はawait前に同期的に差し引く。予約所有者がproviderを待つ間、兄弟処理はその残量を使えない。
- 返すのは未使用枠だけ。二重releaseや閉じた予約の再利用で残量を復活させない。
- 生statementと予約statementの混在、別予約のbatch混在、未計数のsession/dump経路は拒否する。
- 元のEnvや認証tokenを変更せず、非列挙のadmission tokenも継承する。

実行開始時に解放用3 SQLを別予約する。処理本体はこれを消費できない。
既存admissionの最大3回の解放試行を維持する。DB自体が解放を拒否し続ける場合は、
既存の期限切れによるfail-closed回復を使い、解放成功を保証したとしない。

## 遠隔副作用を始める条件

cleanupは最初に最大8枠で古い負債を処理する。3 passと動的waitUntil処理の完了後、
予約を除く実際の残予算をcleanupへ戻す。Freeでは従来どおり小さく繰り越し、
Paidでは最大3ページを一回の実行で進められるため、50へ押し込むためだけの12夜分割を標準としない。どちらも既存の最大3ページと同じSQL台帳に従う。
ページ数だけを根拠に大量送信せず、項目の状態に合わせて次を予約する。

| 単位 | 予約 | 保持する保証 |
| --- | ---: | --- |
| cleanup完了行のretirement | 2 | capability更新とDELETEを同じbatchで処理 |
| 遠隔削除/再削除 | 3 | admission更新、remote用marker、返却receipt保存 |
| 新しいvectorのupsert | 6 | 権限、受付、source CAS、journal retirement |
| 履歴を伴うsource mutation | 上記に2追加 | before-imageとhistory edgeを既存batchで保持 |
| stale CASの再試行 | 再読込1＋対象行数 | 読み直しのawait中に書込枠を他passへ渡さない |

sourceのupsertは、元のdurable journalを作ってから必要枠を確保する。
確保できなければ遠隔送信前に延期し、本文・旧vector参照・cleanup journalを残す。
provider/receipt/source書込の失敗時も既存の補償とjournalを使う。追加の補償が予算に入らない場合、
遠隔結果が不明なのにjournalを消さない。受付receiptは削除の可視化完了とは区別する。

`sqlBudget`を指定するcleanupは、既に予算を付けたEnvを必須とする。
未計数のcallerに数字だけ渡して制限されているように見せない。従来の引数なし手動動作は維持する。

## 再試行と未完了

夜間のstale batchがDBエラーで拒否されたら、個別row fallbackを繰り返さない。
CASの競合は既存の最大3回の範囲で、再読込と書込ラウンドを予約できる場合だけ再試行する。
処理できない行の確認cursorを成功扱いで進めず、次回の候補に残す。

圧縮元の一括rolled-up UPDATEが失敗した場合も、夜間は最大50件の個別更新へ増幅しない。
原記憶は保持し、complete:falseを伝える。保存済みdigestが残る場合は既存cooldownが適用される。
今回、新しいexactly-once/digest修復protocolは追加していない。

夜間の遅延処理も同じ予算・admissionを使い、登録された処理の完了を待ってから結果を確定する。
budget deferral、pass未完了、cleanupエラー時は前回の完全なnight summaryとranAtを保持し、
`scheduled_job.outcome=partial`等で区別する。全待ち行を今夜処理したという意味のsummaryではない。
`nightly_budget`はused/calls/deferred/limitだけを出し、SQL・本文・workspace ID・資格情報は記録しない。

## グラフ候補の公平性

workspaceが確定しているgraph passは、旧policyのedgeを持つ記憶と未接続記憶を同じ候補集合にし、
`created_at DESC, id DESC` のkeysetで進める。cursorは既存KVにworkspaceとpolicyを分けて保存する。
近傍0件、候補単位の失敗も走査を止めない。末尾で折り返し、失敗・本文変更・新規追加を再訪する。
同じ時刻の複数行はidで区別し、cursorの元の行が削除されても続きを読める。
未指定workspaceの既存manual/legacy経路はそのまま残す。

KVはトランザクションや単調な並行実行レジスタではない。読取遅延・書込失敗では窓が再訪され得る。
cursorはedge確定の証拠ではなく、再評価の即時性、exactly-once、無限流入下の一巡時間も保証しない。
SQLは新しいworkspace束縛SELECTを1個増やすため、scope inventoryを141/76/19/2へ更新した。
exemptionは増やしていない。既存の安全assertを削除して帳尻を合わせていない。

## 回帰試験とローカル台帳

追加4ファイルは `d1-budget` 20件、`nightly-d1-budget` 22件、`vector-budget-reservation` 5件、
`graph-refresh-rotation` 11件。既存のownership/scope/cron exact-countも新しい接点に合わせた。
夜間の試験は抽出ハーネスではなく実際のWorker.scheduled入口、実SQLiteと実write fence、
実CLIProxy adapterを使用し、CLIProxy/AI/Vectorizeの応答だけを合成する。外部通信や本番データは使わない。
Free fixtureはSQL50、Paid fixtureはSQL1,000を超えるとテスト側native facadeも拒否する。
解放と動的waitUntilを含む計数である。

| 合成fixture | SQL枠消費 | D1呼出 | 結果 |
| --- | ---: | ---: | --- |
| 通常/初回cursor、短文・長文 | 45 | 36 | digest/edge/staleを実際に確定 |
| 日曜の追加掃除あり | 47 | 37 | 同上 |
| 削除送信待ち30件を併発 | 46 | 38 | 予算内で一部送信し、残りとjournalを保持 |
| 削除確認済み30件を併発 | 48 | 38 | 一部retirement、残りを保持 |
| 削除後もvisibleな30件 | 48 | 39 | 予算内の再送とreceipt保持 |
| stale CASが競合し続ける | 48 | 32 | 未処理確認cursorを進めず延期 |
| staleのDB書込拒否 | 45 | 36 | 個別fallbackなし、未完了 |
| 圧縮元50件の一括更新拒否 | 45 | 36 | 1回の拒否から個別50回へ増幅しない |
| admission解放の最初の2回が失敗 | 47 | 38 | 予約済みの3回目で解放 |
| Paid・削除確認済み30件 | 57 | 45 | 同じjournal/retirement境界のまま一晩で解消 |

Paid行は処理量の増加を確認する回帰条件であり、課金行数・CPU・本番性能の認定ではない。

同じ有限fixtureで24夜分を模擬したFree試験では、元の削除負債30件は12回目で0になった。
全24回とも50以下、原記憶77件を保持。これはこの合成負荷の結果であって運用SLOではない。
一晩で30件を処理したとの意味ではなく、流入が処理能力を上回れば待ち行は増え得る。
予算不足で作成済みsourceの索引を延期する場合もあり、既存pending回復との総合スループットはP5で測る。
近傍0件のgraph12記憶は3回×4件で12件すべてを訪問し、4回目に折り返す。
新規DBの初期化、release全失敗、provider/receipt障害、複合故障も別のケースで検査する。

この表は当該コードのローカルfixture計測で、Cloudflareの実課金行数、実CPU、API計数の実適用、
ライブモデル品質の数値ではない。テストの成否やCIは該当HEADの結果をPRに記録する。
初回候補のCI成功を後続HEADへ流用しない。

## 保留と削除条件

- 既存schema、索引、依存、installer、secret、5 cron、CLIProxy設定は変更しない。
- 新しい任意bindingは `NIGHTLY_D1_EXECUTION_PROFILE` だけ。未設定の既存配備はFree互換の50を維持する。
  Paidへ切り替える操作、main merge、本番配備はこのPRのコード変更とは別の承認事項とする。
- JSONタグ集計、stalenessのsort、graph sweep、cleanup検索の走査行数は別課題として残る。
  索引追加は既存DBの構築/更新rows_writtenとfresh/upgradeのmigrationを評価して別途レビューする。
  SQL送信数が有界でも、1 SQLの全件走査や大量UPDATEの日次消費は有界にならない。
- 枠を守ることと処理が十分早いことは別。実CPU10msへの適合や日次残量、待ち時間は今回認定しない。
- 予約されたreceipt書込もDB/provider自体の成功は保証しない。失敗時のdurable journalと期限切れを残す。
- 上流が同等の共通予算・予約・公平な候補選択を備えたら、そのテストを保って本差分を縮退する。
- P5は承認された隔離環境・合成データ・費用/停止条件で行う。main merge、本番配備、実メモリ操作、
  新インフラ、有料化、PR #73/#68の統合はこの修正の操作範囲外。
