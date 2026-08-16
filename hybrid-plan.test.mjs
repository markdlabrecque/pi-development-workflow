import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
const ingestion = await jiti.import(path.join(directory, "plan-ingestion.ts"));
const stateModule = await jiti.import(path.join(directory, "workflow-state.ts"));
const promptModule = await jiti.import(path.join(directory, "orchestrator-prompt.ts"));
const workflowExports = await jiti.import(path.join(directory, "index.ts"));
const workflowModule = await jiti.import(path.join(directory, "index.ts"), { default: true });
const developmentWorkflow = workflowModule.default ?? workflowModule;
const { setActiveWorkflowIds, setWorkflowModeEnabled } = await jiti.import(path.join(directory, "thread-mode.ts"));

async function tempRepo() { const root = await mkdtemp(path.join(os.tmpdir(), "pi-hybrid-plan-")); await mkdir(path.join(root, ".pi")); return root; }
function registry(model = { provider: workflowExports.WORKFLOW_MODEL_PROVIDER, id: workflowExports.WORKFLOW_MODEL_ID, maxTokens: 32768 }, auth = { ok: true, apiKey: "local" }) {
  return { find(provider, id) { if (model === null) return undefined; return provider === "openai-codex" && ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].includes(id) ? { ...model, provider, id } : undefined; }, async getApiKeyAndHeaders() { return auth; } };
}

test("plan ingestion enforces repository bounds, regular files, size, and digest provenance", async () => {
  const root = await tempRepo(); const outside = await mkdtemp(path.join(os.tmpdir(), "pi-outside-plan-"));
  try {
    await writeFile(path.join(root, "plan.md"), "# Approved\n");
    const plan = await ingestion.ingestPlan(root, "plan.md");
    assert.equal(plan.content, "# Approved\n"); assert.equal(plan.bytes, 11); assert.match(plan.digest, /^[a-f0-9]{64}$/); assert.equal(plan.path, await (await import("node:fs/promises")).realpath(path.join(root, "plan.md")));
    await assert.rejects(ingestion.ingestPlan(root, "missing.md"), /Unable to resolve planPath/);
    await mkdir(path.join(root, "directory")); await assert.rejects(ingestion.ingestPlan(root, "directory"), /not a regular file/);
    await writeFile(path.join(outside, "plan.md"), "outside"); await symlink(path.join(outside, "plan.md"), path.join(root, "outside.md"));
    await assert.rejects(ingestion.ingestPlan(root, "outside.md"), /inside the repository root/);
    await writeFile(path.join(root, "large.md"), Buffer.alloc(ingestion.MAX_PLAN_BYTES + 1));
    await assert.rejects(ingestion.ingestPlan(root, "large.md"), /maximum approved plan size/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("version two planning workflows migrate without silent stage rewrite", () => {
  const legacy = stateModule.createState({ id: "legacy-v2", goal: "resume", repositoryRoot: process.cwd() });
  legacy.version = 2; legacy.stage = "planning"; legacy.history = [{ stage: "planning", at: legacy.createdAt }]; legacy.stageSequence = [...stateModule.LEGACY_STAGE_SEQUENCE];
  const migrated = stateModule.migrateState(legacy);
  assert.equal(migrated.version, 5); assert.equal(migrated.stage, "planning"); assert.deepEqual(migrated.stageSequence, [...stateModule.LEGACY_STAGE_SEQUENCE]);
});

test("new state and bounded Orchestrator prompt are planner-free and retain provenance", () => {
  const state = stateModule.createState({ id: "new-v3", goal: "execute", acceptanceCriteria: ["works"], repositoryRoot: process.cwd() });
  state.planProvenance = { path: path.join(process.cwd(), "plan.md"), content: "x".repeat(promptModule.MAX_PLAN_PROMPT_BYTES + 1000), digest: "a".repeat(64), ingestedAt: new Date().toISOString(), bytes: promptModule.MAX_PLAN_PROMPT_BYTES + 1000 };
  state.plan = state.planProvenance.content;
  assert.equal(state.stage, "red_testing"); assert.deepEqual(state.stageSequence, ["red_testing", "implementing", "reviewing", "reporting"]);
  const prompt = promptModule.renderOrchestratorPlanContext(state);
  assert.match(prompt, /truncated/); assert.match(prompt, /a{64}/); assert.match(prompt, /red-test command/);
  assert.match(prompt, /Agent profiles are not workflow roles/);
  assert.match(prompt, /planner, implementer, test-writer, reviewer, reporter/);
  assert.match(prompt, /\{ agent: "researcher", task: "Investigate \.\.\." \}/);
  assert.ok(Buffer.byteLength(prompt) < promptModule.MAX_PLAN_PROMPT_BYTES + 2000);
});

test("role model resolver fails actionably and accepts only supported explicit overrides", async () => {
  await assert.rejects(workflowExports.resolveWorkflowModel({ modelRegistry: registry(null) }), new RegExp(`requires ${workflowExports.WORKFLOW_MODEL_PROVIDER}/`));
  await assert.rejects(workflowExports.resolveWorkflowModel({ modelRegistry: registry({ provider: workflowExports.WORKFLOW_MODEL_PROVIDER, id: workflowExports.WORKFLOW_MODEL_ID }, { ok: false }) }), /credentials missing/);
  const handlers = new Map();
  const pi = { events: { emit() {}, on() {} }, on(name, fn) { handlers.set(name, fn); }, registerCommand() {}, registerTool() {}, getActiveTools() { return []; }, setActiveTools() {}, async setModel() { return true; } };
  developmentWorkflow(pi);
  const input = { lifecycle: "workflow", workflowId: "missing-state", agentId: "implementer", agent: "implementer", task: "do work", model: "openai-codex/gpt-5.6-luna" };
  setActiveWorkflowIds(["missing-state"]);
  await handlers.get("tool_call")({ toolName: "subagent", toolCallId: "dispatch-1", input }, { modelRegistry: registry() });
  assert.equal(input.model, "openai-codex/gpt-5.6-luna");
  await assert.rejects(handlers.get("tool_call")({ toolName: "subagent", toolCallId: "dispatch-2", input: { ...input, model: "openai/other" } }, { modelRegistry: registry() }), /Unsupported workflow role model/);
  setActiveWorkflowIds([]);
});

test("workflow dispatch rejects invented roles while ordinary researcher profiles remain available", async () => {
  const handlers = new Map();
  const pi = { events: { emit() {}, on() {} }, on(name, fn) { handlers.set(name, fn); }, registerCommand() {}, registerTool() {}, getActiveTools() { return []; }, setActiveTools() {}, async setModel() { return true; } };
  developmentWorkflow(pi);
  const dispatch = handlers.get("tool_call");
  setActiveWorkflowIds(["workflow-1"]);
  for (const agentId of ["harness-auditor", "wayfinder-auditor", "auditor", "test_writer"]) {
    await assert.rejects(dispatch({ toolName: "subagent", toolCallId: `invalid-${agentId}`, input: { lifecycle: "workflow", workflowId: "workflow-1", agentId, agent: "researcher", task: "audit" } }, { modelRegistry: registry() }), error => {
      assert.match(error.message, new RegExp(`Invalid workflow agentId "${agentId}"`));
      assert.match(error.message, /planner, implementer, test-writer, reviewer, reporter/);
      assert.match(error.message, /\{ agent: "researcher", task: "Investigate \.\.\." \}/);
      assert.match(error.message, /omit lifecycle, workflowId, and agentId/);
      return true;
    });
  }
  const ordinary = { agent: "researcher", task: "Investigate dispatch behavior" };
  assert.equal(await dispatch({ toolName: "subagent", toolCallId: "ordinary-research", input: ordinary }, { modelRegistry: registry() }), undefined);
  assert.deepEqual(ordinary, { agent: "researcher", task: "Investigate dispatch behavior" });
  setActiveWorkflowIds([]);
});

test("start preflight requires explicit acknowledgement of dirty paths", async () => {
  const root = await tempRepo(); const tools = new Map(); const workflowId = `dirty-preflight-${Date.now()}`;
  try {
    spawnSync("git", ["init", "-q"], { cwd: root }); spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(path.join(root, "plan.md"), "# Plan\n"); await writeFile(path.join(root, "owned.txt"), "clean\n");
    spawnSync("git", ["add", "."], { cwd: root }); spawnSync("git", ["commit", "-qm", "base"], { cwd: root }); await writeFile(path.join(root, "owned.txt"), "pre-existing\n");
    setWorkflowModeEnabled(true);
    const pi = { events: { emit() {}, on() {} }, on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, getActiveTools() { return ["development_workflow"]; }, setActiveTools() {}, async setModel() { return true; } };
    developmentWorkflow(pi);
    const ctx = { cwd: root, hasUI: false, modelRegistry: registry(), isProjectTrusted: () => false, sessionManager: {}, ui: { setStatus() {}, notify() {} } };
    const args = { action: "start", workflowId, goal: "respect dirt", planPath: "plan.md", acceptanceCriteria: ["done"] };
    await assert.rejects(tools.get("development_workflow").execute("reject", args, undefined, undefined, ctx), /owned\.txt/);
    const accepted = await tools.get("development_workflow").execute("accept", { ...args, acknowledgeDirtyPaths: ["owned.txt"] }, undefined, undefined, ctx);
    assert.deepEqual(accepted.details.preflight.dirtyPaths, ["owned.txt"]); assert.deepEqual(accepted.details.preflight.acknowledgedDirtyPaths, ["owned.txt"]);
  } finally { await stateModule.removeState(workflowId).catch(() => undefined); await rm(root, { recursive: true, force: true }); setWorkflowModeEnabled(false); }
});

test("start requires planPath and explicit criteria, persists provenance, and begins red testing", async () => {
  const root = await tempRepo(); const tools = new Map(); const handlers = new Map(); const workflowId = `hybrid-start-${Date.now()}`;
  try {
    await writeFile(path.join(root, "plan.md"), "# Plan\n\nImplement carefully.\n");
    setWorkflowModeEnabled(true);
    const pi = { events: { emit() {}, on() {} }, on(name, fn) { handlers.set(name, fn); }, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, getActiveTools() { return ["development_workflow"]; }, setActiveTools() {}, async setModel() { return true; } };
    developmentWorkflow(pi);
    const ctx = { cwd: root, hasUI: false, mode: "print", modelRegistry: registry(), model: registry().find(workflowExports.WORKFLOW_MODEL_PROVIDER, workflowExports.WORKFLOW_MODEL_ID), isProjectTrusted: () => false, sessionManager: { getSessionId: () => "test-session" }, ui: { setStatus() {}, notify() {} } };
    const tool = tools.get("development_workflow");
    await assert.rejects(tool.execute("missing-plan", { action: "start", workflowId: `${workflowId}-missing`, goal: "goal", acceptanceCriteria: ["done"] }, undefined, undefined, ctx), /requires planPath/);
    await assert.rejects(tool.execute("missing-criteria", { action: "start", workflowId: `${workflowId}-criteria`, goal: "goal", planPath: "plan.md" }, undefined, undefined, ctx), /requires at least one/);
    await assert.rejects(tool.execute("implicit-parallel", { action: "start", workflowId: `${workflowId}-batch`, goal: "goal", planPath: "plan.md", acceptanceCriteria: ["done"], batchId: "batch-1", siblingOwnedFiles: ["src/sibling.ts"] }, undefined, undefined, ctx), /parallelExplicitlyRequested=true/);
    const result = await tool.execute("valid", { action: "start", workflowId, goal: "goal", planPath: "plan.md", acceptanceCriteria: ["done"], baseBranch: "main", sharedContracts: ["append-only fixture blocks"], parallelExplicitlyRequested: true }, undefined, undefined, ctx);
    assert.equal(result.details.stage, "red_testing"); assert.equal(result.details.modelProvider, workflowExports.WORKFLOW_MODEL_PROVIDER); assert.equal(result.details.modelId, workflowExports.WORKFLOW_MODEL_ID);
    assert.equal(result.details.preflight.baseBranch, "main"); assert.deepEqual(result.details.batch.sharedContracts, ["append-only fixture blocks"]); assert.equal(result.details.batch.explicitlyRequested, true);
    const reviewerDispatch = { lifecycle: "workflow", workflowId, agentId: "reviewer", agent: "reviewer", task: "review artifacts", model: "openai-codex/gpt-5.6-terra" };
    await handlers.get("tool_call")({ toolName: "subagent", toolCallId: "review-dispatch", input: reviewerDispatch }, ctx);
    assert.equal((await stateModule.loadState(workflowId)).roleConfig.reviewer.model, "openai-codex/gpt-5.6-terra", "supported explicit model persists for resume");
    assert.equal(result.details.planProvenance.path, await (await import("node:fs/promises")).realpath(path.join(root, "plan.md"))); assert.match(result.details.planProvenance.digest, /^[a-f0-9]{64}$/); assert.equal(result.details.agentHandles.planner, undefined);
    await assert.rejects(tool.execute("missing-red", { action: "advance", workflowId, stage: "implementing" }, undefined, undefined, ctx), /targeted_red handoff/);
    await tool.execute("bad-red", { action: "record", workflowId, agentId: "test-writer", testCommand: "node --test", testPassed: false, testOutput: "syntax error", evidenceKind: "targeted_red" }, undefined, undefined, ctx);
    await assert.rejects(tool.execute("wrong-red", { action: "advance", workflowId, stage: "implementing" }, undefined, undefined, ctx), /expected behavioral reason/);
    await tool.execute("red", { action: "record", workflowId, agentId: "test-writer", testCommand: "node --test", testPassed: false, testOutput: "missing behavior", evidenceKind: "targeted_red", expectedFailureReason: "feature absent" }, undefined, undefined, ctx);
    await tool.execute("to-implementing", { action: "advance", workflowId, stage: "implementing" }, undefined, undefined, ctx);
    await assert.rejects(tool.execute("missing-green", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, ctx), /full_green handoff/);
    await tool.execute("stale-green", { action: "record", workflowId, agentId: "implementer", testCommand: "node --test", testPassed: true, testOutput: "old pass", evidenceKind: "full_green" }, undefined, undefined, ctx);
    await tool.execute("new-red", { action: "record", workflowId, agentId: "implementer", testCommand: "node --test", testPassed: false, testOutput: "regression", evidenceKind: "full_green" }, undefined, undefined, ctx);
    await assert.rejects(tool.execute("contradictory-green", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, ctx), /may not hand off/);
    await tool.execute("green", { action: "record", workflowId, agentId: "implementer", testCommand: "node --test", testPassed: true, testOutput: "all pass", evidenceKind: "full_green" }, undefined, undefined, ctx);
    await tool.execute("to-reviewing", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, ctx);
    await assert.rejects(tool.execute("generic-review", { action: "routeReview", workflowId, testCommand: "node --test", testPassed: true, testOutput: "all pass", findings: [{ category: "approved", title: "approved" }] }, undefined, undefined, ctx), /named suspectedWeakness/);
    let routed = await tool.execute("fix", { action: "routeReview", workflowId, suspectedWeakness: "edge case", testCommand: "node --test", testPassed: true, testOutput: "all pass", findings: [{ category: "must_fix", title: "fix", detail: "verified at boundary" }] }, undefined, undefined, ctx);
    assert.equal(routed.details.stage, "fixing");
    await tool.execute("regreen", { action: "record", workflowId, agentId: "implementer", testCommand: "node --test", testPassed: true, testOutput: "all pass after fix", evidenceKind: "full_green" }, undefined, undefined, ctx);
    await tool.execute("rereview", { action: "advance", workflowId, stage: "reviewing" }, undefined, undefined, ctx);
    routed = await tool.execute("approve", { action: "routeReview", workflowId, suspectedWeakness: "fixed edge", testCommand: "node --test", testPassed: true, testOutput: "all pass", findings: [{ category: "approved", title: "approved" }] }, undefined, undefined, ctx);
    assert.equal(routed.details.stage, "reporting"); assert.equal(routed.details.review.cycleCount, 2);
    await assert.rejects(tool.execute("premature-complete", { action: "complete", workflowId }, undefined, undefined, ctx), /Reporter exact content/);
    const durable = await stateModule.loadState(workflowId);
    const exact = [
      "# Workflow report", `Goal: ${durable.goal}`, ...durable.acceptanceCriteria,
      durable.planProvenance.path, durable.planProvenance.digest,
      ...durable.tests.flatMap(item => [item.command, item.passed ? "pass" : "fail", item.output, item.expectedFailureReason]),
      "Review: approved", ...durable.review.findings.flatMap(item => [item.category, item.title, item.detail]), "Follow-ups: none",
    ].filter(Boolean).join("\n");
    await tool.execute("report", { action: "report", workflowId, reporterContent: exact }, undefined, undefined, ctx);
    assert.equal((await stateModule.loadState(workflowId)).reporterResult, exact);
    assert.equal(await (await import("node:fs/promises")).readFile(path.join(root, "docs", "reports", `${new Date().toISOString().slice(0, 10)}-${workflowId}.md`), "utf8"), `${exact}\n`);
    await tool.execute("complete", { action: "complete", workflowId, outcome: "done" }, undefined, undefined, ctx);
  } finally { await stateModule.removeState(workflowId).catch(() => undefined); await rm(root, { recursive: true, force: true }); setWorkflowModeEnabled(false); }
});
