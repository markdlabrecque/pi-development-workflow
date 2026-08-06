# Contextual Policy v5 Report

**Destination:** `docs/reports/2026-07-30-contextual-policy-v5.md`  
**GitHub:** No GitHub ticket was created, updated, or commented on.

## Goal and approved scope

Implemented the ratified constitutional-core/contextual-shell state-v5 policy from `POLICY.md` and the 19-item Wayfinder workplan. The workflow now enforces durable required outcomes and hard safety boundaries while allowing foreground-controlled, persisted contextual sequencing.

## Completed behavior

- Added state-v5 modes: `new`, `adopt_existing`, and `recovery`, with lazy v1–v4 migration.
- Replaced rigid choreography authority with outcome-based admissible actions; `stage` remains compatibility/resume projection.
- Preserved default red-first behavior for new work; accepted adopted historical evidence avoids synthetic replay after explicit provenance acceptance.
- Added structured, closed-code outcome deviations and recoverable review-cap escalation choices.
- Kept stable logical roles while allowing foreground-recorded physical-attempt replacement after infrastructure failures.
- Added atomic/idempotent review routing and normalized diagnostic evidence.
- Supported canonical selected-worktree preflight and in-root plan resolution, protecting unrelated selected-worktree dirt.
- Updated policy/prompt/documentation parity and executable policy-boundary coverage.

## Files/categories changed

- `POLICY.md`: ratified classification, architecture, and executable-evidence contracts.
- Extension workflow/state/authorization implementation: v5 persistence, migration, outcome routing, escalation, attempts, diagnostics, worktree targeting, and reporting validation.
- Role prompts and compact handoff artifacts: responsibility/outcome-based guidance while retaining role authority.
- Test suites: state migration, policy boundaries, adopted/recovery flows, review idempotency/escalation, replacement diagnostics, reporting, worktree, authorization, and parity coverage.
- Documentation and user-level policy parity: extension README, `~/.pi/agent/AGENTS.md`, and corresponding Claude policy/alignment coverage.

## Preserved hard safeguards

Production safety; repository trust and remote-write approval; foreground and child identity authority; role mutation boundaries; Reviewer read-only behavior; file ownership/locking and unrelated-dirt protection; canonical target-repository integrity; parallel authorization; green-release evidence; test integrity; architecture evidence; state integrity/recovery; model authorization; activation scope; and truthful/recoverable reporting remain non-overridable.

## Verification evidence

| Command/evidence | Result |
|---|---|
| Initial state-v5 red test | `0/5` passing, expected initial red state. |
| Later contextual red suite | 5 expected behavioral failures. |
| Final combined extension/subagent gate | `100/100` passing. |
| `pi --list-models` smoke, first run | 9 lines returned. |
| `pi --list-models` smoke, second run | 9 lines returned. |
| Hard-invariant-overridable mutation | Caught by tests; restored. |
| Missing-override-justification mutation | Caught by tests; restored. |
| Duplicate-review-routing mutation | Caught by tests; restored. |
| Suppressed-transport-reason mutation | Caught by tests; restored. |

The cited child-run gate evidence was sanitized for its spawned test process only: `PI_SUBAGENT_*` and `PI_WORKFLOW_*` were unset for that process and not at runtime.

## Review

Multiple real blockers were found and fixed. Final round-2 blockers were resolved through the ratified narrow-fix policy choice; no additional review round was allocated. The final full gate is green.

Independent review did **not** issue approval after the review cap. This is not equivalent to post-cap independent approval; further review could still help. No known critical issue remains.

## Infrastructure recovery

Two stale-context Implementer physical attempts failed. Each was replaced while retaining unchanged logical Implementer authority, compact artifact scope, and claims. Neither failure consumed a review cycle.

## Issue #56 replay comparison

The prior first attempt used 6 Test Writer dispatches, had 4 failures, and aborted on dirty ownership. The second attempt consumed `2,348,766ms`, `1,326,733` input tokens, and `158,530` output tokens, then dead-ended after the review cap.

The new path removes synthetic red replay for accepted adopted evidence, protects selected-worktree dirt, permits physical-attempt replacement without changing logical authority, and makes the review cap a recoverable set of foreground choices rather than a dead end. A new live timing/token benchmark was not fabricated; measured improvement awaits a real replay. Eliminated dispatch and dead-end classes are executable-test proven.

## Migration and rollout

Migration is lazy and supports persisted v1–v4 workflows through v5 recovery semantics without hand editing. Rollback is available by keeping activation default-off, disabling contextual activation, and using legacy/recovery-compatible workflow paths. Rollout is staged through explicit foreground/default-off activation; observe diagnostics across live workflows before removing compatibility support.

## Deviations, follow-ups, and risks

**Accepted release deviations:** none.  
**Round-cap narrow fixes:** policy-resolution choices, not release deviations.

**Outstanding follow-ups:** collect real replay timing/token observations and consider an additional independent review after live use.  
**Unresolved risks:** no known critical issue; more live observation and independent review could help.
