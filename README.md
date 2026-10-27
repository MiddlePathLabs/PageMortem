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

- **Ask** answers from the included pages. To compare pages, select several tabs first (Ctrl+click or Shift+click the tabs), or add an open tab through **Context**. Selected text is included automatically unless excluded there. Turn on **Keep earlier pages** inside Context to retain pages as you browse; otherwise only the current selection of tabs and pinned snapshots remain.
- **Summarize** works on the page, or on the selection if one exists. Long pages are summarized in parts.
- **Translate** translates the selection into the sidebar. With no selection it translates the whole page in place, and **Show original** reverts it.
- **Agent** reads the page, searches long pages for text, opens links in background tabs, clicks, presses keys, scrolls, waits for slow pages to load, looks at screenshots (images get numbered labels) and highlights what it finds. Search sees only what reading the page does (never password or payment field values, nothing hidden). A highlight outlines the whole row when the match is in a table, follows the page as you scroll, and stays for 30 seconds; press Esc or click the page to clear it. It asks before anything risky and closes the tabs it opened when it's done.
- **Saving images.** Ask the agent things like *save all images of kittens chasing laser pointers* or *download every photo on this page*. PageMortem scrolls through the page, crops each image from a screenshot and asks the model (or the vision model, if set) a yes/no question about it, then saves the matches to `Downloads/PageMortem/<what you asked for>/`, numbered in page order. Matches appear as thumbnails in the sidebar. It saves the best version the page offers: the full-size file when a thumbnail links straight to one, otherwise the largest `srcset` entry. Images drawn by page script (`blob:`) and inline `data:` images are skipped. The first save asks once, and Firefox asks for its download permission at that moment; only image files are kept (anything else is deleted).
- **Watching a page.** Ask things like *add it to the cart when it's back in stock*. The agent asks once, then reloads the page every 15 s to 10 min (30 s by default) for up to 4 hours, checking for the text that marks the change. The checks run in PageMortem's own code, so a long watch makes no model calls and counts as one step. When the change appears you get a Firefox notification (the first watch asks for that permission; you can decline and still watch) and the agent carries on. The next step still asks you as usual: **Add to cart**, like any purchase step, is approved by you every time, so nothing is bought while you're away. The watch stops if a reload lands anywhere other than the watched page (a sign-in or error page could otherwise look like "Out of stock" going away), after three failed checks in a row, at its time limit, or when you press Stop.
- The right-click menu has Translate, Summarize and Ask entries.
- Each reply ends with its speed and size (tokens per second, tokens in and out, cached prompt tokens). Hover for time to first token, prompt speed and speculative-draft acceptance. Numbers come from the server when it reports them (llama.cpp-style `timings`, or `usage`); otherwise they are estimated and marked `~`. Turn this off in Settings.
- When an agent click is flagged only because of its label (for example “Close”), the card also offers **Always allow “Close” on this site**. That choice lasts until you start a new conversation or close the sidebar, and covers only that exact label on that site. It is never offered for purchases, deletions, messages, account or permission actions, form submissions, downloads or risky link addresses.

### Context and modes

Expand **Context** to inspect Ask's sources, URLs, read times, selected excerpts, and the character budget used for each page. Truncated sources are marked. Unpinned open sources are reread before each Ask request.

- **Pin snapshot** keeps that copy of a page through navigation. **Add an open tab** adds it as a pinned snapshot.
- **Refresh** updates one source; **Refresh context** updates included sources whose tabs are still open at the same address, including pinned ones. Closed or navigated-away snapshots remain unchanged.
- **Remove** excludes a page from future Ask requests. **Remove selection** excludes the extra highlighted excerpt, not matching text in the included page. Selected excerpts share a 6,000-character limit.
- Removing a source or changing selection inclusion clears model conversation history, including earlier answers, so removed information is not retained there. Existing messages stay visible in the sidebar. Manual refresh also clears model history.
- **New conversation** clears the source overrides and remembered approvals, then includes the currently selected tabs again.

**Ask** reads the included pages without interacting with websites. **Agent** starts on the active tab and can use Firefox-selected tabs; Ask's source list does not restrict its navigation. The mode description stays above the message box. Use arrow keys, Home, or End to change modes when a mode button has focus.

Approval cards identify the site, target and available action details, with buttons such as **Submit form**, **Type text** or **Start watch**. Form approvals explicitly warn when submitted values cannot safely be enumerated. Detected consequential actions still require individual approval; ordinary controls can also trigger site-script side effects.

### Settings and capability checks

Settings are grouped into **Connection**, **Models and capabilities**, **Safety**, and a collapsed **Advanced** section for generation, context, translation concurrency and screenshot tuning.

**Check Text**, **Check Tools**, and **Check Vision** send separate diagnostic requests using the displayed settings without saving them or sending page content. Tools checks validate a returned call and its argument in the selected native or JSON-in-text mode; no browser tool is executed. Vision checks send a generated two-color image to the vision model, or the main model if no override is set. A pass confirms only that small probe, not reliable behavior for every task; a failed probe does not establish that the capability is unsupported. Choose **Save settings** to apply changes. The packaged network lock remains unchanged.

## What "local only" means here

- **Network lock.** The extension's Content Security Policy (`connect-src`) allows only the origin(s) you passed to `configure.py`. Firefox itself refuses any other request from the sidebar, settings or background pages, including internet hosts, other LAN hosts, image beacons and frames. A bug or a manipulated model reply can't change this; changing it means re-running `configure.py` and reinstalling.
- **Page access.** The `<all_urls>` permission lets PageMortem read and operate tabs. It opens no network path to anywhere new. The content script never makes requests.
- **The agent has no free-form navigation.** It can open only links that already exist on the page, and it has no tool for arbitrary requests or scripts.
- **Approvals are enforced in code** (`lib/agent.js`), never by the model:
  - Same-site links and in-page controls (tabs, "show more", pagination) run on their own.
  - Key presses are limited to Escape, Tab, arrows, PageUp/PageDown, Home/End, Enter and Space, always on a numbered element. Letters and Ctrl/Alt shortcuts are refused, since on many sites they archive, delete or send. Enter or Space on a control gets the same approval as clicking it, and Enter in a field the same as submitting it.
  - Asked every time, with no "allow all": leaving the approved sites, downloads, form submissions, buttons in forms that send data, anything whose label or link address suggests a change (buy, delete, send, save, continue, …), typing into non-search fields, and using a tab you didn't select.
  - "Allow all" exists only for narrow, low-risk scopes on one site: ordinary clicks (when *Ask before every click* is on) and searches.
  - Labels come from the page, so they can only make PageMortem more careful, never less.
- **Checked again at the last moment.** Each action is bound to the page the model read; if the page navigated or the element changed while an approval card was open, nothing happens. After every click, submit, dropdown change, back step and opened link, PageMortem checks where the tab actually landed. If page script or a redirect took it to an unapproved site, you're asked, and if you decline the tab is sent back (or closed if the agent opened it).
- **Notifications** (optional `notifications` permission) are used only to tell you a watched page changed.
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

The tests run the extension's own scripts in Node with a simulated browser (the content script runs against a minimal fake DOM). They don't exercise Firefox itself (CSP enforcement, permissions, real DOM and event behaviour); check those by loading the extension.

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
