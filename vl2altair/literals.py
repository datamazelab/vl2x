"""Render plain Python values (as produced by ``json.load``) into Python source text."""

from __future__ import annotations

import keyword

MAX_LINE = 88


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
