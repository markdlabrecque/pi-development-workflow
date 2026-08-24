import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.dirname(path.dirname(new URL(import.meta.url).pathname));

test("reviewer fixture emits an isolated dry-run pi assignment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-eval-"));
  const output = path.join(dir, "result.jsonl");
  try {
    const result = spawnSync(process.execPath, [
      path.join(repo, "eval/model-assignment-eval.mjs"), "run",
      "--fixture", "reviewer-missing-validation",
      "--models", "openai-codex/gpt-5.6-luna",
      "--output", output,
      "--dry-run",
    ], { cwd: repo, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const records = (await readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 1);

    const record = records[0];
    assert.equal(record.fixture, "reviewer-missing-validation");
    assert.equal(record.role, "reviewer");
    assert.equal(record.model, "openai-codex/gpt-5.6-luna");
    assert.equal(record.thinking, "medium");
    assert.ok(Array.isArray(record.invocation));
    assert.equal(record.invocation[0], "pi");
    for (const argument of [
      "--mode", "json", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "medium",
      "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-context-files", "--no-session", "--system-prompt",
    ]) assert.ok(record.invocation.includes(argument), `missing Pi argument ${argument}`);
    assert.ok(record.invocation.at(-1).includes("missing validation"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("score accepts structured locations and counts only extra must-fix findings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-score-"));
  const input = path.join(dir, "results.jsonl");
  try {
    const records = [
      {
        fixture: "reviewer-missing-validation",
        model: "split-location",
        response: 'Review complete. {"findings":[{"severity":"must_fix","file":"src/signup.js","line":2,"explanation":"Email validation is missing."}]}',
      },
      {
        fixture: "reviewer-missing-validation",
        model: "extra-finding",
        response: '{"findings":[{"severity":"must_fix","location":"src/signup.js:2","explanation":"Missing email validation."},{"severity":"must_fix","location":"src/other.js:9","explanation":"Unrelated claim."}]}',
      },
    ];
    await writeFile(input, `${records.map(JSON.stringify).join("\n")}\n`);

    const result = spawnSync(process.execPath, [
      path.join(repo, "eval/model-assignment-eval.mjs"), "score", "--input", input,
    ], { cwd: repo, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const score = JSON.parse(result.stdout);
    assert.equal(score.results[0].matchesOracle, true);
    assert.equal(score.results[0].falsePositiveCount, 0);
    assert.equal(score.results[1].matchesOracle, true);
    assert.equal(score.results[1].falsePositiveCount, 1);
    assert.equal(score.falsePositiveCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live run rejects a nonzero Pi exit even after an assistant response", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-live-"));
  const fakePi = path.join(dir, "pi");
  const output = path.join(dir, "result.jsonl");
  try {
    await writeFile(fakePi, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"partial response"}]}}));\nprocess.exit(7);\n`);
    await chmod(fakePi, 0o755);

    const result = spawnSync(process.execPath, [
      path.join(repo, "eval/model-assignment-eval.mjs"), "run",
      "--fixture", "reviewer-missing-validation",
      "--models", "openai-codex/gpt-5.6-luna",
      "--output", output,
    ], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exit status 7/i);

    const score = spawnSync(process.execPath, [
      path.join(repo, "eval/model-assignment-eval.mjs"), "score", "--input", output,
    ], { cwd: repo, encoding: "utf8" });
    assert.notEqual(score.status, 0);
    assert.match(score.stderr, /failed model run/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
