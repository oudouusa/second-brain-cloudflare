# Second Brain Cloudflare フォーク

[Second Brain](https://github.com/rahilp/second-brain-cloudflare)を、自分のCloudflareアカウントへ配備するためのフォークです。上流のMCP・REST・dashboard・Team機能を使い、固定128次元のEmbeddingGemma、日本語検索の補正、R2バックアップ、更新履歴と書込み保護を追加しています。MITライセンスと上流の著作権表示を維持しています。

## このフォークの構成

- **D1を正本にする。** 記憶本文・関係・履歴・削除台帳を保存し、Vectorizeは再生成できる派生索引にします。
- **EmbeddingGemma 128次元を固定する。** 埋込みモデルと次元が違う既存indexへ混ぜません。日本語・全角識別子の検索補正も保持します。
- **有限の処理予算と保存保護を保つ。** write admission、workspace分離、CAS、保留行の隔離、削除receiptを維持します。MCP・生成・夜間処理は既存Durable Objectへ送ります。
- **ChatGPT直接接続は任意。** 初期設定はWorkers AIです。本人が接続・有効化した所有者の個人領域だけでChatGPTプランを使います。VPS・CLIProxyAPIは不要です。

現在の基点は上流の未releaseの`release/4.0.0`（`d550921a8c0ae25f6788ead3d8209f29fc4df6d6`）です。上流の正式4.0.0 releaseと同じ配布物であるとは扱いません。

## 自己配備

[配備手順](docs/fork/DEPLOYMENT.md)に、アカウント確認、D1・KV・Vectorize・R2の作成、Cloudflare Access、秘密情報、初期化と確認をまとめています。

```sh
git clone https://github.com/YOUR_ACCOUNT/YOUR_PUBLIC_FORK.git second-brain
cd second-brain
npm ci --legacy-peer-deps
cp wrangler.jsonc wrangler.personal.jsonc
```

URLをこの公開forkのURLに置き換えてください。`wrangler.jsonc`は資産IDを持たない共通設定です。自身の資産ID・Worker名・所有者設定は、Git対象外の`wrangler.personal.jsonc`へ保存します。既存配備の更新では、その配備で使用している設定を明示してください。

[上流のDeployボタン](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)と[desktop app](https://github.com/rahilp/second-brain-cloudflare/releases/latest)は上流向けです。このフォークの128次元、Access、R2設定はこの配備手順から導入します。`installer/`の実装は上流と同じですが、本フォークでは独自のinstaller配布や署名を提供しません。

Workers・Durable Objects・Workers AI・D1・KV・Vectorize・R2の利用枠は個別です。無料枠内に収まることは保証しません。必要なサービスの利用可否と料金を自身のアカウントで確認してください。

## クライアント接続

| 接続方法 | URLと認証 |
| --- | --- |
| ブラウザ | `https://YOUR-WORKER-URL/dashboard`。所有者限定のCloudflare Accessでログインします。 |
| OAuth対応MCPクライアント | `https://YOUR-WORKER-URL/oauth-mcp`。WorkerのOAuthで認証します。Accessアプリでこのpathを覆わないでください。 |
| static token対応MCPクライアント | `https://YOUR-WORKER-URL/mcp`。`Authorization: Bearer <token>`を使います。外側にAccessアプリを設ける場合はその認証も必要です。 |
| REST | 所有者tokenまたは対応するユーザーtokenをAuthorization headerで渡します。tokenをURLへ入れません。 |

一般的な接続の問題は[Connect to AI Clients → Troubleshooting](https://github.com/rahilp/second-brain-cloudflare/wiki/Connect-to-AI-Clients#troubleshooting)も参照できます（Opera warnings、Cursor OAuth、Claude Code tool visibility）。endpointは上のfork用の表を使ってください。

<a id="memory-tools"></a>

### 記憶ツール

| ツール | 用途 |
| --- | --- |
| `remember` | 意見・決定・好み・文脈を保存します。事実が成立した日を`valid_from`、終了した日を`valid_until`で指定できます。 |
| `append` | 既存の記憶へ時刻付きの追記を加えます。 |
| `rollover` | 長くなった追記記録を、原文を残して短い現在状態の記憶へ継続します。 |
| `update` | 記憶の内容を更新します。事実が終了した日を`valid_until`で指定できます。 |
| `recall` | 意味による検索を行います。`as_of`で過去の日付に有効だった事実を検索できます。 |
| `brief` | 期限・未完了の約束・古くなった記憶・未確認の洞察を確認します。 |
| `resolve` | 追跡中の作業・日付・洞察・古くなった事実を整理します。 |
| `digest` | プロジェクトやタグについて、既存の自動要約を読みます。 |
| `history` | 記憶の変更と、それぞれの変更前の本文を読みます。 |
| `list_recent` | 最近保存された記憶を一覧表示します。 |
| `list_projects` | 読取り可能なプロジェクトを一覧表示します。 |
| `list_teams` | 所属する共有チームの名前とworkspace IDを一覧表示します。 |
| `get` | IDを指定して記憶を読みます。 |
| `forget` | 記憶をゴミ箱へ移します。`undo`で復元できます。 |
| `undo` | 記憶の直前の変更を取り消すか、ゴミ箱から復元します。 |
| `set_status` | 記憶を`canonical`・`draft`・`deprecated`に設定します。 |
| `set_memory_tier` | 手動の保存区分を`hot`・`warm`・`cold`へ変更します。`cold`も検索できます。 |
| `pin_memory` | 利用者が確認した現在の目標や制約をHot contextへ固定します。 |
| `unpin_memory` | 手動の固定を解除します。保存区分は変えません。 |
| `get_hot_context` | 手動でhotにした記憶や固定した記憶を、上限内で読みます。 |
| `get_prompt_capsule` | 認証済みMCPから、決定的なPrompt Capsuleと強いETagを読みます。 |
| `link` | 二つの記憶に明示的な関係を作ります。 |
| `unlink` | 記憶の関係を削除します。 |
| `connections` | 指定した記憶につながる記憶を一覧表示します。 |
| `share` | 個人領域と共有領域の間で記憶を移します。 |

事実の有効期間と変更履歴を区別します。`as_of`は過去に有効だった事実を検索し、新しい事実に置き換わった原文は履歴として残します。Team構成で領域を指定する場合は、`workspace=personal`が個人領域、`workspace=company`が共有領域です。常に本人が読取り可能な範囲を検索します。

<a id="projects"></a>

### プロジェクト

プロジェクトは記憶をまとめる単位です。`list_projects`で利用可能な一覧を読み、対応する検索・一覧・要約へプロジェクトを指定できます。チームへの所属だけでは、別の利用者の個人領域は読めません。

## 開発・更新

```sh
npm run typecheck
npm test
npm run check:scope
npm run benchmark:validate
```

[上流との同期手順](docs/fork/UPSTREAM_SYNC.md)と[所有権の境界](docs/fork/FORK_SCOPE.md)を参照してください。上流所有21ファイル、依存定義・lockfile、installerを独自に変更しません。

[依存のセキュリティ監査](docs/fork/DEPENDENCY_SECURITY.md)には、現在の指摘と利用条件、上流と同じ依存を保持する理由を記録します。CIのreport-only jobの成功だけを脆弱性0件の証拠にしません。

[ChatGPT直接接続](docs/fork/CHATGPT_DIRECT.md)、[R2バックアップと復元](docs/fork/BACKUP_RESTORE.md)、その他の[フォーク文書](docs/fork/README.md)も参照できます。資格情報・実記憶・個人の配備記録は公開Gitへ入れません。
