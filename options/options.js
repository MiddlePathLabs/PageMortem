"use strict";

const $ = (id) => document.getElementById(id);
const TEXT = ["endpoint", "apiKey", "model", "visionModel", "language", "toolMode"];
const NUM = ["temperature", "maxTokens", "maxPageChars", "maxSteps", "screenshotWidth", "translateConcurrency"];
const BOOL = ["disableThinking", "stayOnSite", "confirmAll", "closeAgentTabs"];

function read() {
  const s = {};
  for (const k of TEXT) s[k] = $(k).value.trim();
  for (const k of NUM) {
    const v = Number($(k).value);
    s[k] = Number.isFinite(v) && $(k).value !== "" ? v : DEFAULTS[k];
  }
  for (const k of BOOL) s[k] = $(k).checked;
  s.language ||= DEFAULTS.language;
  s.endpoint ||= DEFAULTS.endpoint;
  return s;
}

function fill(s) {
  for (const k of TEXT) $(k).value = s[k] ?? "";
  for (const k of NUM) $(k).value = s[k];
  for (const k of BOOL) $(k).checked = !!s[k];
}

function showLock() {
  const el = $("lockStatus");
  const problem = lockProblem($("endpoint").value.trim());
  el.className = "hint " + (problem ? "bad" : "ok");
  el.textContent = problem || `Network lock: Lantern can only contact ${lockedOrigins().join(", ")}.`;
}

function result(id, text, ok) {
  $(id).textContent = text;
  $(id).className = "result " + (ok ? "ok" : "bad");
}

async function test() {
  result("testResult", "Testing…", true);
  const s = read();
  const llm = new LLM(s);
  try {
    const models = await llm.models();
    $("models").replaceChildren(...models.map((m) => new Option(m, m)));
    if (!models.length) return result("testResult", "Connected, but the server lists no models.", false);
    const r = await llm.chat({ messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 400, noThinking: true });
    result("testResult", `Connected. ${models.length} model${models.length > 1 ? "s" : ""}; ${s.model || models[0]} replied “${r.content.trim().slice(0, 40)}”.`, true);
  } catch (e) {
    result("testResult", e.message, false);
  }
}

async function init() {
  fill(await loadSettings());
  showLock();
  $("endpoint").addEventListener("input", showLock);
  $("test").addEventListener("click", test);
  $("save").addEventListener("click", async () => {
    await saveSettings(read());
    result("saveResult", "Saved.", true);
    setTimeout(() => ($("saveResult").textContent = ""), 2500);
  });
}

init();
