// Version this key instead of reusing the former default-on boolean. A hot reload in
// a long-lived Pi process can retain that legacy value, which must not re-enable mode.
export const LEGACY_WORKFLOW_MODE_KEY = Symbol.for("development-workflow.enabled");
export const WORKFLOW_MODE_KEY = Symbol.for("development-workflow.enabled.v2");
export const ACTIVE_WORKFLOWS_KEY = Symbol.for("development-workflow.active-ids.v1");

type WorkflowModeGlobal = typeof globalThis & {
  [LEGACY_WORKFLOW_MODE_KEY]?: boolean;
  [WORKFLOW_MODE_KEY]?: boolean;
  [ACTIVE_WORKFLOWS_KEY]?: string[];
};

/** Process-local manual mode shared by every development-workflow extension instance. */
export function workflowModeEnabled(): boolean {
  const root = globalThis as WorkflowModeGlobal;
  return root[WORKFLOW_MODE_KEY] ??= false;
}

export function setWorkflowModeEnabled(enabled: boolean): void {
  (globalThis as WorkflowModeGlobal)[WORKFLOW_MODE_KEY] = enabled;
}

/** Active workflow identities survive hot reloads only; they are never recovered in a new process. */
export function activeWorkflowIds(): string[] {
  return [...((globalThis as WorkflowModeGlobal)[ACTIVE_WORKFLOWS_KEY] ?? [])];
}

export function setActiveWorkflowIds(ids: Iterable<string>): void {
  const root = globalThis as WorkflowModeGlobal;
  const values = [...new Set(ids)];
  if (!values.length) delete root[ACTIVE_WORKFLOWS_KEY];
  else root[ACTIVE_WORKFLOWS_KEY] = values;
}
