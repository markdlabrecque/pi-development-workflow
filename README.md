# Development Workflow extension

Persistent Pi-native workflow orchestration with a **constitutional core** and a **contextual shell**. The extension/harness deterministically enforces production safety, trust and remote authorization, child/role/file/state integrity, Reviewer read-only behavior, truthful artifacts, and current full-green release evidence. The foreground Orchestrator chooses contextual sequencing, mode, and risk, and records structured audited deviations; prompts never grant authority.

## Modes, outcomes, and defaults

Workflows select `new`, `adopt_existing`, or `recovery`. State records satisfied and missing outcomes and computes admissible next actions; stage is a resumable compatibility projection, not authority. `new` normally follows red test, implementation, independent review, and reporting. `adopt_existing` uses individually foreground-accepted branch, commits, dirty-tree, approved-plan, tests/prior evidence, implementation, review, report, and optional issue-ownership provenance, then dispatches only missing outcomes. `recovery` lazily resumes durable legacy evidence.

TDD, independent review, and retained tracer bullets are defaults for new work, not authority-granting universal choreography. Only trivial work may depart with an explicit foreground decision. Every outcome-default departure is a structured audited deviation with closed code, reason, decision, risk, actor, timestamp, and evidence; hard invariants have no override.

## Start and repository preflight

Create and approve a plan inside the repository, then start with explicit acceptance criteria:

```json
{
  "action": "start",
  "goal": "Add ...",
  "planPath": "docs/approved-plan.md",
  "acceptanceCriteria": ["Observable done condition"],
  "baseBranch": "main",
  "acknowledgeDirtyPaths": ["unrelated-dirty.txt"],
  "taskOwnedDirtyPaths": ["stale-task-file.txt"]
}
```

Startup runs a clean-start preflight against an explicit `targetRepository` and `targetWorktree` when supplied. Git membership validation canonicalizes the selected worktree and records branch, target root, base branch, and dirty paths before child mutation. Unacknowledged unrelated dirt gets one recoverable acknowledgement/checkpoint-or-clean error; acknowledged unrelated dirt remains protected. Explicit `taskOwnedDirtyPaths` must name currently dirty relative paths, cannot overlap acknowledged unrelated dirt, and are rejected before creation until checkpointed/cleaned and released, rather than silently adopted. `siblingOwnedFiles` remains parallel batch ownership metadata only. The approved plan is resolved against that same target worktree root. Project `AGENTS.md`/`CLAUDE.md` branch and test conventions override the global feature-branch default.

`planPath` must be a readable regular file inside the repository. Its canonical path, content, byte count, and SHA-256 digest are ingested once. New workflows start in `red_testing` and dispatch `test-writer` first.

## Enforceable handoff evidence

The role prompts are not the only guard. State transitions enforce:

- **Test Writer:** records test files plus `targeted_red` command/output and a non-empty expected behavioral failure reason. The run must fail. Missing, malformed, or contradictory evidence blocks `red_testing -> implementing`.
- **Implementer:** records implementation files/summary plus a passing `full_green` command/output. The latest full-suite evidence must be green before `implementing|fixing -> reviewing`. A disputed test stops and escalates to the Orchestrator; Implementer must not weaken it.
- **Reviewer:** read-only. `routeReview` requires a named suspected weakness and an independently passing full-project gate first. Non-approved findings require verification detail.
- **Reporter:** returns non-empty exact `reporterContent`. New workflows cannot complete until it is persisted.

Fresh physical attempts receive one compact artifact bundle, not conversation history: approved-plan reference, acceptance criteria, relevant red/green evidence, implementation diff, review findings, deviations, unresolved risks, and follow-ups. Logical role authority and claims are stable; infrastructure attempts are replaceable without changing authority. The workflow dispatch cap rejects oversized handoffs; do not duplicate full plans, repeat broad rediscovery, or whole-file rereads.

## Atomic review routing and recoverable cap

`routeReview` atomically records independent gate evidence, findings, evidence IDs, and an idempotency key. Exact retries are no-ops; conflicting reuse is rejected. Two review rounds are the default cap, not an automatic dead-end: it persists a recoverable escalation in reviewing with foreground choices `narrow_fix`, `convert_noncritical_follow_up`, `additional_review_round`, `request_user_risk_acceptance`, `rescope`, or `abort`. Critical findings never become approved or follow-ups. `follow_up` findings remain durable for Reporter.

## Models

Role routing follows the Claude-role analogues and is provider-qualified:

| Role | Model |
|---|---|
| Foreground Orchestrator / legacy Planner | `openai-codex/gpt-5.6-sol` |
| Test Writer | `openai-codex/gpt-5.6-terra` |
| Implementer | `openai-codex/gpt-5.6-terra` |
| Reviewer | `openai-codex/gpt-5.6-sol` |
| Reporter | `openai-codex/gpt-5.6-terra` |

Each model is resolved and authenticated at dispatch with an actionable error. Defaults are Test Writer **low**, Reporter **low**, Implementer **medium**, and Reviewer **medium** thinking; valid explicit overrides remain valid. Only this supported GPT-5.6 pair may be used as an explicit override. A supported override wins and is persisted so resume and review rounds do not drift.

## Parallel worktrees

Parallel execution is allowed only when explicitly requested. The foreground Orchestrator directly coordinates each issue pipeline in its own worktree; no worktree is delegated to a sub-orchestrator.

A parallel start sets `parallelExplicitlyRequested: true` and may record `batchId`, `siblingOwnedFiles`, and `sharedContracts`. Batch metadata without explicit permission is rejected. Assign file ownership and shared contracts, land shared infrastructure before fan-out, bound concurrency by hot-file contention, prefer additive interfaces, and rebase/update every worktree onto the latest base before rerunning full gates on the merged state.

Subagent mutation ownership remains `(workflowId, agentId)` with canonical roots, cross-process locks, pre-existing dirty-file protection, shell auditing, and restoration of unauthorized writes. Separate worktree roots therefore remain isolated while a resumed original Implementer retains its claims.

## Reporter and system of record

Reporter content includes the spec/built behavior, files, red and green commands/results, review verdict, every follow-up, every skip/failure, accepted deviations (code, reason, decision, risk, evidence), and every unresolved risk. It must not soften deferred or failed work.

Trusted `.pi/development-workflow.json` may configure GitHub, GitLab, or Bitbucket. Detection alone never grants remote write permission. Without a configured system of record, the trusted extension writes the exact final post to:

```text
docs/reports/YYYY-MM-DD-<workflow-id>.md
```

Before final reporting, the extension may maintain an operational workplan under `.pi/workplans/`. A posting failure preserves technical state, `reporterResult`, and recovery information.

## Evidence-sensitive starts

An approved plan and copied acceptance criteria are always required. If an acceptance criterion invokes mechanical coupling, executable/live/generated evidence, or architecture-sensitive proof, start also requires explicit `executableEvidence` and `architectureContract` before implementation. Both are persisted in workflow state and included in the compact role-dispatch artifact. Ordinary workflows remain simple and need neither field.

## Activation and operations

Workflow orchestration is off by default. An idle foreground request containing `dev workflow`, `development workflow`, or `sdlc` activates it for one run. `/workflow-enable` and `/workflow-disable` control process-local manual mode.

`development_workflow` actions:

- `start`, `status`, `advance`, `record`, `override`
- `routeReview`, `resolveEscalation`, `replaceAttempt`, `report`
- `complete`, `block`, `abort`, `close`

Commands:

```text
/workflow-enable
/workflow-disable
/workflow-status [workflow-id]
/workflow-diagnostics [workflow-id]
/workflow-abort [workflow-id]
```

Children are bound to raw `PI_WORKFLOW_ID` and `PI_WORKFLOW_ROLE`. Child prompts allow at most one `bash` call per assistant turn and require a compound command when shell steps belong together; read/grep/find may still be parallel. Test Writer and Implementer can record only their scoped artifacts and advance only their stage. Reviewer can inspect and route review only while reviewing. Reporter can inspect and return exact content only while reporting. Children cannot start, complete, block, abort, close, or access another workflow.

## Recovery and compatibility

State is stored under `~/.pi/agent/runtime/development-workflow/`. Versions 1–4 migrate lazily to schema version 5 without reinterpreting their active stage or old sequence. In particular, active legacy `planning`, `implementing`, or post-implementation `testing` workflows continue their recovery path; only newly created workflows use red-first stages.

Use workflow `status` and subagent `{ "action": "list", "workflowId": "..." }` to recover stable handles. Parent cancellation stops running children but leaves state resumable. Blocked, aborted, disputed-test, posting-failed, and review-escalated workflows retain state and diagnostics. `close` removes only a terminal workflow after coordinated subagent cleanup. Successful completion auto-closes after the foreground result is visible. Orphaned `.pi/workplans/` are recovery artifacts: inspect their workflow ID and durable state before deleting them.

Diagnostics are append-only, bounded, and redacted under `~/.pi/agent/runtime/development-workflow/diagnostics/`; successful cleanup compacts them to a summary and failed diagnostics retain the 24-hour policy.

## Global guardrails inherited by roles

Never access or write production servers. Use Chromium for automated browser work and Firefox conventions for manual instructions. If the daily-report post-commit hook or dependencies change, run the required real-commit end-to-end matrix. Use `uv sync --extra dev` when dev tools are an optional dependency extra. Default cross-project integrations to user scope. Keep user output shortest-correct and do not automatically continue after answering a question.

## Validation and rollback

```bash
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_ID -u PI_WORKFLOW_ID -u PI_WORKFLOW_ROLE \
  node --test ~/.pi/agent/extensions/development-workflow/*.test.mjs

When a full gate is launched from a workflow child, unset those identity variables **only for the spawned test process** so foreground harness tests are hermetic. Runtime child identity remains fail-closed; never weaken it.
pi --list-models -e ~/.pi/agent/extensions/subagent/index.ts
pi --list-models -e ~/.pi/agent/extensions/development-workflow/index.ts
```

The test matrix covers policy parity, migration, evidence gates, child authority, role models, review exhaustion, Reporter exact content, system-of-record safety, state locking, diagnostics, terminal compatibility, and cleanup. For rollback, stop new starts, finish/abort active v4 workflows, restore extension files, and `/reload`; never downgrade or hand-edit active state.
