# Prompt Cache経路認定

`qualify.mjs`は、Prompt CapsuleとLLMキャッシュ経路を、本文や資格情報を
証拠へ混入させずに認定するための厳格なoperatorです。利用形態に合わせて
2種類の契約を明示的に分けます。

## 推奨: CLIProxyAPIのみを使う構成

OpenAI Platform APIへ直接接続せず、CLIProxyAPIが保持するCodex OAuthだけを
使う場合は`proxy-only`を指定します。

```text
MCP Managed OAuthで本番Capsule取得
        ↓
固定されたCLIProxyAPI経路
        ↓
初回cache write＋後続cache read
        ↓
prompt-cache-proxy-qualification.v1
```

このモードは`OPENAI_API_KEY`と`SECOND_BRAIN_AUTH_TOKEN`を読みません。
`direct`は成功扱いに偽装せず、次のように明記されます。

```json
{
  "status": "not_applicable",
  "reason": "cliproxy_oauth_only"
}
```

### 1. 実行ホスト自身をMCP Managed OAuthへ一度認可

認定を実行するホスト上でOAuth clientを登録し、そのホスト専用のrefreshable
credentialを作ります。Dashboard cookieは使いません。初回consentではSecond Brainの
setup credentialをブラウザへ一度入力しますが、実験clientはその値を受け取らず、
保存もしません。以後の認定処理はroutineのstatic bearerなしで動作します。
credentialは絶対pathのmode `0600`ファイルへ保存され、OAuth tokenや認可codeは
出力されません。

```bash
install -d -m 700 "$HOME/.local/state/second-brain-cf"

node experiments/prompt-cache/mcp-authorize.mjs \
  --worker-url 'https://your-second-brain-worker.example' \
  --credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json"
```

clientは`--worker-url`からAccess非依存の`/oauth-mcp`を導出します。既存`/mcp`へ
置き換えてはいけません。本番Cloudflare Accessがその経路を先に捕捉し、Workerの
Managed OAuth challengeを置き換えるためです。

表示された一時URLをブラウザで完了すると、loopback callbackへ戻り認可が完了します。
リモートホストでは、同じcallback portをSSHのlocal forwardでそのホストへ結び、
ブラウザをforward元のPCで開きます。iPhone単体でURLを開くと`127.0.0.1` callbackが
iPhone自身へ戻るため、このhost-local認可は完了しません。credential fileを別ホストから
コピーしてはいけません。

以後はrefresh tokenが自動更新されます。再認可が必要な場合、非対話の認定処理は
`mcp_oauth_authorization_required`でfail closedし、認可URLを証拠へ混入させません。

### 2. CLIProxy受信キーを内部credentialとして渡す

CLIProxyAPIの受信キー自体は防御層として残します。ただし、利用者が値を
exportする必要はありません。systemdの`LoadCredential`または
`LoadCredentialEncrypted`で、固定名`prompt-cache-proxy-api-key`として渡します。
runnerは`CREDENTIALS_DIRECTORY`配下のこのファイルだけを読みます。

後方互換用として`PROMPT_CACHE_PROXY_API_KEY`も受理しますが、認定manifestには
値ではなく`environment`または`systemd-credential`という取得元だけを残します。

### 3. proxy-only認定を実行

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode proxy-only \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --proxy-model 'gpt-5.6-luna' \
  --source-auth mcp-oauth \
  --mcp-credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json" \
  --runs 4 \
  --delay-ms 2000 \
  --min-later-hit-rate 0.5 \
  --pretty \
  > /private/path/prompt-cache-proxy-qualification.json
```

合格条件はすべて満たす必要があります。

- Capsule sourceが`worker-mcp-oauth`（後方互換では`worker-access`）
- CLIProxyAPIのscheme、host、port、base pathを含むtransport hashが完全一致
- dry-runではない
- explicit requestがすべて成功
- run 2以降で`cached_tokens > 0`
- 後続hit率が指定した閾値以上
- Capsuleがcomplete（明示的に緩和した場合を除く）

CLIProxyAPI／Codex OAuth経路が`cache_write_tokens`を返す場合は、従来どおり
初回writeと後続readの両方を認定します。write counterを返さず後続
`cached_tokens`だけを返す場合は、`cache_proof.basis`を`cache-read-observed`、
`cache_write_observed`を`false`として認定します。この緩和は
`initial_cache_write_missing`だけが唯一の未達条件で、後続read、全request成功、
transport、OAuth sourceなど他の条件がすべて合格した場合に限ります。

したがって、観測していないwriteを成功扱いにはしません。認定するのは
CLIProxyAPI経路での実キャッシュreadです。

公式direct経路を実行していないため、公式APIとの等価性は認定しません。

### 4. 運用測定manifestを出力

認定に加えて、リクエストヒット率、入力トークンのキャッシュ率、レスポンス全体の
latencyを集計する場合は`--output measurement`を指定します。

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode proxy-only \
  --output measurement \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --proxy-model 'gpt-5.6-luna' \
  --source-auth mcp-oauth \
  --mcp-credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json" \
  --runs 20 \
  --delay-ms 2000 \
  --min-later-hit-rate 0.8 \
  --pretty \
  > /private/path/prompt-cache-proxy-measurement.json
```

出力schemaは`prompt-cache-proxy-measurement.v1`です。次を分けて記録します。

- run 2以降のリクエストヒット率
- 全runとrun 2以降それぞれのcached/input token比
- non-streaming Responses全体のmin/median/p90/max/mean latency
- 後続cache hitとmissを分けたlatency、およびhitごとのcached token数
- cache write counterの観測sample数
- 初回write観測と、全sample中のwrite観測を分離したclaim
- API料金割引と公式API等価性が未検証であること

`input_tokens`、`cached_tokens`、`output_tokens`、`total_tokens`、`latency_ms`の
いずれかが欠ける場合、集計値を0へ丸めず`usage_counters_incomplete`でfail closed
します。CLIProxyAPI/Codex OAuthのusageはOpenAI Platform請求書ではないため、
`estimated_cost`は常に`null`です。

2026-09-03の最初の20回ライブ測定は、後続request hit率84.21%、全入力tokenの
cache率74.71%、warm区間78.64%で合格しました。このmeasurement単独の集計値と
claim boundaryは
[`results/2026-09-03-cliproxy-cache-live-v1.md`](./results/2026-09-03-cliproxy-cache-live-v1.md)
を正本とします。ゴール完了認定の正本は、次節のペアmanifestです。

### 5. 同じ実測から認定と測定を分離保存

ゴール完了証拠を作る場合は`--output artifacts`を使います。1回だけ生成した一時
JSONLから、`prompt-cache-proxy-qualification.v1`と
`prompt-cache-proxy-measurement.v1`を同時に構築します。

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode proxy-only \
  --output artifacts \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --proxy-model 'gpt-5.6-luna' \
  --source-auth mcp-oauth \
  --mcp-credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json" \
  --runs 20 \
  --delay-ms 2000 \
  --min-later-hit-rate 0.8 \
  --pretty \
  > /private/path/prompt-cache-proxy-artifacts.json
```

外側の`prompt-cache-proxy-artifacts.v1`は安全な受け渡し用envelopeです。永続化する
正本は、内側の`qualification`と`measurement`を別々のJSONファイルへ保存します。
両方の`evidence_sha256`が一致するため、同じ実測から作られたことを機械的に確認
できます。生JSONLは保存せず、既存measurementからqualificationを逆生成しません。
2026-09-03の完了証拠は
[`results/2026-09-03-cliproxy-cache-paired-v1.md`](./results/2026-09-03-cliproxy-cache-paired-v1.md)
に記録しています。

## 既存: 公式directとproxyを比較する構成

公式Responses APIとの独立比較が必要な場合は、従来どおり`compare`を使います。
このモードは後方互換のため残しており、既定値も`compare`です。

```text
本番Worker Capsule
        ↓
公式Responses API A/B
        ↓ direct gate合格が必須
CLIProxyAPI
        ↓ proxy gate合格が必須
同一Capsule／model／breakpoint比較
        ↓
prompt-cache-qualification.v1
```

必要な資格情報は次です。

```bash
export SECOND_BRAIN_AUTH_TOKEN='...'
export OPENAI_API_KEY='...'
export PROMPT_CACHE_PROXY_API_KEY='...'
```

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode compare \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --direct-model 'gpt-5.6-luna' \
  --proxy-model 'gpt-5.6-luna' \
  --pretty
```

`--source-auth mcp-oauth --mcp-credential-file PATH`を追加すれば、compareでも
Second Brain bearerの代わりにManaged OAuthを使えます。ただし公式direct用
`OPENAI_API_KEY`は必要です。`--source-auth access`も後方互換で残ります。

## project／company Capsule

project Capsuleを含める場合は`--project-id`を追加します。company workspaceでは
`--workspace company`を使い、所属先が複数なら`--team`も指定します。

```bash
node experiments/prompt-cache/qualify.mjs \
  --mode proxy-only \
  --worker-url 'https://your-second-brain-worker.example' \
  --proxy-base-url 'http://127.0.0.1:8317/v1' \
  --proxy-model 'gpt-5.6-luna' \
  --source-auth mcp-oauth \
  --mcp-credential-file "$HOME/.local/state/second-brain-cf/prompt-cache-oauth.json" \
  --project-id 'p-7f3a' \
  --workspace company \
  --team 'opaque-workspace-id' \
  --pretty
```

## 出力と終了コード

出力にはhash、集約済みcache metrics、boolean、固定failure codeだけを含めます。
Capsule本文、model出力、Worker／proxy URL、Bearer、Access JWT、API key、project／
team id、生JSONLは含めません。

```text
0  選択した認定契約に合格
1  CLI、資格情報取得、child process、または証拠構造が不正
2  証拠構造は正しいが認定条件に未達
```

`proxy-only`のschemaは`prompt-cache-proxy-qualification.v1`、従来比較のschemaは
`prompt-cache-qualification.v1`です。同じ名前にせず、direct未実施を後から
成功済みと誤読できないようにしています。

child processへ渡す環境は経路ごとに分離します。proxy-onlyでは親processに
古い`OPENAI_API_KEY`や`SECOND_BRAIN_AUTH_TOKEN`が残っていてもchildから削除し、
systemd credential directoryも引き継ぎません。CLIProxy受信キーは必要なchildの
`Authorization`へだけ移し替えます。
