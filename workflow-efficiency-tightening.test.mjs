import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = name => fs.readFileSync(path.join(here, name), "utf8");
const agent = role => source(path.join("agents", `${role}.md`));

function requires(text, pattern, message) {
  assert.match(text, pattern, message);
}

test("workflow clean-start preflight gives one recoverable ownership-aware error", () => {
  const index = source("index.ts");
  requires(index, /clean-start preflight/i, "start must use a named clean-start preflight");
  requires(index, /target worktree/i, "the error must identify the target worktree requirement");
  requires(index, /checkpoint/i, "the error must identify the checkpoint requirement");
  requires(index, /task-owned dirty/i, "task-owned dirt must be explicitly distinguished");
  requires(index, /acknowledged unrelated dirty/i, "acknowledged unrelated dirt must remain protected");
  requires(index, /release.*task-owned dirty|task-owned dirty.*release/i, "acknowledged task-owned dirt must be released rather than permanently locked");
});

test("workflow child bash guard rejects a sibling call in the same turn immediately", () => {
  const index = source("index.ts");
  requires(index, /at most one bash call per assistant turn/i, "child policy must state the per-turn bash limit");
  requires(index, /sibling bash/i, "the second bash call must be recognized as a sibling");
  requires(index, /combine commands/i, "the rejection must tell the child how to recover");
  assert.doesNotMatch(index, /bash[\s\S]{0,500}setTimeout\([^,]+,\s*10000\)/i, "the sibling-bash guard must not wait ten seconds");
});

test("role prompts bound discovery, handoffs, and role-specific gate responsibilities", () => {
  const prompts = [agent("test-writer"), agent("implementer"), agent("reviewer"), agent("reporter")].join("\n");
  requires(prompts, /one compact artifact bundle/i, "roles must hand off one compact bundle");
  requires(prompts, /prohibit.*broad rediscovery|no repeated broad rediscovery/i, "roles must not rediscover broadly after handoff");
  requires(prompts, /whole-file rereads/i, "roles must avoid whole-file rereads");
  requires(prompts, /handoff.*(?:cap|limit|maximum)|(?:cap|limit|maximum).*handoff/i, "workflow handoffs must be bounded");
  requires(agent("test-writer"), /initial minimal targeted-red contract/i, "Test Writer is limited to the initial red contract");
  requires(agent("test-writer"), /must not.*post-review architecture redesign/i, "Test Writer cannot be reassigned to redesign");
  requires(agent("implementer"), /targeted gate.*iterat/i, "Implementer iterates with targeted gates");
  requires(agent("implementer"), /one full gate.*(?:handoff|review bounce)/i, "Implementer runs one full gate at handoff/bounce");
  requires(agent("reviewer"), /full gate once per round/i, "Reviewer runs the full gate once per round");
  requires(agent("reviewer"), /failure requires diagnosis/i, "Reviewer may add diagnosis only after a failure");
});

test("approved plan defines executable coupling evidence before implementation", () => {
  const index = source("index.ts");
  requires(index, /approved plan/i, "workflow start requires an approved plan");
  requires(index, /acceptance criteria/i, "workflow start requires acceptance criteria");
  requires(index, /executable evidence/i, "mechanically coupled acceptance must declare executable evidence");
  requires(index, /architecture contract/i, "mechanically coupled acceptance must declare its architecture contract");
  requires(index, /before implementation/i, "the evidence contract must precede implementation");
});

test("dispatch defaults, session reuse, and status timing follow the efficient workflow contract", () => {
  const roles = source("roles.ts");
  const index = source("index.ts");
  requires(roles, /test-writer[\s\S]{0,300}thinking:\s*["']low["']/i, "Test Writer defaults to low thinking");
  requires(roles, /reporter[\s\S]{0,300}thinking:\s*["']low["']/i, "Reporter defaults to low thinking");
  requires(roles, /implementer[\s\S]{0,300}thinking:\s*["']medium["']/i, "Implementer defaults to medium thinking");
  requires(roles, /reviewer[\s\S]{0,300}thinking:\s*["']medium["']/i, "Reviewer defaults to medium thinking");
  requires(index, /explicit.*thinking.*override|thinking.*explicit.*override/i, "explicit thinking overrides remain valid");
  requires(index, /reviewer.*fresh session|fresh session.*reviewer/i, "every Reviewer dispatch uses a fresh context");
  requires(index, /stable logical Implementer role[\s\S]{0,180}physical attempts.*foreground-replaceable|physical attempts.*foreground-replaceable[\s\S]{0,180}stable logical Implementer role/i, "Implementer authority remains logical while physical attempts require foreground-authorized replacement");
  requires(index, /cumulative active run time/i, "status reports accumulated active runtime");
  requires(index, /persistent idle\/waiting time/i, "status reports idle/waiting time separately");
});
