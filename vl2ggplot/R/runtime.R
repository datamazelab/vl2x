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
RUNTIME_EXPORTS <- c("vl_truthy", "vl_pivot", "vl_parse_date", "vl_parse_datetime")

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

#' Parse a Vega-Lite temporal field's raw value into a Date
#'
#' Vega-Lite (like JS) always represents a temporal field's raw numeric value
#' as epoch *milliseconds*, not days -- `as.Date()`'s own numeric form
#' expects days-since-origin, so the numeric case converts first. A
#' non-numeric (string) value tries each of `.date_try_formats`
#' (data.R) in turn, keeping the first that parses every value in the
#' vector without `NA` -- real-world data uses all sorts of date-string
#' spellings ("2000-01-01", "Jan 1 2000", "01/02/2000", ...), and this
#' covers most of them without knowing the source format in advance.
#' Defined once here (as a plain exported package function) rather than
#' re-derived inline -- via the full `if (is.numeric(...)) ... else
#' as.Date(..., tryFormats = c(...))` expression, `tryFormats` list
#' included -- at every single temporal field's own coercion site in the
#' generated script, which used to make a chart with several temporal
#' fields across several layers repeat that same multi-line, multi-format
#' expression once per field.
#' @export
vl_parse_date <- function(x) {
  if (is.numeric(x)) return(as.Date(x / 86400000, origin = "1970-01-01"))
  as.Date(as.character(x), tryFormats = .date_try_formats)
}

#' Parse a Vega-Lite temporal field's raw value into a POSIXct
#'
#' Same as vl_parse_date() above, but for a field whose time-of-day needs
#' preserving (a downstream `hours()`/`minutes()`/`seconds()` expression or
#' timeUnit) -- `as.Date()` always discards it regardless of source format.
#' @export
vl_parse_datetime <- function(x) {
  if (is.numeric(x)) return(as.POSIXct(x / 1000, origin = "1970-01-01", tz = "UTC"))
  as.POSIXct(as.character(x), tryFormats = .datetime_try_formats, tz = "UTC")
}
