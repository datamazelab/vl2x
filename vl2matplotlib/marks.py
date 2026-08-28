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
from .scales import CATEGORICAL_PALETTE, is_quantitative, position_column, scale_type

DEFAULT_COLOR = "'#4C78A8'"  # Vega-Lite's own default mark color


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

    value_field = value_def.get("field")
    top_expr = f"{data_var}[{value_field!r}]" if value_field else "0"
    companion = encoding.get(f"{value_channel}2")
    base_expr = f"{data_var}[{companion['field']!r}]" if isinstance(companion, dict) and companion.get("field") else "0"

    alpha = _opacity_value(encoding, mark_props)
    call = "barh" if horizontal else "bar"
    length_kw = "height" if horizontal else "width"
    bottom_kw = "left" if horizontal else "bottom"
    height_expr = f"({top_expr} - ({base_expr}))" if companion else top_expr

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
    align_kw = ""
    width_is_group_dependent = False
    if not cat_field or not is_quantitative(cat_def) or scale_type(cat_def) == "ordinal":
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
        width_var = f"__{cat_channel}_bar_width_{data_var}"
        stmts.append(
            f"{width_var} = ((({cat_col}).max() - ({cat_col}).min()) / max(({cat_col}).nunique() - 1, 1)) * 0.6 "
            f"if ({cat_col}).nunique() > 1 else 0.8"
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
        stmts.append(f"__dodge_cats = sorted({data_var}[{dodge_field!r}].dropna().unique().tolist(), key=str)")
        stmts.append("__n_dodge = max(len(__dodge_cats), 1)")
        sub_width = f"(({width_expr}) / __n_dodge)"
        r_sub_width = sub_width.replace(data_var, "__drows") if width_is_group_dependent else sub_width
        r_cat = cat_col.replace(data_var, "__drows")
        r_height = height_expr.replace(data_var, "__drows")
        r_base = base_expr.replace(data_var, "__drows")
        shifted_cat = f"({r_cat} + (__i - (__n_dodge - 1) / 2) * ({r_sub_width}))"
        color_expr = f"{CATEGORICAL_PALETTE}[__i % 10]" if by_color else fixed_color
        stmts.append(f"for __i, __dk in enumerate(__dodge_cats):")
        stmts.append(f"    __drows = {data_var}[{data_var}[{dodge_field!r}] == __dk]")
        stmts.append(
            f"    {ax_var}.{call}({shifted_cat}, {r_height}, {length_kw}={r_sub_width}, {bottom_kw}={r_base}, "
            f"color={color_expr}, alpha={alpha}, label=str(__dk){align_kw})"
        )
        stmts.append(f"{ax_var}.legend(title={dodge_field!r})")
        return stmts

    def draw(rows, color, label):
        r_cat = cat_col if rows == data_var else cat_col.replace(data_var, rows)
        r_height = height_expr if rows == data_var else height_expr.replace(data_var, rows)
        r_base = base_expr if rows == data_var else base_expr.replace(data_var, rows)
        r_width = width_expr if (rows == data_var or not width_is_group_dependent) else width_expr.replace(data_var, rows)
        label_kw = f", label={label}" if label else ""
        return [
            f"{ax_var}.{call}({r_cat}, {r_height}, {length_kw}={r_width}, {bottom_kw}={r_base}, "
            f"color={color}, alpha={alpha}{label_kw}{align_kw})"
        ]

    stmts += _grouped_or_single(encoding, mark_props, data_var, draw, stmts=stmts)
    group_field = _color_source(encoding, mark_props)[0]
    if group_field:
        stmts.append(f"{ax_var}.legend(title={group_field!r})")
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
    x_def, y_def = _force_nominal_if_ambiguous(encoding.get("x") or {}), _force_nominal_if_ambiguous(encoding.get("y") or {})
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
        colorbar_stmt = f"plt.colorbar(plt.cm.ScalarMappable(norm=__cnorm_{data_var}, cmap=__cmap_{data_var}), ax={ax_var})"
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
        stmts.append(f"__groups = sorted({data_var}[{cat_field!r}].dropna().unique().tolist(), key=str)")
        stmts.append(
            f"__box_data = [{data_var}[{data_var}[{cat_field!r}] == __g][{value_field!r}].dropna().values for __g in __groups]"
        )
        stmts.append(
            f"__bp = {ax_var}.boxplot(__box_data, positions=list(range(len(__groups))), {vert_kw}, whis={whis}, patch_artist=True)"
        )
        if has_color:
            stmts.append(
                f"for __i, __patch in enumerate(__bp['boxes']): __patch.set_facecolor({CATEGORICAL_PALETTE}[__i % 10])"
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
    if color_field:
        stmts.append(
            f"{ax_var}.pie({data_var}[{theta_field!r}], labels={data_var}[{color_field!r}].astype(str), "
            f"colors=[{CATEGORICAL_PALETTE}[__i % 10] for __i in range(len({data_var}))]{wedge_kw})"
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
        lines = [f"for __i, (__key, __rows) in enumerate({data_var}.groupby({group_field!r})):"]
        inner = draw_stmt_fn("__rows", f"{CATEGORICAL_PALETTE}[__i % 10]", "str(__key)")
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
    if isinstance(size_def, dict) and size_def.get("field"):
        size_expr = f"{data_var}[{size_def['field']!r}]"
    elif isinstance(size_def, dict) and "value" in size_def:
        size_expr = format_value(size_def["value"])
    alpha = _opacity_value(encoding, mark_props)

    def draw(rows, color, label):
        rx = x_col.replace(data_var, rows) if rows != data_var else x_col
        ry = y_col.replace(data_var, rows) if rows != data_var else y_col
        s = size_expr.replace(data_var, rows) if rows != data_var and data_var in size_expr else size_expr
        label_kw = f", label={label}" if label else ""
        return [f"{ax_var}.scatter({rx}, {ry}, s={s}, color={color}, alpha={alpha}{label_kw})"]

    stmts += _grouped_or_single(encoding, mark_props, data_var, draw, stmts=stmts)
    group_field = _color_source(encoding, mark_props)[0]
    if group_field:
        stmts.append(f"{ax_var}.legend(title={group_field!r})")
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

        x_field_for_sort = x_def.get("field")
        alpha = _opacity_value(encoding, mark_props)
        y2 = encoding.get("y2")
        base_expr = f"{data_var}[{y2['field']!r}]" if isinstance(y2, dict) and y2.get("field") else "0"

        def draw(rows, color, label):
            # Sorted by x within each group -- a line/area is drawn by
            # connecting points *in order*, and grouping by color/detail
            # doesn't itself guarantee the rows within one group already
            # arrived in x order (e.g. after a `groupby()` regrouping).
            sort_stmt = f"{rows} = {rows}.sort_values({x_field_for_sort!r})" if x_field_for_sort else None
            rx = x_col if rows == data_var else x_col.replace(data_var, rows)
            ry = y_col if rows == data_var else y_col.replace(data_var, rows)
            label_kw = f", label={label}" if label else ""
            out = []
            if sort_stmt:
                out.append(sort_stmt)
            if is_area:
                base = base_expr if rows == data_var else base_expr.replace(data_var, rows)
                out.append(f"{ax_var}.fill_between({rx}, {base}, {ry}, color={color}, alpha={alpha}{label_kw})")
            else:
                out.append(f"{ax_var}.plot({rx}, {ry}, color={color}, alpha={alpha}{label_kw})")
            return out

        stmts += _grouped_or_single(encoding, mark_props, data_var, draw, allow_row_array=False)
        group_field = _color_source(encoding, mark_props)[0]
        if group_field:
            stmts.append(f"{ax_var}.legend(title={group_field!r})")
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
        stmts.append(f"__dodge_cats = sorted({data_var}[{dodge_field!r}].dropna().unique().tolist(), key=str)")
        stmts.append("__n_dodge = max(len(__dodge_cats), 1)")
        r_cat = cat_col.replace(data_var, "__drows")
        shifted_cat = f"({r_cat} + (__i - (__n_dodge - 1) / 2) * (0.8 / __n_dodge))"
        half = "(0.45 / __n_dodge)"
        color_expr = f"{CATEGORICAL_PALETTE}[__i % 10]" if by_color else fixed_color
        stmts.append("for __i, __dk in enumerate(__dodge_cats):")
        stmts.append(f"    __drows = {data_var}[{data_var}[{dodge_field!r}] == __dk]")
        if horizontal:
            other = y_col.replace(data_var, "__drows")
            stmts.append(f"    {ax_var}.hlines({other}, {shifted_cat} - {half}, {shifted_cat} + {half}, color={color_expr}, alpha={alpha}, label=str(__dk))")
        else:
            other = x_col.replace(data_var, "__drows")
            stmts.append(f"    {ax_var}.vlines({other}, {shifted_cat} - {half}, {shifted_cat} + {half}, color={color_expr}, alpha={alpha}, label=str(__dk))")
        stmts.append(f"{ax_var}.legend(title={dodge_field!r})")
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
    x_def, y_def = encoding.get("x") or {}, encoding.get("y") or {}
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
    field = text_def["field"]
    stmts.append(
        f"for __x, __y, __t in zip({x_col}, {y_col}, {data_var}[{field!r}]): "
        f"{ax_var}.text(__x, __y, str(__t), ha='center', va='center', fontsize=9)"
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
        stmts.append(f"{ax_var}.update_datalim(list(zip({x_col}, {y_col})))")
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
}
