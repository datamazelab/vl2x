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
  unique(c(from_encoding, from_tu_transform[!is.na(from_tu_transform)], from_calc, from_filter))
}

extract_date_function_fields <- function(expr) {
  pattern <- paste0("\\b(", paste(names(.date_funcs), collapse = "|"), ")\\s*\\(\\s*datum\\.([A-Za-z_][A-Za-z0-9_.]*)\\s*\\)")
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
prepare_unit <- function(node, emitter, hint, inherited_data_var = NULL, inherited_encoding = list(), ignore_unsupported = FALSE, inherited_offset_field = NULL) {
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
    coercion <- render_temporal_coercion(work_var, temporal_fields)
    if (length(coercion)) emit(emitter, coercion)

    if (!is.null(node$transform)) emit(emitter, render_transforms(node$transform, work_var, ignore_unsupported))
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
    plan_layer_data(mark_type, encoding_effective, work_var, ignore_unsupported)
  } else {
    list(statements = character(0), encoding = encoding, extra_fixed = list(), extra_aes = list(), use_histogram = FALSE)
  }
  if (length(plan$statements)) emit(emitter, plan$statements)

  extra_fixed <- plan$extra_fixed
  extra_aes <- plan$extra_aes
  if (!is.null(offset_field)) {
    extra_fixed <- dodge_extra_fixed(extra_fixed)
    extra_aes <- dodge_extra_aes(extra_aes, offset_field)
  }

  list(
    data_var = data_var, encoding = plan$encoding, original_encoding = encoding,
    mark = node$mark, extra_fixed = extra_fixed, extra_aes = extra_aes,
    use_histogram = plan$use_histogram
  )
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
dodge_extra_fixed <- function(extra_fixed) {
  extra_fixed[["position"]] <- extra_fixed[["position"]] %||% '"dodge2"'
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
    for (enc in encodings_for_scales) {
      def <- enc[[channel]]
      if (!is.null(def)) {
        mark_type <- attr(enc, "mark_type") %||% "point"
        calls <- build_scale_calls(channel, def, mark_type, ignore_unsupported, notes_env)
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
  prepared <- prepare_unit(spec, emitter, hint, ignore_unsupported = ignore_unsupported)
  if (is.null(prepared$data_var)) stop("A view must have a data source")

  plot_var <- new_var(emitter, hint)
  emit(emitter, sprintf("%s <- ggplot2::ggplot(%s)", plot_var, prepared$data_var))

  geom <- render_geom_layer(prepared$mark, prepared$encoding, NULL, list(extra_fixed = prepared$extra_fixed, extra_aes = prepared$extra_aes, use_histogram = prepared$use_histogram), ignore_unsupported)
  emit(emitter, geom$notes)
  emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, geom$code))
  mark_type0 <- if (is.character(prepared$mark)) prepared$mark else prepared$mark$type
  if (identical(mark_type0, "arc")) {
    emit(emitter, sprintf('%s <- %s + ggplot2::coord_polar(theta = "y")', plot_var, plot_var))
  }

  enc_for_scale <- prepared$encoding
  attr(enc_for_scale, "mark_type") <- if (is.character(prepared$mark)) prepared$mark else prepared$mark$type
  apply_common(plot_var, spec, emitter, list(enc_for_scale), ignore_unsupported)

  facet_def <- extract_facet_channels(prepared$original_encoding)
  if (!is.null(facet_def)) {
    emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, render_facet_call(facet_def)))
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

extract_facet_channels <- function(encoding) {
  if (!is.null(encoding$facet)) return(encoding$facet)
  if (!is.null(encoding$row) || !is.null(encoding$column)) {
    return(list(row = encoding$row, column = encoding$column))
  }
  NULL
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
    coercion <- render_temporal_coercion(wrapper_data_var, temporal_fields)
    if (length(coercion)) emit(emitter, coercion)
    if (!is.null(spec$transform)) emit(emitter, render_transforms(spec$transform, wrapper_data_var, ignore_unsupported))
  }

  base_call <- if (!is.null(wrapper_data_var)) {
    if (!is.null(base_aes_call)) sprintf("ggplot2::ggplot(%s, %s)", wrapper_data_var, base_aes_call) else sprintf("ggplot2::ggplot(%s)", wrapper_data_var)
  } else {
    if (!is.null(base_aes_call)) sprintf("ggplot2::ggplot() + ggplot2::aes(%s)", base_aes_call) else "ggplot2::ggplot()"
  }
  emit(emitter, sprintf("%s <- %s", plot_var, base_call))

  encodings_for_scales <- list()
  facet_def <- extract_facet_channels(wrapper_encoding)

  for (i in seq_along(layer_children)) {
    child <- layer_children[[i]]
    prepared <- prepare_unit(
      child, emitter, sprintf("%s%d", base_hint, i),
      inherited_data_var = wrapper_data_var, inherited_encoding = wrapper_encoding,
      ignore_unsupported = ignore_unsupported, inherited_offset_field = wrapper_offset_field
    )
    data_arg <- prepared$data_var # NULL means "inherit the plot's data"
    geom <- render_geom_layer(
      prepared$mark, prepared$encoding, data_arg,
      list(extra_fixed = prepared$extra_fixed, extra_aes = prepared$extra_aes, use_histogram = prepared$use_histogram),
      ignore_unsupported
    )
    emit(emitter, geom$notes)
    emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, geom$code))

    mark_type_i <- if (is.character(prepared$mark)) prepared$mark else prepared$mark$type
    enc <- prepared$encoding
    attr(enc, "mark_type") <- mark_type_i
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
    emit(emitter, sprintf("%s <- %s + %s", plot_var, plot_var, render_facet_call(facet_def)))
  }

  plot_var
}

translate_facet <- function(spec, emitter, hint, ignore_unsupported = FALSE) {
  child_hint <- if (identical(hint, "chart")) "view" else paste0(hint, "_view")
  child_spec <- inherit_wrapper(spec$spec, spec)
  child_var <- translate_spec(child_spec, emitter, child_hint, ignore_unsupported)

  plot_var <- new_var(emitter, hint)
  emit(emitter, sprintf("%s <- %s + %s", plot_var, child_var, render_facet_call(spec$facet, spec$columns)))
  plot_var
}

translate_repeat <- function(spec, emitter, hint, ignore_unsupported = FALSE) {
  rep_fields <- spec[["repeat"]]
  is_row_col <- is.list(rep_fields) && !is.null(names(rep_fields))
  if (is_row_col && !ignore_unsupported) {
    stop("Unsupported: repeat with row/column/layer mapping is not yet supported (only a flat repeat field list is)")
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

substitute_repeat_field <- function(node, field) {
  if (is.list(node)) {
    if (!is.null(node[["repeat"]]) && is.character(node[["repeat"]]) && length(node) == 1) return(field)
    for (n in names(node)) node[[n]] <- substitute_repeat_field(node[[n]], field)
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
    for (n in names(node)) node[[n]] <- substitute_repeat_fields(node[[n]], values)
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
  emitter <- new_emitter()
  final_var <- translate_spec(spec, emitter, chart_var, ignore_unsupported)

  header <- c("library(ggplot2)", "")
  body <- emitter$lines
  tail <- if (!identical(final_var, chart_var)) sprintf("%s <- %s", chart_var, final_var) else NULL

  paste(c(header, body, "", tail, "", chart_var), collapse = "\n")
}
