// Runs the real content script against a minimal fake DOM: just enough for readPage and describe.
import test from "node:test";
import assert from "node:assert/strict";
import { load, AGENT_FILES } from "./harness.mjs";

const LISTED = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]); // elements with a form owner (el.form)

class El {
  constructor(tag, attrs = {}, kids = []) {
    Object.assign(this, { nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: [], parentElement: null, isConnected: true });
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
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.innerText)).join("");
  }
  get type() {
    return this.attrs.type || (this.tagName === "BUTTON" ? "submit" : "text");
  }
  checkVisibility() {
    return true;
  }
}

function page(body) {
  const all = [];
  const index = (e) => (all.push(e), e.childNodes?.forEach((c) => c.nodeType === 1 && index(c)));
  index(body);
  const document = {
    body,
    title: "Shop",
    documentElement: { lang: "en", scrollHeight: 1000 },
    querySelectorAll: () => [],
    getElementById: (id) => all.find((e) => e.attrs.id === id) || null,
  };
  for (const e of all) e.doc = document;
  let listener;
  load(["content/content.js"], {
    window: {}, document, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, location: { href: "https://shop.example/cart" },
    scrollY: 0, innerHeight: 800, getSelection: () => "",
    browser: { runtime: { onMessage: { addListener: (fn) => (listener = fn) } } },
  });
  const send = async (op, args) => {
    const r = await listener({ pagemortem: true, op, args });
    if (r?.error) throw new Error(r.error);
    return r;
  };
  return {
    async describe(label) {
      const { text, doc } = await send("readPage", {});
      const id = Number(new RegExp(`\\[(\\d+) \\w+ "${label}"`).exec(text)[1]);
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
