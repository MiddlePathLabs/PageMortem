"use strict";

const $ = (id) => document.getElementById(id);
const TEXT = ["endpoint", "apiKey", "model", "visionModel", "rerankModel", "decisionModel", "language", "toolMode", "thinking"];
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

async function checkRerank(llm, s) {
  if (!s.rerankModel) throw new Error("Set a rerank model first. Without one, long pages are cut at the end and Sources asks the main model.");
  const docs = ["The battery lasts about 14 hours on a single charge.", "It is sold in silver and black.", "Shipping is free on orders over $50."];
  const scores = await llm.rerank({ model: s.rerankModel, query: "How long does the battery last?", documents: docs });
  if (!(scores[0] > scores[1] && scores[0] > scores[2])) {
    throw new Error(`Rerank probe did not pass for ${s.rerankModel}: the matching passage did not score highest. Check that the server serves it on /rerank. This does not prove reranking is unsupported.`);
  }
  return `Rerank probe passed for ${s.rerankModel}: ranked the matching passage first of three (score ${scores[0].toFixed(2)}). One small test is not a guarantee for every page.`;
}

async function checkDecision(llm, s) {
  if (!s.decisionModel) throw new Error("Set a decision model first. Without one, Agent watches check only for exact text.");
  const cases = [
    ["The clock shows 11:49:00 PM or later.", "11:47:52 PM\nCoordinated Universal Time", "no"],
    ["The clock shows 11:49:00 PM or later.", "11:52:03 PM\nCoordinated Universal Time", "yes"],
    ["The price is below $50.", "Acme Kettle\nPrice: $54.99\nIn stock", "no"],
    ["The item is back in stock.", "Acme Kettle\n$54.99\nOnly 3 left - order soon\nAdd to cart", "yes"],
  ];
  let right = 0;
  for (const [question, text, expected] of cases) {
    const answer = await llm.decide({ model: s.decisionModel, question: `Does this web page show that the following is true now? ${question}`, text });
    if (answer === expected) right++;
  }
  if (right < cases.length) {
    throw new Error(`Decision probe did not pass for ${s.decisionModel}: ${right} of ${cases.length} answers were right. A watch condition could fire early or never; try another model. This does not prove it can't work.`);
  }
  return `Decision probe passed for ${s.decisionModel}: answered ${cases.length} of ${cases.length} yes/no questions right. Small tests don't guarantee every condition.`;
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

let skills = [];
let editing = null;
let draftFiles = [];

function skillResult(text, ok = null) {
  result("skillResult", text, ok);
}

function syncSkillFields() {
  const agent = $("skillKind").value === "agent";
  $("skillNeeds").disabled = agent;
  $("skillOutput").disabled = agent;
  const slug = skillSlug($("skillName").value);
  $("skillSlug").textContent = slug ? `Used as @${slug}` : "";
}

function clearSkillForm() {
  editing = null;
  $("skillName").value = "";
  $("skillDescription").value = "";
  $("skillKind").value = "prompt";
  $("skillNeeds").value = "none";
  $("skillOutput").value = "markdown";
  $("skillBody").value = "";
  draftFiles = [];
  renderDraftFiles();
  $("skillAdd").textContent = "Add skill";
  $("skillCancel").hidden = true;
  syncSkillFields();
}

function fillSkillForm(skill) {
  $("skillName").value = skill.name;
  $("skillDescription").value = skill.description;
  $("skillKind").value = skill.kind;
  $("skillNeeds").value = skill.needs;
  $("skillOutput").value = skill.output;
  $("skillBody").value = skill.body;
  draftFiles = skill.files ? skill.files.map((file) => ({ ...file })) : [];
  renderDraftFiles();
  $("skillAdd").textContent = "Save skill";
  $("skillCancel").hidden = false;
  syncSkillFields();
  $("skillName").focus();
}

function renderSkills() {
  const list = $("skillList");
  list.replaceChildren(...skills.map((s) => {
    const li = document.createElement("li");
    const title = document.createElement("div");
    title.textContent = `@${s.name}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    const kind = s.kind === "agent" ? "Agent" : "Prompt";
    const extra = s.kind === "agent" ? "" : ` · ${s.needs === "none" ? "no extra context" : s.needs} · ${s.output}`;
    const count = s.files?.length ? ` · ${s.files.length} file${s.files.length === 1 ? "" : "s"}` : "";
    meta.textContent = `${kind}${extra}${count}${s.description ? ` — ${s.description}` : ""}`;
    const row = document.createElement("div");
    row.className = "row";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      editing = s.name;
      fillSkillForm(s);
      skillResult("");
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove @${s.name}?`)) return;
      try {
        skills = await removeSkill(s.name);
        if (editing === s.name) clearSkillForm();
        renderSkills();
        skillResult(`Removed @${s.name}.`, true);
      } catch (e) {
        skillResult(e.message, false);
      }
    });
    row.append(edit, remove);
    li.append(title, meta, row);
    return li;
  }));
  $("skillEmpty").hidden = skills.length > 0;
}

async function commitSkill() {
  const parsed = normalizeSkill({
    name: $("skillName").value,
    description: $("skillDescription").value,
    kind: $("skillKind").value,
    needs: $("skillNeeds").value,
    output: $("skillOutput").value,
    body: $("skillBody").value,
    files: draftFiles,
  });
  if (parsed.error) return skillResult(parsed.error, false);
  $("skillAdd").disabled = true;
  try {
    skills = await putSkill(parsed.skill, editing);
    clearSkillForm();
    renderSkills();
    skillResult(`Saved @${parsed.skill.name}.`, true);
  } catch (e) {
    skillResult(e.message, false);
  } finally {
    $("skillAdd").disabled = false;
  }
}

function renderDraftFiles() {
  const list = $("skillFiles");
  list.replaceChildren(...draftFiles.map((file) => {
    const li = document.createElement("li");
    const name = document.createElement("code");
    name.textContent = file.path;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      draftFiles = draftFiles.filter((item) => item.path !== file.path);
      renderDraftFiles();
    });
    li.append(name, remove);
    return li;
  }));
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function readImported(file) {
  const path = file.webkitRelativePath || file.name;
  if (file.size > 1500000) return { path, skip: "too large" };
  if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
    const image = await readDataUrl(file);
    if (image.length > SKILL_LIMITS.image) return { path, skip: "image too large" };
    return { path, image };
  }
  const text = await file.text();
  if (text.includes("\0")) return { path, skip: "not text" };
  return { path, text };
}

function showImported(parsed) {
  if (parsed.error) return skillResult(parsed.error, false);
  const existing = skills.find((s) => s.name === parsed.skill.name);
  editing = existing ? existing.name : null;
  fillSkillForm(parsed.skill);
  const n = parsed.skill.files?.length || 0;
  const skipped = parsed.skipped?.length ? ` Skipped: ${parsed.skipped.join("; ")}.` : "";
  const lead = existing ? `Review @${parsed.skill.name}, then save to replace it.` : "Review the skill, then add it.";
  const kind = parsed.kindInferred ? " Kind is Agent because the folder has reference files; agent skills read them when needed." : "";
  const warning = parsed.warning ? ` ${parsed.warning}` : "";
  skillResult(`${lead}${n ? ` ${n} supporting file${n === 1 ? "" : "s"}.` : ""}${kind}${warning}${skipped}`, !parsed.warning);
}

async function importSkillFiles(fileList, { folder = false } = {}) {
  const entries = [];
  for (const file of fileList) entries.push(await readImported(file));
  if (!folder && entries.length === 1 && entries[0].text != null && !entries[0].skip) {
    return showImported(parseSkillFile(entries[0].text, entries[0].path));
  }
  const skipped = entries.filter((e) => e.skip);
  if (!folder && skipped.length && entries.length === skipped.length) return skillResult(skipped.map((e) => `${e.path}: ${e.skip}`).join("; "), false);
  showImported(parseSkillBundle(entries));
}

async function addDraftFiles(fileList) {
  const entries = [];
  for (const file of fileList) entries.push(await readImported(file));
  const skipped = entries.filter((e) => e.skip).map((e) => `${e.path}: ${e.skip}`);
  const incoming = normalizeFiles(entries.filter((e) => !e.skip), { lenient: true });
  if (incoming.error) return skillResult(incoming.error, false);
  // Existing files come first, so the limits leave out what was just picked, not what the skill already had.
  const byPath = new Map(draftFiles.map((file) => [file.path.toLowerCase(), file]));
  for (const file of incoming.files) byPath.set(file.path.toLowerCase(), file);
  // Kept up to the agent limit; saving a prompt skill checks its own, lower limit.
  const merged = normalizeFiles([...byPath.values()], { lenient: true });
  if (merged.error) return skillResult(merged.error, false);
  skipped.push(...incoming.skipped, ...merged.skipped);
  draftFiles = merged.files;
  renderDraftFiles();
  skillResult(skipped.length ? `Added files. Skipped: ${skipped.join("; ")}.` : "Added files. Save the skill to keep them.", true);
}

async function importPicked(input, folder) {
  const list = [...(input.files || [])];
  input.value = "";
  if (!list.length) return;
  try {
    await importSkillFiles(list, { folder });
  } catch (e) {
    skillResult(e.message, false);
  }
}

async function bindSkills() {
  skills = await loadSkills();
  renderSkills();
  clearSkillForm();
  $("skillName").addEventListener("input", syncSkillFields);
  $("skillKind").addEventListener("change", syncSkillFields);
  $("skillAdd").addEventListener("click", commitSkill);
  $("skillCancel").addEventListener("click", () => {
    clearSkillForm();
    skillResult("");
  });
  $("skillImport").addEventListener("click", () => $("skillFile").click());
  $("skillFolder").addEventListener("click", () => $("skillDir").click());
  $("skillAddFiles").addEventListener("click", () => $("skillExtra").click());
  $("skillFile").addEventListener("change", () => importPicked($("skillFile"), false));
  $("skillDir").addEventListener("change", () => importPicked($("skillDir"), true));
  $("skillExtra").addEventListener("change", async () => {
    const list = [...($("skillExtra").files || [])];
    $("skillExtra").value = "";
    if (!list.length) return;
    try {
      await addDraftFiles(list);
    } catch (e) {
      skillResult(e.message, false);
    }
  });
}

async function exportBackup() {
  try {
    const backup = await makeBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2) + "\n"], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `pagemortem-backup-${backup.exported.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    const n = backup.skills.length;
    result("backupResult", `Exported settings and ${n} skill${n === 1 ? "" : "s"}.`, true);
  } catch (e) {
    result("backupResult", `Could not export: ${e.message}`, false);
  }
}

async function importBackup() {
  const file = $("backupFile").files?.[0];
  $("backupFile").value = "";
  if (!file) return;
  try {
    const parsed = parseBackup(await file.text());
    if (parsed.error) return result("backupResult", parsed.error, false);
    const n = parsed.skills.length;
    if (!confirm(`Replace the current settings and import ${n} skill${n === 1 ? "" : "s"} from ${file.name}?`)) return;
    const restored = await restoreBackup(parsed);
    fill(restored.settings);
    showLock();
    skills = restored.skills;
    clearSkillForm();
    renderSkills();
    const skipped = restored.skipped.length ? ` Skipped: ${restored.skipped.join("; ")}.` : "";
    const r = restored.restored;
    result("backupResult", `Restored settings and ${r} skill${r === 1 ? "" : "s"}.${skipped}`, !restored.skipped.length);
  } catch (e) {
    result("backupResult", `Could not import: ${e.message}`, false);
  }
}

async function init() {
  fill(await loadSettings());
  await bindSkills();
  $("backupExport").addEventListener("click", exportBackup);
  $("backupImport").addEventListener("click", () => $("backupFile").click());
  $("backupFile").addEventListener("change", importBackup);
  showLock();
  $("endpoint").addEventListener("input", showLock);
  $("test").addEventListener("click", () => runCheck("test", "testResult", testConnection));
  $("checkText").addEventListener("click", () => runCheck("checkText", "textResult", checkText));
  $("checkTools").addEventListener("click", () => runCheck("checkTools", "toolsResult", checkTools));
  $("checkVision").addEventListener("click", () => runCheck("checkVision", "visionResult", checkVision));
  $("checkRerank").addEventListener("click", () => runCheck("checkRerank", "rerankResult", checkRerank));
  $("checkDecision").addEventListener("click", () => runCheck("checkDecision", "decisionResult", checkDecision));
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
