// Lantern sidebar: UI plus all model traffic (bound by the manifest's connect-src lock).
"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const state = {
  settings: null,
  llm: null,
  windowId: null,
  mode: "ask",
  running: null, // { stop() }
  chat: new Chat(),
  translated: new Set(), // tab ids translated in place
  confirms: new Set(), // resolvers of open approval prompts
  keepPages: false, // Ask: keep earlier pages in the conversation when the page changes
  sessionGrants: new Set(), // agent "Always allow" choices, kept until a new conversation
};

// ---------- log rendering ----------
const log = $("log");
// Auto-scroll: while "pinned", the log follows new output, including content that grows later (images loading,
// cards, the final answer). Scrolling up unpins it and shows "Latest"; scrolling back down, pressing "Latest",
// sending a message or an approval card pins it again.
let pinned = true;
let autoTop = 0; // where auto-scroll last put the view, to tell our own scrolling apart from the user's
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
function updateJump() {
  $("jump").hidden = pinned || log.scrollHeight <= log.clientHeight;
}
function stick() {
  if (!pinned) return;
  log.scrollTop = log.scrollHeight;
  autoTop = log.scrollTop;
  updateJump();
}
const scrollDown = (force) => {
  if (force) pinned = true;
  stick();
};
log.addEventListener(
  "scroll",
  () => {
    // Content added between our scroll and this event mustn't count as the user leaving the bottom.
    pinned = nearBottom() || log.scrollTop >= autoTop - 1;
    updateJump();
  },
  { passive: true },
);
// Observer callbacks already batch changes, so they can scroll straight away.
new MutationObserver(stick).observe(log, { childList: true, subtree: true, characterData: true });
log.addEventListener("load", stick, true); // images get their height only once loaded
new ResizeObserver(stick).observe(log); // sidebar resized

function showWelcome() {
  log.replaceChildren();
  const w = el("div", "welcome");
  w.append(
    el("h2", null, "Ask, summarize, translate, or delegate."),
    el("p", null, "Ask answers from the page you're on. Select several tabs (Ctrl+click their tabs) to compare them. Agent can click through pages to finish a task, and asks before anything risky."),
  );
  const ex = el("div", "examples");
  const examples = [
    ["agent", "Summarize the last three releases"],
    ["ask", "Compare these products in a table"],
    ["agent", "Find a photo of a dog in this gallery"],
    ["ask", "What are the key points I should know?"],
  ];
  for (const [mode, text] of examples) {
    const b = el("button", null, (mode === "agent" ? "Agent · " : "Ask · ") + text);
    b.addEventListener("click", () => {
      setMode(mode);
      $("input").value = text;
      $("input").focus();
    });
    ex.append(b);
  }
  w.append(ex);
  log.append(w);
}

function addUser(text) {
  log.querySelector(".welcome")?.remove();
  log.append(el("div", "msg user", text));
  scrollDown(true);
}

function addBot({ agent = false } = {}) {
  log.querySelector(".welcome")?.remove();
  const wrap = el("div", "msg bot");
  let steps = null, list = null, summary = null, count = 0, lastLi = null;
  if (agent) {
    steps = el("details", "steps");
    steps.open = true;
    summary = el("summary", null, "Working");
    list = el("ol");
    steps.append(summary, list);
    wrap.append(steps);
  }
  const extra = el("div");
  const body = el("div", "md");
  const thinking = el("div", "thinking", agent ? "Planning" : "Thinking");
  body.append(thinking);
  wrap.append(extra, body);
  log.append(wrap);
  scrollDown(true);

  // Model text is escaped, parsed inertly and allowlist-filtered. Links work only to pages the answer came from.
  let links = new Set();
  const show = (md) => body.replaceChildren(...markdownNodes(md, { links }));
  let frame = 0, pendingText = "";
  const api = {
    /** Origins the answer may link to (a live Set is fine: the agent adds pages as it reads them). */
    links(origins) {
      links = origins;
    },
    stream(text) {
      pendingText = text;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pendingText) show(pendingText); // auto-scroll follows if pinned
      });
    },
    set(text) {
      cancelAnimationFrame(frame);
      frame = 0;
      show(text || "_(empty reply)_");
      scrollDown();
    },
    note(text) {
      extra.append(el("div", "dimline", text));
    },
    /** Speed and token counts for the whole run, under the reply. */
    stats(meter) {
      const s = state.settings.showStats && meter.summary();
      if (!s) return;
      wrap.querySelector(":scope > .stats")?.remove();
      const line = el("div", "stats", s.text);
      if (s.title) line.title = s.title;
      wrap.append(line);
    },
    step(icon, text, { dim = false } = {}) {
      thinking.textContent = "Working";
      lastLi?.classList.remove("running");
      const li = el("li", dim ? "dim" : "running");
      const tx = el("span", "tx", text);
      li.append(el("span", "ic", icon), tx);
      list.append(li);
      if (!dim) {
        count++;
        summary.textContent = `Working · ${count} step${count === 1 ? "" : "s"}`;
        lastLi = li;
      }
      scrollDown();
      return {
        update: (t) => (tx.textContent = t),
        ok: () => li.classList.remove("running"),
        fail: (m) => {
          li.classList.remove("running");
          li.classList.add("fail");
          li.append(el("div", "err", m));
        },
      };
    },
    /** Small thumbnails in one grid per run of saves (save_images). */
    thumb(url) {
      let grid = list.lastElementChild?.querySelector(":scope > .thumbs");
      if (!grid) {
        const li = el("li");
        grid = el("div", "thumbs");
        li.append(el("span", "ic", ""), grid);
        list.append(li);
      }
      const img = el("img");
      img.src = url;
      img.alt = "Saved image";
      grid.append(img);
      scrollDown();
    },
    image(url) {
      const li = el("li");
      const img = el("img", "shot");
      img.src = url;
      img.alt = "Screenshot the model looked at";
      img.title = "Click to enlarge";
      img.addEventListener("click", () => img.classList.toggle("big"));
      li.append(el("span", "ic", ""), img);
      list.append(li);
      scrollDown();
    },
    /**
     * allowAll: label of a scoped "allow all for this task" button; remember: label of an "always allow for this
     * session" button. Either is null when the action must be approved on its own. permissions: optional Firefox
     * permissions to request when the user allows (Firefox only shows its prompt from inside a click handler).
     */
    confirm({ title, detail, allowAll = null, remember = null, permissions = null }) {
      return new Promise((resolve) => {
        const card = el("div", "confirm");
        card.append(el("div", "title", title), el("div", "detail", detail || ""));
        const row = el("div", "row");
        const finish = (ans, label) => {
          state.confirms.delete(finish);
          card.classList.add("answered");
          card.append(el("div", "dimline", label));
          resolve(ans);
        };
        const mk = (label, ans, cls, after) => {
          const b = el("button", "btn " + (cls || ""), label);
          b.addEventListener("click", () => {
            if (!permissions?.length || ans === "no") return finish(ans, after);
            browser.permissions.request({ permissions }).then(
              (granted) => finish(granted ? ans : "no", granted ? after : "Firefox permission declined"),
              () => finish("no", "Firefox permission declined"),
            );
          });
          return b;
        };
        row.append(mk("Allow", "yes", "primary", "Allowed"));
        if (allowAll) row.append(mk(allowAll, "all", "", `${allowAll}: allowed for the rest of this task`));
        if (remember) row.append(mk(remember, "session", "", `${remember}: allowed until you start a new conversation`));
        row.append(mk("Deny", "no", "", "Denied"));
        card.append(row);
        (list ? list.parentElement : extra).after(card);
        state.confirms.add(finish);
        scrollDown(true);
        row.firstChild.focus();
      });
    },
    progress(done, total, label) {
      let bar = wrap.querySelector(".progress > div");
      if (!bar) {
        const p = el("div", "progress");
        bar = el("div");
        p.append(bar);
        extra.append(p);
      }
      bar.style.width = `${total ? Math.round((100 * done) / total) : 0}%`;
      thinking.textContent = label;
    },
    error(e) {
      lastLi?.classList.remove("running");
      const box = el("div", "error", e.message || String(e));
      if (e instanceof LLMError) {
        const row = el("div", "row");
        const b = el("button", "btn", "Open settings");
        b.addEventListener("click", () => browser.runtime.openOptionsPage());
        row.append(b);
        box.append(row);
      }
      body.replaceChildren(box);
      scrollDown();
    },
    finish() {
      lastLi?.classList.remove("running");
      if (steps) {
        summary.textContent = `${count} step${count === 1 ? "" : "s"}`;
        steps.open = false;
      }
    },
  };
  return api;
}

// ---------- running state ----------
function setRunning(r) {
  state.running = r;
  const send = $("send");
  send.textContent = r ? "Stop" : "Send";
  send.classList.toggle("stop", !!r);
  send.setAttribute("aria-label", r ? "Stop" : "Send");
  for (const id of ["summarize", "translate", "restore", "newChat"]) $(id).disabled = !!r;
}

function stopRunning() {
  for (const resolve of [...state.confirms]) resolve("no", "Stopped");
  state.running?.stop();
}

async function guard(fn) {
  if (state.running) return;
  try {
    await fn();
  } finally {
    setRunning(null);
    refreshContext();
  }
}

const isAbort = (e) => e?.name === "AbortError" || e instanceof StopError;

// ---------- actions ----------
async function activeTab() {
  const [tab] = await browser.tabs.query({ windowId: state.windowId, active: true });
  return tab;
}

async function runAsk(question) {
  const tabs = await contextTabs(state.windowId);
  const bot = addBot();
  const ctrl = new AbortController();
  const meter = new Meter();
  setRunning({ stop: () => ctrl.abort() });
  try {
    const pages = await readPages(tabs);
    for (const p of pages) if (p.error) bot.note(`Couldn't read “${p.title || p.url}”: ${p.error}`);
    bot.links(new Set(pages.map((p) => originOf(p.url))));
    const selection = pages.find((p) => p.tab.active)?.selection || "";
    if (selection) bot.note(`Including your selected text (${selection.length} chars).`);
    const { answer, fresh } = await state.chat.ask({
      question, pages, selection, llm: metered(state.llm, meter), settings: state.settings, keepPages: state.keepPages,
      onDelta: (t) => bot.stream(t), signal: ctrl.signal,
    });
    if (fresh) bot.note("Different page, so this started a fresh conversation. Turn on “Keep earlier pages” to compare with pages you asked about before.");
    bot.set(answer);
  } catch (e) {
    if (isAbort(e)) bot.note("Stopped.");
    else bot.error(e);
  } finally {
    bot.stats(meter);
  }
}

async function runAgent(task) {
  const tabs = await contextTabs(state.windowId);
  const active = await activeTab();
  const selection = await pageCall(active.id, "selection").then((r) => r.text).catch(() => "");
  const bot = addBot({ agent: true });
  const meter = new Meter();
  const agent = new Agent({
    settings: state.settings,
    llm: metered(state.llm, meter),
    windowId: state.windowId,
    sessionGrants: state.sessionGrants,
    ui: { step: (i, t, o) => bot.step(i, t, o), confirm: (o) => bot.confirm(o), image: (u) => bot.image(u), thumb: (u) => bot.thumb(u) },
  });
  bot.links(agent.sources);
  setRunning({ stop: () => agent.stop() });
  try {
    const answer = await agent.run(task, { tabId: active.id, otherTabs: tabs.filter((t) => t.id !== active.id), selection });
    bot.set(answer);
  } catch (e) {
    if (isAbort(e)) bot.set("_Stopped._");
    else bot.error(e);
  } finally {
    bot.finish();
    bot.stats(meter);
  }
}

async function runSummarize() {
  const tab = await activeTab();
  const ctrl = new AbortController();
  const meter = new Meter();
  setRunning({ stop: () => ctrl.abort() });
  const [page] = await readPages([tab]);
  const useSel = page.selection && page.selection.length > 40;
  addUser(useSel ? "Summarize the selected text" : "Summarize this page");
  const bot = addBot();
  try {
    if (page.error) throw new Error(page.error);
    const p = useSel ? { ...page, text: page.selection } : page;
    bot.links(new Set([originOf(page.url)]));
    const answer = await summarize({
      page: p, llm: metered(state.llm, meter), settings: state.settings, signal: ctrl.signal,
      onDelta: (t) => bot.stream(t),
      onProgress: (i, n) => bot.progress(i - 1, n, `Reading part ${i} of ${n}`),
    });
    bot.set(answer);
  } catch (e) {
    if (isAbort(e)) bot.note("Stopped.");
    else bot.error(e);
  } finally {
    bot.stats(meter);
  }
}

async function runTranslate(presetSelection) {
  const lang = $("lang").value;
  const tab = await activeTab();
  const ctrl = new AbortController();
  const meter = new Meter();
  const llm = metered(state.llm, meter);
  setRunning({ stop: () => ctrl.abort() });
  const selection = presetSelection || (await pageCall(tab.id, "selection").then((r) => r.text).catch(() => ""));

  if (selection) {
    addUser(`Translate selection into ${lang}`);
    const bot = addBot();
    try {
      bot.set(await translateText({ text: selection, lang, llm, onDelta: (t) => bot.stream(t), signal: ctrl.signal }));
    } catch (e) {
      if (isAbort(e)) bot.note("Stopped.");
      else bot.error(e);
    } finally {
      bot.stats(meter);
    }
    return;
  }

  addUser(`Translate this page into ${lang}`);
  const bot = addBot();
  try {
    const r = await translatePage({
      tabId: tab.id, lang, llm, settings: state.settings, signal: ctrl.signal,
      onProgress: (d, n) => bot.progress(d, n, `Translating ${d} of ${n} text pieces`),
    });
    state.translated.add(tab.id);
    if (!r.total) bot.set("There's no visible text to translate on this page.");
    else if (ctrl.signal.aborted) bot.set(`Stopped after ${r.done} of ${r.total} text pieces. Use **Show original** to undo.`);
    else bot.set(`Translated the page into ${lang}.${r.failed ? ` ${r.failed} pieces were left as they were.` : ""} Use **Show original** to undo. Text that appears later (menus, “load more”) isn't translated until you run it again.`);
  } catch (e) {
    if (isAbort(e)) bot.note("Stopped.");
    else bot.error(e);
  } finally {
    bot.stats(meter);
  }
}

async function runRestore() {
  const tab = await activeTab();
  try {
    await pageCall(tab.id, "restoreOriginal");
  } catch {
    /* page navigated away; nothing to restore */
  }
  state.translated.delete(tab.id);
  refreshContext();
}

function send() {
  if (state.running) return stopRunning();
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addUser(text);
  guard(() => (state.mode === "agent" ? runAgent(text) : runAsk(text)));
}

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll(".modes button")) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  $("input").placeholder = mode === "agent" ? "Describe a task, e.g. “summarize the last 3 releases”" : "Ask about this page…";
  $("keepWrap").hidden = mode !== "ask";
  browser.storage.local.set({ mode }).catch(() => {});
}

// ---------- status, permission, context ----------
function banner(text, actions = []) {
  $("banner").hidden = !text;
  $("bannerText").textContent = text || "";
  $("bannerActions").replaceChildren(...actions);
}

async function checkSetup() {
  const dot = $("dot");
  const label = $("model");
  dot.className = "dot";
  const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
  if (!granted) {
    const b = el("button", "btn primary", "Grant access");
    b.addEventListener("click", async () => {
      if (await browser.permissions.request({ origins: ["<all_urls>"] })) checkSetup();
    });
    banner("Lantern needs permission to read and act on pages. This doesn't open any network access; the model endpoint lock still applies.", [b]);
    dot.classList.add("bad");
    label.textContent = "Needs permission";
    return;
  }
  const lock = lockProblem(state.settings.endpoint);
  if (lock) {
    const b = el("button", "btn", "Open settings");
    b.addEventListener("click", () => browser.runtime.openOptionsPage());
    banner(lock, [b]);
    dot.classList.add("bad");
    label.textContent = "Endpoint blocked by lock";
    return;
  }
  try {
    const models = await state.llm.models();
    const name = state.settings.model || models[0] || "model";
    dot.classList.add("ok");
    label.textContent = state.settings.model ? name : `${name} (auto)`;
    label.title = `${state.settings.endpoint}${state.settings.visionModel ? ` · vision: ${state.settings.visionModel}` : ""}`;
    banner(null);
  } catch (e) {
    const retry = el("button", "btn", "Retry");
    retry.addEventListener("click", checkSetup);
    const settings = el("button", "btn", "Open settings");
    settings.addEventListener("click", () => browser.runtime.openOptionsPage());
    banner(e.message, [retry, settings]);
    dot.classList.add("bad");
    label.textContent = "Offline";
  }
}

let ctxTimer = 0;
function refreshContext() {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(async () => {
    const tabs = await contextTabs(state.windowId);
    const box = $("context");
    box.replaceChildren();
    if (tabs.length > 1) {
      box.append(el("b", null, `${tabs.length} tabs: `), document.createTextNode(tabs.map((t) => t.title).join(" · ")));
    } else if (tabs[0]) {
      box.append(el("b", null, "Page: "), document.createTextNode(tabs[0].title || tabs[0].url));
    }
    box.title = tabs.map((t) => t.url).join("\n");
    const active = tabs.find((t) => t.active) || tabs[0];
    $("restore").hidden = !(active && state.translated.has(active.id));
  }, 120);
}

async function consumePending() {
  const { pendingCommand: c } = await browser.storage.session.get("pendingCommand");
  if (!c || Date.now() - c.at > 15000) return;
  await browser.storage.session.remove("pendingCommand");
  if (state.running) return;
  if (c.kind === "translate") guard(() => runTranslate(c.selection));
  else if (c.kind === "translate-page") guard(() => runTranslate(""));
  else if (c.kind === "summarize") guard(runSummarize);
  else if (c.kind === "ask") {
    setMode("ask");
    $("input").focus();
  }
}

async function applySettings() {
  state.settings = await loadSettings();
  state.llm = new LLM(state.settings);
  checkSetup();
}

// ---------- init ----------
async function init() {
  state.windowId = (await browser.windows.getCurrent()).id;
  const langSel = $("lang");
  for (const l of LANGUAGES) langSel.append(new Option(l, l));
  await applySettings();
  if (!LANGUAGES.includes(state.settings.language)) langSel.append(new Option(state.settings.language, state.settings.language));
  langSel.value = state.settings.language;
  langSel.addEventListener("change", () => saveSettings({ language: langSel.value }));

  const { mode, askKeepPages } = await browser.storage.local.get(["mode", "askKeepPages"]);
  setMode(mode === "agent" ? "agent" : "ask");
  state.keepPages = !!askKeepPages;
  $("keepPages").checked = state.keepPages;
  $("keepPages").addEventListener("change", (e) => {
    state.keepPages = e.target.checked;
    browser.storage.local.set({ askKeepPages: state.keepPages }).catch(() => {});
  });
  showWelcome();
  refreshContext();

  $("send").addEventListener("click", send);
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.running) stopRunning();
  });
  $("input").addEventListener("input", (e) => {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(160, e.target.scrollHeight) + "px";
  });
  for (const b of document.querySelectorAll(".modes button")) b.addEventListener("click", () => setMode(b.dataset.mode));
  $("summarize").addEventListener("click", () => guard(runSummarize));
  $("translate").addEventListener("click", () => guard(() => runTranslate("")));
  $("restore").addEventListener("click", runRestore);
  $("jump").addEventListener("click", () => scrollDown(true));
  $("newChat").addEventListener("click", () => {
    state.chat.reset();
    state.sessionGrants.clear();
    showWelcome();
  });
  $("openSettings").addEventListener("click", () => browser.runtime.openOptionsPage());

  const mine = (info) => info.windowId === state.windowId;
  browser.tabs.onActivated.addListener((i) => mine(i) && refreshContext());
  browser.tabs.onHighlighted.addListener((i) => mine(i) && refreshContext());
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.status === "loading") state.translated.delete(id);
    if (tab.windowId === state.windowId && (change.title || change.status)) refreshContext();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings && !state.running) applySettings();
  });
  browser.runtime.onMessage.addListener((m) => {
    if (m?.type === "lantern:command") consumePending();
  });
  consumePending();
}

init();
