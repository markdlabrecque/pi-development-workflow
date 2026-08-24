import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const model = "openai-codex/gpt-5.6-luna";

const cases = [
  {
    fixture: "test-writer-cache-boundary",
    role: "test-writer",
    thinking: "low",
    tools: ["read", "edit", "write", "bash"],
    prompt: /cache boundary/i,
  },
  {
    fixture: "implementer-atomic-reservation",
    role: "implementer",
    thinking: "medium",
    tools: ["read", "edit", "write", "bash"],
    prompt: /atomic reservation/i,
  },
  {
    fixture: "reviewer-tenant-cache",
    role: "reviewer",
    thinking: "medium",
    tools: [],
    prompt: /tenant cache/i,
  },
  {
    fixture: "reporter-audit-fidelity",
    role: "reporter",
    thinking: "low",
    tools: [],
    prompt: /audit fidelity/i,
  },
];

test("role fixtures emit isolated dry-run assignments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-roles-"));
  try {
    for (const expected of cases) {
      const output = path.join(dir, `${expected.fixture}.jsonl`);
      const result = spawnSync(process.execPath, [
        path.join(repo, "eval/model-assignment-eval.mjs"), "run",
        "--fixture", expected.fixture,
        "--models", model,
        "--output", output,
        "--dry-run",
      ], { cwd: repo, encoding: "utf8" });

      assert.equal(result.status, 0, result.stderr);
      const records = (await readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(records.length, 1);
      const record = records[0];
      assert.equal(record.fixture, expected.fixture);
      assert.equal(record.role, expected.role);
      assert.equal(record.thinking, expected.thinking);
      assert.equal(record.model, model);

      const invocation = record.invocation;
      assert.equal(invocation[0], "pi");
      for (const argument of [
        "--mode", "json", "--model", model, "--thinking", expected.thinking,
        "--no-extensions", "--no-skills", "--no-prompt-templates",
        "--no-context-files", "--no-session", "--system-prompt",
      ]) assert.ok(invocation.includes(argument), `missing Pi argument ${argument}`);
      if (expected.tools.length) {
        const toolsIndex = invocation.indexOf("--tools");
        assert.notEqual(toolsIndex, -1);
        const enabledTools = new Set(invocation[toolsIndex + 1].split(","));
        for (const tool of expected.tools) assert.ok(enabledTools.has(tool), `missing role tool ${tool}`);
      } else {
        assert.ok(invocation.includes("--no-tools"));
      }
      assert.match(invocation.at(-1), expected.prompt);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
