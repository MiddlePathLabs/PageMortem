// Saving images to the user's Downloads folder for the agent's save_images tool.
// Downloads go through Firefox's downloads API, which can only write inside the Downloads folder. That API isn't
// bound by the CSP network lock, so callers pass only addresses of images already shown on approved pages.
"use strict";

const IMAGE_NAME_RE = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|svg)$/i;

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
   * Waits (bounded) for the downloads to finish, then deletes any file that turned out not to be an image, so the
   * tool can only ever leave images behind.
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
      else if (x.d.mime && !/^image\//i.test(x.d.mime)) {
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
