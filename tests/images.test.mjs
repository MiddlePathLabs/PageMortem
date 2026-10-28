import test from "node:test";
import assert from "node:assert/strict";
import { setup, load, AGENT_FILES, call, answer, results } from "./harness.mjs";

const GALLERY = "https://gallery.example/cats";
const img = (name, extra = {}) => ({ src: `https://cdn.gallery.example/${name}.jpg`, alt: name, ...extra });
// Three screenfuls; "k-" images show the thing asked for.
const SCREENS = [
  [img("k-1"), img("dog-1"), img("k-2")],
  [img("cat-sleeping"), img("k-3"), img("k-1") /* same image repeated further down */],
  [img("bird"), { src: "data:image/png;base64,AAAA" }, { src: "blob:https://gallery.example/x" }],
];

/** Sets up an agent on the gallery whose vision checks answer from the image's name. */
function gallery({ screens = SCREENS, replies, decide = () => "yes", settings, granted = true } = {}) {
  const t = setup({ start: GALLERY, sites: { [GALLERY]: { title: "Cats", text: "a gallery", screens } }, replies, decide, settings });
  if (!granted) t.web.granted.clear();
  // Screenshots and crops need a real canvas; stand in a crop that says which image it is.
  t.ctx.processShot = async (raw, { crop }) => `data:crop/${crop.rect.y}/${crop.rect.x / 100}`;
  t.ctx.decodeShot = async (raw) => raw;
  const checks = [];
  const nameOf = (url) => {
    const [, screen, k] = /crop\/(\d+)\/(\d+)/.exec(url);
    return screens[screen][k].alt;
  };
  // The agent's own model replies come from `replies`; image checks are answered here.
  const chat = t.model.chat;
  t.model.chat = async (req) => {
    const part = Array.isArray(req.messages.at(-1).content) && req.messages.at(-1).content.find((c) => c.type === "image_url");
    if (part && /Does this image show/.test(req.messages.at(-1).content[0].text)) {
      const name = nameOf(part.image_url.url);
      checks.push(name);
      return { content: name.startsWith("k-") ? "Yes." : "No", toolCalls: [], stats: null };
    }
    return chat(req);
  };
  return { ...t, checks };
}

const saved = (web) => web.downloads.map((d) => d.filename);

test("saves only the images the model says match, into a folder named after the request", async () => {
  const { run, web, ui, checks, agent } = gallery({
    replies: [call("save_images", { match: "kittens chasing lasers" }), answer("done")],
  });
  await run();
  assert.equal(ui.cards.length, 1);
  assert.match(ui.cards[0].title, /Save images of “kittens chasing lasers” from gallery\.example\?/);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.cards[0].permissions)), ["downloads"]);
  assert.deepEqual(saved(web), [
    "PageMortem/kittens-chasing-lasers/001-k-1.jpg",
    "PageMortem/kittens-chasing-lasers/002-k-2.jpg",
    "PageMortem/kittens-chasing-lasers/003-k-3.jpg",
  ]);
  assert.equal(checks.filter((c) => c === "k-1").length, 1, "a repeated image is checked once");
  assert.ok(!checks.includes(undefined));
  assert.equal(web.downloads.filter((d) => /^(data|blob):/.test(d.url)).length, 0, "data:/blob: images are never downloaded");
  assert.ok(web.downloads.every((d) => d.saveAs === false && d.conflictAction === "uniquify"));
  assert.deepEqual(JSON.parse(JSON.stringify(web.downloads[0].headers)), [{ name: "Referer", value: "https://gallery.example/" }], "only the origin, never the path or query");
  assert.match(results(agent)[0], /Checked 6 images on gallery\.example; 3 matched “kittens chasing lasers”\. Saved 3 into Downloads\/PageMortem\/kittens-chasing-lasers\//);
});

test("an empty description saves every image without asking the model", async () => {
  const { run, web, checks } = gallery({ replies: [call("save_images", {}), answer("done")] });
  await run();
  assert.equal(checks.length, 0);
  assert.equal(web.downloads.length, 6);
  assert.match(saved(web)[0], /^PageMortem\/images-gallery-example\/001-k-1\.jpg$/);
});

test("stops at the requested maximum", async () => {
  const { run, web } = gallery({ replies: [call("save_images", { match: "kittens", max: 2 }), answer("done")] });
  await run();
  assert.equal(web.downloads.length, 2);
});

test("denying the card saves nothing", async () => {
  const { run, web, checks } = gallery({ replies: [call("save_images", { match: "kittens" }), answer("done")], decide: () => "no" });
  await run();
  assert.equal(web.downloads.length, 0);
  assert.equal(checks.length, 0);
});

test("without Firefox's download permission nothing is saved", async () => {
  const { run, web, agent } = gallery({ replies: [call("save_images", { match: "kittens" }), answer("done")], granted: false });
  await run();
  assert.equal(web.downloads.length, 0);
  assert.match(results(agent)[0], /permission to download files wasn't granted/);
});

test("a download that turns out not to be an image is deleted", async () => {
  const { run, web, agent } = gallery({ replies: [call("save_images", { match: "kittens" }), answer("done")] });
  web.mimeFor = (url) => (url.includes("k-2") ? "text/html" : "image/jpeg");
  await run();
  const bad = web.downloads.find((d) => d.url.includes("k-2"));
  assert.equal(bad.removed, true);
  assert.match(results(agent)[0], /Saved 2 .*1 weren't image files and were removed/);
});

test("“allow” for one save covers later saves on the same site in the task, not other sites", async () => {
  const { run, ui } = gallery({
    replies: [call("save_images", { match: "kittens", max: 1 }), call("save_images", { match: "kittens", max: 1 }), answer("done")],
    decide: (c) => (c.allowAll ? "all" : "no"),
  });
  await run();
  assert.equal(ui.cards.length, 1);
  assert.match(ui.cards[0].allowAll, /Allow saving images from gallery\.example for this task/);
});

test("Stop during the image checks cancels downloads in progress and saves nothing more", async () => {
  const t = gallery({ replies: [call("save_images", { match: "kittens" })] });
  let n = 0;
  const realDownload = t.web.browser; // keep the fake; mark downloads unfinished so they can be cancelled
  t.web.mimeFor = () => "image/jpeg";
  const origChat = t.model.chat;
  t.model.chat = async (req) => {
    const r = await origChat(req);
    if (++n === 3) t.agent.stop(); // stop after the second image check
    return r;
  };
  await assert.rejects(t.run(), /Stopped/);
  assert.ok(t.web.downloads.length <= 1, `saved ${t.web.downloads.length}`);
  assert.ok(t.web.downloads.every((d) => d.cancelled), "anything started was cancelled");
  void realDownload;
});

test("the current page must still be on an approved site", async () => {
  const { run, web, agent } = gallery({
    replies: [
      () => {
        web.navigate(web.tabs.get(1), "https://elsewhere.example/");
        return call("save_images", { match: "kittens" });
      },
      answer("done"),
    ],
    decide: () => "no",
  });
  await run();
  assert.equal(web.downloads.length, 0);
  assert.match(results(agent)[0], /outside the sites approved/);
});

// ---------- helpers ----------
test("folder and file names are safe and ordered", () => {
  const ctx = load(AGENT_FILES, { browser: {} });
  assert.equal(ctx.slugify("Kittens chasing LASERS!! 🐱"), "kittens-chasing-lasers");
  assert.equal(ctx.slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(ctx.imageFileName("https://x.example/a/My%20Cat.PNG?w=200", 7), "007-My_Cat.PNG");
  assert.equal(ctx.imageFileName("https://x.example/img?id=5", 12), "012-img.jpg");
  assert.equal(ctx.imageFileName("https://x.example/", 1), "001-image.jpg");
  assert.equal(ctx.imageFileName("https://x.example/..%2F..%2Fevil.exe", 2), "002-evil.exe.jpg");
});

test("yes/no answers are read conservatively", () => {
  const { parseYesNo } = load(AGENT_FILES, { browser: {} });
  for (const t of ["yes", "Yes.", "**Yes** – a kitten chasing a red dot", "<think>hmm no idea</think>yes"]) assert.equal(parseYesNo(t), true, t);
  for (const t of ["no", "No.", "Not really", "I'm not sure", "", "yes and no"]) assert.equal(parseYesNo(t), false, t);
});

test("a best source on another site is ignored in favour of the image actually displayed", async () => {
  const screens = [[
    img("k-1", { src: "https://tracker.example/k-1.jpg", shown: "https://cdn.gallery.example/k-1-small.jpg" }), // linked file elsewhere
    img("k-2", { src: "https://cdn.gallery.example/k-2-large.jpg", shown: "https://cdn.gallery.example/k-2.jpg" }), // own site: kept
    img("k-3", { src: "https://other.example/k-3.jpg", shown: "https://other.example/k-3-small.jpg" }), // the host it's shown from
    img("k-4", { src: "https://tracker.example/k-4.jpg" }), // nothing displayed to fall back to
  ]];
  const { run, web } = gallery({ screens, replies: [call("save_images", { match: "kittens" }), answer("done")] });
  await run();
  assert.deepEqual(web.downloads.map((d) => d.url), [
    "https://cdn.gallery.example/k-1-small.jpg",
    "https://cdn.gallery.example/k-2-large.jpg",
    "https://other.example/k-3.jpg",
  ]);
});

test("finished downloads with no type or an SVG type are deleted, not kept as images", async () => {
  const { run, web, agent } = gallery({ replies: [call("save_images", { match: "kittens" }), answer("done")] });
  web.mimeFor = (url) => (url.includes("k-1") ? "" : url.includes("k-2") ? "image/svg+xml" : "image/png");
  await run();
  assert.equal(web.downloads.find((d) => d.url.includes("k-1")).removed, true, "missing type");
  assert.equal(web.downloads.find((d) => d.url.includes("k-2")).removed, true, "SVG");
  assert.equal(web.downloads.find((d) => d.url.includes("k-3")).removed, undefined);
  assert.match(results(agent)[0], /Saved 1 .*2 weren't image files and were removed/);
});

test("downloads still running at the deadline are cancelled unless they already report a raster image type", async () => {
  const downloads = [];
  const ctx = load(AGENT_FILES, {
    browser: {
      runtime: { getManifest: () => ({}) },
      downloads: {
        download: async (o) => downloads.push({ ...o, id: downloads.length + 1, state: "in_progress", mime: o.url.includes("svg") ? "image/svg+xml" : o.url.includes("slow") ? "" : "image/jpeg" }),
        search: async ({ id }) => downloads.filter((d) => d.id === id).map((d) => ({ ...d })),
        cancel: async (id) => void (downloads[id - 1].cancelled = true),
        removeFile: async () => {},
        erase: async () => [],
      },
    },
  });
  const saver = new (ctx.$("ImageSaver"))({ folder: "PageMortem/x" });
  for (const u of ["https://a.example/slow", "https://a.example/pic.svg", "https://a.example/big.jpg"]) await saver.save(u);
  const r = await saver.settle(50);
  assert.deepEqual({ ...r }, { saved: 0, failed: 0, notImage: 2, pending: 1 });
  assert.deepEqual(downloads.map((d) => !!d.cancelled), [true, true, false]);
});

test("with a decision model set, images are checked by it, not by a chat request", async () => {
  const t = gallery({ replies: [call("save_images", { match: "kittens chasing lasers" }), answer("done")], settings: { decisionModel: "d3-lite" } });
  const asked = [];
  t.model.decideImage = async ({ question, image, model }) => {
    asked.push({ question, model });
    const [, screen, k] = /crop\/(\d+)\/(\d+)/.exec(image);
    return SCREENS[screen][k].alt.startsWith("k-") ? 0.97 : 0.02;
  };
  await t.run();
  assert.equal(t.checks.length, 0, "no chat request judged an image");
  assert.equal(asked.length, 6);
  assert.equal(asked[0].model, "d3-lite");
  assert.match(asked[0].question, /Does this image show: kittens chasing lasers\?/);
  assert.equal(saved(t.web).length, 3);
});

test("if the decision model can't take images, the run falls back to the vision model once", async () => {
  const t = gallery({ replies: [call("save_images", { match: "kittens chasing lasers" }), answer("done")], settings: { decisionModel: "decider-0.8b" } });
  let tries = 0;
  t.model.decideImage = async () => {
    tries++;
    throw new Error("Server returned 400. decider-0.8b takes no images here");
  };
  await t.run();
  assert.ok(tries >= 1 && tries <= 2, "it stops asking after the first failure (two may already be in flight)");
  assert.equal(t.checks.length, 6);
  assert.equal(saved(t.web).length, 3);
  assert.equal(t.ui.steps.filter((s) => /couldn't check images/.test(s.text)).length, 1);
});

test("only clear decision-model scores count; unsure ones go to the vision model", async () => {
  const t = gallery({ replies: [call("save_images", { match: "kittens chasing lasers" }), answer("done")], settings: { decisionModel: "d3-lite", visionModel: "qwen3-vl" } });
  // k-1 and dog-1 get unsure scores; the rest are clear.
  const scores = { "k-1": 0.6, "dog-1": 0.4, "k-2": 0.95, "k-3": 0.99, "cat-sleeping": 0.03, bird: 0.01 };
  t.model.decideImage = async ({ image }) => {
    const [, screen, k] = /crop\/(\d+)\/(\d+)/.exec(image);
    return scores[SCREENS[screen][k].alt];
  };
  await t.run();
  assert.deepEqual([...t.checks].sort(), ["dog-1", "k-1"], "the vision model saw only the unsure two");
  assert.equal(saved(t.web).length, 3);
  assert.match(results(t.agent)[0], /d3-lite decided 4; 2 it was unsure about went to qwen3-vl\./);
  assert.ok(t.ui.steps.some((s) => /Checking images with d3-lite; ones it is unsure about go to qwen3-vl/.test(s.text)));
});

test("precise sends every image to the vision model, skipping the decision model", async () => {
  const t = gallery({ replies: [call("save_images", { match: "Obama", precise: true }), answer("done")], settings: { decisionModel: "d3-lite", visionModel: "qwen3-vl" } });
  t.model.decideImage = async () => assert.fail("the decision model must not judge a precise match");
  await t.run();
  assert.equal(t.checks.length, 6);
  assert.match(results(t.agent)[0], /qwen3-vl checked 6\./);
  assert.ok(t.ui.steps.some((s) => /Checking images with qwen3-vl \(needs knowledge, not just looking\)/.test(s.text)));
});

test("a vision model that won't identify people counts as no, and the agent is told why", async () => {
  const t = gallery({ replies: [call("save_images", { match: "Obama", precise: true }), answer("done")], settings: { visionModel: "qwen3-vl" } });
  const chat = t.model.chat;
  t.model.chat = async (req) => {
    const last = req.messages.at(-1).content;
    if (Array.isArray(last) && /Does this image show/.test(last[0].text)) return { content: "I can't identify real people from their faces.", toolCalls: [], stats: null };
    return chat(req);
  };
  await t.run();
  assert.equal(saved(t.web).length, 0);
  assert.match(results(t.agent)[0], /qwen3-vl declined to say who is shown in 6 images, so those count as no match/);
});
