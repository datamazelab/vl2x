# Render plain JSON-compatible R values (as produced by jsonlite::fromJSON
# with simplifyVector = FALSE) into R source text.
#
# Unlike JS/Python, R distinguishes atomic vectors (c(1, 2, 3)) from lists
# (list(1, "a", list(...))) -- a JSON array becomes a c(...) call only when
# every element is a scalar of the *same* atomic type; otherwise it becomes
# list(...), same as a JSON object always does (as a named list).

.max_line <- 88L

.r_reserved <- c(
  "if", "else", "repeat", "while", "function", "for", "next", "break",
  "TRUE", "FALSE", "NULL", "Inf", "NaN", "NA", "NA_integer_", "NA_real_",
  "NA_character_", "in"
)

is_valid_r_name <- function(name) {
  grepl("^[a-zA-Z.][a-zA-Z0-9._]*$", name) && !(name %in% .r_reserved)
}

render_name <- function(name) {
  if (is_valid_r_name(name)) name else paste0("`", gsub("`", "\\`", name, fixed = TRUE), "`")
}

render_string <- function(x) {
  escaped <- gsub("\\\\", "\\\\\\\\", x)
  escaped <- gsub("\"", "\\\\\"", escaped)
  escaped <- gsub("\n", "\\\\n", escaped)
  paste0("\"", escaped, "\"")
}

render_scalar <- function(x) {
  if (is.null(x)) return("NULL")
  # A non-scalar value here means a JSON array/object cell (e.g. a "flatten"
  # transform's un-flattened array-valued field) reached what's normally a
  # scalar-only path; delegate to the general renderer instead of crashing
  # inside is.na(), which requires length-1 input.
  if (!is_scalar_value(x)) return(format_value(x))
  if (is.na(x)) return("NA")
  if (is.logical(x)) return(if (x) "TRUE" else "FALSE")
  if (is.numeric(x)) return(format(x, scientific = FALSE, trim = TRUE))
  if (is.character(x)) return(render_string(x))
  render_string(as.character(x))
}

is_scalar_value <- function(x) {
  is.null(x) || (length(x) == 1 && (is.logical(x) || is.numeric(x) || is.character(x)) && !is.list(x))
}

is_named_list <- function(x) {
  is.list(x) && !is.null(names(x)) && all(nzchar(names(x)))
}

# All elements are non-list, non-NULL scalars of the same atomic mode.
homogeneous_atomic <- function(items) {
  if (length(items) == 0) return(FALSE)
  if (any(vapply(items, function(v) is.list(v) || is.null(v), logical(1)))) return(FALSE)
  modes <- vapply(items, function(v) if (is.logical(v)) "logical" else if (is.numeric(v)) "numeric" else "character", character(1))
  length(unique(modes)) == 1
}

render_inline <- function(x) {
  if (is_scalar_value(x)) return(render_scalar(x))

  if (is_named_list(x)) {
    parts <- vapply(names(x), function(n) {
      inner <- render_inline(x[[n]])
      if (is.na(inner)) return(NA_character_)
      paste0(render_name(n), " = ", inner)
    }, character(1))
    if (any(is.na(parts))) return(NA_character_)
    return(paste0("list(", paste(parts, collapse = ", "), ")"))
  }

  if (is.list(x)) {
    if (length(x) == 0) return("list()")
    if (homogeneous_atomic(x)) {
      parts <- vapply(x, render_inline, character(1))
      return(paste0("c(", paste(parts, collapse = ", "), ")"))
    }
    parts <- vapply(x, function(v) {
      inner <- render_inline(v)
      if (is.na(inner)) NA_character_ else inner
    }, character(1))
    if (any(is.na(parts))) return(NA_character_)
    return(paste0("list(", paste(parts, collapse = ", "), ")"))
  }

  NA_character_
}

render_multiline <- function(x, indent) {
  pad <- strrep("  ", indent + 1)
  closing_pad <- strrep("  ", indent)

  if (is_named_list(x)) {
    lines <- vapply(names(x), function(n) {
      paste0(pad, render_name(n), " = ", format_value(x[[n]], indent + 1), ",")
    }, character(1))
    lines[length(lines)] <- sub(",$", "", lines[length(lines)])
    return(paste0("list(\n", paste(lines, collapse = "\n"), "\n", closing_pad, ")"))
  }

  if (is.list(x)) {
    if (length(x) == 0) return("list()")
    ctor <- if (homogeneous_atomic(x)) "c" else "list"
    lines <- vapply(x, function(v) paste0(pad, format_value(v, indent + 1), ","), character(1))
    lines[length(lines)] <- sub(",$", "", lines[length(lines)])
    return(paste0(ctor, "(\n", paste(lines, collapse = "\n"), "\n", closing_pad, ")"))
  }

  render_scalar(x)
}

# Render `x` (a value from jsonlite::fromJSON(..., simplifyVector = FALSE))
# as R source, pretty-printing across multiple lines when the single-line
# form would be too long.
format_value <- function(x, indent = 0) {
  inline <- render_inline(x)
  if (!is.na(inline) && nchar(inline) <= (.max_line - indent * 2) && !grepl("\n", inline, fixed = TRUE)) {
    return(inline)
  }
  render_multiline(x, indent)
}
