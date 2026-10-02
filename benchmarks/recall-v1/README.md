# Recall benchmark v1

Compare the legacy BGE 384 baseline and EmbeddingGemma MRL 128 under identical conditions using a fixed corpus with no real data.

- Queries: 60 (30 Japanese, 15 mixed Japanese/English, 15 identifiers).
- Must-pass cases: 20.
- Metrics: Recall@1, Recall@5, MRR, and must-pass Top-5 count.
- Results: per-query rank and Top 5, including scores.
- Threshold corpus: ten pairs each of exact duplicates, near duplicates, related, and unrelated documents.

## Running

Corpus validation does not access Cloudflare:

```bash
npm run benchmark:validate
```

For measurements, start the local benchmark Worker in another terminal with an explicit dedicated account profile. It uses only a Workers AI binding and does not create a Worker, D1, KV, or Vectorize resource.

```bash
npx --yes wrangler@4.146.0 dev --config benchmarks/recall-v1/ai-dev.jsonc --profile second-brain-cf --port 8791
```

Measure the old baseline:

```bash
npm run benchmark:bge
```

Measure the EmbeddingGemma implementation for comparison:

```bash
npm run benchmark:gemma
```

Check duplicate, graph, and insight thresholds against Gemma document-pair score distributions:

```bash
npm run benchmark:thresholds
```

Check hosted-model input lengths for Japanese, English, and code:

```bash
npm run benchmark:input-limits
```

`evaluate.mjs` checks raw output dimensions, finite values, and nonzero norms. Only the EmbeddingGemma profile truncates to the first 128 dimensions and L2-renormalizes according to its model card, with separate query/document prompts.

Corpus `title` is an evaluation label. Production entries have no title column, so Gemma document input uses fixed `title: none`, matching production. Measurements and adopted thresholds are recorded in `docs/fork/SEARCH_QUALITY.md`.
