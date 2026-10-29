// Settings shared by the sidebar and the options page.
"use strict";

const DEFAULTS = Object.freeze({
  endpoint: "http://192.168.1.100:8080/v1",
  apiKey: "",
  model: "", // blank = first model the server lists
  visionModel: "", // blank = the main model sees screenshots itself
  rerankModel: "", // blank = no reranker: long pages are cut at the end, Sources asks the main model
  decisionModel: "", // blank = none: watch checks only for literal text
  visionEndpoint: "", // blank = the main endpoint and API key
  visionApiKey: "", // used only with an explicit vision endpoint
  rerankEndpoint: "", // blank = the main endpoint and API key
  rerankApiKey: "", // used only with an explicit rerank endpoint; blank = no Authorization header
  decisionEndpoint: "", // blank = the main endpoint and API key
  decisionApiKey: "", // used only with an explicit decision endpoint
  decisionApi: "openai", // "openai" structured output | "systemone" probabilities (Halogen D3)
  language: "English",
  summaryLength: "standard", // "brief" | "standard" | "detailed"
  toolMode: "native", // "native" (OpenAI tool calls) | "json" (tools described in the prompt)
  thinking: "default", // "default" (send nothing) | "off" | a reasoning effort such as "low" or "high"; see LLM.chat
  thinkingLevels: null, // levels "Check thinking" found on the server; null = not checked, offer the common ones
  thinkingDefault: null, // the server's own default effort, when it reports one
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
  hiddenButtons: [], // ids from QUICK_BUTTONS the sidebar leaves out
});

// The sidebar's built-in buttons, which Settings can hide.
const QUICK_BUTTONS = [
  { id: "summarize", label: "Summarize" },
  { id: "translate", label: "Translate" },
  { id: "ocr", label: "Extract text" },
  { id: "markdown", label: "Copy as Markdown" },
  { id: "groupTabs", label: "Group tabs" },
];

const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish", "Russian", "Ukrainian",
  "Turkish", "Arabic", "Hebrew", "Hindi", "Nepali", "Bengali", "Chinese (Simplified)", "Chinese (Traditional)",
  "Japanese", "Korean", "Vietnamese", "Thai", "Indonesian",
];

async function loadSettings() {
  const stored = await browser.storage.local.get("settings");
  const { disableThinking, ...saved } = stored.settings || {};
  if (disableThinking && !saved.thinking) saved.thinking = "off"; // the old on/off checkbox
  return { ...DEFAULTS, ...saved };
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
  return m ? m[1].trim().split(/\s+/).filter((s) => s !== "'none'") : [];
}

/** A packaged origin must also name a local service; settings cannot turn a public origin into one. */
function localModelHost(host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^\d+(?:\.\d+){3}$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts.some((n) => n > 255)) return false;
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254);
  }
  if (host === "::1") return true;
  if (host.includes(":")) {
    const first = parseInt(host.split(":")[0], 16);
    return Number.isFinite(first) && ((first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf));
  }
  return false;
}

/** Returns null if the endpoint is allowed by the network lock, otherwise a message. */
function lockProblem(endpoint) {
  let origin;
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return "The endpoint must be an HTTP(S) URL without embedded credentials. Use the API key field.";
    }
    if (!localModelHost(url.hostname)) return "The endpoint must be a loopback or private LAN address, or a .local host.";
    origin = url.origin;
  } catch {
    return "The endpoint isn't a valid URL.";
  }
  const allowed = lockedOrigins();
  if (allowed.includes(origin)) return null;
  return `The network lock only allows ${allowed.join(", ") || "nothing"}, but the endpoint is ${origin}. Run "python configure.py ${origin}" in the extension folder, then reload the extension.`;
}
