# 任意のChatGPT直接接続と上流提案

所有者が接続と利用範囲を明示した場合だけ、公開Responses APIへOAuthで接続する。
初期設定はWorkers AI。API key・ChatGPT backend-api・VPS・CLIProxyには依存しない。
上流への最初の提案範囲は、**配備所有者の個人workspaceだけ**とする。
Team、member、別のadminの個人領域、範囲不明・混在の処理に所有者のプランを使わせない。

実装は[OSS向けのSign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)と
[公開Responses仕様](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)に基づく。
OpenAIは有償・remote hosted app向けには別途参加の申請を案内している。
個人Workerでの接続成功を、一般公開・商用hostedサービスの参加資格の証明にしない。
Workerを一つのhostとして扱う設計は、[self-hosted VMの手順](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
をWorkersに適用した判断であり、Workers専用の公式承認を意味しない。

PR #117は2026-10-01に本番反映し、VPC binding・private adapter・旧API key要件を撤去した。
生成callerは公開Responsesへ直接接続する。旧secretも本番から削除した。
配備前後の保全・検証と、外部資産を停止していない範囲は[DEPLOYMENT.md](DEPLOYMENT.md)に記録する。

## 導入と明示有効化

`wrangler.jsonc`の`CHATGPT_OPERATIONS`と`CHATGPT_OWNER_WORKSPACE_ID`は空が既定。
`CHATGPT_CREDENTIAL_KEY`は任意secretで、通常の起動・Workers AI利用に要求しない。
直接接続を使う場合だけランダム32バイトをbase64にした鍵を設定する。
鍵・所有者tokenは保護したファイルから渡し、ログ・Git・コマンド引数に秘密を含めない。
配備時のaccount照合・Time Travel・version保全は[DEPLOYMENT.md](DEPLOYMENT.md)に従う。

Linux/macOSの例。`owner-token`にはこのWorkerの既存AUTH_TOKENを安全に保存しておく。
Node.js 22以降が必要で、systemd・sudo・VPS接続は不要。
Wranglerは自身のprofileとaccount・Workerを照合する。このforkの手順では`DEPLOYMENT.md`のprofile指定も必要。
Windowsも同じNode CLIを使い、token・設定directoryを所有者だけが読めるACLにする。
CLIはPOSIXのtokenファイル権限を検査するが、WindowsのACLは自動検証しない。

```sh
umask 077
mkdir -p "$HOME/.config/second-brain-cf"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' \
  > "$HOME/.config/second-brain-cf/credential-key"
sb_cf_profile=your-profile
npx --yes wrangler@4.146.0 secret put CHATGPT_CREDENTIAL_KEY --profile "$sb_cf_profile" --config wrangler.personal.jsonc \
  < "$HOME/.config/second-brain-cf/credential-key"

sb_worker_url=https://your-brain.workers.dev
sb_token_file="$HOME/.config/second-brain-cf/owner-token"
chmod 600 "$sb_token_file"
node scripts/chatgpt-auth.mjs login --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file"
node scripts/chatgpt-auth.mjs import --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file"
node scripts/chatgpt-auth.mjs status --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file"
node scripts/chatgpt-auth.mjs models --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file"
node scripts/chatgpt-auth.mjs probe --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file" --model gpt-5.6-luna
node scripts/chatgpt-auth.mjs enable --worker-url "$sb_worker_url" --auth-token-file "$sb_token_file" --operations answer
```

loginが表示する127.0.0.1のページを待受端末のブラウザで開き、`Continue with ChatGPT`を選ぶ。
ページには接続先Worker、profile、プラン利用の説明と使用量管理リンクがある。
OpenAIの認証URLには再認証用ID token hintを含み得るため、端末・ログには表示しない。
callbackは127.0.0.1の`/auth/callback`。既定portは1455、`--port`で変更できる。

`status`は接続中のclient/subject、署名済み表示情報、状態、所有者workspace、現在の設定を返す。
`models`は同じaccess tokenで取得したcatalogの表示対象をサーバー順に返す。
現在の品質検証対象はLuna/Terraだけで、新しいcatalogモデルを自動採用しない。
`enable`はcatalogと許可モデルを確認して**設定候補を表示するだけ**で、推論・有効化・配備をしない。
既定の候補は`answer`だけ。出力された`CHATGPT_OWNER_WORKSPACE_ID`と処理選択を
Git対象外の`wrangler.personal.jsonc`へ反映し、対象モデルのprobeを確認して通常の配備手順で有効化する。
保存判断を選ぶ場合はTerraのprobeも必要。

## 利用範囲と処理選択

| 設定・処理 | 動作 |
| --- | --- |
| `CHATGPT_OPERATIONS`が空 | 通常のWorkers AI。接続管理・明示probeは可能 |
| `CHATGPT_OWNER_WORKSPACE_ID`が空 | 通常生成にChatGPTを使わない |
| 所有者の個人領域だけを明示した処理 | 選択済みoperationだけChatGPTを使う |
| Team・member・別admin・範囲不明・混在 | 通常のWorkers AI。選択中でも所有者のプランを使わない |
| 選択済みの個人処理が失敗 | 元の保存見送り・再試行・503契約。別providerへ自動再送しない |

対応設定名は`classify,query-tags,smart-merge,contradiction,recall-summary,digest,answer,weekly-insight`。
現行4.0のquery-tagsは既知タグの照合だけで、生成を呼ばない。設定名と予算の互換性は残すが、
この提案でタグ推論を復活させない。
`classify`・`recall-summary`・`answer`の通常モデルは`CHATGPT_MODEL`のLunaを既定とし、
`smart-merge`・`contradiction`・`digest`・`weekly-insight`は固定Terraを使う。
未選択・適用外の処理と固定Gemma128、既存reranker等は従来のWorkers AIを使う。

範囲はHTTPやMCPの認証済みidentity、capture/mirrorのWriteContext、夜間処理の実際の行から決める。
暗号化sessionにも実際の所有者workspaceを束縛し、設定を他のworkspaceに誤指定しても
refresh・Responses送信前に拒否する。内部の`CHATGPT_WORKSPACE_ID`はbindingではなく、
要求headerやJSONから取り込まない。Envの範囲設定はKV・D1予算・隠れたwrite admissionを保持する。

`POST /chat`の`memories`はclient作成の文字列なので、本文の出所をserverで証明できない。
直接接続には`workspace:"personal"`と認証済み所有者のworkspaceが必要。
付属UIは実際の検索結果がすべて個人領域の場合だけこの宣言を送り、利用時に
既存en/itの翻訳設定で「Using ChatGPT plan」と[Manage usage](https://chatgpt.com/settings/usage)を表示する。
直接接続の画面は完了通知を確認し、途中EOFやread失敗時には部分回答を除去してエラーを表示する。
任意clientから所有者本人が送った本文の出所まで保証する仕様ではない。

## 登録と資格情報

[認証手順](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)に沿って毎回新しいstate/nonce/PKCEを生成する。
初回だけdynamic clientで登録し、issued client IDを保存する。同じprofileの再認証では
client IDと署名検証済みsubjectを維持する。emailをregistrationやworkspaceの識別子にしない。

WorkerがD1の`chatgpt_host`へUUIDのhost IDを一度保存する。CLIはそのIDで認証し、
importは対象WorkerのIDと一致する資格情報だけを受け付ける。
端末変更・アカウント切替・切断ではWorkerのhost IDを作り直さない。
資格情報の管理tableはowner管理時のruntime DDLで作り、記憶schema/versionは変更しない。

ローカル保存先は`~/.config/second-brain-cf/hosts/<Worker originのSHA-256>/profiles/<profile>/`。
`--config-dir`でroot、`--profile`で登録を選ぶ。
`registration.json`はclient、verified subject、表示情報、retained ID hint、Worker hostを保持する。
`pending.json`は転送前の資格情報で、Workerの保存を確認したimport後に削除する。
ファイルは原子的に0600、directoryは0700で作る。
同じprofileのlogin/import/disconnectはoperation.lockで排他する。
強制終了後は、そのprofileを操作するCLIがないことを確認してoperation.lockだけを削除する。
転送の結果が不明ならstatusで接続中アカウントを確認し、古いpendingをrefreshに使わず再認証する。
既存の私用URL・systemd-credsを暗黙には使わず、接続先とtokenファイルを明示する。

`profiles`で保存済み登録を確認し、別登録は`login --profile another`で追加する。
同じemailでも別client/subjectを独立させる。現段階はWorkerのactive sessionが一つで、
切替には選択profileのlogin→importが必要。転送後に古いrefresh tokenを端末で使わない。
inactive accountの資格情報をWorkerに複数保持して即時切替するUIは、この最初の提案には含めない。
ID tokenは有効でもプラン利用scopeがない場合は、identityを残して推論資格情報を作らない。
選択profileで`login --consent`して権限を取得し直す。

WorkerもID/access tokenの署名・issuer・audience・期限と初回nonce、direct grantを検証する。
access/refresh/ID tokenとアカウント情報はD1の`chatgpt_session`にAES-GCMで暗号化する。
status・ログ・通常brain-v5 exportには資格情報を含めない。
D1 snapshot/Time Travelには暗号文とhost IDが残り、鍵があれば復号できる。

## 更新・切断・復旧

refreshの所有権はWorkerだけが持つ。D1 CASで更新を排他し、token・期限・grantを原子的に置換する。
更新成功後のID tokenは初回nonceを要求せず、署名・issuer・audience・subject・期限を検証する。
結果が不確かな更新は古いrefresh tokenで再送しない。

- `refresh_in_progress`: 別要求の更新完了を待って再試行する。
- `reauth_required`、更新中断・応答消失: 選択profileでlogin→importする。新revisionは遅延した旧更新で上書きされない。
- 利用上限・利用不能: 使用量管理へ進み、権限・上限を確認する。別方式へ迂回しない。
- 鍵喪失・Time Travel復元: 古いtokenを再利用せず、復旧した正しい鍵または新しい鍵で再認証する。鍵を通常deployで上書きしない。

停止する場合は`CHATGPT_OPERATIONS`を空にして配備してから、選択profileで`disconnect`する。
CLIはWorkerのactive clientとprofileを照合し、DELETEにも対象clientを渡す。
切断はdiscoveryのOpenAI originの失効先へrefresh tokenを送り、暗号文を削除する。
`revoked:false`はremote失効未確認。使用量管理・ChatGPT設定で接続を解除する。
ローカルのpending/ID hintも消し、client/subjectの登録情報とWorker hostは保持する。
同時に新しい認証が入っても、そのrevisionの暗号文を削除しない。

既存配備からの移行では、この変更前のsessionに所有者束縛とアカウント表示情報がない。
**直接生成を一度無効にし、新CLIでWorker hostを取得して再認証・importしてから再有効化する。**
旧ファイルや推論資格情報をCLIが暗黙に移行・再送することはしない。
配備時に選ぶregistrationのissued clientと検証済みsubjectだけを明示的に引き継ぐ場合も、再認証して署名・grantを確認する。
本番での移行・設定は[DEPLOYMENT.md](DEPLOYMENT.md)と当該配備のreadbackを参照する。

公開HTTPは3xxを拒否し、資格情報を別originへ転送しない。
Responsesには`store:false`、`stream:true`、`developer/user`を送る。
preview非対応の`max_output_tokens`・temperatureは送らない。
SSEは完了まで検証し、未完了・途中失敗・不正JSON・過大本文を成功にしない。
ローカル文字上限、SSEの256 KiB上限、15/25秒の期限はプラン消費量や生成token数の上限ではない。

## Upstream proposal draft

Published as [upstream issue #384](https://github.com/rahilp/second-brain-cloudflare/issues/384).

### Proposal: optional ChatGPT plan usage for owner-only dashboard answers

#### Summary

Would an optional ChatGPT provider for the built-in dashboard's answers be useful?
An owner who already has an eligible ChatGPT plan could explicitly authorize
Second Brain to use that plan through Sign in with ChatGPT and the public
Responses API. Workers AI would remain the default, with no sign-in required.

The benefit is an additional inference option for the dashboard. I am not claiming
better answer quality, lower cost, or lower latency without a paired evaluation.
This is a design discussion, not a ready-to-merge upstream implementation.

#### Initial scope

- Disabled by default; explicitly enabled by the deployment owner.
- Dashboard answer generation only, using the owner's personal workspace.
- No team/member usage, background classification, merges, or nightly jobs.
- Preserve MCP recall without server-side synthesis, as in [#219](https://github.com/rahilp/second-brain-cloudflare/pull/219).
- No access to ChatGPT conversation history. No changes to search, embeddings,
  memory storage, the desktop installer, or existing authentication.

An upstream patch would need server-established personal retrieval scope.
Client-supplied workspace labels alone do not prove where answer context came from.

#### Authentication and inference boundaries

- Bind one active credential session to the deployment owner. Keep a stable,
  opaque host ID and separate registrations by Worker origin and account profile.
- Complete OAuth locally with state, nonce, PKCE and signed ID-token validation;
  securely transfer credentials to the owner-authenticated Worker. Let the Worker
  own refreshes, with encrypted D1 storage and conditional updates preventing
  stale refreshes or disconnects from overwriting a newer session.
- Use the signed-in account's model catalog and an explicitly qualified model
  allowlist. Missing models must produce an actionable error.
- Call the public Responses endpoint with `store: false` and `stream: true`.
  Require `response.completed`; interrupted or failed streams must not leave a
  partial answer presented as complete. Bound response size and request lifetime.
- Show the active provider and a Manage usage link using existing translations.
  Distinguish usage limits, expired/revoked sessions and transient failures. Do not
  automatically retry a selected ChatGPT request through a billable API provider.

This would add credential lifecycle maintenance. A first experimental flow could
use an advanced-owner CLI; a complete dashboard account/recovery UI would need
separate work. The proposal does not require a VPS, proxy service, new runtime
dependencies, or a new Durable Object binding.

#### Evidence and checks before adoption

A fork prototype exercises owner/workspace isolation, encrypted credentials,
refresh/disconnect races, loopback OAuth and stream completion with synthetic
tests. These checks are not a Workers AI comparison or proof of production
latency, resource cost, or general deployment eligibility. The fork also explores
other operations; those are outside this first upstream proposal.

Before adoption, I would prepare a minimal upstream patch and check:

1. Default installations still work without ChatGPT credentials; team, member,
   mixed-context and unconfigured requests cannot consume the owner's plan.
2. Credential rotation, account mismatch, revoked consent, usage limits and
   interrupted streams have reproducible tests and clear recovery steps.
3. A shared answer fixture set compares Workers AI and ChatGPT for source-backed
   accuracy, citations, dates, time to first text, and completion time.
4. Worker CPU/wall time and storage usage are measured on the upstream route,
   rather than inferred from the fork's execution architecture.

#### Open questions

OpenAI's [overview](https://developers.openai.com/siwc/token-sharing-open-source)
describes open-source/local apps and directs paid or remotely hosted apps to an
interest form. Its [self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
describes credential transfer and remote refresh ownership; I am treating that as
a design reference, not confirmation that an owner-managed Cloudflare Worker is
eligible. Deployment eligibility needs confirmation before general distribution.
The [inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
defines the public endpoint and completion contract above.

Would this limited, owner-only answer provider be worth exploring, and is an
advanced-owner experiment an acceptable starting point for the project?
