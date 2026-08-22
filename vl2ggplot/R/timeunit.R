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
# (a documented simplification: no timezone handling is performed). A
# leading "binned" prefix (e.g. "binnedyearmonth") marks a field Vega-Lite
# expects to already contain bucket-boundary values -- applying the same
# (idempotent, for genuinely pre-binned data) bucketing function as the
# unprefixed unit is a safe, simpler stand-in for tracking bin continuity
# specially.
normalize_timeunit <- function(unit) {
  name <- if (is.list(unit)) unit$unit else unit
  if (!is.character(name)) return(name)
  # The two prefixes can appear in either order (e.g. "binnedutcyearmonthdate"
  # as well as a hypothetical "utcbinnedyearmonthdate") -- strip both,
  # repeating until neither matches, rather than only checking each once in
  # a fixed order (which would leave "binnedutc..." only half-stripped).
  repeat {
    stripped <- FALSE
    if (startsWith(name, "utc")) {
      name <- substring(name, 4)
      stripped <- TRUE
    }
    if (startsWith(name, "binned")) {
      name <- substring(name, 7)
      stripped <- TRUE
    }
    if (!stripped) break
  }
  name
}

is_supported_timeunit <- function(unit) {
  key <- normalize_timeunit(unit)
  !is.null(key) && key %in% names(.timeunit_local)
}

# The raw unit name, for output-field-naming purposes (out_field_name())
# only -- unlike normalize_timeunit(), a "utc"/"binned" prefix is kept as-is
# (so e.g. a plain "year" and a "utcyear" bucketing don't collide in the
# derived field name) and `step` is dropped silently (naming doesn't need
# to reflect it). `unit` may be a plain string or a `{unit, step}`
# TimeUnitParams object -- paste0()'ing the latter directly into a name
# would coerce the whole list into a multi-element character vector instead
# of erroring loudly, so this must be unwrapped before any such use.
timeunit_label <- function(unit) if (is.list(unit)) unit$unit else unit

# A single-part timeUnit as a bare NUMBER (not a truncated Date/POSIXct) --
# e.g. "year" -> the 4-digit year, "month" -> 1-12. Used only for a filter
# predicate comparing a timeUnit'd field against a plain scalar (as opposed
# to a DateTime object): Vega-Lite's own semantics for `{field, timeUnit:
# "year", equal: 2006}` compare just the extracted component number, not
# the full bucketed date, to the given value (a bucketed Date vs. a bare
# number is never meaningfully equal/ordered). `day`/`dayofyear` already
# return a number from `.timeunit_local` itself, so they're reused
# directly; a multi-part unit (yearmonth/yearmonthdate/yearquarter) has no
# single-number form and returns NULL (falls back to the bucketed-date
# comparison, which real specs practically never hit for these since
# they're normally compared against a DateTime object instead).
.timeunit_component <- list(
  year = function(d) sprintf('as.integer(format(%s, "%%Y"))', d),
  quarter = function(d) sprintf('((as.integer(format(%s, "%%m")) - 1) %%/%% 3 + 1)', d),
  month = function(d) sprintf('as.integer(format(%s, "%%m"))', d),
  date = function(d) sprintf('as.integer(format(%s, "%%d"))', d),
  hours = function(d) sprintf('as.integer(format(%s, "%%H"))', d),
  minutes = function(d) sprintf('as.integer(format(%s, "%%M"))', d),
  seconds = function(d) sprintf('as.integer(format(%s, "%%S"))', d)
)

timeunit_component_expr <- function(unit, date_expr) {
  key <- normalize_timeunit(unit)
  if (key %in% c("day", "dayofyear")) return(.timeunit_local[[key]](date_expr))
  fn <- .timeunit_component[[key]]
  if (is.null(fn)) NULL else fn(date_expr)
}

timeunit_expr <- function(unit, date_expr, ignore_unsupported = FALSE) {
  key <- normalize_timeunit(unit)
  fn <- .timeunit_local[[key]]
  if (is.null(fn)) {
    # No bucketing/truncation applied -- the real (un-truncated) date is
    # still a usable temporal value, just not grouped the way this unit asked for.
    if (ignore_unsupported) return(date_expr)
    stop(sprintf('Unsupported timeUnit: "%s"', unit))
  }
  fn(date_expr)
}
