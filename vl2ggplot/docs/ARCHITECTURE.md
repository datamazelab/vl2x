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
richer than D3, its practical coverage of the same 633-spec corpus (410/633
OK) sits much closer to its mechanical siblings than to `vl2d3`'s 291/633.

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

At the time of writing: **410/633 OK, 219/633 skipped, 4/633 failed**. The
four residual failures each combine multiple unusual features at once —
diminishing returns to chase further:

- a log-scaled histogram whose pre-binned `x`/`x2` range collides with the
  Gantt-chart `geom_linerange` workaround *and* an inline count-aggregate on
  the same layer,
- a non-linear (string-labeled, `"∞"`-containing) histogram using an ordinal
  `"point"`-scale axis paired with a numeric `x2` range,
- a `rule` mark whose `x`/`x2`/`y`/`y2` are all simultaneously
  interactive-`param`-bound values (forming a 2D box with no static
  resolution path for the bound parameters), and
- a `text` mark whose `aggregate` is declared on the `text`/label channel
  itself rather than on `x`/`y`, which needs `stat_summary(..., geom =
  "text", aes(label = after_stat(y)))` — a materially different code shape
  than the "aggregate on a position channel" case everything else in
  `transforms.R` is built around.

Every bug described above was found through this harness — none were caught
by reading the generator code or by the hand-written unit suite
(`tests/testthat/test-translator.R`), which is why the harness exists as a
separate, much larger validation step.
