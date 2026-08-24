# Model assignment benchmark

## Decision

Use these assignments under the current role fixtures:

| Role | Assignment | Current assignment | Action |
|---|---|---|---|
| Test Writer | Luna | Luna | keep |
| Implementer | Luna | Luna | keep |
| Reviewer | Luna | Sol | change |
| Reporter | Sol | Luna | change |

Planner has no fixture, so this benchmark says nothing about its assignment.

## Applied status

The Reporter recommendation is applied: both runtime routing and the Reporter agent profile use `openai-codex/gpt-5.6-sol`. Test Writer and Implementer remain on Luna. The original Reviewer recommendation was not applied; the later hardened Reviewer benchmark retained Sol after it won 36/40 blind runs across four fixtures.

## Method

The benchmark used ten fresh, isolated runs for every model and role fixture. A model had to satisfy every private check. Quality decided first. Mean cost broke quality ties, followed by median latency.

Exploratory batches exposed scorer false rejects. The Reviewer scorer required the literal word "boundary" even when a finding described the exact expiration condition. The Reporter contradiction check treated "not successfully posted" as a success claim. Independent review then found two opposite false-pass cases. Tests now reject claims that exact expiration behavior is correct and claims that the transport succeeded.

The affected exploratory Reviewer and Reporter samples were discarded after the semantic-matching fixes. A new blind batch then produced the final results. Round 2 review added only stricter rejection of opposite-conclusion phrases; all final outputs rescored unchanged. The final decision set contains 120 scorable runs:

- 4 role fixtures
- 3 models per fixture
- 10 fresh runs per model and fixture

## Results

| Role | Model | Pass | 95% Wilson lower bound | Median | p90 | Mean cost |
|---|---|---:|---:|---:|---:|---:|
| Test Writer | Luna | 10/10 | 72.2% | 25.5 s | 27.3 s | $0.000501 |
| Test Writer | Terra | 10/10 | 72.2% | 23.9 s | 25.4 s | $0.005149 |
| Test Writer | Sol | 10/10 | 72.2% | 32.3 s | 35.3 s | $0.013640 |
| Implementer | Luna | 10/10 | 72.2% | 38.9 s | 48.3 s | $0.000541 |
| Implementer | Terra | 10/10 | 72.2% | 32.3 s | 47.0 s | $0.004310 |
| Implementer | Sol | 10/10 | 72.2% | 54.2 s | 67.9 s | $0.017437 |
| Reviewer | Luna | 10/10 | 72.2% | 20.1 s | 23.5 s | $0.001152 |
| Reviewer | Terra | 10/10 | 72.2% | 16.4 s | 18.2 s | $0.008927 |
| Reviewer | Sol | 10/10 | 72.2% | 28.3 s | 29.2 s | $0.031725 |
| Reporter | Luna | 7/10 | 39.7% | 10.2 s | 11.1 s | $0.000470 |
| Reporter | Terra | 8/10 | 49.0% | 9.5 s | 11.6 s | $0.004476 |
| Reporter | Sol | 10/10 | 72.2% | 9.9 s | 10.6 s | $0.011351 |

Luna wins Test Writer, Implementer, and Reviewer. Every model passed those fixtures, while Luna cost 7.8 to 32.2 times less than the alternatives. Terra saved between 1.6 and 6.6 seconds at median latency but did not improve quality.

Sol wins Reporter. It preserved every required fact and caveat in all ten runs. Luna omitted or misplaced required posting evidence in three runs. Terra made equivalent fidelity mistakes in two runs. Sol costs about 24 times more than Luna for this short task, but the benchmark's quality-first rule makes that premium appropriate for audit records.

## Operational evidence

Two exploratory Terra Reviewer attempts exited with status 143. Replacement runs succeeded. The final decision set had no process failures, timeouts, or signals.

## Limits

Ten repetitions measure consistency on one frozen task per role. They do not measure the full range of work each role handles. The assignments are justified for these fixtures, not as universal model rankings.

The next evaluation should add task diversity rather than repeat these exact prompts again. Require a stronger model to beat the current assignment across several frozen fixtures before accepting its higher cost.

## Verification

- `node --test eval/*.test.mjs` passed, 11/11.
- The sanitized full gate passed 91/95. Its four failures are the known missing sibling `subagents` files; all eval tests passed.
- All 120 final records scored successfully.
- Raw benchmark JSONL remains under ignored `eval/results/` paths and does not expose private oracles.
- `eval/results/model-assignment-benchmark-manifest.json` retains record counts, source hashes, batch hashes, and aggregate results.
