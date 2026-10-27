import test from "node:test";
import assert from "node:assert/strict";
import { load, scriptedModel, SETTINGS } from "./harness.mjs";

const browser = { runtime: { getManifest: () => ({}) } };

/** A scripted chat model plus a reranker that scores passages by whether they contain `needle`. */
function rerankingModel(needle, replies = [{ content: "ok" }]) {
  const model = scriptedModel(replies);
  model.reranks = [];
  model.rerank = async ({ query, documents, model: name }) => {
    model.reranks.push({ query, documents, name });
    return documents.map((d) => (d.includes(needle) ? 0.99 : 0.01));
  };
  return model;
}

// A long page: an intro, then many filler paragraphs with one fact buried near the end.
const filler = (i) => `Paragraph ${i} talks about shipping options and colours in some detail, at length. `.repeat(6);
const LONG = ["Acme X1 laptop: product page.", ...Array.from({ length: 80 }, (_, i) => filler(i)), "The battery lasts 14 hours.", ...Array.from({ length: 5 }, (_, i) => filler(100 + i))].join("\n");
const page = { tab: { id: 1 }, doc: "d", url: "https://shop.example/x1", title: "X1", text: LONG };
const settings = { ...SETTINGS, maxPageChars: 6000, rerankModel: "qwen3-reranker-0.6b" };
const sent = (model) => model.calls.at(-1).messages.map((m) => m.content).join("\n");

test("Ask sends the start and the passages the reranker picks from a long page", async () => {
  const ctx = load(["lib/llm.js", "lib/chat.js"], { browser });
  const chat = new (ctx.$("Chat"))();
  const model = rerankingModel("battery");
  const r = await chat.ask({ question: "How long does the battery last?", pages: [page], selection: "", llm: model, settings });
  assert.equal(r.reranked, 1);
  assert.equal(model.reranks[0].name, "qwen3-reranker-0.6b");
  const text = sent(model);
  assert.match(text, /Acme X1 laptop: product page\./);
  assert.match(text, /The battery lasts 14 hours\./);
  assert.match(text, /\[…\]/);
  assert.doesNotMatch(text, /page truncated/);
  // Sources match against exactly what was sent.
  assert.match(chat.citations[0].text, /battery lasts 14 hours/);
  assert.ok(chat.citations[0].text.length <= settings.maxPageChars);
});

test("without a rerank model a long page is cut at the end, as before", async () => {
  const ctx = load(["lib/llm.js", "lib/chat.js"], { browser });
  const chat = new (ctx.$("Chat"))();
  const model = rerankingModel("battery");
  const r = await chat.ask({ question: "battery?", pages: [page], selection: "", llm: model, settings: { ...settings, rerankModel: "" } });
  assert.equal(r.reranked, 0);
  assert.equal(model.reranks.length, 0);
  assert.match(sent(model), /page truncated/);
  assert.doesNotMatch(sent(model), /battery lasts/);
});

test("a failing reranker falls back to cutting at the end and reports why", async () => {
  const ctx = load(["lib/llm.js", "lib/chat.js"], { browser });
  const chat = new (ctx.$("Chat"))();
  const model = scriptedModel([{ content: "ok" }]);
  model.rerank = async () => { throw new Error("Server returned 404."); };
  const r = await chat.ask({ question: "battery?", pages: [page], selection: "", llm: model, settings });
  assert.equal(r.rerankError.message, "Server returned 404.");
  assert.match(sent(model), /page truncated/);
});

test("a follow-up that needs other passages sends the page again; the reranker sees the earlier question too", async () => {
  const ctx = load(["lib/llm.js", "lib/chat.js"], { browser });
  const chat = new (ctx.$("Chat"))();
  const model = rerankingModel("battery", [{ content: "A" }, { content: "B" }]);
  await chat.ask({ question: "How long does the battery last?", pages: [page], selection: "", llm: model, settings });
  model.rerank = async ({ query, documents }) => {
    model.reranks.push({ query, documents });
    return documents.map((d) => (d.includes("Paragraph 104") ? 0.99 : 0.01));
  };
  await chat.ask({ question: "And the last paragraph?", pages: [page], selection: "", llm: model, settings });
  assert.match(model.reranks.at(-1).query, /battery last\?\nAnd the last paragraph\?/);
  const messages = model.calls.at(-1).messages;
  assert.match(messages.at(-1).content, /Paragraph 104/);
  // The earlier copy of the page is reduced to its question.
  assert.equal(messages.filter((m) => /<page /.test(m.content)).length, 1);
});

test("short pages never call the reranker", async () => {
  const ctx = load(["lib/llm.js", "lib/chat.js"], { browser });
  const chat = new (ctx.$("Chat"))();
  const model = rerankingModel("x");
  await chat.ask({ question: "q", pages: [{ ...page, text: "Short page." }], selection: "", llm: model, settings });
  assert.equal(model.reranks.length, 0);
});

test("pagePassages covers the text exactly, in order, at line breaks where possible", () => {
  const ctx = load(["lib/chat.js"]);
  const passages = ctx.pagePassages(LONG);
  assert.equal(passages.join(""), LONG);
  assert.ok(passages.every((p) => p.length <= ctx.$("PASSAGE_CHARS")));
});

test("LLM.rerank batches documents and puts scores back in document order", async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ url, body });
    // Results arrive best first, as servers send them.
    const results = body.documents.map((d, index) => ({ index, relevance_score: Number(d) / 100 })).reverse();
    return new Response(JSON.stringify({ results }), { status: 200 });
  };
  const ctx = load(["lib/settings.js", "lib/llm.js"], { browser, fetch, Response });
  const llm = new (ctx.$("LLM"))({ endpoint: "http://h:1/v1", rerankModel: "rr" });
  const docs = Array.from({ length: 40 }, (_, i) => String(i));
  const scores = await llm.rerank({ query: "q", documents: docs });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].url, "http://h:1/v1/rerank");
  assert.equal(bodies[0].body.model, "rr");
  assert.deepEqual(Array.from(scores), docs.map((d) => Number(d) / 100));
});

// ---------- Sources ----------
const SOURCE_PAGE = `Topaz SLP Manager
Queue multiple videos with output settings saved separately for each file.
A 64-bit Windows system and an NVIDIA GPU suitable for your selected SLP workload.
H.264, HEVC NVENC, AV1 software or NVENC, FFV1, ProRes and DNxHR are available.`;

test("the reranker places a reworded claim on its sentence without a model call", async () => {
  const ctx = load(["lib/evidence.js"]);
  const evidence = new (ctx.$("Evidence"))([{ tabId: 1, url: "https://a.example/", title: "A", text: SOURCE_PAGE }]);
  const llm = rerankingModel("separately");
  llm.rerank = async ({ query, documents }) => documents.map((d) => (/own/.test(query) && d.includes("separately") ? 0.97 : 0.01));
  const found = await ctx.rerankEvidence({ claims: ["Each video keeps its own output settings.", "It is free."], evidence, llm, model: "rr" });
  assert.equal(found[0].quote, "Queue multiple videos with output settings saved separately for each file.");
  assert.equal(found[1], null);
  assert.equal(llm.calls.length, 0);
});

test("a very long page is narrowed by the question's words before reranking", async () => {
  const ctx = load(["lib/llm.js", "lib/chat.js"], { browser });
  const huge = ["Intro.", ...Array.from({ length: 300 }, (_, i) => filler(i)), "The battery lasts 14 hours."].join("\n");
  const model = rerankingModel("battery");
  const text = await ctx.relevantText({ text: huge, query: "battery life", budget: 6000, llm: model, model: "rr" });
  assert.equal(model.reranks[0].documents.length, ctx.$("RERANK_PASSAGES"));
  assert.ok(model.reranks[0].documents.some((d) => d.includes("battery")));
  assert.match(text, /^Intro\.[\s\S]*The battery lasts 14 hours\.$/);
});
