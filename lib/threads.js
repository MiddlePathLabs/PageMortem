// Per-tab conversations in storage.session: in memory only, kept while the sidebar is closed and dropped when the tab
// (background.js) or the browser closes.
"use strict";

const THREAD_PREFIX = "thread:";
// storage.session holds about 10 MB in all; one tab's conversation gets a third of that.
const THREAD_MAX_CHARS = 3_000_000;

const threadKey = (tabId) => `${THREAD_PREFIX}${tabId}`;

/** A storable copy (Sets become arrays) and its size in characters. */
function plainCopy(value) {
  const json = JSON.stringify(value, (k, v) => (v instanceof Set ? [...v] : v));
  return { copy: JSON.parse(json), size: json.length };
}

/** Citation sources cut down to the quotes the answer uses, which is all its "Show on page" buttons need. */
function quoteOnlySources(records, answer) {
  const quotes = new Map();
  for (const match of String(answer || "").matchAll(CITE)) {
    const quote = citationText(match[2]);
    if (quote) quotes.set(match[1], [...(quotes.get(match[1]) || []), quote]);
  }
  return records.map((r) => ({ ...r, text: (quotes.get(r.id) || []).join("\n") }));
}

/** Frees the page texts an earlier reply carries; returns whether there was anything to free. */
function compactEntry(entry) {
  if (entry.kind !== "bot" || entry.compact) return false;
  entry.compact = true;
  const answer = entry.ops.findLast((op) => op[0] === "set")?.[1];
  // Points in Ask and Summarize answers lose their "source" buttons; matching them needs the whole page.
  entry.ops = entry.ops
    .filter((op) => op[0] !== "evidence")
    .map((op) => (op[0] === "citations" ? ["citations", quoteOnlySources(op[1], answer)] : op));
  return true;
}

/**
 * Shrinks a plain thread copy to fit: the oldest replies lose their page texts first, then the oldest turns go. The
 * latest turn and the model history (which Chat already trims) stay.
 */
function compactThread(thread, max = THREAD_MAX_CHARS, size = JSON.stringify(thread).length) {
  for (const entry of thread.entries.slice(0, -1)) {
    if (size <= max) return thread;
    if (compactEntry(entry)) size = JSON.stringify(thread).length;
  }
  while (size > max && thread.entries.length > 2) {
    const next = thread.entries.findIndex((e, i) => i > 0 && e.kind === "user");
    thread.entries.splice(0, next > 0 ? next : 1);
    size = JSON.stringify(thread).length;
  }
  return thread;
}

async function loadThread(tabId) {
  const key = threadKey(tabId);
  return (await browser.storage.session.get(key))[key] || null;
}

/** Stores a thread; if storage is full, drops other tabs' conversations, least recently used first, and retries. */
async function storeThread(thread) {
  const key = threadKey(thread.tabId);
  const { copy, size } = plainCopy(thread);
  compactThread(copy, THREAD_MAX_CHARS, size);
  try {
    await browser.storage.session.set({ [key]: copy });
  } catch (e) {
    const all = await browser.storage.session.get(null);
    const others = Object.entries(all)
      .filter(([k]) => k.startsWith(THREAD_PREFIX) && k !== key)
      .sort(([, a], [, b]) => (a.updated || 0) - (b.updated || 0));
    for (const [k] of others) {
      await browser.storage.session.remove(k);
      try {
        return await browser.storage.session.set({ [key]: copy });
      } catch {
        /* still full: drop the next one */
      }
    }
    throw e;
  }
}

const removeThread = (tabId) => browser.storage.session.remove(threadKey(tabId));

/** Removes conversations whose tabs are gone (closed while nothing was listening). */
async function pruneThreads() {
  const [all, tabs] = await Promise.all([browser.storage.session.get(null), browser.tabs.query({})]);
  const live = new Set(tabs.map((tab) => threadKey(tab.id)));
  const dead = Object.keys(all).filter((k) => k.startsWith(THREAD_PREFIX) && !live.has(k));
  if (dead.length) await browser.storage.session.remove(dead);
}
