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
from .expr import translate_expr
from .literals import format_value, sanitize_identifier
from .timeunit import is_supported_timeunit, timeunit_expr

SUPPORTED_TRANSFORM_KEYS = {"filter", "calculate", "aggregate", "bin", "timeUnit", "window", "joinaggregate", "fold"}


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
    key = next(iter(t), "<unknown>")
    if ignore_unsupported:
        return [f"# vl2matplotlib: skipped unsupported transform type {key!r} (ignore_unsupported)"]
    raise ValueError(f"Unsupported transform type: {key!r}")


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
            conds.append(f"{field_expr} == {predicate['equal']!r}")
        if "range" in predicate and isinstance(predicate["range"], list) and len(predicate["range"]) == 2:
            # Either bound can itself be `null` (unbounded in that
            # direction, e.g. `[null, 2019]` meaning "<= 2019") -- built as
            # separate `>=`/`<=` clauses (only for whichever bound is
            # actually given) rather than one chained `lo <= x <= hi`,
            # since comparing `None <= x` raises `TypeError` outright.
            lo, hi = predicate["range"]
            if lo is not None:
                conds.append(f"({field_expr} >= {lo!r})")
            if hi is not None:
                conds.append(f"({field_expr} <= {hi!r})")
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
        out = sanitize_identifier(a.get("as") or (op if op == "count" else f"{op}_{a.get('field')}"))
        if op == "count":
            agg_pairs.append((out, None, "'size'"))
        else:
            agg_pairs.append((out, a["field"], agg_expr(op)))

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
        if any(src is None for _, src, _ in unique_agg_pairs):
            stmts.append(f"{data_var}['__count__'] = 1")
        named = ", ".join(f"{out}=({(src or '__count__')!r}, {func})" for out, src, func in unique_agg_pairs)
        group_key = groupby[0] if len(groupby) == 1 else groupby
        stmts.append(f"{data_var} = {data_var}.groupby({group_key!r}, as_index=False).agg({named})")
        return stmts

    parts = []
    for out, src, func in unique_agg_pairs:
        if src is None:
            parts.append(f"{out!r}: len({data_var})")
        else:
            parts.append(f"{out!r}: {data_var}[{src!r}].agg({func})")
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
        out = sanitize_identifier(a.get("as") or (op if op == "count" else f"{op}_{a.get('field')}"))
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


def _render_fold(t: dict, data_var: str, ignore_unsupported: bool) -> list[str]:
    # The inverse of `pivot`: N value columns -> two columns (a key naming
    # which original column, and that row's own value from it), one row
    # per (original row x folded column) pair -- exactly `DataFrame.melt()`.
    fields = t["fold"]
    as_names = t.get("as") or ["key", "value"]
    id_vars = f"[c for c in {data_var}.columns if c not in {fields!r}]"
    return [
        f"{data_var} = {data_var}.melt(id_vars={id_vars}, value_vars={fields!r}, "
        f"var_name={as_names[0]!r}, value_name={as_names[1]!r})"
    ]
