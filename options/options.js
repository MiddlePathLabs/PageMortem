"use strict";

const $ = (id) => document.getElementById(id);
const TEXT = ["endpoint", "apiKey", "model", "visionModel", "language", "toolMode", "thinking"];
const NUM = ["temperature", "maxTokens", "maxPageChars", "maxSteps", "screenshotWidth", "translateConcurrency"];
const BOOL = ["showStats", "stayOnSite", "confirmAll", "closeAgentTabs"];

function read() {
  const s = {};
  for (const k of TEXT) s[k] = $(k).value.trim();
  for (const k of NUM) {
    const v = Number($(k).value);
    s[k] = Number.isFinite(v) && $(k).value !== "" ? v : DEFAULTS[k];
  }
  for (const k of BOOL) s[k] = $(k).checked;
  Object.assign(s, thinking);
  s.language ||= DEFAULTS.language;
  s.endpoint ||= DEFAULTS.endpoint;
  return s;
}

// What the thinking dropdown offers; replaced by Check thinking and saved with the other settings.
let thinking = { thinkingLevels: null, thinkingDefault: null };
const LEVEL_NAMES = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

function fillThinking(selected) {
  const levels = thinking.thinkingLevels || ["off", "low", "medium", "high"];
  const def = thinking.thinkingDefault ? ` (${LEVEL_NAMES[thinking.thinkingDefault] || thinking.thinkingDefault})` : "";
  const options = [new Option(`Server default${def}`, "default"), ...levels.map((l) => new Option(LEVEL_NAMES[l] || l, l))];
  // Keep a saved level the server didn't list, so opening settings never changes it silently.
  if (selected && selected !== "default" && !levels.includes(selected)) options.push(new Option(`${LEVEL_NAMES[selected] || selected} (not detected)`, selected));
  $("thinking").replaceChildren(...options);
  $("thinking").value = selected || "default";
}

function fill(s) {
  thinking = { thinkingLevels: s.thinkingLevels, thinkingDefault: s.thinkingDefault };
  fillThinking(s.thinking);
  for (const k of TEXT) $(k).value = s[k] ?? "";
  for (const k of NUM) $(k).value = s[k];
  for (const k of BOOL) $(k).checked = !!s[k];
}

function showLock() {
  const el = $("lockStatus");
  const problem = lockProblem($("endpoint").value.trim());
  el.className = "hint " + (problem ? "bad" : "ok");
  el.textContent = problem || `Network lock: PageMortem can only contact ${lockedOrigins().join(", ")}.`;
}

function result(id, text, ok = null) {
  $(id).textContent = text;
  $(id).className = "result" + (ok == null ? "" : ok ? " ok" : " bad");
}

async function runCheck(buttonId, resultId, check) {
  const button = $(buttonId);
  if (button.disabled) return;
  button.disabled = true;
  $(resultId).setAttribute("aria-busy", "true");
  result(resultId, "Checking the current settings…");
  try {
    const s = read();
    const problem = lockProblem(s.endpoint);
    if (problem) throw new Error(problem);
    const message = await check(new LLM(s), s);
    result(resultId, message, true);
  } catch (e) {
    result(resultId, e.message || "Request failed. Check the endpoint, credentials and server logs, then retry.", false);
  } finally {
    button.disabled = false;
    $(resultId).removeAttribute("aria-busy");
  }
}

async function testConnection(llm, s) {
  const models = await llm.models();
  $("models").replaceChildren(...models.map((m) => new Option(m, m)));
  if (!models.length) throw new Error("Connected, but the server lists no models. Load a model on the server, then retry.");
  const r = await llm.chat({ messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 400, noThinking: true });
  if (!r.content.trim()) throw new Error("The server lists models but returned no visible text. Check the model and server configuration, then retry.");
  return `Connected. ${models.length} model${models.length > 1 ? "s" : ""}; ${s.model || models[0]} replied “${r.content.trim().slice(0, 40)}”. This is not a tools or vision check.`;
}

function probeToken() {
  return `probe_${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;
}

async function checkText(llm) {
  const model = await llm.model();
  const token = probeToken();
  const r = await llm.chat({
    messages: [{ role: "user", content: `Reply with exactly this text and nothing else: ${token}` }],
    temperature: 0, maxTokens: 128, noThinking: true,
  });
  if (r.content.trim() !== token) throw new Error(`Text probe did not pass for ${model}: the reply did not match the requested text. Check the model or server template, then retry. This does not prove text is unsupported.`);
  return `Text probe passed for ${model}: returned the requested text. One short response is not a guarantee for longer tasks.`;
}

function parseProbeJson(text) {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return null;
  }
}

async function checkTools(llm, s) {
  const model = await llm.model();
  const token = probeToken();
  const native = s.toolMode !== "json";
  const prompt = native
    ? `Call capability_probe exactly once with token "${token}". Do not answer in text.`
    : `Reply only with one JSON tool call: {"tool":"capability_probe","args":{"token":"${token}"}}. Do not add any other text.`;
  const options = {
    messages: [{ role: "user", content: prompt }],
    temperature: 0, maxTokens: 256, noThinking: true,
  };
  if (native) options.tools = [{
    type: "function",
    function: {
      name: "capability_probe",
      description: "Return the supplied probe token. This diagnostic tool is never executed.",
      parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
    },
  }];
  const r = await llm.chat(options);
  const call = native ? r.toolCalls?.[0] : parseProbeJson(r.content);
  const name = native ? call?.name : call?.tool;
  const args = native ? parseProbeJson(call?.arguments || "") : call?.args;
  const mode = native ? "native" : "JSON-in-text";
  if (name !== "capability_probe" || args?.token !== token || (native && r.toolCalls.length !== 1)) {
    throw new Error(`Tools probe did not pass for ${model} in ${mode} mode: no matching returned call with the expected token. Check the server's tool template or try the other tool mode. This does not prove tools are unsupported.`);
  }
  return `Tools probe passed for ${model}: inspected a ${mode} call with the expected argument. No tool was executed; this does not guarantee reliable agent behavior.`;
}

function visionProbeImage() {
  const colors = [
    { name: "red", fill: "#ff0000" }, { name: "blue", fill: "#0000ff" },
    { name: "green", fill: "#008000" }, { name: "yellow", fill: "#ffff00" },
  ];
  const random = crypto.getRandomValues(new Uint32Array(2));
  const left = colors.splice(random[0] % colors.length, 1)[0];
  const right = colors[random[1] % colors.length];
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not generate the test image. Reload the settings page and retry.");
  context.fillStyle = left.fill;
  context.fillRect(0, 0, 48, 64);
  context.fillStyle = right.fill;
  context.fillRect(48, 0, 48, 64);
  return { url: canvas.toDataURL("image/png"), left: left.name, right: right.name };
}

async function checkVision(llm, s) {
  const model = s.visionModel || await llm.model();
  const image = visionProbeImage();
  const r = await llm.chat({
    model,
    messages: [{ role: "user", content: [
      { type: "text", text: 'Look at the attached image. Identify the color of the left half and the right half. Reply only with JSON {"left":"color","right":"color"}, using red, blue, green or yellow as the color names.' },
      { type: "image_url", image_url: { url: image.url } },
    ] }],
    temperature: 0, maxTokens: 128, noThinking: true,
  });
  const answer = parseProbeJson(r.content);
  if (answer?.left?.toLowerCase?.() !== image.left || answer?.right?.toLowerCase?.() !== image.right) {
    throw new Error(`Vision probe did not pass for ${model}: the reply did not correctly identify both image halves. Check that this model and server accept image inputs, or set a vision model, then retry. This does not prove vision is unsupported.`);
  }
  return `Vision probe passed for ${model}: correctly identified ${image.left} on the left and ${image.right} on the right of a generated PNG. One simple image can be guessed; this is not a guarantee of screenshot understanding.`;
}

async function checkThinking(llm) {
  const model = await llm.model();
  const r = await llm.thinkingSupport();
  thinking = { thinkingLevels: r.levels, thinkingDefault: r.serverDefault };
  fillThinking($("thinking").value);
  const names = r.levels.map((l) => LEVEL_NAMES[l] || l).join(", ");
  if (!r.thinks && !r.levels.length) return `${model} gave no separate reasoning in a test reply, so there is nothing to set. Only Server default is offered.`;
  const off = !r.thinks || r.levels.includes("off") ? "" : " Turning thinking off didn't stop it, so Off isn't offered.";
  const how = r.verified ? `from ${r.source}` : "accepted without an error; whether each one changes how much it thinks isn't verified";
  return `${model}: ${names || "no levels"} (${how}).${off} Save settings to keep this list.`;
}

async function init() {
  fill(await loadSettings());
  showLock();
  $("endpoint").addEventListener("input", showLock);
  $("test").addEventListener("click", () => runCheck("test", "testResult", testConnection));
  $("checkText").addEventListener("click", () => runCheck("checkText", "textResult", checkText));
  $("checkTools").addEventListener("click", () => runCheck("checkTools", "toolsResult", checkTools));
  $("checkVision").addEventListener("click", () => runCheck("checkVision", "visionResult", checkVision));
  $("checkThinking").addEventListener("click", () => runCheck("checkThinking", "thinkingResult", checkThinking));
  $("save").addEventListener("click", async () => {
    $("save").disabled = true;
    try {
      await saveSettings(read());
      result("saveResult", "Saved.", true);
    } catch (e) {
      result("saveResult", `Could not save settings: ${e.message}. Retry Save settings.`, false);
    } finally {
      $("save").disabled = false;
    }
  });
}

init();
