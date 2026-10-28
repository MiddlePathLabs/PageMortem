// press_key and wait_for: key presses must not get around the click and typing approvals, and waits must stay bounded,
// stoppable and checked for where the page ended up.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, call, answer, results } from "./harness.mjs";

const SHOP = "https://shop.example/";
const page = (title, text, elements = {}) => ({ title, text, elements });
const keys = (web) => web.log.filter(([op]) => op === "key").map(([, , a]) => a.key);

// ---------- press_key ----------
test("Escape, arrows and Tab require approval; Tab reports where focus went", async () => {
  const { run, ui, web, agent } = setup({
    sites: { [SHOP]: page("Shop", "dialog", { 1: { kind: "button", label: "Menu" }, 2: { kind: "input", label: "Search", searchField: true } }) },
    replies: [call("press_key", { id: 1, key: "Escape" }), call("press_key", { id: 2, key: "ArrowDown" }), call("press_key", { id: 2, key: "Tab" }), answer("ok")],
    decide: () => "yes",
  });
  await run();
  assert.equal(ui.cards.length, 3);
  assert.deepEqual(keys(web), ["Escape", "ArrowDown", "Tab"]);
  assert.match(results(agent)[2], /focus moved to \[99 input "Next field"\]/);
});

test("Enter or Space on a risky control asks like a click, with no allow-all, and nothing is pressed when denied", async () => {
  for (const [key, el] of [
    ["Enter", { kind: "button", label: "Delete account" }],
    ["Space", { kind: "button", label: "Go", isSubmit: true, inForm: true, formMethod: "get" }],
    ["Enter", { kind: "button", label: "Next", inForm: true, formMethod: "post" }],
  ]) {
    const { run, ui, web } = setup({
      sites: { [SHOP]: page("Shop", "", { 1: el }) },
      replies: [call("press_key", { id: 1, key }), answer("ok")],
      decide: () => "no",
    });
    await run();
    assert.equal(ui.cards.length, 1, el.label);
    assert.equal(ui.cards[0].title, `Press ${key} on “${el.label}”?`);
    assert.equal(ui.cards[0].allowAll, null);
    assert.equal(ui.cards[0].remember, null, `${el.label} can't be remembered`);
    assert.equal(web.log.length, 0, `${el.label} must not be pressed when denied`);
  }
});

test("Enter on a same-site link uses the click approval", async () => {
  const { run, ui, web, agent } = setup({
    sites: {
      [SHOP]: page("Shop", "", { 1: { kind: "link", tag: "A", label: "Next page", href: `${SHOP}p2` } }),
      [`${SHOP}p2`]: page("Page 2", "second page items"),
    },
    replies: [call("press_key", { id: 1, key: "Enter" }), answer("ok")],
    decide: () => "yes",
  });
  await run();
  assert.equal(ui.cards.length, 1);
  assert.equal(web.tabs.get(1).url, `${SHOP}p2`);
  assert.match(results(agent)[0], /navigated to .*p2[\s\S]*second page items/);
});

test("Enter on a link to another site needs the site approval first", async () => {
  const { run, ui, web } = setup({
    sites: { [SHOP]: page("Shop", "", { 1: { kind: "link", tag: "A", label: "Partner", href: "https://evil.example/" } }) },
    replies: [call("press_key", { id: 1, key: "Enter" }), answer("ok")],
    decide: () => "no",
  });
  await run();
  assert.equal(ui.cards[0].title, "Go to another site?");
  assert.equal(web.log.length, 0);
});

test("Enter in a field is approved like submitting, every time unless it is a search box", async () => {
  const msg = setup({
    sites: { [SHOP]: page("Shop", "", { 3: { kind: "input", label: "Message" } }) },
    replies: [call("press_key", { id: 3, key: "Enter" }), call("press_key", { id: 3, key: "Enter" }), answer("ok")],
    decide: (c) => (c.allowAll ? "all" : "yes"),
  });
  await msg.run();
  assert.equal(msg.ui.cards.length, 2, "asked both times");
  assert.match(msg.ui.cards[0].detail, /submits/);
  assert.ok(msg.ui.cards.every((c) => c.allowAll === null));

  const search = setup({
    sites: { [SHOP]: page("Shop", "", { 3: { kind: "input", label: "Search", searchField: true } }) },
    replies: [call("press_key", { id: 3, key: "Enter" }), call("press_key", { id: 3, key: "Enter" }), answer("ok")],
    decide: (c) => (c.allowAll ? "all" : "no"),
  });
  await search.run();
  assert.equal(search.ui.cards.length, 1);
  assert.deepEqual(keys(search.web), ["Enter", "Enter"]);
});

test("sensitive fields and Space in a field are refused before any approval", async () => {
  const { run, ui, web, agent } = setup({
    sites: { [SHOP]: page("Shop", "", { 3: { kind: "input", label: "Password", sensitive: true }, 4: { kind: "input", label: "Name" } }) },
    replies: [call("press_key", { id: 3, key: "Enter" }), call("press_key", { id: 4, key: "Space" }), answer("ok")],
    decide: () => "yes",
  });
  await run();
  assert.equal(ui.cards.length, 0);
  assert.equal(web.log.length, 0);
  assert.match(results(agent)[0], /password\/payment\/identity/);
  assert.match(results(agent)[1], /use type_text/);
});

test("letters and modifier shortcuts are rejected; common spellings of allowed keys are accepted", async () => {
  const { run, web, agent } = setup({
    sites: { [SHOP]: page("Shop", "", { 1: { kind: "button", label: "Inbox row" } }) },
    replies: [
      call("press_key", { id: 1, key: "#" }),
      call("press_key", { id: 1, key: "Ctrl+Enter" }),
      call("press_key", { id: 1, key: "e" }),
      call("press_key", { id: 1, key: "esc" }),
      call("press_key", { id: 1, key: "pagedown" }),
      answer("ok"),
    ],
    decide: () => "yes",
  });
  await run();
  const r = results(agent);
  for (const i of [0, 1, 2]) assert.match(r[i], /must be one of/);
  assert.deepEqual(keys(web), ["Escape", "PageDown"]);
});

test("a key the page handles itself and uses to leave the site is caught and undone", async () => {
  const { run, ui, web, agent } = setup({
    sites: {
      [SHOP]: page("Shop", "", { 1: { kind: "button", label: "Gallery", onKey: (tab, w) => (w.navigate(tab, "https://evil.example/x"), true) } }),
    },
    replies: [call("press_key", { id: 1, key: "ArrowRight" }), answer("ok")],
    decide: (c) => c.title.startsWith("Press ArrowRight") ? "yes" : "no",
  });
  await run();
  assert.equal(ui.cards.at(-1).title, "The page went to another site. Continue there?");
  assert.equal(web.tabs.get(1).url, SHOP, "tab sent back");
  assert.match(results(agent)[0], /outside the sites approved/);
});

test("an element that changes while the key-press card is open is not pressed", async () => {
  const { run, web, agent } = setup({
    sites: { [SHOP]: page("Shop", "", { 1: { kind: "button", label: "Save draft" } }) },
    replies: [call("press_key", { id: 1, key: "Enter" }), answer("ok")],
    decide: () => {
      web.tabs.get(1).doc.elements[1].label = "Delete everything";
      return "yes";
    },
  });
  await run();
  assert.equal(web.log.length, 0);
  assert.match(results(agent)[0], /changed while waiting for approval/);
});

test("with 'ask before every click' on, other keys ask too and share the ordinary-click allow-all", async () => {
  const { run, ui, web } = setup({
    settings: { confirmAll: true },
    sites: { [SHOP]: page("Shop", "", { 1: { kind: "button", label: "Tab A" } }) },
    replies: [call("press_key", { id: 1, key: "Escape" }), call("click", { id: 1 }), answer("ok")],
    decide: (c) => (c.allowAll ? "all" : "no"),
  });
  await run();
  assert.equal(ui.cards.length, 1);
  assert.match(ui.cards[0].allowAll, /ordinary clicks on shop\.example/);
  assert.equal(web.log.length, 2);
});

// ---------- wait_for ----------
test("wait_for returns as soon as the text appears, with the updated page", async () => {
  const { run, ui, agent } = setup({
    sites: { [SHOP]: { ...page("Shop", "Loading…"), onWait: (tab) => (tab.doc.spec.text = "3 results: red, green, blue") } },
    replies: [call("wait_for", { text: "results" }), answer("ok")],
  });
  await run();
  assert.equal(ui.cards.length, 0);
  assert.match(results(agent)[0], /^Done waiting for “results” to appear[\s\S]*red, green, blue/);
});

test("wait_for gone waits for a spinner to go, and reports when it gives up", async () => {
  const { run, agent, web } = setup({
    sites: { [SHOP]: page("Shop", "Loading…") },
    replies: [call("wait_for", { gone: "Loading", seconds: 4 }), answer("ok")],
  });
  await run();
  assert.match(results(agent)[0], /^Gave up after 4 s waiting for “Loading” to disappear/);
  assert.equal(web.log.find(([op]) => op === "wait")[2].timeoutMs, 4000);
});

test("a page that redirects itself off-site during a wait is caught and sent back", async () => {
  const { run, ui, web, agent } = setup({
    sites: { [SHOP]: { ...page("Shop", "Loading…"), onWait: (tab, w) => w.navigate(tab, "https://evil.example/landing") } },
    replies: [call("wait_for", { text: "results" }), answer("ok")],
    decide: () => "no",
  });
  await run();
  assert.equal(ui.cards.at(-1).title, "The page went to another site. Continue there?");
  assert.equal(web.tabs.get(1).url, SHOP);
  assert.match(results(agent)[0], /navigated while waiting[\s\S]*outside the sites approved/);
});

test("a same-site navigation during a wait is reported and the new page read", async () => {
  const { run, ui, agent } = setup({
    sites: {
      [SHOP]: { ...page("Shop", "Searching…"), onWait: (tab, w) => w.navigate(tab, `${SHOP}results`) },
      [`${SHOP}results`]: page("Results", "found 7 items"),
    },
    replies: [call("wait_for", { text: "items" }), answer("ok")],
  });
  await run();
  assert.equal(ui.cards.length, 0);
  assert.match(results(agent)[0], /navigated while waiting[\s\S]*found 7 items/);
});

test("waits are capped at 15 seconds and Stop ends a plain wait at once", async () => {
  const capped = setup({ sites: { [SHOP]: page("Shop", "") }, replies: [call("wait_for", { seconds: 60 }), answer("ok")] });
  await capped.run();
  assert.match(results(capped.agent)[0], /must be at most 15/);

  const { run, agent, model } = setup({ sites: { [SHOP]: page("Shop", "") }, replies: [call("wait_for", { seconds: 15 })] });
  const p = run();
  setTimeout(() => agent.stop(), 60);
  const t = Date.now();
  await assert.rejects(p, /Stopped/);
  assert.ok(Date.now() - t < 400, "stopped before the wait ran out");
  assert.equal(model.calls.length, 1);
});
