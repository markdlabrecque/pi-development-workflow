# Model Assignment Evaluation Tracer

## Outcome

Expanded the retained Reviewer tracer into role-specific evaluation fixtures for Test Writer, Implementer, Reviewer, and Reporter. The harness now exercises realistic boundary testing, atomic implementation, defect review, and audit-fidelity reporting without exposing private graders to the model.

No model-assignment change is justified yet. This sample has one run per model per fixture, and every model passed.

## Changed files

- `eval/model-assignment-eval.mjs`
- `eval/model-assignment-eval.test.mjs`
- `eval/model-assignment-fixtures.mjs`
- `eval/model-assignment-hard-scoring.test.mjs`
- `eval/model-assignment-roles.test.mjs`
- `eval/README.md`
- `eval/results/.gitignore`

## Behavior

- Added frozen role fixtures:
  - `test-writer-cache-boundary`
  - `implementer-atomic-reservation`
  - `reviewer-tenant-cache`
  - `reporter-audit-fidelity`
- Coding fixtures run in temporary workspaces and capture resulting artifacts.
- Test Writer grading runs the complete submitted test suite against original, correct, and mutant implementations while requiring production files to remain unchanged.
- Implementer grading combines visible tests, private aggregate-demand checks, and workspace-contract enforcement.
- Reviewer grading requires every seeded finding and counts unsupported findings across classifications.
- Reporter grading requires fixed Markdown sections, section-local facts, and no contradictory success or omission claims.
- Artifact paths are normalized and reject traversal, aliases, duplicates, and non-string content before materialization.
- Runs persist timeout, signal, exit, usage, elapsed-time, artifact, and sandbox evidence. Failed records are unscorable.
- Coding live runs fail closed unless the macOS `sandbox-exec` backend is available. The sandbox denies evaluator-repository reads and writes outside the workspace except Pi auth/settings files and their lock paths.
- Model and grading timeouts escalate from `SIGTERM` to `SIGKILL`.

## Live evidence

| Fixture | Model | Result | Time | Cost |
|---|---|---:|---:|---:|
| Test Writer | Luna | pass | 26106 ms | $0.0003172 |
| Test Writer | Terra | pass | 21812 ms | $0.006702 |
| Test Writer | Sol | pass | 31345 ms | $0.02203 |
| Implementer | Luna | pass | 38968 ms | $0.0003246 |
| Implementer | Terra | pass | 52044 ms | $0.005948 |
| Implementer | Sol | pass | 44600 ms | $0.015848 |
| Reviewer | Luna | pass | 16884 ms | $0.0009414 |
| Reviewer | Terra | pass | 14612 ms | $0.007722 |
| Reviewer | Sol | pass | 18753 ms | $0.019275 |
| Reporter | Luna | pass | 10498 ms | $0.000491 |
| Reporter | Terra | pass | 10691 ms | $0.004478 |
| Reporter | Sol | pass | 10583 ms | $0.010715 |

This is harness evidence, not comparative model evidence. After these outputs were captured, two parser corrections accepted objectively compliant output: the Reviewer parser selected Terra's final complete findings object, and Reporter section checks stopped requiring heading words to be repeated in each section body. No fixture oracle was changed, but the sample was inspected during scorer repair and must not be treated as blind evaluation.

## Verification

- `node --test eval/*.test.mjs` — passed, 11/11.
- macOS sandbox smoke — passed: workspace write allowed, evaluator-repository read denied, outside-workspace write denied.
- Each frozen JSONL result rescored successfully after the final narrow fixes.
- `env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_ID -u PI_WORKFLOW_ID -u PI_WORKFLOW_ROLE node --test *.test.mjs eval/*.test.mjs` — 91 passed, 4 failed. The four failures are the known missing sibling `/Users/mark/Projects/subagents/child-guard.ts` and `/Users/mark/Projects/subagents/index.ts` infrastructure; all eval tests passed.

## Review

Round 1 identified incomplete Test Writer discovery, weak Implementer aggregate checks, permissive Reviewer and Reporter scoring, timeout gaps, unsafe artifact handling, and insufficient coding isolation. Those findings were fixed with regression coverage.

Round 2 reached the review cap with additional must-fix findings: non-blocking Reviewer false positives were ignored, Reporter posting-success contradictions could pass, canonical artifact aliases could overwrite, timeout termination was not bounded, and a test platform override could bypass sandboxing. The foreground applied narrow post-cap fixes and reran the targeted suite. This is not independent review approval.

## Accepted deviation

Delegated attempts encountered file-ownership locks, so the foreground applied several red/green and review fixes directly. The post-cap corrections have targeted coverage but no third independent review. The unavailable sibling infrastructure also prevents a fully green repository gate in this checkout.

## Follow-up

The repeated benchmark is recorded in `docs/reports/2026-08-24-model-assignment-benchmark.md`. Add more frozen tasks and clean controls per role before treating its recommendations as broad model rankings.
