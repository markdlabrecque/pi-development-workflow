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
        exitStatus: 0,
        response: JSON.stringify({ findings: [
          { classification: "must_fix", severity: "critical", location: "src/tenant-cache.mjs:11", explanation: "The cache key omits the tenant and leaks values across tenants." },
          { severity: "must_fix", location: "src/tenant-cache.mjs: `now <= hit.expiresAt`", explanation: "The entry is served exactly at expiration." },
        ] }),
      },
      {
        fixture: "reporter-audit-fidelity",
        model: "faithful-reporter",
        exitStatus: 0,
        response: `# Report\n## Outcome\nAtomic reservation without changing the public API.\n## Changed files\nsrc/inventory.mjs and test/inventory.test.mjs.\n## Verification\n### Red evidence\nRed: node --test test/inventory.test.mjs failed.\n### Green evidence\nGreen: node --test *.test.mjs passed.\n## Review\nApproved after round 2.\n## Follow-up\nFollow-up: performance telemetry.\n## Accepted deviation\nAccepted deviation DEV-17. Reason: legacy callers. Risk: return-shape ambiguity. Evidence: contract test.\n## Unresolved risk\nUnresolved risk: concurrent callers.\n## Posting\nThe system-of-record transport timed out. Technical completion remains; this was not successfully posted and must be retried.`,
      },
      {
        fixture: "reviewer-tenant-cache",
        model: "noisy-reviewer",
        exitStatus: 0,
        response: JSON.stringify({ findings: [
          { severity: "must_fix", location: "src/tenant-cache.mjs", explanation: "The tenant is absent from the cache key." },
          { severity: "must_fix", location: "src/tenant-cache.mjs", explanation: "The expiration boundary remains valid." },
          { classification: "quick_fix", location: "src/tenant-cache.mjs", explanation: "The rejected loader should be cached." },
        ] }),
      },
      {
        fixture: "reviewer-tenant-cache",
        model: "contradictory-reviewer",
        exitStatus: 0,
        response: JSON.stringify({ findings: [
          { severity: "must_fix", location: "src/tenant-cache.mjs", explanation: "The tenant is absent from the cache key." },
          { severity: "must_fix", location: "src/tenant-cache.mjs", explanation: "The exact expiration behavior is correct." },
        ] }),
      },
      {
        fixture: "reviewer-tenant-cache",
        model: "opposite-reviewer",
        exitStatus: 0,
        response: JSON.stringify({ findings: [
          { severity: "must_fix", location: "src/tenant-cache.mjs", explanation: "The tenant is absent from the cache key." },
          { severity: "must_fix", location: "src/tenant-cache.mjs", explanation: "The entry is correctly served at exact expiration and is fresh." },
        ] }),
      },
      {
        fixture: "reporter-audit-fidelity",
        model: "false-success-reporter",
        exitStatus: 0,
        response: `# Report\n## Outcome\nAtomic reservation without changing the public API.\n## Changed files\nsrc/inventory.mjs and test/inventory.test.mjs.\n## Verification\n### Red evidence\nnode --test failed.\n### Green evidence\nnode --test passed.\n## Review\nApproved after round 2.\n## Follow-up\nPerformance telemetry.\n## Accepted deviation\nDEV-17. Reason, risk, evidence.\n## Unresolved risk\nConcurrent callers.\n## Posting\nTransport succeeded; technical completion is preserved; retries remain available.`,
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
    assert.equal(score.results[2].matchedFindingCount, 2);
    assert.equal(score.results[2].falsePositiveCount, 1);
    assert.equal(score.results[2].matchesOracle, false);
    assert.equal(score.results[3].matchedFindingCount, 1);
    assert.equal(score.results[3].falsePositiveCount, 1);
    assert.equal(score.results[3].matchesOracle, false);
    assert.equal(score.results[4].matchedFindingCount, 1);
    assert.equal(score.results[4].falsePositiveCount, 1);
    assert.equal(score.results[4].matchesOracle, false);
    assert.equal(score.results[5].matchedFactCount, 9);
    assert.equal(score.results[5].contradictionCount, 1);
    assert.equal(score.results[5].matchesOracle, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
