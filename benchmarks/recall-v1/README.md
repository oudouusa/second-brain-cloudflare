# Recall benchmark v1

実データを含まない固定corpusで、旧BGE 384 baselineとEmbeddingGemma MRL 128を同一条件で比較する。

- query: 60件（日本語30、日英混在15、識別子15）
- must-pass: 20件
- 指標: Recall@1、Recall@5、MRR、must-pass Top 5通過数
- 結果: queryごとのrankとTop 5（scoreを含む）
- 閾値corpus: exact duplicate、near duplicate、related、unrelatedを各10組

## 実行

corpus自体の検証にはCloudflare接続を使わない。

```bash
npm run benchmark:validate
```

実測時は別terminalで、専用account profileを明示してローカルbenchmark Workerを起動する。これはWorker、D1、KV、Vectorizeを作成せず、Workers AI bindingだけを利用する。

```bash
npx wrangler dev --config benchmarks/recall-v1/ai-dev.jsonc --profile second-brain-cf --port 8791
```

旧baselineを測定する。

```bash
npm run benchmark:bge
```

EmbeddingGemma実装後の比較を測定する。

```bash
npm run benchmark:gemma
```

Gemmaのdocument同士のscore分布からduplicate、graph、insight閾値を検証する。

```bash
npm run benchmark:thresholds
```

hosted modelの入力長を日本語、英語、コードで確認する。

```bash
npm run benchmark:input-limits
```

`evaluate.mjs` はモデルの生出力次元、有限値、非ゼロnormを検査する。EmbeddingGemma profileだけは公式model cardに従い先頭128次元へtruncateした後にL2再正規化し、queryとdocumentへ別promptを適用する。

corpusの`title`は評価用labelであり、現行production entryにはtitle列がないため、Gemmaのdocument入力はproductionと同じ`title: none`に固定する。実測値と採用閾値は`docs/fork/SEARCH_QUALITY.md`に記録する。
