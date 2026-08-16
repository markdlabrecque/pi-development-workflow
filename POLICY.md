# Development-workflow policy contract

Status: ratified for state-v5 implementation
Date: 2026-07-30

This document is the executable-policy design record. `HARD` rules are not overridable. `OUTCOME` rules are required by default but may be changed only through a foreground, structured, persisted decision using a closed rule code. `ADVISORY` rules are contextual defaults; following or departing from them never grants authority that a hard rule withholds.

## Policy classification matrix

| Code | Rule and current sources | Class | Enforcement owner / evidence |
|---|---|---|---|
| `production_safety` | Never access, authenticate to, or write production (`README`, all role prompts, Pi/Claude global policy). | HARD | Tool/runtime boundary where available; role prompt plus audit event. No override code exists. |
| `daily_hook_e2e` | Changes to the daily-report post-commit hook or dependencies require a real commit and report verification; URL parsing covers SSH, HTTPS `.git`, subgroup, and no-remote (`AGENTS`, `CLAUDE`, `README`). | HARD | Acceptance/evidence validator and final report. No syntax-only substitution. |
| `repository_trust` | Remote integrations require trusted configuration or explicit foreground approval; detection alone grants no write authority (`README`, `index.ts`, system-of-record layer). | HARD | Extension authorization and persisted provenance. |
| `remote_write_approval` | GitHub/GitLab/Bitbucket writes require trusted configured or explicitly approved integration (`README`, `index.ts`). | HARD | Extension authorization. No child or prompt override. |
| `foreground_authority` | Foreground Orchestrator alone starts, completes, blocks, aborts, closes, chooses risk, and coordinates worktrees (`README`, `index.ts`, global policies). | HARD | Child action matrix and raw workflow identity. |
| `child_identity_authority` | Malformed/partial child identity fails closed; children access only their workflow and role-scoped actions/fields/stages (`index.ts`, `README`). | HARD | Tool-call and execute-time authorization. |
| `role_mutation_boundary` | Test Writer writes initial tests only; Implementer alone writes production; Reviewer is read-only; Reporter returns content and does not mutate implementation (`README`, role prompts, global policies). | HARD | Subagent tools, child action matrix, file ownership/locking, artifact validation. |
| `reviewer_read_only` | Reviewer may run only non-mutating gates/analysis and never fix findings (`README`, reviewer prompt, global policies). | HARD | Tool profile, shell/file mutation audit, workflow authorization. |
| `file_ownership_locking` | Canonical-root ownership, cross-process locks, unrelated-dirt protection, sibling claims, and restoration of unauthorized writes (`README`, `index.ts`, global policy). | HARD | Subagent mutation guard and workflow state lock. |
| `unrelated_dirt_protection` | Pre-existing unrelated dirt must be surfaced, acknowledged, and protected; task-owned dirt must be checkpointed/cleaned and released, not silently adopted (`README`, `index.ts`, `AGENTS`, `CLAUDE`). | HARD | Canonical target-worktree preflight and mutation guard. |
| `target_repository_integrity` | Plans and owned paths remain inside the selected canonical repository/worktree; collisions, malformed/future state, and terminal resurrection fail closed (`README`, `workflow-state.ts`, `index.ts`). | HARD | Canonicalization, strict migration, atomic state transaction/tombstone. |
| `parallel_authorization` | Parallel execution requires explicit user request; no worktree is delegated to a sub-orchestrator (`README`, `index.ts`, global policies). | HARD | Start validation and foreground dispatch authority. |
| `parallel_ownership_contract` | Parallel branches name file ownership/shared contracts, land shared infrastructure first, limit contention, update from base, and rerun gates (`README`, global policies). | OUTCOME | Persisted batch contract and release evidence; deviation requires `parallel_strategy`. |
| `green_release` | Implementer cannot hand off red; review requires an independent gate; completion requires current passing release evidence and cannot silently approve a critical finding (`README`, `index.ts`, role/global policies). | HARD | Evidence validator and outcome transition guard. No override code exists. |
| `test_integrity` | Implementer cannot weaken/delete/skip disputed tests; disputed tests escalate (`README`, implementer prompt, global policies). | HARD | Role authority plus audit/review evidence. |
| `required_artifacts` | Approved scope, acceptance criteria, provenance, relevant test evidence, implementation result, review result/escalation, final report, and unresolved risks must be durable (`README`, `index.ts`, prompts). | OUTCOME | State/outcome validators; only specifically enumerated provenance gaps may be accepted. |
| `architecture_evidence` | Mechanically coupled or architecture-sensitive acceptance requires explicit executable-evidence and architecture contracts before implementation (`README`, `index.ts`, global policies). | HARD | Start/outcome validator. No override code exists. |
| `new_work_red_first` | New work defaults to an initial targeted behavioral red test with command/output/reason (`README`, Test Writer prompt, global policies). | OUTCOME | New-mode default; deviation requires `historical_red_missing` with reason/risk/evidence. Adopted work may accept validated historical provenance. |
| `full_gate_handoff` | Implementer normally runs one full gate at each review handoff/bounce; Reviewer independently runs one full gate per round (`README`, prompts, global policies). | OUTCOME | Evidence validator; narrow post-cap resolution requires `targeted_post_cap_fix` and still needs final full-green release evidence. |
| `review_required` | Non-trivial work gets independent read-only review focused on a named weakness (`README`, prompts, global policies). | OUTCOME | Outcome guard; omission requires `independent_review_unavailable`, explicit user/foreground risk handling, and no unresolved critical finding. |
| `review_round_default` | Two rounds cap automatic reviewer loops; one may be configured (`README`, `index.ts`, prompts, global policies). | ADVISORY | Orchestrator may allocate another round with structured `additional_review_round`; cap creates recoverable escalation, never automatic approval/dead end. |
| `role_sequence_default` | Default path is spec -> Test Writer -> Implementer <-> Reviewer -> Reporter; fresh stage contexts, stable logical Implementer, fresh Reviewer (`README`, prompts, global policies). | ADVISORY | Foreground Orchestrator chooses only admissible next actions based on missing outcomes. Prompts recommend, not authorize. |
| `tracer_bullet_default` | New features prefer a retained vertical slice; spikes are explicit (`README`, Implementer prompt, global policies). | ADVISORY | Handoff/report decision; deviation is recorded as risk when material. |
| `minimal_root_cause` | Prefer minimal, targeted root-cause fixes and avoid scope broadening (`README`, prompts, global policies). | ADVISORY | Foreground decision and review. |
| `premise_verification` | Verify ticket/dependency premises cheaply before encoding them (`role prompts`, Claude policy). | ADVISORY | Handoff context and review focus. |
| `fresh_context_compact_bundle` | Pass compact artifacts, not conversation history or broad rediscovery; no fork/sub-orchestrator; dispatch size is bounded (`README`, `index.ts`, prompts, global policies). | HARD for no fork/sub-orchestrator and byte cap; ADVISORY for exact bundling style | Dispatch authorization/cap plus prompt guidance. |
| `stable_logical_roles` | Fixes return to the stable logical Implementer; Reviewers are independently replaceable; transport failures do not change authority (`README`, prompts, global policies). | HARD authority; ADVISORY physical-session reuse | Logical-role state, attempt records, replacement authorization. |
| `skip_expiry_guard` | Every deliberate skip/descope/ignore/dependency TODO has a guard that fails when its reason disappears (`README`, prompts, global policies). | OUTCOME | Artifact/report validator; deviation requires `expiry_guard_inapplicable` with evidence. |
| `report_fidelity` | Reporter states built/not built, commands/results, verdict, deviations, unresolved risks, failures, skips, and every follow-up without softening (`README`, reporter prompt, global policies). | HARD for truthful persisted content; no override | Reporter validator and system-of-record writer. |
| `posting_failure_integrity` | Posting failure preserves technical state/result for inspection during the active session (`README`, reporter prompt, `index.ts`). | HARD | Commit state before external I/O and record failure diagnostics. |
| `state_integrity` | Session coordination state is validated, locked, lazily migrated, non-resurrectable, and removed after coordinated terminal or session cleanup (`README`, `workflow-state.ts`, `index.ts`). | HARD | State module and cleanup transaction. |
| `diagnostic_integrity` | Diagnostics are append-only/bounded/redacted, identify failures and evidence authors, and remain consistent with state summaries (`README`, diagnostics/index). | HARD for redaction/integrity; OUTCOME for completeness | Diagnostic schema plus consistency tests. |
| `model_authorization` | Workflow models are provider-qualified, supported, available, authenticated, and persisted; malformed state cannot inject CLI values (`README`, roles/index). | HARD | Dispatch-time resolver and strict state validation. |
| `activation_scope` | Workflow tool is off by default and activated only by explicit foreground trigger/manual mode; queued/child fragments cannot gain foreground authority (`README`, `index.ts`). | HARD | Input lifecycle and execute-time guard. |
| `browser_convention` | Chromium for automated work; Firefox conventions for manual instructions (`README`, prompts, global policies). | ADVISORY | Prompt/policy. |
| `uv_dev_extra` | Use `uv sync --extra dev` when dev tools live in the optional dev extra (`README`, prompts, global policies). | OUTCOME | Command evidence; deviation only when project structure proves inapplicable. |
| `output_brevity` | Shortest-correct user output; no unsolicited continuation after a question (`README`, global policies). | ADVISORY | Foreground behavior. |
| `user_scope_integrations` | Cross-project integrations default to user scope (`README`, global policies). | ADVISORY | Foreground decision. |

## Architecture contract

1. The extension owns deterministic authorization, canonical repository/worktree selection, state migration and atomic persistence, idempotency, artifact validation, file/session authority, hard-invariant enforcement, diagnostics, and system-of-record writes.
2. The foreground Orchestrator owns new-work mode selection (`new`, `adopt_existing`), contextual sequencing, risk evaluation, accepted provenance, escalation resolution, rescope, and abort decisions. Legacy `recovery` state is migration compatibility only.
3. Every departure from an outcome default is a structured durable decision with a closed rule code, reason, decision, risk, actor, timestamp, and supporting evidence. Rejected attempts are diagnostic events and cannot mutate authorization state.
4. Prompts describe responsibilities, defaults, risks, and admissible actions. They cannot grant authority, create an override code, bypass artifact validation, or weaken a hard invariant.
5. Transitions are outcome-based: durable state records satisfied/missing outcomes and computes admissible next actions. `stage` remains a resumable projection for compatibility, not the source of authority.
6. Logical role identity is stable and distinct from physical session attempts. A foreground-authorized infrastructure replacement inherits only the same role authority, artifact bundle, and file claims.
7. Release remains fail-closed: no completion without current full-green evidence, truthful reporting, and either resolved critical findings or an explicit non-approval terminal state.

## Executable acceptance-evidence contract

The implementation test matrix uses temporary Git repositories and, where specified, linked worktrees. Every scenario asserts (a) persisted state after reload/migration, (b) normalized diagnostics, (c) computed admissible next actions, and (d) unchanged child/file/remote safety boundaries.

| Scenario | Required executable evidence |
|---|---|
| New work | Starts in `new`; red-first is the default; targeted red provenance is durable; green/review/report outcomes lead to completion. |
| Adopt existing | Starts in a separate selected worktree; inventories branch/commits/dirt/tests/plan/report/issue provenance; foreground accepts each inherited artifact; only missing outcomes are dispatched. |
| Legacy migration | Loads versions 1-4 lazily into v5 when encountered by an active session, without startup scanning or cross-session continuation. |
| Review-cap escalation | Cap persists a recoverable escalation and choices; critical findings never become approved; narrow fix can proceed with targeted proof and final full-green evidence without another automatic review. |
| Authorized override | A closed soft-rule code with complete justification persists accepted decision and diagnostic audit, changes admissible actions, and appears in final Reporter content. |
| Denied override | Attempt against production, trust/remote, child/role, dirt/ownership, reviewer-read-only, state integrity, or green-release boundary is rejected, diagnosed, and leaves state/authority unchanged. |
| Worktree-local plan | Explicit target repository/worktree drives preflight and plan ingestion; an in-root plan is accepted even when the foreground cwd is another worktree; escape paths are rejected. |
| Atomic review routing | One operation records independent gate evidence and findings or references evidence by ID; idempotency retries do not duplicate evidence/findings/cycles/diagnostics. |
| Infrastructure replacement | Transport/process/stale-context/compaction failure records reason/role/attempt/exit/duration/usage; foreground replacement preserves logical authority and claims; failure consumes no review cycle. |
| Final reporting | Reporter output contains selected mode, accepted deviations, rejected/failed actions when relevant, unresolved risks, all follow-ups, and exact red/green/review evidence; posting failure remains inspectable during the active session. |
| Consistency | State test/review/attempt counters derive from or reconcile with diagnostic events after retries and reload. |
| Non-regression | Existing authorization, state lock/tombstone, system-of-record trust, cleanup, production safety, model resolution, activation, compaction, and subagent mutation tests remain green. |

Mutation evidence must prove that tests fail when: one hard invariant is made overridable; override justification is omitted; duplicate review routing is reintroduced; or a transport failure reason is suppressed. Restore every mutation before the full gate.
