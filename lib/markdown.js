// Small, safe Markdown → HTML renderer for model output. Everything is escaped first, and the parsed result is
// filtered against a tag/attribute allowlist before it reaches the sidebar.
"use strict";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * A link is clickable only when it points at a page the answer was drawn from. Otherwise a page could get the model
 * to write a link that carries data to another server, one click away. Such links are shown as plain text instead.
 */
function mdLink(label, href, links) {
  let url;
  try {
    url = new URL(href.replace(/&amp;/g, "&"));
  } catch {
    return label;
  }
  if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && links?.has(url.href)) {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }
  return `${label} <span class="unlinked" title="Not a page PageMortem read, so not clickable">(${href})</span>`;
}

function mdInline(raw, opts = {}) {
  const codes = [];
  let s = esc(raw).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => mdLink(label, href, opts.links))
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i] ?? ""}</code>`);
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** @param {{links?: Set<string>}} opts  links: exact canonical page URLs the answer may link to */
function renderMarkdown(md, opts = {}) {
  const inline = (s) => mdInline(s, opts);
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*```(\w*)/.exec(line))) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush();
      const lvl = Math.min(6, m[1].length + 2); // h3..h6 suit a narrow sidebar
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] || "")) {
      flush();
      const head = splitRow(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
      i--;
      out.push(
        `<div class="table"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] || "")}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
    } else if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      flush();
      out.push("<hr>");
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const depth = Math.min(3, Math.floor(/^\s*/.exec(lines[i])[0].length / 2));
        items.push(`<li class="d${depth}">${inline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""))}</li>`);
      }
      i--;
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ""));
      i--;
      out.push(`<blockquote>${q.map(inline).join("<br>")}</blockquote>`);
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return out.join("");
}

const MD_TAGS = new Set([
  "P", "BR", "H3", "H4", "H5", "H6", "PRE", "CODE", "STRONG", "EM", "DEL", "A", "UL", "OL", "LI", "BLOCKQUOTE", "HR",
  "DIV", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "SPAN",
]);
const MD_ATTRS = { A: ["href", "target", "rel"], LI: ["class"], DIV: ["class"], SPAN: ["class", "title"] };

/** Rendered Markdown as DOM nodes. Defense in depth: anything outside the allowlist is reduced to its text. */
function markdownNodes(md, opts) {
  const body = new DOMParser().parseFromString(renderMarkdown(md, opts), "text/html").body;
  const clean = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE || !MD_TAGS.has(child.tagName)) {
        child.replaceWith(document.createTextNode(child.textContent || ""));
        continue;
      }
      const ok = MD_ATTRS[child.tagName] || [];
      for (const a of [...child.attributes]) if (!ok.includes(a.name)) child.removeAttribute(a.name);
      if (child.tagName === "A" && !/^https?:\/\//i.test(child.getAttribute("href") || "")) child.removeAttribute("href");
      clean(child);
    }
  };
  clean(body);
  return [...body.childNodes];
}
