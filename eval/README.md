# Model-assignment evaluation

This retained tracer compares fixed workflow-role model assignments with frozen, privately graded fixtures.

## Fixtures

| Fixture | Role | Task | Private checks |
|---|---|---|---|
| `reviewer-missing-validation` | Reviewer | Find a missing email-validation defect | Expected finding and false positives |
| `test-writer-cache-boundary` | Test Writer | Add tests for TTL equality and future timestamps | Red on original, green on correct code, two mutants killed, production unchanged |
| `implementer-atomic-reservation` | Implementer | Implement atomic inventory reservation | Visible and hidden tests, aggregate duplicate-SKU demand, workspace contract |
| `reviewer-tenant-cache` | Reviewer | Review tenant isolation and expiration boundaries | Both seeded defects and zero unsupported findings |
| `reviewer-async-authorization` | Reviewer | Review request scope and concurrent authorization | Both independent authorization defects and zero unsupported findings |
| `reviewer-transfer-atomicity` | Reviewer | Review transfer atomicity and idempotency | Both storage defects and zero unsupported findings |
| `reviewer-api-compatibility` | Reviewer | Review request and response compatibility | Both public-contract defects and zero unsupported findings |
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

## Repeated benchmarks

The original decision set ran every model ten times on one fixture per role. Its Reporter result has been applied: Reporter now uses Sol. See `docs/reports/2026-08-24-model-assignment-benchmark.md`.

A later hardened Reviewer decision set ran ten fresh samples per model across four Reviewer fixtures. Sol passed 36/40, Luna 27/40, and Terra 14/40, so the runtime Reviewer assignment remains Sol. See `docs/reports/2026-08-24-reviewer-hardened-benchmark.md`. The original evidence remains retained separately.

## Test

```bash
node --test eval/*.test.mjs
```
