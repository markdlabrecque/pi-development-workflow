import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const nodeModules = path.join(piRoot, "node_modules");
const jiti = piRequire("jiti")(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
    "@earendil-works/pi-ai": path.join(nodeModules, "@earendil-works", "pi-ai", "dist", "compat.js"),
    "@earendil-works/pi-tui": path.join(nodeModules, "@earendil-works", "pi-tui", "dist", "index.js"),
    typebox: piRequire.resolve("typebox"),
  },
});
const here = path.dirname(fileURLToPath(new URL("./index.ts", import.meta.url)));
const roles = await jiti.import(path.join(here, "roles.ts"));
const workflowState = await jiti.import(path.join(here, "workflow-state.ts"));

function legacyState(version, stage = "implementing") {
  const value = workflowState.createState({ id: `planner-removal-${version}`, goal: "resume", repositoryRoot: process.cwd() });
  value.version = version;
  value.stage = stage;
  value.stageSequence = [...workflowState.LEGACY_STAGE_SEQUENCE];
  value.history = [{ stage: "planning", at: value.createdAt }, { stage, at: value.updatedAt }];
  return value;
}

test("Planner is absent from the public role registry", () => {
  assert.equal(roles.WORKFLOW_ROLE_NAMES.includes("planner"), false);
  assert.equal(roles.DEFAULT_ROLE_CONFIG.planner, undefined);
  assert.throws(() => roles.getRoleConfig("planner"), /Unknown workflow role/);
});

test("active legacy planning state fails migration with restart guidance", () => {
  assert.throws(
    () => workflowState.migrateState(legacyState(4, "planning")),
    /planning.*restart|restart.*planning/i,
  );
});

test("non-planning v1-v4 state migrates without a live planning stage", () => {
  for (const version of [1, 2, 3, 4]) {
    const migrated = workflowState.migrateState(legacyState(version));
    assert.equal(migrated.stage, "implementing");
    assert.equal(migrated.stageSequence.includes("planning"), false, `v${version} must not retain a live planning stage`);
    assert.ok(migrated.history.some((entry) => entry.stage === "planning"), "historical planning entry is preserved");
  }
});
