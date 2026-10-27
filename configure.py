#!/usr/bin/env python3
"""Set PageMortem's network lock and build an installable pagemortem.xpi.

Usage:
    python configure.py http://192.168.1.50:8080/v1
    python configure.py http://192.168.1.50:8080 http://192.168.1.51:8000   # several servers

Rewrites the CSP `connect-src` in manifest.json so extension pages can reach only
these origins, then packages the extension as pagemortem.xpi next to this script.
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "manifest.json"
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


def set_lock(origins: list[str]) -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    csp: str = manifest["content_security_policy"]["extension_pages"]
    new_csp, n = re.subn(r"connect-src [^;]*", "connect-src " + " ".join(origins), csp)
    if n != 1:
        raise ValueError("manifest CSP must contain exactly one connect-src directive")
    manifest["content_security_policy"]["extension_pages"] = new_csp
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def build_xpi() -> None:
    with zipfile.ZipFile(XPI, "w", zipfile.ZIP_DEFLATED) as z:
        for name in PACKAGED:
            path = ROOT / name
            files = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
            for f in files:
                z.write(f, f.relative_to(ROOT).as_posix())


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    try:
        origins = sorted({to_origin(a) for a in argv})
        set_lock(origins)
        build_xpi()
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print("Network lock set to:", ", ".join(origins))
    print(f"Built {XPI.name}. Install it from about:addons (gear menu > Install Add-on From File).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
