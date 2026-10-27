import test from "node:test";
import assert from "node:assert/strict";
import { load, AGENT_FILES, Web, SETTINGS, scriptedModel } from "./harness.mjs";

const chatLib = () => load(["lib/chat.js"]);

test("citations require an exact quote from the named source, allowing only whitespace changes", () => {
  const { prepareCitations } = chatLib();
  const sources = [
    { id: "s1", text: "Revenue rose\n 12%. Costs fell." },
    { id: "s2", text: "Revenue fell 12%." },
  ];
  const result = prepareCitations("Growth [[cite:s1|Revenue rose 12%.]] [[cite:s2|Revenue rose 12%.]] [[cite:missing|Costs fell.]] [[cite:s1|revenue rose 12%.]] [[cite:s1|  ]]", sources, "REF");
  assert.equal(result.citations[0].source.id, "s1");
  assert.equal(result.citations[0].quote, "Revenue rose 12%.");
  assert.deepEqual(Array.from(result.citations.slice(1), (c) => c.source), [null, null, null, null]);
});

test("repeated quotes share a number, and quotes used as the sentence's words are marked inline", () => {
  const { prepareCitations } = chatLib();
  const sources = [{ id: "s1", text: "A portable Windows tool. Needs an NVIDIA GPU. FFmpeg and FFprobe." }];
  const text = [
    "**TL;DR:** [[cite:s1|A portable Windows tool.]] for video.",
    "- It requires [[cite:s1|Needs an NVIDIA GPU.]], [[cite:s1|FFmpeg and FFprobe.]]",
    "- It is portable [[cite:s1|A portable Windows tool.]].",
  ].join("\n");
  const { markdown, citations } = prepareCitations(text, sources, "T");
  assert.equal(citations.length, 3);
  assert.equal(markdown, ["**TL;DR:** T1IEND for video.", "- It requires T2IEND, T3IEND", "- It is portableT1END."].join("\n"));
});

test("Ask cannot verify a passage beyond the sent page budget", async () => {
  const ctx = chatLib();
  const chat = new (ctx.$("Chat"))();
  await chat.ask({ question: "How much?", pages: [{ tab: { id: 1 }, doc: "d1", url: "https://a.example/", text: "Visible. Hidden beyond budget." }], selection: "", llm: scriptedModel([{ content: "answer" }]), settings: { ...SETTINGS, maxPageChars: 8 } });
  const id = chat.citations[0].id;
  const parsed = ctx.prepareCitations(`[[cite:${id}|Visible.]] [[cite:${id}|Hidden beyond budget.]]`, chat.citations, "REF");
  assert.equal(parsed.citations[0].source.tabId, 1);
  assert.equal(parsed.citations[1].source, null);
});

test("same-URL reloads cannot reuse a previous document's citation IDs", async () => {
  const ctx = chatLib();
  const chat = new (ctx.$("Chat"))();
  const page = { tab: { id: 1 }, doc: "before", url: "https://a.example/", text: "A fixed fact." };
  const options = { question: "Fact?", pages: [page], selection: "", llm: scriptedModel([{ content: "first" }, { content: "second" }]), settings: SETTINGS };
  await chat.ask(options);
  const oldId = chat.citations[0].id;
  page.doc = "after";
  await chat.ask(options);
  assert.equal(ctx.prepareCitations(`[[cite:${oldId}|A fixed fact.]]`, chat.citations, "REF").citations[0].source, null);
  assert.equal(chat.citations[0].doc, "after");
});

test("selections outside the page budget retain their own source identity", async () => {
  const ctx = chatLib();
  const chat = new (ctx.$("Chat"))();
  await chat.ask({ question: "Explain", pages: [{ tab: { id: 9 }, doc: "d9", url: "https://a.example/", text: "Intro. Later detail.", selection: "Later detail." }], selection: "Later detail.", llm: scriptedModel([{ content: "answer" }]), settings: { ...SETTINGS, maxPageChars: 6 } });
  const source = chat.citations.find((s) => s.text === "Later detail.");
  assert.equal(source.tabId, 9);
  assert.equal(ctx.prepareCitations(`[[cite:${source.id}|Later detail.]]`, chat.citations, "REF").citations[0].source.doc, "d9");
});

test("agent cleanup preserves only tabs with valid quoted citations", async () => {
  const web = new Web({ "https://a.example/": { text: "A real fact." } });
  const valid = web.addTab("https://a.example/");
  const invalid = web.addTab("https://a.example/");
  const ctx = load(AGENT_FILES, { browser: web.browser() });
  const agent = new (ctx.$("Agent"))({ settings: { ...SETTINGS, closeAgentTabs: true }, llm: {}, windowId: 1, ui: {} });
  agent.adopt(valid.id);
  agent.adopt(invalid.id);
  const first = agent.citeSource(valid.id, { url: valid.url, doc: valid.doc.doc }, "A real fact.");
  const second = agent.citeSource(invalid.id, { url: invalid.url, doc: invalid.doc.doc }, "A real fact.");
  await agent.done(`True [[cite:${first}|A real fact.]] False [[cite:${second}|An invented fact.]]`);
  assert.ok(web.tabs.has(valid.id));
  assert.ok(!web.tabs.has(invalid.id));
});
