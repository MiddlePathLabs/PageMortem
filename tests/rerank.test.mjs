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

test("incomplete rerank results fail instead of silently assigning a score of zero", async () => {
  for (const rows of [[], [{ index: 0, score: -3 }], [{ index: 0, score: 1 }, { index: 0, score: 2 }]]) {
    const ctx = load(["lib/settings.js", "lib/llm.js"], {
      browser, fetch: async () => new Response(JSON.stringify({ results: rows })), Response,
    });
    const llm = new (ctx.$("LLM"))({ endpoint: "http://127.0.0.1:9/v1", rerankModel: "rr" });
    await assert.rejects(llm.rerank({ query: "q", documents: ["a", "b"] }), /reranker (scored|returned)/i);
  }
});

// ---------- Sources ----------
const SOURCE_PAGE = `Topaz SLP Manager
Queue multiple videos with output settings saved separately for each file.
A 64-bit Windows system and an NVIDIA GPU suitable for your selected SLP workload.
H.264, HEVC NVENC, AV1 software or NVENC, FFV1, ProRes and DNxHR are available.`;

test("the reranker retrieves reworded related passages without claiming support", async () => {
  const ctx = load(["lib/evidence.js"]);
  const evidence = new (ctx.$("Evidence"))([{ tabId: 1, url: "https://a.example/", title: "A", text: SOURCE_PAGE }]);
  const llm = rerankingModel("separately");
  llm.rerank = async ({ query, documents }) => documents.map((d) => (/own/.test(query) && d.includes("separately") ? 0.97 : 0.01));
  const found = await ctx.rerankEvidence({ claims: ["Each video keeps its own output settings.", "It is free."], evidence, llm, model: "rr" });
  assert.equal(found[0].quote, "Queue multiple videos with output settings saved separately for each file.");
  assert.equal(found[0].kind, "weak");
  assert.equal(found[1].kind, "weak", "even the best irrelevant score is only a retrieval candidate");
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

test("the stats line counts reranker and decision-model requests beside the main model's", () => {
  const ctx = load(["lib/llm.js"]);
  const meter = new (ctx.$("Meter"))();
  meter.add({ promptTokens: 3539, completionTokens: 448, cachedTokens: 64, genMs: 6450 });
  meter.addSide("rerank", { model: "qwen3-reranker-0.6b", ms: 1400, tokens: 9000, items: 32 });
  meter.addSide("rerank", { model: "qwen3-reranker-0.6b", ms: 1400, tokens: 8900, items: 32 });
  for (const answer of ["no", "no", "yes"]) meter.addSide("decide", { model: "d3-lite", ms: 54, tokens: 106, answer });
  const s = meter.summary();
  assert.match(s.text, /448 tokens out · 3,539 in \(64 cached\) · reranked 64 passages in 2\.8 s · 3 decisions, 54 ms avg · /);
  assert.match(s.title, /Reranker qwen3-reranker-0\.6b: 2 requests, 64 passages, 17,900 tokens, 2\.8 s/);
  assert.match(s.title, /Decision model d3-lite: 3 answers \(1 yes\), 54 ms average, 318 tokens/);
});

test("the metered client reports rerank and decide requests to the meter", async () => {
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/rerank")) return new Response(JSON.stringify({ results: body.documents.map((_, index) => ({ index, relevance_score: 0.5 })), usage: { total_tokens: 40 } }));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer": "yes"}' } }], usage: { total_tokens: 50 } }));
  };
  const ctx = load(["lib/settings.js", "lib/llm.js"], { browser, fetch, Response });
  const meter = new (ctx.$("Meter"))();
  const llm = ctx.metered(new (ctx.$("LLM"))({ endpoint: "http://h:1/v1", rerankModel: "rr", decisionModel: "dd" }), meter);
  await llm.rerank({ query: "q", documents: ["a", "b"] });
  assert.equal(await llm.decide({ question: "q?", text: "t" }), "yes");
  assert.deepEqual({ ...meter.side.rerank, ms: 0 }, { model: "rr", calls: 1, ms: 0, tokens: 40, items: 2, yes: 0 });
  assert.equal(meter.side.decide.model, "dd");
  assert.equal(meter.side.decide.yes, 1);
  assert.match(meter.summary().text, /^reranked 2 passages in .* · 1 decision, \d+ ms avg · /);
});

const turn = () => new Promise((resolve) => setImmediate(resolve));

function countingRerankServer() {
  const bodies = [];
  let active = 0, peak = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    active++;
    peak = Math.max(peak, active);
    await turn();
    active--;
    return new Response(JSON.stringify({ results: body.documents.map((_, index) => ({ index, relevance_score: 0.9 })) }));
  };
  return { fetch, bodies, peak: () => peak };
}

test("64 evidence sentences use two serial requests per claim, with at most three claims active", async () => {
  const server = countingRerankServer();
  const ctx = load(["lib/settings.js", "lib/llm.js", "lib/evidence.js"], { browser, fetch: server.fetch, Response });
  const llm = new (ctx.$("LLM"))({ endpoint: "http://h:1/v1", rerankModel: "rr" });
  const text = Array.from({ length: 64 }, (_, i) => `Sentence ${i} explains configuration options.`).join("\n");
  const evidence = new (ctx.$("Evidence"))([{ url: "https://a.example/", text }]);
  const claims = Array.from({ length: 8 }, (_, i) => `Configuration claim ${i}.`);
  const found = await ctx.rerankEvidence({ claims, evidence, llm, model: "rr" });
  assert.equal(server.bodies.length, 16);
  assert.equal(server.peak(), 3);
  assert.ok(server.bodies.every((b) => b.documents.length === 32));
  assert.equal(found.length, claims.length);
  assert.ok(found.every((r) => r.kind === "weak"));
  assert.deepEqual(server.bodies.filter((b) => b.documents[0].includes("Sentence 0 ")).map((b) => b.query), claims);
});

test("evidence beyond 64 sentences narrows each claim to at most 20 passages", async () => {
  const ctx = load(["lib/evidence.js"]);
  const text = Array.from({ length: 65 }, (_, i) => `Configuration sentence ${i} explains available options.`).join("\n");
  const evidence = new (ctx.$("Evidence"))([{ url: "https://a.example/", text }]);
  const llm = rerankingModel("configuration");
  await ctx.rerankEvidence({ claims: ["Configuration options."], evidence, llm, model: "rr" });
  assert.equal(llm.reranks[0].documents.length, 20);
});

test("one failed evidence rerank preserves other claims and raw negative scores remain retrieval-only", async () => {
  const ctx = load(["lib/evidence.js"]);
  const quote = "Product availability is limited to Canada.";
  const evidence = new (ctx.$("Evidence"))([{ url: "https://a.example/", text: quote }]);
  const llm = { rerank: async ({ query }) => {
    if (query === "broken") throw new Error("Server returned 503.");
    return [-4.2];
  } };
  const found = await ctx.rerankEvidence({ claims: ["broken", "Available in Canada."], evidence, llm, model: "rr" });
  assert.equal(found[0], null);
  assert.equal(found[1].quote, quote);
  assert.equal(found[1].score, -4.2);
  assert.equal(found[1].kind, "weak");
});

test("a high relevance score for a contradiction still needs a separate support check", async () => {
  const ctx = load(["lib/evidence.js"]);
  const quote = "This product is not approved for children.";
  const evidence = new (ctx.$("Evidence"))([{ url: "https://a.example/", text: quote }]);
  const claims = ["This product is approved for children."];
  const llm = scriptedModel([{ content: '[{"n":1,"quote":""}]' }]);
  llm.rerank = async () => [0.999];
  const ranked = await ctx.rerankEvidence({ claims, evidence, llm, model: "rr" });
  assert.equal(ranked[0].kind, "weak");
  assert.ok(evidence.match(claims[0]).score >= ctx.$("STRONG_MATCH"), "lexical overlap also cannot establish support");
  const supported = await ctx.modelEvidence({ claims, evidence, llm, ranked });
  assert.equal(supported[0], null);
  assert.match(llm.calls[0].messages[0].content, /Reject passages that contradict the claim/);
  assert.match(llm.calls[0].messages[1].content, /not approved for children/);
});

test("model support checking includes a reranked paraphrase outside the lexical shortlist", async () => {
  const ctx = load(["lib/evidence.js"]);
  const quote = "Every clip retains independent export preferences.";
  const evidence = new (ctx.$("Evidence"))([{ url: "https://a.example/", text: quote }]);
  const claims = ["Each video keeps its own output settings."];
  assert.equal(evidence.candidates(claims[0]).length, 0);
  const llm = scriptedModel([{ content: JSON.stringify([{ n: 1, quote }]) }]);
  llm.rerank = async () => [7.5];
  const ranked = await ctx.rerankEvidence({ claims, evidence, llm, model: "rr" });
  const supported = await ctx.modelEvidence({ claims, evidence, llm, ranked });
  assert.equal(supported[0].quote, quote);
  assert.match(llm.calls[0].messages[1].content, /independent export preferences/);
});

test("eight long pages use at most three concurrent HTTP rerank requests and three batches per page", async () => {
  const server = countingRerankServer();
  const ctx = load(["lib/settings.js", "lib/llm.js", "lib/chat.js"], { browser, fetch: server.fetch, Response });
  const llm = new (ctx.$("LLM"))({ endpoint: "http://h:1/v1", rerankModel: "rr" });
  const model = scriptedModel([{ content: "ok" }]);
  model.rerank = llm.rerank.bind(llm);
  const huge = ["Intro.", ...Array.from({ length: 300 }, (_, i) => filler(i))].join("\n");
  const pages = Array.from({ length: 8 }, (_, i) => ({ ...page, tab: { id: i }, url: `https://a.example/${i}`, text: huge }));
  const chat = new (ctx.$("Chat"))();
  await chat.ask({ question: "shipping?", pages, selection: "", llm: model, settings: { ...settings, maxPageChars: 48000 } });
  assert.equal(server.bodies.length, 24);
  assert.equal(server.peak(), 3);
  assert.ok(server.bodies.every((b) => b.documents.length === 32));
  assert.ok(chat.citations.every((c) => c.text.length <= 6000));
});

test("small page shares respect the budget without an unusable rerank request", async () => {
  const ctx = load(["lib/chat.js"]);
  const llm = rerankingModel("battery");
  for (const budget of [0, 1, 80, 1200]) {
    const text = await ctx.relevantText({ text: "a".repeat(10000), query: "battery", budget, llm, model: "rr" });
    assert.equal(text.length, budget);
  }
  assert.equal(llm.reranks.length, 0);
});

test("passage boundaries never include a 1201st space or line break", () => {
  const ctx = load(["lib/chat.js"]);
  for (const boundary of [" ", "\n"]) {
    const text = "x".repeat(1200) + boundary + "y".repeat(1200);
    const passages = ctx.pagePassages(text);
    assert.equal(passages.join(""), text);
    assert.ok(passages.every((p) => p.length <= 1200));
  }
});

for (const operation of ["evidence", "pages"]) {
  test(`${operation} cancellation stops queued reranks, drains active work, and never starts chat`, async () => {
    const ctx = load(["lib/chat.js", "lib/evidence.js"]);
    const controller = new AbortController();
    const pending = [];
    let calls = 0;
    const llm = scriptedModel([{ content: "must not be called" }]);
    llm.rerank = ({ documents }) => {
      calls++;
      return new Promise((resolve, reject) => pending.push({ resolve: () => resolve(documents.map(() => 0.9)), reject }));
    };
    const evidence = new (ctx.$("Evidence"))([{ url: "https://a.example/", text: SOURCE_PAGE }]);
    const chat = new (ctx.$("Chat"))();
    const work = operation === "evidence"
      ? ctx.rerankEvidence({ claims: Array.from({ length: 8 }, (_, i) => `Claim ${i}`), evidence, llm, model: "rr", signal: controller.signal })
      : chat.ask({ question: "q", pages: Array.from({ length: 8 }, (_, i) => ({ ...page, url: `https://a.example/${i}` })), selection: "", llm, settings: { ...settings, maxPageChars: 48000 }, signal: controller.signal });
    const rejected = assert.rejects(work, { name: "AbortError" });
    let settled = false;
    work.then(() => { settled = true; }, () => { settled = true; });
    assert.equal(calls, 3);
    controller.abort();
    pending[0].reject(controller.signal.reason);
    await turn();
    assert.equal(settled, false, "active siblings must drain before cancellation is reported");
    pending.slice(1).forEach((p) => p.resolve());
    await rejected;
    assert.equal(calls, 3, "five queued reranks must not start");
    assert.equal(llm.calls.length, 0);
    assert.equal(chat.history.length, 0);
  });
}

test("an already cancelled request does not start evidence, selection, or support-check requests", async () => {
  const ctx = load(["lib/evidence.js", "lib/chat.js"]);
  const controller = new AbortController();
  controller.abort();
  const llm = rerankingModel("battery");
  const evidence = new (ctx.$("Evidence"))([{ url: "https://a.example/", text: SOURCE_PAGE }]);
  await assert.rejects(ctx.rerankEvidence({ claims: ["q"], evidence, llm, model: "rr", signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(ctx.modelEvidence({ claims: ["q"], evidence, llm, signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(ctx.relevantText({ text: LONG, query: "q", budget: 6000, llm, model: "rr", signal: controller.signal }), { name: "AbortError" });
  assert.equal(llm.calls.length, 0);
  assert.equal(llm.reranks.length, 0);
});
