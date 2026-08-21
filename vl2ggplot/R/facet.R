# Vega-Lite's facet operator/channels map directly onto ggplot2's own
# facet_wrap()/facet_grid() -- unlike vl2d3 (no small-multiples primitive at
# all in D3), this is a close, native match. Uses the shared format_call()
# helper defined in data.R.

# `facet_def` is either a top-level facet operator's `facet` value
# ({"field":...} or {"row":..., "column":...}) or the encoding-level
# facet/row/column channel(s), normalized to the same shape by the caller.
render_facet_call <- function(facet_def, columns = NULL) {
  # Exact (not partial) name matches: `$`/`[[` on a list would otherwise
  # silently partial-match e.g. a FacetFieldDef's own "columns" (a wrap
  # count, an integer) as if it were "column" (a FacetMapping sub-field, an
  # object) -- a real bug this project hit once already.
  # Exact key presence isn't enough on its own: extract_facet_channels()
  # always builds a `list(row = ..., column = ...)` shape even when only
  # one side is used, and list(a = NULL) still has a "a" name with a NULL
  # value -- so this also needs an explicit not-null check.
  names_here <- names(facet_def)
  has_row <- "row" %in% names_here && !is.null(facet_def[["row"]])
  has_column <- "column" %in% names_here && !is.null(facet_def[["column"]])

  if (has_row || has_column) {
    args <- character(0)
    if (has_row) args <- c(args, sprintf("rows = dplyr::vars(%s)", field_ref(facet_def[["row"]][["field"]])))
    if (has_column) args <- c(args, sprintf("cols = dplyr::vars(%s)", field_ref(facet_def[["column"]][["field"]])))
    return(format_call("ggplot2::facet_grid", args))
  }

  args <- sprintf("facets = dplyr::vars(%s)", field_ref(facet_def[["field"]]))
  ncol_value <- if (!is.null(columns)) columns else facet_def[["columns"]]
  if (!is.null(ncol_value)) args <- c(args, sprintf("ncol = %s", format_value(ncol_value)))
  format_call("ggplot2::facet_wrap", args)
}
