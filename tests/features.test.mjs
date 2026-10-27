import test from "node:test";
import assert from "node:assert/strict";
import { load, AGENT_FILES, scriptedModel, setup, call, answer, SETTINGS } from "./harness.mjs";

const browser = { runtime: { getManifest: () => ({}) } };
const lib = (extra = {}) => load([...AGENT_FILES, "lib/chat.js"], { browser, ...extra });
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------- Ask: keep earlier pages ----------
const yahoo = [{ url: "https://www.yahoo.com/", title: "Yahoo", text: "yahoo headlines" }];
const msnbc = [{ url: "https://www.msnbc.com/article", title: "MSNBC", text: "msnbc article" }];
const sentText = (model) => model.calls.at(-1).messages.map((m) => m.content).join("\n");

test("Ask starts fresh on a different page by default", async () => {
  const ctx = lib();
  const chat = new (ctx.$("Chat"))();
  const model = scriptedModel([{ content: "Y" }, { content: "M" }]);
  const first = await chat.ask({ question: "summarize", pages: yahoo, selection: "", llm: model, settings: SETTINGS });
  const second = await chat.ask({ question: "summarize", pages: msnbc, selection: "", llm: model, settings: SETTINGS });
  assert.equal(first.fresh, false);
  assert.equal(second.fresh, true);
  assert.doesNotMatch(sentText(model), /yahoo/);
  assert.match(sentText(model), /msnbc article/);
});

test("Ask keeps earlier pages when asked to", async () => {
  const ctx = lib();
  const chat = new (ctx.$("Chat"))();
  const model = scriptedModel([{ content: "Y" }, { content: "M" }]);
  await chat.ask({ question: "summarize", pages: yahoo, selection: "", llm: model, settings: SETTINGS, keepPages: true });
  const r = await chat.ask({ question: "compare", pages: msnbc, selection: "", llm: model, settings: SETTINGS, keepPages: true });
  assert.equal(r.fresh, false);
  assert.match(sentText(model), /yahoo headlines[\s\S]*msnbc article/);
});

test("follow-ups on the same page keep the conversation, even when the selection changes", async () => {
  const ctx = lib();
  const chat = new (ctx.$("Chat"))();
  const model = scriptedModel([{ content: "A" }, { content: "B" }]);
  await chat.ask({ question: "q1", pages: yahoo, selection: "", llm: model, settings: SETTINGS });
  const r = await chat.ask({ question: "q2", pages: yahoo, selection: "one headline", llm: model, settings: SETTINGS });
  assert.equal(r.fresh, false);
  assert.match(sentText(model), /q1[\s\S]*one headline[\s\S]*q2/);
});

// ---------- speed stats ----------
const TIMINGS = { prompt_n: 19, predicted_n: 4, prompt_ms: 94.3, predicted_ms: 97, prompt_per_second: 201.5, predicted_per_second: 41.2, cache_n: 0, draft_n: 2, draft_n_accepted: 1 };

test("non-streamed replies report the server's own usage and speed", async () => {
  const body = { choices: [{ message: { content: "hi there" } }], usage: { prompt_tokens: 19, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 19 } }, timings: TIMINGS };
  const ctx = lib({ fetch: async () => new Response(JSON.stringify(body)) });
  const r = await new (ctx.$("LLM"))(SETTINGS).chat({ messages: [] });
  assert.deepEqual(plain({ ...r.stats, elapsedMs: 0 }), {
    elapsedMs: 0, ttftMs: null, promptTokens: 19, completionTokens: 4, cachedTokens: 19, estimated: false, genMs: 97, tps: 41.2, promptTps: 201.5, drafted: { n: 2, accepted: 1 },
  });
});

test("streamed replies ask for usage and read it from the final chunk", async () => {
  let sent;
  const chunks = [
    { choices: [{ delta: { content: "Hello" } }] },
    { choices: [], usage: { prompt_tokens: 19, completion_tokens: 4 }, timings: TIMINGS },
  ];
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const ctx = lib({ fetch: async (url, init) => ((sent = JSON.parse(init.body)), new Response(text)) });
  const r = await new (ctx.$("LLM"))(SETTINGS).chat({ messages: [], stream: true });
  assert.deepEqual(plain(sent.stream_options), { include_usage: true });
  assert.equal(r.content, "Hello");
  assert.equal(r.stats.tps, 41.2);
  assert.equal(r.stats.completionTokens, 4);
  assert.ok(r.stats.ttftMs != null, "time to first token measured");
});

test("servers without usage get estimated, clearly marked numbers", async () => {
  const ctx = lib({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "x".repeat(400) } }] })) });
  const r = await new (ctx.$("LLM"))(SETTINGS).chat({ messages: [] });
  assert.equal(r.stats.completionTokens, 100);
  assert.equal(r.stats.estimated, true);
  const meter = new (ctx.$("Meter"))();
  meter.add(r.stats);
  assert.match(meter.summary().text, /^(~[\d.]+ tok\/s · )?~100 tokens out/); // an instant mock reply has no measurable speed
  assert.match(meter.summary().title, /estimated/);
});

test("the meter adds up several requests", () => {
  const ctx = lib();
  const meter = new (ctx.$("Meter"))();
  meter.add({ promptTokens: 1000, completionTokens: 100, cachedTokens: 800, genMs: 2000, ttftMs: 300, promptTps: 500, drafted: { n: 10, accepted: 6 } });
  meter.add({ promptTokens: 2000, completionTokens: 300, cachedTokens: 0, genMs: 6000, promptTps: 300 });
  const s = meter.summary();
  assert.match(s.text, /^50\.0 tok\/s · 400 tokens out · 3,000 in \(800 cached\) · 2 requests · [\d.]+ s$/);
  assert.match(s.title, /First token after 0\.3 s/);
  assert.match(s.title, /Prompt processing 400 tok\/s/);
  assert.match(s.title, /drafts accepted 60%/);
  assert.equal(new (ctx.$("Meter"))().summary(), null);
});

test("agent runs are metered across all their model calls", async () => {
  const ctx = lib();
  const meter = new (ctx.$("Meter"))();
  const model = scriptedModel([{ content: "a", stats: { completionTokens: 10, genMs: 1000 } }, { content: "b", stats: { completionTokens: 30, genMs: 1000 } }]);
  const llm = ctx.metered(model, meter);
  await llm.chat({ messages: [] });
  await llm.chat({ messages: [] });
  assert.equal(meter.calls, 2);
  assert.equal(meter.completion, 40);
});

// ---------- "Always allow" for the session ----------
const IMDB = "https://www.imdb.com/";
const imdb = (label, extra = {}) => ({ [IMDB]: { title: "IMDb", text: "", elements: { 1: { kind: "link", tag: "A", label, href: `${IMDB}#x`, ...extra } } } });

test("a label-only flag like “Close” offers “Always allow” for the session", async () => {
  const grants = new Set();
  const first = setup({ start: IMDB, sites: imdb("Close"), replies: [call("click", { id: 1 }), answer("ok")], decide: (c) => (c.remember ? "session" : "no") });
  first.agent.sessionGrants = grants;
  await first.run();
  assert.equal(first.ui.cards.length, 1);
  assert.equal(first.ui.cards[0].remember, "Always allow “Close” on imdb.com");
  assert.equal(first.web.log.length, 1);

  // A later task in the same session: no card, and the step log says why.
  const second = setup({ start: IMDB, sites: imdb("Close"), replies: [call("click", { id: 1 }), answer("ok")], decide: () => "no" });
  second.agent.sessionGrants = grants;
  await second.run();
  assert.equal(second.ui.cards.length, 0);
  assert.equal(second.web.log.length, 1);
  assert.ok(second.ui.steps.some((s) => /allowed earlier for this session/.test(s.text)));
});

test("a remembered label doesn't cover other labels, other sites, or riskier signals", async () => {
  const grants = new Set(["label|imdb.com|link|close"]);
  const cases = [
    ["Close account", {}, IMDB],
    ["Close", { kind: "button", isSubmit: true, inForm: true }, IMDB],
    ["Close", { href: `${IMDB}session/logout` }, IMDB],
  ];
  for (const [label, extra, start] of cases) {
    const t = setup({ start, sites: imdb(label, extra), replies: [call("click", { id: 1 }), answer("ok")], decide: () => "no" });
    t.agent.sessionGrants = grants;
    await t.run();
    assert.equal(t.ui.cards.length, 1, `${label} ${JSON.stringify(extra)} must ask`);
    assert.equal(t.web.log.length, 0);
  }
  const other = setup({
    start: "https://www.rottentomatoes.com/",
    sites: { "https://www.rottentomatoes.com/": { title: "RT", text: "", elements: { 1: { kind: "link", tag: "A", label: "Close", href: "https://www.rottentomatoes.com/#x" } } } },
    replies: [call("click", { id: 1 }), answer("ok")],
    decide: () => "no",
  });
  other.agent.sessionGrants = grants;
  await other.run();
  assert.equal(other.ui.cards.length, 1, "other site must ask");
});

test("money, deletion, messages and account actions never offer “Always allow”", async () => {
  for (const label of ["Buy now", "Delete", "Send", "Confirm", "Log out", "Add to cart", "Subscribe", "Allow notifications"]) {
    const t = setup({ start: IMDB, sites: imdb(label), replies: [call("click", { id: 1 }), answer("ok")], decide: () => "no" });
    await t.run();
    assert.equal(t.ui.cards.length, 1, label);
    assert.equal(t.ui.cards[0].remember, null, `${label} must not be rememberable`);
  }
});
