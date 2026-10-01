# Second Brain development-effect result — live v4

## Verdict

Second BrainのCore Capsuleだけでは、この固定タスク集合に対する有意な
改善は観測されなかった。Coreとタグ付きcurrent-state recallを併用した
Full armでは、Controlに対して小さいが正の効果が観測された。

この結果が支持するのは、履歴依存の開発判断を再現する際の文脈効果で
あり、開発速度全体の改善率ではない。

Canonical evidence:
[`2026-09-03-dev-effect-live-v4.json`](./2026-09-03-dev-effect-live-v4.json)

```text
schema:           second-brain-development-effect.v2
evidence SHA-256: 60122ecf8346303f9c6229a4488e2714ff340bef40674bd5762282a39c5809c7
model:            gpt-5.6-luna
trials:           48 / 48 successful
JSON-valid:       48 / 48
```

Capsule/recallはMCP Managed OAuth、推論はCLIProxyAPI/Codex OAuthを利用した。
公式OpenAI API keyとSecond Brainの静的Bearerは使用していない。

## Primary result

| Arm | Mean score | Exact pass | Unsafe-choice rate | Paired delta vs control |
| --- | ---: | ---: | ---: | ---: |
| Control | 0.8000 | 68.75% | 18.75% | — |
| Durable Core Capsule | 0.8083 | 62.50% | 25.00% | +0.0083 (95% interval -0.0407 to +0.0573) |
| Core + tagged current-state recall | 0.9771 | 87.50% | 12.50% | +0.1771 (95% interval +0.0009 to +0.3533) |

`full-context-effect-observed`の判定条件は満たしたが、区間下限はゼロに
非常に近い。16対応ペアだけの近似区間なので、強い一般化はできない。

## What produced the effect

FullとControlの差は、次の2タスクだけから生じた。

- Current production lineage: Control 0.0、Core 0.0、Full 1.0
- Deployment preflight: Control 0.5000、Core 0.6667、Full 0.9167

Access/OAuth境界、handler normalization、Capsule決定性、credential境界、
公開証拠privacyは全armで1.0だった。これらは問題文と選択肢から推論可能で、
この実験ではSecond Brain固有の効果を識別できなかった。

Cache-evidence classificationはControl 0.9、Core 0.8、Full 0.9だった。
文脈があっても`cache_write_tokens=0`を「観測済み」と誤分類する試行があり、
認定には引き続き決定的なmachine gateが必要である。

## Cost and latency

| Arm | Mean input tokens | Total cached tokens | Approx. cache ratio | Median latency | p90 latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control | 501.0 | 0 | 0% | 3,280 ms | 5,068 ms |
| Core | 2,088.0 | 3,584 | 10.7% | 3,233 ms | 3,879 ms |
| Full | 4,398.0 | 15,104 | 21.5% | 2,920 ms | 5,945 ms |

FullはControlの約8.8倍のinput tokenを使った。median model latencyは
約11%短かった一方、p90は約17%長かった。Provider cacheと小標本の影響が
あるため、latency改善とは認定しない。

Core取得は1,333 ms、タグ付きrecall取得は2,319 msだった。これはtrial前に
各1回だけ取得した値で、通常の対話で毎回recallする場合の遅延ではない。

## Review correction

初回v3では自由文を正規表現で採点していたため、否定文や却下した代替案でも
キーワード一致により加点される可能性があった。また、transport failureを
0点のmodel observationとして効果量へ混ぜる余地があった。

v4では次のように修正して再測定した。

- 全criterionを列挙選択式の構造化回答へ変更
- exact key setとallowed valueだけを受理
- unsafe choiceも構造化値から判定
- transport failureはarm scoreとpaired effectから除外
- 1件でもHTTP failureがあればeffect conclusionを`incomplete-run`へ固定
- schemaを`second-brain-development-effect.v2`へ更新

このためv3の大きな効果量はcanonical evidenceとして扱わず、v4を正本とする。

## Limits

- 8タスクは同じ完了済み開発履歴から作ったhistorical decision-recovery問題。
- 16対応ペア、1モデル、1 proxy path、2反復だけの小標本。
- 列挙選択式は否定表現の誤採点を防ぐ一方、実際の自由回答より問題を易しくする。
- Current lineageの1タスクが効果量の大部分を占める。
- Unsafe-choiceは選択肢上の判定であり、実際に危険操作を実行した件数ではない。
- 独立repositoryで実装・test・reviewを比較していないため、wall-clock速度、
  defect rate、clarification回数の改善は未検証。

次の強い検証は、記憶へ保存する前に未知の小規模issueを固定し、隔離した
Control/Full agentで実装させ、passing tests、review findings、unsafe actions、
clarification turns、elapsed timeを比較することである。
