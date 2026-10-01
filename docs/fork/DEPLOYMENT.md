# 自己配備と更新

この手順は新しい空の配備向けです。既存の記憶DBや異なる次元のindexへ、新規導入の設定をそのまま上書きしません。実資産ID・秘密情報・配備結果は各所有者の保管場所へ保存します。

## 前提と設定の分離

Node 22以上、npm、Git、Python 3、Cloudflareアカウントが必要です。D1、KV、Vectorize、Workers AI、SQLite-backed Durable Objectsを利用します。R2 backupを使う場合はR2も有効にします。Cloudflare Accessで所有者のdashboardを保護します。各サービスの枠と料金は個別で、無料枠内での運用は保証しません。

このforkの配備・build用scriptはWrangler 4.146.0を明示取得します。上流との一致を守るため、package/lock内のWranglerとは分けています。`npx wrangler`のような版指定なしの呼出しを、配備用の例へ置き換えないでください。

```sh
npm ci --legacy-peer-deps
umask 077
cp wrangler.jsonc wrangler.personal.jsonc
chmod 600 wrangler.personal.jsonc
sb_cf_profile=your-profile
sb_worker_name=my-second-brain
npx --yes wrangler@4.146.0 login --profile "$sb_cf_profile"
npx --yes wrangler@4.146.0 whoami --profile "$sb_cf_profile" --json
```

profile名とWorker名を自身の値に置き換え、アカウントが配備先と一致することを確認します。`wrangler.personal.jsonc`は`.gitignore`で保護します。Worker名と後述の資源名をこのファイルで揃えます。

共通設定は実資産IDを持ちません。WranglerにはD1/KV等の自動作成機能がありますが、この手順では対象を明確にするため先に資源を作成し、自身のIDを実配備設定へ記録します。自動作成を使う場合も、共通設定のコピーへ配備して、生成されたIDを公開Gitへ入れないでください。
[Wranglerの自動作成](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)

## 空の資源を作る

```sh
npx --yes wrangler@4.146.0 d1 create "${sb_worker_name}-db" --profile "$sb_cf_profile" --config wrangler.personal.jsonc
npx --yes wrangler@4.146.0 kv namespace create OAUTH_KV --profile "$sb_cf_profile" --config wrangler.personal.jsonc
npx --yes wrangler@4.146.0 vectorize create "${sb_worker_name}-eg128" --dimensions 128 --metric cosine --profile "$sb_cf_profile"
npx --yes wrangler@4.146.0 vectorize create-metadata-index "${sb_worker_name}-eg128" --property-name parentId --type string --profile "$sb_cf_profile"
npx --yes wrangler@4.146.0 vectorize create-metadata-index "${sb_worker_name}-eg128" --property-name workspace_id --type string --profile "$sb_cf_profile"
npx --yes wrangler@4.146.0 r2 bucket create "${sb_worker_name}-archive" --profile "$sb_cf_profile"
```

返されたIDと実際の名前を`wrangler.personal.jsonc`へ記録します。

| 設定 | 自身の値 |
| --- | --- |
| `name` | 一意なWorker名 |
| `d1_databases[0].database_name` / `database_id` | 作成したD1の名前・ID |
| `kv_namespaces[0].id` | 作成したKVのID |
| `vectorize[0].index_name` | 作成した128次元indexの名前 |
| `r2_buckets[0].bucket_name` | 自身のprivate bucket名 |

binding名は`DB`、`OAUTH_KV`、`VECTORIZE`、`AI`、`ARCHIVE`、`MCP_EXECUTOR`のままです。`McpExecutor`のSQLite migration、compatibility flags、assetsのrouting、cronの5本は共通設定を引き継ぎます。ChatGPTの2つの選択設定は空のままにします。

R2を利用しない構成では`r2_buckets`を外せます。その場合、backup APIは503を返し、R2による復旧機能は使えません。Vectorizeのmetadata indexは最初のvector書込み前に作成してください。既存indexへ後から追加する場合は[チーム統合の手順](../team-integration.md)で再upsertの要否を確認します。

## 所有者限定のCloudflare Access

Cloudflare Zero Trustで、自身のteam domain、所有者メールだけを許可するpolicy、2つのSelf-hosted HTTP applicationを用意します。Workerの配備先hostnameを使います。

| アプリ | 保護するpath | Worker側のaudience設定 |
| --- | --- | --- |
| dashboard用 | `/dashboard`とその配下 | `DASHBOARD_ACCESS_AUD` |
| Access対応MCP用 | `/mcp` | `ACCESS_AUD` |

各アプリのApplication Audience (AUD) tagを取得します。`ACCESS_TEAM_DOMAIN`は`https://YOUR-TEAM.cloudflareaccess.com`、`ACCESS_ALLOWED_EMAIL`は所有者自身のメールです。dashboard用のappでAPIとHTMLが同じaudienceになるように設定します。

hostname全体を一つのAccessアプリで覆わないでください。`/oauth-mcp`、`/oauth/authorize`、`/oauth/token`、`/oauth/register`とREST APIはWorker自身の認証を使い、MCPのOAuth challengeがブラウザ向けAccessページへ置き換わらないようにします。WorkerはdashboardのJWT署名・issuer・audience・期限・所有者メールも検証します。Access設定が欠けるとdashboardは503になり、公開されません。
[AccessのHTTPアプリ設定](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)

## 秘密情報を設定する

所有者tokenはランダムに生成し、Git対象外のmode 0600ファイルへ保存します。以下は初回導入用で、既存tokenがある場合は停止します。複数配備では配備ごとに保存先を分けます。tokenは画面に表示しません。

```sh
set -eu
umask 077
mkdir -p "$HOME/.config/second-brain-cf"
chmod 700 "$HOME/.config/second-brain-cf"
python3 - <<'PY_SECRET'
import getpass, json, os, secrets
from pathlib import Path
folder = Path.home() / '.config/second-brain-cf'
with (folder / 'owner-token').open('x') as token_file:
    token_file.write(secrets.token_urlsafe(32))
os.chmod(folder / 'owner-token', 0o600)
values = {'AUTH_TOKEN': (folder / 'owner-token').read_text().strip()}
for name in ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'DASHBOARD_ACCESS_AUD', 'ACCESS_ALLOWED_EMAIL']:
    values[name] = getpass.getpass(name + ': ').strip()
    if not values[name]: raise SystemExit('設定値が空です')
file = folder / 'secrets.json'
file.write_text(json.dumps(values))
os.chmod(file, 0o600)
PY_SECRET
npx --yes wrangler@4.146.0 secret bulk "$HOME/.config/second-brain-cf/secrets.json" --profile "$sb_cf_profile" --config wrangler.personal.jsonc
```

初回にWorkerの作成を求められたら、設定のWorker名とアカウントを確認します。secretはこのWorkerに属する値です。`AUTH_TOKEN`をURL、shell引数、公開Issue、GitHub Actionsの通常ログへ入れません。
[Wranglerの秘密情報](https://developers.cloudflare.com/workers/configuration/secrets/)

ChatGPTを使わない構成では`CHATGPT_CREDENTIAL_KEY`は不要です。上流の必須secretに追加しません。

## build・配備・初期化

```sh
npx --yes wrangler@4.146.0 deploy --dry-run --profile "$sb_cf_profile" --config wrangler.personal.jsonc
npx --yes wrangler@4.146.0 deploy --profile "$sb_cf_profile" --config wrangler.personal.jsonc
```

配備されたURLを確認して、所有者tokenで`/health`へアクセスします。curlの設定ファイルを使い、tokenそのものを引数へ出さない例です。

```sh
python3 - <<'PY_CURL'
import os
from pathlib import Path
folder = Path.home() / '.config/second-brain-cf'
token = (folder / 'owner-token').read_text().strip()
file = folder / 'curl-owner.conf'
file.write_text('header = "Authorization: Bearer ' + token + '"\n')
os.chmod(file, 0o600)
PY_CURL
sb_worker_url=https://YOUR-WORKER-URL
curl --fail --silent --show-error --config "$HOME/.config/second-brain-cf/curl-owner.conf" "$sb_worker_url/health"
```

認証済みhealthは順序付きruntime migrationをawaitしてから返します。`database.status=reachable`を確認します。`ok`とVectorize/AIの状態も別に確認してください。埋込みのない空DBは正常で、AI状態は受動的な観測です。DB到達だけで検索や生成の品質を合格にしません。

`db/schema.sql`を既存remote DBへ直接適用しません。単純な`CREATE TABLE IF NOT EXISTS`だけでは必要な列やtriggerを更新できないためです。

次に、認証なしのRESTが拒否されること、他のメールでdashboardに入れないこと、所有者がdashboardに入れることを確認します。MCPはOAuthなら`/oauth-mcp`、static tokenなら`/mcp`を使います。最初は機微でない合成記憶で保存・検索・削除を確認します。[SMOKE_MATRIX.md](SMOKE_MATRIX.md)の順序を利用できます。

## 更新前の保全と更新後の確認

更新時は実配備に使っているconfigとprofileを明示します。共通設定の`CHATGPT_OPERATIONS`と`CHATGPT_OWNER_WORKSPACE_ID`は空なので、共通設定で有効な配備を上書きすると直接生成がOFFになります。`--keep-vars`でもconfigに明示した値は反映されます。

更新前に現在のWorker version、D1 Time Travelの復元地点、config、schema version、件数、比較用の記憶内容hashを所有者の保管場所へ記録します。秘密情報や本文を公開Gitへ入れません。

FTS5の仮想テーブルがあるD1では全体のSQL exportが使えない場合があります。Time Travelと、必要な実テーブルだけのSQL exportを組み合わせます。`entries_fts`・`entry_counts`などの派生表、ChatGPTの`chatgpt_session`と`chatgpt_host`は記憶backupへ含めません。別Workerへ復元した場合は、そのWorkerのhostで再認証します。Time Travelで更新済みrefresh tokenを巻き戻した場合も再認証が必要です。

更新後は`/health`、schema、件数とhash、認証拒否、workspace分離、必要な生成経路を確認します。version rollbackとD1復元は別操作です。各操作の復元対象と、更新された記憶を巻き戻す範囲を確認して実施します。

## 任意のChatGPT接続

[CHATGPT_DIRECT.md](CHATGPT_DIRECT.md)の所有者限定の手順を使います。接続後に表示する有効化候補を`wrangler.personal.jsonc`へ記録し、明示的に配備します。未選択の処理はWorkers AIのままです。ChatGPTの使用量とCloudflare各サービスの使用量は別に確認します。
