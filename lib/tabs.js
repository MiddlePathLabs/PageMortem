// Tab helpers: inject the content script on demand, call into it, wait for navigation, capture screenshots.
"use strict";

/** Resolves after ms; with a signal, rejects as soon as it aborts and clears the timer. */
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

class PageError extends Error {}

const PAGE_TIMEOUT = 20000;

/** Rejects when `signal` aborts or `ms` passes, whichever comes first; otherwise settles like `promise`. */
function bounded(promise, { ms, signal, what = "The page" } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  let timer, onAbort;
  const guard = new Promise((_, reject) => {
    if (ms) timer = setTimeout(() => reject(new PageError(`${what} didn't respond within ${Math.round(ms / 1000)} s.`)), ms);
    onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}

/** Only ordinary web pages may be opened or acted on. */
function isWebUrl(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

async function ensureInjected(tabId, signal) {
  signal?.throwIfAborted();
  try {
    const r = await browser.tabs.sendMessage(tabId, { pagemortem: true, op: "ping" });
    if (r?.ok) return;
  } catch {
    /* not injected yet */
  }
  signal?.throwIfAborted();
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ["/content/content.js"] });
  } catch (e) {
    signal?.throwIfAborted();
    const tab = await browser.tabs.get(tabId).catch(() => null);
    throw new PageError(
      `PageMortem can't access this page${tab?.url ? ` (${tab.url.slice(0, 60)})` : ""}. Firefox blocks extensions on about: pages, addons.mozilla.org, reader view and the built-in PDF viewer. (${e.message})`,
    );
  }
  signal?.throwIfAborted();
}

async function pageCall(tabId, op, args = {}, { timeout = PAGE_TIMEOUT, signal } = {}) {
  signal?.throwIfAborted();
  const call = (async () => {
    await ensureInjected(tabId, signal);
    signal?.throwIfAborted();
    return browser.tabs.sendMessage(tabId, { pagemortem: true, op, args });
  })();
  const r = await bounded(call, { ms: timeout, signal });
  if (r?.error) throw new PageError(r.error);
  return r;
}

/** Wait until a navigation triggered by an action has finished (or determine none happened). */
async function waitForSettle(tabId, prevUrl, timeout = 25000, signal) {
  const start = Date.now();
  let sawLoading = false;
  while (Date.now() - start < timeout && !signal?.aborted) {
    const t = await browser.tabs.get(tabId);
    if (t.status === "loading") sawLoading = true;
    else if (sawLoading || (prevUrl && t.url !== prevUrl)) break;
    else if (Date.now() - start > 1200) break; // in-page update, no navigation
    await sleep(150);
  }
  await sleep(500); // let late scripts render
}

async function openTab(url, { active = false, windowId, openerTabId, onCreated, signal } = {}) {
  const tab = await browser.tabs.create({ url, active, windowId, openerTabId });
  onCreated?.(tab.id); // register before waiting, so a Stop during the load still cleans it up
  const start = Date.now();
  while (Date.now() - start < 30000) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const t = await browser.tabs.get(tab.id);
    if (t.status === "complete" && t.url !== "about:blank") break;
    await sleep(200);
  }
  await sleep(500);
  return tab.id;
}

/** Run fn while tabId is the visible tab of its window, then restore the previous tab. */
async function withTabActive(tabId, fn) {
  const tab = await browser.tabs.get(tabId);
  let restore = null;
  if (!tab.active) {
    const [cur] = await browser.tabs.query({ active: true, windowId: tab.windowId });
    restore = cur?.id ?? null;
    await browser.tabs.update(tabId, { active: true });
    await sleep(400);
  }
  try {
    return await fn(tab.windowId);
  } finally {
    if (restore != null) await browser.tabs.update(restore, { active: true }).catch(() => {});
  }
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(head)?.[1] || "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Downscale (and optionally crop to a viewport-relative rect) a screenshot. Returns a JPEG data URL. */
async function processShot(dataUrl, { maxWidth = 1280, crop = null } = {}) {
  const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (crop) {
    const k = bmp.width / crop.viewport.w;
    sx = Math.max(0, crop.rect.x * k);
    sy = Math.max(0, crop.rect.y * k);
    sw = Math.min(bmp.width - sx, crop.rect.w * k);
    sh = Math.min(bmp.height - sy, crop.rect.h * k);
  }
  const scale = Math.min(1, maxWidth / sw);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)));
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
}

// Suffixes under which different owners get their own subdomain. Not the full Public Suffix List: it covers the
// common country second levels and shared hosting platforms, so tenants of one platform count as different sites.
const SHARED_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "co.in", "com.br",
  "com.mx", "com.tr", "co.za", "com.cn", "com.hk", "com.sg", "co.kr", "com.tw",
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com", "web.app",
  "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com", "blogspot.com",
  "wordpress.com", "tumblr.com", "substack.com", "myshopify.com", "readthedocs.io", "onrender.com", "fly.dev",
  "glitch.me", "ngrok.io", "ngrok-free.app", "neocities.org", "carrd.co", "wixsite.com", "weebly.com",
  "sharepoint.com", "translate.goog",
]);
/** Approximate registrable domain ("site") of a URL. */
function siteOf(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (SHARED_SUFFIXES.has(parts.slice(i).join("."))) return parts.slice(i - 1).join(".");
  }
  return parts.slice(-2).join(".");
}
