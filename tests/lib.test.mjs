import test from "node:test";
import assert from "node:assert/strict";
import { load, AGENT_FILES, scriptedModel, SETTINGS } from "./harness.mjs";

const manifest = { content_security_policy: { extension_pages: "default-src 'self'; connect-src http://192.168.1.50:8080; object-src 'none'" } };
const browser = { runtime: { getManifest: () => manifest } };
// Like a server that never answers: settles only when the request is aborted (at once if already aborted, as fetch does).
const hangingFetch = (url, { signal }) =>
  new Promise((_, rej) => (signal.aborted ? rej(signal.reason) : signal.addEventListener("abort", () => rej(signal.reason))));
// Values from the VM realm have their own Array/Object prototypes; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
const lib = (extra = {}) => load([...AGENT_FILES, "lib/chat.js"], { browser, ...extra });

// ---------- URLs and sites ----------
test("only http(s) URLs count as web pages", () => {
  const { isWebUrl } = lib();
  for (const u of ["https://a.example/", "http://192.168.1.2:8080/x"]) assert.ok(isWebUrl(u), u);
  for (const u of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "about:config", "moz-extension://x/", "blob:https://a/x", "not a url", ""]) {
    assert.ok(!isWebUrl(u), u);
  }
});

test("siteOf separates tenants of shared hosting and handles country suffixes", () => {
  const { siteOf } = lib();
  assert.equal(siteOf("https://www.example.com/a"), "example.com");
  assert.equal(siteOf("https://news.bbc.co.uk/"), "bbc.co.uk");
  assert.equal(siteOf("https://alice.github.io/x"), "alice.github.io");
  assert.notEqual(siteOf("https://victim.vercel.app/"), siteOf("https://attacker.vercel.app/"));
  assert.notEqual(siteOf("https://a.s3.amazonaws.com/"), siteOf("https://b.s3.amazonaws.com/"));
  assert.equal(siteOf("http://192.168.1.5:8080/"), "192.168.1.5");
  assert.equal(siteOf("garbage"), "");
});

test("dangerous link schemes are refused before any approval", async () => {
  const ctx = lib();
  const Agent = ctx.$("Agent");
  const cards = [];
  const a = new Agent({ settings: SETTINGS, llm: {}, windowId: 1, ui: { confirm: async (c) => (cards.push(c), "yes") } });
  for (const u of ["javascript:fetch('//evil')", "data:text/html,hi", "file:///C:/secrets.txt"]) {
    assert.match(await a.siteGate(u), /only http\(s\)/, u);
  }
  assert.equal(cards.length, 0);
});

// ---------- endpoint lock ----------
test("the endpoint lock accepts only the packaged connect-src origin", () => {
  const { lockProblem, lockedOrigins } = lib();
  assert.deepEqual(plain(lockedOrigins()), ["http://192.168.1.50:8080"]);
  assert.equal(lockProblem("http://192.168.1.50:8080/v1"), null);
  for (const u of ["https://api.openai.com/v1", "http://192.168.1.51:8080/v1", "http://192.168.1.50:8081/v1", "http://user:pw@evil.example/v1"]) {
    assert.match(lockProblem(u), /network lock/, u);
  }
  assert.match(lockProblem("::nope"), /valid URL/);
});

// ---------- model client ----------
function sse(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

test("model requests refuse redirects and send the configured headers", async () => {
  let init;
  const ctx = lib({ fetch: async (url, i) => ((init = i), new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }))) });
  const llm = new (ctx.$("LLM"))({ ...SETTINGS, apiKey: "k" });
  const r = await llm.chat({ messages: [] });
  assert.equal(r.content, "hi");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.Authorization, "Bearer k");
  assert.ok(init.signal, "every request carries a timeout signal");
});

test("a model server that never answers times out with a readable error", async () => {
  const ctx = lib({ fetch: hangingFetch });
  const llm = new (ctx.$("LLM"))({ ...SETTINGS, requestTimeout: 50 });
  await assert.rejects(llm.chat({ messages: [] }), (e) => e instanceof ctx.$("LLMError") && /didn't answer within/.test(e.message));
});

test("a user Stop passes through instead of becoming a connection error", async () => {
  const ctx = lib({ fetch: hangingFetch });
  const llm = new (ctx.$("LLM"))(SETTINGS);
  const ctrl = new AbortController();
  const StopError = ctx.$("StopError");
  const p = llm.chat({ messages: [], signal: ctrl.signal });
  ctrl.abort(new StopError("Stopped."));
  await assert.rejects(p, (e) => e instanceof StopError);
});

test("SSE parsing survives fragmented lines, reasoning, <think> blocks and streamed tool calls", async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: "hmm " } }] },
    { choices: [{ delta: { content: "<think>secret</think>Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "read_", arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "page", arguments: 'rt": 2}' } }] }, finish_reason: "tool_calls" }] },
  ];
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  const pieces = [];
  for (let i = 0; i < text.length; i += 7) pieces.push(text.slice(i, i + 7)); // split mid-line and mid-JSON
  const ctx = lib({ fetch: async () => new Response(sse(pieces)) });
  const llm = new (ctx.$("LLM"))(SETTINGS);
  const deltas = [];
  const r = await llm.chat({ messages: [], stream: true, onDelta: (t) => deltas.push(t) });
  assert.equal(r.content, "Hello");
  assert.equal(r.reasoning, "hmm ");
  assert.equal(r.finishReason, "tool_calls");
  assert.deepEqual(plain(r.toolCalls), [{ id: "t1", name: "read_page", arguments: '{"part": 2}' }]);
  assert.ok(deltas.every((d) => !d.includes("secret")));
});

test("server errors surface the status and a context hint", async () => {
  const ctx = lib({ fetch: async () => new Response("prompt exceeds context length", { status: 400 }) });
  const llm = new (ctx.$("LLM"))(SETTINGS);
  await assert.rejects(llm.chat({ messages: [] }), /400.*Max page characters/s);
});

// ---------- Markdown ----------
test("Markdown escapes HTML and never produces scripts, images, frames or handlers", () => {
  const { renderMarkdown } = lib();
  const evil = [
    "<script>alert(1)</script>",
    "<img src=https://evil.example/x.png onerror=alert(1)>",
    "![x](https://evil.example/beacon.png)",
    "<iframe src=//evil></iframe><object data=x></object><embed src=x>",
    "[click](javascript:alert(1))",
    "[d](data:text/html,<script>alert(1)</script>)",
    '[x](https://a.example/"onmouseover="alert(1))',
    "`<b>` **<i>bold</i>**",
  ].join("\n\n");
  const html = renderMarkdown(evil, { links: new Set(["https://a.example"]) });
  assert.doesNotMatch(html, /<(script|img|iframe|object|embed|i)\b/i);
  assert.doesNotMatch(html, /href="(javascript|data):/i);
  // Every tag the renderer emits carries only quoted, allowlisted attributes (handler text stays escaped text).
  for (const [, tag, attrs] of html.matchAll(/<(\w+)([^>]*)>/g)) {
    const rest = attrs.replace(/\s(href|target|rel|class|title)="[^"<>]*"/g, "");
    assert.equal(rest.trim(), "", `<${tag}${attrs}>`);
  }
  assert.match(html, /&lt;script&gt;/);
});

test("Markdown links are clickable only to origins the answer came from", () => {
  const { renderMarkdown } = lib();
  const html = renderMarkdown("[docs](https://docs.example/a?b=1&c=2) and [leak](https://evil.example/?d=secret)", { links: new Set(["https://docs.example"]) });
  assert.match(html, /<a href="https:\/\/docs\.example\/a\?b=1&amp;c=2"/);
  assert.doesNotMatch(html, /<a href="https:\/\/evil/);
  assert.match(html, /class="unlinked"[^>]*>\(https:\/\/evil\.example\/\?d=secret\)/);
  assert.doesNotMatch(renderMarkdown("[x](https://docs.example/)"), /<a /, "no origins given: nothing is clickable");
});

test("Markdown keeps code blocks, tables and lists", () => {
  const { renderMarkdown } = lib();
  const html = renderMarkdown("## T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n- y\n\n```js\nif (a < b) {}\n```");
  assert.match(html, /<h4>T<\/h4>/);
  assert.match(html, /<table>.*<td>1<\/td>/s);
  assert.match(html, /<ul><li class="d0">x<\/li>/);
  assert.match(html, /<pre><code>if \(a &lt; b\) \{\}<\/code><\/pre>/);
});

// ---------- Ask / Summarize / Translate ----------
test("Ask wraps pages as data and keeps the conversation", async () => {
  const ctx = lib();
  const chat = new (ctx.$("Chat"))();
  const model = scriptedModel([{ content: "A1" }, { content: "A2" }]);
  const pages = [{ url: "https://a.example/", title: 'Say "hi"', text: "body text" }];
  assert.equal((await chat.ask({ question: "q1", pages, selection: "", llm: model, settings: SETTINGS })).answer, "A1");
  assert.equal((await chat.ask({ question: "q2", pages, selection: "", llm: model, settings: SETTINGS })).answer, "A2");
  const [sys, u1, a1, u2] = model.calls[1].messages;
  assert.match(sys.content, /untrusted data/);
  assert.equal(a1.content, "A1");
  assert.equal(u2.content, "q2", "same pages aren't resent");
});

test("Summarize splits long pages into parts and combines them", async () => {
  const ctx = lib();
  const model = scriptedModel([{ content: "p1" }, { content: "p2" }, { content: "p3" }, { content: "final" }]);
  const out = await ctx.summarize({ page: { url: "https://a/", title: "T", text: "x".repeat(10000) }, llm: model, settings: { ...SETTINGS, maxPageChars: 4000 } });
  assert.equal(out, "final");
  assert.equal(model.calls.length, 4);
  assert.match(model.calls[3].messages[1].content, /Part 1:\np1/);
});

test("Translate parses numbered segments, including loose numbering", () => {
  const { parseSegments } = lib();
  assert.deepEqual(plain([...parseSegments("[[1]] Hola\n[[2]] Mundo")]), [[1, "Hola"], [2, "Mundo"]]);
  assert.deepEqual(plain([...parseSegments("1. Bonjour\n2) Monde")]), [[1, "Bonjour"], [2, "Monde"]]);
});

test("Translate page applies batches and reports untranslated pieces", async () => {
  const applied = [];
  const browserWithPage = {
    ...browser,
    scripting: { executeScript: async () => [] },
    tabs: {
      get: async () => ({ url: "https://a/" }),
      sendMessage: async (id, { op, args }) => {
        if (op === "ping") return { ok: true };
        if (op === "collectSegments") return { segments: [{ i: 0, t: "Hello" }, { i: 1, t: "World" }] };
        if (op === "applySegments") return applied.push(...args.items), { applied: args.items.length };
      },
    },
  };
  const ctx = load([...AGENT_FILES, "lib/chat.js"], { browser: browserWithPage });
  const model = scriptedModel([{ content: "[[1]] Hola" }]);
  const r = await ctx.translatePage({ tabId: 1, lang: "Spanish", llm: model, settings: { ...SETTINGS, translateConcurrency: 1 } });
  assert.deepEqual(plain(r), { total: 2, done: 2, failed: 1 });
  assert.deepEqual(plain(applied), [{ i: 0, t: "Hola" }]);
});
