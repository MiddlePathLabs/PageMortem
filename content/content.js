// Lantern content script. Injected on demand into the tab being read or operated.
// It never makes network requests; it only reads the DOM and performs the actions it is asked to.
(() => {
  "use strict";
  if (window.__lanternReady) return;
  window.__lanternReady = true;

  // Identifies this document. The agent passes it back with every action so an id read from one
  // page can never act on another page that happens to reuse the same number.
  const DOC = [...crypto.getRandomValues(new Uint32Array(2))].map((n) => n.toString(36)).join("");
  const checkDoc = (doc) => {
    if (doc && doc !== DOC) throw new Error("The page changed since it was read. Read the page again to get fresh numbers.");
  };

  // ---------- element registry (ids are stable for the lifetime of the page) ----------
  let nextId = 1;
  const idOf = new WeakMap();
  const byId = new Map();
  const getId = (el) => {
    let id = idOf.get(el);
    if (!id) {
      id = nextId++;
      idOf.set(el, id);
      byId.set(id, new WeakRef(el));
    }
    return id;
  };
  const getEl = (id) => {
    const el = byId.get(Number(id))?.deref();
    if (!el || !el.isConnected) throw new Error(`Element [${id}] is gone. Read the page again to get fresh numbers.`);
    return el;
  };

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const isVisible = (el) =>
    el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;

  const SENSITIVE_RE = /(passw|card.?(num|no)|cc-?(num|csc|exp)|cvv|cvc|csc|security.?code|expir|iban|routing|account.?num|ssn|social.?sec|\bpin\b|otp|one.?time)/i;
  function isSensitive(el) {
    if (!el || !el.tagName) return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (type === "password" || ac.includes("password") || ac.startsWith("cc-") || ac.includes(" cc-") || ac === "one-time-code") return true;
    const hay = [el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.labels?.[0]?.innerText]
      .filter(Boolean)
      .join(" ");
    return SENSITIVE_RE.test(hay);
  }

  const ROLE_KIND = {
    button: "button", link: "link", tab: "tab", menuitem: "menuitem", option: "option", checkbox: "checkbox",
    radio: "radio", switch: "checkbox", combobox: "select", textbox: "input", searchbox: "input",
  };
  function kindOf(el) {
    const tag = el.tagName;
    if (tag === "A" && el.hasAttribute("href")) return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "hidden") return null;
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox" || t === "radio") return t;
      return "input";
    }
    if (tag === "TEXTAREA") return "input";
    if (tag === "SELECT") return "select";
    const role = el.getAttribute("role");
    if (role && ROLE_KIND[role]) return ROLE_KIND[role];
    if (el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") return "input";
    if (el.hasAttribute("onclick")) return "button";
    return null;
  }

  function labelOf(el) {
    let s = el.getAttribute("aria-label") || "";
    if (!s && el.labels?.length) s = el.labels[0].innerText;
    if (!s && el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type)) s = el.value;
    if (!s && el.tagName !== "SELECT" && el.tagName !== "TEXTAREA") s = el.innerText || "";
    if (!s) s = el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || el.getAttribute("name") || "";
    if (!s) s = el.querySelector?.("img[alt]")?.alt || "";
    return clean(s);
  }

  function shortHref(href) {
    try {
      const u = new URL(href, location.href);
      if (u.protocol === "javascript:") return "javascript";
      const path = u.pathname + u.search;
      return clip(u.origin === location.origin ? path : u.host + path, 90);
    } catch {
      return "";
    }
  }

  // ---------- page serialization ----------
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED", "HEAD", "LINK", "META"]);
  const BLOCK = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "NAV", "ASIDE", "UL", "OL", "TABLE", "THEAD", "TBODY",
    "BLOCKQUOTE", "FORM", "FIELDSET", "DL", "DT", "DD", "FIGURE", "FIGCAPTION", "DETAILS", "HR", "ADDRESS",
  ]);
  const HARD_CAP = 400_000;

  /**
   * The page as text chunks, each with the element it came from (null for layout such as newlines and list
   * markers), so a position in the text can be traced back to the page. Every interactive element gets an id: the
   * text is paged by readPage, so a long page costs more parts, never unaddressable controls.
   */
  function pageChunks() {
    const out = [];
    const srcs = [];
    const tokens = new Set(); // indexes of the [N kind "label"] chunks
    let len = 0;
    const push = (s, src = null) => {
      if (len < HARD_CAP) {
        out.push(s);
        srcs.push(src);
        len += s.length;
      }
    };

    function element(el) {
      const kind = kindOf(el);
      const id = getId(el);
      const label = labelOf(el);
      let s = `[${id} ${kind}`;
      if (kind === "link") {
        s += ` "${clip(label, 120)}"`;
        const h = shortHref(el.getAttribute("href"));
        if (h) s += ` → ${h}`;
      } else if (kind === "input") {
        const type = el.tagName === "INPUT" ? el.type || "text" : el.tagName === "TEXTAREA" ? "textarea" : "text";
        s += `(${type}) "${clip(label, 60)}"`;
        if (isSensitive(el)) s += " (sensitive, not editable)";
        else if (el.value) s += ` value="${clip(clean(el.value), 60)}"`;
      } else if (kind === "select" && el.tagName === "SELECT") {
        const opts = [...el.options].slice(0, 12).map((o) => clip(clean(o.text), 30));
        s += ` "${clip(label, 50)}" = "${clip(clean(el.selectedOptions[0]?.text || ""), 40)}" options: ${opts.join(" | ")}`;
        if (el.options.length > 12) s += ` | …(${el.options.length} total)`;
      } else if (kind === "checkbox" || kind === "radio") {
        const on = el.checked ?? el.getAttribute("aria-checked") === "true";
        s += ` "${clip(label, 80)}"${on ? " checked" : ""}`;
      } else {
        s += ` "${clip(label, 80)}"`;
        if (el.getAttribute("aria-expanded")) s += el.getAttribute("aria-expanded") === "true" ? " expanded" : " collapsed";
        if (el.getAttribute("aria-selected") === "true") s += " selected";
      }
      if (el.disabled || el.getAttribute("aria-disabled") === "true") s += " disabled";
      tokens.add(out.length);
      push(" " + s + "] ", el);
    }

    function walk(node, depth) {
      if (len >= HARD_CAP || depth > 60) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.nodeValue.replace(/\s+/g, " ");
        if (t.trim()) push(t, node.parentElement);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName;
      if (SKIP.has(tag) || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("data-lantern-ui")) return;
      if (!isVisible(el)) return;

      const kind = kindOf(el);
      if (kind) {
        element(el);
        // Links that wrap whole cards: keep their inner text too so prices/specs aren't lost.
        const inner = kind === "link" ? clean(el.innerText) : "";
        if (inner.length <= 120) return;
      }

      if (tag === "IMG") {
        const alt = clean(el.alt);
        if (alt.length > 1 && el.width >= 48 && el.height >= 48) push(` [${getId(el)} image "${clip(alt, 80)}"] `, el);
        return;
      }
      if (tag === "BR") return push("\n");
      if (tag === "PRE") return push("\n```\n" + clip(el.innerText, 3000) + "\n```\n", el);

      const h = /^H([1-6])$/.exec(tag);
      if (h) push("\n\n" + "#".repeat(Number(h[1])) + " ");
      else if (tag === "LI") push("\n- ");
      else if (tag === "TR") push("\n|");
      else if (BLOCK.has(tag)) push("\n");

      const kids = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes;
      for (const c of kids) walk(c, depth + 1);

      if (h) push("\n");
      else if (tag === "TD" || tag === "TH") push(" |");
      else if (BLOCK.has(tag)) push("\n");
    }

    walk(document.body, 0);
    return { out, srcs, tokens };
  }

  const tidy = (s) => s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  const serialize = () => tidy(pageChunks().out.join("")).trim();

  function splitParts(text, maxChars) {
    const parts = [];
    let rest = text;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf("\n", maxChars);
      if (cut < maxChars * 0.5) cut = maxChars;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    parts.push(rest);
    return parts;
  }

  /** Index of the last entry in the ascending list `starts` that is <= pos. */
  function lastAtOrBefore(starts, pos) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  const offsets = (list) => {
    let n = 0;
    return list.map((s) => ((n += s.length), n - s.length));
  };

  /**
   * Case-insensitive search over exactly the text readPage returns, so it sees nothing read_page wouldn't (no
   * sensitive field values, nothing hidden). Each match reports its readPage part, the text around it and the
   * element it sits in, which gets an id so it can be highlighted.
   */
  function findText({ query = "", maxChars = 12000, max = 10 }) {
    const words = clean(String(query)).split(" ").filter(Boolean);
    if (!words.length) throw new Error("Give some text to search for.");
    const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "gi");
    const { out, srcs, tokens } = pageChunks();
    const raw = out.join("");
    const chunkStarts = offsets(out);
    const tidied = tidy(raw);
    const text = tidied.trim();
    const lead = tidied.length - tidied.trimStart().length;
    const parts = splitParts(text, maxChars);
    const partStarts = offsets(parts); // splitParts only cuts, so the parts add up to the text

    const matches = [];
    let total = 0;
    for (const m of raw.matchAll(re)) {
      const first = lastAtOrBefore(chunkStarts, m.index);
      // In an element token, only the label and link count; "[12 button" is Lantern's notation, not page text.
      if (tokens.has(first)) {
        const quote = out[first].indexOf('"');
        if (quote === -1 || m.index - chunkStarts[first] < quote) continue;
      }
      total++;
      if (matches.length >= max) continue;
      const last = lastAtOrBefore(chunkStarts, m.index + m[0].length - 1);
      let el = null;
      let end = null;
      for (let i = first; i <= last; i++) if (srcs[i]) (el ||= srcs[i]), (end = srcs[i]);
      while (el && end && !el.contains(end)) el = el.parentElement;

      const at = Math.max(0, tidy(raw.slice(0, m.index)).length - lead);
      // A second hit in the same element and snippet adds nothing; it still counts in the total.
      const prev = matches.at(-1);
      if (prev && el && prev.id === idOf.get(el) && at - prev.at < 120) continue;
      const from = Math.max(0, at - 120);
      const to = Math.min(text.length, at + m[0].length + 120);
      matches.push({
        at,
        part: lastAtOrBefore(partStarts, at) + 1,
        id: el ? getId(el) : null,
        kind: el ? kindOf(el) || (el.tagName === "IMG" ? "image" : "text") : "text",
        text: (from > 0 ? "…" : "") + clean(text.slice(from, to)) + (to < text.length ? "…" : ""),
      });
    }
    return { ...pageMeta(), matches: matches.map(({ at, ...m }) => m), total, parts: parts.length, doc: DOC };
  }

  function pageMeta() {
    return {
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang || "",
      scroll: {
        y: Math.round(scrollY),
        viewport: innerHeight,
        height: document.documentElement.scrollHeight,
      },
    };
  }

  function readableRoot() {
    const cands = [...document.querySelectorAll("main, article, [role=main], #content, .content")];
    let best = null;
    let bestLen = 0;
    for (const c of cands) {
      const n = (c.innerText || "").length;
      if (n > bestLen) {
        best = c;
        bestLen = n;
      }
    }
    return best && bestLen > 600 ? best : document.body;
  }

  // ---------- visual helpers (overlays live in a closed shadow root the page can't style) ----------
  let overlayHost = null;
  function overlayRoot() {
    if (overlayHost?.isConnected) return overlayHost.__root;
    overlayHost = document.createElement("div");
    overlayHost.setAttribute("data-lantern-ui", "");
    Object.assign(overlayHost.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483647" });
    const root = overlayHost.attachShadow({ mode: "closed" });
    overlayHost.__root = root;
    document.documentElement.appendChild(overlayHost);
    return root;
  }
  function clearOverlay() {
    overlayHost?.remove();
    overlayHost = null;
  }
  function box(rect, { color = "#FFD400", label = null, width = 3 } = {}) {
    const root = overlayRoot();
    const b = document.createElement("div");
    Object.assign(b.style, {
      position: "fixed",
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      outline: `${width}px solid ${color}`,
      boxShadow: "0 0 0 1px #000 inset",
      boxSizing: "border-box",
    });
    root.appendChild(b);
    if (label != null) {
      const t = document.createElement("div");
      t.textContent = String(label);
      Object.assign(t.style, {
        position: "fixed",
        left: Math.max(0, rect.left) + "px",
        top: Math.max(0, rect.top) + "px",
        background: color,
        color: "#000",
        font: "bold 16px/1 system-ui, sans-serif",
        padding: "3px 5px",
        border: "1px solid #000",
        borderRadius: "3px",
      });
      root.appendChild(t);
    }
    return b;
  }
  // rAF doesn't fire in background tabs, so cap the wait.
  const nextPaint = () =>
    Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))),
      new Promise((r) => setTimeout(r, 300)),
    ]);

  function visibleFraction(r) {
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return r.width * r.height ? (w * h) / (r.width * r.height) : 0;
  }

  /** Image-like elements in view: <img>, <picture>, optionally <video>, and elements with a CSS background image. */
  function imageCandidates({ max = 60, min = 48, minVisible = 0.4, video = true } = {}) {
    const found = [];
    const seen = new Set();
    const consider = (el, src) => {
      if (found.length >= max || seen.has(el)) return;
      if (el.parentElement?.tagName === "PICTURE" && seen.has(el.parentElement)) return;
      const r = el.getBoundingClientRect();
      if (r.width < min || r.height < min || visibleFraction(r) < minVisible) return;
      if (!isVisible(el)) return;
      seen.add(el);
      found.push({ el, r, src });
    };
    for (const img of document.querySelectorAll(video ? "img, picture, video, [role=img]" : "img, picture, [role=img]")) consider(img, "img");
    let checked = 0;
    for (const el of document.querySelectorAll("div, a, span, li, figure, button, section")) {
      if (found.length >= max || ++checked > 4000) break;
      const r = el.getBoundingClientRect();
      if (r.width < min || r.height < min || r.bottom < 0 || r.top > innerHeight) continue;
      if (!getComputedStyle(el).backgroundImage.includes("url(")) continue;
      if ([...seen].some((s) => el.contains(s) || s.contains(el))) continue;
      consider(el, "bg");
    }
    return found;
  }

  const IMG_FILE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|svg)$/i;
  const absUrl = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return "";
    }
  };

  /** Largest candidate in one or more srcset strings ("a.jpg 480w, b.jpg 1080w" or "a.jpg 1x, b.jpg 2x"). */
  function srcsetBest(srcset) {
    let best = "";
    let bestSize = 0;
    for (const part of srcset.split(/,\s+/)) {
      const [url, d = "1x"] = part.trim().split(/\s+/);
      const size = parseFloat(d) * (/x$/i.test(d) ? 1000 : 1);
      if (url && size > bestSize) {
        best = url;
        bestSize = size;
      }
    }
    return best;
  }

  /**
   * The best downloadable address for an image element: a full-size file the image links straight to, else the
   * largest srcset entry, else what is displayed (or the lazy-load source when a placeholder is displayed).
   */
  function imageSource(el) {
    const link = el.closest("a[href]");
    const href = link ? absUrl(link.getAttribute("href")) : "";
    if (/^https?:/.test(href) && IMG_FILE_RE.test(new URL(href).pathname)) return href;
    const img = el.tagName === "PICTURE" ? el.querySelector("img") : el;
    if (img?.tagName === "IMG") {
      const sets = [img.getAttribute("srcset"), ...[...(img.closest("picture")?.querySelectorAll("source[srcset]") || [])].map((s) => s.getAttribute("srcset"))];
      const fromSet = srcsetBest(sets.filter(Boolean).join(", "));
      const lazy = img.dataset.src || img.dataset.original || img.dataset.lazySrc || "";
      const shown = img.currentSrc || img.getAttribute("src") || "";
      return absUrl(fromSet || (shown.startsWith("data:") && lazy ? lazy : shown) || lazy);
    }
    const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(getComputedStyle(el).backgroundImage || "");
    return m ? absUrl(m[2]) : "";
  }

  /** Images in view with their viewport rectangles (clipped to the viewport) and best source, for save_images. */
  function listImages({ min = 80 } = {}) {
    const images = imageCandidates({ max: 200, min, minVisible: 0.6, video: false }).map(({ el, r }) => {
      const x = Math.max(0, r.left);
      const y = Math.max(0, r.top);
      const img = el.tagName === "PICTURE" ? el.querySelector("img") : el;
      return {
        id: getId(el),
        rect: { x, y, w: Math.min(innerWidth, r.right) - x, h: Math.min(innerHeight, r.bottom) - y },
        src: imageSource(el),
        loaded: img?.tagName === "IMG" ? img.complete && img.naturalWidth > 0 : true,
        alt: clip(clean(el.getAttribute("alt") || img?.getAttribute?.("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || ""), 120),
      };
    });
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
    return { images, viewport: { w: innerWidth, h: innerHeight }, atBottom, doc: DOC };
  }

  async function markImages({ max = 60 } = {}) {
    clearOverlay();
    const found = imageCandidates({ max });
    const list = found.map(({ el, r }) => {
      const id = getId(el);
      box(r, { label: id });
      const link = el.closest("a[href]");
      return {
        id,
        alt: clip(clean(el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || ""), 80),
        link: link ? shortHref(link.getAttribute("href")) : "",
      };
    });
    await nextPaint();
    return { images: list, dpr: devicePixelRatio, viewport: { w: innerWidth, h: innerHeight }, doc: DOC };
  }

  // ---------- actions ----------
  function describe(el) {
    const kind = kindOf(el) || (el.tagName === "IMG" ? "image" : el.tagName.toLowerCase());
    const link = el.closest("a[href]");
    const form = el.closest("form");
    const type = (el.getAttribute("type") || "").toLowerCase();
    return {
      kind,
      tag: el.tagName,
      label: clip(labelOf(el), 120),
      href: link ? new URL(link.getAttribute("href"), location.href).href : "",
      download: !!link?.hasAttribute("download"),
      inForm: !!form,
      formMethod: (form?.getAttribute("method") || "get").toLowerCase(),
      isSubmit: el.tagName === "BUTTON" ? type === "submit" || (!type && !!form) : type === "submit" || type === "image",
      sensitive: isSensitive(el),
      visible: isVisible(el),
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      readOnly: !!el.readOnly,
      searchField: type === "search" || el.getAttribute("role") === "searchbox" || !!el.closest("[role=search]"),
      doc: DOC,
    };
  }

  /** Refuse to act on elements a user couldn't act on either. */
  function actionable(el, id) {
    if (!isVisible(el)) throw new Error(`[${id}] is hidden. Read the page again.`);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") throw new Error(`[${id}] is disabled.`);
  }

  function flash(el, color = "#22C55E") {
    const r = el.getBoundingClientRect();
    const b = box(r, { color, width: 3 });
    setTimeout(() => b.remove(), 900);
  }

  async function click({ id, doc }) {
    checkDoc(doc);
    const el = getEl(id);
    actionable(el, id);
    el.scrollIntoView({ block: "center", inline: "nearest" });
    await nextPaint();
    flash(el);
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
    return { ok: true };
  }

  async function typeText({ id, text, submit = false, doc }) {
    checkDoc(doc);
    const el = getEl(id);
    if (isSensitive(el)) throw new Error("Refused: this is a password/payment/ID field. Ask the user to fill it in.");
    actionable(el, id);
    if (el.readOnly) throw new Error(`[${id}] is read-only.`);
    if (kindOf(el) !== "input") throw new Error(`[${id}] is not a text field.`);
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) {
      document.getSelection().selectAllChildren(el);
      document.execCommand("insertText", false, text);
    } else {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    flash(el);
    if (submit) {
      const kd = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      const notCancelled = el.dispatchEvent(new KeyboardEvent("keydown", kd));
      el.dispatchEvent(new KeyboardEvent("keyup", kd));
      if (notCancelled && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    }
    return { ok: true };
  }

  function selectOption({ id, value, doc }) {
    checkDoc(doc);
    const el = getEl(id);
    actionable(el, id);
    if (el.tagName !== "SELECT") throw new Error(`[${id}] is not a dropdown; click it instead.`);
    const want = clean(String(value)).toLowerCase();
    const opt =
      [...el.options].find((o) => o.value.toLowerCase() === want || clean(o.text).toLowerCase() === want) ||
      [...el.options].find((o) => clean(o.text).toLowerCase().includes(want));
    if (!opt) throw new Error(`No option matching "${value}".`);
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    flash(el);
    return { ok: true, selected: clean(opt.text) };
  }

  function scrollPage({ direction = "down" }) {
    const dy = Math.round(innerHeight * 0.85) * (direction === "up" ? -1 : 1);
    if (direction === "top") scrollTo(0, 0);
    else if (direction === "bottom") scrollTo(0, document.documentElement.scrollHeight);
    else scrollBy(0, dy);
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
    return { y: Math.round(scrollY), height: document.documentElement.scrollHeight, atBottom };
  }

  /**
   * A table cell's whole row (so "RAM" is outlined together with "16 GB"), unless the row is page layout rather than
   * data: a presentation table, or a row taller than half the screen.
   */
  function rowOf(el) {
    const tr = el.closest("td, th")?.parentElement;
    if (tr?.tagName !== "TR" || tr.closest("table").getAttribute("role") === "presentation") return el;
    return tr.getBoundingClientRect().height <= innerHeight / 2 ? tr : el;
  }

  // Outlines on screen (their removers). The user can dismiss them all with Esc or a click on the page. Only real
  // input counts: the agent's own clicks are synthetic, and clicks on a scrollbar are scrolling, not dismissing.
  const highlights = new Set();
  function dismissHighlights(e) {
    if (!e.isTrusted || (e.type === "keydown" && e.key !== "Escape")) return;
    if (e.type === "pointerdown" && onScrollbar(e)) return;
    for (const done of [...highlights]) done();
  }
  // Scrollbars sit just outside an element's client area. The page's own are measured in the viewport, because on
  // <html> offsetY counts from the top of the document.
  function onScrollbar(e) {
    const t = e.target;
    if (t === document.documentElement || t === document.scrollingElement) return e.clientX >= t.clientWidth || e.clientY >= t.clientHeight;
    return t instanceof Element && t.clientWidth > 0 && (e.offsetX >= t.clientWidth || e.offsetY >= t.clientHeight);
  }

  async function highlight({ id, keep = 30000, doc }) {
    checkDoc(doc);
    const el = rowOf(getEl(id));
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await nextPaint();
    const b = box(el.getBoundingClientRect(), { color: "#F97316", width: 5 });
    // Overlays are fixed to the viewport, so move this one with the element when the page, a scrolling container or
    // the layout around it moves. Ends when the time is up, the user dismisses it or the overlay is cleared.
    let frame = 0;
    const place = () => {
      frame = 0;
      if (!b.isConnected || !el.isConnected) return done();
      const r = el.getBoundingClientRect();
      Object.assign(b.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    };
    const onMove = () => (frame ||= requestAnimationFrame(place));
    const resized = new ResizeObserver(onMove);
    const done = () => {
      b.remove();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      removeEventListener("scroll", onMove, true);
      removeEventListener("resize", onMove);
      resized.disconnect();
      highlights.delete(done);
      if (!highlights.size) {
        removeEventListener("pointerdown", dismissHighlights, true);
        removeEventListener("keydown", dismissHighlights, true);
      }
    };
    if (!highlights.size) {
      addEventListener("pointerdown", dismissHighlights, true);
      addEventListener("keydown", dismissHighlights, true);
    }
    highlights.add(done);
    addEventListener("scroll", onMove, { capture: true, passive: true });
    addEventListener("resize", onMove, { passive: true });
    resized.observe(document.body);
    resized.observe(el);
    const timer = setTimeout(done, keep);
    return { ok: true, row: el.tagName === "TR" };
  }

  async function rectOf({ id, doc }) {
    checkDoc(doc);
    const el = getEl(id);
    if (visibleFraction(el.getBoundingClientRect()) < 0.9) {
      el.scrollIntoView({ block: "center", inline: "center" });
      await nextPaint();
    }
    const r = el.getBoundingClientRect();
    return { rect: { x: r.left, y: r.top, w: r.width, h: r.height }, viewport: { w: innerWidth, h: innerHeight } };
  }

  // ---------- in-place translation ----------
  let segNodes = [];
  const originals = new Map();
  const NO_TRANSLATE = "script,style,noscript,code,pre,kbd,samp,textarea,[translate=no],.notranslate,[data-lantern-ui]";

  function collectSegments() {
    segNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        const t = originals.get(n) ?? n.nodeValue;
        if (!p || !t || !/\p{L}/u.test(t)) return NodeFilter.FILTER_REJECT;
        if (p.closest(NO_TRANSLATE) || p.isContentEditable || !isVisible(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const inView = [];
    const below = [];
    const above = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = segNodes.push(n) - 1;
      const seg = { i, t: clean(originals.get(n) ?? n.nodeValue) };
      const r = n.parentElement.getBoundingClientRect();
      (r.bottom < 0 ? above : r.top > innerHeight ? below : inView).push(seg);
    }
    return { segments: [...inView, ...below, ...above] };
  }

  function applySegments({ items }) {
    let n = 0;
    for (const { i, t } of items) {
      const node = segNodes[i];
      if (!node?.isConnected || typeof t !== "string") continue;
      const orig = originals.get(node) ?? node.nodeValue;
      if (!originals.has(node)) originals.set(node, orig);
      node.nodeValue = orig.match(/^\s*/)[0] + t.trim() + orig.match(/\s*$/)[0];
      n++;
    }
    return { applied: n };
  }

  function restoreOriginal() {
    for (const [node, orig] of originals) if (node.isConnected) node.nodeValue = orig;
    const n = originals.size;
    originals.clear();
    return { restored: n };
  }

  // ---------- message router ----------
  const handlers = {
    ping: () => ({ ok: true }),
    meta: () => pageMeta(),
    selection: () => ({ text: String(getSelection() || "").trim() }),
    readPage: ({ maxChars = 12000, part = 1 }) => {
      const parts = splitParts(serialize(), maxChars);
      const p = Math.min(Math.max(1, part | 0), parts.length);
      return { ...pageMeta(), part: p, parts: parts.length, text: parts[p - 1], doc: DOC };
    },
    find: findText,
    getText: ({ maxChars = 300_000 }) => {
      const text = (readableRoot().innerText || "")
        .split("\n")
        .map((l) => l.replace(/[ \t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return { ...pageMeta(), selection: String(getSelection() || "").trim(), text: text.slice(0, maxChars), length: text.length };
    },
    describe: ({ id, doc }) => (checkDoc(doc), describe(getEl(id))),
    click,
    type: typeText,
    select: selectOption,
    scroll: scrollPage,
    highlight,
    rect: rectOf,
    markImages,
    listImages,
    clearMarks: () => (clearOverlay(), { ok: true }),
    collectSegments,
    applySegments,
    restoreOriginal,
    hasTranslation: () => ({ translated: originals.size > 0 }),
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.lantern !== true) return;
    const fn = handlers[msg.op];
    if (!fn) return Promise.resolve({ error: `unknown op ${msg.op}` });
    return Promise.resolve()
      .then(() => fn(msg.args || {}))
      .catch((e) => ({ error: String(e?.message || e) }));
  });
})();
