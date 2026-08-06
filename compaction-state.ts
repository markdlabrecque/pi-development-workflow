import type { WorkflowState } from "./workflow-state.ts";

export const WORKFLOW_SNAPSHOT_START = "<!-- development-workflow-state:start -->";
export const WORKFLOW_SNAPSHOT_END = "<!-- development-workflow-state:end -->";
const MAX_WORKFLOWS = 3;
const MAX_FIELD_CHARS = 700;
const MAX_SNAPSHOT_CHARS = 5_000;

function truncate(value: string | undefined, limit = MAX_FIELD_CHARS): string | undefined {
  if (!value) return undefined;
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
function active(state: WorkflowState): boolean { return !["completed", "aborted"].includes(state.stage); }

/** A deterministic, size-bounded durable-state snapshot for custom compaction. */
export function renderWorkflowSnapshot(states: readonly WorkflowState[]): string | undefined {
  const selected = states.filter(active).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, MAX_WORKFLOWS);
  if (!selected.length) return undefined;
  const lines = [WORKFLOW_SNAPSHOT_START, "## Development workflow recovery state", "Durable state is stored on disk; preserve these active workflow facts when continuing."];
  for (const state of selected) {
    lines.push(`### ${state.id}`, `- Stage: ${state.stage}`, `- Mode: ${state.mode}`, `- Goal: ${truncate(state.goal) ?? "Not recorded"}`);
    if (state.missingOutcomes.length) lines.push(`- Missing outcomes: ${state.missingOutcomes.join(", ")}`);
    if (state.acceptedDeviations.length) lines.push(`- Accepted deviations: ${state.acceptedDeviations.map(item => item.code).join(", ")}`);
    if (state.unresolvedRisks.length) lines.push(`- Unresolved risks: ${state.unresolvedRisks.map(item => truncate(item, 180)).join(" | ")}`);
    if (state.review.escalation) lines.push(`- Admissible escalation actions: ${state.review.escalation.actions.join(", ")}`);
    if (state.acceptanceCriteria.length) lines.push(`- Acceptance criteria: ${state.acceptanceCriteria.slice(0, 8).map(item => truncate(item, 240)).join(" | ")}`);
    if (state.plan) lines.push(`- Plan: ${truncate(state.plan)}`);
    if (state.implementationSummary) lines.push(`- Implementation: ${truncate(state.implementationSummary)}`);
    const latestTest = state.tests.at(-1);
    if (latestTest) lines.push(`- Latest test: ${latestTest.passed ? "passed" : "failed"} — ${truncate(latestTest.command, 280)}`);
    if (state.review.findings.length) lines.push(`- Review: ${state.review.findings.slice(0, 5).map(finding => `${finding.category}: ${truncate(finding.title, 160)}`).join(" | ")}`);
    if (state.blockingReason) lines.push(`- Blocked: ${truncate(state.blockingReason)}`);
  }
  lines.push(WORKFLOW_SNAPSHOT_END);
  const snapshot = lines.join("\n");
  return snapshot.length > MAX_SNAPSHOT_CHARS ? `${snapshot.slice(0, MAX_SNAPSHOT_CHARS - WORKFLOW_SNAPSHOT_END.length - 2)}\n${WORKFLOW_SNAPSHOT_END}` : snapshot;
}

/** Remove prior snapshots before appending one current snapshot, avoiding compaction bloat. */
export function mergeWorkflowSnapshot(summary: string, snapshot: string): string {
  let result = summary;
  for (;;) {
    const start = result.indexOf(WORKFLOW_SNAPSHOT_START);
    if (start < 0) break;
    const end = result.indexOf(WORKFLOW_SNAPSHOT_END, start);
    result = end < 0 ? result.slice(0, start).trimEnd() : `${result.slice(0, start)}${result.slice(end + WORKFLOW_SNAPSHOT_END.length)}`.trim();
  }
  return `${result.trimEnd()}\n\n${snapshot}`.trim();
}
