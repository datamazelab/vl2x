"""Implicit per-mark stacking: Vega-Lite automatically stacks a `bar`/`area`
mark's own value channel when a `color`/`detail` channel also groups it (and
stacking isn't explicitly turned off) -- matplotlib has nothing resembling
this built in (unlike ggplot2's `position_stack()`), so it's computed
directly as two new columns, `<field>_stack0`/`<field>_stack1` (the
segment's own bottom/top), via a `groupby(position).cumsum()` -- pandas'
own cumulative sum, grouped by the position field, *is* the stack: each
row's running total (minus its own value, for the bottom edge) is exactly
where that row's own segment starts.

Three modes, all sharing that same cumsum-based shape: `"zero"` (the
default -- stacks from a zero baseline, as above), `"normalize"` (each
category's own stack rescaled so its *total* sums to 1 -- a 100% stacked
chart -- by normalizing the per-row value before cumulative-summing it,
rather than summing first and dividing after, so the same cumsum logic
produces the right numbers either way), and `"center"` (a streamgraph-style
stack straddling zero -- the same zero-baseline cumsum, shifted down by
half of the category's own total)."""

from __future__ import annotations

_STACKABLE_MARKS = {"bar", "area"}
# A mark that only stacks when the spec *explicitly* asks for it (`stack`
# actually present on its own value channel) -- unlike `bar`/`area`, which
# default to zero-stacking whenever a `color`/`detail` groups them even
# with no `stack` key at all (Vega-Lite's own real default for those two
# mark types specifically). A `text` layer sibling to a stacked bar/area
# (a common "labeled stacked bar" idiom, e.g. `stacked_bar_h_normalized_
# labeled.vl.json`'s own label layer) explicitly repeats the *same*
# `stack` setting on its own aggregate `x` so its labels land centered
# within each segment -- previously ignored entirely, since `text` wasn't
# a stackable mark at all, so the label layer's own `x` used the raw,
# un-stacked aggregate value instead (often orders of magnitude off from
# the bar layer's own normalized `[0, 1]` range, on the *same* shared
# Axes -- squeezing the real stacked bars down to an invisible sliver).
_STACKABLE_IF_EXPLICIT_MARKS = {"text"}


def plan_stacking(mark, encoding: dict) -> dict | None:
    mark_type = mark if isinstance(mark, str) else mark.get("type")
    explicit_only = mark_type in _STACKABLE_IF_EXPLICIT_MARKS
    if mark_type not in _STACKABLE_MARKS and not explicit_only:
        return None
    # `xOffset`/`yOffset` (a grouped/dodged bar chart -- see `marks.py`'s
    # own `_render_bar()`) is a mutually exclusive alternative to stacking
    # for the *same* color-grouped mark: Vega-Lite dodges side-by-side
    # rather than stacking when an offset channel is present, regardless of
    # whether `color`/`detail` also groups it (they almost always share the
    # same field in a grouped bar chart, exactly the shape that would
    # otherwise be mistaken for a stack here).
    if encoding.get("xOffset") or encoding.get("yOffset"):
        return None

    # The value axis is whichever of x/y is quantitative with no companion
    # range of its own already (an explicit x2/y2 already fully specifies
    # the shape -- nothing left to stack). `is_quantitative()` (not a bare
    # `type` check) so an `aggregate`/`bin`-implied quantitative channel
    # with no explicit `type` at all -- the same common shape fixed
    # elsewhere for bar orientation/width -- still triggers stacking.
    from .scales import is_quantitative

    for channel in ("y", "x"):
        d = encoding.get(channel)
        if not isinstance(d, dict) or not is_quantitative(d) or not d.get("field"):
            continue
        if encoding.get(f"{channel}2"):
            continue
        pos_channel = channel
        break
    else:
        return None

    # A *continuous* color/opacity field (`bar_invalid_color_show_
    # override.vl.json`'s own `color: {field: "c", type: "quantitative"}`)
    # colors each bar individually via a colormap -- it never forms
    # discrete stacking groups the way a categorical one does, so treating
    # it as a `group_field` here stacked bars by whatever `pos_channel`'s
    # own category happened to repeat on, silently wrong (and, since
    # `_render_bar()`'s own draw path never wired continuous color in at
    # all either, also colorless).
    group_channel = None
    for ch in ("color", "detail", "opacity"):
        d = encoding.get(ch)
        if isinstance(d, dict) and d.get("field") and not is_quantitative(d):
            group_channel = ch
            break
    if group_channel is None:
        return None

    category_channel = "x" if pos_channel == "y" else "y"
    category_def = encoding.get(category_channel)
    if not isinstance(category_def, dict) or not category_def.get("field"):
        return None

    stack_setting = encoding[pos_channel].get("stack")
    if stack_setting is False:
        return None
    if explicit_only and stack_setting is None:
        return None
    # Vega-Lite's own default depends on the mark: `area` defaults to
    # `"zero"` too (the same as `bar`), so `True`/absent both mean exactly
    # that -- only the two explicit string values pick a different mode.
    mode = stack_setting if stack_setting in ("normalize", "center") else "zero"

    return {
        "pos_channel": pos_channel,
        "value_field": encoding[pos_channel]["field"],
        "category_field": category_def["field"],
        "group_field": encoding[group_channel]["field"],
        "mode": mode,
    }


def render_stacking_statements(data_var: str, plan: dict) -> list[str]:
    field = plan["value_field"]
    cat = plan["category_field"]
    group = plan["group_field"]
    mode = plan.get("mode", "zero")
    start_col = f"{field}_stack0"
    end_col = f"{field}_stack1"
    stmts = [f"{data_var} = {data_var}.sort_values([{cat!r}, {group!r}]).reset_index(drop=True)"]

    if mode == "normalize":
        # Normalize the per-row *value* first (each category's own rows
        # divided by that category's own total), then cumulative-sum the
        # normalized value -- the running total across a full category
        # lands on exactly 1.0 by construction, a 100%-stacked chart,
        # without a separate "sum first, divide after" pass.
        norm_col = f"__{field}_stack_norm"
        stmts.append(f"{data_var}[{norm_col!r}] = {data_var}[{field!r}] / {data_var}.groupby({cat!r})[{field!r}].transform('sum')")
        stmts.append(f"{data_var}[{end_col!r}] = {data_var}.groupby({cat!r})[{norm_col!r}].cumsum()")
        stmts.append(f"{data_var}[{start_col!r}] = {data_var}[{end_col!r}] - {data_var}[{norm_col!r}]")
    elif mode == "center":
        # A streamgraph-style stack straddling zero: the ordinary zero-
        # baseline cumsum, shifted down by half of the category's own
        # total so the whole stack is centered on the axis instead of
        # sitting on top of it.
        half_total = f"(0.5 * {data_var}.groupby({cat!r})[{field!r}].transform('sum'))"
        stmts.append(f"{data_var}[{end_col!r}] = {data_var}.groupby({cat!r})[{field!r}].cumsum() - {half_total}")
        stmts.append(f"{data_var}[{start_col!r}] = {data_var}[{end_col!r}] - {data_var}[{field!r}]")
    else:
        stmts.append(f"{data_var}[{end_col!r}] = {data_var}.groupby({cat!r})[{field!r}].cumsum()")
        stmts.append(f"{data_var}[{start_col!r}] = {data_var}[{end_col!r}] - {data_var}[{field!r}]")

    return stmts


def apply_stacking_to_encoding(encoding: dict, plan: dict) -> dict:
    channel = plan["pos_channel"]
    channel2 = f"{channel}2"
    field = plan["value_field"]
    rewritten = dict(encoding)
    rewritten[channel] = {**encoding[channel], "field": f"{field}_stack1"}
    rewritten[channel2] = {"field": f"{field}_stack0"}
    return rewritten
