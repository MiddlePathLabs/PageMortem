// Settings shared by the sidebar and the options page.
"use strict";

const DEFAULTS = Object.freeze({
  endpoint: "http://192.168.1.100:8080/v1",
  apiKey: "",
  model: "", // blank = first model the server lists
  visionModel: "", // blank = the main model sees screenshots itself
  language: "English",
  summaryLength: "standard", // "brief" | "standard" | "detailed"
  toolMode: "native", // "native" (OpenAI tool calls) | "json" (tools described in the prompt)
  disableThinking: false, // sends chat_template_kwargs.enable_thinking=false (Qwen3 / llama.cpp / vLLM)
  temperature: 0.3,
  maxTokens: 4096,
  maxPageChars: 24000,
  maxSteps: 20,
  confirmAll: false,
  stayOnSite: true,
  closeAgentTabs: true,
  translateConcurrency: 2,
  screenshotWidth: 1280,
  showStats: true, // speed and token counts under each reply
});

const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish", "Russian", "Ukrainian",
  "Turkish", "Arabic", "Hebrew", "Hindi", "Nepali", "Bengali", "Chinese (Simplified)", "Chinese (Traditional)",
  "Japanese", "Korean", "Vietnamese", "Thai", "Indonesian",
];

async function loadSettings() {
  const stored = await browser.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}

/** Origins the manifest CSP allows extension pages to contact. */
function lockedOrigins() {
  const csp = browser.runtime.getManifest().content_security_policy?.extension_pages || "";
  const m = /connect-src ([^;]*)/.exec(csp);
  return m ? m[1].trim().split(/\s+/) : [];
}

/** Returns null if the endpoint is allowed by the network lock, otherwise a message. */
function lockProblem(endpoint) {
  let origin;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    return "The endpoint isn't a valid URL.";
  }
  const allowed = lockedOrigins();
  if (allowed.includes(origin)) return null;
  return `The network lock only allows ${allowed.join(", ") || "nothing"}, but the endpoint is ${origin}. Run "python configure.py ${origin}" in the extension folder, then reload the extension.`;
}
