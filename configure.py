#!/usr/bin/env python3
"""Lock PageMortem to your model server(s) and build it.

Usage:
    python configure.py http://192.168.1.50:8080/v1
    python configure.py http://192.168.1.50:8080 http://192.168.1.51:8000   # several servers

Copies the extension into build/ with the CSP `connect-src` set so extension pages can
reach only these origins, then packages that copy as pagemortem.xpi next to this script.
The source manifest.json is never changed, so your server address stays out of git.
build/ is replaced on every run.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "manifest.json"
BUILD = ROOT / "build"
XPI = ROOT / "pagemortem.xpi"
PACKAGED = ("manifest.json", "background.js", "icons", "lib", "content", "sidebar", "options")


def to_origin(url: str) -> str:
    raw = url.strip()
    parts = urlsplit(raw if "://" in raw else f"http://{raw}")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"not an http(s) URL: {url!r}")
    if any(c in parts.netloc for c in " ;'*@"):
        raise ValueError(f"invalid characters in {url!r}")
    return f"{parts.scheme}://{parts.netloc}"


def locked_manifest(origins: list[str]) -> str:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    csp: str = manifest["content_security_policy"]["extension_pages"]
    new_csp, n = re.subn(r"connect-src [^;]*", "connect-src " + " ".join(origins), csp)
    if n != 1:
        raise ValueError("manifest CSP must contain exactly one connect-src directive")
    manifest["content_security_policy"]["extension_pages"] = new_csp
    return json.dumps(manifest, indent=2) + "\n"


def build(manifest: str) -> None:
    if BUILD.exists():
        shutil.rmtree(BUILD)
    for name in PACKAGED:
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, BUILD / name)
        else:
            BUILD.mkdir(exist_ok=True)
            shutil.copy2(src, BUILD / name)
    (BUILD / "manifest.json").write_text(manifest, encoding="utf-8")


def build_xpi() -> None:
    with zipfile.ZipFile(XPI, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(p for p in BUILD.rglob("*") if p.is_file()):
            z.write(f, f.relative_to(BUILD).as_posix())


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    try:
        origins = sorted({to_origin(a) for a in argv})
        manifest = locked_manifest(origins)  # validate everything before touching build/
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    build(manifest)
    build_xpi()
    print("Network lock set to:", ", ".join(origins))
    print(f"Built {BUILD.name}/ and {XPI.name}. Install the .xpi from about:addons (gear menu > Install Add-on From File),")
    print(f"or load {BUILD.name}/manifest.json from about:debugging. Re-run this after changing the code.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
