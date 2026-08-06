import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);

function runFixture(cwd, workflowId, capture) {
  const {
    PI_SUBAGENT_CHILD, PI_SUBAGENT_ID, PI_SUBAGENT_COORD_DIR,
    PI_SUBAGENT_MAX_TOKENS, PI_WORKFLOW_ID, PI_WORKFLOW_ROLE,
    ...cleanEnv
  } = process.env;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(here, "subagent-spawn-fixture.mjs"), cwd, workflowId], {
      env: { ...cleanEnv, WORKFLOW_ENV_CAPTURE: capture },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", value => stderr += value);
    proc.on("error", reject);
    proc.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `fixture exited ${code}`)));
  });
}

test("registered workflow subagent spawn passes raw workflow identity to its child", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "workflow-subagent-spawn-"));
  const workflowId = `customer/a:b/c-${Date.now()}`;
  const capture = path.join(cwd, "spawned-environment.json");
  try {
    await runFixture(cwd, workflowId, capture);
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), {
      subagentId: `${workflowId.replace(/[^a-zA-Z0-9._-]/g, "_")}:implementer`,
      workflowId,
      role: "implementer",
      child: "1",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
