import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CURRENT_STATE_VERSION = 5 as const;
export const DEFAULT_STAGE_SEQUENCE = ["red_testing", "implementing", "reviewing", "reporting"] as const;
export const LEGACY_STAGE_SEQUENCE = ["planning", "implementing", "testing", "reviewing", "reporting"] as const;
export type Stage = "planning" | "red_testing" | "implementing" | "testing" | "reviewing" | "fixing" | "reporting" | "completed" | "blocked" | "aborted";
export type TestEvidenceKind = "targeted_red" | "full_green" | "review_gate";
export type WorkflowTemplateName = "bugfix" | "feature" | "refactor";
export type SystemOfRecordType = "file" | "github" | "gitlab" | "bitbucket";
export type FindingCategory = "must_fix" | "quick_fix" | "follow_up" | "advisory" | "approved";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkflowMode = "new" | "adopt_existing" | "recovery";
/** The only policy defaults a foreground decision may override. HARD rules are deliberately absent. */
export type OverridablePolicyCode = "parallel_strategy" | "historical_red_missing" | "targeted_post_cap_fix" | "independent_review_unavailable" | "additional_review_round" | "expiry_guard_inapplicable" | "uv_dev_extra";
export type AcceptedPolicyDecision = "accept_deviation";
export interface PolicyDecision { code: OverridablePolicyCode; reason: string; decision: AcceptedPolicyDecision; risk: string; actor: "foreground-orchestrator"; at: string; evidence: string[]; }
export interface InheritedEvidence { id: string; kind: TestEvidenceKind; command: string; acceptedBy: string; }
export interface LogicalRole { authority: string[]; claims: string[]; attemptId: string; }
export type InfrastructureFailureReason = "transport" | "process" | "stale_context" | "compaction";
export interface AttemptUsage { inputTokens: number; outputTokens: number; }
export interface RoleAttemptReplacement { role: string; priorAttemptId: string; newAttemptId: string; reason: InfrastructureFailureReason; actor: "foreground-orchestrator"; at: string; durationMs: number; usage: AttemptUsage; evidence: string[]; exitStatus?: number; }
export type ReviewCapResolution = "narrow_fix" | "convert_noncritical_follow_up" | "additional_review_round" | "request_user_risk_acceptance" | "rescope" | "abort";
export interface ReviewCapEscalation { status: "review_cap"; recoverable: true; at: string; actor: "foreground-orchestrator"; unresolvedFindingIds: string[]; unresolvedEvidenceIds: string[]; actions: ReviewCapResolution[]; }
export type AdoptedInventoryArtifact = "branch" | "commits" | "dirty_tree" | "approved_plan" | "tests" | "implementation" | "review" | "report" | "issue_ownership";
export interface AcceptedInventoryArtifact { artifact: AdoptedInventoryArtifact; evidence: string; acceptedBy: "foreground-orchestrator"; acceptedAt: string; }
export interface AttemptAudit { role: string; attemptId: string; reason: string; exitCode?: number; durationMs: number; usage: { input: number; output: number; turns?: number }; }
export interface ReviewFinding { category: FindingCategory; title: string; detail?: string; file?: string; line?: number; }
export interface HistoryEntry { stage: Stage; at: string; note?: string; }
export interface WorkflowState {
  version: typeof CURRENT_STATE_VERSION; id: string; goal: string; acceptanceCriteria: string[]; repositoryRoot: string; stage: Stage;
  history: HistoryEntry[]; agentHandles: Record<string, string>; plan?: string;
  /** Canonical provenance for the approved pre-flight plan used by planner-free workflows. */
  planProvenance?: { path: string; content: string; digest: string; ingestedAt: string; bytes: number };
  filesOwned: Record<string, string[]>;
  tests: Array<{ command: string; testCommand?: string; passed: boolean; output?: string; at: string; kind?: TestEvidenceKind; evidenceKind?: TestEvidenceKind; evidenceId?: string; expectedFailureReason?: string }>;
  review: { findings: ReviewFinding[]; cycleCount: number; approved: boolean; maxReviewCycles?: number; suspectedWeakness?: string; needsMoreReview?: boolean; /** Test-array index after which a bounce needs fresh green evidence. */ fullGreenEvidenceFloor?: number; escalation?: ReviewCapEscalation; /** New/adopted workflows persist every review result by key and digest. */ idempotencyRequired?: boolean; idempotencyKeys?: string[]; idempotency?: Record<string, { payloadDigest: string; resultRef: string }>; /** Foreground-authorized narrow fix after a recoverable review-cap escalation. */ postCapFix?: { code: "targeted_post_cap_fix"; actor: "foreground-orchestrator"; at: string; unresolvedFindingIds: string[]; unresolvedEvidenceIds: string[]; fullGreenEvidenceFloor: number } };  
  mode: WorkflowMode; inheritedEvidence: InheritedEvidence[]; inventory: AcceptedInventoryArtifact[]; missingOutcomes: string[]; unresolvedRisks: string[]; acceptedDeviations: PolicyDecision[]; logicalRoles: Record<string, LogicalRole>; roleAttemptReplacements: RoleAttemptReplacement[]; attempts: AttemptAudit[];
  followUps: ReviewFinding[]; systemOfRecord: { type: SystemOfRecordType; repository?: string; approved?: boolean };
  /** Template metadata is persisted so a resumed workflow retains its selected shape. */
  template?: WorkflowTemplateName; stageSequence: Stage[];
  roleConfig?: Record<string, { thinking: ThinkingLevel; maxTokens: number | null; model?: string }>; expiresAt?: string;
  implementationSummary?: string; finalOutcome?: string; blockingReason?: string;
  /** Required pre-implementation proof for mechanically coupled acceptance criteria. */
  executableEvidence?: string; architectureContract?: string;
  createdAt: string; updatedAt: string;
  /** Persisted provider/model identity used by the foreground and every role dispatch. */
  modelProvider?: string; modelId?: string;
  preflight?: { branch?: string; baseBranch?: string; dirtyPaths: string[]; acknowledgedDirtyPaths: string[]; worktree: string };
  batch?: { id?: string; siblingOwnedFiles: string[]; sharedContracts: string[]; explicitlyRequested: boolean };
  reporterResult?: string;
}

const ROOT = path.join(getAgentDir(), "runtime", "development-workflow");
const safe = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, "_");
const stages = new Set<Stage>(["planning", "red_testing", "implementing", "testing", "reviewing", "fixing", "reporting", "completed", "blocked", "aborted"]);
const templateNames = new Set<WorkflowTemplateName>(["bugfix", "feature", "refactor"]);
const findingCategories = new Set<FindingCategory>(["must_fix", "quick_fix", "follow_up", "advisory", "approved"]);
const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modes = new Set<WorkflowMode>(["new", "adopt_existing", "recovery"]);
const overridablePolicyCodes = new Set<OverridablePolicyCode>(["parallel_strategy", "historical_red_missing", "targeted_post_cap_fix", "independent_review_unavailable", "additional_review_round", "expiry_guard_inapplicable", "uv_dev_extra"]);
const acceptedPolicyDecisions = new Set<AcceptedPolicyDecision>(["accept_deviation"]);
const infrastructureFailureReasons = new Set<InfrastructureFailureReason>(["transport", "process", "stale_context", "compaction"]);
const terminalStages = new Set<Stage>(["completed", "blocked", "aborted"]);
const adoptedInventoryArtifacts = new Set<AdoptedInventoryArtifact>(["branch", "commits", "dirty_tree", "approved_plan", "tests", "implementation", "review", "report", "issue_ownership"]);
const requiredAdoptedBaseline: readonly AdoptedInventoryArtifact[] = ["branch", "commits", "dirty_tree", "approved_plan"];
const outcomeArtifacts: Record<string, readonly AdoptedInventoryArtifact[]> = { red_testing: ["tests"], implementation: ["implementation"], review: ["review"], report: ["report"] };
export const NO_STATE_WRITE = Symbol("NO_STATE_WRITE");

export const statePath = (id: string) => path.join(ROOT, `${safe(id)}.json`);
const tombstonePath = (id: string) => path.join(ROOT, `${safe(id)}.closed`);

type UnknownRecord = Record<string, unknown>;
function isRecord(value: unknown): value is UnknownRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fail(message: string): never { throw new Error(`Invalid workflow state: ${message}`); }
function record(value: unknown, name: string): UnknownRecord { if (!isRecord(value)) fail(`${name} must be an object`); return value; }
function string(value: unknown, name: string): string { if (typeof value !== "string") fail(`${name} must be a string`); return value; }
function optionalString(value: unknown, name: string): string | undefined { if (value === undefined) return undefined; return string(value, name); }

/** Returns an expiration instant only for a parseable timestamp; malformed values are not expired. */
export function workflowExpirationTime(expiresAt: unknown): number | undefined {
  if (typeof expiresAt !== "string") return undefined;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** A workflow is stale only when its valid expiration timestamp is at or before now. */
export function isWorkflowExpired(expiresAt: unknown, now = Date.now()): boolean {
  const timestamp = workflowExpirationTime(expiresAt);
  return timestamp !== undefined && timestamp <= now;
}

function stage(value: unknown, name: string): Stage { if (typeof value !== "string" || !stages.has(value as Stage)) fail(`${name} is not a valid stage`); return value as Stage; }
function stringArray(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.some(item => typeof item !== "string")) fail(`${name} must be an array of strings`); return [...value]; }
function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
}
function optionalEvidenceFloor(value: unknown, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) fail("review.fullGreenEvidenceFloor is invalid");
  return value;
}
function findings(value: unknown, name: string): ReviewFinding[] {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value.map((entry, index) => {
    const finding = record(entry, `${name}[${index}]`);
    const category = finding.category;
    if (typeof category !== "string" || !findingCategories.has(category as FindingCategory)) fail(`${name}[${index}].category is invalid`);
    const result: ReviewFinding = { category: category as FindingCategory, title: string(finding.title, `${name}[${index}].title`) };
    const detail = optionalString(finding.detail, `${name}[${index}].detail`); if (detail !== undefined) result.detail = detail;
    const file = optionalString(finding.file, `${name}[${index}].file`); if (file !== undefined) result.file = file;
    if (finding.line !== undefined) { if (typeof finding.line !== "number" || !Number.isInteger(finding.line)) fail(`${name}[${index}].line must be an integer`); result.line = finding.line; }
    return result;
  });
}
function stringRecord(value: unknown, name: string): Record<string, string> {
  const source = record(value, name); const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) result[key] = string(item, `${name}.${key}`);
  return result;
}
function filesRecord(value: unknown): Record<string, string[]> {
  const source = record(value, "filesOwned"); const result: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(source)) result[key] = stringArray(item, `filesOwned.${key}`);
  return result;
}
function history(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) fail("history must be an array");
  return value.map((entry, index) => { const item = record(entry, `history[${index}]`); const result: HistoryEntry = { stage: stage(item.stage, `history[${index}].stage`), at: string(item.at, `history[${index}].at`) }; const note = optionalString(item.note, `history[${index}].note`); if (note !== undefined) result.note = note; return result; });
}
function tests(value: unknown): WorkflowState["tests"] {
  if (!Array.isArray(value)) fail("tests must be an array");
  return value.map((entry, index) => {
    const item = record(entry, `tests[${index}]`); if (typeof item.passed !== "boolean") fail(`tests[${index}].passed must be a boolean`);
    const result: WorkflowState["tests"][number] = { command: string(item.command, `tests[${index}].command`), passed: item.passed, at: string(item.at, `tests[${index}].at`) };
    const output = optionalString(item.output, `tests[${index}].output`); if (output !== undefined) result.output = output;
    const kind = optionalString(item.kind, `tests[${index}].kind`); if (kind !== undefined) { if (!["targeted_red", "full_green", "review_gate"].includes(kind)) fail(`tests[${index}].kind is invalid`); result.kind = kind as TestEvidenceKind; }
    const evidenceKind = optionalString(item.evidenceKind, `tests[${index}].evidenceKind`); if (evidenceKind !== undefined) { if (!["targeted_red", "full_green", "review_gate"].includes(evidenceKind) || (result.kind !== undefined && evidenceKind !== result.kind)) fail(`tests[${index}].evidenceKind is invalid`); result.evidenceKind = evidenceKind as TestEvidenceKind; }
    const testCommand = optionalString(item.testCommand, `tests[${index}].testCommand`); if (testCommand !== undefined && testCommand !== result.command) fail(`tests[${index}].testCommand must match command`); if (testCommand !== undefined) result.testCommand = testCommand;
    const evidenceId = optionalString(item.evidenceId, `tests[${index}].evidenceId`); if (evidenceId !== undefined) result.evidenceId = evidenceId;
    const reason = optionalString(item.expectedFailureReason, `tests[${index}].expectedFailureReason`); if (reason !== undefined) result.expectedFailureReason = reason;
    return result;
  });
}
function sequence(value: unknown): Stage[] {
  if (!Array.isArray(value) || value.length === 0) fail("stageSequence must be a non-empty array");
  return value.map((entry, index) => stage(entry, `stageSequence[${index}]`));
}
function nonEmptyString(value: unknown, name: string): string { const result = string(value, name); if (!result.trim()) fail(`${name} must not be empty`); return result; }
function timestamp(value: unknown, name: string): string { const result = nonEmptyString(value, name); if (!Number.isFinite(Date.parse(result))) fail(`${name} must be a parseable timestamp`); return result; }
function evidenceIds(value: unknown, name: string): string[] { const result = stringArray(value, name); if (!result.length || result.some(item => !item.trim())) fail(`${name} must be non-empty`); return result; }
function policyDecisions(value: unknown, name: string): PolicyDecision[] {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value.map((entry, index) => {
    const item = record(entry, `${name}[${index}]`); const code = nonEmptyString(item.code, `${name}[${index}].code`); const decision = nonEmptyString(item.decision, `${name}[${index}].decision`);
    if (!overridablePolicyCodes.has(code as OverridablePolicyCode)) fail(`${name}[${index}].code is not overridable`);
    if (!acceptedPolicyDecisions.has(decision as AcceptedPolicyDecision)) fail(`${name}[${index}].decision is invalid`);
    if (item.actor !== "foreground-orchestrator") fail(`${name}[${index}].actor must be foreground-orchestrator`);
    return { code: code as OverridablePolicyCode, reason: nonEmptyString(item.reason, `${name}[${index}].reason`), decision: decision as AcceptedPolicyDecision, risk: nonEmptyString(item.risk, `${name}[${index}].risk`), actor: "foreground-orchestrator", at: timestamp(item.at, `${name}[${index}].at`), evidence: evidenceIds(item.evidence, `${name}[${index}].evidence`) };
  });
}
function inventory(value: unknown): AcceptedInventoryArtifact[] {
  if (!Array.isArray(value)) fail("inventory must be an array"); const seen = new Set<string>();
  return value.map((entry, index) => { const item = record(entry, `inventory[${index}]`); const artifact = nonEmptyString(item.artifact, `inventory[${index}].artifact`); if (!adoptedInventoryArtifacts.has(artifact as AdoptedInventoryArtifact) || seen.has(artifact)) fail(`inventory[${index}].artifact is invalid or duplicated`); seen.add(artifact); if (item.acceptedBy !== "foreground-orchestrator") fail(`inventory[${index}].acceptedBy must be foreground-orchestrator`); return { artifact: artifact as AdoptedInventoryArtifact, evidence: nonEmptyString(item.evidence, `inventory[${index}].evidence`), acceptedBy: "foreground-orchestrator", acceptedAt: timestamp(item.acceptedAt, `inventory[${index}].acceptedAt`) }; });
}
export function validateAdoptedInventory(entries: AcceptedInventoryArtifact[]): void {
  const accepted = new Set(entries.map(entry => entry.artifact)); const missing = requiredAdoptedBaseline.filter(artifact => !accepted.has(artifact));
  if (missing.length) fail(`adopt_existing inventory requires accepted baseline provenance: ${missing.join(", ")}`);
}
export function deriveAdoptedOutcomes(entries: AcceptedInventoryArtifact[]): { satisfied: string[]; missing: string[] } {
  validateAdoptedInventory(entries); const accepted = new Set(entries.map(entry => entry.artifact)); const outcomes = Object.keys(outcomeArtifacts);
  const satisfied = outcomes.filter(outcome => outcomeArtifacts[outcome].some(artifact => accepted.has(artifact)));
  return { satisfied, missing: outcomes.filter(outcome => !satisfied.includes(outcome)) };
}
export function adoptExistingState(state: WorkflowState, entries: AcceptedInventoryArtifact[]): WorkflowState {
  const normalized = inventory(entries); const outcomes = deriveAdoptedOutcomes(normalized); state.inventory = normalized; state.missingOutcomes = outcomes.missing;
  const next: Stage = outcomes.missing[0] === "red_testing" ? "red_testing" : outcomes.missing[0] === "implementation" ? "implementing" : outcomes.missing[0] === "review" ? "reviewing" : outcomes.missing[0] === "report" ? "reporting" : "completed";
  state.stage = next; state.history = [{ stage: next, at: new Date().toISOString(), note: `Adopted existing work; missing outcomes: ${outcomes.missing.join(", ") || "none"}` }];
  return state;
}
function inheritedEvidence(value: unknown): InheritedEvidence[] {
  if (!Array.isArray(value)) fail("inheritedEvidence must be an array");
  return value.map((entry, index) => { const item = record(entry, `inheritedEvidence[${index}]`); const kind = nonEmptyString(item.kind, `inheritedEvidence[${index}].kind`); if (!(["targeted_red", "full_green", "review_gate"] as string[]).includes(kind)) fail(`inheritedEvidence[${index}].kind is invalid`); return { id: nonEmptyString(item.id, `inheritedEvidence[${index}].id`), kind: kind as TestEvidenceKind, command: nonEmptyString(item.command, `inheritedEvidence[${index}].command`), acceptedBy: nonEmptyString(item.acceptedBy, `inheritedEvidence[${index}].acceptedBy`) }; });
}
function logicalRoles(value: unknown): Record<string, LogicalRole> {
  const source = record(value, "logicalRoles"); const result: Record<string, LogicalRole> = {};
  for (const [role, entry] of Object.entries(source)) { if (!role.trim()) fail("logicalRoles role is empty"); const item = record(entry, `logicalRoles.${role}`); result[role] = { authority: stringArray(item.authority, `logicalRoles.${role}.authority`), claims: stringArray(item.claims, `logicalRoles.${role}.claims`), attemptId: nonEmptyString(item.attemptId, `logicalRoles.${role}.attemptId`) }; }
  return result;
}
function nonNegativeInteger(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer`); return value; }
function replacements(value: unknown): RoleAttemptReplacement[] {
  if (!Array.isArray(value)) fail("roleAttemptReplacements must be an array");
  return value.map((entry, index) => { const item = record(entry, `roleAttemptReplacements[${index}]`); const reason = nonEmptyString(item.reason, `roleAttemptReplacements[${index}].reason`); if (!infrastructureFailureReasons.has(reason as InfrastructureFailureReason)) fail(`roleAttemptReplacements[${index}].reason is invalid`); if (item.actor !== "foreground-orchestrator") fail(`roleAttemptReplacements[${index}].actor must be foreground-orchestrator`); const exitStatus = item.exitStatus === undefined ? undefined : nonNegativeInteger(item.exitStatus, `roleAttemptReplacements[${index}].exitStatus`); if (reason === "process" && exitStatus === undefined) fail(`roleAttemptReplacements[${index}].exitStatus is required for process failures`); return { role: nonEmptyString(item.role, `roleAttemptReplacements[${index}].role`), priorAttemptId: nonEmptyString(item.priorAttemptId, `roleAttemptReplacements[${index}].priorAttemptId`), newAttemptId: nonEmptyString(item.newAttemptId, `roleAttemptReplacements[${index}].newAttemptId`), reason: reason as InfrastructureFailureReason, actor: "foreground-orchestrator", at: timestamp(item.at, `roleAttemptReplacements[${index}].at`), durationMs: nonNegativeInteger(item.durationMs, `roleAttemptReplacements[${index}].durationMs`), usage: (() => { const usage = record(item.usage, `roleAttemptReplacements[${index}].usage`); return { inputTokens: nonNegativeInteger(usage.inputTokens, `roleAttemptReplacements[${index}].usage.inputTokens`), outputTokens: nonNegativeInteger(usage.outputTokens, `roleAttemptReplacements[${index}].usage.outputTokens`) }; })(), evidence: evidenceIds(item.evidence, `roleAttemptReplacements[${index}].evidence`), ...(exitStatus === undefined ? {} : { exitStatus }) }; });
}
function attempts(value: unknown): AttemptAudit[] {
  if (!Array.isArray(value)) fail("attempts must be an array");
  return value.map((entry, index) => { const item = record(entry, `attempts[${index}]`); const usage = record(item.usage, `attempts[${index}].usage`); const exitCode = item.exitCode === undefined ? undefined : nonNegativeInteger(item.exitCode, `attempts[${index}].exitCode`); const turns = usage.turns === undefined ? undefined : nonNegativeInteger(usage.turns, `attempts[${index}].usage.turns`); return { role: nonEmptyString(item.role, `attempts[${index}].role`), attemptId: nonEmptyString(item.attemptId, `attempts[${index}].attemptId`), reason: nonEmptyString(item.reason, `attempts[${index}].reason`), ...(exitCode === undefined ? {} : { exitCode }), durationMs: nonNegativeInteger(item.durationMs, `attempts[${index}].durationMs`), usage: { input: nonNegativeInteger(usage.input, `attempts[${index}].usage.input`), output: nonNegativeInteger(usage.output, `attempts[${index}].usage.output`), ...(turns === undefined ? {} : { turns }) } }; });
}
function postCapFix(value: unknown, maximum: number): WorkflowState["review"]["postCapFix"] {
  if (value === undefined) return undefined;
  const item = record(value, "review.postCapFix");
  if (item.code !== "targeted_post_cap_fix" || item.actor !== "foreground-orchestrator") fail("review.postCapFix is invalid");
  return { code: "targeted_post_cap_fix", actor: "foreground-orchestrator", at: timestamp(item.at, "review.postCapFix.at"), unresolvedFindingIds: evidenceIds(item.unresolvedFindingIds, "review.postCapFix.unresolvedFindingIds"), unresolvedEvidenceIds: evidenceIds(item.unresolvedEvidenceIds, "review.postCapFix.unresolvedEvidenceIds"), fullGreenEvidenceFloor: optionalEvidenceFloor(item.fullGreenEvidenceFloor, maximum) ?? fail("review.postCapFix.fullGreenEvidenceFloor is required") };
}
function escalation(value: unknown): ReviewCapEscalation | undefined {
  if (value === undefined) return undefined; const item = record(value, "review.escalation");
  if (item.status !== "review_cap" || item.actor !== "foreground-orchestrator") fail("review.escalation is invalid"); const actions = stringArray(item.actions, "review.escalation.actions");
  const requiredActions: ReviewCapResolution[] = ["narrow_fix", "convert_noncritical_follow_up", "additional_review_round", "request_user_risk_acceptance", "rescope", "abort"];
  if (actions.length !== requiredActions.length || new Set(actions).size !== actions.length || requiredActions.some(action => !actions.includes(action))) fail("review.escalation.actions is invalid");
  if (item.recoverable !== true) fail("review.escalation.recoverable must be true");
  return { status: "review_cap", recoverable: true, at: timestamp(item.at, "review.escalation.at"), actor: "foreground-orchestrator", unresolvedFindingIds: evidenceIds(item.unresolvedFindingIds, "review.escalation.unresolvedFindingIds"), unresolvedEvidenceIds: evidenceIds(item.unresolvedEvidenceIds, "review.escalation.unresolvedEvidenceIds"), actions: actions as ReviewCapResolution[] };
}

/**
 * Upgrade persisted state without mutating the parsed input. Versions one through
 * three retain their active stage and sequence; legacy workflows are never silently
 * reinterpreted as red-first. Migration is lazy until the next explicit save.
 */
export function migrateState(raw: unknown): WorkflowState {
  const source = record(raw, "root");
  const version = source.version;
  if (typeof version !== "number" || !Number.isInteger(version)) fail("version must be an integer");
  if (version > CURRENT_STATE_VERSION) throw new Error(`Unsupported workflow state version ${version}; this extension supports up to ${CURRENT_STATE_VERSION}`);
  if (version < 1) throw new Error(`Unsupported workflow state version ${version}`);
  // V1 supported only file/GitHub remotes, and its GitHub selection was already
  // restricted to trusted configuration or an explicit user approval. Preserve that
  // authorization provenance when adding the v2 approval marker. Do not infer
  // approval for v1 values that could not have been created by that version.
  const legacySystemOfRecord = version === 1 && isRecord(source.systemOfRecord) ? source.systemOfRecord : undefined;
  const legacyV5Fields: UnknownRecord = version < CURRENT_STATE_VERSION ? { mode: "recovery", inheritedEvidence: [], inventory: [], missingOutcomes: [], unresolvedRisks: [], acceptedDeviations: [], logicalRoles: {}, roleAttemptReplacements: [], attempts: [] } : {}; 
  const currentV5Defaults: UnknownRecord = version === CURRENT_STATE_VERSION ? { inventory: source.inventory ?? [], missingOutcomes: source.missingOutcomes ?? [], unresolvedRisks: source.unresolvedRisks ?? [], attempts: source.attempts ?? [] } : {};
  const candidate: UnknownRecord = version === 1
    ? {
      ...source, ...legacyV5Fields,
      version: CURRENT_STATE_VERSION,
      stageSequence: source.stageSequence ?? [...LEGACY_STAGE_SEQUENCE],
      ...(legacySystemOfRecord?.type === "github" && legacySystemOfRecord.approved === undefined
        ? { systemOfRecord: { ...legacySystemOfRecord, approved: true } }
        : {}),
    }
    : version === 2 || version === 3 || version === 4 ? { ...source, ...legacyV5Fields, version: CURRENT_STATE_VERSION } : { ...source, ...currentV5Defaults };
  if (candidate.version !== CURRENT_STATE_VERSION) throw new Error(`Unsupported workflow state version ${String(candidate.version)}`);

  const reviewSource = record(candidate.review, "review");
  if (typeof reviewSource.cycleCount !== "number" || !Number.isInteger(reviewSource.cycleCount) || reviewSource.cycleCount < 0) fail("review.cycleCount must be a non-negative integer");
  if (typeof reviewSource.approved !== "boolean") fail("review.approved must be a boolean");
  const persistedEscalation = escalation(reviewSource.escalation);
  if (persistedEscalation && (reviewSource.approved || terminalStages.has(stage(candidate.stage, "stage")))) fail("review.escalation cannot coexist with approved or terminal state");
  const postCap = postCapFix(reviewSource.postCapFix, Array.isArray(candidate.tests) ? candidate.tests.length : 0);
  if (postCap && (persistedEscalation || reviewSource.approved)) fail("review.postCapFix cannot coexist with escalation or approval");
  const explicitEvidenceFloor = optionalEvidenceFloor(reviewSource.fullGreenEvidenceFloor, Array.isArray(candidate.tests) ? candidate.tests.length : 0);
  // Version-4 red-first workflows created before the evidence-floor field may be
  // parked in fixing. Their pre-review green gate must not become reusable.
  const derivedEvidenceFloor = explicitEvidenceFloor ?? (candidate.stage === "fixing" && Array.isArray(candidate.stageSequence) && candidate.stageSequence.includes("red_testing") ? (Array.isArray(candidate.tests) ? candidate.tests.length : 0) : undefined);
  const template = candidate.template;
  if (template !== undefined && (typeof template !== "string" || !templateNames.has(template as WorkflowTemplateName))) fail("template is invalid");
  const systemOfRecord = record(candidate.systemOfRecord, "systemOfRecord");
  if (systemOfRecord.type !== "file" && systemOfRecord.type !== "github" && systemOfRecord.type !== "gitlab" && systemOfRecord.type !== "bitbucket") fail("systemOfRecord.type is invalid");
  const repository = optionalString(systemOfRecord.repository, "systemOfRecord.repository");
  if (systemOfRecord.approved !== undefined && typeof systemOfRecord.approved !== "boolean") fail("systemOfRecord.approved must be a boolean");

  const state: WorkflowState = {
    ...candidate as Omit<WorkflowState, "version" | "id" | "goal" | "acceptanceCriteria" | "repositoryRoot" | "stage" | "history" | "agentHandles" | "filesOwned" | "tests" | "review" | "followUps" | "systemOfRecord" | "template" | "stageSequence" | "createdAt" | "updatedAt">,
    version: CURRENT_STATE_VERSION,
    id: string(candidate.id, "id"), goal: string(candidate.goal, "goal"), acceptanceCriteria: stringArray(candidate.acceptanceCriteria, "acceptanceCriteria"), repositoryRoot: string(candidate.repositoryRoot, "repositoryRoot"), stage: stage(candidate.stage, "stage"),
    history: history(candidate.history), agentHandles: stringRecord(candidate.agentHandles, "agentHandles"), filesOwned: filesRecord(candidate.filesOwned), tests: tests(candidate.tests),
    review: { findings: findings(reviewSource.findings, "review.findings"), cycleCount: reviewSource.cycleCount, approved: reviewSource.approved, maxReviewCycles: optionalPositiveInteger(reviewSource.maxReviewCycles, "review.maxReviewCycles"), ...(reviewSource.idempotencyRequired === undefined ? {} : typeof reviewSource.idempotencyRequired === "boolean" ? { idempotencyRequired: reviewSource.idempotencyRequired } : fail("review.idempotencyRequired must be a boolean")), ...(reviewSource.idempotencyKeys === undefined ? {} : { idempotencyKeys: stringArray(reviewSource.idempotencyKeys, "review.idempotencyKeys") }), ...(reviewSource.idempotency === undefined ? {} : { idempotency: (() => { const items = record(reviewSource.idempotency, "review.idempotency"); const result: Record<string, { payloadDigest: string; resultRef: string }> = {}; for (const [key, value] of Object.entries(items)) { const item = record(value, `review.idempotency.${key}`); const digest = nonEmptyString(item.payloadDigest, `review.idempotency.${key}.payloadDigest`); if (!/^[a-f0-9]{64}$/.test(digest)) fail(`review.idempotency.${key}.payloadDigest is invalid`); result[nonEmptyString(key, "review.idempotency key")] = { payloadDigest: digest, resultRef: nonEmptyString(item.resultRef, `review.idempotency.${key}.resultRef`) }; } return result; })() }), ...(optionalString(reviewSource.suspectedWeakness, "review.suspectedWeakness") ? { suspectedWeakness: string(reviewSource.suspectedWeakness, "review.suspectedWeakness") } : {}), ...(typeof reviewSource.needsMoreReview === "boolean" ? { needsMoreReview: reviewSource.needsMoreReview } : {}), ...(derivedEvidenceFloor === undefined ? {} : { fullGreenEvidenceFloor: derivedEvidenceFloor }), ...(persistedEscalation === undefined ? {} : { escalation: persistedEscalation }), ...(postCap === undefined ? {} : { postCapFix: postCap }) },
    mode: (() => { const mode = nonEmptyString(candidate.mode, "mode"); if (!modes.has(mode as WorkflowMode)) fail("mode is invalid"); return mode as WorkflowMode; })(), inheritedEvidence: inheritedEvidence(candidate.inheritedEvidence), inventory: inventory(candidate.inventory), missingOutcomes: stringArray(candidate.missingOutcomes, "missingOutcomes"), unresolvedRisks: stringArray(candidate.unresolvedRisks, "unresolvedRisks"), acceptedDeviations: policyDecisions(candidate.acceptedDeviations, "acceptedDeviations"), logicalRoles: logicalRoles(candidate.logicalRoles), roleAttemptReplacements: replacements(candidate.roleAttemptReplacements), attempts: attempts(candidate.attempts),
    followUps: findings(candidate.followUps, "followUps"), systemOfRecord: { type: systemOfRecord.type, ...(repository === undefined ? {} : { repository }), ...(systemOfRecord.approved === undefined ? {} : { approved: systemOfRecord.approved }) },
    stageSequence: sequence(candidate.stageSequence), createdAt: string(candidate.createdAt, "createdAt"), updatedAt: string(candidate.updatedAt, "updatedAt"),
  };
  if (template !== undefined) state.template = template as WorkflowTemplateName;
  for (const key of ["plan", "implementationSummary", "finalOutcome", "blockingReason", "expiresAt", "modelProvider", "modelId", "reporterResult", "executableEvidence", "architectureContract"] as const) { const value = optionalString(candidate[key], key); if (value !== undefined) state[key] = value; }
  if (candidate.preflight !== undefined) {
    const preflight = record(candidate.preflight, "preflight");
    state.preflight = { branch: optionalString(preflight.branch, "preflight.branch"), baseBranch: optionalString(preflight.baseBranch, "preflight.baseBranch"), dirtyPaths: stringArray(preflight.dirtyPaths, "preflight.dirtyPaths"), acknowledgedDirtyPaths: stringArray(preflight.acknowledgedDirtyPaths, "preflight.acknowledgedDirtyPaths"), worktree: string(preflight.worktree, "preflight.worktree") };
  }
  if (candidate.batch !== undefined) {
    const batch = record(candidate.batch, "batch"); if (typeof batch.explicitlyRequested !== "boolean") fail("batch.explicitlyRequested must be a boolean");
    state.batch = { id: optionalString(batch.id, "batch.id"), siblingOwnedFiles: stringArray(batch.siblingOwnedFiles, "batch.siblingOwnedFiles"), sharedContracts: stringArray(batch.sharedContracts, "batch.sharedContracts"), explicitlyRequested: batch.explicitlyRequested };
  }
  if (candidate.planProvenance !== undefined) {
    const provenance = record(candidate.planProvenance, "planProvenance");
    const digest = string(provenance.digest, "planProvenance.digest");
    if (!/^[a-f0-9]{64}$/.test(digest)) fail("planProvenance.digest must be a lowercase SHA-256 digest");
    if (typeof provenance.bytes !== "number" || !Number.isSafeInteger(provenance.bytes) || provenance.bytes < 0) fail("planProvenance.bytes must be a non-negative integer");
    state.planProvenance = {
      path: string(provenance.path, "planProvenance.path"),
      content: string(provenance.content, "planProvenance.content"),
      digest,
      ingestedAt: string(provenance.ingestedAt, "planProvenance.ingestedAt"),
      bytes: provenance.bytes,
    };
  }
  if (candidate.roleConfig !== undefined) {
    const configs = record(candidate.roleConfig, "roleConfig"); state.roleConfig = {};
    for (const [name, value] of Object.entries(configs)) { const config = record(value, `roleConfig.${name}`); const maxTokens = config.maxTokens; if (typeof config.thinking !== "string" || !thinkingLevels.has(config.thinking as ThinkingLevel) || (maxTokens !== null && (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1))) fail(`roleConfig.${name} is invalid`); const model = optionalString(config.model, `roleConfig.${name}.model`); state.roleConfig[name] = { thinking: config.thinking as ThinkingLevel, maxTokens: maxTokens as number | null, ...(model ? { model } : {}) }; }
  }
  return state;
}

async function readState(file: string, missingIsUndefined: boolean, requestedId?: string): Promise<WorkflowState | undefined> {
  let contents: string;
  try { contents = await fs.promises.readFile(file, "utf8"); }
  catch (error: any) { if (missingIsUndefined && error?.code === "ENOENT") return undefined; throw new Error(`Unable to read workflow state ${file}: ${error.message}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(contents); }
  catch (error: any) { throw new Error(`Malformed workflow state ${file}: ${error.message}`); }
  try {
    const state = migrateState(parsed);
    if (requestedId !== undefined && state.id !== requestedId) throw new Error(`state-path collision: requested ${requestedId}, found ${state.id}`);
    return state;
  } catch (error: any) { throw new Error(`Unable to load workflow state ${file}: ${error.message}`); }
}

/** Loads one state strictly: malformed or unsupported state is reported to the caller. */
export async function loadState(id: string): Promise<WorkflowState | undefined> { return readState(statePath(id), true, id); }
async function verifyStoredStateIdentity(id: string): Promise<void> {
  let contents: string;
  try { contents = await fs.promises.readFile(statePath(id), "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
  // Cleanup must be able to remove corrupt/future recovery artifacts, but a parseable
  // state from a colliding sanitized path must never be deleted as the requested ID.
  try {
    const raw = JSON.parse(contents);
    if (isRecord(raw) && typeof raw.id === "string" && raw.id !== id) throw new Error(`Workflow state path collision: requested ${id}, found ${raw.id}`);
  } catch (error: any) {
    if (error?.message?.startsWith("Workflow state path collision:")) throw error;
  }
}
async function tombstoneExistsFor(id: string): Promise<boolean> {
  let recorded: string;
  try { recorded = await fs.promises.readFile(tombstonePath(id), "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
  if (recorded !== id) throw new Error(`Workflow state path collision: requested ${id}, tombstone belongs to ${recorded}`);
  return true;
}
async function writeState(state: WorkflowState): Promise<void> {
  const normalized = migrateState(state); Object.assign(state, normalized); state.updatedAt = new Date().toISOString();
  await fs.promises.mkdir(ROOT, { recursive: true }); const target = statePath(state.id); const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); await fs.promises.rename(temp, target);
}

// mkdir is an atomic cross-process primitive. Keep the lock beside its state file so
// independent Pi child processes serialize load/check/mutate/save as one transaction.
async function acquireStateLock(id: string): Promise<() => Promise<void>> {
  // The first workflow operation may be a transaction, before any state file has
  // created ROOT. Create the parent before attempting the adjacent lock directory.
  await fs.promises.mkdir(ROOT, { recursive: true });
  const lock = `${statePath(id)}.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await fs.promises.mkdir(lock, { mode: 0o700 });
      return async () => { await fs.promises.rm(lock, { recursive: true, force: true }); };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw new Error(`Unable to lock workflow state ${id}: ${error.message}`);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting to update workflow ${id}`);
      await new Promise(resolve => setTimeout(resolve, 10 + Math.floor(Math.random() * 15)));
    }
  }
}
/**
 * Save a snapshot only when it cannot revive a terminal workflow. New workflow
 * creation is allowed, but normal callers should use transactState so their mutation
 * is based on the snapshot read while holding this same cross-process lock.
 */
export async function saveState(state: WorkflowState): Promise<void> {
  const release = await acquireStateLock(state.id);
  try {
    if (await tombstoneExistsFor(state.id)) throw new Error(`Refusing to recreate closed workflow: ${state.id}`);
    const current = await loadState(state.id);
    if (current && ["completed", "blocked", "aborted"].includes(current.stage) && !["completed", "blocked", "aborted"].includes(state.stage)) {
      throw new Error(`Refusing to resurrect terminal workflow: ${state.id}`);
    }
    await writeState(state);
  } finally { await release(); }
}
export async function removeState(id: string): Promise<void> {
  const release = await acquireStateLock(id);
  try {
    // Verify before unlinking: sanitized filenames can collide for arbitrary IDs.
    await verifyStoredStateIdentity(id);
    await fs.promises.rm(statePath(id), { force: true });
  } finally { await release(); }
}
/** Permanently retire a closed workflow so an already-loaded stale snapshot cannot recreate it. */
export async function retireState(id: string): Promise<void> {
  const release = await acquireStateLock(id);
  try {
    await loadState(id);
    if (await tombstoneExistsFor(id)) throw new Error(`Workflow is already retired: ${id}`);
    // Tombstones retain the raw identity, making collisions fail closed too.
    await fs.promises.writeFile(tombstonePath(id), id, { mode: 0o600 });
    await fs.promises.rm(statePath(id), { force: true });
  } finally { await release(); }
}
/** Atomically reload, authorize/mutate, and persist one workflow across Pi processes. */
export async function transactState<T>(id: string, operation: (state: WorkflowState) => Promise<T> | T): Promise<{ state: WorkflowState; result: T }> {
  const release = await acquireStateLock(id);
  try {
    const state = await loadState(id);
    if (!state) throw new Error(`Unknown workflow: ${id}`);
    const result = await operation(state);
    if (result !== NO_STATE_WRITE) await writeState(state);
    return { state, result };
  } finally { await release(); }
}
/** Lists valid states only; one corrupt or future state cannot prevent recovery of others. */
export async function listStates(): Promise<WorkflowState[]> {
  await fs.promises.mkdir(ROOT, { recursive: true }); const names = await fs.promises.readdir(ROOT);
  const states = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => { try { return await readState(path.join(ROOT, name), false); } catch { return undefined; } }));
  return states.filter((state): state is WorkflowState => state !== undefined);
}
export function createState(input: { id: string; goal: string; acceptanceCriteria?: string[]; repositoryRoot: string; systemOfRecord?: WorkflowState["systemOfRecord"]; mode?: Exclude<WorkflowMode, "recovery">; inheritedEvidence?: InheritedEvidence[]; acceptedDeviations?: PolicyDecision[] }): WorkflowState {
  const now = new Date().toISOString(); const mode = input.mode ?? "new";
  if (!modes.has(mode)) throw new Error("Invalid workflow mode");
  // Validate caller-provided durable artifacts before constructing a state snapshot.
  const inherited = inheritedEvidence(input.inheritedEvidence ?? []); const deviations = policyDecisions(input.acceptedDeviations ?? [], "acceptedDeviations");
  return { version: CURRENT_STATE_VERSION, id: input.id, goal: input.goal, acceptanceCriteria: [...(input.acceptanceCriteria ?? [])], repositoryRoot: path.resolve(input.repositoryRoot), stage: "red_testing",
    history: [{ stage: "red_testing", at: now, note: "Approved pre-flight plan ingested; red tests required" }], agentHandles: {}, filesOwned: {}, tests: [], review: { findings: [], cycleCount: 0, approved: false, idempotencyRequired: true }, mode, inheritedEvidence: inherited, inventory: [], missingOutcomes: [], unresolvedRisks: [], acceptedDeviations: deviations, logicalRoles: {}, roleAttemptReplacements: [], attempts: [], followUps: [], stageSequence: [...DEFAULT_STAGE_SEQUENCE],
    systemOfRecord: input.systemOfRecord ?? { type: "file" }, createdAt: now, updatedAt: now };
}
/** Persists only closed OUTCOME-rule deviations; HARD codes fail closed without mutation. */
export function applyPolicyDecision(state: WorkflowState, decision: PolicyDecision): { accepted: boolean; state: WorkflowState } {
  try { const normalized = policyDecisions([decision], "policyDecision")[0]; state.acceptedDeviations.push(normalized); return { accepted: true, state }; }
  catch { return { accepted: false, state }; }
}
/** Records a recoverable review-cap condition; it neither approves nor blocks work. */
export function recordReviewCapEscalation(state: WorkflowState, input: Omit<ReviewCapEscalation, "status" | "actions">): WorkflowState {
  if (terminalStages.has(state.stage) || state.review.approved) throw new Error("Cannot escalate an approved or terminal workflow");
  const normalized = escalation({ ...input, status: "review_cap", recoverable: true, actions: ["narrow_fix", "convert_noncritical_follow_up", "additional_review_round", "request_user_risk_acceptance", "rescope", "abort"] });
  state.review.escalation = normalized!;
  return state;
}
/** Computes foreground choices from durable outcomes rather than the compatibility stage projection. */
export function computeAdmissibleNextActions(state: WorkflowState): string[] {
  if (terminalStages.has(state.stage)) return [];
  if (state.review.escalation?.status === "review_cap") return [...state.review.escalation.actions];
  // A required adopted review remains missing while the Implementer is fixing it;
  // never route from that live stage based on a stale later outcome.
  if (state.mode === "adopt_existing" && state.stage === "fixing") return ["implement", "abort"];
  const missing = state.mode === "adopt_existing" ? state.missingOutcomes[0] : undefined;
  if (missing === "red_testing" || state.stage === "red_testing") return ["record_red_evidence", "implement", "abort"]; 
  if (missing === "implementation") return ["implement", "abort"];
  if (missing === "review") return ["route_review", "abort"];
  if (missing === "report") return ["report", "abort"];
  return ["continue", "abort"];
}
/** Remove an adopted outcome only after its corresponding durable workflow action commits. */
export function satisfyOutcome(state: WorkflowState, outcome: string): void { if (state.mode === "adopt_existing") state.missingOutcomes = state.missingOutcomes.filter(item => item !== outcome); }
export function resolveReviewCap(state: WorkflowState, input: { choice: ReviewCapResolution; actor: "foreground-orchestrator"; justification?: string }): WorkflowState {
  const escalation = state.review.escalation;
  if (!escalation || terminalStages.has(state.stage)) throw new Error("No recoverable review-cap escalation is active");
  if (input.actor !== "foreground-orchestrator" || !escalation.actions.includes(input.choice)) throw new Error("Invalid review-cap resolution authority or choice");
  const required = state.review.findings.filter(finding => finding.category === "must_fix" || finding.category === "quick_fix");
  if (["additional_review_round", "request_user_risk_acceptance", "rescope"].includes(input.choice) && !input.justification?.trim()) throw new Error(`${input.choice} requires justification`);
  if (input.choice === "abort") { delete state.review.escalation; state.review.approved = false; state.blockingReason = "Aborted by foreground review-cap resolution"; transition(state, "aborted", state.blockingReason); return state; }
  if (input.choice === "convert_noncritical_follow_up") {
    if (required.some(finding => finding.category === "must_fix")) throw new Error("Critical findings cannot be converted to follow-ups");
    state.followUps.push(...required.map(finding => ({ ...finding, category: "follow_up" as const }))); state.review.findings = state.review.findings.map(finding => finding.category === "quick_fix" ? { ...finding, category: "follow_up" as const } : finding);
    delete state.review.escalation; state.review.approved = false; state.review.needsMoreReview = true; satisfyOutcome(state, "review"); transition(state, "reporting", "Foreground converted non-critical review findings to follow-ups"); return state;
  }
  if (input.choice === "request_user_risk_acceptance" || input.choice === "rescope") { state.history.push({ stage: state.stage, at: new Date().toISOString(), note: `Foreground review-cap ${input.choice}: ${input.justification!.trim()}` }); return state; }
  delete state.review.escalation; state.review.approved = false; state.review.fullGreenEvidenceFloor = state.tests.length;
  if (input.choice === "narrow_fix") {
    const at = new Date().toISOString();
    const risk = `Post-cap findings remain: ${required.map(finding => finding.title).join("; ") || "review escalation"}`;
    const decision = { code: "targeted_post_cap_fix" as const, reason: input.justification?.trim() || "Foreground authorized narrow post-cap fix", decision: "accept_deviation" as const, risk, actor: "foreground-orchestrator" as const, at, evidence: escalation.unresolvedEvidenceIds };
    if (!applyPolicyDecision(state, decision).accepted) throw new Error("Unable to persist narrow post-cap resolution");
    state.review.postCapFix = { code: "targeted_post_cap_fix", actor: "foreground-orchestrator", at, unresolvedFindingIds: [...escalation.unresolvedFindingIds], unresolvedEvidenceIds: [...escalation.unresolvedEvidenceIds], fullGreenEvidenceFloor: state.review.fullGreenEvidenceFloor };
    if (!state.unresolvedRisks.includes(risk)) state.unresolvedRisks.push(risk);
  }
  if (input.choice === "additional_review_round") state.review.maxReviewCycles = Math.max(state.review.maxReviewCycles ?? 0, state.review.cycleCount + 1);
  transition(state, "fixing", input.choice === "narrow_fix" ? "Foreground authorized narrow post-cap fix" : "Foreground authorized an additional review round");
  return state;
}
/** Replaces an infrastructure attempt while retaining the logical role's authority and file claims. */
export function replaceRoleAttempt(state: WorkflowState, input: RoleAttemptReplacement): WorkflowState {
  const normalized = replacements([input])[0]; const current = state.logicalRoles[normalized.role];
  if (!current) throw new Error(`Unknown logical role: ${normalized.role}`);
  if (normalized.priorAttemptId !== current.attemptId) throw new Error("Replacement prior attempt does not match the logical role");
  if (normalized.newAttemptId === current.attemptId) throw new Error("Replacement attempt must differ from the current attempt");
  state.logicalRoles[normalized.role] = { authority: [...current.authority], claims: [...current.claims], attemptId: normalized.newAttemptId };
  state.roleAttemptReplacements.push(normalized);
  return state;
}
const allowed: Record<Stage, Stage[]> = {
  planning: ["implementing", "blocked", "aborted"], red_testing: ["implementing", "blocked", "aborted"], implementing: ["reviewing", "testing", "blocked", "aborted"], testing: ["reviewing", "fixing", "blocked", "aborted"],
  reviewing: ["fixing", "reporting", "blocked", "aborted"], fixing: ["reviewing", "testing", "reporting", "blocked", "aborted"], reporting: ["completed", "blocked", "aborted"],
  completed: [], blocked: ["planning", "red_testing", "implementing", "testing", "reviewing", "fixing", "reporting", "aborted"], aborted: [] };
export function transition(state: WorkflowState, next: Stage, note?: string): void {
  if (state.review.escalation && next === "completed") throw new Error("Cannot complete while a review-cap escalation is unresolved");
  if (!allowed[state.stage].includes(next)) throw new Error(`Invalid workflow transition: ${state.stage} -> ${next}`);
  state.stage = next; state.history.push({ stage: next, at: new Date().toISOString(), note });
}
