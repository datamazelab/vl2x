# Translate a (prepare.R-rewritten) Vega-Lite `encoding` object into ggplot2
# aes() mappings plus any fixed (non-aes) geom parameters.

# Marks whose *ggplot2 geom* (see geoms.R's geom_function_name()) actually
# has a "fill" aesthetic of its own -- not simply the marks where Vega-Lite's
# own generic "color" channel is conceptually a fill color, since several of
# those route to a ggplot2 geom with no such aesthetic at all:
#   - circle/square/tick -> geom_point()'s default (solid, unbordered) shape
#     only has "colour"; "fill" is silently ignored.
#   - text -> geom_text() has no "fill" aesthetic at all (only "colour").
#   - trail -> geom_line(), likewise colour-only.
# Routing color to "fill" for any of those left every mark that color
# through them rendering in the fixed default/black colour instead, with
# the real per-row color silently dropped (also affects a mark-level
# literal `color`/`fill`/`stroke` property, via mark_fixed_params() below,
# which uses this same routing).
.fill_marks <- c("bar", "area", "rect", "boxplot", "errorband", "arc")

color_channel_aes <- function(mark_type) if (mark_type %in% .fill_marks) "fill" else "colour"

# color_channel_aes()'s own answer, but also accounting for the runtime
# fill/stroke swap render_geom_layer_code() (geoms.R) applies to a
# point/circle/square/tick mark with `filled: true` or a mark-level
# `stroke` -- that swap moves the color encoding from "colour" onto "fill"
# for the geom_point() call itself, but apply_common()'s own scale_*() call
# (translator.R) is built entirely separately, from mark_type alone, with
# no visibility into that swap at all. Left unsynced, it kept generating a
# `scale_colour_manual()`/`scale_colour_brewer()`/etc. customizing an
# aesthetic the geom no longer actually uses (colour, cleared by the swap)
# -- silently ineffective, not an error, so easy to miss (e.g.
# isotype_bar_chart.vl.json's own `"filled": true` point mark with a
# color `scale.range`).
effective_color_aes <- function(mark_type, mark_props) {
  base <- color_channel_aes(mark_type)
  if (base == "colour" && mark_type %in% c("point", "circle", "square", "tick") &&
      (isTRUE(mark_props[["filled"]]) || !is.null(mark_props[["stroke"]]))) {
    return("fill")
  }
  base
}

# channel key -> aes() name, for channels that always map the same way
# regardless of mark type. `x2`/`y2` are deliberately excluded: their aes()
# name depends on the mark (xend/yend for a segment, ymin/ymax for a
# ribbon/errorbar), so geoms.R handles them itself per mark type.
.channel_aes_name <- c(
  x = "x", y = "y", theta = "y",
  fill = "fill", stroke = "colour", size = "size", opacity = "alpha",
  shape = "shape", detail = "group", text = "label"
)

# Record that some (possibly deeply nested) value-rendering call fell back
# to a placeholder under `ignore_unsupported` -- an out-of-band channel (an
# environment, if supplied) for the same reason as expr.R's filter_to_expr()
# `.notes`: the fallback happens many calls deep inside a single expression
# fragment (an aes()/fixed geom argument), with no way to splice an R
# comment into that expression itself, so the note is collected here and
# turned into a "# vl2ggplot: ..." comment line by the statement-level
# caller in geoms.R/translator.R instead.
.push_note <- function(notes_env, msg) {
  if (!is.null(notes_env)) notes_env$notes <- c(notes_env$notes, msg)
}

# Build the aes() mapping and fixed (outside-aes) parameters for one geom
# layer's encoding (excluding x2/y2, handled separately by geoms.R). Returns
# list(aes = list(name = expr_string), fixed = list(name = expr_string),
# sort_field = field name or NULL).
# A channel's constant `value` is normally a plain literal, but can instead
# be `{"expr": "..."}`. The common real-world shape for that expr is
# `scale('x'/'y', <inner>)` -- Vega's own idiom for converting a
# *data-space* value into the pixel space a raw mark position property
# expects (needed there because a value channel bypasses the normal
# field->scale encoding pipeline entirely). ggplot2's geom_vline()/
# geom_hline() (the only marks a bare value channel like this actually
# reaches) already expect a *data-space* value -- they apply the plot's own
# scale automatically -- so `scale(...)`'s own job is a no-op here; only
# `<inner>` is needed. `<inner>` commonly indexes into an `extent`
# transform's param array (`b_extent[0]`, 0-based) -- resolved directly at
# each reference via `extent_params` (name -> source field) rather than
# through a separately pre-declared runtime variable, sidestepping any
# redeclaration clash across sibling layer children (each of which
# independently re-runs its own copy of the same top-level transform), and
# reindexed to R's 1-based `range()[...]`.
resolve_value_channel_expr <- function(value, extent_data_var, extent_params, ignore_unsupported, .notes) {
  if (!is.list(value) || is.null(value$expr)) return(format_value(value))
  m <- regmatches(value$expr, regexec("^scale\\(\\s*['\"]([xy])['\"]\\s*,\\s*(.+)\\)$", trimws(value$expr)))[[1]]
  if (length(m) == 0) return(translate_expr(value$expr)) # not the scale(...) idiom -- best-effort generic translation
  inner <- m[3]
  if (!is.null(extent_data_var)) {
    for (pname in names(extent_params)) {
      pattern <- sprintf("\\b%s\\[(\\d+)\\]", pname)
      inner <- replace_tokens(inner, pattern, function(tok) {
        idx <- as.integer(sub(pattern, "\\1", tok, perl = TRUE))
        sprintf("range(%s[[%s]], na.rm = TRUE)[%d]", extent_data_var, render_string(extent_params[[pname]]), idx + 1)
      }, perl = TRUE)
    }
  }
  inner # already valid R once the extent-param substitution above is applied
}

build_layer_channels <- function(encoding, mark_type, ignore_unsupported = FALSE, .notes = NULL, extent_data_var = NULL, extent_params = list()) {
  aes_pairs <- list()
  fixed <- list()
  sort_field <- NULL

  for (channel in names(encoding)) {
    def <- encoding[[channel]]
    if (is.null(def) || !is.list(def)) next
    if (channel %in% c("x2", "y2", "tooltip")) next

    if (channel == "order") {
      if (!is.null(def$field)) sort_field <- def$field
      next
    }

    aes_name <- if (channel == "color") color_channel_aes(mark_type) else unname(.channel_aes_name[channel])
    if (is.na(aes_name)) next

    if (!is.null(def$field)) {
      # A disabled scale (see build_color_scale()'s matching check) pairs
      # with scale_*_identity(), which reads the aes value as the literal
      # color itself -- factor()-wrapping it first (discrete_field_ref()'s
      # usual behavior for a nominal/ordinal field) is unnecessary and
      # risks the literal value being read back off the factor's levels
      # rather than the value itself.
      aes_pairs[[aes_name]] <- if (channel == "color" && "scale" %in% names(def) && is.null(def$scale)) {
        field_ref(def$field)
      } else {
        discrete_field_ref(def)
      }
    } else if (!is.null(def$value)) {
      fixed[[aes_name]] <- resolve_value_channel_expr(def$value, extent_data_var, extent_params, ignore_unsupported, .notes)
    } else if (!is.null(def$datum)) {
      fixed[[aes_name]] <- literal_datum_value(def$datum, ignore_unsupported, .notes)
    }
  }

  # geom_line()/geom_step()/geom_area()'s default grouping is the
  # interaction of *every* discrete aesthetic, including x/y themselves --
  # Vega-Lite's own semantics instead group a line/area by its
  # color/detail/shape encoding alone, connecting across the sorted x-domain
  # regardless of whether x (or y) also happens to be discrete (e.g. an
  # ordinal axis). Without an explicit `group` override here, every distinct
  # (x, y, colour) *row* becomes its own single-point "line" whenever x or y
  # is discrete too -- nothing visibly connects, even though the data and
  # colour mapping are both otherwise correct.
  if (mark_type %in% c("line", "trail", "area") && is.null(aes_pairs[["group"]])) {
    grouping_exprs <- unlist(aes_pairs[intersect(c("colour", "fill", "shape"), names(aes_pairs))], use.names = FALSE)
    if (length(grouping_exprs) == 1) {
      aes_pairs[["group"]] <- grouping_exprs
    } else if (length(grouping_exprs) > 1) {
      aes_pairs[["group"]] <- sprintf("interaction(%s)", paste(grouping_exprs, collapse = ", "))
    } else {
      # No color/detail/shape channel at all -- a genuinely single-series
      # line/area, which still needs group forced to one constant value
      # whenever x or y is discrete (same fragmentation ggplot2's default
      # grouping causes above, just without a colour channel to have
      # otherwise supplied it). Harmless when x/y are both already
      # continuous too (ggplot2's default grouping already treats
      # everything as one group in that case, so this changes nothing).
      aes_pairs[["group"]] <- "1"
    }
  }

  list(aes = aes_pairs, fixed = fixed, sort_field = sort_field)
}

# A `datum` value is usually a plain literal (rare, typically seen with a
# repeat/facet-templated view), but Vega-Lite also allows it to be bound to
# a `param` (interactive value binding) via `{"expr": "paramName"}` -- no
# live interactivity is implemented, so that form has no static value to
# fall back on beyond a placeholder constant.
literal_datum_value <- function(datum, ignore_unsupported = FALSE, .notes = NULL) {
  if (is.list(datum) && !is.null(datum$expr)) {
    if (ignore_unsupported) {
      .push_note(.notes, "unsupported datum bound to a param/signal expression, using 0 instead (ignore_unsupported)")
      return("0")
    }
    stop("Unsupported: a datum bound to a param/signal expression has no static value")
  }
  if (is_datetime_object(datum)) return(datetime_object_to_r_date(datum))
  format_value(datum)
}

# Vega-Lite's own "DateTime object" shorthand for a literal temporal
# constant (as opposed to a plain scalar/string datum) -- e.g. `{"datum":
# {"year": 2006}}`. `format_value()`'s generic list handling would render
# this as a plain R `list(year = 2006)`, which a Date-scaled geom_vline/
# geom_hline can't use (`transform_date() works with objects of class
# <Date> only`) -- this builds a real `as.Date(...)` call instead.
is_datetime_object <- function(x) {
  is.list(x) && is.null(x$expr) &&
    any(c("year", "quarter", "month", "date", "day", "hours", "minutes", "seconds", "milliseconds") %in% names(x))
}

datetime_object_to_r_date <- function(datum) {
  year <- datum$year %||% 2012
  month <- if (!is.null(datum$quarter)) (datum$quarter - 1) * 3 + 1 else (datum$month %||% 1)
  day <- datum$date %||% 1
  # A DateTime object with any clock (hours/minutes/seconds) component
  # needs a real POSIXct, not a Date (which has no time-of-day at all) --
  # `hours: 24` (a common "end of day" domain endpoint) is also valid here
  # even though it overflows a single day's 0-23 range, exactly the way
  # `new Date(year, month, day, 24, ...)` auto-rolls over to midnight the
  # next day in JS -- as.POSIXct() with a plain numeric `seconds since
  # midnight` offset added to a real Date does the same via ordinary
  # arithmetic, rather than needing that overflow handled specially.
  has_clock <- !is.null(datum$hours) || !is.null(datum$minutes) || !is.null(datum$seconds) || !is.null(datum$milliseconds)
  if (!has_clock) {
    return(sprintf(
      'as.Date(sprintf("%%04d-%%02d-%%02d", %s, %s, %s))',
      format_value(year), format_value(month), format_value(day)
    ))
  }
  hours <- datum$hours %||% 0
  minutes <- datum$minutes %||% 0
  seconds <- datum$seconds %||% 0
  sprintf(
    'as.POSIXct(sprintf("%%04d-%%02d-%%02d", %s, %s, %s), tz = "UTC") + (%s * 3600 + %s * 60 + %s)',
    format_value(year), format_value(month), format_value(day),
    format_value(hours), format_value(minutes), format_value(seconds)
  )
}

# A channel definition can reference a `field`, a literal `value`, or (more
# rarely -- typically seen with a repeat/facet-templated view) a literal
# `datum`. Used for channels like x2/y2 that geoms.R handles outside the
# normal build_layer_channels() pass.
channel_value_expr <- function(def, ignore_unsupported = FALSE, .notes = NULL) {
  if (is.null(def)) stop("Internal: channel_value_expr() called with no definition")
  if (!is.null(def$field)) return(discrete_field_ref(def))
  if (!is.null(def$value)) return(format_value(def$value))
  if (!is.null(def$datum)) return(literal_datum_value(def$datum, ignore_unsupported, .notes))
  if (ignore_unsupported) {
    # e.g. a param-bound `{"expr": "..."}` value with no static equivalent
    .push_note(.notes, "unsupported channel value (bound to a param/signal expression with no field/value/datum), using 0 instead (ignore_unsupported)")
    return("0")
  }
  stop("Unsupported: channel has none of field/value/datum")
}

# A Vega-Lite field is nominal/ordinal regardless of its *stored* JSON
# value type (e.g. integer category codes are still nominal) -- ggplot2
# instead decides continuous-vs-discrete from the column's R type, so an
# explicitly nominal/ordinal field must be wrapped in factor() to force
# discrete treatment even when the underlying data happens to be numeric.
discrete_field_ref <- function(def) {
  ref <- field_ref(def$field)
  if (!identical(def$type, "ordinal") && !identical(def$type, "nominal")) return(ref)
  if (is.list(def$sort) && is.null(names(def$sort))) {
    # An explicit sort array may be *partial* -- Vega-Lite still shows
    # every distinct value, appending whichever ones aren't named (in
    # their own default/ascending order) after the named ones, rather than
    # dropping them. `levels = <sort list>` alone would instead turn any
    # value not in that list into NA (factor()'s own behavior for a level
    # it was never told about), and ggplot2 silently drops NA rows -- so
    # this unions in the data's own remaining distinct values at runtime
    # (unknowable at code-generation time) rather than trusting the list
    # to already be complete.
    return(sprintf("factor(%s, levels = union(%s, sort(unique(%s))))", ref, format_value(def$sort), ref))
  }
  sprintf("factor(%s)", ref)
}

render_aes_call <- function(aes_pairs) {
  if (length(aes_pairs) == 0) return(NULL)
  parts <- vapply(names(aes_pairs), function(n) paste0(n, " = ", aes_pairs[[n]]), character(1))
  format_call("ggplot2::aes", parts)
}
