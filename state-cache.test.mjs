import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const globalNodeModules = (await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const jiti = require(path.join(piRoot, "node_modules", "jiti"))(import.meta.url);
const { WorkflowStateCache } = await jiti.import("./state-cache.ts");

const state = (id, goal = "original") => ({ id, goal, nested: { value: 1 } });

test("WorkflowStateCache caches reads, misses, lists, and returns clones deterministically", async () => {
  let now = 0;
  const cache = new WorkflowStateCache(250, () => now);
  let reads = 0;
  const load = async id => { reads++; return id === "missing" ? undefined : state(id, `read-${reads}`); };

  const first = await cache.get("one", load);
  first.nested.value = 99;
  assert.equal((await cache.get("one", load)).nested.value, 1);
  assert.equal(reads, 1, "fresh read is served from cache");
  assert.equal(await cache.get("missing", load), undefined);
  assert.equal(await cache.get("missing", load), undefined);
  assert.equal(reads, 2, "misses are cached too");
  now = 250;
  assert.equal((await cache.get("one", load)).goal, "read-3");
  assert.equal(reads, 3, "expired values reload from disk");

  let lists = 0;
  const list = async () => { lists++; return [state("listed", `list-${lists}`)]; };
  const listed = await cache.list(list);
  listed[0].goal = "mutated";
  assert.equal((await cache.list(list))[0].goal, "list-1");
  assert.equal(lists, 1);
  cache.set(state("written", "durable"));
  assert.equal((await cache.list(list))[0].goal, "list-2", "write invalidates cached list");
});

test("WorkflowStateCache generation guards concurrent get/list reads in either completion order", async () => {
  let now = 0;
  const cache = new WorkflowStateCache(250, () => now);
  let resolveGet;
  let resolveList;
  const pendingGet = cache.get("one", () => new Promise(done => { resolveGet = done; }));
  const pendingList = cache.list(() => new Promise(done => { resolveList = done; }));
  resolveList([state("one", "list")]);
  await pendingList;
  resolveGet(state("one", "stale-get"));
  await pendingGet;
  assert.equal((await cache.get("one", async () => state("one", "reload"))).goal, "list", "a get started before list cannot overwrite list data");

  const reverse = new WorkflowStateCache(250, () => now);
  let resolveReverseList;
  const reverseList = reverse.list(() => new Promise(done => { resolveReverseList = done; }));
  let resolveReverseGet;
  const reverseGet = reverse.get("one", () => new Promise(done => { resolveReverseGet = done; }));
  resolveReverseGet(state("one", "get"));
  await reverseGet;
  resolveReverseList([state("one", "stale-list")]);
  await reverseList;
  assert.equal((await reverse.get("one", async () => state("one", "reload"))).goal, "get", "a list started before get cannot overwrite get data");
});

test("WorkflowStateCache prevents a late concurrent list from replacing the first completed list", async () => {
  let now = 0;
  const cache = new WorkflowStateCache(250, () => now);
  let resolveFirst;
  let resolveSecond;
  const first = cache.list(() => new Promise(done => { resolveFirst = done; }));
  const second = cache.list(() => new Promise(done => { resolveSecond = done; }));
  resolveSecond([state("second", "second")]);
  await second;
  resolveFirst([state("first", "late-first")]);
  await first;
  assert.deepEqual((await cache.list(async () => [state("unexpected")])).map(value => value.id), ["second"], "late first request cannot overwrite the second request that completed first");

  const reverse = new WorkflowStateCache(250, () => now);
  let resolveReverseFirst;
  let resolveReverseSecond;
  const reverseFirst = reverse.list(() => new Promise(done => { resolveReverseFirst = done; }));
  const reverseSecond = reverse.list(() => new Promise(done => { resolveReverseSecond = done; }));
  resolveReverseFirst([state("first", "first")]);
  await reverseFirst;
  resolveReverseSecond([state("second", "late-second")]);
  await reverseSecond;
  assert.deepEqual((await reverse.list(async () => [state("unexpected")])).map(value => value.id), ["first"], "late second request cannot overwrite the first request that completed first");
});

test("WorkflowStateCache generation guards reject stale asynchronous reads after writes and reset", async () => {
  let now = 0;
  const cache = new WorkflowStateCache(250, () => now);
  let resolve;
  const stale = cache.get("one", () => new Promise(done => { resolve = done; }));
  cache.set(state("one", "committed"));
  resolve(state("one", "stale"));
  assert.equal((await stale).goal, "stale", "caller receives its own completed read");
  assert.equal((await cache.get("one", async () => state("one", "reload"))).goal, "committed", "stale read cannot replace committed value");

  let resolveAfterClear;
  const pending = cache.get("two", () => new Promise(done => { resolveAfterClear = done; }));
  cache.clear();
  resolveAfterClear(state("two", "stale"));
  await pending;
  assert.equal((await cache.get("two", async () => state("two", "reload"))).goal, "reload", "clear prevents stale read repopulation");
});
