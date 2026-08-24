# Recursive-ish translation of a Vega-Lite spec into a standalone R script
# that builds the equivalent ggplot2 chart.
#
# Like vl2vlapi (and unlike vl2d3), ggplot2 is itself a grammar-of-graphics
# implementation closely aligned with Vega-Lite's own model, so this
# translator leans on ggplot2 doing most of the actual work: scale domains
# are computed automatically from all layers' data, facet_wrap/grid map
# directly onto Vega-Lite's facet operator, and layers inherit a shared
# base aes() the same way vega-lite-api's chart objects inherit shared
# encoding -- so, as with vl2vlapi, no merge-down of shared layer
# properties into each child is needed.
#
# Passing `ignore_unsupported = TRUE` to `vegalite_to_ggplot()` relaxes this
# (and every other "Unsupported: ..." check throughout the pipeline) into a
# best-effort fallback instead -- nested layers get flattened, a repeat's
# row/column mapping and dodged xOffset/yOffset become a simple patchwork
# grid / overlapping render, geographic encoding is drawn as a plain
# unprojected x/y scatter, and so on. Default is off (current strict
# behavior): a chart that renders something is only better than one that
# refuses when the caller has actually asked for that tradeoff.

# Resolve top-level `datasets: {name: [...rows]}` reusable named datasets --
# any `data: list(name = "...", ...)` reference anywhere in the tree (the
# root view or any layer/concat child) is replaced with that dataset's rows
# as if they'd been inlined directly (`data: list(values = list(...rows), ...rest)`).
resolve_dataset_refs <- function(node, datasets) {
  if (!is.list(node)) return(node)
  if (!is.null(node$data) && is.list(node$data) && !is.null(node$data$name) && !is.null(datasets[[node$data$name]])) {
    rest <- node$data
    rest$name <- NULL
    rest$values <- datasets[[node$data$name]]
    node$data <- rest
  }
  for (key in c("layer", "hconcat", "vconcat", "concat")) {
    if (!is.null(node[[key]])) {
      node[[key]] <- lapply(node[[key]], resolve_dataset_refs, datasets = datasets)
    }
  }
  if (!is.null(node$spec)) {
    node$spec <- resolve_dataset_refs(node$spec, datasets)
  }
  node
}

new_emitter <- function() {
  e <- new.env()
  e$lines <- character(0)
  e$counts <- list()
  e
}

emit <- function(emitter, ...) {
  lines <- c(...)
  emitter$lines <- c(emitter$lines, lines)
}

new_var <- function(emitter, hint) {
  n <- (emitter$counts[[hint]] %||% 0) + 1
  emitter$counts[[hint]] <- n
  if (n == 1) hint else paste0(hint, n)
}

`%||%` <- function(a, b) if (is.null(a)) b else a

collect_temporal_fields <- function(encoding, transform_list) {
  # A field a top-level transform already *produces* (timeUnit's/calculate's
  # "as") is real Date/POSIXct output by construction (see timeunit.R) --
  # excluded below so it's never coerced before the transform that creates
  # it has even run (it doesn't exist yet at that point) or double-coerced
  # after (harmless but pointless).
  produced <- vapply(transform_list, function(t) {
    if (!is.null(t$timeUnit) || !is.null(t$calculate)) t$as %||% NA_character_ else NA_character_
  }, character(1))
  produced <- produced[!is.na(produced)]

  from_encoding <- character(0)
  for (def in encoding) {
    if (is.list(def) && !is.null(def$field) && (identical(def$type, "temporal") || !is.null(def$timeUnit))) {
      from_encoding <- c(from_encoding, def$field)
    }
  }
  from_encoding <- setdiff(from_encoding, produced)
  from_tu_transform <- vapply(transform_list, function(t) if (!is.null(t$timeUnit)) t$field else NA_character_, character(1))
  from_calc <- unlist(lapply(transform_list, function(t) if (!is.null(t$calculate)) extract_date_function_fields(t$calculate) else character(0)))
  from_filter <- unlist(lapply(transform_list, function(t) {
    if (is.character(t$filter) && length(t$filter) == 1) extract_date_function_fields(t$filter) else character(0)
  }))
  drop_bracket_fields(unique(c(from_encoding, from_tu_transform[!is.na(from_tu_transform)], from_calc, from_filter)))
}

# A bracket-indexed field (`argmax_US_Gross['Production Budget']`, a
# compound-aggregate result -- see parse_bracket_field_path()) isn't a real
# column yet at the point any of these collectors run: flatten_bracket_fields()
# (below) creates the real (flattened) column afterward, from the *base*
# name, and rewrites the encoding to point at that instead -- so a bracket
# path reaching field_ref() (e.g. via render_temporal_coercion()/
# render_quantitative_coercion(), both keyed off these collectors) throws
# "Unsupported: bracket-indexed field reference" outright, before that
# rewrite has even happened. None of these fields need this coercion
# anyway (the underlying values were already real numbers/dates going into
# the aggregate that produced them), so they're simply excluded here.
drop_bracket_fields <- function(fields) {
  Filter(function(f) is.null(parse_bracket_field_path(f)), fields)
}

# A field only ever bucketed at day-or-coarser granularity round-trips fine
# through as.Date() (see collect_temporal_fields() above); a field used
# with an "hours"/"minutes"/"seconds"-level timeUnit or date-function needs
# its time-of-day preserved instead, i.e. as.POSIXct() (see
# render_temporal_coercion()'s subday_fields argument, data.R).
is_subday_timeunit <- function(unit) grepl("hours|minutes|seconds", timeunit_label(unit), fixed = FALSE)

collect_subday_temporal_fields <- function(encoding, transform_list) {
  from_encoding <- character(0)
  for (def in encoding) {
    if (is.list(def) && !is.null(def$field) && !is.null(def$timeUnit) && is_subday_timeunit(def$timeUnit)) {
      from_encoding <- c(from_encoding, def$field)
    }
  }
  from_tu_transform <- unlist(lapply(transform_list, function(t) {
    if (!is.null(t$timeUnit) && is_subday_timeunit(t$timeUnit)) t$field else NULL
  }))
  from_calc <- unlist(lapply(transform_list, function(t) if (!is.null(t$calculate)) extract_subday_date_function_fields(t$calculate) else character(0)))
  from_filter <- unlist(lapply(transform_list, function(t) {
    if (is.character(t$filter) && length(t$filter) == 1) extract_subday_date_function_fields(t$filter) else character(0)
  }))
  drop_bracket_fields(unique(c(from_encoding, from_tu_transform, from_calc, from_filter)))
}

# Fields whose encoding channel is explicitly `type: "quantitative"` but
# whose loaded column may have ended up as R `character` -- an inline
# "values" dataset with heterogeneous per-row types for the same field
# (e.g. a "melted"/long-format dataset where non-numeric label rows like
# "Participant ID" share a column with genuinely numeric rating rows)
# forces the whole data.frame column to character at load time (R, unlike
# JS, has no per-row typing), so a later `filter()` that removes the label
# rows still leaves a character column behind unless explicitly coerced
# back to numeric.
transform_produced_fields <- function(transform_list) {
  out <- character(0)
  # `pivot`'s own output column names are the *distinct runtime values* of
  # its key field -- genuinely unknowable at translation time, unlike every
  # other transform below (whose output names are static, spec-declared
  # strings) -- so any pivot anywhere in the pipeline makes the whole
  # "which fields are safe to coerce" question unanswerable, and the
  # caller treats `dynamic = TRUE` as "don't touch anything".
  has_dynamic <- FALSE
  for (t in transform_list) {
    if (!is.null(t$calculate) || !is.null(t$timeUnit)) out <- c(out, t$as)
    if (!is.null(t$bin)) {
      out <- c(out, if (length(t$as) == 2) unlist(t$as) else c(t$as, paste0(t$as, "_end")))
    }
    if (!is.null(t$aggregate) && is.list(t$aggregate)) {
      out <- c(out, vapply(t$aggregate, function(a) a$as %||% "", character(1)))
    }
    if (!is.null(t$window) && is.list(t$window)) {
      out <- c(out, vapply(t$window, function(w) w$as %||% "", character(1)))
    }
    if (!is.null(t$joinaggregate) && is.list(t$joinaggregate)) {
      out <- c(out, vapply(t$joinaggregate, function(a) a$as %||% "", character(1)))
    }
    if (!is.null(t$fold)) {
      as_names <- if (!is.null(t$as)) t$as else list("key", "value")
      out <- c(out, unlist(as_names))
    }
    if (!is.null(t$density)) {
      as_names <- if (!is.null(t$as)) t$as else list("value", "density")
      out <- c(out, unlist(as_names))
    }
    if (!is.null(t$stack)) {
      as_names <- if (!is.null(t$as)) t$as else list(paste0(t$stack, "_start"), paste0(t$stack, "_end"))
      out <- c(out, unlist(as_names))
    }
    # `pivot` and any transform type this project doesn't implement at all
    # (lookup/regression/quantile/impute/flatten/...) either produce field
    # names that are genuinely unknowable at translation time, or are
    # skipped outright under ignore_unsupported -- in both cases, this
    # can't tell whether an encoding field is a real raw column or one of
    # these, so it's safest to leave every quantitative field alone rather
    # than risk coercing a not-yet-existing (or never-existing) one.
    if (!is.null(t$pivot) || !is.null(t$lookup) || !is.null(t$regression) ||
        !is.null(t$quantile) || !is.null(t$impute) || !is.null(t$flatten)) {
      has_dynamic <- TRUE
    }
  }
  list(fields = unique(out[nzchar(out)]), dynamic = has_dynamic)
}

collect_quantitative_fields <- function(encoding, transform_list = list()) {
  produced <- transform_produced_fields(transform_list)
  if (isTRUE(produced$dynamic)) return(character(0))
  fields <- character(0)
  for (def in encoding) {
    if (is.list(def) && !is.null(def$field) && identical(def$type, "quantitative")) {
      fields <- c(fields, def$field)
    }
  }
  drop_bracket_fields(setdiff(unique(fields), produced$fields))
}

render_quantitative_coercion <- function(var_name, fields) {
  if (length(fields) == 0) return(character(0))
  assigns <- vapply(fields, function(f) {
    ref <- field_ref(f)
    sprintf(
      "%s = if (is.character(%s)) suppressWarnings(as.numeric(%s)) else %s",
      render_name(unescape_field_path(f)), ref, ref, ref
    )
  }, character(1))
  sprintf("%s <- dplyr::mutate(%s, %s)", var_name, var_name, paste(assigns, collapse = ", "))
}

# Which of a mark's own continuous position channels (the ones a line/area's
# drawn path actually walks) an invalid value there needs `invalid_handling_
# mode()`-driven treatment for -- x/y for line/trail, plus x2/y2 for area
# (whose implicit-zero baseline can be just as broken/invalid as its own
# top edge). An ordinal/nominal channel is skipped (a real category value
# has no "invalid" numeric reading), and so is a bracket/nested-path field
# (field_ref() itself rejects those; skipped here rather than letting that
# throw, mirroring vl2d3's own equivalent skip).
# An aggregated/pivoted/binned line/area (e.g. stacked_area.vl.json's own
# `y: {aggregate: "sum", ...}`, or trail_comet.vl.json's own `fold`-style
# pivot transform) reshapes its data into new rows with no 1:1 relationship
# to the original ones -- the whole "gap between two raw rows" concept
# collect_path_continuity_fields()/render_invalid_run_id()/
# render_invalid_zero_fill() are built around doesn't apply post-
# aggregation (an aggregate already skips non-finite inputs on its own, via
# na.rm = TRUE, and a run-id column added pre-aggregation wouldn't survive
# a group_by()/summarise() or vl_pivot() call anyway -- it names no grouping
# key and isn't itself aggregated, so dplyr/vl_pivot's own reshape silently
# drops it, later reaching the final aes() as a dangling, nonexistent
# column reference).
has_aggregating_channel <- function(encoding, transform_list) {
  channel_hit <- any(vapply(names(encoding), function(k) {
    def <- encoding[[k]]
    is.list(def) && (!is.null(def$aggregate) || !is.null(def$bin))
  }, logical(1)))
  if (channel_hit) return(TRUE)
  any(vapply(transform_list %||% list(), function(t) {
    !is.null(t$aggregate) || !is.null(t$pivot) || !is.null(t$fold) || !is.null(t$bin) || !is.null(t$joinaggregate) || !is.null(t$window)
  }, logical(1)))
}

collect_path_continuity_fields <- function(mark_type, encoding, transform_list = list()) {
  produced <- transform_produced_fields(transform_list)
  if (isTRUE(produced$dynamic)) return(character(0))
  channels <- if (identical(mark_type, "area")) c("x", "y", "x2", "y2") else c("x", "y")
  fields <- character(0)
  for (ch in channels) {
    def <- encoding[[ch]]
    if (is.null(def) || is.null(def$field)) next
    if (!is.null(def$type) && def$type %in% c("ordinal", "nominal")) next
    ok <- tryCatch({
      field_ref(def$field)
      TRUE
    }, error = function(e) FALSE)
    if (!ok) next
    fields <- c(fields, def$field)
  }
  drop_bracket_fields(setdiff(unique(fields), produced$fields))
}

# A mark's own `invalid` property (Vega-Lite default: `"filter"`) -- unlike
# vl2d3's invalidHandlingMode(), this only looks at the mark level (not
# `config.mark.invalid`), since every spec this project has hit so far that
# relies on the config-level default uses a non-line/area mark, where this
# doesn't come into play at all.
invalid_handling_mode <- function(mark_props) {
  if ("invalid" %in% names(mark_props)) return(mark_props[["invalid"]])
  "filter"
}

# `invalid: null`/`false` (as opposed to the default `"filter"`) asks
# Vega-Lite to neither drop the row nor break the path at it -- the invalid
# value is used as-is, which for a continuous position channel resolves to a
# literal 0 (e.g. area_invalid_null.vl.json's own null `y` values, each
# drawn as a dip to the baseline rather than a gap or a dropped row).
render_invalid_zero_fill <- function(var_name, fields) {
  if (length(fields) == 0) return(character(0))
  assigns <- vapply(fields, function(f) {
    ref <- field_ref(f)
    sprintf("%s = ifelse(is.na(%s), 0, %s)", render_name(unescape_field_path(f)), ref, ref)
  }, character(1))
  sprintf("%s <- dplyr::mutate(%s, %s)", var_name, var_name, paste(assigns, collapse = ", "))
}

# The *default* `"filter"` mode instead breaks a line/area's path at an
# invalid position value (e.g. line_skip_invalid_mid.vl.json's own lone NA
# in the middle) rather than connecting straight across it -- ggplot2
# itself already silently drops any row with an NA aesthetic before
# drawing, so simply leaving the NA row where it is (as this project
# otherwise does) just reconnects its two neighbours directly, the wrong
# shape. This instead tags every row with a run id that increments at each
# invalid row; build_layer_channels() folds that id into the geom's own
# `group` aes (via its own `invalid_run_field` argument), so the rows on
# either side of a gap fall into separate groups and the automatic
# NA-row-drop can no longer bridge across them.
.INVALID_RUN_FIELD <- ".vl_gap_run"

render_invalid_run_id <- function(var_name, fields) {
  if (length(fields) == 0) return(character(0))
  na_cond <- paste(vapply(fields, function(f) sprintf("is.na(%s)", field_ref(f)), character(1)), collapse = " | ")
  sprintf("%s <- dplyr::mutate(%s, %s = cumsum(%s))", var_name, var_name, .INVALID_RUN_FIELD, na_cond)
}

extract_date_function_fields <- function(expr) {
  pattern <- paste0("\\b(", paste(names(.date_funcs), collapse = "|"), ")\\s*\\(\\s*datum\\.([A-Za-z_][A-Za-z0-9_.]*)\\s*\\)")
  m <- gregexpr(pattern, expr, perl = TRUE)
  matches <- regmatches(expr, m)[[1]]
  if (length(matches) == 0) return(character(0))
  sub(pattern, "\\2", matches, perl = TRUE)
}

.subday_date_funcs <- c("hours", "minutes", "seconds", "time")

extract_subday_date_function_fields <- function(expr) {
  pattern <- paste0("\\b(", paste(.subday_date_funcs, collapse = "|"), ")\\s*\\(\\s*datum\\.([A-Za-z_][A-Za-z0-9_.]*)\\s*\\)")
  m <- gregexpr(pattern, expr, perl = TRUE)
  matches <- regmatches(expr, m)[[1]]
  if (length(matches) == 0) return(character(0))
  sub(pattern, "\\2", matches, perl = TRUE)
}

.geo_channels <- c("longitude", "latitude", "longitude2", "latitude2")

# Prepare one unit-view child: load data (if it has its own), coerce
# temporal fields, apply its own top-level transforms, and plan inline
# aggregate/bin/timeUnit. Returns list(data_var = var name or NULL if it
# has none of its own, encoding = rewritten encoding, original_encoding,
# mark, extra_fixed, extra_aes, use_histogram).
#
# `inherited_data_var` is the enclosing layer/facet's own data variable (if
# any) -- used only as a *source to copy from* when this child has no data
# of its own but does need data-level prep (its own transform/aggregate/bin):
# Vega-Lite applies a layer child's transform to its own view of the
# inherited data, not destructively to the shared variable every sibling
# layer also reads, so a copy (`data2 <- data1`) is made first rather than
# reassigning `inherited_data_var` in place.
# A Vega-Lite field name is normally a plain (possibly dotted/escaped)
# property path, but a compound aggregate result (`argmin`/`argmax`, which
# stores the *whole matching row* under its `as` name -- see aggops.R) is
# instead referenced with bracket-index syntax into that nested value, e.g.
# `argmax_US_Gross['Production Budget']`. field_ref()/discrete_field_ref()
# only ever look up a single flat column, so rather than teach every one of
# their call sites a general field-path parser, detect this one shape up
# front and flatten it into an ordinary new top-level column before any of
# them ever see it.
# Base identifier for a bracket/nested field path -- deliberately excludes
# `.` (unlike expr.R's own more permissive .identifier_re), since a dot
# here needs to be split *out* as its own nested-access segment below, not
# swallowed into the base.
.bracket_base_re <- "[A-Za-z_$][A-Za-z0-9_$]*"

parse_bracket_field_path <- function(field) {
  if (!is.character(field) || length(field) != 1) return(NULL)
  # A bracket-indexed field path is either a string key (a compound
  # aggregate result, e.g. `argmax_US_Gross['Production Budget']`) or a
  # bare numeric index (a genuine array-valued column, e.g. a bullet
  # chart's `ranges[2]`) -- both parsed here, not just the string-key
  # shape. An *unescaped* `.` is Vega-Lite's other nested-access
  # convention -- reading a sub-property of an object-valued column (e.g.
  # bar_layered_weather.vl.json's own "record.low", reading a `low` field
  # out of each row's `{"record": {"low": ..., "high": ...}}`-shaped
  # value) -- as opposed to a literal dot *within* one flat column name,
  # which must be backslash-escaped ("record\\.low", handled separately by
  # field_ref()'s own unescape step -- this regex's charset has no
  # backslash in it at all, so an escaped field never matches here and
  # reaches that unescaping untouched). Both `.identifier` and `[key]`
  # segments can freely mix (`"a.b[0].c"`), sharing one `keys` list either
  # way (see vl2d3's identical parseBracketFieldPath() for the same fix).
  m <- regmatches(field, regexec(paste0("^(", .bracket_base_re, ")((?:\\.", .bracket_base_re, "|\\[(?:'[^']*'|\"[^\"]*\"|-?[0-9]+)\\])+)$"), field, perl = TRUE))[[1]]
  if (length(m) == 0) return(NULL)
  base <- m[2]
  raw_keys <- regmatches(m[3], gregexpr(paste0("\\.", .bracket_base_re, "|\\[[^]]*\\]"), m[3], perl = TRUE))[[1]]
  keys <- vapply(raw_keys, function(k) {
    if (startsWith(k, ".")) substring(k, 2) else gsub("^\\['|^\\[\"|'\\]$|\"\\]$|^\\[|\\]$", "", k)
  }, character(1), USE.NAMES = FALSE)
  # "dot" (nested-object access) vs "bracket" (array/compound-aggregate
  # index) -- flatten_bracket_fields() needs to know which, since the two
  # need different R access code (see its own doc comment).
  kinds <- vapply(raw_keys, function(k) if (startsWith(k, ".")) "dot" else "bracket", character(1), USE.NAMES = FALSE)
  list(base = base, keys = keys, kinds = kinds)
}

flatten_bracket_fields <- function(encoding, work_var) {
  statements <- character(0)
  rewritten <- encoding
  for (ch in names(encoding)) {
    def <- encoding[[ch]]
    if (!is.list(def) || is.null(def$field)) next
    parsed <- parse_bracket_field_path(def$field)
    if (is.null(parsed)) next
    flat_field <- paste0(parsed$base, "__", paste(gsub("[^A-Za-z0-9_]", "_", parsed$keys), collapse = "__"))
    # Built as a chain of whole-column steps (not one sapply(base, function(.x)
    # .x[[k1]][[k2]]...) wrapping every key at once), since a "dot" step
    # (nested-object access) and a "bracket" step (array/compound-aggregate
    # index) need genuinely different R code:
    #  - bracket: the column is always a genuine list column (jsonlite never
    #    auto-simplifies a JSON *array* field into a data.frame the way it
    #    does an object field), so sapply(..., function(.x) .x[[i]]) is
    #    always right (unchanged from before this dot-path support existed).
    #  - dot: jsonlite's own default loading (simplifyDataFrame = TRUE, the
    #    only mode this project's data-loading code uses) auto-simplifies a
    #    *structurally uniform* nested JSON object field (e.g.
    #    bar_layered_weather.vl.json's own "record": {"low": ..., "high":
    #    ...} on every row) into a nested data.frame *column* already --
    #    `record[["low"]]` directly, no per-row iteration at all -- but
    #    falls back to a genuine list column when rows aren't uniform (a
    #    missing key on some row, etc.), needing the sapply form instead.
    #    Checked at *runtime* (`is.data.frame(.v)`), since which shape
    #    jsonlite picked isn't knowable until the real data has loaded.
    access_expr <- field_ref(parsed$base)
    for (i in seq_along(parsed$keys)) {
      k <- parsed$keys[i]
      if (identical(parsed$kinds[i], "dot")) {
        key_expr <- render_string(k)
        access_expr <- sprintf(
          "(function(.v) if (is.data.frame(.v)) .v[[%s]] else sapply(.v, function(.x) if (is.null(.x)) NA else .x[[%s]]))(%s)",
          key_expr, key_expr, access_expr
        )
      } else {
        # A bare numeric key is Vega-Lite/JS's own 0-based array index (e.g.
        # `ranges[2]` means the *third* element) -- R indexing is 1-based,
        # so this needs the `+ 1` to land on the same element; a quoted
        # string key (a compound-aggregate field name) needs no such shift.
        is_numeric_key <- grepl("^-?[0-9]+$", k)
        index_expr <- if (is_numeric_key) as.character(as.integer(k) + 1L) else render_string(k)
        access_expr <- sprintf("sapply(%s, function(.x) .x[[%s]])", access_expr, index_expr)
      }
    }
    statements <- c(statements, sprintf(
      "%s <- dplyr::mutate(%s, %s = %s)",
      work_var, work_var, render_name(flat_field), access_expr
    ))
    rewritten[[ch]] <- def
    rewritten[[ch]]$field <- flat_field
  }
  list(statements = statements, encoding = rewritten)
}

# Vega-Lite's compound argmin/argmax encoding shorthand
# (`{"aggregate": {"argmax": "otherField"}, "field": "thisField"}`) is
# exactly equivalent to -- and, per Vega-Lite's own compiler, literally
# desugars into -- a top-level `aggregate` transform computing the whole
# matching row (grouped by every other discrete encoding channel), plus a
# bracket-indexed reference into it: precisely the shape a hand-written
# `bar_argmax_transform`-style spec already uses, and this project already
# fully supports (aggops.R's argmax/argmin summarise expr,
# flatten_bracket_fields()). Desugaring the shorthand into that same shape
# up front lets the rest of the pipeline treat both forms identically,
# rather than teaching every aggregate-handling function a second,
# compound-shaped case of its own.
desugar_compound_aggregate_encoding <- function(node) {
  encoding <- node$encoding
  if (is.null(encoding)) return(node)
  compound_channel <- NULL
  for (ch in names(encoding)) {
    def <- encoding[[ch]]
    agg <- if (is.list(def)) def$aggregate else NULL
    if (is.list(agg) && !is.null(names(agg)) && any(names(agg) %in% c("argmax", "argmin"))) {
      compound_channel <- ch
      break
    }
  }
  if (is.null(compound_channel)) return(node)

  def <- encoding[[compound_channel]]
  op <- intersect(names(def$aggregate), c("argmax", "argmin"))[1]
  sort_field <- def$aggregate[[op]]
  value_field <- def$field
  as_name <- paste0(op, "_", gsub("[^A-Za-z0-9_]", "_", sort_field))

  group_keys <- setdiff(names(encoding), compound_channel)
  groupby_fields <- unique(unlist(lapply(encoding[group_keys], function(d) if (is.list(d)) d$field else NULL)))

  node$transform <- c(node$transform, list(list(
    aggregate = list(list(op = op, field = sort_field, as = as_name)),
    groupby = as.list(groupby_fields)
  )))
  encoding[[compound_channel]]$aggregate <- NULL
  encoding[[compound_channel]]$field <- sprintf("%s['%s']", as_name, value_field)
  node$encoding <- encoding
  node
}

prepare_unit <- function(node, emitter, hint, inherited_data_var = NULL, inherited_encoding = list(), ignore_unsupported = FALSE, inherited_offset_field = NULL, facet_group_fields = character(0)) {
  node <- desugar_compound_aggregate_encoding(node)
  node_encoding <- node$encoding %||% list()
  geo_channel <- intersect(names(node_encoding), .geo_channels)
  if (length(geo_channel) > 0) {
    if (!ignore_unsupported) {
      stop(sprintf('Unsupported: geographic encoding ("%s") is not yet supported by vl2ggplot -- no map projection support', geo_channel[1]))
    }
    # No map projection -- plot longitude/latitude directly as a plain
    # quantitative x/y scatter instead (an unprojected, but still
    # spatially-ordered, approximation), unless the view already has its own x/y.
    if (is.null(node_encoding$x) && !is.null(node_encoding$longitude)) {
      node_encoding$x <- list(field = node_encoding$longitude$field, type = "quantitative")
    }
    if (is.null(node_encoding$y) && !is.null(node_encoding$latitude)) {
      node_encoding$y <- list(field = node_encoding$latitude$field, type = "quantitative")
    }
    for (ch in .geo_channels) node_encoding[[ch]] <- NULL
    emit(emitter, sprintf(
      '# vl2ggplot: unsupported geographic encoding ("%s"), plotting longitude/latitude as an unprojected quantitative x/y scatter instead (ignore_unsupported)',
      geo_channel[1]
    ))
  }
  # A dodged/grouped position offset (`xOffset`/`yOffset`) maps directly
  # onto ggplot2's own `position = "dodge2"` -- no sacrifice needed, unlike
  # vl2d3 (which has to build the sub-band geometry by hand). Only a
  # constant/value-bound offset (no `field`, e.g. a fixed per-mark nudge)
  # has no ggplot2 equivalent (there's no per-row value to dodge groups
  # apart by), so that narrow case still fails in strict mode / falls back
  # to being dropped under `ignore_unsupported`.
  offset_field <- NULL
  offset_channel <- intersect(names(node_encoding), c("xOffset", "yOffset"))
  if (length(offset_channel) > 0) {
    offset_def <- node_encoding[[offset_channel[1]]]
    if (!is.null(offset_def$field)) {
      offset_field <- offset_def
    } else if (!ignore_unsupported) {
      stop(sprintf('Unsupported: "%s" with no field (a constant offset) is not yet supported by vl2ggplot', offset_channel[1]))
    } else {
      emit(emitter, sprintf(
        '# vl2ggplot: unsupported "%s" with no field (a constant offset), rendering series overlapping instead (ignore_unsupported)',
        offset_channel[1]
      ))
    }
    for (ch in c("xOffset", "yOffset")) node_encoding[[ch]] <- NULL
  }
  # This child's own xOffset/yOffset (if any) wins over one shared at the
  # enclosing layer wrapper -- same precedence as any other encoding channel.
  offset_field <- offset_field %||% inherited_offset_field

  data_var <- NULL
  if (!is.null(node$data)) {
    data_var <- new_var(emitter, paste0(hint, "_data"))
    emit(emitter, render_data_load(node$data, data_var, ignore_unsupported))
  }

  encoding <- node_encoding
  # Only used to look up a channel (e.g. the *other* axis, for grouping)
  # this child doesn't define itself but inherits from its enclosing
  # layer's shared encoding -- error-extent computation needs to know the
  # real field, unlike aes() rendering elsewhere, which leaves inheritance
  # to ggplot2 itself and never needs to merge encodings.
  encoding_effective <- utils::modifyList(inherited_encoding, encoding)
  mark_type0 <- if (is.character(node$mark)) node$mark else node$mark$type
  mark_props0 <- if (is.character(node$mark)) list() else node$mark[names(node$mark) != "type"]
  invalid_run_field <- NULL
  # channel_entries(encoding_effective), not just this child's own encoding:
  # a channel this child needs prep for (e.g. a shared wrapper-level
  # timeUnit'd x with no aggregation of its own) may be declared only on the
  # enclosing layer wrapper -- the later plan_layer_data() call already uses
  # encoding_effective, so the work_var it needs to write into must be set
  # up here on that same basis, or the plan's statements have nowhere to go.
  needs_prep <- !is.null(node$transform) || length(channel_entries(encoding_effective)) > 0 ||
    needs_error_extent(mark_type0, mark_props0, encoding_effective)
  work_var <- data_var
  if (needs_prep && is.null(work_var)) {
    if (is.null(inherited_data_var)) {
      stop("Internal: a view needs data-level preparation (transform/aggregate/bin) but has no data of its own")
    }
    work_var <- new_var(emitter, paste0(hint, "_data"))
    emit(emitter, sprintf("%s <- %s", work_var, inherited_data_var))
    data_var <- work_var # this child now needs its own `data = ` on the geom
  }

  if (!is.null(work_var)) {
    # encoding_effective (not just this child's own encoding): a field this
    # child groups/aggregates by via error-extent computation below may only
    # be declared on the enclosing layer wrapper (e.g. a shared x/timeUnit),
    # but still needs Date-parsing before that computation can use it.
    temporal_fields <- collect_temporal_fields(encoding_effective, node$transform %||% list())
    subday_fields <- collect_subday_temporal_fields(encoding_effective, node$transform %||% list())
    coercion <- render_temporal_coercion(work_var, temporal_fields, subday_fields)
    if (length(coercion)) emit(emitter, coercion)

    quantitative_coercion <- render_quantitative_coercion(work_var, collect_quantitative_fields(encoding_effective, node$transform %||% list()))
    if (length(quantitative_coercion)) emit(emitter, quantitative_coercion)

    if (mark_type0 %in% c("line", "trail", "area") && !has_aggregating_channel(encoding_effective, node$transform)) {
      continuity_fields <- collect_path_continuity_fields(mark_type0, encoding_effective, node$transform)
      if (length(continuity_fields)) {
        mode <- invalid_handling_mode(mark_props0)
        if (is.null(mode) || isFALSE(mode)) {
          emit(emitter, render_invalid_zero_fill(work_var, continuity_fields))
        } else if (identical(mode, "filter")) {
          emit(emitter, render_invalid_run_id(work_var, continuity_fields))
          invalid_run_field <- .INVALID_RUN_FIELD
        }
      }
    }

    if (!is.null(node$transform)) emit(emitter, render_transforms(node$transform, work_var, ignore_unsupported))

    bracket_plan <- flatten_bracket_fields(encoding_effective, work_var)
    if (length(bracket_plan$statements)) emit(emitter, bracket_plan$statements)
    encoding_effective <- bracket_plan$encoding
  }

  mark_type <- mark_type0
  if (needs_error_extent(mark_type, mark_props0, encoding_effective)) {
    extent_extra_group_fields <- if (!is.null(offset_field)) offset_field$field else character(0)
    extent_plan <- apply_error_extent(mark_props0, encoding_effective, work_var, ignore_unsupported, extent_extra_group_fields)
    emit(emitter, extent_plan$statements)
    encoding <- extent_plan$encoding
    # The extent rewrite already fully replaces the aggregated axis (and
    # folds in whatever it needed from the inherited encoding), so re-merge
    # rather than use the pre-rewrite `encoding_effective` below.
    encoding_effective <- utils::modifyList(inherited_encoding, encoding)
  }

  # Uses encoding_effective (not just this child's own encoding) so that an
  # aggregate channel's implicit groupby correctly includes a categorical
  # channel the child inherits from its enclosing layer rather than
  # defining itself (e.g. a shared `y` on the layer wrapper) -- otherwise
  # the resulting summarise() drops that column while the plot's aes()
  # (inherited separately, by ggplot2 itself) still expects it.
  plan <- if (length(channel_entries(encoding_effective)) > 0) {
    plan_layer_data(mark_type, encoding_effective, work_var, ignore_unsupported, facet_group_fields, has_dodge = !is.null(offset_field), offset_field = offset_field)
  } else {
    list(statements = character(0), encoding = encoding, extra_fixed = list(), extra_aes = list(), use_histogram = FALSE, aggregated = FALSE)
  }
  if (length(plan$statements)) emit(emitter, plan$statements)

  extra_fixed <- plan$extra_fixed
  extra_aes <- plan$extra_aes
  # `plan$manual_dodge_stack` (plan_explicit_aggregate(), transforms.R):
  # this dodge field's own stacking was already computed explicitly there
  # (ggplot2 has no single built-in `position` that both dodges *and*
  # stacks) -- render_geom_layer_code() (geoms.R) draws the matching manual
  # xmin/xmax dodge geometry off the same encoding, so the usual `position
  # = position_dodge2()` + forced `group` fallback below (which would
  # instead dodge every row, including different stack-groups within the
  # same dodge slot, apart from each other) must be skipped here.
  if (!is.null(offset_field) && !isTRUE(plan$manual_dodge_stack)) {
    extra_fixed <- dodge_extra_fixed(extra_fixed)
    # geom_boxplot() (unlike geom_bar()/geom_col()/geom_point(), which
    # dodge_extra_aes()'s own `group` override exists for) already groups
    # correctly on its own: it forms one box per *combination* of every
    # discrete aesthetic present (x AND fill/colour together) by default.
    # Forcing `group` to the offset field ALONE overrides that default and
    # actively breaks it -- every row sharing the same xOffset/color value
    # gets pooled into one box's statistics regardless of its own x
    # (Cylinders, in boxplot_groupped.vl.json's own case), producing the
    # wrong number of boxes (and outlier points) entirely, not just a
    # cosmetic difference.
    if (mark_type != "boxplot") extra_aes <- dodge_extra_aes(extra_aes, offset_field)
  }

  list(
    data_var = data_var, encoding = plan$encoding, original_encoding = encoding,
    mark = node$mark, extra_fixed = extra_fixed, extra_aes = extra_aes,
    use_histogram = plan$use_histogram, aggregated = isTRUE(plan$aggregated),
    extent_params = collect_extent_params(node$transform %||% list()),
    manual_dodge_stack = isTRUE(plan$manual_dodge_stack), offset_field = offset_field,
    invalid_run_field = invalid_run_field
  )
}

# A top-level `extent` transform (`{extent: field, param: name}`) computes
# the [min, max] of `field` and exposes it under `param` for later
# expressions to reference (e.g. a rule mark's `value: {expr:
# "scale('x', b_extent[0])"}}`) -- not a data-pipeline step at all (no
# var_name reshaping), so it's collected here rather than handled inside
# render_transforms(), and resolved directly at the point of use (see
# resolve_value_channel_expr() in encoding.R) rather than through a
# separately pre-declared runtime variable (avoids a redeclaration clash
# across sibling layer children, which -- like any other top-level
# transform -- each independently re-run their own copy of).
collect_extent_params <- function(transform_list) {
  params <- list()
  for (t in transform_list) {
    if (!is.null(t$extent) && !is.null(t$param)) params[[t$param]] <- t$extent
  }
  params
}

# A dodged/grouped position offset needs two things added to the geom call:
# `position = "dodge2"` (ggplot2's own side-by-side layout for overlapping
# discrete-x geoms -- "dodge2" over plain "dodge" since it copes with a
# varying number of groups per x without an explicit `width` argument), and
# a `group` aes so ggplot2 knows what to dodge apart, in case the offset
# field isn't already implied by fill/colour (a channel this project
# usually maps to the *same* field as xOffset/yOffset, per Vega-Lite
# convention, but not necessarily -- e.g. a grouped chart with a distinct
# color legend on some other channel).
#
# An explicit `width` is required here (not just cosmetic): GeomBar/GeomCol
# have their own default width (0.9) that dodge2 can measure and divide up
# fine without it, but a width-less geom (GeomPoint -- exactly the "circle"
# mark in a bar+circle combo chart) has no xmin/xmax for dodge2 to measure
# at all, so *every* group collapses onto the same, undodged x position
# (silently, apart from a "Width not defined" warning) unless a width is
# supplied explicitly. 0.9 matches geom_bar()'s own default, so a sibling
# bar layer's dodge spacing is unaffected by this.
dodge_extra_fixed <- function(extra_fixed) {
  extra_fixed[["position"]] <- extra_fixed[["position"]] %||% "ggplot2::position_dodge2(width = 0.9)"
  extra_fixed
}

dodge_extra_aes <- function(extra_aes, offset_field) {
  if (is.null(extra_aes[["group"]])) extra_aes[["group"]] <- discrete_field_ref(offset_field)
  extra_aes
}

translate_spec <- function(spec, emitter, hint = "chart", ignore_unsupported = FALSE) {
  spec <- spec[names(spec) != "$schema"]

  if (!is.null(spec$concat) || !is.null(spec$hconcat) || !is.null(spec$vconcat)) {
    return(translate_multi(spec, emitter, hint, ignore_unsupported))
  }
  if (!is.null(spec$facet) && !is.null(spec$spec)) {
    return(translate_facet(spec, emitter, hint, ignore_unsupported))
  }
  if (!is.null(spec[["repeat"]]) && !is.null(spec$spec)) {
    return(translate_repeat(spec, emitter, hint, ignore_unsupported))
  }
  if (!is.null(spec$layer)) {
    return(translate_layer(spec, emitter, hint, ignore_unsupported))
  }
  translate_unit(spec, emitter, hint, ignore_unsupported)
}

apply_common <- function(plot_var, spec, emitter, encodings_for_scales, ignore_unsupported = FALSE) {
  # Scales: first non-empty customization found per channel, across all
  # layers' (rewritten) encodings.
  for (channel in c("x", "y", "color", "size", "opacity")) {
    notes_env <- new.env()
    # `mark.clip` (e.g. area_horizon.vl.json's own `"clip": true`, needed
    # there since its y-domain is deliberately fixed to a compact [0, 50]
    # band -- most raw values fall outside it, the whole point of the
    # horizon-graph technique) explicitly asks for out-of-range data to be
    # visually clipped at the domain edge, not dropped --
    # `scale_*_continuous(limits = ...)` (build_position_scale()'s own
    # default handling of an explicit `scale.domain`) does the latter
    # (NA-s anything outside, leaving gaps in a geom_area()/geom_line()'s
    # otherwise-continuous path), while `coord_cartesian(xlim/ylim = ...)`
    # only zooms the *view* -- every point is still computed from the full
    # data, so a shape exceeding the bound is genuinely clipped flat there
    # instead of torn open. Checked across every layer up front (not just
    # whichever `enc` happens to carry this channel's own explicit domain,
    # commonly the shared wrapper-level encoding itself -- see
    # translate_layer()'s own `enc0`, built with no mark_props of its own
    # at all -- rather than any individual mark's), since `clip` and the
    # domain don't have to live on the very same layer's own encoding.
    clip_requested <- channel %in% c("x", "y") &&
      any(vapply(encodings_for_scales, function(e) isTRUE((attr(e, "mark_props") %||% list())[["clip"]]), logical(1)))
    if (clip_requested) {
      domain <- NULL
      for (enc in encodings_for_scales) {
        d <- enc[[channel]]$scale[["domain"]]
        if (!is.null(d) && is.null(names(d))) {
          domain <- d
          break
        }
      }
      if (!is.null(domain)) {
        coord_fn <- if (channel == "x") "xlim" else "ylim"
        emit(emitter, sprintf(
          "%s <- %s + ggplot2::coord_cartesian(%s = %s)", plot_var, plot_var, coord_fn, format_value(domain)
        ))
        next
      }
    }
    for (enc in encodings_for_scales) {
      def <- enc[[channel]]
      if (!is.null(def)) {
        mark_type <- attr(enc, "mark_type") %||% "point"
        mark_props <- attr(enc, "mark_props") %||% list()
        invalid_override <- spec$config$scale$invalid[[channel]]$value
        color_aes <- if (channel == "color") effective_color_aes(mark_type, mark_props)
        calls <- build_scale_calls(channel, def, mark_type, ignore_unsupported, notes_env, invalid_override, color_aes)
        if (length(calls)) {
          emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, calls))
          break
        }
      }
    }
    if (!is.null(notes_env$notes)) emit(emitter, paste0("# vl2ggplot: ", notes_env$notes))
  }

  if (!is.null(spec$title)) {
    title <- if (is.character(spec$title)) spec$title else spec$title$text
    emit(emitter, sprintf('%s <- %s + ggplot2::labs(title = %s)', plot_var, plot_var, render_string(if (is.list(title)) title[[1]] else title)))
  }
  if (!is.null(spec$width) || !is.null(spec$height)) {
    # ggplot2 doesn't size a plot object itself (that's a device/ggsave
    # concern) -- left as a comment so the intent isn't silently dropped.
    # (A `{"step": n}` per-category size, rather than a fixed pixel size,
    # has no direct ggsave() equivalent either way.)
    dims <- Filter(Negate(is.null), list(width = spec$width, height = spec$height))
    parts <- vapply(names(dims), function(n) sprintf("%s = %s", n, format_value(dims[[n]])), character(1))
    emit(emitter, sprintf(
      "# NOTE: %s are set when saving/displaying, e.g. ggsave(..., %s)",
      paste(names(dims), collapse = "/"), paste(parts, collapse = ", ")
    ))
  }
}

translate_unit <- function(spec, emitter, hint, ignore_unsupported = FALSE) {
  # An encoding-level row/column (or facet) channel's own timeUnit needs
  # the same derived-field treatment inject_facet_timeunit_transforms()
  # gives the top-level `facet` operator (translate_facet()) -- injected
  # here, before prepare_unit() runs, so the resulting transform (and the
  # temporal coercion it implies) is in place by the time this view's data
  # is actually built.
  early_facet_def <- extract_facet_channels(spec$encoding)
  if (!is.null(early_facet_def)) spec <- inject_facet_timeunit_transforms(spec, early_facet_def)

  prepared <- prepare_unit(
    spec, emitter, hint,
    ignore_unsupported = ignore_unsupported,
    facet_group_fields = facet_group_field_names(early_facet_def)
  )
  if (is.null(prepared$data_var)) stop("A view must have a data source")

  plot_var <- new_var(emitter, hint)
  emit(emitter, sprintf("%s <- ggplot2::ggplot(%s)", plot_var, prepared$data_var))

  resolved_mark <- if (is.character(prepared$mark)) prepared$mark else resolve_mark_prop_exprs(prepared$mark, resolve_static_params(spec$params))
  geom <- render_geom_layer(resolved_mark, prepared$encoding, NULL, list(extra_fixed = prepared$extra_fixed, extra_aes = prepared$extra_aes, use_histogram = prepared$use_histogram, aggregated = prepared$aggregated, standalone = TRUE, manual_dodge_stack = prepared$manual_dodge_stack, offset_field = prepared$offset_field, invalid_run_field = prepared$invalid_run_field), ignore_unsupported, prepared$data_var, prepared$extent_params)
  emit(emitter, geom$notes)
  emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, geom$code))
  mark_type0 <- if (is.character(prepared$mark)) prepared$mark else prepared$mark$type
  if (identical(mark_type0, "arc")) {
    # A real `radius` channel (build_layer_channels()'s own has_arc_radius,
    # encoding.R) maps theta onto x instead of the classic single-category
    # pie's y -- coord_polar()'s own default `theta = "x"` matches that
    # directly, so only the classic (no radius channel) pie needs the
    # explicit override.
    coord_polar_call <- if (!is.null(prepared$encoding[["radius"]])) "ggplot2::coord_polar()" else 'ggplot2::coord_polar(theta = "y")'
    emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, coord_polar_call))
  }

  enc_for_scale <- prepared$encoding
  attr(enc_for_scale, "mark_type") <- if (is.character(prepared$mark)) prepared$mark else prepared$mark$type
  attr(enc_for_scale, "mark_props") <- if (is.character(prepared$mark)) list() else prepared$mark[names(prepared$mark) != "type"]
  apply_common(plot_var, spec, emitter, list(enc_for_scale), ignore_unsupported)

  facet_def <- extract_facet_channels(prepared$original_encoding)
  if (!is.null(facet_def)) {
    facet_scales <- resolve_facet_scales(spec, has_arc = identical(mark_type0, "arc"))
    emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, render_facet_call(facet_def, scales = facet_scales)))
  }

  plot_var
}

# A composition wrapper's own `data`/`transform` are inherited by a child
# that doesn't define its own (Vega-Lite lets `data` live at whichever
# level is more convenient) -- unlike `layer`, hconcat/vconcat/concat/facet/
# repeat children are otherwise fully independent specs, so this is a
# plain copy-down rather than the "shared base plot" treatment layers get.
inherit_wrapper <- function(child, wrapper) {
  if (is.null(child$data) && !is.null(wrapper$data)) child$data <- wrapper$data
  if (!is.null(wrapper$transform)) child$transform <- c(wrapper$transform, child$transform)
  child
}

# See render_facet_call()'s own `scales` doc comment (facet.R) for why an
# "arc" mark needs its facet panels' theta/radius (ggplot2's own y) axis
# freed rather than shared. Checks the *wrapped* spec's own mark(s) (a
# facet's own child can be a plain unit view or a layer composition) --
# recursing into `layer` covers a pie chart layered with e.g. a text-label
# overlay, matching translate_layer's own has_arc.
spec_has_arc_mark <- function(spec) {
  if (!is.null(spec$mark)) {
    mark_type <- if (is.character(spec$mark)) spec$mark else spec$mark$type
    return(identical(mark_type, "arc"))
  }
  if (!is.null(spec$layer)) {
    return(any(vapply(spec$layer, spec_has_arc_mark, logical(1))))
  }
  FALSE
}

# The ggplot2 `scales` argument for render_facet_call() -- "free_x"/
# "free_y"/"free" when a channel's own axis needs an independent per-panel
# domain, "fixed" (`NULL` here, ggplot2's own default) otherwise. Combines
# two independent reasons a channel might need freeing: an explicit
# `resolve: {scale: {x/y: "independent"}}` (e.g. facet_bullet.vl.json's own
# `resolve.scale.x`, needed since each row's own metric -- revenue,
# profit%, ... -- has a wildly different natural magnitude) and an "arc"
# mark's own theta/radius (ggplot2's y) requirement (`has_arc`, already
# computed by every call site the same way it was before this helper
# existed).
resolve_facet_scales <- function(spec, has_arc = FALSE) {
  resolve_scale <- spec$resolve$scale %||% list()
  free_x <- identical(resolve_scale$x, "independent")
  free_y <- identical(resolve_scale$y, "independent") || has_arc
  if (free_x && free_y) "free" else if (free_x) "free_x" else if (free_y) "free_y" else NULL
}

extract_facet_channels <- function(encoding) {
  if (!is.null(encoding$facet)) return(encoding$facet)
  if (!is.null(encoding$row) || !is.null(encoding$column)) {
    return(list(row = encoding$row, column = encoding$column))
  }
  NULL
}

# The raw field name(s) a facet_def (extract_facet_channels()'s return
# value) needs each panel split by -- threaded into plan_layer_data() as an
# extra, always-present groupby for the *explicit* dplyr::summarise()
# aggregate path (transforms.R's plan_explicit_aggregate()) only: unlike
# stat_summary()/stat_count() (which ggplot2 itself already computes
# per-facet-panel automatically, no help needed), a pre-computed
# dplyr::summarise() runs before faceting ever sees the data, so without
# this the facet field gets silently collapsed/dropped entirely by the
# summarise() -- not just wrong data, but a hard "Plot is missing `<field>`"
# error from facet_grid()/facet_wrap() as soon as the dropped column no
# longer exists to facet by (e.g. arc_facet.vl.json's `column: {field:
# "year"}` alongside `theta: {"aggregate": "sum", ...}`, with no other
# channel already tracking "year").
facet_group_field_names <- function(facet_def) {
  if (is.null(facet_def)) return(character(0))
  if (!is.null(facet_def$row) || !is.null(facet_def$column)) {
    unique(c(facet_def$row$field, facet_def$column$field))
  } else if (!is.null(facet_def$field)) {
    facet_def$field
  } else {
    character(0)
  }
}

# Vega-Lite allows a `layer` entry to itself be a nested layer composition
# (a layer of layers) -- flatten this recursively into a single list of
# unit-view specs (mirroring vl2d3's flattenLayers()), applying
# inherit_wrapper() at each level so shared data/transform still reach the
# innermost unit views correctly.
flatten_layers <- function(node, wrapper) {
  merged <- inherit_wrapper(node, wrapper)
  if (!is.null(merged$layer)) {
    rest <- merged[names(merged) != "layer"]
    return(unlist(lapply(merged$layer, flatten_layers, wrapper = rest), recursive = FALSE))
  }
  list(merged)
}

translate_layer <- function(spec, emitter, hint, ignore_unsupported = FALSE) {
  base_hint <- if (identical(hint, "chart")) "layer" else hint
  plot_var <- new_var(emitter, hint)

  wrapper_encoding <- spec$encoding %||% list()
  # See translate_unit()'s identical injection: a wrapper-level row/column
  # (or facet) channel's own timeUnit needs its derived field created
  # before the wrapper's data gets loaded/transformed/coerced below.
  early_facet_def <- extract_facet_channels(wrapper_encoding)
  if (!is.null(early_facet_def)) spec <- inject_facet_timeunit_transforms(spec, early_facet_def)

  has_nested_layer <- any(vapply(spec$layer, function(c) !is.null(c$layer), logical(1)))
  if (has_nested_layer && !ignore_unsupported) {
    stop("Unsupported: nested layer-of-layers is not yet supported by vl2ggplot")
  }
  layer_children <- if (has_nested_layer) {
    # inherit_wrapper() (not the wrapper's *encoding*, which each unit
    # already picks up separately via inherited_encoding) still needs to
    # carry the wrapper's own data/transform down into a nested layer's
    # children the same way it would for a directly-listed child.
    unlist(lapply(spec$layer, flatten_layers, wrapper = list(data = spec$data, transform = spec$transform)), recursive = FALSE)
  } else {
    spec$layer
  }

  # prepare_unit() only checks a layer CHILD's own encoding for these -- a
  # shared wrapper-level channel (declared once for all children) needs the
  # same check here, applied to every child below (dodge_extra_fixed()/
  # dodge_extra_aes() below only fill in what a child hasn't already set
  # itself, so a child with its own more-specific xOffset/yOffset still wins).
  wrapper_offset_field <- NULL
  wrapper_offset_channel <- intersect(names(wrapper_encoding), c("xOffset", "yOffset"))
  if (length(wrapper_offset_channel) > 0) {
    wrapper_offset_def <- wrapper_encoding[[wrapper_offset_channel[1]]]
    if (!is.null(wrapper_offset_def$field)) {
      wrapper_offset_field <- wrapper_offset_def
    } else if (!ignore_unsupported) {
      stop(sprintf('Unsupported: "%s" with no field (a constant offset) is not yet supported by vl2ggplot', wrapper_offset_channel[1]))
    } else {
      emit(emitter, sprintf(
        '# vl2ggplot: unsupported "%s" with no field (a constant offset), rendering series overlapping instead (ignore_unsupported)',
        wrapper_offset_channel[1]
      ))
    }
    for (ch in c("xOffset", "yOffset")) wrapper_encoding[[ch]] <- NULL
  }
  child_mark_types <- vapply(layer_children, function(c) if (is.character(c$mark)) c$mark else c$mark$type, character(1))
  has_arc <- "arc" %in% child_mark_types
  # A shared wrapper-level color channel has no single owning mark, so its
  # fill-vs-stroke routing is decided by whether any child is a fill-style
  # mark (arc/bar/area/...) -- if so, "fill" is far more likely correct
  # than the "colour" default (a point/line-only convention).
  wrapper_color_mark <- if (any(child_mark_types %in% .fill_marks)) "bar" else "point"
  base_channels_notes <- new.env()
  base_channels <- if (length(wrapper_encoding) > 0) {
    build_layer_channels(wrapper_encoding, wrapper_color_mark, ignore_unsupported, base_channels_notes)
  } else {
    list(aes = list())
  }
  if (has_arc && is.null(base_channels$aes[["x"]])) base_channels$aes[["x"]] <- '""'
  base_aes_call <- render_aes_call(base_channels$aes)
  if (!is.null(base_channels_notes$notes)) emit(emitter, paste0("# vl2ggplot: ", base_channels_notes$notes))

  wrapper_data_var <- NULL
  if (!is.null(spec$data)) {
    wrapper_data_var <- new_var(emitter, paste0(base_hint, "_data"))
    emit(emitter, render_data_load(spec$data, wrapper_data_var, ignore_unsupported))
    temporal_fields <- collect_temporal_fields(wrapper_encoding, spec$transform %||% list())
    subday_fields <- collect_subday_temporal_fields(wrapper_encoding, spec$transform %||% list())
    coercion <- render_temporal_coercion(wrapper_data_var, temporal_fields, subday_fields)
    if (length(coercion)) emit(emitter, coercion)
    quantitative_coercion <- render_quantitative_coercion(wrapper_data_var, collect_quantitative_fields(wrapper_encoding, spec$transform %||% list()))
    if (length(quantitative_coercion)) emit(emitter, quantitative_coercion)
    if (!is.null(spec$transform)) emit(emitter, render_transforms(spec$transform, wrapper_data_var, ignore_unsupported))
  }
  # An `extent` transform on the wrapper (not any individual layer child --
  # this project's own layer translation, unlike D3's mergeDown(), applies
  # the wrapper's transform once against wrapper_data_var rather than
  # cascading a copy into each child) needs collecting here so each child's
  # own value-channel expr (e.g. a rule mark referencing `b_extent[0]`) can
  # still resolve it.
  wrapper_extent_params <- collect_extent_params(spec$transform %||% list())

  base_call <- if (!is.null(wrapper_data_var)) {
    if (!is.null(base_aes_call)) sprintf("ggplot2::ggplot(%s, %s)", wrapper_data_var, base_aes_call) else sprintf("ggplot2::ggplot(%s)", wrapper_data_var)
  } else {
    if (!is.null(base_aes_call)) sprintf("ggplot2::ggplot() + %s", base_aes_call) else "ggplot2::ggplot()"
  }
  emit(emitter, sprintf("%s <- %s", plot_var, base_call))

  encodings_for_scales <- list()
  facet_def <- extract_facet_channels(wrapper_encoding)

  layer_param_values <- resolve_static_params(spec$params)
  for (i in seq_along(layer_children)) {
    child <- layer_children[[i]]
    prepared <- prepare_unit(
      child, emitter, sprintf("%s%d", base_hint, i),
      inherited_data_var = wrapper_data_var, inherited_encoding = wrapper_encoding,
      ignore_unsupported = ignore_unsupported, inherited_offset_field = wrapper_offset_field,
      facet_group_fields = facet_group_field_names(facet_def)
    )
    data_arg <- prepared$data_var # NULL means "inherit the plot's data"
    resolved_mark <- if (is.character(prepared$mark)) prepared$mark else resolve_mark_prop_exprs(prepared$mark, layer_param_values)
    geom <- render_geom_layer(
      resolved_mark, prepared$encoding, data_arg,
      list(extra_fixed = prepared$extra_fixed, extra_aes = prepared$extra_aes, use_histogram = prepared$use_histogram, aggregated = prepared$aggregated, standalone = FALSE, invalid_run_field = prepared$invalid_run_field),
      ignore_unsupported,
      prepared$data_var %||% wrapper_data_var,
      merge_named(wrapper_extent_params, prepared$extent_params)
    )
    emit(emitter, geom$notes)
    emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, geom$code))

    mark_type_i <- if (is.character(prepared$mark)) prepared$mark else prepared$mark$type
    enc <- prepared$encoding
    attr(enc, "mark_type") <- mark_type_i
    attr(enc, "mark_props") <- if (is.character(resolved_mark)) list() else resolved_mark[names(resolved_mark) != "type"]
    encodings_for_scales[[length(encodings_for_scales) + 1]] <- enc
    if (is.null(facet_def)) facet_def <- extract_facet_channels(prepared$original_encoding)
  }
  if (has_arc) emit(emitter, sprintf('%s <- %s + ggplot2::coord_polar(theta = "y")', plot_var, plot_var))

  if (length(wrapper_encoding) > 0) {
    enc0 <- wrapper_encoding
    attr(enc0, "mark_type") <- "point"
    encodings_for_scales <- c(list(enc0), encodings_for_scales)
  }
  apply_common(plot_var, spec, emitter, encodings_for_scales, ignore_unsupported)

  if (!is.null(facet_def)) {
    emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, render_facet_call(facet_def, scales = resolve_facet_scales(spec, has_arc))))
  }

  plot_var
}

translate_facet <- function(spec, emitter, hint, ignore_unsupported = FALSE) {
  child_hint <- if (identical(hint, "chart")) "view" else paste0(hint, "_view")
  child_spec <- inherit_wrapper(spec$spec, spec)
  child_spec <- inject_facet_timeunit_transforms(child_spec, spec$facet)
  child_var <- translate_spec(child_spec, emitter, child_hint, ignore_unsupported)

  plot_var <- new_var(emitter, hint)
  facet_scales <- resolve_facet_scales(spec, has_arc = spec_has_arc_mark(child_spec))
  emit(emitter, sprintf("%s <- %s + %s", plot_var, child_var, render_facet_call(spec$facet, spec$columns, scales = facet_scales)))
  plot_var
}

translate_repeat <- function(spec, emitter, hint, ignore_unsupported = FALSE) {
  rep_fields <- spec[["repeat"]]
  # `{"repeat": {"layer": [...]}}` -- unlike a row/column repeat (independent
  # side-by-side panels), this repeats the *same* spec once per value as
  # additional layers of one single combined plot (e.g. one line per stock
  # symbol, all sharing the same axes) -- a completely different shape from
  # the row/column grid below, so it's dispatched to its own function rather
  # than (as before) being silently misrouted into the row/column branch,
  # which has no "layer" key to find and left the `{"repeat": "layer"}`
  # placeholder inside the spec never substituted at all.
  is_layer_repeat <- is.list(rep_fields) && !is.null(rep_fields[["layer"]])
  if (is_layer_repeat) {
    return(translate_repeat_layer(spec, emitter, hint, ignore_unsupported))
  }
  is_row_col <- is.list(rep_fields) && !is.null(names(rep_fields))
  if (is_row_col && !ignore_unsupported) {
    stop("Unsupported: repeat with row/column mapping is not yet supported (only a flat repeat field list is)")
  }

  list_var <- new_var(emitter, paste0(hint, "_plots"))
  emit(emitter, sprintf("%s <- list()", list_var))

  if (is_row_col) {
    # A {"row": [...], "column": [...]} grid -- render every row/column
    # combination independently (no shared/aligned scales across panels,
    # same sacrifice vl2d3 makes for the same shape) and lay them out with
    # patchwork using the real column count, rather than refusing entirely.
    emit(emitter, "# vl2ggplot: unsupported repeat row/column mapping, rendering each panel independently (no shared/aligned scales across panels) (ignore_unsupported)")
    rows <- rep_fields$row %||% list(NULL)
    cols <- rep_fields$column %||% list(NULL)
    i <- 0
    for (r in rows) {
      for (co in cols) {
        i <- i + 1
        child_spec <- substitute_repeat_fields(spec$spec, list(row = r, column = co))
        child_spec <- inherit_wrapper(child_spec, spec)
        child_var <- translate_spec(child_spec, emitter, sprintf("%s_rep%d", hint, i), ignore_unsupported)
        emit(emitter, sprintf("%s[[%d]] <- %s", list_var, i, child_var))
      }
    }
    plot_var <- new_var(emitter, hint)
    emit(emitter, sprintf("%s <- patchwork::wrap_plots(%s, ncol = %d)", plot_var, list_var, length(cols)))
    return(plot_var)
  }

  for (i in seq_along(rep_fields)) {
    field <- rep_fields[[i]]
    child_spec <- inherit_wrapper(substitute_repeat_field(spec$spec, field), spec)
    child_var <- translate_spec(child_spec, emitter, sprintf("%s_rep%d", hint, i), ignore_unsupported)
    emit(emitter, sprintf("%s[[%d]] <- %s", list_var, i, child_var))
  }

  plot_var <- new_var(emitter, hint)
  emit(emitter, sprintf("%s <- patchwork::wrap_plots(%s)", plot_var, list_var))
  plot_var
}

# `{"repeat": {"layer": [v1, v2, ...]}}`: render one combined plot with one
# (or more, if `spec.spec` is itself a `layer` composition -- e.g. a
# halo-plus-line pair repeated per series) layer added per repeated value,
# via prepare_unit()/render_geom_layer() directly (mirroring translate_layer's
# own per-child loop) rather than translate_spec() + patchwork -- there's no
# independent panel to lay out here, just more layers on one shared plot.
translate_repeat_layer <- function(spec, emitter, hint, ignore_unsupported = FALSE) {
  layer_values <- spec[["repeat"]][["layer"]]
  base_hint <- if (identical(hint, "chart")) "layer" else hint
  plot_var <- new_var(emitter, hint)
  emit(emitter, sprintf("%s <- ggplot2::ggplot()", plot_var))

  encodings_for_scales <- list()
  facet_def <- NULL
  has_arc <- FALSE
  i <- 0
  for (val in layer_values) {
    child_spec <- inherit_wrapper(substitute_repeat_fields(spec$spec, list(layer = val)), spec)
    units <- if (!is.null(child_spec$layer)) {
      unlist(
        lapply(child_spec$layer, flatten_layers, wrapper = list(data = child_spec$data, transform = child_spec$transform)),
        recursive = FALSE
      )
    } else {
      list(child_spec)
    }
    for (unit in units) {
      i <- i + 1
      prepared <- prepare_unit(unit, emitter, sprintf("%s%d", base_hint, i), ignore_unsupported = ignore_unsupported)
      if (is.null(prepared$data_var)) stop("A view must have a data source")
      geom <- render_geom_layer(
        prepared$mark, prepared$encoding, prepared$data_var,
        list(extra_fixed = prepared$extra_fixed, extra_aes = prepared$extra_aes, use_histogram = prepared$use_histogram, aggregated = prepared$aggregated, standalone = FALSE, invalid_run_field = prepared$invalid_run_field),
        ignore_unsupported, prepared$data_var, prepared$extent_params
      )
      emit(emitter, geom$notes)
      emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, geom$code))

      mark_type_i <- if (is.character(prepared$mark)) prepared$mark else prepared$mark$type
      if (identical(mark_type_i, "arc")) has_arc <- TRUE
      enc <- prepared$encoding
      attr(enc, "mark_type") <- mark_type_i
      attr(enc, "mark_props") <- if (is.character(prepared$mark)) list() else prepared$mark[names(prepared$mark) != "type"]
      encodings_for_scales[[length(encodings_for_scales) + 1]] <- enc
      if (is.null(facet_def)) facet_def <- extract_facet_channels(prepared$original_encoding)
    }
  }

  apply_common(plot_var, spec, emitter, encodings_for_scales, ignore_unsupported)
  if (!is.null(facet_def)) {
    emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, render_facet_call(facet_def, scales = resolve_facet_scales(spec, has_arc))))
  }
  plot_var
}

substitute_repeat_field <- function(node, field) {
  if (is.list(node)) {
    if (!is.null(node[["repeat"]]) && is.character(node[["repeat"]]) && length(node) == 1) return(field)
    # `seq_along()`, not `names(node)`: a JSON *array* (e.g. a `layer` or
    # `hconcat` list of child specs) parses as an unnamed R list, whose
    # `names()` is NULL -- `for (n in names(node))` then iterates zero
    # times, silently skipping every element inside it. That left any
    # `{"repeat": ...}` placeholder nested inside a repeated spec's array
    # properties (almost always exactly where they live, e.g.
    # `spec.layer[i].encoding.y.field`) never substituted at all.
    # `seq_along()` walks every element either way, named or not.
    for (i in seq_along(node)) node[[i]] <- substitute_repeat_field(node[[i]], field)
  }
  node
}

# Same as substitute_repeat_field(), but for the `{"repeat": "row"}` /
# `{"repeat": "column"}` placeholder form used by a row/column repeat grid
# (as opposed to the flat-list form's plain `{"repeat": "repeat"}`).
substitute_repeat_fields <- function(node, values) {
  if (is.list(node)) {
    rep_key <- node[["repeat"]]
    if (!is.null(rep_key) && is.character(rep_key) && length(node) == 1 && rep_key %in% names(values)) {
      return(values[[rep_key]])
    }
    for (i in seq_along(node)) node[[i]] <- substitute_repeat_fields(node[[i]], values)
  }
  node
}

translate_multi <- function(spec, emitter, hint, ignore_unsupported = FALSE) {
  key <- if (!is.null(spec$hconcat)) "hconcat" else if (!is.null(spec$vconcat)) "vconcat" else "concat"
  children <- spec[[key]]
  base_hint <- if (identical(hint, "chart")) key else hint

  child_vars <- vapply(seq_along(children), function(i) {
    translate_spec(inherit_wrapper(children[[i]], spec), emitter, sprintf("%s%d", base_hint, i), ignore_unsupported)
  }, character(1))

  # patchwork's `|`/`/` operator overloads for ggplot objects are only
  # registered when the package is attached (library(patchwork)), which
  # this generated script deliberately never does (everything else is
  # namespace-qualified) -- wrap_plots() is a plain function and needs no
  # attachment, so it's used uniformly for all three concatenation forms.
  plot_var <- new_var(emitter, hint)
  ncol_arg <- switch(key,
    hconcat = sprintf(", ncol = %d", length(children)),
    vconcat = ", ncol = 1",
    if (!is.null(spec$columns)) sprintf(", ncol = %s", format_value(spec$columns)) else ""
  )
  emit(emitter, sprintf("%s <- patchwork::wrap_plots(list(%s)%s)", plot_var, paste(child_vars, collapse = ", "), ncol_arg))
  plot_var
}

#' Translate a Vega-Lite JSON specification into ggplot2 R code
#'
#' @param spec A parsed Vega-Lite spec (as an R list, e.g. from
#'   `jsonlite::fromJSON(text, simplifyVector = FALSE)`).
#' @param chart_var The variable name the generated script assigns the final
#'   plot to. Defaults to `"chart"`.
#' @param ignore_unsupported When `FALSE` (the default), an unsupported
#'   feature throws a clear "Unsupported: ..." error. When `TRUE`, the
#'   translator makes a best-effort sacrifice instead (dropping a feature,
#'   substituting an approximation, or skipping one step) so the chart still
#'   renders, at the cost of no longer faithfully representing the spec.
#' @return A single string: a complete, standalone R script.
#' @export
vegalite_to_ggplot <- function(spec, chart_var = "chart", ignore_unsupported = FALSE) {
  if (!is.null(spec$datasets)) {
    spec <- resolve_dataset_refs(spec, spec$datasets)
    spec$datasets <- NULL
  }

  emitter <- new_emitter()
  final_var <- translate_spec(spec, emitter, chart_var, ignore_unsupported)

  body <- emitter$lines
  # A shared vl2ggplot-exported helper (vl_truthy/vl_pivot/...) is only
  # referenced by name in the generated body -- rather than thread a "which
  # helpers were used" value through every render function that might need
  # one, just check the finished text for each known helper's call syntax
  # and load the package only when at least one is actually present (a
  # plain generated script otherwise depends on nothing beyond ggplot2/dplyr).
  body_text <- paste(body, collapse = "\n")
  needs_vl2ggplot <- any(vapply(RUNTIME_EXPORTS, function(fn) grepl(paste0(fn, "("), body_text, fixed = TRUE), logical(1)))
  header <- c("library(ggplot2)", if (needs_vl2ggplot) "library(vl2ggplot)", "")
  tail <- if (!identical(final_var, chart_var)) sprintf("%s <- %s", chart_var, final_var) else NULL

  paste(c(header, body, "", tail, "", chart_var), collapse = "\n")
}
