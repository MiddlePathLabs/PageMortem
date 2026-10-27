import test from "node:test";
import assert from "node:assert/strict";
import { load, scriptedModel } from "./harness.mjs";

const plain = (v) => JSON.parse(JSON.stringify(v));

/** A window of tabs with tabs.group / tabGroups.update that record what they did. */
function fakeBrowser(tabs) {
  const made = [];
  let nextGroup = 1;
  const browser = {
    runtime: { getManifest: () => ({}) },
    tabs: {
      query: async ({ windowId }) => tabs.filter((t) => t.windowId === windowId).map((t) => ({ ...t })),
      group: async ({ tabIds, createProperties }) => {
        const id = nextGroup++;
        for (const t of tabs) if (tabIds.includes(t.id)) t.groupId = id;
        made.push({ id, tabIds, windowId: createProperties.windowId });
        return id;
      },
    },
    tabGroups: {
      update: async (id, props) => Object.assign(made.find((g) => g.id === id), props),
    },
  };
  return { browser, made };
}

const window = () => [
  { id: 1, index: 0, windowId: 1, groupId: -1, pinned: true, title: "Mail", url: "https://mail.example/" },
  { id: 2, index: 1, windowId: 1, groupId: -1, title: "Flights to Lisbon", url: "https://flights.example/lis" },
  { id: 3, index: 2, windowId: 1, groupId: -1, title: "Rust book: ownership", url: "https://doc.rust-lang.org/book/ch04" },
  { id: 4, index: 3, windowId: 1, groupId: -1, title: "Lisbon hotels", url: "https://hotels.example/lisbon" },
  { id: 5, index: 4, windowId: 1, groupId: -1, title: "Rust by example", url: "https://doc.rust-lang.org/rust-by-example/" },
  { id: 6, index: 5, windowId: 1, groupId: 7, title: "Already grouped", url: "https://x.example/" },
  { id: 7, index: 6, windowId: 1, groupId: -1, title: "Weather", url: "https://weather.example/" },
];

function lib(tabs = window()) {
  const fake = fakeBrowser(tabs);
  const ctx = load(["lib/settings.js", "lib/llm.js", "lib/groups.js"], { browser: fake.browser });
  return { ctx, tabs, ...fake };
}

test("only unpinned, ungrouped tabs are offered, in tab order", async () => {
  const { ctx } = lib();
  const loose = await ctx.looseTabs(1);
  assert.deepEqual(loose.map((t) => t.id), [2, 3, 4, 5, 7]);
});

test("the model sees numbered titles and sites, and its groups map back to tabs", async () => {
  const { ctx } = lib();
  const tabs = await ctx.looseTabs(1);
  const model = scriptedModel([
    { content: '```json\n{"groups":[{"name":"Lisbon trip","color":"blue","tabs":[1,3]},{"name":"Rust","color":"orange","tabs":[2,4]}]}\n```' },
  ]);
  const groups = await ctx.suggestGroups({ tabs, llm: model });
  const prompt = model.calls[0].messages[1].content;
  assert.match(prompt, /^1\. Flights to Lisbon — flights\.example\/lis$/m);
  assert.match(prompt, /^5\. Weather/m);
  assert.deepEqual(plain(groups.map((g) => [g.name, g.color, g.tabs.map((t) => t.id)])), [
    ["Lisbon trip", "blue", [2, 4]],
    ["Rust", "orange", [3, 5]],
  ]);
});

test("bad tab numbers, repeats, one-tab groups and unknown or repeated colours are cleaned up", async () => {
  const { ctx } = lib();
  const tabs = await ctx.looseTabs(1);
  const reply = {
    groups: [
      { name: "  Travel   plans ", color: "GRAY", tabs: [1, 3, 99, 0, "x"] },
      { name: "Dupes", color: "grey", tabs: [1, 3] }, // both already used: dropped
      { name: "Solo", color: "red", tabs: [5] }, // one tab: dropped, tab 5 stays free
      { name: "Code", color: "magenta", tabs: [2, 4, 4] },
      { name: "", color: "red", tabs: [5, 2] }, // no name
    ],
  };
  const groups = ctx.cleanGroups(reply, tabs);
  assert.deepEqual(plain(groups.map((g) => [g.name, g.color, g.tabs.map((t) => t.id)])), [
    ["Travel plans", "grey", [2, 4]],
    ["Code", "blue", [3, 5]],
  ]);
});

test("a reply that isn't JSON is an error, not an empty result", async () => {
  const { ctx } = lib();
  const tabs = await ctx.looseTabs(1);
  await assert.rejects(ctx.suggestGroups({ tabs, llm: scriptedModel([{ content: "Sure! Group the travel ones." }]) }), /expected format/);
});

test("applying creates titled, coloured groups and skips tabs that changed since", async () => {
  const { ctx, tabs, made } = lib();
  const loose = await ctx.looseTabs(1);
  const groups = ctx.cleanGroups({ groups: [{ name: "Trip", color: "blue", tabs: [1, 3] }, { name: "Rust", color: "red", tabs: [2, 4] }] }, loose);
  tabs.find((t) => t.id === 4).pinned = true; // pinned after the suggestion
  tabs.splice(tabs.findIndex((t) => t.id === 5), 1); // closed
  const r = await ctx.applyGroups(groups, 1);
  assert.deepEqual(plain(r), { created: 2, skipped: 2 });
  assert.deepEqual(plain(made), [
    { id: 1, tabIds: [2], windowId: 1, title: "Trip", color: "blue" },
    { id: 2, tabIds: [3], windowId: 1, title: "Rust", color: "red" },
  ]);
});

test("grouping is reported unsupported without the Firefox 139 APIs", () => {
  const ctx = load(["lib/groups.js"], { browser: { tabs: {} } });
  assert.equal(ctx.groupingSupported(), false);
});
