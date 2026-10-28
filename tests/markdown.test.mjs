// Copy as Markdown: runs the real content script's converter against a minimal fake DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

class El {
  constructor(tag, attrs = {}, kids = []) {
    Object.assign(this, { nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: [], parentElement: null, isConnected: true });
    for (const k of kids) this.append(k);
  }
  append(k) {
    if (typeof k === "string") k = { nodeType: 3, nodeValue: k };
    k.parentElement = this;
    this.childNodes.push(k);
  }
  getAttribute(n) {
    return this.attrs[n] ?? null;
  }
  hasAttribute(n) {
    return n in this.attrs;
  }
  checkVisibility() {
    return !("hidden" in this.attrs);
  }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join("");
  }
  get innerText() {
    return this.textContent;
  }
  // Only what the converter asks: is there a table (or ARIA table) anywhere inside?
  querySelector() {
    const visit = (e) => e.childNodes.some((c) => c.nodeType === 1 && (c.tagName === "TABLE" || /^(table|grid|treegrid)$/.test(c.attrs.role) || visit(c)));
    return visit(this) ? {} : null;
  }
}
const h = (tag, attrs, ...kids) => (attrs && (typeof attrs !== "object" || attrs instanceof El || attrs.nodeType) ? new El(tag, {}, [attrs, ...kids]) : new El(tag, attrs || {}, kids));

/** A fake selection from (startNode, startOffset) to (endNode, endOffset), in document order. */
function selectionOf(body, start, startOffset, end, endOffset) {
  const order = [];
  const last = new Map();
  const visit = (n) => {
    order.push(n);
    for (const c of n.childNodes || []) visit(c);
    last.set(n, order.length - 1);
  };
  visit(body);
  const [s, e] = [order.indexOf(start), order.indexOf(end)];
  let common = start.parentElement;
  while (!(order.indexOf(common) <= s && last.get(common) >= e)) common = common.parentElement;
  const range = {
    commonAncestorContainer: common, startContainer: start, startOffset, endContainer: end, endOffset,
    intersectsNode: (n) => order.indexOf(n) <= e && last.get(n) >= s,
  };
  return () => ({ rangeCount: 1, toString: () => "selected", getRangeAt: () => range });
}

async function markdown(body, { title = "", selection = () => "" } = {}) {
  let listener;
  load(["content/content.js"], {
    window: {}, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, location: { href: "https://site.example/docs/page" },
    document: { body, title, documentElement: { lang: "en", scrollHeight: 1000 }, querySelectorAll: () => [] },
    scrollY: 0, innerHeight: 800, getSelection: selection,
    browser: { runtime: { onMessage: { addListener: (fn) => (listener = fn) } } },
  });
  const r = await listener({ pagemortem: true, op: "markdown" });
  if (r.error) throw new Error(r.error);
  return r;
}
const md = async (...kids) => (await markdown(h("body", ...kids))).markdown;

test("headings, paragraphs, inline marks and links", async () => {
  const out = await md(
    h("h1", "Guide"),
    h("p", "Read ", h("strong", "this"), " and ", h("em", "that"), ", run ", h("code", "npm test"), "."),
    h("p", h("a", { href: "/docs/next" }, "Next page"), " · ", h("a", { href: "javascript:void(0)" }, "Menu")),
    h("p", "line one", h("br"), "line two"),
  );
  assert.equal(
    out,
    "# Guide\n\nRead **this** and *that*, run `npm test`.\n\n[Next page](https://site.example/docs/next) · Menu\n\nline one  \nline two",
  );
});

test("page text that looks like Markdown is escaped, snake_case is not", async () => {
  const out = await md(h("p", "# not a heading"), h("p", "1. not a list"), h("p", "a *star* [bracket] my_var _x_ <div>"));
  assert.equal(out, "\\# not a heading\n\n1\\. not a list\n\na \\*star\\* \\[bracket\\] my_var \\_x\\_ \\<div>");
});

test("the page title becomes the heading when the content has none", async () => {
  assert.equal((await markdown(h("body", h("p", "Hi")), { title: "Release notes" })).markdown, "# Release notes\n\nHi");
});

test("nested, ordered and task lists", async () => {
  const out = await md(
    h("ul", h("li", "One", h("ul", h("li", "One a"), h("li", "One b"))), h("li", "Two")),
    h("ol", { start: "3" }, h("li", "Third"), h("li", "Fourth")),
    h("ul", h("li", h("input", { type: "checkbox", checked: "" }), " Done"), h("li", h("input", { type: "checkbox" }), " Todo")),
  );
  assert.equal(out, "- One\n  - One a\n  - One b\n- Two\n\n3. Third\n4. Fourth\n\n- [x] Done\n- [ ] Todo");
});

test("code blocks keep their text, language and a fence longer than any backticks inside", async () => {
  const out = await md(h("pre", { class: "language-js" }, "const a = 1;\nconst s = ```;\n"));
  assert.equal(out, "````js\nconst a = 1;\nconst s = ```;\n````");
});

test("blockquotes, rules and definition lists", async () => {
  const out = await md(h("blockquote", h("p", "Quoted"), h("p", "Twice")), h("hr"), h("dl", h("dt", "Term"), h("dd", "Meaning")));
  assert.equal(out, "> Quoted\n>\n> Twice\n\n---\n\n**Term**\n\nMeaning");
});

test("a table with a header gets the separator row; pipes and line breaks in cells are kept in the cell", async () => {
  const out = await md(
    h("table",
      h("caption", "Prices"),
      h("thead", h("tr", h("th", "Plan"), h("th", "Price"))),
      h("tbody",
        h("tr", h("td", "Basic"), h("td", "$5 | month")),
        h("tr", h("td", "Pro", h("br"), "(popular)"), h("td", h("a", { href: "https://site.example/pro" }, "$9"))))),
  );
  assert.equal(
    out,
    "**Prices**\n\n| Plan | Price |\n| --- | --- |\n| Basic | $5 \\| month |\n| Pro<br>(popular) | [$9](https://site.example/pro) |",
  );
});

test("spanned cells: header rows merge per column, rowspans repeat, data colspans stay in their first column", async () => {
  const out = await md(
    h("table",
      h("tr", h("th", { rowspan: "2" }, "Region"), h("th", { colspan: "2" }, "2024")),
      h("tr", h("th", "Q1"), h("th", "Q2")),
      h("tr", h("td", { rowspan: "2" }, "EU"), h("td", "1"), h("td", "2")),
      h("tr", h("td", "3"), h("td", "4")),
      h("tr", h("td", { colspan: "3" }, "No data for US"))),
  );
  assert.equal(
    out,
    "| Region | 2024 / Q1 | 2024 / Q2 |\n| --- | --- | --- |\n| EU | 1 | 2 |\n| EU | 3 | 4 |\n| No data for US |  |  |",
  );
});

test("a table without header cells gets an empty header; short rows are padded", async () => {
  const out = await md(h("table", h("tr", h("td", "a"), h("td", "b"), h("td", "c")), h("tr", h("td", "d"))));
  assert.equal(out, "|  |  |  |\n| --- | --- | --- |\n| a | b | c |\n| d |  |  |");
});

test("ARIA grids built from divs are tables", async () => {
  const out = await md(
    h("div", { role: "grid" },
      h("div", { role: "row" }, h("div", { role: "columnheader" }, "Name"), h("div", { role: "columnheader" }, "Size")),
      h("div", { role: "rowgroup" }, h("div", { role: "row" }, h("div", { role: "gridcell" }, h("span", "a.txt")), h("div", { role: "gridcell" }, "2 KB")))),
  );
  assert.equal(out, "| Name | Size |\n| --- | --- |\n| a.txt | 2 KB |");
});

test("layout tables are read as ordinary blocks", async () => {
  const single = await md(h("table", h("tr", h("td", h("p", "Only column"))), h("tr", h("td", "Second row"))));
  assert.equal(single, "Only column\n\nSecond row");
  const nested = await md(
    h("table", h("tr", h("td", h("h2", "Side")), h("td", h("table", h("tr", h("th", "k"), h("th", "v")), h("tr", h("td", "1"), h("td", "2")))))),
  );
  assert.equal(nested, "## Side\n\n| k | v |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(await md(h("table", { role: "presentation" }, h("tr", h("td", "a"), h("td", "b")))), "a\n\nb");
});

test("navigation, hidden elements, form controls and small images are left out", async () => {
  const out = await md(
    h("nav", h("a", { href: "/" }, "Home")),
    h("p", "Visible", h("span", { hidden: "" }, " secret")),
    h("form", h("label", "Name"), h("input", { value: "me" }), h("button", "Send")),
    h("img", { src: "/photo.jpg", alt: "A [cat]" }),
    h("p", h("img", { src: "data:image/png;base64,AAAA", alt: "inline" })),
  );
  assert.equal(out, "Visible\n\nName\n\n![A \\[cat\\]](https://site.example/photo.jpg)");
});

test("a link around a whole card links the card's title", async () => {
  const out = await md(h("a", { href: "/item/1" }, h("h3", "Blue mug"), h("p", "$12")));
  assert.equal(out, "### [Blue mug](https://site.example/item/1)\n\n$12");
});

test("with a selection, only the selected text is converted and the title is not added", async () => {
  const first = { nodeType: 3, nodeValue: "Alpha beta" };
  const second = { nodeType: 3, nodeValue: "Gamma delta" };
  const body = h("body", h("h1", "Top"), h("p", first), h("ul", h("li", second), h("li", "Epsilon")));
  const r = await markdown(body, { title: "Page", selection: selectionOf(body, first, 6, second, 5) });
  assert.equal(r.selection, true);
  assert.equal(r.markdown, "beta\n\n- Gamma");
});

test("reports how many tables it converted", async () => {
  const r = await markdown(h("body", h("table", h("tr", h("th", "a"), h("th", "b")), h("tr", h("td", "1"), h("td", "2")))));
  assert.equal(r.tables, 1);
  assert.equal(r.truncated, false);
});

test("doubtful tables are flagged with their simplified HTML; clean tables are not", async () => {
  const clean = await markdown(h("body", h("table", h("tr", h("th", "a"), h("th", "b")), h("tr", h("td", "1"), h("td", "2")))));
  assert.equal(clean.flagged.length, 0);
  const r = await markdown(
    h("body",
      h("table", { class: "wikitable", style: "width:100%" },
        h("caption", "Data"),
        h("tr", h("th", { rowspan: "2" }, "Region"), h("th", { colspan: "2" }, "2024")),
        h("tr", h("th", "Q1"), h("th", "Q2")),
        h("tr", h("td", { rowspan: "2" }, "EU"), h("td", h("a", { href: "/eu" }, "1 & 2")), h("td", h("span", { hidden: "" }, "x"), "<b>")),
        h("tr", h("td", "3"), h("td", "4")))),
  );
  assert.equal(r.flagged.length, 1);
  const [t] = r.flagged;
  assert.deepEqual([...t.reasons], ["merged cells in the data", "a header over several rows"]);
  assert.ok(r.markdown.includes(t.markdown));
  assert.equal(
    t.html,
    '<table><tr><th rowspan="2">Region</th><th colspan="2">2024</th></tr><tr><th>Q1</th><th>Q2</th></tr>' +
      '<tr><td rowspan="2">EU</td><td><a href="https://site.example/eu">1 &amp; 2</a></td><td>&lt;b&gt;</td></tr><tr><td>3</td><td>4</td></tr></table>',
  );
});

test("ragged rows, missing headers, lists in cells and sparse tables are flagged", async () => {
  const reasons = async (table) => [...(await markdown(h("body", table))).flagged[0].reasons];
  assert.deepEqual(await reasons(h("table", h("tr", h("th", "a"), h("th", "b")), h("tr", h("td", "1")))), ["rows have different numbers of cells"]);
  assert.deepEqual(await reasons(h("table", h("tr", h("td", "a"), h("td", "b")), h("tr", h("td", "1"), h("td", "2")))), ["no header row"]);
  assert.deepEqual(await reasons(h("table", h("tr", h("th", "a"), h("th", "b")), h("tr", h("td", h("ul", h("li", "x"), h("li", "y"))), h("td", "2")))), ["lists inside cells"]);
  const sparse = h("table", h("tr", h("th", "a"), h("th", "b"), h("th", "c")), ...[0, 1, 2].map(() => h("tr", h("td", "1"), h("td", ""), h("td", ""))));
  assert.deepEqual(await reasons(sparse), ["many empty cells"]);
});

// The model side: lib/chat.js redoes a flagged table and keeps the answer only if it has exactly the table's words.
const chat = load(["lib/skills.js", "lib/chat.js"]);
const html = '<table><tr><th rowspan="2">Region</th><th colspan="2">2024</th></tr><tr><th>Q1</th><th>Q2</th></tr><tr><td rowspan="2">EU</td><td><a href="https://site.example/eu">1 &amp; 2</a></td><td><img src="https://site.example/i.png" alt="up"></td></tr><tr><td>3</td><td>4</td></tr></table>';
const good = "| Region | 2024 / Q1 | 2024 / Q2 |\n| --- | --- | --- |\n| EU | [1 &amp; 2](https://site.example/eu) | ![up](https://site.example/i.png) |\n| EU | 3 | 4 |";

test("a redone table with the same words is accepted, even with merged values repeated", () => {
  assert.equal(chat.tableProblem(good, html), "");
});

test("a redone table that adds, drops or misshapes is refused", () => {
  assert.match(chat.tableProblem(good.replace("Region", "Area"), html), /added words.*“area”/);
  assert.match(chat.tableProblem(good.replace("| 3 |", "|  |"), html), /left out words.*“3”/);
  assert.match(chat.tableProblem(good.replace("| EU | 3 | 4 |", "| EU | 3 4 |"), html), /different numbers of cells/);
  assert.match(chat.tableProblem("Here is the table:\n" + good, html), /wasn't one Markdown table/);
  assert.equal(chat.tableProblem(good.replace("| Region |", "| Re\\|gion |"), html), "the model added words that aren't in the table (“re”, “gion”)");
});

test("a redone table may not change where its links and images point", () => {
  const swap = (from, to) => chat.tableProblem(good.replace(from, to), html);
  assert.match(swap("https://site.example/eu", "https://evil.example/eu"), /links to an address that isn't in the table \(https:\/\/evil/);
  assert.match(swap("https://site.example/eu", "javascript:alert(1)"), /form PageMortem doesn't check/);
  assert.match(swap("https://site.example/eu", "javascript:alert%281%29"), /links to an address/);
  assert.match(swap("https://site.example/i.png", "https://evil.example/t.png"), /shows an image that isn't in the table/);
  assert.match(swap("| EU | 3 |", "| EU | <https://evil.example> 3 |"), /links to an address/);
  assert.match(swap("| EU | 3 |", "| EU | ![up](https://site.example/i.png) 3 |"), /images that aren't in the table/);
  assert.match(swap("| EU | 3 |", '| EU | <a href="https://evil.example">3</a> |'), /contains HTML/);
  // Link forms the strict pattern doesn't read are refused, not skipped.
  assert.match(swap("(https://site.example/eu)", '(<https://evil.example/eu> "t")'), /form PageMortem doesn't check/);
  assert.match(swap("(https://site.example/eu)", "( https://evil.example/eu)"), /form PageMortem doesn't check/);
  assert.match(swap("(https://site.example/eu)", '(https://site.example/eu "title")'), /form PageMortem doesn't check/);
  assert.match(swap("](https://site.example/eu)", "] (https://evil.example/eu)"), /form PageMortem doesn't check/);
  // An image may only show the table's images, and a link only go where the table's links go.
  assert.match(swap("![up](https://site.example/i.png)", "![up](https://site.example/eu)"), /shows an image that isn't in the table/);
  assert.match(swap("[1 &amp; 2](https://site.example/eu)", "[1 &amp; 2](https://site.example/i.png)"), /links to an address/);
  assert.match(swap("[1 &amp; 2](https://site.example/eu)", "[![up](https://site.example/i.png)](https://evil.example)"), /links to an address/);
  // An escaped backslash doesn't escape the tag after it.
  assert.match(swap("| EU | 3 |", '| EU | \\\\<a href="https://evil.example">3</a> |'), /contains HTML/);
  assert.equal(swap("| EU | 3 |", "| EU | 3 < 5 |").includes("HTML"), false);
  // The converter percent-encodes parentheses; a model writing them encoded or not is the same address.
  const parens = html.replace("https://site.example/eu", "https://site.example/Planet_(x)");
  assert.equal(chat.tableProblem(good.replace("https://site.example/eu", "https://site.example/Planet_%28x%29"), parens), "");
});

test("repairTable sends the reasons and HTML, unwraps a fence and checks the answer", async () => {
  const sent = [];
  const llm = { chat: async (req) => (sent.push(req), { content: "```markdown\n" + good + "\n```" }) };
  const table = { markdown: "| old |", html, reasons: ["merged cells in the data"] };
  const r = await chat.repairTable({ table, llm, settings: { maxTokens: 1024 } });
  assert.equal(r.markdown, good);
  assert.match(sent[0].messages[1].content, /may be wrong \(merged cells in the data\)[\s\S]*<table>/);
  assert.equal(sent[0].temperature, 0);
  const bad = await chat.repairTable({ table, llm: { chat: async () => ({ content: good.replace("EU", "Europe") }) }, settings: { maxTokens: 1024 } });
  assert.match(bad.error, /added words/);
});
