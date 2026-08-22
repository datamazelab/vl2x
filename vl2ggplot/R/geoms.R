# Generate the ggplot2 geom layer call for one (mark, encoding) pair.
#
# Unlike vl2d3, ggplot2 already understands most of what a mark needs to
# draw itself (scales, legends, and even some aggregation via its built-in
# stats) -- so this module's job is mostly picking the right geom function
# and stat, not computing pixel geometry by hand.

# Mark-level properties (outside any encoding channel) that map onto a
# fixed (non-aes) geom argument of a different name.
.mark_prop_map <- c(
  opacity = "alpha", strokeWidth = "linewidth", size = "size",
  interpolate = NULL
)

# A mark's color/fill/stroke is usually a plain CSS-color string, but Vega-
# Lite also allows a gradient definition object (linear/radial, with color
# stops) -- grid/ggplot2 has no equivalent without extra packages, so this
# throws a clear error rather than splicing the gradient object in as if it
# were a color string.
simple_color_value <- function(value, ignore_unsupported = FALSE, .notes = NULL) {
  if (is.list(value)) {
    if (ignore_unsupported) {
      # Use the gradient's first color stop if it has one, else a neutral
      # default -- a flat fill instead of the intended gradient, but still a
      # real, visible color rather than a crash.
      stops <- value$stops
      if (is.list(stops) && length(stops) > 0 && !is.null(stops[[1]]$color)) {
        .push_note(.notes, "unsupported gradient fill/stroke definition, using its first color stop instead (ignore_unsupported)")
        return(format_value(stops[[1]]$color))
      }
      .push_note(.notes, 'unsupported gradient fill/stroke definition, using "steelblue" instead (ignore_unsupported)')
      return(render_string("steelblue"))
    }
    stop("Unsupported: gradient fill/stroke definitions are not supported")
  }
  format_value(value)
}

# A mark-level scalar property (size/opacity/strokeWidth) can be
# `{"expr": "..."}` instead of a plain literal -- almost always a *literal*
# constant wrapped that way (e.g. `{"expr": "20"}`, seen in the wild) rather
# than a genuine signal/param reference (which has no static value at all).
# translate_expr() on the expr text is a no-op for the literal case (a bare
# number translates to itself); the result is used as-is only when it's
# still a plain number afterward -- a leftover bare identifier (a real
# signal/param reference, e.g. `{"expr": "height / 2"}`) means there was
# nothing static to resolve, so this falls back the same way a gradient
# fill/stroke definition does (a reasonable constant, with a note, under
# ignore_unsupported; a clear error otherwise).
mark_scalar_value <- function(value, default_literal, ignore_unsupported = FALSE, .notes = NULL) {
  if (is.list(value) && !is.null(value[["expr"]])) {
    translated <- translate_expr(value[["expr"]])
    if (grepl("^-?[0-9.]+$", translated)) return(translated)
    if (ignore_unsupported) {
      .push_note(.notes, sprintf(
        'unsupported mark property bound to a non-literal expression/signal ("%s"), using %s instead (ignore_unsupported)',
        value[["expr"]], default_literal
      ))
      return(default_literal)
    }
    stop(sprintf('Unsupported: mark property is bound to an expression/signal ("%s") with no static value', value[["expr"]]))
  }
  format_value(value)
}

mark_fixed_params <- function(mark_props, mark_type, ignore_unsupported = FALSE, .notes = NULL) {
  fixed <- list()
  # `[[` (exact match), not `$` (which silently *partial*-matches a list
  # name -- e.g. mark_props$fill on a mark with only "filled" set, never
  # "fill" itself, would return the "filled" boolean instead of NULL).
  if (!is.null(mark_props[["color"]])) fixed[[color_channel_aes(mark_type)]] <- simple_color_value(mark_props[["color"]], ignore_unsupported, .notes)
  if (!is.null(mark_props[["fill"]])) fixed[["fill"]] <- simple_color_value(mark_props[["fill"]], ignore_unsupported, .notes)
  if (!is.null(mark_props[["stroke"]])) fixed[["colour"]] <- simple_color_value(mark_props[["stroke"]], ignore_unsupported, .notes)
  if (!is.null(mark_props[["opacity"]])) fixed[["alpha"]] <- mark_scalar_value(mark_props[["opacity"]], "1", ignore_unsupported, .notes)
  if (!is.null(mark_props[["strokeWidth"]])) {
    # geom_point()'s border-thickness aesthetic is "stroke", not
    # "linewidth" (that's for a line/area/bar's own line thickness, which
    # is what every other mark type here maps onto a geom that has).
    stroke_width_aes <- if (mark_type %in% c("point", "circle", "square", "tick")) "stroke" else "linewidth"
    fixed[[stroke_width_aes]] <- mark_scalar_value(mark_props[["strokeWidth"]], "1", ignore_unsupported, .notes)
  }
  if (!is.null(mark_props[["size"]]) && !(mark_type %in% c("bar", "area", "line"))) {
    fixed[["size"]] <- mark_scalar_value(mark_props[["size"]], "1.5", ignore_unsupported, .notes)
  }
  # A `text` mark's label is usually an encoding channel, but Vega-Lite also
  # allows a literal constant directly on the mark definition (a string, or
  # an array of strings meaning multiple lines).
  if (mark_type == "text" && !is.null(mark_props[["text"]])) {
    label <- if (is.list(mark_props[["text"]])) {
      paste(vapply(mark_props[["text"]], as.character, character(1)), collapse = "\n")
    } else {
      as.character(mark_props[["text"]])
    }
    fixed[["label"]] <- render_string(label)
  }
  if (mark_type == "text" && !is.null(mark_props[["align"]])) {
    fixed[["hjust"]] <- fixed[["hjust"]] %||% render_string(as.character(mark_props[["align"]]))
  }
  fixed
}

# geom function name for a mark, given its properties (a few marks pick a
# different geom based on a property, e.g. line + interpolate: "step").
geom_function_name <- function(mark_type, mark_props, has_y = TRUE, ignore_unsupported = FALSE, .notes = NULL) {
  known <- switch(mark_type,
    # geom_col (stat="identity") needs an explicit y; a bar mark whose y is
    # a bare `{"aggregate": "count"}` has none -- geom_bar's default
    # stat="count" is what supplies it.
    bar = if (has_y) "ggplot2::geom_col" else "ggplot2::geom_bar",
    line = if (!is.null(mark_props$interpolate) && grepl("step", mark_props$interpolate)) "ggplot2::geom_step" else "ggplot2::geom_line",
    area = "ggplot2::geom_area",
    point = "ggplot2::geom_point",
    circle = "ggplot2::geom_point",
    square = "ggplot2::geom_point",
    tick = "ggplot2::geom_point",
    text = "ggplot2::geom_text",
    rule = NULL, # dispatched specially: geom_hline/vline/segment
    arc = "ggplot2::geom_bar",
    boxplot = "ggplot2::geom_boxplot",
    errorbar = "ggplot2::geom_errorbar",
    errorband = "ggplot2::geom_ribbon",
    trail = "ggplot2::geom_line",
    rect = "ggplot2::geom_tile",
    NA_character_
  )
  if (mark_type == "rule" || !is.na(known)) return(known)
  if (ignore_unsupported) {
    # Anything else unrecognized (geoshape, image, ...) -- a point per row
    # is still a rendered chart, even without the mark's real shape.
    .push_note(.notes, sprintf('unsupported mark type "%s", drawing as a point instead (ignore_unsupported)', mark_type))
    return("ggplot2::geom_point")
  }
  stop(sprintf('Unsupported mark type: "%s"', mark_type))
}

# Merge two named lists of rendered-expression strings, `override` winning
# over `base` for duplicate names.
merge_named <- function(base, override) {
  for (n in names(override)) base[[n]] <- override[[n]]
  base
}

render_kwargs <- function(named_list) {
  vapply(names(named_list), function(n) paste0(n, " = ", named_list[[n]]), character(1))
}

# Compute a min/max aes() pair for one axis ("x" or "y") from whichever of
# Vega-Lite's several ways to express a range the encoding uses:
#   - `xError`/`yError` alone: a symmetric +/- offset from the base value.
#   - `xError` + `xError2` (or the y equivalents): asymmetric offsets, both
#     added to the base value (Vega-Lite semantics -- xError2 is not itself
#     the upper bound, it's the offset to it).
#   - `x2`/`y2` alone: `x`/`y` and `x2`/`y2` are themselves the two bounds.
# Returns NULL if this axis has none of these (a plain single-value axis).
# A `bar`/`rect` mark's `color` channel normally routes to the "fill"
# aesthetic (color_channel_aes(), matching its usual real geom -- geom_col/
# geom_tile, both fillable boxes). But the Gantt-chart-style fallback for a
# ranged bar/rect against a categorical companion axis actually draws with
# geom_linerange() instead (a *line*, not a box, since geom_rect can't size
# against a discrete axis) -- which has no "fill" aesthetic at all, only
# "colour". Applied right before build_call() at each such fallback site,
# after build_layer_channels() has already committed to "fill" based on the
# Vega-Lite mark type alone (it has no way to know a *specific* layer will
# end up downgraded to a line-family geom).
rename_fill_to_colour <- function(aes_pairs) {
  if (!is.null(aes_pairs[["fill"]])) {
    aes_pairs[["colour"]] <- aes_pairs[["fill"]]
    aes_pairs[["fill"]] <- NULL
  }
  aes_pairs
}

error_bounds <- function(encoding, axis, ignore_unsupported = FALSE, .notes = NULL) {
  err_key <- paste0(axis, "Error")
  err2_key <- paste0(axis, "Error2")
  range2_key <- paste0(axis, "2")
  base <- encoding[[axis]]
  if (is.null(base)) return(NULL)
  base_expr <- channel_value_expr(base, ignore_unsupported, .notes)

  if (!is.null(encoding[[err_key]])) {
    err_expr <- channel_value_expr(encoding[[err_key]], ignore_unsupported, .notes)
    if (!is.null(encoding[[err2_key]])) {
      err2_expr <- channel_value_expr(encoding[[err2_key]], ignore_unsupported, .notes)
      return(list(min = sprintf("(%s) + (%s)", base_expr, err_expr), max = sprintf("(%s) + (%s)", base_expr, err2_expr)))
    }
    return(list(min = sprintf("(%s) - (%s)", base_expr, err_expr), max = sprintf("(%s) + (%s)", base_expr, err_expr)))
  }
  if (!is.null(encoding[[range2_key]])) {
    return(list(min = base_expr, max = channel_value_expr(encoding[[range2_key]], ignore_unsupported, .notes)))
  }
  NULL
}

# Build one complete geom_*(...) layer call. Returns list(code = the geom
# call expression string, notes = character vector of "# vl2ggplot: ..."
# comment lines to emit immediately before the statement that uses `code`,
# one per ignore_unsupported fallback triggered while building it).
# `plan` (from transforms.R's plan_layer_data()) may add extra fixed params
# (e.g. stat = "count"/"summary") and note whether this layer needs
# geom_histogram instead of the plain mark geom.
render_geom_layer <- function(mark, encoding, data_arg, plan, ignore_unsupported = FALSE, extent_data_var = NULL, extent_params = list()) {
  notes_env <- new.env()
  code <- render_geom_layer_code(mark, encoding, data_arg, plan, ignore_unsupported, notes_env, extent_data_var, extent_params)
  notes <- notes_env$notes
  list(code = code, notes = if (is.null(notes)) character(0) else paste0("# vl2ggplot: ", notes))
}

render_geom_layer_code <- function(mark, encoding, data_arg, plan, ignore_unsupported = FALSE, .notes = NULL, extent_data_var = NULL, extent_params = list()) {
  mark_type <- if (is.character(mark)) mark else mark$type
  mark_props <- if (is.character(mark)) list() else mark[names(mark) != "type"]

  channels <- build_layer_channels(encoding, mark_type, ignore_unsupported, .notes, extent_data_var, extent_params)
  fixed <- merge_named(mark_fixed_params(mark_props, mark_type, ignore_unsupported, .notes), channels$fixed)
  if (!is.null(plan$extra_fixed)) fixed <- merge_named(fixed, plan$extra_fixed)

  aes_pairs <- channels$aes
  if (!is.null(plan$extra_aes)) aes_pairs <- merge_named(aes_pairs, plan$extra_aes)

  # point/circle/square/tick (all geom_point()) have only one color-like
  # aesthetic in their *default* (solid, unbordered) shape -- "colour" --
  # same as a plain point. But a mark-level `stroke` property is a
  # deliberate second, independent color (a border around each point,
  # distinct from the data-driven main color), which collides outright with
  # `colour` also being aes()-mapped from the `color` encoding: ggplot2
  # lets a literal (non-aes) layer argument for an aesthetic silently
  # *replace* that same aesthetic's aes() mapping wholesale, so every point
  # rendered in the fixed `stroke` color regardless of the encoding.
  # Switching to a fillable shape (21: a circle with an independent
  # border) resolves it the same way Vega-Lite itself keeps a circle's
  # fill and stroke independent -- the encoding maps to "fill" (interior)
  # instead, while the mark's own `stroke` keeps meaning "colour" (border).
  # `"filled": true` is Vega-Lite's own explicit request for exactly this
  # (a point/circle/square drawn with a fillable shape instead of its
  # default outline-only one) -- the same switch a mark-level `stroke`
  # forces implicitly below by necessity.
  if (mark_type %in% c("point", "circle", "square", "tick") &&
      (isTRUE(mark_props[["filled"]]) || !is.null(mark_props[["stroke"]])) && !is.null(aes_pairs[["colour"]])) {
    aes_pairs[["fill"]] <- aes_pairs[["colour"]]
    aes_pairs[["colour"]] <- NULL
    fixed[["shape"]] <- fixed[["shape"]] %||% "21"
  }

  # x2/y2/xError/yError: meaning depends on the geom, and either axis can
  # carry the range for a horizontal-vs-vertical errorbar/errorband.
  if (mark_type == "rule") {
    return(render_rule_layer(encoding, aes_pairs, fixed, data_arg, ignore_unsupported, .notes))
  }
  y_range <- error_bounds(encoding, "y", ignore_unsupported, .notes)
  x_range <- error_bounds(encoding, "x", ignore_unsupported, .notes)
  if (!is.null(y_range) && !is.null(x_range) && mark_type %in% c("bar", "rect")) {
    # A true 2D box (both axes have their own range, e.g. a heatmap-style
    # rect) -- geom_rect wants numeric ymin/ymax *and* xmin/xmax.
    aes_pairs[["ymin"]] <- y_range$min
    aes_pairs[["ymax"]] <- y_range$max
    aes_pairs[["xmin"]] <- x_range$min
    aes_pairs[["xmax"]] <- x_range$max
    aes_pairs[["x"]] <- NULL
    aes_pairs[["y"]] <- NULL
    return(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg))
  }
  if (!is.null(y_range) && mark_type %in% c("bar", "rect", "area", "errorband", "errorbar")) {
    aes_pairs[["ymin"]] <- y_range$min
    aes_pairs[["ymax"]] <- y_range$max
    aes_pairs[["y"]] <- NULL
    if (mark_type == "rect" && is.null(aes_pairs[["x"]])) {
      # A `rect` with no x at all (e.g. a min/max reference band spanning
      # the whole plot) needs a real filled box, not a thin geom_linerange
      # line -- geom_rect with a fixed -Inf/Inf xmin/xmax spans the full
      # width without disturbing a continuous x scale a sibling layer uses
      # (a fake categorical x="" would otherwise force a discrete scale).
      aes_pairs[["x"]] <- NULL
      fixed[["xmin"]] <- "-Inf"
      fixed[["xmax"]] <- "Inf"
      return(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg))
    }
    if (mark_type %in% c("bar", "rect")) {
      if (is.null(aes_pairs[["x"]])) aes_pairs[["x"]] <- '""'
      return(build_call("ggplot2::geom_linerange", rename_fill_to_colour(aes_pairs), fixed, data_arg))
    }
    if (mark_type %in% c("area", "errorband")) {
      # geom_area only takes a single y (with an implicit ymin = 0); a real
      # ymin/ymax range needs geom_ribbon. With no companion x channel at
      # all (e.g. a global mean band spanning the whole plot), a fake
      # categorical x="" would force a discrete scale that breaks as soon as
      # another layer shares the x axis with real continuous data -- a
      # fixed -Inf/Inf xmin/xmax spans the full plot width instead, without
      # touching the scale.
      if (is.null(aes_pairs[["x"]])) {
        # geom_ribbon still requires a plain x/y aes even with xmin/xmax
        # supplied as fixed params -- an arbitrary numeric constant
        # satisfies that without affecting where the ribbon is actually
        # drawn (xmin/xmax alone control the horizontal extent).
        aes_pairs[["x"]] <- "0"
        fixed[["xmin"]] <- "-Inf"
        fixed[["xmax"]] <- "Inf"
      }
      return(build_call("ggplot2::geom_ribbon", aes_pairs, fixed, data_arg))
    }
    if (is.null(aes_pairs[["x"]])) aes_pairs[["x"]] <- '""'
    return(build_call("ggplot2::geom_errorbar", aes_pairs, fixed, data_arg))
  }
  if (!is.null(x_range) && mark_type %in% c("bar", "rect", "errorband", "errorbar")) {
    aes_pairs[["xmin"]] <- x_range$min
    aes_pairs[["xmax"]] <- x_range$max
    aes_pairs[["x"]] <- NULL
    if (mark_type == "rect" && is.null(aes_pairs[["y"]])) {
      # Same reasoning as the y_range branch's "rect" case above, just
      # transposed: a vertical full-height band instead of horizontal.
      fixed[["ymin"]] <- "-Inf"
      fixed[["ymax"]] <- "Inf"
      return(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg))
    }
    if (mark_type %in% c("bar", "rect") && !is.null(aes_pairs[["y"]]) && identical(encoding$y$type, "quantitative")) {
      # A real quantitative y value alongside a binned x range (e.g. a
      # pre-binned histogram given as explicit bin_start/bin_end + count
      # columns) -- a proper zero-baseline-anchored box, not the Gantt-
      # style "thick line at a fixed height" case below (which only makes
      # sense when the companion axis is categorical, not a real value).
      aes_pairs[["ymax"]] <- aes_pairs[["y"]]
      aes_pairs[["ymin"]] <- "0"
      aes_pairs[["y"]] <- NULL
      return(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg))
    }
    if (is.null(aes_pairs[["y"]])) aes_pairs[["y"]] <- '""'
    if (mark_type %in% c("bar", "rect")) {
      # The companion axis (y) is typically categorical here (e.g. a Gantt
      # chart), which geom_rect can't size a box against directly --
      # geom_linerange with a widened linewidth is the standard ggplot2
      # workaround for a horizontal "thick bar" at a discrete position.
      fixed[["linewidth"]] <- fixed[["linewidth"]] %||% "10"
      return(build_call("ggplot2::geom_linerange", rename_fill_to_colour(aes_pairs), fixed, data_arg))
    }
    return(build_call("ggplot2::geom_errorbar", aes_pairs, fixed, data_arg))
  }

  if (mark_type == "arc") {
    # The classic ggplot2 "pie chart" recipe: a single-category stacked bar
    # (theta -> y) later wrapped in coord_polar(theta = "y") by the caller.
    # geom_bar needs *some* x aesthetic even though a pie has no x axis.
    if (is.null(aes_pairs[["x"]])) aes_pairs[["x"]] <- '""'
    fixed[["width"]] <- "1"
    fixed[["stat"]] <- fixed[["stat"]] %||% '"identity"'
  }
  if (mark_type %in% c("bar", "rect") && !is.null(aes_pairs[["x"]]) && is.null(aes_pairs[["y"]]) &&
      is.null(x_range) && is.null(y_range) && !isTRUE(plan$use_histogram) && is.null(fixed[["stat"]])) {
    # A bar/rect mark with only a position (x) channel and no value (y)
    # axis at all, and no x2/y2 range either (e.g. a vertical highlight
    # band marking specific x positions, like a null-data day) -- this is
    # not the "1D dot plot" the generic fallback just below treats every
    # other 1-axis mark as (a bar/rect has no meaningful "categorical
    # placeholder position", only ever a real value to size against), and
    # there's no value to size a box against either -- a full plot-height
    # band at that x position instead, via the same -Inf/Inf idiom used
    # elsewhere in this file for a reference band with a missing companion
    # axis. Width is derived from the smallest gap between this layer's own
    # sorted x values (falling back to a fixed guess when there's only one),
    # since there's no bin/band width to read off the (continuous) x scale.
    # Excludes a genuinely quantitative x (a real 1D aggregate value, e.g.
    # `x: {"aggregate": "sum", "field": ...}` with no groupby at all) --
    # that's the generic fallback's "1D bar" case below, sized from a zero
    # baseline, not a position to draw a reference band at.
    x_expr <- aes_pairs[["x"]]
    half_width_expr <- sprintf(
      "(function(.v) { .u <- sort(unique(as.numeric(.v))); if (length(.u) > 1) min(diff(.u)) / 2 else 0.5 })(%s)",
      x_expr
    )
    aes_pairs[["xmin"]] <- sprintf("(%s) - (%s)", x_expr, half_width_expr)
    aes_pairs[["xmax"]] <- sprintf("(%s) + (%s)", x_expr, half_width_expr)
    aes_pairs[["x"]] <- NULL
    fixed[["ymin"]] <- "-Inf"
    fixed[["ymax"]] <- "Inf"
    return(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg))
  }
  if (mark_type == "text") {
    # A `text` mark's x/y is usually an encoding channel, but Vega-Lite also
    # allows a literal pixel offset directly on the mark definition -- used
    # in practice for margin labels sitting just outside the plot area
    # (e.g. row labels to the left of a shared axis). A fake categorical
    # `""` position (the generic 1D-strip fallback just below) would force
    # a discrete scale that breaks as soon as a sibling layer shares that
    # axis with real continuous/temporal data, so this pins the label to
    # the actual plot edge instead -- side picked from `align` (Vega-Lite's
    # own default is "left", meaning "extends rightward from the anchor",
    # so the anchor sits at the left edge... but a fixed mark-level x with
    # no encoding is virtually always an axis-margin label, and `align:
    # "right"` specifically means the text hangs off *before* its anchor,
    # i.e. a label meant to sit to the left of the plot).
    if (is.null(aes_pairs[["x"]]) && !is.null(mark_props[["x"]]) && is.numeric(mark_props[["x"]])) {
      fixed[["x"]] <- if (identical(mark_props[["align"]], "right")) "-Inf" else "Inf"
    }
    if (is.null(aes_pairs[["y"]]) && !is.null(mark_props[["y"]]) && is.numeric(mark_props[["y"]])) {
      fixed[["y"]] <- if (identical(mark_props[["baseline"]], "top")) "-Inf" else "Inf"
    }
  }
  if (mark_type %in% c("point", "circle", "square", "tick", "bar", "rect", "text") && !isTRUE(plan$use_histogram) && !identical(fixed[["stat"]], '"count"')) {
    # A 1D strip/dot plot (only one of x/y given) centers on the missing
    # axis rather than requiring both -- mirroring vl2d3's same fallback.
    # With *neither* axis given, ggplot2 needs the constant supplied as a
    # fixed (non-aes) param instead -- an all-constant aes() mapping can't
    # tell ggplot2 how many rows to draw. Guarded on `stat != "count"`:
    # stat_count is the *only* stat here that auto-supplies a genuinely
    # missing axis on its own (from counting rows) -- stat_summary keeps
    # its aggregated axis but still needs a real position for the other
    # (groupby) axis, same as an unaggregated mark would. This must run
    # *before* geom_function_name() decides geom_bar-vs-geom_col below,
    # since that decision depends on whether "y" ends up present.
    if (is.null(aes_pairs[["x"]]) && is.null(fixed[["x"]]) && is.null(aes_pairs[["y"]]) && is.null(fixed[["y"]])) {
      fixed[["x"]] <- '""'
      fixed[["y"]] <- '""'
    } else if (is.null(aes_pairs[["x"]]) && is.null(fixed[["x"]])) {
      aes_pairs[["x"]] <- '""'
    } else if (is.null(aes_pairs[["y"]]) && is.null(fixed[["y"]])) {
      aes_pairs[["y"]] <- '""'
    }
  }
  # geom_col()/geom_bar()'s default orientation ("x": x is the
  # category/position axis, y is the value drawn from a zero baseline) is
  # normally inferred correctly from which aesthetic ggplot2 sees as
  # discrete at build time -- but a *continuous* position axis (a temporal
  # y with a quantitative x, e.g. a horizontal bar chart binned/bucketed by
  # date) never looks discrete to that inference, so it silently guesses
  # vertical bars instead. Detected directly from Vega-Lite's own encoding
  # types (temporal/ordinal/nominal is a position axis; quantitative is the
  # value axis) rather than relying on ggplot2 to guess right.
  if (mark_type == "bar" && is.null(fixed[["orientation"]]) &&
      identical(encoding$x$type, "quantitative") && !is.null(encoding$y$type) && !identical(encoding$y$type, "quantitative")) {
    fixed[["orientation"]] <- '"y"'
  }
  fn <- if (isTRUE(plan$use_histogram)) "ggplot2::geom_histogram" else geom_function_name(mark_type, mark_props, has_y = !is.null(aes_pairs[["y"]]), ignore_unsupported, .notes)
  build_call(fn, aes_pairs, fixed, data_arg)
}

render_rule_layer <- function(encoding, aes_pairs, fixed, data_arg, ignore_unsupported = FALSE, .notes = NULL) {
  has_x <- !is.null(encoding$x)
  has_y <- !is.null(encoding$y)
  has_x2 <- !is.null(encoding$x2)
  has_y2 <- !is.null(encoding$y2)

  if (has_x && has_x2 && !has_y2) {
    aes_pairs[["xend"]] <- channel_value_expr(encoding$x2, ignore_unsupported, .notes)
    # geom_segment always needs y/yend even for a purely horizontal segment
    # (no y channel at all) -- the same constant-"" convention as the
    # 1D-strip fallback elsewhere.
    aes_pairs[["y"]] <- if (has_y) aes_pairs[["y"]] else '""'
    aes_pairs[["yend"]] <- aes_pairs[["y"]]
    return(build_call("ggplot2::geom_segment", aes_pairs, fixed, data_arg))
  }
  if (has_y && has_y2 && !has_x2) {
    aes_pairs[["yend"]] <- channel_value_expr(encoding$y2, ignore_unsupported, .notes)
    aes_pairs[["x"]] <- if (has_x) aes_pairs[["x"]] else '""'
    aes_pairs[["xend"]] <- aes_pairs[["x"]]
    return(build_call("ggplot2::geom_segment", aes_pairs, fixed, data_arg))
  }
  # A constant (`value`/`datum`, no `field`) is a fixed, non-aes geom
  # argument; a `field` (whether or not it's aggregated -- an aggregated
  # field still needs the stat/fun from `fixed` to compute it) must be a
  # proper aes() mapping, or ggplot2 tries to evaluate the column name in
  # the calling environment instead of the data.
  if (has_x && !has_y) {
    if (!is.null(encoding$x$field)) {
      # Keep any other aes (e.g. color, grouping the rule into one line per
      # group) alongside the intercept itself.
      aes_pairs[["xintercept"]] <- aes_pairs[["x"]]
      aes_pairs[["x"]] <- NULL
      return(build_call("ggplot2::geom_vline", aes_pairs, fixed, data_arg))
    }
    # A constant (value/datum, no field) channel is built into `fixed`, not
    # `aes_pairs` (see build_layer_channels()) -- read it from there, and
    # drop it out of `fixed` again so it isn't *also* passed through as a
    # meaningless literal "x" geom argument.
    xintercept <- fixed[["x"]]
    fixed[["x"]] <- NULL
    return(build_call("ggplot2::geom_vline", list(xintercept = xintercept), fixed, data_arg = NULL, as_aes = FALSE))
  }
  if (has_y && !has_x) {
    if (!is.null(encoding$y$field)) {
      aes_pairs[["yintercept"]] <- aes_pairs[["y"]]
      aes_pairs[["y"]] <- NULL
      return(build_call("ggplot2::geom_hline", aes_pairs, fixed, data_arg))
    }
    yintercept <- fixed[["y"]]
    fixed[["y"]] <- NULL
    return(build_call("ggplot2::geom_hline", list(yintercept = yintercept), fixed, data_arg = NULL, as_aes = FALSE))
  }
  if (ignore_unsupported) {
    .push_note(.notes, '"rule" mark has neither x nor y encoding, drawing nothing (ignore_unsupported)')
    return("ggplot2::geom_blank()") # nothing to draw a rule against
  }
  stop('"rule" mark requires an x and/or y encoding')
}

build_call <- function(fn, aes_pairs, fixed, data_arg, as_aes = TRUE) {
  args <- character(0)
  if (!is.null(data_arg)) args <- c(args, sprintf("data = %s", data_arg))
  if (as_aes && length(aes_pairs) > 0) {
    aes_call <- render_aes_call(aes_pairs)
    if (!is.null(aes_call)) args <- c(args, sprintf("mapping = %s", aes_call))
  } else if (!as_aes) {
    args <- c(args, render_kwargs(aes_pairs))
  }
  args <- c(args, render_kwargs(fixed))
  format_call(fn, args)
}
