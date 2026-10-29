// PageMortem background: toolbar button, context menus, and hand-off to the sidebar.
// All model traffic happens in the sidebar page, which is bound by the manifest CSP.
"use strict";

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

// Each tab keeps its sidebar conversation (lib/threads.js) until it closes.
browser.tabs.onRemoved.addListener((tabId) => {
  browser.storage.session.remove(`thread:${tabId}`).catch(() => {});
});

const MENU = [
  { id: "pagemortem-translate", title: "Translate selection", contexts: ["selection"] },
  { id: "pagemortem-ask", title: "Ask about selection…", contexts: ["selection"] },
  { id: "pagemortem-summarize", title: "Summarize this page", contexts: ["page"] },
  { id: "pagemortem-translate-page", title: "Translate this page", contexts: ["page"] },
  { id: "pagemortem-ocr", title: "Extract text from image", contexts: ["image"] },
];

const SKILL_ITEM = "pagemortem-skill:";
const SKILL_IMAGE_ITEM = "pagemortem-skill-image:";

/** Skills marked "Show as a button", read straight from storage (lib/skills.js keeps one key per skill). */
async function pinnedSkills() {
  const { skillIndex } = await browser.storage.local.get("skillIndex");
  const names = Array.isArray(skillIndex) ? skillIndex.filter((n) => typeof n === "string") : [];
  if (!names.length) return [];
  const stored = await browser.storage.local.get(names.map((n) => `skill:${n}`));
  return names.map((n) => stored[`skill:${n}`]).filter((s) => s?.pinned === true).slice(0, 4); // SKILL_LIMITS.buttons
}

// One rebuild at a time: a second change while one runs would otherwise create duplicate ids.
let building = Promise.resolve();
function buildMenus() {
  building = building.then(async () => {
    await browser.menus.removeAll();
    const parent = browser.menus.create({ id: "pagemortem", title: "PageMortem", contexts: ["selection", "page", "image"] });
    for (const m of MENU) browser.menus.create({ ...m, parentId: parent });
    const skills = await pinnedSkills().catch(() => []);
    // Firefox matches "page" only when the click is on nothing more specific, so on an image only skills that can use
    // it show: prompt skills that include a screenshot, and agent skills, which get the image with their task.
    const onImage = skills.filter((s) => s.kind === "agent" || s.needs === "image");
    if (skills.length) browser.menus.create({ id: "pagemortem-sep", type: "separator", contexts: ["selection", "page"], parentId: parent });
    if (onImage.length) browser.menus.create({ id: "pagemortem-sep-image", type: "separator", contexts: ["image"], parentId: parent });
    for (const { name } of skills) {
      browser.menus.create({ id: SKILL_ITEM + name, title: `Run @${name}`, contexts: ["selection", "page"], parentId: parent });
    }
    for (const { name } of onImage) {
      browser.menus.create({ id: SKILL_IMAGE_ITEM + name, title: `Run @${name} on this image`, contexts: ["image"], parentId: parent });
    }
  }).catch(() => {});
  return building;
}

browser.runtime.onInstalled.addListener(buildMenus);
browser.runtime.onStartup.addListener(buildMenus);
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k === "skillIndex" || k.startsWith("skill:"))) buildMenus();
});

browser.menus.onClicked.addListener((info, tab) => {
  // open() must run synchronously inside the user-gesture handler.
  browser.sidebarAction.open();
  const id = String(info.menuItemId);
  const onImage = id.startsWith(SKILL_IMAGE_ITEM);
  const skill = onImage ? id.slice(SKILL_IMAGE_ITEM.length) : id.startsWith(SKILL_ITEM) ? id.slice(SKILL_ITEM.length) : null;
  const command = {
    kind: skill ? "skill" : id.replace("pagemortem-", ""),
    skill,
    selection: info.selectionText || "",
    tabId: tab?.id,
    // Extract text finds the clicked image by these; targetElementId is only valid in the frame it came from.
    image: id === "pagemortem-ocr" || onImage ? { tabId: tab?.id, frameId: info.frameId || 0, targetElementId: info.targetElementId, srcUrl: info.srcUrl || "" } : null,
    at: Date.now(),
  };
  browser.storage.session.set({ pendingCommand: command }).then(() =>
    browser.runtime.sendMessage({ type: "pagemortem:command" }).catch(() => {
      /* sidebar still loading; it reads pendingCommand on start */
    }),
  );
});
