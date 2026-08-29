"""Per-mark-type matplotlib drawing code generation. `data_var` always
holds a flat DataFrame by the time any of these run (`prepare.py`'s own
aggregate/bin rewrite and `stack.py`'s own stacking rewrite have both
already happened) -- every renderer here just needs to know which columns
to plot and how.

Grouping (a `color`/`detail` field splitting the mark into several series,
each its own color and legend entry) is handled the same way in every
renderer: a `for __i, (__key, __rows) in enumerate(data.groupby(field)):`
loop in the *generated* code, not resolved at translation time -- the
actual distinct category values are only known once the real data has
loaded, the same reason `vl2d3`'s own `d3.group()`/`vl2ggplot`'s own
`dplyr::group_by()` groupings are also resolved at chart-render time, not
translation time. `enumerate()` over a pandas `groupby` (which iterates in
sorted-key order by default) gives a stable palette index for free.
"""

from __future__ import annotations

import re

from .encoding import channel_value_expr, has_field
from .expr import translate_expr
from .literals import format_color_value, format_value
from .scales import CATEGORICAL_PALETTE, ORDINAL_SORT_KEY, is_quantitative, position_column, scale_type

DEFAULT_COLOR = "'#4C78A8'"  # Vega-Lite's own default mark color

# Vega-Lite's own shape names -> the closest matplotlib marker symbol.
_SHAPE_MARKER_MAP = {
    "circle": "o", "square": "s", "cross": "P", "diamond": "D",
    "triangle-up": "^", "triangle-down": "v", "triangle-right": ">", "triangle-left": "<",
    "arrow": "^", "wedge": "^", "triangle": "^", "stroke": "_",
}
# Vega-Lite's own default categorical shape range (`config.point.shape` /
# the built-in ordinal shape scheme), used when a `shape` field has no
# explicit `scale.range` of its own.
_DEFAULT_SHAPE_ORDER = [
    "circle", "square", "cross", "diamond", "triangle-up", "triangle-down", "triangle-right", "triangle-left",
]


def _shape_marker(name: object) -> str:
    return _SHAPE_MARKER_MAP.get(name, "o") if isinstance(name, str) else "o"


def _legend_stmt(ax_var: str, title_field: str) -> str:
    """A plain `ax.legend(title=...)`, with no location given, lets
    matplotlib pick its own "best fit" spot *inside* the Axes -- for a
    small panel (a common real spec shape: several small-multiples facet
    panels, or just a compact figure size) with more than a couple of
    legend entries, that "best fit" box can end up covering most or all of
    the actual plotted data, which then reads as an empty/blank chart.
    Placed just outside the right edge of the Axes instead (matplotlib's
    own documented recipe for this exact problem), so it never overlaps
    the data regardless of how many categories or how small the figure."""
    return f"{ax_var}.legend(title={title_field!r}, bbox_to_anchor=(1.02, 1), loc='upper left', borderaxespad=0)"


def _legend_hidden(color_def: object) -> bool:
    """An explicit `color.legend: null` (distinct from the key being
    *absent*, which means "show the default legend") is a spec author
    deliberately suppressing it -- common on a chart whose color already
    duplicates a panel's own title/facet value (`concat_population_
    pyramid.vl.json`'s own per-panel gender bars) or where a colorbar
    would be redundant/unwanted (`point_angle_windvector.vl.json`'s own
    continuous `color`). Every categorical-legend call site in this module
    checks this before calling `_legend_stmt()`; the continuous-color
    colorbar branches check it too, for the same reason."""
    return isinstance(color_def, dict) and "legend" in color_def and color_def.get("legend") is None


def _mark_props(mark) -> dict:
    return {} if isinstance(mark, str) else {k: v for k, v in mark.items() if k != "type"}


_ROW_LOOKUP_RE = re.compile(r"row\[('[^']*'|\"[^\"]*\")\]")


def _soften_row_lookups(expr: str) -> str:
    """`row['field']` -> `row.get('field')` -- only used for a `color.
    condition`'s own `test` expression (see `_color_source()`), where a
    referenced field surviving into the row this runs against isn't
    guaranteed the way it is for `calculate`/`filter` (which run before any
    aggregation)."""
    return _ROW_LOOKUP_RE.sub(r"row.get(\1)", expr)


def _color_source(
    encoding: dict,
    mark_props: dict,
    fallback: str = DEFAULT_COLOR,
    data_var: str | None = None,
    stmts: list[str] | None = None,
    allow_row_array: bool = True,
) -> tuple[str | None, str]:
    """Returns `(group_field, fixed_color_expr)`: `group_field` is set (and
    `fixed_color_expr` ignored) whenever `color` is a real categorical field
    to group/legend by; otherwise `fixed_color_expr` is the color expression
    every row uses -- almost always a single literal color string
    (`encoding.color.value`, the mark's own `color` property, or the
    Vega-Lite default), but a *per-row array* (`data_var['__cond_color']`)
    when `color.condition` is present and `data_var`/`stmts` were given (see
    below) -- every caller already inserts this return value directly as a
    `color=<expr>` keyword argument, and matplotlib's own `bar`/`scatter`/
    `vlines`/`hlines` calls all already accept either a single color or one
    per element, so this needs no special handling at any of those call
    sites. A *continuous* `color` field (see `_continuous_color_setup()` --
    used instead by callers that support it, e.g. `rect`/`point`) is
    deliberately excluded here via `is_quantitative()` rather than a bare
    `color_def.get("type") in (...)` membership check -- an `aggregate`/
    `bin` color channel with no *explicit* `type` (e.g. `color: {aggregate:
    "mean", field: "Horsepower"}`, a common heatmap shape) would otherwise
    be misclassified as a categorical grouping field just because `type`
    happens to be absent.

    `color.condition` (`{condition: {test: "<expr>", value: ...}, value:
    ...}` -- e.g. a candlestick chart's up/down color, or any other
    computed-per-row color) is only handled when `allow_row_array` is true
    *and* both `data_var`/`stmts` are given (a caller whose own matplotlib
    call can't take an array -- `plot()`/`fill_between()`, or a per-row
    `axvline()`/`axhline()` loop where the array would need indexing this
    function has no way to thread through -- passes `allow_row_array=False`
    instead, falling back to the condition's own base `value` as a single
    flat color, exactly like a plain `color.value` with no condition at
    all). Only a `test`-keyed condition (a real Vega expression) is
    evaluated; a `param`-keyed one (a selection, which has nothing bound in
    a static image) falls back to the base value too, the same convention
    every other selection-driven encoding in this project already uses."""
    color_def = encoding.get("color")
    if isinstance(color_def, dict) and color_def.get("field") and not is_quantitative(color_def):
        return color_def["field"], fallback
    if isinstance(color_def, dict) and "condition" in color_def:
        cond = color_def["condition"]
        cond = cond[0] if isinstance(cond, list) and cond else cond
        base = format_color_value(color_def["value"]) if "value" in color_def else fallback
        if allow_row_array and data_var is not None and stmts is not None and isinstance(cond, dict) and isinstance(cond.get("test"), str) and "value" in cond:
            # A condition's own `test` can reference a field that isn't
            # part of *this* mark's own encoding at all (seen in the corpus:
            # a null/invalid-data check referencing a field the bar's own
            # `y`-aggregate groupby doesn't preserve, since it's neither a
            # groupby key nor an aggregated value) -- `row[field]` would
            # raise `KeyError` for every row once that field genuinely isn't
            # a column any more post-aggregation. `row.get(field)` (via
            # `_soften_row_lookups`) returns `None` instead, which a
            # `pd.isna(...)`-wrapped null check (the common real shape) then
            # correctly treats as "missing," a reasonable degradation rather
            # than crashing the whole chart over one condition.
            test_expr = _soften_row_lookups(translate_expr(cond["test"]))
            then_expr = format_color_value(cond["value"])
            out_col = "__cond_color"
            stmts.append(f"{data_var}[{out_col!r}] = {data_var}.apply(lambda row: ({then_expr}) if ({test_expr}) else ({base}), axis=1)")
            return None, f"{data_var}[{out_col!r}]"
        return None, base
    if isinstance(color_def, dict) and "value" in color_def:
        return None, _mark_color_value(color_def["value"], fallback)
    if "color" in mark_props:
        return None, _mark_color_value(mark_props["color"], fallback)
    return None, fallback


def _mark_color_value(value: object, fallback: str) -> str:
    """A mark-level `color` property is *usually* a plain CSS color string,
    but can also be a gradient definition object (`{gradient: "linear",
    stops: [{offset, color}, ...], x1, y1, x2, y2}`) -- matplotlib has no
    equivalent to a true SVG-style gradient fill without much more
    involved clipping/`imshow` machinery this project doesn't attempt, so
    this approximates it with a single flat color instead: the gradient's
    own *last* stop (the color the fill trends *towards*, generally the
    more visually prominent one in a typical light-to-saturated gradient)
    rather than crashing on a dict where a color string was expected."""
    if isinstance(value, dict) and isinstance(value.get("stops"), list) and value["stops"]:
        last_stop = value["stops"][-1]
        if isinstance(last_stop, dict) and "color" in last_stop:
            return format_color_value(last_stop["color"])
        return fallback
    return format_color_value(value)


def _size_scale_expr(size_def: dict, data_var: str) -> tuple[str, list[str]]:
    """For a *quantitative* `size` field on a `point`/`circle`/`square`
    mark: matplotlib's own `scatter(..., s=...)` treats `s` as marker
    *area* in points^2 directly -- passing a raw data value straight
    through (the previous behavior) is fine for a field that already
    happens to sit in a plausible pixel-area range, but silently draws
    absurdly oversized (or invisible) markers for anything else, e.g.
    `circle_bubble_health_income.vl.json`'s own `size: {field:
    "population"}` (tens of millions), which rendered as one solid black
    rectangle covering the whole plot. Rescaled into a fixed, reasonable
    output area range instead -- `scale.range`/`.rangeMin`/`.rangeMax`
    win when given, else `[20, 1000]` (points^2), a plausible default
    bubble-chart size band; `scale.domain` wins over the data's own
    min/max, matching every other explicit-`scale` override elsewhere in
    this project. Interpolated via a square-root fraction (`sqrt((value -
    lo) / (hi - lo))`), not a flat linear one -- matplotlib's `s=` is
    already an *area*, so this makes the rendered *area* grow linearly
    with the data value (the standard, perceptually-fair bubble-chart
    convention: a value twice as large should look twice as large by
    area, not by radius), matching `vl2d3`'s own `d3.scaleSqrt()`-based
    size scale."""
    field = size_def["field"]
    scale = size_def.get("scale") if isinstance(size_def.get("scale"), dict) else {}
    domain = scale.get("domain")
    range_ = scale.get("range")
    if isinstance(range_, list) and len(range_) == 2:
        lo_r, hi_r = format_value(range_[0]), format_value(range_[1])
    else:
        lo_r = format_value(scale["rangeMin"]) if "rangeMin" in scale else "20"
        hi_r = format_value(scale["rangeMax"]) if "rangeMax" in scale else "1000"
    if isinstance(domain, list) and len(domain) == 2:
        lo_d, hi_d = format_value(domain[0]), format_value(domain[1])
    else:
        lo_d, hi_d = f"{data_var}[{field!r}].min()", f"{data_var}[{field!r}].max()"
    var = f"__size_{data_var}"
    stmt = (
        f"{var} = ({lo_r}) + (({hi_r}) - ({lo_r})) * np.sqrt("
        f"(({data_var}[{field!r}] - ({lo_d})) / max((({hi_d}) - ({lo_d})), 1e-9)).clip(lower=0)"
        f")"
    )
    return var, [stmt]


def _continuous_color_setup(color_def: dict, data_var: str, cmap: str = "viridis") -> tuple[str, list[str]]:
    """For a *continuous* (quantitative) `color` field: emits a shared
    `Normalize` + colormap pair and returns a per-row scalar color
    expression (`cmap(norm(row[field]))`, usable inside a `df.iterrows()`/
    `.apply()` loop) plus the setup statements. An explicit `scale.domain`
    wins over the data's own min/max, matching every other explicit-`scale`
    override elsewhere in this project."""
    field = color_def["field"]
    cmap_var = f"__cmap_{data_var}"
    norm_var = f"__cnorm_{data_var}"
    scale = color_def.get("scale") if isinstance(color_def.get("scale"), dict) else {}
    scheme = scale.get("scheme")
    cmap_name = _COLOR_SCHEME_MAP.get(scheme, cmap) if scheme else cmap
    domain = scale.get("domain")
    if isinstance(domain, list) and len(domain) == 2:
        lo, hi = format_value(domain[0]), format_value(domain[1])
    else:
        lo, hi = f"{data_var}[{field!r}].min()", f"{data_var}[{field!r}].max()"
    stmts = [
        f"{cmap_var} = plt.get_cmap({cmap_name!r})",
        f"{norm_var} = plt.Normalize({lo}, {hi})",
    ]
    color_expr = f"{cmap_var}({norm_var}(row[{field!r}]))"
    return color_expr, stmts


_COLOR_SCHEME_MAP = {
    "viridis": "viridis", "plasma": "plasma", "inferno": "inferno", "magma": "magma",
    "blues": "Blues", "greens": "Greens", "reds": "Reds", "oranges": "Oranges", "purples": "Purples",
    "greys": "Greys", "turbo": "turbo", "rainbow": "rainbow", "spectral": "Spectral",
    "redyellowgreen": "RdYlGn", "redyellowblue": "RdYlBu", "blueorange": "coolwarm", "redblue": "RdBu",
}

# Vega-Lite's own *categorical* (discrete) scheme names -> the nearest
# matplotlib qualitative colormap. Distinct from `_COLOR_SCHEME_MAP` above
# (continuous schemes for a quantitative `color`) since Vega-Lite itself
# has separate scheme vocabularies for the two cases -- "category10" isn't
# a valid continuous scheme name, and "viridis" isn't really a categorical
# one (usable as one in Vega-Lite, but not a *qualitative* palette the way
# these are).
_CATEGORICAL_SCHEME_MAP = {
    "category10": "tab10", "category20": "tab20", "category20b": "tab20b", "category20c": "tab20c",
    "tableau10": "tab10", "tableau20": "tab20",
    "accent": "Accent", "dark2": "Dark2", "paired": "Paired",
    "pastel1": "Pastel1", "pastel2": "Pastel2", "set1": "Set1", "set2": "Set2", "set3": "Set3",
}


def _categorical_color_lookup(color_def: dict | None, data_var: str, stmts: list[str]) -> tuple[str, str]:
    """A categorical `color`/`detail` grouping's own palette: an explicit
    `color.scale.range` (a literal list of CSS colors) or `.scheme` (a
    named qualitative colormap) always wins over the shared default
    `CATEGORICAL_PALETTE` (matplotlib's own `tab10`) every group/dodge/
    boxplot/pie draw loop elsewhere in this module otherwise falls back to
    unconditionally -- previously *always* tab10, silently ignoring any
    custom palette a spec actually asked for.

    Returns `(kind, var_name)`. When `scale.domain` is *also* given
    alongside `range` (an explicit value -> color mapping, e.g. `domain:
    ["Sky", "Shady side"], range: ["#416D9D", "#674028"]` -- distinct from
    a bare `range` with no `domain`, which just supplies an ordered palette
    matched to whichever categories the data happens to produce, in
    whatever order they're encountered), `kind` is `"map"` and `var_name`
    names a real dict (`{domain[i]: range[i], ...}`) a caller should look
    up by the row's own category *value*, not by draw-order index --
    `arc_pie_pyramid.vl.json` is exactly this shape, and additionally
    reorders its wedges via an `order` channel, so a positional/index-based
    palette would silently mismatch a value to the wrong color the moment
    draw order and domain order diverge. Otherwise `kind` is `"list"` and
    `var_name` names a plain sequence (`range`, a scheme's own qualitative
    colormap, or the shared default), meant to be indexed positionally
    (`palette[i % len(palette)]`) by whichever integer index the caller's
    own draw loop already has -- `__i % len(__palette_<var>)`, not a
    hardcoded `% 10`, so a custom range shorter *or* longer than 10 both
    still work correctly. `kind` can also be `"raw"` (`var_name` unused,
    `None`) when `scale` is explicitly `null` -- Vega-Lite's own "disable
    scale" convention for a color channel: the field's own raw values
    *are* literal CSS color specs already (`bar_color_disabled_scale.vl.
    json`'s own `color: {field: "color", scale: null}`, a column of
    `"red"`/`"green"`/`"blue"` strings), used directly rather than mapped
    through a categorical palette -- previously indistinguishable from
    `scale` being *absent* entirely (both fell through to `{}`), so the
    real color names were silently discarded in favor of an arbitrary
    tab10 assignment."""
    if isinstance(color_def, dict) and "scale" in color_def and color_def.get("scale") is None:
        return "raw", None
    scale = color_def.get("scale") if isinstance(color_def, dict) else None
    scale = scale if isinstance(scale, dict) else {}
    range_ = scale.get("range")
    domain = scale.get("domain")
    if isinstance(range_, list) and range_ and isinstance(domain, list) and len(domain) == len(range_):
        pairs = ", ".join(f"{format_value(d)!s}: {format_color_value(c)}" for d, c in zip(domain, range_))
        map_var = f"__colormap_{data_var}"
        stmts.append(f"{map_var} = {{{pairs}}}")
        return "map", map_var
    domain_expr = scale.get("_domain_expr")
    if domain_expr:
        # An internal-only convention (never present in a real spec's own
        # `scale` object): a *runtime* expression naming an already-computed
        # full domain -- set by `translate_facet()`/`translate_hconcat()`
        # etc. when a color-grouped mark is drawn once per panel/child over
        # a data slice that's only ever a *subset* of the field's real
        # domain (a facet panel already filtered to one category, an
        # hconcat child already filtered to one). Indexing a plain `range`
        # list positionally by *this panel's own* local groupby order (the
        # `"list"` kind below) silently reassigns colors per panel --
        # trellis_bar.vl.json's own Male panel, whose only locally-visible
        # category is "Male", would otherwise always land on `range[0]`,
        # the *first* color, identically to the Female panel. Building the
        # `domain -> color` map from the *shared* full-domain expression
        # instead of each panel's own local unique-value order fixes this
        # for every consumer uniformly (same `"map"` kind the explicit-
        # domain-and-range branch above already returns).
        if isinstance(range_, list) and range_:
            range_expr = f"[{', '.join(format_color_value(c) for c in range_)}]"
        else:
            scheme = scale.get("scheme")
            cmap_name = _CATEGORICAL_SCHEME_MAP.get(scheme.lower()) if isinstance(scheme, str) else None
            range_expr = f"plt.get_cmap({cmap_name!r}).colors" if cmap_name else CATEGORICAL_PALETTE
        palette_var = f"__palette_{data_var}"
        stmts.append(f"{palette_var} = {range_expr}")
        map_var = f"__colormap_{data_var}"
        stmts.append(
            f"{map_var} = {{__dv: {palette_var}[__di % len({palette_var})] for __di, __dv in enumerate({domain_expr})}}"
        )
        return "map", map_var
    if isinstance(range_, list) and range_:
        expr = f"[{', '.join(format_color_value(c) for c in range_)}]"
    else:
        scheme = scale.get("scheme")
        cmap_name = _CATEGORICAL_SCHEME_MAP.get(scheme.lower()) if isinstance(scheme, str) else None
        expr = f"plt.get_cmap({cmap_name!r}).colors" if cmap_name else CATEGORICAL_PALETTE
    palette_var = f"__palette_{data_var}"
    stmts.append(f"{palette_var} = {expr}")
    return "list", palette_var


def _opacity_value(encoding: dict, mark_props: dict) -> str:
    op_def = encoding.get("opacity")
    if isinstance(op_def, dict) and "value" in op_def:
        return format_value(op_def["value"])
    if "opacity" in mark_props:
        return format_value(mark_props["opacity"])
    return "1.0"


def _axis_setup_stmts(ax_var: str, channel: str, def_: dict, data_var: str) -> list[str]:
    from .scales import axis_hidden, axis_label, category_var

    stmts = []
    if axis_hidden(def_):
        stmts.append(f"{ax_var}.{'xaxis' if channel == 'x' else 'yaxis'}.set_visible(False)")
        return stmts
    label = axis_label(def_)
    if label:
        stmts.append(f"{ax_var}.set_{channel}label({label!r})")
    if scale_type(def_) == "log":
        # `scale_type()` has recognized `scale: {type: "log"}` since this
        # module's own introduction, but nothing ever actually called
        # `set_xscale`/`set_yscale` on it -- every log-scale spec
        # (`circle_bubble_health_income.vl.json`'s own `x: {field:
        # "income", scale: {type: "log"}}`) silently rendered on a plain
        # linear axis instead, bunching every point into a tiny fraction
        # of the plot's own width.
        stmts.append(f"{ax_var}.set_{channel}scale('log')")
    axis_cfg = def_.get("axis")
    axis_fmt = axis_cfg.get("format") if isinstance(axis_cfg, dict) else None
    if axis_fmt and scale_type(def_) == "temporal":
        # An explicit `axis.format` on a temporal channel (a real strftime-
        # compatible pattern in the common case, e.g. `window_impute_null.
        # vl.json`'s own `"%d %b"`) was previously never applied at all --
        # every date axis fell back to matplotlib's own default tick
        # formatter, which (for a dense daily series) renders full
        # `YYYY-MM-DD`-shaped labels crammed together and unreadable.
        stmts.append(f"{ax_var}.{channel}axis.set_major_formatter(mdates.DateFormatter({axis_fmt!r}))")
    if def_.get("sort") == "descending" and scale_type(def_) != "ordinal":
        # A *continuous* position channel's own `sort: "descending"` means
        # "run this scale/axis in the opposite direction," not "reorder
        # some discrete categories" (that's the ordinal case, handled
        # separately below). The real-world shape this exists for is a
        # population-pyramid-style chart (`concat_population_pyramid.vl.
        # json`'s own Female panel): two side-by-side bar charts meant to
        # mirror each other outward from a shared center, built by giving
        # just one side's *value* axis a descending sort so its bars grow
        # inward/leftward instead of outward/rightward.
        stmts.append(f"{ax_var}.invert_{channel}axis()")
    if scale_type(def_) == "ordinal":
        cats = category_var(channel, data_var)
        ticks = f"range(len({cats}))"
        labels = f"[str(v) for v in {cats}]"
        if channel == "x":
            stmts.append(f"{ax_var}.set_xticks(list({ticks}))")
            stmts.append(f"{ax_var}.set_xticklabels({labels}, rotation=0)")
        else:
            stmts.append(f"{ax_var}.set_yticks(list({ticks}))")
            stmts.append(f"{ax_var}.set_yticklabels({labels})")
    return stmts


def render_mark(mark, encoding: dict, data_var: str, ax_var: str, ignore_unsupported: bool = False) -> list[str]:
    mark_type = mark if isinstance(mark, str) else mark.get("type")
    mark_props = _mark_props(mark)
    renderer = _RENDERERS.get(mark_type)
    if renderer is None:
        if ignore_unsupported:
            return [f"# vl2matplotlib: unsupported mark type {mark_type!r}, skipped (ignore_unsupported)"]
        raise ValueError(f"Unsupported mark type: {mark_type!r}")
    return renderer(encoding, mark_props, data_var, ax_var, ignore_unsupported)


def _render_bar(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    x_def, y_def = encoding.get("x"), encoding.get("y")
    # An explicit mark-level `orient` always wins; otherwise Vega-Lite's own
    # inference: horizontal iff x is the continuous (quantitative) channel
    # and y isn't -- checked via `is_quantitative()` (which also recognizes
    # an `aggregate`/`bin` channel with no *explicit* `type` at all, the
    # single most common shape a 1D aggregate bar chart -- `x: {aggregate:
    # "sum", field: ...}`, no `y` -- uses) rather than a bare `def_.get(
    # "type") == "quantitative"`, which misses that shape entirely and
    # produces an invisible zero-height vertical bar instead.
    orient = mark_props.get("orient")
    if orient in ("horizontal", "vertical"):
        horizontal = orient == "horizontal"
    else:
        horizontal = is_quantitative(x_def) and not is_quantitative(y_def)
    value_channel = "x" if horizontal else "y"
    cat_channel = "y" if horizontal else "x"
    value_def = encoding.get(value_channel) or {}
    cat_def = encoding.get(cat_channel) or {}
    offset_def = encoding.get(f"{cat_channel}Offset")
    dodge_field = offset_def.get("field") if isinstance(offset_def, dict) else None
    if dodge_field:
        # A dodge shift is only meaningful over an *ordinal* integer
        # position -- and a bar's own category channel is very often given
        # with no explicit `type` at all (Vega-Lite infers `nominal` from
        # the underlying string data). Forced ordinal here specifically
        # (mirroring `_force_nominal_if_ambiguous()`'s identical reasoning) rather
        # than changing `scale_type()`'s own shared default, since the
        # *non*-dodged case already works by relying on matplotlib's own
        # native string-category handling for a plain `ax.bar(strings,
        # ...)` call -- forcing ordinal unconditionally there would be a
        # change with no compensating benefit, just risk.
        cat_def = _force_nominal_if_ambiguous(cat_def)

    stmts: list[str] = []
    cat_col, cat_stmts = position_column(cat_channel, cat_def, data_var)
    stmts += cat_stmts
    stmts += _axis_setup_stmts(ax_var, cat_channel, cat_def, data_var)
    # The value (length) channel's own axis never went through
    # `_axis_setup_stmts()` at all previously -- missing both its `title`
    # (e.g. `x: {..., title: "population"}`) and, more consequentially, its
    # own `sort: "descending"` (see `_axis_setup_stmts()`'s own docstring
    # for the population-pyramid-mirroring use case this exists for; a bar
    # mark is the one shape where the value axis is a *different* channel
    # than the one already passed above). `value_def` can be an empty dict
    # (the value channel entirely absent, `bar_1d_dimension_only.vl.json`'s
    # own shape) -- a safe no-op for every check `_axis_setup_stmts()` does.
    # Skipped when the value channel is itself ordinal/nominal (a rarer
    # shape, `bar_ranged_offset_quantitative.vl.json`'s own `yOffset`-
    # driven ranged bars, where *neither* x nor y is quantitative) --
    # `_axis_setup_stmts()`'s ordinal branch expects an integer-position
    # column `position_column()` already built via `category_var()`, which
    # only ever happens for `cat_channel` above, never for `value_channel`
    # (this renderer draws the value channel's own raw field values
    # directly, with no such remapping); calling it here regardless would
    # reference a `__..._cats_...` variable that was never defined.
    if scale_type(value_def) != "ordinal":
        stmts += _axis_setup_stmts(ax_var, value_channel, value_def, data_var)

    value_field = value_def.get("field")
    companion = encoding.get(f"{value_channel}2")
    companion_field = companion.get("field") if isinstance(companion, dict) else None
    # The continuous "length" channel is entirely absent (no field, and no
    # `x2`/`y2` companion either) -- real-world shape: `bar_1d_dimension_
    # only.vl.json`, a bar chart that only ever encodes the *category*
    # channel. Vega-Lite still draws a bar per row in this case, each one
    # spanning the *entire* plot area along the missing axis (there is no
    # data to size it by), not a zero-length invisible one. A plain data-
    # coordinate `left=0, width=<value>` can't express "fill the whole
    # axes" since the value axis has no data scale at all here -- instead
    # draw at `width=1`/`height=1` under a blended transform (data
    # coordinates on the category axis, axes-fraction [0, 1] on the
    # missing value axis), matplotlib's own documented way to mix the two.
    value_field_missing = not value_field and not companion_field
    top_expr = f"{data_var}[{value_field!r}]" if value_field else "0"
    base_expr = f"{data_var}[{companion_field!r}]" if companion_field else "0"

    alpha = _opacity_value(encoding, mark_props)
    call = "barh" if horizontal else "bar"
    length_kw = "height" if horizontal else "width"
    bottom_kw = "left" if horizontal else "bottom"
    if value_field_missing:
        height_expr = "1"
        base_expr = "0"
        transform_kw = f", transform={ax_var}.get_{'y' if horizontal else 'x'}axis_transform()"
    else:
        height_expr = f"({top_expr} - ({base_expr}))" if companion_field else top_expr
        transform_kw = ""

    # A bar's own thickness along the category axis: matplotlib's `align=
    # 'center'`, width=0.8 default is only correct for an ORDINAL position
    # (an integer-spaced index -- see `position_column()`). A continuous
    # (quantitative) category position -- a binned histogram axis (its own
    # `bin_start`/`bin_end` companion, e.g. `x`/`x2`) or a plain
    # quantitative field used directly as a bar position (rarer, but real,
    # e.g. `bar_q_qpow.vl.json`) -- needs a real, data-derived width
    # instead: a flat `0.8`-wide bar drawn at (e.g.) x=3000 on an axis
    # spanning 3000-4000 is a barely-visible sliver, exactly the "plot
    # renders but looks empty" failure mode this fixes.
    # Only trust a real, data-derived width when the category channel is
    # *known* quantitative (explicit `type`, or `aggregate`/`bin`/`timeUnit`-
    # implied -- see `is_quantitative()`); a plain untyped field (very
    # common for a bar's own category axis -- Vega-Lite infers `nominal`
    # from the underlying string data, which this translator can't inspect
    # at translation time) must NOT fall into the numeric-heuristic branch,
    # since `.max()`/`.min()` on a string column raises `TypeError` --
    # `scale_type()` alone can't distinguish "confirmed continuous" from
    # "unknown, defaulted to linear", only `is_quantitative()` can.
    cat_field = cat_def.get("field")
    cat_companion = encoding.get(f"{cat_channel}2")
    cat_scale_type = scale_type(cat_def)
    align_kw = ""
    width_is_group_dependent = False
    if not cat_field or cat_scale_type == "ordinal" or (not is_quantitative(cat_def) and cat_scale_type != "temporal"):
        width_expr = "0.8"
    elif isinstance(cat_companion, dict) and cat_companion.get("field"):
        width_expr = f"({data_var}[{cat_companion['field']!r}] - {cat_col})"
        align_kw = ", align='edge'"
        width_is_group_dependent = True
    else:
        # A single scalar shared by every group's own draw call -- computed
        # once, over the full (ungrouped) data, so it must NEVER be run
        # through the same `.replace(data_var, rows)` substitution the
        # per-group expressions below get: `width_var`'s own generated name
        # embeds `data_var` as a substring (e.g. `__x_bar_width_chart_data`),
        # so blindly substituting would corrupt the variable *name* itself
        # into a reference to a name that was never defined.
        #
        # A *temporal* category axis (a combined/`"binned"`-prefixed
        # `timeUnit` with no `x2`/`y2` companion of its own, e.g.
        # `binnedyearmonth`) needs the identical heuristic, but its
        # `.max() - .min()` naturally produces a `pd.Timedelta` (Timestamp
        # arithmetic) rather than a plain float -- matplotlib's own
        # `bar()`/`barh()` accept either a float or a `Timedelta` `width=`
        # on a date axis, so the *expression* is identical either way, only
        # the single-category fallback literal differs (a bare `0.8` added
        # to a `pd.Timestamp` raises `TypeError`; `pd.Timedelta(days=1)` is
        # the equivalent "at least draw something" fallback).
        width_var = f"__{cat_channel}_bar_width_{data_var}"
        fallback = "pd.Timedelta(days=1)" if cat_scale_type == "temporal" else "0.8"
        stmts.append(
            f"{width_var} = ((({cat_col}).max() - ({cat_col}).min()) / max(({cat_col}).nunique() - 1, 1)) * 0.6 "
            f"if ({cat_col}).nunique() > 1 else {fallback}"
        )
        width_expr = width_var

    # `xOffset`/`yOffset` (a grouped/dodged bar chart): subdivides each
    # category's own slot into N side-by-side sub-bars, one per distinct
    # offset value, instead of every sub-group's bar drawing at the
    # identical category position (silently overdrawing each other, with
    # only the last-drawn group visible) the way this renderer would
    # otherwise treat it. N -- and so both the per-group width shrink and
    # the centering shift -- is only knowable at *runtime* from the real
    # data, the same reason color/detail grouping below is also a
    # generated loop rather than something resolved here at translation
    # time. Mutually exclusive with implicit stacking (`stack.py`'s own
    # `plan_stacking()` already bails out when an offset channel is
    # present, so `height_expr` here is never itself stack-derived in this
    # branch).
    if dodge_field:
        group_field, fixed_color = _color_source(encoding, mark_props, data_var=data_var, stmts=stmts)
        by_color = group_field == dodge_field
        stmts.append(f"__dodge_cats = sorted({data_var}[{dodge_field!r}].dropna().unique().tolist(), key={ORDINAL_SORT_KEY})")
        stmts.append("__n_dodge = max(len(__dodge_cats), 1)")
        sub_width = f"(({width_expr}) / __n_dodge)"
        r_sub_width = sub_width.replace(data_var, "__drows") if width_is_group_dependent else sub_width
        r_cat = cat_col.replace(data_var, "__drows")
        r_height = height_expr.replace(data_var, "__drows")
        r_base = base_expr.replace(data_var, "__drows")
        shifted_cat = f"({r_cat} + (__i - (__n_dodge - 1) / 2) * ({r_sub_width}))"
        color_def = encoding.get("color")
        stack_field = (
            color_def["field"]
            if isinstance(color_def, dict) and color_def.get("field") and not by_color and not is_quantitative(color_def)
            else None
        )
        if stack_field:
            # Grouped (`xOffset`) *and* stacked (`color`, a genuinely
            # DIFFERENT field) at once -- `bar_grouped_stacked.vl.json`'s
            # own shape: dodge by Origin, and within each dodge slot,
            # stack by year-of-Year. Previously dropped: color/stacking
            # were only ever wired up when `color` happened to share the
            # *same* field as the dodge channel (the far more common
            # "grouped, not also stacked" shape) -- a genuinely different
            # color field fell back to a flat default color, with every
            # color's own bar drawn *unstacked* and overlapping at the
            # identical dodge position (only the tallest one visible, and
            # monochrome even then). Stacked here the same way `stack.py`'s
            # own zero-baseline formula does (`groupby(category).cumsum()`),
            # just computed per dodge-slot subset (`__drows`) instead of
            # over the whole frame; colored via the same `_domain_expr`
            # value-map convention `_render_text()`/`_render_rect()` use,
            # so each color's own assignment is consistent across every
            # dodge slot regardless of which years happen to appear in it.
            lookup_def = dict(color_def)
            lookup_scale = dict(color_def.get("scale") or {})
            lookup_scale.setdefault("_domain_expr", f"sorted({data_var}[{stack_field!r}].dropna().unique().tolist(), key={ORDINAL_SORT_KEY})")
            lookup_def["scale"] = lookup_scale
            _, var = _categorical_color_lookup(lookup_def, data_var, stmts)
            stmts.append(f"for __i, __dk in enumerate(__dodge_cats):")
            stmts.append(
                f"    __drows = {data_var}[{data_var}[{dodge_field!r}] == __dk].sort_values([{cat_field!r}, {stack_field!r}])"
            )
            stmts.append(f"    __seg_top = __drows.groupby({cat_field!r})[{value_field!r}].cumsum()")
            stmts.append(f"    __seg_bottom = __seg_top - __drows[{value_field!r}]")
            stmts.append(
                f"    {ax_var}.{call}({shifted_cat}, __seg_top - __seg_bottom, {length_kw}={r_sub_width}, "
                f"{bottom_kw}=__seg_bottom, color=__drows[{stack_field!r}].map({var}).fillna({DEFAULT_COLOR}), "
                f"alpha={alpha}{align_kw})"
            )
            if not _legend_hidden(color_def):
                stmts.append(
                    f"{ax_var}.legend(handles=[plt.Rectangle((0, 0), 1, 1, color=__c) for __c in {var}.values()], "
                    f"labels=[str(__k) for __k in {var}.keys()], title={stack_field!r}, "
                    f"bbox_to_anchor=(1.02, 1), loc='upper left', borderaxespad=0)"
                )
            return stmts
        if by_color:
            kind, var = _categorical_color_lookup(encoding.get("color"), data_var, stmts)
            color_expr = (
                "str(__dk)" if kind == "raw"
                else f"{var}.get(__dk, {DEFAULT_COLOR})" if kind == "map"
                else f"{var}[__i % len({var})]"
            )
        else:
            color_expr = fixed_color
        stmts.append(f"for __i, __dk in enumerate(__dodge_cats):")
        stmts.append(f"    __drows = {data_var}[{data_var}[{dodge_field!r}] == __dk]")
        stmts.append(
            f"    {ax_var}.{call}({shifted_cat}, {r_height}, {length_kw}={r_sub_width}, {bottom_kw}={r_base}, "
            f"color={color_expr}, alpha={alpha}, label=str(__dk){align_kw})"
        )
        if not (by_color and _legend_hidden(encoding.get("color"))):
            stmts.append(_legend_stmt(ax_var, dodge_field))
        return stmts

    # A *continuous* color field (`bar_invalid_color_show_override.vl.
    # json`'s own `color: {field: "c", type: "quantitative"}`) was
    # previously dropped entirely -- `_color_source()` deliberately
    # excludes it (by design, see its own docstring), and unlike
    # `rect`/`point`, `_render_bar()` never had a continuous-color branch
    # of its own to catch it, so every bar fell back to the flat default
    # color regardless. `ax.bar()`'s own `color=` accepts a *per-bar*
    # array, not just a single color, so this reuses `_continuous_color_
    # setup()`'s shared cmap/norm pair with a vectorized `cmap(norm(array))`
    # expression instead of its own default per-row one.
    color_def = encoding.get("color")
    continuous_color_col = None
    colorbar_stmt = None
    if isinstance(color_def, dict) and color_def.get("field") and is_quantitative(color_def):
        _, color_setup_stmts = _continuous_color_setup(color_def, data_var)
        stmts += color_setup_stmts
        cmap_var, norm_var = f"__cmap_{data_var}", f"__cnorm_{data_var}"
        continuous_color_col = f"{cmap_var}({norm_var}({data_var}[{color_def['field']!r}]))"
        if not _legend_hidden(color_def):
            colorbar_stmt = f"plt.colorbar(plt.cm.ScalarMappable(norm={norm_var}, cmap={cmap_var}), ax={ax_var})"

    def draw(rows, color, label):
        r_cat = cat_col if rows == data_var else cat_col.replace(data_var, rows)
        r_height = height_expr if rows == data_var else height_expr.replace(data_var, rows)
        r_base = base_expr if rows == data_var else base_expr.replace(data_var, rows)
        r_width = width_expr if (rows == data_var or not width_is_group_dependent) else width_expr.replace(data_var, rows)
        label_kw = f", label={label}" if label else ""
        r_color = continuous_color_col if continuous_color_col is not None else color
        return [
            f"{ax_var}.{call}({r_cat}, {r_height}, {length_kw}={r_width}, {bottom_kw}={r_base}, "
            f"color={r_color}, alpha={alpha}{label_kw}{align_kw}{transform_kw})"
        ]

    stmts += _grouped_or_single(encoding, mark_props, data_var, draw, stmts=stmts)
    if colorbar_stmt:
        stmts.append(colorbar_stmt)
    group_field = _color_source(encoding, mark_props)[0]
    if group_field and not _legend_hidden(encoding.get("color")):
        stmts.append(_legend_stmt(ax_var, group_field))
    return stmts


def _rect_extent(channel: str, def_: dict, companion_def, data_var: str, cat_col: str) -> tuple[str, str, str]:
    """Returns `(left_edge_expr, width_expr, axis_limit_stmt)` for one axis
    of a `rect` cell. The first two are per-*row* scalar expressions
    (`row[...]`, not a `data_var[...]` Series -- `rect` draws one
    `matplotlib.patches.Rectangle` per row via a `df.iterrows()` loop,
    unlike `bar`'s vectorized single call per group). A binned channel's own
    `x2`/`y2` companion (the bin's upper edge) gives an exact width; an
    ordinal/nominal position (an adjacent-integer index, see
    `position_column()`) gets a full unit-width cell (`[-0.5, +0.5]` around
    its own integer center) so a heatmap's cells tile with no gaps, matching
    Vega-Lite's own default band-scale-with-zero-padding for `rect`;
    anything else falls back to the same unit-width default. `axis_limit_stmt`
    sets the axis's own view limits explicitly -- `Rectangle` patches, unlike
    `bar`/`scatter`/`plot`, are never included in matplotlib's own
    autoscale/data-limit tracking, so without this the Axes would keep its
    default `[0, 1]` view and every rect would render (correctly, just)
    entirely outside the visible frame."""
    companion_field = companion_def.get("field") if isinstance(companion_def, dict) else None
    row_col = cat_col.replace(data_var, "row")
    if companion_field:
        row_companion = f"row[{companion_field!r}]"
        lo = f"min({row_col}, {row_companion})"
        width = f"abs({row_companion} - {row_col})"
        lim = (
            f"min({cat_col}.min(), {data_var}[{companion_field!r}].min()), "
            f"max({cat_col}.max(), {data_var}[{companion_field!r}].max())"
        )
        return lo, width, lim
    if scale_type(def_) == "ordinal":
        from .scales import category_var

        cats = category_var(channel, data_var)
        return f"({row_col} - 0.5)", "1.0", f"-0.5, len({cats}) - 0.5"
    return f"({row_col} - 0.5)", "1.0", f"({cat_col}.min() - 0.5), ({cat_col}.max() + 0.5)"


def _force_nominal_if_ambiguous(def_: dict) -> dict:
    """A position channel *with a field* but no explicit `type` and nothing
    (`aggregate`/`bin`/`timeUnit`) implying `quantitative` is, in real-world
    specs, overwhelmingly a categorical (`nominal`) field. `scale_type()`'s
    own shared default for an ambiguous type is `"linear"` (continuous),
    which `position_column()` would then hand back as the *raw* field value
    (e.g. a plain string column like `"Origin"`) rather than an integer
    position -- fine for a caller that only ever hands that value straight
    to matplotlib (which auto-categorizes a string x/y natively), but wrong
    for one that needs to do arithmetic on the position: `_rect_extent()`'s
    own continuous-axis fallback tries `row['Origin'] - 0.5` (a `TypeError`),
    and `_render_bar()`'s own dodge-shift math would try adding a number to
    a string Series. Forcing `nominal` here (a local decision at each of
    those call sites, not a change to `scale_type()`'s own shared default
    other marks still rely on) routes it through the same integer-position
    machinery an ordinal channel already gets instead. Only applied when a
    field is actually present -- a field-*less* channel (`rect`'s own
    reference-band shape) has no data to be ordinal *about*."""
    from .scales import effective_type

    if isinstance(def_, dict) and def_.get("field") and not is_quantitative(def_) and effective_type(def_) is None:
        return {**def_, "type": "nominal"}
    return def_


def _render_rect(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    # `_force_nominal_if_ambiguous()` is skipped for a channel that has its
    # own `x2`/`y2` companion -- a `field`+companion pair is a genuine
    # numeric *span* (bin edges, or a start/end timeline range, e.g.
    # `wheat_wages.vl.json`'s own `x: {field: "start"}, x2: {field:
    # "end"}` monarchs-reign timeline, neither typed at all) almost always,
    # never a categorical label pair; `_rect_extent()`'s own companion
    # branch already assumes numeric row-to-row arithmetic
    # (`row[x] - row[companion]`) regardless. Forcing nominal here anyway
    # turned each span's own real numeric position into a tiny ordinal
    # integer code while its companion stayed a real (much larger) year
    # value, producing one absurdly wide rectangle per row instead of a
    # real, correctly-sized span.
    x_def = encoding.get("x") or {}
    y_def = encoding.get("y") or {}
    if not (isinstance(encoding.get("x2"), dict) and encoding["x2"].get("field")):
        x_def = _force_nominal_if_ambiguous(x_def)
    if not (isinstance(encoding.get("y2"), dict) and encoding["y2"].get("field")):
        y_def = _force_nominal_if_ambiguous(y_def)
    x_has_field, y_has_field = bool(x_def.get("field")), bool(y_def.get("field"))
    if not x_has_field and not y_has_field:
        if ignore_unsupported:
            return ["# vl2matplotlib: unsupported 'rect' mark shape (no x/y field), skipped (ignore_unsupported)"]
        raise ValueError('Unsupported: "rect" mark requires an x and/or y field')

    color_def = encoding.get("color")
    alpha = _opacity_value(encoding, mark_props)
    stmts: list[str] = []
    if isinstance(color_def, dict) and color_def.get("field") and is_quantitative(color_def):
        color_expr, color_stmts = _continuous_color_setup(color_def, data_var)
        stmts += color_stmts
        colorbar_stmt = (
            None if _legend_hidden(color_def)
            else f"plt.colorbar(plt.cm.ScalarMappable(norm=__cnorm_{data_var}, cmap=__cmap_{data_var}), ax={ax_var})"
        )
    elif isinstance(color_def, dict) and color_def.get("field"):
        # A *categorical* `color` field -- `rect` draws via one shared
        # `df.iterrows()` loop (both branches below, the 2D-grid Rectangle
        # case and the single-axis span case), not `_grouped_or_single()`'s
        # own one-call-per-group idiom every other mark's categorical color
        # support is built on, so `_color_source()` (which only ever
        # returns a *group field name* for this case, not a usable color)
        # was never actually consulted for an actual color here at all --
        # every row silently fell back to the same flat default
        # (`layer_falkensee.vl.json`'s own Nazi-Rule/GDR background bands,
        # meant to be two different colors, rendered identically). Built
        # the same way `_render_text()`'s own per-row color map is: a
        # `value -> color` map via `_categorical_color_lookup()`'s
        # `_domain_expr` convention, looked up per row.
        color_field = color_def["field"]
        lookup_def = dict(color_def)
        lookup_scale = dict(color_def.get("scale") or {})
        lookup_scale.setdefault("_domain_expr", f"sorted({data_var}[{color_field!r}].dropna().unique().tolist(), key={ORDINAL_SORT_KEY})")
        lookup_def["scale"] = lookup_scale
        _, var = _categorical_color_lookup(lookup_def, data_var, stmts)
        color_expr = f"{var}.get(row[{color_field!r}], {DEFAULT_COLOR})"
        colorbar_stmt = None
    else:
        color_expr = _color_source(encoding, mark_props)[1]
        colorbar_stmt = None

    if x_has_field and y_has_field:
        # The common case: a full 2D grid (a heatmap), one Rectangle per row.
        x_col, xs = position_column("x", x_def, data_var)
        y_col, ys = position_column("y", y_def, data_var)
        stmts += xs + ys
        stmts += _axis_setup_stmts(ax_var, "x", x_def, data_var)
        stmts += _axis_setup_stmts(ax_var, "y", y_def, data_var)
        x_left, x_width, x_lim = _rect_extent("x", x_def, encoding.get("x2"), data_var, x_col)
        y_bottom, y_height, y_lim = _rect_extent("y", y_def, encoding.get("y2"), data_var, y_col)
        stmts.append(
            f"for _, row in {data_var}.iterrows(): {ax_var}.add_patch("
            f"plt.Rectangle(({x_left}, {y_bottom}), {x_width}, {y_height}, "
            f"facecolor={color_expr}, alpha={alpha}, linewidth=0))"
        )
        stmts.append(f"{ax_var}.set_xlim({x_lim})")
        stmts.append(f"{ax_var}.set_ylim({y_lim})")
    else:
        # A rect with a field on only ONE axis is a reference *band*
        # spanning the entire other (field-less) axis -- e.g. a min/max
        # extent range drawn behind a scatter layer. `axhspan`/`axvspan`
        # are matplotlib's own purpose-built primitives for exactly this
        # (a span across the Axes' *current* full width/height), simpler
        # and more correct than trying to force it through the same
        # per-row-Rectangle-with-an-explicit-position machinery the field-
        # on-both-axes case above needs -- there is no "position" on the
        # field-less axis to derive a Rectangle corner from at all.
        span_channel, span_def = ("y", y_def) if y_has_field else ("x", x_def)
        span_field = span_def["field"]
        companion_def = encoding.get(f"{span_channel}2")
        companion_field = companion_def.get("field") if isinstance(companion_def, dict) else None
        fn = "axhspan" if span_channel == "y" else "axvspan"
        from .scales import axis_label

        label = axis_label(span_def)
        if label:
            stmts.append(f"{ax_var}.set_{span_channel}label({label!r})")
        if companion_field:
            lo = f"min(row[{span_field!r}], row[{companion_field!r}])"
            hi = f"max(row[{span_field!r}], row[{companion_field!r}])"
        else:
            lo, hi = f"row[{span_field!r}] - 0.5", f"row[{span_field!r}] + 0.5"
        stmts.append(f"for _, row in {data_var}.iterrows(): {ax_var}.{fn}({lo}, {hi}, facecolor={color_expr}, alpha={alpha})")

    if colorbar_stmt:
        stmts.append(colorbar_stmt)
    return stmts


def _render_boxplot(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    from .scales import axis_label

    x_def, y_def = encoding.get("x") or {}, encoding.get("y") or {}
    horizontal = is_quantitative(x_def) and not is_quantitative(y_def)
    value_channel = "x" if horizontal else "y"
    cat_channel = "y" if horizontal else "x"
    value_def = encoding.get(value_channel) or {}
    cat_def = encoding.get(cat_channel) or {}
    value_field = value_def.get("field")
    if not value_field:
        if ignore_unsupported:
            return ["# vl2matplotlib: unsupported 'boxplot' mark shape (no quantitative value field), skipped (ignore_unsupported)"]
        raise ValueError('Unsupported: "boxplot" mark requires a quantitative value field')

    # `extent: "min-max"` -> whiskers extend to the true min/max
    # (matplotlib's `whis=(0, 100)`, a percentile range, is the documented
    # way to get that); Vega-Lite's own default (`"1.5*iqr"`) is already
    # matplotlib's own default `whis=1.5` -- no translation needed there.
    extent = mark_props.get("extent")
    whis = "(0, 100)" if extent == "min-max" else "1.5"
    vert_kw = "vert=False" if horizontal else "vert=True"
    color_def = encoding.get("color")
    has_color = isinstance(color_def, dict) and (color_def.get("field") or "value" in color_def)
    fixed_color = _color_source(encoding, mark_props)[1]

    stmts: list[str] = []
    cat_field = cat_def.get("field")
    if cat_field:
        stmts.append(f"__groups = sorted({data_var}[{cat_field!r}].dropna().unique().tolist(), key={ORDINAL_SORT_KEY})")
        stmts.append(
            f"__box_data = [{data_var}[{data_var}[{cat_field!r}] == __g][{value_field!r}].dropna().values for __g in __groups]"
        )
        stmts.append(
            f"__bp = {ax_var}.boxplot(__box_data, positions=list(range(len(__groups))), {vert_kw}, whis={whis}, patch_artist=True)"
        )
        if has_color:
            kind, var = _categorical_color_lookup(color_def, data_var, stmts)
            color_expr = (
                "str(__groups[__i])" if kind == "raw"
                else f"{var}.get(__groups[__i], {DEFAULT_COLOR})" if kind == "map"
                else f"{var}[__i % len({var})]"
            )
            stmts.append(
                f"for __i, __patch in enumerate(__bp['boxes']): __patch.set_facecolor({color_expr})"
            )
        else:
            stmts.append(f"for __patch in __bp['boxes']: __patch.set_facecolor({fixed_color})")
        ticks_channel = cat_channel
        stmts.append(f"{ax_var}.set_{'yticks' if ticks_channel == 'y' else 'xticks'}(range(len(__groups)))")
        label_kw = ", rotation=0" if ticks_channel == "x" else ""
        stmts.append(f"{ax_var}.set_{'yticklabels' if ticks_channel == 'y' else 'xticklabels'}([str(g) for g in __groups]{label_kw})")
        cat_label = axis_label(cat_def)
        if cat_label:
            stmts.append(f"{ax_var}.set_{cat_channel}label({cat_label!r})")
    else:
        stmts.append(
            f"__bp = {ax_var}.boxplot([{data_var}[{value_field!r}].dropna().values], {vert_kw}, whis={whis}, "
            f"patch_artist=True, positions=[0])"
        )
        stmts.append(f"for __patch in __bp['boxes']: __patch.set_facecolor({fixed_color})")
        stmts.append(f"{ax_var}.set_{'yticks' if cat_channel == 'y' else 'xticks'}([])")

    value_label = axis_label(value_def)
    if value_label:
        stmts.append(f"{ax_var}.set_{value_channel}label({value_label!r})")
    return stmts


def _render_arc(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    theta_def = encoding.get("theta") or {}
    radius_def = encoding.get("radius")
    theta_field = theta_def.get("field")
    # A `radius`-encoded field varies each wedge's own radius (a polar bar
    # chart, not a pie/donut) -- a materially different visualization this
    # translator doesn't attempt; `ax.pie()` below only ever draws equal-
    # radius wedges.
    if not theta_field or (isinstance(radius_def, dict) and radius_def.get("field")):
        if ignore_unsupported:
            return ["# vl2matplotlib: unsupported 'arc' mark shape (a `radius`-encoded field, or no `theta` field), skipped (ignore_unsupported)"]
        raise ValueError('Unsupported: "arc" mark requires a quantitative theta field (a `radius`-encoded field is not supported)')

    color_def = encoding.get("color")
    color_field = color_def.get("field") if isinstance(color_def, dict) and not is_quantitative(color_def) else None
    inner_radius = mark_props.get("innerRadius") or 0
    wedge_kw = ", wedgeprops=dict(width=0.5)" if inner_radius else ""

    stmts: list[str] = []
    order_def = encoding.get("order")
    order_field = order_def.get("field") if isinstance(order_def, dict) else None
    if order_field:
        # Wedges draw in `theta_field`'s own row order by default -- an
        # explicit `order` channel means that's *not* necessarily the
        # data's own natural row order (`arc_pie_pyramid.vl.json`: the
        # wedges' own visual sequence -- "Shady side," "Sunny side," "Sky"
        # -- differs from the order the 3 rows happen to appear in the
        # source data).
        stmts.append(f"{data_var} = {data_var}.sort_values({order_field!r}).reset_index(drop=True)")
    if color_field:
        kind, var = _categorical_color_lookup(color_def, data_var, stmts)
        if kind == "raw":
            colors_expr = f"{data_var}[{color_field!r}].astype(str).tolist()"
        elif kind == "map":
            # Looked up by the row's own category *value* (via `.map()`
            # over the whole column at once), not draw-order index -- an
            # explicit `domain`+`range` pairing must still match the right
            # color to the right category even when an `order` channel (a
            # real corpus shape, `arc_pie_pyramid.vl.json`) reorders the
            # wedges relative to the data's own row order.
            colors_expr = f"{data_var}[{color_field!r}].map({var}).fillna({DEFAULT_COLOR}).tolist()"
        else:
            colors_expr = f"[{var}[__i % len({var})] for __i in range(len({data_var}))]"
        stmts.append(
            f"{ax_var}.pie({data_var}[{theta_field!r}], labels={data_var}[{color_field!r}].astype(str), "
            f"colors={colors_expr}{wedge_kw})"
        )
    else:
        fixed_color = _color_source(encoding, mark_props)[1]
        stmts.append(f"{ax_var}.pie({data_var}[{theta_field!r}], colors=[{fixed_color}] * len({data_var}){wedge_kw})")
    stmts.append(f"{ax_var}.set_aspect('equal')")
    return stmts


_EXTENT_BOUNDS = {
    "stdev": ("{v}['__mean'] - {v}['__std']", "{v}['__mean'] + {v}['__std']"),
    "stderr": ("{v}['__mean'] - {v}['__std'] / {v}['__std_n']", "{v}['__mean'] + {v}['__std'] / {v}['__std_n']"),
    "iqr": ("{v}['__q1']", "{v}['__q3']"),
    # Vega-Lite's default confidence-interval extent uses a bootstrap; this
    # project's own "ci" instead uses the same normal-theory approximation
    # `vl2ggplot` documents making for the identical reason (no simple one-
    # line pandas/R equivalent to a real bootstrap) -- numerically close for
    # reasonably-sized samples, not identical.
    "ci": ("{v}['__mean'] - 1.96 * {v}['__std'] / {v}['__std_n']", "{v}['__mean'] + 1.96 * {v}['__std'] / {v}['__std_n']"),
}


def _error_extent_stmts(encoding: dict, mark_props: dict, data_var: str) -> tuple[list[str], str, dict, dict, bool]:
    """Shared by `errorbar`/`errorband`: groups by whichever position
    channel *isn't* the quantitative value field (if any) and computes
    mean/stdev/quantiles once, then derives `__lo`/`__hi` bound columns
    per the mark's own `extent` (`"stdev"`/`"stderr"`/`"iqr"`/`"ci"`,
    default `"stderr"` matching Vega-Lite's own). Returns `(stmts,
    out_data_var, value_channel_def, cat_channel_def)` -- the two returned
    defs are already rewritten to point at the new aggregated frame's own
    `__mean`/`__lo`/`__hi`/group-field columns, ready for `position_column()`."""
    x_def, y_def = encoding.get("x") or {}, encoding.get("y") or {}
    horizontal = is_quantitative(x_def) and not is_quantitative(y_def)
    value_channel = "x" if horizontal else "y"
    cat_channel = "y" if horizontal else "x"
    value_def = encoding.get(value_channel) or {}
    cat_def = encoding.get(cat_channel) or {}
    value_field = value_def.get("field")
    if not value_field:
        raise ValueError('Unsupported: "errorbar"/"errorband" mark requires a quantitative value field')
    cat_field = cat_def.get("field")

    out_var = f"__err_{data_var}"
    stmts: list[str] = []
    if cat_field:
        stmts.append(
            f"{out_var} = {data_var}.groupby({cat_field!r}, as_index=False).agg("
            f"__mean=({value_field!r}, 'mean'), __std=({value_field!r}, 'std'), __std_n=({value_field!r}, "
            f"lambda s: max(len(s), 1) ** 0.5), __q1=({value_field!r}, lambda s: s.quantile(0.25)), "
            f"__q3=({value_field!r}, lambda s: s.quantile(0.75)))"
        )
    else:
        stmts.append(
            f"{out_var} = pd.DataFrame([{{'__mean': {data_var}[{value_field!r}].mean(), "
            f"'__std': {data_var}[{value_field!r}].std(), "
            f"'__std_n': max(len({data_var}), 1) ** 0.5, "
            f"'__q1': {data_var}[{value_field!r}].quantile(0.25), "
            f"'__q3': {data_var}[{value_field!r}].quantile(0.75)}}])"
        )
    extent = mark_props.get("extent") or "stderr"
    lo_tmpl, hi_tmpl = _EXTENT_BOUNDS.get(extent, _EXTENT_BOUNDS["stderr"])
    stmts.append(f"{out_var}['__lo'] = {lo_tmpl.format(v=out_var)}")
    stmts.append(f"{out_var}['__hi'] = {hi_tmpl.format(v=out_var)}")
    # `axis_label()` falls back to `field` when no explicit `title` is set --
    # preserve the *original* field name there rather than letting it show
    # the internal `"__mean"` column name.
    out_value_def = {**value_def, "field": "__mean", "title": value_def.get("title") or value_field}
    return stmts, out_var, out_value_def, ({**cat_def, "field": cat_field} if cat_field else cat_def), horizontal


def _render_errorbar(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    try:
        stmts, out_var, value_def, cat_def, horizontal = _error_extent_stmts(encoding, mark_props, data_var)
    except ValueError:
        if ignore_unsupported:
            return ["# vl2matplotlib: unsupported 'errorbar' mark shape, skipped (ignore_unsupported)"]
        raise

    cat_field = cat_def.get("field")
    color = _color_source(encoding, mark_props)[1]
    caps = "3" if mark_props.get("ticks") else "0"
    if cat_field:
        cat_col, cat_stmts = position_column("y" if horizontal else "x", cat_def, out_var)
        stmts += cat_stmts
        stmts += _axis_setup_stmts(ax_var, "y" if horizontal else "x", cat_def, out_var)
    else:
        cat_col = "0"
    value_label = _axis_setup_stmts(ax_var, "x" if horizontal else "y", value_def, out_var)
    stmts += value_label

    mean_col, lo_col, hi_col = f"{out_var}['__mean']", f"{out_var}['__lo']", f"{out_var}['__hi']"
    lo_err, hi_err = f"({mean_col} - {lo_col})", f"({hi_col} - {mean_col})"
    if horizontal:
        stmts.append(
            f"{ax_var}.errorbar({mean_col}, {cat_col}, xerr=[{lo_err}, {hi_err}], fmt='o', "
            f"color={color}, capsize={caps})"
        )
    else:
        stmts.append(
            f"{ax_var}.errorbar({cat_col}, {mean_col}, yerr=[{lo_err}, {hi_err}], fmt='o', "
            f"color={color}, capsize={caps})"
        )
    return stmts


def _render_errorband(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    try:
        stmts, out_var, value_def, cat_def, horizontal = _error_extent_stmts(encoding, mark_props, data_var)
    except ValueError:
        if ignore_unsupported:
            return ["# vl2matplotlib: unsupported 'errorband' mark shape, skipped (ignore_unsupported)"]
        raise

    cat_field = cat_def.get("field")
    color = _color_source(encoding, mark_props)[1]
    if cat_field:
        cat_col, cat_stmts = position_column("y" if horizontal else "x", cat_def, out_var)
        stmts += cat_stmts
        stmts += _axis_setup_stmts(ax_var, "y" if horizontal else "x", cat_def, out_var)
        stmts.append(f"{out_var} = {out_var}.sort_values({cat_field!r})")
    else:
        cat_col = "0"
    stmts += _axis_setup_stmts(ax_var, "x" if horizontal else "y", value_def, out_var)

    lo_col, hi_col = f"{out_var}['__lo']", f"{out_var}['__hi']"
    fn = "fill_betweenx" if horizontal else "fill_between"
    stmts.append(f"{ax_var}.{fn}({cat_col}, {lo_col}, {hi_col}, color={color}, alpha=0.3, linewidth=0)")
    return stmts


def _grouped_or_single(encoding, mark_props, data_var, draw_stmt_fn, stmts: list[str] | None = None, allow_row_array: bool = True) -> list[str]:
    """`draw_stmt_fn(rows_expr, color_expr, label_expr)` builds the one
    matplotlib call for either the single ungrouped case or each iteration
    of the grouping loop. `stmts`, when given, lets a `color.condition`
    (see `_color_source()`) emit its own per-row color column *before* the
    draw call(s) below reference it; omit (or pass `allow_row_array=False`,
    for a caller -- `line`/`area` -- whose own matplotlib call can't take
    an array `color=`) to fall back to the condition's flat base color
    instead."""
    group_field, fixed_color = _color_source(encoding, mark_props, data_var=data_var, stmts=stmts, allow_row_array=allow_row_array)
    if group_field:
        lines: list[str] = []
        kind, var = _categorical_color_lookup(encoding.get("color"), data_var, lines)
        color_expr = (
            "str(__key)" if kind == "raw"
            else f"{var}.get(__key, {DEFAULT_COLOR})" if kind == "map"
            else f"{var}[__i % len({var})]"
        )
        lines.append(f"for __i, (__key, __rows) in enumerate({data_var}.groupby({group_field!r})):")
        inner = draw_stmt_fn("__rows", color_expr, "str(__key)")
        lines += [f"    {s}" for s in inner]
        return lines
    return draw_stmt_fn(data_var, fixed_color, None)


def _render_point(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    x_def, y_def = encoding.get("x") or {}, encoding.get("y") or {}
    stmts: list[str] = []
    x_col, x_stmts = position_column("x", x_def, data_var)
    y_col, y_stmts = position_column("y", y_def, data_var)
    stmts += x_stmts + y_stmts
    stmts += _axis_setup_stmts(ax_var, "x", x_def, data_var)
    stmts += _axis_setup_stmts(ax_var, "y", y_def, data_var)

    size_def = encoding.get("size")
    size_expr = "36"
    size_stmts: list[str] = []
    # `_size_scale_expr()`'s own output, like `_trail_width_scale_expr()`'s
    # (see its own `width_is_precomputed` docstring note in
    # `_render_trail()`), is a scalar-per-row Series computed once over the
    # full ungrouped `data_var` -- its generated *name* (e.g.
    # `__size_chart_data`) embeds `data_var` as a substring, so the naive
    # `.replace(data_var, rows)` below would corrupt the name itself
    # instead of re-pointing it at a per-group subset.
    size_is_precomputed = False
    if isinstance(size_def, dict) and size_def.get("field") and is_quantitative(size_def):
        size_expr, size_stmts = _size_scale_expr(size_def, data_var)
        size_is_precomputed = True
    elif isinstance(size_def, dict) and size_def.get("field"):
        size_expr = f"{data_var}[{size_def['field']!r}]"
    elif isinstance(size_def, dict) and "value" in size_def:
        size_expr = format_value(size_def["value"])
    stmts += size_stmts
    alpha = _opacity_value(encoding, mark_props)

    color_def = encoding.get("color")
    if isinstance(color_def, dict) and color_def.get("field") and is_quantitative(color_def):
        # A *continuous* color field (e.g. a wind-vector map's own `dir`,
        # 0-360 mapped through a `rainbow` scheme) varies per point rather
        # than falling into a small set of groups to draw one `scatter()`
        # call per -- `_color_source()` deliberately excludes this case
        # (see its own docstring), so it never reaches `_grouped_or_single()`'s
        # categorical grouping loop below at all otherwise, silently
        # falling back to one flat default color for every point. Handled
        # directly here instead via `scatter()`'s own native `c=`/`cmap=`/
        # `norm=` kwargs (a real per-point colormap lookup, vectorized, no
        # `df.iterrows()` loop needed) -- mirrors `_render_rect()`'s
        # identical continuous-color branch.
        _, color_stmts = _continuous_color_setup(color_def, data_var)
        stmts += color_stmts
        cmap_var, norm_var = f"__cmap_{data_var}", f"__cnorm_{data_var}"
        stmts.append(
            f"{ax_var}.scatter({x_col}, {y_col}, s={size_expr}, c={data_var}[{color_def['field']!r}], "
            f"cmap={cmap_var}, norm={norm_var}, alpha={alpha})"
        )
        if not _legend_hidden(color_def):
            stmts.append(f"plt.colorbar(plt.cm.ScalarMappable(norm={norm_var}, cmap={cmap_var}), ax={ax_var})")
        return stmts

    def draw(rows, color, label):
        rx = x_col.replace(data_var, rows) if rows != data_var else x_col
        ry = y_col.replace(data_var, rows) if rows != data_var else y_col
        if rows == data_var:
            s = size_expr
        elif size_is_precomputed:
            s = f"{size_expr}.loc[{rows}.index]"
        else:
            s = size_expr.replace(data_var, rows) if data_var in size_expr else size_expr
        label_kw = f", label={label}" if label else ""
        return [f"{ax_var}.scatter({rx}, {ry}, s={s}, color={color}, alpha={alpha}{label_kw})"]

    stmts += _grouped_or_single(encoding, mark_props, data_var, draw, stmts=stmts)
    group_field = _color_source(encoding, mark_props)[0]
    if group_field and not _legend_hidden(encoding.get("color")):
        stmts.append(_legend_stmt(ax_var, group_field))
    return stmts


def _trail_width_scale_expr(size_def: dict, data_var: str) -> tuple[str, list[str]]:
    """For a `trail` mark's own `size` field: unlike `point`/`circle`'s
    `size` (a marker *area*, scaled via `_size_scale_expr()`'s sqrt
    interpolation), `trail`'s `size` is a stroke *width* directly -- a
    plain linear interpolation into a plausible width range (points), not
    an area-preserving sqrt one. Defaults and `scale.domain`/`.range`/
    `.rangeMin`/`.rangeMax` handling otherwise mirror `_size_scale_expr()`
    exactly."""
    field = size_def["field"]
    scale = size_def.get("scale") if isinstance(size_def.get("scale"), dict) else {}
    domain = scale.get("domain")
    range_ = scale.get("range")
    if isinstance(range_, list) and len(range_) == 2:
        lo_r, hi_r = format_value(range_[0]), format_value(range_[1])
    else:
        lo_r = format_value(scale["rangeMin"]) if "rangeMin" in scale else "0.5"
        hi_r = format_value(scale["rangeMax"]) if "rangeMax" in scale else "8"
    if isinstance(domain, list) and len(domain) == 2:
        lo_d, hi_d = format_value(domain[0]), format_value(domain[1])
    else:
        lo_d, hi_d = f"{data_var}[{field!r}].min()", f"{data_var}[{field!r}].max()"
    var = f"__width_{data_var}"
    stmt = (
        f"{var} = ({lo_r}) + (({hi_r}) - ({lo_r})) * "
        f"(({data_var}[{field!r}] - ({lo_d})) / max((({hi_d}) - ({lo_d})), 1e-9)).clip(lower=0, upper=1)"
    )
    return var, [stmt]


def _render_trail(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    """A `trail` mark is a line whose own *width* varies along its length
    with a `size` field (`trail_color.vl.json`'s own per-symbol stock-price
    trail, thicker where `price` is higher) -- matplotlib's `ax.plot()` has
    no such per-segment-width line primitive at all, so this was entirely
    unimplemented before (a documented v1 scope gap), silently skipped
    under `ignore_unsupported` and drawing nothing. Built instead via
    `matplotlib.collections.LineCollection`: one line segment per
    consecutive pair of points, each given its own linewidth (the average
    of its two endpoints' own scaled `size` value) -- the standard
    matplotlib recipe for a variable-width line. Position channels are
    forced ordinal when ambiguous (`_force_nominal_if_ambiguous()`, the
    same fix `_render_bar()`/`_render_tick()`/`_render_rect()` already
    apply) -- `LineCollection` needs real numeric coordinates via
    `convert_xunits`/`convert_yunits` below, which raises outright on a
    raw string column matplotlib never got the chance to auto-register a
    categorical unit converter for (`trail_comet.vl.json`'s own `y:
    {field: "variety"}`, an untyped nominal field)."""
    x_def, y_def = _force_nominal_if_ambiguous(encoding.get("x") or {}), _force_nominal_if_ambiguous(encoding.get("y") or {})
    stmts: list[str] = []
    x_col, x_stmts = position_column("x", x_def, data_var)
    y_col, y_stmts = position_column("y", y_def, data_var)
    stmts += x_stmts + y_stmts
    stmts += _axis_setup_stmts(ax_var, "x", x_def, data_var)
    stmts += _axis_setup_stmts(ax_var, "y", y_def, data_var)
    # `LineCollection` is built from raw `convert_xunits`/`convert_yunits`-
    # converted floats below (see `draw()`) rather than a real Timestamp
    # array handed to a high-level call like `ax.plot()` -- which normally
    # also registers that axis's own date locator/formatter as a side
    # effect. Without an equivalent call here, a temporal position
    # (`trail_color.vl.json`'s own `x: {field: "date", type: "temporal"}`)
    # would still convert correctly but display raw matplotlib date-epoch
    # floats (e.g. `11000`) as its own tick labels instead of real dates.
    if scale_type(x_def) == "temporal":
        stmts.append(f"{ax_var}.xaxis_date()")
    if scale_type(y_def) == "temporal":
        stmts.append(f"{ax_var}.yaxis_date()")

    x_field_for_sort = x_def.get("field")
    alpha = _opacity_value(encoding, mark_props)
    size_def = encoding.get("size")
    width_expr = "2"
    width_stmts: list[str] = []
    # `_trail_width_scale_expr()`'s own output is a scalar-per-row Series
    # computed *once*, over the full (ungrouped) `data_var` -- like
    # `_render_bar()`'s own identical `width_var` case, this must never be
    # run through the naive `.replace(data_var, rows)` substitution below
    # (its generated *name*, e.g. `__width_chart_data`, embeds `data_var`
    # as a substring, so blind substitution corrupts the name itself
    # rather than re-pointing it at the per-group subset) -- indexed by
    # `.loc[<rows>.index]` instead, which correctly re-aligns it to
    # whichever row subset the current draw call is for.
    width_is_precomputed = False
    if isinstance(size_def, dict) and size_def.get("field") and is_quantitative(size_def):
        width_expr, width_stmts = _trail_width_scale_expr(size_def, data_var)
        width_is_precomputed = True
    elif isinstance(size_def, dict) and size_def.get("field"):
        width_expr = f"{data_var}[{size_def['field']!r}]"
    elif isinstance(size_def, dict) and "value" in size_def:
        width_expr = format_value(size_def["value"])
    stmts += width_stmts

    def draw(rows, color, label):
        sort_stmt = f"{rows} = {rows}.sort_values({x_field_for_sort!r})" if x_field_for_sort else None
        rx = x_col if rows == data_var else x_col.replace(data_var, rows)
        ry = y_col if rows == data_var else y_col.replace(data_var, rows)
        if rows == data_var:
            rw = width_expr
        elif width_is_precomputed:
            rw = f"{width_expr}.loc[{rows}.index]"
        else:
            rw = width_expr.replace(data_var, rows)
        out = []
        if sort_stmt:
            out.append(sort_stmt)
        # `LineCollection` needs plain float coordinates -- `convert_xunits`/
        # `convert_yunits` (matplotlib's own conversion step, already run
        # internally by `ax.plot()`/`ax.scatter()`) turns a temporal
        # position (a raw `pd.Timestamp` column, e.g. `trail_color.vl.
        # json`'s own `x: {field: "date", type: "temporal"}`) into its
        # internal numeric representation first; a no-op for an
        # already-plain numeric column.
        out.append(
            f"__pts = np.column_stack([{ax_var}.convert_xunits({rx}), {ax_var}.convert_yunits({ry})]).reshape(-1, 1, 2)"
        )
        out.append("__segs = np.concatenate([__pts[:-1], __pts[1:]], axis=1)")
        out.append(f"__w = np.asarray({rw}, dtype=float)")
        out.append(
            f"{ax_var}.add_collection(LineCollection(__segs, linewidths=(__w[:-1] + __w[1:]) / 2, "
            f"color={color}, alpha={alpha}))"
        )
        if label:
            out.append(f"{ax_var}.plot([], [], color={color}, alpha={alpha}, label={label})")
        return out

    stmts += _grouped_or_single(encoding, mark_props, data_var, draw, allow_row_array=False)
    stmts.append(f"{ax_var}.autoscale_view()")
    group_field = _color_source(encoding, mark_props)[0]
    if group_field and not _legend_hidden(encoding.get("color")):
        stmts.append(_legend_stmt(ax_var, group_field))
    return stmts


def _render_line_or_area(is_area: bool):
    def render(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
        x_def, y_def = encoding.get("x") or {}, encoding.get("y") or {}
        stmts: list[str] = []
        x_col, x_stmts = position_column("x", x_def, data_var)
        y_col, y_stmts = position_column("y", y_def, data_var)
        stmts += x_stmts + y_stmts
        stmts += _axis_setup_stmts(ax_var, "x", x_def, data_var)
        stmts += _axis_setup_stmts(ax_var, "y", y_def, data_var)

        # An area/line mark's own orientation was previously always assumed
        # vertical (x = domain/sequence, y = value) -- wrong the moment x is
        # the *quantitative* channel and y is the domain one instead
        # (`area_vertical.vl.json`'s own `x: {aggregate: "sum", field:
        # "Weight_in_lbs"}, y: {timeUnit: "year", field: "Year"}`, an area
        # chart running sideways). This affects two things: which field the
        # rows get sorted by before drawing (a line/area connects points
        # *in order* -- sorting by the wrong axis produces a scrambled
        # zigzag instead of a smooth curve/fill), and, for `area`
        # specifically, `fill_betweenx()` (fills horizontally, at each y
        # position) instead of `fill_between()` (fills vertically, at each
        # x position) -- the two are not interchangeable.
        #
        # A plain `is_quantitative()` check on both channels (`_render_bar()`'s
        # own orientation heuristic) isn't enough here: a bare, *single*
        # `timeUnit` like `"year"` reduces to a plain int (this project's
        # own cyclic-timeUnit convention -- see `timeunit.py`'s own module
        # docstring), which `is_quantitative()` correctly reports as
        # quantitative too, making *both* channels look quantitative in
        # this exact spec. A `timeUnit`-bearing channel is excluded from
        # counting as the "value" channel here specifically -- a temporal
        # sequence, even one reduced to a bare cyclic integer, is
        # overwhelmingly the domain/sequence axis, essentially never the
        # thing actually being measured.
        def _is_value_channel(d: dict) -> bool:
            return is_quantitative(d) and not d.get("timeUnit") and not d.get("_was_timeunit")

        horizontal = _is_value_channel(x_def) and not _is_value_channel(y_def)
        domain_field_for_sort = y_def.get("field") if horizontal else x_def.get("field")
        alpha = _opacity_value(encoding, mark_props)
        value_channel = "x" if horizontal else "y"
        companion = encoding.get(f"{value_channel}2")
        base_expr = f"{data_var}[{companion['field']!r}]" if isinstance(companion, dict) and companion.get("field") else "0"
        # `mark: {type: "line", point: true}` (or a style-override object,
        # `{point: {color: ..., size: ...}}`) overlays a marker at each of
        # the line's own data points -- previously dropped entirely,
        # `mark_props` (already captures every mark-object key besides
        # `type`) was just never consulted here. `point: false`/absent
        # (the plain default) draws no marker, matching a bare `ax.plot()`.
        point_prop = mark_props.get("point")
        marker_kw = ", marker='o', markersize=6, markeredgewidth=0" if (not is_area and point_prop) else ""

        def draw(rows, color, label):
            # Sorted by the domain axis within each group -- a line/area is
            # drawn by connecting points *in order*, and grouping by
            # color/detail doesn't itself guarantee the rows within one
            # group already arrived in that order (e.g. after a
            # `groupby()` regrouping).
            sort_stmt = f"{rows} = {rows}.sort_values({domain_field_for_sort!r})" if domain_field_for_sort else None
            rx = x_col if rows == data_var else x_col.replace(data_var, rows)
            ry = y_col if rows == data_var else y_col.replace(data_var, rows)
            label_kw = f", label={label}" if label else ""
            out = []
            if sort_stmt:
                out.append(sort_stmt)
            if is_area:
                base = base_expr if rows == data_var else base_expr.replace(data_var, rows)
                if horizontal:
                    out.append(f"{ax_var}.fill_betweenx({ry}, {base}, {rx}, color={color}, alpha={alpha}{label_kw})")
                else:
                    out.append(f"{ax_var}.fill_between({rx}, {base}, {ry}, color={color}, alpha={alpha}{label_kw})")
            else:
                out.append(f"{ax_var}.plot({rx}, {ry}, color={color}, alpha={alpha}{label_kw}{marker_kw})")
            return out

        stmts += _grouped_or_single(encoding, mark_props, data_var, draw, allow_row_array=False)
        group_field = _color_source(encoding, mark_props)[0]
        if group_field and not _legend_hidden(encoding.get("color")):
            stmts.append(_legend_stmt(ax_var, group_field))
        # `mark: {invalid: null}` means "don't filter invalid rows" (unlike
        # the default, `"filter"`, which drops them before the scale's own
        # domain is even computed) -- so, unlike the default case, the
        # *other* channel's own null values must not shrink the drawn
        # extent's domain axis: `area_invalid_null.vl.json`'s own edge rows
        # (`x: -1, y: null` / `x: 10, y: null`) have a perfectly real `x`,
        # only `y` is null, but `fill_between()`'s own internal masking
        # excludes a NaN-`y` row from its bounding box entirely, silently
        # cropping the visible x-axis range to only the *valid* rows'
        # extent (missing real Vega-Lite's own -1..10 domain).
        # `update_datalim`/`autoscale_view()` extends (not overwrites) the
        # existing view to include the domain field's own full range.
        if "invalid" in mark_props and mark_props.get("invalid") is None:
            domain_col = y_col if horizontal else x_col
            lim_fn = "set_ylim" if horizontal else "set_xlim"
            cur_fn = "get_ylim" if horizontal else "get_xlim"
            stmts.append(
                f"{ax_var}.{lim_fn}(min({ax_var}.{cur_fn}()[0], ({domain_col}).min()), "
                f"max({ax_var}.{cur_fn}()[1], ({domain_col}).max()))"
            )
        return stmts

    return render


def _render_rule(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    x_def, y_def = encoding.get("x"), encoding.get("y")
    x2_def, y2_def = encoding.get("x2"), encoding.get("y2")
    stmts: list[str] = []
    alpha = _opacity_value(encoding, mark_props)

    if has_field(x_def) and has_field(y_def) and (x2_def or y2_def):
        x_col, xs = position_column("x", x_def, data_var)
        y_col, ys = position_column("y", y_def, data_var)
        stmts += xs + ys
        # `vlines`/`hlines` accept a per-element color array (one color per
        # line), so this is the one `rule` shape that can honor a
        # `color.condition` (a candlestick chart's own up/down color, drawn
        # via this exact x/y/y2 range-bar-adjacent shape) as more than a
        # single flat color -- the branches below (a single `axvline`/
        # `axhline` per row, or one fixed reference line) can't.
        color = _color_source(encoding, mark_props, data_var=data_var, stmts=stmts)[1]
        if y2_def and y2_def.get("field"):
            stmts.append(f"{ax_var}.vlines({x_col}, {y_col}, {data_var}[{y2_def['field']!r}], color={color}, alpha={alpha})")
        elif x2_def and x2_def.get("field"):
            stmts.append(f"{ax_var}.hlines({y_col}, {x_col}, {data_var}[{x2_def['field']!r}], color={color}, alpha={alpha})")
        return stmts

    color = _color_source(encoding, mark_props, allow_row_array=False)[1]
    if has_field(x_def) and not has_field(y_def):
        x_col, xs = position_column("x", x_def, data_var)
        stmts += xs
        stmts.append(f"for __v in {x_col}: {ax_var}.axvline(x=__v, color={color}, alpha={alpha})")
        return stmts
    if has_field(y_def) and not has_field(x_def):
        y_col, ys = position_column("y", y_def, data_var)
        stmts += ys
        stmts.append(f"for __v in {y_col}: {ax_var}.axhline(y=__v, color={color}, alpha={alpha})")
        return stmts
    if isinstance(x_def, dict) and ("value" in x_def or "datum" in x_def):
        stmts.append(f"{ax_var}.axvline(x={channel_value_expr(x_def)}, color={color}, alpha={alpha})")
        return stmts
    if isinstance(y_def, dict) and ("value" in y_def or "datum" in y_def):
        stmts.append(f"{ax_var}.axhline(y={channel_value_expr(y_def)}, color={color}, alpha={alpha})")
        return stmts
    if ignore_unsupported:
        return ["# vl2matplotlib: unsupported rule mark shape, skipped (ignore_unsupported)"]
    raise ValueError('Unsupported: "rule" mark requires an x and/or y encoding')


def _render_tick(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    x_def, y_def = encoding.get("x") or {}, encoding.get("y") or {}
    stmts: list[str] = []
    alpha = _opacity_value(encoding, mark_props)
    horizontal = is_quantitative(y_def) and not is_quantitative(x_def)
    cat_channel = "x" if horizontal else "y"

    offset_def = encoding.get(f"{cat_channel}Offset")
    dodge_field = offset_def.get("field") if isinstance(offset_def, dict) else None
    if dodge_field:
        # Same reasoning as `_render_bar()`'s own identical case: force the
        # (very often untyped) category channel ordinal so the dodge shift
        # below can do arithmetic on it, and thread the offset field
        # through as this mark's own grouping field so it also survives
        # any implicit aggregate (`prepare.py`'s `_ALL_CHANNELS` already
        # includes `xOffset`/`yOffset` for exactly this).
        if cat_channel == "x":
            x_def = _force_nominal_if_ambiguous(x_def)
        else:
            y_def = _force_nominal_if_ambiguous(y_def)

    x_col, xs = position_column("x", x_def, data_var)
    y_col, ys = position_column("y", y_def, data_var)
    stmts += xs + ys
    stmts += _axis_setup_stmts(ax_var, "x", x_def, data_var)
    stmts += _axis_setup_stmts(ax_var, "y", y_def, data_var)

    if dodge_field:
        group_field, fixed_color = _color_source(encoding, mark_props, data_var=data_var, stmts=stmts)
        by_color = group_field == dodge_field
        cat_col = x_col if cat_channel == "x" else y_col
        stmts.append(f"__dodge_cats = sorted({data_var}[{dodge_field!r}].dropna().unique().tolist(), key={ORDINAL_SORT_KEY})")
        stmts.append("__n_dodge = max(len(__dodge_cats), 1)")
        r_cat = cat_col.replace(data_var, "__drows")
        shifted_cat = f"({r_cat} + (__i - (__n_dodge - 1) / 2) * (0.8 / __n_dodge))"
        half = "(0.45 / __n_dodge)"
        if by_color:
            kind, var = _categorical_color_lookup(encoding.get("color"), data_var, stmts)
            color_expr = (
                "str(__dk)" if kind == "raw"
                else f"{var}.get(__dk, {DEFAULT_COLOR})" if kind == "map"
                else f"{var}[__i % len({var})]"
            )
        else:
            color_expr = fixed_color
        stmts.append("for __i, __dk in enumerate(__dodge_cats):")
        stmts.append(f"    __drows = {data_var}[{data_var}[{dodge_field!r}] == __dk]")
        if horizontal:
            other = y_col.replace(data_var, "__drows")
            stmts.append(f"    {ax_var}.hlines({other}, {shifted_cat} - {half}, {shifted_cat} + {half}, color={color_expr}, alpha={alpha}, label=str(__dk))")
        else:
            other = x_col.replace(data_var, "__drows")
            stmts.append(f"    {ax_var}.vlines({other}, {shifted_cat} - {half}, {shifted_cat} + {half}, color={color_expr}, alpha={alpha}, label=str(__dk))")
        if not (by_color and _legend_hidden(encoding.get("color"))):
            stmts.append(_legend_stmt(ax_var, dodge_field))
        return stmts

    color = _color_source(encoding, mark_props, data_var=data_var, stmts=stmts)[1]
    if horizontal:
        stmts.append(f"{ax_var}.hlines({y_col}, {x_col} - 0.45, {x_col} + 0.45, color={color}, alpha={alpha})")
    else:
        stmts.append(f"{ax_var}.vlines({x_col}, {y_col} - 0.45, {y_col} + 0.45, color={color}, alpha={alpha})")
    return stmts


def _position_is_numeric_safe(def_: dict) -> bool:
    """Whether a position channel's own `position_column()` expression is
    known to be numeric -- a field-less channel (a broadcast literal) and
    an ordinal one (always an integer `__pos` column, regardless of the
    underlying category dtype) both always are; a quantitative/temporal
    field is too. Anything else (a field with no explicit `type` and
    nothing implying one) might, at runtime, turn out to be a raw string
    column instead."""
    from .scales import is_temporal

    if not isinstance(def_, dict) or not def_.get("field"):
        return True
    return is_quantitative(def_) or is_temporal(def_) or scale_type(def_) == "ordinal"


def _render_text(encoding, mark_props, data_var, ax_var, ignore_unsupported) -> list[str]:
    # Unlike `bar`/`scatter`/`plot` (which all accept a raw string position
    # and matplotlib auto-establishes a categorical axis for it),
    # `ax.text()` does *not* -- a bare ambiguous-typed (no explicit `type`,
    # nothing implying `quantitative`) field passed straight through
    # crashes outright (`ConversionError: Failed to convert value(s) to
    # axis units`), not just for a standalone text mark but also (the
    # shape that actually surfaces this in the corpus) when a `text` layer
    # shares its `Axes` with a `bar` sibling layer that already coerced the
    # identical field to an ordinal integer position -- the mismatch alone
    # is enough to break the shared axis. Always forced here (unlike
    # `_render_bar()`/`_render_tick()`'s identical fix, gated on a dodge
    # being present) since there's no matplotlib-native fallback for text
    # the way there is for those.
    x_def, y_def = _force_nominal_if_ambiguous(encoding.get("x") or {}), _force_nominal_if_ambiguous(encoding.get("y") or {})
    text_def = encoding.get("text")
    if not isinstance(text_def, dict) or not text_def.get("field"):
        if ignore_unsupported:
            return ["# vl2matplotlib: unsupported text mark (no text encoding), skipped (ignore_unsupported)"]
        raise ValueError('Unsupported: "text" mark requires a text encoding')
    stmts: list[str] = []
    x_col, xs = position_column("x", x_def, data_var)
    y_col, ys = position_column("y", y_def, data_var)
    stmts += xs + ys
    stmts += _axis_setup_stmts(ax_var, "x", x_def, data_var)
    stmts += _axis_setup_stmts(ax_var, "y", y_def, data_var)
    # `bandPosition` (most often paired with an implicit-stacking `x2`/`y2`
    # companion `stack.py`'s own `apply_stacking_to_encoding()` adds --
    # `stacked_bar_h_normalized_labeled.vl.json`'s own label layer, meant
    # to sit centered within each stacked segment rather than pinned to
    # its own end) blends the position with its companion instead of using
    # the position channel's own field alone -- `0.5` (the common case)
    # lands exactly at the segment's midpoint.
    for channel, col in (("x", x_col), ("y", y_col)):
        def_ = x_def if channel == "x" else y_def
        band = def_.get("bandPosition")
        companion = encoding.get(f"{channel}2")
        if isinstance(band, (int, float)) and isinstance(companion, dict) and companion.get("field"):
            companion_col = f"{data_var}[{companion['field']!r}]"
            blended = f"({companion_col} + {band!r} * ({col} - {companion_col}))"
            if channel == "x":
                x_col = blended
            else:
                y_col = blended
    field = text_def["field"]
    # `text` draws via one `df.iterrows()`-adjacent `zip()` loop, not
    # `_grouped_or_single()`'s own one-call-per-group idiom every other
    # mark uses for a categorical `color` -- so `encoding.color` was never
    # even looked at here at all, every label always drawing in
    # matplotlib's own default (black) text color regardless of the spec
    # (`text_scatterplot_colored.vl.json`'s own `color: {field: "Origin"}`,
    # dropped entirely). A continuous color field reuses
    # `_continuous_color_setup()`'s shared cmap/norm pair, evaluated
    # per-row; a categorical one needs a real `value -> color` map (there's
    # no natural per-row "draw order index" the way a grouped loop has) --
    # built via `_categorical_color_lookup()`'s existing `_domain_expr`
    # convention (see `_share_color_domain()`'s own docstring in
    # `translator.py`), pointed at this field's own sorted unique values
    # since text never spans multiple already-filtered panels the way a
    # facet/concat child does.
    color_def = encoding.get("color")
    color_stmts: list[str] = []
    if isinstance(color_def, dict) and color_def.get("field") and is_quantitative(color_def):
        _, color_stmts = _continuous_color_setup(color_def, data_var)
        cmap_var, norm_var = f"__cmap_{data_var}", f"__cnorm_{data_var}"
        color_expr = f"{cmap_var}({norm_var}(__c))"
        color_col = f"{data_var}[{color_def['field']!r}]"
    elif isinstance(color_def, dict) and color_def.get("field"):
        color_field = color_def["field"]
        lookup_def = dict(color_def)
        lookup_scale = dict(color_def.get("scale") or {})
        lookup_scale.setdefault("_domain_expr", f"sorted({data_var}[{color_field!r}].dropna().unique().tolist(), key={ORDINAL_SORT_KEY})")
        lookup_def["scale"] = lookup_scale
        _, var = _categorical_color_lookup(lookup_def, data_var, color_stmts)
        color_expr = f"{var}.get(__c, {DEFAULT_COLOR})"
        color_col = f"{data_var}[{color_field!r}]"
    else:
        # `text`'s own Vega-Lite default color is black, distinct from
        # every other mark's own default blue (`DEFAULT_COLOR`) --
        # `_color_source()`'s own fallback parameter lets this differ
        # without changing the shared default every other renderer relies
        # on.
        color_expr = _color_source(encoding, mark_props, fallback="'black'")[1]
        color_col = None
    stmts += color_stmts
    if color_col:
        stmts.append(
            f"for __x, __y, __t, __c in zip({x_col}, {y_col}, {data_var}[{field!r}], {color_col}): "
            f"{ax_var}.text(__x, __y, str(__t), ha='center', va='center', fontsize=9, color={color_expr})"
        )
    else:
        stmts.append(
            f"for __x, __y, __t in zip({x_col}, {y_col}, {data_var}[{field!r}]): "
            f"{ax_var}.text(__x, __y, str(__t), ha='center', va='center', fontsize=9, color={color_expr})"
        )
    # `ax.text()`, unlike `scatter`/`plot`/`bar`, never participates in
    # matplotlib's own autoscale/data-limit tracking -- without this, a
    # panel containing *only* text marks (e.g. a column of category labels
    # next to a bar panel, a common small-multiples idiom) keeps the Axes'
    # default `[0, 1]` view and every label renders entirely off-screen,
    # invisible. `update_datalim()` + `autoscale_view()` (rather than a
    # flat `set_xlim`/`set_ylim`) *extends* the view to include the text
    # positions without clobbering a range another, already-drawn mark on
    # this same (layered) Axes already set correctly. Only attempted when
    # BOTH positions are known-numeric (quantitative/temporal, or ordinal --
    # already converted to an integer `__pos` column by `position_column()`
    # regardless of the underlying category dtype): an ambiguously-typed
    # channel (no explicit `type`, nothing implying `quantitative`) can hold
    # genuinely non-numeric data at runtime (e.g. `text` labeling an image-
    # URL column), which `update_datalim` can't handle -- skipped here
    # rather than crashing the whole script over a cosmetic view-range nudge.
    if _position_is_numeric_safe(x_def) and _position_is_numeric_safe(y_def):
        # `update_datalim()` itself requires already-numeric (float) data --
        # a raw `pd.Timestamp` column (a `temporal` position, which counts
        # as "numeric-safe" above since it's never a raw string) fails
        # `np.isfinite()` outright. `ax.convert_xunits()`/`convert_yunits()`
        # is matplotlib's own conversion step (already run internally by
        # `ax.text()`/`ax.bar()`/... themselves) that turns a date into its
        # internal float representation first; a no-op for an already-plain
        # numeric column (no unit converter registered for it).
        stmts.append(
            f"{ax_var}.update_datalim(list(zip({ax_var}.convert_xunits({x_col}), {ax_var}.convert_yunits({y_col}))))"
        )
        stmts.append(f"{ax_var}.autoscale_view()")
    return stmts


_RENDERERS = {
    "bar": _render_bar,
    "point": _render_point,
    "circle": _render_point,
    "square": _render_point,
    "line": _render_line_or_area(is_area=False),
    "area": _render_line_or_area(is_area=True),
    "rule": _render_rule,
    "tick": _render_tick,
    "text": _render_text,
    "rect": _render_rect,
    "boxplot": _render_boxplot,
    "arc": _render_arc,
    "errorbar": _render_errorbar,
    "errorband": _render_errorband,
    "trail": _render_trail,
}
