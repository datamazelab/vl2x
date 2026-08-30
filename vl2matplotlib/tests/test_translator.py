"""Fast, hand-written pytest suite covering the same feature areas the
corpus validation harnesses exercise, with small specs -- catches
regressions without needing the external `vega-lite-example-specs/`
checkout. Mirrors `vl2altair`'s own `tests/test_translator.py` in spirit:
translate, `exec()` the result, and assert on the real `Figure`/`Axes`
object it produces (not just that no exception was raised)."""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))

import pytest

from vl2matplotlib import vegalite_to_matplotlib_code


def render(spec: dict, **kwargs):
    code = vegalite_to_matplotlib_code(spec, **kwargs)
    ns: dict = {}
    try:
        exec(compile(code, "<generated>", "exec"), ns)
    except Exception as e:  # pragma: no cover - re-raised with the source for a legible pytest failure
        raise AssertionError(f"{e}\n\n--- generated code ---\n{code}") from e
    return ns[kwargs.get("chart_var", "fig")], code


def test_bar_chart_nominal_x_quantitative_y():
    fig, _ = render({
        "data": {"values": [{"a": "A", "b": 28}, {"a": "B", "b": 55}, {"a": "C", "b": 43}]},
        "mark": "bar",
        "encoding": {"x": {"field": "a", "type": "nominal"}, "y": {"field": "b", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 3


def test_bar_chart_inline_count_aggregate():
    fig, _ = render({
        "data": {"values": [{"cat": "x"}, {"cat": "x"}, {"cat": "y"}]},
        "mark": "bar",
        "encoding": {"x": {"field": "cat", "type": "nominal"}, "y": {"aggregate": "count", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    heights = sorted(p.get_height() for p in ax.patches)
    assert heights == [1, 2]


def test_bar_chart_grouped_by_color_stacks():
    fig, _ = render({
        "data": {"values": [
            {"g": "a", "c": "x", "v": 1}, {"g": "a", "c": "y", "v": 2},
            {"g": "b", "c": "x", "v": 3}, {"g": "b", "c": "y", "v": 4},
        ]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "g", "type": "nominal"},
            "y": {"field": "v", "type": "quantitative"},
            "color": {"field": "c", "type": "nominal"},
        },
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 4
    assert ax.get_legend() is not None


def test_bar_chart_xoffset_dodges_instead_of_overlapping():
    # xOffset (a grouped/dodged bar chart) must draw each sub-group at its
    # own shifted x position -- previously ignored entirely, so every
    # sub-group's bar drew at the identical category position, overdrawing
    # each other rather than sitting side by side.
    fig, _ = render({
        "data": {"values": [
            {"g": "a", "c": "x", "v": 1}, {"g": "a", "c": "y", "v": 2},
            {"g": "b", "c": "x", "v": 3}, {"g": "b", "c": "y", "v": 4},
        ]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "g", "type": "nominal"},
            "xOffset": {"field": "c", "type": "nominal"},
            "y": {"field": "v", "type": "quantitative"},
            "color": {"field": "c", "type": "nominal"},
        },
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 4
    xs = sorted(round(p.get_x(), 3) for p in ax.patches)
    assert len(set(xs)) == 4  # all 4 bars at distinct x positions, none overlapping
    assert ax.get_legend() is not None


def test_scatter_with_color():
    fig, _ = render({
        "data": {"values": [{"x": 1, "y": 2, "c": "a"}, {"x": 2, "y": 3, "c": "b"}, {"x": 3, "y": 1, "c": "a"}]},
        "mark": "point",
        "encoding": {
            "x": {"field": "x", "type": "quantitative"},
            "y": {"field": "y", "type": "quantitative"},
            "color": {"field": "c", "type": "nominal"},
        },
    })
    ax = fig.axes[0]
    assert len(ax.collections) == 2  # one scatter call per color group


def test_line_chart():
    fig, _ = render({
        "data": {"values": [{"x": 1, "y": 3}, {"x": 2, "y": 1}, {"x": 3, "y": 4}]},
        "mark": "line",
        "encoding": {"x": {"field": "x", "type": "quantitative"}, "y": {"field": "y", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.lines) == 1
    xs = list(ax.lines[0].get_xdata())
    assert xs == sorted(xs)


def test_area_chart():
    fig, _ = render({
        "data": {"values": [{"x": 1, "y": 3}, {"x": 2, "y": 1}]},
        "mark": "area",
        "encoding": {"x": {"field": "x", "type": "quantitative"}, "y": {"field": "y", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.collections) == 1  # fill_between


def test_filter_and_calculate_transforms():
    fig, _ = render({
        "data": {"values": [{"a": 1}, {"a": 2}, {"a": 3}]},
        "transform": [{"filter": "datum.a > 1"}, {"calculate": "datum.a * 2", "as": "b"}],
        "mark": "point",
        "encoding": {"x": {"field": "a", "type": "quantitative"}, "y": {"field": "b", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.collections[0].get_offsets()) == 2


def test_top_level_aggregate_transform():
    fig, _ = render({
        "data": {"values": [{"g": "a", "v": 1}, {"g": "a", "v": 3}, {"g": "b", "v": 10}]},
        "transform": [{"aggregate": [{"op": "mean", "field": "v", "as": "mv"}], "groupby": ["g"]}],
        "mark": "bar",
        "encoding": {"x": {"field": "g", "type": "nominal"}, "y": {"field": "mv", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    heights = sorted(p.get_height() for p in ax.patches)
    assert heights == [2, 10]


def test_window_transform_running_sum():
    fig, code = render({
        "data": {"values": [{"x": 1, "v": 1}, {"x": 2, "v": 2}, {"x": 3, "v": 3}]},
        "transform": [{"window": [{"op": "sum", "field": "v", "as": "cum"}], "sort": [{"field": "x"}], "frame": [None, 0]}],
        "mark": "line",
        "encoding": {"x": {"field": "x", "type": "quantitative"}, "y": {"field": "cum", "type": "quantitative"}},
    })
    assert "vl_window" in code
    ax = fig.axes[0]
    ys = list(ax.lines[0].get_ydata())
    assert ys == [1, 3, 6]


def test_joinaggregate_transform_broadcasts_group_mean():
    fig, _ = render({
        "data": {"values": [{"g": "a", "v": 1}, {"g": "a", "v": 3}, {"g": "b", "v": 10}]},
        "transform": [{"joinaggregate": [{"op": "mean", "field": "v", "as": "group_mean"}], "groupby": ["g"]}],
        "mark": "point",
        "encoding": {"x": {"field": "v", "type": "quantitative"}, "y": {"field": "group_mean", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    ys = sorted(float(v) for v in ax.collections[0].get_offsets()[:, 1])
    assert ys == [2, 2, 10]


def test_fold_transform_melts_columns_into_rows():
    fig, _ = render({
        "data": {"values": [{"a": 1, "b": 2}]},
        "transform": [{"fold": ["a", "b"], "as": ["key", "value"]}],
        "mark": "bar",
        "encoding": {"x": {"field": "key", "type": "nominal"}, "y": {"field": "value", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 2


def test_filter_range_with_null_lower_bound():
    # `range: [null, 2019]` means "<= 2019" -- comparing `None <= x`
    # directly used to raise TypeError instead of being treated as
    # unbounded in that direction.
    fig, _ = render({
        "data": {"values": [{"y": 2010}, {"y": 2020}, {"y": 2019}]},
        "transform": [{"filter": {"field": "y", "range": [None, 2019]}}],
        "mark": "point",
        "encoding": {"x": {"field": "y", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.collections[0].get_offsets()) == 2


def test_layered_chart_shares_one_axes():
    fig, _ = render({
        "data": {"values": [{"x": 1, "y": 2}]},
        "layer": [
            {"mark": "bar", "encoding": {"x": {"field": "x", "type": "nominal"}, "y": {"field": "y", "type": "quantitative"}}},
            {"mark": "rule", "encoding": {"y": {"datum": 1}}},
        ],
    })
    assert len(fig.axes) == 1


def test_faceted_chart():
    fig, _ = render({
        "data": {"values": [{"g": "a", "x": 1, "y": 2}, {"g": "b", "x": 1, "y": 3}]},
        "facet": {"field": "g", "type": "nominal"},
        "spec": {
            "mark": "point",
            "encoding": {"x": {"field": "x", "type": "quantitative"}, "y": {"field": "y", "type": "quantitative"}},
        },
    })
    assert len(fig.axes) == 2


def test_hconcat():
    fig, _ = render({
        "hconcat": [
            {"data": {"values": [{"a": 1}]}, "mark": "point", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
            {"data": {"values": [{"a": 2}]}, "mark": "point", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
        ]
    })
    assert len(fig.axes) == 2


def test_repeat_plain_array_substitutes_field_per_panel():
    fig, _ = render({
        "data": {"values": [{"a": 1, "b": 2}, {"a": 3, "b": 4}]},
        "repeat": ["a", "b"],
        "spec": {
            "mark": "point",
            "encoding": {"x": {"field": {"repeat": "repeat"}, "type": "quantitative"}},
        },
    })
    assert len(fig.axes) == 2


def test_repeat_row_column_builds_a_grid():
    fig, _ = render({
        "data": {"values": [{"a": 1, "b": 2}]},
        "repeat": {"row": ["a"], "column": ["a", "b"]},
        "spec": {
            "mark": "point",
            "encoding": {
                "x": {"field": {"repeat": "column"}, "type": "quantitative"},
                "y": {"field": {"repeat": "row"}, "type": "quantitative"},
            },
        },
    })
    assert len(fig.axes) == 2  # 1 row x 2 columns


def test_repeat_layer_shares_one_axes_with_distinct_colors():
    fig, _ = render({
        "data": {"values": [{"a": 1, "b": 2, "c": 3}]},
        "repeat": {"layer": ["b", "c"]},
        "spec": {
            "mark": "line",
            "encoding": {
                "x": {"field": "a", "type": "quantitative"},
                "y": {"field": {"repeat": "layer"}, "type": "quantitative"},
                "color": {"datum": {"repeat": "layer"}},
            },
        },
    })
    assert len(fig.axes) == 1
    colors = {tuple(line.get_color()) if not isinstance(line.get_color(), str) else line.get_color() for line in fig.axes[0].lines}
    assert len(colors) == 2


def test_legend_is_placed_outside_the_axes():
    # A plain `ax.legend(title=...)` with no location lets matplotlib pick
    # its own "best fit" spot *inside* the Axes -- for a legend with many
    # entries on a small figure, that box can end up covering the actual
    # plotted data (a real symptom: a normalized stacked-area chart with 14
    # series looked entirely blank because its own legend filled the panel).
    fig, _ = render({
        "data": {"values": [
            {"g": "a", "c": "x", "v": 1}, {"g": "a", "c": "y", "v": 2},
            {"g": "b", "c": "x", "v": 3}, {"g": "b", "c": "y", "v": 4},
        ]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "g", "type": "nominal"},
            "y": {"field": "v", "type": "quantitative"},
            "color": {"field": "c", "type": "nominal"},
        },
    })
    ax = fig.axes[0]
    legend = ax.get_legend()
    assert legend is not None
    assert legend.get_bbox_to_anchor() is not None


def test_stack_normalize_rescales_each_category_to_one():
    fig, _ = render({
        "data": {"values": [
            {"c": "a", "g": "x", "v": 1}, {"c": "a", "g": "y", "v": 3},
            {"c": "b", "g": "x", "v": 10}, {"c": "b", "g": "y", "v": 30},
        ]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "c", "type": "nominal"},
            "y": {"field": "v", "type": "quantitative", "stack": "normalize"},
            "color": {"field": "g", "type": "nominal"},
        },
    })
    ax = fig.axes[0]
    # Every category's own stack (its topmost segment's own top edge) must
    # reach exactly 1.0 -- grouped by x-position since each category has
    # two stacked segments (only the outer one's own top is the full
    # category total).
    tops_by_x: dict[float, float] = {}
    for p in ax.patches:
        x = round(p.get_x(), 3)
        top = p.get_y() + p.get_height()
        tops_by_x[x] = max(tops_by_x.get(x, 0), top)
    assert sorted(round(v, 6) for v in tops_by_x.values()) == [1.0, 1.0]


def test_categorical_color_domain_range_maps_by_value_not_index():
    # An explicit `scale.domain`+`scale.range` is a value->color mapping,
    # not just a positionally-indexed palette -- must still color "b"
    # green even though it's the *second* row (index 1), matching its own
    # domain position, not accidentally landing on the color at index 1.
    fig, _ = render({
        "data": {"values": [{"cat": "a", "v": 1}, {"cat": "b", "v": 2}]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "cat", "type": "nominal"},
            "y": {"field": "v", "type": "quantitative"},
            "color": {
                "field": "cat", "type": "nominal",
                "scale": {"domain": ["b", "a"], "range": ["#00ff00", "#ff0000"]},
            },
        },
    })
    ax = fig.axes[0]
    colors = {tuple(p.get_facecolor()) for p in ax.patches}
    assert (0.0, 1.0, 0.0, 1.0) in colors  # "b" -> green, regardless of its own row/draw order
    assert (1.0, 0.0, 0.0, 1.0) in colors  # "a" -> red


def test_2d_binning_bins_both_channels():
    fig, _ = render({
        "data": {"values": [{"a": i, "b": i * 2} for i in range(20)]},
        "mark": "point",
        "encoding": {
            "x": {"field": "a", "bin": {"maxbins": 5}},
            "y": {"field": "b", "bin": {"maxbins": 5}},
            "size": {"aggregate": "count"},
        },
    })
    ax = fig.axes[0]
    offsets = ax.collections[0].get_offsets()
    xs = {round(float(x), 3) for x, _ in offsets}
    ys = {round(float(y), 3) for _, y in offsets}
    assert len(xs) > 1 and len(ys) > 1  # both axes actually varied, not one collapsed to a single bin


def test_bin_binned_object_form_is_not_rebinned():
    fig, _ = render({
        "data": {"values": [{"lo": 0, "hi": 5, "n": 3}, {"lo": 5, "hi": 10, "n": 7}]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "lo", "bin": {"binned": True, "step": 5}},
            "x2": {"field": "hi"},
            "y": {"field": "n", "type": "quantitative"},
        },
    })
    ax = fig.axes[0]
    widths = sorted(p.get_width() for p in ax.patches)
    assert widths == [5, 5]  # the real bin span (hi - lo), not a re-binned/default width


def test_longitude_latitude_falls_back_to_plain_xy_scatter():
    # No map-projection support at all -- longitude/latitude used to be
    # entirely unrecognized, leaving every point at the same literal (0, 0)
    # broadcast position (a single visible dot).
    fig, _ = render({
        "data": {"values": [{"lon": 1, "lat": 2}, {"lon": 3, "lat": 4}, {"lon": 5, "lat": 6}]},
        "mark": "point",
        "encoding": {
            "longitude": {"field": "lon", "type": "quantitative"},
            "latitude": {"field": "lat", "type": "quantitative"},
        },
    })
    ax = fig.axes[0]
    offsets = ax.collections[0].get_offsets()
    assert len(set(round(float(x), 3) for x, _ in offsets)) == 3  # 3 distinct x positions, not collapsed to one


def test_binnedyearmonth_timeunit_produces_wide_bars_not_hairlines():
    # `binnedyearmonth` (Vega-Lite's "this field is already pre-binned to
    # yearmonth granularity" convention) used to be entirely unrecognized,
    # and even once mapped to plain `yearmonth`, a temporal bar's own width
    # heuristic only handled a *quantitative* category axis -- a bare `0.8`
    # width on a Timestamp-valued x-axis is ~0.8 *days* wide, an invisible
    # hairline next to month-wide gaps between bars.
    fig, _ = render({
        "data": {"values": [
            {"d": "2020-01-15", "v": 1}, {"d": "2020-01-20", "v": 2},
            {"d": "2020-02-10", "v": 3}, {"d": "2020-03-05", "v": 4},
        ]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "d", "timeUnit": "binnedyearmonth", "type": "temporal"},
            "y": {"aggregate": "count", "type": "quantitative"},
        },
    })
    ax = fig.axes[0]
    widths_in_days = [p.get_width() for p in ax.patches]
    assert all(w > 5 for w in widths_in_days)  # real month-scale width, not a ~0.8-day hairline


def test_text_mark_ambiguous_position_does_not_crash_matplotlib():
    # Unlike bar/scatter, ax.text() has no native fallback for a raw string
    # x-position -- an ambiguously-typed (no explicit `type`) field used to
    # reach matplotlib as a literal string, raising ConversionError.
    fig, _ = render({
        "data": {"values": [{"cat": "A", "v": 1}, {"cat": "B", "v": 2}]},
        "mark": "text",
        "encoding": {"x": {"field": "cat"}, "y": {"field": "v", "type": "quantitative"}, "text": {"field": "v"}},
    })
    ax = fig.axes[0]
    assert len(ax.texts) == 2


def test_1d_aggregate_bar_is_horizontal_with_nonzero_width():
    # A 1D aggregate bar chart (only `x` given, `aggregate`+`field`, no
    # explicit `type`) must be recognized as quantitative and drawn as a
    # horizontal bar with a real width -- not a zero-height vertical sliver
    # (the "plot renders but is empty" failure this regression-tests).
    fig, _ = render({
        "data": {"values": [{"v": 1}, {"v": 2}, {"v": 3}]},
        "mark": "bar",
        "encoding": {"x": {"aggregate": "sum", "field": "v"}},
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 1
    patch = ax.patches[0]
    assert patch.get_width() == 6
    assert patch.get_height() > 0


def test_binned_bar_width_matches_bin_span():
    fig, _ = render({
        "data": {"values": [{"v": i} for i in range(20)]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "v", "bin": {"maxbins": 5}},
            "y": {"aggregate": "count"},
        },
    })
    ax = fig.axes[0]
    widths = [p.get_width() for p in ax.patches]
    assert max(widths) - min(widths) < 0.01  # every bin (near enough) the same width
    assert widths[0] != 0.8  # not the ordinal-position default


def test_rect_heatmap_draws_one_cell_per_row_with_colorbar():
    fig, _ = render({
        "data": {"values": [
            {"x": "a", "y": "p", "v": 1}, {"x": "a", "y": "q", "v": 2},
            {"x": "b", "y": "p", "v": 3}, {"x": "b", "y": "q", "v": 4},
        ]},
        "mark": "rect",
        "encoding": {
            "x": {"field": "x", "type": "nominal"},
            "y": {"field": "y", "type": "nominal"},
            "color": {"field": "v", "type": "quantitative"},
        },
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 4
    assert len(fig.axes) == 2  # the heatmap's own Axes + the colorbar's


def test_boxplot_one_box_per_category():
    fig, _ = render({
        "data": {"values": [
            {"g": "a", "v": 1}, {"g": "a", "v": 2}, {"g": "a", "v": 3},
            {"g": "b", "v": 10}, {"g": "b", "v": 20},
        ]},
        "mark": "boxplot",
        "encoding": {"x": {"field": "g", "type": "nominal"}, "y": {"field": "v", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 2  # patch_artist=True -> each box is a Patch


def test_conditional_color_produces_per_row_colors_not_one_flat_color():
    # A candlestick-style up/down color (`color.condition`) must reach the
    # generated `color=` array, not collapse to a single flat color -- the
    # `"value" in color_def` check used to match on the CONDITION's own
    # outer fallback `value` first, before ever looking at `condition`.
    fig, _ = render({
        "data": {"values": [
            {"o": 1, "c": 2, "x": 1}, {"o": 2, "c": 2, "x": 2}, {"o": 3, "c": 1, "x": 3},
        ]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "x", "type": "ordinal"},
            "y": {"field": "o", "type": "quantitative"},
            "y2": {"field": "c"},
            "color": {
                "condition": {"test": "datum.o < datum.c", "value": "#06982d"},
                "value": "#ae1325",
            },
        },
    })
    ax = fig.axes[0]
    colors = {tuple(p.get_facecolor()) for p in ax.patches}
    assert len(colors) == 2  # both the up- and down-colored bars are present


def test_monthdate_timeunit_handles_leap_day():
    # The `monthdate` combined timeUnit reconstructs a real date at a fixed
    # placeholder year -- 1900 (not a leap year) used to raise "day is out
    # of range for month" for any real Feb 29th in the data.
    fig, _ = render({
        "data": {"values": [{"d": "2012-02-29"}, {"d": "2012-03-01"}]},
        "mark": "line",
        "encoding": {
            "x": {"field": "d", "timeUnit": "monthdate", "type": "temporal"},
            "y": {"aggregate": "count", "type": "quantitative"},
        },
    })
    ax = fig.axes[0]
    assert len(ax.lines) == 1


def test_rule_datum_date_literal_plots_as_a_real_timestamp():
    # `x: {datum: {"year": 2006}}` (Vega's own partial-DateTime-object
    # shorthand) must become a real `pd.Timestamp`, not a raw dict handed
    # straight to matplotlib's date axis (which can't plot a dict at all).
    fig, _ = render({
        "data": {"values": [{"x": 1}]},
        "mark": "rule",
        "encoding": {"x": {"datum": {"year": 2006, "month": 3}}},
    })
    ax = fig.axes[0]
    assert len(ax.lines) == 1


def test_arc_pie_draws_one_wedge_per_row():
    fig, _ = render({
        "data": {"values": [{"c": "a", "v": 1}, {"c": "b", "v": 2}, {"c": "c", "v": 3}]},
        "mark": "arc",
        "encoding": {"theta": {"field": "v", "type": "quantitative"}, "color": {"field": "c", "type": "nominal"}},
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 3


def test_errorbar_implicit_extent_one_call_covers_every_group():
    fig, _ = render({
        "data": {"values": [
            {"g": "a", "v": 1}, {"g": "a", "v": 2}, {"g": "a", "v": 3},
            {"g": "b", "v": 10}, {"g": "b", "v": 30},
        ]},
        "mark": {"type": "errorbar", "extent": "stdev"},
        "encoding": {"x": {"field": "g", "type": "nominal"}, "y": {"field": "v", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.containers) == 1  # one ErrorbarContainer, plotting both groups' means/errors at once
    (points, _caps, _bars) = ax.containers[0]
    assert len(points.get_ydata()) == 2


def test_errorband_draws_a_filled_band():
    fig, _ = render({
        "data": {"values": [
            {"x": 1, "v": 1}, {"x": 1, "v": 2}, {"x": 1, "v": 3},
            {"x": 2, "v": 10}, {"x": 2, "v": 30},
        ]},
        "mark": "errorband",
        "encoding": {"x": {"field": "x", "type": "ordinal"}, "y": {"field": "v", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.collections) == 1  # fill_between


def test_unsupported_mark_strict_error():
    with pytest.raises(ValueError, match="Unsupported"):
        render({"data": {"values": [{"a": 1}]}, "mark": "geoshape", "encoding": {"x": {"field": "a", "type": "quantitative"}}})


def test_unsupported_mark_ignore_unsupported_fallback():
    fig, _ = render(
        {"data": {"values": [{"a": 1}]}, "mark": "geoshape", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
        ignore_unsupported=True,
    )
    assert fig is not None


def test_trail_mark_draws_a_variable_width_line():
    # trail_color.vl.json's own shape: a `trail` mark's own `size` field
    # varies the line's *width* along its length -- previously entirely
    # unimplemented (an "Unsupported mark type" skip), drawing nothing.
    fig, code = render({
        "data": {"values": [{"x": i, "y": i, "w": i} for i in range(5)]},
        "mark": "trail",
        "encoding": {
            "x": {"field": "x", "type": "quantitative"},
            "y": {"field": "y", "type": "quantitative"},
            "size": {"field": "w", "type": "quantitative"},
        },
    })
    assert "LineCollection(" in code
    ax = fig.axes[0]
    assert len(ax.collections) == 1
    widths = ax.collections[0].get_linewidths()
    assert len(set(widths)) > 1


def test_include_source_paths_adds_comments():
    _, code = render({
        "data": {"values": [{"a": "A", "b": 1}]},
        "mark": "bar",
        "encoding": {"x": {"field": "a", "type": "nominal"}, "y": {"field": "b", "type": "quantitative"}},
    }, include_source_paths=True)
    assert "# from: mark, encoding.x, encoding.y" in code


def test_default_off_has_no_source_path_comments():
    _, code = render({
        "data": {"values": [{"a": "A", "b": 1}]},
        "mark": "bar",
        "encoding": {"x": {"field": "a", "type": "nominal"}, "y": {"field": "b", "type": "quantitative"}},
    })
    assert "# from:" not in code


def test_bar_with_only_category_channel_fills_the_full_axes_width():
    # bar_1d_dimension_only.vl.json's own shape: a bar mark with only `y`
    # given (no `x`/`x2` at all) draws each bar spanning the *entire* plot
    # width, not a zero-length invisible one (see marks.py's own
    # `value_field_missing` handling in `_render_bar()`).
    fig, _ = render({
        "data": {"values": [{"b": 0}, {"b": 10}, {"b": 20}]},
        "mark": {"type": "bar", "orient": "horizontal"},
        "encoding": {"y": {"field": "b", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 3
    for patch in ax.patches:
        assert patch.get_width() == pytest.approx(1.0)


def test_ordinal_numeric_field_sorts_numerically_not_lexicographically():
    # scales.py's ORDINAL_SORT_KEY: a numeric-valued ordinal field (e.g. a
    # cyclic `month` timeUnit's own int 1-12 output) must sort 1, 2, ..., 12
    # -- not the lexicographic 1, 10, 11, 12, 2, ... a plain `key=str` gives.
    fig, _ = render({
        "data": {"values": [{"m": 1, "v": 1}, {"m": 10, "v": 2}, {"m": 2, "v": 3}]},
        "mark": "bar",
        "encoding": {"x": {"field": "m", "type": "ordinal"}, "y": {"field": "v", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    labels = [t.get_text() for t in ax.get_xticklabels()]
    assert labels == ["1", "2", "10"]


def test_density_transform_produces_a_kde_curve():
    fig, _ = render({
        "data": {"values": [{"x": v} for v in [1, 2, 2, 3, 3, 3, 4, 4, 5]]},
        "transform": [{"density": "x", "bandwidth": 0.5}],
        "mark": "area",
        "encoding": {"x": {"field": "value", "type": "quantitative"}, "y": {"field": "density", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    assert len(ax.collections) == 1  # fill_between


def test_pivot_transform_creates_one_column_per_key():
    fig, code = render({
        "data": {"values": [
            {"date": "2020", "k": "a", "v": 1}, {"date": "2020", "k": "b", "v": 2},
            {"date": "2021", "k": "a", "v": 3}, {"date": "2021", "k": "b", "v": 4},
        ]},
        "transform": [{"pivot": "k", "value": "v", "groupby": ["date"]}],
        "mark": "bar",
        "encoding": {"x": {"field": "date", "type": "nominal"}, "y": {"field": "a", "type": "quantitative"}},
    })
    assert "vl_pivot(" in code
    ax = fig.axes[0]
    assert len(ax.patches) == 2


def test_facet_panels_share_one_color_domain_for_the_facet_field():
    # trellis_bar.vl.json's own shape: faceting AND coloring by the same
    # field means every panel only ever sees a single locally-unique
    # category -- without a shared domain, every panel's own bar lands on
    # the same (first) palette color instead of each getting its own.
    fig, _ = render({
        "data": {"values": [{"g": "a", "x": 1, "y": 1}, {"g": "b", "x": 1, "y": 2}]},
        "facet": {"field": "g", "type": "nominal"},
        "spec": {
            "mark": "bar",
            "encoding": {
                "x": {"field": "x", "type": "ordinal"},
                "y": {"field": "y", "type": "quantitative"},
                "color": {"field": "g", "type": "nominal", "scale": {"range": ["#111111", "#222222"]}},
            },
        },
    })
    colors = {tuple(ax.patches[0].get_facecolor()) for ax in fig.axes if ax.patches}
    assert len(colors) == 2


def test_repeat_plain_array_honors_top_level_columns():
    # repeat_histogram.vl.json's own shape: a plain-array `repeat` with a
    # top-level `columns` must wrap into a grid, not one long row.
    fig, _ = render({
        "repeat": ["a", "b", "c", "d"],
        "columns": 2,
        "spec": {
            "data": {"values": [{"a": 1, "b": 2, "c": 3, "d": 4}]},
            "mark": "bar",
            "encoding": {
                "x": {"field": {"repeat": "repeat"}, "type": "quantitative"},
                "y": {"aggregate": "count"},
            },
        },
    })
    assert fig.axes[0].get_gridspec().nrows == 2
    assert fig.axes[0].get_gridspec().ncols == 2


def test_point_mark_continuous_color_uses_a_real_colormap():
    # point_angle_windvector.vl.json's own shape: a continuous `color`
    # field on a point mark previously fell back to one flat default color.
    fig, _ = render({
        "data": {"values": [{"x": i, "y": i, "dir": i * 30} for i in range(5)]},
        "mark": "point",
        "encoding": {
            "x": {"field": "x", "type": "quantitative"},
            "y": {"field": "y", "type": "quantitative"},
            "color": {"field": "dir", "type": "quantitative", "scale": {"domain": [0, 360]}},
        },
    })
    ax = fig.axes[0]
    assert len(ax.collections) == 1
    array = ax.collections[0].get_array()
    assert array is not None and len(set(array.tolist())) > 1


def test_color_legend_null_suppresses_the_legend():
    fig, _ = render({
        "data": {"values": [{"g": "a", "v": 1}, {"g": "b", "v": 2}]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "g", "type": "nominal"},
            "y": {"field": "v", "type": "quantitative"},
            "color": {"field": "g", "type": "nominal", "legend": None},
        },
    })
    assert fig.axes[0].get_legend() is None


def test_hconcat_children_get_their_own_declared_widths():
    # concat_population_pyramid.vl.json's own shape: a narrow middle panel
    # sandwiched between two full-width ones must actually render narrower.
    fig, _ = render({
        "hconcat": [
            {"width": 300, "data": {"values": [{"a": 1}]}, "mark": "bar", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
            {"width": 20, "data": {"values": [{"a": 1}]}, "mark": "bar", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
        ],
    })
    bbox0 = fig.axes[0].get_position()
    bbox1 = fig.axes[1].get_position()
    assert bbox0.width > bbox1.width * 2


def test_text_mark_color_field_colors_each_label():
    # text_scatterplot_colored.vl.json's own shape: a categorical `color`
    # field on a `text` mark was previously dropped entirely, every label
    # drawing in matplotlib's own default black.
    fig, _ = render({
        "data": {"values": [{"x": 1, "y": 1, "g": "a", "t": "A"}, {"x": 2, "y": 2, "g": "b", "t": "B"}]},
        "mark": "text",
        "encoding": {
            "x": {"field": "x", "type": "quantitative"},
            "y": {"field": "y", "type": "quantitative"},
            "color": {"field": "g", "type": "nominal"},
            "text": {"field": "t", "type": "nominal"},
        },
    })
    ax = fig.axes[0]
    colors = {t.get_color() for t in ax.texts}
    assert len(colors) == 2


def test_point_size_field_scales_into_a_reasonable_area_range():
    # circle_bubble_health_income.vl.json's own shape: a raw size field in
    # the tens of millions previously produced markers so large the whole
    # plot rendered as one solid block.
    fig, _ = render({
        "data": {"values": [{"x": i, "y": i, "pop": i * 10_000_000} for i in range(1, 5)]},
        "mark": "circle",
        "encoding": {
            "x": {"field": "x", "type": "quantitative"},
            "y": {"field": "y", "type": "quantitative", "scale": {"type": "log"}},
            "size": {"field": "pop", "type": "quantitative"},
        },
    })
    ax = fig.axes[0]
    sizes = ax.collections[0].get_sizes()
    assert sizes.max() <= 1000
    assert ax.get_yscale() == "log"


def test_line_point_marker_draws_at_each_data_point():
    # line_bump.vl.json's own shape: `mark: {type: "line", point: true}`
    # previously drew no marker overlay at all.
    fig, _ = render({
        "data": {"values": [{"x": 1, "y": 1}, {"x": 2, "y": 2}]},
        "mark": {"type": "line", "point": True},
        "encoding": {"x": {"field": "x", "type": "quantitative"}, "y": {"field": "y", "type": "quantitative"}},
    })
    line = fig.axes[0].lines[0]
    assert line.get_marker() != "None"


def test_quantile_transform_produces_probability_value_pairs():
    fig, code = render({
        "data": {"values": [{"u": v} for v in [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]},
        "transform": [{"quantile": "u", "step": 0.1, "as": ["p", "v"]}],
        "mark": "point",
        "encoding": {"x": {"field": "p", "type": "quantitative"}, "y": {"field": "v", "type": "quantitative"}},
    })
    assert "vl_quantile(" in code
    ax = fig.axes[0]
    assert len(ax.collections[0].get_offsets()) == 10


def test_fold_transform_keeps_the_original_folded_fields():
    # trail_comet.vl.json's own shape: a `calculate` step *after* `fold`
    # reads one of the original folded fields back by name -- Vega-Lite's
    # own `fold` keeps every original field on each output row (unlike a
    # plain `melt()`, which drops the folded ones).
    fig, code = render({
        "data": {"values": [{"a": 1, "b": 2}]},
        "transform": [
            {"fold": ["a", "b"]},
            {"calculate": "datum['a'] - datum['b']", "as": "delta"},
        ],
        "mark": "point",
        "encoding": {"x": {"field": "key", "type": "nominal"}, "y": {"field": "delta", "type": "quantitative"}},
    })
    ax = fig.axes[0]
    ys = ax.collections[0].get_offsets()[:, 1]
    assert set(ys.tolist()) == {-1.0}


def test_window_sum_with_no_frame_is_cumulative_not_whole_partition():
    # waterfall_chart.vl.json's own shape: `window: [{op: "sum", ...}]`
    # with no `frame` at all means a *running* total (Vega-Lite's real
    # default frame, `[null, 0]`), not the grand total repeated on every
    # row (an earlier, unverified assumption this project used to make).
    fig, code = render({
        "data": {"values": [{"v": 1}, {"v": 2}, {"v": 3}]},
        "transform": [{"window": [{"op": "sum", "field": "v", "as": "running"}]}],
        "mark": "line",
        "encoding": {"x": {"field": "v", "type": "quantitative"}, "y": {"field": "running", "type": "quantitative"}},
    })
    ys = list(fig.axes[0].lines[0].get_ydata())
    assert ys == [1, 3, 6]


def test_window_rank_breaks_ties_with_the_full_sort_order():
    # window_rank.vl.json's own shape: two rows tied on the *first* sort
    # field need the second to break the tie correctly.
    fig, code = render({
        "data": {"values": [
            {"g": 1, "point": 6, "diff": -1}, {"g": 1, "point": 6, "diff": 3}, {"g": 1, "point": 3, "diff": 0},
        ]},
        "transform": [{
            "sort": [{"field": "point", "order": "descending"}, {"field": "diff", "order": "descending"}],
            "window": [{"op": "rank", "as": "rank"}],
            "groupby": ["g"],
        }],
        "mark": "point",
        "encoding": {"x": {"field": "diff", "type": "quantitative"}, "y": {"field": "rank", "type": "quantitative"}},
    })
    ranks = sorted(fig.axes[0].collections[0].get_offsets()[:, 1].tolist())
    assert ranks == [1, 2, 3]


def test_stack_transform_produces_start_end_columns():
    fig, code = render({
        "data": {"values": [{"g": "a", "v": 1}, {"g": "a", "v": 2}, {"g": "b", "v": 3}]},
        "transform": [{"stack": "v", "as": ["lo", "hi"], "groupby": []}],
        "mark": "bar",
        "encoding": {"x": {"field": "g", "type": "nominal"}, "y": {"field": "lo", "type": "quantitative"}, "y2": {"field": "hi"}},
    })
    assert "vl_stack(" in code
    assert len(fig.axes[0].patches) == 3


def test_area_orientation_flips_when_x_is_the_value_channel():
    # area_vertical.vl.json's own shape: x is the quantitative measure, y
    # is a bare `timeUnit` (reduces to a plain int -- still the
    # domain/sequence axis, not a value being measured) -- must use
    # fill_betweenx, not fill_between.
    fig, code = render({
        "data": {"values": [{"t": "2020-01-01", "v": 5}, {"t": "2021-01-01", "v": 10}, {"t": "2022-01-01", "v": 3}]},
        "mark": "area",
        "encoding": {"x": {"aggregate": "sum", "field": "v"}, "y": {"timeUnit": "year", "field": "t"}},
    })
    assert "fill_betweenx(" in code
    assert len(fig.axes[0].collections) == 1


def test_dodge_and_stack_combine_when_color_differs_from_xoffset():
    # bar_grouped_stacked.vl.json's own shape: dodge by one field, stack by
    # a genuinely different color field within each dodge slot.
    fig, code = render({
        "data": {"values": [
            {"cyl": 4, "origin": "A", "year": 2000, "w": 10}, {"cyl": 4, "origin": "A", "year": 2001, "w": 20},
            {"cyl": 4, "origin": "B", "year": 2000, "w": 15},
        ]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "cyl", "type": "nominal"},
            "xOffset": {"field": "origin", "type": "nominal"},
            "y": {"aggregate": "sum", "field": "w", "type": "quantitative"},
            "color": {"field": "year", "type": "nominal"},
        },
    })
    ax = fig.axes[0]
    assert len(ax.patches) == 3
    # The two same-dodge-slot (origin "A") bars must stack (not overlap at
    # the same bottom=0).
    bottoms = sorted(p.get_y() for p in ax.patches)
    assert bottoms[-1] > 0


def test_color_scale_null_uses_the_raw_field_value_as_the_color():
    # bar_color_disabled_scale.vl.json's own shape: `scale: null` means the
    # field's own values ARE literal color specs, not categories to map
    # through a palette.
    fig, _ = render({
        "data": {"values": [{"c": "red", "v": 1}, {"c": "blue", "v": 2}]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "c", "type": "nominal"},
            "y": {"field": "v", "type": "quantitative"},
            "color": {"field": "c", "type": "nominal", "scale": None},
        },
    })
    colors = {tuple(p.get_facecolor()) for p in fig.axes[0].patches}
    import matplotlib.colors as mcolors
    assert colors == {mcolors.to_rgba("red"), mcolors.to_rgba("blue")}


def test_shape_channel_varies_marker_by_the_same_color_field():
    # point_color_with_shape.vl.json's own shape: shape and color grouped
    # by the identical field.
    fig, code = render({
        "data": {"values": [{"x": 1, "y": 1, "g": "a"}, {"x": 2, "y": 2, "g": "b"}]},
        "mark": "point",
        "encoding": {
            "x": {"field": "x", "type": "quantitative"},
            "y": {"field": "y", "type": "quantitative"},
            "color": {"field": "g", "type": "nominal"},
            "shape": {"field": "g", "type": "nominal"},
        },
    })
    ax = fig.axes[0]
    assert "__shapemap_" in code
    assert len(ax.collections) == 2
    paths = [c.get_paths()[0].vertices.tobytes() for c in ax.collections]
    assert paths[0] != paths[1]


def test_a_bound_param_expr_resolves_to_its_own_default_value():
    # rule_params.vl.json's own shape: a slider-bound top-level param
    # (a static `value`, no live interactivity needed) referenced via
    # `datum: {"expr": "paramName"}` -- should resolve to a real literal
    # (25), not a raw, un-evaluatable `{"expr": ...}` dict spliced
    # straight into the generated `axvline(x=...)` call.
    fig, code = render({
        "params": [{"name": "x", "value": 25, "bind": {"input": "range", "min": 1, "max": 100}}],
        "data": {"values": [{}]},
        "mark": "rule",
        "encoding": {"x": {"datum": {"expr": "x"}, "type": "quantitative"}},
    }, ignore_unsupported=True)
    ax = fig.axes[0]
    assert len(ax.lines) == 1
    assert ax.lines[0].get_xdata()[0] == 25
    assert '"expr"' not in code and "'expr'" not in code


def test_an_unresolvable_expr_falls_back_via_the_js_style_or_operator():
    # param_expr.vl.json's own shape: `size: {"expr": "sel.field * 10 ||
    # 75"}` -- `sel` is a live selection param with no static value at
    # all (no interactivity is implemented), so the expression should
    # fall back to its own literal `75`, matching what a real Vega-Lite
    # render shows with nothing actually selected -- not crash trying to
    # multiply `None`/raise `NameError` on the unresolved `sel`.
    fig, _ = render({
        "params": [{"name": "sel", "select": {"type": "point", "fields": ["v"]}}],
        "data": {"values": [{"x": 1, "y": 2}]},
        "mark": {"type": "point", "size": {"expr": "sel.v * 10 || 75"}},
        "encoding": {"x": {"field": "x", "type": "quantitative"}, "y": {"field": "y", "type": "quantitative"}},
    }, ignore_unsupported=True)
    ax = fig.axes[0]
    assert len(ax.collections) == 1
    sizes = ax.collections[0].get_sizes()
    assert len(sizes) == 1 and sizes[0] == 75


def test_a_param_expr_referencing_an_earlier_param_resolves_in_declaration_order():
    # bar_bullet_expr_bind.vl.json's own shape: a param with no bound
    # `value` of its own, only an `expr` deriving it from an earlier
    # param in the same `params` array.
    fig, _ = render({
        "params": [
            {"name": "height", "value": 20, "bind": {"input": "range", "min": 1, "max": 100}},
            {"name": "innerBarSize", "expr": "height/2"},
        ],
        "data": {"values": [{"v": 5}]},
        "mark": {"type": "bar", "size": {"expr": "innerBarSize"}},
        "encoding": {"x": {"field": "v", "type": "quantitative"}},
    }, ignore_unsupported=True)
    assert len(fig.axes[0].patches) == 1


def test_bracket_indexed_field_reads_one_element_of_an_array_valued_column():
    # bar_bullet_expr_bind.vl.json's own shape: `"field": "ranges[2]"`
    # names one specific element of a row's own array-valued "ranges"
    # column -- should materialize a real column of that literal name,
    # not raise KeyError("ranges[2]") trying to look it up directly.
    fig, _ = render({
        "data": {"values": [{"ranges": [150, 225, 300]}]},
        "mark": "bar",
        "encoding": {"x": {"field": "ranges[2]", "type": "quantitative"}},
    }, ignore_unsupported=True)
    ax = fig.axes[0]
    assert len(ax.patches) == 1
    assert ax.patches[0].get_x() + ax.patches[0].get_width() / 2 == pytest.approx(300, abs=1) or ax.patches[0].get_width() == pytest.approx(300, abs=1)


def test_a_bar_implicitly_stacks_by_its_own_category_value_with_no_color_channel():
    # bar_qq_stack.vl.json's own shape: two rows share the same category
    # value, no color/detail channel at all -- real Vega-Lite still
    # stacks them (confirmed against the real compiler's own output: a
    # "stack" transform with `groupby: ["a"]` even absent any color
    # channel) -- previously matplotlib drew both rows as two fully-
    # overlapping, un-stacked bars sharing the same zero baseline, the
    # taller one completely hiding the shorter.
    fig, _ = render({
        "data": {"values": [{"a": 1, "b": 28}, {"a": 1, "b": 55}, {"a": 5, "b": 43}]},
        "mark": "bar",
        "encoding": {"x": {"field": "a", "type": "quantitative"}, "y": {"field": "b", "type": "quantitative"}},
    }, ignore_unsupported=True)
    ax = fig.axes[0]
    assert len(ax.patches) == 3
    at_a1 = sorted((p for p in ax.patches if abs(p.get_x() - 1) < 2), key=lambda p: p.get_y())
    assert len(at_a1) == 2
    # Stacked: the two segments' own y-ranges should be adjacent, not both
    # starting from 0 (which would mean they're just overlapping).
    assert at_a1[0].get_y() + at_a1[0].get_height() == pytest.approx(at_a1[1].get_y(), abs=0.5)


def test_an_explicit_orient_wins_over_the_stack_planner_own_x_y_quantitative_guess():
    # bar_qq_stack_horizontal.vl.json's own shape: mark.orient explicit
    # "horizontal", x AND y both quantitative -- plan_stacking() has its
    # own independent (and previously orient-blind) guess at which axis
    # is the real value channel, which used to silently disagree with
    # _render_bar()'s own (correct) orientation detection, stacking the
    # CATEGORY field grouped by the VALUE field -- backwards.
    fig, code = render({
        "data": {"values": [{"a": 1, "b": 28}, {"a": 1, "b": 55}, {"a": 5, "b": 43}]},
        "mark": {"type": "bar", "orient": "horizontal"},
        "encoding": {"y": {"field": "a", "type": "quantitative"}, "x": {"field": "b", "type": "quantitative"}},
    }, ignore_unsupported=True)
    assert 'groupby("a")["b"]' in code, f"expected stacking to group by the real category (a), got:\n{code}"
    ax = fig.axes[0]
    assert len(ax.patches) == 3
    at_a1 = sorted((p for p in ax.patches if abs(p.get_y() - 1) < 2), key=lambda p: p.get_x())
    assert len(at_a1) == 2
    assert at_a1[0].get_x() + at_a1[0].get_width() == pytest.approx(at_a1[1].get_x(), abs=0.5)


def test_an_explicit_y2_companion_on_a_qq_bar_is_not_silently_stacked_via_the_other_axis():
    # bar_ranged_not_binned.vl.json's own shape: x and y both reference
    # the SAME quantitative field, with an explicit y2 companion already
    # giving a complete zero-baseline range -- the implicit-stacking
    # planner's own per-channel loop previously only checked each
    # candidate channel's OWN companion (x2 for x, y2 for y): once y was
    # excluded for having its own y2, it fell through and picked x
    # instead (which has no x2 of its own), silently stacking a mark that
    # was never meant to stack at all -- collapsing all 9 rows into one
    # solid block instead of 9 separate bars at their own real values.
    fig, _ = render({
        "data": {"values": [{"b": 28, "b2": 0}, {"b": 55, "b2": 0}, {"b": 43, "b2": 0}]},
        "mark": {"type": "bar"},
        "encoding": {
            "x": {"field": "b", "type": "quantitative"},
            "y": {"field": "b", "type": "quantitative"},
            "y2": {"field": "b2"},
        },
    }, ignore_unsupported=True)
    ax = fig.axes[0]
    assert len(ax.patches) == 3
    heights = sorted(p.get_height() for p in ax.patches)
    assert heights == pytest.approx([28, 43, 55]), f"expected 3 independent bars at their own real heights, got {heights}"


def test_a_genuinely_quantitative_qq_bar_gets_a_narrow_width_not_a_wide_touching_block():
    # bar_qq_stack.vl.json's own shape -- a plain arbitrary-numeric
    # quantitative category axis (not temporal) should get a small
    # reference-bar width (real Vega-Lite's own `continuousBandSize`
    # convention), not the much wider fraction-of-gap default used for a
    # temporal category axis (which reads correctly wide, matching a
    # normal time-series bar chart) -- confirmed live: the old 0.6
    # multiplier made two categories 4 apart come out 2.4 units wide,
    # visually indistinguishable from a touching ordinal band.
    fig, _ = render({
        "data": {"values": [{"a": 1, "b": 28}, {"a": 5, "b": 43}]},
        "mark": "bar",
        "encoding": {"x": {"field": "a", "type": "quantitative"}, "y": {"field": "b", "type": "quantitative"}},
    }, ignore_unsupported=True)
    ax = fig.axes[0]
    assert len(ax.patches) == 2
    for p in ax.patches:
        assert p.get_width() < 1.5, f"expected a narrow reference-bar width, got {p.get_width()}"


def test_an_area_marks_own_composite_line_and_point_properties_overlay_a_line_and_markers():
    # area_overlay.vl.json's own shape: `mark: {"type": "area", "line":
    # true, "point": true}` -- Vega-Lite's composite-mark shorthand for
    # overlaying a stroked line and point markers on top of the area
    # fill. Previously `point`/`line` were only ever consulted for a
    # plain (non-area) line mark, so an area spec'd this way silently
    # drew ONLY the fill -- confirmed against the user-reported "no
    # dots/points shown for matplotlib" symptom.
    fig, _ = render({
        "data": {"values": [{"d": 1, "v": 10}, {"d": 2, "v": 20}, {"d": 3, "v": 15}]},
        "mark": {"type": "area", "line": True, "point": True},
        "encoding": {"x": {"field": "d", "type": "quantitative"}, "y": {"field": "v", "type": "quantitative"}},
    }, ignore_unsupported=True)
    ax = fig.axes[0]
    assert len(ax.collections) >= 1, "expected the area fill (a PolyCollection)"
    marker_lines = [ln for ln in ax.lines if ln.get_marker() != 'None']
    plain_lines = [ln for ln in ax.lines if ln.get_marker() == 'None']
    assert marker_lines, "expected an overlaid line with point markers"
    assert plain_lines, "expected an overlaid plain stroked line"


def test_an_explicit_scale_domain_clamps_the_axis_matching_the_horizon_graph_idiom():
    # area_horizon.vl.json's own shape: a second layer shifted down by a
    # calculate transform so part of it falls below zero, relying on a
    # shared `scale: {domain: [0, 50]}` to hide that spillover (matching
    # matplotlib's own default clipping of a patch to its Axes' data
    # limits) instead of autoscaling to include it. Previously no
    # position channel's own explicit scale.domain was ever applied at
    # all -- the axis always autoscaled to the full data extent.
    fig, _ = render({
        "data": {"values": [{"x": 1, "y": 10}, {"x": 2, "y": -5}]},
        "mark": "area",
        "encoding": {
            "x": {"field": "x", "type": "quantitative"},
            "y": {"field": "y", "type": "quantitative", "scale": {"domain": [0, 50]}},
        },
    }, ignore_unsupported=True)
    ax = fig.axes[0]
    assert ax.get_ylim() == (0, 50)


def test_mark_invalid_null_on_an_area_widens_the_domain_and_leaves_real_gaps():
    # area_invalid_null.vl.json's own shape: `mark: {"type": "area",
    # "invalid": null}` -- unlike the default ("filter", which drops
    # invalid rows and connects smoothly across the gap), an explicit
    # `invalid: null` keeps them in place, meaning the domain axis must
    # still reflect their own real x extent (not shrink to only the
    # valid rows'), and the drawn area must break into separate paths at
    # each null instead of connecting through it.
    fig, _ = render({
        "data": {"values": [
            {"x": -1, "y": None}, {"x": 1, "y": 10}, {"x": 2, "y": 30},
            {"x": 3, "y": None}, {"x": 4, "y": 15}, {"x": 10, "y": None},
        ]},
        "mark": {"type": "area", "invalid": None},
        "encoding": {"x": {"field": "x", "type": "quantitative"}, "y": {"field": "y", "type": "quantitative"}},
    }, ignore_unsupported=True)
    ax = fig.axes[0]
    xlim = ax.get_xlim()
    assert xlim[0] <= -1 and xlim[1] >= 10, f"expected the x-axis to still span the full -1..10 domain, got {xlim}"
    paths = ax.collections[0].get_paths()
    assert len(paths) >= 2, f"expected the area to break into separate paths around the null rows, got {len(paths)}"
