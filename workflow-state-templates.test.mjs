import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
const directory = path.dirname(fileURLToPath(new URL("./index.ts", import.meta.url)));
const state = await jiti.import(path.join(directory, "workflow-state.ts"));
const templates = await jiti.import(path.join(directory, "templates.ts"));
const workflowModule = await jiti.import(path.join(directory, "index.ts"), { default: true });
const developmentWorkflow = workflowModule.default ?? workflowModule;
const { setWorkflowModeEnabled } = await jiti.import(path.join(directory, "thread-mode.ts"));

function validState(id) { return state.createState({ id, goal: "test", repositoryRoot: process.cwd() }); }
function createMockPi() {
  const tools = new Map();
  const pi = {
    events: { emit() {}, on() {} }, on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); },
    getActiveTools() { return ["development_workflow"]; }, setActiveTools() {},
  };
  const ctx = { cwd: process.cwd(), hasUI: false, modelRegistry: { find: () => ({}) }, isProjectTrusted: () => false, ui: { setStatus() {}, notify() {} } };
  developmentWorkflow(pi);
  return { tools, ctx };
}

test("migrateState upgrades version one without mutating it", () => {
  const legacy = validState(`state-migrate-${Date.now()}`);
  legacy.version = 1;
  legacy.systemOfRecord = { type: "github", repository: "owner/repository" };
  delete legacy.stageSequence;
  const migrated = state.migrateState(legacy);

  assert.equal(migrated.version, state.CURRENT_STATE_VERSION);
  assert.deepEqual(migrated.stageSequence, ["planning", "implementing", "testing", "reviewing", "reporting"]);
  assert.deepEqual(migrated.systemOfRecord, { type: "github", repository: "owner/repository", approved: true }, "v1 GitHub authorization provenance is preserved");
  assert.equal(legacy.version, 1);
  assert.equal(legacy.stageSequence, undefined);
  assert.equal(legacy.systemOfRecord.approved, undefined, "migration must not mutate the loaded v1 state");

  const impossibleV1Provider = { ...legacy, systemOfRecord: { type: "gitlab", repository: "group/project" } };
  assert.deepEqual(state.migrateState(impossibleV1Provider).systemOfRecord, { type: "gitlab", repository: "group/project" }, "approval is never inferred for providers unavailable in v1");
});

test("strict single-state loads report corrupt and future data while list isolates them", async () => {
  const prefix = `state-load-${Date.now()}`;
  const validId = `${prefix}-valid`;
  const legacyId = `${prefix}-legacy`;
  const futureId = `${prefix}-future`;
  const malformedId = `${prefix}-malformed`;
  try {
    await state.saveState(validState(validId));
    const legacy = validState(legacyId);
    legacy.version = 1;
    delete legacy.stageSequence;
    await writeFile(state.statePath(legacyId), JSON.stringify(legacy));
    const loadedLegacy = await state.loadState(legacyId);
    assert.equal(loadedLegacy.version, state.CURRENT_STATE_VERSION, "loadState should migrate v1 transparently");
    assert.deepEqual(loadedLegacy.stageSequence, ["planning", "implementing", "testing", "reviewing", "reporting"]);

    const future = validState(futureId);
    future.version = 99;
    await writeFile(state.statePath(futureId), JSON.stringify(future));
    await writeFile(state.statePath(malformedId), "not json");

    await assert.rejects(state.loadState(futureId), /Unsupported workflow state version 99/);
    await assert.rejects(state.loadState(malformedId), /Malformed workflow state/);
    const all = await state.listStates();
    assert.ok(all.some(entry => entry.id === validId));
    assert.ok(!all.some(entry => entry.id === futureId || entry.id === malformedId));
  } finally {
    await Promise.all([state.removeState(validId), state.removeState(legacyId), state.removeState(futureId), state.removeState(malformedId)]);
  }
});

test("deprecated templates remain immutable but use the planner-free sequence", () => {
  assert.ok(Object.isFrozen(templates.WORKFLOW_TEMPLATES));
  assert.ok(Object.isFrozen(templates.WORKFLOW_TEMPLATES.bugfix.acceptanceCriteria));
  assert.throws(() => templates.WORKFLOW_TEMPLATES.bugfix.acceptanceCriteria.push("mutate"), TypeError);
  assert.deepEqual(templates.WORKFLOW_TEMPLATES.bugfix.stageSequence, ["red_testing", "implementing", "reviewing", "reporting"]);
});
