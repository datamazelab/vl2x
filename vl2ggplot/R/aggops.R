# Map a Vega-Lite aggregate op name to (a) an R expression computing it over
# a column, for use inside dplyr::summarise(), and (b) where possible, a
# plain function-name string ggplot2's stat_summary(fun = ...) can call
# directly. Only the common statistical ops are supported; percentile/
# selection ops with no direct base-R equivalent (argmin/argmax, ci0/ci1)
# throw a clear error at translate time rather than silently emitting wrong
# numbers.

.agg_summarise <- list(
  count = function(field) "dplyr::n()",
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

aggregate_summarise_expr <- function(op, field) {
  fn <- .agg_summarise[[op]]
  if (is.null(fn)) {
    stop(sprintf(
      "Unsupported aggregate op: \"%s\" (supported: %s)",
      op, paste(names(.agg_summarise), collapse = ", ")
    ))
  }
  fn(field)
}
