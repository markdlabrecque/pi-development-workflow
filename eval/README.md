# Model-assignment evaluation

This retained tracer compares fixed workflow-role model assignments with frozen, privately graded fixtures.

## Fixtures

| Fixture | Role | Task | Private checks |
|---|---|---|---|
| `reviewer-missing-validation` | Reviewer | Find a missing email-validation defect | Expected finding and false positives |
| `test-writer-cache-boundary` | Test Writer | Add tests for TTL equality and future timestamps | Red on original, green on correct code, two mutants killed, production unchanged |
| `implementer-atomic-reservation` | Implementer | Implement atomic inventory reservation | Visible and hidden tests, aggregate duplicate-SKU demand, workspace contract |
| `reviewer-tenant-cache` | Reviewer | Review tenant isolation and expiration boundaries | Both seeded defects and zero unsupported findings |
| `reporter-audit-fidelity` | Reporter | Produce an auditable completion report | Fixed sections, required facts, and contradiction checks |

The scoring oracle and hidden tests are not included in model prompts or result records.

## Run

Preview an invocation:

```bash
node eval/model-assignment-eval.mjs run \
  --fixture reviewer-tenant-cache \
  --models openai-codex/gpt-5.6-luna \
  --output eval/results/dry-run.jsonl \
  --dry-run
```

Run and score a fixture:

```bash
node eval/model-assignment-eval.mjs run \
  --fixture reviewer-tenant-cache \
  --models openai-codex/gpt-5.6-luna,openai-codex/gpt-5.6-terra,openai-codex/gpt-5.6-sol \
  --output eval/results/reviewer-tenant-cache.jsonl

node eval/model-assignment-eval.mjs score \
  --input eval/results/reviewer-tenant-cache.jsonl
```

Runs are sequential. Every run disables extensions, skills, prompt templates, context files, and session persistence. Reviewer and Reporter fixtures also disable tools. Coding fixtures enable only the declared coding tools inside a temporary workspace.

Coding live runs currently require macOS `sandbox-exec` and fail closed on other platforms or when that backend is unavailable. The sandbox denies reads from this evaluator repository and denies writes outside the temporary workspace, except for Pi's `auth.json`, `settings.json`, and their lock paths. Prompt-only Reviewer and Reporter runs do not receive filesystem tools. `sandboxActive` is persisted in each result record.

`MODEL_TIMEOUT_MS` configures the model timeout; the default is 180000 ms. Timeout handling escalates from `SIGTERM` to `SIGKILL`. Timed-out, signaled, and nonzero-exit runs are persisted but rejected by both `run` and `score`. Artifact paths and content are validated before private grading.

## Frozen expansion sample

One post-fix run per model and fixture produced these results:

| Role fixture | Luna | Terra | Sol |
|---|---:|---:|---:|
| Test Writer | pass, 26.1 s, $0.00032 | pass, 21.8 s, $0.00670 | pass, 31.3 s, $0.02203 |
| Implementer | pass, 39.0 s, $0.00032 | pass, 52.0 s, $0.00595 | pass, 44.6 s, $0.01585 |
| Reviewer | pass, 16.9 s, $0.00094 | pass, 14.6 s, $0.00772 | pass, 18.8 s, $0.01928 |
| Reporter | pass, 10.5 s, $0.00049 | pass, 10.7 s, $0.00448 | pass, 10.6 s, $0.01072 |

These runs validate harder role-specific tasks and the harness, not a model ranking. Each cell is one sample, every model passed, and two scorer parsing corrections were made after inspecting otherwise compliant Reviewer and Reporter output. Comparative decisions require more frozen fixtures, clean controls, and repeated runs.

## Test

```bash
node --test eval/*.test.mjs
```
