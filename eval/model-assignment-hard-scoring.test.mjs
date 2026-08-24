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
          { severity: "must_fix", location: "src/tenant-cache.mjs:9", evidence: "const cacheKey = key", cause: "The cache key omits the tenant key dimension.", impact: "Values can cross tenant boundaries.", explanation: "Include tenantId in cacheKey." },
          { severity: "must_fix", location: "src/tenant-cache.mjs:12", evidence: "now <= hit.expiresAt", cause: "The expiration boundary uses now <= expiresAt.", impact: "An expired entry is served at exact expiry.", explanation: "Treat equality as stale." },
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
          { severity: "must_fix", location: "src/tenant-cache.mjs:9", evidence: "const cacheKey = key", cause: "The tenant is absent from the cache key.", impact: "Values cross tenant boundaries.", explanation: "Use a composite key." },
          { severity: "must_fix", location: "src/tenant-cache.mjs:12", evidence: "now <= hit.expiresAt", cause: "The expiration boundary uses equality as fresh.", impact: "An expired entry is served.", explanation: "Use a strict freshness comparison." },
          { severity: "quick_fix", location: "src/tenant-cache.mjs:14", cause: "The loader promise is not cached.", impact: "Rejected loads can retry.", explanation: "Cache the loader promise." },
        ] }),
      },
      {
        fixture: "reviewer-tenant-cache",
        model: "contradictory-reviewer",
        exitStatus: 0,
        response: JSON.stringify({ findings: [
          { severity: "must_fix", location: "src/tenant-cache.mjs:9", evidence: "const cacheKey = key", cause: "The tenant is absent from the cache key.", impact: "Values cross tenant boundaries.", explanation: "Use a composite key." },
          { severity: "must_fix", location: "src/tenant-cache.mjs:12", evidence: "now <= hit.expiresAt", cause: "The expiration boundary is exact and behavior is correct.", impact: "An expired entry is served.", explanation: "No change is needed." },
        ] }),
      },
      {
        fixture: "reviewer-tenant-cache",
        model: "opposite-reviewer",
        exitStatus: 0,
        response: JSON.stringify({ findings: [
          { severity: "must_fix", location: "src/tenant-cache.mjs:9", evidence: "const cacheKey = key", cause: "The tenant is absent from the cache key.", impact: "Values cross tenant boundaries.", explanation: "Use a composite key." },
          { severity: "must_fix", location: "src/tenant-cache.mjs:12", evidence: "now <= hit.expiresAt", cause: "The expiration boundary uses equality and is correctly served.", impact: "An expired entry is served.", explanation: "It is fresh." },
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
      model: "structured-reviewer", fixture: "reviewer-tenant-cache", structuredOutputPresent: true, hasMustFix: true,
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
