import test from "node:test";
import assert from "node:assert/strict";
import { load, SETTINGS } from "./harness.mjs";

const origins = ["http://127.0.0.1:9100", "http://127.0.0.1:9101", "http://127.0.0.1:9102"];
const browser = { runtime: { getManifest: () => ({ content_security_policy: { extension_pages: `default-src 'self'; connect-src ${origins.join(" ")};` } }) } };
const plain = (value) => JSON.parse(JSON.stringify(value));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const base = { ...SETTINGS, endpoint: origins[0] + "/v1", apiKey: "main-key", model: "shared-name", decisionModel: "classifier", rerankModel: "ranker" };
const imageMessages = [{ role: "user", content: [{ type: "text", text: "What color?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }];
function client(settings = {}, fetch = async () => json({})) {
  const ctx = load(["lib/settings.js", "lib/llm.js"], { browser, fetch, Response });
  return { ctx, llm: new (ctx.$("LLM"))({ ...base, ...settings }) };
}

test("System One text returns only clear yes/no probabilities; ambiguous is unknown", async () => {
  for (const [probability, expected] of [[0, "no"], [0.15, "no"], [0.1501, "unknown"], [0.5, "unknown"], [0.8499, "unknown"], [0.85, "yes"], [1, "yes"]]) {
    let request;
    const { llm } = client({ decisionApi: "systemone", decisionModel: "any-custom-name" }, async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return json({ answers: { answer: { type: "noul", noul: probability } }, usage: { input_tokens: 100, output_tokens: 1 } });
    });
    let stats;
    assert.equal(await llm.decide({ question: "Is it available?", text: "Only 3 left", onStats: (value) => { stats = value; } }), expected);
    assert.equal(request.url, origins[0] + "/v1/systemone");
    assert.deepEqual(request.body, { model: "any-custom-name", state: "Only 3 left", questions: { answer: { type: "noul", instructions: "Is it available?" } } });
    assert.equal(stats.answer, expected);
    assert.equal(stats.probability, probability);
    assert.equal(stats.tokens, 101);
  }
});

test("System One images retain probabilities and reject absent, nonnumeric or out-of-range scores", async () => {
  let body;
  const { llm } = client({}, async (url, init) => {
    body = JSON.parse(init.body);
    return json({ answers: { answer: { noul: 0.6 } }, usage: { total_tokens: 12 } });
  });
  let stats;
  assert.equal(await llm.decideImage({ question: "Is it red?", image: "data:image/png;base64,AAA", onStats: (value) => { stats = value; } }), 0.6);
  assert.deepEqual(body.images, ["data:image/png;base64,AAA"]);
  assert.equal(body.questions.answer.instructions, "Is it red?");
  assert.equal(stats.answer, "unknown");
  assert.equal(stats.tokens, 12);
  for (const score of [undefined, null, "0.99", -0.01, 1.01]) {
    for (const method of ["decide", "decideImage"]) {
      const broken = client({ decisionApi: "systemone" }, async () => json({ answers: { answer: { noul: score } } })).llm;
      await assert.rejects(broken[method]({ question: "q", text: "t", image: "data:image/png;base64,AAA" }), /valid yes\/no probability/);
    }
  }
});

test("OpenAI structured decisions remain the default regardless of the model name", async () => {
  let request;
  const { llm } = client({ decisionModel: "d3-lite" }, async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return json({ choices: [{ message: { content: '<think>private</think>{"answer":"defer"}' } }] });
  });
  assert.equal(await llm.decide({ question: "Which outcome?", text: "context", options: ["allow", "deny", "defer"] }), "defer");
  assert.equal(request.url, origins[0] + "/v1/chat/completions");
  assert.equal(request.body.response_format.type, "json_schema");
  assert.equal(request.body.response_format.json_schema.description, "Which outcome?");
  assert.deepEqual(request.body.response_format.json_schema.schema.properties.answer.enum, ["allow", "deny", "defer"]);
});

test("failed, malformed and unsupported decision APIs never silently retry or invent an answer", async () => {
  for (const response of [() => json({ error: { message: "Not Found" } }, 404), () => json({ error: { message: "takes no images here" } }, 400), () => json({ error: { message: "busy" } }, 503), () => new Response("not-json"), () => json({})]) {
    let calls = 0;
    const { llm } = client({ decisionApi: "systemone" }, async () => { calls++; return response(); });
    await assert.rejects(llm.decide({ question: "q?", text: "t" }));
    assert.equal(calls, 1);
  }
  const { llm } = client({}, async () => json({ choices: [{ message: { content: '{"answer":"maybe"}' } }] }));
  await assert.rejects(llm.decide({ question: "q?", text: "t" }), /didn't give one of yes\/no/);
});

test("System One nonbinary options and unknown API selections fail before dispatch", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return json({}); };
  await assert.rejects(client({ decisionApi: "systemone" }, fetch).llm.decide({ question: "q", text: "t", options: ["one", "two"] }), /yes\/no questions/);
  await assert.rejects(client({ decisionApi: "typo" }, fetch).llm.decide({ question: "q", text: "t" }), /Select OpenAI/);
  assert.equal(calls, 0);
});

test("independent services use their own base paths and keys, even with identical model names", async () => {
  const requests = [];
  const { llm } = client({ visionEndpoint: origins[1] + "/vision/v1/", visionApiKey: "vision-key", rerankEndpoint: origins[2], rerankApiKey: "rank-key", decisionEndpoint: origins[1] + "/decision/v1", decisionApiKey: "decision-key", decisionApi: "systemone" }, async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    if (url.endsWith("/rerank")) return json({ results: [{ index: 0, relevance_score: 0.8 }] });
    if (url.endsWith("/systemone")) return json({ answers: { answer: { noul: 0.98 } } });
    return json({ choices: [{ message: { content: "ready" } }] });
  });
  await llm.chat({ messages: [{ role: "user", content: "hello" }] });
  await llm.chat({ model: "shared-name", messages: imageMessages });
  await llm.rerank({ query: "q", documents: ["doc"] });
  await llm.decide({ question: "q", text: "t" });
  await llm.decideImage({ question: "q", image: "data:image/png;base64,AAA" });
  assert.deepEqual(requests.map(({ url }) => url), [origins[0] + "/v1/chat/completions", origins[1] + "/vision/v1/chat/completions", origins[2] + "/rerank", origins[1] + "/decision/v1/systemone", origins[1] + "/decision/v1/systemone"]);
  assert.deepEqual(requests.map(({ init }) => init.headers.Authorization), ["Bearer main-key", "Bearer vision-key", "Bearer rank-key", "Bearer decision-key", "Bearer decision-key"]);
  for (const { init } of requests) {
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
  }
});

test("a blank vision model is discovered from its own endpoint and text stays on the main model", async () => {
  const requests = [];
  const { llm } = client({ visionEndpoint: origins[1] + "/v1", visionModel: "" }, async (url, init) => {
    requests.push({ url, body: init.body && JSON.parse(init.body) });
    if (url.endsWith("/models")) return json({ data: [{ id: "vision-only" }] });
    return json({ choices: [{ message: { content: "ok" } }] });
  });
  await llm.chat({ messages: imageMessages });
  await llm.chat({ messages: [{ role: "user", content: "text" }] });
  assert.deepEqual(requests.map((r) => r.url), [
    origins[1] + "/v1/models", origins[1] + "/v1/chat/completions", origins[0] + "/v1/chat/completions",
  ]);
  assert.equal(requests[1].body.model, "vision-only");
  assert.equal(requests[2].body.model, "shared-name");
});

test("blank auxiliary endpoints inherit the main key, explicit endpoints never inherit it", async () => {
  for (const separate of [false, true]) {
    const requests = [];
    const settings = Object.fromEntries(["vision", "rerank", "decision"].map((service) => [service + "Endpoint", separate ? origins[0] + "/alternate/v1" : ""]));
    const { llm } = client({ ...settings, visionModel: "vision", decisionApi: "systemone" }, async (url, init) => {
      requests.push({ url, key: init.headers.Authorization });
      if (url.endsWith("/systemone")) return json({ answers: { answer: { noul: 0.99 } } });
      return json({ choices: [{ message: { content: "ok" } }], results: [{ index: 0, relevance_score: 1 }] });
    });
    await llm.chat({ messages: imageMessages });
    await llm.rerank({ query: "q", documents: ["t"] });
    await llm.decide({ question: "q", text: "t" });
    assert.deepEqual(requests.map(({ key }) => key), Array(3).fill(separate ? undefined : "Bearer main-key"));
  }
});

test("independent OpenAI decisions also use only the independent decision key", async () => {
  let request;
  const { llm } = client({ decisionEndpoint: origins[1] + "/v1", decisionApiKey: "separate-key" }, async (url, init) => {
    request = { url, key: init.headers.Authorization };
    return json({ choices: [{ message: { content: '{"answer":"yes"}' } }] });
  });
  assert.equal(await llm.decide({ question: "q", text: "t" }), "yes");
  assert.deepEqual(request, { url: origins[1] + "/v1/chat/completions", key: "Bearer separate-key" });
});

test("independent endpoints cannot expand the packaged allowlist or embed credentials", async () => {
  for (const endpoint of ["https://api.openai.com/v1", "http://127.0.0.1:9999/v1", "http://user:secret@127.0.0.1:9101/v1", "file:///tmp/server"]) {
    let calls = 0;
    const { llm } = client({ visionEndpoint: endpoint, rerankEndpoint: endpoint, decisionEndpoint: endpoint, decisionApi: "systemone" }, async () => { calls++; return json({}); });
    await assert.rejects(llm.chat({ messages: imageMessages }));
    await assert.rejects(llm.rerank({ query: "q", documents: ["t"] }));
    await assert.rejects(llm.decide({ question: "q", text: "t" }));
    await assert.rejects(llm.decideImage({ question: "q", image: "data:image/png;base64,AAA" }));
    assert.equal(calls, 0, endpoint);
  }
});

test("independent model requests preserve caller cancellation", async () => {
  const ctrl = new AbortController();
  const reason = new DOMException("Stopped", "AbortError");
  ctrl.abort(reason);
  const { llm } = client({ decisionEndpoint: origins[1] + "/v1", decisionApi: "systemone" }, async (url, { signal }) => { throw signal.reason; });
  await assert.rejects(llm.decide({ question: "q", text: "t", signal: ctrl.signal }), (error) => error === reason);
});

function diagnostics() {
  // Keep init waiting on storage while exercising the actual exported diagnostic functions with unsaved values.
  const ctx = load(["lib/settings.js", "lib/llm.js", "options/options.js"], {
    browser: { ...browser, storage: { local: { get: () => new Promise(() => {}) } } },
    document: { createElement: () => ({ getContext: () => ({ fillRect() {} }), toDataURL: () => "data:image/png;base64,GENERATED" }) },
  });
  return ctx;
}

test("decision diagnostics distinguish text probabilities, ambiguous scores and image support", async () => {
  const ctx = diagnostics();
  const settings = { decisionModel: "custom", decisionApi: "systemone" };
  const answers = ["no", "yes", "no", "yes"];
  const textResult = await ctx.checkDecision({ decide: async () => answers.shift() }, settings);
  assert.match(textResult, /System One probabilities/);
  assert.match(textResult, /text only, not image support/);
  await assert.rejects(ctx.checkDecision({ decide: async () => "unknown" }, settings), /0 of 4.*4 ambiguous/);
  const images = [];
  const probabilities = [0.99, 0.01];
  assert.match(await ctx.checkDecisionImage({ decideImage: async (request) => { images.push(plain(request)); return probabilities.shift(); } }, settings), /image probe passed/);
  assert.equal(images.length, 2);
  assert.equal(images[0].image, "data:image/png;base64,GENERATED");
  assert.notEqual(images[0].question, images[1].question);
  await assert.rejects(ctx.checkDecisionImage({ decideImage: async () => 0.5 }, settings), /Ambiguous or wrong scores do not prove images are unsupported/);
  await assert.rejects(ctx.checkDecisionImage({ decideImage: async () => { throw new Error("Server returned 400. takes no images here"); } }, settings), /takes no images here/);
});

test("independent decision diagnostics use unsaved endpoint values without requiring the main origin", async () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", checked: false, disabled: false, setAttribute() {}, removeAttribute() {} });
    return nodes.get(id);
  };
  node("endpoint").value = "http://unconfigured-main.invalid/v1";
  node("apiKey").value = "main-secret";
  node("decisionEndpoint").value = origins[1] + "/v1";
  node("decisionApiKey").value = "decision-secret";
  node("decisionApi").value = "systemone";
  node("decisionModel").value = "custom";
  const probabilities = [0.01, 0.99, 0.01, 0.99];
  const requests = [];
  const ctx = load(["lib/settings.js", "lib/llm.js", "options/options.js"], {
    browser: { ...browser, storage: { local: { get: () => new Promise(() => {}) } } },
    document: { getElementById: node },
    Response,
    fetch: async (url, init) => {
      requests.push({ url, key: init.headers.Authorization });
      return json({ answers: { answer: { noul: probabilities.shift() } } });
    },
  });
  await ctx.runCheck("checkDecision", "decisionResult", ctx.checkDecision);
  assert.match(node("decisionResult").textContent, /text probe passed/);
  assert.equal(node("decisionResult").className, "result ok");
  assert.equal(requests.length, 4);
  for (const request of requests) assert.deepEqual(request, { url: origins[1] + "/v1/systemone", key: "Bearer decision-secret" });
});

test("legacy settings keep shared connections and backups preserve independent endpoint credentials", async () => {
  const storage = { settings: { endpoint: base.endpoint, apiKey: "original", model: "main" } };
  const ctx = load(["lib/settings.js", "lib/backup.js"], {
    browser: { storage: { local: { get: async () => structuredClone(storage), set: async (patch) => Object.assign(storage, patch) } } },
  });
  const legacy = await ctx.loadSettings();
  assert.equal(legacy.decisionApi, "openai");
  for (const service of ["vision", "rerank", "decision"]) {
    assert.equal(legacy[service + "Endpoint"], "");
    assert.equal(legacy[service + "ApiKey"], "");
  }
  const saved = await ctx.saveSettings({ visionEndpoint: origins[1] + "/v1", visionApiKey: "vision", rerankEndpoint: origins[2] + "/v1", rerankApiKey: "rank", decisionEndpoint: origins[1] + "/v1", decisionApiKey: "decision", decisionApi: "systemone" });
  assert.equal(saved.apiKey, "original");
  const restored = ctx.$("backupSettings")(plain(saved));
  for (const service of ["vision", "rerank", "decision"]) {
    assert.equal(restored[service + "Endpoint"], saved[service + "Endpoint"]);
    assert.equal(restored[service + "ApiKey"], saved[service + "ApiKey"]);
  }
  assert.equal(restored.decisionApi, "systemone");
});
