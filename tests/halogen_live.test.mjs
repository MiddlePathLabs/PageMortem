// Optional checks against a running Halogen server. Only synthetic text and pixels leave this machine.
// PAGEMORTEM_HALOGEN_ENDPOINT=http://192.168.1.50:8731/v1 npm run test:halogen
// The extension client is real; browser APIs are supplied by the test harness.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { load, SETTINGS } from "./harness.mjs";

const endpoint = process.env.PAGEMORTEM_HALOGEN_ENDPOINT;
const opts = { skip: !endpoint && "set PAGEMORTEM_HALOGEN_ENDPOINT to run", timeout: 120000 };
const origin = endpoint ? new URL(endpoint).origin : "http://127.0.0.1";
const browser = { runtime: { getManifest: () => ({ content_security_policy: { extension_pages: `connect-src ${origin};` } }) } };
const ctx = load(["lib/settings.js", "lib/llm.js"], { browser, fetch, Response });
const LLM = ctx.$("LLM");
const client = (settings = {}) => new LLM({ ...SETTINGS, endpoint, requestTimeout: 60000, ...settings });

// A 64×32 PNG with a red left half and a blue right half, built without browser canvas or extra packages.
function splitColorPng() {
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const result = Buffer.alloc(payload.length + 8);
    result.writeUInt32BE(data.length);
    payload.copy(result, 4);
    result.writeUInt32BE(crc(payload), payload.length + 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8; // 8-bit RGB
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 64 }, (_, x) => x < 32 ? [255, 0, 0] : [0, 0, 255]).flat())]);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(32).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

test("Halogen lists the expected decision and reranking capabilities", opts, async () => {
  const models = await client().models();
  for (const name of ["d3-lite", "d3-nano", "qwen3-reranker-0.6b"]) assert.ok(models.includes(name), `missing ${name}`);
});

for (const model of ["d3-lite", "d3-nano"]) {
  test(`${model} serves decisive text through System One`, opts, async () => {
    const llm = client({ decisionEndpoint: endpoint, decisionApi: "systemone", decisionModel: model });
    assert.equal(await llm.decide({ question: "Is the door open?", text: "The door is wide open." }), "yes");
    assert.equal(await llm.decide({ question: "Is the door open?", text: "The door is firmly closed and locked." }), "no");
  });

  test(`${model} serves image probabilities through System One`, opts, async () => {
    const llm = client({ decisionEndpoint: endpoint, decisionApi: "systemone", decisionModel: model });
    const image = splitColorPng();
    assert.ok(await llm.decideImage({ question: "Is the left half of this image red?", image }) >= 0.85);
    assert.ok(await llm.decideImage({ question: "Is the left half of this image green?", image }) <= 0.15);
  });
}

test("Halogen reranker returns a complete ranking in document order", opts, async () => {
  const scores = await client({ rerankEndpoint: endpoint, rerankModel: "qwen3-reranker-0.6b" }).rerank({
    query: "Which passage says the door is open?",
    documents: ["The door is closed.", "The door is open.", "The window is open."],
  });
  assert.equal(scores.length, 3);
  assert.equal(scores.indexOf(Math.max(...scores)), 1);
});

test("watch diagnostic reports uncertain D3 answers without treating them as yes", opts, async () => {
  const cases = [
    ["The clock shows 11:49:00 PM or later.", "11:47:52 PM\nCoordinated Universal Time", "no"],
    ["The clock shows 11:49:00 PM or later.", "11:52:03 PM\nCoordinated Universal Time", "yes"],
    ["The price is below $50.", "Acme Kettle\nPrice: $54.99\nIn stock", "no"],
    ["The item is back in stock.", "Acme Kettle\n$54.99\nOnly 3 left - order soon\nAdd to cart", "yes"],
  ];
  for (const model of ["d3-lite", "d3-nano"]) {
    const llm = client({ decisionEndpoint: endpoint, decisionApi: "systemone", decisionModel: model });
    const results = [];
    for (const [question, text, expected] of cases) {
      let probability;
      const answer = await llm.decide({
        question: `Does this web page show that the following is true now? ${question}`,
        text,
        onStats: (s) => { probability = s.probability; },
      });
      assert.ok(["yes", "no", "unknown"].includes(answer));
      results.push({ expected, answer, probability });
    }
    console.log(`${model} watch diagnostic: ${JSON.stringify(results)}`);
  }
});
