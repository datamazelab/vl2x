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
  format_value(normalize_css_color(value))
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
# A top-level `params` entry can bind a mark/encoding property to a live,
# interactive value (`{"bind": {"input": "range", ...}}`) -- this project
# has no interactivity, so the only thing worth reproducing is its *static
# default* (`value`), which is what every property bound via `{"expr":
# "<param name>"}` actually shows on first render anyway (mirrors vl2d3's
# identical resolveStaticParams()/evalSimpleParamExpr() in translator.js --
# see that file for the full rationale, including why a single left-to-
# right pass over `params` is enough for a derived param that references an
# earlier one, e.g. a bullet chart's own `innerBarSize: height / 2`).
resolve_static_params <- function(params) {
  values <- list()
  for (p in params %||% list()) {
    if (is.null(p$name)) next
    if (is.numeric(p$value) && length(p$value) == 1) {
      values[[p$name]] <- p$value
    } else if (is.character(p$expr) && length(p$expr) == 1) {
      resolved <- eval_simple_param_expr(p$expr, values)
      if (!is.null(resolved)) values[[p$name]] <- resolved
    }
  }
  values
}

# Substitutes every already-resolved param name in `expr` with its numeric
# value, then evaluates the result -- but only if what's left is safe,
# plain arithmetic (a whitelist of digits/operators/parens/whitespace, no
# identifiers at all): deliberately refuses anything referencing an
# unresolved param, a signal, or a Vega expression function, returning NULL
# for the caller to fall back on rather than guessing.
eval_simple_param_expr <- function(expr, param_values) {
  substituted <- expr
  for (nm in names(param_values)) {
    substituted <- gsub(sprintf("\\b%s\\b", nm), sprintf("(%s)", format_value(param_values[[nm]])), substituted, perl = TRUE)
  }
  if (!grepl("^[0-9\\s+*/().-]+$", substituted, perl = TRUE)) return(NULL)
  result <- tryCatch(eval(parse(text = substituted)), error = function(e) NULL)
  if (is.numeric(result) && length(result) == 1 && is.finite(result)) result else NULL
}

# Resolves any mark property bound to a *static* param (`{"expr": "<param
# name or simple arithmetic over param names>"}`) into the literal number
# it would show on first render, by substituting it directly into the
# expr's own text -- mark_scalar_value() below already handles a plain
# numeric expr string as-is, so this needs no further plumbing once the
# substitution happens here, up front. A prop already a plain literal, or
# bound to something eval_simple_param_expr() can't resolve, passes through
# unchanged for mark_scalar_value()'s own existing fallback to handle.
resolve_mark_prop_exprs <- function(mark_props, param_values) {
  if (length(param_values) == 0) return(mark_props)
  for (k in names(mark_props)) {
    v <- mark_props[[k]]
    if (is.list(v) && is.character(v[["expr"]])) {
      resolved <- eval_simple_param_expr(v[["expr"]], param_values)
      if (!is.null(resolved)) mark_props[[k]][["expr"]] <- format_value(resolved)
    }
  }
  mark_props
}

# Vega-Lite's point/circle/square/tick mark `size` is the marker's *area*
# in px^2 (default 30) -- ggplot2's own `size` aesthetic for the same geoms
# is a diameter-ish measurement in mm (`geom_point()` renders a symbol
# `size * .pt` points across, where `.pt <- 72.27 / 25.4` is points-per-mm,
# and a "point" (1/72.27 inch) is close enough to a px at the nominal
# ~72dpi both Vega-Lite and ggsave() render at to treat as equivalent
# here). Passing a raw Vega-Lite area value straight through as ggplot2's
# `size`, as if the two units already matched, produces a wildly, unusably
# oversized marker (e.g. stocks-2009-layered-line-point.vl.json's `size:
# 60` swallows the entire plot panel) -- converted via the two shapes'
# actual geometric relationship (`diameter = 2 * sqrt(area / pi)`) instead.
.pt_per_mm <- 72.27 / 25.4

vl_point_size_to_ggplot <- function(area) {
  if (!is.numeric(area) || is.na(area) || area <= 0) return(area)
  (2 * sqrt(area / pi)) / .pt_per_mm
}

# Same literal-vs-expr resolution as mark_scalar_value() below, but for the
# `size` mark property specifically -- the numeric result (whether a plain
# literal or a static expression) needs the area->ggplot2-size conversion
# above; the "no static value, fall back to ggplot2's own default" case
# does NOT (that fallback, "1.5", is already a ggplot2-native size, not a
# Vega-Lite area needing conversion).
mark_size_value <- function(value, ignore_unsupported = FALSE, .notes = NULL) {
  if (is.list(value) && !is.null(value[["expr"]])) {
    translated <- translate_expr(value[["expr"]])
    if (grepl("^-?[0-9.]+$", translated)) return(format_value(vl_point_size_to_ggplot(as.numeric(translated))))
    if (ignore_unsupported) {
      .push_note(.notes, sprintf(
        'unsupported mark property bound to a non-literal expression/signal ("%s"), using the default point size instead (ignore_unsupported)',
        value[["expr"]]
      ))
      return("1.5")
    }
    stop(sprintf('Unsupported: mark property is bound to an expression/signal ("%s") with no static value', value[["expr"]]))
  }
  format_value(vl_point_size_to_ggplot(value))
}

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
    fixed[["size"]] <- mark_size_value(mark_props[["size"]], ignore_unsupported, .notes)
  }
  # A boxplot's `extent` picks how far the whiskers reach: "min-max" means
  # the true data min/max (no point is ever an outlier), while a bare
  # number is an IQR multiplier (Vega-Lite default: 1.5, matching
  # stat_boxplot()'s own `coef` default -- so this only needs to emit
  # anything for the "min-max" case, via `coef = Inf` (no finite multiple
  # of the IQR excludes a point, so the whisker reaches every point)).
  if (mark_type == "boxplot" && identical(mark_props[["extent"]], "min-max")) {
    fixed[["coef"]] <- "Inf"
  } else if (mark_type == "boxplot" && is.numeric(mark_props[["extent"]])) {
    fixed[["coef"]] <- format_value(mark_props[["extent"]])
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
    # A companion range field (e.g. histogram_nonlinear.vl.json's own `x2:
    # {field: "endTime"}`, no type of its own at all) is positioned on
    # exactly the same scale the *base* channel resolved to, regardless of
    # its own type annotation (or lack of one).
    range2_def <- encoding[[range2_key]]
    if (identical(base$type, "ordinal") || identical(base$type, "nominal")) {
      # An ordinal/nominal base (a discrete factor()-backed scale) needs its
      # companion positioned on the SAME numbering -- computing each field's
      # factor() levels independently (discrete_field_ref()'s usual
      # per-field behavior) assigns each its own separate numbering over its
      # own distinct values, and for two different-but-overlapping value
      # sets (e.g. "startTime"/"endTime" bin edges, sharing most but not all
      # of their distinct values) that produces two INCOMPATIBLE numberings
      # -- ggplot2 then draws nonsensical/reversed rects (or, when the
      # companion is left entirely unwrapped, refuses to plot at all:
      # "Discrete value supplied to a continuous scale"). Building one
      # shared level set -- the union of both fields' own distinct values,
      # in the order values are first encountered scanning the two fields
      # row-by-row together, matching `sort: null`'s "use the data's own
      # order" semantics -- keeps both ends of each bin on one consistent
      # numeric axis once as.numeric()'d.
      base_ref <- field_ref(base$field)
      range2_ref <- field_ref(range2_def$field)
      combined_expr <- sprintf("unique(as.vector(rbind(%s, %s)))", base_ref, range2_ref)
      shared_levels_expr <- if (is.list(base$sort) && is.null(names(base$sort))) {
        sprintf("union(%s, %s)", format_value(base$sort), combined_expr)
      } else {
        combined_expr
      }
      return(list(
        min = sprintf("factor(%s, levels = %s)", base_ref, shared_levels_expr),
        max = sprintf("factor(%s, levels = %s)", range2_ref, shared_levels_expr)
      ))
    }
    return(list(min = base_expr, max = channel_value_expr(range2_def, ignore_unsupported, .notes)))
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
# mark.line/mark.point (e.g. area_overlay.vl.json's own `{"type": "area",
# "line": true, "point": true}`) overlay the area's own top edge with a
# stroked line and/or a marker per data point -- ggplot2 has no single-geom
# equivalent (unlike vl2d3, which draws these by hand off the same
# coordinates), but layering separate geom_line()/geom_point() calls on top
# of the same geom_area()/geom_ribbon(), reusing `y_expr` as their own `y`,
# achieves the identical visual. Shared between the plain-area case (whose
# own `aes_pairs[["y"]]` is exactly the top edge) and the ranged/y2 case
# (geom_ribbon, whose `y` has already been replaced by ymin/ymax by the
# time this runs, so its caller passes the pre-replacement value instead).
build_area_overlay_layers <- function(aes_pairs, y_expr, mark_props, data_arg, fixed = list()) {
  if (is.null(y_expr) || (!isTRUE(mark_props[["line"]]) && !isTRUE(mark_props[["point"]]))) return(character(0))
  overlay_aes <- aes_pairs[intersect(c("x", "y"), names(aes_pairs))]
  overlay_aes[["y"]] <- y_expr
  if (!is.null(aes_pairs[["fill"]])) overlay_aes[["colour"]] <- aes_pairs[["fill"]]
  # The overlay tracks the main mark's own resolved style/stat exactly --
  # a mark-level (or literal `.value`-bound encoding) colour (e.g. layer_
  # overlay.vl.json's own `color: {"value": "darkred"}`, rendered as a
  # FIXED `colour = "darkred"` param, not an aes mapping, since there's no
  # per-row field to map) and, for an inline-aggregated line/area (`stat =
  # "summary", fun = "..."`), the SAME aggregate -- omitted here, the
  # overlay would draw with ggplot2's own default black point/line color,
  # and (for `stat`/`fun`) one raw point per UNAGGREGATED row instead of
  # one per aggregated group, mismatching the main mark's own position.
  overlay_fixed <- fixed[intersect(c("colour", "stat", "fun"), names(fixed))]
  extra_layers <- character(0)
  if (isTRUE(mark_props[["line"]])) {
    extra_layers <- c(extra_layers, build_call("ggplot2::geom_line", overlay_aes, overlay_fixed, data_arg))
  }
  if (isTRUE(mark_props[["point"]])) {
    extra_layers <- c(extra_layers, build_call("ggplot2::geom_point", overlay_aes, overlay_fixed, data_arg))
  }
  extra_layers
}

render_geom_layer <- function(mark, encoding, data_arg, plan, ignore_unsupported = FALSE, extent_data_var = NULL, extent_params = list()) {
  notes_env <- new.env()
  code <- render_geom_layer_code(mark, encoding, data_arg, plan, ignore_unsupported, notes_env, extent_data_var, extent_params)
  notes <- notes_env$notes
  list(code = code, notes = if (is.null(notes)) character(0) else paste0("# vl2ggplot: ", notes))
}

# A genuinely QUANTITATIVE `xOffset`/`yOffset` (as opposed to the far more
# common categorical "dodge" case, which maps directly onto ggplot2's own
# `position_dodge2()` -- see prepare_unit()'s own comment, translator.R) is
# a real, distinct shape -- bar_ranged_offset_quantitative.vl.json's own
# `y: {field: "team"}` + `yOffset: {field: "score", type: "quantitative"}`:
# confirmed against the real compiler's own output, the offset channel gets
# a LINEAR sub-position *within* the outer category's own band (domain: the
# field's own real min/max, NOT forced through zero), with a small FIXED
# thickness -- not a value-driven zero-baseline bar length, and not a
# discrete per-group dodge slot ggplot2's own `position_dodge2()` has no way
# to express at all (it requires a discrete grouping variable, not a
# continuous one). Built as `geom_rect()` with every position expressed as
# a pure aes() computation (factor()-derived integer positions, `min()`/
# `max()` read directly off the mapped column) rather than pre-mutated
# columns, since this function -- unlike prepare_unit()/plan_layer_data(),
# which have real emitter access for a separate statements list -- can only
# return the one geom-call (plus scale) string appended onto the plot.
render_ranged_offset_bar_layer <- function(encoding, offset_channel, data_arg, extent_data_var) {
  base_ch <- if (offset_channel == "yOffset") "y" else "x"
  plain_ch <- if (base_ch == "y") "x" else "y"
  offset_field <- encoding[[offset_channel]]$field
  base_field <- encoding[[base_ch]]$field
  plain_field <- encoding[[plain_ch]]$field
  color_def <- encoding$color
  data_var <- data_arg %||% extent_data_var

  band_span <- 0.8
  half_span <- band_span / 2
  thickness <- band_span * 0.5
  offset_ref <- field_ref(offset_field)
  sub_pos_expr <- sprintf(
    "(((%s) - min(%s)) / max(max(%s) - min(%s), 1e-9)) * %s",
    offset_ref, offset_ref, offset_ref, offset_ref, band_span
  )
  base_pos_expr <- sprintf("as.numeric(factor(%s))", field_ref(base_field))
  plain_pos_expr <- sprintf("as.numeric(factor(%s))", field_ref(plain_field))
  fill_expr <- if (!is.null(color_def$field)) sprintf(", fill = factor(%s)", field_ref(color_def$field)) else ""

  aes_expr <- if (base_ch == "y") {
    sprintf(
      "ggplot2::aes(xmin = (%s) - %s, xmax = (%s) + %s, ymin = (%s) - %s + %s, ymax = (%s) - %s + %s + %s%s)",
      plain_pos_expr, half_span, plain_pos_expr, half_span,
      base_pos_expr, half_span, sub_pos_expr,
      base_pos_expr, half_span, sub_pos_expr, thickness, fill_expr
    )
  } else {
    sprintf(
      "ggplot2::aes(ymin = (%s) - %s, ymax = (%s) + %s, xmin = (%s) - %s + %s, xmax = (%s) - %s + %s + %s%s)",
      plain_pos_expr, half_span, plain_pos_expr, half_span,
      base_pos_expr, half_span, sub_pos_expr,
      base_pos_expr, half_span, sub_pos_expr, thickness, fill_expr
    )
  }
  geom_args <- character(0)
  if (!is.null(data_arg)) geom_args <- c(geom_args, sprintf("data = %s", data_arg))
  geom_args <- c(geom_args, sprintf("mapping = %s", aes_expr))
  geom_call <- format_call("ggplot2::geom_rect", geom_args)
  # geom_rect() needs plain numeric xmin/xmax/ymin/ymax (not a discrete
  # `factor()` position the way an ordinary geom_bar()/geom_col() axis
  # would show one natively) -- both category axes are real integer
  # positions here (`as.numeric(factor(...))`, above), so their own tick
  # labels need restoring by hand via explicit breaks/labels instead.
  plain_scale <- sprintf(
    "ggplot2::scale_%s_continuous(breaks = seq_along(levels(factor(%s[[%s]]))), labels = levels(factor(%s[[%s]])))",
    plain_ch, data_var, deparse(plain_field), data_var, deparse(plain_field)
  )
  base_scale <- sprintf(
    "ggplot2::scale_%s_continuous(breaks = seq_along(levels(factor(%s[[%s]]))), labels = levels(factor(%s[[%s]])))",
    base_ch, data_var, deparse(base_field), data_var, deparse(base_field)
  )
  paste(c(geom_call, plain_scale, base_scale), collapse = " +\n  ")
}

render_geom_layer_code <- function(mark, encoding, data_arg, plan, ignore_unsupported = FALSE, .notes = NULL, extent_data_var = NULL, extent_params = list()) {
  mark_type <- if (is.character(mark)) mark else mark$type
  mark_props <- if (is.character(mark)) list() else mark[names(mark) != "type"]

  channels <- build_layer_channels(encoding, mark_type, ignore_unsupported, .notes, extent_data_var, extent_params, standalone = isTRUE(plan$standalone), invalid_run_field = plan$invalid_run_field)
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
  if (mark_type %in% c("point", "circle", "square") &&
      (isTRUE(mark_props[["filled"]]) || !is.null(mark_props[["stroke"]])) && !is.null(aes_pairs[["colour"]])) {
    aes_pairs[["fill"]] <- aes_pairs[["colour"]]
    aes_pairs[["colour"]] <- NULL
    # Only forced to a fixed fillable shape (21) when there's no real
    # `shape` ENCODING of its own -- a literal (non-aes) layer argument for
    # an aesthetic silently *replaces* that same aesthetic's own aes()
    # mapping wholesale in ggplot2 (the exact same trap `stroke`'s own
    # comment above describes for colour), so unconditionally setting this
    # was discarding a genuine `shape: {"field": ...}` encoding outright --
    # every row rendered as the same plain filled circle regardless of its
    # own category (e.g. isotype_bar_chart.vl.json's `filled: true` point
    # mark, alongside its own `shape: {"field": "animal"}`).
    if (is.null(aes_pairs[["shape"]])) fixed[["shape"]] <- fixed[["shape"]] %||% "21"
  }

  # x2/y2/xError/yError: meaning depends on the geom, and either axis can
  # carry the range for a horizontal-vs-vertical errorbar/errorband.
  if (mark_type == "rule") {
    return(render_rule_layer(encoding, aes_pairs, fixed, data_arg, ignore_unsupported, .notes))
  }
  if (mark_type == "tick" && is.null(encoding$x2) && is.null(encoding$y2) &&
      is.null(encoding$xError) && is.null(encoding$yError) && is.null(plan$offset_field) &&
      (!is.null(aes_pairs[["x"]]) || !is.null(aes_pairs[["y"]]))) {
    # A dodged tick (an xOffset/yOffset field, e.g. tick_grouped.vl.json)
    # isn't handled by render_tick_layer() at all -- it has no equivalent
    # of the manual per-group dodge arithmetic the bar/rect "real discrete
    # x position" case implements (geoms.R, above) for its own xmin/xmax,
    # and geom_segment() doesn't support position_dodge2() the way
    # geom_point() (this mark's own fallback, just below) natively does --
    # falls through to the generic point-based rendering instead, an
    # accepted narrower gap rather than a broken/erroring dodge. Likewise a
    # tick with *neither* x nor y of its own (e.g.
    # parallel_coordinate.vl.json's own repeat-of-layers construction,
    # whose innermost tick layer inherits no usable position at all) falls
    # through too, to the generic "1D strip / centered fallback" every
    # other point-like mark already shares (below, `fixed[["x"]] <- '""'`
    # etc) -- render_tick_layer() has no equivalent of that fallback.
    return(render_tick_layer(encoding, aes_pairs, fixed, mark_props, data_arg, ignore_unsupported, .notes))
  }
  if (mark_type %in% c("bar", "rect")) {
    quant_offset_channel <-
      if (!is.null(encoding$yOffset) && identical(encoding$yOffset$type, "quantitative")) "yOffset"
      else if (!is.null(encoding$xOffset) && identical(encoding$xOffset$type, "quantitative")) "xOffset"
      else NULL
    if (!is.null(quant_offset_channel)) {
      return(render_ranged_offset_bar_layer(encoding, quant_offset_channel, data_arg, extent_data_var))
    }
  }
  y_range <- error_bounds(encoding, "y", ignore_unsupported, .notes)
  x_range <- error_bounds(encoding, "x", ignore_unsupported, .notes)
  # The companion axis's own full-plot-height/-width fill: `-Inf`/`Inf` when
  # this mark might share its scale with a sibling layer's real data (a
  # layer/repeat-layer child -- ggplot2 unions Inf against whatever finite
  # range that sibling establishes, giving a true full-height band), but a
  # *finite* symmetric fallback when this view is the only thing setting up
  # that scale at all (translate_unit's standalone case): every row's
  # min/max would otherwise be the same +/-Inf, leaving ggplot2 nothing
  # finite to compute an actual panel range from at all, and the mark
  # silently fails to draw anything.
  full_span <- if (isTRUE(plan$standalone)) c("-0.5", "0.5") else c("-Inf", "Inf")
  # When this view is genuinely standalone (no sibling layer could ever
  # give the companion axis real meaning), that axis's ticks/labels/title
  # are just noise -- ggplot2 still auto-generates them from full_span's
  # own -0.5/0.5 (or whatever finite fallback), which looks like a stray
  # unlabeled numeric axis rather than the single clean axis Vega-Lite
  # itself shows for this shape. Appended (via `+`) onto the geom call
  # itself, the same way an extra scale/theme layer normally would be.
  blank_axis_theme <- function(axis) {
    if (!isTRUE(plan$standalone)) return("")
    sprintf(
      " + ggplot2::theme(axis.text.%s = ggplot2::element_blank(), axis.ticks.%s = ggplot2::element_blank(), axis.title.%s = ggplot2::element_blank())",
      axis, axis, axis
    )
  }
  # Vega-Lite's own default for adjacent binned boxes (config.bar.binSpacing)
  # is a small fixed pixel gap between them; ggplot2 has no direct
  # pixel-space equivalent, so this shrinks each box toward its own center
  # by a proportional factor instead (10% total, by default) -- otherwise
  # adjacent occupied bins (e.g. a dense histogram-like binned field with
  # no aggregate) all touch edge-to-edge and visually merge into one
  # solid, undifferentiated block instead of showing as distinct bars.
  # `min + (max - min) / 2` (not `(min + max) / 2`, though the two are
  # algebraically identical for plain numbers) -- when min/max are Date
  # objects (a binned/ranged TEMPORAL axis, e.g. layer_falkensee.vl.json's
  # own `year_start`/`year_end`), `Date + Date` has no defined meaning at
  # all in R ("binary + is not defined for 'Date' objects", a real runtime
  # crash), while `Date - Date` (a difftime) and `Date + <numeric-like>`
  # both work -- this formula only ever adds a DIFFERENCE to one of the
  # original endpoints, never adds two endpoints together.
  shrink_range <- function(min_expr, max_expr, factor = 0.9) {
    mid <- sprintf("(%s) + ((%s) - (%s)) / 2", min_expr, max_expr, min_expr)
    half <- sprintf("(((%s) - (%s)) / 2) * %s", max_expr, min_expr, format_value(factor))
    list(min = sprintf("(%s) - (%s)", mid, half), max = sprintf("(%s) + (%s)", mid, half))
  }
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
    # Captured before ymin/ymax below replace `y` entirely -- see this
    # branch's own area/errorband case for why this (not ymax) is the
    # right edge for an overlaid line/point.
    overlay_y_expr <- y_range$min
    aes_pairs[["ymin"]] <- y_range$min
    aes_pairs[["ymax"]] <- y_range$max
    aes_pairs[["y"]] <- NULL
    if (mark_type %in% c("bar", "rect") && is.null(aes_pairs[["x"]])) {
      # A `rect`/`bar` with no x at all (e.g. a min/max reference band
      # spanning the whole plot, or -- transforms.R's plan_layer_data()
      # real-binning case -- a bin-only y channel with no aggregate
      # anywhere) needs a real filled box, not a thin geom_linerange line
      # -- geom_rect with a fixed -Inf/Inf xmin/xmax spans the full width
      # without disturbing a continuous x scale a sibling layer uses (a
      # fake categorical x="" would otherwise force a discrete scale). The
      # shrink gives adjacent occupied bins visible separation instead of
      # touching edge-to-edge (see shrink_range()); harmless on a single
      # sparse reference band, the other real use of this same shape.
      shrunk <- shrink_range(aes_pairs[["ymin"]], aes_pairs[["ymax"]])
      aes_pairs[["ymin"]] <- shrunk$min
      aes_pairs[["ymax"]] <- shrunk$max
      aes_pairs[["x"]] <- NULL
      fixed[["xmin"]] <- full_span[1]
      fixed[["xmax"]] <- full_span[2]
      return(paste0(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg), blank_axis_theme("x")))
    }
    if (mark_type %in% c("bar", "rect")) {
      if (is.null(aes_pairs[["x"]])) {
        aes_pairs[["x"]] <- '""'
        return(build_call("ggplot2::geom_linerange", rename_fill_to_colour(aes_pairs), fixed, data_arg))
      }
      # A real discrete x position (not the "no x at all" fallback just
      # above) can size a proper filled box after all -- e.g.
      # bar_layered_weather.vl.json's own several `y`/`y2`-ranged
      # "floating bar" layers, sharing one ordinal `id` x -- geom_rect
      # just needs numeric xmin/xmax, which a discrete/factor aes doesn't
      # give it directly. `as.numeric(<x>)` reads the factor's own 1-based
      # position (ggplot2's discrete axes are always laid out on
      # consecutive integers internally, whatever the labels), and
      # `mark.size` (Vega-Lite's own `config.bar.discreteBandSize` default
      # is exactly 20, matching geom_bar()'s own default `width = 0.9`
      # filling a unit-wide band) scales the half-width proportionally so
      # bar_layered_weather's several differently-sized layers (20px/12px/
      # 3px, all sharing the same band) still end up visibly different
      # widths, not identically thick.
      x_expr <- sprintf("as.numeric(%s)", aes_pairs[["x"]])
      if (isTRUE(plan$manual_dodge_stack) && !is.null(plan$offset_field)) {
        # A dodge field whose stack was already computed explicitly
        # (transforms.R's plan_explicit_aggregate(), `manual_dodge_stack`)
        # needs its own manual xmin/xmax dodge geometry here too -- ggplot2
        # has no single built-in `position` that both dodges *and* stacks,
        # so `position_dodge2()` (translator.R's usual dodge fallback,
        # skipped for exactly this case) can't do it. Slices the outer
        # (0.9-wide, matching geom_bar()'s own default) band into one
        # sub-slot per distinct offset value, `sort(unique(...))`-ordered
        # the same way vl2d3's own dodge sub-band scale is, each slot
        # filling 90% of its own share (a small gap between adjacent
        # dodge bars, mirroring position_dodge2()'s own default padding).
        offset_ref <- field_ref(plan$offset_field$field)
        n_groups_expr <- sprintf("length(unique(%s))", offset_ref)
        rank_expr <- sprintf("match(%s, sort(unique(%s)))", offset_ref, offset_ref)
        slot_width_expr <- sprintf("(0.9 / (%s))", n_groups_expr)
        center_expr <- sprintf("((%s) - 0.45 + ((%s) - 0.5) * (%s))", x_expr, rank_expr, slot_width_expr)
        half_width_expr <- sprintf("((%s) * 0.45)", slot_width_expr)
      } else {
        size_value <- mark_scalar_value(mark_props[["size"]] %||% 20, "20", ignore_unsupported, .notes)
        center_expr <- x_expr
        half_width_expr <- sprintf("0.45 * (%s) / 20", size_value)
      }
      aes_pairs[["xmin"]] <- sprintf("(%s) - (%s)", center_expr, half_width_expr)
      aes_pairs[["xmax"]] <- sprintf("(%s) + (%s)", center_expr, half_width_expr)
      aes_pairs[["x"]] <- NULL
      return(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg))
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
      main_call <- build_call("ggplot2::geom_ribbon", aes_pairs, fixed, data_arg)
      if (mark_type != "area") return(main_call)
      # mark.line/mark.point overlay on a *ranged* area (e.g.
      # area_overlay_with_y2.vl.json's own explicit `y2: {datum: 0}`
      # baseline) -- same idea as the plain-area overlay below, but there's
      # no single `aes_pairs[["y"]]` left to reuse (replaced by ymin/ymax
      # just above). error_bounds()'s own range2 branch always returns the
      # *base* channel's own value as `min` (regardless of which of
      # base/range2 is numerically smaller -- ranges aren't guaranteed
      # ordered), so `overlay_y_expr` (captured before ymin/ymax replaced
      # `y` above) is exactly the "top edge" Vega-Lite itself draws the
      # line/point overlay along.
      extra_layers <- build_area_overlay_layers(aes_pairs, overlay_y_expr, mark_props, data_arg, fixed)
      if (length(extra_layers) == 0) return(main_call)
      return(paste(c(main_call, extra_layers), collapse = " +\n  "))
    }
    if (is.null(aes_pairs[["x"]])) aes_pairs[["x"]] <- '""'
    return(build_call("ggplot2::geom_errorbar", aes_pairs, fixed, data_arg))
  }
  if (!is.null(x_range) && mark_type %in% c("bar", "rect", "errorband", "errorbar")) {
    aes_pairs[["xmin"]] <- x_range$min
    aes_pairs[["xmax"]] <- x_range$max
    aes_pairs[["x"]] <- NULL
    if (mark_type %in% c("bar", "rect") && is.null(aes_pairs[["y"]])) {
      # Same reasoning as the y_range branch's "rect" case above, just
      # transposed: a vertical full-height band instead of horizontal. Not
      # just "rect": a `mark: "bar"` with a position range but genuinely no
      # y at all (e.g. a bin-only encoding channel, no aggregate anywhere --
      # transforms.R's plan_layer_data() real-binning case) means the same
      # thing here as it would for "rect" -- there's no categorical
      # position to anchor a Gantt-style thick line at (the fallback just
      # below, meant for an actual Gantt chart, which always has one).
      shrunk <- shrink_range(aes_pairs[["xmin"]], aes_pairs[["xmax"]])
      aes_pairs[["xmin"]] <- shrunk$min
      aes_pairs[["xmax"]] <- shrunk$max
      fixed[["ymin"]] <- full_span[1]
      fixed[["ymax"]] <- full_span[2]
      return(paste0(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg), blank_axis_theme("y")))
    }
    if (mark_type %in% c("bar", "rect") && !is.null(aes_pairs[["y"]]) && identical(encoding$y$type, "quantitative")) {
      # A real quantitative y value alongside a binned x range (e.g. a
      # pre-binned histogram given as explicit bin_start/bin_end + count
      # columns) -- a proper zero-baseline-anchored box, not the Gantt-
      # style "thick line at a fixed height" case below (which only makes
      # sense when the companion axis is categorical, not a real value).
      # geom_rect() needs a genuinely numeric xmin/xmax -- error_bounds()
      # wraps a discrete/ordinal base channel's own range in factor() (e.g.
      # histogram_nonlinear.vl.json's own ordinal `x`/`x2` bin edges), which
      # ggplot2's own scale-type inference then sees as a *discrete* value
      # fed into what geom_rect expects to be a *continuous* one ("Discrete
      # value supplied to a continuous scale") -- `as.numeric()` reads the
      # factor's own 1-based position (matching the identical as.numeric()
      # conversion the y_range branch's own "real discrete x position" case
      # above already relies on for the same reason).
      if (identical(encoding$x$type, "ordinal") || identical(encoding$x$type, "nominal")) {
        aes_pairs[["xmin"]] <- sprintf("as.numeric(%s)", aes_pairs[["xmin"]])
        aes_pairs[["xmax"]] <- sprintf("as.numeric(%s)", aes_pairs[["xmax"]])
      }
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
      is.null(x_range) && is.null(y_range) && !isTRUE(plan$use_histogram) && is.null(fixed[["stat"]]) &&
      (identical(mark_props[["orient"]], "vertical") || identical(encoding[["x"]][["type"]], "temporal"))) {
    # A bar/rect mark with only a position (x) channel and no value (y)
    # axis at all, and no x2/y2 range either (e.g. a vertical highlight
    # band marking specific x positions, like a null-data day) -- this is
    # not the "1D dot plot" the generic fallback just below treats every
    # other 1-axis mark as (a bar/rect has no meaningful "categorical
    # placeholder position", only ever a real value to size against), and
    # there's no value to size a box against either -- a full plot-height
    # band at that x position instead. Width is derived from the smallest
    # gap between this layer's own sorted x values (falling back to a
    # fixed guess when there's only one), since there's no bin/band width
    # to read off the (continuous) x scale. Triggers when `mark.orient`
    # *explicitly* conflicts with the one channel given (e.g.
    # bar_1d_dimension_only.vl.json's own y-only mirror of this, `orient:
    # "horizontal"`, just below) -- that's Vega-Lite's own signal that this
    # channel is deliberately playing the discrete/category role, not a
    # value -- OR when the one channel given is TEMPORAL (e.g.
    # layer_null_data.vl.json's own `x: {timeUnit: "yearmonthdate", field:
    # "a", type: "temporal", bandPosition: 0}`, no `orient` override at
    # all): a date is never a plausible zero-baseline magnitude regardless
    # of what `orient` says (`pmin(0, <a Date>)`/`pmax(0, ...)` -- the
    # fallback further below's own zero-baseline formula -- mixes a Date
    # with a raw epoch-day number, silently spanning from 1970 out to the
    # real date instead of a narrow one-day band). Every other spec shape
    # reaching this point (no orient override, a genuinely non-temporal
    # channel) is a real, un-aggregated magnitude instead (facet_bullet.vl
    # .json's own `ranges[N]`/`measures[N]` fields, e.g.) and gets the
    # zero-baseline treatment in the plain fallback further below
    # regardless of whether that magnitude came from an inline VL
    # `aggregate` or not.
    x_expr <- aes_pairs[["x"]]
    half_width_expr <- sprintf(
      "(function(.v) { .u <- sort(unique(as.numeric(.v))); if (length(.u) > 1) min(diff(.u)) / 2 * 0.9 else 0.45 })(%s)",
      x_expr
    )
    aes_pairs[["xmin"]] <- sprintf("(%s) - (%s)", x_expr, half_width_expr)
    aes_pairs[["xmax"]] <- sprintf("(%s) + (%s)", x_expr, half_width_expr)
    aes_pairs[["x"]] <- NULL
    fixed[["ymin"]] <- full_span[1]
    fixed[["ymax"]] <- full_span[2]
    return(paste0(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg), blank_axis_theme("y")))
  }
  # Mirrors the x-present/y-absent branch just above, transposed: a bare
  # y position with no x at all and an explicit `orient: "horizontal"`
  # conflict (or a temporal y, same reasoning as the x-side's own
  # `type == "temporal"` check) -- e.g. `bar_1d_dimension_only`, a
  # `y`-only "horizontal" bar mark with a plain (non-aggregate) field.
  if (mark_type %in% c("bar", "rect") && !is.null(aes_pairs[["y"]]) && is.null(aes_pairs[["x"]]) &&
      is.null(x_range) && is.null(y_range) && !isTRUE(plan$use_histogram) && is.null(fixed[["stat"]]) &&
      (identical(mark_props[["orient"]], "horizontal") || identical(encoding[["y"]][["type"]], "temporal"))) {
    y_expr <- aes_pairs[["y"]]
    half_width_expr <- sprintf(
      "(function(.v) { .u <- sort(unique(as.numeric(.v))); if (length(.u) > 1) min(diff(.u)) / 2 * 0.9 else 0.45 })(%s)",
      y_expr
    )
    aes_pairs[["ymin"]] <- sprintf("(%s) - (%s)", y_expr, half_width_expr)
    aes_pairs[["ymax"]] <- sprintf("(%s) + (%s)", y_expr, half_width_expr)
    aes_pairs[["y"]] <- NULL
    fixed[["xmin"]] <- full_span[1]
    fixed[["xmax"]] <- full_span[2]
    return(paste0(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg), blank_axis_theme("x")))
  }
  if (mark_type %in% c("bar", "rect") && !is.null(aes_pairs[["x"]]) && is.null(aes_pairs[["y"]]) &&
      is.null(x_range) && is.null(y_range) && !isTRUE(plan$use_histogram) && is.null(fixed[["stat"]])) {
    # A quantitative x with no y at all and no conflicting `orient` (e.g.
    # `x: {"aggregate": "sum", ...}` with no groupby, or
    # facet_bullet.vl.json's own plain un-aggregated `ranges[N]`) --
    # Vega-Lite draws a single zero-baseline bar here (0 to the value), the
    # same convention vl2d3 uses for this shape, filling the companion axis
    # the same standalone-aware way as the reference-band case above.
    x_expr <- aes_pairs[["x"]]
    aes_pairs[["xmin"]] <- sprintf("pmin(0, %s)", x_expr)
    aes_pairs[["xmax"]] <- sprintf("pmax(0, %s)", x_expr)
    aes_pairs[["x"]] <- NULL
    fixed[["ymin"]] <- full_span[1]
    fixed[["ymax"]] <- full_span[2]
    return(paste0(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg), blank_axis_theme("y")))
  }
  if (mark_type %in% c("bar", "rect") && !is.null(aes_pairs[["y"]]) && is.null(aes_pairs[["x"]]) &&
      is.null(x_range) && is.null(y_range) && !isTRUE(plan$use_histogram) && is.null(fixed[["stat"]])) {
    y_expr <- aes_pairs[["y"]]
    aes_pairs[["ymin"]] <- sprintf("pmin(0, %s)", y_expr)
    aes_pairs[["ymax"]] <- sprintf("pmax(0, %s)", y_expr)
    aes_pairs[["y"]] <- NULL
    fixed[["xmin"]] <- full_span[1]
    fixed[["xmax"]] <- full_span[2]
    return(paste0(build_call("ggplot2::geom_rect", aes_pairs, fixed, data_arg), blank_axis_theme("x")))
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
  synthesized_axes <- character(0)
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
      synthesized_axes <- c("x", "y")
    } else if (is.null(aes_pairs[["x"]]) && is.null(fixed[["x"]])) {
      aes_pairs[["x"]] <- '""'
      synthesized_axes <- "x"
    } else if (is.null(aes_pairs[["y"]]) && is.null(fixed[["y"]])) {
      aes_pairs[["y"]] <- '""'
      synthesized_axes <- "y"
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
  # value axis) rather than relying on ggplot2 to guess right. Also fires
  # when y has no declared/inferred type at all (e.g.
  # concat_population_pyramid.vl.json's own `y: {field: "age"}`, no
  # "type") -- Vega-Lite's own bar-orientation rule is really "whichever
  # position channel is quantitative is the value axis, the other is the
  # category axis regardless of its own type", so a confirmed-quantitative
  # x already settles this even when y's type is unknown.
  if (mark_type == "bar" && is.null(fixed[["orientation"]]) &&
      identical(encoding$x$type, "quantitative") && !is.null(encoding$y) && !identical(encoding$y$type, "quantitative")) {
    fixed[["orientation"]] <- '"y"'
  }
  # The heuristic just above can't tell which axis is really the value one
  # at all when BOTH x and y are quantitative (bar_qq_stack_horizontal.vl
  # .json's own shape -- neither side of its own `!identical(...,
  # "quantitative")` check is ever true) -- an explicit `mark.orient`
  # always settles this instead (already the deciding factor for the two
  # `is.null(x)`/`is.null(y)` 1D cases above; extended here to the
  # "both quantitative" 2D case too), since ggplot2's own default geom_col
  # orientation ("x") would otherwise always win regardless of what the
  # spec's own explicit `orient: "horizontal"` said -- confirmed live:
  # without this, x/y stayed mapped to the wrong (swapped) roles entirely,
  # not just the wrong orientation.
  if (mark_type == "bar" && is.null(fixed[["orientation"]]) &&
      identical(encoding$x$type, "quantitative") && identical(encoding$y$type, "quantitative")) {
    if (identical(mark_props[["orient"]], "horizontal")) {
      fixed[["orientation"]] <- '"y"'
    } else if (identical(mark_props[["orient"]], "vertical")) {
      fixed[["orientation"]] <- '"x"'
    }
  }
  # Both x and y quantitative (the same shape just above) also needs an
  # explicit `width` override -- absent one, ggplot2's own default for a
  # continuous position axis (`0.9 * resolution(x)`, the smallest gap
  # between any two distinct x values) spans most of the way to the
  # NEXT bar (confirmed live: bar_qq_stack.vl.json's own two categories 4
  # apart came out 3.6 data-units wide, visibly touching/crowding its
  # neighbor) -- real Vega-Lite instead uses a small FIXED pixel width
  # (`config.bar.continuousBandSize`, 5px) regardless of the data-space
  # gap, which ggplot2 has no direct equivalent for (its own `width` is
  # always in DATA units, not pixels) -- approximated here as a small
  # FRACTION of that same nearest-neighbor gap (already computed the
  # identical way for the 1D-dimension-only case above) instead of
  # ggplot2's own much wider 90% default, close enough to read as a
  # deliberately narrow, non-touching bar without needing real pixel
  # geometry.
  if (mark_type == "bar" && identical(encoding$x$type, "quantitative") && identical(encoding$y$type, "quantitative") &&
      is.null(fixed[["width"]])) {
    # `data_arg` is NULL for the common single-layer case (the geom just
    # inherits the top-level `ggplot(chart_data)` call's own data instead
    # of repeating `data = chart_data` on itself) -- the real data
    # variable name is still available as `extent_data_var` even then.
    width_data_ref <- data_arg %||% extent_data_var
    cat_field <- if (identical(fixed[["orientation"]], '"y"')) encoding$y$field else encoding$x$field
    if (!is.null(cat_field) && !is.null(width_data_ref)) {
      fixed[["width"]] <- sprintf(
        "(function(.v) { .u <- sort(unique(as.numeric(.v))); if (length(.u) > 1) min(diff(.u)) * 0.15 else 0.5 })(%s[[%s]])",
        width_data_ref, deparse(cat_field)
      )
    }
  }
  # `stack: "normalize"` on the aggregated value axis asks for each
  # x-category's (or y-category's, for a horizontal bar) stacked values to
  # be rescaled to fractions summing to 1 -- ggplot2's own equivalent is
  # `position = "fill"` (its default stacking, `position = "stack"`, is
  # already what a plain color/fill-grouped area/bar gets with no
  # `position` set at all, so only the normalized case needs calling out
  # here). `stack: "center"` (a streamgraph-style baseline) has no
  # off-the-shelf ggplot2 position and is left unhandled.
  if (mark_type %in% c("area", "bar") &&
      identical(encoding$x$stack %||% encoding$y$stack, "normalize")) {
    fixed[["position"]] <- fixed[["position"]] %||% '"fill"'
  }
  fn <- if (isTRUE(plan$use_histogram)) "ggplot2::geom_histogram" else geom_function_name(mark_type, mark_props, has_y = !is.null(aes_pairs[["y"]]), ignore_unsupported, .notes)
  main_call <- build_call(fn, aes_pairs, fixed, data_arg)
  # A synthesized constant `""` position (just above, the 1D-strip
  # fallback) has no real data-driven meaning at all -- left un-hidden,
  # a genuinely standalone view (rect_mosaic_labelled_with_offset.vl
  # .json's own top text-label strip, a bare `mark: "text"` with only an
  # `x` encoding) drew its own fabricated axis's full default chrome
  # (panel background, gridlines, tick marks, an empty-string axis
  # title) -- reading as an entire second, empty chart floating above
  # the real one instead of a compact label row. Mirrors the identical
  # `blank_axis_theme()` treatment the bar/rect zero-baseline branches
  # above already apply for the same reason; only fires when this view
  # is genuinely standalone (blank_axis_theme()'s own guard), never for
  # a layer child sharing scale with real sibling data.
  for (axis in synthesized_axes) main_call <- paste0(main_call, blank_axis_theme(axis))
  # `mark.line`/`mark.point` (e.g. area_overlay.vl.json's own `{"type":
  # "area", "line": true, "point": true}`) overlay the area's own top edge
  # with a stroked line and/or a marker per data point -- ggplot2 has no
  # single-geom equivalent (unlike vl2d3, which draws these by hand off the
  # same coordinates), but layering separate geom_line()/geom_point() calls
  # on top of the same geom_area(), reusing its own x/y aes, achieves the
  # identical visual. Only the plain (non-ranged) area shape is handled --
  # a ranged area's own `ymin`/`ymax` aes has no single obvious "top edge"
  # `y` to reuse, so that case is left as area-only (an accepted, narrower
  # gap rather than guessing which bound the overlay means).
  #
  # `mark.point` on a plain LINE mark (e.g. layer_overlay.vl.json's own
  # top-level `config: {line: {point: true}}`, applied to every line mark
  # via apply_config_mark_defaults()) is the identical composite-mark
  # idiom, minus the "line" half (a line mark drawing ANOTHER geom_line()
  # overlay on top of its own already-drawn line would just double it) --
  # `mark_props[["line"]]` is stripped before reusing the same helper here
  # so only the point marker gets added.
  extra_layers <- if (mark_type %in% c("area", "line") && !is.null(aes_pairs[["y"]])) {
    overlay_props <- if (mark_type == "line") {
      mp <- mark_props
      mp[["line"]] <- NULL
      mp
    } else {
      mark_props
    }
    build_area_overlay_layers(aes_pairs, aes_pairs[["y"]], overlay_props, data_arg, fixed)
  } else {
    character(0)
  }
  if (length(extra_layers) == 0) return(main_call)
  paste(c(main_call, extra_layers), collapse = " +\n  ")
}

# A "tick" mark (e.g. tick_strip.vl.json) draws a short dash per row, not
# a dot -- geom_function_name()'s own default ("tick" -> geom_point()) only
# ever drew a marker at the exact point, never an actual tick shape (this
# project's own equivalent gap to vl2d3's pre-fix renderTick() bug, which
# at least drew *something* dash-shaped, just in the wrong orientation).
# Mirrors vl2d3's own renderTick() (marks.js): a genuinely 1D strip (only
# one of x/y has a real field) maps directly onto ggplot2's own built-in
# equivalent, geom_rug(); a 2D strip (both x and y have fields) draws a
# short geom_segment() *perpendicular* to whichever channel is the
# continuous "value" axis, spanning within its companion axis's own
# discrete band -- vertical (pinned x, dash spans y) by default, flipping
# to horizontal only when y is the continuous channel and x is the
# discrete one.
render_tick_layer <- function(encoding, aes_pairs, fixed, mark_props, data_arg, ignore_unsupported = FALSE, .notes = NULL) {
  has_x <- !is.null(aes_pairs[["x"]]) && nzchar(aes_pairs[["x"]])
  has_y <- !is.null(aes_pairs[["y"]]) && nzchar(aes_pairs[["y"]])
  if (!has_x && !has_y) {
    # A blank-but-present x/y (e.g. parallel_coordinate.vl.json's own
    # repeat-of-layers construction, whose innermost tick layer has an
    # entirely empty `encoding: {}` of its own -- some part of that
    # construct's own encoding inheritance leaves both x and y resolving to
    # "" rather than a real expression or genuinely absent) has nothing
    # meaningful for either the geom_rug() or geom_segment() case below to
    # draw -- falls back to the plain geom_point() rendering every other
    # mark type (and this one, before this whole function existed) already
    # tolerates a not-fully-resolved position from, rather than a hard
    # "missing aesthetics" error.
    return(build_call("ggplot2::geom_point", aes_pairs, fixed, data_arg))
  }

  # mark_fixed_params() already converted a `size` mark prop as though this
  # were a point-marker's own *area* (vl_point_size_to_ggplot()) -- meaningless
  # for a tick's line-segment shape, so that (and point's own border-width
  # aesthetic, "stroke") are dropped/renamed here; any real thickness comes
  # through as geom_segment()/geom_rug()'s own "linewidth" instead.
  fixed[["size"]] <- NULL
  if (!is.null(fixed[["stroke"]])) {
    fixed[["linewidth"]] <- fixed[["stroke"]]
    fixed[["stroke"]] <- NULL
  }

  if (has_x && !has_y) {
    rug_aes <- aes_pairs[intersect(c("x", "colour"), names(aes_pairs))]
    return(build_call("ggplot2::geom_rug", rug_aes, merge_named(fixed, list(sides = '"b"')), data_arg))
  }
  if (has_y && !has_x) {
    rug_aes <- aes_pairs[intersect(c("y", "colour"), names(aes_pairs))]
    return(build_call("ggplot2::geom_rug", rug_aes, merge_named(fixed, list(sides = '"l"')), data_arg))
  }

  x_continuous <- identical(encoding$x$type, "quantitative") || identical(encoding$x$type, "temporal")
  y_continuous <- identical(encoding$y$type, "quantitative") || identical(encoding$y$type, "temporal")
  horizontal <- y_continuous && !x_continuous

  # Vega-Lite's own `config.tick.bandSize` default (20px) sized against the
  # discrete companion axis's own unit band -- mirrors the identical
  # mark.size-based half-width convention the bar/rect "real discrete x
  # position" case (above) already uses for the same reason.
  size_value <- mark_scalar_value(mark_props[["size"]] %||% 20, "20", ignore_unsupported, .notes)
  half_width_expr <- sprintf("0.45 * (%s) / 20", size_value)

  seg_aes <- aes_pairs[intersect(c("colour"), names(aes_pairs))]
  # A bare geom_blank() layer mapping the discrete companion channel to its
  # own real (factor-wrapped, when ordinal/nominal) field, alongside the
  # geom_segment() below computing that same channel's position as plain
  # arithmetic (`as.numeric(<factor>) +/- half`) -- geom_segment() alone,
  # with no other layer in the chart ever mapping the raw factor itself,
  # gives ggplot2 nothing to train a genuinely *discrete* scale from, so
  # the axis silently falls back to each level's own bare integer code
  # (1, 2, 3, ...) instead of its real label (e.g. tick_strip.vl.json's
  # own Cylinders values, 3/4/5/6/8) -- geom_blank() draws nothing itself,
  # existing only to give the scale a real discrete value to train against
  # (the same trick bar_layered_weather.vl.json's own analogous xmin/xmax
  # convention gets "for free" from its shared plot-level `aes(x =
  # factor(id))`, which a standalone tick mark has no equivalent of).
  if (horizontal) {
    x_expr <- sprintf("as.numeric(%s)", aes_pairs[["x"]])
    seg_aes[["x"]] <- sprintf("(%s) - (%s)", x_expr, half_width_expr)
    seg_aes[["xend"]] <- sprintf("(%s) + (%s)", x_expr, half_width_expr)
    seg_aes[["y"]] <- aes_pairs[["y"]]
    seg_aes[["yend"]] <- aes_pairs[["y"]]
    blank_layer <- build_call("ggplot2::geom_blank", list(x = aes_pairs[["x"]]), list(), data_arg)
  } else {
    y_expr <- sprintf("as.numeric(%s)", aes_pairs[["y"]])
    seg_aes[["y"]] <- sprintf("(%s) - (%s)", y_expr, half_width_expr)
    seg_aes[["yend"]] <- sprintf("(%s) + (%s)", y_expr, half_width_expr)
    seg_aes[["x"]] <- aes_pairs[["x"]]
    seg_aes[["xend"]] <- aes_pairs[["x"]]
    blank_layer <- build_call("ggplot2::geom_blank", list(y = aes_pairs[["y"]]), list(), data_arg)
  }
  main_call <- build_call("ggplot2::geom_segment", seg_aes, fixed, data_arg)
  paste(c(blank_layer, main_call), collapse = " +\n  ")
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
