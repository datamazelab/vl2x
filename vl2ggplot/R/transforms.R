# Two related but distinct jobs:
#
# 1. render_transforms(): the top-level Vega-Lite `transform` array
#    (filter/calculate/aggregate/bin as explicit, always-applied steps) ->
#    dplyr pipeline statements.
#
# 2. plan_layer_data(): `aggregate`/`bin`/`timeUnit` declared *inline on an
#    encoding channel* (e.g. `{"y": {"aggregate": "mean", "field": "Rating"}}`).
#    Unlike vl2d3 (which always has to materialize this into pre-transformed
#    data, since D3 has no aggregation stats), ggplot2 has built-in stats
#    (`stat_count`, `stat_summary`, `stat_summary_bin`, `geom_histogram`)
#    that can do this declaratively as part of the geom layer itself, with
#    *no data pre-processing at all* -- so this is tried first, and only
#    falls back to explicit dplyr group_by()/summarise() pre-processing
#    (mirroring vl2d3's approach) for combinations those stats can't express.

# ---- 1. top-level transform array ----

render_transforms <- function(transform_list, var_name, ignore_unsupported = FALSE) {
  stmts <- character(0)
  for (t in transform_list) {
    stmts <- c(stmts, render_one_transform(t, var_name, ignore_unsupported))
  }
  stmts
}

render_one_transform <- function(t, var_name, ignore_unsupported = FALSE) {
  if (!is.null(t$filter)) {
    notes_env <- new.env()
    expr <- filter_to_expr(t$filter, ignore_unsupported, notes_env)
    note <- if (isTRUE(notes_env$unsupported)) {
      "# vl2ggplot: unsupported filter predicate shape, keeping every row (ignore_unsupported)"
    } else character(0)
    return(c(note, sprintf("%s <- dplyr::filter(%s, %s)", var_name, var_name, expr)))
  }
  if (!is.null(t$calculate)) {
    return(sprintf("%s <- dplyr::mutate(%s, %s = %s)", var_name, var_name, render_name(t$as), translate_expr(t$calculate)))
  }
  if (!is.null(t$timeUnit)) {
    supported <- is_supported_timeunit(t$timeUnit)
    if (!supported && !ignore_unsupported) stop(sprintf('Unsupported timeUnit: "%s"', t$timeUnit))
    expr <- timeunit_expr(t$timeUnit, field_ref(t$field), ignore_unsupported)
    note <- if (!supported) {
      sprintf('# vl2ggplot: unsupported timeUnit "%s", left untruncated (ignore_unsupported)', t$timeUnit)
    } else character(0)
    return(c(note, sprintf("%s <- dplyr::mutate(%s, %s = %s)", var_name, var_name, render_name(t$as), expr)))
  }
  if (!is.null(t$bin)) {
    max_bins <- if (is.list(t$bin) && !is.null(t$bin$maxbins)) t$bin$maxbins else 20
    as_names <- if (length(t$as) == 2) t$as else c(t$as, paste0(t$as, "_end"))
    field <- field_ref(t$field)
    return(c(
      sprintf(
        "%s <- dplyr::mutate(%s, .brks = list(pretty(%s, %d)))",
        var_name, var_name, field, max_bins
      ),
      sprintf(
        "%s <- dplyr::mutate(%s, %s = .brks[[1]][findInterval(%s, .brks[[1]], all.inside = TRUE)], %s = .brks[[1]][findInterval(%s, .brks[[1]], all.inside = TRUE) + 1], .brks = NULL)",
        var_name, var_name, render_name(as_names[1]), field, render_name(as_names[2]), field
      )
    ))
  }
  if (!is.null(t$aggregate)) {
    return(render_aggregate_transform(t, var_name, ignore_unsupported))
  }
  if (!is.null(t$density)) {
    return(render_density_transform(t, var_name))
  }
  if (!is.null(t$window)) {
    supported <- all(vapply(t$window, function(w) is_supported_window_op(w$op), logical(1)))
    if (!supported && !ignore_unsupported) {
      bad <- Filter(Negate(is_supported_window_op), vapply(t$window, function(w) w$op, character(1)))
      stop(sprintf('Unsupported window op: "%s"', bad[1]))
    }
    return(render_window_transform(t, var_name, ignore_unsupported))
  }
  if (!is.null(t$joinaggregate)) {
    # A `joinaggregate` transform is exactly a `window` transform's own
    # aggregate ops (sum/mean/count/min/max/...) with no `sort` and no
    # `frame` -- i.e. always the "whole partition, broadcast to every row"
    # case render_window_transform() already implements -- so this is a
    # thin reshape into that same shape rather than a separate
    # implementation.
    supported <- all(vapply(t$joinaggregate, function(w) is_supported_window_op(w$op), logical(1)))
    if (!supported && !ignore_unsupported) {
      bad <- Filter(Negate(is_supported_window_op), vapply(t$joinaggregate, function(w) w$op, character(1)))
      stop(sprintf('Unsupported aggregate op: "%s"', bad[1]))
    }
    return(render_window_transform(list(window = t$joinaggregate, groupby = t$groupby), var_name, ignore_unsupported))
  }
  if (!is.null(t$fold)) {
    return(render_fold_transform(t, var_name))
  }
  if (!is.null(t$pivot)) {
    return(render_pivot_transform(t, var_name))
  }
  if (ignore_unsupported) {
    # Skip this one step -- the rest of the transform pipeline (and the
    # chart as a whole) still runs on whatever data shape existed before it,
    # rather than the entire chart failing over one step it can't perform.
    return(sprintf("# vl2ggplot: skipped unsupported transform type \"%s\" (ignore_unsupported)", names(t)[1]))
  }
  stop(sprintf('Unsupported transform type: "%s"', names(t)[1]))
}

render_aggregate_transform <- function(t, var_name, ignore_unsupported = FALSE) {
  if (!ignore_unsupported) {
    for (a in t$aggregate) {
      if (a$op != "count" && !is_supported_aggregate_op(a$op)) {
        stop(sprintf('Unsupported aggregate op: "%s"', a$op))
      }
    }
  }
  # A compound argmin/argmax op (`a$op` itself a list, e.g. `{"argmax":
  # "field"}`) is excluded here (`is.character(a$op)` guard): it's a
  # structurally different feature (a row lookup, not a summary statistic)
  # that aggregate_summarise_expr() below always rejects outright, in both
  # modes -- not a "fell back to mean" case worth a note.
  unsupported_ops <- unique(vapply(t$aggregate, function(a) {
    if (is.character(a$op) && a$op != "count" && !is_supported_aggregate_op(a$op)) a$op else NA_character_
  }, character(1)))
  unsupported_ops <- unsupported_ops[!is.na(unsupported_ops)]
  notes <- sprintf('# vl2ggplot: unsupported aggregate op "%s", using mean instead (ignore_unsupported)', unsupported_ops)

  value_assigns <- vapply(t$aggregate, function(a) {
    expr <- if (a$op == "count") "dplyr::n()" else aggregate_summarise_expr(a$op, field_ref(a$field), ignore_unsupported)
    paste0(render_name(a$as), " = ", expr)
  }, character(1))

  groupby <- t$groupby
  if (is.null(groupby) || length(groupby) == 0) {
    return(c(notes, sprintf("%s <- dplyr::summarise(%s, %s)", var_name, var_name, paste(value_assigns, collapse = ", "))))
  }
  group_args <- paste(vapply(groupby, field_ref, character(1)), collapse = ", ")
  c(
    notes,
    sprintf("%s <- dplyr::group_by(%s, %s)", var_name, var_name, group_args),
    sprintf("%s <- dplyr::summarise(%s, %s, .groups = \"drop\")", var_name, var_name, paste(value_assigns, collapse = ", "))
  )
}

# Vega-Lite's `density` transform: a kernel density estimate of one field,
# replacing the data with (by default) `value`/`density` sample points
# tracing the estimated curve -- optionally per `groupby` group. R's
# `stats::density()` computes exactly this (a real KDE, not an
# approximation), so this is genuinely supported rather than a sacrifice:
#   - `bandwidth` maps directly to `bw`; omitted, both Vega-Lite and R's
#     "nrd0" default fall back to a similar Silverman's-rule-of-thumb
#     automatic bandwidth (not bit-for-bit identical, but the same idea).
#   - `extent` maps to `from`/`to`; omitted, both sides estimate over the
#     data's own range (plus a small margin).
#   - `steps` maps to `n` (defaulting to 200, Vega-Lite's own default,
#     rather than R's usual 512, for closer visual parity).
#   - `counts: true` rescales the density curve so its area equals the
#     sample count instead of integrating to 1 (Vega-Lite's own definition).
#   - `groupby` computes one density curve per distinct combination of
#     those fields, via dplyr::group_modify() (which conveniently
#     re-attaches the grouping columns to each group's output rows itself).
render_density_transform <- function(t, var_name) {
  field <- t$density
  as_names <- if (!is.null(t$as) && length(t$as) == 2) t$as else c("value", "density")
  value_name <- render_name(as_names[1])
  density_name <- render_name(as_names[2])
  bw_arg <- if (!is.null(t$bandwidth)) format_value(t$bandwidth) else '"nrd0"'
  n_arg <- if (!is.null(t$steps)) format_value(t$steps) else "200"
  extent_arg <- if (!is.null(t$extent)) {
    sprintf(", from = %s, to = %s", format_value(t$extent[[1]]), format_value(t$extent[[2]]))
  } else {
    ""
  }
  density_call <- function(data_var) {
    field_expr <- sprintf("%s[[%s]]", data_var, render_string(field))
    y_expr <- if (isTRUE(t$counts)) {
      sprintf(".k$y * length(stats::na.omit(%s))", field_expr)
    } else {
      ".k$y"
    }
    sprintf(
      "{ .k <- stats::density(%s, bw = %s, n = %s%s, na.rm = TRUE); data.frame(%s = .k$x, %s = %s) }",
      field_expr, bw_arg, n_arg, extent_arg, value_name, density_name, y_expr
    )
  }

  groupby <- t$groupby
  if (is.null(groupby) || length(groupby) == 0) {
    return(sprintf("%s <- (function(.d) %s)(%s)", var_name, density_call(".d"), var_name))
  }
  # group_modify()'s formula body sees the group's rows as `.x` (and the
  # group's key columns, unused here, as `.y`) -- and conveniently
  # re-attaches those key columns to each group's output rows itself, so
  # the groupby fields survive into the replaced data with no extra work.
  group_args <- paste(vapply(groupby, field_ref, character(1)), collapse = ", ")
  c(
    sprintf("%s <- dplyr::group_by(%s, %s)", var_name, var_name, group_args),
    sprintf("%s <- dplyr::group_modify(%s, ~ %s)", var_name, var_name, density_call(".x")),
    sprintf("%s <- dplyr::ungroup(%s)", var_name, var_name)
  )
}

# Vega-Lite's `window` transform: SQL-window-function-style per-row derived
# fields, computed within `groupby` partitions ordered by `sort`. Supports:
#   - row_number/rank/dense_rank (no `field`/`frame` needed -- purely
#     positional, based on partition order).
#   - lag/lead (an earlier/later row's own value, `param` rows away,
#     defaulting to 1).
#   - sum/mean/average/count/min/max/median (a `frame`-bounded aggregate:
#     `[null, null]` -- Vega-Lite's own default when `frame` is omitted --
#     is a whole-partition aggregate broadcast to every row; `[null, 0]`
#     is a running/cumulative aggregate from the partition's start through
#     the current row; any other numeric bound is a genuine sliding window
#     `frame[0]` rows before to `frame[1]` rows after the current one).
# Percentile/selection ops with no simple base-R equivalent (percent_rank,
# cume_dist, ntile, first_value/last_value/nth_value) aren't supported.
.window_positional_ops <- c("row_number", "rank", "dense_rank", "lag", "lead")
.window_aggregate_ops <- c("sum", "mean", "average", "count", "min", "max", "median")

is_supported_window_op <- function(op) op %in% c(.window_positional_ops, .window_aggregate_ops)

# The R expression (evaluated inside a dplyr::mutate() on the already
# sorted/grouped data) for one frame-bounded aggregate window field.
window_aggregate_expr <- function(op, field, frame) {
  # `count` has no `field` (it counts rows, not a column) -- every branch
  # below that actually uses `f` is for a different op, so it's safe to
  # leave it NULL rather than call field_ref() on a nonexistent field.
  f <- if (is.null(field)) NULL else field_ref(field)
  whole_partition <- is.null(frame) || (is.null(frame[[1]]) && is.null(frame[[2]]))
  cumulative <- !is.null(frame) && is.null(frame[[1]]) && identical(frame[[2]], 0)

  base_fn <- switch(op,
    sum = "sum", mean = , average = "mean", count = NA, min = "min", max = "max", median = "median"
  )
  if (whole_partition) {
    if (op == "count") return("dplyr::n()")
    return(sprintf("%s(%s, na.rm = TRUE)", base_fn, f))
  }
  if (cumulative) {
    return(switch(op,
      sum = sprintf("cumsum(%s)", f),
      count = "dplyr::row_number()",
      min = sprintf("cummin(%s)", f),
      max = sprintf("cummax(%s)", f),
      # mean/average/median have no base-R cumulative version -- computed
      # directly from the running window bounds instead, same as the
      # general sliding-window case just below.
      sprintf(
        "vapply(seq_along(%s), function(.i) %s(%s[seq_len(.i)], na.rm = TRUE), numeric(1))",
        f, if (op == "median") "median" else "mean", f
      )
    ))
  }
  # A genuine sliding window: `frame[1]` rows before to `frame[2]` rows
  # after the current row (either bound `NULL` means "to the partition's
  # own start/end"), recomputed at every row via a plain (uncompiled, but
  # this only runs once per chart render, not performance-critical) loop.
  lo_arg <- if (is.null(frame[[1]])) "1" else sprintf("max(1, .i + (%s))", format_value(frame[[1]]))
  hi_arg <- if (is.null(frame[[2]])) "dplyr::n()" else sprintf("min(dplyr::n(), .i + (%s))", format_value(frame[[2]]))
  agg_fn <- if (op == "count") "length" else if (op %in% c("mean", "average")) "mean" else base_fn
  sprintf(
    "vapply(seq_len(dplyr::n()), function(.i) %s(%s[(%s):(%s)], na.rm = TRUE), numeric(1))",
    agg_fn, f, lo_arg, hi_arg
  )
}

render_window_transform <- function(t, var_name, ignore_unsupported = FALSE) {
  groupby <- t$groupby %||% list()
  sort_spec <- t$sort %||% list()
  has_group <- length(groupby) > 0
  group_args <- if (has_group) paste(vapply(groupby, field_ref, character(1)), collapse = ", ") else NULL

  stmts <- character(0)
  if (has_group) {
    stmts <- c(stmts, sprintf("%s <- dplyr::group_by(%s, %s)", var_name, var_name, group_args))
  }
  if (length(sort_spec) > 0) {
    sort_args <- vapply(sort_spec, function(s) {
      ref <- field_ref(s$field)
      if (identical(s$order, "descending")) sprintf("dplyr::desc(%s)", ref) else ref
    }, character(1))
    by_group <- if (has_group) ", .by_group = TRUE" else ""
    stmts <- c(stmts, sprintf("%s <- dplyr::arrange(%s, %s%s)", var_name, var_name, paste(sort_args, collapse = ", "), by_group))
  }

  ops <- vapply(t$window, function(w) w$op, character(1))
  needs_ties <- any(ops %in% c("rank", "dense_rank"))
  if (needs_ties) {
    sort_fields <- if (length(sort_spec) > 0) vapply(sort_spec, function(s) field_ref(s$field), character(1)) else "dplyr::row_number()"
    stmts <- c(stmts, sprintf("%s <- dplyr::mutate(%s, .win_rn = dplyr::row_number(), .win_tie = dplyr::consecutive_id(%s))", var_name, var_name, paste(sort_fields, collapse = ", ")))
  }
  if ("rank" %in% ops) {
    regroup <- if (has_group) sprintf("%s, .win_tie", group_args) else ".win_tie"
    stmts <- c(
      stmts,
      sprintf("%s <- dplyr::group_by(%s, %s)", var_name, var_name, regroup),
      sprintf("%s <- dplyr::mutate(%s, .win_rank = min(.win_rn))", var_name, var_name),
      if (has_group) sprintf("%s <- dplyr::group_by(%s, %s)", var_name, var_name, group_args) else sprintf("%s <- dplyr::ungroup(%s)", var_name, var_name)
    )
  }

  assigns <- vapply(t$window, function(w) {
    as_name <- render_name(w$as)
    expr <- switch(w$op,
      row_number = "dplyr::row_number()",
      rank = ".win_rank",
      dense_rank = ".win_tie",
      lag = sprintf("dplyr::lag(%s, n = %s)", field_ref(w$field), if (!is.null(w$param)) format_value(w$param) else "1"),
      lead = sprintf("dplyr::lead(%s, n = %s)", field_ref(w$field), if (!is.null(w$param)) format_value(w$param) else "1"),
      window_aggregate_expr(w$op, w$field, t$frame)
    )
    sprintf("%s = %s", as_name, expr)
  }, character(1))
  stmts <- c(stmts, sprintf("%s <- dplyr::mutate(%s, %s)", var_name, var_name, paste(assigns, collapse = ", ")))

  if (needs_ties) {
    stmts <- c(stmts, sprintf("%s <- dplyr::select(%s, -.win_rn, -.win_tie)", var_name, var_name))
  }
  stmts <- c(stmts, sprintf("%s <- dplyr::ungroup(%s)", var_name, var_name))
  stmts
}

# Vega-Lite's `fold` transform: unpivot a fixed list of fields into one
# (key, value) pair of columns, producing one output row per (original row
# x folded field) -- every other column is copied through unchanged. `.f`
# needs a plain string (the field name itself) for `[[<-`, not the
# backtick-quoted-if-needed bare symbol render_name()/field_ref() return
# for aes()/mutate() use, so the "as" column names are inserted via `[[`
# with render_string() (a real R string literal) instead.
render_fold_transform <- function(t, var_name) {
  fields <- t$fold
  as_names <- if (!is.null(t$as) && length(t$as) == 2) t$as else c("key", "value")
  key_str <- render_string(as_names[1])
  value_str <- render_string(as_names[2])
  fields_vec <- paste(vapply(fields, render_string, character(1)), collapse = ", ")
  sprintf(
    "%s <- do.call(rbind, lapply(c(%s), function(.f) { .d <- %s; .d[[%s]] <- .f; .d[[%s]] <- .d[[.f]]; .d }))",
    var_name, fields_vec, var_name, key_str, value_str
  )
}

# `pivot` (fold's inverse: rows -> columns) needs real per-group
# bookkeeping (collect duplicates, aggregate them, keep a stable, possibly
# limited column ordering) that would be error-prone to re-derive inline on
# every call site -- delegated to the shared vl_pivot() runtime helper
# instead (see runtime.R); vegalite_to_ggplot()'s header adds the
# `library(vl2ggplot)` this needs whenever the generated code actually calls it.
render_pivot_transform <- function(t, var_name) {
  args <- c(
    var_name,
    render_string(t$pivot),
    render_string(t$value),
    sprintf("groupby = %s", format_value(t$groupby %||% list()))
  )
  if (!is.null(t$op)) args <- c(args, sprintf("op = %s", render_string(t$op)))
  if (!is.null(t$limit)) args <- c(args, sprintf("limit = %s", format_value(t$limit)))
  sprintf("%s <- vl_pivot(%s)", var_name, paste(args, collapse = ", "))
}

# ---- 2. inline encoding aggregate/bin/timeUnit ----


# `tooltip` is deliberately excluded: ggplot2 has no tooltip equivalent, so
# it's never rendered at all here (see build_layer_channels()) -- treating
# it as an implicit groupby dimension for aggregation would be pure
# guesswork about Vega-Lite's own (rarely-exercised) default-aggregate
# behavior for un-aggregated tooltip fields, for a channel this project
# drops on the floor anyway.
.position_like <- c(
  "x", "y", "x2", "y2", "color", "fill", "stroke", "size", "opacity",
  "shape", "detail", "text"
)

channel_entries <- function(encoding) {
  keys <- intersect(names(encoding), .position_like)
  keys[vapply(keys, function(k) {
    def <- encoding[[k]]
    is.list(def) && (!is.null(def$field) || identical(def$aggregate, "count"))
  }, logical(1))]
}

out_field_name <- function(field, suffix) if (is.null(field)) suffix else paste0(suffix, "_", field)

# See plan_layer_data()'s is_2d_bin check: both x and y binned, with a
# `count` aggregate elsewhere -- `bins` takes the real per-axis maxbins
# (falling back to ggplot2's own geom_bin2d()/stat_bin2d() default of 30
# when a side doesn't specify one, matching how plan_histogram() already
# falls back to a fixed bin count for the 1D case).
plan_2d_bin <- function(mark_type, encoding, agg_keys) {
  bin_count <- function(def) if (is.list(def$bin) && !is.null(def$bin$maxbins)) def$bin$maxbins else 30
  x_bins <- bin_count(encoding$x)
  y_bins <- bin_count(encoding$y)

  rewritten <- encoding
  rewritten$x$bin <- NULL
  rewritten$y$bin <- NULL
  extra_aes <- list()
  for (k in agg_keys) {
    rewritten[[k]] <- NULL
    # "color" (unlike "size", which is already ggplot2's own aes name) needs
    # the same fill-vs-colour routing build_layer_channels() uses for a
    # real color encoding -- geom_tile (the "rect" mark's geom) only has a
    # visible "fill"; geom_point only has "colour" (for its default,
    # unbordered shape).
    aes_name <- if (k == "color") color_channel_aes(mark_type) else k
    extra_aes[[aes_name]] <- "ggplot2::after_stat(count)"
  }

  list(
    statements = character(0), encoding = rewritten,
    extra_fixed = list(stat = '"bin2d"', bins = sprintf("c(%d, %d)", x_bins, y_bins)),
    extra_aes = extra_aes, use_histogram = FALSE
  )
}

# Returns list(statements, encoding, extra_fixed, extra_aes, use_histogram).
plan_layer_data <- function(mark_type, encoding, var_name, ignore_unsupported = FALSE) {
  keys <- channel_entries(encoding)
  agg_keys <- keys[vapply(keys, function(k) !is.null(encoding[[k]]$aggregate), logical(1))]
  bin_keys <- keys[vapply(keys, function(k) !is.null(encoding[[k]]$bin), logical(1))]
  tu_only_keys <- keys[vapply(keys, function(k) {
    !is.null(encoding[[k]]$timeUnit) && is.null(encoding[[k]]$aggregate) && is.null(encoding[[k]]$bin)
  }, logical(1))]
  plain_keys <- keys[vapply(keys, function(k) {
    is.null(encoding[[k]]$aggregate) && is.null(encoding[[k]]$bin) && is.null(encoding[[k]]$timeUnit)
  }, logical(1))]

  empty_plan <- list(statements = character(0), encoding = encoding, extra_fixed = list(), extra_aes = list(), use_histogram = FALSE)

  if (length(agg_keys) == 0 && length(bin_keys) == 0 && length(tu_only_keys) == 0) {
    # Nothing to aggregate/bin/timeUnit -- `encoding` here is the *merged*
    # encoding_effective (needed above only to detect this). A merged-in
    # channel with a real field/value/datum (e.g. a shared wrapper-level x/y
    # position) is kept, since every layer's aes() is rebuilt from this
    # returned encoding rather than relying on ggplot2's own aes
    # inheritance. But a channel that merged in nothing but axis/type
    # metadata (no field/value/datum at all, e.g. a wrapper's bare `{"type":
    # "quantitative"}` used only to configure a shared axis) is a phantom --
    # promoting it would make a layer that doesn't actually have this
    # channel look like it does.
    pruned <- encoding
    for (k in .position_like) {
      def <- pruned[[k]]
      if (!is.null(def) && is.list(def) && is.null(def$field) && is.null(def$value) && is.null(def$datum)) {
        pruned[[k]] <- NULL
      }
    }
    return(list(statements = character(0), encoding = pruned, extra_fixed = list(), extra_aes = list(), use_histogram = FALSE))
  }

  # Map-only: timeUnit with no aggregation anywhere -> a single mutate().
  if (length(agg_keys) == 0) {
    rewritten <- encoding
    assigns <- character(0)
    notes <- character(0)
    for (k in c(tu_only_keys, bin_keys)) {
      def <- encoding[[k]]
      if (!is.null(def$timeUnit)) {
        supported <- is_supported_timeunit(def$timeUnit)
        if (!supported && !ignore_unsupported) stop(sprintf('Unsupported timeUnit: "%s"', def$timeUnit))
        if (!supported) {
          notes <- c(notes, sprintf('# vl2ggplot: unsupported timeUnit "%s", left untruncated (ignore_unsupported)', def$timeUnit))
        }
        out <- out_field_name(def$field, timeunit_label(def$timeUnit))
        # `out` may still carry def$field's own escaping (e.g. "..._a\.b")
        # -- fine for the later field_ref(out) this project uses everywhere
        # else (it knows how to unescape), but render_name() here doesn't,
        # and a raw `\.` left inside a backtick-quoted mutate() assignment
        # target is an R *parse error* (backtick names parse escapes the
        # same way a string literal does), not just a lookup miss.
        assigns <- c(assigns, paste0(render_name(unescape_field_path(out)), " = ", timeunit_expr(def$timeUnit, field_ref(def$field), ignore_unsupported)))
        rewritten[[k]]$field <- out
        rewritten[[k]]$timeUnit <- NULL
      } else if (!is.null(def$bin)) {
        # A bin with nothing to aggregate against: leave the field as-is
        # (an honest simplification -- see vl2d3's binMapExpr for the same
        # call) rather than guessing a binning without an anchor.
        rewritten[[k]]$bin <- NULL
      }
    }
    if (length(assigns) > 0) {
      empty_plan$statements <- c(notes, sprintf("%s <- dplyr::mutate(%s, %s)", var_name, var_name, paste(assigns, collapse = ", ")))
    }
    empty_plan$encoding <- rewritten
    return(empty_plan)
  }

  # A genuine 2D histogram/heatmap: both x and y are binned, with a `count`
  # aggregate on some other channel (size, for a binned scatter, or color,
  # for a rect/tile heatmap) -- ggplot2's stat_bin2d() computes exactly this
  # natively (real 2D binning, not an approximation), overriding whichever
  # geom the mark normally maps to (geom_tile for "rect", geom_point for
  # "circle"/"point") with `stat = "bin2d"` and reading the count back via
  # `after_stat(count)` -- so this is genuinely supported, not a sacrifice,
  # and (like density()/window()) needs no ignore_unsupported gate at all.
  is_2d_bin <- all(c("x", "y") %in% bin_keys) &&
    length(agg_keys) > 0 &&
    all(vapply(agg_keys, function(k) identical(encoding[[k]]$aggregate, "count"), logical(1)))
  if (is_2d_bin) {
    return(plan_2d_bin(mark_type, encoding, agg_keys))
  }

  # From here, at least one channel aggregates.
  plan_notes <- character(0)
  bin_group_conflict <- length(bin_keys) > 1 || (length(bin_keys) == 1 && (length(plain_keys) > 0 || length(tu_only_keys) > 0))
  if (bin_group_conflict) {
    if (!ignore_unsupported) {
      stop("Unsupported: binning combined with additional groupby channels is not yet supported")
    }
    # Keep just the first binned channel and drop every other groupby
    # channel -- a plain histogram of that one field, rather than nothing.
    bin_keys <- bin_keys[seq_len(min(length(bin_keys), 1))]
    plain_keys <- character(0)
    tu_only_keys <- character(0)
    plan_notes <- c(plan_notes, "# vl2ggplot: unsupported binning combined with additional groupby channels, keeping only the binned channel (ignore_unsupported)")
  }

  if (length(bin_keys) == 1) {
    plan <- plan_histogram(mark_type, encoding, bin_keys[1], agg_keys, var_name, ignore_unsupported)
    plan$statements <- c(plan_notes, plan$statements)
    return(plan)
  }

  group_keys <- c(plain_keys, tu_only_keys)
  if (length(group_keys) > 2) {
    if (!ignore_unsupported) stop("Unsupported: aggregating grouped by more than 2 fields is not yet supported")
    group_keys <- group_keys[1:2]
    plan_notes <- c(plan_notes, "# vl2ggplot: unsupported aggregation grouped by more than 2 fields, keeping only the first 2 (ignore_unsupported)")
  }

  # All-stat-summary-compatible, exactly one aggregate channel, and *some*
  # discrete groupby channel to summarize within -- let the geom's own stat
  # do the work, no data pre-processing needed at all. With zero groupby
  # channels (e.g. a `rule` mark's single dataset-wide mean/sum line),
  # there's nothing for stat_summary/stat_count to group by, so that case
  # falls through to plan_explicit_aggregate()'s plain (groupless)
  # dplyr::summarise() instead, producing one pre-computed scalar row.
  # A `rule` mark's aggregated position channel gets renamed to
  # xintercept/yintercept by render_rule_layer(), which stat_summary()/
  # stat_count() can't target (they only compute plain x/y) -- so rule marks
  # always go through the explicit dplyr::summarise() path below instead,
  # the same one already used for a rule's groupless dataset-wide mean.
  # And stat_count()/stat_summary() only ever compute a plain x or y value --
  # an aggregate declared on a *non-position* channel (e.g. `color:
  # {"aggregate": "count"}` on a heatmap-style rect, colored/sized by count
  # rather than positioned by it) has nothing for either stat to target, so
  # that also needs the explicit dplyr path instead.
  if (length(agg_keys) == 1 && length(group_keys) > 0 && mark_type != "rule" && agg_keys %in% c("x", "y")) {
    op <- encoding[[agg_keys]]$aggregate
    if (op == "count" || is_stat_summary_op(op)) {
      plan <- plan_native_stat(encoding, agg_keys, op, group_keys, var_name, ignore_unsupported)
      plan$statements <- c(plan_notes, plan$statements)
      return(plan)
    }
  }

  plan <- plan_explicit_aggregate(encoding, agg_keys, group_keys, var_name, ignore_unsupported)
  plan$statements <- c(plan_notes, plan$statements)
  plan
}

plan_native_stat <- function(encoding, agg_key, op, group_keys, var_name, ignore_unsupported = FALSE) {
  rewritten <- encoding
  extra_fixed <- list()
  statements <- character(0)
  notes <- character(0)
  # A groupby channel with its own `timeUnit` (and no aggregate/bin of its
  # own -- e.g. a `color` channel bucketed by year) needs the same bucketing
  # mutate() the map-only path (above) applies: stat_summary()/stat_count()
  # group by whatever raw value the field already holds, so an un-bucketed
  # temporal field would group by its full per-row resolution (e.g. every
  # distinct day) instead of the requested per-year buckets.
  for (k in group_keys) {
    def <- encoding[[k]]
    if (is.null(def$timeUnit)) next
    supported <- is_supported_timeunit(def$timeUnit)
    if (!supported && !ignore_unsupported) stop(sprintf('Unsupported timeUnit: "%s"', def$timeUnit))
    if (!supported) {
      notes <- c(notes, sprintf('# vl2ggplot: unsupported timeUnit "%s", left untruncated (ignore_unsupported)', def$timeUnit))
      next
    }
    out <- out_field_name(def$field, timeunit_label(def$timeUnit))
    statements <- c(statements, sprintf(
      "%s <- dplyr::mutate(%s, %s = %s)",
      var_name, var_name, render_name(unescape_field_path(out)), timeunit_expr(def$timeUnit, field_ref(def$field), ignore_unsupported)
    ))
    rewritten[[k]]$field <- out
    rewritten[[k]]$timeUnit <- NULL
  }
  if (op == "count") {
    rewritten[[agg_key]] <- NULL # geom's default stat="count" supplies this aes itself
    # Set explicitly (even though it's already geom_bar's default) so
    # geoms.R's "does this layer already get a missing axis from its own
    # stat" check has a single, reliable signal to look for.
    extra_fixed[["stat"]] <- '"count"'
    if (agg_key == "x") extra_fixed[["orientation"]] <- '"y"'
  } else {
    extra_fixed[["stat"]] <- '"summary"'
    extra_fixed[["fun"]] <- render_string(stat_summary_fun_name(op))
    # stat_summary()'s default orientation ("x") groups by x and summarizes
    # y; when it's *x* being aggregated here (grouped by y instead), that
    # must be flipped or ggplot2 tries to summarize the (non-numeric)
    # groupby field instead.
    if (agg_key == "x") extra_fixed[["orientation"]] <- '"y"'
    rewritten[[agg_key]]$aggregate <- NULL
  }
  list(statements = c(notes, statements), encoding = rewritten, extra_fixed = extra_fixed, extra_aes = list(), use_histogram = FALSE)
}

plan_histogram <- function(mark_type, encoding, bin_key, agg_keys, var_name, ignore_unsupported = FALSE) {
  def <- encoding[[bin_key]]
  max_bins <- if (is.list(def$bin) && !is.null(def$bin$maxbins)) def$bin$maxbins else 30
  rewritten <- encoding
  rewritten[[bin_key]]$bin <- NULL
  # geom_histogram/stat_summary_bin always need real numeric input to bin,
  # regardless of Vega-Lite's own "ordinal" type label on a binned channel
  # (which is about ordering the resulting *bins*, not making the
  # underlying values discrete) -- factor()-wrapping it (as
  # discrete_field_ref() would for a plain ordinal/nominal field) breaks
  # stat_bin outright.
  rewritten[[bin_key]]$type <- "quantitative"

  if (length(agg_keys) == 0) {
    if (!ignore_unsupported) {
      stop("Unsupported: a binned channel with no aggregate value channel is not yet supported")
    }
    # Nothing to aggregate against -- a plain count histogram is a
    # reasonable default for "just show me the distribution of this field".
    return(list(
      statements = "# vl2ggplot: unsupported binned channel with no aggregate value channel, using a plain count histogram instead (ignore_unsupported)",
      encoding = rewritten,
      extra_fixed = list(bins = as.character(max_bins)), extra_aes = list(), use_histogram = TRUE
    ))
  }
  op <- encoding[[agg_keys[1]]]$aggregate
  rewritten[[agg_keys[1]]] <- NULL

  if (op == "count") {
    list(
      statements = character(0), encoding = rewritten,
      extra_fixed = list(bins = as.character(max_bins)), extra_aes = list(), use_histogram = TRUE
    )
  } else if (is_stat_summary_op(op) || ignore_unsupported) {
    fun_name <- if (is_stat_summary_op(op)) stat_summary_fun_name(op) else "mean"
    note <- if (!is_stat_summary_op(op)) {
      sprintf('# vl2ggplot: unsupported aggregate op "%s" for a binned channel, using mean instead (ignore_unsupported)', op)
    } else character(0)
    list(
      statements = note, encoding = rewritten,
      extra_fixed = list(stat = '"summary_bin"', fun = render_string(fun_name), bins = as.character(max_bins)),
      extra_aes = setNames(list(field_ref(encoding[[agg_keys[1]]]$field)), "y"),
      use_histogram = FALSE
    )
  } else {
    stop(sprintf('Unsupported aggregate op for a binned channel: "%s"', op))
  }
}

# ---- errorbar/errorband "extent" (implicit mean/median +/- a computed
# range, with no explicit xError/x2-style channel at all) ----

# Which of x/y is the plain continuous "value" channel needing an implicit
# range -- has a field, no aggregate, and no already-explicit range
# channel of its own (xError/x2/etc, handled by geoms.R's error_bounds()
# instead). Returns NULL if neither axis qualifies (e.g. this errorbar
# already uses an explicit range channel).
error_extent_axis <- function(encoding) {
  for (axis in c("x", "y")) {
    def <- encoding[[axis]]
    if (is.null(def) || is.null(def$field) || !is.null(def$aggregate)) next
    if (!is.null(encoding[[paste0(axis, "Error")]]) || !is.null(encoding[[paste0(axis, "2")]])) next
    if (!is.null(def$type) && !identical(def$type, "quantitative")) next
    # A channel with its own `timeUnit` is a date-bucketing/groupby key (the
    # errorband's shared x-axis), not the continuous value to summarize --
    # skip it so the real value axis (the other one) is picked instead.
    if (!is.null(def$timeUnit)) next
    return(axis)
  }
  NULL
}

# Vega-Lite's own default `extent` (when the mark doesn't specify one and
# no explicit xError/x2-style range channel is used either) is "stderr".
needs_error_extent <- function(mark_type, mark_props, encoding) {
  mark_type %in% c("errorbar", "errorband") && !is.null(error_extent_axis(encoding))
}

# Vega-Lite's `extent` values, mapped to a lo/hi bound expression over a
# field-accessor expression. `ci` is an approximate normal-theory 95%
# interval (Vega-Lite's own default uses a bootstrap) -- a documented
# simplification, not an exact match.
extent_bounds_expr <- function(extent, f, ignore_unsupported = FALSE) {
  if (ignore_unsupported && !(extent %in% c("stdev", "stderr", "ci", "iqr"))) extent <- "stderr"
  switch(extent,
    stdev = list(
      lo = sprintf("mean(%s, na.rm = TRUE) - stats::sd(%s, na.rm = TRUE)", f, f),
      hi = sprintf("mean(%s, na.rm = TRUE) + stats::sd(%s, na.rm = TRUE)", f, f)
    ),
    stderr = list(
      lo = sprintf("mean(%s, na.rm = TRUE) - stats::sd(%s, na.rm = TRUE) / sqrt(sum(!is.na(%s)))", f, f, f),
      hi = sprintf("mean(%s, na.rm = TRUE) + stats::sd(%s, na.rm = TRUE) / sqrt(sum(!is.na(%s)))", f, f, f)
    ),
    ci = list(
      lo = sprintf("mean(%s, na.rm = TRUE) - 1.96 * stats::sd(%s, na.rm = TRUE) / sqrt(sum(!is.na(%s)))", f, f, f),
      hi = sprintf("mean(%s, na.rm = TRUE) + 1.96 * stats::sd(%s, na.rm = TRUE) / sqrt(sum(!is.na(%s)))", f, f, f)
    ),
    iqr = list(
      lo = sprintf("stats::quantile(%s, 0.25, na.rm = TRUE, names = FALSE)", f),
      hi = sprintf("stats::quantile(%s, 0.75, na.rm = TRUE, names = FALSE)", f)
    ),
    stop(sprintf('Unsupported: errorbar/errorband extent "%s"', extent))
  )
}

# Groupby fields for the extent computation: the *other* axis (if it's a
# plain categorical field) plus color/detail, mirroring which channels
# act as an implicit groupby elsewhere in this file. `extra_fields` folds in
# a dodged/grouped position offset (xOffset/yOffset) -- it's not a channel
# `encoding` itself carries by the time this runs (prepare_unit strips it
# before building the ggplot2 aes(), since ggplot2 has no such aes), but the
# extent still needs to be computed *per offset group*, or a shared-across-
# groups extent band gets dodged in the final aes() with nothing behind it
# to justify the split (a `group` referencing a column this data frame
# never grouped by at all).
error_extent_group_fields <- function(encoding, value_axis, extra_fields = character(0)) {
  other_axis <- if (value_axis == "x") "y" else "x"
  fields <- character(0)
  for (ch in c(other_axis, "color", "detail")) {
    def <- encoding[[ch]]
    if (!is.null(def) && !is.null(def$field) && is.null(def$aggregate)) fields <- c(fields, def$field)
  }
  unique(c(fields, extra_fields))
}

apply_error_extent <- function(mark_props, encoding, var_name, ignore_unsupported = FALSE, extra_group_fields = character(0)) {
  axis <- error_extent_axis(encoding)
  field <- encoding[[axis]]$field
  f <- field_ref(field)
  extent <- mark_props$extent %||% "stderr"
  bounds <- extent_bounds_expr(extent, f, ignore_unsupported)
  note <- if (ignore_unsupported && !(extent %in% c("stdev", "stderr", "ci", "iqr"))) {
    sprintf('# vl2ggplot: unsupported errorbar/errorband extent "%s", using stderr instead (ignore_unsupported)', extent)
  } else character(0)

  lo_field <- out_field_name(field, "lo")
  hi_field <- out_field_name(field, "hi")
  # lo_field/hi_field may still carry `field`'s own escaping (see the
  # out_field_name()/render_name() comment above in render_one_transform) --
  # render_name() doesn't undo it, so it must happen here explicitly.
  value_assigns <- sprintf(
    "%s = %s, %s = %s", render_name(unescape_field_path(lo_field)), bounds$lo, render_name(unescape_field_path(hi_field)), bounds$hi
  )

  group_fields <- error_extent_group_fields(encoding, axis, extra_group_fields)
  rewritten <- encoding
  rewritten[[axis]] <- list(field = lo_field, type = "quantitative")
  rewritten[[paste0(axis, "2")]] <- list(field = hi_field, type = "quantitative")

  if (length(group_fields) == 0) {
    stmts <- sprintf("%s <- dplyr::summarise(%s, %s)", var_name, var_name, value_assigns)
  } else {
    group_refs <- vapply(group_fields, field_ref, character(1))
    stmts <- c(
      sprintf("%s <- dplyr::group_by(%s, %s)", var_name, var_name, paste(group_refs, collapse = ", ")),
      sprintf("%s <- dplyr::summarise(%s, %s, .groups = \"drop\")", var_name, var_name, value_assigns)
    )
  }

  list(statements = c(note, stmts), encoding = rewritten)
}

plan_explicit_aggregate <- function(encoding, agg_keys, group_keys, var_name, ignore_unsupported = FALSE) {
  notes <- character(0)
  if (length(group_keys) > 2) {
    if (!ignore_unsupported) stop("Unsupported: aggregating grouped by more than 2 fields is not yet supported")
    group_keys <- group_keys[1:2]
    notes <- c(notes, "# vl2ggplot: unsupported aggregation grouped by more than 2 fields, keeping only the first 2 (ignore_unsupported)")
  }
  if (!ignore_unsupported) {
    for (k in agg_keys) {
      op <- encoding[[k]]$aggregate
      if (op != "count" && !is_supported_aggregate_op(op)) stop(sprintf('Unsupported aggregate op: "%s"', op))
    }
  } else {
    # See render_aggregate_transform()'s identical guard: a compound
    # argmin/argmax op (a list, not a plain string) is excluded here --
    # aggregate_summarise_expr() below always rejects it outright regardless
    # of ignore_unsupported, so it's not a "fell back to mean" case.
    unsupported_ops <- unique(vapply(agg_keys, function(k) {
      op <- encoding[[k]]$aggregate
      if (is.character(op) && op != "count" && !is_supported_aggregate_op(op)) op else NA_character_
    }, character(1)))
    unsupported_ops <- unsupported_ops[!is.na(unsupported_ops)]
    notes <- c(notes, sprintf('# vl2ggplot: unsupported aggregate op "%s", using mean instead (ignore_unsupported)', unsupported_ops))
  }

  rewritten <- encoding
  group_field_refs <- character(0)
  pre_assigns <- character(0)
  for (k in group_keys) {
    def <- encoding[[k]]
    if (!is.null(def$timeUnit)) {
      supported <- is_supported_timeunit(def$timeUnit)
      if (!supported && !ignore_unsupported) stop(sprintf('Unsupported timeUnit: "%s"', def$timeUnit))
      if (!supported) {
        notes <- c(notes, sprintf('# vl2ggplot: unsupported timeUnit "%s", left untruncated (ignore_unsupported)', def$timeUnit))
      }
      out <- out_field_name(def$field, timeunit_label(def$timeUnit))
      # See the identical comment on the other out_field_name()/render_name()
      # pairing above -- `out` may still carry def$field's own escaping, which
      # render_name() (unlike field_ref()) doesn't undo.
      pre_assigns <- c(pre_assigns, paste0(render_name(unescape_field_path(out)), " = ", timeunit_expr(def$timeUnit, field_ref(def$field), ignore_unsupported)))
      group_field_refs <- c(group_field_refs, render_name(unescape_field_path(out)))
      rewritten[[k]]$field <- out
      rewritten[[k]]$timeUnit <- NULL
    } else {
      group_field_refs <- c(group_field_refs, field_ref(def$field))
    }
  }

  value_assigns <- vapply(agg_keys, function(k) {
    def <- encoding[[k]]
    out <- if (def$aggregate == "count") "count" else out_field_name(def$field, def$aggregate)
    rewritten[[k]]$field <<- out
    rewritten[[k]]$aggregate <<- NULL
    expr <- if (def$aggregate == "count") "dplyr::n()" else aggregate_summarise_expr(def$aggregate, field_ref(def$field), ignore_unsupported)
    # `out` may still carry def$field's own escaping (see the
    # out_field_name()/render_name() comment above for the timeUnit case).
    paste0(render_name(unescape_field_path(out)), " = ", expr)
  }, character(1))

  stmts <- notes
  if (length(pre_assigns) > 0) {
    stmts <- c(stmts, sprintf("%s <- dplyr::mutate(%s, %s)", var_name, var_name, paste(pre_assigns, collapse = ", ")))
  }
  if (length(group_field_refs) > 0) {
    stmts <- c(stmts, sprintf("%s <- dplyr::group_by(%s, %s)", var_name, var_name, paste(group_field_refs, collapse = ", ")))
    stmts <- c(stmts, sprintf("%s <- dplyr::summarise(%s, %s, .groups = \"drop\")", var_name, var_name, paste(value_assigns, collapse = ", ")))
  } else {
    stmts <- c(stmts, sprintf("%s <- dplyr::summarise(%s, %s)", var_name, var_name, paste(value_assigns, collapse = ", ")))
  }

  list(statements = stmts, encoding = rewritten, extra_fixed = list(), extra_aes = list(), use_histogram = FALSE)
}
