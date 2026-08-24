# Model-assignment eval tracer

This tracer runs one frozen Reviewer bundle against one or more models. The bundle contains a planted missing-email-validation defect. Its private oracle never enters the model prompt or result record.

## Run

Preview the isolated Pi invocation without calling a model:

```bash
node eval/model-assignment-eval.mjs run \
  --fixture reviewer-missing-validation \
  --models openai-codex/gpt-5.6-luna \
  --output eval/results/dry-run.jsonl \
  --dry-run
```

Run all three supported models, then score their findings:

```bash
node eval/model-assignment-eval.mjs run \
  --fixture reviewer-missing-validation \
  --models openai-codex/gpt-5.6-luna,openai-codex/gpt-5.6-terra,openai-codex/gpt-5.6-sol \
  --output eval/results/reviewer-missing-validation.jsonl

node eval/model-assignment-eval.mjs score \
  --input eval/results/reviewer-missing-validation.jsonl
```

The runner disables tools, extensions, skills, prompt templates, context files, and session persistence. Runs are sequential. A nonzero Pi exit makes both `run` and `score` fail.

## First tracer result

One run per model found the planted defect:

| Model | Oracle match | False positives | Time | Reported cost |
|---|---:|---:|---:|---:|
| Luna | yes | 0 | 8.8 s | $0.00041 |
| Terra | yes | 0 | 13.0 s | $0.00632 |
| Sol | yes | 0 | 20.8 s | $0.02005 |

This validates the isolated runner, result capture, and structured scorer. It says nothing reliable about the best Reviewer assignment yet. The sample has one fixture and one run per model, and every model passed. The next useful slice is a small set of Reviewer fixtures with seeded defects and clean controls so recall and false-positive rates can differ.

## Test

```bash
node --test eval/model-assignment-eval.test.mjs
```
