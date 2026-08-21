"""Translate top-level Vega-Lite ``params`` (and legacy ``selection``) into
``alt.selection_point`` / ``alt.selection_interval`` / ``alt.param`` calls."""

from __future__ import annotations

from .calls import render_kwargs


def render_param(param: dict) -> str:
    """Render one entry of the top-level ``params`` array as a Python expression."""
    select = param.get("select")

    if select is not None:
        select_dict = select if isinstance(select, dict) else {"type": select}
        select_type = select_dict.get("type", "point")
        func = "selection_interval" if select_type == "interval" else "selection_point"
        kwargs = {k: v for k, v in select_dict.items() if k != "type"}
        for extra in ("name", "value", "bind", "views"):
            if extra in param:
                kwargs[extra] = param[extra]
        rendered = render_kwargs(kwargs)
        return f"alt.{func}({rendered})"

    # Plain (non-selection) variable parameter.
    kwargs = {k: v for k, v in param.items()}
    rendered = render_kwargs(kwargs)
    return f"alt.param({rendered})"


def render_legacy_selection(name: str, definition: dict) -> str:
    """Render one entry of the deprecated top-level ``selection`` mapping."""
    sel_type = definition.get("type", "single")
    func = "selection_interval" if sel_type == "interval" else "selection_point"
    kwargs = {k: v for k, v in definition.items() if k != "type"}
    kwargs["name"] = name
    if sel_type == "multi":
        kwargs.setdefault("toggle", True)
    rendered = render_kwargs(kwargs)
    return f"alt.{func}({rendered})"
