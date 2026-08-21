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
simple_color_value <- function(value) {
  if (is.list(value)) stop("Unsupported: gradient fill/stroke definitions are not supported")
  format_value(value)
}

mark_fixed_params <- function(mark_props, mark_type) {
  fixed <- list()
  if (!is.null(mark_props$color)) fixed[[color_channel_aes(mark_type)]] <- simple_color_value(mark_props$color)
  if (!is.null(mark_props$fill)) fixed[["fill"]] <- simple_color_value(mark_props$fill)
  if (!is.null(mark_props$stroke)) fixed[["colour"]] <- simple_color_value(mark_props$stroke)
  if (!is.null(mark_props$opacity)) fixed[["alpha"]] <- format_value(mark_props$opacity)
  if (!is.null(mark_props$strokeWidth)) fixed[["linewidth"]] <- format_value(mark_props$strokeWidth)
  if (!is.null(mark_props$size) && !(mark_type %in% c("bar", "area", "line"))) {
    fixed[["size"]] <- format_value(mark_props$size)
  }
  # A `text` mark's label is usually an encoding channel, but Vega-Lite also
  # allows a literal constant directly on the mark definition (a string, or
  # an array of strings meaning multiple lines).
  if (mark_type == "text" && !is.null(mark_props$text)) {
    label <- if (is.list(mark_props$text)) {
      paste(vapply(mark_props$text, as.character, character(1)), collapse = "\n")
    } else {
      as.character(mark_props$text)
    }
    fixed[["label"]] <- render_string(label)
  }
  fixed
}

# geom function name for a mark, given its properties (a few marks pick a
# different geom based on a property, e.g. line + interpolate: "step").
geom_function_name <- function(mark_type, mark_props, has_y = TRUE) {
  switch(mark_type,
    # geom_col (stat="identity") needs an explicit y; a bar mark whose y is
    # a bare `{"aggregate": "count"}` has none -- geom_bar's default
    # stat="count" is what supplies it.
    bar = if (has_y) "ggplot2::geom_col" else "ggplot2::geom_bar",
    line = if (!is.null(mark_props$interpolate) && grepl("step", mark_props$interpolate)) "ggplot2::geom_step" else "ggplot2::geom_line",
    area = "ggplot2::geom_area",
    point = "ggplot2::geom_point",
    circle = "ggplot2::geom_point",
    tick = "ggplot2::geom_point",
    text = "ggplot2::geom_text",
    rule = NULL, # dispatched specially: geom_hline/vline/segment
    arc = "ggplot2::geom_bar",
    boxplot = "ggplot2::geom_boxplot",
    errorbar = "ggplot2::geom_errorbar",
    errorband = "ggplot2::geom_ribbon",
    trail = "ggplot2::geom_line",
    stop(sprintf('Unsupported mark type: "%s"', mark_type))
  )
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
error_bounds <- function(encoding, axis) {
  err_key <- paste0(axis, "Error")
  err2_key <- paste0(axis, "Error2")
  range2_key <- paste0(axis, "2")
  base <- encoding[[axis]]
  if (is.null(base)) return(NULL)
  base_expr <- channel_value_expr(base)

  if (!is.null(encoding[[err_key]])) {
    err_expr <- channel_value_expr(encoding[[err_key]])
    if (!is.null(encoding[[err2_key]])) {
      err2_expr <- channel_value_expr(encoding[[err2_key]])
      return(list(min = sprintf("(%s) + (%s)", base_expr, err_expr), max = sprintf("(%s) + (%s)", base_expr, err2_expr)))
    }
    return(list(min = sprintf("(%s) - (%s)", base_expr, err_expr), max = sprintf("(%s) + (%s)", base_expr, err_expr)))
  }
  if (!is.null(encoding[[range2_key]])) {
    return(list(min = base_expr, max = channel_value_expr(encoding[[range2_key]])))
  }
  NULL
}

# Build one complete geom_*(...) layer call.
# `plan` (from transforms.R's plan_layer_data()) may add extra fixed params
# (e.g. stat = "count"/"summary") and note whether this layer needs
# geom_histogram instead of the plain mark geom.
render_geom_layer <- function(mark, encoding, data_arg, plan) {
  mark_type <- if (is.character(mark)) mark else mark$type
  mark_props <- if (is.character(mark)) list() else mark[names(mark) != "type"]

  channels <- build_layer_channels(encoding, mark_type)
  fixed <- merge_named(mark_fixed_params(mark_props, mark_type), channels$fixed)
  if (!is.null(plan$extra_fixed)) fixed <- merge_named(fixed, plan$extra_fixed)

  aes_pairs <- channels$aes
  if (!is.null(plan$extra_aes)) aes_pairs <- merge_named(aes_pairs, plan$extra_aes)

  # x2/y2/xError/yError: meaning depends on the geom, and either axis can
  # carry the range for a horizontal-vs-vertical errorbar/errorband.
  if (mark_type == "rule") {
    return(render_rule_layer(encoding, aes_pairs, fixed, data_arg))
  }
  y_range <- error_bounds(encoding, "y")
  x_range <- error_bounds(encoding, "x")
  if (!is.null(y_range) && !is.null(x_range) && mark_type == "bar") {
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
  if (!is.null(y_range) && mark_type %in% c("bar", "area", "errorband", "errorbar")) {
    aes_pairs[["ymin"]] <- y_range$min
    aes_pairs[["ymax"]] <- y_range$max
    aes_pairs[["y"]] <- NULL
    if (mark_type == "bar") {
      if (is.null(aes_pairs[["x"]])) aes_pairs[["x"]] <- '""'
      return(build_call("ggplot2::geom_linerange", aes_pairs, fixed, data_arg))
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
  if (!is.null(x_range) && mark_type %in% c("bar", "errorband", "errorbar")) {
    aes_pairs[["xmin"]] <- x_range$min
    aes_pairs[["xmax"]] <- x_range$max
    aes_pairs[["x"]] <- NULL
    if (is.null(aes_pairs[["y"]])) aes_pairs[["y"]] <- '""'
    if (mark_type == "bar") {
      # The companion axis (y) is typically categorical here (e.g. a Gantt
      # chart), which geom_rect can't size a box against directly --
      # geom_linerange with a widened linewidth is the standard ggplot2
      # workaround for a horizontal "thick bar" at a discrete position.
      fixed[["linewidth"]] <- fixed[["linewidth"]] %||% "10"
      return(build_call("ggplot2::geom_linerange", aes_pairs, fixed, data_arg))
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
  if (mark_type %in% c("point", "circle", "tick", "bar", "text") && !isTRUE(plan$use_histogram) && !identical(fixed[["stat"]], '"count"')) {
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
    if (is.null(aes_pairs[["x"]]) && is.null(aes_pairs[["y"]])) {
      fixed[["x"]] <- '""'
      fixed[["y"]] <- '""'
    } else if (is.null(aes_pairs[["x"]])) {
      aes_pairs[["x"]] <- '""'
    } else if (is.null(aes_pairs[["y"]])) {
      aes_pairs[["y"]] <- '""'
    }
  }
  fn <- if (isTRUE(plan$use_histogram)) "ggplot2::geom_histogram" else geom_function_name(mark_type, mark_props, has_y = !is.null(aes_pairs[["y"]]))
  build_call(fn, aes_pairs, fixed, data_arg)
}

render_rule_layer <- function(encoding, aes_pairs, fixed, data_arg) {
  has_x <- !is.null(encoding$x)
  has_y <- !is.null(encoding$y)
  has_x2 <- !is.null(encoding$x2)
  has_y2 <- !is.null(encoding$y2)

  if (has_x && has_x2 && !has_y2) {
    aes_pairs[["xend"]] <- channel_value_expr(encoding$x2)
    # geom_segment always needs y/yend even for a purely horizontal segment
    # (no y channel at all) -- the same constant-"" convention as the
    # 1D-strip fallback elsewhere.
    aes_pairs[["y"]] <- if (has_y) aes_pairs[["y"]] else '""'
    aes_pairs[["yend"]] <- aes_pairs[["y"]]
    return(build_call("ggplot2::geom_segment", aes_pairs, fixed, data_arg))
  }
  if (has_y && has_y2 && !has_x2) {
    aes_pairs[["yend"]] <- channel_value_expr(encoding$y2)
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
    return(build_call("ggplot2::geom_vline", list(xintercept = aes_pairs[["x"]]), fixed, data_arg = NULL, as_aes = FALSE))
  }
  if (has_y && !has_x) {
    if (!is.null(encoding$y$field)) {
      aes_pairs[["yintercept"]] <- aes_pairs[["y"]]
      aes_pairs[["y"]] <- NULL
      return(build_call("ggplot2::geom_hline", aes_pairs, fixed, data_arg))
    }
    return(build_call("ggplot2::geom_hline", list(yintercept = aes_pairs[["y"]]), fixed, data_arg = NULL, as_aes = FALSE))
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
