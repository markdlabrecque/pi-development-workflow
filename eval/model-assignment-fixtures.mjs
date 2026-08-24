import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const codingTools = "read,bash,edit,write,grep,find,ls";
const noTools = "--no-tools";

const testWriterFiles = {
  "package.json": JSON.stringify({ type: "module" }, null, 2) + "\n",
  "src/cache.mjs": `export function isFresh({ cachedAt, now = Date.now(), ttlMs }) {
  return now - cachedAt <= ttlMs;
}
`,
  "test/cache.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { isFresh } from "../src/cache.mjs";

test("accepts a cache entry younger than its TTL", () => {
  assert.equal(isFresh({ cachedAt: 100, now: 150, ttlMs: 100 }), true);
});
`,
};

const implementerFiles = {
  "package.json": JSON.stringify({ type: "module" }, null, 2) + "\n",
  "src/inventory.mjs": `export function reserve(inventory, requested) {
  for (const item of requested) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new RangeError("quantity must be a positive integer");
    if (!(item.sku in inventory)) throw new Error("unknown SKU");
    if (inventory[item.sku] < item.quantity) throw new Error("insufficient stock");
    inventory[item.sku] -= item.quantity;
  }
  return requested.map(({ sku, quantity }) => ({ sku, quantity }));
}
`,
  "test/inventory.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { reserve } from "../src/inventory.mjs";

test("reserves available stock", () => {
  const inventory = { A: 5 };
  assert.deepEqual(reserve(inventory, [{ sku: "A", quantity: 2 }]), [{ sku: "A", quantity: 2 }]);
  assert.deepEqual(inventory, { A: 3 });
});
`,
  "SPEC.md": `# Reservation\n\nReserve requests atomically. Quantities are positive integers; duplicate SKUs aggregate before stock is checked. Any failure leaves inventory unchanged.\n`,
};

const reviewerMissingValidation = Object.freeze({
  name: "reviewer-missing-validation",
  role: "reviewer",
  thinking: "medium",
  prompt: `Review this bundle as an independent, read-only Reviewer. Attack the named suspected weakness first. Return structured findings with severity, a concrete file/line when available, and a concise explanation.

Acceptance criteria:
- Invalid email addresses must be rejected before they are written.

Named suspected weakness: missing validation in the new email-writing path may accept an invalid email without validation.

Implementation diff:
 diff --git a/src/signup.js b/src/signup.js
 --- a/src/signup.js
 +++ b/src/signup.js
 @@ -1,5 +1,7 @@
  export function saveSignup(input, store) {
 +  store.write({ email: input.email });
 +  return true;
  }

Review bundle: src/signup.js (the complete changed file is shown in the diff above).`,
  oracle: { findings: [{ file: "src/signup.js", line: 2, terms: ["validat", "email"] }] },
});

const fixtures = {
  "reviewer-missing-validation": reviewerMissingValidation,
  "test-writer-cache-boundary": {
    name: "test-writer-cache-boundary", role: "test-writer", thinking: "low",
    prompt: `Work as the Test Writer. Add focused tests for the cache boundary in this small ESM repository. Never edit production code. The required behavior is that an entry exactly at or older than its TTL is stale, and a future cachedAt timestamp throws RangeError. Run the targeted test and leave the production byte-identical.`,
    files: testWriterFiles,
    grader: "cache-boundary",
  },
  "implementer-atomic-reservation": {
    name: "implementer-atomic-reservation", role: "implementer", thinking: "medium",
    prompt: `Work as the Implementer on this atomic reservation task. Read SPEC.md and the visible tests, then edit production code (not tests) so duplicate SKUs aggregate, quantities are positive integers, missing or insufficient stock is preflighted, failures make zero mutation, and successful reservations decrement and return the requested lines. Run the visible tests.`,
    files: implementerFiles,
    grader: "atomic-reservation",
  },
  "reviewer-tenant-cache": {
    name: "reviewer-tenant-cache", role: "reviewer", thinking: "medium",
    prompt: `Review this tenant cache bundle as an independent, read-only Reviewer. Focus first on the tenant cache defects and return structured JSON findings with severity, location, and explanation. There are two must-fix defects; do not mistake the rejected loader promise behavior for a defect.`,
    promptBundle: `
Acceptance criteria: cache entries must never cross tenant boundaries and an entry at its expiration boundary must not be served.

Diff:
 diff --git a/src/tenant-cache.mjs b/src/tenant-cache.mjs
 --- a/src/tenant-cache.mjs
 +++ b/src/tenant-cache.mjs
 @@ -8,12 +8,14 @@
  export async function getCached(tenantId, key, now, load) {
 +  const cacheKey = key;
 +  const hit = cache.get(cacheKey);
 +  if (hit && now > hit.expiresAt) cache.delete(cacheKey);
 +  if (hit && now <= hit.expiresAt) return hit.value;
 +  const value = await load(tenantId, key);
 +  cache.set(cacheKey, { value, expiresAt: now + 60_000 });
 +  return value;
  }

The loader promise is deliberately not cached: a rejected loader must not poison later requests. Review the complete changed function above.`,
    oracle: { findings: [
      { file: "src/tenant-cache.mjs", line: 10, terms: ["tenant", "key"] },
      { file: "src/tenant-cache.mjs", line: 12, terms: ["expir"], anyTerms: ["bound", "exact", ">=", "==="], rejectTerms: ["behavior is correct", "should remain", "works correctly", "correctly served", "correctly returned", "should be served"] },
    ] },
  },
  "reporter-audit-fidelity": {
    name: "reporter-audit-fidelity", role: "reporter", thinking: "low",
    prompt: `Act as Reporter and produce the exact final Markdown system-of-record post for this audit fidelity task. Use this fixed template and these exact headings (do not omit or rename them): # Report, ## Outcome, ## Changed files, ## Verification, ### Red evidence, ### Green evidence, ## Review, ## Follow-up, ## Accepted deviation, ## Unresolved risk, ## Posting. Put each fact in its named section. Preserve every fact, caveat, follow-up, accepted deviation, unresolved risk, and the posting failure; do not claim a successful post.`,
    promptBundle: `
Goal: Add atomic reservation behavior without changing the public API.
Changed files: src/inventory.mjs and test/inventory.test.mjs.
Evidence: targeted red command node --test test/inventory.test.mjs failed as expected; full green command node --test *.test.mjs eval/*.test.mjs passed.
Review: approved after round 2 with no blocking findings.
Follow-up: add performance telemetry for large reservation batches.
Accepted deviation: code=DEV-17; reason=legacy callers require the current return shape; decision=approved; risk=return-shape ambiguity; evidence=contract test and reviewer approval.
Unresolved risk: concurrent callers are not covered by this in-memory test.
Posting failed: system-of-record transport returned timeout, but technical completion is preserved and the post must be retried.`,
    oracle: { groups: [
      ["atomic reservation", "public api"],
      ["src/inventory.mjs", "test/inventory.test.mjs"],
      ["red", "node --test", "failed"],
      ["green", "node --test", "passed"],
      ["approved", "round 2"],
      ["follow-up", "performance telemetry"],
      ["accepted deviation", "dev-17", "reason", "risk", "evidence"],
      ["unresolved risk", "concurrent callers"],
      ["transport", "technical completion", "retri"]
    ] },
  },
};

for (const fixture of Object.values(fixtures)) {
  if (fixture.promptBundle) fixture.prompt += fixture.promptBundle;
}

export async function loadRolePrompt(role) {
  const url = new URL(`../agents/${role}.md`, import.meta.url);
  return (await readFile(fileURLToPath(url), "utf8"))
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export function fixtureFor(name) { return fixtures[name]; }
export const FIXTURES = Object.freeze(fixtures);
export { codingTools, noTools };
