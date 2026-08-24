import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const cli = path.join(repo, "eval/model-assignment-eval.mjs");

function scoreRecords(records, input) {
  return writeFile(input, `${records.map(JSON.stringify).join("\n")}\n`).then(() => spawnSync(
    process.execPath, [cli, "score", "--input", input], { cwd: repo, encoding: "utf8" },
  ));
}

test("Reviewer rejects acceptance-criteria parroting without private cause and impact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-hardening-"));
  try {
    const result = await scoreRecords([{
      fixture: "reviewer-missing-validation", model: "parrot", exitStatus: 0,
      response: JSON.stringify({ findings: [{
        severity: "must_fix", file: "src/signup.js", line: 2,
        explanation: "Email validation is missing.",
      }] }),
    }], path.join(dir, "results.jsonl"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].matchesOracle, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Reviewer rejects acceptance parroting that lacks code evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-hardening-evidence-"));
  try {
    const result = await scoreRecords([{
      fixture: "reviewer-tenant-cache", model: "tenant-parrot", exitStatus: 0,
      response: JSON.stringify({ findings: [
        { severity: "must_fix", file: "src/tenant-cache.mjs", line: 9, cause: "The tenant key is unsafe.", impact: "Values cross tenant boundaries.", explanation: "Honor tenant isolation." },
        { severity: "must_fix", file: "src/tenant-cache.mjs", line: 12, cause: "The expiration boundary is wrong.", impact: "An expired entry is served.", explanation: "Honor expiration." },
      ] }),
    }], path.join(dir, "results.jsonl"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].matchesOracle, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Reviewer rejects prose even when it contains finding fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-hardening-"));
  try {
    const result = await scoreRecords([{
      fixture: "reviewer-missing-validation", model: "prose", exitStatus: 0,
      response: "must_fix file src/signup.js line 2 cause missing validation impact invalid emails are written",
    }], path.join(dir, "results.jsonl"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].matchesOracle, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Reviewer rejects undeclared top-level fields and contradictory locations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-hardening-schema-"));
  try {
    const finding = { severity: "must_fix", file: "src/signup.js", line: 2, evidence: "store.write({ email: input.email })", cause: "input.email is written without validation", impact: "an invalid address is persisted", explanation: "Validate before writing." };
    const records = [
      { fixture: "reviewer-missing-validation", model: "extra-top-level", exitStatus: 0, response: JSON.stringify({ findings: [finding], oracle: "guessed private data" }) },
      { fixture: "reviewer-missing-validation", model: "contradictory-location", exitStatus: 0, response: JSON.stringify({ findings: [{ ...finding, location: "src/signup.js:99" }] }) },
      { fixture: "reviewer-missing-validation", model: "contradictory-file", exitStatus: 0, response: JSON.stringify({ findings: [{ ...finding, location: "src/other.js:99" }] }) },
      { fixture: "reviewer-missing-validation", model: "empty-semantics", exitStatus: 0, response: JSON.stringify({ findings: [{ ...finding, cause: "problem", impact: "harm", explanation: "input.email is written without validation, so an invalid address is persisted" }] }) },
      { fixture: "reviewer-missing-validation", model: "partial-semantics", exitStatus: 0, response: JSON.stringify({ findings: [{ ...finding, cause: "input.email is mishandled", impact: "invalid data results", explanation: "It is written without validation and persisted." }] }) },
      { fixture: "reviewer-missing-validation", model: "undeclared-finding-field", exitStatus: 0, response: JSON.stringify({ findings: [{ ...finding, anchor: "store.write" }] }) },
      { fixture: "reviewer-missing-validation", model: "contradictory-explanation", exitStatus: 0, response: JSON.stringify({ findings: [{ ...finding, explanation: "The behavior is correct." }] }) },
      { fixture: "reviewer-tenant-cache", model: "negated-defect", exitStatus: 0, response: JSON.stringify({ findings: [
        { severity: "must_fix", file: "src/tenant-cache.mjs", line: 9, evidence: "const cacheKey = key;", cause: "Tenant is included in the cache key identity.", impact: "Values cannot leak to another tenant.", explanation: "No isolation defect exists." },
        { severity: "must_fix", file: "src/tenant-cache.mjs", line: 12, evidence: "now <= hit.expiresAt", cause: "The expiration boundary uses equality as fresh.", impact: "An expired entry is served.", explanation: "Use a strict comparison." },
      ] }) },
    ];
    const result = await scoreRecords(records, path.join(dir, "results.jsonl"));
    assert.equal(result.status, 0, result.stderr);
    for (const score of JSON.parse(result.stdout).results) assert.equal(score.matchesOracle, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Reviewer rejects a code-specific finding at the wrong location", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-hardening-"));
  try {
    const result = await scoreRecords([{
      fixture: "reviewer-missing-validation", model: "wrong-location", exitStatus: 0,
      response: JSON.stringify({ findings: [{
        severity: "must_fix", file: "src/signup.js", line: 1,
        evidence: "store.write({ email: input.email })",
        cause: "saveSignup writes input.email without validating its format",
        impact: "invalid email addresses are persisted",
        explanation: "The email is written without validation.",
      }] }),
    }], path.join(dir, "results.jsonl"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].matchesOracle, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Reviewer grades independent transfer and API compatibility defects one-to-one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-hardening-multifinding-"));
  try {
    const transferFindings = [
      { severity: "must_fix", file: "src/transfers.mjs", line: 4, evidence: "db.accounts.debit(...) then db.accounts.credit(...)", cause: "The debit and credit are independent account operations without a transaction.", impact: "A credit failure leaves the source balance debited.", explanation: "Wrap both balance writes in one transaction." },
      { severity: "must_fix", file: "src/transfers.mjs", line: 3, evidence: "db.idempotency.exists(request.key)", cause: "Concurrent requests can both observe a missing key.", impact: "Concurrent requests can each debit and credit the accounts more than once.", explanation: "The check-then-act sequence needs an atomic key claim." },
    ];
    const apiFindings = [
      { severity: "must_fix", file: "src/client.mjs", line: 2, evidence: "const limit = options.limit ?? 100", cause: "An omitted limit is now sent as 100 instead of leaving the option absent.", impact: "Existing callers no longer receive the server's chosen default.", explanation: "Preserve omission when no limit was supplied." },
      { severity: "must_fix", file: "src/client.mjs", line: 7, evidence: "return { users: response.data, next: response.nextPage }", cause: "The wrapper returns users and next instead of the documented items and nextCursor shape.", impact: "Existing callers reading items or nextCursor break.", explanation: "Keep the public return contract." },
    ];
    const records = [
      { fixture: "reviewer-transfer-atomicity", model: "transfer-complete", exitStatus: 0, response: JSON.stringify({ findings: transferFindings }) },
      { fixture: "reviewer-transfer-atomicity", model: "transfer-combined", exitStatus: 0, response: JSON.stringify({ findings: [{ severity: "must_fix", file: "src/transfers.mjs", line: 4, evidence: "accounts.debit accounts.credit idempotency.exists idempotency.record", cause: "Separate debit and credit writes race with the idempotency exists check and record.", impact: "A partial or duplicate transfer can occur.", explanation: "Both defects need atomic storage." }] }) },
      { fixture: "reviewer-transfer-atomicity", model: "transfer-noisy", exitStatus: 0, response: JSON.stringify({ findings: [...transferFindings, { severity: "must_fix", file: "src/transfers.mjs", line: 7, cause: "The audit runs after success.", impact: "Audit records are unsafe.", explanation: "Move audit before the writes." }] }) },
      { fixture: "reviewer-transfer-atomicity", model: "transfer-bundled-distractor", exitStatus: 0, response: JSON.stringify({ findings: [{ ...transferFindings[0], explanation: "The account writes need a transaction, and the audit is unsafe." }, transferFindings[1]] }) },
      { fixture: "reviewer-transfer-atomicity", model: "transfer-supported-decomposition", exitStatus: 0, response: JSON.stringify({ findings: [...transferFindings, { severity: "must_fix", file: "src/transfers.mjs", line: 6, evidence: "db.idempotency.record(request.key)", cause: "The record is separate from the earlier existence check and is not an atomic claim.", impact: "A failure permits replay and a duplicate transfer.", explanation: "This is another consequence of the same idempotency defect." }] }) },
      { fixture: "reviewer-api-compatibility", model: "api-complete", exitStatus: 0, response: JSON.stringify({ findings: apiFindings }) },
      { fixture: "reviewer-api-compatibility", model: "api-noisy", exitStatus: 0, response: JSON.stringify({ findings: [...apiFindings, { severity: "must_fix", file: "src/client.mjs", line: 6, cause: "The wrapper propagates client errors.", impact: "Callers see the original failure.", explanation: "Swallow the error." }] }) },
    ];
    const result = await scoreRecords(records, path.join(dir, "results.jsonl"));
    assert.equal(result.status, 0, result.stderr);
    const [transfer, combined, transferNoisy, bundledDistractor, supportedDecomposition, api, apiNoisy] = JSON.parse(result.stdout).results;
    assert.equal(transfer.expectedFindingCount, 2); assert.equal(transfer.matchedFindingCount, 2); assert.equal(transfer.matchesOracle, true);
    assert.equal(combined.expectedFindingCount, 2); assert.ok(combined.matchedFindingCount <= 1); assert.ok(combined.missedFindingCount >= 1); assert.equal(combined.matchesOracle, false);
    assert.equal(transferNoisy.matchedFindingCount, 2); assert.equal(transferNoisy.falsePositiveCount, 1); assert.equal(transferNoisy.matchesOracle, false);
    assert.equal(bundledDistractor.matchesOracle, false);
    assert.equal(supportedDecomposition.matchedFindingCount, 2); assert.equal(supportedDecomposition.falsePositiveCount, 1); assert.equal(supportedDecomposition.matchesOracle, false);
    assert.equal(api.expectedFindingCount, 2); assert.equal(api.matchedFindingCount, 2); assert.equal(api.matchesOracle, true);
    assert.equal(apiNoisy.matchedFindingCount, 2); assert.equal(apiNoisy.falsePositiveCount, 1); assert.equal(apiNoisy.matchesOracle, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Reviewer accepts equivalent boundary and request-context semantics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-hardening-equivalence-"));
  try {
    const records = [
      { fixture: "reviewer-tenant-cache", model: "boundary-equivalent", exitStatus: 0, response: JSON.stringify({ findings: [
        { severity: "must_fix", file: "src/tenant-cache.mjs", line: 9, evidence: "const cacheKey = key;", cause: "Tenant is not included in the cache key identity.", impact: "A value can leak to a different tenant.", explanation: "Include tenantId in the key." },
        { severity: "must_fix", file: "src/tenant-cache.mjs", line: 11, evidence: "if (hit && now > hit.expiresAt) cache.delete(cacheKey);", cause: "Expiration is treated as strictly after its timestamp.", impact: "At equality, line 12 returns the expired value.", explanation: "The expiration boundary must be exclusive; the deliberately uncached loader promise is not a defect." },
      ] }) },
      { fixture: "reviewer-async-authorization", model: "capture-location", exitStatus: 0, response: JSON.stringify({ findings: [
        { severity: "must_fix", file: "src/membership.mjs", line: 3, evidence: "requestContext.organizationId", cause: "organizationId is captured but never used to scope the target.", impact: "A request for one organization can update another organization.", explanation: "Enforce the immutable request organization." },
        { severity: "must_fix", file: "src/membership.mjs", line: 4, evidence: "db.memberships.save({ id: membershipId, role: nextRole })", cause: "Authorization and persistence are separate with no conditional version guard.", impact: "A concurrent organization change permits a stale-authorized membership write.", explanation: "Bind authorization to the write." },
      ] }) },
    ];
    const result = await scoreRecords(records, path.join(dir, "results.jsonl"));
    assert.equal(result.status, 0, result.stderr);
    for (const score of JSON.parse(result.stdout).results) assert.equal(score.matchesOracle, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Reviewer distinguishes the async authorization race from safe request-context handling", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-hardening-authorization-"));
  try {
    const defects = [
      { severity: "must_fix", file: "src/membership.mjs", line: 6, evidence: "assertCanManage(requestContext.userId, membership.organizationId, db)", cause: "requestContext.organizationId is never checked against the membership organization.", impact: "A request scoped to one organization can update a membership in a different organization.", explanation: "Reject cross-organization membership IDs." },
      { severity: "must_fix", file: "src/membership.mjs", line: 7, evidence: "db.memberships.save({ id: membershipId, role: nextRole })", cause: "The save is separate from the authorization check and has no version or conditional organization guard.", impact: "A concurrent organization change can apply the membership write after stale authorization.", explanation: "Make authorization and the versioned save one conditional operation." },
    ];
    const records = [
      { fixture: "reviewer-async-authorization", model: "authorization-complete", exitStatus: 0, response: JSON.stringify({ findings: defects }) },
      { fixture: "reviewer-async-authorization", model: "authorization-noisy", exitStatus: 0, response: JSON.stringify({ findings: [...defects, { severity: "must_fix", file: "src/membership.mjs", line: 3, cause: "The request context is frozen.", impact: "The caller cannot mutate it.", explanation: "Remove Object.freeze." }] }) },
    ];
    const result = await scoreRecords(records, path.join(dir, "results.jsonl"));
    assert.equal(result.status, 0, result.stderr);
    const [complete, noisy] = JSON.parse(result.stdout).results;
    assert.equal(complete.expectedFindingCount, 2); assert.equal(complete.matchedFindingCount, 2); assert.equal(complete.matchesOracle, true);
    assert.equal(noisy.matchedFindingCount, 2); assert.equal(noisy.falsePositiveCount, 1); assert.equal(noisy.matchesOracle, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("planned Reviewer fixtures are isolated, tool-free, and identify their prompts", async () => {
  const fixtures = [
    ["reviewer-tenant-cache", /tenant cache/i],
    ["reviewer-async-authorization", /async authorization/i],
    ["reviewer-transfer-atomicity", /transfer atomicity/i],
    ["reviewer-api-compatibility", /api compatibility/i],
  ];
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-hardening-run-"));
  try {
    for (const [fixture, prompt] of fixtures) {
      const output = path.join(dir, `${fixture}.jsonl`);
      const result = spawnSync(process.execPath, [cli, "run", "--fixture", fixture, "--models", "openai-codex/gpt-5.6-luna", "--output", output, "--dry-run"], { cwd: repo, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const record = JSON.parse((await readFile(output, "utf8")).trim());
      assert.equal(record.role, "reviewer");
      assert.ok(record.invocation.includes("--no-tools"));
      assert.match(record.invocation.at(-1), prompt);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
