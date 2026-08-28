"""Render plain Python values (as produced by ``json.load``) into Python source text.

Identical to `vl2altair`'s own `literals.py` -- both projects render the same
kind of thing (a parsed-JSON value back into Python source), so there's no
matplotlib-specific reason for this to diverge.
"""

from __future__ import annotations

import keyword
import re

MAX_LINE = 88

_UNSAFE_IDENT_CHARS = re.compile(r"[^A-Za-z0-9_]")


def sanitize_identifier(name: str) -> str:
    """A *derived* output column name (e.g. `f"{op}_{field}"` for an
    aggregate/bin/timeUnit result) needs to double as a bare Python
    identifier wherever pandas' own named-aggregation syntax
    (`.agg(this_name=(col, func))`) uses it as a keyword argument, not just
    a string column label -- unlike a plain `data[field]` bracket lookup
    (fine with any string, spaces included), a keyword argument must be a
    syntactically valid identifier. Every non-identifier character (a
    space, `.`, `-`, ...) becomes `_`; a leading digit gets a `_` prefix
    (Python identifiers can't start with one)."""
    out = _UNSAFE_IDENT_CHARS.sub("_", name)
    if out and out[0].isdigit():
        out = f"_{out}"
    return out or "_"


_CSS_RGB_RE = re.compile(
    r"^\s*rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*(?:,\s*([\d.]+)\s*)?\)\s*$"
)


def _css_channel(component: str) -> float:
    if component.endswith("%"):
        return max(0.0, min(1.0, float(component[:-1]) / 100))
    return max(0.0, min(1.0, float(component) / 255))


def format_color_value(value: object) -> str:
    """Like `format_value`, but for a color literal specifically: Vega-Lite
    (CSS) spells full transparency as the color name `"transparent"`,
    matplotlib as the color name `"none"`. CSS's own function-call color
    syntax (`"rgb(167, 165, 156)"`, `"rgba(0, 0, 0, 0.5)"` -- 0-255 (or a
    `%`) per channel) is real, valid CSS a spec can use anywhere a color
    string is allowed, but matplotlib has no built-in parser for it at all
    (only hex codes, named colors, and its own `(r, g, b[, a])` *tuple* of
    0-1 floats) -- converted here into that tuple form. Everything else
    (hex codes, every named CSS color matplotlib already recognizes)
    passes through unchanged."""
    if value == "transparent":
        return "'none'"
    if isinstance(value, str):
        m = _CSS_RGB_RE.match(value)
        if m:
            r, g, b, a = m.groups()
            channels = [_css_channel(r), _css_channel(g), _css_channel(b)]
            if a is not None:
                channels.append(max(0.0, min(1.0, float(a))))
            return repr(tuple(channels))
    return format_value(value)


def is_safe_identifier(key: object) -> bool:
    """Whether ``key`` can be used as a literal ``name=value`` keyword argument."""
    return (
        isinstance(key, str)
        and key.isidentifier()
        and not keyword.iskeyword(key)
    )


def format_value(value: object, indent: int = 0) -> str:
    """Render a JSON-compatible Python value as Python source code.

    Dicts/lists are pretty-printed across multiple lines when the single-line
    form would be too long; short literals stay inline.
    """
    inline = _format_inline(value)
    if inline is not None and (len(inline) <= MAX_LINE - indent * 4 and "\n" not in inline):
        return inline
    return _format_multiline(value, indent)


def _format_inline(value: object) -> str | None:
    if isinstance(value, dict):
        if not value:
            return "{}"
        parts = []
        for k, v in value.items():
            iv = _format_inline(v)
            if iv is None:
                return None
            parts.append(f"{_format_inline(k)}: {iv}")
        return "{" + ", ".join(parts) + "}"
    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        parts = []
        for v in value:
            iv = _format_inline(v)
            if iv is None:
                return None
            parts.append(iv)
        return "[" + ", ".join(parts) + "]"
    return _format_scalar(value)


def _format_scalar(value: object) -> str:
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return repr(value)
    # Fallback for anything unexpected (should not normally happen for JSON data).
    return repr(value)


def _format_multiline(value: object, indent: int) -> str:
    pad = "    " * (indent + 1)
    closing_pad = "    " * indent
    if isinstance(value, dict):
        if not value:
            return "{}"
        lines = []
        for k, v in value.items():
            rendered = format_value(v, indent + 1)
            lines.append(f"{pad}{_format_inline(k)}: {rendered},")
        return "{\n" + "\n".join(lines) + f"\n{closing_pad}}}"
    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        lines = []
        for v in value:
            rendered = format_value(v, indent + 1)
            lines.append(f"{pad}{rendered},")
        return "[\n" + "\n".join(lines) + f"\n{closing_pad}]"
    return _format_scalar(value)


def try_black_format(source: str) -> str:
    """Best-effort formatting with ``black`` if it is installed; otherwise a no-op."""
    try:
        import black
    except ImportError:
        return source
    try:
        return black.format_str(source, mode=black.Mode())
    except Exception:
        return source
