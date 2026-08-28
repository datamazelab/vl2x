"""Turn Vega-Lite's *implicit* per-channel `aggregate`/`bin`/`timeUnit` into
explicit pandas statements, mirroring `vl2d3`'s own `prepare.js` role (there
because D3 has no aggregation of its own) -- except here it's less about
hand-rolling the aggregation and more about picking the right one or two
pandas calls, since `groupby(...).agg(...)` already does in one call what
`vl2d3` needs a hand-written `d3.rollup()` reduction for.

Returns a rewritten `encoding` whose channels reference plain, already-
materialized output column names -- `marks.py`/`scales.py` never need to
know aggregate/bin/timeUnit exist at all; they just see flat column names on
`data_var`.
"""

from __future__ import annotations

from .aggops import agg_expr, is_supported_agg_op
from .literals import sanitize_identifier
from .scales import effective_type
from .timeunit import is_supported_timeunit, timeunit_expr


def _rewritten_type(d: dict) -> str | None:
    """The channel's effective type *before* an aggregate/bin/timeUnit
    rewrite below clears the very key (`aggregate`/`bin`/`timeUnit`)
    `effective_type()` would otherwise infer it from -- baked in here as an
    explicit `type` on the rewritten encoding so a downstream consumer
    (chiefly `marks.py`'s bar/tick mark *orientation* inference, which reads
    `is_quantitative()` on the already-rewritten encoding) still sees it.
    Without this, a 1D aggregate bar chart (`x: {aggregate: "sum", field:
    ...}`, no `y`, no explicit `type` anywhere) loses its only quantitative
    signal the moment this module aggregates it, and silently renders as an
    invisible zero-height vertical bar instead of the horizontal one it
    should be."""
    return d.get("type") or effective_type(d)

# Every channel whose own *position* in the mark drawing matters -- x/x2/y/y2
# range companions included, since a binned x2 needs the same bin-derived
# treatment its own x does.
_ALL_CHANNELS = [
    "x", "y", "x2", "y2", "color", "size", "opacity", "shape", "detail", "order", "text",
    "theta", "radius", "xOffset", "yOffset",
]


def _timeunit_out_name(field: str, unit) -> str:
    name = unit["unit"] if isinstance(unit, dict) else unit
    return sanitize_identifier(f"{name}_{field}")


def _bin_out_names(field: str) -> tuple[str, str]:
    base = sanitize_identifier(field)
    return f"{base}_bin_start", f"{base}_bin_end"


def prepare_encoding(encoding: dict, data_var: str, ignore_unsupported: bool = False) -> tuple[list[str], dict]:
    """Returns `(statements, rewritten_encoding)`."""
    agg_channels = {
        ch: d for ch, d in encoding.items()
        if ch in _ALL_CHANNELS and isinstance(d, dict) and d.get("aggregate") is not None
    }
    bin_channels = {
        ch: d for ch, d in encoding.items()
        # `bin: "binned"` (as opposed to `true`/`{maxbins: ...}`) is Vega-
        # Lite's own "this field is already pre-binned real data -- don't
        # re-bin it" convention: the field IS the bin start, and its own
        # `x2`/`y2` companion (already present in the spec, untouched) is
        # the bin end. Excluded here so it falls through unprepared (no
        # `np.histogram_bin_edges`/`pd.cut` at all) rather than re-binning
        # already-binned data into a different, wrong set of edges.
        if ch in _ALL_CHANNELS and isinstance(d, dict) and d.get("bin") and d.get("bin") != "binned" and not d.get("aggregate")
    }

    if not agg_channels and not bin_channels:
        return _derive_timeunits_only(encoding, data_var, ignore_unsupported)

    if bin_channels:
        return _prepare_binned(encoding, bin_channels, agg_channels, data_var, ignore_unsupported)

    return _prepare_aggregated(encoding, agg_channels, data_var, ignore_unsupported)


def _derive_timeunits_only(encoding: dict, data_var: str, ignore_unsupported: bool) -> tuple[list[str], dict]:
    stmts: list[str] = []
    rewritten = dict(encoding)
    for ch in _ALL_CHANNELS:
        d = encoding.get(ch)
        if not isinstance(d, dict) or not d.get("field") or not d.get("timeUnit"):
            continue
        unit = d["timeUnit"]
        if not is_supported_timeunit(unit):
            if not ignore_unsupported:
                name = unit["unit"] if isinstance(unit, dict) else unit
                raise ValueError(f"Unsupported timeUnit: {name!r}")
            continue
        out = _timeunit_out_name(d["field"], unit)
        expr = timeunit_expr(unit, f"row[{d['field']!r}]")
        stmts.append(f"{data_var}[{out!r}] = {data_var}.apply(lambda row: {expr}, axis=1)")
        rewritten[ch] = {**d, "field": out}
    return stmts, rewritten


def _prepare_aggregated(encoding: dict, agg_channels: dict, data_var: str, ignore_unsupported: bool) -> tuple[list[str], dict]:
    stmts: list[str] = []
    groupby_fields: list[str] = []
    groupby_channels: list[str] = []
    rewritten = dict(encoding)

    for ch in _ALL_CHANNELS:
        if ch in agg_channels:
            continue
        d = encoding.get(ch)
        if not isinstance(d, dict) or not d.get("field"):
            continue
        field = d["field"]
        if d.get("timeUnit"):
            unit = d["timeUnit"]
            if not is_supported_timeunit(unit):
                if not ignore_unsupported:
                    name = unit["unit"] if isinstance(unit, dict) else unit
                    raise ValueError(f"Unsupported timeUnit: {name!r}")
                continue
            out = _timeunit_out_name(field, unit)
            expr = timeunit_expr(unit, f"row[{field!r}]")
            stmts.append(f"{data_var}[{out!r}] = {data_var}.apply(lambda row: {expr}, axis=1)")
            field = out
            rewritten[ch] = {**d, "field": field, "timeUnit": None, "type": _rewritten_type(d)}
        if field not in groupby_fields:
            groupby_fields.append(field)
        groupby_channels.append(ch)

    agg_pairs = []  # (out_name, source_field, op)
    for ch, d in agg_channels.items():
        op = d["aggregate"]
        if not is_supported_agg_op(op):
            if ignore_unsupported:
                continue
            raise ValueError(f"Unsupported aggregate op: {op!r}")
        if op == "count":
            out_name = "count"
            source = groupby_fields[0] if groupby_fields else None
        else:
            field = d.get("field")
            if not field:
                if ignore_unsupported:
                    continue
                raise ValueError(f"Unsupported: aggregate {op!r} channel {ch!r} has no field")
            out_name = sanitize_identifier(f"{op}_{field}")
            source = field
        agg_pairs.append((out_name, source, op, ch))

    # Two different encoding channels (e.g. `x` and `order`) aggregating the
    # identical field with the identical op deterministically produce the
    # identical `out_name` -- de-duplicated here (by out_name, first wins)
    # before emitting named-aggregation keyword args / dict keys, since a
    # repeated keyword/key would otherwise be a `SyntaxError`/silently drop
    # a duplicate dict entry. `rewritten` below still needs every channel's
    # own entry, duplicates included, so `agg_pairs` itself stays as-is.
    seen_out_names: set[str] = set()
    unique_agg_pairs = []
    for pair in agg_pairs:
        if pair[0] in seen_out_names:
            continue
        seen_out_names.add(pair[0])
        unique_agg_pairs.append(pair)

    if groupby_fields:
        def _agg_pair(out, src, op):
            if src is None:
                return f"{out}=('__count__', 'size')"
            func = "'size'" if op == "count" else agg_expr(op)
            return f"{out}=({src!r}, {func})"

        named_aggs = ", ".join(_agg_pair(out, src, op) for out, src, op, _ch in unique_agg_pairs)
        if any(src is None for _, src, _, _ in unique_agg_pairs):
            stmts.append(f"{data_var}['__count__'] = 1")
        group_key = groupby_fields[0] if len(groupby_fields) == 1 else groupby_fields
        stmts.append(f"{data_var} = {data_var}.groupby({group_key!r}, as_index=False).agg({named_aggs})")
    else:
        # A groupless aggregate (e.g. a `rule` mark's dataset-wide mean) --
        # `.agg()` on the whole frame returns a scalar per column, not a row,
        # so the result is wrapped into a genuine one-row DataFrame instead.
        parts = []
        for out, src, op, _ch in unique_agg_pairs:
            if op == "count":
                parts.append(f"{out!r}: len({data_var})")
            else:
                parts.append(f"{out!r}: {data_var}[{src!r}].agg({agg_expr(op)})")
        stmts.append(f"{data_var} = pd.DataFrame([{{{', '.join(parts)}}}])")

    for out, _src, _op, ch in agg_pairs:
        d = encoding[ch]
        rewritten[ch] = {**d, "field": out, "aggregate": None, "type": _rewritten_type(d)}

    return stmts, rewritten


def _prepare_binned(encoding: dict, bin_channels: dict, agg_channels: dict, data_var: str, ignore_unsupported: bool) -> tuple[list[str], dict]:
    if len(bin_channels) > 1:
        if not ignore_unsupported:
            raise ValueError("Unsupported: binning on more than one channel at once (2D binning) is not yet supported by vl2matplotlib")
        bin_channels = dict(list(bin_channels.items())[:1])

    stmts: list[str] = []
    rewritten = dict(encoding)
    (bin_ch, bin_def), = bin_channels.items()
    field = bin_def["field"]
    max_bins = bin_def["bin"].get("maxbins", 10) if isinstance(bin_def.get("bin"), dict) else 10
    start_col, end_col = _bin_out_names(field)

    stmts.append(f"__edges = np.histogram_bin_edges({data_var}[{field!r}].dropna(), bins={max_bins})")
    stmts.append(
        f"{data_var}[{start_col!r}] = pd.cut({data_var}[{field!r}], bins=__edges, include_lowest=True).apply(lambda iv: iv.left if pd.notna(iv) else float('nan')).astype(float)"
    )
    stmts.append(
        f"{data_var}[{end_col!r}] = pd.cut({data_var}[{field!r}], bins=__edges, include_lowest=True).apply(lambda iv: iv.right if pd.notna(iv) else float('nan')).astype(float)"
    )
    rewritten[bin_ch] = {**bin_def, "field": start_col, "bin": None, "type": "quantitative"}
    companion_ch = f"{bin_ch}2"
    rewritten[companion_ch] = {"field": end_col, "type": "quantitative"}

    if agg_channels:
        # Any OTHER channel with its own field but no aggregate of its own
        # (e.g. `color: {field: "Major Genre"}` alongside a binned x and an
        # aggregated y) needs to be a groupby key too, exactly like
        # `_prepare_aggregated`'s own `groupby_fields` collection -- omitting
        # it here would silently drop that column from the aggregated
        # result, breaking any later `.groupby(that_field)` (e.g. the
        # per-color-group draw loop in `marks.py`) with a `KeyError`.
        extra_groupby_fields = []
        for ch in _ALL_CHANNELS:
            if ch == bin_ch or ch in agg_channels:
                continue
            d = encoding.get(ch)
            if isinstance(d, dict) and d.get("field") and d["field"] not in extra_groupby_fields:
                extra_groupby_fields.append(d["field"])
        group_keys = [start_col, end_col] + extra_groupby_fields

        agg_pairs = []
        for ch, d in agg_channels.items():
            op = d["aggregate"]
            if not is_supported_agg_op(op):
                if ignore_unsupported:
                    continue
                raise ValueError(f"Unsupported aggregate op: {op!r}")
            if op == "count":
                agg_pairs.append((ch, "count", None, "count"))
            else:
                agg_pairs.append((ch, sanitize_identifier(f"{op}_{d['field']}"), d["field"], op))
        stmts.append(f"{data_var}['__count__'] = 1")

        def _binned_agg_pair(out, src, op):
            func = "'size'" if op is None else agg_expr(op)
            return f"{out}=({(src or '__count__')!r}, {func})"

        named_aggs = ", ".join(_binned_agg_pair(out, src, op) for _ch, out, src, op in agg_pairs)
        stmts.append(
            f"{data_var} = {data_var}.groupby({group_keys!r}, as_index=False, dropna=True).agg({named_aggs})"
        )
        for ch, out, _src, _op in agg_pairs:
            d = encoding[ch]
            rewritten[ch] = {**d, "field": out, "aggregate": None, "type": _rewritten_type(d)}

    return stmts, rewritten
