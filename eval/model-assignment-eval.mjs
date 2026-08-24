#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, codingTools, fixtureFor, loadRolePrompt, noTools } from "./model-assignment-fixtures.mjs";

const SELF = fileURLToPath(import.meta.url);
const GRADING_TIMEOUT_MS = 15_000;
const MODEL_TIMEOUT_MS = 180_000;

function usage() { console.error(`Usage:\n  node eval/model-assignment-eval.mjs run --fixture <name> --models <model[,model...]> --output <path> [--dry-run]\n  node eval/model-assignment-eval.mjs score --input <jsonl>`); }
function parseOptions(args, command) {
  const options = { dryRun: false };
  const names = new Set(command === "run" ? ["fixture", "models", "output"] : ["input"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (command === "run" && arg === "--dry-run") { options.dryRun = true; continue; }
    if (!arg.startsWith("--") || !names.has(arg.slice(2)) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Invalid option: ${arg}`);
    options[arg.slice(2)] = args[++i];
  }
  for (const name of names) if (!options[name]) throw new Error(`Missing required option: --${name}`);
  if (command === "run") {
    if (!FIXTURES[options.fixture]) throw new Error(`Unknown fixture: ${options.fixture}`);
    options.models = options.models.split(",").map((x) => x.trim()).filter(Boolean);
    if (!options.models.length) throw new Error("--models must contain at least one model");
  }
  return options;
}
function invocation(fixture, model, systemPrompt) {
  const tools = fixture.role === "reviewer" || fixture.role === "reporter" ? [noTools] : ["--tools", codingTools];
  return ["pi", "--mode", "json", "--model", model, "--thinking", fixture.thinking, ...tools,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session",
    "--system-prompt", systemPrompt, fixture.prompt];
}
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}
function parsePiOutput(stdout) {
  let finalText = ""; let usage;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const message = event.message ?? event;
    if (message.role === "assistant") { const text = textFromContent(message.content ?? message.text); if (text) finalText = text; usage = message.usage ?? event.usage ?? usage; }
  }
  return { finalText, usage };
}
function runPi(args, cwd) {
  return new Promise((resolve) => {
    const started = Date.now(); let stdout = ""; let stderr = ""; let timedOut = false;
    const child = spawn(args[0], args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, MODEL_TIMEOUT_MS);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ error, elapsedMs: Date.now() - started, stderr, timedOut }); });
    child.on("close", (status, signal) => { clearTimeout(timer); resolve({ ...parsePiOutput(stdout), elapsedMs: Date.now() - started, status, signal, stderr, timedOut }); });
  });
}
async function writeFixtureFiles(dir, files) {
  for (const [name, content] of Object.entries(files ?? {})) { const target = path.join(dir, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
}
async function regularArtifacts(dir, root = dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await regularArtifacts(full, root));
    else if (entry.isFile()) output.push({ path: path.relative(root, full), content: await readFile(full, "utf8") });
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}
async function run(options) {
  const fixture = fixtureFor(options.fixture); const systemPrompt = await loadRolePrompt(fixture.role);
  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true }); const records = [];
  for (const model of options.models) {
    const args = invocation(fixture, model, systemPrompt);
    if (options.dryRun) { records.push({ fixture: fixture.name, role: fixture.role, model, thinking: fixture.thinking, invocation: args }); continue; }
    let cwd; let result; let artifacts;
    if (fixture.files) { cwd = await mkdtemp(path.join(os.tmpdir(), "model-assignment-workspace-")); await writeFixtureFiles(cwd, fixture.files); }
    try { result = await runPi(args, cwd); if (cwd) artifacts = await regularArtifacts(cwd); }
    finally { if (cwd) await rm(cwd, { recursive: true, force: true }); }
    records.push({ fixture: fixture.name, role: fixture.role, model, thinking: fixture.thinking, invocation: args,
      response: result.finalText || null, ...(artifacts ? { artifacts } : {}), elapsedMs: result.elapsedMs, usage: result.usage ?? null,
      exitStatus: result.status ?? null, signal: result.signal ?? null, stderr: result.stderr ?? "" });
  }
  await writeFile(options.output, `${records.map(JSON.stringify).join("\n")}\n`);
  if (!options.dryRun) { const failed = records.find((r) => r.exitStatus !== 0 || r.signal || !r.response); if (failed) throw new Error(`Pi failed for ${failed.model}; exit status ${failed.exitStatus ?? "unavailable"}${failed.signal ? `, signal ${failed.signal}` : ""}${failed.stderr ? `: ${failed.stderr.trim()}` : ""}`); }
}
function responseFindings(response) {
  const text = String(response ?? ""); const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) { try { const parsed = JSON.parse(text.slice(start, end + 1)); if (Array.isArray(parsed.findings)) return parsed.findings; } catch {} }
  return [text];
}
function findingText(finding) { return JSON.stringify(finding).toLowerCase(); }
function findingLocation(finding) {
  if (finding && typeof finding === "object") return String(finding.location ?? (finding.file && finding.line != null ? `${finding.file}:${finding.line}` : finding.file ?? "")).toLowerCase();
  return String(finding).toLowerCase();
}
function scoreReviewer(record, fixture) {
  const expected = fixture.oracle.findings; const mustFix = responseFindings(record.response).filter((f) => /must[_ -]?fix/i.test([f?.severity, f?.classification, f].filter(Boolean).join(" ")));
  const used = new Set();
  const matched = expected.filter((oracle) => {
    const index = mustFix.findIndex((f, i) => !used.has(i) && findingLocation(f).includes(oracle.file) && oracle.terms.every((term) => findingText(f).includes(term)));
    if (index < 0) return false;
    used.add(index); return true;
  });
  const falsePositiveCount = Math.max(0, mustFix.length - used.size);
  return { model: record.model, fixture: record.fixture, hasMustFix: mustFix.length > 0, expectedFindingCount: expected.length,
    matchedFindingCount: matched.length, missedFindingCount: expected.length - matched.length, falsePositiveCount,
    matchesOracle: matched.length === expected.length };
}
function command(args, cwd) {
  return new Promise((resolve) => { let stdout = "", stderr = "", timedOut = false; const child = spawn(args[0], args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, GRADING_TIMEOUT_MS); child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ status: null, stdout, stderr, error, timedOut }); }); child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); }); });
}
async function gradeCoding(record, fixture) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-grade-"));
  try { for (const artifact of record.artifacts ?? []) { const target = path.join(dir, artifact.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, artifact.content); }
    if (fixture.grader === "cache-boundary") return await gradeCache(dir, fixture);
    return await gradeAtomic(dir, fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function gradeCache(dir, fixture) {
  const original = fixture.files["src/cache.mjs"]; const current = await readFile(path.join(dir, "src/cache.mjs"), "utf8").catch(() => "");
  let testsChanged = false;
  for (const [name, content] of Object.entries(fixture.files)) {
    if (name.startsWith("test/") && await readFile(path.join(dir, name), "utf8").catch(() => "") !== content) testsChanged = true;
  }
  const testFile = path.join(dir, "test/cache.test.mjs");
  const originalRun = await command([process.execPath, "--test", testFile], dir);
  await writeFile(path.join(dir, "src/cache.mjs"), `export function isFresh({ cachedAt, now = Date.now(), ttlMs }) { if (cachedAt > now) throw new RangeError("future cache timestamp"); return now - cachedAt < ttlMs; }\n`);
  const correctRun = await command([process.execPath, "--test", testFile], dir);
  const mutationResults = [];
  for (const mutant of ["export function isFresh({ cachedAt, now = Date.now(), ttlMs }) { if (cachedAt > now) throw new RangeError(); return now - cachedAt <= ttlMs; }\n", "export function isFresh({ cachedAt, now = Date.now(), ttlMs }) { return now - cachedAt < ttlMs; }\n"]) {
    await writeFile(path.join(dir, "src/cache.mjs"), mutant); const result = await command([process.execPath, "--test", testFile], dir); mutationResults.push(result.status !== 0 && !result.timedOut);
  }
  return { productionUnchanged: current === original, testsChanged, testsFailOriginal: originalRun.status !== 0, testsPassCorrect: correctRun.status === 0, mutantsKilled: mutationResults.filter(Boolean).length, mutantsKilledOutOf: 2 };
}
async function gradeAtomic(dir, fixture) {
  const visible = await command([process.execPath, "--test", "test/inventory.test.mjs"], dir);
  const visibleTest = await readFile(path.join(dir, "test/inventory.test.mjs"), "utf8").catch(() => "");
  const unchanged = visibleTest === fixture.files["test/inventory.test.mjs"];
  const hidden = `import assert from "node:assert/strict"; import test from "node:test"; import { reserve } from "../src/inventory.mjs";
 test("atomic hidden contract", () => {
  let i={A:2,B:1}; assert.throws(()=>reserve(i,[{sku:"A",quantity:1},{sku:"B",quantity:2}])); assert.deepEqual(i,{A:2,B:1});
  assert.throws(()=>reserve(i,[{sku:"A",quantity:0}])); assert.throws(()=>reserve(i,[{sku:"Z",quantity:1}]));
  i={A:3}; assert.deepEqual(reserve(i,[{sku:"A",quantity:1},{sku:"A",quantity:2}]),[{sku:"A",quantity:1},{sku:"A",quantity:2}]); assert.deepEqual(i,{A:0});
 });\n`;
  await writeFile(path.join(dir, "test/hidden.mjs"), hidden); const hiddenResult = await command([process.execPath, "--test", "test/hidden.mjs"], dir);
  return { visibleGreen: visible.status === 0, hiddenGreen: hiddenResult.status === 0, testsUnchanged: unchanged };
}
async function score(options) {
  const source = await readFile(options.input, "utf8"); const results = [];
  for (const line of source.split(/\r?\n/).filter(Boolean)) { const record = JSON.parse(line); if ((record.exitStatus != null && record.exitStatus !== 0) || record.signal) throw new Error(`Cannot score failed model run for ${record.model ?? "unknown model"}`);
    const fixture = fixtureFor(record.fixture); if (!fixture) throw new Error(`Unknown fixture in score input: ${record.fixture}`);
    if (fixture.role === "reviewer") results.push(scoreReviewer(record, fixture));
    else if (fixture.role === "reporter") { const text = String(record.response ?? "").toLowerCase(); const groups = fixture.oracle.groups; const matched = groups.filter((group) => group.every((term) => text.includes(term))).length; const contradictions = ["no follow-ups", "no followups", "no deviations", "no unresolved risks", "posting succeeded", "posted successfully", "successfully posted"].filter((term) => text.includes(term)).length; results.push({ model: record.model, fixture: record.fixture, requiredFactCount: groups.length, matchedFactCount: matched, contradictionCount: contradictions, matchesOracle: matched === groups.length && contradictions === 0 }); }
    else results.push({ model: record.model, fixture: record.fixture, ...await gradeCoding(record, fixture) });
  }
  const falsePositiveCount = results.reduce((n, result) => n + (result.falsePositiveCount ?? 0), 0); process.stdout.write(`${JSON.stringify({ results, falsePositiveCount })}\n`);
}
async function main() { const [action, ...args] = process.argv.slice(2); if (!action || action === "--help") return usage(); if (!["run", "score"].includes(action)) throw new Error(`Unknown command: ${action}`); const options = parseOptions(args, action); if (action === "run") await run(options); else await score(options); }
main().catch((error) => { console.error(`Error: ${error.message}`); usage(); process.exitCode = 1; });
