import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const globalNodeModules = (await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const jiti = require(path.join(piRoot, "node_modules", "jiti"))(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js") } });
const state = await jiti.import("./workflow-state.ts");
const [id, next] = process.argv.slice(2);
await state.transactState(id, current => state.transition(current, next, "cross-process update"));
