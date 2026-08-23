# Render the code that loads/produces the initial data.frame.

# Build a `data.frame(col1 = c(...), col2 = c(...))` call from a list of row
# objects (JSON records, as parsed by jsonlite with simplifyVector = FALSE),
# computed column-wise here (at generation time) since row-object -> column
# vectors is exactly the transpose base R's data.frame() expects.
render_inline_values <- function(values) {
  if (length(values) == 0) return("data.frame()")

  # Vega-Lite's own convention: an array of primitive values (not row
  # objects) is ingested as if each were `{"data": value}`.
  if (!is_named_list(values[[1]])) {
    values <- lapply(values, function(v) list(data = v))
  }

  all_fields <- unique(unlist(lapply(values, names)))
  cols <- lapply(all_fields, function(field) {
    lapply(values, function(row) if (is.null(row[[field]])) NA else row[[field]])
  })
  names(cols) <- all_fields

  col_code <- vapply(all_fields, function(field) {
    items <- cols[[field]]
    # An array-valued field (e.g. a bullet chart's own `"ranges": [150, 225,
    # 300]`) can't go through the plain `c(...)` column path below: each
    # row's own array would just splice its elements in as *more* rows
    # instead of staying one cell, immediately conflicting with every other
    # (real, one-value-per-row) column's length -- `data.frame(..., ranges
    # = c(c(150, 225, 300)))` for a single row silently asks for 3 rows.
    # `I(list(...))` instead keeps each row's whole array as one list-cell,
    # exactly what flatten_bracket_fields()'s `sapply(field, function(.x)
    # .x[[k]])` (translator.R) already expects to index into.
    has_array <- any(vapply(items, function(v) !is.null(v) && !is_scalar_value(v), logical(1)))
    if (has_array) {
      rendered <- vapply(items, function(v) if (is.null(v)) "NULL" else render_scalar_or_na(v), character(1))
      paste0(render_name(field), " = I(list(", paste(rendered, collapse = ", "), "))")
    } else {
      rendered <- vapply(items, function(v) if (is.null(v) || (length(v) == 1 && is.na(v))) "NA" else render_scalar_or_na(v), character(1))
      paste0(render_name(field), " = c(", paste(rendered, collapse = ", "), ")")
    }
  }, character(1))

  format_call("data.frame", col_code, extra_args = c("stringsAsFactors = FALSE", "check.names = FALSE"), indent = 0)
}

render_scalar_or_na <- function(v) {
  if (is.null(v)) return("NA")
  render_scalar(v)
}

# Render `target(arg1, arg2, ...)`, one arg per line if it doesn't fit on
# one line.
format_call <- function(target, arg_lines, extra_args = NULL, indent = 0) {
  all_args <- c(arg_lines, extra_args)
  inline <- paste0(target, "(", paste(all_args, collapse = ", "), ")")
  if (nchar(inline) <= 88 && !grepl("\n", inline, fixed = TRUE)) return(inline)
  pad <- strrep("  ", indent + 1)
  closing_pad <- strrep("  ", indent)
  body <- paste0(pad, all_args, collapse = ",\n")
  paste0(target, "(\n", body, "\n", closing_pad, ")")
}

guess_format_from_url <- function(url) {
  ext <- tolower(sub(".*\\.", "", sub("[?#].*$", "", url)))
  if (ext %in% c("csv", "tsv", "json")) ext else "json"
}

# Render the statement(s) that produce a data.frame variable `var_name` from
# a Vega-Lite `data` object, and whether the field is a data.frame directly
# usable or needs a following as.data.frame()-style step.
render_data_load <- function(data, var_name, ignore_unsupported = FALSE) {
  if (is.null(data)) return(character(0))

  if (!is.null(data$format$property)) {
    if (ignore_unsupported) {
      return(c(
        '# vl2ggplot: unsupported data "format.property" (extracting a nested array from a larger JSON object), using an empty data.frame instead (ignore_unsupported)',
        sprintf("%s <- data.frame()", var_name)
      ))
    }
    stop('Unsupported: data "format.property" (extracting a nested array from a larger JSON object) is not yet supported')
  }

  if (!is.null(data$values)) {
    # Vega-Lite also allows "values" to be an embedded raw string (CSV/TSV/
    # JSON text) rather than an array of parsed rows, keyed off format.type.
    if (is.character(data$values) && length(data$values) == 1) {
      fmt <- if (!is.null(data$format) && !is.null(data$format$type)) data$format$type else "csv"
      known <- fmt %in% c("csv", "tsv", "json")
      loader <- switch(fmt,
        csv = sprintf('read.csv(text = %s, stringsAsFactors = FALSE, check.names = FALSE)', render_string(data$values)),
        tsv = sprintf('read.delim(text = %s, stringsAsFactors = FALSE, check.names = FALSE)', render_string(data$values)),
        json = sprintf('jsonlite::fromJSON(%s)', render_string(data$values)),
        if (ignore_unsupported) "data.frame()" else stop(sprintf('Unsupported data format: "%s"', fmt))
      )
      note <- if (!known && ignore_unsupported) {
        sprintf('# vl2ggplot: unsupported inline data format "%s", using an empty data.frame instead (ignore_unsupported)', fmt)
      } else character(0)
      return(c(note, sprintf("%s <- %s", var_name, loader)))
    }
    if (is_named_list(data$values)) {
      if (ignore_unsupported) {
        return(c(
          '# vl2ggplot: unsupported inline "values" shape (a nested object rather than an array of rows), using an empty data.frame instead (ignore_unsupported)',
          sprintf("%s <- data.frame()", var_name)
        ))
      }
      stop('Unsupported: inline "values" is a nested object rather than an array of rows')
    }
    return(sprintf("%s <- %s", var_name, render_inline_values(data$values)))
  }

  if (!is.null(data$url)) {
    fmt <- if (!is.null(data$format) && !is.null(data$format$type)) data$format$type else guess_format_from_url(data$url)
    known <- fmt %in% c("csv", "tsv", "json")
    loader <- switch(fmt,
      csv = sprintf('read.csv(%s, stringsAsFactors = FALSE, check.names = FALSE)', render_string(data$url)),
      tsv = sprintf('read.delim(%s, stringsAsFactors = FALSE, check.names = FALSE)', render_string(data$url)),
      json = sprintf('jsonlite::fromJSON(%s)', render_string(data$url)),
      # A format this project can't parse at all (topojson map geometry, ...)
      # -- an empty data.frame at least keeps the rest of the chart (other
      # layers, axes) from failing outright, though this layer draws nothing.
      if (ignore_unsupported) "data.frame()" else stop(sprintf('Unsupported data format: "%s"', fmt))
    )
    note <- if (!known && ignore_unsupported) {
      sprintf('# vl2ggplot: unsupported data format "%s", using an empty data.frame instead (ignore_unsupported)', fmt)
    } else character(0)
    return(c(note, sprintf("%s <- %s", var_name, loader)))
  }

  if (!is.null(data$sequence)) {
    # A `sequence` data generator produces its own rows outright (no
    # parsing involved) -- one row per step from `start` (inclusive) to
    # `stop` (exclusive), each holding just the sequence value under `as`
    # (Vega-Lite's own default field name, "data", when `as` is omitted).
    # base R's seq() has no built-in exclusive-stop form (unlike d3.range()),
    # so the naive inclusive sequence is filtered down afterward.
    start <- data$sequence$start
    stop <- data$sequence$stop
    step <- if (!is.null(data$sequence$step)) data$sequence$step else 1
    as_name <- if (!is.null(data$sequence$as)) data$sequence$as else "data"
    seq_expr <- sprintf("seq(%s, %s, by = %s)", format_value(start), format_value(stop), format_value(step))
    return(sprintf(
      "%s <- data.frame(%s = Filter(function(.v) .v < %s, %s))",
      var_name, render_name(as_name), format_value(stop), seq_expr
    ))
  }

  if (ignore_unsupported) {
    return(c(
      '# vl2ggplot: unsupported data source (expected inline "values" or a "url"), using an empty data.frame instead (ignore_unsupported)',
      sprintf("%s <- data.frame()", var_name)
    ))
  }
  stop('Unsupported data source: expected inline "values", a "url", or a "sequence" generator')
}

# Fields that are encoded as temporal need coercion from raw
# strings/numbers into real Date objects before anything else runs.
# Real-world data uses all sorts of date-string spellings ("2000-01-01",
# "Jan 1 2000", "01/02/2000", ...) -- as.Date()'s `tryFormats` tries each
# candidate format in turn and keeps the first that parses without NA,
# which covers most of them without knowing the source format in advance.
.date_try_formats <- c(
  "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y",
  "%b %d %Y", "%B %d, %Y", "%B %d %Y", "%Y-%m-%dT%H:%M:%S",
  "%a, %d %b %Y %H:%M:%S",
  # A bare 4-digit year (e.g. "1933") -- last, since it's the most
  # permissive/ambiguous pattern (as.Date() picks the *first* format in
  # this list that parses every value in the vector without NA, so a more
  # specific format earlier never gets shadowed by this one).
  "%Y"
)


# A field a downstream `hours()`/`minutes()`/`seconds()` expression or an
# "hours"/"minutes"/"seconds"-level timeUnit needs its time-of-day
# preserved, not truncated away -- as.Date() (below) always discards it
# regardless of source format, so such a field needs as.POSIXct() instead.
# The time-inclusive formats are listed *first*: R's underlying strptime()
# is lenient about trailing unparsed characters, so a shorter date-only
# format (e.g. "%Y-%m-%d") would otherwise silently "succeed" against a
# string that actually has a time part too (e.g. "2010-01-01T01:00:00"),
# quietly dropping it -- as.POSIXct()'s own tryFormats keeps the *first*
# format that parses every value without NA, so putting the more specific
# formats first is what makes the plainer ones only a fallback for
# genuinely date-only values.
.datetime_try_formats <- c(
  "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%a, %d %b %Y %H:%M:%S",
  "%b %d %Y %H:%M:%S", "%B %d, %Y %H:%M:%S", "%B %d %Y %H:%M:%S",
  "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y",
  "%b %d %Y", "%B %d, %Y", "%B %d %Y", "%Y"
)

render_temporal_coercion <- function(var_name, fields, subday_fields = character(0)) {
  if (length(fields) == 0) return(character(0))
  # vl_parse_date()/vl_parse_datetime() (runtime.R, exported by this
  # package) do the actual numeric-vs-string, tryFormats-list parsing --
  # kept as plain function calls here (rather than inlined) so a chart with
  # several temporal fields across several layers doesn't repeat that same
  # multi-line, multi-format expression once per field.
  assigns <- vapply(fields, function(f) {
    ref <- field_ref(f)
    parse_fn <- if (f %in% subday_fields) "vl_parse_datetime" else "vl_parse_date"
    sprintf("%s = %s(%s)", render_name(unescape_field_path(f)), parse_fn, ref)
  }, character(1))
  sprintf("%s <- dplyr::mutate(%s, %s)", var_name, var_name, paste(assigns, collapse = ", "))
}
