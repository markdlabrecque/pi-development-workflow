import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.dirname(path.dirname(new URL(import.meta.url).pathname));

test("hard role scorers accept equivalent structured findings and faithful prose", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-assignment-hard-score-"));
  const input = path.join(dir, "results.jsonl");
  try {
    const records = [
      {
        fixture: "reviewer-tenant-cache",
        model: "structured-reviewer",
        response: JSON.stringify({ findings: [
          { classification: "must_fix", severity: "critical", location: "src/tenant-cache.mjs:11", explanation: "The cache key omits the tenant and leaks values across tenants." },
          { severity: "must_fix", location: "src/tenant-cache.mjs: `now <= hit.expiresAt`", explanation: "The expiration boundary serves an entry when the timestamps are equal." },
        ] }),
      },
      {
        fixture: "reporter-audit-fidelity",
        model: "faithful-reporter",
        response: `# Atomic reservation\nGoal: preserve the public API.\nImplementation: src/inventory.mjs and test/inventory.test.mjs.\nRed: node --test test/inventory.test.mjs failed. Green: node --test *.test.mjs passed.\nReview approved after round 2.\nAccepted deviation DEV-17. Reason: legacy callers. Risk: return-shape ambiguity. Evidence: contract test.\nFollow-up: performance telemetry.\nUnresolved risk: concurrent callers.\nThe system-of-record transport timed out. Technical completion remains, and posting must be retried.`,
      },
    ];
    await writeFile(input, `${records.map(JSON.stringify).join("\n")}\n`);

    const result = spawnSync(process.execPath, [
      path.join(repo, "eval/model-assignment-eval.mjs"), "score", "--input", input,
    ], { cwd: repo, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const score = JSON.parse(result.stdout);
    assert.deepEqual(score.results[0], {
      model: "structured-reviewer", fixture: "reviewer-tenant-cache", hasMustFix: true,
      expectedFindingCount: 2, matchedFindingCount: 2, missedFindingCount: 0,
      falsePositiveCount: 0, matchesOracle: true,
    });
    assert.equal(score.results[1].requiredFactCount, 9);
    assert.equal(score.results[1].matchedFactCount, 9);
    assert.equal(score.results[1].contradictionCount, 0);
    assert.equal(score.results[1].matchesOracle, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
