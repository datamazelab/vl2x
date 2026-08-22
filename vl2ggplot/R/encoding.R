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
build_layer_channels <- function(encoding, mark_type, ignore_unsupported = FALSE, .notes = NULL) {
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
      aes_pairs[[aes_name]] <- discrete_field_ref(def)
    } else if (!is.null(def$value)) {
      fixed[[aes_name]] <- format_value(def$value)
    } else if (!is.null(def$datum)) {
      fixed[[aes_name]] <- literal_datum_value(def$datum, ignore_unsupported, .notes)
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
  format_value(datum)
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
    return(sprintf("factor(%s, levels = %s)", ref, format_value(def$sort)))
  }
  sprintf("factor(%s)", ref)
}

render_aes_call <- function(aes_pairs) {
  if (length(aes_pairs) == 0) return(NULL)
  parts <- vapply(names(aes_pairs), function(n) paste0(n, " = ", aes_pairs[[n]]), character(1))
  format_call("ggplot2::aes", parts)
}
