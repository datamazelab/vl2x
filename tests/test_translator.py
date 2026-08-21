import sys
from pathlib import Path

import altair as alt
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vl2altair import vegalite_to_altair_code  # noqa: E402


def run(spec: dict) -> alt.TopLevelMixin:
    """Translate a spec, exec the generated code, and return the resulting chart."""
    code = vegalite_to_altair_code(spec, format_with_black=False)
    ns: dict = {}
    exec(compile(code, "<generated>", "exec"), ns)
    return ns["chart"]


def test_simple_bar_chart():
    spec = {
        "data": {"values": [{"a": "A", "b": 28}, {"a": "B", "b": 55}]},
        "mark": "bar",
        "encoding": {
            "x": {"field": "a", "type": "nominal"},
            "y": {"field": "b", "type": "quantitative"},
        },
    }
    chart = run(spec)
    d = chart.to_dict()
    assert d["mark"] == {"type": "bar"}
    assert d["encoding"]["x"] == {"field": "a", "type": "nominal"}
    assert d["encoding"]["y"] == {"field": "b", "type": "quantitative"}
    assert d["datasets"][d["data"]["name"]] == spec["data"]["values"]


def test_scatter_with_color_and_tooltip_list():
    spec = {
        "data": {"url": "data/cars.json"},
        "mark": "point",
        "encoding": {
            "x": {"field": "Horsepower", "type": "quantitative"},
            "y": {"field": "Miles_per_Gallon", "type": "quantitative"},
            "color": {"field": "Origin", "type": "nominal"},
            "tooltip": [
                {"field": "Name", "type": "nominal"},
                {"field": "Horsepower", "type": "quantitative"},
            ],
        },
    }
    chart = run(spec)
    d = chart.to_dict()
    assert d["data"] == {"url": "data/cars.json"}
    assert d["encoding"]["color"] == {"field": "Origin", "type": "nominal"}
    assert d["encoding"]["tooltip"] == spec["encoding"]["tooltip"]


def test_transform_filter_calculate_aggregate():
    spec = {
        "data": {"url": "data/movies.json"},
        "transform": [
            {"filter": "datum.IMDB_Rating > 5"},
            {"calculate": "datum.Rating / 2", "as": "HalfRating"},
            {"aggregate": [{"op": "mean", "field": "HalfRating", "as": "MeanHalf"}], "groupby": ["Major_Genre"]},
        ],
        "mark": "bar",
        "encoding": {
            "x": {"field": "Major_Genre", "type": "nominal"},
            "y": {"field": "MeanHalf", "type": "quantitative"},
        },
    }
    chart = run(spec)
    d = chart.to_dict()
    assert d["transform"] == spec["transform"]


def test_layered_chart_with_shared_encoding():
    spec = {
        "data": {"values": [{"x": 1, "y": 2}, {"x": 2, "y": 3}]},
        "encoding": {"x": {"field": "x", "type": "quantitative"}},
        "layer": [
            {"mark": "line", "encoding": {"y": {"field": "y", "type": "quantitative"}}},
            {"mark": "point", "encoding": {"y": {"field": "y", "type": "quantitative"}}},
        ],
    }
    chart = run(spec)
    d = chart.to_dict()
    assert len(d["layer"]) == 2
    assert d["layer"][0]["mark"] == {"type": "line"}
    assert d["layer"][1]["mark"] == {"type": "point"}
    for layer in d["layer"]:
        assert layer["encoding"]["x"] == {"field": "x", "type": "quantitative"}
        assert layer["encoding"]["y"] == {"field": "y", "type": "quantitative"}
    # data should be hoisted to the shared top level, not duplicated per layer.
    assert "data" not in d["layer"][0]
    assert "data" in d


def test_faceted_chart():
    spec = {
        "data": {"url": "data/cars.json"},
        "facet": {"column": {"field": "Origin", "type": "nominal"}},
        "spec": {
            "mark": "point",
            "encoding": {
                "x": {"field": "Horsepower", "type": "quantitative"},
                "y": {"field": "Miles_per_Gallon", "type": "quantitative"},
            },
        },
    }
    chart = run(spec)
    d = chart.to_dict()
    assert d["facet"] == {"column": {"field": "Origin", "type": "nominal"}}
    assert d["data"] == {"url": "data/cars.json"}
    assert "data" not in d["spec"]


def test_hconcat():
    spec = {
        "data": {"values": [{"a": 1}]},
        "hconcat": [
            {"mark": "bar", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
            {"mark": "point", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
        ],
    }
    chart = run(spec)
    d = chart.to_dict()
    assert len(d["hconcat"]) == 2
    assert d["hconcat"][0]["mark"] == {"type": "bar"}
    assert d["hconcat"][1]["mark"] == {"type": "point"}


def test_selection_param_and_condition():
    spec = {
        "data": {"values": [{"a": "A", "b": 1}]},
        "params": [{"name": "select", "select": "point"}],
        "mark": "bar",
        "encoding": {
            "x": {"field": "a", "type": "nominal"},
            "y": {"field": "b", "type": "quantitative"},
            "color": {
                "condition": {"param": "select", "field": "a", "type": "nominal"},
                "value": "grey",
            },
        },
    }
    chart = run(spec)
    d = chart.to_dict()
    assert d["params"][0]["name"] == "select"
    assert d["params"][0]["select"]["type"] == "point"
    assert d["encoding"]["color"]["condition"] == {"param": "select", "field": "a", "type": "nominal"}
    assert d["encoding"]["color"]["value"] == "grey"


def test_config_and_properties():
    spec = {
        "data": {"values": [{"a": 1}]},
        "mark": "bar",
        "width": 300,
        "height": 200,
        "title": "My Chart",
        "encoding": {"x": {"field": "a", "type": "quantitative"}},
        "config": {"axis": {"grid": False}},
    }
    chart = run(spec)
    d = chart.to_dict()
    assert d["width"] == 300
    assert d["height"] == 200
    assert d["title"] == "My Chart"
    assert d["config"]["axis"] == {"grid": False}


def test_bin_and_reserved_word_transform_keys():
    spec = {
        "data": {"values": [{"a": 1}]},
        "transform": [
            {"bin": True, "field": "a", "as": "a_binned"},
            {"timeUnit": "year", "field": "a", "as": "a_year"},
        ],
        "mark": "bar",
        "encoding": {"x": {"field": "a_binned", "type": "quantitative"}},
    }
    chart = run(spec)
    d = chart.to_dict()
    assert d["transform"] == spec["transform"]


def test_named_datasets_are_hoisted_once():
    spec = {
        "datasets": {"mydata": [{"a": 1}, {"a": 2}]},
        "hconcat": [
            {"data": {"name": "mydata"}, "mark": "bar", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
            {"data": {"name": "mydata"}, "mark": "point", "encoding": {"x": {"field": "a", "type": "quantitative"}}},
        ],
    }
    code = vegalite_to_altair_code(spec, format_with_black=False)
    # The dataset list literal should appear exactly once in the source.
    assert code.count("[{'a': 1}, {'a': 2}]") + code.count('[{"a": 1}, {"a": 2}]') == 1
    chart = run(spec)
    d = chart.to_dict()
    assert len(d["hconcat"]) == 2


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
