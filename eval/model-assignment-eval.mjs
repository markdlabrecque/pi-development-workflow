#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, codingTools, fixtureFor, loadRolePrompt, noTools } from "./model-assignment-fixtures.mjs";

const SELF = fileURLToPath(import.meta.url);
const GRADING_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL_TIMEOUT_MS = 180_000;
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? DEFAULT_MODEL_TIMEOUT_MS);
const DEFAULT_TIMEOUT_GRACE_MS = 1_000;
const TIMEOUT_GRACE_MS = Number(process.env.MODEL_TIMEOUT_GRACE_MS ?? DEFAULT_TIMEOUT_GRACE_MS);
const EVALUATOR_ROOT = path.dirname(path.dirname(SELF));

function modelTimeoutMs() { return Number.isFinite(MODEL_TIMEOUT_MS) && MODEL_TIMEOUT_MS > 0 ? MODEL_TIMEOUT_MS : DEFAULT_MODEL_TIMEOUT_MS; }
function timeoutGraceMs() { return Number.isFinite(TIMEOUT_GRACE_MS) && TIMEOUT_GRACE_MS > 0 ? TIMEOUT_GRACE_MS : DEFAULT_TIMEOUT_GRACE_MS; }
async function sandboxAvailable() {
  if (process.platform !== "darwin") return false;
  try { await access("/usr/bin/sandbox-exec"); return true; } catch { return false; }
}
function sandboxProfile(workspace, evaluatorRoot) {
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
  const writable = [workspace, path.join(agentDir, "auth.json"), path.join(agentDir, "auth.json.lock"),
    path.join(agentDir, "settings.json"), path.join(agentDir, "settings.json.lock")];
  const writeExceptions = writable.map((entry) => `(subpath ${JSON.stringify(entry)})`).join(" ");
  return `(version 1)\n(allow default)\n(deny file-read* (subpath ${JSON.stringify(evaluatorRoot)}))\n(deny file-write* (require-not (require-any ${writeExceptions})))\n`;
}
async function codingInvocation(args, cwd) {
  if (process.platform !== "darwin") throw new Error("Coding live runs require the macOS sandbox-exec isolation backend");
  const [workspace, evaluatorRoot] = await Promise.all([realpath(cwd), realpath(EVALUATOR_ROOT)]);
  return { args: ["/usr/bin/sandbox-exec", "-p", sandboxProfile(workspace, evaluatorRoot), ...args], sandboxActive: true };
}

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
    const started = Date.now(); let stdout = ""; let stderr = ""; let timedOut = false; let forceTimer;
    const child = spawn(args[0], args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); forceTimer = setTimeout(() => child.kill("SIGKILL"), timeoutGraceMs()); }, modelTimeoutMs());
    const clearTimers = () => { clearTimeout(timer); clearTimeout(forceTimer); };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    child.on("error", (error) => { clearTimers(); resolve({ error, elapsedMs: Date.now() - started, stderr, timedOut }); });
    child.on("close", (status, signal) => { clearTimers(); resolve({ ...parsePiOutput(stdout), elapsedMs: Date.now() - started, status, signal, stderr, timedOut }); });
  });
}
async function writeFixtureFiles(dir, files) {
  for (const [name, content] of Object.entries(files ?? {})) { const target = path.join(dir, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
}
function validateArtifacts(artifacts) {
  const seen = new Set(); const validated = [];
  for (const artifact of artifacts ?? []) {
    if (!artifact || typeof artifact.path !== "string" || typeof artifact.content !== "string") throw new Error("Invalid grading artifact: path and content must be strings");
    const artifactPath = artifact.path.replaceAll("\\", "/"); const normalizedPath = path.posix.normalize(artifactPath);
    if (path.posix.isAbsolute(artifactPath) || normalizedPath === "." || normalizedPath.split("/").includes("..")) throw new Error(`Invalid grading artifact path: ${artifact.path}`);
    if (seen.has(normalizedPath)) throw new Error(`Duplicate grading artifact path: ${artifact.path}`);
    seen.add(normalizedPath); validated.push({ ...artifact, path: normalizedPath });
  }
  return validated;
}
async function materializeArtifacts(dir, artifacts) {
  for (const artifact of validateArtifacts(artifacts)) { const target = path.join(dir, artifact.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, artifact.content); }
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
    let cwd; let result; let artifacts; let sandboxActive = false;
    if (fixture.files) cwd = await mkdtemp(path.join(os.tmpdir(), "model-assignment-workspace-"));
    try {
      if (cwd) {
        await writeFixtureFiles(cwd, fixture.files);
        if (!(await sandboxAvailable())) throw new Error("Coding live run requires macOS sandbox-exec; refusing unrestricted execution");
      }
      const launched = cwd && fixture.role !== "reviewer" && fixture.role !== "reporter" ? await codingInvocation(args, cwd) : { args, sandboxActive: false };
      sandboxActive = launched.sandboxActive; result = await runPi(launched.args, cwd); if (cwd) artifacts = await regularArtifacts(cwd);
    }
    finally { if (cwd) await rm(cwd, { recursive: true, force: true }); }
    records.push({ fixture: fixture.name, role: fixture.role, model, thinking: fixture.thinking, invocation: args, sandboxActive,
      response: result.finalText || null, ...(artifacts ? { artifacts } : {}), elapsedMs: result.elapsedMs, usage: result.usage ?? null,
      timedOut: result.timedOut === true, exitStatus: result.status ?? null, signal: result.signal ?? null, stderr: result.stderr ?? "" });
  }
  await writeFile(options.output, `${records.map(JSON.stringify).join("\n")}\n`);
  if (!options.dryRun) { const failed = records.find((r) => r.timedOut || r.exitStatus !== 0 || r.signal || !r.response); if (failed) throw new Error(`Pi failed for ${failed.model}; exit status ${failed.exitStatus ?? "unavailable"}${failed.signal ? `, signal ${failed.signal}` : ""}${failed.stderr ? `: ${failed.stderr.trim()}` : ""}`); }
}
function responseFindings(response) {
  const text = String(response ?? "");
  let start = -1; let depth = 0; let quoted = false; let escaped = false; let latest;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{") { if (depth === 0) start = index; depth++; }
    else if (character === "}" && depth > 0 && --depth === 0 && start >= 0) {
      try { const parsed = JSON.parse(text.slice(start, index + 1)); if (Array.isArray(parsed.findings)) latest = parsed.findings; } catch {}
    }
  }
  return latest ?? [text];
}
function findingText(finding) { return JSON.stringify(finding).toLowerCase(); }
function findingLocation(finding) {
  if (finding && typeof finding === "object") return [finding.location, finding.file, finding.snippet, finding.code, finding.range, finding.line != null && finding.file ? `${finding.file}:${finding.line}` : ""].filter(Boolean).join(" ").toLowerCase();
  return String(finding).toLowerCase();
}
function scoreReviewer(record, fixture) {
  const expected = fixture.oracle.findings; const findings = responseFindings(record.response);
  const blocking = findings.map((finding, index) => ({ finding, index })).filter(({ finding }) => /must[_ -]?fix/i.test([finding?.severity, finding?.classification, finding].filter(Boolean).join(" ")));
  const used = new Set();
  const matched = expected.filter((oracle) => {
    const match = blocking.find(({ finding, index }) => {
      const text = findingText(finding);
      return !used.has(index) && findingLocation(finding).includes(oracle.file) && oracle.terms.every((term) => text.includes(term)) && (!oracle.anyTerms || oracle.anyTerms.some((term) => text.includes(term))) && !(oracle.rejectTerms ?? []).some((term) => text.includes(term));
    });
    if (!match) return false;
    used.add(match.index); return true;
  });
  const falsePositiveCount = findings.filter((finding, index) => !used.has(index) && !/\b(?:approved|no[_ -]?finding)\b/i.test([finding?.classification, finding?.severity].filter(Boolean).join(" "))).length;
  return { model: record.model, fixture: record.fixture, hasMustFix: blocking.length > 0, expectedFindingCount: expected.length,
    matchedFindingCount: matched.length, missedFindingCount: expected.length - matched.length, falsePositiveCount,
    matchesOracle: matched.length === expected.length && falsePositiveCount === 0 };
}
function markdownSections(text) {
  const headings = [...text.matchAll(/^#{1,6} .+$/gim)].map((m) => ({ name: m[0].trim().toLowerCase(), start: m.index, end: m.index + m[0].length }));
  const sections = new Map();
  for (let i = 0; i < headings.length; i++) sections.set(headings[i].name, text.slice(headings[i].end, headings[i + 1]?.start ?? text.length).toLowerCase());
  return sections;
}
function scoreReporter(record, fixture) {
  const sections = markdownSections(String(record.response ?? ""));
  const body = (name) => sections.get(name) ?? "";
  const groups = [
    ["## outcome", ["atomic reservation", "public api"]],
    ["## changed files", ["src/inventory.mjs", "test/inventory.test.mjs"]],
    ["### red evidence", ["node --test", "failed"]],
    ["### green evidence", ["node --test", "passed"]],
    ["## review", ["approved", "round 2"]],
    ["## follow-up", ["performance telemetry"]],
    ["## accepted deviation", ["dev-17", "reason", "risk", "evidence"]],
    ["## unresolved risk", ["concurrent callers"]],
    ["## posting", ["transport", "technical completion", "retri"]],
  ];
  const matched = groups.filter(([section, terms]) => terms.every((term) => body(section).includes(term))).length;
  const requiredHeadings = ["# report", "## verification"];
  const templateMissing = requiredHeadings.some((heading) => !sections.has(heading));
  const allText = String(record.response ?? "").toLowerCase();
  const contradictions = [/no (?:follow[- ]?ups?|deviations?|unresolved risks?)/, /retry(?:ing)? is unnecessary/, /no (?:reason|risk|evidence)/, /(?:follow[- ]?up|risk)\s*:\s*(?:none|nothing|no )/, /(?:posting succeeded|posted successfully|(?<!not )successfully posted|recorded successfully|transport (?:succeeded|was successful))/].filter((re) => re.test(allText)).length;
  return { model: record.model, fixture: record.fixture, requiredFactCount: groups.length, matchedFactCount: matched, contradictionCount: contradictions + (templateMissing ? 1 : 0), matchesOracle: matched === groups.length && contradictions === 0 && !templateMissing };
}
function command(args, cwd) {
  const env = { ...process.env };
  for (const name of ["NODE_TEST_CONTEXT", ...Object.keys(env).filter((key) => key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_WORKFLOW_"))]) delete env[name];
  return new Promise((resolve) => { let stdout = "", stderr = "", timedOut = false, forceTimer; const child = spawn(args[0], args.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); forceTimer = setTimeout(() => child.kill("SIGKILL"), timeoutGraceMs()); }, GRADING_TIMEOUT_MS); const clearTimers = () => { clearTimeout(timer); clearTimeout(forceTimer); };
    child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    child.on("error", (error) => { clearTimers(); resolve({ status: null, stdout, stderr, error, timedOut }); }); child.on("close", (status) => { clearTimers(); resolve({ status, stdout, stderr, timedOut }); }); });
}
async function gradeCoding(record, fixture) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-grade-"));
  try { await materializeArtifacts(dir, record.artifacts ?? []);
    if (fixture.grader === "cache-boundary") return await gradeCache(dir, fixture);
    return await gradeAtomic(dir, fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function gradeCache(dir, fixture) {
  const original = fixture.files["src/cache.mjs"]; const current = await readFile(path.join(dir, "src/cache.mjs"), "utf8").catch(() => "");
  const fixtureSources = new Set(Object.keys(fixture.files).filter((name) => name.startsWith("src/")));
  const actualSources = new Set((await regularArtifacts(path.join(dir, "src"))).map((x) => path.join("src", x.path)));
  let productionUnchanged = fixtureSources.size === actualSources.size && [...fixtureSources].every((name) => actualSources.has(name));
  for (const name of fixtureSources) if (await readFile(path.join(dir, name), "utf8").catch(() => null) !== fixture.files[name]) productionUnchanged = false;
  let testsChanged = false;
  for (const [name, content] of Object.entries(fixture.files)) {
    if (name.startsWith("test/") && await readFile(path.join(dir, name), "utf8").catch(() => "") !== content) testsChanged = true;
  }
  const wholeSuite = () => command([process.execPath, "--test", "test/**/*.mjs"], dir);
  const originalRun = await wholeSuite();
  await writeFile(path.join(dir, "src/cache.mjs"), `export function isFresh({ cachedAt, now = Date.now(), ttlMs }) { if (cachedAt > now) throw new RangeError("future cache timestamp"); return now - cachedAt < ttlMs; }\n`);
  const correctRun = await wholeSuite();
  const mutationResults = [];
  for (const mutant of ["export function isFresh({ cachedAt, now = Date.now(), ttlMs }) { if (cachedAt > now) throw new RangeError(); return now - cachedAt <= ttlMs; }\n", "export function isFresh({ cachedAt, now = Date.now(), ttlMs }) { return now - cachedAt < ttlMs; }\n"]) {
    await writeFile(path.join(dir, "src/cache.mjs"), mutant); const result = await wholeSuite(); mutationResults.push(result.status !== 0 && !result.timedOut);
  }
  const fixtureTests = new Set(Object.keys(fixture.files).filter((name) => name.startsWith("test/")));
  const actualTests = new Set((await regularArtifacts(path.join(dir, "test"))).map((x) => path.join("test", x.path)));
  const testFilesChanged = [];
  for (const name of new Set([...fixtureTests, ...actualTests])) {
    const actual = await readFile(path.join(dir, name), "utf8").catch(() => null);
    if ((fixture.files[name] ?? null) !== actual) testFilesChanged.push(name);
  }
  return { productionUnchanged: productionUnchanged && current === original, testsChanged: testFilesChanged.length > 0, testFilesChanged, testsFailOriginal: originalRun.status !== 0, testsPassCorrect: correctRun.status === 0, mutantsKilled: mutationResults.filter(Boolean).length, mutantsKilledOutOf: 2 };
}
async function gradeAtomic(dir, fixture) {
  const visible = await command([process.execPath, "--test", "test/**/*.mjs"], dir);
  const fixtureNonProduction = Object.entries(fixture.files).filter(([name]) => !name.startsWith("src/"));
  const workspaceContractPreserved = (await regularArtifacts(dir)).filter(({ path: name }) => !name.startsWith("src/")).length === fixtureNonProduction.length && (await Promise.all(fixtureNonProduction.map(async ([name, content]) => (await readFile(path.join(dir, name), "utf8").catch(() => null)) === content))).every(Boolean);
  const testNames = new Set((await regularArtifacts(path.join(dir, "test"))).map(({ path: name }) => path.join("test", name)));
  const fixtureTestNames = new Set(Object.keys(fixture.files).filter((name) => name.startsWith("test/")));
  const testsUnchanged = workspaceContractPreserved && testNames.size === fixtureTestNames.size && [...testNames].every((name) => fixtureTestNames.has(name));
  const hidden = `import assert from "node:assert/strict"; import test from "node:test"; import { reserve } from "../src/inventory.mjs";
 test("atomic hidden contract", () => {
  let i={A:2,B:1}; assert.throws(()=>reserve(i,[{sku:"A",quantity:1},{sku:"B",quantity:2}])); assert.deepEqual(i,{A:2,B:1});
  assert.throws(()=>reserve(i,[{sku:"A",quantity:0}])); assert.throws(()=>reserve(i,[{sku:"Z",quantity:1}]));
  i={A:3}; assert.throws(()=>reserve(i,[{sku:"A",quantity:2},{sku:"A",quantity:2}])); assert.deepEqual(i,{A:3});
  assert.deepEqual(reserve(i,[{sku:"A",quantity:1},{sku:"A",quantity:2}]),[{sku:"A",quantity:1},{sku:"A",quantity:2}]); assert.deepEqual(i,{A:0});
 });\n`;
  await writeFile(path.join(dir, "test/hidden.mjs"), hidden); const hiddenResult = await command([process.execPath, "--test", "test/hidden.mjs"], dir);
  return { visibleGreen: visible.status === 0, hiddenGreen: hiddenResult.status === 0, workspaceContractPreserved, testsUnchanged };
}
async function score(options) {
  const source = await readFile(options.input, "utf8"); const results = [];
  for (const line of source.split(/\r?\n/).filter(Boolean)) { const record = JSON.parse(line); if (record.timedOut) throw new Error(`Cannot score timed-out model run for ${record.model ?? "unknown model"}`);
    if (record.exitStatus !== 0 || record.signal) throw new Error(`Cannot score failed model run for ${record.model ?? "unknown model"}`);
    const fixture = fixtureFor(record.fixture); if (!fixture) throw new Error(`Unknown fixture in score input: ${record.fixture}`);
    if (fixture.role === "reviewer") results.push(scoreReviewer(record, fixture));
    else if (fixture.role === "reporter") results.push(scoreReporter(record, fixture));
    else results.push({ model: record.model, fixture: record.fixture, ...await gradeCoding(record, fixture) });
  }
  const falsePositiveCount = results.reduce((n, result) => n + (result.falsePositiveCount ?? 0), 0); process.stdout.write(`${JSON.stringify({ results, falsePositiveCount })}\n`);
}
async function main() { const [action, ...args] = process.argv.slice(2); if (!action || action === "--help") return usage(); if (!["run", "score"].includes(action)) throw new Error(`Unknown command: ${action}`); const options = parseOptions(args, action); if (action === "run") await run(options); else await score(options); }
main().catch((error) => { console.error(`Error: ${error.message}`); usage(); process.exitCode = 1; });
