"""Helpers for rendering ``name(kw=val, ...)`` call expressions from dicts."""

from __future__ import annotations

from .literals import format_value, is_safe_identifier

# JSON keys that collide with Python keywords and have a documented Altair
# alias (used only for methods where we choose to emit named kwargs).
RESERVED_ALIASES = {"as": "as_", "from": "from_"}


def render_kwargs(kwargs: dict, indent: int = 1, rename: dict | None = None) -> str:
    """Render dict items as the inside of a call's argument list.

    Keys that are valid Python identifiers (and not reserved words) are
    emitted as ``name=value``. Any remaining keys are passed through a
    trailing ``**{...}`` so the call is always valid regardless of what
    keys a spec happens to contain.
    """
    rename = rename or {}
    named_parts = []
    unsafe = {}
    for key, value in kwargs.items():
        py_name = rename.get(key, key)
        if is_safe_identifier(py_name):
            named_parts.append((py_name, value))
        else:
            unsafe[key] = value

    pieces = []
    for name, value in named_parts:
        pieces.append(f"{name}={format_value(value, indent)}")
    if unsafe:
        pieces.append(f"**{format_value(unsafe, indent)}")
    return ", ".join(pieces)


def render_call(target: str, kwargs: dict, args: list | None = None, rename: dict | None = None) -> str:
    """Render ``target(arg1, arg2, kw=val, ...)`` as a single-line-or-wrapped string."""
    args = args or []
    arg_strs = [format_value(a) for a in args]
    kw_str = render_kwargs(kwargs, rename=rename) if kwargs else ""
    all_args = [a for a in arg_strs if a] + ([kw_str] if kw_str else [])
    joined = ", ".join(all_args)
    one_line = f"{target}({joined})"
    if len(one_line) <= 88 and "\n" not in one_line:
        return one_line
    # Expand onto multiple lines, one argument per line.
    parts = []
    for a in arg_strs:
        parts.append(a)
    if kwargs:
        rename = rename or {}
        named_parts = []
        unsafe = {}
        for key, value in kwargs.items():
            py_name = rename.get(key, key)
            if is_safe_identifier(py_name):
                named_parts.append((py_name, value))
            else:
                unsafe[key] = value
        for name, value in named_parts:
            parts.append(f"{name}={format_value(value, 1)}")
        if unsafe:
            parts.append(f"**{format_value(unsafe, 1)}")
    inner = ",\n    ".join(parts)
    return f"{target}(\n    {inner},\n)"


def render_call_kv(target: str, pairs: list[tuple[str, str]]) -> str:
    """Render ``target(key=value, ...)`` from a list of already-rendered
    ``(name, code)`` pairs (used e.g. for ``.encode(x=..., y=...)`` where the
    values are themselves ``alt.X(...)``-style expressions, not raw literals)."""
    if not pairs:
        return f"{target}()"
    inline = ", ".join(f"{k}={v}" for k, v in pairs)
    one_line = f"{target}({inline})"
    if len(one_line) <= 88 and "\n" not in one_line:
        return one_line
    body = ",\n    ".join(f"{k}={v}" for k, v in pairs)
    return f"{target}(\n    {body},\n)"
