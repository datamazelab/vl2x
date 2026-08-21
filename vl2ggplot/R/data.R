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
    rendered <- vapply(items, function(v) if (is.null(v) || (length(v) == 1 && is.na(v))) "NA" else render_scalar_or_na(v), character(1))
    paste0(render_name(field), " = c(", paste(rendered, collapse = ", "), ")")
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
render_data_load <- function(data, var_name) {
  if (is.null(data)) return(character(0))

  if (!is.null(data$format$property)) {
    stop('Unsupported: data "format.property" (extracting a nested array from a larger JSON object) is not yet supported')
  }

  if (!is.null(data$values)) {
    # Vega-Lite also allows "values" to be an embedded raw string (CSV/TSV/
    # JSON text) rather than an array of parsed rows, keyed off format.type.
    if (is.character(data$values) && length(data$values) == 1) {
      fmt <- if (!is.null(data$format) && !is.null(data$format$type)) data$format$type else "csv"
      loader <- switch(fmt,
        csv = sprintf('read.csv(text = %s, stringsAsFactors = FALSE, check.names = FALSE)', render_string(data$values)),
        tsv = sprintf('read.delim(text = %s, stringsAsFactors = FALSE, check.names = FALSE)', render_string(data$values)),
        json = sprintf('jsonlite::fromJSON(%s)', render_string(data$values)),
        stop(sprintf('Unsupported data format: "%s"', fmt))
      )
      return(sprintf("%s <- %s", var_name, loader))
    }
    if (is_named_list(data$values)) {
      stop('Unsupported: inline "values" is a nested object rather than an array of rows')
    }
    return(sprintf("%s <- %s", var_name, render_inline_values(data$values)))
  }

  if (!is.null(data$url)) {
    fmt <- if (!is.null(data$format) && !is.null(data$format$type)) data$format$type else guess_format_from_url(data$url)
    loader <- switch(fmt,
      csv = sprintf('read.csv(%s, stringsAsFactors = FALSE, check.names = FALSE)', render_string(data$url)),
      tsv = sprintf('read.delim(%s, stringsAsFactors = FALSE, check.names = FALSE)', render_string(data$url)),
      json = sprintf('jsonlite::fromJSON(%s)', render_string(data$url)),
      stop(sprintf('Unsupported data format: "%s"', fmt))
    )
    return(sprintf("%s <- %s", var_name, loader))
  }

  stop('Unsupported data source: expected inline "values" or a "url"')
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
  "%a, %d %b %Y %H:%M:%S"
)

render_temporal_coercion <- function(var_name, fields) {
  if (length(fields) == 0) return(character(0))
  formats <- format_value(as.list(.date_try_formats))
  assigns <- vapply(fields, function(f) {
    ref <- field_ref(f)
    # Vega-Lite (like JS) always represents a temporal field's raw numeric
    # value as epoch *milliseconds*, not days -- as.Date()'s own numeric
    # form expects days-since-origin, so this must convert first.
    sprintf(
      "%s = if (is.numeric(%s)) as.Date(%s / 86400000, origin = \"1970-01-01\") else as.Date(as.character(%s), tryFormats = %s)",
      render_name(f), ref, ref, ref, formats
    )
  }, character(1))
  sprintf("%s <- dplyr::mutate(%s, %s)", var_name, var_name, paste(assigns, collapse = ", "))
}
