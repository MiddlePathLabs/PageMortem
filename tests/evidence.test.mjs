import test from "node:test";
import assert from "node:assert/strict";
import { load, scriptedModel } from "./harness.mjs";

const PAGE = `Topaz SLP Manager
Queue multiple videos with output settings saved separately for each file. Drag videos into the queue.
Requirements
A 64-bit Windows system and an NVIDIA GPU suitable for your selected SLP workload.
FFmpeg and FFprobe, including the encoders you intend to use.
H.264, HEVC NVENC, AV1 software or NVENC, FFV1, ProRes and DNxHR are available.`;

const source = { tabId: 1, doc: "d", url: "https://a.example/", title: "A", text: PAGE };
const evidenceLib = () => load(["lib/evidence.js"]);

test("a paraphrased claim matches the page sentence it came from", () => {
  const ctx = evidenceLib();
  const evidence = new (ctx.$("Evidence"))([source]);
  const hit = evidence.match("It needs 64-bit Windows and an NVIDIA GPU.");
  assert.equal(hit.quote, "A 64-bit Windows system and an NVIDIA GPU suitable for your selected SLP workload.");
  assert.ok(hit.score >= ctx.$("STRONG_MATCH"));
  assert.equal(evidence.match("Output codecs include ProRes and DNxHR.").quote.startsWith("H.264, HEVC NVENC"), true);
});

test("a claim the page doesn't support scores weakly", () => {
  const ctx = evidenceLib();
  const evidence = new (ctx.$("Evidence"))([source]);
  const hit = evidence.match("The project was founded in Berlin by three students.");
  assert.ok(!hit || hit.score < ctx.$("WEAK_MATCH"));
});

test("sentences never span lines, so every quote is contiguous on the page", () => {
  const ctx = evidenceLib();
  const sentences = ctx.pageSentences("Short\nFirst sentence here. Second sentence here.\n" + "word ".repeat(200));
  assert.deepEqual(Array.from(sentences.slice(0, 2), (s) => s.text), ["First sentence here.", "Second sentence here."]);
  assert.equal(sentences[0].line, sentences[1].line);
  assert.ok(sentences.length > 4);
  for (const s of sentences) assert.ok(s.text.length <= 300);
});

test("the model fallback keeps only quotes that appear verbatim in the page", async () => {
  const ctx = evidenceLib();
  const evidence = new (ctx.$("Evidence"))([source]);
  const llm = scriptedModel([{ content: 'Here: [{"n":1,"quote":"FFmpeg and FFprobe, including the encoders you intend to use."},{"n":2,"quote":"Runs on macOS."},{"n":3,"quote":""}]' }]);
  const found = await ctx.modelEvidence({ claims: ["You need FFmpeg tools.", "It runs on Macs.", "It is free."], evidence, llm });
  assert.equal(found[0].quote, "FFmpeg and FFprobe, including the encoders you intend to use.");
  assert.equal(found[0].source.url, "https://a.example/");
  assert.equal(found[1], null);
  assert.equal(found[2], null);
  assert.match(llm.calls[0].messages[1].content, /<claim n="1">You need FFmpeg tools\.<\/claim>/);
});

test("an unparseable model reply finds nothing rather than failing", async () => {
  const ctx = evidenceLib();
  const evidence = new (ctx.$("Evidence"))([source]);
  const found = await ctx.modelEvidence({ claims: ["x y z"], evidence, llm: scriptedModel([{ content: "no idea" }]) });
  assert.deepEqual(Array.from(found), [null]);
});
