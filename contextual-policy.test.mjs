import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
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
const directory = path.dirname(fileURLToPath(new URL("./index.ts", import.meta.url)));
const extensionModule = await jiti.import(path.join(directory, "index.ts"), { default: true });
const developmentWorkflow = extensionModule.default ?? extensionModule;
const state = await jiti.import(path.join(directory, "workflow-state.ts"));
const diagnostics = await jiti.import(path.join(directory, "diagnostics.ts"));
const prompt = await jiti.import(path.join(directory, "orchestrator-prompt.ts"));
const { activeWorkflowIds, setActiveWorkflowIds, setWorkflowModeEnabled } = await jiti.import(path.join(directory, "thread-mode.ts"));

function git(cwd, args) { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); }
function registry() { return { find: () => ({ provider: "openai-codex", id: "gpt-5.6-terra", maxTokens: 32768 }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local" }) }; }
function fixture(cwd) {
  const tools = new Map();
  developmentWorkflow({ events: { emit() {}, on() {} }, on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, getActiveTools() { return ["development_workflow"]; }, setActiveTools() {}, async setModel() { return true; } });
  return { tool: tools.get("development_workflow"), ctx: { cwd, hasUI: false, modelRegistry: registry(), isProjectTrusted: () => false, sessionManager: {}, ui: { setStatus() {}, notify() {} } } };
}
async function clean(workflowId, roots = []) { await state.removeState(workflowId).catch(() => undefined); await rm(diagnostics.diagnosticsDir(workflowId), { recursive: true, force: true }); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); setWorkflowModeEnabled(false); }
function activate(workflowId) { setActiveWorkflowIds([...activeWorkflowIds(), workflowId]); }

// Contract interpretation: targetRepository is the canonical repository and targetWorktree
// is its selected linked worktree; inventory entries carry their own foreground acceptance.
test("contextual policy: selected worktree, adopted provenance, atomic review, replacements, and reporting", async t => {
  const previous = Object.fromEntries(["PI_SUBAGENT_CHILD", "PI_SUBAGENT_ID", "PI_WORKFLOW_ID", "PI_WORKFLOW_ROLE"].map(key => [key, process.env[key]]));
  delete process.env.PI_SUBAGENT_CHILD; delete process.env.PI_SUBAGENT_ID; delete process.env.PI_WORKFLOW_ID; delete process.env.PI_WORKFLOW_ROLE; setWorkflowModeEnabled(true);
  const repository = await mkdtemp(path.join(os.tmpdir(), "workflow-context-repository-"));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "workflow-context-elsewhere-"));
  const worktree = path.join(path.dirname(repository), `${path.basename(repository)}-selected`);
  git(repository, ["init", "-q"]); git(repository, ["config", "user.email", "test@example.com"]); git(repository, ["config", "user.name", "Test"]);
  await mkdir(path.join(repository, ".pi")); await writeFile(path.join(repository, "approved-plan.md"), "# Approved plan\n");
  git(repository, ["add", "."]); git(repository, ["commit", "-qm", "base"]); git(repository, ["worktree", "add", "-q", "-b", "context-slice", worktree]);
  const { tool, ctx } = fixture(elsewhere);
  const ids = [];
  try {
    await t.test("start uses the explicit selected worktree and rejects plan escapes with a normalized diagnostic", async () => {
      const workflowId = `context-target-${Date.now()}`; ids.push(workflowId);
      const started = await tool.execute("target", { action: "start", workflowId, goal: "selected worktree", mode: "new", targetRepository: repository, targetWorktree: worktree, planPath: "approved-plan.md", acceptanceCriteria: ["done"] }, undefined, undefined, ctx);
      assert.equal(started.details.repositoryRoot, worktree, "preflight and persisted root use targetWorktree, not ctx.cwd");
      assert.equal(started.details.planProvenance.path, path.join(worktree, "approved-plan.md"));
      await assert.rejects(tool.execute("escape", { action: "start", workflowId: `${workflowId}-escape`, goal: "no escape", mode: "new", targetRepository: repository, targetWorktree: worktree, planPath: "../approved-plan.md", acceptanceCriteria: ["done"] }, undefined, undefined, ctx), /inside.*worktree|escape/i);
      const events = await diagnostics.readDiagnosticEvents(`${workflowId}-escape`);
      assert.ok(events.some(event => event.type === "action_rejected" && event.metadata?.action === "start" && event.error?.message), "rejected escape is durably normalized diagnostic evidence");
    });

    await t.test("adopt_existing requires individually accepted inventory provenance and dispatches only missing outcomes", async () => {
      const workflowId = `context-adopt-${Date.now()}`; const withoutInventoryId = `${workflowId}-missing`; ids.push(workflowId, withoutInventoryId);
      const originalCwd = ctx.cwd; ctx.cwd = worktree;
      const base = { action: "start", workflowId, goal: "adopt", mode: "adopt_existing", targetRepository: repository, targetWorktree: worktree, planPath: "approved-plan.md", acceptanceCriteria: ["done"] };
      await assert.rejects(tool.execute("no-inventory", { ...base, workflowId: withoutInventoryId }, undefined, undefined, ctx), /inventory.*required/i);
      const adopted = await tool.execute("adopt", { ...base, inventory: [
        { artifact: "branch", evidence: "context-slice", acceptedBy: "foreground-orchestrator", acceptedAt: "2026-07-30T00:00:00.000Z" },
        { artifact: "commits", evidence: "base", acceptedBy: "foreground-orchestrator", acceptedAt: "2026-07-30T00:00:00.000Z" },
        { artifact: "dirty_tree", evidence: "clean", acceptedBy: "foreground-orchestrator", acceptedAt: "2026-07-30T00:00:00.000Z" },
        { artifact: "approved_plan", evidence: "approved-plan.md", acceptedBy: "foreground-orchestrator", acceptedAt: "2026-07-30T00:00:00.000Z" },
        { artifact: "tests", evidence: "node --test: pass", acceptedBy: "foreground-orchestrator", acceptedAt: "2026-07-30T00:00:00.000Z" },
      ] }, undefined, undefined, ctx);
      assert.equal(adopted.details.mode, "adopt_existing");
      assert.equal(adopted.details.inventory.length, 5, "accepted inherited provenance persists per artifact");
      assert.deepEqual(adopted.details.missingOutcomes, ["implementation", "review", "report"], "adoption computes remaining work without synthetic targeted-red evidence");
      assert.equal(adopted.details.stage, "implementing");
      assert.deepEqual(state.computeAdmissibleNextActions(adopted.details), ["implement", "abort"]);
      assert.equal(adopted.details.tests?.some(item => item.evidenceKind === "targeted_red"), false);
      await tool.execute("adopt-summary", { action: "record", workflowId, agentId: "implementer", implementationSummary: "implemented adopted work" }, undefined, undefined, ctx);
      await tool.execute("adopt-green", { action: "record", workflowId, agentId: "implementer", testCommand: "node --test", testPassed: true, testOutput: "pass", evidenceKind: "full_green" }, undefined, undefined, ctx);
      await tool.execute("adopt-review-stage", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, ctx);
      const bounced = await tool.execute("adopt-review", { action: "routeReview", workflowId, idempotencyKey: "adopt-review", suspectedWeakness: "adopt boundary", testCommand: "node --test", testPassed: true, testOutput: "pass", findings: [{ category: "must_fix", title: "adopted fix", detail: "verified" }] }, undefined, undefined, ctx);
      assert.deepEqual(bounced.details.missingOutcomes, ["review", "report"], "a blocking adopted review remains missing through the fix bounce");
      assert.deepEqual(state.computeAdmissibleNextActions(bounced.details), ["implement", "abort"], "fixing actions take precedence over a stale report outcome");
      await tool.execute("adopt-regreen", { action: "record", workflowId, agentId: "implementer", testCommand: "node --test", testPassed: true, testOutput: "pass after adopted fix", evidenceKind: "full_green" }, undefined, undefined, ctx);
      await tool.execute("adopt-rereview-stage", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, ctx);
      const reviewed = await tool.execute("adopt-rereview", { action: "routeReview", workflowId, idempotencyKey: "adopt-rereview", suspectedWeakness: "fixed adopt boundary", testCommand: "node --test", testPassed: true, testOutput: "pass", findings: [{ category: "approved", title: "approved" }] }, undefined, undefined, ctx);
      assert.deepEqual(reviewed.details.missingOutcomes, ["report"], "review is removed only after re-review resolves it for reporting");
      const report = [reviewed.details.goal, ...reviewed.details.acceptanceCriteria, reviewed.details.planProvenance.path, reviewed.details.planProvenance.digest, reviewed.details.implementationSummary, ...reviewed.details.tests.flatMap(item => [item.command, item.passed ? "pass" : "fail", item.output, item.expectedFailureReason]), "approved", ...reviewed.details.review.findings.flatMap(item => [item.category, item.title, item.detail]), "Follow-ups: none"].filter(Boolean).join("\n");
      const reported = await tool.execute("adopt-report", { action: "report", workflowId, reporterContent: report }, undefined, undefined, ctx);
      assert.deepEqual(reported.details.missingOutcomes, [], "report completion removes the final adopted outcome");
      ctx.cwd = originalCwd;
    });

    await t.test("routeReview is atomic and idempotent, while review cap creates recoverable escalation", async () => {
      const workflowId = `context-review-${Date.now()}`; ids.push(workflowId);
      const persisted = state.createState({ id: workflowId, goal: "review", repositoryRoot: worktree }); persisted.stage = "reviewing"; persisted.history = [{ stage: "reviewing", at: persisted.createdAt }]; persisted.review.maxReviewCycles = 1; await state.saveState(persisted); activate(workflowId);
      const input = { action: "routeReview", workflowId, idempotencyKey: "review-001", suspectedWeakness: "boundary", testCommand: "node --test", testPassed: true, testOutput: "pass", findings: [{ category: "must_fix", title: "edge", detail: "reproduced" }] };
      const first = await tool.execute("review-1", input, undefined, undefined, ctx);
      const second = await tool.execute("review-retry", input, undefined, undefined, ctx);
      assert.deepEqual(second.details.review, first.details.review, "retry returns the committed review result");
      await assert.rejects(tool.execute("review-conflict", { ...input, findings: [{ category: "must_fix", title: "different", detail: "reproduced" }] }, undefined, undefined, ctx), /idempotencyKey conflicts/);
      const reloaded = await state.loadState(workflowId);
      assert.equal(reloaded.review.cycleCount, 1); assert.equal(reloaded.review.findings.length, 1); assert.equal(reloaded.tests.filter(item => item.testCommand === "node --test").length, 1);
      assert.equal(reloaded.stage, "reviewing", "cap is not a blocking terminal/dead-end");
      assert.ok(reloaded.review.escalation?.recoverable); assert.ok(reloaded.review.escalation?.unresolvedFindingIds?.length);
      const events = await diagnostics.readDiagnosticEvents(workflowId);
      assert.equal(events.filter(event => event.metadata?.idempotencyKey === "review-001").length, 1, "review diagnostic/evidence transaction is not duplicated");
    });

    await t.test("Reviewer retries survive a stage change and narrow post-cap fixes require fresh green evidence", async () => {
      const workflowId = `context-post-cap-${Date.now()}`; ids.push(workflowId);
      const persisted = state.createState({ id: workflowId, goal: "post-cap", repositoryRoot: worktree });
      persisted.stage = "reviewing"; persisted.history = [{ stage: "reviewing", at: persisted.createdAt }]; persisted.review.maxReviewCycles = 1;
      await state.saveState(persisted); activate(workflowId);
      const review = { action: "routeReview", workflowId, idempotencyKey: "review-stage-change", suspectedWeakness: "retry boundary", testCommand: "node --test", testPassed: true, testOutput: "pass", findings: [{ category: "must_fix", title: "critical", detail: "reproduced" }] };
      process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:reviewer`; process.env.PI_WORKFLOW_ID = workflowId; process.env.PI_WORKFLOW_ROLE = "reviewer";
      await tool.execute("review-first", review, undefined, undefined, ctx);
      const retried = await tool.execute("review-exact-retry", review, undefined, undefined, ctx);
      assert.equal(retried.details.review.cycleCount, 1, "exact child retry is a no-op after its review stage changed");
      await assert.rejects(tool.execute("review-conflicting-retry", { ...review, findings: [{ category: "must_fix", title: "other", detail: "reproduced" }] }, undefined, undefined, ctx), /idempotencyKey conflicts/);
      delete process.env.PI_SUBAGENT_ID; delete process.env.PI_WORKFLOW_ID; delete process.env.PI_WORKFLOW_ROLE;
      await tool.execute("resolve-narrow", { action: "resolveEscalation", workflowId, escalationChoice: "narrow_fix" }, undefined, undefined, ctx);
      let resolved = await state.loadState(workflowId);
      assert.equal(resolved.stage, "fixing"); assert.equal(resolved.review.approved, false); assert.equal(resolved.review.postCapFix?.code, "targeted_post_cap_fix");
      await assert.rejects(tool.execute("post-cap-stale-green", { action: "advance", workflowId, stage: "reporting" }, undefined, undefined, ctx), /after the review bounce/);
      await tool.execute("post-cap-green", { action: "record", workflowId, agentId: "implementer", testCommand: "node --test", testPassed: true, testOutput: "fresh pass", evidenceKind: "full_green" }, undefined, undefined, ctx);
      const reported = await tool.execute("post-cap-reporting", { action: "advance", workflowId, stage: "reporting" }, undefined, undefined, ctx);
      assert.equal(reported.details.stage, "reporting"); assert.equal(reported.details.review.approved, false);
    });

    await t.test("replaceAttempt is foreground-only, auditable, and does not consume review cycles", async () => {
      const workflowId = `context-replace-${Date.now()}`; ids.push(workflowId);
      const persisted = state.createState({ id: workflowId, goal: "replace", repositoryRoot: worktree }); persisted.stage = "fixing"; persisted.review.cycleCount = 1; persisted.agentHandles.implementer = "logical-implementer"; await state.saveState(persisted); activate(workflowId);
      const replacement = { action: "replaceAttempt", workflowId, role: "implementer", failure: { reason: "transport timeout", exitCode: 124, durationMs: 500, usage: { input: 7, output: 3, turns: 1 } }, replacementAttemptId: "attempt-2" };
      const replaced = await tool.execute("replace", replacement, undefined, undefined, ctx);
      assert.equal(replaced.details.review.cycleCount, 1); assert.equal(replaced.details.agentHandles.implementer, "logical-implementer");
      assert.deepEqual(replaced.details.attempts?.at(-1), { role: "implementer", attemptId: "attempt-2", reason: "transport timeout", exitCode: 124, durationMs: 500, usage: { input: 7, output: 3, turns: 1 } });
      await assert.rejects(tool.execute("replace-retry", replacement, undefined, undefined, ctx), /attempt.*differ|prior attempt/i);
      const reloaded = await state.loadState(workflowId);
      const events = await diagnostics.readDiagnosticEvents(workflowId);
      const replacementEvents = events.filter(event => event.type === "role_attempt_replaced");
      assert.equal(replacementEvents.length, 1, "a successful replacement appends exactly one event; retry rejection cannot duplicate it");
      assert.deepEqual(replacementEvents[0] && {
        role: replacementEvents[0].role,
        attemptId: replacementEvents[0].metadata?.attemptId,
        reason: replacementEvents[0].metadata?.reason,
        exitStatus: replacementEvents[0].metadata?.exitStatus,
        durationMs: replacementEvents[0].durationMs,
        usage: replacementEvents[0].usage,
        evidence: replacementEvents[0].metadata?.evidence,
        actor: replacementEvents[0].metadata?.actor,
        reviewCycle: replacementEvents[0].reviewCycle,
      }, { role: "implementer", attemptId: "attempt-2", reason: "transport", exitStatus: 124, durationMs: 500, usage: { input: 7, output: 3, turns: 1 }, evidence: ["transport timeout"], actor: "foreground-orchestrator", reviewCycle: 1 });
      const summary = diagnostics.calculateDiagnosticSummary(workflowId, events);
      assert.equal(reloaded.review.cycleCount, 1); assert.equal(summary.reviewCycles, reloaded.review.cycleCount);
      assert.equal(reloaded.roleAttemptReplacements.length, replacementEvents.length); assert.equal(reloaded.attempts.length, replacementEvents.length);
      assert.equal(summary.eventCount, events.length); assert.deepEqual(summary.usage, { input: 7, output: 3, cost: 0, turns: 1 });
      process.env.PI_SUBAGENT_ID = `workflow-${workflowId}:implementer`; process.env.PI_WORKFLOW_ID = workflowId; process.env.PI_WORKFLOW_ROLE = "implementer";
      await assert.rejects(tool.execute("child-replace", { action: "replaceAttempt", workflowId, role: "implementer", failure: { reason: "x" }, replacementAttemptId: "attempt-3" }, undefined, undefined, ctx), /foreground/i);
      delete process.env.PI_SUBAGENT_ID; delete process.env.PI_WORKFLOW_ID; delete process.env.PI_WORKFLOW_ROLE;
    });

    await t.test("rejections are normalized and Reporter requires deviations and unresolved risks", async () => {
      const workflowId = `context-report-${Date.now()}`; ids.push(workflowId);
      const persisted = state.createState({ id: workflowId, goal: "report", repositoryRoot: worktree }); persisted.stage = "reporting"; persisted.acceptedDeviations = [{ code: "historical_red_missing", reason: "imported history", decision: "accept_deviation", risk: "legacy evidence cannot be rerun", actor: "foreground-orchestrator", at: persisted.createdAt, evidence: ["inventory-1"] }]; persisted.unresolvedRisks = ["unresolved posting failure"];  await state.saveState(persisted); activate(workflowId);
      await assert.rejects(tool.execute("incomplete-report", { action: "report", workflowId, reporterContent: "# Report\nEverything passed." }, undefined, undefined, ctx), /accepted deviation.*unresolved risk/i);
      await assert.rejects(tool.execute("heading-only-report", { action: "report", workflowId, reporterContent: "# Report\nAccepted deviations\nUnresolved risks" }, undefined, undefined, ctx), /materially state/);
      for (const omitted of ["historical_red_missing", "imported history", "accept_deviation", "legacy evidence cannot be rerun", "inventory-1", "unresolved posting failure"]) {
        await assert.rejects(tool.execute(`omitted-${omitted}`, { action: "report", workflowId, reporterContent: "# Report\nAccepted deviations: historical_red_missing imported history accept_deviation legacy evidence cannot be rerun inventory-1\nUnresolved risks: unresolved posting failure.".replace(omitted, "omitted") }, undefined, undefined, ctx), /materially state/);
      }
      await tool.execute("complete-report", { action: "report", workflowId, reporterContent: "# Report\nGoal: report\nFollow-ups: none\nAccepted deviations: historical_red_missing; imported history; accept_deviation; legacy evidence cannot be rerun; inventory-1.\nUnresolved risks: unresolved posting failure." }, undefined, undefined, ctx);
      await assert.rejects(tool.execute("rejected-action", { action: "advance", workflowId, stage: "implementing" }, undefined, undefined, ctx));
      const events = await diagnostics.readDiagnosticEvents(workflowId);
      assert.ok(events.some(event => event.type === "action_rejected" && event.metadata?.action === "advance" && event.error?.name && event.error?.message));
    });
  } finally {
    setActiveWorkflowIds([]);
    for (const workflowId of ids) await clean(workflowId);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(worktree, { recursive: true, force: true }); await rm(repository, { recursive: true, force: true }); await rm(elsewhere, { recursive: true, force: true });
  }
});

test("contextual policy prompt bounds persisted array contributions", () => {
  const workflow = state.createState({ id: "bounded-context", goal: "x".repeat(10_000), repositoryRoot: process.cwd() });
  workflow.acceptanceCriteria = Array.from({ length: 100 }, () => "é".repeat(5_000));
  workflow.missingOutcomes = Array.from({ length: 100 }, () => "implementation");
  workflow.unresolvedRisks = Array.from({ length: 100 }, () => "risk-".repeat(2_000));
  const rendered = prompt.renderOrchestratorPlanContext(workflow);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= prompt.MAX_ORCHESTRATOR_CONTEXT_BYTES);
});
