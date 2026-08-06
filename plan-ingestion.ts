import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Approved plans are deliberately bounded before they can enter state or model context. */
export const MAX_PLAN_BYTES = 256 * 1024;

export interface IngestedPlan {
  path: string;
  content: string;
  digest: string;
  ingestedAt: string;
  bytes: number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve symlinks, enforce repository ownership, and read the approved plan exactly once. */
export async function ingestPlan(repositoryRoot: string, planPath: string): Promise<IngestedPlan> {
  if (!planPath.trim()) throw new Error("start requires a non-empty planPath");
  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    canonicalRoot = await fs.promises.realpath(repositoryRoot);
    canonicalPath = await fs.promises.realpath(path.resolve(canonicalRoot, planPath));
  } catch (error: any) {
    throw new Error(`Unable to resolve planPath ${JSON.stringify(planPath)}: ${error.message}`);
  }
  if (!isInside(canonicalRoot, canonicalPath)) {
    throw new Error(`planPath must resolve inside the repository root (${canonicalRoot}); external plans are not supported`);
  }

  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(canonicalPath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("path is not a regular file");
    if (stat.size > MAX_PLAN_BYTES) throw new Error(`file is ${stat.size} bytes; maximum approved plan size is ${MAX_PLAN_BYTES} bytes`);
    const buffer = await handle.readFile();
    if (buffer.byteLength > MAX_PLAN_BYTES) throw new Error(`file exceeded the ${MAX_PLAN_BYTES}-byte limit while reading`);
    const content = buffer.toString("utf8");
    return {
      path: canonicalPath,
      content,
      digest: crypto.createHash("sha256").update(buffer).digest("hex"),
      ingestedAt: new Date().toISOString(),
      bytes: buffer.byteLength,
    };
  } catch (error: any) {
    throw new Error(`Unable to ingest planPath ${canonicalPath}: ${error.message}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
