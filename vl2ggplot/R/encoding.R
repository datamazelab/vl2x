# Translate a (prepare.R-rewritten) Vega-Lite `encoding` object into ggplot2
# aes() mappings plus any fixed (non-aes) geom parameters.

# Marks where Vega-Lite's generic "color" channel means fill color by
# default (see the Vega-Lite encoding docs); everything else means stroke
# ("colour" in ggplot2's spelling).
.fill_marks <- c("bar", "area", "tick", "text", "trail", "circle", "square", "boxplot", "errorband", "arc")

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

# Build the aes() mapping and fixed (outside-aes) parameters for one geom
# layer's encoding (excluding x2/y2, handled separately by geoms.R). Returns
# list(aes = list(name = expr_string), fixed = list(name = expr_string),
# sort_field = field name or NULL).
build_layer_channels <- function(encoding, mark_type) {
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
    }
  }

  list(aes = aes_pairs, fixed = fixed, sort_field = sort_field)
}

# A channel definition can reference a `field`, a literal `value`, or (more
# rarely -- typically seen with a repeat/facet-templated view) a literal
# `datum`. Used for channels like x2/y2 that geoms.R handles outside the
# normal build_layer_channels() pass.
channel_value_expr <- function(def) {
  if (is.null(def)) stop("Internal: channel_value_expr() called with no definition")
  if (!is.null(def$field)) return(discrete_field_ref(def))
  if (!is.null(def$value)) return(format_value(def$value))
  if (!is.null(def$datum)) return(format_value(def$datum))
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
