// PageMortem sidebar: UI plus all model traffic (bound by the manifest's connect-src lock).
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
  // The active tab's conversation; chat, sessionGrants, contextPages and excludedPages below are its parts.
  thread: null,
  chat: new Chat(),
  translated: new Set(), // tab ids translated in place
  confirms: new Set(), // resolvers of open approval prompts
  keepPages: false, // Ask: keep earlier pages in the conversation when the page changes
  sessionGrants: new Set(), // agent "Always allow" choices, kept until a new conversation
  contextPages: new Map(),
  excludedPages: new Set(),
  contextTabs: [],
  contextBusy: false,
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

function addUser(text, { replay = false } = {}) {
  log.querySelector(".welcome")?.remove();
  log.append(el("div", "msg user", text));
  scrollDown(true);
  if (!replay) record({ kind: "user", text });
}

/** A "Show on page" button that highlights a quote in its source tab, with a status line for the outcome. */
function passageButton(source, quote, onError) {
  const button = el("button", "linkish", "Show on page");
  const status = el("p", "citation-status");
  status.setAttribute("role", "status");
  const show = async (trigger = button) => {
    if (button.disabled) return;
    button.disabled = true;
    trigger.disabled = true;
    status.textContent = "Locating passage…";
    try {
      const tab = await browser.tabs.get(source.tabId).catch(() => null);
      if (!tab) throw new Error("The source tab is closed. The quoted snapshot is still available here.");
      if (tab.url !== source.url) throw new Error("The source tab has navigated. The quoted snapshot is still available here.");
      await browser.tabs.update(tab.id, { active: true });
      await pageCall(tab.id, "showPassage", { quote, url: source.url, doc: source.doc });
      status.textContent = "Highlighted for 30 seconds. Press Esc or click the page to clear it.";
    } catch (e) {
      status.textContent = e.message || String(e);
      onError?.();
    } finally {
      button.disabled = false;
      trigger.disabled = false;
    }
  };
  button.addEventListener("click", () => show());
  return { button, status, show };
}

// ---------- sources for Ask and Summarize answers ----------
// Nothing shows until asked: hovering a paragraph or bullet offers "source", and selecting part of an answer offers the
// sources of every point it touches. Local matches (lib/evidence.js) show at once; only weak ones go to the model.
const evidenceAnswers = new Set(); // { body, claims: Map<block, claim>, reveal(claims) }

/** A block's own words: without nested lists, our own controls, or a bold "Label:" lead-in. */
function claimText(block) {
  let text = "";
  for (const node of block.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE && node.matches("ul, ol, .evidence, .claim-src")) continue;
    text += node.textContent;
  }
  const lead = block.firstElementChild;
  if (lead?.tagName === "STRONG" && /:\s*$/.test(lead.textContent) && text.trimStart().startsWith(lead.textContent)) {
    text = text.trimStart().slice(lead.textContent.length);
  }
  return text.trim();
}

function attachEvidence(body, sources) {
  const evidence = new Evidence(sources);
  if (!evidence.sentences.length) return;
  const manyPages = new Set(evidence.sources.map((s) => `${s.tabId}|${s.url}`)).size > 1;
  const claims = new Map();

  const render = (claim) => {
    const { panel, result } = claim;
    panel.className = "evidence";
    if (!result) {
      panel.replaceChildren(el("p", "citation-status", "Looking for the passage on the page…"));
      return;
    }
    if (result.kind === "none" || result.kind === "error") {
      panel.classList.add("missing");
      panel.replaceChildren(el("p", "citation-status", result.kind === "error"
        ? `Couldn't check this point: ${result.message}`
        : "Not found on the page. This point may come from the model rather than the page."));
      return;
    }
    const parts = [];
    if (result.kind === "weak") parts.push(el("p", "citation-status", "Closest passage, a weak match:"));
    parts.push(el("q", null, result.quote));
    if (manyPages) parts.push(el("div", "source-url", result.source.title || result.source.url));
    const { button, status } = passageButton(result.source, result.quote);
    parts.push(" ", button, status);
    panel.replaceChildren(...parts);
  };

  const resolve = async (list) => {
    const ask = [];
    for (const claim of list) {
      if (claim.pending || (claim.result && claim.result.kind !== "error")) continue;
      if (claim.local?.score >= STRONG_MATCH) claim.result = { ...claim.local, kind: "match" };
      else {
        claim.result = null;
        claim.pending = true;
        ask.push(claim);
      }
    }
    list.forEach(render);
    if (!ask.length) return;
    let found = [], failure = null;
    try {
      found = await modelEvidence({ claims: ask.map((c) => c.text), evidence, llm: state.llm });
    } catch (e) {
      failure = e;
    }
    ask.forEach((claim, i) => {
      claim.pending = false;
      const fallback = claim.local?.score >= WEAK_MATCH ? { ...claim.local, kind: "weak" } : null;
      if (found[i]) claim.result = { ...found[i], kind: "match" };
      else if (failure) claim.result = fallback || { kind: "error", message: failure.message || String(failure) };
      else claim.result = fallback || { kind: "none" };
      if (claim.panel.isConnected) render(claim);
    });
  };

  /** Shows the sources of these claims; if all are already showing, hides them instead. */
  const reveal = (list, { toggle = false } = {}) => {
    if (toggle && list.every((c) => c.panel.isConnected)) {
      for (const c of list) {
        c.panel.remove();
        c.block.classList.remove("has-evidence");
      }
      return;
    }
    for (const c of list) {
      if (c.panel.isConnected) continue;
      const nested = c.block.querySelector(":scope > ul, :scope > ol");
      if (c.block.tagName === "LI") nested ? nested.before(c.panel) : c.block.append(c.panel);
      else c.block.after(c.panel);
      c.block.classList.add("has-evidence");
    }
    resolve(list);
  };

  for (const block of body.querySelectorAll("p, li")) {
    const text = claimText(block);
    if (evidenceWords(text).length < 3) continue;
    const claim = { block, text, local: evidence.match(text), panel: el("div", "evidence"), result: undefined, pending: false };
    claims.set(block, claim);
    block.classList.add("claim");
    const button = el("button", "claim-src", "source");
    button.title = "Show where this point comes from on the page";
    button.addEventListener("click", () => reveal([claim], { toggle: true }));
    const nested = block.querySelector(":scope > ul, :scope > ol");
    nested ? nested.before(button) : block.append(button);
  }
  if (claims.size) evidenceAnswers.add({ body, claims, reveal });
}

// Selecting part of an answer offers the sources for every point the selection touches.
const selectionSources = el("button", "selection-src", "Show sources");
selectionSources.hidden = true;
document.body.append(selectionSources);
let selectedClaims = null;
function updateSelectionSources() {
  selectionSources.hidden = true;
  selectedClaims = null;
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  for (const answer of [...evidenceAnswers]) {
    if (!answer.body.isConnected) {
      evidenceAnswers.delete(answer);
      continue;
    }
    const list = [...answer.claims.values()].filter((c) => range.intersectsNode(c.block));
    if (!list.length) continue;
    // The selection's own paragraphs, not the bullets that merely contain them.
    const innermost = list.filter((c) => !list.some((d) => d !== c && c.block.contains(d.block)));
    selectedClaims = { answer, list: innermost };
    break;
  }
  if (!selectedClaims) return;
  const n = selectedClaims.list.length;
  selectionSources.textContent = n === 1 ? "Show source" : `Show sources (${n})`;
  const rect = range.getBoundingClientRect();
  selectionSources.hidden = false;
  const width = selectionSources.offsetWidth;
  selectionSources.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
  selectionSources.style.top = `${Math.min(innerHeight - 36, rect.bottom + 6)}px`;
}
log.addEventListener("mouseup", () => setTimeout(updateSelectionSources));
log.addEventListener("keyup", (e) => e.shiftKey && updateSelectionSources());
log.addEventListener("scroll", () => (selectionSources.hidden = true), { passive: true });
document.addEventListener("selectionchange", () => getSelection().isCollapsed && (selectionSources.hidden = true));
selectionSources.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection while clicking
selectionSources.addEventListener("click", () => {
  if (selectedClaims) selectedClaims.answer.reveal(selectedClaims.list);
  selectionSources.hidden = true;
  getSelection().removeAllRanges();
});

function renderCitedAnswer(body, text, links, sources, final) {
  const token = `CITATION${[...crypto.getRandomValues(new Uint32Array(4))].map((n) => n.toString(36)).join("")}REF`;
  const { markdown, citations } = prepareCitations(text, sources, token);
  body.replaceChildren(...markdownNodes(markdown, { links }));
  const section = el("details", "citations");
  const showPassages = [];
  const items = citations.map(({ quote, source }, index) => {
    const item = el("li", "citation");
    item.value = index + 1;
    item.append(el("q", null, quote));
    if (!source) {
      item.classList.add("unverified");
      item.append(el("p", "citation-status", "Not found in the page text, so this quote is unverified."));
      return item;
    }
    const { button, status, show } = passageButton(source, quote, () => {
      section.open = true;
      item.scrollIntoView({ block: "nearest" });
    });
    showPassages[index] = show;
    item.append(" ", button, status);
    return item;
  });
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue.includes(token)) nodes.push(node);
  for (const node of nodes) {
    const parts = node.nodeValue.split(new RegExp(`${token}(\\d+)(I?)END`, "g"));
    const out = [];
    for (let i = 0; i < parts.length; i += 3) {
      if (parts[i]) out.push(document.createTextNode(parts[i]));
      if (i + 1 >= parts.length) break;
      const number = Number(parts[i + 1]);
      // The model used the quote as the sentence's own words: show them, or the sentence has holes.
      if (parts[i + 2]) out.push(el("span", "cited-text", citations[number - 1].quote));
      const ref = el("button", "citation-ref", String(number));
      ref.setAttribute("aria-label", showPassages[number - 1] ? `Show passage ${number} on page` : `View unverified citation ${number}`);
      if (!citations[number - 1].source) ref.classList.add("unverified");
      ref.title = citations[number - 1].quote;
      ref.addEventListener("click", () => {
        if (showPassages[number - 1]) return showPassages[number - 1](ref);
        section.open = true;
        items[number - 1].scrollIntoView({ block: "nearest" });
      });
      out.push(ref);
    }
    node.replaceWith(...out);
  }
  if (items.length) {
    // One list per source page, headed once, rather than repeating the page title on every quote.
    const groups = new Map();
    citations.forEach(({ source }, index) => {
      const key = source ? `${source.tabId}|${source.url}` : "";
      if (!groups.has(key)) groups.set(key, { source, items: [] });
      groups.get(key).items.push(items[index]);
    });
    const pages = new Set(citations.filter((c) => c.source).map((c) => `${c.source.tabId}|${c.source.url}`)).size;
    const unverified = citations.filter((c) => !c.source).length;
    const label = [`${items.length} quote${items.length === 1 ? "" : "s"}`];
    if (pages > 1) label.push(`${pages} pages`);
    if (unverified) label.push(`${unverified} unverified`);
    section.append(el("summary", null, `Sources · ${label.join(" · ")}`));
    for (const { source, items: list } of groups.values()) {
      const group = el("div", "citation-group");
      if (source) group.append(el("div", "citation-source", source.title || source.url), el("div", "source-url", source.url));
      else group.append(el("div", "citation-source", "Unverified"));
      const ol = el("ol");
      ol.append(...list);
      group.append(ol);
      section.append(group);
    }
    body.append(section);
  } else if (final) {
    body.append(el("p", "context-help", "No passage citations supplied. Verify claims against the sources."));
  }
}

/** replay: draw a stored reply (replayBot) without recording it again. */
function addBot({ agent = false, replay = false } = {}) {
  log.querySelector(".welcome")?.remove();
  // What happens to the reply, as [method, ...args], so it can be drawn again after the sidebar reopens.
  const entry = replay ? null : record({ kind: "bot", agent, ops: [], done: false });
  const op = (...args) => {
    if (!entry) return args;
    entry.ops.push(args);
    saveSoon();
    return args;
  };
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
  let sources = null, evidenceSources = null;
  const show = (md, final = false) => {
    if (sources) return renderCitedAnswer(body, md, links, sources, final);
    body.replaceChildren(...markdownNodes(md, { links }));
    if (final && evidenceSources) attachEvidence(body, evidenceSources);
  };
  let frame = 0, pendingText = "", stepCount = 0;
  const api = {
    /** Origins the answer may link to (a live Set is fine: the agent adds pages as it reads them). */
    links(origins) {
      links = origins;
      op("links", origins);
    },
    /** Agent answers: sources for the model's own [[cite:…]] markup. */
    citations(records) {
      sources = records.slice();
      op("citations", sources);
    },
    /** Ask and Summarize answers: page texts to find each point's source in, on request. */
    evidence(records) {
      evidenceSources = records.slice();
      // A long page Summarize read in parts can be far bigger than anything else in the thread, and the thread is
      // saved every second while a reply streams. Such sources stay with this reply only; replayed, it has no "source"
      // buttons, as when compactThread drops them.
      const max = state.settings?.maxPageChars || 24000;
      if (evidenceSources.every((r) => (r.text?.length || 0) <= max)) op("evidence", evidenceSources);
    },
    stream(text) {
      pendingText = text;
      if (entry) {
        entry.partial = text;
        saveSoon();
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pendingText) show(pendingText); // auto-scroll follows if pinned
      });
    },
    set(text) {
      cancelAnimationFrame(frame);
      frame = 0;
      show(text || "_(empty reply)_", true);
      scrollDown();
      if (entry) delete entry.partial;
      op("set", text);
    },
    note(text) {
      extra.append(el("div", "dimline", text));
      op("note", text);
    },
    /** Speed and token counts for the whole run, under the reply. */
    stats(meter) {
      const s = state.settings.showStats && meter.summary();
      if (!s) return;
      op("stats", s);
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
      const n = stepCount++;
      op("step", icon, text, { dim });
      return {
        update: (t) => {
          tx.textContent = t;
          op("stepText", n, t);
        },
        ok: () => {
          li.classList.remove("running");
          op("stepOk", n);
        },
        fail: (m) => {
          li.classList.remove("running");
          li.classList.add("fail");
          li.append(el("div", "err", m));
          op("stepFail", n, m);
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
      const img = el("img", "shot");
      img.src = url;
      img.alt = "Screenshot the model looked at";
      img.title = "Click to enlarge";
      img.addEventListener("click", () => img.classList.toggle("big"));
      if (list) {
        const li = el("li");
        li.append(el("span", "ic", ""), img);
        list.append(li);
      } else extra.append(img); // Ask answers have no step list
      scrollDown();
    },
    /**
     * allowAll: label of a scoped "allow all for this task" button; remember: label of an "always allow for this
     * session" button. Either is null when the action must be approved on its own. permissions: optional Firefox
     * permissions to request when the user allows (Firefox only shows its prompt from inside a click handler).
     * permissionsOptional: declining Firefox's prompt still allows the action, only without that permission.
     */
    confirm({ title, detail, actionLabel = "Allow action", fields = [], allowAll = null, remember = null, permissions = null, permissionsOptional = false }) {
      return new Promise((resolve) => {
        const card = confirmCard({ title, detail, fields });
        const recorded = op("confirm", { title, detail, fields }, null);
        const row = el("div", "row");
        const finish = (ans, label) => {
          if (!state.confirms.has(finish)) return;
          state.confirms.delete(finish);
          card.classList.add("answered");
          card.append(el("div", "dimline", label));
          recorded[2] = label;
          saveSoon();
          resolve(ans);
        };
        const mk = (label, ans, cls, after) => {
          const b = el("button", "btn " + (cls || ""), label);
          b.addEventListener("click", () => {
            if (b.disabled) return;
            if (permissions?.length && ans !== "no") {
              for (const button of row.children) button.disabled = true;
            }
            if (!permissions?.length || ans === "no") return finish(ans, after);
            const declined = () =>
              permissionsOptional ? finish(ans, `${after} (Firefox permission declined)`) : finish("no", "Firefox permission declined");
            browser.permissions.request({ permissions }).then((granted) => (granted ? finish(ans, after) : declined()), declined);
          });
          return b;
        };
        row.append(mk(actionLabel, "yes", "primary", `${actionLabel}: allowed`));
        if (allowAll) row.append(mk(allowAll, "all", "", `${allowAll}: allowed for the rest of this task`));
        if (remember) row.append(mk(remember, "session", "", `${remember}: allowed until you start a new conversation`));
        row.append(mk("Deny", "no", "", "Denied"));
        card.append(row);
        (list ? list.parentElement : extra).after(card);
        state.confirms.add(finish);
        scrollDown(true);
        row.lastChild.focus();
      });
    },
    /** An approval card from a stored reply, with how it was answered. */
    pastConfirm(details, label) {
      const card = confirmCard(details);
      card.classList.add("answered");
      card.append(el("div", "dimline", label || "Not answered: the sidebar was closed"));
      (list ? list.parentElement : extra).after(card);
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
      const settingsProblem = e instanceof LLMError || !!e.llm;
      op("error", e.message || String(e), settingsProblem);
      if (settingsProblem) {
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
      op("finish");
      lastLi?.classList.remove("running");
      if (steps) {
        summary.textContent = `${count} step${count === 1 ? "" : "s"}`;
        steps.open = false;
      }
    },
  };
  return api;
}

function confirmCard({ title, detail, fields = [] }) {
  const card = el("section", "confirm");
  card.setAttribute("aria-label", title);
  card.append(el("div", "title", title), el("div", "detail", detail || ""));
  if (fields.length) {
    const preview = el("dl", "approval-fields");
    for (const field of fields) preview.append(el("dt", null, field.label), el("dd", null, field.value));
    card.append(preview);
  }
  return card;
}

/** Draws a stored reply again; one cut off by the sidebar closing shows how far it got. */
function replayBot(entry) {
  const bot = addBot({ agent: entry.agent, replay: true });
  const steps = [];
  for (const [method, ...args] of entry.ops) {
    if (method === "links") bot.links(new Set(args[0]));
    else if (method === "step") steps.push(bot.step(...args));
    else if (method === "stepText") steps[args[0]]?.update(args[1]);
    else if (method === "stepOk") steps[args[0]]?.ok();
    else if (method === "stepFail") steps[args[0]]?.fail(args[1]);
    else if (method === "stats") bot.stats({ summary: () => args[0] });
    else if (method === "error") bot.error({ message: args[0], llm: args[1] });
    else if (method === "confirm") bot.pastConfirm(args[0], args[1]);
    else if (["citations", "evidence", "set", "note", "finish"].includes(method)) bot[method](...args);
  }
  // Stopped runs end without a reply: show what had streamed in.
  if (!entry.ops.some(([method]) => method === "set" || method === "error")) bot.set(entry.partial || "_(no reply)_");
  if (!entry.interrupted) return;
  bot.note("Interrupted: the sidebar was closed before this finished.");
  if (entry.agent) bot.finish();
}

// ---------- per-tab conversations (lib/threads.js) ----------
// Each tab has its own conversation, kept in storage.session until the tab or the browser closes. The sidebar shows
// the active tab's, but never switches during a run: a run's replies stay with the tab it started on, and the
// sidebar follows the active tab again at the next tab switch.
const grantsByTab = new Map(); // "Always allow" choices stay in memory: closing the sidebar forgets them
let saveTimer = 0;
let threadVersion = 0;

function record(entry) {
  state.thread?.entries.push(entry);
  saveSoon();
  return entry;
}

function saveSoon() {
  if (state.thread && !saveTimer) saveTimer = setTimeout(saveNow, 1000);
}

const tabInfo = (tab) => tab && { id: tab.id, url: tab.url, title: tab.title };

function contextSnapshot() {
  const max = state.settings?.maxPageChars || 24000; // no more than this is ever sent for one page
  const page = (p) => p && { ...p, tab: tabInfo(p.tab), text: p.text?.slice(0, max) };
  return {
    pages: [...state.contextPages].map(([key, e]) => [key, { ...e, tab: tabInfo(e.tab), page: page(e.page) }]),
    excluded: [...state.excludedPages],
  };
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const thread = state.thread;
  if (!thread) return Promise.resolve();
  const context = contextSnapshot();
  if (!thread.entries.length && !context.pages.some(([, e]) => e.pinned)) return removeThread(thread.tabId).catch(() => {});
  // storeThread copies the thread before its first await, so later changes don't leak into this write.
  return storeThread({ tabId: thread.tabId, updated: Date.now(), entries: thread.entries, chat: state.chat.snapshot(), context })
    .catch((e) => console.warn("PageMortem: couldn't keep this conversation", e));
}

async function showThread(tabId) {
  if (state.thread?.tabId === tabId) return;
  const version = ++threadVersion;
  saveNow();
  const stored = await loadThread(tabId).catch(() => null);
  if (version !== threadVersion || state.running) return;
  const entries = stored?.entries || [];
  for (const entry of entries) {
    if (entry.kind === "bot" && !entry.done) Object.assign(entry, { done: true, interrupted: true });
  }
  state.thread = { tabId, entries };
  state.chat.restore(stored?.chat);
  state.contextPages.clear();
  for (const [key, entry] of stored?.context?.pages || []) state.contextPages.set(key, entry);
  state.excludedPages.clear();
  for (const key of stored?.context?.excluded || []) state.excludedPages.add(key);
  if (!grantsByTab.has(tabId)) grantsByTab.set(tabId, new Set());
  state.sessionGrants = grantsByTab.get(tabId);
  contextVersion++; // a context read still running belongs to the previous tab
  state.contextBusy = false;
  $("contextStatus").textContent = "";

  log.replaceChildren();
  evidenceAnswers.clear();
  for (const entry of entries) entry.kind === "user" ? addUser(entry.text, { replay: true }) : replayBot(entry);
  if (!entries.length) showWelcome();
  scrollDown(true);
  refreshContext();
}

async function followActiveTab() {
  if (state.running) return;
  const tab = await activeTab();
  if (tab) await showThread(tab.id);
}

// ---------- running state ----------
function setRunning(r) {
  state.running = r;
  const send = $("send");
  send.textContent = r ? "Stop" : "Send";
  send.classList.toggle("stop", !!r);
  send.setAttribute("aria-label", r ? "Stop" : "Send");
  for (const id of ["summarize", "translate", "restore", "groupTabs", "newChat"]) $(id).disabled = !!r;
  for (const button of document.querySelectorAll(".modes button")) button.disabled = !!r;
  renderContext();
}

function stopRunning() {
  for (const resolve of [...state.confirms]) resolve("no", "Stopped");
  state.running?.stop();
}

// One run at a time. The reservation is taken before the first await: runs set their Stop handle only after reading
// tabs, and a second Send or Summarize in that gap would otherwise start a run nothing can stop.
async function guard(fn) {
  if (state.running || state.reserved) return;
  state.reserved = true;
  try {
    await fn();
  } finally {
    state.reserved = false;
    setRunning(null);
    if (state.settingsChanged) {
      state.settingsChanged = false;
      applySettings();
    }
    for (const entry of state.thread?.entries || []) if (entry.kind === "bot") entry.done = true;
    saveNow();
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
  const bot = addBot();
  const ctrl = new AbortController();
  const meter = new Meter();
  setRunning({ stop: () => ctrl.abort() });
  try {
    await bounded(syncContext({ reread: true }), { signal: ctrl.signal });
    ctrl.signal.throwIfAborted();
    const pages = [...state.contextPages.values()].map((entry) => ({
      ...entry.page, selection: entry.selectionExcluded ? "" : entry.page?.selection,
    }));
    if (!pages.length) throw new Error("No pages included. Expand Context and add an open tab.");
    if (pages.some((page) => !page.url)) throw new Error("Context is still loading. Refresh context and try again.");
    for (const p of pages) if (p.error) bot.note(`Couldn't read “${p.title || p.url}”: ${p.error}`);
    bot.links(new Set(pages.map((p) => originOf(p.url))));
    const selection = pages.map((p) => p.selection || "").filter(Boolean).join("\n\n");
    if (selection) bot.note(`Including selected text (${Math.min(selection.length, 6000)} chars).`);
    const llm = metered(state.llm, meter);
    let image = null;
    let asked = question;
    if (isImageQuestion(question)) {
      const active = await activeTab();
      const tab = pages.find((p) => p.tab?.id === active?.id)?.tab || pages[0].tab;
      try {
        const shot = await pageShot(tab.id, { maxWidth: state.settings.screenshotWidth, signal: ctrl.signal });
        bot.image(shot.url);
        bot.note(shot.cropped ? "Showing the model the main image on the page." : "Showing the model a screenshot of the page.");
        const { visionModel, model } = state.settings;
        if (visionModel && visionModel !== model) {
          const seen = await describeImage({ image: shot.url, question, llm, settings: state.settings, signal: ctrl.signal });
          asked = `${question}\n\n<screenshot_description>\n${seen}\n</screenshot_description>\n(What the vision model sees in a screenshot from the page.)`;
        } else image = shot.url;
      } catch (e) {
        if (isAbort(e)) throw e;
        bot.note(`Couldn't look at the page: ${e.message}`);
      }
    }
    const ask = (img) => state.chat.ask({
      question: asked, pages, selection, image: img, llm, settings: state.settings, keepPages: false,
      onDelta: (t) => bot.stream(t), signal: ctrl.signal,
    });
    let reply;
    try {
      reply = await ask(image);
    } catch (e) {
      if (!image || isAbort(e)) throw e;
      // Text-only models (or a server without the vision projector loaded) reject the image outright.
      bot.note(`The model didn't accept the image (${e.message}). Set a vision model in options; answering from the page text.`);
      bot.stream("");
      reply = await ask(null);
    }
    const { answer, fresh } = reply;
    if (fresh) bot.note("Included pages changed, so this answer starts a fresh model conversation.");
    bot.evidence(state.chat.citations);
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
    bot.citations(agent.citations);
    bot.set(answer);
  } catch (e) {
    if (isAbort(e)) bot.set("_Stopped. Actions already sent to the page may still complete; Stop does not undo them._");
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
  const length = { brief: " briefly", detailed: " in detail" }[state.settings.summaryLength] || "";
  addUser(`${useSel ? "Summarize the selected text" : "Summarize this page"}${length}`);
  const bot = addBot();
  try {
    if (page.error) throw new Error(page.error);
    const p = useSel ? { ...page, text: page.selection } : page;
    bot.links(new Set([originOf(page.url)]));
    bot.evidence([{ tabId: tab.id, doc: p.doc, url: p.url, title: p.title, text: p.text }]);
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

async function runGroupTabs() {
  addUser("Suggest tab groups");
  const bot = addBot();
  if (!groupingSupported()) return bot.set("Tab groups need Firefox 139 or later.");
  const tabs = await looseTabs(state.windowId);
  if (tabs.length < GROUP_MIN_TABS) return bot.set(`There are only ${tabs.length} ungrouped tabs in this window. Nothing to group.`);
  const ctrl = new AbortController();
  const meter = new Meter();
  setRunning({ stop: () => ctrl.abort() });
  try {
    const groups = await suggestGroups({ tabs, llm: metered(state.llm, meter), signal: ctrl.signal });
    if (!groups.length) return bot.set("The model found no tabs that belong together.");
    const placed = groups.reduce((n, g) => n + g.tabs.length, 0);
    const extra = tabs.length > GROUP_MAX_TABS ? ` Only the first ${GROUP_MAX_TABS} were considered.` : "";
    bot.set(`Suggested ${groups.length} group${groups.length === 1 ? "" : "s"} for ${placed} of ${tabs.length} ungrouped tabs.${extra}`);
    const ans = await bot.confirm({
      title: "Create these tab groups?",
      detail: "Tabs not listed stay where they are. You can rename, recolor or ungroup them afterwards from the tab strip.",
      actionLabel: "Create groups",
      fields: groups.map((g) => ({ label: `${g.name} (${g.color})`, value: g.tabs.map((t) => t.title || t.url).join(" · ") })),
    });
    if (ans !== "yes") return;
    const r = await applyGroups(groups, state.windowId);
    bot.note(`Created ${r.created} group${r.created === 1 ? "" : "s"}.${r.skipped ? ` ${r.skipped} tabs had closed or changed and were left out.` : ""}`);
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
  if (state.reserved) return;
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addUser(text);
  guard(() => (state.mode === "agent" ? runAgent(text) : runAsk(text)));
}

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll(".modes button")) {
    const selected = b.dataset.mode === mode;
    b.setAttribute("aria-checked", String(selected));
    b.tabIndex = selected ? 0 : -1;
  }
  $("input").placeholder = mode === "agent" ? "Describe a task, e.g. “summarize the last 3 releases”" : "Ask about this page…";
  $("keepWrap").hidden = mode !== "ask";
  $("modeHelp").textContent = mode === "agent"
    ? "Can interact with pages. Requests approval for detected risky actions; ordinary controls can still have site-script side effects."
    : "Reads the included pages. Does not interact with websites.";
  $("contextHelp").textContent = mode === "agent"
    ? "Agent starts on the active tab and can read selected tabs. These are starting tabs, not a navigation restriction. Further reads and actions appear in the task log; approvals still apply."
    : "Ask uses the pages below. Removing a source resets model conversation history, including earlier answers.";
  renderContext();
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
    banner("PageMortem needs permission to read and act on pages. This doesn't open any network access; the model endpoint lock still applies.", [b]);
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
let contextVersion = 0;
const sourceKey = (tab) => `${tab.id}|${tab.url}`;

function resetContextHistory(message) {
  state.chat.reset();
  $("contextStatus").textContent = message + " Model conversation history was reset.";
}

function contextButton(label, action) {
  const button = el("button", "btn", label);
  button.disabled = !!state.running || state.contextBusy || state.mode !== "ask";
  button.addEventListener("click", action);
  return button;
}

function renderContext() {
  saveSoon(); // sources belong to the tab's conversation
  const entries = [...state.contextPages.values()];
  const count = entries.length;
  const selectionCount = entries.filter((entry) => entry.page?.selection && !entry.selectionExcluded).length;
  $("context").textContent = state.mode === "agent" ? "Context · Agent uses active / selected tabs"
    : `Context · ${count} page${count === 1 ? "" : "s"}${selectionCount ? ` + ${selectionCount} selection${selectionCount === 1 ? "" : "s"}` : ""}`;
  const list = $("contextList");
  list.replaceChildren();
  const agentMode = state.mode === "agent";
  document.querySelector(".context-actions").hidden = agentMode;
  if (agentMode) {
    const highlighted = state.contextTabs.filter((tab) => tab.highlighted);
    const tabs = highlighted.length > 1 ? highlighted : state.contextTabs.filter((tab) => tab.active);
    $("context").textContent = `Context · ${tabs.length} Agent starting tab${tabs.length === 1 ? "" : "s"}`;
    for (const tab of tabs) {
      const item = el("section", "source");
      item.append(el("strong", null, tab.title || tab.url), el("div", "source-url", tab.url),
        el("p", "context-help", tab.active ? "Active tab · read when the task starts" : "Selected tab · available to the agent"));
      list.append(item);
    }
    return;
  }
  const perPage = Math.floor((state.settings?.maxPageChars || 24000) / Math.max(1, count));
  for (const entry of entries) {
    const { tab, page, readAt, pinned } = entry;
    const item = el("section", "source");
    item.append(el("strong", null, page?.title || tab.title || tab.url));
    item.append(el("div", "source-url", tab.url));
    const length = Math.max(page?.length || 0, page?.text?.length || 0);
    const sent = Math.min(page?.text?.length || 0, perPage);
    const time = readAt ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(readAt) : "";
    item.append(el("p", "context-help", !page ? "Reading…" : page.error ? `Unreadable: ${page.error}` :
      `Read ${time} · ${sent.toLocaleString()} of ${length.toLocaleString()} characters${sent < length ? " · truncated" : " · full extracted text"}${pinned ? " · pinned snapshot" : ""}`));
    const actions = el("div", "source-actions");
    actions.append(
      contextButton("Refresh", () => refreshSource(sourceKey(tab))),
      contextButton(pinned ? "Unpin" : "Pin snapshot", () => {
        entry.pinned = !entry.pinned;
        renderContext();
      }),
      contextButton("Remove", () => {
        state.excludedPages.add(sourceKey(tab));
        state.contextPages.delete(sourceKey(tab));
        contextVersion++;
        resetContextHistory("Source removed.");
        renderContext();
      }),
    );
    item.append(actions);
    if (page?.selection) {
      const selection = el("div", "source-selection");
      selection.append(el("strong", null, entry.selectionExcluded ? "Selected text · excluded" : "Selected text · included"));
      selection.append(el("p", null, page.selection.slice(0, 180) + (page.selection.length > 180 ? "…" : "")));
      selection.append(el("p", "context-help", "Controls the extra highlighted excerpt, not matching text in the included page. Selected excerpts share a 6,000-character limit."));
      selection.append(contextButton(entry.selectionExcluded ? "Include selection" : "Remove selection", () => {
        entry.selectionExcluded = !entry.selectionExcluded;
        resetContextHistory(entry.selectionExcluded ? "Selection excluded." : "Selection included.");
        renderContext();
      }));
      item.append(selection);
    }
    list.append(item);
  }
  if (!count) list.append(el("p", "context-help", "No pages included. Add an open tab below."));
  const add = $("addSource");
  add.replaceChildren(new Option("Choose a tab…", ""));
  for (const tab of state.contextTabs) {
    if (!isWebUrl(tab.url) || state.contextPages.has(sourceKey(tab))) continue;
    add.append(new Option(tab.title || tab.url, String(tab.id)));
  }
  const disabled = !!state.running || state.contextBusy || state.mode !== "ask";
  add.disabled = disabled;
  $("refreshSources").disabled = disabled || !count;
  $("keepPages").disabled = disabled;
}

async function syncContext({ reread = false, refreshPinned = false } = {}) {
  const version = ++contextVersion;
  state.contextBusy = true;
  renderContext();
  try {
    const [selected, open] = await Promise.all([
      contextTabs(state.windowId), browser.tabs.query({ windowId: state.windowId }),
    ]);
    if (version !== contextVersion) return;
    state.contextTabs = open;
    const selectedKeys = new Set(selected.map(sourceKey));
    for (const [key, entry] of state.contextPages) {
      if (!entry.pinned && !state.keepPages && !selectedKeys.has(key)) state.contextPages.delete(key);
    }
    for (const tab of selected) {
      if (!isWebUrl(tab.url) || state.excludedPages.has(sourceKey(tab))) continue;
      const key = sourceKey(tab);
      if (!state.contextPages.has(key)) {
        state.contextPages.set(key, { tab, page: null, readAt: null, pinned: false, selectionExcluded: false });
      }
    }
    const refresh = [...state.contextPages.values()].filter((entry) =>
      !entry.page || (reread && (!entry.pinned || refreshPinned) && open.some((tab) => tab.id === entry.tab.id && tab.url === entry.tab.url)));
    const pages = await readPages(refresh.map((entry) => entry.tab));
    if (version !== contextVersion) return;
    pages.forEach((page, index) => Object.assign(refresh[index], { page, readAt: Date.now() }));
    const active = selected.find((tab) => tab.active) || selected[0];
    $("restore").hidden = !(active && state.translated.has(active.id));
  } catch (e) {
    $("contextStatus").textContent = `Couldn't update context: ${e.message}`;
  } finally {
    if (version === contextVersion) {
      state.contextBusy = false;
      renderContext();
    }
  }
}

async function refreshSource(key) {
  const entry = state.contextPages.get(key);
  if (!entry || state.running || state.contextBusy) return;
  state.contextBusy = true;
  renderContext();
  try {
    const tab = await browser.tabs.get(entry.tab.id);
    if (tab.url !== entry.tab.url) throw new Error("This tab navigated. Remove this snapshot and add the current tab.");
    const [page] = await readPages([tab]);
    Object.assign(entry, { page, readAt: Date.now() });
    resetContextHistory("Source refreshed.");
  } catch (e) {
    $("contextStatus").textContent = `Couldn't refresh: ${e.message}`;
  } finally {
    state.contextBusy = false;
    renderContext();
  }
}

function refreshContext() {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(() => {
    if (!state.running && !state.contextBusy) syncContext({ reread: true });
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
  const lengthSel = $("summaryLength");
  lengthSel.value = SUMMARY_LENGTHS.includes(state.settings.summaryLength) ? state.settings.summaryLength : "standard";
  lengthSel.addEventListener("change", () => {
    state.settings.summaryLength = lengthSel.value; // a Summarize click right away mustn't wait for storage
    saveSettings({ summaryLength: lengthSel.value });
  });

  const { mode, askKeepPages } = await browser.storage.local.get(["mode", "askKeepPages"]);
  setMode(mode === "agent" ? "agent" : "ask");
  state.keepPages = !!askKeepPages;
  $("keepPages").checked = state.keepPages;
  $("keepPages").addEventListener("change", (e) => {
    state.keepPages = e.target.checked;
    browser.storage.local.set({ askKeepPages: state.keepPages }).catch(() => {});
    if (!state.keepPages) resetContextHistory("Earlier unpinned pages will no longer be kept.");
    refreshContext();
  });
  pruneThreads().catch(() => {});
  await followActiveTab();
  if (!state.thread) showWelcome();
  addEventListener("pagehide", saveNow); // closing the sidebar: keep what the last second added

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
  const modes = [...document.querySelectorAll(".modes button")];
  for (const b of modes) {
    b.addEventListener("click", () => setMode(b.dataset.mode));
    b.addEventListener("keydown", (e) => {
      if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const index = e.key === "Home" ? 0 : e.key === "End" ? modes.length - 1
        : (modes.indexOf(b) + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 1) + modes.length) % modes.length;
      setMode(modes[index].dataset.mode);
      modes[index].focus();
    });
  }
  $("refreshSources").addEventListener("click", async () => {
    resetContextHistory("Refreshing open sources. Snapshots whose tabs closed or navigated remain unchanged.");
    await syncContext({ reread: true, refreshPinned: true });
  });
  $("contextPanel").addEventListener("toggle", () => {
    if ($("contextPanel").open) refreshContext();
  });
  $("addSource").addEventListener("change", async (e) => {
    const tab = state.contextTabs.find((tab) => tab.id === Number(e.target.value));
    if (!tab || state.running || state.contextBusy) return;
    state.excludedPages.delete(sourceKey(tab));
    state.contextPages.set(sourceKey(tab), { tab, page: null, readAt: null, pinned: true, selectionExcluded: false });
    await syncContext();
  });
  $("summarize").addEventListener("click", () => guard(runSummarize));
  $("translate").addEventListener("click", () => guard(() => runTranslate("")));
  $("restore").addEventListener("click", runRestore);
  $("groupTabs").addEventListener("click", () => guard(runGroupTabs));
  $("jump").addEventListener("click", () => scrollDown(true));
  $("newChat").addEventListener("click", () => {
    state.chat.reset();
    state.sessionGrants.clear();
    state.contextPages.clear();
    state.excludedPages.clear();
    $("contextStatus").textContent = "";
    if (state.thread) state.thread.entries = [];
    saveNow();
    refreshContext();
    showWelcome();
  });
  $("openSettings").addEventListener("click", () => browser.runtime.openOptionsPage());

  const mine = (info) => info.windowId === state.windowId;
  browser.tabs.onActivated.addListener((i) => {
    if (!mine(i)) return;
    followActiveTab();
    refreshContext();
  });
  browser.tabs.onHighlighted.addListener((i) => mine(i) && refreshContext());
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.status === "loading") state.translated.delete(id);
    // Reread only when a page in context (or about to be: the active or highlighted tab) finished loading or moved.
    if (tab.windowId !== state.windowId || !(change.title || change.url || change.status === "complete")) return;
    const inContext = tab.active || tab.highlighted || [...state.contextPages.values()].some((entry) => entry.tab.id === id);
    if (inContext && (change.url || change.status === "complete")) return refreshContext();
    // Any other tab: only the "Choose a tab" list shows it, so update that without reading pages.
    const i = state.contextTabs.findIndex((t) => t.id === id);
    if (i === -1) state.contextTabs.push(tab);
    else state.contextTabs[i] = tab;
    if (!state.contextBusy) renderContext();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    // A run keeps the settings it started with; changes made meanwhile apply when it ends.
    if (state.running || state.reserved) state.settingsChanged = true;
    else applySettings();
  });
  browser.runtime.onMessage.addListener((m) => {
    if (m?.type === "pagemortem:command") consumePending();
  });
  consumePending();
}

init();
