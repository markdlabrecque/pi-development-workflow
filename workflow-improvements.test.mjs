import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Load this extension exactly as Pi does: Node's normal resolver cannot see Pi's bundled
// extension dependencies from ~/.pi/agent. The mock below exercises its registered handlers.
const globalNodeModules = (await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const createJiti = piRequire("jiti");
const nodeModules = path.join(piRoot, "node_modules");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
    "@earendil-works/pi-ai": path.join(nodeModules, "@earendil-works", "pi-ai", "dist", "compat.js"),
    "@earendil-works/pi-tui": path.join(nodeModules, "@earendil-works", "pi-tui", "dist", "index.js"),
    typebox: piRequire.resolve("typebox"),
  },
});
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const developmentWorkflowModule = await jiti.import(extensionPath, { default: true });
const developmentWorkflow = developmentWorkflowModule.default ?? developmentWorkflowModule;
const { validateToolArguments } = await import(path.join(nodeModules, "@earendil-works", "pi-ai", "dist", "compat.js"));

const originalSubagentId = process.env.PI_SUBAGENT_ID;
const workflowStateModule = await jiti.import(path.join(path.dirname(extensionPath), "workflow-state.ts"));
const { activeWorkflowIds, setActiveWorkflowIds, setWorkflowModeEnabled: setWfMode } = await jiti.import("./thread-mode.ts");

// Helper to ensure workflow mode is enabled (reset process-global state)
function resetWorkflowMode() {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_WORKFLOW_ID;
  delete process.env.PI_WORKFLOW_ROLE;
  setActiveWorkflowIds([]);
  setWfMode(true);
}
function auditableReporterContent(current) {
  return [
    `Goal: ${current.goal}`,
    ...current.acceptanceCriteria,
    current.planProvenance?.path,
    current.planProvenance?.digest,
    current.implementationSummary,
    ...Object.values(current.filesOwned).flat().map(file => path.relative(current.repositoryRoot, file)),
    ...current.tests.flatMap(item => [item.command, item.passed ? "pass" : "fail", item.output, item.expectedFailureReason]),
    current.review.approved ? "Review: approved" : "Review: not approved",
    ...current.review.findings.flatMap(item => [item.category, item.title, item.detail]),
    current.followUps.length ? undefined : "Follow-ups: none",
    ...current.followUps.flatMap(item => [item.title, item.detail]),
    ...current.acceptedDeviations.flatMap(item => [item.code, item.reason, item.decision, item.risk, ...item.evidence]),
    ...current.unresolvedRisks,
    ...current.attempts.flatMap(item => [item.role, item.reason]),
  ].filter(Boolean).join("\n");
}

function createMockPi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const active = new Set(["read", "bash", "development_workflow"]);
  const notifications = [];
  const statuses = new Map();
  const subagentRequests = [];
  let confirmAnswer = true;
  let selectAnswer;
  const confirmations = [];
  const selections = [];
  const pi = {
    events: {
      emit(name, request) {
        if (name !== "subagent:request") return;
        subagentRequests.push(request);
        request.accept();
        request.resolve("closed");
      },
      on() {},
    },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) {
      if (tool.name === "development_workflow") {
        const execute = tool.execute.bind(tool);
        tool = { ...tool, async execute(id, params, signal, update, ctx) {
          if (params.action === "start" && params.planPath === undefined) {
            const local = path.join(ctx.cwd, ".test-approved-plan.md"); fs.mkdirSync(ctx.cwd, { recursive: true }); fs.writeFileSync(local, "# Approved test plan\n");
            params = { ...params, planPath: ".test-approved-plan.md", acceptanceCriteria: params.acceptanceCriteria?.length ? params.acceptanceCriteria : ["test acceptance criterion"] };
          }
          // Compatibility adapter for older assertions in this file that exercise
          // unrelated lifecycle behavior through the former post-implementation testing stage.
          if (params.action === "advance" && params.stage === "testing") {
            const current = await workflowStateModule.loadState(params.workflowId);
            if (current?.stage === "red_testing") {
              await execute(`${id}-red`, { action: "record", workflowId: params.workflowId, agentId: "test-writer", testCommand: "node --test", testPassed: false, testOutput: "expected missing behavior", evidenceKind: "targeted_red", expectedFailureReason: "behavior absent" }, signal, update, ctx);
              await execute(`${id}-implementing`, { action: "advance", workflowId: params.workflowId, stage: "implementing" }, signal, update, ctx);
            }
            await execute(`${id}-green`, { action: "record", workflowId: params.workflowId, agentId: "implementer", testCommand: "node --test", testPassed: true, testOutput: "all pass", evidenceKind: "full_green" }, signal, update, ctx);
            return execute(`${id}-status`, { action: "status", workflowId: params.workflowId }, signal, update, ctx);
          }
          if (params.action === "routeReview") {
            params = { ...params, suspectedWeakness: params.suspectedWeakness ?? "test harness risk", testCommand: params.testCommand ?? "node --test", testPassed: true, testOutput: params.testOutput ?? "all pass", findings: params.findings?.map(f => f.category === "approved" ? f : { ...f, detail: f.detail ?? "verified by test harness" }) };
          }
          if (params.action === "complete") {
            const current = await workflowStateModule.loadState(params.workflowId);
            if (current?.stage === "reporting" && !current.reporterResult) await execute(`${id}-report`, { action: "report", workflowId: params.workflowId, reporterContent: auditableReporterContent(current) }, signal, update, ctx);
          }
          return execute(id, params, signal, update, ctx);
        } };
      }
      tools.set(tool.name, tool);
    },
    async setModel() { return true; },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active.clear(); for (const name of names) active.add(name); },
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: { getEntries: () => [] },
    modelRegistry: { find: () => ({ provider: "omlx", id: "AtomicChat--ornith-35b-MLX-4bit", maxTokens: 32768 }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local" }) },
    isProjectTrusted: () => false,
    ui: {
      setStatus(key, value) { statuses.set(key, value); },
      notify(message, level) { notifications.push({ message, level }); },
      async confirm(title, message) { confirmations.push({ title, message }); return confirmAnswer; },
      async select(title, options) { selections.push({ title, options }); return selectAnswer ?? options[0]; },
    },
  };
  developmentWorkflow(pi);
  return { pi, handlers, commands, tools, active, notifications, statuses, confirmations, selections, subagentRequests, setConfirmAnswer(value) { confirmAnswer = value; }, setSelectAnswer(value) { selectAnswer = value; }, ctx };
}

async function emit(mock, name, event, ctx = mock.ctx) {
  let result;
  for (const handler of mock.handlers.get(name) ?? []) result = await handler(event, ctx);
  return result;
}

// Manual mode is enabled by callers that need workflow operations; no runtime fixture
// is needed merely to exercise foreground prompt injection.
async function startWithWorkflow(mock) {
  await emit(mock, "session_start", { reason: "startup" });
}

test("unfinished workflows are session-scoped, cleaned on exit, and never offered for recovery", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-session-scope-"));
  const workflowId = `session-scope-${Date.now()}`;
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  const workflow = mock.tools.get("development_workflow");
  const legacyWorkplan = path.join(workdir, ".pi", "workplans", `${workflowId}.md`);
  try {
    await emit(mock, "session_start", { reason: "startup" });
    await workflow.execute("start", { action: "start", workflowId, goal: "session-only workflow" }, undefined, undefined, mock.ctx);
    await fs.promises.mkdir(path.dirname(legacyWorkplan), { recursive: true });
    await writeFile(legacyWorkplan, "legacy recovery artifact");

    await emit(mock, "session_shutdown", { reason: "quit" });
    assert.equal(await workflowStateModule.loadState(workflowId), undefined, "session exit removes unfinished workflow state");
    assert.equal(fs.existsSync(legacyWorkplan), false, "session exit removes a legacy in-progress workplan");
    assert.equal(mock.subagentRequests.at(-1)?.action, "closeWorkflow", "session exit closes workflow-scoped child sessions");
    assert.equal(mock.commands.has("workflow-recover"), false, "the recovery command is not registered");

    await workflowStateModule.saveState(workflowStateModule.createState({ id: workflowId, goal: "orphan", repositoryRoot: workdir }));
    const replacement = createMockPi();
    replacement.ctx.cwd = workdir;
    await emit(replacement, "session_start", { reason: "startup" });
    assert.equal(replacement.selections.length, 0, "startup never prompts for an unfinished workflow");
    await assert.rejects(replacement.tools.get("development_workflow").execute("status", { action: "status", workflowId }, undefined, undefined, replacement.ctx), /not active in this foreground session/);
  } finally {
    setActiveWorkflowIds([]);
    await workflowStateModule.removeState(workflowId).catch(() => undefined);
    await rm(workdir, { recursive: true, force: true });
  }
});

test("status uses cloned cached reads, suppresses repeated state loads, and reloads at lifecycle boundaries", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-cache-status-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  const workflowId = `cache-status-${Date.now()}`;
  const workflow = mock.tools.get("development_workflow");
  const originalReadFile = fs.promises.readFile;
  try {
    await workflow.execute("start", { action: "start", workflowId, goal: "cached" }, undefined, undefined, mock.ctx);
    // Hot reload preserves the process-local workflow while rebuilding its cache.
    await emit(mock, "session_shutdown", { reason: "reload" });
    let reads = 0;
    fs.promises.readFile = async (...args) => {
      if (args[0] === workflowStateModule.statePath(workflowId)) reads++;
      return originalReadFile.apply(fs.promises, args);
    };
    await emit(mock, "session_start", { reason: "reload" });
    const first = await workflow.execute("status-1", { action: "status", workflowId }, undefined, undefined, mock.ctx);
    first.details.goal = "caller mutation";
    const second = await workflow.execute("status-2", { action: "status", workflowId }, undefined, undefined, mock.ctx);
    assert.equal(second.details.goal, "cached", "returned status values cannot mutate cache");
    assert.equal(reads, 1, "reload reads active state once; repeated status performs no state load");

    const changed = await workflowStateModule.loadState(workflowId);
    changed.goal = "after-reload";
    await workflowStateModule.saveState(changed);
    assert.equal((await workflow.execute("status-stale", { action: "status", workflowId }, undefined, undefined, mock.ctx)).details.goal, "cached");
    await emit(mock, "session_shutdown", { reason: "reload" });
    await emit(mock, "session_start", { reason: "reload" });
    assert.equal((await workflow.execute("status-reloaded", { action: "status", workflowId }, undefined, undefined, mock.ctx)).details.goal, "after-reload", "reload clears cached state without recovering another session");
  } finally {
    fs.promises.readFile = originalReadFile;
    await workflowStateModule.removeState(workflowId);
    await rm(workdir, { recursive: true, force: true });
  }
});

test("failed durable creation and retirement never leave stale workflow cache entries", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-cache-commit-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  const workflow = mock.tools.get("development_workflow");
  const failedId = `cache-failed-${Date.now()}`;
  const mutationId = `${failedId}-mutation`;
  const retiredId = `${failedId}-retired`;
  const originalRename = fs.promises.rename;
  try {
    fs.promises.rename = async (...args) => {
      if (String(args[1]) === workflowStateModule.statePath(failedId)) throw new Error("durable commit failed");
      return originalRename.apply(fs.promises, args);
    };
    await assert.rejects(workflow.execute("failed-start", { action: "start", workflowId: failedId, goal: "must not cache" }, undefined, undefined, mock.ctx), /durable commit failed/);
    fs.promises.rename = originalRename;
    await assert.rejects(workflow.execute("failed-status", { action: "status", workflowId: failedId }, undefined, undefined, mock.ctx), /not active in this foreground session/);

    await workflow.execute("mutation-start", { action: "start", workflowId: mutationId, goal: "pre-warmed" }, undefined, undefined, mock.ctx);
    assert.equal((await workflow.execute("mutation-warm", { action: "status", workflowId: mutationId }, undefined, undefined, mock.ctx)).details.stage, "red_testing");
    fs.promises.rename = async (...args) => {
      if (String(args[1]) === workflowStateModule.statePath(mutationId)) throw new Error("mutation commit failed");
      return originalRename.apply(fs.promises, args);
    };
    await assert.rejects(workflow.execute("mutation-fail", { action: "advance", workflowId: mutationId, stage: "testing" }, undefined, undefined, mock.ctx), /mutation commit failed/);
    fs.promises.rename = originalRename;
    assert.equal((await workflow.execute("mutation-cached", { action: "status", workflowId: mutationId }, undefined, undefined, mock.ctx)).details.stage, "red_testing", "failed transaction cannot poison a pre-warmed cached snapshot");

    await workflow.execute("retired-start", { action: "start", workflowId: retiredId, goal: "retire" }, undefined, undefined, mock.ctx);
    assert.ok((await workflow.execute("retired-list-warm", { action: "status" }, undefined, undefined, mock.ctx)).details.some(state => state.id === retiredId), "retired workflow is initially present in cached list");
    const terminal = await workflowStateModule.loadState(retiredId);
    terminal.stage = "aborted";
    await workflowStateModule.saveState(terminal);
    await workflow.execute("retire", { action: "close", workflowId: retiredId }, undefined, undefined, mock.ctx);
    await assert.rejects(workflow.execute("retired-status", { action: "status", workflowId: retiredId }, undefined, undefined, mock.ctx), /not active in this foreground session/, "successful retirement removes session membership");
    assert.equal((await workflow.execute("retired-list", { action: "status" }, undefined, undefined, mock.ctx)).details.some(state => state.id === retiredId), false, "successful retirement invalidates cached list membership");
  } finally {
    fs.promises.rename = originalRename;
    await workflowStateModule.removeState(failedId);
    await workflowStateModule.removeState(mutationId);
    await workflowStateModule.removeState(retiredId);
    const failedBases = [failedId, mutationId].map(id => path.basename(workflowStateModule.statePath(id)));
    for (const name of await fs.promises.readdir(path.dirname(workflowStateModule.statePath(failedId)))) {
      if (failedBases.some(base => name.startsWith(`${base}.`)) && name.endsWith(".tmp")) await fs.promises.rm(path.join(path.dirname(workflowStateModule.statePath(failedId)), name), { force: true });
    }
    await rm(workdir, { recursive: true, force: true });
  }
});

test("bounded foreground triggers activate workflow before prompt construction for one run", async () => {
  const inheritedSubagentId = process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_ID;
  setWfMode(false);
  const mock = createMockPi();
  await emit(mock, "session_start", { reason: "startup" });
  try {
    assert.equal(mock.active.has("development_workflow"), false);
    assert.equal(mock.tools.has("request_workflow_bypass"), false, "obsolete bypass tool is not registered");
    assert.equal(await emit(mock, "before_agent_start", { systemPrompt: "base" }), undefined);
    for (const text of ["Use DEV WORKFLOW for this", "please start the Development Workflow", "Run the SDLC process"]) {
      await emit(mock, "input", { text, source: "interactive" });
      assert.match((await emit(mock, "before_agent_start", { systemPrompt: "base" })).systemPrompt, /development-workflow Orchestrator/, text);
      assert.equal(mock.active.has("development_workflow"), true, "trigger activates the tool before the prompt");
      await emit(mock, "agent_start", {});
      await emit(mock, "agent_settled", {});
      assert.equal(mock.active.has("development_workflow"), false, "activation lasts one foreground run");
    }
    for (const text of ["sdlcs are useful", "development workflows are useful", "mydev workflow", "sdlc_guide"]) {
      await emit(mock, "input", { text, source: "interactive" });
      assert.equal(await emit(mock, "before_agent_start", { systemPrompt: "base" }), undefined, text);
    }
    await emit(mock, "input", { text: "use sdlc", source: "interactive" });
    assert.equal(mock.active.has("development_workflow"), true);
    await emit(mock, "input", { text: "use sdlc", source: "extension" });
    assert.equal(mock.active.has("development_workflow"), false, "extension input clears active transient tools");
    assert.equal(await emit(mock, "before_agent_start", { systemPrompt: "base" }), undefined, "extension input cannot activate workflow");
    for (const streamingBehavior of ["steer", "followUp"]) {
      await emit(mock, "input", { text: "use sdlc", source: "interactive" });
      assert.equal(mock.active.has("development_workflow"), true);
      await emit(mock, "input", { text: "use sdlc", source: "interactive", streamingBehavior });
      assert.equal(mock.active.has("development_workflow"), false, `${streamingBehavior} input clears active transient tools`);
      assert.equal(await emit(mock, "before_agent_start", { systemPrompt: "base" }), undefined, `${streamingBehavior} input cannot activate workflow`);
    }
    // A trigger that is handled or fails preflight never promotes into a later run.
    await emit(mock, "input", { text: "use sdlc", source: "interactive" });
    await emit(mock, "input", { text: "ordinary request", source: "interactive" });
    assert.equal(mock.active.has("development_workflow"), false, "replaced pending activation removes the active tool");
    assert.equal(await emit(mock, "before_agent_start", { systemPrompt: "base" }), undefined, "replaced pending activation cannot leak");
    await emit(mock, "input", { text: "use sdlc", source: "interactive" });
    await emit(mock, "before_agent_start", { systemPrompt: "base" });
    await emit(mock, "input", { text: "ordinary request", source: "interactive" });
    assert.equal(mock.active.has("development_workflow"), false, "failed preflight activation removes the active tool");
    assert.equal(await emit(mock, "before_agent_start", { systemPrompt: "base" }), undefined, "failed preflight activation cannot leak");
  } finally {
    setWfMode(false);
    if (inheritedSubagentId === undefined) delete process.env.PI_SUBAGENT_ID;
    else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
  }
});

test("before_agent_start injects role-specific prompt for workflow child sessions", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-role-prompt-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  await startWithWorkflow(mock, workdir);

  // Normal foreground session gets the Orchestrator prompt (currentId is now set)
  const foregroundPrompt = await emit(mock, "before_agent_start", { systemPrompt: "base system" });
  assert.match(foregroundPrompt.systemPrompt, /development-workflow Orchestrator/);

  // Set PI_SUBAGENT_ID for workflow child sessions
  process.env.PI_SUBAGENT_ID = `workflow-test123:planner`; process.env.PI_WORKFLOW_ID = "test123"; process.env.PI_WORKFLOW_ROLE = "planner";
  const plannerPrompt = await emit(mock, "before_agent_start", { systemPrompt: "base system" });
  assert.match(plannerPrompt.systemPrompt, /Planner/);
  assert.match(plannerPrompt.systemPrompt, /Read and search only/);

  // Workflow child session with reviewer role
  process.env.PI_SUBAGENT_ID = `workflow-test123:reviewer`; process.env.PI_WORKFLOW_ROLE = "reviewer";
  const reviewerPrompt = await emit(mock, "before_agent_start", { systemPrompt: "base system" });
  assert.match(reviewerPrompt.systemPrompt, /Reviewer/);
  assert.match(reviewerPrompt.systemPrompt, /read-only Reviewer/);

  // Workflow child session with reporter role
  process.env.PI_SUBAGENT_ID = `workflow-test123:reporter`; process.env.PI_WORKFLOW_ROLE = "reporter";
  const reporterPrompt = await emit(mock, "before_agent_start", { systemPrompt: "base system" });
  assert.match(reporterPrompt.systemPrompt, /Reporter/);

  // Unknown role falls through to default behavior (Orchestrator prompt)
  process.env.PI_SUBAGENT_ID = `workflow-test123:unknown-role`; process.env.PI_WORKFLOW_ROLE = "unknown-role";
  const unknownPrompt = await emit(mock, "before_agent_start", { systemPrompt: "base system" });
  assert.match(unknownPrompt.systemPrompt, /development-workflow Orchestrator/);

  // Non-workflow child session falls through to default
  process.env.PI_SUBAGENT_ID = `session-123:agent1`; delete process.env.PI_WORKFLOW_ID; delete process.env.PI_WORKFLOW_ROLE;
  const nonWorkflowPrompt = await emit(mock, "before_agent_start", { systemPrompt: "base system" });
  assert.match(nonWorkflowPrompt.systemPrompt, /development-workflow Orchestrator/);

  // Restore original env and clean up
  resetWorkflowMode();
  if (originalSubagentId !== undefined) process.env.PI_SUBAGENT_ID = originalSubagentId;
  await rm(workdir, { recursive: true, force: true });
});

test("tool_call allows development_workflow from workflow-scoped child sessions even when disabled", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-child-access-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  await startWithWorkflow(mock, workdir);
  const workflow = mock.tools.get("development_workflow");
  const workflowId = `workflow-child-access-${Date.now()}`;
  await workflow.execute("start", { action: "start", workflowId, goal: "child access" }, undefined, undefined, mock.ctx);

  // With workflow mode enabled (default), the tool is allowed for everyone
  delete process.env.PI_SUBAGENT_ID;
  const allowedResult = await emit(mock, "tool_call", { toolName: "development_workflow" });
  assert.equal(allowedResult, undefined, "Should be allowed when workflow mode is enabled");

  // Disable workflow mode
  await mock.commands.get("workflow-disable").handler("", mock.ctx);

  // Normal foreground session is blocked
  delete process.env.PI_SUBAGENT_ID;
  const blockedResult = await emit(mock, "tool_call", { toolName: "development_workflow" });
  assert.ok(blockedResult);
  assert.equal(blockedResult.block, true, "Should block non-child sessions when disabled");

  // Workflow-scoped child session is STILL allowed even when disabled
  process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:planner`; process.env.PI_WORKFLOW_ID = workflowId; process.env.PI_WORKFLOW_ROLE = "planner";
  const childResult = await emit(mock, "tool_call", { toolName: "development_workflow", input: { action: "status", workflowId } });
  assert.equal(childResult, undefined, "Should allow an owned workflow child action when disabled");
  await assert.doesNotReject(workflow.execute("child-status", { action: "status", workflowId }, undefined, undefined, mock.ctx), "workflow child execution remains available");
  const crossWorkflow = await emit(mock, "tool_call", { toolName: "development_workflow", input: { action: "status", workflowId: "workflow-other" } });
  assert.deepEqual(crossWorkflow, { block: true, reason: "Workflow children may access only their own workflowId." });
  await assert.rejects(workflow.execute("cross-workflow", { action: "status", workflowId: "workflow-other" }, undefined, undefined, mock.ctx), /only their own workflowId/);
  await assert.rejects(workflow.execute("child-start", { action: "start", workflowId, goal: "forbidden" }, undefined, undefined, mock.ctx), /may not perform start actions/);
  await assert.doesNotReject(workflow.execute("planner-record", { action: "record", workflowId, agentId: "planner", plan: "approved plan" }, undefined, undefined, mock.ctx));
  await assert.rejects(workflow.execute("wrong-agent", { action: "record", workflowId, agentId: "implementer", plan: "forbidden" }, undefined, undefined, mock.ctx), /require agentId=planner/);
  await assert.rejects(workflow.execute("wrong-field", { action: "record", workflowId, agentId: "planner", implementationSummary: "forbidden" }, undefined, undefined, mock.ctx), /may not record implementationSummary/);
  process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:reporter`; process.env.PI_WORKFLOW_ROLE = "reporter";
  await assert.rejects(workflow.execute("child-complete", { action: "complete", workflowId }, undefined, undefined, mock.ctx), /may not perform complete actions/);

  // Non-workflow child session is still blocked
  process.env.PI_SUBAGENT_ID = `session-xyz:agent1`; delete process.env.PI_WORKFLOW_ID; delete process.env.PI_WORKFLOW_ROLE;
  const otherChildResult = await emit(mock, "tool_call", { toolName: "development_workflow" });
  assert.ok(otherChildResult);
  assert.equal(otherChildResult.block, true, "Non-workflow child sessions should be blocked when disabled");

  // Restore and clean up
  resetWorkflowMode();
  await workflowStateModule.removeState(workflowId);
  await rm(workdir, { recursive: true, force: true });
});

test("workflow start stores roleConfig and maxReviewCycles on state", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-role-config-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  await startWithWorkflow(mock, workdir);

  const workflowId = `role-config-test-${Date.now()}`;
  const workflow = mock.tools.get("development_workflow");
  const result = await workflow.execute("start", {
    action: "start",
    workflowId,
    goal: "Test role config storage",
    maxReviewCycles: 2,
  }, undefined, undefined, mock.ctx);

  const state = result.details;
  assert.ok(state.roleConfig, "roleConfig should be stored on state");
  assert.equal(state.roleConfig.planner, undefined, "new workflows omit Planner config");
  assert.equal(state.roleConfig.implementer.thinking, "medium");
  assert.equal(state.roleConfig.reviewer.thinking, "medium");
  assert.equal(state.roleConfig.reviewer.model, "openai-codex/gpt-5.6-sol");
  assert.equal(state.roleConfig["test-writer"].thinking, "low");
  assert.equal(state.roleConfig.reporter.thinking, "low");
  assert.equal(state.review.maxReviewCycles, 2);

  // Cleanup
  await workflowStateModule.removeState(workflowId);
  await rm(workdir, { recursive: true, force: true });
});

test("registered schema validates maxReviewCycles and persists its configured value", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-max-cycles-schema-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  await startWithWorkflow(mock);
  const workflow = mock.tools.get("development_workflow");
  const workflowId = `schema-max-cycles-${Date.now()}`;
  const toolCall = input => ({ type: "toolCall", id: "schema-test", name: "development_workflow", arguments: input });
  try {
    const valid = validateToolArguments(workflow, toolCall({ action: "start", workflowId, goal: "Validate public schema", maxReviewCycles: 2 }));
    assert.equal(valid.maxReviewCycles, 2);
    for (const value of [0, -1, 1.5]) {
      try { validateToolArguments(workflow, toolCall({ action: "start", goal: "Invalid cycle count", maxReviewCycles: value })); }
      catch (error) { assert.match(error.message, /Validation failed/); continue; }
      assert.fail(`schema accepted invalid maxReviewCycles: ${value}`);
    }
    const result = await workflow.execute("start", valid, undefined, undefined, mock.ctx);
    assert.equal(result.details.review.maxReviewCycles, 2);
    assert.equal((await workflowStateModule.loadState(workflowId)).review.maxReviewCycles, 2, "validated configured value persists");
  } finally {
    await workflowStateModule.removeState(workflowId);
    await rm(workdir, { recursive: true, force: true });
  }
});

test("default maxReviewCycles escalates critical findings after two rounds", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-default-cycles-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  await startWithWorkflow(mock);
  const workflow = mock.tools.get("development_workflow");
  const workflowId = `default-max-cycles-${Date.now()}`;
  try {
    const start = await workflow.execute("start", { action: "start", workflowId, goal: "Preserve default review cycle behavior" }, undefined, undefined, mock.ctx);
    assert.equal(start.details.review.maxReviewCycles, 2);
    for (const stage of ["testing", "reviewing"]) await workflow.execute("advance", { action: "advance", workflowId, stage }, undefined, undefined, mock.ctx);
    for (let cycle = 1; cycle <= 2; cycle++) {
      const result = await workflow.execute("routeReview", { action: "routeReview", workflowId, findings: [{ category: "must_fix", title: `Fix ${cycle}` }] }, undefined, undefined, mock.ctx);
      if (cycle < 2) {
        assert.equal(result.details.stage, "fixing");
        await workflow.execute("advance", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx);
        await workflow.execute("advance", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, mock.ctx);
      } else {
        assert.equal(result.details.stage, "reviewing");
        assert.ok(result.details.review.escalation?.recoverable);
      }
    }
  } finally {
    await workflowStateModule.removeState(workflowId);
    await rm(workdir, { recursive: true, force: true });
  }
});

test("successful completion correlation is bounded and clears on ended runs and shutdown", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-completion-correlation-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  const ids = [`completion-old-${Date.now()}`, `completion-new-${Date.now()}`, `completion-agent-end-${Date.now()}`, `completion-shutdown-${Date.now()}`, `completion-error-${Date.now()}`];
  const completed = async id => {
    const state = workflowStateModule.createState({ id, goal: "completion correlation", repositoryRoot: workdir });
    state.stage = "completed";
    await workflowStateModule.saveState(state);
    return state;
  };
  const resultMessage = (callId, state) => ({ message: { role: "toolResult", toolName: "development_workflow", toolCallId: callId, isError: false, details: state } });
  const tick = () => new Promise(resolve => setTimeout(resolve, 100));
  try {
    const [oldState, newState, endedState, shutdownState, errorState] = await Promise.all(ids.map(completed));
    // 257 successful results prove FIFO eviction without relying on internal state.
    for (let index = 0; index <= 256; index++) await emit(mock, "tool_result", { toolName: "development_workflow", toolCallId: `cap-${index}`, input: { action: "complete" }, isError: false });
    await emit(mock, "tool_result", { toolName: "development_workflow", toolCallId: "old", input: { action: "complete" }, isError: false });
    await emit(mock, "message_end", resultMessage("cap-0", oldState));
    await tick();
    assert.ok(await workflowStateModule.loadState(ids[0]), "evicted completion candidates cannot auto-close");
    await emit(mock, "tool_result", { toolName: "development_workflow", toolCallId: "new", input: { action: "complete" }, isError: false });
    await emit(mock, "message_end", resultMessage("new", newState));
    await tick();
    assert.equal(await workflowStateModule.loadState(ids[1]), undefined, "a successful complete result auto-closes after its message");

    await emit(mock, "tool_result", { toolName: "development_workflow", toolCallId: "ended", input: { action: "complete" }, isError: false });
    await emit(mock, "agent_end", {});
    await emit(mock, "message_end", resultMessage("ended", endedState));
    await tick();
    assert.ok(await workflowStateModule.loadState(ids[2]), "agent end clears canceled-run completion candidates");

    await emit(mock, "tool_result", { toolName: "development_workflow", toolCallId: "shutdown", input: { action: "complete" }, isError: false });
    await emit(mock, "session_shutdown", { reason: "reload" });
    await emit(mock, "message_end", resultMessage("shutdown", shutdownState));
    await tick();
    assert.ok(await workflowStateModule.loadState(ids[3]), "session shutdown clears completion candidates");

    await emit(mock, "tool_result", { toolName: "development_workflow", toolCallId: "error", input: { action: "complete" }, isError: true });
    await emit(mock, "message_end", resultMessage("error", errorState));
    await tick();
    assert.ok(await workflowStateModule.loadState(ids[4]), "failed complete calls are never tracked");
  } finally {
    resetWorkflowMode();
    await Promise.all(ids.map(id => workflowStateModule.removeState(id)));
    await rm(workdir, { recursive: true, force: true });
  }
});

test("workflow role maxTokens is forwarded to workflow-scoped subagent calls without replacing explicit overrides", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-role-max-tokens-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  const workflowId = `role-max-tokens-${Date.now()}`;
  const workflow = mock.tools.get("development_workflow");
  try {
    await workflow.execute("start", { action: "start", workflowId, goal: "forward role token limit" }, undefined, undefined, mock.ctx);
    const workflowCall = { toolName: "subagent", input: { lifecycle: "workflow", workflowId, agentId: "implementer" } };
    await emit(mock, "tool_call", workflowCall);
    assert.equal(workflowCall.input.workflowMaxTokens, 32768);

    const explicitCall = { toolName: "subagent", input: { lifecycle: "workflow", workflowId, agentId: "reviewer", maxTokens: 4096 } };
    await emit(mock, "tool_call", explicitCall);
    assert.equal(explicitCall.input.workflowMaxTokens, undefined, "explicit child override retains precedence");
  } finally {
    await workflowStateModule.removeState(workflowId);
    await rm(workdir, { recursive: true, force: true });
  }
});

test("workflow role thinking is validated, forwarded on every workflow dispatch, and preserves explicit and terminal calls", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-role-thinking-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  const workflowId = `role-thinking-${Date.now()}`;
  const workflow = mock.tools.get("development_workflow");
  try {
    await workflow.execute("start", { action: "start", workflowId, goal: "forward role thinking" }, undefined, undefined, mock.ctx);
    const persisted = await workflowStateModule.loadState(workflowId);
    persisted.roleConfig.implementer.thinking = "medium";
    await workflowStateModule.saveState(persisted);
    for (const input of [
      { lifecycle: "workflow", workflowId, agentId: "implementer" },
      { lifecycle: "workflow", workflowId, agentId: "implementer" },
    ]) {
      await emit(mock, "tool_call", { toolName: "subagent", input });
      assert.equal(input.thinking, "medium", "valid persisted role thinking is forwarded for initial and resumed dispatches without using the fallback");
    }
    const explicit = { lifecycle: "workflow", workflowId, agentId: "implementer", thinking: "off" };
    await emit(mock, "tool_call", { toolName: "subagent", input: explicit });
    assert.equal(explicit.thinking, "off", "explicit per-call thinking wins, including off");

    const terminal = { agent: "implementer", task: "one-shot terminal task" };
    await emit(mock, "tool_call", { toolName: "subagent", input: terminal });
    assert.equal(terminal.thinking, undefined, "terminal calls do not receive workflow role thinking");

    const state = await workflowStateModule.loadState(workflowId);
    state.roleConfig.implementer.thinking = "invalid";
    await writeFile(workflowStateModule.statePath(workflowId), JSON.stringify(state));
    const invalidPersisted = { lifecycle: "workflow", workflowId, agentId: "implementer" };
    await emit(mock, "tool_call", { toolName: "subagent", input: invalidPersisted });
    assert.equal(invalidPersisted.thinking, "medium", "invalid persisted thinking never reaches child dispatch and uses the approved Implementer default");
  } finally {
    await workflowStateModule.removeState(workflowId);
    await rm(workdir, { recursive: true, force: true });
  }
});

test("workflow state rejects invalid persisted role thinking", () => {
  const state = workflowStateModule.createState({ id: `invalid-role-thinking-${Date.now()}`, goal: "validate thinking", repositoryRoot: process.cwd() });
  state.roleConfig = { implementer: { thinking: "invalid", maxTokens: 1 } };
  assert.throws(() => workflowStateModule.migrateState(state), /roleConfig\.implementer is invalid/);
});

test("routeReview clears reviewer file ownership when transitioning to fixing", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-file-lock-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  await startWithWorkflow(mock, workdir);

  const workflowId = `file-lock-test-${Date.now()}`;
  const workflow = mock.tools.get("development_workflow");

  // Start at implementing and advance through testing → reviewing
  await workflow.execute("start", { action: "start", workflowId, goal: "test file lock release" }, undefined, undefined, mock.ctx);
  await workflow.execute("advance", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx);
  await workflow.execute("advance", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, mock.ctx);

  // Record some files owned by reviewer
  await workflow.execute("record", {
    action: "record",
    workflowId,
    agentId: "reviewer",
    files: ["file1.ts", "file2.ts"],
  }, undefined, undefined, mock.ctx);

  const statusBefore = await workflow.execute("status", { action: "status", workflowId }, undefined, undefined, mock.ctx);
  const stateBefore = statusBefore.details;
  assert.ok(stateBefore.filesOwned["reviewer"], "reviewer should have file ownership before routeReview");

  // Route review with required findings → should transition to fixing and clear reviewer ownership
  await workflow.execute("routeReview", {
    action: "routeReview",
    workflowId,
    findings: [{ category: "must_fix", title: "Fix this" }],
  }, undefined, undefined, mock.ctx);

  const statusAfter = await workflow.execute("status", { action: "status", workflowId }, undefined, undefined, mock.ctx);
  const stateAfter = statusAfter.details;
  assert.equal(stateAfter.stage, "fixing", "Should be in fixing stage");
  assert.equal(stateAfter.filesOwned["reviewer"], undefined, "Reviewer file ownership should be cleared");

  // Cleanup
  await workflowStateModule.removeState(workflowId);
  await rm(workdir, { recursive: true, force: true });
});

test("terminal state notifications fire on complete/block/abort", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-notifications-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  await startWithWorkflow(mock, workdir);

  const workflowId = `notify-test-${Date.now()}`;
  const workflow = mock.tools.get("development_workflow");

  // Start a workflow and complete it
  await workflow.execute("start", { action: "start", workflowId, goal: "test notifications" }, undefined, undefined, mock.ctx);
  await workflow.execute("advance", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx);
  await workflow.execute("advance", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, mock.ctx);
  await workflow.execute("routeReview", {
    action: "routeReview",
    workflowId,
    findings: [{ category: "approved", title: "All good" }],
  }, undefined, undefined, mock.ctx);

  // Complete - should fire success notification
  const notificationsBefore = mock.notifications.length;
  await workflow.execute("complete", { action: "complete", workflowId }, undefined, undefined, mock.ctx);
  const completeNotification = mock.notifications.find(n => n.message.includes("completed") && n.level === "success");
  assert.ok(completeNotification, "Should notify on complete");

  // Block - should fire error notification
  const workflowId2 = `notify-test-${Date.now()}-2`;
  await workflow.execute("start", { action: "start", workflowId: workflowId2, goal: "test block" }, undefined, undefined, mock.ctx);
  await workflow.execute("block", { action: "block", workflowId: workflowId2, reason: "Test block reason" }, undefined, undefined, mock.ctx);
  const blockNotification = mock.notifications.find(n => n.message.includes("blocked") && n.level === "error");
  assert.ok(blockNotification, "Should notify on block");

  // Abort - should fire warning notification
  const workflowId3 = `notify-test-${Date.now()}-3`;
  await workflow.execute("start", { action: "start", workflowId: workflowId3, goal: "test abort" }, undefined, undefined, mock.ctx);
  await workflow.execute("abort", { action: "abort", workflowId: workflowId3, reason: "Test abort" }, undefined, undefined, mock.ctx);
  const abortNotification = mock.notifications.find(n => n.message.includes("aborted") && n.level === "warning");
  assert.ok(abortNotification, "Should notify on abort");

  // Cleanup
  await workflowStateModule.removeState(workflowId);
  await workflowStateModule.removeState(workflowId2);
  await workflowStateModule.removeState(workflowId3);
  await rm(workdir, { recursive: true, force: true });
});

test("terminal notifications are transition-aware for review exhaustion and workflow-abort", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-terminal-transitions-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  await startWithWorkflow(mock, workdir);
  const workflow = mock.tools.get("development_workflow");
  const prefix = `terminal-transition-${Date.now()}`;
  const directId = `${prefix}-direct`;
  const exhaustedId = `${prefix}-exhausted`;
  const abortId = `${prefix}-abort`;
  try {
    await workflow.execute("start", { action: "start", workflowId: directId, goal: "direct notification" }, undefined, undefined, mock.ctx);
    await workflow.execute("block", { action: "block", workflowId: directId, reason: "Direct block" }, undefined, undefined, mock.ctx);
    const directNotifications = () => mock.notifications.filter(n => n.message.includes(directId));
    assert.equal(directNotifications().length, 1, "a direct terminal transition notifies exactly once");
    await workflow.execute("record", { action: "record", workflowId: directId, plan: "retained blocked workflow detail" }, undefined, undefined, mock.ctx);
    assert.equal(directNotifications().length, 1, "recording a blocked workflow does not repeat its terminal notification");

    await workflow.execute("start", { action: "start", workflowId: exhaustedId, goal: "review exhaustion", maxReviewCycles: 1 }, undefined, undefined, mock.ctx);
    for (const stage of ["testing", "reviewing"]) await workflow.execute("advance", { action: "advance", workflowId: exhaustedId, stage }, undefined, undefined, mock.ctx);
    await workflow.execute("routeReview", { action: "routeReview", workflowId: exhaustedId, findings: [{ category: "must_fix", title: "Required" }] }, undefined, undefined, mock.ctx);
    const exhaustionNotifications = mock.notifications.filter(n => n.message.includes(exhaustedId) && n.level === "error");
    assert.equal(exhaustionNotifications.length, 0, "recoverable review escalation is not a terminal error notification");
    assert.ok((await workflowStateModule.loadState(exhaustedId)).review.escalation?.recoverable);

    await workflow.execute("start", { action: "start", workflowId: abortId, goal: "command abort" }, undefined, undefined, mock.ctx);
    await mock.commands.get("workflow-abort").handler(abortId, mock.ctx);
    assert.equal((await workflowStateModule.loadState(abortId)).blockingReason, "Aborted by command", "command records its abort reason");
    await mock.commands.get("workflow-abort").handler(abortId, mock.ctx);
    const abortNotifications = mock.notifications.filter(n => n.message.includes(abortId) && n.level === "warning");
    assert.equal(abortNotifications.length, 1, "repeated workflow-abort does not duplicate notification");

    const headless = createMockPi();
    headless.ctx.cwd = workdir;
    headless.ctx.hasUI = false;
    headless.ctx.ui.notify = () => { throw new Error("headless terminal transitions must not notify"); };
    const headlessId = `${prefix}-headless`;
    await headless.tools.get("development_workflow").execute("start", { action: "start", workflowId: headlessId, goal: "headless" }, undefined, undefined, headless.ctx);
    await headless.tools.get("development_workflow").execute("block", { action: "block", workflowId: headlessId, reason: "No UI" }, undefined, undefined, headless.ctx);
    await headless.commands.get("workflow-abort").handler(headlessId, headless.ctx);
  } finally {
    resetWorkflowMode();
    await Promise.all([directId, exhaustedId, abortId, `${prefix}-headless`].map(id => workflowStateModule.removeState(id)));
    await rm(workdir, { recursive: true, force: true });
  }
});

test("in-progress and blocked workflows do not create local workplan documents", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-no-local-workplan-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  const workflow = mock.tools.get("development_workflow");
  const workflowId = `no-local-workplan-${Date.now()}`;
  try {
    await workflow.execute("start", { action: "start", workflowId, goal: "no recovery document" }, undefined, undefined, mock.ctx);
    assert.equal(fs.existsSync(path.join(workdir, ".pi", "workplans", `${workflowId}.md`)), false);
    await workflow.execute("block", { action: "block", workflowId, reason: "blocked without workplan" }, undefined, undefined, mock.ctx);
    assert.equal((await workflowStateModule.loadState(workflowId)).stage, "blocked");
    assert.equal(fs.existsSync(path.join(workdir, ".pi", "workplans")), false, "no .pi/workplans directory is created");
    assert.equal(mock.notifications.filter(n => n.message.includes(workflowId) && n.level === "error").length, 1);
  } finally {
    resetWorkflowMode();
    await workflowStateModule.removeState(workflowId);
    await rm(workdir, { recursive: true, force: true });
  }
});

test("role config module exports correct defaults", async () => {
  const rolesPath = fileURLToPath(new URL("./roles.ts", import.meta.url));
  const rolesModule = await jiti.import(rolesPath, { default: true });

  // Test getRoleConfig
  const planner = rolesModule.getRoleConfig("planner");
  assert.equal(planner.name, "planner");
  assert.equal(planner.thinking, "high");
  assert.equal(planner.readOnly, true);

  const reviewer = rolesModule.getRoleConfig("reviewer");
  assert.equal(reviewer.thinking, "medium");
  assert.equal(reviewer.model, "openai-codex/gpt-5.6-sol");
  assert.equal(reviewer.readOnly, true);

  const implementer = rolesModule.getRoleConfig("implementer");
  assert.equal(implementer.thinking, "medium");
  assert.equal(implementer.readOnly, false);

  assert.equal(rolesModule.getRoleConfig("test-writer").thinking, "low");
  assert.equal(rolesModule.getRoleConfig("reporter").thinking, "low");

  // Test error on unknown role
  assert.throws(() => rolesModule.getRoleConfig("nonexistent"), /Unknown workflow role/);
});

test("stale workflow warnings use valid expirations, deduplicate, reset on reload, and stay headless-safe", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-expiration-ui-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  const workflow = mock.tools.get("development_workflow");
  const prefix = `expiration-${Date.now()}`;
  const ids = {
    future: `${prefix}-future`,
    expired: `${prefix}-expired`,
    malformed: `${prefix}-malformed`,
    missing: `${prefix}-missing`,
    headless: `${prefix}-headless`,
  };
  const now = Date.now();
  const future = new Date(now + 60_000).toISOString();
  const expiredAtNow = new Date(now).toISOString();
  const expired = new Date(now - 60_000).toISOString();
  try {
    assert.equal(workflowStateModule.isWorkflowExpired(expiredAtNow, now), true, "expiration at now is stale");
    assert.equal(workflowStateModule.isWorkflowExpired(future, now), false, "future expiration is not stale");
    assert.equal(workflowStateModule.isWorkflowExpired("not-a-timestamp", now), false, "malformed expiration is not stale");
    assert.equal(workflowStateModule.isWorkflowExpired(undefined, now), false, "missing expiration is not stale");

    await emit(mock, "session_start", { reason: "startup" });
    const futureResult = await workflow.execute("start", { action: "start", workflowId: ids.future, goal: "future", expiresAt: future }, undefined, undefined, mock.ctx);
    const expiredResult = await workflow.execute("start", { action: "start", workflowId: ids.expired, goal: "expired", expiresAt: expired }, undefined, undefined, mock.ctx);
    await workflow.execute("start", { action: "start", workflowId: ids.malformed, goal: "malformed", expiresAt: "not-a-timestamp" }, undefined, undefined, mock.ctx);
    await workflow.execute("start", { action: "start", workflowId: ids.missing, goal: "missing" }, undefined, undefined, mock.ctx);
    assert.equal(futureResult.details.expiresAt, future, "start persists a future expiration");
    assert.equal(expiredResult.details.expiresAt, expired, "start persists an expired timestamp without mutating state");

    const warningCount = () => mock.notifications.filter(notification => notification.level === "warning" && notification.message.includes(ids.expired)).length;
    assert.equal(warningCount(), 1, "expired workflow notifies once when first observed");
    assert.match(mock.statuses.get("development-workflow-stale"), new RegExp(ids.expired));

    const futureStatus = await workflow.execute("status", { action: "status", workflowId: ids.future }, undefined, undefined, mock.ctx);
    const expiredStatus = await workflow.execute("status", { action: "status", workflowId: ids.expired }, undefined, undefined, mock.ctx);
    const malformedStatus = await workflow.execute("status", { action: "status", workflowId: ids.malformed }, undefined, undefined, mock.ctx);
    const missingStatus = await workflow.execute("status", { action: "status", workflowId: ids.missing }, undefined, undefined, mock.ctx);
    assert.match(futureStatus.content[0].text, new RegExp(`Expires: ${future}`));
    assert.doesNotMatch(futureStatus.content[0].text, /expired|invalid timestamp/);
    assert.match(expiredStatus.content[0].text, /Expires: .* \(expired\)/);
    assert.match(malformedStatus.content[0].text, /Expires: not-a-timestamp \(invalid timestamp\)/);
    assert.doesNotMatch(missingStatus.content[0].text, /Expires:/, "workflows without expiresAt retain their status output");
    const allStatus = await workflow.execute("status", { action: "status" }, undefined, undefined, mock.ctx);
    assert.match(allStatus.content[0].text, new RegExp(`${ids.expired}: [\\s\\S]*?Expires: .* \\(expired\\)`), "workflow list status marks valid expired timestamps");
    assert.equal(warningCount(), 1, "repeated status checks do not repeat stale notifications");

    await emit(mock, "session_shutdown", { reason: "reload" });
    await emit(mock, "session_start", { reason: "reload" });
    assert.equal(warningCount(), 2, "reload resets notification lifecycle without changing persisted state");
    assert.equal((await workflowStateModule.loadState(ids.expired)).expiresAt, expired, "warnings never mutate expiration state");

    const headless = createMockPi();
    headless.ctx.cwd = workdir;
    headless.ctx.hasUI = false;
    headless.ctx.ui.notify = () => { throw new Error("headless mode must not notify"); };
    await workflowStateModule.saveState({ ...workflowStateModule.createState({ id: ids.headless, goal: "headless", repositoryRoot: workdir }), expiresAt: expired });
    setActiveWorkflowIds([...activeWorkflowIds(), ids.headless]);
    await emit(headless, "session_start", { reason: "startup" });
    await headless.tools.get("development_workflow").execute("status", { action: "status", workflowId: ids.headless }, undefined, undefined, headless.ctx);
  } finally {
    resetWorkflowMode();
    await Promise.all(Object.values(ids).map(id => workflowStateModule.removeState(id)));
    await rm(workdir, { recursive: true, force: true });
  }
});

test("two-round quick-fix leftovers become warned follow-ups", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-review-warning-")); resetWorkflowMode();
  const mock = createMockPi(); mock.ctx.cwd = workdir; await startWithWorkflow(mock); const workflow = mock.tools.get("development_workflow"); const workflowId = `review-warning-${Date.now()}`;
  try {
    await workflow.execute("start", { action: "start", workflowId, goal: "cap warning" }, undefined, undefined, mock.ctx);
    await workflow.execute("legacy-testing", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx);
    await workflow.execute("review", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, mock.ctx);
    let result = await workflow.execute("round-1", { action: "routeReview", workflowId, findings: [{ category: "quick_fix", title: "small fix" }] }, undefined, undefined, mock.ctx);
    assert.equal(result.details.stage, "fixing");
    await workflow.execute("regreen", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx);
    await workflow.execute("rereview", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, mock.ctx);
    result = await workflow.execute("round-2", { action: "routeReview", workflowId, findings: [{ category: "quick_fix", title: "leftover" }] }, undefined, undefined, mock.ctx);
    assert.equal(result.details.stage, "reviewing"); assert.ok(result.details.review.escalation?.recoverable);
    await workflow.execute("resolve", { action: "resolveEscalation", workflowId, escalationChoice: "convert_noncritical_follow_up" }, undefined, undefined, mock.ctx);
    const resolved = await workflow.execute("status", { action: "status", workflowId }, undefined, undefined, mock.ctx);
    assert.equal(resolved.details.stage, "reporting"); assert.equal(resolved.details.review.needsMoreReview, true); assert.ok(resolved.details.followUps.some(f => f.title === "leftover"));
    await assert.rejects(workflow.execute("bad-report", { action: "report", workflowId, reporterContent: "All done." }, undefined, undefined, mock.ctx), /durable|could use more review passes/);
    await workflow.execute("good-report", { action: "report", workflowId, reporterContent: `${auditableReporterContent(resolved.details)}\nThe work could use more review passes.` }, undefined, undefined, mock.ctx);
  } finally { await workflowStateModule.removeState(workflowId); await rm(workdir, { recursive: true, force: true }); }
});

test("routeReview uses per-workflow maxReviewCycles for blocking", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-max-cycles-"));
  resetWorkflowMode();
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  await startWithWorkflow(mock, workdir);

  // Start with maxReviewCycles=2 (instead of default 3)
  const workflowId = `max-cycles-test-${Date.now()}`;
  const workflow = mock.tools.get("development_workflow");

  await workflow.execute("start", {
    action: "start",
    workflowId,
    goal: "test custom max review cycles",
    maxReviewCycles: 2,
  }, undefined, undefined, mock.ctx);

  await workflow.execute("advance", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx);
  await workflow.execute("advance", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, mock.ctx);

  // First review cycle with must_fix
  await workflow.execute("routeReview", {
    action: "routeReview",
    workflowId,
    findings: [{ category: "must_fix", title: "Fix A" }],
  }, undefined, undefined, mock.ctx);

  let status = await workflow.execute("status", { action: "status", workflowId }, undefined, undefined, mock.ctx);
  let state = status.details;
  assert.equal(state.stage, "fixing", "Should be in fixing after first cycle");
  assert.equal(state.review.cycleCount, 1);

  // Advance back to reviewing and route another review with must_fix
  await workflow.execute("advance", { action: "advance", workflowId, stage: "testing" }, undefined, undefined, mock.ctx);
  await workflow.execute("advance", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, mock.ctx);

  await workflow.execute("routeReview", {
    action: "routeReview",
    workflowId,
    findings: [{ category: "must_fix", title: "Fix B" }],
  }, undefined, undefined, mock.ctx);

  status = await workflow.execute("status", { action: "status", workflowId }, undefined, undefined, mock.ctx);
  state = status.details;
  assert.equal(state.stage, "reviewing", "Two cycles produce a recoverable escalation, not a block");
  assert.ok(state.review.escalation?.recoverable);

  // Cleanup
  await workflowStateModule.removeState(workflowId);
  await rm(workdir, { recursive: true, force: true });
});
