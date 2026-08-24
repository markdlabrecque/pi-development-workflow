# Remove legacy Planner

## Approved scope

Remove the legacy Planner role from the role profile, registry, prompts, and workflow lifecycle. Preserve supported non-planning migrations and legacy testing recovery. Reject workflows that are actively in planning with restart guidance.

## Changed behavior

- Removed the Planner profile, registry entry, prompt path, and lifecycle behavior.
- Active planning state now fails with guidance to restart the workflow.
- Non-planning v1 through v4 migration remains supported. Migration removes planning from `stageSequence` and preserves workflow history.
- Legacy testing recovery remains supported.

## Key files

- `agents/planner.md`
- `roles.ts`
- `orchestrator-prompt.ts`
- `index.ts`
- `workflow-state.ts`
- `planner-removal-regression.test.mjs`
- `child-policy.test.mjs`
- `hybrid-plan.test.mjs`
- `policy-boundaries.test.mjs`
- `workflow-improvements.test.mjs`
- `workflow-process.integration.test.mjs`
- `workflow-state-templates.test.mjs`

## Verification

- `node --test child-policy.test.mjs hybrid-plan.test.mjs planner-removal-regression.test.mjs policy-boundaries.test.mjs workflow-improvements.test.mjs workflow-process.integration.test.mjs workflow-state-templates.test.mjs` passed, 39/39.
- Reviewer full gate, `env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_ID -u PI_WORKFLOW_ID -u PI_WORKFLOW_ROLE node --test '*.test.mjs' 'eval/*.test.mjs'`, completed with 94 passing and 4 failing. The four known baseline failures are caused only by missing external files `/Users/mark/Projects/subagents/child-guard.ts` and `/Users/mark/Projects/subagents/index.ts`. The repository gate was not fully green.

## Review

Reviewer verdict: approved. No findings remain for the Planner-removal change.

## Deviations and follow-up

No accepted deviations or deliberate skips. The only unresolved follow-up and risk is the external missing-files baseline. Restore `/Users/mark/Projects/subagents/child-guard.ts` and `/Users/mark/Projects/subagents/index.ts`, then rerun the full gate.
