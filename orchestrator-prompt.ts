import type { WorkflowState } from "./workflow-state.ts";

export const MAX_PLAN_PROMPT_BYTES = 48 * 1024;
export const MAX_ORCHESTRATOR_CONTEXT_BYTES = 56 * 1024;
const MAX_ARRAY_ITEMS = 8;
const MAX_ARRAY_ITEM_BYTES = 512;

function boundedUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end--;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

function boundedList(values: readonly string[]): string { return values.slice(0, MAX_ARRAY_ITEMS).map(value => boundedUtf8(value, MAX_ARRAY_ITEM_BYTES).text).join(" | ") || "none"; }
function stageInstruction(stage: WorkflowState["stage"]): string {
  switch (stage) {
    case "red_testing": return "Send the approved spec to Test Writer first; require targeted red-test command/output and the expected behavioral failure reason before implementation.";
    case "implementing": return "Send the approved spec plus red-test evidence to the stable logical Implementer role; physical attempts are replaceable only by foreground authorization after infrastructure failure. Require a green full-suite command/result before review.";
    case "testing": return "This is a legacy post-implementation testing stage; preserve its existing Test Writer session and sequence.";
    case "reviewing": return "Send Reviewer the approved spec, red evidence, implementation diff, green evidence, and a named suspected weakness; require the full project gate first.";
    case "fixing": return "Send only the concrete review findings and relevant approved scope back to the stable logical Implementer role; physical attempts are replaceable only by foreground authorization after infrastructure failure.";
    case "reporting": return "Ask Reporter to summarize execution against the approved plan; do not ask it to re-plan.";
    case "planning": return "This is a legacy planning workflow. Resume its existing Planner session without replacing its recorded scope.";
    default: return "Inspect the durable workflow state; do not create or broaden a plan.";
  }
}

/** Build bounded, durable foreground context without asking children to plan again. */
export function renderOrchestratorPlanContext(state: WorkflowState): string {
  const provenance = state.planProvenance;
  const source = provenance?.content ?? state.plan ?? "";
  const bounded = boundedUtf8(source, MAX_PLAN_PROMPT_BYTES);
  const criteria = state.acceptanceCriteria.slice(0, MAX_ARRAY_ITEMS).map(item => `- ${boundedUtf8(item, MAX_ARRAY_ITEM_BYTES).text}`).join("\n") || "- (legacy workflow: none recorded)";
  const context = [
    "## Active approved development plan",
    `Workflow: ${state.id}`,
    `Stage: ${state.stage}`,
    `Mode: ${state.mode}`,
    `Missing outcomes: ${boundedList(state.missingOutcomes)}`,
    `Admissible actions: ${state.review.escalation ? boundedList(state.review.escalation.actions) : "continue, abort"}`,
    `Accepted deviations: ${boundedList(state.acceptedDeviations.map(item => item.code))}`,
    `Unresolved risks: ${boundedList(state.unresolvedRisks)}`, 
    `Canonical path: ${provenance?.path ?? "(legacy workflow; unavailable)"}`,
    `SHA-256: ${provenance?.digest ?? "(legacy workflow; unavailable)"}`,
    "Acceptance criteria:",
    criteria,
    "",
    state.mode === "adopt_existing" ? `Adopted-existing workflow: dispatch only the first missing outcome (${state.missingOutcomes[0] ?? "none"}) using the admissible actions above; do not synthesize targeted-red or Test Writer work when accepted tests provenance satisfies it.` : stageInstruction(state.stage),
    "Delegate execution details, not whole-change re-planning. Preserve stable logical Implementer authority across fix rounds; physical attempts are replaceable only with foreground authorization after infrastructure failure. Use fresh stage contexts and pass artifacts rather than conversation history. Never use a fork or sub-orchestrator as a pipeline stage.",
    "Before dispatch, honor the persisted branch/dirty-tree/worktree snapshot and any batch file ownership/shared contracts. Parallelize only when the user explicitly requested it.",
    "Agent profiles are not workflow roles. Workflow lifecycle agentId must be exactly one of: planner, implementer, test-writer, reviewer, reporter. Never invent or semantically infer a role identifier.",
    "Auxiliary profiles such as researcher use ordinary subagent dispatch, for example { agent: \"researcher\", task: \"Investigate ...\" }, with no lifecycle, workflowId, or agentId.",
    "",
    `Approved plan${bounded.truncated ? ` (truncated to ${MAX_PLAN_PROMPT_BYTES} bytes for prompt safety)` : ""}:`,
    "```markdown",
    bounded.text,
    "```",
  ].join("\n");
  return boundedUtf8(context, MAX_ORCHESTRATOR_CONTEXT_BYTES).text;
}
