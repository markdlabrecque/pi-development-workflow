import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Load this extension exactly as Pi does: Node's normal resolver cannot see Pi's bundled
// extension dependencies from ~/.pi/agent. The mock below exercises its registered handlers.
const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
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
const module = await jiti.import(extensionPath, { default: true });
const developmentWorkflow = module.default ?? module;

function createMockPi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const active = new Set(["read", "bash", "development_workflow"]);
  const statuses = new Map();
  const notifications = [];
  const pi = {
    events: { emit() {}, on() {} },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getActiveTools() { return [...active]; },
    async setModel() { return true; },
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
    },
  };
  developmentWorkflow(pi);
  return { pi, handlers, commands, tools, active, statuses, notifications, ctx };
}

async function emit(mock, name, event, ctx = mock.ctx) {
  let result;
  for (const handler of mock.handlers.get(name) ?? []) result = await handler(event, ctx);
  return result;
}

async function start(mock, reason) {
  await emit(mock, "session_start", { reason });
}

test("process-local mode persists through rebinds and is shared by concurrent runtimes", async () => {
  const first = createMockPi();
  await start(first, "startup");
  await first.commands.get("workflow-enable").handler("", first.ctx); // establish test baseline
  const second = createMockPi();
  await start(second, "startup");

  await first.commands.get("workflow-disable").handler("", first.ctx);
  assert.equal(first.active.has("development_workflow"), false);
  await emit(second, "session_shutdown", { reason: "reload" });
  const secondReloaded = createMockPi();
  await start(secondReloaded, "reload");
  assert.equal(secondReloaded.active.has("development_workflow"), false);

  // /new has no session identity in memory, but the process-local setting still survives.
  await emit(first, "session_shutdown", { reason: "new" });
  let replacement = createMockPi();
  await start(replacement, "new");
  assert.equal(replacement.active.has("development_workflow"), false);

  for (const reason of ["resume", "fork", "reload"]) {
    await emit(replacement, "session_shutdown", { reason });
    replacement = createMockPi();
    await start(replacement, reason);
    assert.equal(replacement.active.has("development_workflow"), false, `${reason} must retain disabled mode`);
  }

  // A command in one concurrent runtime changes gating observed by the other.
  await secondReloaded.commands.get("workflow-enable").handler("", secondReloaded.ctx);
  assert.equal(await emit(first, "tool_call", { toolName: "development_workflow" }), undefined);
});

test("a new process and a hot reload with legacy default-on state initialize mode disabled", () => {
  const modePath = new URL("./thread-mode.ts", import.meta.url).href;
  for (const preload of ["", 'globalThis[Symbol.for("development-workflow.enabled")] = true;']) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `${preload} const { workflowModeEnabled } = await import(${JSON.stringify(modePath)}); console.log(workflowModeEnabled());`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "false");
  }
});

test("disabled mode suppresses prompt injection and blocks stale workflow calls", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "workflow-thread-mode-"));
  const mock = createMockPi();
  mock.ctx.cwd = workdir;
  const workflowId = `thread-mode-test-${Date.now()}`;
  try {
    await start(mock, "startup");
    await mock.commands.get("workflow-enable").handler("", mock.ctx);
    const workflow = mock.tools.get("development_workflow");
    await writeFile(path.join(mock.ctx.cwd, "plan.md"), "# Approved plan\n");
    await workflow.execute("start", { action: "start", workflowId, goal: "test mode", planPath: "plan.md", acceptanceCriteria: ["mode remains safe"] }, undefined, undefined, mock.ctx);
    // The test runner can itself be a workflow child; this assertion exercises the
    // foreground branch rather than inheriting that child role's prompt.
    const inheritedSubagentId = process.env.PI_SUBAGENT_ID;
    delete process.env.PI_SUBAGENT_ID;
    const injected = await emit(mock, "before_agent_start", { systemPrompt: "base" });
    assert.match(injected.systemPrompt, /development-workflow Orchestrator/);

    await mock.commands.get("workflow-disable").handler("", mock.ctx);
    assert.equal(await emit(mock, "before_agent_start", { systemPrompt: "base" }), undefined);
    assert.deepEqual(await emit(mock, "tool_call", { toolName: "development_workflow" }), {
      block: true,
      reason: "Development workflow is inactive. Use a trigger phrase or /workflow-enable.",
    });
    await assert.rejects(
      workflow.execute("stale", { action: "status" }, undefined, undefined, mock.ctx),
      /Development workflow is inactive/, 
    );
    assert.equal(await emit(mock, "tool_call", { toolName: "read" }), undefined);
    if (inheritedSubagentId === undefined) delete process.env.PI_SUBAGENT_ID;
    else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
  } finally {
    const workflowState = await jiti.import(path.join(path.dirname(extensionPath), "workflow-state.ts"));
    await workflowState.removeState(workflowId);
    await rm(workdir, { recursive: true, force: true });
  }
});
