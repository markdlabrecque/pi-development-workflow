import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = name => fs.readFileSync(path.join(here, name), "utf8");
const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const jiti = piRequire("jiti")(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"), "@earendil-works/pi-ai": path.join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"), "@earendil-works/pi-tui": path.join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"), typebox: piRequire.resolve("typebox") } });

test("round-one regressions have enforceable production hooks", () => {
  const workflow = source("index.ts");
  const guard = source("../subagents/child-guard.ts");
  const subagent = source("../subagents/index.ts");
  assert.match(guard, /turn_start/);
  assert.match(guard, /usedBashThisTurn/);
  assert.match(workflow, /--porcelain=v1", "-z", "--untracked-files=all/);
  assert.match(workflow, /parsePorcelainV1Z/);
  assert.match(workflow, /fullGreenEvidenceFloor/);
  assert.match(subagent, /lastEndedAt.*activeRunMs/s);
  assert.match(subagent, /a\.status !== "running"/);
});

test("NUL porcelain parsing preserves special names and both rename paths", async () => {
  const { parsePorcelainV1Z } = await jiti.import(path.join(here, "index.ts"));
  assert.deepEqual(parsePorcelainV1Z(" M a space [x].ts\0R  new name.ts\0old name.ts\0?? odd\\name\0"), ["a space [x].ts", "new name.ts", "odd\\name", "old name.ts"]);
});

test("a pre-field red-first fixing state derives an evidence floor", async () => {
  const workflowState = await jiti.import(path.join(here, "workflow-state.ts"));
  const state = workflowState.createState({ id: "legacy-fixing-floor", goal: "test", repositoryRoot: process.cwd() });
  state.stage = "fixing"; state.tests.push({ kind: "full_green", command: "node --test", output: "pass", passed: true, at: new Date().toISOString() });
  const migrated = workflowState.migrateState(state);
  assert.equal(migrated.review.fullGreenEvidenceFloor, 1);
  const { requireEvidence } = await jiti.import(path.join(here, "index.ts"));
  assert.throws(() => requireEvidence(migrated, "full_green", migrated.review.fullGreenEvidenceFloor), /after the review bounce/);
});

test("exceptional timing charges prior idle only before an unpersisted attempt", async () => {
  const { settleExceptionalWorkflowTiming } = await jiti.import(path.join(here, "../subagents/index.ts"));
  const prior = { activeRunMs: 10, idleWaitingMs: 20, lastEndedAt: new Date(1_000).toISOString() };
  assert.equal(settleExceptionalWorkflowTiming(prior, 2_000, 2_300, false), true);
  assert.deepEqual(prior, { activeRunMs: 310, idleWaitingMs: 1_020, lastEndedAt: new Date(1_000).toISOString() });
  const persisted = { activeRunMs: 10, idleWaitingMs: 20, lastEndedAt: new Date(1_000).toISOString() };
  settleExceptionalWorkflowTiming(persisted, 2_000, 2_300, true);
  assert.equal(persisted.idleWaitingMs, 20);
  const noAttempt = { activeRunMs: 10, idleWaitingMs: 20, lastEndedAt: new Date(1_000).toISOString() };
  assert.equal(settleExceptionalWorkflowTiming(noAttempt, undefined, 2_300, false), false);
  assert.deepEqual(noAttempt, { activeRunMs: 10, idleWaitingMs: 20, lastEndedAt: new Date(1_000).toISOString() });
});
