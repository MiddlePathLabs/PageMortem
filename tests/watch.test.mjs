// reload and watch: a long watch runs in code (one step, no model calls per check), stops on anything that could fake
// the change, and never gets around the approval for what the agent does once the change happens.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, call, answer, results } from "./harness.mjs";

const ITEM = "https://shop.example/item/42";
const OUT = "Blue kettle. Out of stock. [1 button \"Add to cart\"]";
const IN = "Blue kettle. In stock, ships tomorrow. [1 button \"Add to cart\"]";
const cart = { 1: { kind: "button", label: "Add to cart", cartContext: "Blue kettle|sku=42|quantity=1" } };
/** A product page that comes back in stock on the nth reload. */
const restocks = (n) => ({ title: "Kettle", text: OUT, elements: cart, onReload: (tab) => void (tab.reloads >= n && (w0.text = IN)) });
let w0;
const item = (n) => (w0 = restocks(n));

test("reload re-reads the page without asking", async () => {
  const { run, ui, web, agent } = setup({
    start: ITEM,
    sites: { [ITEM]: { title: "Kettle", text: OUT, onReload: (tab) => void (web0.sites[ITEM].text = "reloaded text") } },
    replies: [call("reload"), answer("ok")],
  });
  const web0 = web;
  await run();
  assert.equal(ui.cards.length, 0);
  assert.equal(web.tabs.get(1).reloads, 1);
  assert.match(results(agent)[0], /^Reloaded\.[\s\S]*reloaded text/);
});

test("watch reloads until the item is back in stock in one step, notifies, and Add to cart still needs approval", async () => {
  const { run, ui, web, agent, model } = setup({
    start: ITEM,
    sites: { [ITEM]: item(3) },
    replies: [call("watch", { gone: "Out of stock", every: 15 }), call("click", { id: 1 }), answer("not added")],
    decide: (c) => (c.title === "Watch this page?" ? "yes" : "no"),
  });
  web.granted.add("notifications");
  await run();
  assert.equal(web.tabs.get(1).reloads, 3);
  assert.equal(model.calls.length, 3, "the watch itself made no model calls");
  assert.match(results(agent)[0], /^The change happened after .* \(4 checks\): “Out of stock” to disappear\. The user has been notified\.[\s\S]*In stock/);
  assert.equal(web.notifications.length, 1);
  assert.match(web.notifications[0].message, /shop\.example: “Out of stock” disappeared/);

  const [watchCard, cartCard] = ui.cards;
  assert.match(watchCard.detail, /every 15 s for up to 30 min/);
  assert.equal(watchCard.permissions, undefined, "permission already granted");
  assert.equal(cartCard.title, "Click “Add to cart”?");
  assert.equal(cartCard.allowAll, null);
  assert.equal(cartCard.remember, null, "a purchase step can't be remembered");
  assert.equal(web.log.filter(([op]) => op === "click").length, 0);
});

test("without the notifications permission the card asks for it, but only as an option", async () => {
  const { run, ui, web, agent } = setup({
    start: ITEM,
    sites: { [ITEM]: item(1) },
    replies: [call("watch", { gone: "Out of stock", every: 15 }), answer("ok")],
    decide: () => "yes",
  });
  await run();
  assert.deepEqual([...ui.cards[0].permissions], ["notifications"]);
  assert.equal(ui.cards[0].permissionsOptional, true);
  assert.equal(web.notifications.length, 0);
  assert.doesNotMatch(results(agent)[0], /notified/);
});

test("intervals under 15 seconds are rejected; a watch may last as long as the user asks", async () => {
  const { run, agent, web, ui } = setup({
    start: ITEM,
    sites: { [ITEM]: item(1) },
    replies: [call("watch", { gone: "Out of stock", every: 5 }), call("watch", { gone: "Out of stock", every: 30, minutes: 1440 }), answer("ok")],
  });
  await run();
  assert.match(results(agent)[0], /must be at least 15/);
  assert.equal(web.tabs.get(1).reloads, undefined);
  assert.match(ui.cards[0].detail, /every 30 s for up to 24 hours/);
});

test("watch needs something to look for, and returns at once when it's already there", async () => {
  const { run, agent, ui } = setup({
    start: ITEM,
    sites: { [ITEM]: { title: "Kettle", text: IN, elements: cart } },
    replies: [call("watch", {}), call("watch", { text: "In stock" }), answer("ok")],
  });
  await run();
  assert.match(results(agent)[0], /give text that should appear/);
  assert.match(results(agent)[1], /^No need to watch/);
  assert.equal(ui.cards.length, 0);
});

test("a denied watch reloads nothing", async () => {
  const { run, web, agent } = setup({ start: ITEM, sites: { [ITEM]: item(1) }, replies: [call("watch", { gone: "Out of stock" }), answer("ok")], decide: () => "no" });
  await run();
  assert.equal(web.tabs.get(1).reloads, undefined);
  assert.match(results(agent)[0], /denied watching/);
});

test("a reload that lands on a login page stops the watch instead of counting as the change", async () => {
  const LOGIN = "https://shop.example/login";
  const { run, web, agent } = setup({
    start: ITEM,
    sites: { [ITEM]: { title: "Kettle", text: OUT, onReload: () => LOGIN }, [LOGIN]: { title: "Sign in", text: "Please sign in" } },
    replies: [call("watch", { gone: "Out of stock", every: 15 }), answer("ok")],
    decide: () => "yes",
  });
  web.granted.add("notifications");
  await run();
  assert.match(results(agent)[0], /^Stopped watching: reloading led to .*login/);
  assert.equal(web.notifications.length, 0);
});

test("a reload that goes off-site is caught, undone and ends the watch", async () => {
  const { run, ui, web, agent } = setup({
    start: ITEM,
    sites: { [ITEM]: { title: "Kettle", text: OUT, onReload: () => "https://evil.example/" } },
    replies: [call("watch", { gone: "Out of stock", every: 15 }), answer("ok")],
    decide: (c) => (c.title === "Watch this page?" ? "yes" : "no"),
  });
  await run();
  assert.equal(ui.cards.at(-1).title, "The page went to another site. Continue there?");
  assert.equal(web.tabs.get(1).url, ITEM);
  assert.match(results(agent)[0], /^Stopped watching: after a reload, .*outside the sites approved/);
});

test("watch gives up at its time limit", async () => {
  const { run, web, agent } = setup({
    start: ITEM,
    sites: { [ITEM]: item(1000) },
    replies: [call("watch", { gone: "Out of stock", every: 15, minutes: 1 }), answer("ok")],
    decide: () => "yes",
  });
  await run();
  assert.match(results(agent)[0], /^Stopped watching after 1 min \(\d+ checks\) without seeing “Out of stock” to disappear\. The watch ran out/);
  assert.ok(web.tabs.get(1).reloads >= 3 && web.tabs.get(1).reloads <= 4);
});

test("Stop ends a watch at once", async () => {
  const { run, agent, model } = setup({
    start: ITEM,
    sites: { [ITEM]: item(1000) },
    replies: [call("watch", { gone: "Out of stock", every: 600, minutes: 240 })],
    decide: () => "yes",
  });
  const p = run();
  setTimeout(() => agent.stop(), 100);
  const t = Date.now();
  await assert.rejects(p, /Stopped/);
  assert.ok(Date.now() - t < 500);
  assert.equal(model.calls.length, 1);
});

// ---------- live pages and conditions ----------
const CLOCK = "https://www.google.com/search?q=utc+time";
/** A clock page that ticks while it is being observed, without any reload. */
const clock = () => {
  let t = 47 * 60 + 52; // 11:47:52 PM
  const fmt = () => `11:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(t % 60).padStart(2, "0")} PM`;
  const spec = { title: "utc time", text: `${fmt()}\nCoordinated Universal Time` };
  spec.onWait = () => {
    t += 7;
    spec.text = `${fmt()}\nCoordinated Universal Time`;
  };
  return spec;
};
/** A decision model that reads the clock and compares it with 11:49:00 PM. */
const clockJudge = (model) => {
  model.decisions = [];
  model.decide = async ({ question, text, model: name }) => {
    model.decisions.push({ question, text, name });
    const [, m, s] = /11:(\d\d):(\d\d) PM/.exec(text);
    return Number(m) * 60 + Number(s) >= 49 * 60 ? "yes" : "no";
  };
};

test("a condition is judged by the decision model as a live page changes, with no reload needed", async () => {
  const { run, web, agent, model } = setup({
    start: CLOCK,
    sites: { [CLOCK]: clock() },
    settings: { decisionModel: "d3-lite" },
    replies: [call("watch", { condition: "the clock shows 11:49:00 PM or later", every: 600, minutes: 5 }), answer("It's 11:49.")],
    decide: () => "yes",
  });
  clockJudge(model);
  web.granted.add("notifications");
  await run();
  assert.match(results(agent)[0], /^The change happened after .*“the clock shows 11:49:00 PM or later” to be true\. The user has been notified\./);
  assert.equal(web.tabs.get(1).reloads, undefined, "a live page needs no reload");
  assert.ok(model.decisions.length > 2);
  assert.equal(model.decisions[0].name, "d3-lite");
  assert.match(model.decisions[0].question, /11:49:00 PM or later/);
  assert.match(web.notifications[0].message, /“the clock shows 11:49:00 PM or later” is true/);
  assert.equal(model.calls.length, 2, "the main model is not called while watching");
});

test("literal text on a live page is caught between reloads too", async () => {
  const { run, web, agent } = setup({
    start: CLOCK,
    sites: { [CLOCK]: clock() },
    replies: [call("watch", { text: "11:48:", every: 600, minutes: 5 }), answer("ok")],
    decide: () => "yes",
  });
  await run();
  assert.match(results(agent)[0], /^The change happened/);
  assert.equal(web.tabs.get(1).reloads, undefined);
});

test("a condition needs a decision model", async () => {
  const { run, agent, ui } = setup({
    start: CLOCK,
    sites: { [CLOCK]: clock() },
    replies: [call("watch", { condition: "the clock shows 11:49:00 PM or later" }), answer("ok")],
  });
  await run();
  assert.match(results(agent)[0], /^Error: condition needs a decision model/);
  assert.equal(ui.cards.length, 0);
});

test("a condition already true needs no watch", async () => {
  const { run, agent, model, ui } = setup({
    start: CLOCK,
    sites: { [CLOCK]: { title: "utc time", text: "11:52:03 PM" } },
    settings: { decisionModel: "d3-lite" },
    replies: [call("watch", { condition: "the clock shows 11:49:00 PM or later" }), answer("ok")],
  });
  clockJudge(model);
  await run();
  assert.match(results(agent)[0], /^No need to watch/);
  assert.equal(ui.cards.length, 0);
});

test("a condition that never comes true reloads on schedule and reports running out", async () => {
  const { run, web, agent, model } = setup({
    start: ITEM,
    sites: { [ITEM]: item(1000) },
    settings: { decisionModel: "d3-lite" },
    replies: [call("watch", { condition: "the price is below $50", every: 15, minutes: 1 }), answer("ok")],
    decide: () => "yes",
  });
  model.decide = async () => "no";
  await run();
  assert.match(results(agent)[0], /^Stopped watching after 1 min .*The watch ran out before the change/);
  assert.ok(web.tabs.get(1).reloads >= 3 && web.tabs.get(1).reloads <= 4);
});

// ---------- Add to cart approved with the watch ----------
const CHECKOUT = "https://shop.example/checkout";
const restocking = (elements) => (w0 = { title: "Kettle", text: OUT, elements, onReload: (tab) => void (tab.reloads >= 1 && (w0.text = IN)) });
/** A literal stock change in the same document: the first check is false, the next sees the change. */
const liveRestocking = (elements = cart) => {
  let waits = 0;
  const spec = { title: "Kettle", text: OUT, elements };
  spec.onWait = () => { if (++waits >= 2) spec.text = IN; };
  return spec;
};

test("an Add to cart approved with the watch is clicked without asking, once, and notifies", async () => {
  const { run, ui, web, agent } = setup({
    start: ITEM,
    sites: { [ITEM]: liveRestocking() },
    replies: [call("watch", { gone: "Out of stock", every: 15, minutes: 1440, add_to_cart: true, cart_id: 1 }), call("click", { id: 1 }), call("click", { id: 1 }), answer("added")],
    decide: (c) => (c.title.startsWith("Watch this page") ? "yes" : "no"),
  });
  web.granted.add("notifications");
  await run();
  assert.equal(ui.cards[0].title, "Watch this page, then add to cart?");
  assert.match(ui.cards[0].detail, /existing “Add to cart” button \[1\] once within 60 seconds/);
  assert.match(results(agent)[0], /approved one click on the existing Add to cart button \[1\]/);
  assert.match(results(agent)[1], /^Clicked “Add to cart”/);
  assert.equal(web.log.filter(([op]) => op === "click").length, 1, "the second click was asked about and denied");
  assert.equal(ui.cards.length, 2);
  assert.equal(ui.cards[1].title, "Click “Add to cart”?");
  assert.match(web.notifications.at(-1).message, /clicked “Add to cart”/);
});

test("an unrelated risky click revokes the bound approval rather than retaining a site-wide cart permission", async () => {
  const elements = { 1: { kind: "button", label: "Buy now" }, 2: { kind: "button", label: "Add to cart and checkout" }, 3: { ...cart[1] } };
  const { run, ui, web } = setup({
    start: ITEM,
    sites: { [ITEM]: liveRestocking(elements) },
    replies: [call("watch", { gone: "Out of stock", every: 15, add_to_cart: true, cart_id: 3 }), call("click", { id: 1 }), call("click", { id: 2 }), call("click", { id: 3 }), answer("ok")],
    decide: (c) => (c.title.startsWith("Watch this page") ? "yes" : "no"),
  });
  await run();
  assert.deepEqual(ui.cards.slice(1).map((c) => c.title), ["Click “Buy now”?", "Click “Add to cart and checkout”?", "Click “Add to cart”?"]);
  assert.equal(web.log.filter(([op]) => op === "click").length, 0);
});

test("before the change, Add to cart still asks", async () => {
  const { run, ui } = setup({
    start: ITEM,
    sites: { [ITEM]: { title: "Kettle", text: OUT, elements: cart } },
    replies: [call("click", { id: 1 }), answer("ok")],
  });
  await run();
  assert.equal(ui.cards[0].title, "Click “Add to cart”?");
});

test("a pre-approved Add to cart that sends to checkout asks; one that lands there stops the agent", async () => {
  const toCheckout = { 1: { ...cart[1], isSubmit: true, inForm: true, formMethod: "post", action: CHECKOUT } };
  const first = setup({
    start: ITEM,
    sites: { [ITEM]: liveRestocking(toCheckout) },
    replies: [call("watch", { gone: "Out of stock", every: 15, add_to_cart: true, cart_id: 1 }), call("click", { id: 1 }), answer("ok")],
    decide: (c) => (c.title.startsWith("Watch this page") ? "yes" : "no"),
  });
  await first.run();
  assert.equal(first.ui.cards.length, 2, "the form sends to checkout, so the click is asked about");

  const lands = { 1: { ...cart[1], onClick: (tab, web) => web.navigate(tab, CHECKOUT) } };
  const second = setup({
    start: ITEM,
    sites: { [ITEM]: liveRestocking(lands), [CHECKOUT]: { title: "Checkout", text: "Pay now", elements: { 2: { kind: "button", label: "Pay now" } } } },
    replies: [call("watch", { gone: "Out of stock", every: 15, add_to_cart: true, cart_id: 1 }), call("click", { id: 1 }), call("click", { id: 2 }), answer("stopped")],
    decide: (c) => (c.title.startsWith("Watch this page") ? "yes" : "no"),
  });
  await second.run();
  assert.equal(second.ui.cards.length, 1);
  assert.match(results(second.agent)[1], /Stop here: the pre-approved Add to cart click led to https:\/\/shop\.example\/checkout/);
  assert.match(results(second.agent)[2], /Refused:.*checkout/);
  assert.equal(second.web.log.filter(([op]) => op === "click").length, 1, "a model ignoring the stop instruction cannot act again");
});

test("a watch still observes and reloads, but reloading requires fresh cart approval", async () => {
  const { run, ui, web, agent } = setup({
    start: ITEM,
    sites: { [ITEM]: restocking(cart) },
    replies: [call("watch", { gone: "Out of stock", every: 15, add_to_cart: true, cart_id: 1 }), call("click", { id: 1 }), answer("not added")],
    decide: (c) => c.title.startsWith("Watch this page") ? "yes" : "no",
  });
  await run();
  assert.equal(web.tabs.get(1).reloads, 1);
  assert.match(results(agent)[0], /The change happened[\s\S]*Adding to cart requires fresh approval/);
  assert.equal(ui.cards.at(-1).title, "Click “Add to cart”?");
  assert.equal(web.log.filter(([op]) => op === "click").length, 0);
});

for (const [name, options] of [
  ["another product on the same site", { change: (web) => web.navigate(web.tabs.get(1), "https://shop.example/item/99") }],
  ["another tab on the same URL", { change: (_web, agent) => { agent.focus = 2; } }],
  ["a new document at the same URL", { change: (web) => web.navigate(web.tabs.get(1), ITEM) }],
  ["a hash-routed product", { change: (web) => { web.tabs.get(1).url = `${ITEM}#product-99`; } }],
  ["a sibling Add to cart button", { id: 2, change: () => {} }],
  ["a changed product or quantity on the same DOM button", { change: (web) => { web.tabs.get(1).doc.elements[1].cartContext = "Red toaster|sku=99|quantity=8"; } }],
  ["a changed form destination", { change: (web) => { web.tabs.get(1).doc.elements[1].action = "https://shop.example/cart/add?sku=99"; } }],
]) {
  test(`a bound cart approval cannot be reused for ${name}`, async () => {
    const elements = { ...cart, 2: { ...cart[1] } };
    const spec = liveRestocking(elements);
    const h = setup({
      start: ITEM,
      userTabs: [ITEM],
      sites: { [ITEM]: spec, "https://shop.example/item/99": { title: "Toaster", text: IN, elements } },
      replies: [
        call("watch", { gone: "Out of stock", every: 15, add_to_cart: true, cart_id: 1 }),
        () => { options.change(h.web, h.agent); return call("read_page"); },
        call("click", { id: options.id || 1 }),
        answer("not added"),
      ],
      decide: (c) => c.title.startsWith("Watch this page") ? "yes" : "no",
    });
    await h.run();
    assert.equal(h.ui.cards.at(-1).title, "Click “Add to cart”?");
    assert.equal(h.web.log.filter(([op]) => op === "click").length, 0);
  assert.equal(h.ui.cards.at(-1).title, "Click “Add to cart”?");
  });
}

test("a literal stock condition is checked again immediately before consuming the cart approval", async () => {
  const spec = liveRestocking();
  const h = setup({
    start: ITEM,
    sites: { [ITEM]: spec },
    replies: [
      call("watch", { gone: "Out of stock", every: 15, add_to_cart: true, cart_id: 1 }),
      () => { spec.onWait = undefined; spec.text = OUT; return call("click", { id: 1 }); },
      answer("not added"),
    ],
    decide: (c) => c.title.startsWith("Watch this page") ? "yes" : "no",
  });
  await h.run();
  assert.equal(h.agent.cartGrant, null);
  assert.equal(h.web.log.filter(([op]) => op === "click").length, 0);
});

for (const target of ["omitted", "absent", "missing-context"]) {
  test(`an ${target} initial cart target cannot pre-authorize a later Add to cart button`, async () => {
    const spec = liveRestocking(target === "absent" ? {} : target === "missing-context" ? { 1: { kind: "button", label: "Add to cart" } } : cart);
    const onWait = spec.onWait;
    spec.onWait = (tab) => {
      onWait();
      if (spec.text === IN && target === "absent") {
        tab.doc.elements[1] = { ...cart[1] };
        spec.elements = cart;
      }
    };
    const { run, ui, web, agent } = setup({
      start: ITEM,
      sites: { [ITEM]: spec },
      replies: [call("watch", { gone: "Out of stock", every: 15, add_to_cart: true, ...(target === "omitted" ? {} : { cart_id: 1 }) }), call("click", { id: 1 }), answer("not added")],
      decide: (c) => c.title.startsWith("Watch this page") ? "yes" : "no",
    });
    await run();
    assert.match(ui.cards[0].detail, /fresh click approval/);
    assert.match(results(agent)[0], /Adding to cart requires fresh approval/);
    assert.equal(ui.cards.at(-1).title, "Click “Add to cart”?");
    assert.equal(web.log.filter(([op]) => op === "click").length, 0);
  });
}

test("an overconfident false decision-model condition never authorizes adding to cart", async () => {
  const h = setup({
    start: ITEM,
    sites: { [ITEM]: liveRestocking() },
    settings: { decisionModel: "decision" },
    replies: [call("watch", { condition: "the kettle costs under $1", every: 15, add_to_cart: true, cart_id: 1 }), call("click", { id: 1 }), answer("not added")],
    decide: (c) => c.title.startsWith("Watch this page") ? "yes" : "no",
  });
  let decisions = 0;
  h.model.decide = async () => ++decisions === 1 ? "no" : "yes";
  await h.run();
  assert.match(results(h.agent)[0], /The change happened[\s\S]*Adding to cart requires fresh approval/);
  assert.equal(h.ui.cards.at(-1).title, "Click “Add to cart”?");
  assert.equal(h.web.log.filter(([op]) => op === "click").length, 0);
});

test("an ambiguous decision model stays watching until timeout without notifying or authorizing cart", async () => {
  const h = setup({
    start: ITEM,
    sites: { [ITEM]: { title: "Kettle", text: OUT, elements: cart } },
    settings: { decisionModel: "decision" },
    replies: [call("watch", { condition: "the kettle costs under $1", every: 15, minutes: 1, add_to_cart: true, cart_id: 1 }), call("click", { id: 1 }), answer("not added")],
    decide: (c) => c.title.startsWith("Watch this page") ? "yes" : "no",
  });
  h.model.decide = async () => "unknown";
  h.web.granted.add("notifications");
  await h.run();
  assert.match(results(h.agent)[0], /^Stopped watching after 1 min/);
  assert.equal(h.web.notifications.length, 0);
  assert.equal(h.agent.cartGrant, null);
  assert.equal(h.web.log.filter(([op]) => op === "click").length, 0);
});

test("a decision that arrives after the watch deadline is not reported as success", async () => {
  const h = setup({
    start: ITEM,
    sites: { [ITEM]: liveRestocking() },
    settings: { decisionModel: "decision" },
    replies: [call("watch", { condition: "the price is under $1", minutes: 1, add_to_cart: true, cart_id: 1 }), call("click", { id: 1 }), answer("not added")],
    decide: (c) => c.title.startsWith("Watch this page") ? "yes" : "no",
  });
  let decisions = 0;
  h.model.decide = async () => {
    if (++decisions === 1) return "no";
    const clock = h.ctx.$("Date");
    const afterDeadline = clock.now() + 120000;
    clock.now = () => afterDeadline;
    return "yes";
  };
  h.web.granted.add("notifications");
  await h.run();
  assert.match(results(h.agent)[0], /^Stopped watching after 1 min/);
  assert.equal(h.web.notifications.length, 0);
  assert.equal(h.web.log.filter(([op]) => op === "click").length, 0);
});

for (const action of ["reload", "switch_tab", "watch"]) {
  test(`${action} cancels a pending cart approval`, async () => {
    const h = setup({
      start: ITEM,
      userTabs: [ITEM],
      sites: { [ITEM]: liveRestocking() },
      replies: [
        call("watch", { gone: "Out of stock", add_to_cart: true, cart_id: 1 }),
        call(action, action === "switch_tab" ? { tab_id: 2 } : action === "watch" ? { text: "In stock" } : {}),
        call("click", { id: 1 }),
        answer("not added"),
      ],
      decide: (c) => c.title.startsWith("Watch this page") ? "yes" : "no",
    });
    await h.run();
    assert.equal(h.ui.cards.at(-1).title, "Click “Add to cart”?");
    assert.equal(h.web.log.filter(([op]) => op === "click").length, 0);
  });
}

test("cart approval expires even when the exact target is unchanged", async () => {
  const h = setup({
    start: ITEM,
    sites: { [ITEM]: liveRestocking() },
    replies: [
      call("watch", { gone: "Out of stock", add_to_cart: true, cart_id: 1 }),
      () => {
        const clock = h.ctx.$("Date");
        const expired = clock.now() + 61000;
        clock.now = () => expired;
        return call("click", { id: 1 });
      },
      answer("not added"),
    ],
    decide: (c) => c.title.startsWith("Watch this page") ? "yes" : "no",
  });
  await h.run();
  assert.equal(h.ui.cards.at(-1).title, "Click “Add to cart”?");
  assert.equal(h.web.log.filter(([op]) => op === "click").length, 0);
});

for (const ending of ["finish", "stop"]) {
  test(`${ending} clears the pending cart approval even when tabs are kept`, async () => {
    const h = setup({
      start: ITEM,
      sites: { [ITEM]: liveRestocking() },
      settings: { closeAgentTabs: false },
      replies: [
        call("watch", { gone: "Out of stock", add_to_cart: true, cart_id: 1 }),
        () => {
          assert.ok(h.agent.cartGrant, "the unchanged literal watch armed exactly one target");
          if (ending === "stop") h.agent.stop();
          return answer("done");
        },
      ],
      decide: () => "yes",
    });
    if (ending === "stop") await assert.rejects(h.run(), /Stopped/);
    else await h.run();
    assert.equal(h.agent.cartGrant, null);
    assert.equal(h.web.log.filter(([op]) => op === "click").length, 0);
  });
}
