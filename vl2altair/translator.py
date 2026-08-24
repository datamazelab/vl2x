"""Recursive translation of a Vega-Lite spec (dict) into Altair Python source."""

from __future__ import annotations

import keyword

from .calls import render_call_kv, render_kwargs
from .encoding import render_encoding_kwargs
from .literals import format_value, try_black_format
from .params import render_legacy_selection, render_param
from .transforms import render_transform_call

# Keys that describe *structure* (composition/spec-nesting) rather than a
# property that can be passed through Chart.properties(); these should never
# leak into a generic ``.properties(**leftover)`` call.
STRUCTURAL_KEYS = {
    "layer",
    "facet",
    "spec",
    "repeat",
    "hconcat",
    "vconcat",
    "concat",
    "$schema",
    "datasets",
}


class Emitter:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.dataset_vars: dict[str, str] = {}
        self._counts: dict[str, int] = {}
        self._data_var_cache: dict[int, str] = {}

    def new_var(self, hint: str) -> str:
        n = self._counts.get(hint, 0) + 1
        self._counts[hint] = n
        return hint if n == 1 else f"{hint}_{n}"

    def add_stmt(self, line: str) -> None:
        self.lines.append(line)


def _sanitize_identifier(name: object, fallback: str) -> str:
    if isinstance(name, str) and name.isidentifier() and not keyword.iskeyword(name):
        return name
    return fallback


def _hoist_datasets(datasets: dict, emitter: Emitter) -> None:
    for name, values in datasets.items():
        hint = _sanitize_identifier(name, "dataset")
        var = emitter.new_var(hint)
        emitter.add_stmt(f"{var} = {format_value(values)}")
        emitter.dataset_vars[name] = var


def _render_data(data: object, emitter: Emitter, hint: str) -> str | None:
    """Render a Vega-Lite ``data`` value into a Python expression.

    Every dict-shaped data value is hoisted into its own variable rather than
    inlined, and repeated calls for the *same* dict object (by identity) reuse
    the same variable. This matters because Altair's own logic for
    consolidating identical data across layer/concat/facet children
    (``_combine_subchart_data``) checks object identity, not equality -- and
    since ``_merge_down`` shares (rather than copies) a wrapper's ``data``
    dict across its children, giving each occurrence the same Python object
    here lets that consolidation succeed instead of silently failing.
    """
    if data is None:
        return None
    if isinstance(data, dict):
        cached = emitter._data_var_cache.get(id(data))
        if cached is not None:
            return cached
        if set(data.keys()) == {"name"} and data["name"] in emitter.dataset_vars:
            rendered = f'{{"values": {emitter.dataset_vars[data["name"]]}}}'
        else:
            rendered = format_value(data)
        var = emitter.new_var(hint)
        emitter.add_stmt(f"{var} = {rendered}")
        emitter._data_var_cache[id(data)] = var
        return var
    return format_value(data)


def _merge_down(child: dict, wrapper: dict, merge_encoding: bool) -> dict:
    """Push wrapper-level ``data``/``transform`` (and, for layers, ``encoding``)
    down into a composition child so each child can be translated as if it
    were fully self-contained."""
    child = dict(child)
    if "data" not in child and "data" in wrapper:
        child["data"] = wrapper["data"]
    if "transform" in wrapper:
        child["transform"] = list(wrapper["transform"]) + list(child.get("transform", []))
    if merge_encoding and "encoding" in wrapper:
        merged_enc = dict(wrapper["encoding"])
        merged_enc.update(child.get("encoding", {}))
        child["encoding"] = merged_enc
    return child


def _apply_common(varname: str, spec: dict, emitter: Emitter, consumed: set) -> None:
    """Apply transform/params/resolve/projection/config, and route anything
    left over through a generic ``.properties(**leftover)`` call."""
    if "transform" in spec:
        for t in spec["transform"]:
            call = render_transform_call(t)
            if call is None:
                emitter.add_stmt(
                    f"{varname}.transform = list({varname}.transform "
                    f"if {varname}.transform is not alt.Undefined else []) + "
                    f"[{format_value(t)}]"
                )
            else:
                emitter.add_stmt(f"{varname} = {varname}.{call}")
        consumed.add("transform")

    param_vars = []
    if "params" in spec:
        for p in spec["params"]:
            pv = emitter.new_var("param")
            emitter.add_stmt(f"{pv} = {render_param(p)}")
            param_vars.append(pv)
        consumed.add("params")
    if "selection" in spec:
        for name, definition in spec["selection"].items():
            pv = emitter.new_var("param")
            emitter.add_stmt(f"{pv} = {render_legacy_selection(name, definition)}")
            param_vars.append(pv)
        consumed.add("selection")
    if param_vars:
        emitter.add_stmt(f"{varname} = {varname}.add_params({', '.join(param_vars)})")

    if "resolve" in spec:
        resolve = spec["resolve"]
        for kind in ("scale", "axis", "legend"):
            if kind in resolve:
                emitter.add_stmt(
                    f"{varname} = {varname}.resolve_{kind}({render_kwargs(resolve[kind])})"
                )
        consumed.add("resolve")

    if "projection" in spec:
        emitter.add_stmt(f"{varname} = {varname}.project({render_kwargs(spec['projection'])})")
        consumed.add("projection")

    if "config" in spec:
        emitter.add_stmt(f"{varname} = {varname}.configure({render_kwargs(spec['config'])})")
        consumed.add("config")

    leftover = {k: v for k, v in spec.items() if k not in consumed and k not in STRUCTURAL_KEYS}
    if leftover:
        emitter.add_stmt(f"{varname} = {varname}.properties({render_kwargs(leftover)})")


def _translate_unit(spec: dict, emitter: Emitter, hint: str) -> str:
    varname = emitter.new_var(hint)
    data_hint = "source" if hint == "chart" else f"{hint}_data"
    data_expr = _render_data(spec.get("data"), emitter, data_hint)
    emitter.add_stmt(f"{varname} = alt.Chart({data_expr or ''})")
    consumed = {"data"}

    if "mark" in spec:
        mark = spec["mark"]
        if isinstance(mark, str):
            mtype, mkwargs = mark, {}
        else:
            mark = dict(mark)
            mtype = mark.pop("type")
            mkwargs = mark
        emitter.add_stmt(f"{varname} = {varname}.mark_{mtype}({render_kwargs(mkwargs)})")
        consumed.add("mark")

    if "encoding" in spec:
        enc_kwargs = render_encoding_kwargs(spec["encoding"])
        emitter.add_stmt(render_call_kv(f"{varname} = {varname}.encode", list(enc_kwargs.items())))
        consumed.add("encoding")

    _apply_common(varname, spec, emitter, consumed)
    return varname


def _translate_layer(spec: dict, emitter: Emitter, hint: str) -> str:
    wrapper = spec
    base_hint = "layer" if hint == "chart" else hint
    children_vars = [
        translate_spec(_merge_down(child, wrapper, merge_encoding=True), emitter, f"{base_hint}{i}")
        for i, child in enumerate(wrapper["layer"], start=1)
    ]
    varname = emitter.new_var(hint)
    emitter.add_stmt(f"{varname} = alt.layer({', '.join(children_vars)})")
    consumed = {"layer", "data", "transform", "encoding"}
    _apply_common(varname, wrapper, emitter, consumed)
    return varname


def _translate_multi(spec: dict, emitter: Emitter, hint: str, key: str, func: str) -> str:
    wrapper = spec
    base_hint = key if hint == "chart" else hint
    children_vars = [
        translate_spec(_merge_down(child, wrapper, merge_encoding=False), emitter, f"{base_hint}{i}")
        for i, child in enumerate(wrapper[key], start=1)
    ]
    varname = emitter.new_var(hint)
    emitter.add_stmt(f"{varname} = {func}({', '.join(children_vars)})")
    consumed = {key, "data", "transform"}
    _apply_common(varname, wrapper, emitter, consumed)
    return varname


def _translate_facet(spec: dict, emitter: Emitter, hint: str) -> str:
    wrapper = spec
    child_hint = "view" if hint == "chart" else f"{hint}_view"
    child = _merge_down(wrapper["spec"], wrapper, merge_encoding=False)
    child_var = translate_spec(child, emitter, child_hint)

    facet_val = wrapper["facet"]
    fkwargs: dict = {}
    if isinstance(facet_val, dict) and ("row" in facet_val or "column" in facet_val):
        if "row" in facet_val:
            fkwargs["row"] = facet_val["row"]
        if "column" in facet_val:
            fkwargs["column"] = facet_val["column"]
    else:
        fkwargs["facet"] = facet_val
    if "columns" in wrapper:
        fkwargs["columns"] = wrapper["columns"]

    varname = emitter.new_var(hint)
    emitter.add_stmt(f"{varname} = {child_var}.facet({render_kwargs(fkwargs)})")
    consumed = {"facet", "spec", "data", "transform", "columns"}
    _apply_common(varname, wrapper, emitter, consumed)
    return varname


def _translate_repeat(spec: dict, emitter: Emitter, hint: str) -> str:
    wrapper = spec
    child_hint = "view" if hint == "chart" else f"{hint}_view"
    child = _merge_down(wrapper["spec"], wrapper, merge_encoding=False)
    child_var = translate_spec(child, emitter, child_hint)

    repeat_val = wrapper["repeat"]
    rkwargs: dict = {}
    if isinstance(repeat_val, list):
        rkwargs["repeat"] = repeat_val
    else:
        for k in ("row", "column", "layer"):
            if k in repeat_val:
                rkwargs[k] = repeat_val[k]
    if "columns" in wrapper:
        rkwargs["columns"] = wrapper["columns"]

    varname = emitter.new_var(hint)
    emitter.add_stmt(f"{varname} = {child_var}.repeat({render_kwargs(rkwargs)})")
    consumed = {"repeat", "spec", "data", "transform", "columns"}
    _apply_common(varname, wrapper, emitter, consumed)
    return varname


def translate_spec(spec: dict, emitter: Emitter, hint: str = "chart") -> str:
    spec = dict(spec)
    spec.pop("$schema", None)

    if "layer" in spec:
        return _translate_layer(spec, emitter, hint)
    if "facet" in spec and "spec" in spec:
        return _translate_facet(spec, emitter, hint)
    if "repeat" in spec and "spec" in spec:
        return _translate_repeat(spec, emitter, hint)
    if "hconcat" in spec:
        return _translate_multi(spec, emitter, hint, "hconcat", "alt.hconcat")
    if "vconcat" in spec:
        return _translate_multi(spec, emitter, hint, "vconcat", "alt.vconcat")
    if "concat" in spec:
        return _translate_multi(spec, emitter, hint, "concat", "alt.concat")
    return _translate_unit(spec, emitter, hint)


def spec_to_code(spec: dict, chart_var: str = "chart", format_with_black: bool = True) -> str:
    """Translate a full Vega-Lite JSON spec (as a Python dict) into a
    standalone Altair Python script (as a string)."""
    emitter = Emitter()
    root = dict(spec)
    root.pop("$schema", None)
    datasets = root.pop("datasets", None)
    if datasets:
        _hoist_datasets(datasets, emitter)

    varname = translate_spec(root, emitter, chart_var)

    # A provenance header: this file is machine-generated from a Vega-Lite
    # spec, not hand-written -- re-run the translator (with the same
    # arguments shown here) after the source spec changes, rather than
    # hand-editing this output and losing that round-trip.
    header_comment = (
        f"# Generated by vl2altair.vegalite_to_altair_code(spec, "
        f"chart_var={chart_var!r}, format_with_black={format_with_black!r})"
    )
    lines = [header_comment, "import altair as alt", ""]
    lines.extend(emitter.lines)
    if varname != chart_var:
        lines.append(f"{chart_var} = {varname}")
    lines.append("")
    lines.append(chart_var)

    code = "\n".join(lines) + "\n"
    if format_with_black:
        code = try_black_format(code)
    return code
