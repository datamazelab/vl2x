# Emit an explicit scale_*() call only when there's something to
# customize (an explicit domain/range/scheme/sort order) -- ggplot2's own
# defaults (computed automatically from all layers' data) are otherwise
# used as-is, so most charts need no scale_*() call at all.

.viridis_schemes <- c("viridis", "inferno", "magma", "plasma", "cividis", "turbo")
.brewer_schemes <- c(
  "blues", "greens", "greys", "oranges", "purples", "reds",
  "category10", "tableau10", "set1", "set2", "set3", "dark2", "paired", "accent"
)

axis_kind <- function(def) {
  if (identical(def$type, "temporal")) {
    if (isTRUE(def[[".posixct"]])) "datetime" else "date"
  }
  else if (def$type %in% c("ordinal", "nominal")) "discrete"
  else "continuous"
}

# Build the scale_*() call(s) for one channel, or character(0) if the
# defaults suffice.
build_scale_calls <- function(channel, def, mark_type, ignore_unsupported = FALSE, .notes = NULL) {
  if (is.null(def)) return(character(0))
  # A color field commonly has no explicit "type" at all (Vega-Lite infers
  # it from the data instead, e.g. a plain string-valued field defaults to
  # "nominal") -- unlike x/y/size/opacity, build_color_scale() below copes
  # with that itself (an explicit `scale.range` array is discrete-only
  # regardless of type, so it doesn't even need to know), so it mustn't be
  # screened out here the same way a missing type silently drops every
  # other channel's customization.
  if (channel != "color" && is.null(def$type)) return(character(0))

  if (channel %in% c("x", "y")) return(build_position_scale(channel, def))
  if (channel == "color") return(build_color_scale(color_channel_aes(mark_type), def))
  if (channel == "size") return(build_size_scale(def, ignore_unsupported, .notes))
  if (channel == "opacity") return(build_opacity_scale(def, ignore_unsupported, .notes))
  character(0)
}

build_position_scale <- function(channel, def) {
  kind <- axis_kind(def)
  fn <- paste0("ggplot2::scale_", channel, "_", kind)
  args <- character(0)

  domain <- def$scale[["domain"]]
  if (!is.null(domain) && is.null(names(domain))) {
    if (kind %in% c("date", "datetime")) {
      # A date/datetime-axis domain element is usually still a raw
      # epoch-millisecond number here (the same Vega-Lite convention as
      # inline temporal field values), needing scale_*_date()/
      # scale_*_datetime()'s `limits` to be real Date/POSIXct values
      # instead -- but it can also be a DateTime-object shorthand (e.g.
      # `{"hours": 0}`), the same literal-constant shape a `datum`-bound
      # channel value already handles (literal_datum_value(), encoding.R),
      # reused here rather than re-implementing the same conversion (that
      # helper already produces a POSIXct, not a Date, for one with any
      # clock component -- consistent with a "datetime" axis either way).
      epoch_expr <- if (kind == "datetime") {
        function(v) sprintf('as.POSIXct(%s / 1000, origin = "1970-01-01", tz = "UTC")', format_value(v))
      } else {
        function(v) sprintf('as.Date(%s / 86400000, origin = "1970-01-01")', format_value(v))
      }
      limits_expr <- sprintf(
        "c(%s)", paste(vapply(domain, function(v) {
          if (is.list(v)) literal_datum_value(v) else epoch_expr(v)
        }, character(1)), collapse = ", ")
      )
      args <- c(args, sprintf("limits = %s", limits_expr))
    } else {
      args <- c(args, sprintf("limits = %s", format_value(domain)))
    }
  }
  if (kind == "discrete") {
    if (!is.null(def$sort) && identical(def$sort, "descending")) {
      args <- c(args, "limits = rev")
    } else if (is.list(def$sort) && is.null(names(def$sort))) {
      args <- c(args, sprintf("limits = %s", format_value(def$sort)))
    }
  }
  if (isTRUE(def$scale$reverse)) args <- c(args, if (kind == "discrete") "limits = rev" else "trans = \"reverse\"")

  if (length(args) == 0) return(character(0))
  format_call(fn, args)
}

build_color_scale <- function(aes_name, def) {
  # `"scale": null` is Vega-Lite's own "use the raw field value directly as
  # the visual channel value, no mapping at all" escape hatch (e.g. a
  # `color` field that already holds real CSS color strings) -- distinct
  # from the (far more common) case of no `scale` key at all, which still
  # wants ggplot2's own default discrete/continuous palette. Checking
  # `is.null(def$scale)` alone can't tell those apart (both are NULL), so
  # this also requires the key to actually be present.
  if ("scale" %in% names(def) && is.null(def$scale)) {
    return(format_call(sprintf("ggplot2::scale_%s_identity", aes_name), character(0)))
  }
  scheme <- def$scale$scheme
  domain <- def$scale[["domain"]]
  range <- def$scale[["range"]]

  # An array of literal color values (e.g. ["red", "blue"]) selects a manual
  # discrete scale; a bare scheme-name string (e.g. "diverging", "ordinal")
  # is a different, scheme-keyword form of `range` -- jsonlite parses the
  # former as a list and the latter as a plain length-1 character vector, so
  # is.list() distinguishes them. Checked before axis_kind() below (which
  # needs def$type) since a manual color list is discrete regardless of
  # type, and a color field commonly has no explicit type at all.
  if (!is.null(range) && is.null(names(range)) && is.list(range)) {
    args <- character(0)
    # A plain array is a literal, ordered list of domain values -- but
    # Vega-Lite also allows a domain *object* here (e.g. `{"unionWith":
    # [...]}`, unioning the auto-inferred domain with a few extra explicit
    # values), which format_value() would otherwise happily (and wrongly)
    # serialize as an R list -- `breaks = list(unionWith = c(...))` isn't a
    # valid vector of factor levels, so scale_fill_manual() silently maps
    # every value to NA instead of a real color. Skipped instead: ggplot2's
    # own auto-inferred breaks (the data's actual factor levels) still line
    # up positionally against `values` below in the common case where the
    # union target(s) already occur in the data (e.g. this file's own
    # `unionWith: [5, 6]`, already within category's 1-6 domain) -- only a
    # union value that *never* actually appears in the data would be
    # silently dropped, same as any other domain-object shape this project
    # doesn't attempt to reproduce exactly (see build_position_scale's
    # identical `is.null(names(domain))` guard).
    if (!is.null(domain) && is.null(names(domain))) args <- c(args, sprintf("breaks = %s", format_value(domain)))
    args <- c(args, sprintf("values = %s", format_value(range)))
    return(format_call(sprintf("ggplot2::scale_%s_manual", aes_name), args))
  }

  # Every other customization below (a scheme keyword, or a domain with no
  # explicit range) does need to know discrete-vs-continuous -- an untyped
  # field falls back to "discrete", matching Vega-Lite's own inference for
  # a bare string-valued field (a genuinely continuous field almost always
  # carries an explicit "quantitative"/"temporal" type already, since
  # ggplot2 itself needs one for the geom's own aes()).
  kind <- if (is.null(def$type)) "discrete" else axis_kind(def)

  if (kind == "continuous" || kind == "date") {
    if (!is.null(scheme) && scheme %in% .viridis_schemes) {
      return(format_call(sprintf("ggplot2::scale_%s_viridis_c", aes_name), sprintf('option = "%s"', scheme)))
    }
    return(character(0))
  }

  # discrete color
  if (!is.null(scheme) && scheme %in% .viridis_schemes) {
    return(format_call(sprintf("ggplot2::scale_%s_viridis_d", aes_name), sprintf('option = "%s"', scheme)))
  }
  if (!is.null(scheme) && scheme %in% .brewer_schemes) {
    return(format_call(sprintf("ggplot2::scale_%s_brewer", aes_name), sprintf('palette = "%s"', scheme)))
  }
  character(0)
}

.discretizing_scale_types <- c("quantile", "quantize", "threshold")

build_size_scale <- function(def, ignore_unsupported = FALSE, .notes = NULL) {
  range <- def$scale[["range"]]
  if (is.null(range)) return(character(0))
  # scale_size()'s range is a 2-element continuous interval, unlike Vega-Lite's
  # discretizing scale types (quantile/quantize/threshold), whose range is a
  # list of discrete output values -- passing one through crashes scale_size().
  if (length(range) > 2 || (!is.null(def$scale$type) && def$scale$type %in% .discretizing_scale_types)) {
    # No custom scale call at all -- ggplot2's own default size scale still
    # applies, just without the discrete range this spec asked for.
    if (ignore_unsupported) {
      .push_note(.notes, sprintf(
        'unsupported scale type "%s" for a size channel, using the default size scale instead (ignore_unsupported)',
        def$scale$type %||% "range"
      ))
      return(character(0))
    }
    stop(sprintf('Unsupported: scale type "%s" for a size channel is not yet supported', def$scale$type %||% "range"))
  }
  format_call("ggplot2::scale_size", sprintf("range = %s", format_value(range)))
}

build_opacity_scale <- function(def, ignore_unsupported = FALSE, .notes = NULL) {
  range <- def$scale[["range"]]
  if (is.null(range)) return(character(0))
  if (length(range) > 2 || (!is.null(def$scale$type) && def$scale$type %in% .discretizing_scale_types)) {
    if (ignore_unsupported) {
      .push_note(.notes, sprintf(
        'unsupported scale type "%s" for an opacity channel, using the default opacity scale instead (ignore_unsupported)',
        def$scale$type %||% "range"
      ))
      return(character(0))
    }
    stop(sprintf('Unsupported: scale type "%s" for an opacity channel is not yet supported', def$scale$type %||% "range"))
  }
  format_call("ggplot2::scale_alpha", sprintf("range = %s", format_value(range)))
}
