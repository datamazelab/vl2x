spec_from_json <- function(json) jsonlite::fromJSON(json, simplifyVector = FALSE)

# Translate a spec, execute the generated code, and return the built
# ggplot object's plot data (one data.frame per layer) plus the source.
run_spec <- function(spec) {
  code <- vegalite_to_ggplot(spec)
  plot_obj <- eval(parse(text = code), envir = new.env())
  built <- ggplot2::ggplot_build(plot_obj)
  list(built = built, plot = plot_obj, code = code)
}

test_that("simple bar chart", {
  spec <- spec_from_json('{
    "data": {"values": [{"a": "A", "b": 28}, {"a": "B", "b": 55}, {"a": "C", "b": 43}]},
    "mark": "bar",
    "encoding": {"x": {"field": "a", "type": "nominal"}, "y": {"field": "b", "type": "quantitative"}}
  }')
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 3)
})

test_that("inline count aggregate uses geom_bar's own stat", {
  spec <- spec_from_json('{
    "data": {"values": [{"cat": "x"}, {"cat": "x"}, {"cat": "y"}]},
    "mark": "bar",
    "encoding": {"x": {"field": "cat", "type": "nominal"}, "y": {"aggregate": "count", "type": "quantitative"}}
  }')
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 2)
  expect_false(grepl("dplyr::summarise", r$code))
})

test_that("inline mean aggregate uses stat_summary", {
  spec <- spec_from_json('{
    "data": {"values": [{"g": "a", "v": 1}, {"g": "a", "v": 3}, {"g": "b", "v": 10}]},
    "mark": "bar",
    "encoding": {"x": {"field": "g", "type": "nominal"}, "y": {"field": "v", "aggregate": "mean", "type": "quantitative"}}
  }')
  r <- run_spec(spec)
  expect_true(grepl("stat = \"summary\"", r$code))
  expect_equal(nrow(r$built$data[[1]]), 2)
})

test_that("histogram via bin + count uses geom_histogram", {
  values <- lapply(seq_len(50), function(i) list(x = i))
  spec <- list(
    data = list(values = values), mark = "bar",
    encoding = list(
      x = list(field = "x", bin = TRUE, type = "quantitative"),
      y = list(aggregate = "count", type = "quantitative")
    )
  )
  r <- run_spec(spec)
  expect_true(grepl("geom_histogram", r$code))
  expect_gt(nrow(r$built$data[[1]]), 1)
})

test_that("scatter plot with color", {
  spec <- spec_from_json('{
    "data": {"values": [{"x": 1, "y": 2, "c": "A"}, {"x": 2, "y": 3, "c": "B"}, {"x": 3, "y": 1, "c": "A"}]},
    "mark": "point",
    "encoding": {
      "x": {"field": "x", "type": "quantitative"},
      "y": {"field": "y", "type": "quantitative"},
      "color": {"field": "c", "type": "nominal"}
    }
  }')
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 3)
  expect_equal(length(unique(r$built$data[[1]]$colour)), 2)
})

test_that("line chart", {
  spec <- spec_from_json('{
    "data": {"values": [{"x": 1, "y": 2}, {"x": 2, "y": 3}, {"x": 3, "y": 1}]},
    "mark": "line",
    "encoding": {"x": {"field": "x", "type": "quantitative"}, "y": {"field": "y", "type": "quantitative"}}
  }')
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 3)
})

test_that("arc (pie) chart", {
  spec <- spec_from_json('{
    "data": {"values": [{"cat": "a", "v": 10}, {"cat": "b", "v": 20}, {"cat": "c", "v": 30}]},
    "mark": "arc",
    "encoding": {"theta": {"field": "v", "type": "quantitative"}, "color": {"field": "cat", "type": "nominal"}}
  }')
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 3)
  expect_true(grepl("coord_polar", r$code))
})

test_that("filter and calculate transforms", {
  spec <- spec_from_json('{
    "data": {"values": [{"a": "A", "b": 1}, {"a": "B", "b": 2}, {"a": "C", "b": 3}]},
    "transform": [{"filter": "datum.b > 1"}, {"calculate": "datum.b * 10", "as": "b10"}],
    "mark": "bar",
    "encoding": {"x": {"field": "a", "type": "nominal"}, "y": {"field": "b10", "type": "quantitative"}}
  }')
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 2)
  expect_equal(sort(r$built$data[[1]]$y), c(20, 30))
})

test_that("ternary calculate expression", {
  spec <- spec_from_json('{
    "data": {"values": [{"sex": 1}, {"sex": 2}]},
    "transform": [{"calculate": "datum.sex == 2 ? \\u0027Female\\u0027 : \\u0027Male\\u0027", "as": "gender"}],
    "mark": "bar",
    "encoding": {"x": {"field": "gender", "type": "nominal"}, "y": {"aggregate": "count", "type": "quantitative"}}
  }')
  r <- run_spec(spec)
  expect_true(grepl("ifelse", r$code))
  expect_equal(nrow(r$built$data[[1]]), 2)
})

test_that("top-level aggregate transform", {
  spec <- spec_from_json('{
    "data": {"values": [{"g": "a", "v": 1}, {"g": "a", "v": 3}, {"g": "b", "v": 10}]},
    "transform": [{"aggregate": [{"op": "sum", "field": "v", "as": "total"}], "groupby": ["g"]}],
    "mark": "bar",
    "encoding": {"x": {"field": "g", "type": "nominal"}, "y": {"field": "total", "type": "quantitative"}}
  }')
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 2)
})

test_that("layered bar + rule sharing scales", {
  spec <- spec_from_json('{
    "data": {"values": [{"a": "A", "b": 10}, {"a": "B", "b": 20}]},
    "layer": [
      {"mark": "bar", "encoding": {"x": {"field": "a", "type": "nominal"}, "y": {"field": "b", "type": "quantitative"}}},
      {"mark": "rule", "encoding": {"y": {"field": "b", "type": "quantitative", "aggregate": "mean"}}}
    ]
  }')
  r <- run_spec(spec)
  expect_equal(length(r$built$data), 2)
  expect_equal(nrow(r$built$data[[1]]), 2)
})

test_that("facet_wrap for the facet operator", {
  spec <- spec_from_json('{
    "data": {"values": [{"a": "A", "b": 1, "g": "x"}, {"a": "B", "b": 2, "g": "y"}]},
    "facet": {"field": "g", "type": "nominal"},
    "spec": {
      "mark": "point",
      "encoding": {"x": {"field": "a", "type": "nominal"}, "y": {"field": "b", "type": "quantitative"}}
    }
  }')
  r <- run_spec(spec)
  expect_true(grepl("facet_wrap", r$code))
})

test_that("hconcat via patchwork", {
  spec <- spec_from_json('{
    "data": {"values": [{"a": 1, "b": 2}]},
    "hconcat": [
      {"mark": "bar", "encoding": {"x": {"field": "a", "type": "quantitative"}, "y": {"field": "b", "type": "quantitative"}}},
      {"mark": "point", "encoding": {"x": {"field": "a", "type": "quantitative"}, "y": {"field": "b", "type": "quantitative"}}}
    ]
  }')
  r <- run_spec(spec)
  expect_true(grepl("wrap_plots", r$code))
  expect_s3_class(r$plot, "patchwork")
})

test_that("field names with spaces round-trip through backtick quoting", {
  spec <- spec_from_json('{
    "data": {"values": [{"Fighter Name": "a", "Place Rank": 1}, {"Fighter Name": "b", "Place Rank": 2}]},
    "mark": "point",
    "encoding": {"x": {"field": "Place Rank", "type": "quantitative"}, "y": {"field": "Fighter Name", "type": "nominal"}}
  }')
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 2)
})

test_that("repeat with layer mapping produces one combined multi-layer plot", {
  spec <- spec_from_json('{
    "data": {"values": [{"x": 1, "a": 2, "b": 3}, {"x": 2, "a": 4, "b": 6}]},
    "repeat": {"layer": ["a", "b"]},
    "spec": {
      "mark": "line",
      "encoding": {
        "x": {"field": "x", "type": "quantitative"},
        "y": {"field": {"repeat": "layer"}, "type": "quantitative"}
      }
    }
  }')
  r <- run_spec(spec)
  expect_equal(length(r$built$data), 2)
  expect_false(grepl("wrap_plots", r$code))
})

test_that("facet/repeat throw a clear error for unsupported shapes", {
  spec <- spec_from_json('{
    "repeat": {"row": ["a"], "column": ["b"]},
    "spec": {"mark": "point", "encoding": {}}
  }')
  expect_error(vegalite_to_ggplot(spec), "row/column mapping")
})

test_that("a bar implicitly stacks by its own category value with no color/detail channel", {
  # bar_qq_stack.vl.json's own shape: two rows share the same category
  # value, no color/detail channel at all -- real Vega-Lite still stacks
  # them (confirmed against the real compiler's own output: a "stack"
  # transform with groupby: ["a"] even absent any color channel).
  spec <- spec_from_json('{
    "data": {"values": [{"a": 1, "b": 28}, {"a": 1, "b": 55}, {"a": 5, "b": 43}]},
    "mark": "bar",
    "encoding": {"x": {"field": "a", "type": "quantitative"}, "y": {"field": "b", "type": "quantitative"}}
  }')
  r <- run_spec(spec)
  d <- r$built$data[[1]]
  expect_equal(nrow(d), 3)
  at_a1 <- d[abs(d$x - 1) < 0.5, ]
  expect_equal(nrow(at_a1), 2)
  # Stacked: the two segments should be adjacent (one's ymax meets the
  # other's ymin), not both starting from 0 (which would mean overlap).
  expect_equal(sort(at_a1$ymax)[1], sort(at_a1$ymin)[2])
})

test_that("an explicit mark.orient wins over the both-quantitative orientation guess, with a narrow real width", {
  # bar_qq_stack_horizontal.vl.json's own shape: mark.orient explicit
  # "horizontal", x AND y both quantitative -- ggplot2's own default
  # geom_col orientation ("x") previously always won regardless, drawing
  # vertical bars with the category/value roles effectively swapped.
  spec <- spec_from_json('{
    "data": {"values": [{"a": 1, "b": 28}, {"a": 1, "b": 55}, {"a": 5, "b": 43}]},
    "mark": {"type": "bar", "orient": "horizontal"},
    "encoding": {"y": {"field": "a", "type": "quantitative"}, "x": {"field": "b", "type": "quantitative"}}
  }')
  code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
  expect_match(code, 'orientation = "y"')
  r <- run_spec(spec)
  d <- r$built$data[[1]]
  expect_equal(nrow(d), 3)
  at_a1 <- d[abs(d$y - 1) < 0.5, ]
  expect_equal(nrow(at_a1), 2)
  # Stacked along x this time (horizontal): adjacent segments, not overlap.
  expect_equal(sort(at_a1$xmax)[1], sort(at_a1$xmin)[2])
  # Narrow bars (not ggplot2's own much-wider 90%-of-resolution default,
  # which would span most of the way to the neighboring category at a=5).
  expect_true(all(d$ymax - d$ymin < 1))
})

test_that("a line's color and detail channels combine into the group aesthetic, not just detail alone", {
  # repeat_child_layer.vl.json's own shape: `color: {field: "location"}` +
  # `detail: {field: "year"}` on the same line layer. Two independent
  # bugs previously combined here: (1) the aggregation planner's own
  # groupby-field cap ("more than 2 fields") silently dropped `detail`
  # from the x+color+detail set entirely, leaving its own year value
  # untruncated; (2) even with detail correctly retained, the `group`
  # aes-combining logic in encoding.R skipped itself outright whenever
  # `detail` had already populated `group` on its own, so `colour` never
  # got folded in -- every row sharing the same year (regardless of
  # location) ended up on one merged, crossing line.
  spec <- spec_from_json('{
    "data": {"values": [
      {"loc": "A", "year": 2020, "m": 1, "v": 1}, {"loc": "A", "year": 2020, "m": 2, "v": 2},
      {"loc": "A", "year": 2021, "m": 1, "v": 10}, {"loc": "A", "year": 2021, "m": 2, "v": 20},
      {"loc": "B", "year": 2020, "m": 1, "v": 5}, {"loc": "B", "year": 2020, "m": 2, "v": 6}
    ]},
    "mark": "line",
    "encoding": {
      "x": {"field": "m", "type": "ordinal"},
      "y": {"field": "v", "type": "quantitative"},
      "color": {"field": "loc", "type": "nominal"},
      "detail": {"field": "year", "type": "nominal"}
    }
  }')
  code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
  expect_match(code, "interaction\\(.*loc.*year")
  r <- run_spec(spec)
  d <- r$built$data[[1]]
  # 3 distinct (loc, year) series -> 3 distinct ggplot-internal group ids.
  expect_equal(length(unique(d$group)), 3)
})

test_that("a standalone text mark's synthesized constant axis hides its own chrome", {
  # rect_mosaic_labelled_with_offset.vl.json's own shape: a standalone
  # `mark: "text"` view with only an `x` encoding (no `y` at all) --
  # the 1D-strip fallback synthesizes a constant `y = ""` position so
  # ggplot2 has something to plot against, but previously left that
  # fabricated axis's own default chrome (panel background, gridlines,
  # tick marks, an empty-string axis title) fully visible, reading as an
  # entire second, empty chart floating above the real one.
  spec <- spec_from_json('{
    "data": {"values": [{"g": "a", "v": 1}, {"g": "b", "v": 2}]},
    "mark": "text",
    "encoding": {"x": {"field": "v", "type": "quantitative"}, "text": {"field": "g"}}
  }')
  code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
  expect_match(code, "axis\\.text\\.y = ggplot2::element_blank\\(\\)")
  expect_match(code, "axis\\.ticks\\.y = ggplot2::element_blank\\(\\)")
  expect_match(code, "axis\\.title\\.y = ggplot2::element_blank\\(\\)")
  # Still renders real data, not just theme chrome.
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 2)
})

test_that("a genuinely quantitative yOffset draws a real sub-band ranged bar via geom_rect", {
  # bar_ranged_offset_quantitative.vl.json's own shape: `y: {field:
  # "team"}` + `yOffset: {field: "score", type: "quantitative"}` --
  # ggplot2's own `position_dodge2()` (the categorical-dodge case this
  # project otherwise maps xOffset/yOffset onto directly) has no way to
  # express a continuous linear sub-position within a band at all, so
  # this previously fell through to treating the offset field as an
  # ordinary discrete dodge group (`group = score`), fragmenting every
  # row into its own tiny dodge slot instead of a real ranged sub-position.
  spec <- spec_from_json('{
    "data": {"values": [
      {"quarter": "Q1", "team": "A", "score": 12}, {"quarter": "Q2", "team": "A", "score": 18},
      {"quarter": "Q1", "team": "B", "score": 8}, {"quarter": "Q2", "team": "B", "score": 14}
    ]},
    "mark": "bar",
    "encoding": {
      "x": {"field": "quarter", "type": "ordinal"},
      "y": {"field": "team", "type": "nominal"},
      "yOffset": {"field": "score", "type": "quantitative"},
      "color": {"field": "team", "type": "nominal"}
    }
  }')
  code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
  expect_match(code, "ggplot2::geom_rect")
  expect_no_match <- !grepl("position_dodge2", code)
  expect_true(expect_no_match)
  r <- run_spec(spec)
  d <- r$built$data[[1]]
  expect_equal(nrow(d), 4)
  expect_equal(length(unique(round(d$ymin, 6))), 4)
})

test_that("a bar/rect rendered as geom_linerange gets scale_colour_*, not an inert scale_fill_*", {
  # bar_diverging_stack_transform.vl.json's own shape: `x`/`x2` (a signed
  # range) + `y: {field: "question", type: "nominal"}` -- render_geom_
  # layer_code() draws this as geom_linerange() (no fill aesthetic at
  # all, only colour), renaming the aes from fill to colour at render
  # time, but the separate scale-building code previously always
  # requested scale_fill_*() for any bar/rect regardless, silently
  # customizing an aesthetic the geom never used while the real one
  # (colour) fell back to ggplot2's own default hue palette.
  spec <- spec_from_json('{
    "data": {"values": [
      {"q": "Q1", "t": "A", "nx": -5, "nx2": 0},
      {"q": "Q1", "t": "B", "nx": 0, "nx2": 5}
    ]},
    "mark": "bar",
    "encoding": {
      "x": {"field": "nx", "type": "quantitative"},
      "x2": {"field": "nx2"},
      "y": {"field": "q", "type": "nominal"},
      "color": {
        "field": "t", "type": "nominal",
        "scale": {"domain": ["A", "B"], "range": ["#111111", "#222222"]}
      }
    }
  }')
  code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
  expect_match(code, "scale_colour_manual")
  expect_false(grepl("scale_fill_manual", code))
  r <- run_spec(spec)
  d <- r$built$data[[1]]
  expect_setequal(unique(d$colour), c("#111111", "#222222"))
})

test_that("resolve: {scale: {y: independent}} (dual axis) rescales the secondary layer onto the primary's y range", {
  # layer_dual_axis.vl.json's own shape: a primary area layer with an
  # explicit y domain ([0, 30]) and a secondary line layer on a totally
  # different scale (0-5ish) -- ggplot2 has only one real y coordinate,
  # so the secondary layer's own raw values get linearly rescaled onto
  # the primary's range before plotting, with a `sec_axis()` inverse
  # transform relabeling the right-hand axis in the secondary's own real
  # units.
  spec <- spec_from_json('{
    "data": {"values": [
      {"m": 1, "temp": 5, "rain": 10}, {"m": 2, "temp": 8, "rain": 40},
      {"m": 3, "temp": 12, "rain": 25}
    ]},
    "encoding": {"x": {"field": "m", "type": "ordinal"}},
    "layer": [
      {"mark": "area", "encoding": {"y": {"field": "temp", "type": "quantitative", "scale": {"domain": [0, 30]}, "title": "Temp"}}},
      {"mark": "line", "encoding": {"y": {"field": "rain", "type": "quantitative", "title": "Rain"}}}
    ],
    "resolve": {"scale": {"y": "independent"}}
  }')
  code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
  expect_match(code, "sec_axis")
  expect_match(code, "__dualaxis_rain")
  expect_match(code, 'name = "Temp"')
  expect_match(code, 'name = "Rain"')

  r <- run_spec(spec)
  primary_data <- r$built$data[[1]]
  secondary_data <- r$built$data[[2]]
  # The primary layer's own y values are untouched, still in [0, 30].
  expect_true(all(primary_data$y >= 0 & primary_data$y <= 30))
  # The secondary layer's raw rain values (10-40) land inside that same
  # [0, 30] range once rescaled, not their own original (wildly
  # different) 10-40 scale.
  expect_true(all(secondary_data$y >= 0 & secondary_data$y <= 30))
  expect_true(max(secondary_data$y) > 5, "expected the rescaled line to actually use the shared range, not collapse near zero")
})

test_that("a binned/ranged TEMPORAL rect's own midpoint-shrink formula doesn't add two Dates together", {
  # layer_falkensee.vl.json's own shape: a rect mark with a temporal
  # x/x2 range (`start`/`end` years) -- shrink_range()'s own box-spacing
  # formula previously computed a midpoint as `(min + max) / 2`, which
  # crashes at *render* time ("binary + is not defined for 'Date'
  # objects") once min/max are real Date-typed fields, not plain numbers.
  # The fix (`min + (max - min) / 2`, algebraically identical for plain
  # numbers) only ever adds a numeric *difference* to one endpoint,
  # never adds two Dates together.
  spec <- spec_from_json('{
    "data": {"values": [
      {"start": "2000-01-01", "end": "2003-01-01", "event": "A"},
      {"start": "2005-01-01", "end": "2007-01-01", "event": "B"}
    ]},
    "mark": "rect",
    "encoding": {
      "x": {"field": "start", "type": "temporal"},
      "x2": {"field": "end", "type": "temporal"},
      "fill": {"field": "event", "type": "nominal"}
    }
  }')
  code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
  r <- run_spec(spec)
  expect_equal(nrow(r$built$data[[1]]), 2)
  expect_true(all(is.finite(as.numeric(r$built$data[[1]]$xmin))))
  expect_true(all(is.finite(as.numeric(r$built$data[[1]]$xmax))))
  expect_true(all(r$built$data[[1]]$xmax > r$built$data[[1]]$xmin))
})

test_that("a bar/rect with a single TEMPORAL position and no value channel gets a full-height reference band, not a zero-baseline bar", {
  # layer_null_data.vl.json's own shape: a second layer highlighting each
  # null-data date with a translucent reference band --
  # `mark: {type: "bar", color: "red", opacity: 0.2}`, `x: {timeUnit:
  # "yearmonthdate", field: "a", type: "temporal", bandPosition: 0}`, no
  # `y` at all, no `orient` override either. The "genuinely 1D, no value
  # channel" reference-band branch previously only fired with an
  # EXPLICIT `mark.orient` override, so this fell through to the
  # zero-baseline fallback instead -- `pmin(0, <a Date>)`/`pmax(0, ...)`
  # mixes a Date with a raw epoch-day number, silently spanning from
  # 1970 out to the real date instead of a narrow one-day band. A
  # temporal position is never a plausible zero-baseline magnitude
  # regardless of `orient`.
  spec <- spec_from_json('{
    "data": {"values": [
      {"a": "2000-01-01", "b": 1}, {"a": "2000-01-02", "b": null}, {"a": "2000-01-03", "b": 2}
    ]},
    "layer": [
      {"mark": "line", "encoding": {
        "x": {"field": "a", "type": "temporal"},
        "y": {"field": "b", "type": "quantitative"}
      }},
      {
        "transform": [{"filter": "datum.b === null"}],
        "mark": {"type": "bar", "color": "red", "opacity": 0.2},
        "encoding": {"x": {"field": "a", "type": "temporal", "bandPosition": 0}}
      }
    ]
  }')
  code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
  expect_false(grepl("pmin\\(0", code), "expected no zero-baseline formula for a temporal position")
  expect_match(code, "ymin = -Inf")
  expect_match(code, "ymax = Inf")
  r <- run_spec(spec)
  rect_data <- r$built$data[[2]]
  expect_equal(nrow(rect_data), 1)
  epoch <- as.numeric(as.Date("1970-01-01"))
  expect_true(all(as.numeric(rect_data$xmin) > epoch), "expected the band's own xmin to be near the real date, not the 1970 epoch")
  expect_true(diff(c(rect_data$xmin, rect_data$xmax)) < 5, "expected a narrow, roughly one-day-wide band")
})

test_that("config.line.point (a top-level default, not a per-mark property) overlays a matching-colour point", {
  # layer_overlay.vl.json's own shape: `config: {line: {point: true}}`,
  # no per-mark `point` property anywhere, and a mark-level literal
  # colour (`color: {value: "darkred"}`) on one of the two line layers.
  # Two gaps: (1) config-level mark defaults were never read at all --
  # only a mark object's own explicit properties reached geoms.R; (2)
  # the composite line+point overlay helper (build_area_overlay_layers())
  # only ever handled AREA marks, and even there dropped the main mark's
  # own fixed colour/stat params, so a fixed-color line's own point
  # overlay would have drawn in ggplot2's default black instead of
  # matching.
  spec <- spec_from_json('{
    "config": {"line": {"point": true}},
    "data": {"values": [
      {"c": 1, "h": 10}, {"c": 2, "h": 20}, {"c": 1, "h": 15}
    ]},
    "mark": "line",
    "encoding": {
      "x": {"field": "c", "type": "ordinal"},
      "y": {"aggregate": "max", "field": "h", "type": "quantitative"},
      "color": {"value": "darkred"}
    }
  }')
  code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
  expect_match(code, "ggplot2::geom_point")
  r <- run_spec(spec)
  expect_equal(length(r$built$data), 2)
  point_data <- r$built$data[[2]]
  expect_equal(nrow(point_data), 2, info = "expected one point per aggregated x-group, not one per raw row")
  expect_true(all(point_data$colour == "darkred"))
})
