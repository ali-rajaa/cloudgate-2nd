#!/usr/bin/env python3
"""Check every internal link in the built site.

Usage: python3 scripts/check-links.py _site [baseurl]

Fails (exit 1) if a link points at a page that wasn't built, or at an
#anchor that doesn't exist on its page. External, mailto and tel links
are not fetched.
"""
import html
import os
import re
import sys
from urllib.parse import unquote, urlparse

root = sys.argv[1] if len(sys.argv) > 1 else "_site"
baseurl = (sys.argv[2] if len(sys.argv) > 2 else "").rstrip("/")

pages = {}
for folder, _, files in os.walk(root):
    for name in files:
        if name.endswith(".html"):
            path = os.path.join(folder, name)
            with open(path, encoding="utf-8") as f:
                pages[path] = f.read()

ids = {path: set(re.findall(r'\sid="([^"]+)"', text)) for path, text in pages.items()}


def resolve(source, href):
    url = urlparse(href)
    path = unquote(url.path)
    if not path:
        target = source
    elif path.startswith("/"):
        if baseurl and (path == baseurl or path.startswith(baseurl + "/")):
            path = path[len(baseurl):] or "/"
        target = os.path.join(root, path.lstrip("/"))
    else:
        target = os.path.normpath(os.path.join(os.path.dirname(source), path))
    if os.path.isdir(target):
        target = os.path.join(target, "index.html")
    return target, url.fragment


broken = []
checked = 0
for source, text in pages.items():
    for href in re.findall(r'<a\s[^>]*href="([^"]+)"', text):
        href = html.unescape(href)
        if href.startswith(("http://", "https://", "mailto:", "tel:", "//")):
            continue
        checked += 1
        target, fragment = resolve(source, href)
        page = os.path.relpath(source, root)
        if not os.path.exists(target):
            broken.append(f"{page}: {href} (page not found)")
        elif fragment and fragment not in ids.get(target, set()):
            broken.append(f"{page}: {href} (no element with id '{fragment}')")

print(f"Checked {checked} internal links on {len(pages)} pages.")
if broken:
    print(f"{len(broken)} broken:")
    for line in broken:
        print(f"  {line}")
    sys.exit(1)
print("No broken links.")
