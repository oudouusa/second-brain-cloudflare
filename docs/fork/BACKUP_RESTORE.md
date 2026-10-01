# R2 backup / restore

この文書は4.0.0統合branchのbrain-v5形式を説明する。3.7.0の配備済み版はbrain-v4である。

## 形式

手動snapshotだけを使用し、cronとmemory単位dual-writeは行わない。private bucket `second-brain-cf-archive` にimmutable chunkとmanifestを保存する。

```text
backups/YYYY/MM/<unix-ms>/chunks/entries-<global-offset>.json
backups/YYYY/MM/<unix-ms>/chunks/edges-<global-offset>.json
backups/YYYY/MM/<unix-ms>/chunks/projects-<global-offset>.json
backups/YYYY/MM/<unix-ms>/chunks/history-<global-offset>.json
backups/YYYY/MM/<unix-ms>/manifest.json
```

`brain-v5` manifestには `format`、`workerVersion`、`createdAt`、entry/edge/project/history件数、固定embedding profile、backup IDと、各chunkのtable種別、global offset、件数、object key、UTF-8 byte数、SHA-256を記録する。manifest自身のSHA-256はこれらのdescriptor全体を固定する。chunkとmanifestはR2 conditional putで上書きを拒否し、manifest公開前に失敗した今回分chunkはbest-effortで削除する。現行entryの`vector_ids`はdeployment固有なのでbackupに含めず、restore後に再埋め込みする。trash内に残る旧vector参照も復旧時に破棄する。R2へ保存するのはD1のentry、edge、Project設定とentry_versions／entries_trash／recall_log／entry_eventsの履歴である。Projectと履歴のworkspace IDは所属の復元に必要なため保持する。integrationのtoken、workspace管理レコード、利用者config、item map、同期cursorはR2へ書かない。

旧`brain-v2.json`と`brain-v3`／`brain-v4` manifestは読み取り互換として復元できるが、このbranchの新しいbackupは常に`brain-v5`で作る。

Cloudflare KVはeventual consistencyであり、D1とKVを厳密な同時点snapshotとして証明できない。この薄forkではintegration状態の独自復旧層を増やさず、backup前に全integrationを`purge=true`で切断し、D1に既知provider由来のmirrorが0件であることを必須条件にする。接続をKVから確認できた場合、またはprovider sourceのentryが1件でもあれば409で拒否する。接続直後で未syncの資格情報もbackup対象ではない。restore後に再接続し、外部正本から同期し直す。

snapshot作成時は120秒で失効する専用exclusive write barrierを取得する。新しい通常writeを止め、既存admissionがなくなったことをD1で確認してepochをrotateする。barrier中はentry/edge/project件数とedgeの参照整合性を確認し、各tableをglobal offset順のD1 pageで読み、最大4 MiBのchunkへ分割する。barrier ownerをpage読取とR2 writeの前に再確認するため、全体JSONをWorkerメモリへ載せず、書込みのない同一snapshotを維持する。成功・失敗を問わずbarrierはowner一致で解除する。他のmigration/backup barrierや実行中writeがあれば423で再試行させる。Worker強制終了で解除処理が走らなくても、期限切れsnapshot barrierはadmission、D1 trigger、次のbackup/restoreを妨げない。

## API

- `POST /admin/backup`: snapshotを作成する。
- `GET /admin/backups`: manifest metadataを新しい順に返す。
- `POST /admin/restore/:backupId`: 空のD1からpage単位でrestoreする。返却されたnext offsetを復旧先D1の`restore_state`台帳へ保存するため、引数なしの再呼び出しで再開する。

restoreはmanifest fingerprint、descriptorの連続性・件数、現在cursorを含む1 chunkのbyte数・SHA-256・JSON shapeと、そのpayloadに既知integration sourceがないことをD1 query・変更前に検証する。古いarchiveにintegration mirrorが含まれていれば409で拒否する。最初のrestoreは空D1だけを許可し、現在接続中と確認できるintegrationがあれば409で切断を求める。未完了pageの再実行は既存IDをskipし、entry・edge・projectの3つのresume cursorは後退させず、durable cursorより前方の`offset`、`edge_offset`、`project_offset`は409で拒否する。page内でentry/edge/projectが1件でも失敗した場合は503とし、cursorと`completed_at`を更新しない。成功した行はretryでskipされ、失敗行だけを再試行できる。最終pageではD1実件数とmanifest件数の一致を確認し、完了cursorと同じD1 transactionでintegration generationを更新する。

integration recordは`integrations:<provider>:<generation>`という世代別KV keyへ保存する。connect、disconnect、syncはいずれも現在のD1 write admissionとgenerationを確認し、restore開始前のinvocationが遅れて完了しても旧世代keyにしか到達できない。通常readは現世代だけを見るため、restore前のKV blobや別coloから遅れて現れた旧blobは以後未接続として扱われ、所有者が再接続したrecordだけが新世代で有効になる。旧世代objectの物理削除はKVのeventual consistency上の安全条件にせず、資格情報の保持期間を短くしたい場合は管理者がKV namespaceを明示的に清掃する。

`completed_at`後の同一backup呼び出しは、空backupを含め、明示的に古いoffsetを渡してもno-opであり、通常運用後のD1へ旧行を再挿入しない。最終responseを受け取れなかったclientは引数なしで再試行し、保存済みcursorと完了状態を受け取れる。非空backupを同じIDから新しく復元し直す場合だけ、復旧先D1を空にして新runとして開始する。空backupは空targetと意図的な再開始を区別できないため、同じbackup IDの明示的再開始は行わない。

`restore_state`はbackup ID、run ID、cursor、完了状態、短期leaseを保持する。同時に実行できるrestore pageは1つだけで、active lease中の二重実行は409となる。未完了台帳はpage間もmaintenance barrierとして残り、通常のREST/MCP memory mutationとscheduled jobを止める。restore自身だけがrun IDでbarrierを通過し、page終了時にはleaseを解放する。Worker停止などでleaseが残っても120秒後に再取得できる。完了後はbarrierが解除される。

別backupを非空D1へ重ねる操作は拒否するが、復旧先D1のentries、edges、projectsが空で、insight candidateとvector cleanup tombstoneも空なら台帳を新しいbackup IDへ切り替え、offset 0から開始できる。新しいrestore runのD1 claimと同じtransactionでembedding migration generationとmemory write epochを更新するため、共有OAuth KVに残った旧cursorや開始前admissionを復元後に再利用することはない。integration generation singletonの作成と初期行insertの間でupgradeが中断しても、最初のintegration read/saveが行欠損だけを1回修復して再読込する。台帳をD1へ帰属させることで、同じOAuth KVを使う一時restore drillが別D1の復旧を妨げない。旧KVキー`restore:r2:v1`は参照しない。完了後はintegrationを再接続・再同期し、`/vectorize-pending` またはembedding migrationで索引を再生成する。

3.6.0以降のFTS索引（`entries_fts`）と`entry_counts`は、`entries`から作り直せる派生データなので、R2 backupにもHTTP exportにも含めない。restoreが`entries`へ行を挿入すると、同期トリガーがFTSと件数を同時に更新する。取りこぼしがあれば、夜間の整合性チェックが検出してbackfillをやり直す。D1全体のSQL exportはFTS5の仮想テーブルがあると失敗するため、配備前の保全はD1 Time Travelとテーブル指定のSQL exportで行う（`DEPLOYMENT.md`の「配備前の保全と配備後の確認」）。

R2を有効化してbucketを作成するまでは、APIは503と固定bucket名を返す。これは意図した未配備状態である。

## Worker内処理の容量上限

Workerの128 MiBメモリを守るため、R2 snapshotの総行数・総byte数には上限を置かず、D1読取pageを2,000行、R2 chunkを最大4 MiB、manifestを最大512 KiBに制限する。1行だけでchunk上限を超える場合は413にし、復元時はobject bodyを読む前にR2 metadataのsizeを検査する。restoreのD1 write pageは従来どおり最大12行である。

手動`GET /export`の引数なしcomplete responseは後方互換のため500行・推定512 KiB・実JSON 768 KiBの上限を維持する。大きいbrainは`GET /export?paged=1&limit=500`から始め、responseの`pagination.next_offset`、`next_edge_offset`、`next_project_offset`を次のrequestへ渡し、`complete=true`まで取得する。HTTP pageは最大500行である。旧`brain-v2` restoreも単一objectを安全に読むため768 KiB・500行の上限を維持する。任意JSONを受ける通常の`POST /import`は構造膨張によるOOMを避けるため1 MiBかつentry＋edge＋project 10,000行で打ち切る。
