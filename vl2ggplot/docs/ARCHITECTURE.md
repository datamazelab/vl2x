# Architecture and design notes

This document explains *how* `vl2ggplot` translates a Vega-Lite spec into
ggplot2 R code, why its design differs from its siblings
[`vl2altair`](../../vl2altair)/[`vl2vlapi`](../../vl2vlapi) (mechanical,
near-100%) and [`vl2d3`](../../vl2d3) (hand-built, deliberately narrow), and
the bugs that real execution against a large spec corpus caught along the
way. For usage, see [`../README.md`](../README.md).

## Two grammars of graphics, not one

`vl2altair`/`vl2vlapi` target libraries that *are* Vega-Lite — Altair and
vega-lite-api both compile down to a real Vega-Lite spec, so almost every
property maps onto a same-named (or documented-alias) method, and the real
Vega-Lite compiler does the actual semantic work. `vl2d3` targets a toolkit
with no grammar-of-graphics layer at all, so it has to implement scale
inference, mark drawing, and data aggregation completely by hand.

ggplot2 is neither of those. It's a *second, independent* implementation of
"grammar of graphics" — the same conceptual lineage Vega-Lite itself draws
on (Wilkinson's *The Grammar of Graphics*, via Hadley Wickham's 2010 paper)
— which is why so much of Vega-Lite's model maps onto it directly (a mark is
a `geom_*()`, an encoding channel is an `aes()` mapping, a scale is a
`scale_*()` call, `facet` is `facet_wrap()`/`facet_grid()`). But it's a
*different* grammar, with its own vocabulary and its own gaps relative to
Vega-Lite's:

- ggplot2 has no notion of Vega-Lite's inline `{"aggregate": "mean", "field":
  ...}` encoding shorthand — but it has its own, more general mechanism for
  the same idea (`stat_*()` layers), which can express most of the same
  cases *if* you pick the right one and set its parameters correctly.
- ggplot2 has no `extent`-on-a-mark for error bars/bands the way Vega-Lite
  does — you compute the bounds yourself and hand them to `geom_errorbar()`/
  `geom_ribbon()` as `ymin`/`ymax` aesthetics.
- ggplot2 (via R) distinguishes atomic vectors from lists in a way JS/Python
  don't have to think about, which affects how literal values round-trip
  into source code at all.

So this project is real translation work — closer in spirit to `vl2d3` than
to `vl2altair`/`vl2vlapi` — but because the *target* grammar is so much
richer than D3, its practical coverage of the same 633-spec corpus (523/633
OK) sits much closer to its mechanical siblings than to `vl2d3`'s 408/633.

## Shared runtime helpers (`R/runtime.R`)

Most generated code only needs `library(ggplot2)`/`dplyr` — but a transform
substantial enough that re-deriving its logic inline in every generated
script would be error-prone (`pivot`'s per-group column-spreading with
duplicate-cell aggregation; the JS-truthy semantics a bare-expression
filter like `"datum.field"` relies on, which `dplyr::filter()`'s
strict-logical requirement doesn't share) is instead a real, independently-
readable exported package function (`vl_pivot()`, `vl_truthy()`), called by
name from the generated script. Unlike `vl2d3`'s equivalent (`runtime.js`,
a plain file copied alongside each generated output since there's no
install step for generated JS to depend on), a generated R script already
runs somewhere `vl2ggplot` is installed — that's how `vegalite_to_ggplot()`
produced it — so the mechanism is just `library(vl2ggplot)` in the header,
added automatically (and only) when the generated body actually calls one
of these.

## The aggregate/bin/timeUnit dual path (`transforms.R`)

Vega-Lite lets `aggregate`/`bin`/`timeUnit` be declared *inline on an
encoding channel* — e.g. `{"y": {"aggregate": "mean", "field": "Rating"}}` —
and expects the renderer to group/summarize/derive accordingly. Unlike
`vl2d3` (which always has to pre-materialize this into transformed data,
since D3 has no aggregation stats of its own), ggplot2 has built-in stats
that do this *declaratively as part of the geom layer itself* —
`stat_count()`, `stat_summary()`, `stat_summary_bin()` (bin + a
`stat_summary`-compatible aggregate), `geom_histogram()` (bin + count) — so
`plan_layer_data()` tries that route first, with **zero data pre-processing
at all**, and only falls back to an explicit
`dplyr::group_by()`+`summarise()` pre-computation (mirroring `vl2d3`'s own
approach) for shapes those stats can't express:

1. Exactly one aggregate channel, `op` is `count` or one of the
   `stat_summary`-compatible ops (sum/mean/median/min/max), and there's at
   least one plain groupby channel → the geom's own `stat_count`/
   `stat_summary`, no data touched.
2. Exactly one **binned** channel with a `count`/summary-compatible
   aggregate and no other groupby → `geom_histogram()` (count) or
   `stat_summary_bin()`.
3. Anything else with at least one real aggregate (a **groupless**
   aggregate — e.g. a `rule` mark's dataset-wide mean — an aggregate op
   `stat_summary` can't compute like `stdev`/`distinct`/`q1`, or 2+ groupby
   channels) → explicit `dplyr::group_by()`+`summarise()`, with the
   encoding rewritten to reference the summarised output field names.
4. `timeUnit` with no aggregation anywhere → a plain `dplyr::mutate()`
   deriving the truncated field, no grouping at all.

Two orientation subtleties this dispatch has to get right, because
ggplot2's stats default to assuming you're grouped by `x` and summarizing
`y`:

- `stat_summary()`/`stat_count()` need `orientation = "y"` set explicitly
  whenever the aggregated channel is `x` (not `y`) — otherwise ggplot2 tries
  to summarize the (non-numeric) groupby field instead.
- A `rule` mark's aggregated position channel gets renamed to
  `xintercept`/`yintercept` by the mark-specific renderer (`geoms.R`), which
  `stat_summary()` can't target (it only ever computes plain `x`/`y`) — so
  `rule` marks always take the explicit-`dplyr` path (case 3), never the
  native-stat path (case 1), regardless of whether they'd otherwise
  qualify.

## Error bars/bands: three different shapes, one dispatch (`geoms.R`, `transforms.R`)

Vega-Lite has three ways to specify an error bar/band's range, and ggplot2
needs the same `ymin`/`ymax` (or `xmin`/`xmax`) aesthetic regardless of which
one was used:

1. **Explicit `xError`/`yError`** (symmetric offset) or **+`xError2`/
   `yError2`** (asymmetric offsets, both *added* to the base value per
   Vega-Lite's own semantics — `xError2` is an offset, not itself the upper
   bound) — computed arithmetically from the base value plus the offset
   field(s) (`error_bounds()` in `geoms.R`).
2. **Explicit `x2`/`y2`** — the two bounds directly; same code path as (1),
   just without the arithmetic.
3. **No explicit channel at all**, only a mark-level `extent` (or nothing —
   Vega-Lite's own implicit default is `stderr`) — the value axis is
   auto-detected (`error_extent_axis()`: the one plain, non-aggregated,
   quantitative-or-untyped channel with no Error/2 companion) and a real
   `dplyr::group_by()`+`summarise()` computes `mean ± <extent>` bounds
   (`apply_error_extent()` in `transforms.R`) — `stdev`/`stderr` are exact;
   `ci` uses a normal-theory `1.96 * sd/sqrt(n)` approximation rather than
   Vega-Lite's own bootstrap (documented in the README); `iqr` uses
   `stats::quantile()`.

Getting the *other* axis right matters as much as the range itself: a bar
mark with an `x2` companion against a categorical y-axis (a Gantt-chart
shape) can't use `geom_rect()` (which needs a numeric box on both axes) —
`geom_linerange()` with a widened `linewidth` is the standard ggplot2
workaround for a "thick bar" at a discrete position, and is used whenever
only one axis has a genuine range. A **1D** error band/bar with *no*
companion axis at all (e.g. a single global mean±stdev band meant to span
the whole plot) can't use a fake categorical `x = ""` either, once it's
layered against another series with a real continuous x — that would force
a discrete x scale and break as soon as the other layer's real numeric x
tries to share it. `geom_ribbon()` still requires *some* `x`/`y` aesthetic
even with `xmin`/`xmax` supplied, so the fix is an arbitrary numeric
constant (`x = 0`) alongside fixed (non-aes) `xmin = -Inf, xmax = Inf`,
which spans the full plot width without constraining the shared scale at
all.

## Layer-encoding inheritance: merge for detection, not for rendering (`translator.R`)

A Vega-Lite `layer` child can declare only *part* of what it needs and
inherit the rest from the shared wrapper-level `encoding` — e.g. a
wrapper-level `x` shared by every child, with each child only declaring its
own `y`. ggplot2 supports the same idea natively (a layer with no
`mapping =` inherits the plot-level `aes()`), so most of the time nothing
extra is needed. But **detecting** whether a child needs data-level
preparation — is *this* channel aggregated? binned? does an error-extent
computation need to group by a field the child doesn't declare itself? — has
to look at the *merged* view (child's own encoding layered over the
wrapper's), or a child whose aggregate/error-extent logic depends on a
wrapper-only field silently drops it.

`prepare_unit()` therefore computes `encoding_effective <-
utils::modifyList(inherited_encoding, encoding)` and uses it for exactly
that detection (`needs_prep`, `needs_error_extent()`, `plan_layer_data()`'s
groupby-field collection) — but the encoding it hands back for actual
*rendering* deliberately does **not** just become `encoding_effective`
wholesale. A wrapper channel that merged in only axis/type metadata (no
`field`/`value`/`datum` at all — e.g. a wrapper's bare `{"type":
"quantitative"}` used only to configure a shared axis) is a phantom: nothing
was computed for it, and promoting it into a child's own encoding makes a
layer that doesn't actually have that channel *look* like it does (breaking,
for instance, the geom-selection logic that decides `geom_bar` vs.
`geom_col` based on whether `y` is present). `plan_layer_data()`'s no-op
branch (nothing to aggregate/bin/timeUnit) prunes exactly those
phantom channels back out before returning; a channel that *does* carry a
real value (even if only declared on the wrapper) is kept, since every
layer's `aes()` is rebuilt from its own returned encoding rather than
relying on ggplot2's inheritance for anything the translator itself already
computed.

## R-specific literal rendering (`literals.R`)

Unlike JS or Python, R distinguishes atomic vectors (`c(1, 2, 3)`, every
element the same primitive mode) from lists (`list(1, "a", list(...))`, any
mix) — a JSON array becomes `c(...)` only when every element is a scalar of
the same atomic type, and `list(...)` otherwise (same as a JSON object,
which is always a named list). Getting this wrong produces R that's
syntactically valid but semantically wrong in ways that don't always error
immediately.

A field name that isn't a syntactically valid R identifier (spaces,
leading digits, ...) needs backtick-quoting for dplyr's non-standard
evaluation (`` `Fighter Name` ``) — but R's default `data.frame()`/
`read.csv()`/`read.delim()` silently *sanitize* column names
(`check.names = TRUE` by default, turning `"Fighter Name"` into
`"Fighter.Name"`), which breaks a backtick-quoted reference built against
the *original* name. Every data-loading call site passes
`check.names = FALSE` to prevent this.

R's `$`/`[[` on a **list** partial-match a name by default in some contexts
(and `list(a = NULL)` still registers the name `"a"` with a `NULL` value) —
a real bug source when checking "does this field exist" without also
checking "is it non-NULL." `facet.R`'s row/column lookup was written once
using exact-match-only accessors specifically because of this.

## Other bugs corpus validation caught

A representative sample, because each says something about a class of
mistake that reading the generator in isolation wouldn't catch:

- **A dead-code groupby rewrite.** `plan_explicit_aggregate()`'s per-group
  `timeUnit` handling computed the `dplyr::mutate()` assignment expression
  needed to derive the groupby field (e.g. `month_date = ...`) into a local
  variable — but never appended it to the emitted statement list. The
  subsequent `dplyr::group_by(month_date)` referenced a column that was
  never created, failing with "column not found" only at generated-code
  *execution* time, since the translator itself never inspects whether a
  referenced column exists.
- **Wrong error-extent axis when a groupby channel looks like a value
  channel.** `error_extent_axis()` originally picked the *first* channel
  (checking `x` before `y`) satisfying "has a field, isn't aggregated, isn't
  explicitly non-quantitative" — but a `timeUnit`'d date/categorical axis
  satisfies that same loose test (no explicit `"type"` is required), so a
  chart with `x: {field, timeUnit}` (the real groupby) and `y: {field}` (the
  real value needing mean±extent) had the two swapped, computing an error
  band across dates instead of across the actual measurement. Fixed by
  excluding any channel with its own `timeUnit` from candidacy — that's
  structurally a bucketing key, never the continuous value being
  summarized.
- **Numeric temporal values treated as days instead of milliseconds.**
  Vega-Lite (like JS) always represents a temporal field's raw numeric value
  as epoch *milliseconds*; `as.Date()`'s own numeric form expects
  days-since-origin. The initial temporal coercion passed the raw number
  straight through, silently producing a date off by roughly a factor of
  86,400,000 (an obviously-wrong but not obviously-erroring result — the
  code ran fine and produced *a* date, just the wrong one). Both direct
  field coercion and a date-typed scale `domain` (which uses the same raw
  epoch-ms convention) needed the `/ 86400000` fix.
- **`if(cond, a, b)` — the function-call spelling of a ternary.** Vega
  expressions can write a conditional as `cond ? a : b` *or* as a function
  call, `if(cond, a, b)`, and the two aren't interchangeable syntax for the
  same parser step — only the ternary form was handled. A nested
  `if(a, 0, if(b, 1, 2))` (a 3-way categorical mapping) needed a second,
  independent parser (`rewrite_if_calls()`, using the same quote/paren-aware
  scanning as the ternary parser) that recurses into each extracted
  argument, since the else-branch can itself be another `if(...)` call.
- **Array-valued inline data cells.** A `"flatten"`-transform-oriented spec
  (an explicitly unsupported transform type) has array-valued fields in its
  raw inline data (e.g. `{"foo": [1, 2]}`) — but the crash happened *before*
  the transform-type check ever ran, inside the literal renderer's
  `is.na(x)` check, which requires length-1 input and throws a confusing
  "condition has length > 1" on a multi-element cell. Fixed by making
  `render_scalar()` delegate to the general list/vector-aware renderer
  (`format_value()`) for any non-scalar input, so data loading always
  succeeds and the *actual* unsupported-feature error (naming `"flatten"`
  specifically) is what a user sees, rather than an unrelated internal
  crash.

- **`geom_line()`'s default grouping silently fragmented a multi-series line
  chart into one single-point "line" per row.** ggplot2 groups a line by
  the *interaction of every discrete aesthetic in the plot* by default —
  including `x`/`y` themselves, if they happen to be discrete (e.g. an
  ordinal axis). Vega-Lite's own semantics group a line only by its
  `color`/`detail`/`shape` encoding, connecting across the sorted x-domain
  regardless of whether that axis is itself discrete. A rank-over-time
  chart (ordinal x *and* ordinal y, one series per `color`) had every
  distinct `(x, y, colour)` combination become its own single-point group —
  correct data, correct colours, but nothing visibly connected, since nothing
  in the translator ever set an explicit `group` aesthetic to override
  ggplot2's default. `build_layer_channels()` in `encoding.R` now always sets
  `group` to the colour/fill/shape aesthetic explicitly for `line`/`trail`/
  `area` marks, which is a no-op when x/y are already continuous (ggplot2
  computes the same grouping either way) and the actual fix when they aren't.
- **A mark-level literal color config was captured into the wrong bucket
  and never used.** A channel's constant `value`/`datum` (no `field`) is
  correctly kept out of `aes_pairs` and instead built into `fixed` (a
  literal geom argument, not a per-row mapping) — but `render_rule_layer()`
  looked for a value-only x/y channel's resolved expression back in
  `aes_pairs` anyway, which was always empty for that shape. The result was
  a always-empty `xintercept =` (an R parse error, not silently wrong
  output) whenever a rule mark used a bare constant position (~40 corpus
  specs have *some* mark-level literal color/fill/stroke property, several
  of which combine with this exact rule-mark shape). Fixed by reading from
  `fixed` for that case, matching where `build_layer_channels()` actually
  puts it.
- **A `timeUnit`-bucketed filter compared the wrong shape.** `{"field":
  "date", "timeUnit": "year", "equal": 2006}` is Vega-Lite's standard
  filter-by-year idiom — comparing just the extracted *year number* to
  `2006`, not the field's own `year`-truncated *Date* to it (a Date vs. a
  bare number is never meaningfully equal, and R silently evaluates it to
  `FALSE` for every row rather than erroring, filtering out the entire
  dataset with no error at all). `timeunit_component_expr()` in
  `timeunit.R` now extracts the bare component number
  (year/month/date/hours/minutes/seconds/quarter) for exactly this case,
  used only when the filter's comparison value isn't a `DateTime` object.
- **An escaped field name (`"a\\.b"`, a literal dot in a flat column name)
  produced an R *parse* error, not just a lookup miss.** R's own
  backtick-quoted-name syntax (`` `a\.b` ``) parses backslash escapes the
  same way a string literal does — `\.` isn't a recognized escape sequence,
  so a name built from an un-unescaped field string is invalid R syntax,
  not merely a reference to a nonexistent column. `field_ref()` in `expr.R`
  now undoes the escaping once it's confirmed every remaining dot is a
  genuinely-escaped literal one (as opposed to an unsupported nested-path
  dot); a couple of other call sites that read a channel's `$field`
  directly rather than through `field_ref()` (`out_field_name()`'s derived
  names, used for a `timeUnit`-bucketed groupby column) needed the same
  `unescape_field_path()` applied explicitly, since they never went through
  `field_ref()` in the first place.

## Dodge and stack together: ggplot2 has no single built-in position for both

ggplot2's `position_dodge2()` dodges every row apart from every other row in
the same x position — including rows that belong to *different* stack
groups within the same dodge slot, which it has no concept of. A spec with
both an `xOffset`/`yOffset` field (dodge) and a `color`/`detail`-driven
`stack` on the same mark (e.g. a grouped-and-stacked bar chart) needs both
at once, which no off-the-shelf `position` does. `plan_explicit_aggregate()`
(`transforms.R`) computes this manually instead: the offset field becomes a
genuine third `group_by()` dimension (not just a passenger column), the
per-group cumulative-sum stack computation groups by `(category, offset)`
instead of just `category`, and `render_geom_layer_code()` (`geoms.R`)
builds the resulting box directly as `geom_rect()` with dodge-aware
`xmin`/`xmax` (one sub-slot per distinct offset value, sized like the
existing bar/rect band-width convention) rather than relying on any
`position` argument at all. The one case this doesn't cover: `stack:
"center"` combined with a dodge field, which would need the same manual
per-group cumulative-sum-then-recenter logic the plain (non-dodged) `center`
case already has, just further split by the dodge dimension too — left
unhandled as a narrow, compounding edge case.

A same-field special case falls out of this for free: when the dodge field
and the stack field are identical (Vega-Lite already fully expresses that
one dimension via dodging alone), stacking on top of it would try to
`group_by()` the same column twice — a dplyr error ("column name must not
be duplicated"), not a silently wrong chart. `is_implicit_stack`'s own
detection excludes this case explicitly rather than reaching that error.

## Tick marks are line segments, not points

`geom_function_name()`'s default mapping for `"tick"` is `geom_point()` — a
marker at the position, not Vega-Lite's own short dash. For a genuinely 1D
strip (only one of x/y given), ggplot2's own `geom_rug()` is a direct,
built-in equivalent. For a 2D strip (both x and y given, e.g.
`tick_strip.vl.json`'s horsepower-by-cylinder-count chart), the tick is a
short `geom_segment()` drawn *perpendicular* to whichever channel is
continuous — spanning within the discrete companion axis's own band,
mirroring `vl2d3`'s own `renderTick()` orientation logic exactly
(`render_tick_layer()` in `geoms.R`).

Getting the discrete companion axis's own numeric position (`as.numeric(x)`,
the same convention the bar/rect "real discrete x position" case already
uses) loses that axis's real labels, though — a bare numeric scale shows
each level's own 1-based integer code (1, 2, 3, ...) instead of its actual
value, since nothing else in the chart maps the raw factor for the scale to
train real labels from. A `geom_blank()` layer mapping that same channel to
its own real (factor-wrapped) field, drawing nothing itself, exists purely
to give the scale something real to train against — the same thing
`bar_layered_weather.vl.json`'s own analogous `xmin`/`xmax` convention gets
"for free" from its shared plot-level `aes(x = factor(id))`, which a
standalone tick mark has no equivalent of.

A dodged tick (an offset field alongside the tick) and a tick with neither a
real x nor a real y of its own (seen in `parallel_coordinate.vl.json`'s own
deeply-nested repeat-of-layers construction, whose innermost tick layer
resolves no usable position from its inherited encoding) both fall through
to the ordinary `geom_point()`-based rendering instead — `render_tick_layer()`
has no dodge-aware or blank-position handling of its own, and every other
point-like mark already tolerates both of those shapes via existing,
independently-maintained fallback code further down `geoms.R` that a fresh
reimplementation would only risk diverging from.

## `mark.invalid`: filter (the default) means break the path, not drop the row

Vega-Lite's default handling of an invalid (null/NaN) value on a
`line`/`area` mark's own position channel is `"filter"` — but for these two
marks specifically, that doesn't mean *drop the row* (which would silently
reconnect its two neighbors straight across the gap); it means *break the
drawn path there*, leaving a real visual gap. ggplot2's own default
behavior for an `NA` in a required aesthetic is exactly the "reconnect
across it" shape, which under-represents the missing data. `prepare_unit()`
now tags every row with a run id that increments at each invalid value
(`render_invalid_run_id()` in `translator.R`), which `build_layer_channels()`
folds into the geom's own `group` aesthetic (alongside any real
`color`/`detail` grouping) — so the automatic `NA`-row-drop can no longer
bridge across a gap, since the rows on either side already belong to
different groups.

`invalid: null`/`false` (asking Vega-Lite to *not* filter/break at all)
means the opposite: the invalid value is used as-is, which for a continuous
position resolves to a literal 0 (a dip to the baseline, not a gap).
`render_invalid_zero_fill()` coerces those values to 0 upstream of drawing
instead. Both paths are skipped whenever the mark is aggregated/pivoted/
binned (`has_aggregating_channel()`) — the whole "gap between two raw rows"
concept doesn't survive a `group_by()`+`summarise()` or `vl_pivot()`
reshape, whose own output rows have no 1:1 relationship to the original
ones a run-id column added beforehand could still meaningfully describe.

## Corpus validation methodology

Like `vl2d3` (and unlike `vl2altair`/`vl2vlapi`'s near-100% pass/fail), a
plain pass/fail count wouldn't be meaningful here either — ggplot2's own
grammar has genuine gaps relative to Vega-Lite's, so a large fraction of the
corpus legitimately uses something out of scope. `tests/validate_examples.R`
buckets every spec into one of three outcomes:

1. **OK** — translate, evaluate the generated R, no error.
2. **Skipped** — translation or evaluation raised one of this project's own
   `"Unsupported: ..."` errors. An intentional scope boundary, not a bug.
3. **Failed** — anything else. By construction, every failure in this bucket
   is either a real bug or an undocumented gap worth documenting.

At the time of writing: **523/633 OK, 104/633 skipped, 6/633 failed**. A
second, stricter harness, `tests/validate_rendering.R`, runs the full corpus
a second time under `ignore_unsupported = TRUE` and captures the *complete*
error message for anything that still fails (`render_ggplot.R`'s own status
tracking keeps only ggplot2's first, often-truncated line) — **602/633
execute cleanly** under it. The 6 residual strict failures each combine
several unusual features at once — diminishing returns to chase further for
a v1:

- **`histogram_log.vl.json`** — a log-scaled, pre-binned histogram whose
  `geom_rect()` call ends up with only `xmin`/`xmax` (no plain `x`/`y`) and
  `stat = "count"`, which `stat_count()` requires a genuine `x` or `y`
  aesthetic to compute from.
- **`boxplot_1D_invalid.vl.json`** — a boxplot whose own `x` has invalid
  (non-numeric) values; unlike `mark.invalid` support for line/area (above),
  nothing filters an invalid row upstream of `stat_boxplot()` for a
  non-path mark, so it chokes on the resulting `NA`.
- **`isotype_bar_chart_emoji.vl.json`** — a `calculate` expression using a
  JS object-literal as an inline lookup table (`{'cattle': '🐄', ...}
  [animal]`), a shape `translate_expr()` doesn't recognize and so passes
  through as literal (invalid) R syntax.
- **`layer_bar_labels_grey.vl.json`** — a `dplyr::group_by()` call ends up
  with the same field name twice from two independent code paths that both
  decided to group by it, which dplyr rejects as a duplicate column name.
- **`layer_falkensee.vl.json`**, **`layer_timeunit_rect.vl.json`** — both
  compute a temporal range's midpoint (`(start + end) / 2`) directly on
  `Date` objects, which R's own `Date` class doesn't define a binary `+`
  for at all (needs an explicit numeric conversion first).

Every bug described above was found through one of these two harnesses —
none were caught by reading the generator code or by the hand-written unit
suite (`tests/testthat/test-translator.R`), which is why they exist as
separate, much larger validation steps.
