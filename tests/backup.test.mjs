import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

const plain = (v) => JSON.parse(JSON.stringify(v));
const FILES = ["lib/settings.js", "lib/skills.js", "lib/backup.js"];

function memoryStorage(data = {}) {
  const pick = (keys) => Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]]));
  return { data, browser: { storage: { local: {
    get: async (keys) => structuredClone(pick(keys)),
    set: async (obj) => { Object.assign(data, structuredClone(obj)); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  } } } };
}

const note = { name: "notes", description: "", kind: "agent", needs: "none", output: "markdown", body: "Note quotes." };
const caption = { name: "caption", description: "", kind: "prompt", needs: "image", output: "raw", body: "Caption it." };

test("a backup restores settings and skills into an empty install", async () => {
  const from = memoryStorage();
  const old = load(FILES, { browser: from.browser });
  await old.saveSettings({ endpoint: "http://10.0.0.5:8080/v1", apiKey: "k", maxSteps: 30, thinkingLevels: ["off", "high"] });
  await old.putSkill(note);
  await old.putSkill(caption);
  const text = JSON.stringify(await old.makeBackup());

  const to = memoryStorage();
  const fresh = load(FILES, { browser: to.browser });
  const parsed = fresh.parseBackup(text);
  assert.equal(parsed.error, undefined);
  const restored = await fresh.restoreBackup(parsed);
  assert.equal(restored.restored, 2);
  const settings = await fresh.loadSettings();
  assert.equal(settings.endpoint, "http://10.0.0.5:8080/v1");
  assert.equal(settings.apiKey, "k");
  assert.equal(settings.maxSteps, 30);
  assert.deepEqual(plain(settings.thinkingLevels), ["off", "high"]);
  assert.deepEqual(plain((await fresh.loadSkills()).map((s) => s.name)), ["notes", "caption"]);
});

test("importing keeps other saved skills and replaces ones with the same name", async () => {
  const store = memoryStorage();
  const ctx = load(FILES, { browser: store.browser });
  await ctx.putSkill(note);
  await ctx.putSkill({ ...caption, name: "mine" });
  const text = JSON.stringify({ format: "pagemortem-backup", version: 1, settings: {}, skills: [{ ...note, body: "New." }, caption] });
  await ctx.restoreBackup(ctx.parseBackup(text));
  const list = await ctx.loadSkills();
  assert.deepEqual(plain(list.map((s) => s.name)), ["notes", "mine", "caption"]);
  assert.equal(list[0].body, "New.");
});

test("a bad file is refused, and bad values or skills inside a backup are left out", () => {
  const { parseBackup } = load(FILES, { browser: memoryStorage().browser });
  assert.match(parseBackup("not json").error, /not valid JSON/);
  assert.match(parseBackup('{"skills":[]}').error, /isn't a PageMortem backup/);
  assert.match(parseBackup('{"format":"pagemortem-backup","version":9}').error, /newer/);
  const parsed = parseBackup(JSON.stringify({
    format: "pagemortem-backup", version: 1,
    settings: { maxSteps: "lots", temperature: 0.5, confirmAll: true, unknown: 1, thinkingLevels: [1] },
    skills: [note, { name: "!!!", body: "x" }, note],
  }));
  assert.deepEqual(plain(parsed.settings), { temperature: 0.5, confirmAll: true });
  assert.deepEqual(plain(parsed.skills.map((s) => s.name)), ["notes"]);
  assert.equal(parsed.skipped.length, 2);
});
