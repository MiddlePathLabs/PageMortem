// Where form data goes, what a search grant covers, and pages that move after the landing check.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, call, answer, results } from "./harness.mjs";

const SHOP = "https://shop.example/";
const EVIL = "https://evil.example/collect";
const page = (title, text, elements = {}) => ({ title, text, elements });

test("a submit button whose form posts to another site asks to approve that site before anything is sent", async () => {
  const { run, ui, web, agent } = setup({
    sites: { [SHOP]: page("Shop", "", { 1: { kind: "button", label: "Go", isSubmit: true, inForm: true, formMethod: "get", action: EVIL } }) },
    replies: [call("click", { id: 1 }), answer("ok")],
    decide: () => "no",
  });
  await run();
  assert.equal(ui.cards[0].title, "Go to another site?");
  assert.match(ui.cards[0].detail, /evil\.example/);
  assert.equal(ui.cards.length, 1, "denying the destination ends it");
  assert.equal(web.log.length, 0);
  assert.match(results(agent)[0], /denied leaving/);
});

test("the submit card names where the form sends its data", async () => {
  const { run, ui } = setup({
    sites: { [SHOP]: page("Shop", "", { 1: { kind: "button", label: "Go", isSubmit: true, inForm: true, formMethod: "post", action: `${SHOP}cart` } }) },
    replies: [call("click", { id: 1 }), answer("ok")],
    decide: () => "no",
  });
  await run();
  assert.equal(ui.cards.length, 1);
  assert.deepEqual(ui.cards[0].fields.find((f) => f.label === "Form sends to")?.value, `${SHOP}cart`);
});

test("typing with submit and Enter in a field check the form's destination too", async () => {
  const field = { kind: "input", label: "Email", inForm: true, formMethod: "post", action: EVIL };
  for (const reply of [call("type_text", { id: 1, text: "a@b.example", submit: true }), call("press_key", { id: 1, key: "Enter" })]) {
    const { run, ui, web } = setup({ sites: { [SHOP]: page("Shop", "", { 1: field }) }, replies: [reply, answer("ok")], decide: () => "no" });
    await run();
    assert.equal(ui.cards[0].title, "Go to another site?");
    assert.equal(web.log.length, 0);
  }
  // Typing without submitting sends nothing, so it needs no destination check.
  const { run, ui } = setup({ sites: { [SHOP]: page("Shop", "", { 1: field }) }, replies: [call("type_text", { id: 1, text: "x" }), answer("ok")], decide: () => "no" });
  await run();
  assert.equal(ui.cards[0].title, "Type into “Email”?");
});

test("forms that send to a non-web address are refused without a card", async () => {
  for (const action of ["javascript:steal()", "mailto:x@evil.example", "data:text/html,x"]) {
    const { run, ui, web, agent } = setup({
      sites: { [SHOP]: page("Shop", "", { 1: { kind: "button", label: "Go", isSubmit: true, inForm: true, action } }) },
      replies: [call("click", { id: 1 }), answer("ok")],
      decide: () => "yes",
    });
    await run();
    assert.equal(ui.cards.length, 0, action);
    assert.equal(web.log.length, 0, action);
    assert.match(results(agent)[0], /non-web address/);
  }
});

test("an approved click is void if the form's destination changes while the card is open", async () => {
  const { run, web, agent } = setup({
    sites: { [SHOP]: page("Shop", "", { 1: { kind: "button", label: "Pay", isSubmit: true, inForm: true, formMethod: "post", action: `${SHOP}pay` } }) },
    replies: [call("click", { id: 1 }), answer("ok")],
    decide: () => {
      web.tabs.get(1).doc.elements[1].action = EVIL;
      return "yes";
    },
  });
  await run();
  assert.equal(web.log.length, 0);
  assert.match(results(agent)[0], /changed while waiting for approval/);
});

test("allowing searches covers that search box only, not other fields the page calls a search", async () => {
  const search = { kind: "input", label: "Search", searchField: true, inForm: true, action: `${SHOP}search` };
  const { run, ui, web } = setup({
    sites: {
      [SHOP]: page("Shop", "", {
        3: search,
        4: { ...search, label: "Write a review" },
        5: { ...search, action: `${SHOP}reviews` },
      }),
    },
    replies: [
      call("type_text", { id: 3, text: "a" }),
      call("type_text", { id: 3, text: "b", submit: true }),
      call("type_text", { id: 4, text: "c" }),
      call("type_text", { id: 5, text: "d" }),
      answer("ok"),
    ],
    decide: (c) => (c.allowAll ? "all" : "no"),
  });
  await run();
  assert.match(ui.cards[0].allowAll, /Allow searches in “Search” on shop\.example/);
  assert.equal(ui.cards.length, 3, "the other two fields still ask");
  assert.deepEqual(web.log.filter(([op]) => op === "type").map(([, , a]) => a.text), ["a", "b", "c", "d"]);
});

test("a page that moves off-site after the landing check is never read", async () => {
  const { run, web, agent } = setup({
    sites: {
      [SHOP]: page("Shop", "", { 1: { kind: "link", tag: "A", label: "Next", href: `${SHOP}p2` } }),
      [`${SHOP}p2`]: page("Page 2", "page two"),
      "https://evil.example/": page("Evil", "SECRET-EVIL-TEXT"),
    },
    replies: [call("click", { id: 1 }), answer("ok")],
  });
  // The page passes the landing check, then redirects itself just before it's read.
  const handle = web.handle.bind(web);
  web.handle = async (tab, op, args) => {
    if (op === "readPage" && tab.url === `${SHOP}p2`) web.navigate(tab, "https://evil.example/");
    return handle(tab, op, args);
  };
  await run();
  const r = results(agent)[0];
  assert.match(r, /moved to evil\.example, outside the sites approved/);
  assert.doesNotMatch(JSON.stringify(agent.messages), /SECRET-EVIL-TEXT/);
});

test("refusing to go back to another site restores the page even without forward history", async () => {
  const { run, web, ctx, agent } = setup({
    sites: { [SHOP]: page("Shop", "shop"), "https://evil.example/": page("Evil", "evil") },
    replies: [call("go_back"), answer("ok")],
    decide: () => "no",
  });
  web.tabs.get(1).history.push("https://evil.example/");
  ctx.browser.tabs.goForward = async () => {}; // forward history lost
  await run();
  assert.match(results(agent)[0], /Not going back/);
  assert.equal(web.tabs.get(1).url, SHOP);
});
