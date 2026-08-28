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
        render({"data": {"values": [{"a": 1}]}, "mark": "trail", "encoding": {"x": {"field": "a", "type": "quantitative"}}})


def test_unsupported_mark_ignore_unsupported_fallback():
    fig, _ = render(
        {"data": {"values": [{"a": 1}]}, "mark": "trail", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
        ignore_unsupported=True,
    )
    assert fig is not None


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
