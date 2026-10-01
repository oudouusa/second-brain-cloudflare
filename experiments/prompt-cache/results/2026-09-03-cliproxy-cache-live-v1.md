# CLIProxyAPI Prompt Cache measurement — live v1

## Verdict

CLIProxyAPIからCodex OAuthへ送った20回の連続Responses requestで、実キャッシュreadを
再現できた。後続19回のうち16回で`cached_tokens > 0`を観測し、事前に固定した
80%の合格閾値を超えた。

Canonical evidence:
[`2026-09-03-cliproxy-cache-live-v1.json`](./2026-09-03-cliproxy-cache-live-v1.json)

```text
schema:                  prompt-cache-proxy-measurement.v1
model:                   gpt-5.6-luna
requests:                20 / 20 successful
later request hit rate:  16 / 19 = 84.21%
all-input cache ratio:   28,672 / 38,380 = 74.71%
warm-input cache ratio:  28,672 / 36,461 = 78.64%
cached tokens per hit:   1,792
```

Capsuleは本番WorkerからMCP Managed OAuthで取得し、推論は固定されたCLIProxyAPI
transportを経由した。公式OpenAI API keyとSecond Brain static bearerは使用して
いない。Core Capsuleは8,727文字、complete、全requestでbyte-identicalだった。

## Latency observation

| Sample | n | Median | Mean | p90 |
| --- | ---: | ---: | ---: | ---: |
| All requests | 20 | 1,244 ms | 1,417.65 ms | 1,911 ms |
| Later cache hits | 16 | 1,244 ms | 1,392.06 ms | 1,911 ms |
| Later cache misses | 3 | 1,332 ms | 1,630.67 ms | 2,440 ms |

hitのmean latencyはmissより約14.6%短かった。ただしmissが3件しかなく、
non-streaming response全体の時間には生成・ネットワーク・proxy処理も含まれる。
したがって、cacheによるlatency改善の因果証拠とは認定しない。

## Claim boundary

- `cache-read-observed`: 認定済み
- initial cache write: 未観測
- 全sample中のcache write: 20 responseすべてcounterは0で、未観測
- OpenAI公式Responses APIとの等価性: 未検証
- providerの料金割引: 未検証
- API費用推計: 未算出

`cached_tokens`はCLIProxyAPI/Codex OAuth経路で返されたusage counterであり、
OpenAI Platformの請求書ではない。この結果が証明するのは、安定したCore Capsuleの
うち1,792 tokensが高い頻度で再利用されたことまでである。

## Reproduction contract

測定は`qualify.mjs --mode proxy-only --output measurement`を使い、次を要求した。

- MCP Managed OAuthで取得したcompleteな本番Capsule
- scheme、host、port、base pathを含むCLIProxy transport hashの完全一致
- 20回すべてHTTP成功
- runごとに異なるsuffix
- 同じcache keyとCore hash
- 後続cache hit率80%以上
- 全requestのinput、cached、output、total tokenとlatency counter

本文、モデル出力、Worker URL、OAuth token、proxy key、生ETag、生JSONLは保存して
いない。
