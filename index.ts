import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import { compact, CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { adoptExistingState, applyPolicyDecision, createState, isWorkflowExpired, loadState, NO_STATE_WRITE, recordReviewCapEscalation, removeState, replaceRoleAttempt, resolveReviewCap, retireState, saveState, satisfyOutcome, transactState, transition, workflowExpirationTime, type FindingCategory, type ReviewCapResolution, type ReviewFinding, type RoleAttemptReplacement, type Stage, type WorkflowState } from "./workflow-state.ts";
import { mergeWorkflowSnapshot, renderWorkflowSnapshot } from "./compaction-state.ts";
import { removeInProgressWorkplan, resolveSystemOfRecord, updateSystemOfRecord } from "./system-of-record.ts";
import { parseReviewerOutput } from "./reviewer.ts";
import { activeWorkflowIds, setActiveWorkflowIds, setWorkflowModeEnabled, workflowModeEnabled } from "./thread-mode.ts";
import { ACTIVE_ROLE_NAMES, getRoleConfig, WORKFLOW_ROLE_NAMES, type RoleName, type ThinkingLevel } from "./roles.ts";
import { WorkflowStateCache } from "./state-cache.ts";
import { ingestPlan } from "./plan-ingestion.ts";
import { renderOrchestratorPlanContext } from "./orchestrator-prompt.ts";
import { appendDiagnostic, compactSuccessfulDiagnostics, createDiagnosticEvent, diagnosticsPath, normalizeDiagnosticError, pruneExpiredDiagnostics, renderDiagnosticSummary, summarizeDiagnostics } from "./diagnostics.ts";

export const WORKFLOW_MODEL_PROVIDER = "openai-codex" as const;
export const WORKFLOW_MODEL_ID = "gpt-5.6-sol" as const;
export const WORKFLOW_MODEL = `${WORKFLOW_MODEL_PROVIDER}/${WORKFLOW_MODEL_ID}` as const;
export const SUPPORTED_WORKFLOW_MODELS = new Set(["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"]);
const DEFAULT_MAX_REVIEW_CYCLES = 2;
const MAX_TRACKED_COMPLETION_TOOL_CALLS = 256;
/** Bounded handoffs preserve the compact artifact contract at workflow dispatch. */
const MAX_WORKFLOW_TASK_BYTES = 16 * 1024;

async function resolveQualifiedWorkflowModel(ctx: ExtensionContext, qualified: string) {
  if (!SUPPORTED_WORKFLOW_MODELS.has(qualified)) throw new Error(`Unsupported workflow model ${qualified}; supported models: ${[...SUPPORTED_WORKFLOW_MODELS].join(", ")}`);
  const slash = qualified.indexOf("/"); const provider = qualified.slice(0, slash); const id = qualified.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) throw new Error(`Development workflow requires ${qualified}. Add it to Pi's model registry, then reload Pi.`);
  let auth; try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(model); } catch (error: any) { throw new Error(`Unable to authenticate workflow model ${qualified}: ${error.message}`); }
  if (!auth.ok) throw new Error(`Unable to authenticate workflow model ${qualified}: provider credentials missing.`);
  return model;
}
/** Resolve and authenticate the high-judgment foreground Orchestrator model. */
export async function resolveWorkflowModel(ctx: ExtensionContext) { return resolveQualifiedWorkflowModel(ctx, WORKFLOW_MODEL); }
const Actions = ["start", "status", "advance", "record", "routeReview", "report", "complete", "block", "abort", "close", "override", "resolveEscalation", "replaceAttempt"] as const;
const Stages = ["planning", "red_testing", "implementing", "testing", "reviewing", "fixing", "reporting", "completed", "blocked", "aborted"] as const;
const Finding = Type.Object({ category: StringEnum(["must_fix", "quick_fix", "follow_up", "advisory", "approved"] as const), title: Type.String(), detail: Type.Optional(Type.String()), file: Type.Optional(Type.String()), line: Type.Optional(Type.Number()) });
const InventoryArtifact = Type.Object({ artifact: Type.String(), evidence: Type.String(), acceptedBy: Type.String(), acceptedAt: Type.String() });
const AttemptFailure = Type.Object({ reason: Type.String(), exitCode: Type.Optional(Type.Number()), durationMs: Type.Optional(Type.Number()), usage: Type.Optional(Type.Object({ input: Type.Number(), output: Type.Number(), turns: Type.Optional(Type.Number()) })) });
const Params = Type.Object({
  action: StringEnum(Actions), workflowId: Type.Optional(Type.String()), goal: Type.Optional(Type.String()), planPath: Type.Optional(Type.String({ description: "Required for start; approved plan document inside the repository" })), acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
  stage: Type.Optional(StringEnum(Stages)), note: Type.Optional(Type.String()), plan: Type.Optional(Type.String()), implementationSummary: Type.Optional(Type.String()),
  files: Type.Optional(Type.Array(Type.String())), agentId: Type.Optional(Type.String()), testCommand: Type.Optional(Type.String()), testPassed: Type.Optional(Type.Boolean()),
  testOutput: Type.Optional(Type.String()), evidenceKind: Type.Optional(StringEnum(["targeted_red", "full_green", "review_gate"] as const)), expectedFailureReason: Type.Optional(Type.String()), findings: Type.Optional(Type.Array(Finding)), reviewOutput: Type.Optional(Type.String({ description: "Raw structured Reviewer JSON to parse" })), suspectedWeakness: Type.Optional(Type.String()), reporterContent: Type.Optional(Type.String()), outcome: Type.Optional(Type.String()), reason: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.String({ description: "Optional ISO-8601 workflow expiration timestamp" })),
  maxReviewCycles: Type.Optional(Type.Number({ minimum: 1, multipleOf: 1, description: "Review rounds before a recoverable foreground escalation; defaults to 2" })),
  acknowledgeDirtyPaths: Type.Optional(Type.Array(Type.String())), taskOwnedDirtyPaths: Type.Optional(Type.Array(Type.String({ description: "Dirty paths owned by this task that must be checkpointed/cleaned before creation" }))), baseBranch: Type.Optional(Type.String()), batchId: Type.Optional(Type.String()), parallelExplicitlyRequested: Type.Optional(Type.Boolean()), siblingOwnedFiles: Type.Optional(Type.Array(Type.String())), sharedContracts: Type.Optional(Type.Array(Type.String())), 
  approveDetectedIntegration: Type.Optional(Type.Boolean({ description: "Explicitly approve a detected remote integration for this workflow" })),
  executableEvidence: Type.Optional(Type.String({ description: "Executable/live/generated proof required for mechanically coupled acceptance criteria" })),
  architectureContract: Type.Optional(Type.String({ description: "Architecture coupling contract required before implementation when acceptance is mechanically sensitive" })),
  ruleCode: Type.Optional(Type.String()), decision: Type.Optional(Type.String()), risk: Type.Optional(Type.String()), evidence: Type.Optional(Type.Array(Type.String())),
  escalationChoice: Type.Optional(StringEnum(["narrow_fix", "convert_noncritical_follow_up", "additional_review_round", "request_user_risk_acceptance", "rescope", "abort"] as const)), justification: Type.Optional(Type.String()),
  mode: Type.Optional(StringEnum(["new", "adopt_existing", "recovery"] as const)), targetRepository: Type.Optional(Type.String()), targetWorktree: Type.Optional(Type.String()), inventory: Type.Optional(Type.Array(InventoryArtifact)), idempotencyKey: Type.Optional(Type.String()), replacementAttemptId: Type.Optional(Type.String()), role: Type.Optional(Type.String()), failure: Type.Optional(AttemptFailure),
});
interface SubagentCloseWorkflowRequest {
  action: "closeWorkflow"; workflowId: string; accept: () => void; resolve: (text: string) => void; reject: (error: unknown) => void;
}
function requestSubagentClose(pi: ExtensionAPI, workflowId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let accepted = false; let settled = false;
    const finish = (fn: (value: any) => void, value: any) => { if (!settled) { settled = true; fn(value); } };
    const request: SubagentCloseWorkflowRequest = {
      action: "closeWorkflow", workflowId,
      accept: () => { accepted = true; },
      resolve: text => finish(resolve, text),
      reject: error => finish(reject, error),
    };
    pi.events.emit("subagent:request", request);
    if (!accepted) finish(reject, new Error("Subagent extension did not accept closeWorkflow request"));
  });
}
async function required(id: string | undefined, load: (workflowId: string) => Promise<WorkflowState | undefined>): Promise<WorkflowState> { if (!id) throw new Error("workflowId is required"); const state = await load(id); if (!state) throw new Error(`Unknown workflow: ${id}`); return state; }
// Workflow subagent list/details report cumulative active run time separately from persistent idle/waiting time.
function statusText(s: WorkflowState, now = Date.now()): string {
  const maxCycles = s.review.maxReviewCycles ?? DEFAULT_MAX_REVIEW_CYCLES;
  const expiration = s.expiresAt === undefined ? "" : isWorkflowExpired(s.expiresAt, now)
    ? `\nExpires: ${s.expiresAt} (expired)`
    : workflowExpirationTime(s.expiresAt) === undefined
      ? `\nExpires: ${s.expiresAt} (invalid timestamp)`
      : `\nExpires: ${s.expiresAt}`;
  return `${s.id}: ${s.stage}\nGoal: ${s.goal}\nReview cycles: ${s.review.cycleCount}/${maxCycles}\nTests: ${s.tests.length}\nFollow-ups: ${s.followUps.length}\nDiagnostics: ${diagnosticsPath(s.id)}${expiration}${s.blockingReason ? `\nBlocked: ${s.blockingReason}` : ""}`;
}

// User requests opt in only when they contain one complete, explicit trigger. The
// surrounding non-word boundaries prevent partial-word matches such as "sdlcs".
export function hasWorkflowTrigger(text: string): boolean {
  return /\b(?:dev\s+workflow|development\s+workflow|sdlc)\b/i.test(text);
}
// Any subagent marker or workflow-identity fragment is security-relevant. Treat a
// partial handoff as a child and fail closed instead of accidentally granting it
// foreground authority.
function isChildSession(): boolean { return ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_ID", "PI_WORKFLOW_ID", "PI_WORKFLOW_ROLE"].some(name => process.env[name] !== undefined); }
type WorkflowChild = { workflowId: string; role: RoleName };
/** Raw workflow identity is handed off separately from subagent's sanitized run ID. */
function workflowChild(): WorkflowChild | undefined {
  if (!isChildSession()) return undefined;
  const workflowId = process.env.PI_WORKFLOW_ID;
  const role = process.env.PI_WORKFLOW_ROLE;
  if (!workflowId || !role || !["planner", "implementer", "test-writer", "reviewer", "reporter"].includes(role)) return undefined;
  return { workflowId, role: role as RoleName };
}
function isWorkflowChildSession(): boolean { return workflowChild() !== undefined; }
function malformedWorkflowChildError(): string | undefined {
  return isChildSession() && !workflowChild() ? "Malformed workflow child identity may not perform workflow actions; raw PI_WORKFLOW_ID and PI_WORKFLOW_ROLE are required." : undefined;
}
// This is the complete child authority matrix. Environment identity binds a child to a
// workflow role; it is a tool-call boundary, not a defense against a child deliberately
// forging its environment through an arbitrary shell.
const CHILD_ACTIONS: Record<RoleName, readonly (typeof Actions)[number][]> = {
  planner: ["status", "record", "advance"],
  implementer: ["status", "record", "advance"],
  "test-writer": ["status", "record", "advance"],
  reviewer: ["status", "routeReview"],
  reporter: ["status", "report"],
};
const CHILD_RECORD_FIELDS: Record<Extract<RoleName, "planner" | "implementer" | "test-writer">, readonly string[]> = {
  planner: ["plan"],
  implementer: ["implementationSummary", "files", "testCommand", "testPassed", "testOutput", "evidenceKind"],
  "test-writer": ["files", "testCommand", "testPassed", "testOutput", "evidenceKind", "expectedFailureReason"],
};
const CHILD_ADVANCES: Partial<Record<RoleName, { from: readonly Stage[]; to: Stage }>> = {
  planner: { from: ["planning"], to: "implementing" },
};
const RECORD_MUTABLE_FIELDS = ["plan", "implementationSummary", "files", "testCommand", "testPassed", "testOutput", "evidenceKind", "expectedFailureReason"] as const;
const RECORD_BASE_FIELDS = ["action", "workflowId", "agentId"] as const;
function childWorkflowAccessError(params: { action?: string; workflowId?: string; agentId?: string; stage?: unknown; [key: string]: unknown }, state?: WorkflowState): string | undefined {
  const child = workflowChild();
  if (!child) return undefined;
  if (params.workflowId !== child.workflowId) return "Workflow children may access only their own workflowId.";
  if (!params.action || !CHILD_ACTIONS[child.role].includes(params.action as (typeof Actions)[number])) return params.action === "replaceAttempt" ? "replaceAttempt is foreground-only." : `The ${child.role} workflow child may not perform ${params.action ?? "this"} actions.`;
  if (params.action === "record") {
    if (params.agentId !== child.role) return `Workflow child record actions require agentId=${child.role}.`;
    const allowedFields = CHILD_RECORD_FIELDS[child.role as keyof typeof CHILD_RECORD_FIELDS];
    if (!allowedFields) return `The ${child.role} workflow child may not record workflow fields.`;
    const disallowedWritable = RECORD_MUTABLE_FIELDS.find(field => params[field] !== undefined && !allowedFields.includes(field));
    if (disallowedWritable) return `The ${child.role} workflow child may not record ${disallowedWritable}.`;
    const allowedKeys = new Set<string>([...RECORD_BASE_FIELDS, ...allowedFields]);
    const unexpected = Object.keys(params).find(key => params[key] !== undefined && !allowedKeys.has(key));
    if (unexpected) return `The ${child.role} workflow child may not include ${unexpected} in record actions.`;
    if (!allowedFields.some(field => params[field] !== undefined)) return `Workflow child record actions require at least one ${child.role}-writable field.`;
    return undefined;
  }
  if (params.action === "report") {
    if (child.role !== "reporter" || typeof params.reporterContent !== "string" || !params.reporterContent.trim()) return "Reporter must return non-empty exact reporterContent.";
    const unexpected = Object.keys(params).find(key => params[key] !== undefined && !["action", "workflowId", "reporterContent"].includes(key));
    if (unexpected) return `The reporter workflow child may not include ${unexpected} in report actions.`;
  }
  if (!state) return undefined;
  if (child.role === "planner" && (state.stage !== "planning" || state.planProvenance !== undefined)) {
    return "Planner access is restricted to pre-existing legacy workflows still in planning.";
  }
  if (params.action === "advance") {
    const legacy = !state.stageSequence.includes("red_testing");
    const allowed = child.role === "implementer"
      ? (state.stage === "fixing" && params.stage === "reporting" && Boolean(state.review.postCapFix)) || (["implementing", "fixing"].includes(state.stage) && params.stage === (legacy ? "testing" : "reviewing"))
      : child.role === "test-writer"
        ? (legacy ? state.stage === "testing" && params.stage === "reviewing" : state.stage === "red_testing" && params.stage === "implementing")
        : Boolean(CHILD_ADVANCES[child.role] && params.stage === CHILD_ADVANCES[child.role]!.to && CHILD_ADVANCES[child.role]!.from.includes(state.stage));
    if (!allowed) return `The ${child.role} workflow child may not advance ${state.stage} to ${String(params.stage)}.`;
  }
  if (params.action === "routeReview" && state.stage !== "reviewing") return "The reviewer workflow child may route review only while reviewing.";
  if (params.action === "report" && state.stage !== "reporting") return "The reporter workflow child may report only while reporting.";
  return undefined;
}
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function validThinking(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}
async function workflowRoleMaxTokens(workflowId: string, agentId: string, load: (id: string) => Promise<WorkflowState | undefined>): Promise<number | undefined> {
  try {
    const state = await load(workflowId);
    const stored = positiveMaxTokens(state?.roleConfig?.[agentId]?.maxTokens);
    if (stored !== undefined) return stored;
    return positiveMaxTokens(getRoleConfig(agentId).maxTokens);
  } catch {
    return undefined;
  }
}
/** Resolve only validated persisted role thinking; old states fall back to bundled role defaults. */
async function workflowRoleModel(workflowId: string, agentId: string, load: (id: string) => Promise<WorkflowState | undefined>): Promise<string> {
  try { const persisted = (await load(workflowId))?.roleConfig?.[agentId]?.model; if (persisted && SUPPORTED_WORKFLOW_MODELS.has(persisted)) return persisted; } catch { /* malformed legacy role config falls back safely */ }
  return getRoleConfig(agentId).model;
}
async function workflowRoleThinking(workflowId: string, agentId: string, load: (id: string) => Promise<WorkflowState | undefined>): Promise<ThinkingLevel | undefined> {
  try {
    const stored = (await load(workflowId))?.roleConfig?.[agentId]?.thinking;
    if (validThinking(stored)) return stored;
  } catch {
    // A malformed state must not turn arbitrary persisted input into a child CLI argument.
  }
  try {
    const fallback = getRoleConfig(agentId).thinking;
    return validThinking(fallback) ? fallback : undefined;
  } catch {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);
/** Porcelain -z paths are literal; separator backslashes need translation only on win32. */
function normalizeRepositoryRelativePath(value: string): string {
  return path.posix.normalize(process.platform === "win32" ? value.replace(/\\/g, "/") : value);
}
/** Parse NUL-delimited porcelain paths without Git's human/C-quoted display syntax. */
export function parsePorcelainV1Z(output: string): string[] {
  const records = output.split("\0"); const paths: string[] = [];
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index]; if (record.length < 3) continue;
    const status = record.slice(0, 2); paths.push(normalizeRepositoryRelativePath(record.slice(3)));
    // In -z format rename/copy has destination then source as two NUL records.
    if (/[RC]/.test(status)) { const source = records[++index]; if (source !== undefined) paths.push(normalizeRepositoryRelativePath(source)); }
  }
  return [...new Set(paths)].sort();
}
async function selectedTargetWorktree(targetRepository: string | undefined, targetWorktree: string | undefined, fallback: string): Promise<string> {
  if (targetRepository === undefined && targetWorktree === undefined) return path.resolve(fallback);
  if (!targetRepository || !targetWorktree) throw new Error("targetRepository and targetWorktree must be supplied together");
  let repository: string; let worktree: string;
  try { repository = await fs.promises.realpath(targetRepository); worktree = await fs.promises.realpath(targetWorktree); }
  catch (error: any) { throw new Error(`Unable to canonicalize selected repository/worktree: ${error.message}`); }
  try {
    const [{ stdout: repositoryRoot }, { stdout: worktreeRoot }, { stdout: listed }] = await Promise.all([
      execFileAsync("git", ["-C", repository, "rev-parse", "--show-toplevel"]), execFileAsync("git", ["-C", worktree, "rev-parse", "--show-toplevel"]), execFileAsync("git", ["-C", repository, "worktree", "list", "--porcelain"]),
    ]);
    if (path.resolve(repositoryRoot.trim()) !== repository || path.resolve(worktreeRoot.trim()) !== worktree) throw new Error("selected paths are not canonical Git worktree roots");
    if (!listed.split("\n").some(line => line === `worktree ${worktree}`)) throw new Error("targetWorktree is not a member of targetRepository");
  } catch (error: any) { throw new Error(`Selected target repository/worktree validation failed: ${error.message}`); }
  // Keep the caller's canonical lexical worktree root for persisted paths. On macOS
  // realpath may add /private, which is equivalent for membership validation but not a
  // stable user-selected worktree spelling.
  return path.resolve(targetWorktree);
}
async function repositoryPreflight(cwd: string): Promise<{ branch?: string; dirtyPaths: string[]; worktree: string }> {
  try {
    const [{ stdout: branch }, { stdout: status }, { stdout: worktree }] = await Promise.all([
      execFileAsync("git", ["branch", "--show-current"], { cwd }), execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }), execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd }),
    ]);
    return { branch: branch.trim() || undefined, dirtyPaths: parsePorcelainV1Z(status), worktree: worktree.trim() };
  } catch { return { dirtyPaths: [], worktree: path.resolve(cwd) }; }
}
/** Clean-start preflight keeps acknowledged unrelated dirty files protected while rejecting this task's stale claims. */
function normalizeDeclaredDirtyPaths(values: string[] | undefined, dirtyPaths: string[], field: string): string[] {
  const normalized = [...new Set((values ?? []).map(value => {
    if (!value.trim() || path.isAbsolute(value)) throw new Error(`${field} entries must be non-empty relative dirty paths`);
    const candidate = normalizeRepositoryRelativePath(value);
    if (candidate === ".." || candidate.startsWith("../")) throw new Error(`${field} entries must remain inside the target worktree`);
    return candidate;
  }))].sort();
  const unknown = normalized.filter(value => !dirtyPaths.includes(value));
  if (unknown.length) throw new Error(`${field} must name currently dirty paths: ${unknown.join(", ")}`);
  return normalized;
}
function cleanStartPreflight(preflight: { dirtyPaths: string[]; worktree: string }, acknowledged: string[], taskOwned: string[]): void {
  const unacknowledged = preflight.dirtyPaths.filter(item => !acknowledged.includes(item));
  const taskOwnedDirty = preflight.dirtyPaths.filter(item => taskOwned.includes(item));
  if (taskOwnedDirty.length) {
    // release task-owned dirty paths after a checkpoint/clean operation; never silently adopt them.
    throw new Error(`Clean-start preflight: task-owned dirty paths (${taskOwnedDirty.join(", ")}) block workflow creation in target worktree ${preflight.worktree}; checkpoint or clean them, then release task-owned dirty paths and retry. Acknowledged unrelated dirty paths remain protected.`);
  }
  if (unacknowledged.length) throw new Error(`Clean-start preflight: acknowledge unrelated dirty paths before workflow creation in target worktree ${preflight.worktree}: ${unacknowledged.join(", ")}. Checkpoint or clean them first.`);
}
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") { const source = value as Record<string, unknown>; return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`; } return JSON.stringify(value); }
function reviewPayloadDigest(params: Record<string, unknown>): string { return crypto.createHash("sha256").update(canonicalJson({ findings: params.findings, reviewOutput: params.reviewOutput, suspectedWeakness: params.suspectedWeakness, testCommand: params.testCommand, testPassed: params.testPassed, testOutput: params.testOutput })).digest("hex"); }
/** Every route is persisted by an explicit Reviewer key or a deterministic compatibility key. */
function routeReviewKey(params: Record<string, unknown>, digest: string): string { return typeof params.idempotencyKey === "string" && params.idempotencyKey.trim() ? params.idempotencyKey : `review-${digest}`; }
function requiresArchitectureContract(criteria: string[]): boolean {
  return criteria.some(item => /\b(mechanical(?:ly)?|coupl(?:e|ed|ing)|executable|live|generated|architecture-sensitive)\b/i.test(item));
}
function compactArtifactBundle(state: WorkflowState): string {
  const criteria = state.acceptanceCriteria.map(item => `- ${item}`).join("\n");
  const evidence = state.tests.slice(-2).map(item => `${item.kind ?? "evidence"}: ${item.command}`).join("; ");
  const architecture = state.executableEvidence || state.architectureContract
    ? `Executable evidence: ${state.executableEvidence ?? "(not required)"}\nArchitecture contract: ${state.architectureContract ?? "(not required)"}\n`
    : "";
  return `[workflow artifact bundle]\nApproved plan: ${state.planProvenance?.path ?? "persisted"} (${state.planProvenance?.digest?.slice(0, 12) ?? "legacy"})\nAcceptance criteria:\n${criteria}\n${architecture}Evidence: ${evidence || "none yet"}\n[/workflow artifact bundle]\n\n`;
}
export function requireEvidence(state: Pick<WorkflowState, "tests">, kind: "targeted_red" | "full_green", floor = 0): void {
  const evidenceIndex = state.tests.map((test, index) => ({ test, index })).reverse().find(({ test, index }) => test.kind === kind && index >= floor);
  const evidence = evidenceIndex?.test;
  if (!evidence?.command.trim() || !evidence.output?.trim()) throw new Error(`${kind} handoff requires a command and non-empty output${floor ? " after the review bounce" : ""}`);
  if (kind === "targeted_red" && (evidence.passed || !evidence.expectedFailureReason?.trim())) throw new Error("Test Writer must record a failing targeted_red run and its expected behavioral reason");
  if (kind === "full_green" && !evidence.passed) throw new Error("Implementer may not hand off while any test is red");
}
function reporterContentGaps(state: WorkflowState, reporterContent: string): string[] {
  const content = reporterContent.toLowerCase();
  const has = (value: string | undefined) => !value?.trim() || content.includes(value.toLowerCase());
  const gaps: string[] = [];
  const require = (label: string, value: string | undefined) => { if (!has(value)) gaps.push(label); };
  require("goal", state.goal);
  for (const criterion of state.acceptanceCriteria) require("acceptance criterion", criterion);
  if (state.planProvenance) { require("approved plan path", state.planProvenance.path); require("approved plan digest", state.planProvenance.digest); }
  require("implementation summary", state.implementationSummary);
  for (const files of Object.values(state.filesOwned)) for (const file of files) require("changed file", path.relative(state.repositoryRoot, file));
  for (const evidence of state.tests) {
    require("test command", evidence.command);
    if (!content.includes(evidence.passed ? "pass" : "fail")) gaps.push("test result");
    require("test output", evidence.output);
    if (!evidence.passed) require("test failure reason", evidence.expectedFailureReason);
  }
  if (state.review.approved) { if (!content.includes("approved")) gaps.push("review verdict"); }
  else if (state.review.findings.length && !content.includes("not approved")) gaps.push("review verdict");
  for (const finding of state.review.findings) { require("review finding category", finding.category); require("review finding", finding.title); require("review finding detail", finding.detail); }
  if (!state.followUps.length && !/follow[ -]?ups?\s*:\s*(?:none|no)/i.test(reporterContent)) gaps.push("follow-up verdict");
  for (const followUp of state.followUps) { require("follow-up", followUp.title); require("follow-up detail", followUp.detail); }
  for (const deviation of state.acceptedDeviations) for (const value of [deviation.code, deviation.reason, deviation.decision, deviation.risk, ...deviation.evidence]) require("accepted deviation", value);
  for (const risk of state.unresolvedRisks) require("unresolved risk", risk);
  for (const attempt of state.attempts) { require("recorded failure", attempt.reason); require("recorded failure role", attempt.role); }
  return [...new Set(gaps)];
}

export default function (pi: ExtensionAPI) {
  // Manual mode is process-local; a trigger grants separate, ephemeral foreground-run
  // activation. Workflow children retain access even though their processes default off.
  let uiCtx: ExtensionContext | undefined;
  const sessionWorkflowIds = new Set<string>(isChildSession() ? [] : activeWorkflowIds());
  let currentId: string | undefined = [...sessionWorkflowIds].at(-1);
  const trackWorkflowId = (id: string): void => {
    currentId = id;
    sessionWorkflowIds.add(id);
    if (!isChildSession()) setActiveWorkflowIds(sessionWorkflowIds);
  };
  const untrackWorkflowId = (id: string): void => {
    sessionWorkflowIds.delete(id);
    currentId = [...sessionWorkflowIds].at(-1);
    if (!isChildSession()) setActiveWorkflowIds(sessionWorkflowIds);
  };
  let foregroundActivated = false;
  // Pending/preflight activation is replaced on every input. It becomes a run activation
  // only after agent_start, so handled input cannot authorize a later run.
  let pendingForegroundActivation = false;
  let preflightForegroundActivation = false;
  const workflowActive = (): boolean => workflowModeEnabled() || foregroundActivated || pendingForegroundActivation || preflightForegroundActivation || isWorkflowChildSession();
  const pendingAutomaticCloses = new Map<string, Promise<void>>();
  const scheduledAutomaticCloses = new Set<string>();
  const completionToolCalls = new Set<string>();
  let activeRunId: string | undefined;
  const activeDispatches = new Map<string, { workflowId: string; role: string; correlationId: string; startedAt: number }>();
  const sessionId = () => uiCtx?.sessionManager?.getSessionId?.();
  const diagnose = (workflowId: string, type: string, fields: Record<string, unknown> = {}): void => {
    void appendDiagnostic(createDiagnosticEvent(workflowId, type, { sessionId: sessionId(), runId: activeRunId, ...fields } as any)).catch(() => undefined);
  };
  // Notifications are session-scoped so one stale workflow cannot spam status checks,
  // while reload/session replacement deliberately permits one fresh warning.
  const staleWorkflowNotifications = new Set<string>();
  const refreshStaleWorkflowWarnings = (states: WorkflowState[], ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const now = Date.now();
    const stale = states.filter(state => isWorkflowExpired(state.expiresAt, now));
    const staleIds = new Set(stale.map(state => state.id));
    for (const id of staleWorkflowNotifications) if (!staleIds.has(id)) staleWorkflowNotifications.delete(id);
    ctx.ui.setStatus("development-workflow-stale", stale.length
      ? `workflow expired: ${stale.map(state => state.id).join(", ")}`
      : undefined);
    for (const state of stale) {
      if (staleWorkflowNotifications.has(state.id)) continue;
      staleWorkflowNotifications.add(state.id);
      ctx.ui.notify(`Workflow ${state.id} is stale: it expired at ${state.expiresAt}.`, "warning");
    }
  };
  // Short TTL bounds cross-process staleness; transaction/security paths below use disk directly.
  const stateCache = new WorkflowStateCache<WorkflowState>();
  const cachedState = (id: string) => stateCache.get(id, loadState);
  const foregroundWorkflowIds = (): string[] => [...new Set([...sessionWorkflowIds, ...activeWorkflowIds()])];
  const isForegroundWorkflowActive = (id: string): boolean => foregroundWorkflowIds().includes(id);
  const activeSessionStates = async (): Promise<WorkflowState[]> =>
    (await Promise.all(foregroundWorkflowIds().map(id => cachedState(id)))).filter((state): state is WorkflowState => Boolean(state));
  const discardSessionWorkflow = async (state: WorkflowState): Promise<void> => {
    // Workflow state is shared with child processes only for the lifetime of this
    // foreground session. Cleanup deliberately leaves final reports untouched.
    let closeError: unknown;
    try { await requestSubagentClose(pi, state.id); } catch (error) { closeError = error; }
    // Remove coordination state first so a legacy project-artifact permission error
    // cannot accidentally leave a workflow recoverable across sessions.
    await removeState(state.id);
    await removeInProgressWorkplan(state);
    stateCache.delete(state.id);
    untrackWorkflowId(state.id);
    diagnose(state.id, "workflow_discarded", { stage: state.stage, outcome: closeError ? "failure" : "success" });
    if (closeError) throw closeError;
  };
  const persist = async (state: WorkflowState): Promise<void> => {
    await saveState(state); trackWorkflowId(state.id);
    stateCache.set(state);
    await updateSystemOfRecord(state);
  };
  // State mutations commit before external system-of-record I/O. In particular, never
  // call saveState from a transactState callback: that would try to acquire the same
  // cross-process lock and would let a stale snapshot escape the transaction.
  const updateRecordAfterCommit = async (state: WorkflowState): Promise<void> => {
    try { await updateSystemOfRecord(state); }
    catch (error: any) {
      const reason = `System-of-record update failed: ${error.message}`;
      const { state: failed } = await transactState(state.id, current => { current.blockingReason = reason; });
      stateCache.set(failed);
      throw new Error(reason);
    }
  };
  const applyThreadMode = (ctx: ExtensionContext) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(workflowActive() ? [...new Set([...active, "development_workflow"])] : active.filter(name => name !== "development_workflow"));
    // Default-off is normal, not a persistent footer warning.
    ctx.ui.setStatus("development-workflow", undefined);
  };
  const setThreadMode = (enabled: boolean, ctx: ExtensionContext) => {
    setWorkflowModeEnabled(enabled);
    applyThreadMode(ctx);
  };
  pi.on("session_start", async (_event, ctx) => {
    // Hot reload keeps the current process-local workflow identity. A new process or
    // replacement session never discovers unfinished state from disk.
    stateCache.clear();
    foregroundActivated = false;
    pendingForegroundActivation = false;
    preflightForegroundActivation = false;
    staleWorkflowNotifications.clear();
    uiCtx = ctx;
    if (!isChildSession()) {
      sessionWorkflowIds.clear();
      for (const id of activeWorkflowIds()) sessionWorkflowIds.add(id);
      currentId = [...sessionWorkflowIds].at(-1);
    }
    const active = await activeSessionStates();
    for (const id of [...sessionWorkflowIds]) if (!active.some(state => state.id === id)) untrackWorkflowId(id);
    refreshStaleWorkflowWarnings(active, ctx);
    applyThreadMode(ctx);
    void pruneExpiredDiagnostics().catch(() => undefined);
    if (currentId) diagnose(currentId, "session_start", { metadata: { reason: _event.reason } });
  });
  pi.on("session_shutdown", async event => {
    const endingIds = [...sessionWorkflowIds];
    for (const id of endingIds) diagnose(id, "session_shutdown", { metadata: { reason: event.reason } });
    if (!isChildSession() && event.reason !== "reload") {
      for (const id of endingIds) {
        try {
          const state = await loadState(id);
          if (state) await discardSessionWorkflow(state);
          else untrackWorkflowId(id);
        } catch (error: any) {
          // State removal is attempted even when child cleanup fails. Report the failure,
          // but never offer cross-session recovery on the next startup.
          untrackWorkflowId(id);
          if (uiCtx?.hasUI) uiCtx.ui.notify(`Workflow session cleanup failed for ${id}: ${error.message}`, "error");
        }
      }
    }
    foregroundActivated = false; pendingForegroundActivation = false; preflightForegroundActivation = false; completionToolCalls.clear(); staleWorkflowNotifications.clear(); uiCtx = undefined; stateCache.clear();
  });
  // A canceled or otherwise ended low-level run has no future foreground result message.
  pi.on("agent_end", () => {
    completionToolCalls.clear();
    for (const [toolCallId, dispatch] of activeDispatches) {
      diagnose(dispatch.workflowId, "role_dispatch_end", { correlationId: dispatch.correlationId, role: dispatch.role, durationMs: Date.now() - dispatch.startedAt, outcome: "cancelled", metadata: { toolCallId } });
    }
    activeDispatches.clear();
  });
  pi.on("agent_settled", () => {
    if (currentId && activeRunId) diagnose(currentId, "agent_settled", { correlationId: activeRunId, outcome: "success" });
    activeRunId = undefined;
    foregroundActivated = false; pendingForegroundActivation = false; preflightForegroundActivation = false; if (uiCtx) applyThreadMode(uiCtx);
  });

  // Only idle, raw foreground input can activate a run. Queued follow-ups and streaming
  // steering are intentionally ignored: they belong to an already-running turn and have
  // no safe independent prompt/tool lifecycle.
  pi.on("input", (event: any) => {
    pendingForegroundActivation = false;
    preflightForegroundActivation = false;
    if (!isChildSession() && event.source !== "extension" && event.streamingBehavior === undefined && hasWorkflowTrigger(event.text ?? "")) {
      pendingForegroundActivation = true;
    }
    // Clearing/replacing transient activation must also immediately remove stale tools.
    if (uiCtx) applyThreadMode(uiCtx);
  });
  pi.on("agent_start", () => {
    activeRunId = crypto.randomUUID();
    if (currentId) diagnose(currentId, "agent_start", { correlationId: activeRunId });
    if (preflightForegroundActivation) foregroundActivated = true;
    pendingForegroundActivation = false;
    preflightForegroundActivation = false;
    if (uiCtx) applyThreadMode(uiCtx);
  });

  // Preserve a bounded, current workflow snapshot while retaining Pi's normal
  // split-turn handling and cumulative file-operation metadata from compact().
  pi.on("session_before_compact", async (event, ctx) => {
    if (currentId) diagnose(currentId, "compaction_start", { metadata: { reason: event.reason, willRetry: event.willRetry } });
    try {
      const snapshotIds = workflowChild() ? [workflowChild()!.workflowId] : foregroundWorkflowIds();
      const snapshotStates = (await Promise.all(snapshotIds.map(id => loadState(id)))).filter((state): state is WorkflowState => Boolean(state));
      const snapshot = renderWorkflowSnapshot(snapshotStates);
      if (!snapshot || !ctx.model) {
        if (currentId) diagnose(currentId, "compaction_end", { outcome: "success", metadata: { fallback: "no active workflow snapshot or model" } });
        return;
      }
      // Auth resolution can throw (for example, a token refresh failure), so keep it
      // in the same safe-fallback boundary as the custom compaction request.
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) {
        if (currentId) diagnose(currentId, "compaction_end", { outcome: "failure", error: normalizeDiagnosticError(new Error("model authentication unavailable")) });
        if (!event.signal.aborted && ctx.hasUI) ctx.ui.notify("Workflow state was not added to compaction: model authentication is unavailable", "warning");
        return;
      }
      const result = await compact(event.preparation, ctx.model, auth.apiKey, auth.headers, event.customInstructions, event.signal, undefined, undefined, auth.env);
      if (currentId) diagnose(currentId, "compaction_end", { outcome: "success", metadata: { reason: event.reason, tokensBefore: event.preparation.tokensBefore } });
      return { compaction: { ...result, summary: mergeWorkflowSnapshot(result.summary, snapshot) } };
    } catch (error: any) {
      if (currentId) diagnose(currentId, "compaction_end", { outcome: event.signal.aborted ? "cancelled" : "failure", error: normalizeDiagnosticError(error) });
      // Returning nothing explicitly delegates to Pi's default compaction path.
      if (!event.signal.aborted && ctx.hasUI) ctx.ui.notify(`Workflow compaction preservation failed; using default compaction: ${error.message}`, "warning");
      return;
    }
  });

  // Phase 1E: Role-specific system prompts for workflow-scoped child sessions.
  // PI_SUBAGENT_ID is a lossy, sanitized registry key; use the separately handed-off
  // raw role instead. This also works for arbitrary workflow IDs such as ticket/a:42.
  pi.on("before_agent_start", async (event, ctx) => {
    const child = workflowChild();
    if (child) {
      try {
          const role = getRoleConfig(child.role);
          const agentDir = getAgentDir();
          const agentFile = path.join(agentDir, "extensions", "development-workflow", "agents", `${role.name}.md`);
          try {
            const content = fs.readFileSync(agentFile, "utf8");
            const bodyStart = content.indexOf("\n---\n");
            const systemPrompt = bodyStart >= 0 ? content.slice(bodyStart + 5).trim() : content;
            return { systemPrompt: `${event.systemPrompt}\n\n${systemPrompt}\n\nChild tool discipline: use at most one bash call per assistant turn; combine commands into one compound command. Read, grep, and find calls may still be parallel.` };
          } catch {
            // Fallback: inject a basic role prompt if file not found
            return { systemPrompt: `${event.systemPrompt}\n\nYou are the ${role.name} role in a development workflow. ${role.description}.` };
          }
      } catch {
        // A malformed/unrecognized raw identity never gains a role prompt or tool authority.
      }
    }
    // Consume the one input's activation at preflight so a handled or failed input
    // cannot arm a later run. It remains active after agent_start until settlement.
    const activeForPrompt = workflowActive();
    preflightForegroundActivation = pendingForegroundActivation;
    pendingForegroundActivation = false;
    if (uiCtx) applyThreadMode(uiCtx);
    if (!activeForPrompt) return undefined;
    let planContext = "";
    if (currentId) {
      try {
        const state = await cachedState(currentId);
        if (state && !["completed", "blocked", "aborted"].includes(state.stage)) {
          const model = await resolveWorkflowModel(ctx);
          if (!await pi.setModel(model)) throw new Error(`Unable to activate required workflow model ${WORKFLOW_MODEL}`);
          planContext = `\n\n${renderOrchestratorPlanContext(state)}`;
        }
      } catch (error: any) {
        throw new Error(`Unable to resume development workflow ${currentId}: ${error.message}`);
      }
    }
    return { systemPrompt: `${event.systemPrompt}\n\nYou are the development-workflow Orchestrator. Agent profiles and workflow roles are different namespaces. Workflow lifecycle dispatches accept only these exact agentId values: planner, implementer, test-writer, reviewer, reporter. Do not invent or semantically infer workflow roles. Auxiliary profiles such as researcher remain available through ordinary subagent dispatch, for example { agent: "researcher", task: "Investigate ..." }, without lifecycle, workflowId, or agentId. Route implementation through workflow-scoped subagents; do not directly perform normal implementation edits. Use stable workflowId and valid role agentId handles. Never ask a child to re-plan the entire change. Review-cycle limits escalate recoverably; never automatically block, defer, or approve findings.${planContext}` };
  });

  // Child policy: at most one bash call per assistant turn; a sibling bash is blocked immediately with combine commands guidance instead of waiting on the mutation mutex.
  // Phase 1B: Allow workflow-scoped child sessions to call development_workflow.
  // When a child session is dispatched with lifecycle="workflow", it needs to be
  // able to call development_workflow for record/advance/routeReview actions.
  pi.on("tool_call", async (event, ctx) => {
    // Development-workflow owns persisted role defaults and supported role models;
    // subagent owns final thinking/token resolution and resume persistence.
    if (event.toolName === "subagent") {
      const input = event.input as { lifecycle?: string; workflowId?: string; agentId?: string; task?: string; thinking?: ThinkingLevel; maxTokens?: unknown; workflowMaxTokens?: unknown; model?: string; freshSession?: boolean };
      if (input.lifecycle === "workflow") {
        if (!input.workflowId) throw new Error("Workflow lifecycle dispatch requires workflowId.");
        if (!isChildSession() && !isForegroundWorkflowActive(input.workflowId)) throw new Error(`Workflow ${input.workflowId} is not active in this foreground session.`);
        if (!input.agentId) throw new Error(`Workflow lifecycle dispatch requires agentId. Valid workflow roles: ${WORKFLOW_ROLE_NAMES.join(", ")}.`);
        if (!(WORKFLOW_ROLE_NAMES as readonly string[]).includes(input.agentId)) throw new Error(`Invalid workflow agentId "${input.agentId}". Valid workflow roles: ${WORKFLOW_ROLE_NAMES.join(", ")}. Profiles are not workflow roles and semantic aliases are not inferred. For auxiliary research, use ordinary non-workflow dispatch: { agent: "researcher", task: "Investigate ..." } (omit lifecycle, workflowId, and agentId).`);
        // The compact bundle is optional context. A corrupt persisted record must not
        // prevent workflowRoleThinking from using its existing safe default fallback.
        let dispatchState: WorkflowState | undefined;
        try { dispatchState = await loadState(input.workflowId); } catch { /* role defaults below remain available */ }
        if (dispatchState && !input.task?.startsWith("[workflow artifact bundle]")) input.task = `${compactArtifactBundle(dispatchState)}${input.task ?? ""}`;
        if (Buffer.byteLength(input.task ?? "", "utf8") > MAX_WORKFLOW_TASK_BYTES) throw new Error(`Workflow handoff task exceeds the ${MAX_WORKFLOW_TASK_BYTES}-byte cap; send one compact artifact bundle and omit repeated broad rediscovery or whole-file rereads.`);
        // Every Reviewer dispatch uses a fresh session; the stable logical Implementer role retains authority across fixes, while physical attempts are foreground-replaceable after infrastructure failure.
        if (input.agentId === "reviewer") input.freshSession = true;
        // Role defaults follow Claude analogues. Explicit thinking override remains valid; overrides are accepted only
        // within the supported GPT-5.6 models and then persisted for stable resume/rounds.
        const configured = await workflowRoleModel(input.workflowId, input.agentId, loadState);
        const effective = input.model ?? configured;
        if (!SUPPORTED_WORKFLOW_MODELS.has(effective)) throw new Error(`Unsupported workflow role model ${effective}`);
        await resolveQualifiedWorkflowModel(ctx, effective);
        input.model = effective;
        if (effective !== configured) {
          const { state } = await transactState(input.workflowId, current => {
            if (!current.roleConfig?.[input.agentId!]) throw new Error(`Unknown workflow role ${input.agentId}`);
            current.roleConfig[input.agentId!].model = effective;
          });
          stateCache.set(state);
        }
        if (input.thinking === undefined) {
          const thinking = await workflowRoleThinking(input.workflowId, input.agentId, loadState);
          if (thinking !== undefined) input.thinking = thinking;
        }
        if (input.maxTokens === undefined && input.workflowMaxTokens === undefined) {
          const maxTokens = await workflowRoleMaxTokens(input.workflowId, input.agentId, loadState);
          if (maxTokens !== undefined) input.workflowMaxTokens = maxTokens;
        }
        const correlationId = crypto.randomUUID();
        const startedAt = Date.now();
        activeDispatches.set(event.toolCallId, { workflowId: input.workflowId, role: input.agentId, correlationId, startedAt });
        diagnose(input.workflowId, "role_dispatch_start", {
          correlationId, role: input.agentId, model: input.model, thinking: input.thinking,
          maxTokens: positiveMaxTokens(input.maxTokens) ?? positiveMaxTokens(input.workflowMaxTokens),
          taskBytes: Buffer.byteLength(input.task ?? "", "utf8"), metadata: { toolCallId: event.toolCallId, freshSession: input.freshSession ?? false }, 
        });
      }
      return undefined;
    }
    if (event.toolName === "development_workflow") {
      const malformedChild = malformedWorkflowChildError();
      if (malformedChild) return { block: true, reason: malformedChild };
      const childError = childWorkflowAccessError(event.input as { action?: string; workflowId?: string });
      if (childError) return { block: true, reason: childError };
      if (workflowActive()) return undefined;
      return { block: true, reason: "Development workflow is inactive. Use a trigger phrase or /workflow-enable." };
    }
    return undefined;
  });

  const closeState = async (state: WorkflowState): Promise<string> => {
    // The subagent action owns its session/diagnostic policy. Keep development state until
    // that action succeeds so explicit terminal cleanup remains retryable in this session.
    diagnose(state.id, "cleanup_start", { stage: state.stage });
    const startedAt = Date.now();
    try {
      const text = await requestSubagentClose(pi, state.id);
      await retireState(state.id);
    stateCache.delete(state.id);
    untrackWorkflowId(state.id);
      const cleanupEvent = createDiagnosticEvent(state.id, "cleanup_end", { sessionId: sessionId(), runId: activeRunId, stage: state.stage, durationMs: Date.now() - startedAt, outcome: "success" });
      await appendDiagnostic(cleanupEvent).catch(() => undefined);
      if (state.stage === "completed") {
        try { await compactSuccessfulDiagnostics(state.id, await summarizeDiagnostics(state.id)); } catch { /* Diagnostics never invalidate technical cleanup. */ }
      }
      return text;
    } catch (error: any) {
      diagnose(state.id, "cleanup_end", { stage: state.stage, durationMs: Date.now() - startedAt, outcome: "failure", error: normalizeDiagnosticError(error) });
      throw error;
    }
  };
  const closeCompletedAfterForegroundResult = async (workflowId: string): Promise<void> => {
    if (pendingAutomaticCloses.has(workflowId)) return pendingAutomaticCloses.get(workflowId)!;
    const closing = (async () => {
      const state = await loadState(workflowId);
      if (!state || state.stage !== "completed") return;
      await closeState(state);
    })();
    pendingAutomaticCloses.set(workflowId, closing);
    try { await closing; }
    finally { pendingAutomaticCloses.delete(workflowId); }
  };
  // Keep candidates only from a successful tool result until its final foreground message.
  // This short-lived FIFO is deliberately bounded: canceled runs may never emit message_end.
  const trackCompletionToolCall = (toolCallId: string): void => {
    completionToolCalls.delete(toolCallId);
    while (completionToolCalls.size >= MAX_TRACKED_COMPLETION_TOOL_CALLS) {
      completionToolCalls.delete(completionToolCalls.values().next().value!);
    }
    completionToolCalls.add(toolCallId);
  };
  pi.on("tool_result", (event: any) => {
    if (event.toolName === "subagent") {
      const dispatch = activeDispatches.get(event.toolCallId);
      if (dispatch) {
        activeDispatches.delete(event.toolCallId);
        const result = event.details?.results?.[0];
        const cancelled = result?.status === "aborted";
        diagnose(dispatch.workflowId, "role_dispatch_end", {
          correlationId: dispatch.correlationId, role: dispatch.role, durationMs: Date.now() - dispatch.startedAt,
          outcome: cancelled ? "cancelled" : event.isError || result?.status === "failed" ? "failure" : "success",
          usage: result?.usage, error: event.isError || result?.reason ? normalizeDiagnosticError(new Error(result?.reason ?? "subagent dispatch failed")) : undefined,
          metadata: { toolCallId: event.toolCallId, exitCode: result?.exitCode },
        });
      }
    }
    if (event.toolName === "development_workflow" && event.input?.action === "complete" && !event.isError) trackCompletionToolCall(event.toolCallId);
  });
  // Failed, blocked, and aborted workflows deliberately retain their state and diagnostics.
  pi.on("message_end", (event: any) => {
    const message = event.message;
    if (currentId && message?.role === "assistant" && message.usage) {
      diagnose(currentId, "message_usage", { usage: { input: message.usage.input, output: message.usage.output, cost: message.usage.cost?.total }, model: message.provider && message.model ? `${message.provider}/${message.model}` : undefined });
    }
    if (message?.role !== "toolResult" || !completionToolCalls.delete(message.toolCallId)) return;
    const state = message.details as WorkflowState | undefined;
    if (message.toolName !== "development_workflow" || message.isError || state?.stage !== "completed" || !state.id || scheduledAutomaticCloses.has(state.id)) return;
    scheduledAutomaticCloses.add(state.id);
    // Defer to a later turn of the event loop: this handler must finish before cleanup begins.
    setTimeout(() => {
      void closeCompletedAfterForegroundResult(state.id).catch((error: any) => {
        if (uiCtx?.hasUI) uiCtx.ui.notify(`Automatic workflow cleanup failed for ${state.id}: ${error.message}`, "error");
      }).finally(() => scheduledAutomaticCloses.delete(state.id));
    }, 0);
  });

  // Notify only for a persisted transition into a terminal state. This makes the
  // state itself the deduplication source across tool calls and commands.
  const notifyTerminalTransition = (previousStage: Stage, s: WorkflowState, ctx: ExtensionContext): void => {
    if (previousStage === s.stage || !ctx.hasUI) return;
    if (s.stage === "completed") ctx.ui.notify(`Workflow ${s.id} completed: ${s.finalOutcome ?? "success"}`, "success");
    else if (s.stage === "blocked") ctx.ui.notify(`Workflow ${s.id} blocked: ${s.blockingReason ?? "unknown"}`, "error");
    else if (s.stage === "aborted") ctx.ui.notify(`Workflow ${s.id} aborted: ${s.blockingReason ?? "unknown"}`, "warning");
  };

  pi.registerTool({ name: "development_workflow", label: "Development Workflow", description: "Create, route, inspect, and close structured development workflows for the current foreground session. The foreground agent remains the Orchestrator; dispatch role jobs through workflow-scoped subagents.", promptSnippet: "Manage session-scoped staged software-development workflows", parameters: Params,
    async execute(_id, p, _signal, _update, ctx) {
      uiCtx = ctx;
      // Guard execution as well as the active-tool list: queued/stale calls or another
      // extension re-enabling the tool must not bypass disabled mode.
      const malformedChild = malformedWorkflowChildError();
      if (malformedChild) throw new Error(malformedChild);
      const childError = childWorkflowAccessError(p);
      if (childError) throw new Error(childError);
      if (!workflowActive()) throw new Error("Development workflow is inactive. Use a trigger phrase or /workflow-enable.");
      if (p.action === "start") try {
        const workflowModel = await resolveWorkflowModel(ctx);
        if (!await pi.setModel(workflowModel)) {
          throw new Error(`Unable to activate required workflow model ${WORKFLOW_MODEL}. Check Pi model registration and provider credentials, then retry.`);
        }
        if (!p.goal) throw new Error("start requires goal");
        if (p.maxReviewCycles !== undefined && (!Number.isInteger(p.maxReviewCycles) || p.maxReviewCycles < 1)) throw new Error("maxReviewCycles must be a positive integer");
        if (!p.planPath) throw new Error("start requires planPath");
        if (p.mode === "adopt_existing" && !p.inventory?.length) throw new Error("adopt_existing inventory is required");
        let preflight: { branch?: string; dirtyPaths: string[]; worktree: string }; let approvedPlan: Awaited<ReturnType<typeof ingestPlan>>;
        try {
          const targetWorktree = await selectedTargetWorktree(p.targetRepository, p.targetWorktree, ctx.cwd);
          preflight = await repositoryPreflight(targetWorktree);
          preflight.worktree = targetWorktree;
          const requestedPlan = path.resolve(preflight.worktree, p.planPath);
          if (requestedPlan !== preflight.worktree && !requestedPlan.startsWith(`${preflight.worktree}${path.sep}`)) throw new Error("planPath must remain inside the selected target worktree");
          // Resolve the approved plan against the same canonical selected worktree that
          // supplied the branch and dirt snapshot; never against the foreground cwd.
          approvedPlan = await ingestPlan(preflight.worktree, p.planPath);
          // The plan was realpath-validated inside the selected worktree. Preserve an
          // explicitly selected worktree spelling; legacy cwd starts retain realpath.
          if (p.targetWorktree) approvedPlan.path = path.resolve(preflight.worktree, p.planPath);
        } catch (error: any) { throw error; }
        const acknowledged = normalizeDeclaredDirtyPaths(p.acknowledgeDirtyPaths, preflight.dirtyPaths, "acknowledgeDirtyPaths");
        const taskOwned = normalizeDeclaredDirtyPaths(p.taskOwnedDirtyPaths, preflight.dirtyPaths, "taskOwnedDirtyPaths");
        const overlap = taskOwned.filter(item => acknowledged.includes(item));
        if (overlap.length) throw new Error(`taskOwnedDirtyPaths cannot overlap acknowledged unrelated dirty paths: ${overlap.join(", ")}`);
        cleanStartPreflight(preflight, acknowledged, taskOwned);
        if ((p.batchId || p.siblingOwnedFiles?.length || p.sharedContracts?.length) && !p.parallelExplicitlyRequested) throw new Error("Parallel batch metadata requires parallelExplicitlyRequested=true");
        const id = p.workflowId ?? `workflow-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
        if (await loadState(id)) throw new Error(`Workflow already exists: ${id}`);
        if (!p.acceptanceCriteria?.length || p.acceptanceCriteria.some(item => !item.trim())) {
          throw new Error("start requires at least one non-empty acceptanceCriteria entry copied from the approved plan");
        }
        if (requiresArchitectureContract(p.acceptanceCriteria) && (!p.executableEvidence?.trim() || !p.architectureContract?.trim())) {
          throw new Error("Approved plan acceptance criteria require executable evidence and an architecture contract before implementation.");
        }
        const sor = await resolveSystemOfRecord(preflight.worktree, ctx.isProjectTrusted(), p.approveDetectedIntegration ?? false);
        if (p.mode === "recovery") throw new Error("start does not accept recovery mode");
        if (p.mode === "adopt_existing" && !p.inventory?.length) throw new Error("adopt_existing inventory is required");
        const state = createState({ id, goal: p.goal, acceptanceCriteria: p.acceptanceCriteria, repositoryRoot: preflight.worktree, systemOfRecord: sor, mode: p.mode as "new" | "adopt_existing" | undefined });
        if (p.mode === "adopt_existing") {
          // State parsing validates every per-artifact foreground acceptance before persistence.
          adoptExistingState(state, p.inventory as any);
        }
        state.plan = approvedPlan.content;
        state.planProvenance = approvedPlan;
        if (p.executableEvidence?.trim()) state.executableEvidence = p.executableEvidence.trim();
        if (p.architectureContract?.trim()) state.architectureContract = p.architectureContract.trim();
        // Phase 1A: Store per-role config (thinking, maxTokens) in the workflow state.
        const roleConfigs: Record<string, { thinking: ThinkingLevel; maxTokens: number | null; model: string }> = {};
        for (const roleName of ACTIVE_ROLE_NAMES) {
          try {
            const role = getRoleConfig(roleName);
            roleConfigs[roleName] = { thinking: role.thinking, maxTokens: role.maxTokens === null ? null : Math.min(role.maxTokens, workflowModel.maxTokens), model: role.model };
          } catch { /* skip unknown roles */ }
        }
        (state as any).roleConfig = roleConfigs;
        state.modelProvider = WORKFLOW_MODEL_PROVIDER;
        state.modelId = WORKFLOW_MODEL_ID;
        state.preflight = { branch: preflight.branch, baseBranch: p.baseBranch, dirtyPaths: preflight.dirtyPaths, acknowledgedDirtyPaths: acknowledged, worktree: preflight.worktree };
        state.batch = { id: p.batchId, siblingOwnedFiles: p.siblingOwnedFiles ?? [], sharedContracts: p.sharedContracts ?? [], explicitlyRequested: p.parallelExplicitlyRequested ?? false };
        state.agentHandles = { implementer: "implementer", "test-writer": "test-writer", reviewer: "reviewer", reporter: "reporter", ...state.agentHandles };
        // This is a recoverable escalation threshold, never an automatic terminal verdict.
        state.review.maxReviewCycles = p.maxReviewCycles ?? DEFAULT_MAX_REVIEW_CYCLES;
        // Expiration is persisted as provided. Invalid values are never treated as expired.
        if (p.expiresAt !== undefined) state.expiresAt = p.expiresAt;
        await persist(state);
        diagnose(id, "workflow_start", { stage: state.stage, model: WORKFLOW_MODEL, planPath: approvedPlan.path, planDigest: approvedPlan.digest, metadata: { planBytes: approvedPlan.bytes, maxReviewCycles: state.review.maxReviewCycles } });
        refreshStaleWorkflowWarnings(await activeSessionStates(), ctx);
        return { content: [{ type: "text", text: `Started ${id} in red_testing with approved plan ${approvedPlan.path} (${approvedPlan.digest}). Dispatch test-writer first with lifecycle=workflow, workflowId=${id}, agentId=test-writer.` }], details: state };
      } catch (error: any) {
        const rejectedId = p.workflowId ?? "unassigned";
        await appendDiagnostic(createDiagnosticEvent(rejectedId, "action_rejected", { sessionId: sessionId(), runId: activeRunId, outcome: "failure", error: normalizeDiagnosticError(error), metadata: { action: "start" } })).catch(() => undefined);
        throw error;
      }
      if (!isChildSession() && p.workflowId && !isForegroundWorkflowActive(p.workflowId)) throw new Error(`Workflow ${p.workflowId} is not active in this foreground session.`);
      if (p.action === "status") {
        if (!p.workflowId) {
          const active = await activeSessionStates();
          refreshStaleWorkflowWarnings(active, ctx);
          return { content: [{ type: "text", text: active.map(state => statusText(state)).join("\n\n") || "No workflows." }], details: active };
        }
        const s = await required(p.workflowId, cachedState);
        refreshStaleWorkflowWarnings(await activeSessionStates(), ctx);
        return { content: [{ type: "text", text: statusText(s) }], details: s };
      }
      if (p.action === "close") {
        const s = await required(p.workflowId, loadState);
        if (!["completed", "blocked", "aborted"].includes(s.stage)) throw new Error("Only terminal workflows can be closed");
        const closeMessage = await closeState(s);
        return { content: [{ type: "text", text: closeMessage }], details: s };
      }
      if (p.action === "override") {
        const current = await required(p.workflowId, loadState);
        // Actor and clock come from this foreground-only boundary, never caller input.
        const decision = { code: p.ruleCode, reason: p.reason, decision: p.decision, risk: p.risk, evidence: p.evidence, actor: "foreground-orchestrator" as const, at: new Date().toISOString() };
        if (!applyPolicyDecision(structuredClone(current), decision as any).accepted) {
          diagnose(current.id, "rejected_action", { stage: current.stage, outcome: "failure", metadata: { action: "override", ruleCode: p.ruleCode } });
          throw new Error("Policy override was rejected by the closed state policy");
        }
        const { state: accepted } = await transactState(current.id, s => { const result = applyPolicyDecision(s, decision as any); if (!result.accepted) throw new Error("Policy override was rejected by the closed state policy"); });
        stateCache.set(accepted); trackWorkflowId(accepted.id); diagnose(accepted.id, "policy_override", { stage: accepted.stage, metadata: { ruleCode: p.ruleCode } });
        await updateRecordAfterCommit(accepted);
        return { content: [{ type: "text", text: statusText(accepted) }], details: accepted };
      }
      const routeDigest = p.action === "routeReview" ? reviewPayloadDigest(p as Record<string, unknown>) : undefined;
      const routeKey = routeDigest ? routeReviewKey(p as Record<string, unknown>, routeDigest) : undefined;
      // This lock spans reload, authorization, mutation, and persistence. A child that
      // waits behind a foreground terminal transition reloads that terminal state rather
      // than saving a stale non-terminal snapshot over it.
      let mutation: any;
      try { mutation = await transactState(p.workflowId!, async s => {
        const previousStage = s.stage;
        // A Reviewer retry can arrive after its first call moved reviewing -> fixing.
        // Check the committed key/digest while holding the transaction lock before
        // current-stage authorization; same payload is a no-op, different payload fails.
        if (p.action === "routeReview" && routeKey) {
          const existing = s.review.idempotency?.[routeKey];
          if (existing) {
            if (existing.payloadDigest !== routeDigest) throw new Error("routeReview idempotencyKey conflicts with the committed payload");
            return NO_STATE_WRITE as any;
          }
        }
        const childStateError = childWorkflowAccessError(p, s);
        if (childStateError) throw new Error(childStateError);
      if (p.action === "advance") {
        if (!p.stage) throw new Error("advance requires stage");
        if (s.stage === "red_testing" && p.stage === "implementing") requireEvidence(s, "targeted_red");
        if ((s.stage === "implementing" || s.stage === "fixing") && p.stage === "reviewing" && s.stageSequence.includes("red_testing")) requireEvidence(s, "full_green", s.stage === "fixing" ? s.review.fullGreenEvidenceFloor ?? 0 : 0);
        if (s.stage === "fixing" && p.stage === "reporting") {
          const postCap = s.review.postCapFix;
          if (!postCap) throw new Error("Only a persisted targeted_post_cap_fix resolution may advance fixing directly to reporting");
          requireEvidence(s, "full_green", postCap.fullGreenEvidenceFloor);
          // Critical findings remain findings; a narrow post-cap route is never approval.
          s.review.approved = false;
        }
        transition(s, p.stage as Stage, p.note);
        if (p.stage === "reviewing") satisfyOutcome(s, "implementation");
        if (p.stage === "reporting" && previousStage === "fixing" && s.review.postCapFix) satisfyOutcome(s, "review");
      }
      else if (p.action === "record") {
        if (p.plan !== undefined) s.plan = p.plan; if (p.implementationSummary !== undefined) { s.implementationSummary = p.implementationSummary; satisfyOutcome(s, "implementation"); }
        if (p.agentId && p.files) s.filesOwned[p.agentId] = [...new Set([...(s.filesOwned[p.agentId] ?? []), ...p.files.map(f => path.resolve(s.repositoryRoot, f))])];
        if (p.testCommand) {
          if (!p.evidenceKind && s.stageSequence.includes("red_testing")) throw new Error("test evidence requires evidenceKind");
          s.tests.push({ command: p.testCommand, passed: p.testPassed ?? false, output: p.testOutput, kind: p.evidenceKind, expectedFailureReason: p.expectedFailureReason, at: new Date().toISOString() });
          if (p.evidenceKind === "targeted_red" && p.testPassed === false && p.expectedFailureReason?.trim()) satisfyOutcome(s, "red_testing");
        }
      } else if (p.action === "routeReview") {
        const findings = p.findings ? p.findings as ReviewFinding[] : p.reviewOutput ? parseReviewerOutput(p.reviewOutput) : undefined;
        if (!findings) throw new Error("routeReview requires findings or reviewOutput");
        if (s.stageSequence.includes("red_testing")) {
          if (!p.suspectedWeakness?.trim()) throw new Error("Reviewer task/result requires a named suspectedWeakness");
          if (!p.testCommand?.trim() || p.testPassed !== true || !p.testOutput?.trim()) throw new Error("Reviewer must independently record a passing full project gate first");
          s.tests.push({ command: p.testCommand, testCommand: p.testCommand, passed: true, output: p.testOutput, kind: "review_gate", evidenceKind: "review_gate", evidenceId: routeKey!, at: new Date().toISOString() });
          s.review.suspectedWeakness = p.suspectedWeakness.trim();
          if (findings.some(f => f.category !== "approved" && !f.detail?.trim())) throw new Error("Reviewer findings must cite verification detail");
        }
        s.review.findings = findings;
        s.review.idempotencyKeys = [...new Set([...(s.review.idempotencyKeys ?? []), routeKey!])];
        s.review.idempotency = { ...(s.review.idempotency ?? {}), [routeKey!]: { payloadDigest: routeDigest!, resultRef: `review-${s.review.cycleCount + 1}-${routeDigest!.slice(0, 12)}` } };
        const requiredFindings = s.review.findings.filter(f => f.category === "must_fix" || f.category === "quick_fix"); s.followUps.push(...s.review.findings.filter(f => f.category === "follow_up"));
        s.review.approved = s.review.findings.some(f => f.category === "approved") && requiredFindings.length === 0;
        // Phase 1C: Clear reviewer file ownership when transitioning to fixing.
        // The implementer will be doing the fixes, so clear any stale reviewer claims.
        s.review.cycleCount++;
        if (requiredFindings.length) {
          const maxCycles = s.review.maxReviewCycles ?? DEFAULT_MAX_REVIEW_CYCLES;
          if (s.review.cycleCount >= maxCycles) {
            // A cap is always recoverable, including compatibility/unkeyed callers.
            // It never blocks, silently defers, or approves a required finding.
            recordReviewCapEscalation(s, { actor: "foreground-orchestrator", at: new Date().toISOString(), unresolvedFindingIds: requiredFindings.map((_, index) => `${routeKey}-finding-${index + 1}`), unresolvedEvidenceIds: [routeKey!] });
          } else {
            // A review bounce establishes an evidence floor: fixes must add a new
            // passing full_green record rather than reusing the pre-review gate.
            s.review.fullGreenEvidenceFloor = s.tests.length;
            transition(s, "fixing", "Required findings return to the stable logical Implementer role");
            delete s.filesOwned["reviewer"]; 
          }
        }
        else {
          transition(s, "reporting", s.review.approved ? "Reviewer approved" : "No blocking findings");
          delete s.filesOwned["reviewer"];
          satisfyOutcome(s, "review");
        }
      } else if (p.action === "report") {
        if (!p.reporterContent?.trim()) throw new Error("report requires exact reporterContent");
        const gaps = reporterContentGaps(s, p.reporterContent);
        if (gaps.length) throw new Error(`Reporter content must materially state durable ${gaps.join(", ")}`);
        if (s.review.needsMoreReview && !/could use more review passes/i.test(p.reporterContent)) throw new Error("Reporter content must state that the work could use more review passes");
        s.reporterResult = p.reporterContent.trim();
        satisfyOutcome(s, "report");
      } else if (p.action === "replaceAttempt") {
        if (!p.role || !p.replacementAttemptId || !p.failure) throw new Error("replaceAttempt requires role, replacementAttemptId, and failure");
        const current = s.logicalRoles[p.role] ?? { authority: [], claims: [], attemptId: s.agentHandles[p.role] ?? p.role };
        s.logicalRoles[p.role] = current;
        const normalizedReason = /transport/i.test(p.failure.reason) ? "transport" : /process/i.test(p.failure.reason) ? "process" : /stale/i.test(p.failure.reason) ? "stale_context" : /compaction/i.test(p.failure.reason) ? "compaction" : undefined;
        if (!normalizedReason) throw new Error("replaceAttempt failure reason must be a closed infrastructure reason");
        const usage = p.failure.usage ?? { input: 0, output: 0 };
        const replacement: RoleAttemptReplacement = { role: p.role, priorAttemptId: current.attemptId, newAttemptId: p.replacementAttemptId, reason: normalizedReason, actor: "foreground-orchestrator", at: new Date().toISOString(), durationMs: p.failure.durationMs ?? 0, usage: { inputTokens: usage.input, outputTokens: usage.output }, evidence: [p.failure.reason], ...(p.failure.exitCode === undefined ? {} : { exitStatus: p.failure.exitCode }) };
        replaceRoleAttempt(s, replacement);
        s.attempts.push({ role: p.role, attemptId: p.replacementAttemptId, reason: p.failure.reason, ...(p.failure.exitCode === undefined ? {} : { exitCode: p.failure.exitCode }), durationMs: p.failure.durationMs ?? 0, usage });
      } else if (p.action === "resolveEscalation") {
        if (!p.escalationChoice) throw new Error("resolveEscalation requires escalationChoice");
        resolveReviewCap(s, { choice: p.escalationChoice as ReviewCapResolution, actor: "foreground-orchestrator", justification: p.justification });
      } else if (p.action === "complete") {
        if (s.stageSequence.includes("red_testing") && !s.reporterResult) throw new Error("Reporter exact content must be recorded before completion");
        s.finalOutcome = p.outcome ?? "Completed"; transition(s, "completed", s.finalOutcome);
      }
      else if (p.action === "block") { s.blockingReason = p.reason ?? "Blocked"; transition(s, "blocked", s.blockingReason); }
      else if (p.action === "abort") { s.blockingReason = p.reason ?? "Aborted by Orchestrator"; transition(s, "aborted", s.blockingReason); }
        return previousStage;
      }); } catch (error: any) {
        if (p.workflowId) await appendDiagnostic(createDiagnosticEvent(p.workflowId, "action_rejected", { sessionId: sessionId(), runId: activeRunId, outcome: "failure", error: normalizeDiagnosticError(error), metadata: { action: p.action } })).catch(() => undefined);
        throw error;
      }
      const s = mutation.state;
      if (mutation.result === NO_STATE_WRITE) return { content: [{ type: "text", text: statusText(s) }], details: s };
      if (mutation.result !== s.stage) diagnose(s.id, "stage_transition", { stage: s.stage, metadata: { from: mutation.result, to: s.stage }, reviewCycle: s.review.cycleCount });
      if (p.action === "routeReview" && routeKey) diagnose(s.id, "review_routed", { stage: s.stage, reviewCycle: s.review.cycleCount, metadata: { idempotencyKey: routeKey } });
      if (p.action === "replaceAttempt") {
        const attempt = s.attempts.at(-1); const replacement = s.roleAttemptReplacements.at(-1);
        if (!attempt || !replacement) throw new Error("Committed replacement audit is missing");
        await appendDiagnostic(createDiagnosticEvent(s.id, "role_attempt_replaced", {
          sessionId: sessionId(), runId: activeRunId, stage: s.stage, role: attempt.role, durationMs: attempt.durationMs, reviewCycle: s.review.cycleCount,
          usage: attempt.usage, outcome: "success", metadata: { attemptId: attempt.attemptId, reason: replacement.reason, exitStatus: replacement.exitStatus, actor: replacement.actor, evidenceAuthor: replacement.actor, evidence: replacement.evidence },
        }));
      }
      if (p.action === "record" && p.testCommand) diagnose(s.id, "test_result", { stage: s.stage, testPassed: p.testPassed ?? false, metadata: { commandBytes: Buffer.byteLength(p.testCommand, "utf8"), outputBytes: Buffer.byteLength(p.testOutput ?? "", "utf8") } });
      // The transaction has durably committed. Notify before external SoR I/O so a
      // reporter failure cannot hide an already-persisted terminal transition.
      notifyTerminalTransition(mutation.result, s, ctx);
      trackWorkflowId(s.id);
      stateCache.set(s);
      await updateRecordAfterCommit(s);
      return { content: [{ type: "text", text: statusText(s) }], details: s };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("accent", `${args.action} ${args.workflowId ?? ""}`), 0, 0); },
    renderResult(result, _options, theme) { const s = result.details as WorkflowState | undefined; return new Text(theme.fg("success", s?.id ? `${s.id} · ${s.stage}` : "workflow updated"), 0, 0); }
  });
  pi.registerCommand("workflow-enable", { description: "enable development workflow mode for this live thread", handler: async (_args, ctx) => { setThreadMode(true, ctx); ctx.ui.notify("Development workflow enabled", "info"); } });
  pi.registerCommand("workflow-disable", { description: "disable development workflow mode for this live thread", handler: async (_args, ctx) => { foregroundActivated = false; pendingForegroundActivation = false; preflightForegroundActivation = false; setThreadMode(false, ctx); ctx.ui.notify("Development workflow disabled", "info"); } });
  pi.registerCommand("workflow-diagnostics", { description: "summarize development workflow diagnostics", handler: async (args, ctx) => {
    const id = args.trim() || currentId;
    if (!id) { if (ctx.hasUI) ctx.ui.notify("No active workflow", "warning"); return; }
    try { if (ctx.hasUI) ctx.ui.notify(renderDiagnosticSummary(await summarizeDiagnostics(id)), "info"); }
    catch (error: any) { if (ctx.hasUI) ctx.ui.notify(`Unable to read workflow diagnostics: ${error.message}`, "error"); }
  } });
  for (const [name, action] of [["workflow-status", "status"], ["workflow-abort", "abort"]] as const) pi.registerCommand(name, { description: `${action} development workflow`, handler: async (args, ctx) => {
    const id = args.trim() || currentId;
    if (!id) { if (ctx.hasUI) ctx.ui.notify("No active workflow", "warning"); return; }
    if (!isForegroundWorkflowActive(id)) { if (ctx.hasUI) ctx.ui.notify(`Workflow ${id} is not active in this foreground session.`, "error"); return; }
    if (action === "status") { const s = await cachedState(id); refreshStaleWorkflowWarnings(await activeSessionStates(), ctx); if (ctx.hasUI) ctx.ui.notify(s ? statusText(s) : `Unknown workflow ${id}`, s ? "info" : "error"); }
    else {
      try {
        const { state: s, result: previousStage } = await transactState(id, async current => {
          const previous = current.stage;
          if (current.stage !== "completed" && current.stage !== "aborted") {
            current.blockingReason = "Aborted by command";
            transition(current, "aborted", current.blockingReason);
          }
          return previous;
        });
        stateCache.set(s);
        notifyTerminalTransition(previousStage, s, ctx);
      } catch (error: any) {
        if (ctx.hasUI) ctx.ui.notify(error.message, "error");
      }
    }
  } });
}
