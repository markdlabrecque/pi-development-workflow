import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_STRING_BYTES = 2 * 1024;
export const MAX_DIAGNOSTIC_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_DIAGNOSTIC_FILES = 3;
export const FAILED_DIAGNOSTIC_RETENTION_MS = 24 * 60 * 60 * 1000;

export type DiagnosticOutcome = "success" | "failure" | "cancelled";
export interface DiagnosticEvent {
  version: typeof DIAGNOSTIC_SCHEMA_VERSION;
  workflowId: string;
  sessionId?: string;
  runId?: string;
  correlationId: string;
  timestamp: string;
  type: string;
  stage?: string;
  role?: string;
  durationMs?: number;
  model?: string;
  thinking?: string;
  maxTokens?: number;
  outcome?: DiagnosticOutcome;
  reviewCycle?: number;
  testPassed?: boolean;
  usage?: { input?: number; output?: number; cost?: number; turns?: number };
  planPath?: string;
  planDigest?: string;
  taskBytes?: number;
  error?: { name: string; code?: string; message: string };
  metadata?: Record<string, unknown>;
}

const ROOT = path.join(getAgentDir(), "runtime", "development-workflow", "diagnostics");
const queues = new Map<string, Promise<void>>();
const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|password|secret|token|credential)/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._~+\/-]+|\bsk-[a-z0-9_-]{8,}|\b(?:gh[oprsu]|glpat)-[a-z0-9_-]{8,})/gi;

function safeWorkflowId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe === id ? safe : `${safe}-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}
export function diagnosticsDir(workflowId: string): string { return path.join(ROOT, safeWorkflowId(workflowId)); }
export function diagnosticsPath(workflowId: string): string { return path.join(diagnosticsDir(workflowId), "events.jsonl"); }

function truncate(value: string): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= MAX_DIAGNOSTIC_STRING_BYTES) return value;
  return `${buffer.subarray(0, MAX_DIAGNOSTIC_STRING_BYTES).toString("utf8")}…[truncated]`;
}
export function sanitizeDiagnosticValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return truncate(value.replace(SECRET_VALUE, "[REDACTED]"));
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeDiagnosticValue(item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) result[childKey] = sanitizeDiagnosticValue(child, childKey);
    return result;
  }
  return value;
}
export function normalizeDiagnosticError(error: unknown): DiagnosticEvent["error"] {
  const source = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; message?: unknown } : {};
  return sanitizeDiagnosticValue({
    name: typeof source.name === "string" ? source.name : "Error",
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    message: typeof source.message === "string" ? source.message : String(error),
  }) as DiagnosticEvent["error"];
}

function enqueue(file: string, operation: () => Promise<void>): Promise<void> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(file, next);
  return next.finally(() => { if (queues.get(file) === next) queues.delete(file); });
}
async function rotate(file: string): Promise<void> {
  let size = 0;
  try { size = (await fs.promises.stat(file)).size; } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  if (size < MAX_DIAGNOSTIC_FILE_BYTES) return;
  await fs.promises.rm(`${file}.${MAX_DIAGNOSTIC_FILES - 1}`, { force: true });
  for (let index = MAX_DIAGNOSTIC_FILES - 2; index >= 1; index--) {
    try { await fs.promises.rename(`${file}.${index}`, `${file}.${index + 1}`); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
  try { await fs.promises.rename(file, `${file}.1`); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
}

/** Append one bounded JSONL event. Callers may treat failures as non-fatal. */
export async function appendDiagnostic(event: DiagnosticEvent): Promise<void> {
  const file = diagnosticsPath(event.workflowId);
  const sanitized = sanitizeDiagnosticValue(event) as DiagnosticEvent;
  const line = `${JSON.stringify(sanitized)}\n`;
  await enqueue(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await rotate(file);
    await fs.promises.appendFile(file, line, { encoding: "utf8", mode: 0o600, flag: "a" });
  });
}

export function createDiagnosticEvent(workflowId: string, type: string, fields: Partial<Omit<DiagnosticEvent, "version" | "workflowId" | "type" | "timestamp" | "correlationId">> & { correlationId?: string } = {}): DiagnosticEvent {
  return {
    version: DIAGNOSTIC_SCHEMA_VERSION,
    workflowId,
    timestamp: new Date().toISOString(),
    type,
    correlationId: fields.correlationId ?? crypto.randomUUID(),
    ...fields,
  };
}

export async function readDiagnosticEvents(workflowId: string): Promise<DiagnosticEvent[]> {
  const files = [2, 1].map(index => `${diagnosticsPath(workflowId)}.${index}`).concat(diagnosticsPath(workflowId));
  const events: DiagnosticEvent[] = [];
  for (const file of files) {
    let content: string;
    try { content = await fs.promises.readFile(file, "utf8"); } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try { const event = JSON.parse(line); if (event?.version === DIAGNOSTIC_SCHEMA_VERSION && typeof event.type === "string") events.push(event); } catch { /* Ignore a partial trailing line after process termination. */ }
    }
  }
  return events;
}

export interface DiagnosticSummary {
  workflowId: string;
  eventCount: number;
  wallClockMs: number;
  stages: Record<string, number>;
  roles: Record<string, { dispatches: number; failures: number; cancellations: number; durationMs: number }>;
  reviewCycles: number;
  tests: { passed: number; failed: number };
  compactions: number;
  usage: { input: number; output: number; cost: number; turns: number };
  rawLogPath: string;
}

export function calculateDiagnosticSummary(workflowId: string, events: DiagnosticEvent[]): DiagnosticSummary {
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const first = ordered[0] ? Date.parse(ordered[0].timestamp) : 0;
  const last = ordered.at(-1) ? Date.parse(ordered.at(-1)!.timestamp) : first;
  const stages: Record<string, number> = {};
  const stageStarts = new Map<string, number>();
  const roles: DiagnosticSummary["roles"] = {};
  let reviewCycles = 0, compactions = 0, passed = 0, failed = 0, currentStage: string | undefined;
  const usage = { input: 0, output: 0, cost: 0, turns: 0 };
  for (const event of ordered) {
    const at = Date.parse(event.timestamp);
    if (event.type === "workflow_start" && event.stage && Number.isFinite(at)) { stageStarts.set(event.stage, at); currentStage = event.stage; }
    if (event.type === "stage_transition" && event.stage && Number.isFinite(at)) {
      const from = typeof event.metadata?.from === "string" ? event.metadata.from : undefined;
      if (from) {
        const started = stageStarts.get(from);
        if (started !== undefined) stages[from] = (stages[from] ?? 0) + Math.max(0, at - started);
      }
      stageStarts.set(event.stage, at); currentStage = event.stage;
    }
    if (event.type === "role_dispatch_end" && event.role) {
      const role = roles[event.role] ??= { dispatches: 0, failures: 0, cancellations: 0, durationMs: 0 };
      role.dispatches++;
      role.durationMs += event.durationMs ?? 0;
      if (event.outcome === "failure") role.failures++;
      if (event.outcome === "cancelled") role.cancellations++;
    }
    if (event.reviewCycle !== undefined) reviewCycles = Math.max(reviewCycles, event.reviewCycle);
    if (event.type === "test_result") event.testPassed ? passed++ : failed++;
    if (event.type === "compaction_end") compactions++;
    if (event.usage) {
      usage.input += event.usage.input ?? 0; usage.output += event.usage.output ?? 0;
      usage.cost += event.usage.cost ?? 0; usage.turns += event.usage.turns ?? 0;
    }
  }
  if (currentStage && Number.isFinite(last)) {
    const started = stageStarts.get(currentStage);
    if (started !== undefined) stages[currentStage] = (stages[currentStage] ?? 0) + Math.max(0, last - started);
  }
  return { workflowId, eventCount: events.length, wallClockMs: Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : 0, stages, roles, reviewCycles, tests: { passed, failed }, compactions, usage, rawLogPath: diagnosticsPath(workflowId) };
}

export async function summarizeDiagnostics(workflowId: string): Promise<DiagnosticSummary> {
  return calculateDiagnosticSummary(workflowId, await readDiagnosticEvents(workflowId));
}

export function renderDiagnosticSummary(summary: DiagnosticSummary): string {
  const stages = Object.entries(summary.stages).map(([name, ms]) => `${name}=${ms}ms`).join(", ") || "none";
  const roles = Object.entries(summary.roles).map(([name, value]) => `${name}: ${value.dispatches} dispatches, ${value.durationMs}ms, ${value.failures} failed, ${value.cancellations} cancelled`).join("\n") || "none";
  return `Diagnostics for ${summary.workflowId}\nWall clock: ${summary.wallClockMs}ms\nStages: ${stages}\nRoles:\n${roles}\nReview cycles: ${summary.reviewCycles}\nTests: ${summary.tests.passed} passed, ${summary.tests.failed} failed\nCompactions: ${summary.compactions}\nUsage: ${summary.usage.input} input, ${summary.usage.output} output, ${summary.usage.turns} turns, cost ${summary.usage.cost}\nRaw JSONL: ${summary.rawLogPath}`;
}

export async function compactSuccessfulDiagnostics(workflowId: string, summary: unknown): Promise<void> {
  const dir = diagnosticsDir(workflowId);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, "summary.json");
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(sanitizeDiagnosticValue(summary), null, 2), { mode: 0o600 });
  await fs.promises.rename(temp, target);
  await Promise.all([diagnosticsPath(workflowId), `${diagnosticsPath(workflowId)}.1`, `${diagnosticsPath(workflowId)}.2`].map(file => fs.promises.rm(file, { force: true })));
}

/** Remove only failed/aborted diagnostic directories older than the 24-hour policy. */
export async function pruneExpiredDiagnostics(now = Date.now()): Promise<void> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(ROOT, { withFileTypes: true }); } catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
  await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const dir = path.join(ROOT, entry.name);
    if (await fs.promises.stat(path.join(dir, "summary.json")).then(() => true, () => false)) return;
    const stat = await fs.promises.stat(dir);
    if (now - stat.mtimeMs >= FAILED_DIAGNOSTIC_RETENTION_MS) await fs.promises.rm(dir, { recursive: true, force: true });
  }));
}
