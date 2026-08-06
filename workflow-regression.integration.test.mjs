import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const jiti = require(path.join(piRoot, "node_modules", "jiti"))(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js") } });
const state = await jiti.import("./workflow-state.ts");
const here = path.dirname(new URL(import.meta.url).pathname);
function child(script, args, env) {
  return new Promise((resolve, reject) => {
    const clean = { ...process.env };
    for (const name of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_ID", "PI_WORKFLOW_ID", "PI_WORKFLOW_ROLE"]) delete clean[name];
    const proc = spawn(process.execPath, [path.join(here, script), ...args], { env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", value => out += value); proc.stderr.on("data", value => err += value);
    proc.on("error", reject); proc.on("exit", code => code === 0 ? resolve(out) : reject(new Error(err || `${script} exited ${code}`)));
  });
}

test("workflow regression: registry-shaped child identity is raw-bound and stale writes cannot revive terminal state", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-regression-"));
  const workflowId = "customer/a:b/c";
  try {
    const legacy = state.createState({ id: workflowId, goal: "identity", repositoryRoot: cwd });
    legacy.stage = "planning"; legacy.stageSequence = [...state.LEGACY_STAGE_SEQUENCE]; legacy.history = [{ stage: "planning", at: legacy.createdAt }];
    await state.saveState(legacy);
    // This is the actual subagent registry form: the workflow part is sanitized and
    // therefore cannot be decoded. The separate raw fields must be authoritative.
    const output = await child("workflow-child-fixture.mjs", [workflowId], {
      PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_ID: "customer_a_b_c:planner",
      PI_WORKFLOW_ID: workflowId, PI_WORKFLOW_ROLE: "planner",
    });
    assert.equal(JSON.parse(output).stage, "implementing");

    // Exercise the registered subagent tool's real spawn path, rather than injecting
    // identity directly into the workflow-tool fixture.
    const capture = path.join(cwd, "spawned-environment.json");
    const spawnedWorkflowId = `${workflowId}-spawn-${Date.now()}`;
    await child("subagent-spawn-fixture.mjs", [cwd, spawnedWorkflowId], { WORKFLOW_ENV_CAPTURE: capture });
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), {
      subagentId: `${spawnedWorkflowId.replace(/[^a-zA-Z0-9._-]/g, "_")}:implementer`, workflowId: spawnedWorkflowId, role: "implementer", child: "1",
    });
    for (const partialIdentity of [
      { PI_SUBAGENT_CHILD: "1" },
      { PI_WORKFLOW_ID: workflowId },
      { PI_WORKFLOW_ROLE: "planner" },
      { PI_SUBAGENT_ID: "customer_a_b_c:planner", PI_WORKFLOW_ID: workflowId },
    ]) {
      await assert.rejects(child("workflow-child-fixture.mjs", [workflowId], partialIdentity), /Malformed workflow child identity/);
    }

    const collisionId = "customer_a_b_c";
    await assert.rejects(state.loadState(collisionId), /state-path collision/);
    await assert.rejects(state.transactState(collisionId, () => undefined), /state-path collision/);
    await assert.rejects(state.retireState(collisionId), /state-path collision/);
    const retiredId = `closed/path-${Date.now()}`;
    const retiredCollisionId = retiredId.replace("/", "_");
    await state.saveState(state.createState({ id: retiredId, goal: "tombstone collision", repositoryRoot: cwd }));
    await state.retireState(retiredId);
    await assert.rejects(state.saveState(state.createState({ id: retiredCollisionId, goal: "collision", repositoryRoot: cwd })), /tombstone belongs to/);
    await assert.rejects(state.retireState(retiredCollisionId), /tombstone belongs to/);

    const stale = await state.loadState(workflowId);
    await state.transactState(workflowId, current => state.transition(current, "aborted", "terminal wins"));
    await assert.rejects(state.saveState(stale), /Refusing to resurrect terminal workflow/);
    assert.equal((await state.loadState(workflowId)).stage, "aborted");
  } finally {
    await state.removeState(workflowId);
    await rm(cwd, { recursive: true, force: true });
  }
});
