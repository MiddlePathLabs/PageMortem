// Tab helpers: inject the content script on demand, call into it, wait for navigation, capture screenshots.
"use strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PageError extends Error {}

async function ensureInjected(tabId) {
  try {
    const r = await browser.tabs.sendMessage(tabId, { lantern: true, op: "ping" });
    if (r?.ok) return;
  } catch {
    /* not injected yet */
  }
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ["/content/content.js"] });
  } catch (e) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    throw new PageError(
      `Lantern can't access this page${tab?.url ? ` (${tab.url.slice(0, 60)})` : ""}. Firefox blocks extensions on about: pages, addons.mozilla.org, reader view and the built-in PDF viewer. (${e.message})`,
    );
  }
}

async function pageCall(tabId, op, args = {}) {
  await ensureInjected(tabId);
  const r = await browser.tabs.sendMessage(tabId, { lantern: true, op, args });
  if (r?.error) throw new PageError(r.error);
  return r;
}

/** Wait until a navigation triggered by an action has finished (or determine none happened). */
async function waitForSettle(tabId, prevUrl, timeout = 25000) {
  const start = Date.now();
  let sawLoading = false;
  while (Date.now() - start < timeout) {
    const t = await browser.tabs.get(tabId);
    if (t.status === "loading") sawLoading = true;
    else if (sawLoading || (prevUrl && t.url !== prevUrl)) break;
    else if (Date.now() - start > 1200) break; // in-page update, no navigation
    await sleep(150);
  }
  await sleep(500); // let late scripts render
}

async function openTab(url, { active = false, windowId, openerTabId } = {}) {
  const tab = await browser.tabs.create({ url, active, windowId, openerTabId });
  const start = Date.now();
  while (Date.now() - start < 30000) {
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

const MULTI_PART_TLD = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "co.in", "com.br",
  "com.mx", "com.tr", "co.za", "com.cn", "com.hk", "com.sg", "co.kr", "com.tw", "github.io", "gitlab.io", "pages.dev",
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
  const last2 = parts.slice(-2).join(".");
  return MULTI_PART_TLD.has(last2) ? parts.slice(-3).join(".") : last2;
}
