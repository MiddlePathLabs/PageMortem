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
    let res;
    try {
      res = await fetch(this.url(path), { ...init, headers: this.headers() });
    } catch (e) {
      if (e.name === "AbortError") throw e;
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
   * @returns {Promise<{content:string, reasoning:string, toolCalls:{id:string,name:string,arguments:string}[], finishReason:string}>}
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

    const res = await this._fetch("/chat/completions", { method: "POST", body: JSON.stringify(body), signal });
    if (!stream) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message || {};
      return {
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
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || {};
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
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      lines.forEach((l) => handle(l.trim()));
    }
    if (buf.trim()) handle(buf.trim());
    return {
      content: stripThink(raw),
      reasoning,
      toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` })),
      finishReason,
    };
  }
}
