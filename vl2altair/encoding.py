"""Translate a Vega-Lite ``encoding`` object into ``alt.X(...)``-style expressions."""

from __future__ import annotations

from .calls import render_kwargs
from .literals import format_value


def _channel_class(key: str) -> str:
    return key[0].upper() + key[1:]


def _render_channel_def(key: str, value: object) -> str:
    cls = _channel_class(key)
    if isinstance(value, str):
        # Shorthand field name (rare in raw Vega-Lite JSON, but harmless to
        # support): treat it as the field itself.
        return f"alt.{cls}({format_value(value)})"
    if isinstance(value, dict):
        return f"alt.{cls}({render_kwargs(value)})"
    # Fallback for anything unexpected (e.g. a bare number/bool for a value
    # encoding shorthand) -- pass through as the positional argument.
    return f"alt.{cls}({format_value(value)})"


def render_channel(key: str, value: object) -> str:
    """Render a single ``encoding`` entry. ``value`` may be a dict or a list
    of dicts (valid for channels like ``detail``, ``tooltip``, ``order``)."""
    if isinstance(value, list):
        items = ", ".join(_render_channel_def(key, item) for item in value)
        return f"[{items}]"
    return _render_channel_def(key, value)


def render_encoding_kwargs(encoding: dict) -> dict:
    """Return ``{channel_name: rendered_expression}`` for use in ``.encode(...)``."""
    return {key: render_channel(key, value) for key, value in encoding.items()}
