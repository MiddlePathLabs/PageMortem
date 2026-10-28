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

browser.runtime.onInstalled.addListener(async () => {
  await browser.menus.removeAll();
  const parent = browser.menus.create({ id: "pagemortem", title: "PageMortem", contexts: ["selection", "page", "image"] });
  for (const m of MENU) browser.menus.create({ ...m, parentId: parent });
});

browser.menus.onClicked.addListener((info, tab) => {
  // open() must run synchronously inside the user-gesture handler.
  browser.sidebarAction.open();
  const command = {
    kind: info.menuItemId.replace("pagemortem-", ""),
    selection: info.selectionText || "",
    tabId: tab?.id,
    // Extract text finds the clicked image by these; targetElementId is only valid in the frame it came from.
    image: info.menuItemId === "pagemortem-ocr" ? { tabId: tab?.id, frameId: info.frameId || 0, targetElementId: info.targetElementId, srcUrl: info.srcUrl || "" } : null,
    at: Date.now(),
  };
  browser.storage.session.set({ pendingCommand: command }).then(() =>
    browser.runtime.sendMessage({ type: "pagemortem:command" }).catch(() => {
      /* sidebar still loading; it reads pendingCommand on start */
    }),
  );
});
