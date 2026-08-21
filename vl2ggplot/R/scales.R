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
  if (identical(def$type, "temporal")) "date"
  else if (def$type %in% c("ordinal", "nominal")) "discrete"
  else "continuous"
}

# Build the scale_*() call(s) for one channel, or character(0) if the
# defaults suffice.
build_scale_calls <- function(channel, def, mark_type) {
  if (is.null(def) || is.null(def$type)) return(character(0))

  if (channel %in% c("x", "y")) return(build_position_scale(channel, def))
  if (channel == "color") return(build_color_scale(color_channel_aes(mark_type), def))
  if (channel == "size") return(build_size_scale(def))
  if (channel == "opacity") return(build_opacity_scale(def))
  character(0)
}

build_position_scale <- function(channel, def) {
  kind <- axis_kind(def)
  fn <- paste0("ggplot2::scale_", channel, "_", kind)
  args <- character(0)

  domain <- def$scale$domain
  if (!is.null(domain) && is.null(names(domain))) {
    if (kind == "date") {
      # A date-axis domain is still raw epoch-millisecond numbers here (the
      # same Vega-Lite convention as inline temporal field values) --
      # scale_*_date()'s `limits` needs real Date values instead.
      limits_expr <- sprintf(
        "c(%s)", paste(vapply(domain, function(v) sprintf('as.Date(%s / 86400000, origin = "1970-01-01")', format_value(v)), character(1)), collapse = ", ")
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
  kind <- axis_kind(def)
  scheme <- def$scale$scheme
  domain <- def$scale$domain
  range <- def$scale$range

  # An array of literal color values (e.g. ["red", "blue"]) selects a manual
  # discrete scale; a bare scheme-name string (e.g. "diverging", "ordinal")
  # is a different, scheme-keyword form of `range` -- jsonlite parses the
  # former as a list and the latter as a plain length-1 character vector, so
  # is.list() distinguishes them.
  if (!is.null(range) && is.null(names(range)) && is.list(range)) {
    args <- character(0)
    if (!is.null(domain)) args <- c(args, sprintf("breaks = %s", format_value(domain)))
    args <- c(args, sprintf("values = %s", format_value(range)))
    return(format_call(sprintf("ggplot2::scale_%s_manual", aes_name), args))
  }

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

build_size_scale <- function(def) {
  range <- def$scale$range
  if (is.null(range)) return(character(0))
  # scale_size()'s range is a 2-element continuous interval, unlike Vega-Lite's
  # discretizing scale types (quantile/quantize/threshold), whose range is a
  # list of discrete output values -- passing one through crashes scale_size().
  if (length(range) > 2 || (!is.null(def$scale$type) && def$scale$type %in% .discretizing_scale_types)) {
    stop(sprintf('Unsupported: scale type "%s" for a size channel is not yet supported', def$scale$type %||% "range"))
  }
  format_call("ggplot2::scale_size", sprintf("range = %s", format_value(range)))
}

build_opacity_scale <- function(def) {
  range <- def$scale$range
  if (is.null(range)) return(character(0))
  if (length(range) > 2 || (!is.null(def$scale$type) && def$scale$type %in% .discretizing_scale_types)) {
    stop(sprintf('Unsupported: scale type "%s" for an opacity channel is not yet supported', def$scale$type %||% "range"))
  }
  format_call("ggplot2::scale_alpha", sprintf("range = %s", format_value(range)))
}
