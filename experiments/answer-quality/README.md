# Japanese answer generation: small fixed test

Send the two synthetic documents in `cases.json` to `/chat` sequentially without changing model configuration. Run only in an environment where the owner has authorized live requests. Set `SB_AUTH_TOKEN` through an existing secure credential-retrieval mechanism; do not put the token in command text.

```sh
python3 experiments/answer-quality/run.py --endpoint https://YOUR_WORKER --output /tmp/answer-quality-new.jsonl
```

Defaults are three repetitions per case, five seconds between requests, and no retries. Existing output is not overwritten. Mechanical checks cover HTTP/SSE completion, nonempty output, citation numbers and required source quotations, and unexpected characters outside Japanese/Latin scripts. Not every document must be cited. Character checks are specific to this fixture, not general multilingual answers.

`machine_pass` is not a quality verdict. Compare every answer with `review_required` and manually check for confusion between incomplete and undecided states or unsupported assertions. A few successful samples do not guarantee ongoing quality, performance, or operation within free allowances. This test is independent of Issue #54's comparison source, fixtures, and performance gates.

Also warn when a Gregorian year absent from source material is supplied. This detects only differences in year occurrences, not all semantic errors involving conditions, negation, or dates. Run detector regressions with:

```sh
python3 -B -m unittest discover -s experiments/answer-quality -p 'test_*.py'
```

The 2026-09-08 production measurement showed HTTP 200, completed SSE, Japanese output, and valid required citations in 6/6 samples. Manual review found an unsupported “2025” in 1/6. **Generation quality was not accepted.** A year-invention warning was added to the detector. Original measurements were preserved rather than replaced by reruns; neither prompt nor model changed. Do not interpret 1/6 in a small test as a stable error rate.

Original measurements are in `results/20260908.jsonl`; retrospective checks and human review are in `results/20260908-review.json`. Production source was `da945308d0aa090827081b482426f30fa46e1176`, Worker version `bededc76-c34d-4fa5-8475-e139af17cd66`, and the answer path was then CLIProxy Luna. Original `machine_pass` values predate the year-invention check and must be read alongside human review. These are historical results, not the current direct-connection deployment.

## Completion-check review

Read SSE by event. Completion requires `finish_reason=stop` followed by a complete, separate `data: [DONE]` event. DONE inside content, length/content_filter termination, malformed JSON, additional data after termination, and an unfinished final event fail. Responses are limited to 2 MiB. Do not follow redirects, to avoid forwarding authentication headers; reject credentials, queries, or fragments in endpoint URLs.

Year evidence comes only from source documents, not the question. Normalize full-width digits too. These changes reduce false passes in the test; they do not fix model generation quality.

The two production synthetic cases after tightening checks are in `results/20260908-strict-stream.jsonl`. Both passed HTTP 200, stop → DONE, language, citation, and year checks. Human review found the postponement case weakened “until validation passes” to “until validation finishes.” Mechanical checks do not guarantee the semantics of conditions. These results do not resolve the failures in the older six samples.
