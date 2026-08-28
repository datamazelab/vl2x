"""Recursive-ish translation of a Vega-Lite spec into a standalone Python/
matplotlib script.

Scope: single unit view, `layer` (children drawn onto one shared `Axes`),
`hconcat`/`vconcat`/`concat` (a `plt.subplots()` grid, one child per panel
-- panel count is known at translation time straight from the spec's own
JSON array), `facet` (also a `plt.subplots()` grid, but the panel *count*
is only known once the real data has loaded -- generated as a runtime loop
over the distinct facet values instead of unrolled at translation time),
and `repeat` (a `plt.subplots()` grid too, same as `hconcat`/`vconcat`/
`concat` -- the repeated field *names* are known at translation time from
the spec's own `repeat` array/object, unlike `facet`'s data-dependent
panel count -- with each panel's own template field substituted per
`_substitute_repeat_refs()`; `repeat: {layer: [...]}` instead becomes N
layers sharing one `Axes`, reusing `translate_layer()`, since Vega-Lite's
own semantics for a `layer`-repeat is "layer, not grid," unlike its
`row`/`column`/plain-array forms).
"""

from __future__ import annotations

import re

from .data import render_data_load, render_quantitative_coercion, render_temporal_coercion
from .literals import try_black_format
from .marks import render_mark
from .prepare import prepare_encoding
from .stack import apply_stacking_to_encoding, plan_stacking, render_stacking_statements
from .timeunit import timeunit_expr
from .transforms import render_transforms

STRUCTURAL_KEYS = {"layer", "facet", "spec", "repeat", "hconcat", "vconcat", "concat", "$schema", "datasets"}
_POSITION_LIKE = ["x", "y", "x2", "y2", "color", "size", "opacity", "shape", "detail", "text"]


_RUNTIME_CALL_RE = re.compile(r"\bvl_\w+(?=\()")


class Emitter:
    def __init__(self, include_source_paths: bool = False) -> None:
        self.lines: list[str] = []
        self._counts: dict[str, int] = {}
        self.include_source_paths = include_source_paths
        self.uses_math = False
        # Every `vl2matplotlib.runtime` helper function (`vl_window`, ...)
        # a generated statement actually calls -- auto-detected the same
        # way `uses_math` is, so `spec_to_code()`'s own header only ever
        # imports the ones a given script genuinely needs, matching
        # `vl2ggplot`'s identical conditional `library(vl2ggplot)` header
        # logic for its own shared runtime helpers.
        self.uses_runtime: set[str] = set()

    def new_var(self, hint: str) -> str:
        n = self._counts.get(hint, 0) + 1
        self._counts[hint] = n
        return hint if n == 1 else f"{hint}{n}"

    def add_stmt(self, line: str, path: str | None = None) -> None:
        if self.include_source_paths and path:
            self.lines.append(f"# from: {path}")
        self.lines.append(line)
        if "math." in line:
            self.uses_math = True
        self.uses_runtime.update(_RUNTIME_CALL_RE.findall(line))


def _resolve_dataset_refs(node: dict, datasets: dict) -> dict:
    node = dict(node)
    data = node.get("data")
    if isinstance(data, dict) and data.get("name") in datasets:
        rest = {k: v for k, v in data.items() if k != "name"}
        node["data"] = {"values": datasets[data["name"]], **rest}
    for key in ("layer", "hconcat", "vconcat", "concat"):
        if key in node:
            node[key] = [_resolve_dataset_refs(c, datasets) for c in node[key]]
    if "spec" in node:
        node["spec"] = _resolve_dataset_refs(node["spec"], datasets)
    return node


# A `calculate`/`filter` expression's own date-component function
# (`year(datum.Year)`, ...) needs `datum.Year` to already be a real
# `Timestamp` by the time it runs -- caught here (before `expr.py`'s own
# translation, which only sees `row[...]`, not the original field name in
# isolation) so `_collect_temporal_fields` also coerces a field that's
# *never* used as a `temporal`-typed encoding channel but only read through
# one of these.
_EXPR_DATE_COMPONENT_FIELD_RE = re.compile(
    r"\b(?:year|quarter|month|date|day|dayofyear|hours|minutes|seconds|milliseconds)\(\s*datum\.([A-Za-z_][A-Za-z0-9_]*)"
)


def _derived_field_names(transform_list: list) -> set[str]:
    """Every field name a top-level `transform` entry *produces* (its own
    `as`) rather than reads -- needed by both `_collect_temporal_fields()`
    and `_collect_quantitative_fields()` so neither tries to coerce a
    column *before* the transform that creates it has even run (a
    `KeyError`, since the column doesn't exist yet at that point in the
    generated script). Most transform types keep `as` at their own top
    level (`calculate`/`bin`/a transform-level `timeUnit`); `aggregate`,
    `window`, and `joinaggregate` are the shapes that don't -- each one's
    own `as` lives one level down, inside each entry of its own list
    (`{op, field, as}`), not on the transform dict itself."""
    names: set[str] = set()
    for t in transform_list or []:
        if isinstance(t.get("as"), str):
            names.add(t["as"])
        elif isinstance(t.get("as"), list):
            names.update(a for a in t["as"] if isinstance(a, str))
        for key in ("aggregate", "window", "joinaggregate"):
            for item in t.get(key) or []:
                if isinstance(item, dict) and isinstance(item.get("as"), str):
                    names.add(item["as"])
    return names


def _collect_temporal_fields(encoding: dict, transform_list: list) -> list[str]:
    # A field a top-level `transform` entry *produces* (its own `as`) is
    # never a raw column needing `pd.to_datetime()` coercion -- a
    # `calculate`/`aggregate`/`bin` result is never a date string, and a
    # `timeUnit` transform's own result is already whatever `timeunit_expr()`
    # produced (a plain int for a cyclic single-component unit like
    # `"month"`, a real `pd.Timestamp` -- already a Timestamp, not a string
    # -- for a combined unit). An encoding channel that names one of these
    # (e.g. `x: {field: "month", type: "temporal"}` reading a `timeUnit:
    # "month"` transform's own output) would otherwise get coerced *before*
    # the transform that creates it has even run, a `KeyError`.
    derived_fields = _derived_field_names(transform_list)

    fields = []
    for ch in _POSITION_LIKE:
        d = encoding.get(ch)
        if isinstance(d, dict) and d.get("field") and d["field"] not in derived_fields:
            if d.get("type") == "temporal" or d.get("timeUnit"):
                fields.append(d["field"])
    for t in transform_list or []:
        if "timeUnit" in t and t.get("field"):
            fields.append(t["field"])
        for key in ("calculate", "filter"):
            val = t.get(key)
            if isinstance(val, str):
                fields += _EXPR_DATE_COMPONENT_FIELD_RE.findall(val)
    return sorted(set(fields))


def _collect_quantitative_fields(encoding: dict, transform_list: list) -> list[str]:
    """A `type: "quantitative"` channel's own raw JSON value is sometimes a
    *string* (`"p": "0.14"`, not `0.14`) -- a real shape seen in this
    corpus's own export-style data. Vega-Lite coerces this implicitly from
    the declared type; this translator needs to do the same explicitly
    (`pd.to_numeric()`, mirroring `_collect_temporal_fields()`'s identical
    `pd.to_datetime()` coercion for `temporal`), or downstream arithmetic
    (an implicit `aggregate`, `stack.py`'s own `cumsum()`, a bare `-`/`+` in
    a `calculate` expression) fails outright on the string dtype instead of
    computing on numbers."""
    derived_fields = _derived_field_names(transform_list)
    fields = []
    for ch in _POSITION_LIKE:
        d = encoding.get(ch)
        if isinstance(d, dict) and d.get("field") and d["field"] not in derived_fields and d.get("type") == "quantitative":
            fields.append(d["field"])
    return sorted(set(fields))


def _mark_channels_comment(path: str, mark_path_suffix: str, encoding: dict) -> str:
    parts = [f"{path}{mark_path_suffix}"] + [f"{path}encoding.{ch}" for ch in encoding]
    return ", ".join(parts)


def translate_unit(node: dict, emitter: Emitter, hint: str, ax_var: str, ignore_unsupported: bool = False, path: str = "", data_param: str | None = None) -> str:
    """Draws one unit view's own mark onto an *existing* `ax_var` (created
    by whichever caller decided the subplot layout -- `translate_top()` for
    a standalone/layer chart, or the facet/concat panel-building code
    below). Returns the `data_var` this view's own (post-transform)
    DataFrame ended up in, in case a caller needs it (facet's own per-panel
    filtering)."""
    if data_param is not None:
        data_var = data_param
    else:
        data_var = emitter.new_var(f"{hint}_data")
        for s in render_data_load(node.get("data"), data_var, ignore_unsupported):
            emitter.add_stmt(s, path=f"{path}data")

    temporal_fields = _collect_temporal_fields(node.get("encoding", {}), node.get("transform") or [])
    for s in render_temporal_coercion(data_var, temporal_fields):
        emitter.add_stmt(s)
    quantitative_fields = _collect_quantitative_fields(node.get("encoding", {}), node.get("transform") or [])
    for s in render_quantitative_coercion(data_var, quantitative_fields):
        emitter.add_stmt(s)

    transform_list = node.get("transform")
    if transform_list:
        transform_stmts = render_transforms(transform_list, data_var, ignore_unsupported)
        if transform_stmts:
            emitter.add_stmt(transform_stmts[0], path=f"{path}transform")
            for s in transform_stmts[1:]:
                emitter.add_stmt(s)

    encoding = node.get("encoding", {}) or {}
    prep_stmts, encoding = prepare_encoding(encoding, data_var, ignore_unsupported)
    for s in prep_stmts:
        emitter.add_stmt(s)

    mark = node["mark"]
    plan = plan_stacking(mark, encoding)
    if plan:
        for s in render_stacking_statements(data_var, plan):
            emitter.add_stmt(s)
        encoding = apply_stacking_to_encoding(encoding, plan)

    mark_stmts = render_mark(mark, encoding, data_var, ax_var, ignore_unsupported)
    if mark_stmts:
        emitter.add_stmt(mark_stmts[0], path=_mark_channels_comment(path, "mark", encoding))
        for s in mark_stmts[1:]:
            emitter.add_stmt(s)

    title = node.get("title")
    if isinstance(title, str):
        emitter.add_stmt(f"{ax_var}.set_title({title!r})")
    elif isinstance(title, dict) and isinstance(title.get("text"), str):
        emitter.add_stmt(f"{ax_var}.set_title({title['text']!r})")

    return data_var


def translate_layer(node: dict, emitter: Emitter, hint: str, ax_var: str, ignore_unsupported: bool = False, path: str = "", data_param: str | None = None) -> None:
    for i, child in enumerate(node["layer"]):
        merged = _merge_down(child, node)
        # A child lacking its own `data` inherits the wrapper's -- when
        # `data_param` is set (this whole layer is itself a facet/repeat
        # panel template), that inherited data is *already* the
        # pre-filtered, pre-loaded panel DataFrame, so this child reuses it
        # directly rather than re-loading (or, worse, finding no `data` key
        # at all, since the facet/repeat caller deliberately strips it off
        # the template before this ever runs).
        child_data_param = data_param if data_param is not None and "data" not in child else None
        # A layer child can itself be a nested `layer` composition (a
        # "layer of layers", e.g. layer_bar_annotations.vl.json's own
        # `{data, layer: [...]}` child with no `mark` of its own at all) --
        # `_draw_unit_or_layer()` recurses into `translate_layer()` again
        # for exactly that shape, rather than this loop assuming every
        # child is always a plain unit view.
        _draw_unit_or_layer(merged, emitter, f"{hint}{i + 1}", ax_var, ignore_unsupported, f"{path}layer[{i}].", data_param=child_data_param)


def _merge_down(child: dict, wrapper: dict) -> dict:
    child = dict(child)
    if "data" not in child and wrapper.get("data") is not None:
        child["data"] = wrapper["data"]
    if wrapper.get("transform"):
        child["transform"] = list(wrapper["transform"]) + list(child.get("transform", []))
    if "encoding" in wrapper:
        merged_enc = dict(wrapper["encoding"])
        merged_enc.update(child.get("encoding", {}))
        child["encoding"] = merged_enc
    return child


def _draw_unit_or_layer(node: dict, emitter: Emitter, hint: str, ax_var: str, ignore_unsupported: bool, path: str, data_param: str | None = None) -> None:
    if "layer" in node:
        translate_layer(node, emitter, hint, ax_var, ignore_unsupported, path, data_param=data_param)
        return
    for key in ("repeat", "facet", "hconcat", "vconcat", "concat"):
        if key in node:
            if ignore_unsupported:
                emitter.add_stmt(f"# vl2matplotlib: a nested {key!r} composition here is not yet supported by vl2matplotlib, skipped (ignore_unsupported)")
                return
            raise ValueError(f"Unsupported: a nested {key!r} composition inside {hint!r} is not yet supported by vl2matplotlib")
    translate_unit(node, emitter, hint, ax_var, ignore_unsupported, path=path, data_param=data_param)


def _panel_size(spec: dict) -> tuple[float, float]:
    w = spec.get("width")
    h = spec.get("height")
    return (
        max(1.5, min(14.0, w / 96)) if isinstance(w, (int, float)) else 6.0,
        max(1.5, min(14.0, h / 96)) if isinstance(h, (int, float)) else 4.0,
    )


def translate_facet(node: dict, emitter: Emitter, hint: str, ignore_unsupported: bool = False, path: str = "") -> str:
    facet_def = node["facet"]
    if not isinstance(facet_def, dict) or not facet_def.get("field"):
        if ignore_unsupported:
            facet_def = None
        else:
            raise ValueError("Unsupported: facet row/column form is not yet supported by vl2matplotlib (a plain field-based `facet` is)")

    data_var = emitter.new_var(f"{hint}_data")
    for s in render_data_load(node.get("data"), data_var, ignore_unsupported):
        emitter.add_stmt(s, path=f"{path}data")
    temporal_fields = _collect_temporal_fields({}, node.get("transform") or [])
    if facet_def and (facet_def.get("type") == "temporal" or facet_def.get("timeUnit")):
        temporal_fields.append(facet_def["field"])
    for s in render_temporal_coercion(data_var, sorted(set(temporal_fields))):
        emitter.add_stmt(s)
    if node.get("transform"):
        transform_stmts = render_transforms(node["transform"], data_var, ignore_unsupported)
        if transform_stmts:
            emitter.add_stmt(transform_stmts[0], path=f"{path}transform")
            for s in transform_stmts[1:]:
                emitter.add_stmt(s)

    if facet_def is None:
        # ignore_unsupported fallback: draw the template once, unsplit.
        fig_v = emitter.new_var("fig")
        ax_v = emitter.new_var("ax")
        w, h = _panel_size(node["spec"])
        emitter.add_stmt(f"{fig_v}, {ax_v} = plt.subplots(figsize=({w}, {h}))")
        emitter.add_stmt("# vl2matplotlib: unsupported facet shape, rendering the template unsplit (ignore_unsupported)")
        child = _merge_down(node["spec"], {"data": None, "transform": None})
        _draw_unit_or_layer(child, emitter, hint, ax_v, ignore_unsupported, f"{path}spec.")
        return fig_v

    field = facet_def["field"]
    if facet_def.get("timeUnit"):
        out = f"{facet_def['timeUnit'] if isinstance(facet_def['timeUnit'], str) else facet_def['timeUnit']['unit']}_{field}"
        expr = timeunit_expr(facet_def["timeUnit"], f"row[{field!r}]")
        emitter.add_stmt(f"{data_var}[{out!r}] = {data_var}.apply(lambda row: {expr}, axis=1)")
        field = out

    cats_var = emitter.new_var("__facet_vals")
    emitter.add_stmt(f"{cats_var} = sorted({data_var}[{field!r}].dropna().unique().tolist(), key=str)")
    columns = node.get("columns")
    ncols_expr = str(columns) if isinstance(columns, int) else f"len({cats_var})"
    fig_v = emitter.new_var("fig")
    axes_v = emitter.new_var("axes")
    w, h = _panel_size(node["spec"])
    if isinstance(columns, int):
        emitter.add_stmt(
            f"{fig_v}, {axes_v} = plt.subplots(-(-len({cats_var}) // {ncols_expr}), {ncols_expr}, "
            f"figsize=({w} * {ncols_expr}, {h} * (-(-len({cats_var}) // {ncols_expr}))), squeeze=False)"
        )
    else:
        emitter.add_stmt(f"{fig_v}, {axes_v} = plt.subplots(1, {ncols_expr}, figsize=({w} * {ncols_expr}, {h}), squeeze=False)")

    template = _merge_down(node["spec"], {})
    template.pop("data", None)
    template.pop("transform", None)

    fi = emitter.new_var("__fi")
    fv = emitter.new_var("__fv")
    emitter.add_stmt(f"for {fi}, {fv} in enumerate({cats_var}):")
    inner = Emitter(emitter.include_source_paths)
    panel_data = inner.new_var(f"{hint}_panel")
    ncols_runtime = ncols_expr if isinstance(columns, int) else f"len({cats_var})"
    ax_v = f"{axes_v}_ax"
    inner.add_stmt(f"{ax_v} = {axes_v}[{fi} // {ncols_runtime}][{fi} % {ncols_runtime}]")
    inner.add_stmt(f"{panel_data} = {data_var}[{data_var}[{field!r}] == {fv}].copy()")
    _draw_unit_or_layer(template, inner, hint, ax_v, ignore_unsupported, f"{path}spec.", data_param=panel_data)
    inner.add_stmt(f"{ax_v}.set_title(str({fv}))")
    for line in inner.lines:
        emitter.lines.append("    " + line)
    if inner.uses_math:
        emitter.uses_math = True
    emitter.uses_runtime.update(inner.uses_runtime)
    emitter.add_stmt(f"{fig_v}.tight_layout()")

    return fig_v


def _substitute_repeat_refs(node: object, repeat_values: dict) -> object:
    """Returns a *new* structure with every `{"repeat": "row"|"column"|
    "layer"|"repeat"}` placeholder (Vega-Lite's own template-field syntax
    for a `repeat` operator's spec -- found as a `field`/`datum` value at
    any depth, e.g. `x: {field: {"repeat": "column"}}`, `color: {datum:
    {"repeat": "layer"}}`) replaced by the real field name for this one
    panel/layer. `"repeat"` is the placeholder name a plain-array `repeat:
    [...]` (as opposed to the `{row: [...], column: [...]}`/`{layer:
    [...]}` object forms) uses, matching the top-level key's own name."""
    if isinstance(node, dict):
        if set(node) == {"repeat"} and node["repeat"] in repeat_values:
            return repeat_values[node["repeat"]]
        return {k: _substitute_repeat_refs(v, repeat_values) for k, v in node.items()}
    if isinstance(node, list):
        return [_substitute_repeat_refs(v, repeat_values) for v in node]
    return node


# matplotlib's own `tab10` colormap, as hex -- the translate-time
# equivalent of `scales.py`'s `CATEGORICAL_PALETTE` runtime expression,
# needed here because a `repeat: {layer: [...]}` panel's own layer count
# (and so which color each one gets) is already fully known at translation
# time, unlike a genuine `color`/`detail` grouping's runtime-only count.
_REPEAT_LAYER_PALETTE = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
]


def translate_repeat(node: dict, emitter: Emitter, hint: str, ignore_unsupported: bool = False, path: str = "") -> str:
    repeat_def = node["repeat"]
    template = node["spec"]

    if isinstance(repeat_def, dict) and "layer" in repeat_def and not ({"row", "column"} & set(repeat_def)):
        layer_children = []
        for i, v in enumerate(repeat_def["layer"]):
            child = _substitute_repeat_refs(template, {"layer": v})
            # `color: {datum: {"repeat": "layer"}}` (the common real shape --
            # each repeated layer gets its own literal "color value" equal
            # to its own repeat value, e.g. the string "US Gross") means
            # "auto-assign this whole layer a distinct categorical color,"
            # not a real color *value* -- `_substitute_repeat_refs()` above
            # already replaced the placeholder with the repeat value itself
            # (`v`, a field/series name, not a color), which would
            # otherwise reach `_color_source()` as an unrecognized `datum`
            # key and fall back to every layer sharing the same default
            # color. Replaced here with a real palette color instead, one
            # per layer index, the closest translation-time equivalent to
            # the runtime `__i % 10` palette indexing color/detail grouping
            # already uses everywhere else.
            color_def = (child.get("encoding") or {}).get("color")
            if isinstance(color_def, dict) and color_def.get("datum") == v:
                child["encoding"]["color"] = {"value": _REPEAT_LAYER_PALETTE[i % len(_REPEAT_LAYER_PALETTE)]}
            layer_children.append(child)
        synthetic = {"data": node.get("data"), "transform": node.get("transform"), "layer": layer_children}
        w, h = _panel_size(synthetic)
        fig_v = emitter.new_var("fig")
        ax_v = emitter.new_var("ax")
        emitter.add_stmt(f"{fig_v}, {ax_v} = plt.subplots(figsize=({w}, {h}))")
        translate_layer(synthetic, emitter, hint, ax_v, ignore_unsupported, path=f"{path}repeat.")
        return fig_v

    if isinstance(repeat_def, dict):
        rows = repeat_def.get("row") or [None]
        cols = repeat_def.get("column") or [None]
    else:
        rows, cols = [None], list(repeat_def)

    nrows, ncols = len(rows), len(cols)
    w, h = _panel_size(template)
    fig_v = emitter.new_var("fig")
    axes_v = emitter.new_var("axes")
    emitter.add_stmt(f"{fig_v}, {axes_v} = plt.subplots({nrows}, {ncols}, figsize=({w * ncols}, {h * nrows}), squeeze=False)")

    for ri, rv in enumerate(rows):
        for ci, cv in enumerate(cols):
            repeat_values = {}
            if rv is not None:
                repeat_values["row"] = rv
            if cv is not None:
                repeat_values["column" if isinstance(repeat_def, dict) else "repeat"] = cv
            child = _substitute_repeat_refs(template, repeat_values)
            merged = _merge_down(child, {"data": node.get("data"), "transform": node.get("transform")})
            ax_v = f"{axes_v}[{ri}][{ci}]"
            if "concat" in merged or "hconcat" in merged or "vconcat" in merged or "facet" in merged or "repeat" in merged:
                if ignore_unsupported:
                    emitter.add_stmt(f"# vl2matplotlib: unsupported nested composition inside 'repeat', skipped (ignore_unsupported)")
                    continue
                raise ValueError("Unsupported: a nested composition inside 'repeat' is not yet supported by vl2matplotlib")
            _draw_unit_or_layer(merged, emitter, f"{hint}{ri}_{ci}", ax_v, ignore_unsupported, f"{path}repeat[{ri}][{ci}].")

    emitter.add_stmt(f"{fig_v}.tight_layout()")
    return fig_v


def translate_multi(node: dict, emitter: Emitter, hint: str, key: str, ignore_unsupported: bool = False, path: str = "") -> str:
    children = node[key]
    direction = "row" if key == "vconcat" else "col" if key == "hconcat" else "grid"
    n = len(children)
    columns = node.get("columns")
    if direction == "grid" and isinstance(columns, int):
        nrows, ncols = -(-n // columns), columns
    elif direction == "row":
        nrows, ncols = n, 1
    else:
        nrows, ncols = 1, n

    sizes = [_panel_size(c) for c in children]
    w = max((s[0] for s in sizes), default=6.0)
    h = max((s[1] for s in sizes), default=4.0)
    fig_v = emitter.new_var("fig")
    axes_v = emitter.new_var("axes")
    emitter.add_stmt(f"{fig_v}, {axes_v} = plt.subplots({nrows}, {ncols}, figsize=({w * ncols}, {h * nrows}), squeeze=False)")

    for i, child in enumerate(children):
        merged = _merge_down(child, {"data": node.get("data"), "transform": node.get("transform")})
        row, col = divmod(i, ncols) if direction != "row" else (i, 0)
        if direction == "col":
            row, col = 0, i
        ax_v = f"{axes_v}[{row}][{col}]"
        if "concat" in merged or "hconcat" in merged or "vconcat" in merged or "facet" in merged:
            if ignore_unsupported:
                emitter.add_stmt(f"# vl2matplotlib: unsupported nested composition in {key}[{i}], skipped (ignore_unsupported)")
                continue
            raise ValueError(f"Unsupported: a nested composition inside {key!r} is not yet supported by vl2matplotlib")
        _draw_unit_or_layer(merged, emitter, f"{hint}{i + 1}", ax_v, ignore_unsupported, f"{path}{key}[{i}].")

    emitter.add_stmt(f"{fig_v}.tight_layout()")
    return fig_v


def _rewrite_encoding_facet_shorthand(root: dict) -> dict | None:
    """A plain unit/layer spec's own `encoding.row`/`.column`/`.facet` is
    Vega-Lite's shorthand for the `facet` *operator* -- equivalent to
    wrapping the same spec in `{facet: {...}, spec: {...without that
    channel...}}`. Returns the rewritten explicit form, or `None` if this
    spec doesn't use the shorthand at all."""
    encoding = root.get("encoding") or {}
    facet_channel = None
    facet_def = None
    columns = root.get("columns")
    for ch in ("facet", "row", "column"):
        d = encoding.get(ch)
        if isinstance(d, dict) and d.get("field"):
            facet_channel = ch
            facet_def = dict(d)
            break
    if facet_channel is None:
        return None
    # `columns` (how many panels per row) can live on the channel
    # definition itself (`encoding.facet.columns`, Vega-Lite's own
    # documented spot for it on the shorthand form) or, more rarely, the
    # spec's own top-level `columns` -- the channel's own wins when both
    # are somehow present.
    if facet_def.get("columns") is not None:
        columns = facet_def["columns"]
    if facet_channel == "row":
        columns = 1
    template_encoding = {k: v for k, v in encoding.items() if k not in ("facet", "row", "column")}
    template = {k: v for k, v in root.items() if k not in ("data", "transform", "encoding", "columns")}
    template["encoding"] = template_encoding
    return {
        "facet": facet_def,
        "spec": template,
        "data": root.get("data"),
        "transform": root.get("transform"),
        "columns": columns,
    }


def _unescape_field_refs(node: object) -> None:
    """A `field` value's *escaped* dot (`"a\\.b"`, a literal field named
    `a.b`) and an *unescaped* one (`"a.b"`, Vega-Lite's own nested-object
    drill-down into `datum.a.b`) both end up naming the identical flat
    pandas column after `data.py`'s own `_flatten_record()` -- a genuinely
    nested record gets flattened into a real `"a.b"`-named column, and an
    already-flat record's own literal `"a.b"` field needs no flattening at
    all. So the *only* remaining difference to resolve is the escaping
    itself: mutates every `"field"` string found anywhere in the spec tree
    (encoding channels, transform entries, `sort`/`condition` field refs,
    nested layer/facet/concat specs -- walked recursively, since a `field`
    key can appear at any depth) by dropping the backslash."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "field" and isinstance(v, str) and "\\." in v:
                node[k] = v.replace("\\.", ".")
            else:
                _unescape_field_refs(v)
    elif isinstance(node, list):
        for item in node:
            _unescape_field_refs(item)


def translate_top(root: dict, emitter: Emitter, hint: str, ignore_unsupported: bool = False) -> str:
    _unescape_field_refs(root)
    shorthand = _rewrite_encoding_facet_shorthand(root)
    if shorthand is not None:
        return translate_facet(shorthand, emitter, hint, ignore_unsupported)
    if "layer" in root:
        w, h = _panel_size(root)
        fig_v = emitter.new_var("fig")
        ax_v = emitter.new_var("ax")
        emitter.add_stmt(f"{fig_v}, {ax_v} = plt.subplots(figsize=({w}, {h}))")
        translate_layer(root, emitter, hint, ax_v, ignore_unsupported, path="")
        return fig_v
    if "hconcat" in root:
        return translate_multi(root, emitter, hint, "hconcat", ignore_unsupported)
    if "vconcat" in root:
        return translate_multi(root, emitter, hint, "vconcat", ignore_unsupported)
    if "concat" in root:
        return translate_multi(root, emitter, hint, "concat", ignore_unsupported)
    if "facet" in root and "spec" in root:
        return translate_facet(root, emitter, hint, ignore_unsupported)
    if "repeat" in root and "spec" in root:
        return translate_repeat(root, emitter, hint, ignore_unsupported)

    w, h = _panel_size(root)
    fig_v = emitter.new_var("fig")
    ax_v = emitter.new_var("ax")
    emitter.add_stmt(f"{fig_v}, {ax_v} = plt.subplots(figsize=({w}, {h}))")
    translate_unit(root, emitter, hint, ax_v, ignore_unsupported, path="")
    return fig_v


def spec_to_code(
    spec: dict,
    chart_var: str = "fig",
    ignore_unsupported: bool = False,
    include_source_paths: bool = False,
    format_with_black: bool = True,
) -> str:
    """Translate a full Vega-Lite JSON spec (as a Python dict) into a
    standalone matplotlib script (as a string)."""
    emitter = Emitter(include_source_paths)
    root = dict(spec)
    root.pop("$schema", None)
    datasets = root.pop("datasets", None)
    if datasets:
        root = _resolve_dataset_refs(root, datasets)

    fig_var = translate_top(root, emitter, "chart", ignore_unsupported)

    header = (
        f"# Generated by vl2matplotlib.vegalite_to_matplotlib_code(spec, chart_var={chart_var!r}, "
        f"ignore_unsupported={ignore_unsupported!r}, include_source_paths={include_source_paths!r})"
    )
    imports = ["import matplotlib.pyplot as plt", "import pandas as pd", "import numpy as np"]
    if emitter.uses_math:
        imports.append("import math")
    if emitter.uses_runtime:
        names = ", ".join(sorted(emitter.uses_runtime))
        imports.append(f"from vl2matplotlib.runtime import {names}")

    lines = [header, *imports, ""]
    lines += emitter.lines
    if fig_var != chart_var:
        lines.append(f"{chart_var} = {fig_var}")
    lines.append("")
    lines.append(chart_var)

    code = "\n".join(lines) + "\n"
    if format_with_black:
        code = try_black_format(code)
    return code
