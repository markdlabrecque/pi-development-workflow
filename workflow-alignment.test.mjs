import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const jiti = piRequire("jiti")(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js") } });
const load = name => jiti.import(path.join(here, name));

test("new workflows use the red-first versioned state machine while v3 remains recoverable", async () => {
  const state = await load("workflow-state.ts");
  assert.equal(state.CURRENT_STATE_VERSION, 5);
  const created = state.createState({ id: "alignment", goal: "align", repositoryRoot: process.cwd() });
  assert.equal(created.stage, "red_testing");
  assert.deepEqual(created.stageSequence, ["red_testing", "implementing", "reviewing", "reporting"]);
  const legacy = { ...created, version: 3, stage: "testing", stageSequence: ["implementing", "testing", "reviewing", "reporting"] };
  const migrated = state.migrateState(legacy);
  assert.equal(migrated.stage, "testing");
  assert.deepEqual(migrated.stageSequence, legacy.stageSequence);
});

test("role routing matches Claude analogs and defaults to two review rounds", async () => {
  const roles = await load("roles.ts");
  assert.equal(roles.getRoleConfig("test-writer").model, "openai-codex/gpt-5.6-terra");
  assert.equal(roles.getRoleConfig("implementer").model, "openai-codex/gpt-5.6-terra");
  assert.equal(roles.getRoleConfig("reviewer").model, "openai-codex/gpt-5.6-sol");
  assert.equal(roles.getRoleConfig("reporter").model, "openai-codex/gpt-5.6-terra");
  const source = fs.readFileSync(path.join(here, "index.ts"), "utf8");
  assert.match(source, /DEFAULT_MAX_REVIEW_CYCLES = 2/);
  assert.doesNotMatch(source, /ollama\/qwen3\.6-pi/);
});

test("Pi policy and role prompts retain the enforceable workflow contract", () => {
  const piPolicy = fs.readFileSync(path.join(process.env.HOME, ".pi/agent/AGENTS.md"), "utf8");
  const claudePolicy = fs.readFileSync(path.join(process.env.HOME, ".claude/CLAUDE.md"), "utf8");
  for (const phrase of ["production servers", "uv sync --extra dev", "tracer bullets", "worktree", "Firefox", "Chromium"]) {
    assert.match(piPolicy.toLowerCase(), new RegExp(phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(claudePolicy.toLowerCase(), new RegExp(phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(piPolicy.toLowerCase(), /2 review rounds/);
  assert.match(claudePolicy.toLowerCase(), /2 rounds/);
  const prompts = Object.fromEntries(["test-writer", "implementer", "reviewer", "reporter"].map(role => [role, fs.readFileSync(path.join(here, "agents", `${role}.md`), "utf8")]));
  assert.match(prompts["test-writer"], /fail.*right.*reason/is);
  assert.match(prompts.implementer, /may not.*any test is red/is);
  assert.match(prompts.reviewer, /full.*gate.*first/is);
  assert.match(prompts.reporter, /docs\/reports\/YYYY-MM-DD-<task-slug>\.md/);
});

test("ratified constitutional core is platform-translated while workflow sequencing stays contextual", () => {
  const piPolicy = fs.readFileSync(path.join(process.env.HOME, ".pi/agent/AGENTS.md"), "utf8");
  const claudePolicy = fs.readFileSync(path.join(process.env.HOME, ".claude/CLAUDE.md"), "utf8");
  const readme = fs.readFileSync(path.join(here, "README.md"), "utf8");
  const prompts = Object.fromEntries(["test-writer", "implementer", "reviewer", "reporter"].map(role => [role, fs.readFileSync(path.join(here, "agents", `${role}.md`), "utf8")]));

  // Platform names differ (Pi roles vs. Claude agents), but both policies must preserve
  // the same non-overridable safety, integrity, and green-release outcomes.
  for (const policy of [piPolicy, claudePolicy]) {
    assert.match(policy, /never (?:log in to|access).*production|never access.*production/is);
    assert.match(policy, /only .*write.*production|only agent that writes production/is);
    assert.match(policy, /may not hand off.*red|hard gate.*red/is);
    assert.match(policy, /foreground.*orchestrator|main thread/is);
    assert.match(policy, /contextual|admissible next actions|outcome-based/is, "foreground sequencing must be contextual, not a rigid script");
    assert.match(policy, /(?:structured|audited|persisted).*deviation|deviation.*(?:risk|evidence)/is, "outcome-default departures require an auditable risk decision");
    assert.match(policy, /\bnew\b.*\badopt_existing\b.*\brecovery\b/is, "all supported workflow modes are documented");
    assert.match(policy, /review.*cap.*escalat|escalat.*review.*cap/is, "the review cap is an escalation boundary");
    assert.match(policy, /logical.*(?:role|implementer).*attempt|attempt.*logical.*(?:role|implementer)/is, "authority belongs to a stable logical role, not a process");
    assert.doesNotMatch(policy, /(?:must|always) follow (?:this )?(?:exact |single )?(?:sequence|pipeline)|uses fresh role contexts in this order/is);
    assert.doesNotMatch(policy, /(?:round|review) cap.*(?:automatically )?(?:block|defer)|(?:automatically )?(?:block|defer).*(?:round|review) cap/is);
    assert.doesNotMatch(policy, /same (?:physical )?(?:implementer )?(?:session|agent)|original implementer session/is);
  }

  assert.match(readme, /\bnew\b.*\badopt_existing\b.*\brecovery\b/is);
  assert.match(readme, /accepted deviations?.*(?:risk|evidence)|(?:risk|evidence).*accepted deviations?/is);
  assert.match(readme, /admissible next actions|outcome-based/is);
  assert.match(readme, /logical.*role.*(?:attempt|replacement)|(?:attempt|replacement).*logical.*role/is);
  assert.doesNotMatch(readme, /Fixes always return to the original stable Implementer session|(?:round|review) cap.*(?:automatically )?(?:block|defer)|(?:automatically )?(?:block|defer).*(?:round|review) cap/is);
  for (const [role, prompt] of Object.entries(prompts)) {
    assert.match(prompt, /(?:outcome|responsibilit)/i, `${role} states its outcome responsibility`);
    assert.match(prompt, /(?:may|only|never) .*(?:action|write|return|record|run)/is, `${role} states admissible actions`);
    assert.match(prompt, /(?:deviation|risk)/i, `${role} surfaces deviations or risks`);
    assert.match(prompt, /saniti[sz]ed.*(?:test|gate)|(?:test|gate).*saniti[sz]ed/i, `${role} requires sanitized child test/gate evidence`);
  }
});
