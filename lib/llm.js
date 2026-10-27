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
    this.started = Date.now();
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
    if (!this.calls) return null;
    const n = (x) => Math.round(x).toLocaleString("en-US");
    const sec = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
    const tps = this.genMs > 0 ? this.completion / (this.genMs / 1000) : 0;
    const approx = this.estimated ? "~" : "";
    const parts = [];
    if (tps) parts.push(`${approx}${tps.toFixed(1)} tok/s`);
    parts.push(`${approx}${n(this.completion)} tokens out`);
    if (this.prompt) parts.push(`${n(this.prompt)} in${this.cached ? ` (${n(this.cached)} cached)` : ""}`);
    if (this.calls > 1) parts.push(`${this.calls} requests`);
    parts.push(sec(Date.now() - this.started));
    const tip = [];
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
    async chat(opts) {
      const r = await llm.chat(opts);
      meter.add(r.stats);
      return r;
    },
  };
}

// Slow local models can take minutes on long prompts, but a request that never ends must not hang the UI.
const LLM_TIMEOUT = 300000;

class LLM {
  constructor(settings) {
    this.s = settings;
    this._model = settings.model || "";
  }

  url(path) {
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
    if (this.s.disableThinking || noThinking) body.chat_template_kwargs = { enable_thinking: false };
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
}
