# 検索品質と閾値調整

## 実測条件

- 実行日: 2026-08-26 JST
- Cloudflare account/profile: `second-brain-cf`
- corpus: synthetic 60 queries（日本語30、日英混在15、識別子15）、must-pass 20
- baseline: `@cf/baai/bge-small-en-v1.5` 384 dimensions
- candidate: `@cf/google/embeddinggemma-300m` の先頭128 dimensionsをtruncate後L2再正規化
- Gemma query prompt: `task: search result | query: ...`
- Gemma document prompt: `title: none | text: ...`

corpusの`title`は評価用labelであり、現行production entryにはtitle列がないためembeddingへ入れていない。Workers AI REST APIを専用accountで実行し、OAuth token、vector値、private memory本文は保存・出力していない。全queryのrank、Top 5とscoreは`benchmarks/recall-v1/results-*.json`へ保存した。

## Recall結果

| Profile / category | Recall@1 | Recall@5 | MRR |
|---|---:|---:|---:|
| BGE overall | 86.67% | 96.67% | 0.910758 |
| Gemma 128 overall | 100% | 100% | 1.000000 |
| BGE 日本語 | 73.33% | 93.33% | 0.821516 |
| Gemma 128 日本語 | 100% | 100% | 1.000000 |
| BGE mixed | 100% | 100% | 1.000000 |
| Gemma 128 mixed | 100% | 100% | 1.000000 |
| BGE identifier | 100% | 100% | 1.000000 |
| Gemma 128 identifier | 100% | 100% | 1.000000 |

Gemmaはmust-pass 20/20をTop 5へ入れた。日本語Recall@5は6.67 points改善し、mixedとidentifierは低下0 pointsで、M3の品質gateを満たした。Gemmaの正解Top 1 scoreは0.519723–0.853190で、0.60未満は3/60件だった。

## 閾値corpus

検索queryとは別に、document同士をexact duplicate、near duplicate、related-but-distinct、unrelatedの各10組、計40組へ固定した。結果は`benchmarks/recall-v1/thresholds-embeddinggemma-mrl128-v1.json`へ保存した。

| Class | min | median | max |
|---|---:|---:|---:|
| exact duplicate | 1.000000 | 1.000000 | 1.000000 |
| near duplicate | 0.826514 | 0.910752 | 0.959032 |
| related | 0.329240 | 0.453827 | 0.594439 |
| unrelated | 0.155909 | 0.228434 | 0.378484 |

## 採用値

| 用途 | 旧値 | 採用値 | 実測上の挙動 |
|---|---:|---:|---|
| duplicate block | 0.95 | 0.98 | exact 10/10をblock、nearを誤blockしない |
| duplicate flag | 0.85 | 0.80 | near 10/10をflag、related/unrelatedの誤flag 0/20 |
| recall widen | 0.85 | 0.60 | 全件widenを避け、weak tail 3/60だけを拡張 |
| graph auto-link | 0.78 | 0.42（具体topic tag一致）／0.70（不一致・tagなし） | 0.42はrelated 8/10、unrelated false positive 0/10の校正下限。production整合gateは後述 |
| insight candidate | 0.80 | 0.82 | evolving-thought相当のnear 10/10、broad related/unrelated 0/20 |

Insightは広い話題関連ではなく、30日以上離れた同一テーマの変化をLLM判定へ渡すpre-filterなので、near-duplicate帯をpositiveとして保守的に合わせた。丸めた採用値と実測JSONの対応はunit testで固定した。

## Production graph再検証（2026-08-28）

private本文を保存せず意味分類だけを集計した83-edge snapshotでは、明確に有用56、明確な誤接続22、弱い関連5だった。81件が自動推論、2件が明示edgeで、誤接続は主に意味の似た別project間で発生した。`0.70`以上の推論edge 31件は全件妥当だった一方、`0.6891`にも明確な誤接続があり、単純に閾値を上げるだけでは`0.42–0.69`にある同一projectの有用edgeも失う。

このためraw scoreだけでなく具体topic tagの共有をproject整合の証拠にする。AI instructionsがほぼ全entryへ付ける`personal`、`work`、`task`、`idea`、`context`、`claude-response`、`codex-response`は整合証拠に数えず、system lifecycle／pipeline tagも除外する。共有topicがあれば校正下限`0.42`、なければproduction clean bandの`0.70`を適用する。policyは`embeddinggemma-mrl128-v2`としてedge metadataへ記録し、夜間passが旧policy edgeを段階的に再計算できるようにした。

同日のproduction read-only SQL dry-runでは現行推論`relates_to` 96件の内訳が、`0.70`以上36件、`0.42–0.69`かつ具体topic共有29件、同bandでtopic共有なし31件、`0.42`未満0件だった。したがって初回nightly prune候補は31件、維持候補は65件である。SQL metadataは`changed_db=false`、`rows_written=0`で、本文・tag値・entry IDは端末へ出力していない。

2.5.0配備後はbounded nightly passを6回実行して段階移行を完了した。初回収束確認ではcurrent-policy inferred 61（shared-topic-tag 59、high-similarity 2）、legacy policy 0、explicit 6、dangling 0だった。2.5.1配備後の2026-08-28 17:38 JST確認では、通常の再計算後にentries 43、edges 64、current-policy inferred 58、legacy 0、explicit 6、dangling 0である。推論edge数はentry更新と夜間再計算で変動するが、旧policyへは戻らない。明示edgeは再計算・prune対象外のまま保持された。

## 読み取り時のgraph寄与

`recall`はhopsを明示したrequestについて、`seedCount`、`expandedCount`、`eligibleCount`、`selectedCount`を返す。`expanded`はedge traversalが動いた件数、`eligible`はquery evidence gateを通った件数、`selected`は最終結果へ残ったgraph由来memory件数である。Workers Logsにはこの件数だけを保存し、queryやIDは保存しない。

`connections`はedge typeをnode dedupe後に絞らず、source／target index scanの内側で絞る。同一pairの複数typeを保持し、directed edgeはstored source/targetと要求entryから見たdirectionを返す。cursor pagingは既定20、最大100、offset上限10,000で、無制限scanを許可しない。`DEFAULT_HOPS=0`はfalse positiveと余分なD1 readを避けるため維持し、why/how、因果、時系列ではclientが1–2へ上げる。

2.5.1では、graph rootとして選んだ上位候補同士のedgeも1-hop evidenceへ含める。従来はroot集合を最初からvisitedに入れたため、直接検索の6位以下が強いedgeで上位rootへ接続されていても、そのedgeを再順位付けへ使えなかった。最終direct枠とrelated枠はIDでdedupeし、保護した上位direct結果は置換しない。

日本語の「なぜ／理由／原因」「前／後／経緯／履歴」「現時点／現在／最新」もintent分類する。明示またはsystem由来の`caused_by`、`follows`、`supersedes`は、causal／chronology intent、stored direction、質問方向、1-hop、weight 0.5以上がすべて一致する場合だけ構造証拠として利用できる。inferred edgeはこの例外を使わず、従来どおり本文のrare-term precisionとevidence-gain gateを通す。

## Hosted入力長

日本語320/400/450/480/500/1000/1600文字、英語1600文字、コード1600文字をproductionと同じdocument promptで実行し、すべてHTTP 200・生768次元だった。共通prefixの後ろに異なるsuffixを置いた500/1000/1600文字の比較でも先頭128次元に差が出た。受理だけでなく後半差分がembeddingへ影響することを確認できたため、`CHUNK_MAX_CHARS=1600`を維持する。実測は`benchmarks/recall-v1/input-limits-embeddinggemma-mrl128-v1.json`に保存した。

## 再現

別terminalでREADME記載のAI binding Workerを`127.0.0.1:8791`へ起動し、次を実行する。

```bash
npm run benchmark:bge
npm run benchmark:gemma
npm run benchmark:thresholds
npm run benchmark:input-limits
```

corpusだけの検証は`npm run benchmark:validate`でCloudflare接続なしに実行できる。結果ファイルは生成日時だけが変動し、corpusとthreshold corpusのSHA-256を内包する。

## Tagged current-state retrieval (2026-09-13)

A focused fork improvement addresses status evidence lost during fusion. A
Japanese request such as “最新の採用状況” was classified as causal because
“採用” preceded the explicit current-state signal. “直近” was not recognized.
Current intent now takes precedence over a bare decision word; explicit reasons
and directed before/after questions retain their original precedence.

For a **tagged current-state query with strong dense evidence**, reuse the
existing lexical-arm normalization: scale the largest keyword RRF weight to one
while retaining the IDF ordering within that arm. Previously, rare generic words
could accumulate several votes and bury relevant status records. The existing
`RECALL_WIDEN_THRESHOLD` remains the gate. Other tagged intents, weak/degraded
retrieval and the existing untagged calibration condition remain unchanged.
There is no new model branch, dependency, ranking service, endpoint or setting.

### Evidence and limits

The diagnostic replay used a read-only production snapshot of 832 entries and
1,996 stored vectors, eight previously selected Japanese questions, and one
fixed batch of eight query embeddings from the unchanged Gemma model. The new
evaluation-summary memory and its incident edges were excluded before comparison
to prevent the assessment itself from supplying the answers. Production
`recallEntries` ran against the existing SQLite test facade with stored vectors
returned by `getByIds`, the same personal workspace, fixed clock, topK=5, hops=0,
and default MMR. No live memory write or candidate deployment was performed.
Raw content, IDs, embeddings and the private replay helper remain outside Git.
Only anonymous regression fixtures are committed.

| Previously missed question | Baseline | Candidate |
|---|---|---|
| Latest production rollout | No sufficient source in top five | Current journal at rank 2 contains the rollout/version and remaining validation limits |
| Adoption of a particular upstream PR | Old review/open-state records dominated | Current journal at rank 2 and integration journal at rank 4 contain the merged/adopted state |
| Six other questions | Existing results | Identical ordered result IDs |

This measures **answer-bearing source availability**, not an automatic correct
answer. The current journal is long and its newest facts require `get`; rank 1
is still not the correct answer to either failing question. The two originally
chosen standalone target IDs still miss the top five. Do not count alternate
journals as exact-target recovery, claim general Recall@5/precision, or interpret
“100% match” as confidence. These eight cases are selected, self-assessed,
already inspected during development, and have no held-out set. Untagged live
quality, generated-answer accuracy, Fable behavior, CPU and billing remain
unmeasured by this replay.

Normalizing every tagged query was rejected after it displaced an answer to a
historical question. Replacing direct lexical fusion with the full graph-root
term set was also rejected. The final change is restricted to explicit current
intent and reuses the existing fusion calculation.

The two changed cases retained one embedding call and 17 bounded Vectorize
`getByIds` calls each, with no Vectorize query. D1 statements changed from 10 to
11 because current intent activates the existing rollover-lineage read. Local
SQLite does not reproduce Cloudflare billed rows; no free-tier guarantee follows.

### Reproducible checks and primary implementation references

- Anonymous fusion regression: `test/integration/keyword-recall-quality.test.ts`
  covers strong current intent, ordinary/causal intent, and weak dense evidence.
  It disables MMR only in this fixture to isolate the fusion outcome.
- Intent and lineage regressions: `test/unit/recall-query-profile.test.ts` and
  `test/integration/recall-rollover-lineage.test.ts`.
- Implementation: [query profile](../../src/recall/query-profile.ts),
  [fusion and search](../../src/recall/search.ts),
  [RRF](../../src/recall/rrf.ts), and
  [fixed embedding profile](../../src/embedding/profile.ts).
- The snapshot uses Cloudflare's read-only
  [get-vectors API](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/get_by_ids/).
  Query embeddings use the documented
  [EmbeddingGemma model](https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/)
  with the existing query prefix, first-128 projection and L2 normalization.

This is fork evidence for a future upstream discussion, not a public submission
or a production release. Before proposing the normalization upstream, validate
its own embedding calibration rather than copying this fork's threshold.

### Follow-up: evidence visible in the preview

The next inspection separates ranking from what a client can actually read.
On the same frozen snapshot, the previous candidate already displayed the latest
production version, but its query-selected excerpt cut off the subsequent
qualification: real-memory quality and one model remained unverified. A source
being retrieved does not mean its important qualification reached the client.

The fork now shares a small `recallSnippet` selector between MCP and REST, while
keeping the upstream-owned `snippet.ts` byte-identical. For current intent with
no explicit or parsed time bounds, search passes full-query evidence excluding
corpus-saturated words using the existing DF calculation and saturation limit.
Numeric identifiers remain mandatory anchors even when absent from that corpus.
For an oversized append journal only, the selector may use upstream's existing
head-plus-latest-update preview when the **visible latest excerpt** matches at
least two evidence terms and every numeric identifier. Otherwise it retains the
ordinary query-relevant excerpt. The full source length, truncation marker,
`get` affordance, full-output behavior and existing character allowances remain.
`現状` and `今の` are also recognized as current intent. Reasons and directed
history retain precedence; `今後` does not become current intent.

MCP labels the normalized score as `relative score: 1.00` instead of `100% match`,
and prints the source update date when present. Neither source creation nor
update dates certify when a real-world event happened. REST's numeric score
contract is unchanged. The MCP tool description changes accordingly, so the
pinned `tools/list` digest is deliberately updated; tool schemas and registration
order are unchanged. Clients caching tool descriptions must refresh that catalog.

The same eight-case replay retained every ordered result ID and every observed
AI/Vectorize/D1/KV operation count from the preceding candidate. The production
preview now includes the previously omitted quality/model qualification. The
six non-current cases keep their prior excerpt selection. The original exact-ID
misses and incorrect rank-1 answers remain unresolved; this is a presentation
improvement, not a second ranking win. No further remote embeddings were needed.

Anonymous checks cover current wording and historical/future wording, explicit
date bounds, unrelated final updates, a different issue number (`#14` versus
`#149`), an identifier outside the visible excerpt, and preserved truncation and
source length. These are controlled regressions, not a held-out live quality
benchmark. Matching two words is still a lexical heuristic: same-topic but
different-subject updates and alternate identifier spellings can remain hard.
Do not treat the latest excerpt as a substitute for `get` when omitted context
could change the answer.

The initial trial required the latest preview to retain at least as many query
words as the ordinary preview. It kept an older passage that happened to contain
one extra generic word while hiding the new qualification. The accepted gate
uses bounded, non-saturated evidence in the visible update instead. Blindly
preferring the newest entry or globally changing RRF/MMR remains unjustified;
the snapshot shows that the missing standalone answers are already candidates,
and stored-vector similarity alone does not put them first. More freshness
weight would not establish that an entry actually records completion.

Primary implementation references are [upstream-compatible snippet selection](../../src/recall/snippet.ts),
[the shared preview selector](../../src/recall/render.ts),
[existing corpus DF distillation](../../src/recall/distill.ts), and
[the MCP contract](../../src/mcp/server.ts). The rationale and limitations above
are local observations and design judgments, not claims made by the external
Cloudflare documentation. Additional local string processing is not included in
the remote CPU/billing evidence; no production or free-tier certification is
implied by unchanged operation counts.


### Follow-up: preserve subjects within the rare-term budget

Distillation can discard the subject before lexical fusion: three rarer generic
words can displace an explicit issue number. The fork's CJK fallback also lets a
whole word and its substrings consume separate slots. These are term-selection
problems, independent of the embedding model or current-state intent.

The existing `distillToRareTerms` now removes a fallback bigram from selection
when an eligible whole query word contains it. If that whole word did not survive
the existing corpus filter, partial matching remains available. It then reserves
at most one of the existing three slots for the rarest eligible structured
identifier, using the tokenizer's existing provenance and punctuation/digits.
Acronyms alone do not qualify. Absent or corpus-saturated identifiers receive no
reserved slot, including the all-common fallback. Remaining slots retain DF
ordering and the result retains query order. This does not expand all query terms
into direct fusion, change the SQL scan, or add calls, settings or dependencies.
The upstream-owned tokenizer and snippet implementation remain unchanged.

The frozen eight-question replay against the preceding candidate retained all
five result IDs for every question. Seven kept their complete order; the team
policy question exchanged ranks 3 and 4. Observed AI, Vectorize, D1 statement and
KV operation counts were unchanged for all eight questions; local string work and
remote billed rows are not measured by those counts. The guidance query replaced the redundant
`キル` fragment of `スキル` with `個人`; the overdesign query gained `助言` instead
of a substring. These are improvements in term coverage, not new recovered
answers. In particular, the production question still distills to `直近 たい 残り`
and the two original standalone target misses remain unresolved.

Four anonymous SQLite retrieval cases exercise English/Japanese wording with and
without an explicit tag. Each has an issue's archive, unrelated background notes,
and two state records using the same generic wording but different issue numbers.
With embeddings deliberately unavailable, the preceding implementation discards
the queried issue number; the candidate preserves it and ranks the matching state
record first. Separate unit cases cover absent/common identifiers, multiple IDs,
acronyms, duplicate CJK fragments and partial-match fallback. These are controlled
regressions added during development, not independent or blind accuracy evidence.

A trial where the matching state record omitted a rare generic query word still
ranked the other issue first. Reserving an identifier is not a hard match filter
or a guarantee of correct ranking; this limitation remains. Alternate spellings
such as `PR #730` / `PR730`, repository identity for equal issue numbers, questions
without explicit identifiers, and inferred completion remain separate problems.
There is no new claim of live accuracy, latency, billed rows or free-tier safety.

Primary implementation references: the upstream
[rare-term selection](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/recall/distill.ts),
[its Unicode tokenizer](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/text/tokenize.ts),
the fork's [bounded selection](../../src/recall/distill.ts) and
[existing token provenance](../../src/text/lexical-query.ts).
The identifier reservation is a candidate for a small upstream proposal after
validation against upstream's own retrieval behavior; the bigram deduplication
addresses the fork's fallback layer and is not claimed as an upstream defect.

## Candidate admission, independent preview evidence, and synthesis context (2026-09-13)

A static review identified three remaining seams. They are addressed in the
fork-owned callers and lexical helper, without changing the upstream-owned
tokenizer/snippet, embedding profile, provider selection, or deployment bindings.

- **Direct candidate admission:** with `hops=0`, the ordinary keyword OR query
  now reuses `recallEligibilitySql(kind)` before its existing LIMIT. Previously,
  newer deprecated or wrong-kind rows could fill that window and hide an older
  usable result even though MMR correctly rejected the fetched ineligible rows.
  The OR alternatives remain grouped under the workspace and eligibility
  predicates. Tagged direct retrieval also applies eligibility and the existing
  `created_at` bounds before collecting vector IDs, without a new recency LIMIT.
  With graph traversal enabled, the existing candidate population remains:
  a readable event outside the answer's kind/time filters can still lead to an
  eligible answer. Final hydration and pre-MMR checks remain in both modes.
- **Independent current-preview terms:** reuse the distillation helper that
  removes a CJK bigram contained in an eligible whole word. Apply it after DF
  admission to the current-preview evidence, retaining the original token kind.
  `スキル`, `スキ`, and `キル` no longer satisfy the two-term preview threshold
  through one word. A bigram remains available when its whole word is absent
  from the admitted set. Ordinary fusion and graph scoring keep their evidence.
- **Synthesis context:** pass the original request query, including time phrases,
  to `synthesizeInsight`. The distilled query remains the lexical search input
  and reported `query_used`. REST's synthesis default and MCP's explicit
  `synthesize:false` are unchanged. This preserves the question; it does not
  establish generated-answer accuracy or guarantee fewer input tokens.

Focused regression fixtures use the existing SQLite facade and mocked AI and
Vectorize. They cover candidate-window occupancy, direct tag overfetch versus
graph roots, the full recall-to-preview path, and the actual synthesis prompt.
These are local regression evidence, not a held-out production quality study or
a measurement of CPU, billed D1 rows, daily usage, or full-tag scalability.

The existing upstream mechanisms remain the starting point: [keyword retrieval
and synthesis caller](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/recall/search.ts),
[query distillation](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/recall/distill.ts),
and [snippet selection](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/recall/snippet.ts).
