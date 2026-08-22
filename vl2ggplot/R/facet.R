# Vega-Lite's facet operator/channels map directly onto ggplot2's own
# facet_wrap()/facet_grid() -- unlike vl2d3 (no small-multiples primitive at
# all in D3), this is a close, native match. Uses the shared format_call()
# helper defined in data.R.

# A facet channel's own `timeUnit` (e.g. faceting by hour-of-day) is
# derived exactly like any other channel's -- inject_facet_timeunit_transforms()
# (translator.R) adds a real `{timeUnit, field, as}` transform to the
# child spec for it, under one of these fixed names, so this only needs to
# know which name to reference instead of the raw field.
.facet_row_field <- ".facet_row"
.facet_column_field <- ".facet_column"
.facet_wrap_field <- ".facet"

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

  facet_side_ref <- function(side_def, derived_name) {
    if (!is.null(side_def[["timeUnit"]])) render_name(derived_name) else field_ref(side_def[["field"]])
  }

  if (has_row || has_column) {
    args <- character(0)
    if (has_row) args <- c(args, sprintf("rows = dplyr::vars(%s)", facet_side_ref(facet_def[["row"]], .facet_row_field)))
    if (has_column) args <- c(args, sprintf("cols = dplyr::vars(%s)", facet_side_ref(facet_def[["column"]], .facet_column_field)))
    return(format_call("ggplot2::facet_grid", args))
  }

  args <- sprintf("facets = dplyr::vars(%s)", facet_side_ref(facet_def, .facet_wrap_field))
  ncol_value <- if (!is.null(columns)) columns else facet_def[["columns"]]
  if (!is.null(ncol_value)) args <- c(args, sprintf("ncol = %s", format_value(ncol_value)))
  format_call("ggplot2::facet_wrap", args)
}

# Vega-Lite implicitly derives a facet channel's own timeUnit'd bucket
# exactly the way a plain encoding channel's timeUnit gets desugared into a
# derived field -- ggplot2's facet_grid()/facet_wrap() has no equivalent
# built-in (they facet by an existing column/expression only), so this adds
# the *same* {timeUnit, field, as} transform Vega-Lite's own semantics
# imply, reusing the existing timeUnit-transform + temporal-coercion
# machinery to do the real work; render_facet_call() then references the
# derived field by its fixed name instead of the raw one.
inject_facet_timeunit_transforms <- function(child_spec, facet_def) {
  add_one <- function(spec, side_def, as_name) {
    if (is.null(side_def) || is.null(side_def[["timeUnit"]])) return(spec)
    spec$transform <- c(spec$transform, list(list(timeUnit = side_def[["timeUnit"]], field = side_def[["field"]], as = as_name)))
    spec
  }
  names_here <- names(facet_def)
  if ("row" %in% names_here && !is.null(facet_def[["row"]])) {
    child_spec <- add_one(child_spec, facet_def[["row"]], .facet_row_field)
  }
  if ("column" %in% names_here && !is.null(facet_def[["column"]])) {
    child_spec <- add_one(child_spec, facet_def[["column"]], .facet_column_field)
  }
  if (!("row" %in% names_here) && !("column" %in% names_here)) {
    child_spec <- add_one(child_spec, facet_def, .facet_wrap_field)
  }
  child_spec
}
