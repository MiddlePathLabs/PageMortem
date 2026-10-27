import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

/** A fake storage.session that refuses writes past `quota` characters in all. */
function session(quota = Infinity) {
  const data = new Map();
  const size = () => [...data.values()].reduce((n, v) => n + JSON.stringify(v).length, 0);
  return {
    data,
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      return Object.fromEntries([keys].flat().filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) {
      const before = new Map(data);
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
      if (size() > quota) {
        data.clear();
        for (const [k, v] of before) data.set(k, v);
        throw new Error("QuotaExceededError");
      }
    },
    async remove(keys) {
      for (const k of [keys].flat()) data.delete(k);
    },
  };
}

const threadsLib = (storage = session(), tabs = []) =>
  load(["lib/chat.js", "lib/threads.js"], { browser: { storage: { session: storage }, tabs: { query: async () => tabs } } });

const reply = (answer, ops = []) => ({ kind: "bot", agent: false, done: true, ops: [...ops, ["set", answer]] });

test("a thread round-trips through storage, with live Sets stored as arrays", async () => {
  const lib = threadsLib();
  const origins = lib.$("new Set([\"https://a.example\"])"); // a Set from the extension's own realm
  await lib.$("storeThread")({ tabId: 7, entries: [{ kind: "user", text: "hi" }, reply("hello", [["links", origins]])] });
  origins.add("https://b.example"); // a later change mustn't reach the stored copy
  const stored = await lib.$("loadThread")(7);
  assert.equal(stored.entries[0].text, "hi");
  assert.deepEqual(stored.entries[1].ops[0], ["links", ["https://a.example"]]);
  assert.equal(await lib.$("loadThread")(8), null);
});

test("Chat state survives a snapshot and restore", () => {
  const lib = threadsLib();
  const chat = new (lib.$("Chat"))();
  Object.assign(chat, { history: [{ role: "user", content: "q", hasContext: false }, { role: "assistant", content: "a" }], lastKey: "k", lastPages: "p", sourceSequence: 3 });
  const copy = new (lib.$("Chat"))();
  copy.restore(JSON.parse(JSON.stringify(chat.snapshot())));
  assert.deepEqual([copy.history.length, copy.lastKey, copy.lastPages, copy.sourceSequence], [2, "k", "p", 3]);
  chat.history.push({ role: "user", content: "pages + q2", hasContext: true });
  assert.deepEqual([chat.snapshot().history.length, chat.snapshot().lastKey], [2, ""], "a question still being answered isn't kept");
  copy.restore(null);
  assert.deepEqual([copy.history.length, copy.lastKey], [0, ""]);
});

test("oversized threads free old page texts first, keeping citation quotes, then drop the oldest turns", () => {
  const lib = threadsLib();
  const page = "x".repeat(5000);
  const cited = reply("It is fast [[cite:s1|Very fast.]].", [["citations", [{ id: "s1", url: "u", text: `${page} Very fast. ${page}` }]]]);
  const thread = {
    entries: [
      { kind: "user", text: "q1" }, cited,
      { kind: "user", text: "q2" }, reply("a2", [["evidence", [{ text: page }]]]),
      { kind: "user", text: "q3" }, reply("a3", [["evidence", [{ text: page }]]]),
    ],
  };
  lib.$("compactThread")(thread, 9000);
  assert.deepEqual(thread.entries[1].ops[0][1][0].text, "Very fast.");
  assert.equal(thread.entries[3].ops.some((op) => op[0] === "evidence"), false);
  assert.equal(thread.entries[5].ops[0][0], "evidence", "the latest reply keeps its sources");
  lib.$("compactThread")(thread, JSON.stringify({ entries: thread.entries.slice(-2) }).length);
  assert.deepEqual(thread.entries.map((e) => e.text || e.ops.at(-1)[1]), ["q3", "a3"]);
});

test("a full store drops other tabs' conversations, least recently used first", async () => {
  const storage = session(800);
  const lib = threadsLib(storage);
  const big = (tabId, updated) => ({ tabId, updated, entries: [{ kind: "user", text: "y".repeat(200) }] });
  await lib.$("storeThread")(big(1, 10));
  await lib.$("storeThread")(big(2, 20));
  await lib.$("storeThread")(big(3, 30));
  await lib.$("storeThread")(big(4, 40));
  assert.deepEqual([...storage.data.keys()].sort(), ["thread:2", "thread:3", "thread:4"]);
});

test("prune removes conversations whose tabs are gone and nothing else", async () => {
  const storage = session();
  const lib = threadsLib(storage, [{ id: 1 }]);
  await storage.set({ "thread:1": {}, "thread:2": {}, pendingCommand: {} });
  await lib.$("pruneThreads")();
  assert.deepEqual([...storage.data.keys()].sort(), ["pendingCommand", "thread:1"]);
});
