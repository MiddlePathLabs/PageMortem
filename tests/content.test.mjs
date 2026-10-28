// Runs the real content script against a minimal fake DOM: just enough for readPage and describe.
import test from "node:test";
import assert from "node:assert/strict";
import { load, AGENT_FILES } from "./harness.mjs";

const LISTED = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]); // elements with a form owner (el.form)

class El {
  constructor(tag, attrs = {}, kids = []) {
    Object.assign(this, { nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: [], parentElement: null, isConnected: true });
    this.name = attrs.name || "";
    this.id = attrs.id || "";
    this.value = attrs.value || "";
    for (const k of kids) this.append(k);
  }
  append(k) {
    if (typeof k === "string") k = { nodeType: 3, nodeValue: k };
    k.parentElement = this;
    this.childNodes.push(k);
    return k;
  }
  getAttribute(n) {
    return this.attrs[n] ?? null;
  }
  hasAttribute(n) {
    return n in this.attrs;
  }
  matches(sel) {
    const m = /^(\w*)(?:\[(\w+)(?:=(\w+))?\])?$/.exec(sel);
    return (!m[1] || this.tagName === m[1].toUpperCase()) && (!m[2] || (m[3] ? this.attrs[m[2]] === m[3] : m[2] in this.attrs));
  }
  contains(e) {
    for (; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
  closest(sel) {
    for (let e = this; e; e = e.parentElement) if (e.tagName && e.matches(sel)) return e;
    return null;
  }
  get form() {
    if (!LISTED.has(this.tagName)) return undefined;
    if ("form" in this.attrs) return this.doc.getElementById(this.attrs.form);
    return this.closest("form");
  }
  get innerText() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.checkVisibility() ? c.innerText : "")).join("");
  }
  get type() {
    return this.attrs.type || (this.tagName === "BUTTON" ? "submit" : "text");
  }
  checkVisibility() {
    return !("hidden" in this.attrs);
  }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join("");
  }
  // Just enough of the DOM for actions: `on[type]` handlers stand in for page listeners.
  querySelectorAll(sel) {
    const out = [];
    const visit = (e) => e.childNodes.forEach((c) => c.nodeType === 1 && (sel.split(/,\s*/).some((s) => c.matches(s)) && out.push(c), visit(c)));
    visit(this);
    return out;
  }
  dispatchEvent(e) {
    this.on?.[e.type]?.(e);
    return true;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 };
  }
  scrollIntoView() {}
  focus() {}
  click() {
    this.clicked = true;
  }
  requestSubmit() {
    this.submitted = true;
  }
}

class Ev {
  constructor(type, init = {}) {
    Object.assign(this, init, { type });
  }
}
const stub = () => ({ style: {}, isConnected: true, setAttribute() {}, appendChild() {}, remove() {}, attachShadow: stub });

function page(body, { ld = [] } = {}) {
  const all = [];
  const index = (e) => (all.push(e), e.childNodes?.forEach((c) => c.nodeType === 1 && index(c)));
  index(body);
  const document = {
    body,
    title: "Shop",
    documentElement: { lang: "en", scrollHeight: 1000, appendChild() {} },
    createElement: stub,
    querySelectorAll: (sel) => (sel.includes("ld+json") ? ld.map((textContent) => ({ textContent })) : []),
    getElementById: (id) => all.find((e) => e.attrs.id === id) || null,
  };
  for (const e of all) e.doc = document;
  let listener;
  const observers = [];
  load(["content/content.js"], {
    window: {}, document, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, location: { href: "https://shop.example/cart" },
    scrollY: 0, innerHeight: 800, innerWidth: 1200, getSelection: () => "",
    Event: Ev, KeyboardEvent: Ev, MouseEvent: Ev, PointerEvent: Ev, requestAnimationFrame: (f) => setTimeout(f, 0),
    browser: { runtime: { onMessage: { addListener: (fn) => (listener = fn) } } },
    performance, MutationObserver: class {
      constructor(fn) { observers.push((this.fn = fn)); }
      observe() {}
      disconnect() { observers.splice(observers.indexOf(this.fn), 1); }
    },
  });
  const send = async (op, args) => {
    const r = await listener({ pagemortem: true, op, args });
    if (r?.error) throw new Error(r.error);
    return r;
  };
  return {
    send,
    mutate: () => observers.forEach((fn) => fn([])),
    async describe(label) {
      const { text, doc } = await send("readPage", {});
      const id = Number(new RegExp(`\\[(\\d+) \\w+(?:\\(\\w+\\))? "${label}"`).exec(text)[1]);
      return send("describe", { id, doc });
    },
  };
}

const { clickRisk } = load(AGENT_FILES, { browser: { runtime: { getManifest: () => ({}) } } });

test("a button tied to a form with form=\"id\" is that form's submit button", async () => {
  const p = page(
    new El("body", {}, [
      new El("form", { id: "checkout", method: "post" }, [new El("input", { name: "qty" })]),
      new El("div", {}, [new El("button", { form: "checkout" }, ["Go"])]),
    ]),
  );
  const info = await p.describe("Go");
  assert.equal(info.inForm, true);
  assert.equal(info.isSubmit, true);
  assert.equal(info.formMethod, "post");
  assert.equal(clickRisk(info).level, "approve");
});

test("form=\"id\" naming another form detaches a control from the form around it", async () => {
  const p = page(new El("body", {}, [new El("form", { method: "post" }, [new El("button", { type: "button", form: "nowhere" }, ["Toggle"])])]));
  assert.equal((await p.describe("Toggle")).inForm, false);
});

test("a submit button's formmethod overrides its form's method", async () => {
  const p = page(new El("body", {}, [new El("form", { method: "get" }, [new El("button", { type: "submit", formmethod: "POST" }, ["Save"])])]));
  assert.equal((await p.describe("Save")).formMethod, "post");
});

test("controls without a form owner (role=button) still count their enclosing form", async () => {
  const p = page(new El("body", {}, [new El("form", { method: "post" }, [new El("div", { role: "button" }, ["Next"])])]));
  const info = await p.describe("Next");
  assert.equal(info.inForm, true);
  assert.equal(clickRisk(info).level, "approve");
});

test("credential fields omit values and refuse typing and key presses across label and identifier spellings", async () => {
  const names = ["API Key", "Access Token", "Secret", "Client Secret", "Recovery Code", "Password", "Card Number", "cc num", "PIN"];
  const spellings = (name) => [name, name.toLowerCase().replaceAll(" ", "-"), name.toLowerCase().replaceAll(" ", "_"),
    name.split(" ").map((word, index) => index === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1)).join("")];
  for (const name of new Set(names.flatMap(spellings))) {
    for (const source of ["aria-label", "placeholder", "name", "id", "label"]) {
      const input = new El("input", source === "label" ? {} : { [source]: name });
      if (source === "label") input.labels = [{ innerText: name }];
      input.value = "synthetic-credential";
      const p = page(new El("body", {}, [input]));
      const { text, doc } = await p.send("readPage", {});
      const id = Number(/\[(\d+) input/.exec(text)[1]);
      assert.match(text, /sensitive, not editable/, `${source}: ${name}`);
      assert.doesNotMatch(text, /synthetic-credential/);
      assert.equal((await p.send("describe", { id, doc })).sensitive, true);
      await assert.rejects(p.send("type", { id, doc, text: "replacement" }), /Refused/);
      await assert.rejects(p.send("pressKey", { id, doc, key: "Enter" }), /Refused/);
      assert.equal(input.value, "synthetic-credential");
    }
  }
});

test("ordinary fields are still readable and not classified as credentials", async () => {
  for (const label of ["Search", "Secretary", "Recovery email", "API endpoint", "Access level", "Key binding"]) {
    const input = new El("input", { "aria-label": label, value: "ordinary-value" });
    const p = page(new El("body", {}, [input]));
    const { text, doc } = await p.send("readPage", {});
    const id = Number(/\[(\d+) input/.exec(text)[1]);
    assert.match(text, /value="ordinary-value"/, label);
    assert.equal((await p.send("describe", { id, doc })).sensitive, false, label);
  }
});

// ---------- search fields ----------
test("only the field itself or a GET form marked as a search makes a search field", async () => {
  const cases = [
    [new El("body", {}, [new El("input", { type: "search", "aria-label": "Find" })]), true],
    [new El("body", {}, [new El("input", { role: "searchbox", "aria-label": "Find" })]), true],
    [new El("body", {}, [new El("form", { role: "search" }, [new El("input", { "aria-label": "Find" })])]), true],
    [new El("body", { role: "search" }, [new El("input", { "aria-label": "Find" })]), false],
    [new El("body", {}, [new El("div", { role: "search" }, [new El("input", { "aria-label": "Find" })])]), false],
    [new El("body", {}, [new El("form", { role: "search", method: "post" }, [new El("input", { "aria-label": "Find" })])]), false],
    [new El("body", {}, [new El("form", { method: "post" }, [new El("input", { type: "search", "aria-label": "Find" })])]), false],
    [new El("body", {}, [new El("form", { role: "search" }, [new El("textarea", { "aria-label": "Find" })])]), false],
  ];
  for (const [body, expected] of cases) {
    const p = page(body);
    const field = body.querySelectorAll("input, textarea")[0];
    assert.equal((await p.describe("Find")).searchField, expected, JSON.stringify({ body: body.attrs, parent: field.parentElement.attrs, field: field.attrs }));
  }
});

// ---------- form destinations ----------
test("describe reports where a submit sends data: formaction, else the form's action, else the page", async () => {
  const p = page(
    new El("body", {}, [
      new El("form", { action: "/checkout?step=2", method: "post" }, [
        new El("input", { "aria-label": "Qty" }),
        new El("button", {}, ["Buy"]),
        new El("button", { formaction: "https://evil.example/collect" }, ["Express"]),
        new El("button", { type: "button", formaction: "https://evil.example/ignored" }, ["Help"]),
      ]),
      new El("form", {}, [new El("button", {}, ["Plain"])]),
    ]),
  );
  assert.equal((await p.describe("Qty")).action, "https://shop.example/checkout?step=2", "Enter in a field submits to the form's action");
  assert.equal((await p.describe("Buy")).action, "https://shop.example/checkout?step=2");
  assert.equal((await p.describe("Express")).action, "https://evil.example/collect");
  assert.equal((await p.describe("Help")).action, "https://shop.example/checkout?step=2", "formaction counts only on submit buttons");
  assert.equal((await p.describe("Plain")).action, "https://shop.example/cart");
  const { send } = p;
  const a = await p.describe("Buy");
  assert.notEqual(a.fp, (await p.describe("Express")).fp);
  void send;
});

// ---------- the approved element, right before activation ----------
function form(handlers = {}) {
  const field = new El("input", { "aria-label": "Search" });
  const button = new El("button", {}, ["Go"]);
  const f = new El("form", { action: "/search" }, [field, button]);
  const p = page(new El("body", {}, [f]));
  return { p, f, field, button, on: (el, type, fn) => ((el.on ||= {})[type] = fn), ...handlers };
}
const target = async (p, label) => {
  const { text, doc } = await p.send("readPage", {});
  const id = Number(new RegExp(`\\[(\\d+) \\w+(?:\\(\\w+\\))? "${label}"`).exec(text)[1]);
  const info = await p.send("describe", { id, doc });
  return { id, doc, expect: info.fp };
};

test("a click goes ahead when the element is still what was approved", async () => {
  const { p, button } = form();
  await p.send("click", await target(p, "Go"));
  assert.equal(button.clicked, true);
});

test("a click is refused when a page handler changes where the form sends before the activation", async () => {
  const { p, f, button, on } = form();
  const t = await target(p, "Go");
  on(button, "pointerdown", () => (button.attrs.formaction = "https://evil.example/collect"));
  await assert.rejects(p.send("click", t), /changed before the action/);
  assert.equal(button.clicked, undefined);
  // Changing the form itself (not the button) before the click is caught too.
  delete button.attrs.formaction;
  button.on = null;
  f.attrs.action = "https://evil.example/collect";
  await assert.rejects(p.send("click", t), /changed before the action/);
  assert.equal(button.clicked, undefined);
});

test("typing with submit is refused when a key handler redirects the form before it submits", async () => {
  const { p, f, field, on } = form();
  const ok = await target(p, "Search");
  await p.send("type", { ...ok, text: "socks", submit: true });
  assert.equal(f.submitted, true);
  f.submitted = false;
  on(field, "keydown", () => (f.attrs.method = "post"));
  await assert.rejects(p.send("type", { ...ok, text: "socks", submit: true }), /changed before the action/);
  assert.equal(f.submitted, false);
});

test("Enter in a field is refused when the field changed after approval", async () => {
  const { p, f, field, on } = form();
  const t = await target(p, "Search");
  on(field, "keydown", () => (f.attrs.action = "https://evil.example/"));
  await assert.rejects(p.send("pressKey", { ...t, key: "Enter" }), /changed before the action/);
  assert.equal(f.submitted, undefined);
});

test("actions without the current document's token are refused", async () => {
  const { p } = form();
  const { id } = await target(p, "Go");
  for (const op of ["describe", "click", "highlight", "rect"]) {
    await assert.rejects(p.send(op, { id }), /page changed since it was read/, op);
  }
});

// ---------- credential hints in title and aria-labelledby ----------
test("a credential hint in title or aria-labelledby hides the value and refuses typing", async () => {
  const cases = [
    () => [new El("input", { title: "Password", value: "synthetic-credential" })],
    () => [new El("span", { id: "lbl" }, ["One-time code"]), new El("input", { "aria-labelledby": "lbl", value: "synthetic-credential" })],
  ];
  for (const make of cases) {
    const kids = make();
    const input = kids.at(-1);
    const p = page(new El("body", {}, kids));
    const { text, doc } = await p.send("readPage", {});
    assert.doesNotMatch(text, /synthetic-credential/);
    assert.match(text, /sensitive, not editable/);
    const id = Number(/\[(\d+) input/.exec(text)[1]);
    await assert.rejects(p.send("type", { id, doc, text: "x" }), /Refused/);
    assert.equal(input.value, "synthetic-credential");
  }
  // aria-labelledby is also how the field is labelled.
  const p = page(new El("body", {}, [new El("span", { id: "q" }, ["Destination"]), new El("input", { "aria-labelledby": "q" })]));
  assert.equal((await p.describe("Destination")).label, "Destination");
});

// ---------- Ask / Summarize text ----------
test("page text for Ask and Summarize leaves out editable regions that hold credentials", async () => {
  const p = page(
    new El("body", {}, [
      new El("p", {}, ["Save these somewhere safe.\n"]),
      new El("div", { contenteditable: "true", "aria-label": "Recovery codes" }, ["abcd-1234 efgh-5678"]),
      new El("div", { contenteditable: "true", "aria-label": "Notes" }, ["ordinary notes"]),
    ]),
  );
  const { text } = await p.send("getText", {});
  assert.doesNotMatch(text, /abcd-1234|efgh-5678/);
  assert.match(text, /\[sensitive field omitted\]/);
  assert.match(text, /Save these somewhere safe/);
  assert.match(text, /ordinary notes/);
});

test("a label hidden by the layout is shown next to the visible one and can be found", async () => {
  const p = page(new El("body", {}, [
    new El("a", { href: "/repo/tree/main" }, [new El("span", {}, ["Files"]), new El("span", { hidden: "" }, ["Files and versions"])]),
    new El("a", { href: "/repo" }, [new El("span", {}, ["Model card"])]),
  ]));
  const { text } = await p.send("readPage", {});
  assert.match(text, /link "Files" \(also "Files and versions"\) → \S*\/repo\/tree\/main/);
  assert.doesNotMatch(text, /Model card" \(also/);
  const found = await p.send("find", { query: "files and versions" });
  assert.equal(found.total, 1);
  assert.equal(found.matches[0].kind, "link");
});

test("watchText returns the page text when it differs from the last hash, and waits for a change otherwise", async () => {
  const price = new El("p", {}, ["Price: $54.99"]);
  const p = page(new El("body", {}, [price]));
  const first = await p.send("watchText", { since: "", timeoutMs: 0 });
  assert.equal(first.changed, true);
  assert.match(first.text, /\$54\.99/);
  assert.equal((await p.send("watchText", { since: first.hash, timeoutMs: 0 })).changed, false);
  const later = p.send("watchText", { since: first.hash, timeoutMs: 3000 });
  setTimeout(() => {
    price.childNodes[0].nodeValue = "Price: $47.50";
    p.mutate();
  }, 50);
  const r = await later;
  assert.equal(r.changed, true);
  assert.match(r.text, /\$47\.50/);
});

test("read_page ends with the product variants a page publishes as JSON-LD, and find_in_page searches them", async () => {
  const variant = (color, code, price, stock) => ({
    "@type": "Product", sku: code, name: `PLA Matte - ${color} (${code}) / Refill / 1kg`,
    offers: { "@type": "Offer", price, priceCurrency: "USD", availability: `https://schema.org/${stock}` },
  });
  const group = {
    "@context": "https://schema.org", "@type": "ProductGroup", name: "PLA Matte", brand: { "@type": "Brand", name: "Bambu Lab" },
    hasVariant: [variant("Ivory White", "11100", "19.99", "InStock"), variant("Sakura Pink", "11201", "19.99", "OutOfStock"),
      { "@type": "Product", name: "PLA Matte Sampler", color: "Assorted", offers: [{ "@type": "AggregateOffer", lowPrice: 5, highPrice: 9, priceCurrency: "USD" }] }],
  };
  const p = page(new El("body", {}, [new El("h1", {}, ["PLA Matte"]), new El("button", { "aria-label": "swatch" })]), {
    ld: ["{not json", JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "BreadcrumbList", name: "Home" }, group] })],
  });
  const { text } = await p.send("readPage", {});
  assert.match(text, /## Structured product data \(from the page's JSON-LD\)\nProduct group: PLA Matte · brand Bambu Lab · 3 variants\n/);
  assert.match(text, /- PLA Matte - Ivory White \(11100\) \/ Refill \/ 1kg — 19\.99 USD, InStock\n/);
  assert.match(text, /- PLA Matte - Sakura Pink \(11201\) \/ Refill \/ 1kg — 19\.99 USD, OutOfStock/);
  assert.match(text, /- PLA Matte Sampler \(Assorted\) — 5–9 USD/);
  assert.doesNotMatch(text, /Home/);
  assert.ok(text.indexOf("Structured product data") > text.indexOf("swatch"), "visible text comes first");
  const found = await p.send("find", { query: "sakura pink" });
  assert.equal(found.total, 1);
  assert.equal(found.matches[0].kind, "text");
  assert.equal(found.matches[0].id, null);
});

test("pages without product JSON-LD read as before, and huge variant lists are capped", async () => {
  const plain = page(new El("body", {}, [new El("p", {}, ["Hello"])]), { ld: [JSON.stringify({ "@type": "Article", name: "Post" })] });
  assert.doesNotMatch((await plain.send("readPage", {})).text, /Structured product data/);
  const many = Array.from({ length: 250 }, (_, i) => ({ "@type": "Product", name: `Shade ${i}` }));
  const big = page(new El("body", {}, [new El("p", {}, ["Hello"])]), { ld: [JSON.stringify([{ "@type": "Product", name: "Paint", hasVariant: many }])] });
  const { text } = await big.send("readPage", { maxChars: 100_000 });
  assert.match(text, /Paint · 250 variants/);
  assert.match(text, /- Shade 199\n- …\(50 more variants not shown\)/);
  assert.doesNotMatch(text, /Shade 200/);
});
