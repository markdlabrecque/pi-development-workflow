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
  name: "reviewer-missing-validation", role: "reviewer", thinking: "medium",
  prompt: `Review this bundle as an independent, read-only Reviewer. Attack the named suspected weakness first. Return ONLY strict JSON in the form { "findings": [{ "severity": "must_fix", "file": "...", "line": 0, "evidence": "exact code expression", "cause": "...", "impact": "...", "explanation": "..." }] }. Include severity, exact file, line or location, cause, impact, and explanation; return an empty findings array when unsupported.

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

Review bundle: src/signup.js (the complete changed file is shown in the diff above).
Evidence: assess the acceptance criteria against the diff/bundle; do not invent findings. No tools are available.`,
  oracle: { findings: [{ file: "src/signup.js", allowedLines: [2], anchors: ["store.write({ email: input.email })"], evidenceTerms: ["store.write", "input.email"], causeTerms: ["input.email", "without", "validat"], impactTerms: ["invalid", "persist"], denialPatterns: ["(?:invalid|email).{0,24}(?:cannot|can't|does not|never)\\s+(?:persist|be persisted|write|be written)"] }] },
});

const reviewerAsyncAuthorization = Object.freeze({
  name: "reviewer-async-authorization", role: "reviewer", thinking: "medium",
  prompt: `Review this async authorization bundle as an independent, read-only Reviewer. Attack the named suspected weakness first. Return ONLY strict JSON { "findings": [{ "severity": "must_fix", "file": "...", "line": 0, "location": "...", "evidence": "exact code expression", "cause": "...", "impact": "...", "explanation": "..." }] }. Include acceptance, diff/bundle, named weakness, and evidence in your review. No tools are available.

Acceptance: a membership role update must authorize and write within the same organization context, validate roles, and preserve immutable request context.
Named suspected weakness: verify that authorization remains bound to the eventual write when concurrent changes occur.
Complete changed file with source line numbers:
 src/membership.mjs
 1 import { isAllowedRole } from "./roles.mjs";
 2 export async function updateMembership(request, membershipId, nextRole, db) {
 3   const requestContext = Object.freeze({ userId: request.userId, organizationId: request.organizationId });
 4   const membership = await db.memberships.findById(membershipId);
 5   if (!isAllowedRole(nextRole)) throw new Error("invalid role");
 6   await assertCanManage(requestContext.userId, membership.organizationId, db);
 7   await db.memberships.save({ id: membershipId, role: nextRole });
 8   return { id: membershipId, role: nextRole };
 9 }
10 async function assertCanManage(userId, organizationId, db) {
11   const actor = await db.members.findByUserAndOrganization(userId, organizationId);
12   if (!actor || actor.role !== "owner") throw new Error("forbidden");
13 }
Review the complete function and related helper shown above.`,
  oracle: { forbiddenFindingTerms: ["remove object.freeze", "object.freeze is a defect", "role validation is missing"], findings: [
    { file: "src/membership.mjs", allowedLines: [3, 6], anchors: ["assertCanManage(requestContext.userId", "requestContext.organizationId"], evidenceGroups: [["assertcanmanage", "requestcontext.organizationid"], ["membership.organizationid", "organizationid"]], causeGroups: [["requestcontext.organizationid", "organizationid", "request organization", "request's organization"], ["not", "never", "omit", "ignore"]], impactGroups: [["request", "tenant", "organization"], ["other", "different", "cross", "another", "organization b", "one organization"]], denialPatterns: ["(?:cannot|can't|does not|never)\\s+(?:update|cross|write).{0,24}(?:other|different|another)" ] },
    { file: "src/membership.mjs", allowedLines: [4, 6, 7], anchors: ["memberships.save({ id: membershipId"], evidenceTerms: ["memberships.save", "membershipid"], causeGroups: [["authorization", "owner check", "assertcanmanage"], ["save", "write", "mutation", "persistence"], ["transaction", "version", "conditional", "unconstrained", "separate"]], impactGroups: [["membership", "role update", "write"], ["organization", "authorization"], ["change", "race", "between", "concurrent"]], denialPatterns: ["authorization.{0,24}(?:is|remains) bound", "(?:cannot|can't|does not|never)\\s+(?:race|change|be unauthor)"] },
  ] },
});

const reviewerTransferAtomicity = Object.freeze({
  name: "reviewer-transfer-atomicity", role: "reviewer", thinking: "medium",
  prompt: `Review this transfer atomicity bundle as an independent, read-only Reviewer. Attack the named suspected weakness first. Return ONLY strict JSON { "findings": [{ "severity": "must_fix", "file": "...", "line": 0, "location": "...", "evidence": "exact code expression", "cause": "...", "impact": "...", "explanation": "..." }] }. Include acceptance, diff/bundle, named weakness, and evidence. No tools are available.

Acceptance: a transfer must be atomic and idempotent under concurrent requests; validation and post-success audit are required but safe.
Named suspected weakness: verify storage consistency when failures or concurrent requests interrupt the operation.
Complete changed file with source line numbers:
 src/transfers.mjs
1 export async function transfer(request, db) {
2   validateTransfer(request);
3   if (await db.idempotency.exists(request.key)) return db.transfers.byKey(request.key);
4   await db.accounts.debit(request.from, request.amount);
5   await db.accounts.credit(request.to, request.amount);
6   await db.idempotency.record(request.key);
7   db.audit.success(request);
8   return { from: request.from, to: request.to, amount: request.amount };
9 }
The audit sink is non-throwing telemetry by contract and performs no storage write. Review the complete changed function shown above.`,
  oracle: { forbiddenFindingTerms: ["audit is unsafe", "move audit", "audit can throw"], findings: [
    { file: "src/transfers.mjs", allowedLines: [4, 5], anchors: ["accounts.debit", "accounts.credit"], evidenceGroups: [["accounts.debit", "accounts.credit"]], causeGroups: [["debit"], ["credit"], ["transaction", "rollback", "separate", "independent", "atomic"]], impactGroups: [["failure", "interrupt", "partial", "without", "missing"], ["debit", "fund", "balance"]], denialPatterns: ["(?:debit|credit).{0,24}(?:are not|aren't) separate", "(?:cannot|can't|does not|never)\\s+(?:lose|leave|cause|produce).{0,24}(?:fund|partial|inconsistent|without credit)"] },
    { file: "src/transfers.mjs", allowedLines: [3, 6], anchors: ["idempotency.exists", "idempotency.record"], evidenceGroups: [["idempotency.exists", "idempotency.record"]], causeGroups: [["exist", "check", "missing"], ["record", "claim", "unique", "act", "before either", "both observe"], ["concurrent", "race", "atomic", "separate", "check-then"]], impactGroups: [["duplicat", "multiple", "both", "replay", "twice", "more than once", "each"], ["transfer", "debit", "credit"]], denialPatterns: ["(?:check|claim).{0,24}(?:is|are) atomic", "(?:cannot|can't|does not|never)\\s+(?:(?:cause|permit|allow)\\s+)?(?:duplicat|replay|execute twice)"] },
  ] },
});

const reviewerApiCompatibility = Object.freeze({
  name: "reviewer-api-compatibility", role: "reviewer", thinking: "medium",
  prompt: `Review this API compatibility bundle as an independent, read-only Reviewer. Attack the named suspected weakness first. Return ONLY strict JSON { "findings": [{ "severity": "must_fix", "file": "...", "line": 0, "location": "...", "evidence": "exact code expression", "cause": "...", "impact": "...", "explanation": "..." }] }. Include acceptance, diff/bundle, named weakness, and evidence. No tools are available.

Acceptance: omitted-limit requests and the documented return shape remain backward compatible; deliberate errors must still propagate.
Existing public contract: omitting options sends no limit and lets the server choose its default. The resolved value is { items: response.data, nextCursor: response.nextPage }.
Named suspected weakness: check whether the wrapper still honors existing request and response contracts.
Complete changed file with source line numbers:
 src/client.mjs
1 export async function listUsers(client, options = {}) {
2   const limit = options.limit ?? 100;
3   let response;
4   try { response = await client.get("/users", { limit }); }
5   catch (error) { throw error; }
6   // Propagating the original client error is deliberate.
7   return { users: response.data, next: response.nextPage };
8 }
Review the complete changed wrapper shown above.`,
  oracle: { forbiddenFindingTerms: ["swallow the error", "error should be swallowed", "propagating the original client error is a defect"], findings: [
    { file: "src/client.mjs", allowedLines: [2, 4], anchors: ["options.limit ?? 100"], evidenceTerms: ["options.limit", "100"], causeGroups: [["omitted", "undefined", "absent"], ["100", "explicit"]], impactGroups: [["server", "existing", "contract", "caller"], ["default", "pagination", "limit"]], denialPatterns: ["server.{0,24}still.{0,24}(?:choose|default)", "(?:request|contract).{0,24}(?:remains|is) backward compatible"] },
    { file: "src/client.mjs", allowedLines: [7], anchors: ["return { users: response.data"], evidenceTerms: ["users: response.data", "next: response.nextpage"], causeGroups: [["rename", "return", "shape", "propert", "key", "change", "differ"]], impactGroups: [["caller", "consumer", "existing"], ["break", "incompat", "missing", "undefined", "violat"]], denialPatterns: ["(?:shape|properties|keys).{0,24}(?:does not|doesn't|is not) change", "(?:caller|consumer).{0,24}(?:does not|doesn't|is not).{0,16}(?:break|affected)"] },
  ] },
});

const fixtures = {
  "reviewer-missing-validation": reviewerMissingValidation,
  "reviewer-async-authorization": reviewerAsyncAuthorization,
  "reviewer-transfer-atomicity": reviewerTransferAtomicity,
  "reviewer-api-compatibility": reviewerApiCompatibility,
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
    prompt: `Review this tenant cache bundle as an independent, read-only Reviewer. Attack the named suspected weakness first and return ONLY strict JSON { "findings": [{ "severity": "must_fix", "file": "...", "line": 0, "location": "...", "evidence": "exact code expression", "cause": "...", "impact": "...", "explanation": "..." }] }. Named suspected weakness: verify cache identity and freshness semantics at tenant and time boundaries. Do not mistake the rejected loader promise behavior for a defect. Include acceptance, diff/bundle, named weakness, and evidence. No tools are available.`,
    promptBundle: `
Acceptance criteria: cache entries must never cross tenant boundaries and an entry at its expiration boundary must not be served.

Complete changed function with source line numbers:
 src/tenant-cache.mjs
 8 export async function getCached(tenantId, key, now, load) {
 9   const cacheKey = key;
10   const hit = cache.get(cacheKey);
11   if (hit && now > hit.expiresAt) cache.delete(cacheKey);
12   if (hit && now <= hit.expiresAt) return hit.value;
13   const value = await load(tenantId, key);
14   cache.set(cacheKey, { value, expiresAt: now + 60_000 });
15   return value;
16 }

The loader promise is deliberately not cached: a rejected loader must not poison later requests. Review the complete changed function above.`,
    oracle: { forbiddenFindingTerms: ["loader promise should be cached", "cache the loader promise", "not caching the loader promise is a defect"], findings: [
      { file: "src/tenant-cache.mjs", allowedLines: [9], anchors: ["const cacheKey = key"], evidenceTerms: ["cachekey", "key"], causeGroups: [["tenant"], ["key", "identity"], ["omit", "absent", "exclud", "without tenant", "only key", "not include", "ignore"]], impactGroups: [["tenant"], ["cross", "leak", "another", "different"]], denialPatterns: ["tenant(?:id)?\\s+(?:(?:is|are)\\s+)?(?:included|present).{0,24}(?:key|identity)", "(?:cannot|can't|does not|never)\\s+(?:leak|cross|return).{0,24}tenant"] },
      { file: "src/tenant-cache.mjs", allowedLines: [11, 12], anchors: ["now > hit.expiresAt", "now <= hit.expiresAt"], evidenceGroups: [["now > hit.expiresat", "now <= hit.expiresat"]], causeGroups: [["now", "equal", "inclusive", "<=", "strict", "after", "fresh"], ["expir", "boundary"]], impactGroups: [["served", "return"], ["expiration", "expired", "expiry", "boundary"]], denialPatterns: ["(?:now|entry).{0,24}(?:at|equal).{0,24}(?:is not|isn't|cannot|does not)\\s+(?:served|returned|fresh)", "(?:expired|expiration).{0,24}(?:is not|isn't|cannot|does not)\\s+(?:served|returned)"] , rejectTerms: ["behavior is correct", "should remain", "works correctly", "correctly served", "correctly returned", "should be served"] },
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
