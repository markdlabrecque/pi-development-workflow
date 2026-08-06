import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const globalNodeModules = (await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const createJiti = piRequire("jiti");
const nodeModules = path.join(piRoot, "node_modules");
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-ai": path.join(nodeModules, "@earendil-works", "pi-ai", "dist", "compat.js"),
  "@earendil-works/pi-tui": path.join(nodeModules, "@earendil-works", "pi-tui", "dist", "index.js"),
  typebox: piRequire.resolve("typebox"),
} });
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const workflowExtensionModule = await jiti.import(extensionPath, { default: true });
const developmentWorkflow = workflowExtensionModule.default ?? workflowExtensionModule;
const state = await jiti.import("./workflow-state.ts");
const { setWorkflowModeEnabled } = await jiti.import("./thread-mode.ts");

function mockPi(cwd) {
  const handlers = new Map(); const tools = new Map();
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

test("workflow child policy matrix enforces role actions, exact records, and stage transitions", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-child-policy-"));
  const workflowId = `workflow-child-policy-${Date.now()}`;
  const prior = process.env.PI_SUBAGENT_ID, priorWorkflowId = process.env.PI_WORKFLOW_ID, priorWorkflowRole = process.env.PI_WORKFLOW_ROLE;
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_WORKFLOW_ID; delete process.env.PI_WORKFLOW_ROLE; setWorkflowModeEnabled(true);
  const mock = mockPi(cwd); const workflow = mock.tools.get("development_workflow");
  try {
    const legacy = state.createState({ id: workflowId, goal: "child policy", repositoryRoot: cwd });
    legacy.stage = "planning"; legacy.stageSequence = [...state.LEGACY_STAGE_SEQUENCE]; legacy.history = [{ stage: "planning", at: legacy.createdAt }];
    await state.saveState(legacy);
    const allowed = { planner: ["status", "record", "advance"], implementer: ["status", "record", "advance"], "test-writer": ["status", "record", "advance"], reviewer: ["status", "routeReview"], reporter: ["status", "report"] };
    const actions = ["start", "status", "advance", "record", "routeReview", "report", "complete", "block", "abort", "close", "override", "resolveEscalation"];
    const recordPayload = { planner: { plan: "x" }, implementer: { implementationSummary: "x" }, "test-writer": { testCommand: "node --test" }, reviewer: {}, reporter: {} };
    for (const [role, permitted] of Object.entries(allowed)) {
      process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:${role}`;
      process.env.PI_WORKFLOW_ID = workflowId; process.env.PI_WORKFLOW_ROLE = role;
      for (const action of actions) {
        const input = { action, workflowId, ...(action === "report" ? { reporterContent: "exact report" } : { agentId: role }), ...(action === "record" ? recordPayload[role] : {}) };
        const result = await emit(mock, "tool_call", { toolName: "development_workflow", input });
        assert.equal(result === undefined, permitted.includes(action), `${role} ${action}`);
      }
    }

    process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:planner`; process.env.PI_WORKFLOW_ID = workflowId; process.env.PI_WORKFLOW_ROLE = "planner";
    await assert.rejects(workflow.execute("empty", { action: "record", workflowId, agentId: "planner" }, undefined, undefined, mock.ctx), /at least one/);
    await assert.rejects(workflow.execute("extra", { action: "record", workflowId, agentId: "planner", plan: "p", reason: "not a record field" }, undefined, undefined, mock.ctx), /may not include reason/);
    await workflow.execute("plan", { action: "record", workflowId, agentId: "planner", plan: "p" }, undefined, undefined, mock.ctx);
    await assert.rejects(workflow.execute("bad planner advance", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx), /may not advance/);
    await workflow.execute("planner advance", { action: "advance", workflowId, stage: "implementing" }, undefined, undefined, mock.ctx);

    process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:implementer`; process.env.PI_WORKFLOW_ROLE = "implementer";
    await workflow.execute("implementation", { action: "record", workflowId, agentId: "implementer", implementationSummary: "done", files: ["src/a.ts"] }, undefined, undefined, mock.ctx);
    await workflow.execute("implementer advance", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx);

    process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:test-writer`; process.env.PI_WORKFLOW_ROLE = "test-writer";
    await workflow.execute("tests", { action: "record", workflowId, agentId: "test-writer", testCommand: "node --test", testPassed: true }, undefined, undefined, mock.ctx);
    await workflow.execute("test advance", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, mock.ctx);
    process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:reviewer`; process.env.PI_WORKFLOW_ROLE = "reviewer";
    await workflow.execute("required review", { action: "routeReview", workflowId, findings: [{ category: "must_fix", title: "fix" }] }, undefined, undefined, mock.ctx);
    assert.equal((await state.loadState(workflowId)).stage, "fixing", "trusted review routing may enter fixing");

    process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:implementer`; process.env.PI_WORKFLOW_ROLE = "implementer";
    await workflow.execute("fix advance", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx);
    process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:test-writer`; process.env.PI_WORKFLOW_ROLE = "test-writer";
    await workflow.execute("retest advance", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, mock.ctx);
    process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:reviewer`; process.env.PI_WORKFLOW_ROLE = "reviewer";
    await workflow.execute("approved review", { action: "routeReview", workflowId, findings: [{ category: "approved", title: "approved" }] }, undefined, undefined, mock.ctx);
    const afterReview = await state.loadState(workflowId);
    assert.equal(afterReview.stage, "reporting", "trusted review routing retains its normal consequence");
    await assert.rejects(workflow.execute("late review", { action: "routeReview", workflowId, findings: [{ category: "approved", title: "late" }] }, undefined, undefined, mock.ctx), /only while reviewing/);
    process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:reporter`; process.env.PI_WORKFLOW_ROLE = "reporter";
    const auditableReport = ["child policy", "done", "src/a.ts", "node --test", "pass", "approved", "approved", "Follow-ups: none"].join("\n");
    await workflow.execute("report", { action: "report", workflowId, reporterContent: auditableReport }, undefined, undefined, mock.ctx);
    assert.equal((await state.loadState(workflowId)).reporterResult, auditableReport);
    await assert.rejects(workflow.execute("report-extra", { action: "report", workflowId, reporterContent: "x", reason: "extra" }, undefined, undefined, mock.ctx), /may not include reason/);
  } finally {
    if (prior === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = prior;
    if (priorWorkflowId === undefined) delete process.env.PI_WORKFLOW_ID; else process.env.PI_WORKFLOW_ID = priorWorkflowId;
    if (priorWorkflowRole === undefined) delete process.env.PI_WORKFLOW_ROLE; else process.env.PI_WORKFLOW_ROLE = priorWorkflowRole;
    setWorkflowModeEnabled(false);
    await state.removeState(workflowId);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("foreground policy actions persist accepted decisions, resolve caps, and deny children", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-policy-actions-")); const workflowId = `workflow-policy-actions-${Date.now()}`;
  const previous = Object.fromEntries(["PI_SUBAGENT_ID", "PI_WORKFLOW_ID", "PI_WORKFLOW_ROLE"].map(key => [key, process.env[key]]));
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_WORKFLOW_ID; delete process.env.PI_WORKFLOW_ROLE; setWorkflowModeEnabled(true);
  const mock = mockPi(cwd); const workflow = mock.tools.get("development_workflow");
  try {
    const persisted = state.createState({ id: workflowId, goal: "policy actions", repositoryRoot: cwd });
    persisted.stage = "reviewing"; persisted.history = [{ stage: "reviewing", at: persisted.createdAt }];
    state.recordReviewCapEscalation(persisted, { actor: "foreground-orchestrator", at: persisted.createdAt, unresolvedFindingIds: ["finding-1"], unresolvedEvidenceIds: ["gate-1"] });
    await state.saveState(persisted);
    await workflow.execute("override", { action: "override", workflowId, ruleCode: "historical_red_missing", reason: "historical import", decision: "accept_deviation", risk: "missing red", evidence: ["record-1"] }, undefined, undefined, mock.ctx);
    await workflow.execute("resolve", { action: "resolveEscalation", workflowId, escalationChoice: "narrow_fix" }, undefined, undefined, mock.ctx);
    const resolved = await state.loadState(workflowId);
    assert.equal(resolved.stage, "fixing"); assert.equal(resolved.acceptedDeviations.length, 2); assert.equal(resolved.review.escalation, undefined); assert.equal(resolved.review.postCapFix?.code, "targeted_post_cap_fix");
    process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:implementer`; process.env.PI_WORKFLOW_ID = workflowId; process.env.PI_WORKFLOW_ROLE = "implementer";
    const hook = await emit(mock, "tool_call", { toolName: "development_workflow", input: { action: "override", workflowId } });
    assert.equal(hook?.block, true);
    await assert.rejects(workflow.execute("child override", { action: "override", workflowId, ruleCode: "historical_red_missing", reason: "x", decision: "accept_deviation", risk: "x", evidence: ["x"] }, undefined, undefined, mock.ctx), /may not perform override/);
    await assert.rejects(workflow.execute("child resolve", { action: "resolveEscalation", workflowId, escalationChoice: "abort" }, undefined, undefined, mock.ctx), /may not perform resolveEscalation/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    setWorkflowModeEnabled(false); await state.removeState(workflowId); await rm(cwd, { recursive: true, force: true });
  }
});
