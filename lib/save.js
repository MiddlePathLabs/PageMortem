// Saving images to the user's Downloads folder for the agent's save_images tool.
// Downloads go through Firefox's downloads API, which can only write inside the Downloads folder. That API isn't
// bound by the CSP network lock, so callers pass only addresses of images already shown on approved pages.
"use strict";

const IMAGE_NAME_RE = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?)$/i;
// This checks Firefox's reported MIME, not file bytes; the downloads API cannot inspect the saved file.
const RASTER_MIME_RE = /^image\/(?:jpeg|png|gif|webp|avif|bmp|x-ms-bmp|tiff)$/i;

/** A folder-safe name from free text: "Kittens chasing lasers!" → "kittens-chasing-lasers". */
function slugify(s, max = 50) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** "007-cat.jpg": numbered so files keep the page order and never collide; ".jpg" when the address has no extension. */
function imageFileName(url, n) {
  let base = "";
  try {
    base = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    /* keep the fallback name */
  }
  base = base.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "").slice(-80);
  if (!base) base = "image";
  if (!IMAGE_NAME_RE.test(base)) base += ".jpg";
  return `${String(n).padStart(3, "0")}-${base}`;
}

/** A safe file name from the one the page offered, else from its address: "../a:b.json" → "a_b.json". */
function downloadFileName(name, href) {
  let base = name || "";
  if (!base && href) {
    try {
      base = decodeURIComponent(new URL(href).pathname.split("/").pop() || "");
    } catch {
      /* keep the fallback name */
    }
  }
  base = base.split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^[. _]+|[. ]+$/g, "").slice(-120);
  return base || "file";
}

/** Reads a model's yes/no answer; anything unclear counts as no. */
function parseYesNo(text) {
  const t = stripThink(text || "").trim().toLowerCase();
  const first = t.split(/[.!?\n]/)[0];
  if (/^\W*yes\b/.test(t)) return !/\bno\b/.test(first); // "yes and no" is not a yes
  if (/^\W*no\b/.test(t)) return false;
  return /\byes\b/.test(t) && !/\bno\b/.test(t);
}

/** Runs fn over items, `n` at a time. */
async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

class ImageSaver {
  /** @param {{folder:string, referer?:string, incognito?:boolean, signal?:AbortSignal}} o */
  constructor({ folder, referer = "", incognito = false, signal }) {
    Object.assign(this, { folder, referer, incognito, signal });
    this.items = []; // { id, url }
  }

  async save(url) {
    const opts = {
      url,
      filename: `${this.folder}/${imageFileName(url, this.items.length + 1)}`,
      conflictAction: "uniquify",
      saveAs: false,
      incognito: this.incognito,
    };
    this.items.push({ id: null, url }); // reserve the number before awaiting, so parallel saves get distinct names
    const item = this.items.at(-1);
    try {
      // Some image hosts refuse requests without the page as Referer; not every Firefox version accepts the header.
      item.id = await browser.downloads.download(this.referer ? { ...opts, headers: [{ name: "Referer", value: this.referer }] } : opts);
    } catch {
      item.id = await browser.downloads.download(opts);
    }
    return item.id;
  }

  /**
   * Waits (bounded) for downloads, then removes files whose reported MIME is not a raster image.
   * The downloads API cannot validate file bytes, and a server can misreport its MIME.
   */
  async settle(timeout = 60000) {
    const start = Date.now();
    let found = [];
    for (;;) {
      found = await Promise.all(this.items.map(async (it) => ({ ...it, d: it.id == null ? null : (await browser.downloads.search({ id: it.id }))[0] })));
      if (found.every((x) => !x.d || x.d.state !== "in_progress") || Date.now() - start > timeout || this.signal?.aborted) break;
      await sleep(500);
    }
    const out = { saved: 0, failed: 0, notImage: 0, pending: 0 };
    for (const x of found) {
      if (!x.d || x.d.state === "interrupted") out.failed++;
      // Raster images only: an unknown type proves nothing, and SVG can carry script. A download still running at the
      // deadline is never checked again, so one without a raster type yet is cancelled rather than left behind.
      else if (!RASTER_MIME_RE.test(x.d.mime || "")) {
        out.notImage++;
        if (x.d.state === "in_progress") await browser.downloads.cancel(x.id).catch(() => {});
        else await browser.downloads.removeFile(x.id).catch(() => {});
        await browser.downloads.erase({ id: x.id }).catch(() => {});
      } else if (x.d.state === "in_progress") out.pending++;
      else out.saved++;
    }
    return out;
  }

  async cancelAll() {
    for (const it of this.items) if (it.id != null) await browser.downloads.cancel(it.id).catch(() => {});
  }
}

/**
 * Saves files a page offered for download (caught by the content script during click_each) into one folder, keeping
 * the page's file names. Contents arrive as bytes; a plain web address is downloaded as it is.
 */
class FileSaver {
  /** @param {{folder:string, incognito?:boolean, signal?:AbortSignal}} o */
  constructor({ folder, incognito = false, signal }) {
    Object.assign(this, { folder, incognito, signal });
    this.ids = [];
    this.urls = []; // object URLs to revoke once Firefox has read them
  }

  async save({ name, type, bytes, href }) {
    let url = href;
    if (!href) {
      url = URL.createObjectURL(new Blob([bytes], { type: type || "application/octet-stream" }));
      this.urls.push(url);
    }
    const id = await browser.downloads.download({
      url,
      filename: `${this.folder}/${downloadFileName(name, href)}`,
      conflictAction: "uniquify",
      saveAs: false,
      incognito: this.incognito,
    });
    this.ids.push(id);
    return id;
  }

  /** Waits (bounded) for the downloads to finish, then frees their contents. */
  async settle(timeout = 60000) {
    const start = Date.now();
    let found = [];
    for (;;) {
      found = await Promise.all(this.ids.map(async (id) => (await browser.downloads.search({ id }))[0]));
      if (found.every((d) => !d || d.state !== "in_progress") || Date.now() - start > timeout || this.signal?.aborted) break;
      await sleep(500);
    }
    for (const url of this.urls.splice(0)) URL.revokeObjectURL(url);
    return {
      saved: found.filter((d) => d?.state === "complete").length,
      pending: found.filter((d) => d?.state === "in_progress").length,
      failed: found.filter((d) => !d || d.state === "interrupted").length,
    };
  }
}
