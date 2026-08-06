import { createRequire } from "node:module";
import path from "node:path";
import { writeFile, access } from "node:fs/promises";
const [workflowId, ready, release] = process.argv.slice(2);
const globalNodeModules = (await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const require = createRequire(path.join(piRoot, "package.json"));
const jiti = require("jiti")(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js") } });
const { transactState, transition } = await jiti.import("./workflow-state.ts");
await transactState(workflowId, async state => {
  await writeFile(ready, "locked");
  while (true) { try { await access(release); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  transition(state, "implementing", "child transaction");
});
