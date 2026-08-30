"""Render a top-level Vega-Lite `transform` array as a sequence of `data =
...` pandas statements. Scope: `filter`, `calculate`, `aggregate`, `bin`,
`timeUnit`, `window` (via the shared `vl2matplotlib.runtime.vl_window()`
helper -- see that module's own docstring for why this one specifically
needed a real function rather than an inline one-liner), `joinaggregate`
(a `groupby(...).transform(...)` one-liner), and `fold` (a `melt()`
one-liner). `pivot`/`lookup` remain out of scope (documented gap) --
`pivot` has real pandas equivalent (`pivot_table`) but needs more careful
handling (limit, mixed aggregation, flattening the resulting column index)
than the other two justified adding this session; `lookup` needs a second
dataset joined in, a bigger structural change to how `render_transforms()`
is even called (it only ever sees the *one* dataset already loaded into
`data_var`)."""

from __future__ import annotations

from .aggops import agg_expr, is_supported_agg_op
from .encoding import _datetime_literal_expr, _is_datetime_literal_object
from .expr import translate_expr
from .literals import format_value, sanitize_identifier
from .timeunit import is_supported_timeunit, timeunit_expr

SUPPORTED_TRANSFORM_KEYS = {"filter", "calculate", "aggregate", "bin", "timeUnit", "window", "joinaggregate", "fold", "density", "pivot", "quantile", "stack", "extent"}


def render_transforms(transform_list: list, data_var: str, ignore_unsupported: bool = False) -> list[str]:
    stmts: list[str] = []
    for t in transform_list:
        stmts += _render_one(t, data_var, ignore_unsupported)
    return stmts


def _render_one(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    if "filter" in t:
        return _render_filter(t["filter"], data_var, ignore_unsupported)
    if "calculate" in t:
        expr = translate_expr(t["calculate"])
        return [f"{data_var}[{t['as']!r}] = {data_var}.apply(lambda row: {expr}, axis=1)"]
    if "timeUnit" in t:
        if not is_supported_timeunit(t["timeUnit"]):
            if ignore_unsupported:
                return [f"# vl2matplotlib: unsupported timeUnit {t['timeUnit']!r}, skipped (ignore_unsupported)"]
            raise ValueError(f"Unsupported timeUnit: {t['timeUnit']!r}")
        expr = timeunit_expr(t["timeUnit"], f"row[{t['field']!r}]")
        return [f"{data_var}[{t['as']!r}] = {data_var}.apply(lambda row: {expr}, axis=1)"]
    if "bin" in t:
        return _render_bin(t, data_var, ignore_unsupported)
    if "aggregate" in t:
        return _render_aggregate(t, data_var, ignore_unsupported)
    if "window" in t:
        return _render_window(t, data_var, ignore_unsupported)
    if "joinaggregate" in t:
        return _render_joinaggregate(t, data_var, ignore_unsupported)
    if "fold" in t:
        return _render_fold(t, data_var, ignore_unsupported)
    if "density" in t:
        return _render_density(t, data_var, ignore_unsupported)
    if "pivot" in t:
        return _render_pivot(t, data_var, ignore_unsupported)
    if "quantile" in t:
        return _render_quantile(t, data_var, ignore_unsupported)
    if "stack" in t:
        return _render_stack_transform(t, data_var, ignore_unsupported)
    if "extent" in t:
        # `{"extent": field, "param": name}` computes the [min, max] of
        # `field` and exposes it under `param` for a later value-channel
        # expression to reference (e.g. bar_simple_extent.vl.json's own
        # `x: {value: {expr: "scale('x', b_extent[0])"}}`, a rule mark
        # drawn at the data's own min/max). Unlike every other transform
        # here, this needs no per-layer plumbing at all: every generated
        # script runs as one flat sequence of statements sharing a single
        # Python module-level namespace, so a plain top-level assignment
        # here is already visible to any later layer's own expression
        # that references this name (see encoding.py's channel_value_expr(),
        # which resolves the matching `scale(...)` shape directly).
        return [f"{t['param']} = [{data_var}[{t['extent']!r}].min(), {data_var}[{t['extent']!r}].max()]"]
    key = next(iter(t), "<unknown>")
    if ignore_unsupported:
        return [f"# vl2matplotlib: skipped unsupported transform type {key!r} (ignore_unsupported)"]
    raise ValueError(f"Unsupported transform type: {key!r}")


def _filter_bound_expr(v: object) -> str:
    """A filter predicate's own `equal`/`range` bound is usually a plain
    literal, but for a `timeUnit`-bearing predicate comparing against an
    extracted date component can itself be a `DateTime`-object literal
    (`{"year": 2005, "month": 1}`, the same shape `encoding.py`'s own
    `channel_value_expr()` already handles for a `datum` -- reused here via
    its two helper functions rather than duplicating the table) instead of
    a plain number -- a bare `repr()` would render it as a Python dict,
    compared against a real `pd.Timestamp`/int component with no coercion
    on either side, `TypeError`."""
    if _is_datetime_literal_object(v):
        return _datetime_literal_expr(v)
    return repr(v)


def _render_filter(predicate, data_var: str, ignore_unsupported: bool) -> list[str]:
    if isinstance(predicate, str):
        expr = translate_expr(predicate)
        return [f"{data_var} = {data_var}[{data_var}.apply(lambda row: bool({expr}), axis=1)].reset_index(drop=True)"]
    if isinstance(predicate, dict) and "field" in predicate:
        field = predicate["field"]
        # A filter predicate's own `timeUnit` (e.g. `{field: "date",
        # timeUnit: "year", range: [2006, 2007]}`) compares against the
        # *extracted component*, not the raw (Timestamp-valued) field --
        # without this, comparing a Timestamp to a plain int range crashes.
        field_expr = f"row[{field!r}]"
        if predicate.get("timeUnit") and is_supported_timeunit(predicate["timeUnit"]):
            field_expr = timeunit_expr(predicate["timeUnit"], field_expr)
        conds = []
        if "equal" in predicate:
            conds.append(f"{field_expr} == {_filter_bound_expr(predicate['equal'])}")
        if "range" in predicate and isinstance(predicate["range"], list) and len(predicate["range"]) == 2:
            # Either bound can itself be `null` (unbounded in that
            # direction, e.g. `[null, 2019]` meaning "<= 2019") -- built as
            # separate `>=`/`<=` clauses (only for whichever bound is
            # actually given) rather than one chained `lo <= x <= hi`,
            # since comparing `None <= x` raises `TypeError` outright.
            lo, hi = predicate["range"]
            if lo is not None:
                conds.append(f"({field_expr} >= {_filter_bound_expr(lo)})")
            if hi is not None:
                conds.append(f"({field_expr} <= {_filter_bound_expr(hi)})")
        if "oneOf" in predicate:
            conds.append(f"{field_expr} in {predicate['oneOf']!r}")
        if predicate.get("valid") is True:
            conds.append(f"pd.notna({field_expr})")
        if conds:
            expr = " and ".join(conds)
            return [f"{data_var} = {data_var}[{data_var}.apply(lambda row: {expr}, axis=1)].reset_index(drop=True)"]
    if ignore_unsupported:
        return [f"# vl2matplotlib: unsupported filter predicate shape, keeping every row (ignore_unsupported)"]
    raise ValueError(f"Unsupported: filter predicate shape {predicate!r}")


def _render_bin(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    field = t["field"]
    as_names = t["as"] if isinstance(t["as"], list) else [t["as"], f"{t['as']}_end"]
    max_bins = t["bin"].get("maxbins", 10) if isinstance(t["bin"], dict) else 10
    return [
        f"__edges = np.histogram_bin_edges({data_var}[{field!r}].dropna(), bins={max_bins})",
        f"{data_var}[{as_names[0]!r}] = pd.cut({data_var}[{field!r}], bins=__edges, include_lowest=True).apply(lambda iv: iv.left if pd.notna(iv) else float('nan')).astype(float)",
        f"{data_var}[{as_names[1]!r}] = pd.cut({data_var}[{field!r}], bins=__edges, include_lowest=True).apply(lambda iv: iv.right if pd.notna(iv) else float('nan')).astype(float)",
    ]


def _render_aggregate(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    groupby = t.get("groupby") or []
    agg_pairs = []
    for a in t["aggregate"]:
        op = a["op"]
        if not is_supported_agg_op(op):
            if ignore_unsupported:
                continue
            raise ValueError(f"Unsupported aggregate op: {op!r}")
        # `true_out` is the spec's own literal `as` name -- what a later
        # transform/encoding will always refer to it by (`rect_mosaic_
        # simple.vl.json`'s own `as: "count_*"`, then read back by a `stack`
        # transform's own `stack: "count_*"`). `out` (`sanitize_identifier()`)
        # is only needed for pandas' own named-aggregation *keyword-arg*
        # syntax below (`.agg(out=(src, func))` requires a valid Python
        # identifier); when the two differ, the resulting column is renamed
        # back to `true_out` afterward so nothing downstream ever sees the
        # sanitized name.
        true_out = a.get("as") or (op if op == "count" else f"{op}_{a.get('field')}")
        out = sanitize_identifier(true_out)
        if op == "count":
            agg_pairs.append((out, true_out, None, "'size'"))
        else:
            agg_pairs.append((out, true_out, a["field"], agg_expr(op)))

    # Two aggregate entries with the same explicit/derived `as` name would
    # otherwise repeat a keyword arg (named-agg case) or a dict key
    # (groupless case) -- de-duplicated here, first wins.
    seen_out_names: set[str] = set()
    unique_agg_pairs = []
    for pair in agg_pairs:
        if pair[0] in seen_out_names:
            continue
        seen_out_names.add(pair[0])
        unique_agg_pairs.append(pair)

    if groupby:
        stmts = []
        if any(src is None for _, _, src, _ in unique_agg_pairs):
            stmts.append(f"{data_var}['__count__'] = 1")
        named = ", ".join(f"{out}=({(src or '__count__')!r}, {func})" for out, _, src, func in unique_agg_pairs)
        group_key = groupby[0] if len(groupby) == 1 else groupby
        stmts.append(f"{data_var} = {data_var}.groupby({group_key!r}, as_index=False).agg({named})")
        renames = {out: true_out for out, true_out, _, _ in unique_agg_pairs if out != true_out}
        if renames:
            stmts.append(f"{data_var} = {data_var}.rename(columns={renames!r})")
        return stmts

    parts = []
    for _, true_out, src, func in unique_agg_pairs:
        if src is None:
            parts.append(f"{true_out!r}: len({data_var})")
        else:
            parts.append(f"{true_out!r}: {data_var}[{src!r}].agg({func})")
    return [f"{data_var} = pd.DataFrame([{{{', '.join(parts)}}}])"]


def _render_window(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    # Delegated entirely to the shared `vl_window()` runtime helper -- the
    # combination of an optional partition (`groupby`), order (`sort`), and
    # a *relative-to-the-current-row* frame bound makes this the one
    # transform type in this module that's genuinely awkward to re-derive
    # as an inline pandas one-liner every time (unlike `aggregate`/
    # `joinaggregate`/`fold`, which all have a clean single-call pandas
    # equivalent) -- see `runtime.py`'s own module docstring.
    frame = t.get("frame")
    frame_arg = format_value(list(frame)) if isinstance(frame, list) else "None"
    return [
        f"{data_var} = vl_window({data_var}, window={format_value(t['window'])}, "
        f"groupby={format_value(t.get('groupby') or [])}, sort={format_value(t.get('sort') or [])}, "
        f"frame={frame_arg})"
    ]


def _render_joinaggregate(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    # Unlike `aggregate` (one output row per distinct groupby combination),
    # `joinaggregate` computes the same per-group aggregate but *joins* it
    # back onto every original row -- pandas' own `groupby(...).transform(
    # ...)` already does exactly that in one call, needing no shared helper
    # the way `window`'s own relative-frame semantics does.
    groupby = t.get("groupby") or []
    stmts: list[str] = []
    needs_count_col = False
    for a in t["joinaggregate"]:
        op = a["op"]
        if not is_supported_agg_op(op):
            if ignore_unsupported:
                continue
            raise ValueError(f"Unsupported aggregate op: {op!r}")
        # Unlike `_render_aggregate()`'s own named-aggregation keyword-arg
        # syntax, a plain `data_var[out] = ...` bracket assignment (below)
        # never needs `out` to be a valid Python identifier at all -- it's
        # just a string key -- so the spec's own literal `as` name is used
        # directly here, with no `sanitize_identifier()` detour to undo.
        out = a.get("as") or (op if op == "count" else f"{op}_{a.get('field')}")
        field = a.get("field")
        if op == "count" and not field:
            needs_count_col = True
            field = "__count__"
        func = "'size'" if op == "count" else agg_expr(op)
        if groupby:
            group_key = groupby[0] if len(groupby) == 1 else groupby
            stmts.append(f"{data_var}[{out!r}] = {data_var}.groupby({group_key!r})[{field!r}].transform({func})")
        else:
            stmts.append(f"{data_var}[{out!r}] = {data_var}[{field!r}].agg({func})")
    if needs_count_col:
        stmts.insert(0, f"{data_var}['__count__'] = 1")
    return stmts


def _render_density(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    # Delegated entirely to the shared `vl_density()` runtime helper -- a
    # real Gaussian-kernel KDE, computed inline since pandas/numpy have no
    # built-in density-estimation convenience of their own (see
    # `runtime.py`'s own docstring for the bandwidth/extent defaults).
    field = t["density"]
    as_names = t["as"] if isinstance(t.get("as"), list) and len(t["as"]) == 2 else ["value", "density"]
    bandwidth_arg = format_value(t["bandwidth"]) if isinstance(t.get("bandwidth"), (int, float)) else "None"
    extent = t.get("extent")
    extent_arg = f"({format_value(extent[0])}, {format_value(extent[1])})" if isinstance(extent, list) and len(extent) == 2 else "None"
    steps_arg = t["steps"] if isinstance(t.get("steps"), int) else 200
    counts_arg = "True" if t.get("counts") else "False"
    return [
        f"{data_var} = vl_density({data_var}, {field!r}, groupby={format_value(t.get('groupby') or [])}, "
        f"bandwidth={bandwidth_arg}, extent={extent_arg}, steps={steps_arg}, counts={counts_arg}, "
        f"as_names=({as_names[0]!r}, {as_names[1]!r}))"
    ]


def _render_pivot(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    # `fold`'s inverse: real per-group bookkeeping (collect duplicates,
    # aggregate them, keep a stable possibly-limited column ordering) that
    # would be error-prone to re-derive inline at every call site --
    # delegated to the shared `vl_pivot()` runtime helper (mirrors
    # `vl2d3`'s own `vlPivot()`/`vl2ggplot`'s own `vl_pivot()`).
    opts = [f"groupby={format_value(t.get('groupby') or [])}"]
    if t.get("op"):
        opts.append(f"op={t['op']!r}")
    if t.get("limit"):
        opts.append(f"limit={t['limit']!r}")
    return [f"{data_var} = vl_pivot({data_var}, {t['pivot']!r}, {t['value']!r}, {', '.join(opts)})"]


def _render_quantile(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    # Delegated to the shared `vl_quantile()` runtime helper -- see its own
    # docstring for the probability-sampling convention.
    field = t["quantile"]
    as_names = t["as"] if isinstance(t.get("as"), list) and len(t["as"]) == 2 else ["prob", "value"]
    step = t["step"] if isinstance(t.get("step"), (int, float)) else 0.01
    return [
        f"{data_var} = vl_quantile({data_var}, {field!r}, groupby={format_value(t.get('groupby') or [])}, "
        f"step={step!r}, as_names=({as_names[0]!r}, {as_names[1]!r}))"
    ]


def _render_stack_transform(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    # An *explicit* version of `stack.py`'s own implicit per-mark
    # stacking, computed here as real `as` columns instead
    # (`stacked_bar_population_transform.vl.json`'s own shape). Delegated
    # to the shared `vl_stack()` runtime helper -- see its own docstring.
    field = t["stack"]
    as_names = t["as"] if isinstance(t.get("as"), list) and len(t["as"]) == 2 else [f"{field}_start", f"{field}_end"]
    offset = t.get("offset") or "zero"
    return [
        f"{data_var} = vl_stack({data_var}, {field!r}, groupby={format_value(t.get('groupby') or [])}, "
        f"sort={format_value(t.get('sort') or [])}, offset={offset!r}, "
        f"as_names=({as_names[0]!r}, {as_names[1]!r}))"
    ]


def _render_fold(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    # The inverse of `pivot`: N value columns -> two new columns (a key
    # naming which original column, and that row's own value from it), one
    # row per (original row x folded column) pair. NOT a plain
    # `DataFrame.melt()`, despite the superficial resemblance: Vega-Lite's
    # own `fold` keeps *every* original field on each output row --
    # including the very fields being folded -- while a bare `melt(id_vars=
    # <everything except the folded fields>, value_vars=<folded fields>)`
    # necessarily drops them (they can't be both an id_var and a
    # value_var). Real corpus usage relies on this: `trail_comet.vl.json`'s
    # own `fold: ["1931", "1932"]` is followed by a `calculate:
    # "datum['1932'] - datum['1931']"` step reading the *original* folded
    # fields back, after the fold -- exactly what `vl2d3`'s own
    # `renderFoldTransform()` (`{...d, key: f, value: d[f]}`, spreading the
    # whole original row) and `vl2ggplot`'s own `render_fold_transform()`
    # (`.d <- var_name; .d[[key]] <- .f; ...`) already do. Implemented here
    # as a melt over the non-folded columns (`ignore_index=False`, so the
    # original row index survives, duplicated once per folded field) with
    # the folded fields' own original values re-joined back afterward by
    # that same index.
    fields = t["fold"]
    as_names = t.get("as") or ["key", "value"]
    src = f"__fold_src_{data_var}"
    id_vars = f"[c for c in {src}.columns if c not in {fields!r}]"
    stmts = [
        f"{src} = {data_var}",
        f"{data_var} = {src}.melt(id_vars={id_vars}, value_vars={fields!r}, "
        f"var_name={as_names[0]!r}, value_name={as_names[1]!r}, ignore_index=False)",
    ]
    for f in fields:
        stmts.append(f"{data_var}[{f!r}] = {src}.loc[{data_var}.index, {f!r}]")
    stmts.append(f"{data_var} = {data_var}.reset_index(drop=True)")
    return stmts
