import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const [workflowId, action = "advance"] = process.argv.slice(2);
const globalNodeModules = (await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const require = createRequire(path.join(piRoot, "package.json"));
const jiti = require("jiti")(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-ai": path.join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"),
  "@earendil-works/pi-tui": path.join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"), typebox: require.resolve("typebox"),
} });
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const loaded = await jiti.import(extensionPath, { default: true });
const extension = loaded.default ?? loaded;
const handlers = new Map(), tools = new Map();
const pi = { events: { emit() {}, on() {} }, on(name, handler) { const all = handlers.get(name) ?? []; all.push(handler); handlers.set(name, all); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, getActiveTools() { return ["development_workflow"]; }, setActiveTools() {} };
const ctx = { cwd: process.cwd(), hasUI: false, modelRegistry: { find: () => ({}) }, isProjectTrusted: () => false, ui: { setStatus() {}, notify() {} } };
extension(pi);
const input = action === "advance" ? { action, workflowId, stage: "implementing" } : { action, workflowId, agentId: "planner", plan: "from child" };
let hook;
for (const handler of handlers.get("tool_call") ?? []) hook = await handler({ toolName: "development_workflow", input }, ctx);
if (hook?.block) throw new Error(hook.reason);
const result = await tools.get("development_workflow").execute("fixture", input, undefined, undefined, ctx);
process.stdout.write(JSON.stringify({ stage: result.details.stage }));
