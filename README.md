# Lantern

A Firefox sidebar that uses your own OpenAI-compatible model server to ask about, summarize, translate and operate web pages. The extension can contact only the server address you lock it to.

## Install (Firefox Developer Edition)

1. Lock it to your server and build the package:
   ```
   python configure.py http://<server-ip>:<port>
   ```
   This writes `lantern.xpi`. Re-run it whenever the server address changes.
2. In `about:config`, set `xpinstall.signatures.required` to `false` (Developer Edition and Nightly only).
3. In `about:addons`, open the gear menu, choose **Install Add-on From File…** and pick `lantern.xpi`.
4. Open the sidebar with the toolbar button or **Alt+Shift+L**. Go to **Settings**, enter the endpoint (for example `http://192.168.1.50:8080/v1`), then click **Test connection**.

For quick iteration you can instead load `manifest.json` from `about:debugging` → **This Firefox** → **Load Temporary Add-on**. That copy is removed when Firefox restarts.

## Server notes

- **llama.cpp `llama-server`:** start it with `--jinja` so tool calls work. Add `--mmproj` for a vision model. Use `--host 0.0.0.0` so other LAN machines can reach it.
- **vLLM:** use `--enable-auto-tool-choice --tool-call-parser hermes` for Qwen models.
- **Qwen3-Next is text-only.** For image tasks, run a Qwen3-VL model too and put its name in **Settings → Vision model**. If your main model accepts images, leave that field blank.
- If Agent mode stalls, or tool calls show up as plain text, switch **Tool calling** to *JSON in text*.

## Using it

- **Ask** answers from the current tab. To compare pages, select several tabs first (Ctrl+click or Shift+click the tabs). Selected text on the page is included automatically.
- **Summarize** works on the page, or on the selection if one exists. Long pages are summarized in parts.
- **Translate** translates the selection into the sidebar. With no selection it translates the whole page in place, and **Show original** reverts it.
- **Agent** reads the page, opens links in background tabs, clicks, scrolls, looks at screenshots (images get numbered labels) and highlights what it finds. It asks before anything risky and closes the tabs it opened when it's done.
- The right-click menu has Translate, Summarize and Ask entries.

## What "local only" means here

- **Network lock.** The extension's Content Security Policy (`connect-src`) allows only the origin(s) you passed to `configure.py`. Firefox itself refuses any other request from the sidebar, settings or background pages, including internet hosts, other LAN hosts, image beacons and frames. A bug or a manipulated model reply can't change this; changing it means editing the manifest and reinstalling.
- **Page access.** The `<all_urls>` permission lets Lantern read and operate tabs. It opens no network path to anywhere new. The content script never makes requests.
- **The agent has no free-form navigation.** It can open only links that already exist on the page. Leaving the starting site, risky buttons (buy, delete, send, submit, …), downloads and all typing need your approval. Password, payment and ID fields are refused outright. There's also a step limit and a Stop button (Esc).
- **What can still reach a website:** pages the agent visits load like any page you visit. Text the agent types into a field (with your approval) is visible to that site. A translated page's own scripts can read the translated text.
- **Prompt injection:** page text is handed to the model as data, and the system prompt tells it to ignore instructions inside pages. A small model can still be fooled, which is why the gates above are enforced in code rather than left to the model.

## Files

| Path | Role |
|---|---|
| `manifest.json` | Permissions, CSP network lock, sidebar |
| `background.js` | Toolbar button, context menu |
| `sidebar/` | UI; all model calls happen here |
| `lib/llm.js` | OpenAI-compatible client (streaming, tool calls, `<think>` stripping) |
| `lib/chat.js` | Ask, Summarize, Translate |
| `lib/agent.js` | Agent loop, tools, approval rules |
| `lib/tabs.js` | Script injection, navigation waits, screenshots |
| `content/content.js` | Page reader with numbered elements, actions, in-place translation, image labels |
| `configure.py` | Sets the lock, builds `lantern.xpi` |
