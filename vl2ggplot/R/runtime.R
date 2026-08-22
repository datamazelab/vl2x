# Shared runtime helpers for GENERATED R code -- functions substantial
# enough that re-deriving them inline in every generated script would be
# error-prone and hard to keep consistent are defined once here (as regular
# exported package functions) instead. The standalone script this package
# generates references these by name and, whenever it does, its header
# includes `library(vl2ggplot)` (see vegalite_to_ggplot()'s conditional
# header logic in translator.R and RUNTIME_EXPORTS below) so they resolve
# the same way whether the script runs inside this project's own pipeline
# or on its own.

# Every function name this file exports, in preference order for the
# generated header's `library(vl2ggplot)` detection -- see
# vegalite_to_ggplot() in translator.R.
RUNTIME_EXPORTS <- c("vl_truthy", "vl_pivot")

#' JS-style truthiness for a Vega-Lite string-expression filter
#'
#' A Vega-Lite `"filter": "datum.field"` expression (no comparison at all)
#' relies on JS's truthy/falsy coercion -- `0`, `""`, `null`/`undefined`, and
#' `NaN` are dropped, everything else kept. `dplyr::filter()` requires a
#' strict logical vector, so every translated string-filter expression is
#' wrapped in this at generated-code run time (a bare comparison already
#' yields a logical, which this passes through unchanged modulo NA-as-FALSE).
#' @export
vl_truthy <- function(x) {
  if (is.logical(x)) return(!is.na(x) & x)
  if (is.character(x)) return(!is.na(x) & x != "")
  !is.na(x) & x != 0
}

#' Vega-Lite `pivot` transform: rows -> columns
#'
#' For each distinct `groupby` combination, spreads the distinct values of
#' `field` out into their own columns, each holding `value` aggregated by
#' `op` (default `"sum"`, Vega-Lite's own default -- rows that share both the
#' same groupby combination *and* the same pivoted value combine under it via
#' `op` rather than the later one silently overwriting the earlier). `limit`
#' (default 0 = unlimited) keeps only the first N distinct pivoted values in
#' sorted order, matching Vega-Lite's own documented bounded-pivot behavior.
#' @export
vl_pivot <- function(data, field, value, groupby = character(0), op = "sum", limit = 0) {
  groupby <- as.character(groupby) # tolerate a plain list() (0 groupby fields) as well as a character vector
  pivot_keys <- sort(unique(data[[field]]))
  if (limit > 0) pivot_keys <- utils::head(pivot_keys, limit)
  data <- data[data[[field]] %in% pivot_keys, , drop = FALSE]
  pivot_names <- as.character(pivot_keys)

  agg_fn <- switch(op,
    sum = function(v) sum(v, na.rm = TRUE),
    mean = ,
    average = function(v) mean(v, na.rm = TRUE),
    count = function(v) length(v),
    min = function(v) min(v, na.rm = TRUE),
    max = function(v) max(v, na.rm = TRUE),
    median = function(v) stats::median(v, na.rm = TRUE),
    function(v) sum(v, na.rm = TRUE)
  )

  group_key <- if (length(groupby)) do.call(paste, c(unname(data[groupby]), sep = "\r")) else rep("", nrow(data))
  rows <- lapply(split(seq_len(nrow(data)), group_key), function(idx) {
    sub <- data[idx, , drop = FALSE]
    row <- stats::setNames(as.list(rep(NA_real_, length(pivot_keys))), pivot_names)
    for (i in seq_along(pivot_keys)) {
      vals <- sub[[value]][sub[[field]] == pivot_keys[i]]
      if (length(vals)) row[[pivot_names[i]]] <- agg_fn(vals)
    }
    for (g in groupby) row[[g]] <- sub[[g]][1]
    as.data.frame(row[c(groupby, pivot_names)], check.names = FALSE, stringsAsFactors = FALSE)
  })
  out <- do.call(rbind, rows)
  rownames(out) <- NULL
  out
}
