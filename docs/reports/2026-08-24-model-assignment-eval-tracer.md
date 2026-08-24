# Model Assignment Evaluation Tracer

## Goal

Build a retained tracer bullet for evaluating fixed workflow-role model assignments. One passing fixture cannot rank models.

## Approved scope and implementation

Changed files:

- `eval/model-assignment-eval.mjs`
- `eval/model-assignment-eval.test.mjs`
- `eval/README.md`
- `eval/results/.gitignore`

The evaluator runs isolated Pi processes with no tools, extensions, skills, context, or session against the frozen reviewer-missing-validation fixture. It captures response, usage, timing, and status as JSONL; applies deterministic structured scoring; and rejects failed processes at both run and score stages.

## Live results

| Model | Match | False positives | Time | Cost |
|---|---:|---:|---:|---:|
| Luna | true | 0 | 8769 ms | $0.0004132 |
| Terra | true | 0 | 12986 ms | $0.006316 |
| Sol | true | 0 | 20751 ms | $0.02005 |

These results do not establish a model ranking: they cover only one fixture.

## Verification

- `node --test eval/model-assignment-eval.test.mjs` — passed, 3/3.
- `env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_ID -u PI_WORKFLOW_ID -u PI_WORKFLOW_ROLE node --test *.test.mjs eval/*.test.mjs` — failed: 83 passed, 4 failed. All failures are pre-existing missing `/Users/mark/Projects/subagents/child-guard.ts` or `index.ts` infrastructure. Tracer tests passed.
- Child-run gate evidence was sanitized by unsetting `PI_SUBAGENT_*` and `PI_WORKFLOW_*` only for the spawned test process.

## Review

Round 1 found format-biased scoring, incorrect false-positive accounting, acceptance of nonzero exits, and missing tests. These were fixed.

Round 2 confirmed the representation bias was fixed, but found that failed records were persisted and accepted by scoring. At the two-round cap, the foreground chose a narrow targeted post-cap fix: scoring now rejects explicit failed runs, and the regression is green.

This is not review approval. Residual risk remains because the post-cap fix has targeted tests but no third independent review, and the full gate cannot pass in this checkout because sibling infrastructure is absent.

## Accepted deviation

Subagent dirty-file ownership prevented replacement Test Writer/Implementer attempts from editing files. The foreground therefore performed the disputed-test correction and review fixes after proving the tests red. This reduces role independence; risk is mitigated by targeted red/green evidence and two review rounds.

## Follow-up

Add several seeded-defect and clean-control Reviewer fixtures with repeated runs before making any model-assignment decision.
