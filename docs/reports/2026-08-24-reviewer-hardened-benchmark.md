# Hardened Reviewer model benchmark

## Outcome

Retain `openai-codex/gpt-5.6-sol` for the Reviewer role. Sol passed 36/40 blind runs across four fixtures, ahead of Luna at 27/40 and Terra at 14/40. The existing runtime assignment therefore remains unchanged.

This result supersedes the original single-fixture Reviewer recommendation for assignment decisions; it does not overwrite the original evidence in `2026-08-24-model-assignment-benchmark.md`.

## Evaluation design

The hardened decision set covers four distinct review risks:

- tenant cache isolation and expiration boundaries;
- authorization across asynchronous and concurrent changes;
- transfer atomicity and idempotency;
- public API request and response compatibility.

Each prompt contains realistic safe behavior as a distractor and does not disclose the defect count. Reviewer invocations have no tools, extensions, skills, prompt templates, context files, or persistent sessions. The scorer requires strict JSON with a closed finding schema, exact code evidence and location, substantive cause and impact in their dedicated fields, complete one-to-one defect coverage, and no extra findings. It also rejects contradictions and allegations against the fixtures' named safe distractors.

Each of Luna, Terra, and Sol received ten fresh runs per fixture: 120 runs total. All runs completed successfully and were scorable. Quality ranks first; mean cost and median latency are tie-breakers only.

## Results

| Model | Passing runs | Finding coverage | Unsupported findings | 95% Wilson interval | Mean cost/run | Median latency | p90 latency |
|---|---:|---:|---:|---:|---:|---:|---:|
| Sol | 36/40 (90.0%) | 77/80 | 4 | 76.9–96.0% | $0.021748 | 17.55 s | 27.21 s |
| Luna | 27/40 (67.5%) | 65/80 | 6 | 52.0–79.9% | $0.000786 | 13.45 s | 18.64 s |
| Terra | 14/40 (35.0%) | 53/80 | 28 | 22.1–50.5% | $0.005739 | 10.05 s | 15.26 s |

### Passes by fixture

| Fixture | Luna | Terra | Sol |
|---|---:|---:|---:|
| Tenant cache | 10/10 | 8/10 | 10/10 |
| Async authorization | 2/10 | 3/10 | 9/10 |
| Transfer atomicity | 6/10 | 0/10 | 7/10 |
| API compatibility | 9/10 | 3/10 | 10/10 |

Sol's advantage came from the harder authorization and compatibility tasks. Transfer atomicity remained difficult for every model, often because a response combined two independently gradable defects or omitted exact code evidence. Luna was much cheaper and somewhat faster, but quality was not tied. Terra was fastest but had the lowest pass rate and the most unsupported findings.

## Grader validation and rescore

Independent review found and fixed false-pass paths involving acceptance parroting, undeclared top-level and finding fields, contradictory file or line locations, cause/impact semantics supplied only through `explanation`, bundled allegations against known safe distractors, negated defect claims, and contradictory claims. Regression tests cover each case.

After blind generation, manual inspection also found equivalent accurate language that the private keyword grader rejected. Red regressions were added for strict-after expiration language and request-context evidence at its capture line. The scorer retains exact one-to-one grading: combined findings cannot satisfy two defects, and extra decomposed findings count as extras. Only private oracle and scoring behavior changed; prompts and raw model responses did not. The original 120 records were rescored after each grader correction. The manifest records separate generation and final-scoring source hashes.

## Verification

```text
node --test eval/*.test.mjs
20 passed, 0 failed
```

The broader sanitized repository gate passed 103/107 tests. Its four failures are the known baseline failures caused by absent sibling files under `/Users/mark/Projects/subagents/`.

## Review

Approved after post-cap recovery review. The final review verified the tenant-polarity regression, score totals, manifest claims, isolation, and the 20/20 eval gate; it reported no unresolved issues.

## Evidence

- Manifest: `eval/results/reviewer-hardened-benchmark-manifest.json`
- Retained score records: `eval/results/reviewer-*-hardened-final-10-score.json`
- Ignored raw records: `eval/results/reviewer-*-hardened-final-10.jsonl`

Raw JSONL remains ignored because it contains model responses. SHA-256 hashes in the manifest bind the local raw and scored decision set without publishing those responses.

## Limits

The runs repeat four fixed tasks and are not 40 independent samples of all Reviewer work. Confidence intervals describe run-level uncertainty for this fixture set, not a universal model ranking. The benchmark supports retaining Sol for the current Reviewer workload; future materially different review tasks should be evaluated separately.
