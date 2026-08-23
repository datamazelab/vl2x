# Best-effort translation of a Vega expression string into plain R,
# targeting the bare-column-name style dplyr::filter()/dplyr::mutate() use
# (data-masking NSE) rather than `df$field` access.
#
# As in vl2d3's expr.js, this is a token-level rewrite rather than a full
# parser: replace `datum.field`/`datum['field']` with a (possibly
# backtick-quoted) bare column reference, map the small set of
# JS/Vega-only operators and functions onto their R equivalents, and pass
# everything else through verbatim. Vega-specific functions with no simple
# R equivalent (`datetime()`, `toDate()`, the `vlSelectionTest` family, ...)
# are NOT translated -- they pass through as literal text, which will raise
# a clear R error ("could not find function ...") at generated-code run
# time rather than silently producing wrong output.

.identifier_re <- "[A-Za-z_.][A-Za-z0-9_.]*"

# R already has abs/sqrt/log/exp/sign/cos/sin/tan/atan under the same name;
# these few differ from their Vega/JS spelling. toNumber/toBoolean/toString
# are 1-argument type coercions with an exact base-R equivalent (unlike
# e.g. toDate(), which has none and is deliberately left untranslated).
# `round` is deliberately absent here -- R's own `round(x, digits)` already
# has the exact same 2-argument (value, decimal places) signature and
# semantics Vega's does, so a bare, untranslated `round(...)` already just
# works. `length`, unlike JS/Vega's array-or-string length, only ever
# reports an R *vector's* length (always 1 for a single string) -- `nchar`
# is the correct rename for the string-field usage this project's
# generated code actually exercises.
.math_rename <- c(
  ceil = "ceiling", pow = NA, random = NA, length = "nchar",
  toNumber = "as.numeric", toBoolean = "as.logical", toString = "as.character"
)

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
  # index into a single row's array-valued cell, and a compound-aggregate
  # (argmin/argmax) result is referenced the same way with a string key
  # (e.g. "argmax_US_Gross['Production Budget']") -- neither is a real
  # column name. `flatten_bracket_fields()` (translator.R) rewrites the
  # latter shape into a plain new field before it ever reaches here; a
  # bracket-suffixed field that still arrives at this point (any other
  # shape) would backtick-quote into a nonexistent column if allowed
  # through, so fail loudly instead.
  if (grepl("\\[[^][]*\\]$", field)) {
    stop(sprintf('Unsupported: bracket-indexed field reference "%s" is not supported', field))
  }
  # Per Vega-Lite's field convention, an unescaped "." means nested-object
  # property access (e.g. "record.low" into {"record": {"low": ...}}), not a
  # literal dot in a flat column name (which must be written "record\\.low").
  if (grepl("(?<!\\\\)\\.", field, perl = TRUE)) {
    stop(sprintf('Unsupported: nested field reference "%s" (dot-path into a sub-object) is not supported', field))
  }
  field <- unescape_field_path(field)
  # is_valid_r_name() (not a hand-rolled character-pattern check here) --
  # a field can easily collide with an R reserved word (`next`, `break`,
  # `if`, ...), which is a syntactically valid *identifier* shape but still
  # requires backtick-quoting to use as a bare name; a plain "does it match
  # the identifier character pattern" check would otherwise emit it
  # unquoted, an R parse error at generated-code run time.
  if (is_valid_r_name(field)) field else paste0("`", field, "`")
}

# Undo a Vega-Lite field NAME's own backslash-escaping (most commonly of a
# literal "." -- see field_ref()'s doc comment) -- the real column name in
# the loaded data has no backslash in it at all. Every consumer that reads
# a channel's `$field` directly (bypassing field_ref(), typically because
# it needs the name as something other than an aes()/mutate() symbol -- e.g.
# render_temporal_coercion()'s render_name()'d assignment target) must
# apply this itself; R's own backtick-quoted-name syntax parses backslash
# escapes the same way a string literal does, so a left-in `\.` (not a
# recognized escape like `\n`/`\\`) is an R *parse error* there, not just a
# lookup miss.
unescape_field_path <- function(field) {
  gsub("\\\\(.)", "\\1", field, perl = TRUE)
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

# `datum.field === null` (or `==`/`!==`/`!=`) has no direct R translation --
# R's `==`/`!=` against NA always evaluates to NA itself, never TRUE/FALSE
# (unlike JS, where `x === null` is a real boolean test), so a straight
# operator-and-literal-null translation (the blanket "null" -> "NA" rename
# in translate_expr() below) would silently produce a condition that never
# selects either ifelse() branch. Rewritten into is.na()/!is.na() while the
# `datum...` reference is still simple, literal source text -- this must
# run before the datum->field-reference substitution, which could turn the
# left-hand side into something with backticks/brackets that's harder to
# safely re-wrap.
.null_comparison_re <- "((?:datum(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[['\"][^'\"]*['\"]\\])+))\\s*(===|==|!==|!=)\\s*null\\b"

rewrite_null_comparisons <- function(s) {
  replace_tokens(s, .null_comparison_re, function(m) {
    parts <- regmatches(m, regexec(.null_comparison_re, m, perl = TRUE))[[1]]
    expr <- parts[2]
    op <- parts[3]
    if (op %in% c("===", "==")) sprintf("is.na(%s)", expr) else sprintf("!is.na(%s)", expr)
  }, perl = TRUE)
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
  if (!is.na(qpos)) {
    cond <- substr(s, 1, qpos - 1)
    rest <- substr(s, qpos + 1, nchar(s))
    cpos <- .find_matching_colon(rest)
    if (is.na(cpos)) return(s) # malformed; leave as-is rather than guess
    true_branch <- substr(rest, 1, cpos - 1)
    false_branch <- substr(rest, cpos + 1, nchar(rest))
    return(sprintf(
      "ifelse(%s, %s, %s)",
      trimws(cond), translate_ternary(trimws(true_branch)), translate_ternary(trimws(false_branch))
    ))
  }
  # No BARE top-level ternary -- but a very common shape is one wrapped in
  # its own grouping parens for precedence, e.g. `(cond ? a : b) + c`
  # (`?` sits at depth 1, not 0, so the check above never finds it).
  # Recurse into each top-level paren group's own inner content instead;
  # text outside every group is left untouched (if it held a bare ternary,
  # the check above would already have found it).
  groups <- .find_top_level_groups(s)
  if (length(groups) == 0) return(s)
  result <- ""
  pos <- 1
  for (g in groups) {
    result <- paste0(result, substr(s, pos, g$open))
    inner <- substr(s, g$open + 1, g$close - 1)
    result <- paste0(result, translate_ternary(inner), ")")
    pos <- g$close + 1
  }
  paste0(result, substr(s, pos, nchar(s)))
}

# Every top-level (depth-0) `(...)` group in `s`, as a list of
# `list(open, close)` character positions (of the parens themselves).
.find_top_level_groups <- function(s) {
  chars <- strsplit(s, "")[[1]]
  depth <- 0
  in_quote <- FALSE
  quote_char <- ""
  groups <- list()
  open_pos <- NA
  for (i in seq_along(chars)) {
    ch <- chars[i]
    if (in_quote) {
      if (ch == quote_char) in_quote <- FALSE
      next
    }
    if (ch %in% c("'", '"')) {
      in_quote <- TRUE
      quote_char <- ch
    } else if (ch == "(") {
      if (depth == 0) open_pos <- i
      depth <- depth + 1
    } else if (ch == ")") {
      depth <- depth - 1
      if (depth == 0) groups[[length(groups) + 1]] <- list(open = open_pos, close = i)
    }
  }
  groups
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
  # A quote *anywhere* in a part isn't quite enough: a ternary's own
  # *condition* commonly quotes a string too (`ifelse(type == 'Agree', 1,
  # 0)`, comparing a string field but still returning plain numbers) --
  # blanking out just the condition argument of every ifelse() first means
  # this only reacts to a quote in the true/false *value* arguments, the
  # actual signal that this whole `+` means concatenation, not addition.
  if (!any(vapply(parts, function(p) grepl("['\"]", blank_format_calls(blank_ifelse_conditions(p))), logical(1)))) return(s)
  sprintf("paste0(%s)", paste(parts, collapse = ", "))
}

# See rewrite_string_concat() above: blanks out the first (condition)
# argument of every top-level `ifelse(...)` call in `s`, leaving its
# true/false value arguments (and everything else) untouched.
blank_ifelse_conditions <- function(s) {
  result <- ""
  pos <- 1
  n <- nchar(s)
  while (pos <= n) {
    m <- regexpr("ifelse\\(", substring(s, pos), perl = TRUE)
    if (m[1] == -1) {
      result <- paste0(result, substring(s, pos))
      break
    }
    open <- pos + m[1] - 1 + attr(m, "match.length") - 1
    result <- paste0(result, substring(s, pos, open))
    depth <- 1
    in_quote <- FALSE
    quote_char <- ""
    i <- open + 1
    first_comma <- NA
    while (i <= n && depth > 0) {
      ch <- substr(s, i, i)
      if (in_quote) {
        if (ch == quote_char) in_quote <- FALSE
      } else if (ch %in% c("'", '"')) {
        in_quote <- TRUE
        quote_char <- ch
      } else if (ch == "(") {
        depth <- depth + 1
      } else if (ch == ")") {
        depth <- depth - 1
      } else if (ch == "," && depth == 1 && is.na(first_comma)) {
        first_comma <- i
      }
      i <- i + 1
    }
    if (is.na(first_comma)) {
      result <- paste0(result, substring(s, open + 1))
      pos <- n + 1
      break
    }
    result <- paste0(result, substring(s, first_comma))
    pos <- first_comma
  }
  result
}

# See rewrite_string_concat() above: blanks out every top-level
# `format(...)` call's own arguments in `s` (replacing them with spaces,
# preserving length/positions), leaving everything else untouched. Every
# `format(...)` this project ever generates is `.date_funcs`' own
# implementation of a Vega hours()/minutes()/year()/etc. date-part
# accessor (expr.R) -- always wrapped in `as.integer(...)`, so its result
# is numeric regardless of the quoted format-pattern string ("%H", "%M", ...)
# passed as its second argument. That pattern string being present is not a
# "this whole expression is a string" signal the way an ifelse() branch's
# own quoted string is -- left unblanked, `hours(datum.date) + minutes(...)
# / 60` (a genuine numeric sum) was wrongly rewritten into a paste0() string
# concatenation, since both operands' translated R code carries a quote
# from the pattern string alone.
blank_format_calls <- function(s) {
  result <- ""
  pos <- 1
  n <- nchar(s)
  while (pos <= n) {
    m <- regexpr("format\\(", substring(s, pos), perl = TRUE)
    if (m[1] == -1) {
      result <- paste0(result, substring(s, pos))
      break
    }
    open <- pos + m[1] - 1 + attr(m, "match.length") - 1
    result <- paste0(result, substring(s, pos, open))
    depth <- 1
    in_quote <- FALSE
    quote_char <- ""
    i <- open + 1
    while (i <= n && depth > 0) {
      ch <- substr(s, i, i)
      if (in_quote) {
        if (ch == quote_char) in_quote <- FALSE
      } else if (ch %in% c("'", '"')) {
        in_quote <- TRUE
        quote_char <- ch
      } else if (ch == "(") {
        depth <- depth + 1
      } else if (ch == ")") {
        depth <- depth - 1
      }
      i <- i + 1
    }
    close <- i - 1
    inner_len <- max(close - (open + 1), 0)
    result <- paste0(result, strrep(" ", inner_len), ")")
    pos <- close + 1
  }
  result
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
  # .find_call() only ever finds the *first* "if(" in `s` -- a second,
  # sibling `if(...)` later in the same expression (e.g. `if(a,1,0) +
  # if(b,2,0) + ...`, several ternaries chained together) sits entirely
  # inside the trailing `substr(s, call$close + 1, ...)` this used to
  # return untouched, left as invalid R syntax (`if(x,y,z)` -- R's own
  # `if` has no such 3-argument comma form) -- recursing into that tail
  # catches every later occurrence too. Safe to recurse without re-matching
  # this call's own output: "ifelse(" never matches `.find_call(s, "if")`'s
  # `if\(` pattern (the "e" right after "if" isn't "(").
  before <- substr(s, 1, call$open - 3)
  after <- substr(s, call$close + 1, nchar(s))
  paste0(before, replacement, rewrite_if_calls(after))
}

# `isValid(x)` -- Vega's own "not null/undefined/NaN" check, for any value
# type -- has no single base-R function to rename to, but expands exactly
# into `!is.na(x)` (R's own NA already covers both a genuinely missing value
# and a NaN, which `is.na()` treats the same way).
rewrite_is_valid_calls <- function(s) {
  call <- .find_call(s, "isValid")
  if (is.null(call)) return(s)
  inner <- trimws(substr(s, call$open + 1, call$close - 1))
  replacement <- sprintf("!is.na(%s)", inner)
  rewritten <- paste0(substr(s, 1, call$open - 8), replacement, substr(s, call$close + 1, nchar(s)))
  rewrite_is_valid_calls(rewritten)
}

# Operators with LOWER precedence than JS/Vega's `%` (which binds exactly
# like `*`/`/`) -- a depth-0 occurrence of any of these between the start
# of `s`/the previous such boundary and a `%` means that boundary, not the
# start of `s`, is where `%`'s own left operand actually begins (and
# likewise the next one going right is where its right operand ends).
# Spelled in their *already-rewritten* R form (`&`/`|`, plain `==`/`!=`),
# not the original JS one (`&&`/`||`/`===`/`!==`) -- rewrite_modulo() runs
# near the very end of translate_expr(), after those upstream rewrites
# have already run, so the JS spellings never actually occur in `s` by
# this point (kept in the list too, harmlessly, in case that ordering ever
# changes). Checked longest-first so e.g. "<=" isn't shadowed by matching
# just "<" first.
.MODULO_BOUNDARY_TOKENS <- c("&&", "||", "===", "!==", "==", "!=", "<=", ">=", "<", ">", "&", "|", ",", "?", ":")

# Every depth-0 occurrence of any token in `tokens`, as a list of
# `list(start, end)` character positions (both inclusive) -- same
# quote/paren-aware scan as .find_top_level_char, generalized to
# multi-character tokens.
.find_top_level_tokens <- function(s, tokens) {
  n <- nchar(s)
  depth <- 0
  in_quote <- FALSE
  quote_char <- ""
  hits <- list()
  i <- 1
  while (i <= n) {
    ch <- substr(s, i, i)
    if (in_quote) {
      if (ch == quote_char) in_quote <- FALSE
      i <- i + 1
      next
    }
    if (ch %in% c("'", '"')) {
      in_quote <- TRUE
      quote_char <- ch
      i <- i + 1
      next
    }
    if (ch %in% c("(", "[")) {
      depth <- depth + 1
      i <- i + 1
      next
    }
    if (ch %in% c(")", "]")) {
      depth <- depth - 1
      i <- i + 1
      next
    }
    if (depth == 0) {
      hit_len <- NULL
      for (tok in tokens) {
        tl <- nchar(tok)
        if (i + tl - 1 <= n && substr(s, i, i + tl - 1) == tok) {
          hit_len <- tl
          break
        }
      }
      if (!is.null(hit_len)) {
        hits[[length(hits) + 1]] <- list(start = i, end = i + hit_len - 1)
        i <- i + hit_len
        next
      }
    }
    i <- i + 1
  }
  hits
}

# JS/Vega's unary `+` coerces its immediate operand to a number -- a common
# "make sure this is numeric" idiom for a field that might arrive from raw
# (often all-string) JSON/CSV data (e.g. wheat_wages.vl.json's own
# `+datum.year + 5`, `+datum.start + (+datum.end - +datum.start)/2`). R's
# own unary `+` has no such effect -- applying it to a character vector
# errors outright ("invalid argument to unary operator") -- so every
# UNARY (not binary) `+` is rewritten into an explicit `as.numeric(...)`
# call around its own immediate operand instead. Run after the identifier
# rewrite above, so `datum.field` has already become a plain (possibly
# backtick-quoted) field reference -- a single simple token whose extent is
# easy to detect. A `+` is unary whenever the nearest preceding
# non-whitespace character is "start of string" or itself an operator/`(`/
# `,`/etc -- anything that means "an operand is expected next" -- as
# opposed to following an identifier/number/`)`/`]`/backtick (a real
# value already sits there), which means it's binary addition instead.
rewrite_unary_plus <- function(s) {
  n <- nchar(s)
  chars <- strsplit(s, "")[[1]]
  out <- character(n)
  i <- 1
  out_i <- 0
  in_quote <- FALSE
  quote_char <- ""
  last_significant <- ""
  # `]` listed first in the class (POSIX bracket-expression convention for
  # a literal `]` member -- `\]` is NOT an escape inside `[...]` here, it's
  # a literal backslash immediately followed by a class-closing `]`). `'`/
  # `"` count as a value char too: a closed string literal (e.g. `'...' +
  # datum.x`, a common concatenation pattern) is also a real value, and
  # `last_significant` is left holding the *opening* quote character for
  # as long as a string is being copied through verbatim below (nothing
  # updates it again until the string closes), which is otherwise
  # indistinguishable from "no value seen yet".
  is_value_char <- function(ch) ch %in% c("'", '"') || grepl("[]A-Za-z0-9_.$)`]", ch)
  emit <- function(txt) {
    out_i <<- out_i + 1
    out[out_i] <<- txt
  }
  while (i <= n) {
    ch <- chars[i]
    if (in_quote) {
      emit(ch)
      if (ch == quote_char) in_quote <- FALSE
      i <- i + 1
      next
    }
    if (ch %in% c("'", '"')) {
      in_quote <- TRUE
      quote_char <- ch
      emit(ch)
      last_significant <- ch
      i <- i + 1
      next
    }
    if (ch == "+" && !(nzchar(last_significant) && is_value_char(last_significant))) {
      j <- i + 1
      while (j <= n && chars[j] %in% c(" ", "\t")) j <- j + 1
      operand_start <- j
      if (j <= n && chars[j] == "`") {
        j <- j + 1
        while (j <= n && chars[j] != "`") j <- j + 1
        j <- min(j + 1, n + 1)
      } else if (j <= n && chars[j] == "(") {
        depth <- 1
        j <- j + 1
        while (j <= n && depth > 0) {
          if (chars[j] == "(") depth <- depth + 1
          if (chars[j] == ")") depth <- depth - 1
          j <- j + 1
        }
      } else {
        while (j <= n && grepl("[A-Za-z0-9_.$]", chars[j])) j <- j + 1
      }
      if (j > operand_start) {
        operand <- paste(chars[operand_start:(j - 1)], collapse = "")
        emit(sprintf("as.numeric(%s)", operand))
        last_significant <- ")"
        i <- j
        next
      }
    }
    emit(ch)
    if (!ch %in% c(" ", "\t", "\n")) last_significant <- ch
    i <- i + 1
  }
  paste(out[seq_len(out_i)], collapse = "")
}

# JS/Vega's `%` is modulo (like R's `%%`, which R itself spells with two
# percent signs); a bare `%` is otherwise never valid R syntax.
rewrite_modulo <- function(s) {
  pos <- .find_top_level_char(s, "%")
  if (!is.na(pos)) {
    # `%`'s own operand span is only the text back to the nearest lower-
    # precedence boundary (or the start/end of `s`), NOT the whole string
    # either side -- e.g. `!commonwealth && index % 2`: the left operand is
    # just `index`, not `!commonwealth && index` (`&&` binds looser than
    # `%` in JS, so swallowing it too would silently change what the
    # expression computes, not just how it's spelled).
    boundaries <- .find_top_level_tokens(s, .MODULO_BOUNDARY_TOKENS)
    lhs_from <- 1
    for (b in boundaries) if (b$end < pos) lhs_from <- max(lhs_from, b$end + 1)
    rhs_to <- nchar(s)
    for (b in boundaries) if (b$start > pos) rhs_to <- min(rhs_to, b$start - 1)
    lhs <- trimws(substr(s, lhs_from, pos - 1))
    rhs <- trimws(substr(s, pos + 1, rhs_to))
    before <- substr(s, 1, lhs_from - 1)
    after <- substr(s, rhs_to + 1, nchar(s))
    return(paste0(before, sprintf("(%s) %%%% (%s)", lhs, rewrite_modulo(rhs)), rewrite_modulo(after)))
  }
  # No BARE top-level `%` -- but it very commonly sits inside its own
  # grouping parens for precedence, or nested inside some other construct's
  # own parens entirely (e.g. wheat_wages.vl.json's own `((!datum.a &&
  # datum.b % 2) ? -1 : 1) * 2 + 95`, where `%` is two parens deep, inside
  # a ternary's own condition -- `%` sits at depth 2, not 0, so the check
  # above never finds it). Recurse into each top-level paren group's own
  # inner content instead, same strategy as translate_ternary() above; text
  # outside every group is left untouched (if it held a bare `%`, the check
  # above would already have found it).
  groups <- .find_top_level_groups(s)
  if (length(groups) == 0) return(s)
  result <- ""
  pos <- 1
  for (g in groups) {
    result <- paste0(result, substr(s, pos, g$open))
    inner <- substr(s, g$open + 1, g$close - 1)
    result <- paste0(result, rewrite_modulo(inner), ")")
    pos <- g$close + 1
  }
  paste0(result, substr(s, pos, nchar(s)))
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
  out <- rewrite_null_comparisons(expr)
  out <- translate_ternary(out)
  out <- rewrite_if_calls(out)
  out <- rewrite_is_valid_calls(out)

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

  out <- rewrite_unary_plus(out)

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
#
# `.notes` (an environment, if supplied) is an out-of-band channel for
# recording that some (possibly nested) sub-filter fell back to "TRUE" --
# needed because the recursive and/or/not calls all return a plain string
# (spliced together by the caller), leaving nowhere in that return value
# itself to also flag "a fallback happened somewhere in here" for the
# statement-level caller in transforms.R to turn into a "# vl2ggplot: ..."
# comment.
# A Vega-Lite field-predicate filter's comparison value is a plain scalar
# almost always, but for a `timeUnit`-bucketed field it can instead be a
# `DateTime` object (`{year: 2005, month: 1}`) naming date components --
# distinguished from an ordinary list value (e.g. `oneOf`'s plain array,
# unnamed once parsed) by having at least one recognized date-part name.
.date_part_keys <- c("year", "quarter", "month", "date", "day", "hours", "minutes", "seconds", "milliseconds")

is_date_time_object <- function(v) {
  is.list(v) && any(.date_part_keys %in% names(v))
}

# The R Date/POSIXct construction for a Vega-Lite `DateTime` object,
# matching the granularity `timeunit_expr`'s bucketing functions produce so
# the two sides of a filter comparison are the same shape.
date_time_object_expr <- function(v) {
  year <- if (!is.null(v[["year"]])) v[["year"]] else as.integer(format(Sys.Date(), "%Y"))
  month <- if (!is.null(v[["month"]])) v[["month"]] else 1
  day <- if (!is.null(v[["date"]])) v[["date"]] else 1
  has_time <- !is.null(v[["hours"]]) || !is.null(v[["minutes"]]) || !is.null(v[["seconds"]])
  if (has_time) {
    hour <- if (!is.null(v[["hours"]])) v[["hours"]] else 0
    minute <- if (!is.null(v[["minutes"]])) v[["minutes"]] else 0
    sec <- if (!is.null(v[["seconds"]])) v[["seconds"]] else 0
    return(sprintf(
      'as.POSIXct(sprintf("%%04d-%%02d-%%02d %%02d:%%02d:%%02d", %d, %d, %d, %d, %d, %d), tz = "UTC")',
      year, month, day, hour, minute, sec
    ))
  }
  sprintf('as.Date(sprintf("%%04d-%%02d-%%02d", %d, %d, %d))', year, month, day)
}

filter_to_expr <- function(filter, ignore_unsupported = FALSE, .notes = NULL) {
  if (is.character(filter) && length(filter) == 1) return(sprintf("vl_truthy(%s)", translate_expr(filter)))

  if (is.list(filter) && is.null(names(filter))) {
    if (ignore_unsupported) {
      if (!is.null(.notes)) assign("unsupported", TRUE, envir = .notes)
      return("TRUE")
    }
    stop("Unsupported filter: bare array (expected object or expression string)")
  }

  if (is.list(filter)) {
    if (!is.null(filter[["and"]])) {
      parts <- vapply(filter[["and"]], function(f) paste0("(", filter_to_expr(f, ignore_unsupported, .notes), ")"), character(1))
      return(paste(parts, collapse = " & "))
    }
    if (!is.null(filter[["or"]])) {
      parts <- vapply(filter[["or"]], function(f) paste0("(", filter_to_expr(f, ignore_unsupported, .notes), ")"), character(1))
      return(paste(parts, collapse = " | "))
    }
    if (!is.null(filter[["not"]])) {
      return(paste0("!(", filter_to_expr(filter[["not"]], ignore_unsupported, .notes), ")"))
    }
    if (!is.null(filter[["field"]])) {
      raw_ref <- field_ref(filter[["field"]])
      has_time_unit <- !is.null(filter[["timeUnit"]])
      if (has_time_unit && !is_supported_timeunit(filter[["timeUnit"]]) && !ignore_unsupported) {
        stop(sprintf('Unsupported timeUnit: "%s"', filter[["timeUnit"]]))
      }
      ref <- if (has_time_unit) sprintf("(%s)", timeunit_expr(filter[["timeUnit"]], raw_ref, ignore_unsupported)) else raw_ref
      # A `timeUnit`-bucketed field's comparison value is either a DateTime
      # object (compare via its own Date/POSIXct construction, not
      # format_value()-ing the list into a meaningless, type-incompatible
      # literal) or a bare number (Vega-Lite's own semantics for e.g.
      # `{timeUnit: "year", equal: 2006}` compare just the extracted
      # component number -- a bucketed *Date* vs. a bare number is never
      # meaningfully equal/ordered, unlike two Dates or two plain numbers).
      component_ref <- if (has_time_unit) timeunit_component_expr(filter[["timeUnit"]], raw_ref) else NULL
      cmp <- function(op, value) {
        if (is_date_time_object(value)) return(sprintf("%s %s %s", ref, op, date_time_object_expr(value)))
        if (!is.null(component_ref)) return(sprintf("%s %s %s", component_ref, op, format_value(value)))
        sprintf("%s %s %s", ref, op, format_value(value))
      }
      if (!is.null(filter[["equal"]])) return(cmp("==", filter[["equal"]]))
      if (!is.null(filter[["lt"]])) return(cmp("<", filter[["lt"]]))
      if (!is.null(filter[["lte"]])) return(cmp("<=", filter[["lte"]]))
      if (!is.null(filter[["gt"]])) return(cmp(">", filter[["gt"]]))
      if (!is.null(filter[["gte"]])) return(cmp(">=", filter[["gte"]]))
      if (!is.null(filter[["range"]])) {
        rng <- filter[["range"]]
        parts <- character(0)
        if (!is.null(rng[[1]])) parts <- c(parts, cmp(">=", rng[[1]]))
        if (!is.null(rng[[2]])) parts <- c(parts, cmp("<=", rng[[2]]))
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

  if (ignore_unsupported) {
    # A param/selection-driven predicate (e.g. `{"param": "brush"}`) has no
    # meaning without live interactivity (not implemented) -- "TRUE" (keep
    # every row, as if nothing were selected/brushed) is the closest
    # reasonable default for a static render.
    if (!is.null(.notes)) assign("unsupported", TRUE, envir = .notes)
    return("TRUE")
  }
  stop(sprintf("Unsupported filter predicate shape: %s", jsonlite::toJSON(filter, auto_unbox = TRUE)))
}
