import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { SystemOfRecordType, WorkflowState } from "./workflow-state.ts";
import { diagnosticsPath, renderDiagnosticSummary, summarizeDiagnostics, type DiagnosticSummary } from "./diagnostics.ts";

type RemoteSystem = Exclude<SystemOfRecordType, "file">;
interface Config { systemOfRecord?: { type?: string; repository?: string } }
export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<string>;

async function exec(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
    child.stdout.on("data", data => out += data); child.stderr.on("data", data => err += data);
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(`${command} exited ${code}: ${err.trim()}`)));
  });
}
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const bitbucketRepositoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
function validRepository(type: RemoteSystem, repository: string | undefined): repository is string { return Boolean(repository && (type === "bitbucket" ? bitbucketRepositoryPattern : repositoryPattern).test(repository)); }
function configuredSystem(config: Config): WorkflowState["systemOfRecord"] | undefined {
  const type = config.systemOfRecord?.type;
  const repository = config.systemOfRecord?.repository;
  if ((type === "github" || type === "gitlab" || type === "bitbucket") && validRepository(type, repository)) return { type, repository, approved: true };
  return undefined;
}

/** Parse only canonical Bitbucket Cloud origin URLs; credentials are never retained. */
export function bitbucketRepositoryFromRemote(remote: string): string | undefined {
  const match = remote.trim().match(/(?:^|[@/:])bitbucket\.org[/:]([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/i);
  const repository = match ? `${match[1]}/${match[2]}` : undefined;
  return validRepository("bitbucket", repository) ? repository : undefined;
}
/** Parse GitLab HTTPS/SSH remotes, retaining nested group paths but no credentials. */
export function gitlabRepositoryFromRemote(remote: string): string | undefined {
  const match = remote.trim().match(/(?:^|[@/:])gitlab\.com[/:]((?:[A-Za-z0-9][A-Za-z0-9._-]*\/)+[A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/i);
  const repository = match?.[1];
  return validRepository("gitlab", repository) ? repository : undefined;
}
async function originRepository(run: CommandRunner, cwd: string, type: "gitlab" | "bitbucket"): Promise<string | undefined> {
  try { const remote = await run("git", ["remote", "get-url", "origin"], cwd); return type === "gitlab" ? gitlabRepositoryFromRemote(remote) : bitbucketRepositoryFromRemote(remote); }
  catch { return undefined; }
}

export function createSystemOfRecord(run: CommandRunner = exec) {
  const resolve = async (cwd: string, trusted: boolean, approveDetected: boolean): Promise<WorkflowState["systemOfRecord"]> => {
    const configPath = path.join(cwd, CONFIG_DIR_NAME, "development-workflow.json");
    if (trusted) {
      try {
        const configured = configuredSystem(JSON.parse(await fs.promises.readFile(configPath, "utf8")) as Config);
        if (configured) return configured;
      } catch (error: any) { if (error?.code !== "ENOENT") throw new Error(`Invalid trusted workflow config: ${error.message}`); }
    }
    if (trusted && approveDetected) {
      try { const repository = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd); if (validRepository("github", repository)) return { type: "github", repository, approved: true }; } catch { /* try other explicitly approved detections */ }
      const gitlab = await originRepository(run, cwd, "gitlab"); if (gitlab) return { type: "gitlab", repository: gitlab, approved: true };
      const bitbucket = await originRepository(run, cwd, "bitbucket"); if (bitbucket) return { type: "bitbucket", repository: bitbucket, approved: true };
    }
    return { type: "file" };
  };

  const ensureRemote = (state: WorkflowState, type: RemoteSystem): string => {
    if (state.systemOfRecord.type !== type || !state.systemOfRecord.approved || !validRepository(type, state.systemOfRecord.repository)) throw new Error(`${type === "github" ? "GitHub" : type === "gitlab" ? "GitLab" : "Bitbucket"} writes require explicit trusted configuration or approval`);
    return state.systemOfRecord.repository;
  };
  const gitHub = async (state: WorkflowState): Promise<void> => {
    const repository = ensureRemote(state, "github"); const title = `[development-workflow] ${state.id}`; const body = state.reporterResult ?? renderWorkplan(state, await diagnosticSummary(state.id));
    let existing: string;
    try {
      existing = await run("gh", ["issue", "list", "--repo", repository, "--state", "all", "--search", `\"${title}\" in:title`, "--json", "number,title", "--jq", `.[] | select(.title == ${JSON.stringify(title)}) | .number`], state.repositoryRoot);
    } catch (error: any) {
      // An indeterminate lookup could conceal an existing issue. Do not create a duplicate.
      throw new Error(`Unable to look up GitHub workflow issue: ${error.message}`);
    }
    const number = existing.trim();
    if (number && !/^[1-9]\d*$/.test(number)) throw new Error("Unable to look up GitHub workflow issue: response was not a numeric issue number");
    if (number) await run("gh", ["issue", "comment", number, "--repo", repository, "--body", body], state.repositoryRoot);
    else await run("gh", ["issue", "create", "--repo", repository, "--title", title, "--body", body], state.repositoryRoot);
  };
  const gitLab = async (state: WorkflowState): Promise<void> => {
    const repository = ensureRemote(state, "gitlab"); const title = `[development-workflow] ${state.id}`; const body = state.reporterResult ?? renderWorkplan(state, await diagnosticSummary(state.id));
    // glab uses its existing authenticated CLI session; no token is read into workflow state.
    let output: string;
    try {
      output = await run("glab", ["issue", "list", "--repo", repository, "--all", "--search", title, "--output", "json"], state.repositoryRoot);
    } catch (error: any) {
      throw new Error(`Unable to look up GitLab workflow issue: ${error.message}`);
    }
    let issues: Array<{ iid?: number; title?: string }>;
    try {
      const parsed: unknown = JSON.parse(output);
      if (!Array.isArray(parsed)) throw new Error("response was not an issue array");
      issues = parsed as Array<{ iid?: number; title?: string }>;
    } catch (error: any) {
      // A failed or malformed lookup is ambiguous: creating now could duplicate a
      // remote issue, so let the reporter fail and retain the local workflow state.
      throw new Error(`Unable to look up GitLab workflow issue: ${error.message}`);
    }
    const iid = issues.find(issue => issue.title === title)?.iid?.toString();
    if (iid) await run("glab", ["issue", "note", iid, "--repo", repository, "--message", body], state.repositoryRoot);
    else await run("glab", ["issue", "create", "--repo", repository, "--title", title, "--description", body, "--yes"], state.repositoryRoot);
  };
  const bitbucket = async (state: WorkflowState): Promise<void> => {
    const repository = ensureRemote(state, "bitbucket");
    // Do not allow an approved config to write to a different checkout's remote.
    if (await originRepository(run, state.repositoryRoot, "bitbucket") !== repository) throw new Error("Bitbucket writes require origin to match the approved repository");
    const title = `[development-workflow] ${state.id}`; const body = state.reporterResult ?? renderWorkplan(state, await diagnosticSummary(state.id));
    const base = `https://api.bitbucket.org/2.0/repositories/${repository}/issues`;
    const query = `${base}?q=${encodeURIComponent(`title="${title}"`)}`;
    // --netrc delegates authentication to curl's existing credential store; secrets never enter state or argv.
    let listed: string;
    try {
      listed = await run("curl", ["--fail-with-body", "--silent", "--show-error", "--netrc", query], state.repositoryRoot);
    } catch (error: any) {
      throw new Error(`Unable to look up Bitbucket workflow issue: ${error.message}`);
    }
    let payload: { values?: Array<{ id?: number; title?: string }> };
    try {
      const parsed: unknown = JSON.parse(listed);
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { values?: unknown }).values)) throw new Error("response was not an issue collection");
      payload = parsed as { values: Array<{ id?: number; title?: string }> };
    } catch (error: any) {
      // As with GitLab, do not turn an indeterminate lookup into a duplicate issue.
      throw new Error(`Unable to look up Bitbucket workflow issue: ${error.message}`);
    }
    const id = payload.values?.find(issue => issue.title === title)?.id?.toString();
    if (id) await run("curl", ["--fail-with-body", "--silent", "--show-error", "--netrc", "--request", "POST", "--header", "Content-Type: application/json", "--data", JSON.stringify({ content: { raw: body } }), `${base}/${id}/comments`], state.repositoryRoot);
    else await run("curl", ["--fail-with-body", "--silent", "--show-error", "--netrc", "--request", "POST", "--header", "Content-Type: application/json", "--data", JSON.stringify({ title, content: { raw: body } }), base], state.repositoryRoot);
  };
  const update = async (state: WorkflowState): Promise<void> => {
    if (state.systemOfRecord.type === "file") return writeFileWorkplan(state);
    if (!["reporting", "completed", "blocked", "aborted"].includes(state.stage)) return;
    if (state.systemOfRecord.type === "github") return gitHub(state);
    if (state.systemOfRecord.type === "gitlab") return gitLab(state);
    return bitbucket(state);
  };
  return { resolve, update, gitHub, gitLab, bitbucket };
}

function section(title: string, value: string | undefined): string { return `## ${title}\n\n${value?.trim() || "_Not recorded._"}\n`; }
async function diagnosticSummary(workflowId: string): Promise<DiagnosticSummary | undefined> {
  try { const summary = await summarizeDiagnostics(workflowId); return summary.eventCount ? summary : undefined; } catch { return undefined; }
}
export function renderWorkplan(state: WorkflowState, diagnostics?: DiagnosticSummary): string {
  const criteria = state.acceptanceCriteria.length ? state.acceptanceCriteria.map(item => `- [ ] ${item}`).join("\n") : "_Not specified._";
  const files = Object.entries(state.filesOwned).flatMap(([agent, values]) => values.map(file => `- \`${path.relative(state.repositoryRoot, file)}\` (${agent})`)).join("\n") || "_None recorded._";
  const tests = state.tests.map(test => `- ${test.passed ? "✅" : "❌"} \`${test.command}\`${test.output ? ` — ${test.output.slice(0, 500)}` : ""}`).join("\n") || "_None recorded._";
  const findings = state.review.findings.map(finding => `- **${finding.category}** ${finding.title}${finding.file ? ` (\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`)` : ""}${finding.detail ? ` — ${finding.detail}` : ""}`).join("\n") || "_None recorded._";
  const follow = state.followUps.map(finding => `- ${finding.title}${finding.detail ? ` — ${finding.detail}` : ""}`).join("\n") || "_None._";
  const metrics = diagnostics ? `${renderDiagnosticSummary(diagnostics)}\n` : `Metrics unavailable (diagnostic logging is non-blocking).\nRaw JSONL: ${diagnosticsPath(state.id)}`;
  const provenance = state.planProvenance ? `Path: \`${state.planProvenance.path}\`\n\nSHA-256: \`${state.planProvenance.digest}\`\n\nIngested: ${state.planProvenance.ingestedAt}` : "_Legacy workflow; approved-plan provenance was not recorded._";
  return `# Development Workplan: ${state.id}\n\n> Current stage: **${state.stage}**  \n> Updated: ${state.updatedAt}\n\n${section("Goal and Scope", state.goal)}${section("Acceptance Criteria", criteria)}${section("Approved Plan Provenance", provenance)}${section("Implementation Plan", state.plan)}${section("Implementation Summary and Changed Files", `${state.implementationSummary ?? "_Not recorded._"}\n\n${files}`)}${section("Tests and Results", tests)}${section("Review Findings", findings)}${section("Fix Cycles", String(state.review.cycleCount))}${section("Follow-up Items", follow)}${section("Execution Metrics and Diagnostics", metrics)}${section("Final Outcome", state.finalOutcome ?? state.blockingReason)}\n`;
}
async function writeFileWorkplan(state: WorkflowState): Promise<void> {
  const safeId = state.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const finalReport = Boolean(state.reporterResult && ["reporting", "completed", "blocked"].includes(state.stage));
  const target = finalReport
    ? path.join(state.repositoryRoot, "docs", "reports", `${new Date().toISOString().slice(0, 10)}-${safeId}.md`)
    : path.join(state.repositoryRoot, CONFIG_DIR_NAME, "workplans", `${safeId}.md`);
  const diagnostics = await diagnosticSummary(state.id);
  const content = finalReport ? state.reporterResult! : renderWorkplan(state, diagnostics);
  await withFileMutationQueue(target, async () => { await fs.promises.mkdir(path.dirname(target), { recursive: true }); const temp = `${target}.${process.pid}.tmp`; await fs.promises.writeFile(temp, `${content.trim()}\n`); await fs.promises.rename(temp, target); });
}
const operations = createSystemOfRecord();
export const resolveSystemOfRecord = operations.resolve;
export const updateSystemOfRecord = operations.update;
