import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixtureFor } from "./model-assignment-fixtures.mjs";

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
        exitStatus: 0,
        response: 'Review complete. {"findings":[{"severity":"must_fix","file":"src/signup.js","line":2,"explanation":"Email validation is missing."}]}',
      },
      {
        fixture: "reviewer-missing-validation",
        model: "extra-finding",
        exitStatus: 0,
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
    assert.equal(score.results[1].matchesOracle, false);
    assert.equal(score.results[1].falsePositiveCount, 1);
    assert.equal(score.falsePositiveCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grading rejects unsafe artifacts before writing outside its workspace", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-artifacts-"));
  const input = path.join(dir, "results.jsonl"); const outside = path.join(dir, "escape");
  try {
    await writeFile(input, JSON.stringify({ fixture: "test-writer-cache-boundary", model: "fake", exitStatus: 0, artifacts: [{ path: "../escape", content: "must not write" }] }) + "\n");
    const result = spawnSync(process.execPath, [path.join(repo, "eval/model-assignment-eval.mjs"), "score", "--input", input], { cwd: repo, encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /invalid grading artifact path/i);
    await assert.rejects(readFile(outside), /ENOENT/);

    await writeFile(input, JSON.stringify({ fixture: "test-writer-cache-boundary", model: "duplicate", exitStatus: 0, artifacts: [{ path: "test/x.mjs", content: "first" }, { path: "test//x.mjs", content: "second" }] }) + "\n");
    const duplicate = spawnSync(process.execPath, [path.join(repo, "eval/model-assignment-eval.mjs"), "score", "--input", input], { cwd: repo, encoding: "utf8" });
    assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /duplicate grading artifact path/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("test-writer grader accepts a new test file without production changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-writer-")); const input = path.join(dir, "result.jsonl");
  try {
    const fixture = fixtureFor("test-writer-cache-boundary");
    const artifacts = Object.entries(fixture.files).map(([p, content]) => ({ path: p, content }));
    artifacts.push({ path: "test/boundary.test.mjs", content: `import assert from "node:assert/strict"; import test from "node:test"; import { isFresh } from "../src/cache.mjs"; test("TTL boundary is stale", () => assert.equal(isFresh({ cachedAt: 1, now: 2, ttlMs: 1 }), false)); test("future timestamps reject", () => assert.throws(() => isFresh({ cachedAt: 2, now: 1, ttlMs: 1 }), RangeError));\n` });
    await writeFile(input, JSON.stringify({ fixture: fixture.name, model: "synthetic", exitStatus: 0, artifacts }) + "\n");
    const result = spawnSync(process.execPath, [path.join(repo, "eval/model-assignment-eval.mjs"), "score", "--input", input], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); const scored = JSON.parse(result.stdout).results[0];
    assert.equal(scored.productionUnchanged, true); assert.equal(scored.testsChanged, true); assert.deepEqual(scored.testFilesChanged, ["test/boundary.test.mjs"]); assert.equal(scored.testsFailOriginal, true); assert.equal(scored.testsPassCorrect, true); assert.equal(scored.mutantsKilled, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("implementer hidden grading catches duplicate oversubscription and test changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-implementer-")); const input = path.join(dir, "results.jsonl");
  try {
    const fixture = fixtureFor("implementer-atomic-reservation");
    const flawedSource = `export function reserve(inventory, requested) { for (const item of requested) { if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new RangeError(); if (!(item.sku in inventory) || inventory[item.sku] < item.quantity) throw new Error(); } for (const item of requested) inventory[item.sku] -= item.quantity; return requested; }\n`;
    const base = Object.entries(fixture.files).map(([artifactPath, content]) => ({ path: artifactPath, content: artifactPath === "src/inventory.mjs" ? flawedSource : content }));
    const changedTests = [...base, { path: "test/extra.test.mjs", content: "// unauthorized test change\n" }];
    await writeFile(input, `${JSON.stringify({ fixture: fixture.name, model: "bad-aggregate", exitStatus: 0, artifacts: base })}\n${JSON.stringify({ fixture: fixture.name, model: "changed-tests", exitStatus: 0, artifacts: changedTests })}\n`);

    const result = spawnSync(process.execPath, [path.join(repo, "eval/model-assignment-eval.mjs"), "score", "--input", input], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); const [aggregate, integrity] = JSON.parse(result.stdout).results;
    assert.equal(aggregate.visibleGreen, true); assert.equal(aggregate.hiddenGreen, false); assert.equal(aggregate.workspaceContractPreserved, true);
    assert.equal(integrity.testsUnchanged, false); assert.equal(integrity.workspaceContractPreserved, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("timed-out runs are persisted and rejected even when Pi exits zero", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-timeout-")); const fakePi = path.join(dir, "pi"); const output = path.join(dir, "result.jsonl");
  try {
    await writeFile(fakePi, `#!/usr/bin/env node\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`); await chmod(fakePi, 0o755);
    const result = spawnSync(process.execPath, [path.join(repo, "eval/model-assignment-eval.mjs"), "run", "--fixture", "reviewer-missing-validation", "--models", "fake", "--output", output], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, MODEL_TIMEOUT_MS: "20", MODEL_TIMEOUT_GRACE_MS: "20" } });
    assert.notEqual(result.status, 0); const record = JSON.parse((await readFile(output, "utf8")).trim()); assert.equal(record.timedOut, true);
    const scored = spawnSync(process.execPath, [path.join(repo, "eval/model-assignment-eval.mjs"), "score", "--input", output], { cwd: repo, encoding: "utf8" });
    assert.notEqual(scored.status, 0); assert.match(scored.stderr, /timed-out/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("coding live runs sandbox repository reads and writes outside the workspace", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-sandbox-")); const fakePi = path.join(dir, "pi"); const output = path.join(dir, "result.jsonl"); const outside = path.join(dir, "outside-write");
  const fixtureModule = path.join(repo, "eval/model-assignment-fixtures.mjs");
  try {
    await writeFile(fakePi, `#!/usr/bin/env node\nconst fs=require("node:fs"); let readDenied=false,writeDenied=false; try{fs.readFileSync(${JSON.stringify(fixtureModule)})}catch{readDenied=true} try{fs.writeFileSync(${JSON.stringify(outside)},"escape")}catch{writeDenied=true} fs.writeFileSync("sandbox-proof.json",JSON.stringify({readDenied,writeDenied})); console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}}));\n`); await chmod(fakePi, 0o755);
    const result = spawnSync(process.execPath, [path.join(repo, "eval/model-assignment-eval.mjs"), "run", "--fixture", "test-writer-cache-boundary", "--models", "fake", "--output", output], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, MODEL_EVAL_PLATFORM: "darwin" } });
    assert.equal(result.status, 0, result.stderr); const record = JSON.parse((await readFile(output, "utf8")).trim());
    assert.equal(record.sandboxActive, true); const proof = record.artifacts.find((artifact) => artifact.path === "sandbox-proof.json"); assert.deepEqual(JSON.parse(proof.content), { readDenied: true, writeDenied: true });
    await assert.rejects(readFile(outside), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reporter scoring requires the fixed sections and rejects negated facts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-reporter-")); const input = path.join(dir, "results.jsonl");
  try {
    const report = `# Report\n## Outcome\natomic reservation public API\n## Changed files\nsrc/inventory.mjs test/inventory.test.mjs\n## Verification\n### Red evidence\nred node --test failed\n### Green evidence\ngreen node --test passed\n## Review\napproved round 2\n## Follow-up\nFollow-up: performance telemetry; no follow-ups are needed.\n## Accepted deviation\naccepted deviation DEV-17 reason risk evidence\n## Unresolved risk\nunresolved risk concurrent callers\n## Posting\ntransport technical completion retried; retry is unnecessary. Posting succeeded on the second attempt.`;
    await writeFile(input, JSON.stringify({ fixture: "reporter-audit-fidelity", model: "contradictory", exitStatus: 0, response: report }) + "\n");
    const result = spawnSync(process.execPath, [path.join(repo, "eval/model-assignment-eval.mjs"), "score", "--input", input], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); const score = JSON.parse(result.stdout).results[0];
    assert.equal(score.matchedFactCount, 9); assert.ok(score.contradictionCount > 0); assert.equal(score.matchesOracle, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
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
