# Best-effort translation of a Vega expression string into plain R,
# targeting the bare-column-name style dplyr::filter()/dplyr::mutate() use
# (data-masking NSE) rather than `df$field` access.
#
# As in vl2d3's expr.js, this is a token-level rewrite rather than a full
# parser: replace `datum.field`/`datum['field']` with a (possibly
# backtick-quoted) bare column reference, map the small set of
# JS/Vega-only operators and functions onto their R equivalents, and pass
# everything else through verbatim. Vega-specific functions with no simple
# R equivalent (`datetime()`, `toDate()`, the `vlSelectionTest` family,
# string helpers like `isValid`/`length`, ...) are NOT translated -- they
# pass through as literal text, which will raise a clear R error
# ("could not find function ...") at generated-code run time rather than
# silently producing wrong output.

.identifier_re <- "[A-Za-z_.][A-Za-z0-9_.]*"

# R already has abs/sqrt/log/exp/sign/cos/sin/tan/atan under the same name;
# these few differ from their Vega/JS spelling.
.math_rename <- c(ceil = "ceiling", pow = NA, random = NA)

.date_funcs <- list(
  year = function(a) sprintf('as.integer(format(%s, "%%Y"))', a),
  month = function(a) sprintf('(as.integer(format(%s, "%%m")) - 1L)', a),
  date = function(a) sprintf('as.integer(format(%s, "%%d"))', a),
  day = function(a) sprintf('as.integer(format(%s, "%%w"))', a),
  hours = function(a) sprintf('as.integer(format(%s, "%%H"))', a),
  minutes = function(a) sprintf('as.integer(format(%s, "%%M"))', a),
  seconds = function(a) sprintf('as.integer(format(%s, "%%S"))', a),
  time = function(a) sprintf("as.numeric(%s)", a)
)
.date_func_re <- paste0("\\b(", paste(names(.date_funcs), collapse = "|"), ")\\s*\\(([^()]+)\\)")

# Reference a field as a bare (data-masking) name, backtick-quoting it if it
# isn't already a valid R identifier (e.g. it contains spaces).
field_ref <- function(field) {
  # Vega-Lite "bullet chart" style specs use a field name like "ranges[2]" to
  # index into a single row's array-valued cell -- not a real column name.
  # Backtick-quoting it as a literal name would silently reference a
  # nonexistent column, so fail loudly instead.
  if (grepl("\\[[0-9]+\\]$", field)) {
    stop(sprintf('Unsupported: bracket-indexed field reference "%s" is not supported', field))
  }
  # Per Vega-Lite's field convention, an unescaped "." means nested-object
  # property access (e.g. "record.low" into {"record": {"low": ...}}), not a
  # literal dot in a flat column name (which must be written "record\\.low").
  if (grepl("(?<!\\\\)\\.", field, perl = TRUE)) {
    stop(sprintf('Unsupported: nested field reference "%s" (dot-path into a sub-object) is not supported', field))
  }
  if (grepl(paste0("^", .identifier_re, "$"), field)) field else paste0("`", field, "`")
}

# Apply `replace_fn(match_text) -> replacement_text` to every match of
# `pattern` in `text` (base R has no function-replacement form of gsub).
replace_tokens <- function(text, pattern, replace_fn, perl = FALSE) {
  m <- gregexpr(pattern, text, perl = perl)
  matches <- regmatches(text, m)[[1]]
  if (length(matches) == 0) return(text)
  replacements <- vapply(matches, replace_fn, character(1), USE.NAMES = FALSE)
  regmatches(text, m) <- list(replacements)
  text
}

# R has no ternary operator, so `cond ? a : b` is rewritten to
# `ifelse(cond, a, b)` (vectorized, since this runs inside a dplyr::mutate()
# over a whole column, not a scalar `if`). Scans for the first top-level
# `?` and its matching top-level `:` (tracking paren/bracket nesting and
# quoted strings, and nested-ternary depth so a chained
# `a ? b : c ? d : e` -- right-associative, as in JS -- still finds the
# right split), then recurses into both branches for further chained
# ternaries.
translate_ternary <- function(s) {
  qpos <- .find_top_level_char(s, "?")
  if (is.na(qpos)) return(s)
  cond <- substr(s, 1, qpos - 1)
  rest <- substr(s, qpos + 1, nchar(s))
  cpos <- .find_matching_colon(rest)
  if (is.na(cpos)) return(s) # malformed; leave as-is rather than guess
  true_branch <- substr(rest, 1, cpos - 1)
  false_branch <- substr(rest, cpos + 1, nchar(rest))
  sprintf(
    "ifelse(%s, %s, %s)",
    trimws(cond), translate_ternary(trimws(true_branch)), translate_ternary(trimws(false_branch))
  )
}

.find_top_level_char <- function(s, target) {
  chars <- strsplit(s, "")[[1]]
  depth <- 0
  in_quote <- FALSE
  quote_char <- ""
  for (i in seq_along(chars)) {
    ch <- chars[i]
    if (in_quote) {
      if (ch == quote_char) in_quote <- FALSE
      next
    }
    if (ch %in% c("'", '"')) {
      in_quote <- TRUE
      quote_char <- ch
    } else if (ch %in% c("(", "[")) {
      depth <- depth + 1
    } else if (ch %in% c(")", "]")) {
      depth <- depth - 1
    } else if (ch == target && depth == 0) {
      return(i)
    }
  }
  NA_integer_
}

.split_top_level <- function(s, target) {
  chars <- strsplit(s, "")[[1]]
  depth <- 0
  in_quote <- FALSE
  quote_char <- ""
  positions <- integer(0)
  for (i in seq_along(chars)) {
    ch <- chars[i]
    if (in_quote) {
      if (ch == quote_char) in_quote <- FALSE
      next
    }
    if (ch %in% c("'", '"')) {
      in_quote <- TRUE
      quote_char <- ch
    } else if (ch %in% c("(", "[")) {
      depth <- depth + 1
    } else if (ch %in% c(")", "]")) {
      depth <- depth - 1
    } else if (ch == target && depth == 0) {
      positions <- c(positions, i)
    }
  }
  positions
}

# JS/Vega's `+` does string concatenation whenever either operand is a
# string; R's `+` is arithmetic-only, so a top-level `+` next to a quoted
# string literal must become paste0() instead.
rewrite_string_concat <- function(s) {
  positions <- .split_top_level(s, "+")
  if (length(positions) == 0) return(s)
  bounds <- c(0, positions, nchar(s) + 1)
  parts <- vapply(seq_len(length(bounds) - 1), function(i) {
    trimws(substr(s, bounds[i] + 1, bounds[i + 1] - 1))
  }, character(1))
  if (!any(grepl("^['\"]", parts))) return(s)
  sprintf("paste0(%s)", paste(parts, collapse = ", "))
}

# Find the outer `name(...)` call in `s` (a literal identifier immediately
# followed by "(", not part of a longer identifier), returning the
# character positions of its "(" and matching ")", or NULL if absent.
.find_call <- function(s, name) {
  m <- regexpr(paste0("(^|[^A-Za-z0-9_.])", name, "\\("), s, perl = TRUE)
  if (m[1] == -1) return(NULL)
  open <- m[1] + attr(m, "match.length") - 1
  chars <- strsplit(s, "")[[1]]
  depth <- 0
  in_quote <- FALSE
  quote_char <- ""
  for (i in open:length(chars)) {
    ch <- chars[i]
    if (in_quote) {
      if (ch == quote_char) in_quote <- FALSE
      next
    }
    if (ch %in% c("'", '"')) {
      in_quote <- TRUE
      quote_char <- ch
    } else if (ch == "(") {
      depth <- depth + 1
    } else if (ch == ")") {
      depth <- depth - 1
      if (depth == 0) return(list(open = open, close = i))
    }
  }
  NULL
}

# Vega expressions can spell a conditional as the function `if(cond, a, b)`
# as well as the `cond ? a : b` ternary -- both need ifelse(), and the
# function form's arguments can themselves nest another `if(...)` (as its
# else-branch), so this recurses into each extracted argument.
rewrite_if_calls <- function(s) {
  call <- .find_call(s, "if")
  if (is.null(call)) return(s)
  inner <- substr(s, call$open + 1, call$close - 1)
  positions <- .split_top_level(inner, ",")
  if (length(positions) != 2) return(s) # malformed; leave as-is rather than guess
  bounds <- c(0, positions, nchar(inner) + 1)
  parts <- vapply(seq_len(3), function(i) trimws(substr(inner, bounds[i] + 1, bounds[i + 1] - 1)), character(1))
  replacement <- sprintf("ifelse(%s, %s, %s)", parts[1], rewrite_if_calls(parts[2]), rewrite_if_calls(parts[3]))
  paste0(substr(s, 1, call$open - 3), replacement, substr(s, call$close + 1, nchar(s)))
}

# JS/Vega's `%` is modulo (like R's `%%`, which R itself spells with two
# percent signs); a bare `%` is otherwise never valid R syntax.
rewrite_modulo <- function(s) {
  pos <- .find_top_level_char(s, "%")
  if (is.na(pos)) return(s)
  lhs <- trimws(substr(s, 1, pos - 1))
  rhs <- trimws(substr(s, pos + 1, nchar(s)))
  sprintf("(%s) %%%% (%s)", lhs, rewrite_modulo(rhs))
}

.find_matching_colon <- function(s) {
  chars <- strsplit(s, "")[[1]]
  depth <- 0
  ternary_depth <- 0
  in_quote <- FALSE
  quote_char <- ""
  for (i in seq_along(chars)) {
    ch <- chars[i]
    if (in_quote) {
      if (ch == quote_char) in_quote <- FALSE
      next
    }
    if (ch %in% c("'", '"')) {
      in_quote <- TRUE
      quote_char <- ch
    } else if (ch %in% c("(", "[")) {
      depth <- depth + 1
    } else if (ch %in% c(")", "]")) {
      depth <- depth - 1
    } else if (depth == 0 && ch == "?") {
      ternary_depth <- ternary_depth + 1
    } else if (depth == 0 && ch == ":") {
      if (ternary_depth == 0) return(i)
      ternary_depth <- ternary_depth - 1
    }
  }
  NA_integer_
}

translate_expr <- function(expr) {
  if (!is.character(expr)) return(expr)
  out <- translate_ternary(expr)
  out <- rewrite_if_calls(out)

  # datum['field'] / datum["field"] -> bare/backtick-quoted field reference.
  out <- replace_tokens(out, "datum\\[(['\"])([^'\"]*)\\1\\]", function(m) {
    field <- sub("^datum\\[['\"](.*)['\"]\\]$", "\\1", m)
    field_ref(field)
  })

  # datum.field[N] -> JS string indexing (the Nth character, 0-based) --
  # must run before the generic datum.field rewrite below, or the trailing
  # [N] is left dangling as R vector indexing (which for [0] always yields a
  # zero-length result, not a character).
  out <- replace_tokens(out, paste0("datum\\.(", .identifier_re, ")\\[(\\d+)\\]"), function(m) {
    parts <- sub(paste0("^datum\\.(", .identifier_re, ")\\[(\\d+)\\]$"), "\\1\\|\\|\\2", m)
    parts <- strsplit(parts, "\\|\\|")[[1]]
    pos <- as.integer(parts[2]) + 1L
    sprintf("substr(%s, %d, %d)", field_ref(parts[1]), pos, pos)
  }, perl = TRUE)

  # pow(a, b) -> (a)^(b) ; only for a simple (no nested-paren) argument list.
  out <- replace_tokens(out, "\\bpow\\s*\\(([^(),]+),([^()]+)\\)", function(m) {
    args <- sub("^pow\\s*\\((.*)\\)$", "\\1", m)
    parts <- strsplit(args, ",", fixed = TRUE)[[1]]
    sprintf("(%s)^(%s)", trimws(parts[1]), trimws(parts[2]))
  })

  # Date-component extraction functions applied to a simple argument.
  out <- replace_tokens(out, .date_func_re, function(m) {
    fn <- sub("^([A-Za-z]+).*$", "\\1", m)
    arg <- sub("^[A-Za-z]+\\s*\\((.+)\\)$", "\\1", m)
    .date_funcs[[fn]](arg)
  })

  # Identifier-level rewrites: datum.field -> field reference; JS/Vega
  # operators and function names with a different R spelling.
  out <- replace_tokens(out, paste0(.identifier_re, "(\\.", .identifier_re, ")?"), function(m) {
    if (startsWith(m, "datum.")) return(field_ref(substring(m, 7)))
    if (m == "datum") return(m)
    if (m == "random") return("stats::runif")
    if (m %in% names(.math_rename) && !is.na(.math_rename[[m]])) return(.math_rename[[m]])
    m
  }, perl = TRUE)

  # random() takes no arguments in JS/Vega but runif() requires a count.
  out <- gsub("stats::runif\\(\\s*\\)", "stats::runif(1)", out)

  # Boolean/comparison operators: JS/Vega spellings -> R's.
  out <- gsub("===", "==", out, fixed = TRUE)
  out <- gsub("!==", "!=", out, fixed = TRUE)
  out <- gsub("&&", "&", out, fixed = TRUE)
  out <- gsub("||", "|", out, fixed = TRUE)
  out <- gsub("\\bnull\\b", "NA", out)
  out <- gsub("\\btrue\\b", "TRUE", out)
  out <- gsub("\\bfalse\\b", "FALSE", out)

  out <- rewrite_string_concat(out)
  out <- rewrite_modulo(out)

  out
}

# Vega-Lite's non-expression-string filter forms: a field predicate object
# (`{field, equal/range/oneOf/lt/lte/gt/gte/valid}`), a logical composition
# (`{and/or/not: [...]}`), or a lookup/param predicate. Returns an R boolean
# expression string suitable for dplyr::filter().
filter_to_expr <- function(filter) {
  if (is.character(filter) && length(filter) == 1) return(translate_expr(filter))

  if (is.list(filter) && is.null(names(filter))) {
    stop("Unsupported filter: bare array (expected object or expression string)")
  }

  if (is.list(filter)) {
    if (!is.null(filter[["and"]])) {
      parts <- vapply(filter[["and"]], function(f) paste0("(", filter_to_expr(f), ")"), character(1))
      return(paste(parts, collapse = " & "))
    }
    if (!is.null(filter[["or"]])) {
      parts <- vapply(filter[["or"]], function(f) paste0("(", filter_to_expr(f), ")"), character(1))
      return(paste(parts, collapse = " | "))
    }
    if (!is.null(filter[["not"]])) {
      return(paste0("!(", filter_to_expr(filter[["not"]]), ")"))
    }
    if (!is.null(filter[["field"]])) {
      ref <- field_ref(filter[["field"]])
      if (!is.null(filter[["equal"]])) return(sprintf("%s == %s", ref, format_value(filter[["equal"]])))
      if (!is.null(filter[["lt"]])) return(sprintf("%s < %s", ref, format_value(filter[["lt"]])))
      if (!is.null(filter[["lte"]])) return(sprintf("%s <= %s", ref, format_value(filter[["lte"]])))
      if (!is.null(filter[["gt"]])) return(sprintf("%s > %s", ref, format_value(filter[["gt"]])))
      if (!is.null(filter[["gte"]])) return(sprintf("%s >= %s", ref, format_value(filter[["gte"]])))
      if (!is.null(filter[["range"]])) {
        rng <- filter[["range"]]
        parts <- character(0)
        if (!is.null(rng[[1]])) parts <- c(parts, sprintf("%s >= %s", ref, format_value(rng[[1]])))
        if (!is.null(rng[[2]])) parts <- c(parts, sprintf("%s <= %s", ref, format_value(rng[[2]])))
        return(if (length(parts)) paste(parts, collapse = " & ") else "TRUE")
      }
      one_of <- filter[["oneOf"]]
      if (is.null(one_of)) one_of <- filter[["in"]]
      if (!is.null(one_of)) return(sprintf("%s %%in%% %s", ref, format_value(one_of)))
      if (!is.null(filter[["valid"]])) {
        return(if (isTRUE(filter[["valid"]])) sprintf("!is.na(%s)", ref) else sprintf("is.na(%s)", ref))
      }
    }
  }

  stop(sprintf("Unsupported filter predicate shape: %s", jsonlite::toJSON(filter, auto_unbox = TRUE)))
}
