# CLIProxyAPI Prompt Cache paired certification — live v1

## Verdict

同一の一時JSONLから、認定manifestと運用測定manifestを分離生成した。両方の
`evidence_sha256`は
`b2b8e9fbf23cbb0e4ef775f32a95a4aa0754164cf963f1360876e8ad5eadfa41`で一致し、
どちらも`verified: true`である。

- [Qualification](./2026-09-03-cliproxy-cache-paired-v1.qualification.json)
- [Measurement](./2026-09-03-cliproxy-cache-paired-v1.measurement.json)

```text
qualification schema:       prompt-cache-proxy-qualification.v1
measurement schema:         prompt-cache-proxy-measurement.v1
mode:                       proxy-only
basis:                      cache-read-observed
direct:                     not_applicable
requests:                   20 / 20 successful
later request hit rate:     17 / 19 = 89.47%
all-input cache ratio:      30,464 / 38,380 = 79.37%
warm-input cache ratio:     30,464 / 36,461 = 83.55%
cached tokens per hit:      1,792
```

Capsuleは本番WorkerからMCP Managed OAuthで取得し、Core Capsuleは8,727文字、
complete、全requestでbyte-identicalだった。推論は固定されたCLIProxyAPI transportを
経由した。公式OpenAI API keyとSecond Brain static bearerは使用していない。

## Qualification attempts

同じ固定条件で最初に実行した候補は、20/20 requestが成功したものの、後続hitが
15/19（78.95%）で80%閾値に1件届かず不合格になった。成功扱いにはせず、同条件の
次バッチで17/19（89.47%）を観測したmanifestを正本とした。この差からも、hit率は
単一リクエストごとの保証ではなく、一定回数で評価する運用指標として扱う。

## Claim boundary

- 実キャッシュread: 認定済み
- initial cache write: 未観測
- cache write counter: 20 responseすべて0
- 公式Responses APIとの等価性: 未検証
- providerの料金割引: 未検証
- API費用推計: 未算出
- latency改善の因果関係: 未認定

今回のhit sampleはmiss sampleより遅く、non-streaming response全体には生成、ネット
ワーク、proxy処理が含まれる。そのため、キャッシュreadの観測結果をlatency改善へ
読み替えない。

## Credential boundary

ライブ実測時のCLIProxy受信キー取得元は`environment`である。値はmanifest、ログ、
repositoryへ保存していない。`systemd-credential`対応は実装・テスト済みの推奨運用
経路だが、今回のライブ実測条件には含めない。

外側の`prompt-cache-proxy-artifacts.v1` envelopeと生JSONLは共有証拠へ保存して
いない。永続化したのは、同じevidence hashを持つ2つのsanitized manifestだけである。
