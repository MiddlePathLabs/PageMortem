"""Optional real-Firefox smoke tests. Requires selenium and geckodriver.

Run with GECKODRIVER=/path/to/geckodriver FIREFOX_BINARY=/path/to/firefox \
    python tests/firefox_integration.py

This installs a freshly packaged extension into an isolated headless Firefox profile and
uses its own options page to call the real content script on local fixture pages.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service


ROOT = Path(__file__).resolve().parents[1]
PACKAGED = ("configure.py", "manifest.json", "background.js", "icons", "lib", "content", "sidebar", "options")
HALOGEN_ENDPOINT = os.environ.get("PAGEMORTEM_HALOGEN_ENDPOINT", "")


class Fixture:
    def __init__(self):
        self.requests = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def respond(self, body, status=200, mime="text/html", csp=""):
                self.send_response(status)
                self.send_header("Content-Type", mime)
                if csp:
                    self.send_header("Content-Security-Policy", csp)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                fixture.requests.append(("GET", self.path))
                if self.path == "/ping":
                    return self.respond(b"pong", mime="text/plain")
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", fixture.redirect_to)
                    return self.end_headers()
                body = f'''<!doctype html><html><body>
                  <a id="js" href="javascript:window.jsRan=true">Script link</a>
                  <a id="data" href="data:text/html,unsafe">Data link</a>
                  <a id="redirect" href="/redirect">Redirect link</a>
                  <button id="blobdl" onclick="setTimeout(()=>{{const u=window.URL.createObjectURL(new Blob(['{{&quot;a&quot;:1}}'],{{type:'application/json'}}));const a=document.createElement('a');a.href=u;a.download='wf.json';a.click();setTimeout(()=>window.URL.revokeObjectURL(u),1000)}},50)">Download workflow</button>
                  <a id="linkdl" href="data:application/json,%7B%7D" download="plain.json">Download plain</a>
                  <button id="mutate" onpointerdown="window.pointerRan=true;this.textContent='Changed'">Show more</button>
                  <form action="/submit" method="get"><input name="q" value="public">
                    <button id="cross" formaction="{fixture.cross_action}" formmethod="post">Submit elsewhere</button>
                  </form>
                  <article data-product-id="kettle-42"><h1>Blue kettle</h1><span id="stock">Out of stock</span>
                    <form action="/cart"><input type="hidden" name="sku" value="42">
                      <select name="variant"><option value="blue">Blue</option><option value="red">Red</option></select>
                      <button id="cart" disabled>Add to cart</button>
                    </form>
                  </article>
                </body></html>'''.encode()
                self.respond(body, csp="default-src 'self' 'unsafe-inline'" if self.path == "/csp" else "")

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                fixture.requests.append(("POST", self.path, body))
                self.respond(b"received")

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.cross_action = self.origin + "/receive"
        self.redirect_to = self.origin + "/landed"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FirefoxIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.first, cls.second = Fixture(), Fixture()
        cls.first.cross_action = cls.second.origin + "/receive"
        cls.first.redirect_to = cls.second.origin + "/landed"
        cls.temp = tempfile.TemporaryDirectory(prefix="pagemortem-firefox-")
        work = Path(cls.temp.name)
        for name in PACKAGED:
            src = ROOT / name
            if src.is_dir():
                shutil.copytree(src, work / name)
            else:
                shutil.copy2(src, work / name)
        origins = [cls.first.origin + "/v1"]
        if HALOGEN_ENDPOINT:
            origins.append(HALOGEN_ENDPOINT)
        subprocess.run([sys.executable, str(work / "configure.py"), *origins], check=True, capture_output=True)
        options = Options()
        options.binary_location = os.environ.get("FIREFOX_BINARY", "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox")
        options.add_argument("-headless")
        service = Service(os.environ.get("GECKODRIVER") or None, env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"})
        cls.driver = webdriver.Firefox(options=options, service=service)
        cls.driver.install_addon(str(work / "pagemortem.xpi"), temporary=True)
        cls.driver.set_context("chrome")
        uuids = json.loads(cls.driver.execute_script("return Services.prefs.getStringPref('extensions.webextensions.uuids')"))
        cls.driver.set_context("content")
        cls.uuid = uuids["pagemortem@middlepathlabs.local"]
        cls.driver.get(cls.first.origin + "/")
        cls.fixture_tab = cls.driver.current_window_handle
        cls.driver.switch_to.new_window("tab")
        cls.driver.get(f"moz-extension://{cls.uuid}/options/options.html")
        cls.extension_tab = cls.driver.current_window_handle
        cls.tab_id = cls.ext("const tabs=await browser.tabs.query({}); return tabs.find(t=>t.url.startsWith(arguments[0])).id", cls.first.origin)

    def setUp(self):
        self.driver.switch_to.window(self.fixture_tab)
        self.driver.get(self.first.origin + "/")
        self.ext("await browser.scripting.executeScript({target:{tabId:arguments[0]},files:['/content/content.js']}); return true", self.tab_id)

    @classmethod
    def tearDownClass(cls):
        cls.driver.quit()
        cls.temp.cleanup()
        cls.first.close()
        cls.second.close()

    @classmethod
    def ext(cls, code, *args):
        cls.driver.switch_to.window(cls.extension_tab)
        script = "const done=arguments[arguments.length-1]; (async()=>{" + code + "})().then(done,e=>done({error:String(e)}));"
        result = cls.driver.execute_async_script(script, *args)
        if isinstance(result, dict) and "error" in result:
            raise AssertionError(result["error"])
        return result

    @classmethod
    def page(cls, op, args=None):
        return cls.ext("return browser.tabs.sendMessage(arguments[0],{pagemortem:true,op:arguments[1],args:arguments[2]})", cls.tab_id, op, args or {})

    def id_for(self, label):
        read = self.page("readPage")
        match = re.search(r"\[(\d+) \w+ \"" + re.escape(label) + r"\"", read["text"])
        self.assertIsNotNone(match, read["text"])
        return int(match.group(1)), read["doc"]

    def test_manifest_permission_and_csp(self):
        self.assertTrue(self.ext("return browser.permissions.contains({origins:['<all_urls>']})"))
        allowed = self.ext("return fetch(arguments[0]+'/ping').then(r=>r.text())", self.first.origin)
        self.assertEqual(allowed, "pong")
        blocked = self.ext("return fetch(arguments[0]+'/ping').then(()=>false,()=>true)", self.second.origin)
        self.assertTrue(blocked, "extension-page CSP must block a second local port")

    def test_screenshot_capture_in_installed_extension(self):
        result = self.ext("""
          const tab=await browser.tabs.get(arguments[0]);
          await browser.tabs.update(tab.id,{active:true});
          const shot=await browser.tabs.captureVisibleTab(tab.windowId,{format:'png'});
          return {prefix:shot.slice(0,22),length:shot.length};
        """, self.tab_id)
        self.assertEqual(result["prefix"], "data:image/png;base64,")
        self.assertGreater(result["length"], 100)

    def test_restricted_browser_page_does_not_install_content_receiver(self):
        self.driver.switch_to.new_window("tab")
        handle = self.driver.current_window_handle
        try:
            self.driver.get("about:addons")
            blocked = self.ext("""
              const tabs=await browser.tabs.query({});
              const tab=tabs.find(t=>t.url==='about:addons');
              if (!tab) return 'page missing';
              try {
                const out=await browser.scripting.executeScript({target:{tabId:tab.id},files:['/content/content.js']});
                const ping=await browser.tabs.sendMessage(tab.id,{pagemortem:true,op:'ping',args:{}}).catch(e=>String(e));
                return {out,ping};
              } catch(e) { return {blocked:String(e)}; }
            """)
            # Firefox can resolve executeScript with [None] here; the extension must check the URL itself.
            self.assertEqual(blocked["out"], [None])
            self.assertIn("Receiving end does not exist", blocked["ping"])
        finally:
            self.driver.switch_to.window(handle)
            self.driver.close()

    def test_javascript_and_data_links_are_exposed_as_unsafe_destinations(self):
        for label, scheme in (("Script link", "javascript:"), ("Data link", "data:")):
            element_id, doc = self.id_for(label)
            info = self.page("describe", {"id": element_id, "doc": doc})
            self.assertTrue(info["href"].startswith(scheme), info)
        # A direct content-script click can execute a javascript: link: the agent gate is essential.
        element_id, doc = self.id_for("Script link")
        info = self.page("describe", {"id": element_id, "doc": doc})
        self.page("click", {"id": element_id, "doc": doc, "expect": info["fp"]})
        self.driver.switch_to.window(self.fixture_tab)
        self.assertTrue(self.driver.execute_script("return window.jsRan === true"))

    def test_pointer_handler_can_run_before_element_recheck(self):
        element_id, doc = self.id_for("Show more")
        info = self.page("describe", {"id": element_id, "doc": doc})
        with self.assertRaisesRegex(AssertionError, "changed before the action"):
            self.page("click", {"id": element_id, "doc": doc, "expect": info["fp"]})
        self.driver.switch_to.window(self.fixture_tab)
        self.assertTrue(self.driver.execute_script("return window.pointerRan === true"))

    def test_cart_context_survives_stock_change_but_not_variant_change(self):
        element_id, doc = self.id_for("Add to cart")
        before = self.page("describe", {"id": element_id, "doc": doc})
        self.assertTrue(before["cartContext"])
        self.driver.switch_to.window(self.fixture_tab)
        self.driver.execute_script("document.querySelector('#stock').textContent='In stock';document.querySelector('#cart').disabled=false")
        after = self.page("describe", {"id": element_id, "doc": doc})
        self.assertEqual(after["cartContext"], before["cartContext"])
        self.driver.switch_to.window(self.fixture_tab)
        self.driver.execute_script("document.querySelector('select[name=variant]').value='red'")
        changed = self.page("describe", {"id": element_id, "doc": doc})
        self.assertNotEqual(changed["cartContext"], before["cartContext"])

    def test_real_redirect_reaches_second_origin_before_a_landing_check(self):
        element_id, doc = self.id_for("Redirect link")
        info = self.page("describe", {"id": element_id, "doc": doc})
        self.page("click", {"id": element_id, "doc": doc, "expect": info["fp"]})
        deadline = time.time() + 3
        while time.time() < deadline:
            address = self.ext("return (await browser.tabs.get(arguments[0])).url", self.tab_id)
            if address.startswith(self.second.origin):
                break
            time.sleep(0.05)
        self.assertEqual(address, self.second.origin + "/landed")
        self.assertIn(("GET", "/landed"), self.second.requests)

    def test_formaction_override_and_real_cross_origin_submit(self):
        element_id, doc = self.id_for("Submit elsewhere")
        info = self.page("describe", {"id": element_id, "doc": doc})
        self.assertEqual(info["action"], self.second.origin + "/receive")
        self.assertEqual(info["formMethod"], "post")
        self.page("click", {"id": element_id, "doc": doc, "expect": info["fp"]})
        deadline = time.time() + 3
        while time.time() < deadline and not any(r[0] == "POST" for r in self.second.requests):
            time.sleep(0.05)
        self.assertTrue(any(r[0] == "POST" and r[1] == "/receive" for r in self.second.requests))

    @unittest.skipUnless(HALOGEN_ENDPOINT, "set PAGEMORTEM_HALOGEN_ENDPOINT for the live options-page check")
    def test_halogen_options_diagnostics_in_installed_extension(self):
        settings = {
            "endpoint": HALOGEN_ENDPOINT,
            "model": "halogen-v2-abliterated",
            "decisionEndpoint": HALOGEN_ENDPOINT,
            "decisionModel": "d3-lite",
            "decisionApi": "systemone",
            "rerankEndpoint": HALOGEN_ENDPOINT,
            "rerankModel": "qwen3-reranker-0.6b",
        }
        self.ext("""
          for (const [id, value] of Object.entries(arguments[0])) {
            const field = document.getElementById(id);
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return true;
        """, settings)
        lock = self.ext("return document.getElementById('lockStatus').textContent")
        self.assertIn("Network lock:", lock)
        for button, result in (("test", "testResult"), ("checkRerank", "rerankResult"),
                               ("checkDecision", "decisionResult"), ("checkDecisionImage", "decisionImageResult")):
            self.ext("document.getElementById(arguments[0]).click(); return true", button)
            deadline = time.time() + 90
            while time.time() < deadline:
                state = self.ext("""
                  const field = document.getElementById(arguments[0]);
                  return { busy: field.hasAttribute('aria-busy'), className: field.className, text: field.textContent };
                """, result)
                if not state["busy"]:
                    break
                time.sleep(0.1)
            self.assertFalse(state["busy"], f"{button} timed out")
            if button == "checkDecision":
                # A cautious threshold can make a legitimate model answer uncertain. That is a diagnostic result,
                # not an API failure and not an authorization to trigger a watch.
                self.assertIn("of 4", state["text"], state)
            else:
                self.assertIn("ok", state["className"], state)

    def test_download_capture_catches_blob_and_link_downloads(self):
        # Under a CSP like real download sites send, where fetching the blob: address itself is blocked.
        self.driver.switch_to.window(self.fixture_tab)
        self.driver.get(self.first.origin + "/csp")
        self.ext("await browser.scripting.executeScript({target:{tabId:arguments[0]},files:['/content/content.js']}); return true", self.tab_id)
        self.assertEqual(self.page("captureDownloads", {"on": True}), {"supported": True})
        for label in ("Download workflow", "Download plain"):
            el, doc = self.id_for(label)
            self.page("click", {"id": el, "doc": doc})
        got = self.ext(
            "const r=await browser.tabs.sendMessage(arguments[0],{pagemortem:true,op:'takeDownloads',args:{wait:3000}});"
            "return r.error ? r : r.files.map(f=>({name:f.name,released:!!f.released,href:f.href||'',size:f.bytes?f.bytes.byteLength:-1,"
            "text:f.bytes?new TextDecoder().decode(f.bytes):''}))",
            self.tab_id,
        )
        self.page("captureDownloads", {"on": False})
        self.assertEqual(sorted(f["name"] for f in got), ["plain.json", "wf.json"], got)
        for f in got:
            self.assertFalse(f["released"], got)
        self.assertEqual(next(f for f in got if f["name"] == "wf.json")["text"], '{"a":1}')

    def test_z_permission_revocation_stops_new_injection(self):
        removed = self.ext("return browser.permissions.remove({origins:['<all_urls>']})")
        if not removed:
            self.skipTest("this Firefox build did not permit programmatic revocation of the declared host permission")
        self.assertFalse(self.ext("return browser.permissions.contains({origins:['<all_urls>']})"))
        self.driver.switch_to.window(self.fixture_tab)
        self.driver.refresh()
        refused = self.ext("""
          try {
            await browser.scripting.executeScript({target:{tabId:arguments[0]},files:['/content/content.js']});
            return false;
          } catch { return true; }
        """, self.tab_id)
        self.assertTrue(refused)


if __name__ == "__main__":
    unittest.main()
