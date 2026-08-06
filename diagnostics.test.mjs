import assert from "node:assert/strict";
import { readFile, rm, stat, utimes } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const createJiti = piRequire("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js") } });
const directory = path.dirname(fileURLToPath(new URL("./index.ts", import.meta.url)));
const diagnostics = await jiti.import(path.join(directory, "diagnostics.ts"));
const id = prefix => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const cleanup = workflowId => rm(diagnostics.diagnosticsDir(workflowId), { recursive: true, force: true });

function event(workflowId, type, timestamp, fields = {}) {
  return { version: 1, workflowId, correlationId: fields.correlationId ?? `${type}-${timestamp}`, timestamp, type, ...fields };
}

test("diagnostic event schema is versioned and append serialization preserves complete JSONL records", async () => {
  const workflowId = id("diag-serialization");
  try {
    const events = Array.from({ length: 100 }, (_, index) => diagnostics.createDiagnosticEvent(workflowId, "parallel", { metadata: { index } }));
    await Promise.all(events.map(diagnostics.appendDiagnostic));
    const loaded = await diagnostics.readDiagnosticEvents(workflowId);
    assert.equal(loaded.length, 100); assert.ok(loaded.every(item => item.version === 1 && item.workflowId === workflowId && item.correlationId));
    const lines = (await readFile(diagnostics.diagnosticsPath(workflowId), "utf8")).trim().split("\n");
    assert.equal(lines.length, 100); assert.doesNotThrow(() => lines.forEach(JSON.parse));
  } finally { await cleanup(workflowId); }
});

test("diagnostics redact likely secrets, truncate strings, and record task size instead of task content", async () => {
  const workflowId = id("diag-redaction");
  try {
    await diagnostics.appendDiagnostic(diagnostics.createDiagnosticEvent(workflowId, "role_dispatch_start", {
      taskBytes: 1234,
      metadata: { apiKey: "top-secret", note: `Bearer abcdefghijklmnop ${"x".repeat(5000)}` },
      error: { name: "Error", message: "token sk-supersecretvalue" },
    }));
    const [loaded] = await diagnostics.readDiagnosticEvents(workflowId);
    assert.equal(loaded.taskBytes, 1234); assert.equal(loaded.metadata.apiKey, "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(loaded), /top-secret|abcdefghijklmnop|sk-supersecretvalue/);
    assert.match(loaded.metadata.note, /\[truncated\]/); assert.equal("task" in loaded.metadata, false);
  } finally { await cleanup(workflowId); }
});

test("summary calculations balance dispatch outcomes, stage latency, tests, compactions, cycles, and usage", () => {
  const workflowId = id("diag-summary");
  const events = [
    event(workflowId, "workflow_start", "2026-01-01T00:00:00.000Z", { stage: "implementing" }),
    event(workflowId, "role_dispatch_start", "2026-01-01T00:00:00.100Z", { role: "implementer", correlationId: "dispatch-a" }),
    event(workflowId, "role_dispatch_end", "2026-01-01T00:00:01.100Z", { role: "implementer", correlationId: "dispatch-a", durationMs: 1000, outcome: "failure", usage: { input: 10, output: 2, turns: 1 } }),
    event(workflowId, "role_dispatch_end", "2026-01-01T00:00:02.000Z", { role: "implementer", correlationId: "dispatch-b", durationMs: 500, outcome: "cancelled" }),
    event(workflowId, "stage_transition", "2026-01-01T00:00:03.000Z", { stage: "testing", reviewCycle: 2, metadata: { from: "implementing", to: "testing" } }),
    event(workflowId, "test_result", "2026-01-01T00:00:04.000Z", { stage: "testing", testPassed: true }),
    event(workflowId, "test_result", "2026-01-01T00:00:05.000Z", { stage: "testing", testPassed: false }),
    event(workflowId, "compaction_end", "2026-01-01T00:00:06.000Z", { outcome: "success" }),
  ];
  const summary = diagnostics.calculateDiagnosticSummary(workflowId, events);
  assert.equal(summary.wallClockMs, 6000); assert.equal(summary.stages.implementing, 3000); assert.equal(summary.stages.testing, 3000);
  assert.deepEqual(summary.roles.implementer, { dispatches: 2, failures: 1, cancellations: 1, durationMs: 1500 });
  assert.deepEqual(summary.tests, { passed: 1, failed: 1 }); assert.equal(summary.reviewCycles, 2); assert.equal(summary.compactions, 1);
  assert.deepEqual(summary.usage, { input: 10, output: 2, cost: 0, turns: 1 });
});

test("successful cleanup retains compact summary while failed diagnostics honor 24-hour pruning", async () => {
  const successId = id("diag-success"); const failedId = id("diag-failed");
  try {
    await diagnostics.appendDiagnostic(diagnostics.createDiagnosticEvent(successId, "workflow_start"));
    await diagnostics.compactSuccessfulDiagnostics(successId, { workflowId: successId, token: "must-redact", result: "success" });
    await assert.rejects(stat(diagnostics.diagnosticsPath(successId)), /ENOENT/);
    const summary = JSON.parse(await readFile(path.join(diagnostics.diagnosticsDir(successId), "summary.json"), "utf8"));
    assert.equal(summary.token, "[REDACTED]"); assert.equal(summary.result, "success");

    await diagnostics.appendDiagnostic(diagnostics.createDiagnosticEvent(failedId, "workflow_end", { outcome: "failure" }));
    const old = new Date(Date.now() - diagnostics.FAILED_DIAGNOSTIC_RETENTION_MS - 1000);
    await utimes(diagnostics.diagnosticsDir(failedId), old, old);
    for (let attempt = 0; attempt < 5; attempt++) {
      await diagnostics.pruneExpiredDiagnostics();
      if (!await stat(diagnostics.diagnosticsDir(failedId)).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await assert.rejects(stat(diagnostics.diagnosticsDir(failedId)), /ENOENT/);
    assert.ok(await stat(diagnostics.diagnosticsDir(successId)));
  } finally { await cleanup(successId); await cleanup(failedId); }
});

test("normalized errors are bounded and logging failures remain rejectable for caller-side graceful degradation", async () => {
  const normalized = diagnostics.normalizeDiagnosticError({ name: "Failure", code: "E_TEST", message: `password=hunter2 ${"z".repeat(5000)}` });
  assert.equal(normalized.name, "Failure"); assert.equal(normalized.code, "E_TEST"); assert.ok(Buffer.byteLength(normalized.message) < diagnostics.MAX_DIAGNOSTIC_STRING_BYTES + 100);
  await assert.rejects(diagnostics.appendDiagnostic({ ...diagnostics.createDiagnosticEvent("valid", "bad"), workflowId: null }), /replace/);
});
