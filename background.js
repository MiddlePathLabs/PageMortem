// Lantern background: toolbar button, context menus, and hand-off to the sidebar.
// All model traffic happens in the sidebar page, which is bound by the manifest CSP.
"use strict";

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

const MENU = [
  { id: "lantern-translate", title: "Translate selection", contexts: ["selection"] },
  { id: "lantern-ask", title: "Ask about selection…", contexts: ["selection"] },
  { id: "lantern-summarize", title: "Summarize this page", contexts: ["page"] },
  { id: "lantern-translate-page", title: "Translate this page", contexts: ["page"] },
];

browser.runtime.onInstalled.addListener(async () => {
  await browser.menus.removeAll();
  const parent = browser.menus.create({ id: "lantern", title: "Lantern", contexts: ["selection", "page"] });
  for (const m of MENU) browser.menus.create({ ...m, parentId: parent });
});

browser.menus.onClicked.addListener((info, tab) => {
  // open() must run synchronously inside the user-gesture handler.
  browser.sidebarAction.open();
  const command = {
    kind: info.menuItemId.replace("lantern-", ""),
    selection: info.selectionText || "",
    tabId: tab?.id,
    at: Date.now(),
  };
  browser.storage.session.set({ pendingCommand: command }).then(() =>
    browser.runtime.sendMessage({ type: "lantern:command" }).catch(() => {
      /* sidebar still loading; it reads pendingCommand on start */
    }),
  );
});
