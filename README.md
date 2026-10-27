# PageMortem

A Firefox sidebar that uses your own OpenAI-compatible model server to ask about, summarize, translate and operate web pages. The extension can contact only the server address you lock it to.

## Install (Firefox Developer Edition)

1. Lock it to your server and build the package:
   ```
   python configure.py http://<server-ip>:<port>
   ```
   This copies the extension into `build/` with the lock set, and packages that copy as `pagemortem.xpi`. Your server address goes only into those two, which git ignores; the `manifest.json` in the repository keeps a placeholder. Re-run it whenever the server address or the code changes.
2. In `about:config`, set `xpinstall.signatures.required` to `false` (Developer Edition and Nightly only).
3. In `about:addons`, open the gear menu, choose **Install Add-on From File…** and pick `pagemortem.xpi`.
4. Open the sidebar with the toolbar button or **Alt+Shift+L**. Go to **Settings**, enter the endpoint (for example `http://192.168.1.50:8080/v1`), then click **Test connection**.

For quick iteration you can instead load `build/manifest.json` from `about:debugging` → **This Firefox** → **Load Temporary Add-on**. That copy is removed when Firefox restarts. After editing code, re-run `configure.py` and click **Reload**: `build/` is a copy, so edits to the source don't reach it until then. (Loading the top-level `manifest.json` works too, but its placeholder lock blocks your server.)

## Server notes

- **llama.cpp `llama-server`:** start it with `--jinja` so tool calls work. Add `--mmproj` for a vision model. Use `--host 0.0.0.0` so other LAN machines can reach it.
- **vLLM:** use `--enable-auto-tool-choice --tool-call-parser hermes` for Qwen models.
- **Qwen3-Next is text-only.** For image tasks, run a Qwen3-VL model too and put its name in **Settings → Vision model**. If your main model accepts images, leave that field blank.
- If Agent mode stalls, or tool calls show up as plain text, switch **Tool calling** to *JSON in text*.

## Using it

- **Ask** answers from the current tab. To compare pages, select several tabs first (Ctrl+click or Shift+click the tabs). Selected text on the page is included automatically. Asking on a different page starts a fresh conversation; turn on **Keep earlier pages** (next to the page name) to keep earlier pages in it for comparisons.
- **Summarize** works on the page, or on the selection if one exists. Long pages are summarized in parts.
- **Translate** translates the selection into the sidebar. With no selection it translates the whole page in place, and **Show original** reverts it.
- **Agent** reads the page, searches long pages for text, opens links in background tabs, clicks, scrolls, looks at screenshots (images get numbered labels) and highlights what it finds. Search sees only what reading the page does (never password or payment field values, nothing hidden). A highlight outlines the whole row when the match is in a table, follows the page as you scroll, and stays for 30 seconds; press Esc or click the page to clear it. It asks before anything risky and closes the tabs it opened when it's done.
- **Saving images.** Ask the agent things like *save all images of kittens chasing laser pointers* or *download every photo on this page*. PageMortem scrolls through the page, crops each image from a screenshot and asks the model (or the vision model, if set) a yes/no question about it, then saves the matches to `Downloads/PageMortem/<what you asked for>/`, numbered in page order. Matches appear as thumbnails in the sidebar. It saves the best version the page offers: the full-size file when a thumbnail links straight to one, otherwise the largest `srcset` entry. Images drawn by page script (`blob:`) and inline `data:` images are skipped. The first save asks once, and Firefox asks for its download permission at that moment; only image files are kept (anything else is deleted).
- The right-click menu has Translate, Summarize and Ask entries.
- Each reply ends with its speed and size (tokens per second, tokens in and out, cached prompt tokens). Hover for time to first token, prompt speed and speculative-draft acceptance. Numbers come from the server when it reports them (llama.cpp-style `timings`, or `usage`); otherwise they are estimated and marked `~`. Turn this off in Settings.
- When an agent click is flagged only because of its label (for example “Close”), the card also offers **Always allow “Close” on this site**. That choice lasts until you start a new conversation or close the sidebar, and covers only that exact label on that site. It is never offered for purchases, deletions, messages, account or permission actions, form submissions, downloads or risky link addresses.

## What "local only" means here

- **Network lock.** The extension's Content Security Policy (`connect-src`) allows only the origin(s) you passed to `configure.py`. Firefox itself refuses any other request from the sidebar, settings or background pages, including internet hosts, other LAN hosts, image beacons and frames. A bug or a manipulated model reply can't change this; changing it means re-running `configure.py` and reinstalling.
- **Page access.** The `<all_urls>` permission lets PageMortem read and operate tabs. It opens no network path to anywhere new. The content script never makes requests.
- **The agent has no free-form navigation.** It can open only links that already exist on the page, and it has no tool for arbitrary requests or scripts.
- **Approvals are enforced in code** (`lib/agent.js`), never by the model:
  - Same-site links and in-page controls (tabs, "show more", pagination) run on their own.
  - Asked every time, with no "allow all": leaving the approved sites, downloads, form submissions, buttons in forms that send data, anything whose label or link address suggests a change (buy, delete, send, save, continue, …), typing into non-search fields, and using a tab you didn't select.
  - "Allow all" exists only for narrow, low-risk scopes on one site: ordinary clicks (when *Ask before every click* is on) and searches.
  - Labels come from the page, so they can only make PageMortem more careful, never less.
- **Checked again at the last moment.** Each action is bound to the page the model read; if the page navigated or the element changed while an approval card was open, nothing happens. After every click, submit, dropdown change, back step and opened link, PageMortem checks where the tab actually landed. If page script or a redirect took it to an unapproved site, you're asked, and if you decline the tab is sent back (or closed if the agent opened it).
- **Downloads** use Firefox's downloads API (optional `downloads` permission, requested the first time you approve a save). That API isn't bound by the network lock, so it is used only for images already shown on approved pages; the model can't give it an address of its own, and files can only land inside your Downloads folder.
- **Password, payment and ID fields** are refused outright and their values are never read. There's a step limit, timeouts on the model and page calls, and a Stop button (Esc) that ends the run at once and closes the tabs the agent opened. Tabs you opened are never closed.
- **Links in answers** are clickable only when they point at a page PageMortem read for that answer. Other links are shown as plain text, so a page can't plant a one-click link that carries data elsewhere.
- **What can still reach a website:** pages the agent visits load like any page you visit. Text the agent types into a field (with your approval) is visible to that site. A translated page's own scripts can read the translated text. A page's scripts can react to anything PageMortem does on it; PageMortem detects where that leads, but can't stop the page from sending its own requests.
- **Prompt injection:** page text is handed to the model labelled as untrusted data, and the system prompt tells it to ignore instructions inside pages. A small model can still be fooled, which is why every gate above is enforced in code rather than left to the model.
- **Site boundaries** use a built-in list of shared-hosting and country suffixes (e.g. `alice.github.io`, `x.vercel.app`, `bbc.co.uk`), not the full Public Suffix List. A rare platform not on the list is treated as one site.

## Tests

```
npm test                                                     # offline: agent policy, parsing, Markdown, client
PAGEMORTEM_ENDPOINT=http://<server>:<port>/v1 npm run test:live # also exercises a real model server
```

The tests run the extension's own scripts in Node with a simulated browser. They don't exercise Firefox itself (CSP enforcement, permissions, the real content script DOM code); check those by loading the extension.

## Files

| Path | Role |
|---|---|
| `manifest.json` | Permissions, CSP network lock (a placeholder until `configure.py` builds), sidebar |
| `background.js` | Toolbar button, context menu |
| `sidebar/` | UI; all model calls happen here |
| `lib/llm.js` | OpenAI-compatible client (streaming, tool calls, `<think>` stripping) |
| `lib/chat.js` | Ask, Summarize, Translate |
| `lib/agent.js` | Agent loop, tools, approval rules |
| `lib/tabs.js` | Script injection, navigation waits, screenshots |
| `content/content.js` | Page reader with numbered elements, actions, in-place translation, image labels |
| `configure.py` | Builds `build/` and `pagemortem.xpi` with the lock set |
| `build/` | Generated by `configure.py`; not in git |
