// Minimal OpenAI-compatible chat client (llama.cpp server, vLLM, LM Studio, Ollama /v1, …).
"use strict";

/** Remove <think>…</think> blocks, including an unfinished one, and anything before a lone </think>. */
function stripThink(text) {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = t.indexOf("<think>");
  if (open !== -1) t = t.slice(0, open);
  const close = t.lastIndexOf("</think>");
  if (close !== -1) t = t.slice(close + 8);
  return t.replace(/^\s+/, "");
}

class LLMError extends Error {}

/**
 * Speed and size of one reply. Uses the server's own numbers when it sends them (`usage`, and llama.cpp-style
 * `timings`), otherwise client-side timing with tokens estimated from characters.
 */
function replyStats({ usage, timings, started, firstAt, ended, chars }) {
  const s = {
    elapsedMs: ended - started,
    ttftMs: firstAt ? firstAt - started : null,
    promptTokens: usage?.prompt_tokens ?? timings?.prompt_n ?? null,
    completionTokens: usage?.completion_tokens ?? timings?.predicted_n ?? null,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? timings?.cache_n ?? null,
    estimated: false,
  };
  if (s.completionTokens == null) {
    s.completionTokens = Math.round(chars / 4);
    s.estimated = true;
  }
  s.genMs = timings?.predicted_ms ?? (firstAt ? ended - firstAt : s.elapsedMs);
  s.tps = timings?.predicted_per_second ?? (s.genMs > 0 ? s.completionTokens / (s.genMs / 1000) : null);
  s.promptTps = timings?.prompt_per_second || null;
  if (timings?.draft_n) s.drafted = { n: timings.draft_n, accepted: timings.draft_n_accepted || 0 };
  return s;
}

/** Adds up reply stats over one Ask, Summarize, Translate or Agent run. */
class Meter {
  constructor() {
    Object.assign(this, { calls: 0, prompt: 0, completion: 0, cached: 0, genMs: 0, ttftMs: null, estimated: false, drafted: 0, accepted: 0, promptTps: [] });
    // Requests to the reranker and the decision model, which run beside the main model: { model, calls, ms, tokens, items, yes }.
    this.side = { rerank: null, decide: null };
    this.started = Date.now();
  }

  /** One rerank or decide request: its model, time, tokens, and passages scored (rerank) or answer (decide). */
  addSide(kind, { model, ms, tokens, items = 0, answer }) {
    const s = (this.side[kind] ||= { model, calls: 0, ms: 0, tokens: 0, items: 0, yes: 0 });
    s.calls++;
    s.ms += ms;
    s.tokens += tokens || 0;
    s.items += items;
    if (answer === "yes") s.yes++;
  }

  add(s) {
    if (!s) return;
    this.calls++;
    this.prompt += s.promptTokens || 0;
    this.completion += s.completionTokens || 0;
    this.cached += s.cachedTokens || 0;
    this.genMs += s.genMs || 0;
    this.estimated ||= s.estimated;
    if (this.ttftMs == null && s.ttftMs != null) this.ttftMs = s.ttftMs;
    if (s.promptTps) this.promptTps.push(s.promptTps);
    if (s.drafted) {
      this.drafted += s.drafted.n;
      this.accepted += s.drafted.accepted;
    }
  }

  /** One short line, plus a longer tooltip. Returns null when nothing was measured. */
  summary() {
    const { rerank, decide } = this.side;
    if (!this.calls && !rerank && !decide) return null;
    const n = (x) => Math.round(x).toLocaleString("en-US");
    const sec = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
    const tps = this.genMs > 0 ? this.completion / (this.genMs / 1000) : 0;
    const approx = this.estimated ? "~" : "";
    const parts = [];
    if (tps) parts.push(`${approx}${tps.toFixed(1)} tok/s`);
    if (this.calls) parts.push(`${approx}${n(this.completion)} tokens out`);
    if (this.prompt) parts.push(`${n(this.prompt)} in${this.cached ? ` (${n(this.cached)} cached)` : ""}`);
    if (this.calls > 1) parts.push(`${this.calls} requests`);
    if (rerank) parts.push(`reranked ${n(rerank.items)} passages in ${sec(rerank.ms)}`);
    if (decide) parts.push(`${n(decide.calls)} decision${decide.calls === 1 ? "" : "s"}, ${n(decide.ms / decide.calls)} ms avg`);
    parts.push(sec(Date.now() - this.started));
    const tip = [];
    if (rerank) {
      tip.push(`Reranker ${rerank.model}: ${n(rerank.calls)} request${rerank.calls === 1 ? "" : "s"}, ${n(rerank.items)} passages${rerank.tokens ? `, ${n(rerank.tokens)} tokens` : ""}, ${sec(rerank.ms)}`);
    }
    if (decide) {
      tip.push(`Decision model ${decide.model}: ${n(decide.calls)} answer${decide.calls === 1 ? "" : "s"} (${n(decide.yes)} yes), ${n(decide.ms / decide.calls)} ms average${decide.tokens ? `, ${n(decide.tokens)} tokens` : ""}`);
    }
    if (this.ttftMs != null) tip.push(`First token after ${sec(this.ttftMs)}`);
    if (this.promptTps.length) tip.push(`Prompt processing ${(this.promptTps.reduce((a, b) => a + b, 0) / this.promptTps.length).toFixed(0)} tok/s`);
    if (this.drafted) tip.push(`Speculative drafts accepted ${Math.round((100 * this.accepted) / this.drafted)}%`);
    if (this.estimated) tip.push("~ = estimated: the server didn't report token counts");
    return { text: parts.join(" · "), title: tip.join("\n") };
  }
}

/** The same client, with every reply's stats added to `meter`. */
function metered(llm, meter) {
  return {
    s: llm.s,
    models: () => llm.models(),
    model: () => llm.model(),
    rerank: (opts) => llm.rerank({ ...opts, onStats: (s) => meter.addSide("rerank", s) }),
    decide: (opts) => llm.decide({ ...opts, onStats: (s) => meter.addSide("decide", s) }),
    async chat(opts) {
      const r = await llm.chat(opts);
      meter.add(r.stats);
      return r;
    },
  };
}

// Slow local models can take minutes on long prompts, but a request that never ends must not hang the UI.
const LLM_TIMEOUT = 300000;

// Passages sent in one rerank request.
const RERANK_BATCH = 32;

// Reasoning effort names, least to most; each server accepts its own subset.
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Effort names a chat template accepts, or null when it has no reasoning_effort variable. A template that checks the
 * value against a list (`reasoning_effort not in ('low', …)`) accepts only that list; one that just prints it accepts any.
 */
function templateEfforts(template) {
  const lines = template.split("\n").filter((l) => l.includes("reasoning_effort"));
  if (!lines.length) return null;
  const quoted = (l) => [...l.matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]).filter((w) => EFFORTS.includes(w));
  const list = lines.find((l) => /\bin\s*[([]/.test(l) && quoted(l).length);
  return list ? quoted(list) : [...new Set(["low", "medium", "high", ...lines.flatMap(quoted)])];
}

const byEffort = (a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b);

class LLM {
  constructor(settings) {
    this.s = settings;
    this._model = settings.model || "";
  }

  url(path) {
    if (path.startsWith("/~")) return new URL(this.s.endpoint).origin + path.slice(2); // server root, outside /v1
    return this.s.endpoint.replace(/\/+$/, "") + path;
  }

  headers() {
    const h = { "Content-Type": "application/json" };
    if (this.s.apiKey) h.Authorization = `Bearer ${this.s.apiKey}`;
    return h;
  }

  async _fetch(path, init) {
    const timeout = AbortSignal.timeout(this.s.requestTimeout || LLM_TIMEOUT);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res;
    try {
      // redirect: "error" keeps the request (and the API key) on the configured origin; the CSP also blocks other origins.
      res = await fetch(this.url(path), { ...init, signal, headers: this.headers(), redirect: "error" });
    } catch (e) {
      if (e.name === "TimeoutError") throw new LLMError(`The model server didn't answer within ${Math.round((this.s.requestTimeout || LLM_TIMEOUT) / 1000)} s.`);
      if (e.name === "AbortError" || init.signal?.aborted) throw e;
      const lock = lockProblem(this.s.endpoint);
      throw new LLMError(lock || `Can't reach ${this.s.endpoint}. Is the server running and reachable from this computer?`);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 400);
      let hint = "";
      if (/context|too long|exceed/i.test(body)) hint = " Try lowering “Max page characters” in settings.";
      throw new LLMError(`Server returned ${res.status}. ${body}${hint}`);
    }
    return res;
  }

  async models() {
    const res = await this._fetch("/models", { method: "GET" });
    const data = await res.json();
    return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
  }

  async model() {
    if (!this._model) {
      const list = await this.models();
      if (!list.length) throw new LLMError("The server lists no models. Set a model name in settings.");
      this._model = list[0];
    }
    return this._model;
  }

  /**
   * @returns {Promise<{content:string, reasoning:string, toolCalls:{id:string,name:string,arguments:string}[], finishReason:string, stats:object}>}
   */
  async chat({ messages, tools, model, stream = false, onDelta, signal, temperature, maxTokens, noThinking }) {
    const body = {
      model: model || (await this.model()),
      messages,
      temperature: temperature ?? this.s.temperature,
      max_tokens: maxTokens ?? this.s.maxTokens,
      stream,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    const level = noThinking ? "off" : this.s.thinking;
    if (level === "off") body.chat_template_kwargs = { enable_thinking: false }; // Qwen3 / llama.cpp / vLLM
    else if (EFFORTS.includes(level)) {
      // vLLM and OpenAI read the top-level field; llama.cpp passes the kwarg to templates such as gpt-oss.
      body.reasoning_effort = level;
      body.chat_template_kwargs = { reasoning_effort: level };
    }
    if (stream) body.stream_options = { include_usage: true }; // standard OpenAI field; servers that don't know it ignore it

    const started = Date.now();
    const res = await this._fetch("/chat/completions", { method: "POST", body: JSON.stringify(body), signal });
    if (!stream) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message || {};
      const chars = (msg.content || "").length + (msg.reasoning_content || msg.reasoning || "").length + (msg.tool_calls ? JSON.stringify(msg.tool_calls).length : 0);
      return {
        stats: replyStats({ usage: data.usage, timings: data.timings, started, firstAt: null, ended: Date.now(), chars }),
        content: stripThink(msg.content || ""),
        reasoning: msg.reasoning_content || msg.reasoning || "",
        toolCalls: (msg.tool_calls || []).map((c, i) => ({
          id: c.id || `call_${Date.now()}_${i}`,
          name: c.function?.name || "",
          arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments || {}),
        })),
        finishReason: data.choices?.[0]?.finish_reason || "",
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let raw = "";
    let reasoning = "";
    let finishReason = "";
    let usage = null;
    let timings = null;
    let firstAt = null;
    const calls = [];
    const handle = (line) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      if (chunk.usage) usage = chunk.usage;
      if (chunk.timings) timings = chunk.timings;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || {};
      if (firstAt == null && (d.content || d.reasoning_content || d.reasoning || d.tool_calls)) firstAt = Date.now();
      if (d.content) raw += d.content;
      if (d.reasoning_content || d.reasoning) reasoning += d.reasoning_content || d.reasoning;
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] ||= { id: "", name: "", arguments: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
      onDelta?.(stripThink(raw), reasoning);
    };
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (e.name === "TimeoutError") throw new LLMError("The model server stopped responding mid-reply.");
        throw e;
      }
      const { done, value } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      lines.forEach((l) => handle(l.trim()));
    }
    if (buf.trim()) handle(buf.trim());
    const chars = raw.length + reasoning.length + calls.reduce((n, c) => n + (c?.name.length || 0) + (c?.arguments.length || 0), 0);
    return {
      stats: replyStats({ usage, timings, started, firstAt, ended: Date.now(), chars }),
      content: stripThink(raw),
      reasoning,
      toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` })),
      finishReason,
    };
  }

  /**
   * Scores each document's relevance to the query with a reranker model (`POST /rerank`, as served by vLLM, llama.cpp
   * and Infinity). Returns one score per document, in document order; documents the server left out score 0.
   * `onStats` hears about each request: { model, ms, tokens, items }.
   */
  async rerank({ query, documents, model, signal, onStats }) {
    const scores = new Array(documents.length).fill(0);
    model ||= this.s.rerankModel;
    // A few dozen passages per request keeps each one well inside the request timeout.
    for (let start = 0; start < documents.length; start += RERANK_BATCH) {
      const batch = documents.slice(start, start + RERANK_BATCH);
      const started = Date.now();
      const res = await this._fetch("/rerank", { method: "POST", body: JSON.stringify({ model, query, documents: batch }), signal });
      const data = await res.json();
      onStats?.({ model, ms: Date.now() - started, tokens: data.usage?.total_tokens ?? data.usage?.prompt_tokens, items: batch.length });
      for (const r of data.results || data.data || []) {
        const score = r.relevance_score ?? r.score;
        if (Number.isInteger(r.index) && r.index >= 0 && r.index < batch.length && Number.isFinite(score)) scores[start + r.index] = score;
      }
    }
    return scores;
  }

  /**
   * Asks a decision model a question about `text` and returns one of `options`. Small classifiers served on
   * /chat/completions take the question as the system message and the options as a JSON-schema enum; any model with
   * structured output answers the same request. `onStats` hears about the request: { model, ms, tokens, answer }.
   */
  async decide({ question, text, options = ["yes", "no"], model, signal, onStats }) {
    model ||= this.s.decisionModel;
    const body = {
      model,
      messages: [{ role: "system", content: question }, { role: "user", content: text }],
      temperature: 0,
      max_tokens: 64,
      response_format: {
        type: "json_schema",
        json_schema: { name: "decision", schema: { type: "object", properties: { answer: { type: "string", enum: options } }, required: ["answer"] } },
      },
    };
    const started = Date.now();
    const res = await this._fetch("/chat/completions", { method: "POST", body: JSON.stringify(body), signal });
    const data = await res.json();
    const content = stripThink(data.choices?.[0]?.message?.content || "");
    let answer;
    try {
      answer = JSON.parse(content).answer;
    } catch {}
    onStats?.({ model, ms: Date.now() - started, tokens: data.usage?.total_tokens, answer });
    if (!options.includes(answer)) throw new LLMError(`The decision model didn't give one of ${options.join("/")} (it said “${content.slice(0, 80)}”).`);
    return answer;
  }

  /** GET a server-root info page (llama.cpp /props, /health); null when the server has none. */
  async _info(path) {
    try {
      return await (await this._fetch(`/~${path}`, { method: "GET" })).json();
    } catch {
      return null;
    }
  }

  /**
   * Which thinking levels the server takes. Reads what the server reports about itself, then confirms with small
   * requests: whether the model thinks at all, whether "off" stops it, and (when nothing listed efforts) which effort
   * values are accepted without an error.
   * @returns {Promise<{levels:string[], serverDefault:string|null, thinks:boolean, source:string, verified:boolean}>}
   */
  async thinkingSupport() {
    const [health, props] = await Promise.all([this._info("/health"), this._info("/props")]);
    let efforts = null;
    let serverDefault = null;
    let source = "test requests";
    if (Array.isArray(health?.reasoning_effort_values)) {
      efforts = health.reasoning_effort_values.filter((v) => EFFORTS.includes(v));
      serverDefault = health.reasoning_effort_default || null;
      source = "the server's /health report";
    } else if (typeof props?.chat_template === "string") {
      efforts = templateEfforts(props.chat_template);
      serverDefault = props.chat_template.match(/reasoning_effort\s*\|\s*default\(\s*['"]([a-z]+)['"]/)?.[1] || null;
      source = "the model's chat template";
    }

    const probe = (thinking) =>
      new LLM({ ...this.s, thinking, model: this._model }).chat({
        messages: [{ role: "user", content: "What is 12 + 30? Reply with the number only." }],
        temperature: 0, maxTokens: 256,
      });
    const thinks = !!(await probe("default")).reasoning;
    const levels = [];
    if (thinks && !(await probe("off").catch(() => ({ reasoning: "?" }))).reasoning) levels.push("off");
    let verified = !!efforts;
    if (!efforts) {
      // Nothing listed the values: keep each one the server accepts. Accepting one doesn't prove it changes anything.
      efforts = [];
      for (const e of ["low", "medium", "high"]) if (await probe(e).then(() => true, () => false)) efforts.push(e);
      verified = false;
    }
    if (thinks || verified) levels.push(...efforts.sort(byEffort));
    return { levels, serverDefault, thinks, source, verified };
  }
}
