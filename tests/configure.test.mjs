// configure.py, run for real in a temporary copy of the project. Skipped when no Python is installed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["configure.py", "manifest.json", "background.js", "icons", "lib", "content", "sidebar", "options"];
const python = ["python3", "python", "py"].find((p) => spawnSync(p, ["--version"]).status === 0);
const opts = { skip: !python && "Python not found" };

const made = [];
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pagemortem-"));
  made.push(dir);
  for (const s of SOURCES) fs.cpSync(path.join(ROOT, s), path.join(dir, s), { recursive: true });
  return dir;
}
const configure = (dir, ...args) => spawnSync(python, ["-I", path.join(dir, "configure.py"), ...args], { encoding: "utf8" });
const files = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => f.split(path.sep).join("/")).sort();
const csp = (manifestText) => JSON.parse(manifestText).content_security_policy.extension_pages;

/** Entry names and manifest of a built .xpi, read with Python's zipfile. */
function readXpi(file) {
  const code = "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'names': sorted(z.namelist()), 'manifest': z.read('manifest.json').decode()}))";
  return JSON.parse(spawnSync(python, ["-I", "-c", code, file], { encoding: "utf8" }).stdout);
}

test("configure.py locks build/ and the .xpi, and leaves the source manifest untouched", opts, () => {
  const dir = project();
  const source = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
  const r = configure(dir, "http://10.0.0.9:9000/v1", "http://10.0.0.8:9000");
  assert.equal(r.status, 0, r.stderr);

  assert.equal(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"), source, "source manifest unchanged");
  const built = fs.readFileSync(path.join(dir, "build", "manifest.json"), "utf8");
  assert.match(csp(built), /connect-src http:\/\/10\.0\.0\.8:9000 http:\/\/10\.0\.0\.9:9000;/);
  assert.equal(csp(built).replace(/connect-src [^;]*/, ""), csp(source).replace(/connect-src [^;]*/, ""), "rest of the CSP kept");

  const expected = files(dir).filter((f) => !f.startsWith("build/") && f !== "configure.py" && f !== "pagemortem.xpi");
  assert.deepEqual(files(path.join(dir, "build")), expected, "build/ holds exactly the extension's files");
  const xpi = readXpi(path.join(dir, "pagemortem.xpi"));
  assert.deepEqual(xpi.names, expected);
  assert.equal(xpi.manifest, built);
});

test("configure.py replaces build/ on every run", opts, () => {
  const dir = project();
  assert.equal(configure(dir, "http://10.0.0.9:9000").status, 0);
  fs.writeFileSync(path.join(dir, "build", "stale.js"), "old");
  assert.equal(configure(dir, "http://10.0.0.7:9000").status, 0);
  assert.ok(!fs.existsSync(path.join(dir, "build", "stale.js")));
  assert.match(csp(fs.readFileSync(path.join(dir, "build", "manifest.json"), "utf8")), /connect-src http:\/\/10\.0\.0\.7:9000;/);
});

test("configure.py writes canonical origins that match browser URL.origin", opts, () => {
  const dir = project();
  const r = configure(dir, "http://LOCALHOST:080/v1", "https://[FD00::1]:443/v1", "http://10.0.0.9:09000/v1");
  assert.equal(r.status, 0, r.stderr);
  const built = fs.readFileSync(path.join(dir, "build", "manifest.json"), "utf8");
  assert.match(csp(built), /connect-src http:\/\/10\.0\.0\.9:9000 http:\/\/localhost https:\/\/\[fd00::1\];/);
});

test("configure.py rejects a bad address before building anything", opts, () => {
  const dir = project();
  for (const bad of ["ftp://10.0.0.9", "http://user@evil.example", "http://a.example;script-src *", "http://10.0.0.9:99999", "https://api.openai.com/v1", "http://8.8.8.8:8000/v1"]) {
    const r = configure(dir, "http://10.0.0.9:9000", bad);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /^error:/, bad);
  }
  assert.ok(!fs.existsSync(path.join(dir, "build")));
  assert.ok(!fs.existsSync(path.join(dir, "pagemortem.xpi")));
});

test("configure.py rejects addresses that could add a second connect-src source", opts, () => {
  const dir = project();
  for (const bad of ["http://10.0.0.9:9000\f10.0.0.66", "http://10.0.0.9\v:9000", "http://10.0.0.9:9000 http://evil.example", "http://a b.example", "http://10.0.0.9;x", "http://u@10.0.0.9"]) {
    const r = configure(dir, bad);
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.ok(!fs.existsSync(path.join(dir, "build")), "nothing built");
  }
  assert.equal(configure(dir, "http://[fd00::5]:8080/v1").status, 0, "a bracketed IPv6 address is fine");
});
