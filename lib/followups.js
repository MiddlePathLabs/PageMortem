// Follow-ups across Agent tasks and skill answers: a short record of earlier turns ("again", "now the next page") and
// the skill that stays active after @name until another is named, it is removed, or a new conversation starts.
"use strict";

// Turns kept, and how many of them an Agent task sees.
const FOLLOWUP_KEEP = 8;
const FOLLOWUP_TURNS = 5;
// Characters of each earlier answer an Agent task sees; a prompt skill sees its own answers whole, up to this many.
const FOLLOWUP_ANSWER_CHARS = 800;
const SKILL_ANSWER_CHARS = 6000;
// Earlier answers of the active prompt skill sent with a follow-up to it.
const SKILL_HISTORY = 3;

const clip = (s, n) => {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
};

/** @returns {{skill: string|null, turns: {kind:"agent"|"skill", skill:string|null, task:string, answer:string, url?:string, title?:string}[]}} */
function newFollowups() {
  return { skill: null, turns: [] };
}

/** Adds a finished (or stopped, or failed) turn, keeping the latest FOLLOWUP_KEEP. */
function recordTurn(followups, turn) {
  followups.turns.push({ ...turn, task: clip(turn.task, 2000), answer: clip(turn.answer, SKILL_ANSWER_CHARS) });
  followups.turns.splice(0, Math.max(0, followups.turns.length - FOLLOWUP_KEEP));
}

/** Earlier turns for the start of an Agent task, or "" when there are none. */
function earlierTurnsBlock(followups) {
  const turns = followups.turns.slice(-FOLLOWUP_TURNS);
  if (!turns.length) return "";
  const lines = turns.map((t, i) => {
    const out = [`${i + 1}. Task: ${clip(t.task, 400)}${t.skill ? ` (skill @${t.skill}${t.kind === "skill" ? ", answered without browsing" : ""})` : ""}`];
    if (t.url) out.push(`   Ended on: ${clip(t.title || "", 120)} — ${t.url}`);
    out.push(`   Result: ${clip(t.answer, FOLLOWUP_ANSWER_CHARS) || "(none)"}`);
    return out.join("\n");
  });
  return `Earlier in this conversation (for follow-ups such as "again" or "the next one"; pages may have changed since):\n${lines.join("\n")}\n\n`;
}

/** The active prompt skill's earlier exchanges, as chat messages to put before the new request. */
function skillHistory(followups, name) {
  return followups.turns
    .filter((t) => t.kind === "skill" && t.skill === name && t.answer)
    .slice(-SKILL_HISTORY)
    .flatMap((t) => [{ role: "user", content: t.task }, { role: "assistant", content: t.answer }]);
}
