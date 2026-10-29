// PageMortem content script. Injected on demand into the tab being read or operated.
// It never makes network requests; it only reads the DOM (and, while capturing downloads, blob:/data: files the page made)
// and performs the actions it is asked to.
(() => {
  "use strict";
  if (window.__pagemortemReady) return;
  window.__pagemortemReady = true;

  // Identifies this document. The agent passes it back with every action so an id read from one
  // page can never act on another page that happens to reuse the same number.
  const DOC = [...crypto.getRandomValues(new Uint32Array(2))].map((n) => n.toString(36)).join("");
  const checkDoc = (doc) => {
    if (doc !== DOC) throw new Error("The page changed since it was read. Read the page again to get fresh numbers.");
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

  const SENSITIVE_RE = /(passw|card.?(num|no)|cc.?(num|csc|exp)|cvv|cvc|csc|security.?code|expir|iban|routing|account.?num|ssn|social.?sec|\bpin\b|otp|one.?time|api\s*key|access\s*token|\bsecret\b|recovery\s*code)/i;
  function isSensitive(el) {
    if (!el || !el.tagName) return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (type === "password" || ac.includes("password") || ac.startsWith("cc-") || ac.includes(" cc-") || ac === "one-time-code") return true;
    // Every source labelOf can show, so a field is never displayed as "Password" with its value next to it.
    const hay = [el.name, el.id, el.getAttribute("aria-label"), labelledBy(el), el.getAttribute("placeholder"), el.getAttribute("title"),
      ...[...(el.labels || [])].map((l) => l.innerText)]
      .filter(Boolean)
      .join(" ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ");
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

  /** Text of the elements aria-labelledby names. */
  function labelledBy(el) {
    return (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.innerText || "").join(" ").trim();
  }

  function labelOf(el) {
    let s = el.getAttribute("aria-label") || labelledBy(el);
    if (!s && el.labels?.length) s = el.labels[0].innerText;
    if (!s && el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type)) s = el.value;
    if (!s && el.tagName !== "SELECT" && el.tagName !== "TEXTAREA") s = el.innerText || "";
    if (!s) s = el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || el.getAttribute("name") || "";
    if (!s) s = el.querySelector?.("img[alt]")?.alt || "";
    return clean(s);
  }

  function shortHref(href) {
    try {
      const u = new URL(href, document.baseURI || location.href);
      if (u.protocol === "javascript:") return "javascript";
      const path = u.pathname + u.search;
      return clip(u.origin === location.origin ? path : u.host + path, 90);
    } catch {
      return "";
    }
  }

  // ---------- page serialization ----------
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED", "HEAD", "LINK", "META"]);

  /** Text inside el that the current layout hides, e.g. the long form of a label shown only on wide screens. */
  function hiddenText(el) {
    const out = [];
    let len = 0;
    const visit = (node) => {
      for (const c of node.childNodes) {
        if (len > 200) return;
        if (c.nodeType !== Node.ELEMENT_NODE || SKIP.has(c.tagName) || c.getAttribute("aria-hidden") === "true") continue;
        if (isVisible(c)) visit(c);
        else {
          const t = clean(c.textContent);
          if (t) out.push(t), (len += t.length);
        }
      }
    };
    visit(el);
    return clean(out.join(" "));
  }
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
      // Responsive sites swap labels by screen width ("Files" / "Files and versions"); the hidden one is what the
      // model may know the control by, so it is shown and searchable.
      let alt = ["link", "button", "tab", "menuitem"].includes(kind) ? hiddenText(el) : "";
      alt = alt && !label.toLowerCase().includes(alt.toLowerCase()) ? ` (also "${clip(alt, 80)}")` : "";
      if (kind === "link") {
        s += ` "${clip(label, 120)}"${alt}`;
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
        s += ` "${clip(label, 80)}"${alt}`;
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
      if (SKIP.has(tag) || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("data-pagemortem-ui")) return;
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

    // The product facts are added after the visible text, outside HARD_CAP, so a long page never pushes them out.
    const ld = structuredData();
    walk(document.body, 0);
    if (ld) out.push(ld), srcs.push(null);
    return { out, srcs, tokens };
  }

  // ---------- structured data ----------
  const LD_CAP = 20_000;
  const LD_ROWS = 200;
  const ldTypes = (o) => [].concat(o?.["@type"] || []).map(String);
  const ldText = (v) => clean(typeof v === "object" && v ? v.name ?? v["@value"] ?? "" : v == null ? "" : String(v));
  const schemaTail = (v) => ldText(v).replace(/^https?:\/\/schema\.org\//i, "");

  function ldOffer(offers) {
    const o = [].concat(offers || [])[0];
    if (!o || typeof o !== "object") return "";
    const spec = [].concat(o.priceSpecification || [])[0] || {};
    const cur = ldText(o.priceCurrency ?? spec.priceCurrency);
    const price = o.lowPrice != null && o.highPrice != null && o.lowPrice !== o.highPrice ? `${ldText(o.lowPrice)}–${ldText(o.highPrice)}`
      : ldText(o.price ?? o.lowPrice ?? spec.price);
    return [price && (cur ? `${price} ${cur}` : price), schemaTail(o.availability)].filter(Boolean).join(", ");
  }

  /** One line per product; a variant's own name usually already says its color and size. */
  function ldProductLine(p, prefix) {
    const name = ldText(p.name);
    const extra = ["color", "size", "material"].map((k) => ldText(p[k])).filter((v) => v && !name.toLowerCase().includes(v.toLowerCase()));
    const offer = ldOffer(p.offers);
    return clip(`${prefix}${name || "(unnamed)"}${extra.length ? ` (${extra.join(", ")})` : ""}${offer ? ` — ${offer}` : ""}`, 240);
  }

  /**
   * Product facts the page publishes as JSON-LD for search engines. Stores often list every variant (each color,
   * size and its price and stock) there while the page shows them only as unlabeled swatches. Page-authored like
   * the rest of the text, so equally untrusted. Other JSON-LD types (articles, breadcrumbs, organizations) repeat
   * what the page shows and are left out.
   */
  function structuredData() {
    const products = [];
    const collect = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 6) return;
      if (Array.isArray(node)) return node.forEach((n) => collect(n, depth + 1));
      const types = ldTypes(node);
      if (types.some((t) => t === "Product" || t === "ProductGroup")) return void products.push(node);
      if (node["@graph"]) collect(node["@graph"], depth + 1);
      for (const el of [].concat(node.itemListElement || [])) collect(el?.item ?? el, depth + 1);
    };
    for (const s of document.querySelectorAll?.('script[type="application/ld+json"]') || []) {
      try {
        collect(JSON.parse(s.textContent || ""), 0);
      } catch {} // sites ship broken JSON-LD; the visible page still reads fine
    }
    if (!products.length) return "";
    const lines = [];
    let rows = 0;
    for (const p of products) {
      const variants = [].concat(p.hasVariant || []).filter((v) => v && typeof v === "object");
      const brand = ldText(p.brand);
      let head = ldProductLine(p, `${ldTypes(p).includes("ProductGroup") ? "Product group" : "Product"}: `);
      if (brand) head += ` · brand ${brand}`;
      if (variants.length) head += ` · ${variants.length} variant${variants.length === 1 ? "" : "s"}`;
      lines.push(head);
      for (const v of variants) if (rows++ < LD_ROWS) lines.push(ldProductLine(v, "- "));
    }
    if (rows > LD_ROWS) lines.push(`- …(${rows - LD_ROWS} more variants not shown)`);
    let text = lines.join("\n");
    if (text.length > LD_CAP) text = text.slice(0, text.lastIndexOf("\n", LD_CAP)) + "\n- …(truncated)";
    return `\n\n## Structured product data (from the page's JSON-LD)\n${text}\n`;
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
   * sensitive field values, nothing hidden beyond the structured product data). Each match reports its readPage part, the text around it and the
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
      // In an element token, only the label and link count; "[12 button" is PageMortem's notation, not page text.
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

  /** The main content element and its innerText, measured once. */
  function readableRoot() {
    const all = document.querySelectorAll("main, article, [role=main], #content, .content");
    // A candidate inside another never has more text than it and loses ties to it, so only the outermost are measured.
    const cands = [...all].filter((c) => !c.parentElement?.closest("main, article, [role=main], #content, .content"));
    let best = null;
    let bestText = "";
    for (const c of cands) {
      const text = c.innerText || "";
      if (text.length > bestText.length) {
        best = c;
        bestText = text;
      }
    }
    return best && bestText.length > 600 ? { root: best, text: bestText } : { root: document.body, text: document.body.innerText || "" };
  }

  // ---------- Markdown export ----------
  // Copy as Markdown converts the DOM in code, without a model, so nothing is shortened or reworded.
  const MD_CAP = 2_000_000;
  const MD_INLINE = new Set([
    "A", "ABBR", "B", "BDI", "BDO", "BR", "CITE", "CODE", "DATA", "DEL", "DFN", "EM", "FONT", "I", "IMG", "INS", "KBD",
    "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRIKE", "STRONG", "SUB", "SUP", "TIME", "TT", "U", "VAR", "WBR",
  ]);
  // Form controls are left out: their values may be private, and their labels are interface, not content.
  const MD_DROP = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "DIALOG", "MENU"]);
  const MD_TABLE_ROLES = new Set(["table", "grid", "treegrid"]);
  const MD_CELL_ROLES = new Set(["cell", "gridcell", "columnheader", "rowheader"]);
  const mdKids = (el) => (el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : [...el.childNodes]);
  const mdRole = (el) => el.getAttribute("role") || "";
  const mdRun = (s, ch) => Math.max(0, ...(s.match(new RegExp(`\\${ch}+`, "g")) || []).map((m) => m.length));

  /** Escapes text so it reads as itself, not as Markdown. Underscores inside words (snake_case) are left alone. */
  function mdEscape(s) {
    return s
      .replace(/[\\`*[\]]/g, "\\$&")
      .replace(/_/g, (m, i, all) => (/\w/.test(all[i - 1] || "") && /\w/.test(all[i + 1] || "") ? m : "\\_"))
      .replace(/<(?=[A-Za-z/!?])/g, "\\<");
  }
  /** Escapes what would start a heading, quote, list or rule at the start of a line. */
  const mdLineStart = (l) =>
    l.replace(/^([#>]|[-+=](?=\s|$)|[-=]+\s*$)/, "\\$1").replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2");
  const mdUrl = (u) => u.replace(/[()\s|]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  function mdResolve(href, schemes = /^(https?|mailto|ftp):$/) {
    try {
      const u = new URL(href, document.baseURI || location.href);
      return schemes.test(u.protocol) ? u.href : "";
    } catch {
      return "";
    }
  }
  function mdWrap(s, mark) {
    const t = s.trim();
    return t ? s.match(/^\s*/)[0] + mark + t + mark + s.match(/\s*$/)[0] : s;
  }
  function mdCode(t) {
    if (!t) return "";
    const ticks = "`".repeat(mdRun(t, "`") + 1);
    const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
    return ticks + pad + t + pad + ticks;
  }

  function mdSkip(el, env) {
    return (
      SKIP.has(el.tagName) || MD_DROP.has(el.tagName) || el.getAttribute("aria-hidden") === "true" ||
      el.hasAttribute("data-pagemortem-ui") || !isVisible(el) ||
      // Site navigation is chrome, unless the user selected it.
      (!env.range && (el.tagName === "NAV" || mdRole(el) === "navigation")) ||
      (env.range && !env.range.intersectsNode(el))
    );
  }

  /** Whether el is laid out as a block. An inline element that wraps blocks (a link around a whole card) counts as one. */
  function mdIsBlock(el, env) {
    let b = env.blocks.get(el);
    if (b !== undefined) return b;
    if (MD_INLINE.has(el.tagName)) b = false;
    else if (el.tagName.includes("-") && typeof getComputedStyle === "function") b = !getComputedStyle(el).display.startsWith("inline");
    else b = true;
    if (!b) b = mdKids(el).some((c) => c.nodeType === Node.ELEMENT_NODE && mdIsBlock(c, env));
    env.blocks.set(el, b);
    return b;
  }

  function mdText(node, env) {
    let t = node.nodeValue || "";
    const r = env.range;
    if (r) {
      if (!r.intersectsNode(node)) return "";
      if (node === r.endContainer) t = t.slice(0, r.endOffset);
      if (node === r.startContainer) t = t.slice(r.startOffset);
    }
    return mdEscape(t.replace(/\s+/g, " "));
  }

  function mdInline(node, env) {
    if (node.nodeType === Node.TEXT_NODE) return mdText(node, env);
    if (node.nodeType !== Node.ELEMENT_NODE || mdSkip(node, env)) return "";
    const el = node;
    const tag = el.tagName;
    if (tag === "BR") return "\n";
    if (tag === "IMG") return mdImage(el);
    if (tag === "CODE" || tag === "KBD" || tag === "SAMP" || tag === "TT") return mdCode(clean(el.textContent));
    const inner = mdKids(el).map((c) => mdInline(c, env)).join("");
    if (tag === "A") return mdLink(el, inner);
    if (tag === "STRONG" || tag === "B") return mdWrap(inner, "**");
    if (tag === "EM" || tag === "I") return mdWrap(inner, "*");
    if (tag === "DEL" || tag === "S" || tag === "STRIKE") return mdWrap(inner, "~~");
    return inner;
  }

  function mdLink(el, text) {
    const url = mdResolve(el.getAttribute("href") || "");
    const t = text.replace(/\s+/g, " ").trim();
    if (!url || !t) return text;
    if (t === mdEscape(url)) return `<${url}>`;
    return text.match(/^\s*/)[0] + `[${t}](${mdUrl(url)})` + text.match(/\s*$/)[0];
  }

  function mdImage(el) {
    // Icons and spacers are noise; the page text serializer skips them the same way.
    if (el.width && el.height && el.width < 48 && el.height < 48) return "";
    // blob: and data: images can't be fetched from the copied text, and data: ones can be megabytes long.
    const url = mdResolve(el.currentSrc || el.getAttribute("src") || "", /^https?:$/);
    if (!url) return "";
    const alt = clean(el.getAttribute("alt") || "").replace(/[[\]\\]/g, "\\$&");
    return `![${alt}](${mdUrl(url)})`;
  }

  /** A run of inline Markdown as paragraphs: blank lines (two <br>s) split it, single line breaks become hard breaks. */
  function mdPara(s) {
    return s
      .split(/\n\s*\n/)
      .map((p) => p.split("\n").map((l) => mdLineStart(l.replace(/\s+/g, " ").trim())).filter(Boolean).join("  \n"))
      .filter(Boolean)
      .join("\n\n");
  }

  /** The children of el as Markdown blocks. */
  function mdBlocks(el, env) {
    const out = [];
    let run = "";
    const flush = () => {
      const p = mdPara(run);
      if (p) out.push(p), (env.len += p.length);
      run = "";
    };
    for (const c of mdKids(el)) {
      if (env.len > MD_CAP) {
        env.cut = true;
        break;
      }
      if (c.nodeType === Node.ELEMENT_NODE && !mdSkip(c, env) && mdIsBlock(c, env)) {
        flush();
        out.push(...mdBlock(c, env).filter(Boolean));
      } else run += mdInline(c, env);
    }
    flush();
    return out;
  }

  /** Blocks of one item, kept tight: a nested list follows its text on the next line, not after a blank one. */
  function mdJoinItem(blocks) {
    return blocks.reduce((s, b, i) => (i ? s + (/^(- |\d+\. )/.test(b) ? "\n" : "\n\n") : "") + b, "");
  }

  function mdBlock(el, env) {
    const tag = el.tagName;
    const h = /^H([1-6])$/.exec(tag);
    if (h) {
      const t = mdKids(el).map((c) => mdInline(c, env)).join("").replace(/\s+/g, " ").trim();
      return t ? ["#".repeat(Number(h[1])) + " " + t] : [];
    }
    if (tag === "HR") return ["---"];
    if (tag === "PRE") {
      const pre = mdPre(el);
      env.len += pre.length;
      return [pre];
    }
    if (tag === "UL" || tag === "OL") return mdList(el, env);
    if (tag === "TABLE" || MD_TABLE_ROLES.has(mdRole(el))) {
      const table = mdTable(el, env);
      if (table) return table;
    }
    if (tag === "BLOCKQUOTE") {
      const inner = mdBlocks(el, env).join("\n\n");
      return inner ? [inner.split("\n").map((l) => (l ? "> " + l : ">")).join("\n")] : [];
    }
    if (tag === "DT") {
      const t = mdKids(el).map((c) => mdInline(c, env)).join("").replace(/\s+/g, " ").trim();
      return t ? [mdWrap(t, "**")] : [];
    }
    const blocks = mdBlocks(el, env);
    // A link around a whole card: link its title, so a listing keeps where each item goes.
    const url = tag === "A" && mdResolve(el.getAttribute("href") || "");
    const at = url ? blocks.findIndex((b) => !b.includes("\n") && !b.includes("](")) : -1;
    if (at >= 0) {
      const [, mark, text] = /^(#{1,6} )?(.*)$/.exec(blocks[at]);
      blocks[at] = `${mark || ""}[${text}](${mdUrl(url)})`;
    }
    return blocks;
  }

  function mdPre(el) {
    const code = (el.innerText ?? el.textContent ?? "").replace(/\n+$/, "");
    const cls = `${el.getAttribute("class") || ""} ${el.querySelector?.("code")?.getAttribute("class") || ""}`;
    const lang = /(?:^|\s)lang(?:uage)?-([\w+#.-]+)/.exec(cls)?.[1] || "";
    const fence = "`".repeat(Math.max(3, mdRun(code, "`") + 1));
    return `${fence}${lang}\n${code}\n${fence}`;
  }

  function mdList(el, env) {
    const ordered = el.tagName === "OL";
    let n = parseInt(el.getAttribute("start") ?? "1", 10);
    if (!Number.isFinite(n)) n = 1;
    const items = [];
    for (const li of mdKids(el)) {
      if (li.nodeType !== Node.ELEMENT_NODE || mdSkip(li, env)) continue;
      const marker = ordered ? `${n++}. ` : "- ";
      // Task lists: the checkbox is a form control, so it is dropped with the others and shown as [x] here.
      const box = mdKids(li).flatMap((c) => (c.nodeType === Node.ELEMENT_NODE && c.tagName !== "UL" && c.tagName !== "OL" ? [c, ...mdKids(c)] : []))
        .find((c) => c.tagName === "INPUT" && c.getAttribute("type") === "checkbox");
      const task = box ? (box.checked ?? box.hasAttribute("checked") ? "[x] " : "[ ] ") : "";
      const body = mdJoinItem(li.tagName === "LI" ? mdBlocks(li, env) : mdBlock(li, env));
      const pad = " ".repeat(marker.length);
      items.push(body.split("\n").map((l, i) => (i ? (l ? pad + l : "") : marker + task + l)).join("\n"));
    }
    return items.length ? [items.join("\n")] : [];
  }

  /** Rows of cells, for <table> or an ARIA table/grid. A nested table's rows belong to it, not to this one. */
  function mdRows(el, env) {
    const rows = [];
    if (el.tagName === "TABLE" && !MD_TABLE_ROLES.has(mdRole(el))) {
      const visit = (node) => {
        for (const c of mdKids(node)) {
          if (c.nodeType !== Node.ELEMENT_NODE || mdSkip(c, env)) continue;
          if (c.tagName === "TR") rows.push(mdKids(c).filter((d) => d.nodeType === Node.ELEMENT_NODE && (d.tagName === "TD" || d.tagName === "TH") && !mdSkip(d, env)));
          else if (c.tagName === "THEAD" || c.tagName === "TBODY" || c.tagName === "TFOOT") visit(c);
        }
      };
      visit(el);
      return rows;
    }
    const find = (node, want, stop, out) => {
      for (const c of mdKids(node)) {
        if (c.nodeType !== Node.ELEMENT_NODE || mdSkip(c, env)) continue;
        if (want(c)) out.push(c);
        else if (!stop(c)) find(c, want, stop, out);
      }
      return out;
    };
    const isTable = (c) => c.tagName === "TABLE" || MD_TABLE_ROLES.has(mdRole(c));
    for (const row of find(el, (c) => mdRole(c) === "row", isTable, [])) {
      rows.push(find(row, (c) => MD_CELL_ROLES.has(mdRole(c)), (c) => isTable(c) || mdRole(c) === "row", []));
    }
    return rows;
  }

  const mdHead = (cell) => cell.tagName === "TH" || mdRole(cell) === "columnheader";

  function mdCell(cell, env) {
    return mdBlocks(cell, env).join("\n").replace(/ *\n+ */g, "<br>").replace(/\|/g, "\\|").trim();
  }

  /**
   * A GFM table, or null when el is laid out as a table but holds no data: role=presentation, one column, or another
   * table inside it. Then its cells are read as ordinary blocks. Spanned cells are filled in: a rowspan repeats its value
   * down the rows, a colspan repeats it across header rows (whose text is then joined per column) and is left empty
   * across data rows.
   */
  function mdTable(el, env) {
    if (/^(presentation|none)$/.test(mdRole(el))) return null;
    const rows = mdRows(el, env).filter((r) => r.length);
    if (!rows.length || Math.max(...rows.map((r) => r.length)) < 2) return null;
    if (rows.some((r) => r.some((c) => c.querySelector?.("table, [role=table], [role=grid], [role=treegrid]")))) return null;

    const grid = rows.map(() => []);
    rows.forEach((cells, r) => {
      let c = 0;
      for (const cell of cells) {
        while (grid[r][c]) c++;
        const cs = Math.min(Math.max(parseInt(cell.getAttribute("colspan"), 10) || 1, 1), 100);
        const rsRaw = parseInt(cell.getAttribute("rowspan"), 10);
        const rs = rsRaw === 0 ? rows.length - r : Math.min(Math.max(rsRaw || 1, 1), rows.length - r);
        const value = { text: mdCell(cell, env), head: mdHead(cell), spanned: cs > 1 || rs > 1 };
        for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = { value, first: dc === 0 };
        c += cs;
      }
    });
    const width = Math.max(...grid.map((r) => r.length));
    if (width < 2) return null;

    // Header rows: the table's <thead>, else the leading rows made only of header cells.
    const inHead = (r) => r[0].parentElement?.parentElement?.tagName === "THEAD";
    let heads = rows.some(inHead) ? rows.findIndex((r) => !inHead(r)) : 0;
    if (heads < 0) heads = rows.length;
    if (!heads) while (heads < grid.length && grid[heads].every((g) => !g || g.value.head)) heads++;
    if (heads === grid.length) heads = Math.min(1, heads); // all headers: the first is the header, the rest are data

    const text = (g, inHead) => (g && (g.first || inHead) ? g.value.text : "");
    const header = Array.from({ length: width }, (_, c) => {
      const parts = [];
      for (let r = 0; r < heads; r++) {
        const t = text(grid[r][c], true);
        if (t && parts.at(-1) !== t) parts.push(t);
      }
      return parts.join(" / ");
    });
    const line = (cells) => `| ${cells.join(" | ")} |`;
    const body = grid
      .slice(heads)
      .map((r) => Array.from({ length: width }, (_, c) => text(r[c], false)))
      .filter((cells) => cells.some(Boolean));
    env.tables++;
    const out = [];
    const caption = mdKids(el).find((c) => c.tagName === "CAPTION");
    const captionText = caption && mdKids(caption).map((c) => mdInline(c, env)).join("").replace(/\s+/g, " ").trim();
    if (captionText) out.push(mdWrap(captionText, "**"));
    const markdown = [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
    out.push(markdown);

    // What the rules above may have gotten wrong. These tables are offered to the model to redo from their HTML.
    const reasons = [];
    if (grid.some((r) => r.length < width || r.includes(undefined))) reasons.push("rows have different numbers of cells");
    if (grid.slice(heads).some((r) => r.some((g) => g?.value.spanned))) reasons.push("merged cells in the data");
    if (heads > 1) reasons.push("a header over several rows");
    if (!heads && body.length > 1) reasons.push("no header row");
    if (body.some((cells) => cells.some((t) => /(^|<br>)(- |\d+\. )/.test(t)))) reasons.push("lists inside cells");
    const cells = body.flat();
    if (cells.length >= 6 && cells.filter((t) => !t).length > cells.length * 0.4) reasons.push("many empty cells");
    if (reasons.length) {
      const html = mdHtml(el, env);
      if (html.length <= MD_REPAIR_HTML) env.flagged.push({ markdown, html, reasons });
    }
    return out;
  }

  // The HTML a flagged table is sent to the model as: structure, spans, text and links only, no classes or styles.
  const MD_REPAIR_HTML = 16_000;
  const MD_HTML_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "UL", "OL", "LI", "P", "BR", "A", "STRONG", "B", "EM", "I", "CODE", "IMG", "SUP", "SUB"]);
  const htmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function mdHtml(node, env) {
    if (node.nodeType === Node.TEXT_NODE) return env.range && !env.range.intersectsNode(node) ? "" : htmlEscape((node.nodeValue || "").replace(/\s+/g, " "));
    if (node.nodeType !== Node.ELEMENT_NODE || mdSkip(node, env) || node.tagName === "CAPTION") return "";
    const tag = node.tagName;
    const role = mdRole(node);
    const inner = mdKids(node).map((c) => mdHtml(c, env)).join("");
    const tableRole = MD_TABLE_ROLES.has(role) || MD_CELL_ROLES.has(role) || role === "row";
    if (!MD_HTML_TAGS.has(tag) && !tableRole) return inner;
    const name = MD_HTML_TAGS.has(tag) ? tag.toLowerCase() : "div";
    let attrs = "";
    for (const a of ["colspan", "rowspan", "scope"]) if (node.getAttribute(a)) attrs += ` ${a}="${htmlEscape(node.getAttribute(a))}"`;
    if (tableRole) attrs += ` role="${role}"`;
    if (tag === "A" && mdResolve(node.getAttribute("href") || "")) attrs += ` href="${htmlEscape(mdResolve(node.getAttribute("href")))}"`;
    if (tag === "IMG") {
      const src = mdResolve(node.currentSrc || node.getAttribute("src") || "", /^https?:$/);
      if (!src) return "";
      attrs += ` src="${htmlEscape(src)}" alt="${htmlEscape(clean(node.getAttribute("alt") || ""))}"`;
    }
    return tag === "BR" || tag === "IMG" ? `<${name}${attrs}>` : `<${name}${attrs}>${inner}</${name}>`;
  }

  /** The selection, or else the page's main content, as Markdown. */
  function pageMarkdown() {
    const sel = getSelection();
    const range = sel?.rangeCount && String(sel).trim() ? sel.getRangeAt(0) : null;
    const env = { range, tables: 0, flagged: [], len: 0, blocks: new WeakMap() };
    let root = range ? range.commonAncestorContainer : readableRoot().root;
    if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
    let md = mdBlock(root, env).join("\n\n");
    const title = clean(document.title);
    if (!range && title && !/^# /m.test(md)) md = `# ${mdEscape(title)}\n\n${md}`;
    const truncated = !!env.cut || md.length > MD_CAP;
    if (truncated) md = md.slice(0, MD_CAP);
    // A flagged table cut off by the length cap can't be swapped for a repaired one.
    const flagged = env.flagged.filter((t) => md.includes(t.markdown));
    return { ...pageMeta(), markdown: md.trim(), tables: env.tables, flagged, selection: !!range, truncated };
  }

  // ---------- visual helpers (overlays live in a closed shadow root the page can't style) ----------
  let overlayHost = null;
  function overlayRoot() {
    if (overlayHost?.isConnected) return overlayHost.__root;
    overlayHost = document.createElement("div");
    overlayHost.setAttribute("data-pagemortem-ui", "");
    Object.assign(overlayHost.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483647" });
    const root = overlayHost.attachShadow({ mode: "closed" });
    overlayHost.__root = root;
    document.documentElement.appendChild(overlayHost);
    return root;
  }
  function clearOverlay() {
    overlayHost?.remove();
    for (const done of [...highlights]) done();
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
        // What is actually displayed; the agent falls back to it when the best source is on another site.
        shown: img?.tagName === "IMG" ? absUrl(img.currentSrc || img.getAttribute("src") || "") : imageSource(el),
        loaded: img?.tagName === "IMG" ? img.complete && img.naturalWidth > 0 : true,
        alt: clip(clean(el.getAttribute("alt") || img?.getAttribute?.("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || ""), 120),
      };
    });
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
    return { images, viewport: { w: innerWidth, h: innerHeight }, atBottom, doc: DOC };
  }

  /** The image a menu click was on: by the menu's element id, else by its address. */
  function findImage({ targetElementId, srcUrl } = {}) {
    let el = null;
    if (targetElementId != null) {
      try {
        el = browser.menus.getTargetElement(targetElementId);
      } catch {
        /* id expired or from another frame */
      }
    }
    if (!el && srcUrl) {
      el = [...document.images].find((img) => img.currentSrc === srcUrl || absUrl(img.getAttribute("src") || "") === srcUrl) || null;
    }
    if (!el) throw new Error("Couldn't find that image on the page. Images inside frames aren't supported.");
    return el;
  }

  /** The clicked image's best address (imageSource) and what is displayed, so the sidebar can decide which to trust. */
  function imageSources(args = {}) {
    const el = findImage(args);
    const img = el.tagName === "PICTURE" ? el.querySelector("img") : el;
    const shown = img?.tagName === "IMG" ? absUrl(img.currentSrc || img.getAttribute("src") || "") : "";
    return { src: imageSource(el), shown };
  }

  /**
   * Downloads an image file the way the page would (its cookies, only its origin as Referer) and returns it as a JPEG
   * data URL no larger than maxSide. Refuses anything that isn't a raster image or is over maxBytes.
   */
  async function fetchImage({ url, maxBytes = 15e6, timeout = 4000, maxSide = 2048 } = {}) {
    if (!/^https?:/i.test(url || "")) throw new Error("the full-size address isn't a web address");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { credentials: "include", referrerPolicy: "origin", signal: ctrl.signal });
      if (!res.ok) throw new Error(`the site answered ${res.status}`);
      const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!type.startsWith("image/") || type === "image/svg+xml") throw new Error("the address isn't an image file");
      if (Number(res.headers.get("content-length")) > maxBytes) throw new Error("the file is too large");
      // Counted while reading: a server without Content-Length could otherwise send any amount.
      const chunks = [];
      let size = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          reader.cancel().catch(() => {});
          throw new Error("the file is too large");
        }
        chunks.push(value);
      }
      const bmp = await createImageBitmap(new Blob(chunks, { type })).catch(() => {
        throw new Error("the file isn't an image Firefox can read");
      });
      const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // transparent areas would otherwise turn black in the JPEG
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return { url: canvas.toDataURL("image/jpeg", 0.92), width: bmp.width, height: bmp.height, finalUrl: res.url || url };
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error("it took too long");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The image the user right-clicked, for Extract text: found by the menu's target id, else by address. Scrolled into
   * view first; clipped says part of it still lies outside the viewport (an image taller than the window).
   */
  async function imageRect(args = {}) {
    const el = findImage(args);
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
      el.scrollIntoView({ block: r.height > innerHeight ? "start" : "center", inline: "nearest", behavior: "instant" });
      await nextPaint();
      r = el.getBoundingClientRect();
    }
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const rect = { x, y, w: Math.min(innerWidth, r.right) - x, h: Math.min(innerHeight, r.bottom) - y };
    if (rect.w < 4 || rect.h < 4) throw new Error("That image isn't visible on the page.");
    const clipped = r.top < -1 || r.left < -1 || r.bottom > innerHeight + 1 || r.right > innerWidth + 1;
    return { rect, clipped, viewport: { w: innerWidth, h: innerHeight } };
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
  // Bind an advance cart approval to stable product and variant clues. Stock text and button disabled state
  // are expected to change during a watch, so including them would make the grant unusable on real pages.
  // This cannot infer arbitrary site-script behavior; pages with no identifiable product require fresh approval.
  function cartContext(el, form) {
    const region = el.closest("article") || form;
    if (!region) return "";
    const heading = clean(region.querySelector?.("h1, h2, [itemprop=name]")?.innerText || "").slice(0, 200);
    const ids = [];
    for (let node = el; node; node = node.parentElement) {
      for (const attr of ["data-product-id", "data-item-id", "data-sku"]) {
        const value = node.getAttribute?.(attr);
        if (value) ids.push([attr, value.slice(0, 200)]);
      }
      if (node === region) break;
    }
    const controls = [...(form?.elements || region.querySelectorAll("input, select, textarea"))]
      .filter((c) => ["INPUT", "SELECT", "TEXTAREA"].includes(c.tagName));
    if (controls.length > 100 || controls.some(isSensitive)) return "";
    const productField = controls.some((c) => c.type === "hidden" && /(?:product|item|sku|variant|offer)[_-]?(?:id|code)?/i.test(c.name || "") && c.value);
    if (!ids.length && !productField && heading.length < 6) return "";
    return JSON.stringify([document.title, heading, ids, controls.map((c) =>
      [c.tagName, c.name, c.type, c.value, !!c.checked])]);
  }

  function describe(el) {
    const kind = kindOf(el) || (el.tagName === "IMG" ? "image" : el.tagName.toLowerCase());
    const link = el.closest("a[href]");
    // The form owner, which form="id" can place outside the <form>; elements without one (divs) use their ancestor.
    const form = el.form !== undefined ? el.form : el.closest("form");
    const type = (el.getAttribute("type") || "").toLowerCase();
    const isSubmit = el.tagName === "BUTTON" ? type === "submit" || (!type && !!form) : type === "submit" || type === "image";
    // A submit button's formmethod and formaction override its form's; a field's Enter submits to the form's own.
    const formMethod = ((isSubmit && el.getAttribute("formmethod")) || form?.getAttribute("method") || "get").toLowerCase();
    let action = "";
    if (form) {
      const raw = (isSubmit && el.getAttribute("formaction")) || form.getAttribute("action") || location.href;
      try {
        action = new URL(raw, document.baseURI || location.href).href;
      } catch {
        action = raw;
      }
    }
    const info = {
      kind,
      tag: el.tagName,
      label: clip(labelOf(el), 120),
      href: link ? new URL(link.getAttribute("href"), document.baseURI || location.href).href : "",
      download: !!link?.hasAttribute("download"),
      inForm: !!form,
      formMethod,
      action,
      isSubmit,
      sensitive: isSensitive(el),
      visible: isVisible(el),
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      readOnly: !!el.readOnly,
      // Only the field itself, or a GET form that calls itself a search, makes a search box. A role on some ancestor
      // (even <body role=search>) doesn't, and nothing that posts data is a search.
      searchField: el.tagName === "INPUT" && ["", "text", "search"].includes(type) && formMethod !== "post" &&
        (type === "search" || el.getAttribute("role") === "searchbox" || form?.getAttribute("role") === "search"),
      cartContext: cartContext(el, form),
      doc: DOC,
    };
    // What the agent approved. Actions compare it again right before they activate anything.
    info.fp = JSON.stringify([info.kind, info.tag, info.label, info.href, info.download, info.inForm, formMethod, action, isSubmit, info.sensitive]);
    return info;
  }

  /** Refuse when the page has changed what the element is or does since the agent approved it. */
  function checkSame(el, expect) {
    if (expect && describe(el).fp !== expect) throw new Error("The element changed before the action, so nothing was done. Read the page again.");
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

  // `expect` is the fingerprint the agent approved. Page handlers run at every await and dispatched event, so it is
  // checked again after each, and last immediately before the activation.
  async function click({ id, doc, expect }) {
    checkDoc(doc);
    const el = getEl(id);
    actionable(el, id);
    el.scrollIntoView({ block: "center", inline: "nearest" });
    await nextPaint();
    checkSame(el, expect);
    flash(el);
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    checkSame(el, expect);
    el.click();
    return { ok: true };
  }

  async function typeText({ id, text, submit = false, doc, expect }) {
    checkDoc(doc);
    const el = getEl(id);
    if (isSensitive(el)) throw new Error("Refused: this is a password/payment/ID or credential field. Ask the user to fill it in.");
    actionable(el, id);
    if (el.readOnly) throw new Error(`[${id}] is read-only.`);
    if (kindOf(el) !== "input") throw new Error(`[${id}] is not a text field.`);
    checkSame(el, expect);
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
      if (notCancelled && el.form) {
        checkSame(el, expect);
        el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      }
    }
    return { ok: true };
  }

  function selectOption({ id, value, doc, expect }) {
    checkDoc(doc);
    const el = getEl(id);
    actionable(el, id);
    if (el.tagName !== "SELECT") throw new Error(`[${id}] is not a dropdown; click it instead.`);
    checkSame(el, expect);
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

  const KEY_INFO = {
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    "Shift+Tab": { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Space: { key: " ", code: "Space", keyCode: 32 },
  };
  // What a real key press activates; anything else gets the key's scrolling default, or nothing.
  const ENTER_ACTIVATES = new Set(["link", "button", "tab", "menuitem", "option"]);
  const SPACE_ACTIVATES = new Set(["button", "checkbox", "radio", "tab", "menuitem", "option"]);
  const FOCUSABLE ="a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=''], [contenteditable=true]";

  /** The element Tab (or Shift+Tab) would move to from `el`, in document order. */
  function nextFocusable(el, back) {
    const list = [...document.querySelectorAll(FOCUSABLE)].filter(
      (e) => e === el || (isVisible(e) && !e.disabled && !(e.getAttribute("tabindex") < 0)),
    );
    const i = list.indexOf(el);
    return list[back ? (i <= 0 ? list.length - 1 : i - 1) : (i + 1) % list.length] || null;
  }

  /** The element a scroll key moves: the nearest scrollable ancestor, else the page. */
  function scrollerOf(el) {
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)) return e;
    }
    return document.scrollingElement || document.documentElement;
  }

  /**
   * Press one key on element [N]. Events dispatched by an extension are untrusted, so Firefox performs none of a key's
   * default actions; the page's own handlers run, and if none cancels the key, the usual default is done here: focus
   * moves, the page scrolls, Enter/Space activate controls, Enter submits a field's form. Which of these is allowed is
   * decided by the agent before this runs.
   */
  async function pressKey({ id, key, doc, expect }) {
    checkDoc(doc);
    const el = getEl(id);
    if (isSensitive(el)) throw new Error("Refused: this is a password/payment/ID or credential field.");
    actionable(el, id);
    const k = KEY_INFO[key];
    if (!k) throw new Error(`Unsupported key "${key}".`);
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.focus({ preventScroll: true });
    await nextPaint();
    checkSame(el, expect);
    flash(el);
    const init = { ...k, which: k.keyCode, bubbles: true, cancelable: true, composed: true, view: window };
    const notCancelled = el.dispatchEvent(new KeyboardEvent("keydown", init));
    const kind = kindOf(el);
    const out = { ok: true, cancelled: !notCancelled };
    if (notCancelled) {
      if (key === "Tab" || key === "Shift+Tab") {
        const next = nextFocusable(el, key === "Shift+Tab");
        if (next) {
          next.focus();
          out.focused = { id: getId(next), kind: kindOf(next) || next.tagName.toLowerCase(), label: clip(labelOf(next), 80) };
        }
      } else if (key === "Enter" && kind === "input") {
        if (el.form && el.tagName !== "TEXTAREA") {
          checkSame(el, expect);
          el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
        }
        out.action = "submit";
      } else if ((key === "Enter" && ENTER_ACTIVATES.has(kind)) || (key === "Space" && SPACE_ACTIVATES.has(kind))) {
        checkSame(el, expect);
        el.click();
        out.action = "activate";
      } else if (kind !== "input" && kind !== "select") {
        const sc = scrollerOf(el);
        const page = Math.round((sc === document.scrollingElement ? innerHeight : sc.clientHeight) * 0.85);
        const by = { ArrowUp: [0, -40], ArrowDown: [0, 40], ArrowLeft: [-40, 0], ArrowRight: [40, 0], PageUp: [0, -page], PageDown: [0, page], Space: [0, page] }[key];
        if (by) sc.scrollBy(...by);
        else if (key === "Home") sc.scrollTo(0, 0);
        else if (key === "End") sc.scrollTo(0, sc.scrollHeight);
        if (by || key === "Home" || key === "End") {
          out.action = "scroll";
          out.y = Math.round(scrollY);
          out.height = document.documentElement.scrollHeight;
          out.atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
        }
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    return out;
  }

  /**
   * Wait until text appears on the page (or, with gone, disappears), as read_page would see it. Checks again whenever
   * the page changes, at most every 250 ms. Resolves { met, waited } when met or after timeoutMs.
   */
  function waitFor({ text = "", gone = "", timeoutMs = 10000 }) {
    const pattern = (q) => {
      const words = clean(String(q)).split(" ").filter(Boolean);
      return words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "i") : null;
    };
    const want = pattern(text);
    const away = pattern(gone);
    if (!want && !away) throw new Error("Give text to wait for, or text to wait to disappear.");
    const met = () => {
      const page = pageChunks().out.join("");
      return (!want || want.test(page)) && (!away || !away.test(page));
    };
    const start = performance.now();
    return new Promise((resolve) => {
      let dirty = true;
      const obs = new MutationObserver(() => (dirty = true));
      obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      const tick = () => {
        const waited = Math.round(performance.now() - start);
        if (dirty) {
          dirty = false;
          if (met()) return finish(true, waited);
        }
        if (waited >= timeoutMs) return finish(false, waited);
        setTimeout(tick, 250);
      };
      const finish = (ok, waited) => {
        obs.disconnect();
        resolve({ met: ok, waited });
      };
      tick();
    });
  }

  /**
   * The page text once it differs from the text whose hash is `since`, or at the time limit, whichever is first; for a
   * watch whose condition is judged outside the page. Checks at most once a second, since a ticking clock changes the
   * page constantly.
   */
  function watchText({ since = "", timeoutMs = 10000 }) {
    const hash = (s) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      return (h >>> 0).toString(36);
    };
    const start = performance.now();
    return new Promise((resolve) => {
      let dirty = true;
      const obs = new MutationObserver(() => (dirty = true));
      obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      const finish = (r) => {
        obs.disconnect();
        resolve(r);
      };
      const tick = () => {
        const waited = Math.round(performance.now() - start);
        if (dirty) {
          dirty = false;
          const text = pageChunks().out.join("");
          const h = hash(text);
          if (h !== since) return finish({ changed: true, text, hash: h, waited });
        }
        if (waited >= timeoutMs) return finish({ changed: false, waited });
        setTimeout(tick, 1000);
      };
      tick();
    });
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

  function passageStreams() {
    const streams = [];
    let stream;
    const separate = () => {
      stream = { parts: [], entries: [], length: 0, space: false };
      streams.push(stream);
    };
    const space = () => {
      if (stream.length && !stream.space) {
        stream.parts.push(" ");
        stream.length++;
        stream.space = true;
      }
    };
    separate();

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.nodeValue;
        if (!raw) return;
        if (raw.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          if (![...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)) return separate();
        }
        const from = stream.space ? raw.match(/^\s*/)[0].length : 0;
        const text = raw.slice(from).replace(/\s+/g, " ");
        if (!text) return;
        stream.entries.push({ node, raw, from, start: stream.length, length: text.length });
        stream.parts.push(text);
        stream.length += text.length;
        stream.space = text.endsWith(" ");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const style = getComputedStyle(el);
      if (SKIP.has(el.tagName) || ["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(el.tagName) ||
          el.isContentEditable || ["textbox", "searchbox", "combobox"].includes(el.getAttribute("role")) ||
          el.hasAttribute("data-pagemortem-ui") || el.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
          style.contentVisibility === "hidden" || Number(style.opacity) === 0) return separate();
      if (el.tagName === "BR") return space();
      const block = !["inline", "contents"].includes(style.display) && !style.display.startsWith("inline-");
      if (block) space();
      if (el.shadowRoot) {
        separate();
        for (const child of el.childNodes) walk(child);
        separate();
        for (const child of el.shadowRoot.childNodes) walk(child);
        separate();
      } else if (el.tagName === "SLOT" && el.assignedNodes?.().length) {
        separate();
      } else {
        for (const child of el.childNodes) walk(child);
      }
      if (block) space();
    }

    if (document.body) walk(document.body);
    return streams;
  }

  function passageOffset(entry, offset) {
    let raw = entry.from;
    for (let normalized = 0; normalized < offset; normalized++) {
      if (/\s/.test(entry.raw[raw])) {
        do { raw++; } while (raw < entry.raw.length && /\s/.test(entry.raw[raw]));
      } else raw++;
    }
    return raw;
  }

  function passageRange(quote) {
    let match = null;
    for (const stream of passageStreams()) {
      const text = stream.parts.join("");
      const start = text.indexOf(quote);
      if (start < 0) continue;
      if (match || text.indexOf(quote, start + 1) >= 0) {
        throw new Error("This quote appears more than once on the page. Use a longer, unique quote.");
      }
      const end = start + quote.length;
      const starts = stream.entries.map((entry) => entry.start);
      const first = lastAtOrBefore(starts, start);
      const last = lastAtOrBefore(starts, end - 1);
      const a = stream.entries[first];
      const b = stream.entries[last];
      const range = document.createRange();
      range.setStart(a.node, passageOffset(a, start - a.start));
      range.setEnd(b.node, passageOffset(b, end - b.start));
      match = { range, entries: stream.entries.slice(first, last + 1) };
    }
    if (!match) throw new Error("The quoted passage is missing or hidden on this page. Read the page again.");
    return match;
  }

  const passageParent = (el) => el.assignedSlot || el.parentElement || el.getRootNode().host;

  function passageRects({ range, entries }) {
    const rects = [];
    for (const entry of entries) {
      const part = document.createRange();
      part.selectNodeContents(entry.node);
      if (entry.node === range.startContainer) part.setStart(entry.node, range.startOffset);
      if (entry.node === range.endContainer) part.setEnd(entry.node, range.endOffset);
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let el = entry.node.parentElement; el; el = passageParent(el)) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
            style.contentVisibility === "hidden" || Number(style.opacity) === 0 ||
            el.getAttribute("aria-hidden") === "true" || el.hasAttribute("data-pagemortem-ui")) return [];
        if (el === document.body || el === document.documentElement) continue;
        const r = el.getBoundingClientRect();
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
          clip.left = Math.max(clip.left, r.left + el.clientLeft);
          clip.right = Math.min(clip.right, r.left + el.clientLeft + el.clientWidth);
        }
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
          clip.top = Math.max(clip.top, r.top + el.clientTop);
          clip.bottom = Math.min(clip.bottom, r.top + el.clientTop + el.clientHeight);
        }
      }
      for (const r of part.getClientRects()) {
        const left = Math.max(r.left, clip.left);
        const top = Math.max(r.top, clip.top);
        const width = Math.min(r.right, clip.right) - left;
        const height = Math.min(r.bottom, clip.bottom) - top;
        if (width > 0 && height > 0) rects.push({ left, top, width, height });
      }
    }
    return rects;
  }

  function scrollPassage(range) {
    const target = range.startContainer.parentElement;
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    for (let el = target; el && el !== document.body && el !== document.documentElement; el = passageParent(el)) {
      const style = getComputedStyle(el);
      const r = range.getClientRects()[0];
      if (!r) return;
      const box = el.getBoundingClientRect();
      el.scrollBy({
        left: ["auto", "scroll", "hidden"].includes(style.overflowX) && el.scrollWidth > el.clientWidth
          ? r.left - box.left - el.clientLeft - (el.clientWidth - r.width) / 2 : 0,
        top: ["auto", "scroll", "hidden"].includes(style.overflowY) && el.scrollHeight > el.clientHeight
          ? r.top - box.top - el.clientTop - (el.clientHeight - r.height) / 2 : 0,
        behavior: "instant",
      });
    }
    const r = range.getClientRects()[0];
    if (r) window.scrollBy({
      left: r.left - (innerWidth - r.width) / 2,
      top: r.top - (innerHeight - r.height) / 2,
      behavior: "instant",
    });
  }

  async function showPassage({ quote, url, doc }) {
    const checkPage = () => {
      if (typeof url !== "string" || url !== location.href) {
        throw new Error("The page URL changed since this source was read. Read the page again.");
      }
      checkDoc(doc);
    };
    checkPage();
    if (typeof quote !== "string" || !clean(quote)) throw new Error("Give a nonempty quoted passage to show.");
    quote = clean(quote);
    let passage = passageRange(quote);
    scrollPassage(passage.range);
    await nextPaint();
    checkPage();
    passage = passageRange(quote);
    if (!passageRects(passage).length) throw new Error("The quoted passage is no longer visible. Read the page again.");
    const target = passage.range.startContainer.parentElement;

    const root = overlayRoot();
    const boxes = [];
    let frame = 0;
    const scrollRoots = new Set([window]);
    for (let el = target; el; el = passageParent(el)) {
      const tree = el.getRootNode();
      if (tree instanceof ShadowRoot) scrollRoots.add(tree);
    }
    const place = () => {
      frame = 0;
      if (!root.host.isConnected || location.href !== url ||
          passage.entries.some((entry) => !entry.node.isConnected || entry.node.nodeValue !== entry.raw)) return done();
      const rects = passageRects(passage);
      if (!rects.length) return done();
      while (boxes.length > rects.length) boxes.pop().remove();
      rects.forEach((r, i) => {
        const b = boxes[i] ||= box(r, { color: "#F97316", width: 2 });
        Object.assign(b.style, {
          left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px",
          background: "rgba(249, 115, 22, 0.22)",
        });
      });
    };
    const onMove = () => (frame ||= requestAnimationFrame(place));
    const resized = new ResizeObserver(onMove);
    const done = () => {
      for (const b of boxes) b.remove();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      for (const tree of scrollRoots) tree.removeEventListener("scroll", onMove, true);
      removeEventListener("resize", onMove);
      resized.disconnect();
      highlights.delete(done);
      if (!highlights.size) {
        removeEventListener("pointerdown", dismissHighlights, true);
        removeEventListener("keydown", dismissHighlights, true);
      }
    };
    const timer = setTimeout(done, 30000);
    if (!highlights.size) {
      addEventListener("pointerdown", dismissHighlights, true);
      addEventListener("keydown", dismissHighlights, true);
    }
    highlights.add(done);
    for (const tree of scrollRoots) tree.addEventListener("scroll", onMove, { capture: true, passive: true });
    addEventListener("resize", onMove, { passive: true });
    resized.observe(document.body);
    resized.observe(target);
    place();
    return { ok: true };
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
  const NO_TRANSLATE = "script,style,noscript,code,pre,kbd,samp,textarea,[translate=no],.notranslate,[data-pagemortem-ui]";

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

  // ---------- download capture (click_each) ----------
  // While the agent clicks a list of Download buttons, a file the page hands the browser through a link (a download
  // name, or a blob:/data: address) is caught here instead, so the extension can save it into its own folder. Contents
  // are read without any request: a blob from the object the page made it from (fetching a blob: address is blocked by
  // many sites' CSP), a data: address by decoding it. A web address is passed back as it is. A file that can't be read
  // is let through, and the browser downloads it as it would have.
  const MAX_CAPTURE = 200 * 1024 * 1024;
  let capture = null; // { jobs: [], blobs: Map<blob: address, Blob> } while capturing
  let pageClick = null; // the page's own HTMLAnchorElement.prototype.click, once hooked
  const letThrough = new WeakSet(); // links whose file couldn't be read, clicked again for the browser to download

  const catchable = (a) => a.hasAttribute("download") || /^(blob|data):/i.test(a.href || "");
  const readBlob = (blob) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(blob);
    });
  function dataBytes(href) {
    const m = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(href);
    if (!m) throw new Error("bad data address");
    const raw = m[2] ? atob(decodeURIComponent(m[3])) : unescape(m[3].replace(/%(?![0-9a-f]{2})/gi, "%25"));
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0) & 255);
    return { type: m[1].split(";")[0], bytes: bytes.buffer };
  }
  function take(a, release) {
    const href = a.href;
    const name = a.getAttribute("download") || "";
    const blob = capture.blobs.get(href);
    capture.jobs.push((async () => {
      if (/^https?:/i.test(href)) return { href, name };
      if (/^data:/i.test(href)) return { name, ...dataBytes(href) };
      if (!blob || blob.size > MAX_CAPTURE) throw new Error("unreadable");
      return { name, type: blob.type, bytes: await readBlob(blob) };
    })().catch(() => {
      release();
      return { name, released: true };
    }));
  }

  function hookDownloads() {
    if (pageClick || typeof exportFunction !== "function") return !!pageClick; // Firefox content scripts only
    const proto = window.wrappedJSObject.HTMLAnchorElement.prototype;
    pageClick = proto.click;
    // Remember what each blob: address the page makes while capturing holds, to read it without a request.
    const pageURL = window.wrappedJSObject.URL;
    const makeURL = pageURL.createObjectURL;
    pageURL.createObjectURL = exportFunction(function (obj) {
      const url = makeURL.call(pageURL, obj);
      if (capture && typeof obj?.size === "number") capture.blobs.set(url, obj); // a Blob or File, not a MediaSource
      return url;
    }, window);
    // Sites usually build a detached <a download>, call .click() on it and drop it; no event reaches the document.
    proto.click = exportFunction(function () {
      if (capture && catchable(this)) return take(this, () => pageClick.call(this));
      return pageClick.call(this);
    }, window);
    // A real link in the page, clicked by the agent or by page script.
    window.addEventListener("click", (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (a && letThrough.delete(a)) return;
      if (!capture || !a || !catchable(a) || e.defaultPrevented) return;
      e.preventDefault();
      take(a, () => {
        letThrough.add(a);
        a.click();
      });
    }, true);
    return true;
  }

  function captureDownloads({ on }) {
    if (!on) {
      capture = null;
      return { ok: true };
    }
    if (!hookDownloads()) return { supported: false };
    capture = { jobs: [], blobs: new Map() };
    return { supported: true };
  }

  /** The files caught so far, waiting up to `wait` ms for the first one; each is handed over once. */
  async function takeDownloads({ wait = 0 }) {
    if (!capture) return { files: [] };
    const until = Date.now() + wait;
    while (!capture.jobs.length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300)); // a click can start more than one file
    const jobs = capture.jobs.splice(0);
    return { files: await Promise.all(jobs) };
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
    markdown: () => pageMarkdown(),
    getText: ({ maxChars = 300_000 }) => {
      let { root, text: raw } = readableRoot();
      // innerText leaves out typed input values but keeps editable regions and prefilled text areas; drop the ones
      // that look like credentials, as readPage does.
      for (const el of root.querySelectorAll?.("input, textarea, [contenteditable]") || []) {
        const secret = isSensitive(el) ? clean(el.innerText || el.textContent || "") : "";
        if (!secret) continue;
        const re = new RegExp(secret.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
        raw = raw.replace(re, "[sensitive field omitted]");
      }
      const text = raw
        .split("\n")
        .map((l) => l.replace(/[ \t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return { ...pageMeta(), selection: String(getSelection() || "").trim(), text: text.slice(0, maxChars), length: text.length, doc: DOC };
    },
    describe: ({ id, doc }) => (checkDoc(doc), describe(getEl(id))),
    click,
    type: typeText,
    select: selectOption,
    scroll: scrollPage,
    pressKey,
    waitFor,
    watchText,
    highlight,
    showPassage,
    rect: rectOf,
    markImages,
    listImages,
    imageRect,
    imageSources,
    fetchImage,
    clearMarks: () => (clearOverlay(), { ok: true }),
    collectSegments,
    applySegments,
    restoreOriginal,
    captureDownloads,
    takeDownloads,
    hasTranslation: () => ({ translated: originals.size > 0 }),
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.pagemortem !== true) return;
    const fn = handlers[msg.op];
    if (!fn) return Promise.resolve({ error: `unknown op ${msg.op}` });
    return Promise.resolve()
      .then(() => fn(msg.args || {}))
      .catch((e) => ({ error: String(e?.message || e) }));
  });
})();
