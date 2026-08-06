import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The registered subagent tool re-executes this script (piInvocation uses argv[1]).
// Capture the environment before loading extensions in that child process.
if (process.argv.includes("--mode")) {
  await writeFile(process.env.WORKFLOW_ENV_CAPTURE, JSON.stringify({
    subagentId: process.env.PI_SUBAGENT_ID,
    workflowId: process.env.PI_WORKFLOW_ID,
    role: process.env.PI_WORKFLOW_ROLE,
    child: process.env.PI_SUBAGENT_CHILD,
  }));
  process.exit(0);
}

delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_ID;
delete process.env.PI_WORKFLOW_ID;
delete process.env.PI_WORKFLOW_ROLE;
const [cwd, workflowId] = process.argv.slice(2);
await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
await writeFile(path.join(cwd, ".pi", "agents", "implementer.md"), "---\nname: implementer\ndescription: test implementer\n---\nimplementer");
const globalNodeModules = (await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const require = createRequire(path.join(piRoot, "package.json"));
const jiti = require("jiti")(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-ai": path.join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"),
  "@earendil-works/pi-tui": path.join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"), typebox: require.resolve("typebox"),
} });
const extensionPath = fileURLToPath(new URL("../subagent/index.ts", import.meta.url));
const loaded = await jiti.import(extensionPath, { default: true });
const extension = loaded.default ?? loaded;
const tools = new Map();
const pi = {
  events: { on() {} }, on() {}, registerTool(tool) { tools.set(tool.name, tool); },
  getThinkingLevel() { return "low"; },
};
const ctx = { cwd, hasUI: false, modelRegistry: { find: () => undefined }, ui: { setWidget() {} } };
extension(pi);
await tools.get("subagent").execute("spawn-test", {
  action: "run", lifecycle: "workflow", workflowId, agentId: "implementer", agent: "implementer", task: "capture environment", agentScope: "project",
}, undefined, () => {}, ctx);
