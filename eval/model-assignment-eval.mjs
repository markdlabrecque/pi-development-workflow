#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLE = "reviewer";
const THINKING = "medium";
const FIXTURES = Object.freeze({
  "reviewer-missing-validation": Object.freeze({
    name: "reviewer-missing-validation",
    role: ROLE,
    prompt: `Review this bundle as an independent, read-only Reviewer. Attack the named suspected weakness first. Return structured findings with severity, a concrete file/line when available, and a concise explanation.

Acceptance criteria:
- Invalid email addresses must be rejected before they are written.

Named suspected weakness: missing validation in the new email-writing path may accept an invalid email without validation.

Implementation diff:
 diff --git a/src/signup.js b/src/signup.js
 --- a/src/signup.js
 +++ b/src/signup.js
 @@ -1,5 +1,7 @@
  export function saveSignup(input, store) {
 +  store.write({ email: input.email });
 +  return true;
  }

Review bundle: src/signup.js (the complete changed file is shown in the diff above).`,
    oracle: Object.freeze({
      severity: "must_fix",
      file: "src/signup.js",
      line: 2,
      terms: ["validat", "email"],
    }),
  }),
});

function usage() {
  console.error(`Usage:
  node eval/model-assignment-eval.mjs run --fixture <name> --models <model[,model...]> --output <path> [--dry-run]
  node eval/model-assignment-eval.mjs score --input <jsonl>`);
}

function parseOptions(args, command) {
  const options = { dryRun: false };
  const valueOptions = new Set(command === "run" ? ["fixture", "models", "output"] : ["input"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run" && command === "run") {
      options.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--") || !valueOptions.has(arg.slice(2)) || i + 1 >= args.length || args[i + 1].startsWith("--")) {
      throw new Error(`Invalid option: ${arg}`);
    }
    options[arg.slice(2)] = args[++i];
  }
  for (const required of valueOptions) if (!options[required]) throw new Error(`Missing required option: --${required}`);
  if (command === "run") {
    if (!FIXTURES[options.fixture]) throw new Error(`Unknown fixture: ${options.fixture}`);
    options.models = options.models.split(",").map((model) => model.trim()).filter(Boolean);
    if (!options.models.length) throw new Error("--models must contain at least one model");
  }
  return options;
}

function rolePrompt() {
  const text = new URL("../agents/reviewer.md", import.meta.url);
  return readFile(fileURLToPath(text), "utf8").then((source) => source.replace(/^---\n[\s\S]*?\n---\n?/, "").trim());
}

function invocation(model, systemPrompt, fixturePrompt) {
  return ["pi", "--mode", "json", "--model", model, "--thinking", THINKING,
    "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-context-files", "--no-session", "--system-prompt", systemPrompt, fixturePrompt];
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

function parsePiOutput(stdout) {
  let finalText = "";
  let usage;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event.message ?? event;
    if (message.role === "assistant") {
      const text = textFromContent(message.content ?? message.text);
      if (text) finalText = text;
      if (message.usage) usage = message.usage;
      else if (event.usage) usage = event.usage;
    }
  }
  return { finalText, usage };
}

function runPi(args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ error, elapsedMs: Date.now() - started, stderr }));
    child.on("close", (status, signal) => resolve({ ...parsePiOutput(stdout), elapsedMs: Date.now() - started, status, signal, stderr }));
  });
}

async function run(options) {
  const fixture = FIXTURES[options.fixture];
  const systemPrompt = await rolePrompt();
  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  const records = [];
  for (const model of options.models) {
    const args = invocation(model, systemPrompt, fixture.prompt);
    if (options.dryRun) {
      records.push({ fixture: fixture.name, role: ROLE, model, thinking: THINKING, invocation: args });
      continue;
    }
    const result = await runPi(args);
    records.push({ fixture: fixture.name, role: ROLE, model, thinking: THINKING, invocation: args,
      response: result.finalText || null, elapsedMs: result.elapsedMs, usage: result.usage ?? null,
      exitStatus: result.status ?? null, signal: result.signal ?? null, stderr: result.stderr ?? "" });
  }
  await writeFile(options.output, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  if (!options.dryRun) {
    const failed = records.find((record) => record.exitStatus !== 0 || record.signal || !record.response);
    if (failed) throw new Error(`Pi failed for ${failed.model}; exit status ${failed.exitStatus ?? "unavailable"}${failed.signal ? `, signal ${failed.signal}` : ""}${failed.stderr ? `: ${failed.stderr.trim()}` : ""}`);
  }
}

function responseFindings(response) {
  const text = String(response ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed.findings)) return parsed.findings;
    } catch { /* fall back to matching the complete response */ }
  }
  return [text];
}

function score(options) {
  return readFile(options.input, "utf8").then((source) => {
    const results = [];
    for (const line of source.split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line);
      if ((record.exitStatus != null && record.exitStatus !== 0) || record.signal) {
        throw new Error(`Cannot score failed model run for ${record.model ?? "unknown model"}`);
      }
      const oracle = FIXTURES[record.fixture]?.oracle;
      if (!oracle) throw new Error(`Unknown fixture in score input: ${record.fixture}`);
      const expectedLocation = `${oracle.file}:${oracle.line}`.toLowerCase();
      const mustFixFindings = responseFindings(record.response).filter((finding) => {
        const severity = typeof finding === "object" && finding ? finding.severity ?? finding.classification : "";
        return /must[_ -]?fix/i.test(String(severity || finding));
      });
      const matchingFindings = mustFixFindings.filter((finding) => {
        const location = typeof finding === "object" && finding
          ? finding.location ?? (finding.file && finding.line != null ? `${finding.file}:${finding.line}` : finding.file ?? "")
          : String(finding);
        const text = JSON.stringify(finding).toLowerCase();
        return String(location).toLowerCase().includes(expectedLocation)
          && oracle.terms.every((term) => text.includes(term.toLowerCase()));
      });
      const falsePositiveCount = Math.max(0, mustFixFindings.length - matchingFindings.length);
      results.push({ model: record.model, fixture: record.fixture, hasMustFix: mustFixFindings.length > 0,
        matchesOracle: matchingFindings.length > 0, falsePositiveCount });
    }
    const falsePositiveCount = results.reduce((total, result) => total + result.falsePositiveCount, 0);
    process.stdout.write(`${JSON.stringify({ results, falsePositiveCount })}\n`);
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || !command) { usage(); return; }
  if (command !== "run" && command !== "score") throw new Error(`Unknown command: ${command}`);
  const options = parseOptions(args, command);
  if (command === "run") await run(options); else await score(options);
}

main().catch((error) => { console.error(`Error: ${error.message}`); usage(); process.exitCode = 1; });
