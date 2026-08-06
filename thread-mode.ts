// Version this key instead of reusing the former default-on boolean. A hot reload in
// a long-lived Pi process can retain that legacy value, which must not re-enable mode.
export const LEGACY_WORKFLOW_MODE_KEY = Symbol.for("development-workflow.enabled");
export const WORKFLOW_MODE_KEY = Symbol.for("development-workflow.enabled.v2");

type WorkflowModeGlobal = typeof globalThis & {
  [LEGACY_WORKFLOW_MODE_KEY]?: boolean;
  [WORKFLOW_MODE_KEY]?: boolean;
};

/** Process-local manual mode shared by every development-workflow extension instance. */
export function workflowModeEnabled(): boolean {
  const root = globalThis as WorkflowModeGlobal;
  return root[WORKFLOW_MODE_KEY] ??= false;
}

export function setWorkflowModeEnabled(enabled: boolean): void {
  (globalThis as WorkflowModeGlobal)[WORKFLOW_MODE_KEY] = enabled;
}
