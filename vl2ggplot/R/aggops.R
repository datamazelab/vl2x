# Map a Vega-Lite aggregate op name to (a) an R expression computing it over
# a column, for use inside dplyr::summarise(), and (b) where possible, a
# plain function-name string ggplot2's stat_summary(fun = ...) can call
# directly. Only the common statistical ops are supported (plus argmin/
# argmax, a row *lookup* rather than a scalar reduction -- see below);
# percentile/selection ops with no direct base-R equivalent (ci0/ci1) throw
# a clear error at translate time rather than silently emitting wrong
# numbers.

.agg_summarise <- list(
  count = function(field) "dplyr::n()",
  # argmax/argmin store the *whole matching row* (every other column, not
  # just `field`), because Vega-Lite lets a later `field` reference index
  # into it (e.g. `argmax_Sales['Profit']`). `dplyr::pick(everything())`
  # inside summarise() sees the group's pre-summarise rows; `as.list()`
  # turns the one selected row into a plain named list so a later
  # `flatten_bracket_fields()` mutate can pull an arbitrary column out of it
  # with `[[...]]` (see translator.R).
  argmax = function(field) sprintf("list(as.list(dplyr::slice_max(dplyr::pick(dplyr::everything()), %s, n = 1, with_ties = FALSE)))", field),
  argmin = function(field) sprintf("list(as.list(dplyr::slice_min(dplyr::pick(dplyr::everything()), %s, n = 1, with_ties = FALSE)))", field),
  sum = function(field) sprintf("sum(%s, na.rm = TRUE)", field),
  mean = function(field) sprintf("mean(%s, na.rm = TRUE)", field),
  average = function(field) sprintf("mean(%s, na.rm = TRUE)", field),
  median = function(field) sprintf("median(%s, na.rm = TRUE)", field),
  min = function(field) sprintf("min(%s, na.rm = TRUE)", field),
  max = function(field) sprintf("max(%s, na.rm = TRUE)", field),
  variance = function(field) sprintf("var(%s, na.rm = TRUE)", field),
  variancep = function(field) sprintf("var(%s, na.rm = TRUE)", field),
  stdev = function(field) sprintf("sd(%s, na.rm = TRUE)", field),
  stdevp = function(field) sprintf("sd(%s, na.rm = TRUE)", field),
  distinct = function(field) sprintf("dplyr::n_distinct(%s)", field),
  valid = function(field) sprintf("sum(!is.na(%s))", field),
  missing = function(field) sprintf("sum(is.na(%s))", field),
  q1 = function(field) sprintf("stats::quantile(%s, 0.25, na.rm = TRUE, names = FALSE)", field),
  q3 = function(field) sprintf("stats::quantile(%s, 0.75, na.rm = TRUE, names = FALSE)", field)
)

# Ops that map onto a plain base-R function name, usable directly as
# stat_summary(fun = "..."). A narrower set than .agg_summarise because
# stat_summary calls fun(x) with no extra arguments (no na.rm, etc).
.agg_stat_fun <- list(
  sum = "sum", mean = "mean", average = "mean", median = "median",
  min = "min", max = "max"
)

is_supported_aggregate_op <- function(op) op %in% names(.agg_summarise)

is_stat_summary_op <- function(op) op %in% names(.agg_stat_fun)

stat_summary_fun_name <- function(op) .agg_stat_fun[[op]]

aggregate_summarise_expr <- function(op, field, ignore_unsupported = FALSE) {
  # `op` is normally a plain string, but Vega-Lite also allows a compound
  # form for argmin/argmax (`{"argmax": "otherField"}`, selecting the row at
  # that field's max rather than reducing to a scalar) -- a structurally
  # different feature (a row *lookup*, not a summary statistic) with no
  # equivalent here; `mean` is not a meaningful stand-in for it either, so
  # this fails the same way in both modes rather than guessing.
  if (!is.character(op) || length(op) != 1) {
    stop(sprintf("Unsupported aggregate op: %s (compound argmin/argmax form not supported)", jsonlite::toJSON(op, auto_unbox = TRUE)))
  }
  fn <- .agg_summarise[[op]]
  if (is.null(fn)) {
    if (ignore_unsupported) {
      # No base-R equivalent for this op (argmin/argmax, ci0/ci1, ...) --
      # `mean` is a reasonable numeric stand-in when some summary value is
      # needed to keep the chart rendering, closer to the original than an
      # arbitrary constant.
      return(.agg_summarise[["mean"]](field))
    }
    stop(sprintf(
      "Unsupported aggregate op: \"%s\" (supported: %s)",
      op, paste(names(.agg_summarise), collapse = ", ")
    ))
  }
  fn(field)
}
