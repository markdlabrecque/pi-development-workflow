import type { Stage, WorkflowTemplateName } from "./workflow-state.ts";

export interface WorkflowTemplate {
  readonly name: WorkflowTemplateName;
  readonly acceptanceCriteria: readonly string[];
  readonly plan: string;
  /** Normal path; review findings may still enter the existing fixing loop. */
  readonly stageSequence: readonly Stage[];
  /** Optional stable role handles supplied by a template. */
  readonly agentHandles?: Readonly<Record<string, string>>;
}

const standardSequence: readonly Stage[] = Object.freeze(["red_testing", "implementing", "reviewing", "reporting"]);
function defineTemplate(template: WorkflowTemplate): WorkflowTemplate {
  if (template.agentHandles) Object.freeze(template.agentHandles);
  Object.freeze(template.acceptanceCriteria);
  Object.freeze(template.stageSequence);
  return Object.freeze(template);
}

/**
 * Deprecated immutable defaults retained only for compatibility with older imports.
 * New workflows require an approved planPath and never select a template.
 */
export const WORKFLOW_TEMPLATES: Readonly<Record<WorkflowTemplateName, WorkflowTemplate>> = Object.freeze({
  bugfix: defineTemplate({
    name: "bugfix",
    acceptanceCriteria: ["Identify and correct the root cause", "Add regression coverage for the reported behavior", "Run targeted verification"],
    plan: "Reproduce or characterize the defect, identify its root cause, make the smallest safe correction, and verify the regression is covered.",
    stageSequence: standardSequence,
  }),
  feature: defineTemplate({
    name: "feature",
    acceptanceCriteria: ["Implement the requested behavior", "Cover expected behavior and relevant edge cases", "Run targeted verification"],
    plan: "Confirm the requested behavior and affected interfaces, implement the scoped feature, add focused coverage, and verify integration with existing behavior.",
    stageSequence: standardSequence,
  }),
  refactor: defineTemplate({
    name: "refactor",
    acceptanceCriteria: ["Preserve existing observable behavior", "Improve the targeted structure without unrelated changes", "Verify behavior with focused tests"],
    plan: "Map the current behavior and dependencies, make the scoped structural improvement, retain or add behavior-preserving tests, and verify no contract changed unintentionally.",
    stageSequence: standardSequence,
  }),
});

export const WORKFLOW_TEMPLATE_NAMES = ["bugfix", "feature", "refactor"] as const satisfies readonly WorkflowTemplateName[];
export function getWorkflowTemplate(name: WorkflowTemplateName): WorkflowTemplate { return WORKFLOW_TEMPLATES[name]; }
