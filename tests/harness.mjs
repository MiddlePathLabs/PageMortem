// Test harness: loads the extension's classic scripts into a VM context with a fake `browser` API, fake pages and a
// scripted model. Timers and the clock run TIME_SCALE times faster so navigation waits don't slow the suite down.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIME_SCALE = 20;

export function load(files, extra = {}) {
  const t0 = Date.now();
  class FastDate extends Date {
    static now() {
      return t0 + (Date.now() - t0) * TIME_SCALE;
    }
  }
  const ctx = vm.createContext({
    console, URL, TextDecoder, TextEncoder, AbortController, AbortSignal, DOMException, Blob, crypto, structuredClone,
    Date: FastDate,
    setTimeout: (fn, ms = 0, ...a) => setTimeout(fn, ms / TIME_SCALE, ...a),
    clearTimeout,
    ...extra,
  });
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  // Top-level classes and consts aren't properties of the global object; expose them by name.
  ctx.$ = (name) => vm.runInContext(name, ctx);
  return ctx;
}

export const AGENT_FILES = ["lib/settings.js", "lib/llm.js", "lib/tabs.js", "lib/save.js", "lib/markdown.js", "lib/skills.js", "lib/agent.js"];

/**
 * A fake web. `sites[url]` describes a page: { title, text, elements: { [id]: info & { onClick?(tab, web) } },
 * redirect?: url, hang?: true }. Unknown URLs get an empty page.
 */
export class Web {
  constructor(sites) {
    this.sites = sites;
    this.tabs = new Map();
    this.nextTab = 100;
    this.log = []; // actions that reached a page: [op, url, args]
    this.docSeq = 0;
    this.downloads = []; // { id, url, filename, state, mime, headers, removed, cancelled }
    this.granted = new Set(["downloads"]); // Firefox optional permissions already granted
    this.mimeFor = () => "image/jpeg";
    this.notifications = [];
  }

  page(url) {
    const spec = this.sites[url] || { title: url, text: "" };
    if (spec.redirect) return this.page(spec.redirect);
    return { url, spec, doc: `doc${++this.docSeq}`, elements: structuredClone(Object.fromEntries(Object.entries(spec.elements || {}).map(([k, v]) => [k, { ...v, onClick: undefined, onKey: undefined }]))) };
  }

  addTab(url, extra = {}) {
    const id = extra.id ?? this.nextTab++;
    const tab = { id, windowId: 1, status: "complete", active: false, title: "", history: [], future: [], ...extra };
    this.tabs.set(id, tab);
    this.navigate(tab, url, { push: false });
    return tab;
  }

  navigate(tab, url, { push = true } = {}) {
    if (push && tab.doc) tab.history.push(tab.doc.url);
    if (push) tab.future = [];
    tab.doc = this.page(url);
    tab.url = tab.doc.url;
    tab.title = tab.doc.spec.title || tab.url;
  }

  view(tab) {
    const { doc, history, future, ...rest } = tab;
    return { ...rest };
  }

  browser() {
    const web = this;
    const get = (id) => {
      const t = web.tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      return t;
    };
    return {
      permissions: { contains: async ({ permissions }) => permissions.every((p) => web.granted.has(p)) },
      downloads: {
        download: async (o) => {
          const d = { id: web.downloads.length + 1, ...o, state: "complete", mime: web.mimeFor(o.url) };
          web.downloads.push(d);
          return d.id;
        },
        search: async ({ id }) => web.downloads.filter((d) => d.id === id).map((d) => ({ ...d })),
        cancel: async (id) => void (web.downloads[id - 1].cancelled = true),
        removeFile: async (id) => void (web.downloads[id - 1].removed = true),
        erase: async () => [],
      },
      notifications: { create: async (o) => void web.notifications.push(o) },
      runtime: { getURL: (p) => `moz-extension://test/${p}`, getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      scripting: { executeScript: async () => [] },
      tabs: {
        get: async (id) => web.view(get(id)),
        query: async (q = {}) => [...web.tabs.values()].filter((t) => (q.active == null || t.active === q.active) && (q.windowId == null || t.windowId === q.windowId)).map((t) => web.view(t)),
        create: async ({ url, openerTabId }) => web.view(web.addTab(url, { openerTabId })),
        remove: async (ids) => [].concat(ids).forEach((id) => web.tabs.delete(id)),
        update: async (id, { active, url }) => {
          const t = get(id);
          if (active) for (const o of web.tabs.values()) o.active = o.id === id;
          if (url) web.navigate(t, url);
          return web.view(t);
        },
        // `onReload(tab, web)` runs before each reload: change the page's text, or return a URL to redirect to.
        reload: async (id) => {
          const t = get(id);
          t.reloads = (t.reloads || 0) + 1;
          const to = web.sites[t.url]?.onReload?.(t, web);
          web.navigate(t, to || t.url, { push: false });
        },
        goBack: async (id) => {
          const t = get(id);
          const prev = t.history.pop();
          if (prev) {
            t.future.push(t.url);
            web.navigate(t, prev, { push: false });
          }
        },
        goForward: async (id) => {
          const t = get(id);
          const next = t.future.pop();
          if (next) {
            t.history.push(t.url);
            web.navigate(t, next, { push: false });
          }
        },
        captureVisibleTab: async () => "data:image/png;base64,AAAA",
        sendMessage: async (id, msg) => web.handle(get(id), msg.op, msg.args || {}),
      },
    };
  }

  /** What the content script would do, including its document and target checks. */
  async handle(tab, op, args) {
    const d = tab.doc;
    if (op === "ping") return { ok: true };
    if (d.spec.hang) return new Promise(() => {});
    const fail = (error) => ({ error });
    if (args.doc && args.doc !== d.doc) return fail("The page changed since it was read. Read the page again to get fresh numbers.");
    const el = args.id != null ? d.elements[args.id] : null;
    if (args.id != null && !el && op !== "readPage") return fail(`Element [${args.id}] is gone. Read the page again to get fresh numbers.`);
    const base = { url: tab.url, title: tab.title, doc: d.doc };
    switch (op) {
      case "readPage":
        return { ...base, part: 1, parts: 1, text: d.spec.text || "" };
      case "find": {
        // Lines of the page text that contain the query; the element is the first [N …] on the line.
        const q = args.query.toLowerCase();
        const lines = (d.spec.text || "").split("\n").filter((l) => l.toLowerCase().includes(q));
        const matches = lines.slice(0, 10).map((l) => {
          const id = /\[(\d+) (\w+)/.exec(l);
          return { part: 1, id: id ? Number(id[1]) : null, kind: id ? id[2] : "text", text: l };
        });
        return { ...base, matches, total: lines.length, parts: 1 };
      }
      case "meta":
        return { ...base, scroll: { y: 0, height: 1000, viewport: 800 } };
      case "describe":
        return { kind: "button", tag: "BUTTON", label: "", href: "", download: false, inForm: false, formMethod: "get", isSubmit: false, sensitive: false, visible: true, disabled: false, searchField: false, ...el, doc: d.doc };
      case "click": {
        if (el.hidden) return fail(`[${args.id}] is hidden. Read the page again.`);
        this.log.push(["click", tab.url, args]);
        const behaviour = d.spec.elements[args.id].onClick;
        if (behaviour) behaviour(tab, this);
        else if (el.href) this.navigate(tab, el.href);
        return { ok: true };
      }
      case "type":
        if (el.sensitive) return fail("Refused: this is a password/payment/ID field. Ask the user to fill it in.");
        this.log.push(["type", tab.url, args]);
        if (args.submit && el.submitTo) this.navigate(tab, el.submitTo);
        return { ok: true };
      case "pressKey": {
        // Mirrors the content script: focus keys move focus, Enter/Space on a control behave like its click, Enter
        // in a field submits, scroll keys scroll. `onKey(tab, web, key)` lets a page handle (and cancel) a key itself.
        if (el.sensitive) return fail("Refused: this is a password/payment/ID field.");
        this.log.push(["key", tab.url, args]);
        const spec = d.spec.elements[args.id];
        if (spec.onKey?.(tab, this, args.key)) return { ok: true, cancelled: true };
        if (args.key === "Tab" || args.key === "Shift+Tab") return { ok: true, focused: { id: 99, kind: "input", label: "Next field" } };
        if (el.kind === "input") {
          if (args.key === "Enter" && el.submitTo) this.navigate(tab, el.submitTo);
          return { ok: true, action: args.key === "Enter" ? "submit" : undefined };
        }
        if (args.key === "Enter" || args.key === "Space") {
          if (spec.onClick) spec.onClick(tab, this);
          else if (el.href && args.key === "Enter") this.navigate(tab, el.href);
          return { ok: true, action: "activate" };
        }
        if (["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"].includes(args.key)) return { ok: true, action: "scroll", y: 100, height: 1000, atBottom: false };
        return { ok: true };
      }
      case "waitFor": {
        // `onWait(tab, web)` changes the page while the agent waits, e.g. results arriving or a redirect.
        this.log.push(["wait", tab.url, args]);
        d.spec.onWait?.(tab, this);
        if (tab.doc !== d) throw new Error("Could not establish connection. Receiving end does not exist.");
        const has = (q) => (tab.doc.spec.text || "").toLowerCase().includes(q.toLowerCase());
        const met = (!args.text || has(args.text)) && (!args.gone || !has(args.gone));
        return { met, waited: met ? 1200 : args.timeoutMs };
      }
      case "select":
        this.log.push(["select", tab.url, args]);
        return { ok: true, selected: args.value };
      case "scroll":
        if (args.direction === "top") tab.scrollIdx = 0;
        else if (args.direction === "down") tab.scrollIdx = (tab.scrollIdx || 0) + 1;
        return { y: 100, height: 1000, atBottom: false };
      case "listImages": {
        // spec.screens: one list of { src, alt?, loaded? } per screenful, top to bottom.
        const screens = d.spec.screens || [];
        const i = Math.min(tab.scrollIdx || 0, Math.max(0, screens.length - 1));
        const images = (screens[i] || []).map((im, k) => ({ id: 900 + k, rect: { x: k * 100, y: i, w: 90, h: 90 } /* y = screen index, so tests can tell crops apart */, loaded: true, alt: "", ...im }));
        return { images, viewport: { w: 1280, h: 800 }, atBottom: i >= screens.length - 1, doc: d.doc };
      }
      case "highlight":
        this.log.push(["highlight", tab.url, args]);
        return { ok: true };
      case "markImages":
        return { images: [], doc: d.doc, viewport: { w: 1280, h: 800 } };
      case "rect":
        return { rect: { x: 0, y: 0, w: 10, h: 10 }, viewport: { w: 1280, h: 800 } };
      case "clearMarks":
        return { ok: true };
      default:
        return fail(`unknown op ${op}`);
    }
  }
}

/** A model that replays scripted replies. Each entry: a reply object, or a function(messages) returning one. */
export function scriptedModel(replies) {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      if (req.signal?.aborted) throw req.signal.reason;
      const next = replies.shift();
      if (!next) return { content: "Out of script.", toolCalls: [], reasoning: "", finishReason: "stop" };
      const r = typeof next === "function" ? await next(req.messages, req) : next;
      return { content: "", toolCalls: [], reasoning: "", finishReason: "stop", ...r };
    },
  };
}

let callSeq = 0;
/** Native OpenAI-style tool call reply. */
export const call = (name, args = {}) => ({ toolCalls: [{ id: `c${++callSeq}`, name, arguments: JSON.stringify(args) }] });
export const answer = (text) => call("finish", { answer: text });

/** UI double: records approval cards; `decide(card)` returns "yes" | "no" | "all". */
export function fakeUi(decide = () => "no") {
  const cards = [];
  const steps = [];
  return {
    cards,
    steps,
    step: (icon, text) => {
      const s = { icon, text, status: "running" };
      steps.push(s);
      return { update: (t) => (s.text = t), ok: () => (s.status = "ok"), fail: (m) => ((s.status = "fail"), (s.error = m)) };
    },
    confirm: async (card) => {
      cards.push(card);
      return decide(card, cards.length);
    },
    image: () => {},
  };
}

export const SETTINGS = {
  endpoint: "http://127.0.0.1:9/v1", apiKey: "", model: "m", visionModel: "", toolMode: "native", temperature: 0.3,
  maxTokens: 512, maxPageChars: 4000, maxSteps: 12, confirmAll: false, stayOnSite: true, closeAgentTabs: true,
  screenshotWidth: 800,
};

/** Builds an agent wired to a fake web. Returns everything a test might inspect. */
export function setup({ sites, start = "https://shop.example/", userTabs = [], replies = [], decide, settings = {} }) {
  const web = new Web(sites);
  const ctx = load(AGENT_FILES, { browser: web.browser() });
  const startTab = web.addTab(start, { id: 1, active: true });
  const others = userTabs.map((u, i) => web.addTab(u, { id: 2 + i }));
  const model = scriptedModel(replies);
  const ui = fakeUi(decide);
  const agent = new (ctx.$("Agent"))({ settings: { ...SETTINGS, ...settings }, llm: model, windowId: 1, ui });
  return { ctx, web, agent, model, ui, startTab, others, run: (task = "do the task", opts = {}) => agent.run(task, { tabId: 1, ...opts }) };
}

/** Text of the tool result messages the model received, in order. */
export const results = (agent) => agent.messages.filter((m) => m.role === "tool" || (m.role === "user" && /^Result of /.test(m.content))).map((m) => m.content);
