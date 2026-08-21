"""Parse the official Vega-Lite example gallery's category structure
(H2 section > H3 subsection > example) from a cached copy of
https://vega.github.io/vega-lite/examples/, so the showcase landing page can
mirror the same organization/titles for every example name it recognizes.
"""
import html
import re
from pathlib import Path

REFERENCE_HTML = Path(__file__).parent / "vega_lite_gallery_reference.html"

_ITEM_RE = re.compile(
    r'<h2 id="[^"]*">(?P<h2>[^<]+)</h2>'
    r'|<h3 id="[^"]*">(?P<h3>.+?)</h3>'
    r'|<a class="imagegroup" href="/vega-lite/examples/(?P<name>[a-zA-Z0-9_.-]+)\.html">\s*'
    r'<span class="image"[^>]*></span>\s*'
    r'<span class="image-title">(?P<title>[^<]+)</span>',
    re.S,
)


def load_gallery_sections():
    """Returns (sections, name_to_title) where sections is an ordered list of
    {"h2": str, "subsections": [{"h3": str, "items": [name, ...]}]}."""
    page_html = REFERENCE_HTML.read_text()
    sections = []
    name_to_title = {}
    cur_section = None
    cur_sub = None
    for m in _ITEM_RE.finditer(page_html):
        if m.group("h2"):
            cur_section = {"h2": html.unescape(m.group("h2").strip()), "subsections": []}
            sections.append(cur_section)
            cur_sub = None
        elif m.group("h3"):
            if cur_section is None:
                continue
            title = re.sub("<[^>]+>", "", m.group("h3")).strip()
            cur_sub = {"h3": html.unescape(title), "items": []}
            cur_section["subsections"].append(cur_sub)
        elif m.group("name"):
            if cur_section is None:
                continue
            name = m.group("name")
            if cur_sub is None:
                cur_sub = {"h3": None, "items": []}
                cur_section["subsections"].append(cur_sub)
            if name not in cur_sub["items"]:
                cur_sub["items"].append(name)
            name_to_title.setdefault(name, html.unescape(m.group("title").strip()))
    return sections, name_to_title
