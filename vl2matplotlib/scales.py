"""Scale inference: matplotlib has no `Scale` object of its own tied to a
channel the way Vega-Lite/D3/ggplot2 do -- an `Axes` is just linear (or log,
via `set_xscale`) pixel space, and "this axis is really a categorical
scale" only exists insofar as the code plots at integer positions and
relabels the ticks. This module decides, per position channel, which of
those two situations applies, and -- for the ordinal case -- emits the one
vectorized statement that materializes a real integer-position column
(`pd.Categorical(...).codes`, not a per-row Python loop) for `marks.py` to
plot directly as a plain array, the same way any other matplotlib script
would.

Mirrors `vl2d3`'s own `scales.js` role, with one simplification `vl2d3`
doesn't have the luxury of: color/detail *grouping* for the mark-drawing
loop is handled entirely in `marks.py` via `df.groupby(...)`, not through a
scale object here -- matplotlib's own "one draw call per group, each with
its own `label=`" idiom (see `marks.py`) makes that the natural place for
it, and building a legend for free out of it doesn't need a scale
abstraction at all.
"""

from __future__ import annotations

from .literals import format_value

_TEMPORAL_TYPES = {"temporal"}
_DISCRETE_TYPES = {"ordinal", "nominal"}
_QUANTITATIVE_ONLY_SCALE_TYPES = {"linear", "log", "pow", "sqrt", "symlog"}
_TEMPORAL_ONLY_SCALE_TYPES = {"time", "utc"}

# A small, Vega-Lite/D3-adjacent categorical palette (10 colors) -- matches
# matplotlib's own default `tab10` cycle almost exactly (it *is* `tab10`),
# picked explicitly (rather than left to matplotlib's implicit per-Axes
# color cycle) so a color/detail-grouped chart's own color assignment is
# stable and reproducible regardless of how many groups or draw calls came
# before it on the same Axes.
CATEGORICAL_PALETTE = "plt.get_cmap('tab10').colors"


def effective_type(def_: dict) -> str | None:
    """The channel's type, inferred the way Vega-Lite itself would when a
    spec omits an explicit `type` -- common for an `aggregate`/`bin`
    channel (both imply `quantitative`) and for a combined `timeUnit`
    (implies `temporal`; a *cyclic* `timeUnit` like `"month"` does not --
    `timeunit_expr()` reduces it to a plain int, not a real date, so it
    behaves as `quantitative`/ordinal-ish instead). Checking this instead of
    a bare `def_.get("type") == "..."` matters most for bar/tick mark
    *orientation* inference: a 1D aggregate bar chart (`x: {aggregate:
    "sum", field: ...}`, no `type`, no `y` at all) needs to be recognized as
    quantitative to draw as a horizontal bar; missing that produces a
    zero-height vertical bar at an enormous x position -- invisible, not
    just misoriented."""
    if not isinstance(def_, dict):
        return None
    if "type" in def_:
        return def_["type"]
    if def_.get("aggregate") is not None or def_.get("bin"):
        return "quantitative"
    unit = def_.get("timeUnit")
    if unit:
        from .timeunit import _COMBINED

        name = unit["unit"] if isinstance(unit, dict) else unit
        return "temporal" if name in _COMBINED else "quantitative"
    # A quantitative-only (or temporal-only) `scale.type` is a real signal
    # too, even with no explicit "type" at all -- e.g. layer_line_window.vl
    # .json's own `y: {field: "fps", scale: {type: "log"}}`: a log scale
    # only ever applies to a quantitative field. Missing this previously
    # fed straight into `_is_value_channel()`'s (marks.py) own line/area
    # orientation heuristic -- an explicitly quantitative x plus this
    # untyped-but-log-scaled y read as "neither channel is confirmed
    # quantitative enough to call the other the value axis", misclassifying
    # an ordinary vertical line chart as horizontal and, through that,
    # handing the line's own sort-before-drawing step the WRONG field
    # (y's own "fps" instead of x's "row") -- silently connecting points in
    # ascending-value order instead of trial order.
    scale = def_.get("scale")
    scale_type = scale.get("type") if isinstance(scale, dict) else None
    if scale_type in _QUANTITATIVE_ONLY_SCALE_TYPES:
        return "quantitative"
    if scale_type in _TEMPORAL_ONLY_SCALE_TYPES:
        return "temporal"
    return None


def is_discrete(def_: dict) -> bool:
    return effective_type(def_) in _DISCRETE_TYPES


def is_temporal(def_: dict) -> bool:
    return effective_type(def_) in _TEMPORAL_TYPES


def is_quantitative(def_: dict) -> bool:
    return effective_type(def_) == "quantitative"


def scale_type(def_: dict) -> str:
    """`'ordinal'` (discrete, integer-position + relabeled ticks),
    `'temporal'`, or `'linear'`/`'log'` (continuous)."""
    if not isinstance(def_, dict):
        return "linear"
    if is_discrete(def_):
        return "ordinal"
    if is_temporal(def_):
        return "temporal"
    scale = def_.get("scale") or {}
    if scale.get("type") == "log":
        return "log"
    return "linear"


# Vega-Lite's default ordinal sort is the field's own natural order --
# numeric comparison for numbers, lexical for strings. A plain `key=str`
# instead sorts *every* category lexicographically, which is silently wrong
# for a numeric-valued ordinal field (most commonly a cyclic `timeUnit` like
# `"month"`, whose extracted values are plain ints 1-12: `key=str` produces
# 1, 10, 11, 12, 2, 3, ... instead of calendar order). This key sorts
# numbers before strings, numerically among themselves, and falls back to
# `str()` only for genuinely non-numeric values -- safe for the common case
# where a single field's own unique values are all one type or the other.
ORDINAL_SORT_KEY = "lambda v: (0, v) if isinstance(v, (int, float)) else (1, str(v))"


def category_var(channel: str, data_var: str) -> str:
    return f"__{channel}_cats_{data_var}"


def position_column(channel: str, def_: dict, data_var: str) -> tuple[str, list[str]]:
    """Returns `(column_expr, statements)`: `column_expr` is the Python
    expression a mark-drawing call can plot directly -- either
    `<data_var>[<some column>]` (a plain Series) or, when this channel has
    no real field at all (a literal `value`/`datum`, or genuinely absent --
    e.g. a 1D strip plot with only one of x/y given), a *broadcast* literal
    (`pd.Series(<value>, index=<data_var>.index)`, not a bare scalar --
    `ax.scatter(0, [1, 2, 3])` raises `"x and y must be the same size"`,
    unlike `ax.bar`/`ax.plot`, which tolerate a scalar more forgivingly;
    broadcasting explicitly here means every mark renderer in `marks.py`
    can treat this return value uniformly regardless of which case it is)."""
    field = def_.get("field") if isinstance(def_, dict) else None
    if field is None:
        literal = format_value(def_["value"]) if isinstance(def_, dict) and "value" in def_ else (
            format_value(def_["datum"]) if isinstance(def_, dict) and "datum" in def_ else "0"
        )
        return f"pd.Series({literal}, index={data_var}.index)", []
    if scale_type(def_) != "ordinal":
        return f"{data_var}[{field!r}]", []
    cats = category_var(channel, data_var)
    pos_col = f"__{channel}_pos"
    # An explicit `sort: null` (distinct from the key being *absent*,
    # which means "sort ascending," `ORDINAL_SORT_KEY`'s own default)
    # is a spec author deliberately asking to keep the data's own
    # original row order instead -- `waterfall_chart.vl.json`'s own `x:
    # {field: "label", sort: null}`, whose whole narrative (Begin -> Jan
    # -> Feb -> ... -> Dec -> End) depends on NOT being re-sorted
    # alphabetically. `.unique()` already returns values in first-
    # occurrence order, so this only needs to skip the `sorted(...)` call.
    sort_is_null = "sort" in def_ and def_.get("sort") is None
    cats_expr = (
        f"{data_var}[{field!r}].dropna().unique().tolist()"
        if sort_is_null
        else f"sorted({data_var}[{field!r}].dropna().unique().tolist(), key={ORDINAL_SORT_KEY})"
    )
    stmts = [
        f"{cats} = {cats_expr}",
        f"{data_var}[{pos_col!r}] = pd.Categorical({data_var}[{field!r}], categories={cats}).codes.astype(float)",
        f"{data_var}.loc[{data_var}[{pos_col!r}] < 0, {pos_col!r}] = float('nan')",
    ]
    return f"{data_var}[{pos_col!r}]", stmts


def axis_label(def_: dict) -> str | None:
    """The axis title text -- an explicit `title` (on the channel or its
    `axis` object) always wins, including an explicit `null`/`false`
    (Vega-Lite's own "no title" request, distinct from title being *absent*
    entirely, which falls back to the field name)."""
    if not isinstance(def_, dict):
        return None
    if "title" in def_:
        return def_["title"] if isinstance(def_["title"], str) else None
    axis = def_.get("axis")
    if isinstance(axis, dict) and "title" in axis:
        return axis["title"] if isinstance(axis["title"], str) else None
    return def_.get("field")


def axis_hidden(def_: dict) -> bool:
    return isinstance(def_, dict) and "axis" in def_ and def_.get("axis") is None
