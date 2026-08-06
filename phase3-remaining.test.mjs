import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
const ai = await import(path.join(nodeModules, "@earendil-works", "pi-ai", "dist", "compat.js"));
const faux = await import(path.join(nodeModules, "@earendil-works", "pi-ai", "dist", "providers", "faux.js"));
const directory = path.dirname(fileURLToPath(new URL("./index.ts", import.meta.url)));
const state = await jiti.import(path.join(directory, "workflow-state.ts"));
const compaction = await jiti.import(path.join(directory, "compaction-state.ts"));
const records = await jiti.import(path.join(directory, "system-of-record.ts"));
const indexModule = await jiti.import(path.join(directory, "index.ts"), { default: true });
const developmentWorkflow = indexModule.default ?? indexModule;

function reportingState(id, type, repository) {
  const result = state.createState({ id, goal: "Preserve a very important workflow goal", repositoryRoot: process.cwd(), systemOfRecord: { type, repository, approved: true } });
  result.stage = "reporting";
  result.implementationSummary = "Implemented the requested work";
  return result;
}

test("workflow compaction snapshots are bounded and replace stale snapshots", () => {
  const states = Array.from({ length: 5 }, (_, index) => {
    const item = reportingState(`workflow-${index}`, "file");
    item.updatedAt = `2026-01-0${index + 1}T00:00:00.000Z`;
    item.goal = "x".repeat(2_000);
    item.plan = "p".repeat(2_000);
    return item;
  });
  const snapshot = compaction.renderWorkflowSnapshot(states);
  assert.ok(snapshot.includes("workflow-4"));
  assert.ok(!snapshot.includes("workflow-0"), "only the three newest active workflows are retained");
  assert.ok(snapshot.length <= 5_000);
  const merged = compaction.mergeWorkflowSnapshot(`old summary\n${snapshot}`, snapshot.replace("workflow-4", "workflow-current"));
  assert.equal(merged.split(compaction.WORKFLOW_SNAPSHOT_START).length - 1, 1);
  assert.match(merged, /workflow-current/);
});

test("compaction hook safely falls back when no model can perform Pi compact", async () => {
  const handlers = new Map();
  const pi = { on(name, handler) { const entries = handlers.get(name) ?? []; entries.push(handler); handlers.set(name, entries); }, registerTool() {}, registerCommand() {}, getActiveTools() { return []; }, setActiveTools() {}, events: { emit() {} } };
  developmentWorkflow(pi);
  const handler = handlers.get("session_before_compact")[0];
  const result = await handler({ signal: new AbortController().signal }, { model: undefined, hasUI: false });
  assert.equal(result, undefined, "default compaction must remain available");
});

test("compaction hook preserves Pi result semantics, auth, split turns, and repeated snapshots", async () => {
  const workflowId = `compaction-hook-${Date.now()}`;
  const activeWorkflow = reportingState(workflowId, "file");
  activeWorkflow.stage = "implementing";
  await state.saveState(activeWorkflow);
  activeWorkflow.updatedAt = "9999-12-31T23:59:59.999Z";
  await writeFile(state.statePath(workflowId), JSON.stringify(activeWorkflow));
  const handlers = new Map();
  const pi = { on(name, handler) { const entries = handlers.get(name) ?? []; entries.push(handler); handlers.set(name, entries); }, registerTool() {}, registerCommand() {}, getActiveTools() { return []; }, setActiveTools() {}, events: { emit() {} } };
  developmentWorkflow(pi);
  const handler = handlers.get("session_before_compact")[0];
  const registration = ai.registerFauxProvider({ models: [{ id: "compaction-test", contextWindow: 100_000, maxTokens: 1_000 }] });
  const calls = [];
  registration.setResponses([
    (context, options) => { calls.push({ context, options }); return faux.fauxAssistantMessage("first compact summary"); },
    (context, options) => { calls.push({ context, options }); return faux.fauxAssistantMessage("split history summary"); },
    (context, options) => { calls.push({ context, options }); return faux.fauxAssistantMessage("split turn summary"); },
    (context, options) => { calls.push({ context, options }); return faux.fauxAssistantMessage("repeated compact summary"); },
  ]);
  const model = registration.getModel();
  const ctx = {
    model,
    hasUI: false,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "compaction-token", headers: { "x-compaction": "test" }, env: { COMPACTION_ENV: "set" } }) },
  };
  const prep = (overrides = {}) => ({
    firstKeptEntryId: "kept-entry",
    messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "summarize this" }], timestamp: Date.now() }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 321,
    fileOps: { read: new Set(["read-only.ts", "changed.ts"]), written: new Set(), edited: new Set(["changed.ts"]) },
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 50 },
    ...overrides,
  });
  try {
    const first = await handler({ preparation: prep(), signal: new AbortController().signal }, ctx);
    assert.equal(first.compaction.firstKeptEntryId, "kept-entry");
    assert.equal(first.compaction.tokensBefore, 321);
    assert.deepEqual(first.compaction.details, { readFiles: ["read-only.ts"], modifiedFiles: ["changed.ts"] }, "compact() metadata survives the hook");
    assert.match(first.compaction.summary, new RegExp(workflowId));
    assert.equal(calls[0].options.apiKey, "compaction-token");
    assert.deepEqual(calls[0].options.headers, { "x-compaction": "test" });
    assert.deepEqual(calls[0].options.env, { COMPACTION_ENV: "set" });

    const failedAuth = await handler({ preparation: prep(), signal: new AbortController().signal }, { ...ctx, modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("token refresh failed"); } } });
    assert.equal(failedAuth, undefined, "authentication exceptions also delegate to Pi's default compaction");

    const split = await handler({ preparation: prep({ isSplitTurn: true, turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: "early split-turn context" }], timestamp: Date.now() }], previousSummary: first.compaction.summary }), signal: new AbortController().signal }, ctx);
    assert.match(split.compaction.summary, /Turn Context \(split turn\)/, "Pi split-turn handling is retained");
    assert.equal(calls.length, 3, "split turns make the history and turn-prefix compaction calls");

    const repeated = await handler({ preparation: prep({ previousSummary: split.compaction.summary }), signal: new AbortController().signal }, ctx);
    assert.equal(calls.length, 4);
    assert.equal(repeated.compaction.summary.split(compaction.WORKFLOW_SNAPSHOT_START).length - 1, 1, "repeated hook compactions replace, rather than accumulate, workflow state");
  } finally {
    registration.unregister();
    await state.removeState(workflowId);
  }
});

test("GitHub lookup comments existing issues and fails closed on indeterminate output", async () => {
  const repository = "owner/repository";
  const cwd = "/workflow-checkout";
  const makeState = id => {
    const result = reportingState(id, "github", repository);
    result.repositoryRoot = cwd;
    return result;
  };
  const expectedLookup = state => ["issue", "list", "--repo", repository, "--state", "all", "--search", `\"[development-workflow] ${state.id}\" in:title`, "--json", "number,title", "--jq", `.[] | select(.title == ${JSON.stringify(`[development-workflow] ${state.id}`)}) | .number`];

  const existingState = makeState("github-existing");
  const existingCommands = [];
  await records.createSystemOfRecord(async (command, args, commandCwd) => {
    existingCommands.push({ command, args, cwd: commandCwd });
    return args[1] === "list" ? " 42 \n" : "";
  }).update(existingState);
  assert.deepEqual(existingCommands, [
    { command: "gh", args: expectedLookup(existingState), cwd },
    { command: "gh", args: ["issue", "comment", "42", "--repo", repository, "--body", records.renderWorkplan(existingState)], cwd },
  ], "an exact existing issue number is commented instead of creating a duplicate");

  const blankState = makeState("github-blank");
  const blankCommands = [];
  await records.createSystemOfRecord(async (command, args, commandCwd) => {
    blankCommands.push({ command, args, cwd: commandCwd });
    return " \n\t ";
  }).update(blankState);
  assert.deepEqual(blankCommands, [
    { command: "gh", args: expectedLookup(blankState), cwd },
    { command: "gh", args: ["issue", "create", "--repo", repository, "--title", "[development-workflow] github-blank", "--body", records.renderWorkplan(blankState)], cwd },
  ], "a successful blank lookup retains new-issue creation");

  for (const [id, lookup, error] of [
    ["github-lookup-failure", () => { throw new Error("network unavailable"); }, /Unable to look up GitHub workflow issue: network unavailable/],
    ["github-malformed-lookup", () => "not-a-number", /Unable to look up GitHub workflow issue/],
    ["github-multiple-matches", () => "42\n43", /Unable to look up GitHub workflow issue/],
  ]) {
    const workflowState = makeState(id);
    const commands = [];
    await assert.rejects(records.createSystemOfRecord(async (command, args, commandCwd) => {
      commands.push({ command, args, cwd: commandCwd });
      return lookup();
    }).update(workflowState), error);
    assert.deepEqual(commands, [{ command: "gh", args: expectedLookup(workflowState), cwd }], `${id} must not write after an indeterminate lookup`);
  }
});

test("GitLab and Bitbucket writers use approved repositories and credential-safe commands", async () => {
  const commands = [];
  const run = async (command, args, cwd) => {
    commands.push({ command, args, cwd });
    if (command === "glab" && args[1] === "list") return "[]";
    if (command === "git") return "git@bitbucket.org:workspace/repository.git";
    if (command === "curl" && !args.includes("--request")) return JSON.stringify({ values: [] });
    return "";
  };
  const operations = records.createSystemOfRecord(run);
  await operations.update(reportingState("github-test", "github", "owner/repository"));
  assert.ok(commands.some(entry => entry.command === "gh" && entry.args.includes("create")), "existing GitHub issue creation is retained");

  commands.length = 0;
  await operations.update(reportingState("gitlab-test", "gitlab", "group/project"));
  assert.deepEqual(commands[0].command, "glab");
  assert.ok(commands.some(entry => entry.command === "glab" && entry.args.includes("create")));

  commands.length = 0;
  await operations.update(reportingState("bitbucket-test", "bitbucket", "workspace/repository"));
  assert.equal(commands[0].command, "git", "Bitbucket verifies origin before API access");
  const curl = commands.filter(entry => entry.command === "curl");
  assert.equal(curl.length, 2);
  assert.ok(curl.every(entry => entry.args.includes("--netrc")));
  assert.ok(curl.some(entry => entry.args.includes("--request") && entry.args.includes("POST")));
});

test("GitLab and Bitbucket lookup failures fail closed rather than creating duplicate issues", async () => {
  for (const [type, repository] of [["gitlab", "group/project"], ["bitbucket", "workspace/repository"]]) {
    const commands = [];
    const run = async (command, args, cwd) => {
      commands.push({ command, args, cwd });
      if (command === "git") return "git@bitbucket.org:workspace/repository.git";
      throw new Error("remote lookup unavailable");
    };
    const operations = records.createSystemOfRecord(run);
    await assert.rejects(operations.update(reportingState(`${type}-lookup-failure`, type, repository)), /Unable to look up .*workflow issue/i);
    assert.ok(!commands.some(entry => entry.args.includes("create") || (entry.command === "curl" && entry.args.includes("--request"))), `${type} must not create an issue after an indeterminate lookup`);
  }

  const malformedGitLab = records.createSystemOfRecord(async (command, args) => command === "glab" && args[1] === "list" ? "not json" : "");
  await assert.rejects(malformedGitLab.update(reportingState("gitlab-malformed-lookup", "gitlab", "group/project")), /Unable to look up GitLab workflow issue/);
  const malformedBitbucket = records.createSystemOfRecord(async (command, args) => {
    if (command === "git") return "git@bitbucket.org:workspace/repository.git";
    if (command === "curl" && !args.includes("--request")) return "{}";
    return "";
  });
  await assert.rejects(malformedBitbucket.update(reportingState("bitbucket-malformed-lookup", "bitbucket", "workspace/repository")), /Unable to look up Bitbucket workflow issue/);
});

test("remote parsers accept canonical remotes and reject malformed repositories", () => {
  assert.equal(records.gitlabRepositoryFromRemote("git@gitlab.com:group/nested/project.git"), "group/nested/project");
  assert.equal(records.bitbucketRepositoryFromRemote("https://bitbucket.org/workspace/project.git"), "workspace/project");
  assert.equal(records.bitbucketRepositoryFromRemote("https://attacker.invalid/workspace/project.git"), undefined);
});

test("trusted configuration enables GitLab while untrusted configuration remains file-only", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-sor-"));
  try {
    await (await import("node:fs/promises")).mkdir(path.join(cwd, ".pi"));
    await (await import("node:fs/promises")).writeFile(path.join(cwd, ".pi", "development-workflow.json"), JSON.stringify({ systemOfRecord: { type: "gitlab", repository: "group/project" } }));
    const operations = records.createSystemOfRecord(async () => { throw new Error("should not detect"); });
    assert.deepEqual(await operations.resolve(cwd, true, false), { type: "gitlab", repository: "group/project", approved: true });
    assert.deepEqual(await operations.resolve(cwd, false, false), { type: "file" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
