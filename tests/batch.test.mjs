import test from "node:test";
import assert from "node:assert/strict";
import { setup, call, answer, results } from "./harness.mjs";

const PAGE = "https://workflows.example/list/";
const dl = (label, extra = {}) => ({ kind: "button", tag: "BUTTON", label, ...extra });
const site = (elements) => ({ [PAGE]: { title: "Workflows", text: "45 workflows", elements } });
const clicked = (web) => web.log.filter(([op]) => op === "click").map(([, , a]) => a.id);

test("click_each asks once for the whole list and clicks every item", async () => {
  const t = setup({
    start: PAGE,
    sites: site({ 1: dl("Download Alpha"), 2: dl("Download Beta"), 3: dl("Download Gamma") }),
    replies: [call("click_each", { ids: [1, 2, 3] }), answer("done")],
    decide: () => ({ answer: "yes", picked: [1, 2, 3] }),
  });
  await t.run();
  assert.equal(t.ui.cards.length, 1);
  assert.equal(t.ui.cards[0].title, "Download 3 files on workflows.example?");
  assert.deepEqual([...t.ui.cards[0].items.map((i) => i.id)], [1, 2, 3]);
  assert.deepEqual(clicked(t.web), [1, 2, 3]);
  assert.ok(t.ui.steps.some((s) => s.text === "Started 3 of 3 downloads"));
  assert.match(results(t.agent)[0], /Clicked 3 of 3/);
});

test("unticked items aren't clicked, and the card can't add items it wasn't given", async () => {
  const t = setup({
    start: PAGE,
    sites: site({ 1: dl("Download Alpha"), 2: dl("Download Beta"), 3: dl("Download Gamma"), 9: dl("Delete everything") }),
    replies: [call("click_each", { ids: [1, 2, 3] }), answer("done")],
    decide: () => ({ answer: "yes", picked: [1, 3, 9] }),
  });
  await t.run();
  assert.deepEqual(clicked(t.web), [1, 3]);
  assert.match(results(t.agent)[0], /unticked 1/);
});

test("click_each leaves out forms, other pages and actions that need their own approval", async () => {
  const t = setup({
    start: PAGE,
    sites: site({
      1: dl("Download Alpha"),
      2: dl("Download Beta"),
      3: { kind: "link", tag: "A", label: "Details", href: "https://workflows.example/details" },
      4: dl("Delete"),
      5: dl("Download", { isSubmit: true, inForm: true, formMethod: "post" }),
      6: { kind: "link", tag: "A", label: "Get zip", href: "https://workflows.example/all.zip" },
    }),
    replies: [call("click_each", { ids: [1, 2, 3, 4, 5, 6] }), answer("done")],
    decide: () => ({ answer: "yes", picked: [1, 2, 3, 4, 5, 6] }),
  });
  await t.run();
  assert.deepEqual([...t.ui.cards[0].items.map((i) => i.id)], [1, 2, 6]);
  assert.deepEqual(clicked(t.web), [1, 2, 6]);
  const text = results(t.agent)[0];
  assert.match(text, /\[3\] opens another page/);
  assert.match(text, /\[4\] needs its own approval/);
  assert.match(text, /\[5\] is part of a form/);
});

test("denying the list clicks nothing", async () => {
  const t = setup({
    start: PAGE,
    sites: site({ 1: dl("Download Alpha"), 2: dl("Download Beta") }),
    replies: [call("click_each", { ids: [1, 2] }), answer("done")],
    decide: () => ({ answer: "no", picked: [] }),
  });
  await t.run();
  assert.deepEqual(clicked(t.web), []);
  assert.match(results(t.agent)[0], /denied/);
});

test("a click that leaves the page stops the run", async () => {
  const t = setup({
    start: PAGE,
    sites: {
      ...site({ 1: dl("Show more", { onClick: (tab, w) => w.navigate(tab, "https://workflows.example/other") }), 2: dl("Show more") }),
      "https://workflows.example/other": { title: "Other", text: "elsewhere" },
    },
    replies: [call("click_each", { ids: [1, 2] }), answer("done")],
    decide: () => ({ answer: "yes", picked: [1, 2] }),
  });
  await t.run();
  assert.deepEqual(clicked(t.web), [1]);
  assert.match(results(t.agent)[0], /1 approved item was not clicked/);
});

test("an item that changed after approval is skipped", async () => {
  const t = setup({
    start: PAGE,
    sites: site({ 1: dl("Download Alpha", { onClick: (tab) => void (tab.doc.elements[2].label = "Delete all") }), 2: dl("Download Beta") }),
    replies: [call("click_each", { ids: [1, 2] }), answer("done")],
    decide: () => ({ answer: "yes", picked: [1, 2] }),
  });
  await t.run();
  assert.deepEqual(clicked(t.web), [1]);
  assert.match(results(t.agent)[0], /\[2\] changed since approval/);
});

test("single download clicks say so, and repeated approvals point the model at click_each", async () => {
  const t = setup({
    start: PAGE,
    sites: site({ 1: dl("Download Alpha"), 2: dl("Download Beta"), 3: dl("Download Gamma") }),
    replies: [call("click", { id: 1 }), call("click", { id: 2 }), answer("done")],
    decide: () => "yes",
  });
  await t.run();
  assert.equal(t.ui.cards.length, 2);
  assert.match(t.ui.cards[0].detail, /downloads a file/);
  const [first, second] = results(t.agent);
  assert.doesNotMatch(first, /click_each/);
  assert.match(second, /click_each/);
});
