# Map a Vega-Lite `timeUnit` name to an R expression that truncates/derives
# from a Date/POSIXct value. Deliberately uses only base R (format()/as.Date()/
# as.POSIXct()) rather than lubridate, so generated code has no extra runtime
# dependency beyond ggplot2/dplyr/scales. Assumes the field has already been
# parsed into a real Date/POSIXct (see data.R).
#
# Like vl2d3's timeunit.js, each unit is treated as producing a real
# temporal value (the start of that period) so it can be plotted on a
# continuous date axis -- a documented simplification of Vega-Lite's fuller
# (and partly ordinal) timeUnit semantics.

.timeunit_local <- list(
  year = function(d) sprintf('as.Date(format(%s, "%%Y-01-01"))', d),
  quarter = function(d) sprintf(
    'as.Date(paste0(format(%s, "%%Y-"), sprintf("%%02d", (as.integer(format(%s, "%%m")) - 1) %%/%% 3 * 3 + 1), "-01"))',
    d, d
  ),
  month = function(d) sprintf('as.Date(format(%s, "%%Y-%%m-01"))', d),
  date = function(d) sprintf('as.Date(%s)', d),
  day = function(d) sprintf('as.integer(format(%s, "%%w"))', d),
  dayofyear = function(d) sprintf('as.integer(format(%s, "%%j"))', d),
  hours = function(d) sprintf('as.POSIXct(format(%s, "%%Y-%%m-%%d %%H:00:00"), tz = "UTC")', d),
  minutes = function(d) sprintf('as.POSIXct(format(%s, "%%Y-%%m-%%d %%H:%%M:00"), tz = "UTC")', d),
  seconds = function(d) sprintf('as.POSIXct(format(%s, "%%Y-%%m-%%d %%H:%%M:%%S"), tz = "UTC")', d),
  yearmonth = function(d) sprintf('as.Date(format(%s, "%%Y-%%m-01"))', d),
  yearmonthdate = function(d) sprintf('as.Date(%s)', d),
  yearquarter = function(d) .timeunit_local$quarter(d)
)

# Strip a leading "utc" prefix -- treated the same as the local-time unit
# (a documented simplification: no timezone handling is performed).
normalize_timeunit <- function(unit) {
  name <- if (is.list(unit)) unit$unit else unit
  if (is.character(name) && startsWith(name, "utc")) substring(name, 4) else name
}

is_supported_timeunit <- function(unit) {
  key <- normalize_timeunit(unit)
  !is.null(key) && key %in% names(.timeunit_local)
}

timeunit_expr <- function(unit, date_expr) {
  key <- normalize_timeunit(unit)
  fn <- .timeunit_local[[key]]
  if (is.null(fn)) stop(sprintf('Unsupported timeUnit: "%s"', unit))
  fn(date_expr)
}
