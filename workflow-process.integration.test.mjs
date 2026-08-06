import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const globalNodeModules = (await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const jiti = require(path.join(piRoot, "node_modules", "jiti"))(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js") } });
const state = await jiti.import("./workflow-state.ts");
const { WorkflowStateCache } = await jiti.import("./state-cache.ts");
const here = path.dirname(new URL(import.meta.url).pathname);
function child(script, args, env = {}) { return new Promise((resolve, reject) => { const proc = spawn(process.execPath, [path.join(here, script), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = ""; proc.stdout.on("data", data => out += data); proc.stderr.on("data", data => err += data); proc.on("error", reject); proc.on("exit", code => code === 0 ? resolve(out) : reject(new Error(`${script}: ${err}`))); }); }
async function eventually(file) { for (let i = 0; i < 100; i++) { try { await access(file); return; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } } throw new Error(`timed out waiting for ${file}`); }
function legacyPlanningState(input) { const value = state.createState(input); value.stage = "planning"; value.stageSequence = [...state.LEGACY_STAGE_SEQUENCE]; value.history = [{ stage: "planning", at: value.createdAt }]; return value; }

test("workflow cache expires cross-process changes while transactions remain authoritative", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-cache-process-"));
  const workflowId = `cache-process-${Date.now()}`;
  try {
    await state.saveState(legacyPlanningState({ id: workflowId, goal: "cache process", repositoryRoot: cwd }));
    let now = 0;
    const cache = new WorkflowStateCache(250, () => now);
    assert.equal((await cache.get(workflowId, state.loadState)).stage, "planning");
    await child("workflow-cache-update-fixture.mjs", [workflowId, "implementing"]);
    assert.equal((await cache.get(workflowId, state.loadState)).stage, "planning", "fresh TTL may serve a local snapshot");
    assert.equal((await state.transactState(workflowId, current => current.stage)).result, "implementing", "transaction bypasses cache and observes the other process immediately");
    now = 250;
    assert.equal((await cache.get(workflowId, state.loadState)).stage, "implementing", "expired cache reloads durable cross-process state");
  } finally { await state.removeState(workflowId); await rm(cwd, { recursive: true, force: true }); }
});

test("workflow subprocess receives raw identity and transactions cannot resurrect a terminal state", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-process-"));
  const workflowId = "ticket/child:42"; // Valid explicit ID whose sanitized run ID is not reversible.
  const ready = path.join(cwd, "ready"), release = path.join(cwd, "release");
  try {
    await state.saveState(legacyPlanningState({ id: workflowId, goal: "process identity", repositoryRoot: cwd }));
    const output = await child("workflow-child-fixture.mjs", [workflowId], {
      PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_ID: "workflow-ticket_child_42:planner",
      PI_WORKFLOW_ID: workflowId, PI_WORKFLOW_ROLE: "planner",
    });
    assert.equal(JSON.parse(output).stage, "implementing");

    const raceId = `ticket/race:${Date.now()}`;
    await state.saveState(legacyPlanningState({ id: raceId, goal: "race", repositoryRoot: cwd }));
    const held = child("workflow-lock-fixture.mjs", [raceId, ready, release]);
    await eventually(ready);
    const abort = state.transactState(raceId, current => { state.transition(current, "aborted", "foreground abort"); });
    await new Promise(resolve => setTimeout(resolve, 30));
    await writeFile(release, "release");
    await Promise.all([held, abort]);
    assert.equal((await state.loadState(raceId)).stage, "aborted", "queued terminal write wins after the child transaction; no stale resurrection");
    await state.removeState(raceId);
  } finally { await state.removeState(workflowId); await rm(cwd, { recursive: true, force: true }); }
});
