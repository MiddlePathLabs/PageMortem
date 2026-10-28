// Follow-ups: earlier Agent and skill turns reach the next task, and a prompt skill sees its own earlier answers.
import test from "node:test";
import assert from "node:assert/strict";
import { load, setup, answer } from "./harness.mjs";

const lib = () => load(["lib/followups.js"]);

test("earlier turns are summarised for the next Agent task, newest last, with long answers cut", () => {
  const ctx = lib();
  const f = ctx.newFollowups();
  assert.equal(ctx.earlierTurnsBlock(f), "");
  for (let i = 1; i <= 7; i++) ctx.recordTurn(f, { kind: "agent", skill: null, task: `task ${i}`, answer: `answer ${i}` });
  ctx.recordTurn(f, { kind: "agent", skill: "krea2-caption", task: "caption this image", answer: "x".repeat(5000), url: "https://a.example/p", title: "P" });
  assert.equal(f.turns.length, ctx.$("FOLLOWUP_KEEP"));
  const block = ctx.earlierTurnsBlock(f);
  assert.doesNotMatch(block, /task 3\b/, "only the latest five turns");
  assert.match(block, /task 4[\s\S]*task 7[\s\S]*Task: caption this image \(skill @krea2-caption\)/);
  assert.match(block, /Ended on: P — https:\/\/a\.example\/p/);
  assert.ok(block.length < 5000);
});

test("a prompt skill's history holds only its own answered turns, latest three", () => {
  const ctx = lib();
  const f = ctx.newFollowups();
  ctx.recordTurn(f, { kind: "skill", skill: "other", task: "o", answer: "other answer" });
  for (let i = 1; i <= 4; i++) ctx.recordTurn(f, { kind: "skill", skill: "cap", task: `t${i}`, answer: `a${i}` });
  ctx.recordTurn(f, { kind: "agent", skill: "cap", task: "agent run", answer: "done" });
  const h = ctx.skillHistory(f, "cap");
  assert.deepEqual(Array.from(h, (m) => m.content), ["t2", "a2", "t3", "a3", "t4", "a4"]);
  assert.deepEqual(Array.from(h, (m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
});

test("buildSkillRequest puts the skill's earlier exchanges between the instructions and the new request", () => {
  const ctx = load(["lib/skills.js"]);
  const skill = { name: "cap", kind: "prompt", needs: "none", output: "raw", body: "Write a caption.", files: [] };
  const history = [{ role: "user", content: "a red bike" }, { role: "assistant", content: "Red bike at dusk." }];
  const req = ctx.buildSkillRequest({ skill, task: "again", history });
  assert.deepEqual(Array.from(req.messages, (m) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(req.messages[2].content, "Red bike at dusk.");
  assert.equal(req.messages[3].content, "again");
});

test("an Agent task starts with the earlier turns, ahead of the task itself", async () => {
  const { run, model } = setup({ start: "https://shop.example/", sites: { "https://shop.example/": { title: "Shop", text: "Welcome" } }, replies: [answer("done")] });
  await run("again", { earlier: "Earlier in this conversation (…):\n1. Task: count the links\n   Result: 12 links\n\n" });
  const head = model.calls[0].messages[1].content;
  assert.match(head, /^Earlier in this conversation[\s\S]*Task: count the links[\s\S]*\n\nTask: again\n/);
});
