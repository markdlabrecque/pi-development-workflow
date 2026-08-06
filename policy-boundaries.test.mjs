import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const globalNodeModules = (await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const jiti = piRequire("jiti")(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-ai": path.join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"),
  "@earendil-works/pi-tui": path.join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
  typebox: piRequire.resolve("typebox"),
} });
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const loaded = await jiti.import(extensionPath, { default: true });
const developmentWorkflow = loaded.default ?? loaded;
const state = await jiti.import("./workflow-state.ts");
const { setWorkflowModeEnabled } = await jiti.import("./thread-mode.ts");

function mockPi(cwd) {
  const handlers = new Map(), tools = new Map();
  const pi = {
    events: { emit() {}, on() {} },
    on(name, handler) { const entries = handlers.get(name) ?? []; entries.push(handler); handlers.set(name, entries); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
    getActiveTools() { return ["development_workflow"]; }, setActiveTools() {}, async setModel() { return true; },
  };
  const ctx = { cwd, hasUI: false, modelRegistry: { find: () => ({ provider: "omlx", id: "AtomicChat--ornith-35b-MLX-4bit", maxTokens: 32768 }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local" }) }, isProjectTrusted: () => false, ui: { setStatus() {}, notify() {} } };
  developmentWorkflow(pi);
  return { handlers, tools, ctx };
}
async function emit(mock, name, event) { let result; for (const handler of mock.handlers.get(name) ?? []) result = await handler(event, mock.ctx); return result; }

test("child policy denies every terminal action at hook and execution boundaries while foreground remains unrestricted", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-policy-boundaries-"));
  const workflowId = `workflow-policy-boundaries-${Date.now()}`;
  const otherWorkflowId = `${workflowId}-other`;
  const foregroundTerminalId = `${workflowId}-foreground-terminal`;
  const priorIdentity = Object.fromEntries(
    ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_ID", "PI_WORKFLOW_ID", "PI_WORKFLOW_ROLE"].map(name => [name, process.env[name]]),
  );
  for (const name of Object.keys(priorIdentity)) delete process.env[name];
  setWorkflowModeEnabled(true);
  const mock = mockPi(cwd), workflow = mock.tools.get("development_workflow");
  const terminalActions = ["complete", "block", "abort", "close"];
  try {
    await writeFile(path.join(cwd, "plan.md"), "# Approved plan\n");
    const approved = { planPath: "plan.md", acceptanceCriteria: ["done"] };
    await workflow.execute("start", { action: "start", workflowId, goal: "policy boundaries", ...approved }, undefined, undefined, mock.ctx);
    await workflow.execute("start-other", { action: "start", workflowId: otherWorkflowId, goal: "foreground scope", ...approved }, undefined, undefined, mock.ctx);
    await workflow.execute("start-foreground-terminal", { action: "start", workflowId: foregroundTerminalId, goal: "foreground terminal scope", ...approved }, undefined, undefined, mock.ctx);

    // A foreground orchestrator is deliberately not tied to a child workflow ID,
    // including for lifecycle-changing terminal actions.
    await assert.doesNotReject(workflow.execute("foreground-other-status", { action: "status", workflowId: otherWorkflowId }, undefined, undefined, mock.ctx));
    const foregroundAbort = await workflow.execute("foreground-abort", { action: "abort", workflowId: foregroundTerminalId, reason: "orchestrator decision" }, undefined, undefined, mock.ctx);
    assert.equal(foregroundAbort.details.stage, "aborted");

    for (const role of ["planner", "implementer", "test-writer", "reviewer", "reporter"]) {
      process.env.PI_SUBAGENT_CHILD = "1";
      process.env.PI_SUBAGENT_ID = `${workflowId}:${role}`;
      process.env.PI_WORKFLOW_ID = workflowId;
      process.env.PI_WORKFLOW_ROLE = role;
      for (const action of terminalActions) {
        const input = { action, workflowId, ...(action === "block" || action === "abort" ? { reason: "no" } : {}) };
        const hookResult = await emit(mock, "tool_call", { toolName: "development_workflow", input });
        assert.equal(hookResult?.block, true, `${role} ${action} must be blocked by tool_call`);
        await assert.rejects(workflow.execute(`${role}-${action}`, input, undefined, undefined, mock.ctx), new RegExp(`The ${role} workflow child may not perform ${action} actions\\.`), `${role} ${action} must be denied by execute`);
      }
      const crossWorkflow = await emit(mock, "tool_call", { toolName: "development_workflow", input: { action: "status", workflowId: otherWorkflowId } });
      assert.equal(crossWorkflow?.block, true, `${role} cannot inspect another workflow`);
    }
  } finally {
    for (const [name, value] of Object.entries(priorIdentity)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    setWorkflowModeEnabled(false);
    await state.removeState(workflowId);
    await state.removeState(otherWorkflowId);
    await state.removeState(foregroundTerminalId);
    await rm(cwd, { recursive: true, force: true });
  }
});
