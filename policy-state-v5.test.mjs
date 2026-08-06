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
const directory = path.dirname(fileURLToPath(new URL("./workflow-state.ts", import.meta.url)));
const state = await jiti.import(path.join(directory, "workflow-state.ts"));

const baseState = id => state.createState({ id, goal: "policy-v5 contract", repositoryRoot: process.cwd() });
const justification = {
  code: "historical_red_missing",
  reason: "Validated historical red evidence is unavailable.",
  decision: "accept_deviation",
  risk: "Targeted red provenance cannot be reconstructed.",
  actor: "foreground-orchestrator",
  at: "2026-07-30T00:00:00.000Z",
  evidence: ["migration-record-1"],
};

test("v5 lazily migrates v4 state without losing state and marks recovery mode", async () => {
  const id = `policy-v5-migration-${Date.now()}`;
  try {
    const legacy = baseState(id);
    legacy.version = 4;
    legacy.tests.push({ kind: "targeted_red", command: "node --test", output: "red", passed: false, at: justification.at });
    const preserved = structuredClone(legacy);
    await state.saveState(legacy);

    assert.equal(state.CURRENT_STATE_VERSION, 5);
    const migrated = await state.loadState(id);
    assert.equal(migrated.mode, "recovery");
    assert.equal(migrated.id, preserved.id);
    assert.equal(migrated.goal, preserved.goal);
    assert.equal(migrated.repositoryRoot, preserved.repositoryRoot);
    assert.equal(migrated.stage, preserved.stage);
    assert.deepEqual(migrated.tests, preserved.tests, "existing durable evidence survives lazy migration");
  } finally {
    await state.removeState(id);
  }
});

test("adopt_existing state durably retains accepted inherited evidence and deviations", async () => {
  const id = `policy-v5-adopt-${Date.now()}`;
  const inheritedEvidence = [{ id: "existing-green", kind: "full_green", command: "node --test", acceptedBy: "foreground-orchestrator" }];
  const acceptedDeviations = [justification];
  try {
    const created = state.createState({ id, goal: "adopt", repositoryRoot: process.cwd(), mode: "adopt_existing", inheritedEvidence, acceptedDeviations });
    await state.saveState(created);
    const reloaded = await state.loadState(id);
    assert.equal(reloaded.mode, "adopt_existing");
    assert.deepEqual(reloaded.inheritedEvidence, inheritedEvidence);
    assert.deepEqual(reloaded.acceptedDeviations, acceptedDeviations);
  } finally {
    await state.removeState(id);
  }
});

test("only closed outcome codes accept complete foreground override justification", () => {
  assert.equal(typeof state.applyPolicyDecision, "function", "state API applies structured policy decisions");
  const workflow = baseState(`policy-v5-override-${Date.now()}`);
  const accepted = state.applyPolicyDecision(workflow, justification);
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.state.acceptedDeviations, [justification]);

  for (const invalid of [{ code: "production_safety" }, { code: "new_work_red_first" }, { actor: "implementer" }, { decision: "approve" }, { at: "not-a-date" }, { evidence: [] }]) {
    const beforeDenied = structuredClone(accepted.state);
    const denied = state.applyPolicyDecision(accepted.state, { ...justification, ...invalid });
    assert.equal(denied.accepted, false);
    assert.deepEqual(denied.state, beforeDenied, "denial cannot mutate state or authority");
  }
});

test("review-cap escalation exposes recoverable foreground choices with unresolved references", () => {
  assert.equal(typeof state.recordReviewCapEscalation, "function", "state API records review-cap recovery");
  assert.equal(typeof state.computeAdmissibleNextActions, "function", "state API computes outcome-based actions");
  const escalation = { actor: "foreground-orchestrator", at: justification.at, unresolvedFindingIds: ["finding-1"], unresolvedEvidenceIds: ["review-gate-1"] };
  const workflow = baseState(`policy-v5-cap-${Date.now()}`);
  workflow.stage = "reviewing";
  const escalated = state.recordReviewCapEscalation(workflow, escalation);
  assert.deepEqual(escalated.review.escalation.unresolvedFindingIds, ["finding-1"]);
  const actions = state.computeAdmissibleNextActions(escalated);
  assert.ok(actions.includes("narrow_fix"));
  assert.ok(actions.includes("additional_review_round"));
  assert.ok(actions.includes("abort"));
  assert.ok(!actions.includes("blocked"));
  assert.ok(!actions.includes("auto_deferred"));
  const critical = structuredClone(escalated);
  critical.review.findings = [{ category: "must_fix", title: "critical" }];
  assert.throws(() => state.resolveReviewCap(critical, { choice: "convert_noncritical_follow_up", actor: "foreground-orchestrator" }), /Critical findings/);
  const narrowed = state.resolveReviewCap(escalated, { choice: "narrow_fix", actor: "foreground-orchestrator" });
  assert.equal(narrowed.stage, "fixing");
  assert.equal(narrowed.review.escalation, undefined);
  narrowed.stage = "completed";
  assert.deepEqual(state.computeAdmissibleNextActions(narrowed), [], "terminal state suppresses escalation actions");
  critical.review.approved = true;
  assert.throws(() => state.migrateState(critical), /escalation cannot coexist/);
});

test("replacing a role attempt retains authority and records normalized infrastructure audit metadata", () => {
  assert.equal(typeof state.replaceRoleAttempt, "function", "state API replaces physical attempts");
  const workflow = baseState(`policy-v5-replacement-${Date.now()}`);
  workflow.logicalRoles = { implementer: { authority: ["write_production"], claims: ["src/feature.ts"], attemptId: "attempt-1" } };
  const replacement = { role: "implementer", priorAttemptId: "attempt-1", newAttemptId: "attempt-2", reason: "transport", actor: "foreground-orchestrator", at: justification.at, durationMs: 15, usage: { inputTokens: 1, outputTokens: 2 }, evidence: ["dispatch-1"] };
  const replaced = state.replaceRoleAttempt(workflow, replacement);
  assert.equal(replaced.logicalRoles.implementer.attemptId, "attempt-2");
  assert.deepEqual(replaced.logicalRoles.implementer.authority, ["write_production"]);
  assert.deepEqual(replaced.logicalRoles.implementer.claims, ["src/feature.ts"]);
  assert.deepEqual(replaced.roleAttemptReplacements, [replacement]);
  assert.throws(() => state.replaceRoleAttempt(replaced, { ...replacement, reason: "manual", priorAttemptId: "attempt-2", newAttemptId: "attempt-3" }), /reason is invalid/);
  assert.throws(() => state.replaceRoleAttempt(replaced, { ...replacement, priorAttemptId: "other", newAttemptId: "attempt-3" }), /prior attempt/);
});
