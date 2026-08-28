# Architecture and design notes

## Why this couldn't be a mechanical translation

`vl2altair`/`vl2vlapi` translate Vega-Lite into another library that
*already speaks Vega-Lite's own grammar* — encoding channels, scales,
marks, composition operators all map across almost one-to-one.
`vl2ggplot` targets a *different* grammar-of-graphics, but still a
grammar-of-graphics, with its own `aes()`/`geom_*()`/`facet_*()` vocabulary
Vega-Lite's model maps onto fairly directly.

matplotlib has none of that. An `Axes` is just pixel space; there is no
encoding-channel concept, no automatic scale inference, no notion of a
"mark" beyond "call `ax.bar(...)`/`ax.plot(...)`/... with plain arrays,"
and no composition operator beyond "make more `Axes` objects." Every one of
Vega-Lite's own concepts — which channel drives which visual property,
which scale a channel uses, how a categorical `color` value becomes a
distinct series with its own legend entry, how a `bar`/`area` mark stacks
when grouped — has to be built by hand here, the same situation `vl2d3`
faces with D3. This translator's architecture mirrors `vl2d3`'s own
module-per-concern split (`scales.js`/`marks.js`/`prepare.js`/`stack.js`/
`expr.js`/...) almost directly, module for module.

The one place this project has it *easier* than `vl2d3`: **pandas**.
`groupby(...).agg(...)` gives this translator dplyr-grade aggregation for
free — genuinely N-way groupby, not the 1–2-field cap `vl2d3`'s own
hand-rolled `d3.rollup()` reductions started with. So the data-pipeline
half of this translator's scope (inline `aggregate`/`bin`/`timeUnit`,
top-level `transform`) is broader than `vl2d3`'s *original* launch scope,
even though the mark-drawing/scale/composition half stays just as
hand-built.

## Row-at-a-time expression evaluation, not vectorized pandas

`expr.py` translates a Vega expression string (`calculate`/`filter`) into a
Python expression evaluated via `df.apply(lambda row: <expr>, axis=1)`
(`df[df.apply(lambda row: bool(<expr>), axis=1)]` for a filter), not a
vectorized pandas expression (`df["a"] + df["b"]`). This is slower — a
Python-level loop per row instead of a single vectorized C call — but far
simpler to generate *correctly* for arbitrary Vega expression syntax:
Python and JavaScript already share nearly every operator (`+ - * / % < <=
> >= == !=` and parenthesization all mean the same thing), so most of
`expr.py` reduces to table lookups (`&&`→`and`, `Math.floor`→`math.floor`,
...) applied to a string, the same string-rewrite approach `vl2d3`'s own
`expr.js` and `vl2ggplot`'s own `expr.R` already use for the identical
reason. Nothing in this project's own corpus-sized examples (hundreds to
low thousands of rows) will ever notice the performance difference; a
translator whose whole reason for existing is *simplicity and legibility of
the generated code* has no reason to reach for `numexpr`-style vectorization
just to shave milliseconds off a one-off script run.

Not a real parser — like its siblings, `expr.py` is a sequence of targeted
regex/string rewrites over the finite set of expression shapes Vega-Lite
specs in the wild actually use. A shape past that set passes through as
literal text and fails loudly (a Python `NameError`/`SyntaxError`) at
generated-code run time, rather than silently miscomputing.

Two rewrites needed genuine hand-rolled scanning rather than a single
regex, because both need to correctly handle nesting:

- **`if(cond, then, else)`** (Vega's own ternary function, distinct from
  `?:` but semantically identical) — a bracket/quote-depth-aware scan
  that splits the 3 top-level comma-separated arguments (handling a
  further `if(...)` nested inside one of them, as real specs do) before
  recursively translating each and reassembling as `(then) if (cond) else
  (else)`.
- **`cond ? then : else`** — depth-aware splitting on `?`/`:`, but with one
  wrinkle a naive single-pass scan misses: a ternary is very often an
  *argument* to a function call (`toString(isValid(x) ? x : 0)`), not the
  whole expression, so a scan that only looks for `?`/`:` at absolute
  bracket depth 0 never finds it (depth never returns to 0 while still
  inside the ternary). `_rewrite_ternary` handles this by first recursing
  into every top-level bracketed group's own inner content via
  `_rewrite_ternary_in_groups`, treating that inner content as its own
  "local top level," before running its own depth-0 scan on what's left.

## `NaN` vs. `None`: why `== null` needs `pd.isna()`, not `==`

A Vega-Lite null check (`datum.field === null` / `!== null`) translates,
via the ordinary `===`/`!==` and `null` rewrites, to `row['field'] ==
None` / `!= None`. That's wrong: a missing value in a numeric pandas
column is `NaN` (a float), not the Python singleton `None`, and `float('nan')
== None` is `False` in Python — so the filter silently matches *nothing*,
which is worse than an exception because it fails quietly. `expr.py`
special-cases this shape (`_rewrite_null_comparisons`): `<row-field-chain>
== None` → `pd.isna(<...>)`, `!= None` → `pd.notna(<...>)`, which both
handle a missing value regardless of whether it manifests as `NaN` or a
genuine `None` (an object-dtype column can hold either).

## Ordinal position: integer index + relabeled ticks, matplotlib's `scaleBand`

matplotlib has no categorical-axis primitive analogous to D3's
`scaleBand`/Vega-Lite's own `point`/`band` scale — every `Axes` is real
number space. `scales.py`'s `position_column()` handles a discrete
(`ordinal`/`nominal`) position channel by materializing a real integer
column via `pd.Categorical(data[field], categories=sorted_unique).codes`,
plotting *that*, then relabeling the ticks (`ax.set_xticks`/
`set_xticklabels`) to show the original category strings — the same
`scaleBand`-equivalent role `vl2d3`'s own `scales.js` plays, just expressed
as one vectorized pandas statement instead of a D3 scale object.

A position channel with no real field at all (a literal `value`/`datum`, or
genuinely absent — a 1D strip plot with only one of x/y given) returns a
*broadcast* literal — `pd.Series(<value>, index=data.index)` — rather than a
bare scalar. This matters because `ax.scatter(0, [1, 2, 3])` raises `"x and
y must be the same size"` (no scalar broadcasting), unlike `ax.bar`/
`ax.plot`, which tolerate a bare scalar. Broadcasting explicitly here means
every mark renderer in `marks.py` can treat this return value uniformly
regardless of which case produced it.

## Categorical grouping: a runtime `groupby` loop, not a translate-time scale

matplotlib's own idiom for a categorical `color`/`detail`-grouped series is
"one draw call per group, each with its own `label=`, then `ax.legend()`
builds the legend for free from those labels." `marks.py` generates this as
a **runtime** loop in the *output* code:

```python
for __i, (__key, __rows) in enumerate(data.groupby(field)):
    ax.bar(..., color=plt.get_cmap('tab10').colors[__i % 10], label=str(__key))
ax.legend(title=field)
```

not resolved at translation time — the actual distinct category values are
only known once the real data has loaded, the same reason `vl2d3`'s own
`d3.group()`/`vl2ggplot`'s own `dplyr::group_by()` groupings are also left
to chart-render time. `enumerate()` over a pandas `groupby` (sorted-key
order by default) gives a stable, reproducible palette index for free — no
separate scale-domain-registration step needed the way a real Vega-Lite/D3
ordinal color scale would require.

Every legend-gating check in `marks.py` (`_render_point`/`_render_bar`/
`_render_line_or_area`) is careful to gate on the *same* condition that
decides whether grouping actually happens (`_color_source(...)[0]`), not
just "is there a `color` field at all" — a continuous (quantitative)
`color` field has a field but isn't grouped in v1, and calling
`ax.legend()` with no labeled artists raises a `"No artists with labels
found"` warning.

## Facet vs. concat/hconcat/vconcat: a runtime loop vs. translate-time unrolling

Both `facet` and `concat`/`hconcat`/`vconcat` produce a grid of panels, but
`translator.py` generates them completely differently, because of when the
panel *count* is known:

- **`concat`/`hconcat`/`vconcat`**: the panel count is the length of the
  spec's own JSON array — known at translation time. `translate_multi()`
  unrolls it directly into N separate `plt.subplots()`-indexed draw blocks,
  one call to `_draw_unit_or_layer()` per child, each writing to its own
  `axes[i]`.
- **`facet`**: the panel count is *data-dependent* (the distinct values of
  the facet field) — only knowable once the real data has loaded, not from
  the spec's own JSON shape. `translate_facet()` instead generates a
  **runtime** Python `for` loop over `data[field].unique()`, with a nested
  `Emitter` (its own `lines` buffer) whose generated statements get
  indented and spliced into the loop body — the facet-panel equivalent of
  the same "resolve at generated-code run time, not translation time"
  choice color/detail grouping makes.

`data_param` threading (mirroring `vl2d3`'s own `dataParam` convention)
lets a facet panel's pre-filtered `DataFrame` — or a layer wrapper's
inherited data — reach a child `translate_unit()`/`translate_layer()` call
without redundant reloading. This is threaded through
`_draw_unit_or_layer()`, which dispatches by node shape: a `layer` child
recurses into `translate_layer()`; a further nested composition
(`facet`/`hconcat`/`vconcat`/`concat`/`repeat`) inside a layer/concat child
is refused (`ignore_unsupported=False`) or skipped in place — Vega-Lite
itself allows some of these nestings, but they're deliberately out of v1
scope; a plain unit view falls through to `translate_unit()`.

## `encoding.facet`/`.row`/`.column` shorthand

Vega-Lite allows a facet to be spelled two ways: the explicit top-level
`{facet: {field, columns}, spec: {...}}` form, or an `encoding.facet`/
`encoding.row`/`encoding.column` shorthand on an otherwise-plain unit view
(a chart with no top-level `facet` key at all). `translate_top()` detects
the shorthand form (`_rewrite_encoding_facet_shorthand()`) and rewrites it
into the explicit form before the normal facet dispatch runs, so
`translate_facet()` itself only ever has to handle one shape. One subtlety
worth calling out explicitly since it caused a real bug during corpus
validation: the shorthand form's own `columns` property lives at
`encoding.facet.columns`, *not* at the spec's top-level `columns` — the
first version of this rewrite read the wrong location and silently
ignored a spec's explicit column count, producing a 1×N grid instead of
the requested M×N one.

## Implicit stacking

`stack.py` mirrors `vl2d3`'s own `stack.js`/`vl2ggplot`'s equivalent: a
`bar`/`area` mark whose `color`/`detail` channel groups it gets an implicit
zero-baseline stack (a `groupby(...).cumsum()`-derived running total used
as each group's own baseline) unless the spec explicitly turns stacking off
(`stack: null`/`false`) — matching Vega-Lite's own default. `normalize`/
`center` stacking modes are out of v1 scope.

## Provenance header and `include_source_paths`

Every generated script opens with a `# Generated by
vl2matplotlib.vegalite_to_matplotlib_code(spec, ...)` comment naming the
exact call (including every non-default argument) that produced it —
matching the convention shared by all five sibling translators.
`include_source_paths=True` additionally precedes each statement (or
statement block) with a `# from: <json path>` comment (`# from: mark,
encoding.x`, `# from: layer[0].transform`), threaded through every
`Emitter.add_stmt(..., path=...)` call site the same way `vl2d3`'s own
emitter threads it. Off by default (a noisier script); useful for tracing a
specific generated line back to the part of the spec that produced it.

## Notable bugs corpus validation caught

A deliberately scoped-down v1 makes plain pass/fail meaningless (see
"Corpus validation methodology" below) — most of the value of running the
full 633-spec corpus came from the *unexpected* failures, each a real bug
rather than a documented scope gap. A few worth calling out because the
class of bug, not just the one-off fix, is worth knowing about:

- **A `Categorical`-dtype column silently surviving `.apply()`.**
  `pd.cut(...)` returns a `Categorical`-dtype `Series`; calling
  `.apply(lambda iv: iv.left, ...)` on it to extract a numeric bin edge
  *keeps* the `Categorical` dtype on the output even though every value is
  now a plain float. Grouping by such a column with pandas' `observed=False`
  default (the default) then builds the full category cross-product
  internally, which mismatches the real aggregated row count and crashes
  deep inside `groupby(as_index=False).agg()`. Fixed by an explicit
  `.astype(float)` after every bin-edge extraction.
- **A bare Python name where pandas needs a *string* function name.**
  `.agg(count=('col', size))` uses the *unquoted* Python name `size`
  (a `NameError` — nothing by that name is in scope) where pandas'
  named-aggregation syntax needs the *string* `'size'`. Every
  named-aggregation call site now goes through a small local helper that
  always emits `'size'` (properly quoted) for a `count` aggregate.
- **A derived column name used as a Python keyword argument.**
  `.agg(sum_Rotten Tomatoes Rating=(...))` — pandas' named-aggregation
  syntax uses the output name as a keyword argument, which must be a valid
  Python identifier, not just a valid string column label. Any field name
  containing a space, dot, or other non-identifier character broke this.
  Fixed via `literals.py`'s `sanitize_identifier()`, applied everywhere a
  derived aggregate/bin/timeUnit output name is constructed.
- **Two channels aggregating the same field the same way.** A spec with
  both `x: {aggregate: "sum", field: "yield"}` and `order: {aggregate:
  "sum", field: "yield"}` deterministically derives the *identical* output
  column name (`sum_yield`) for both channels, which built a
  `.agg(sum_yield=(...), sum_yield=(...))` call — a Python `SyntaxError`
  (`keyword argument repeated`), since a derived name is only unique per
  `(field, op)` pair, not per channel. Fixed by de-duplicating the
  generated named-aggregation arguments by output name (first wins) while
  still keeping every channel's own encoding rewrite (each channel still
  needs to know its own resulting field name, duplicates included).
- **`.replace(x, y, 1)`'s count limit silently dropping the second
  occurrence.** An early version of the stacked-bar height expression
  (`top - base`, both referencing the same `data_var` name) used
  `str.replace(old, new, 1)` to substitute in the per-group row variable —
  correct for an expression that mentions the variable once, silently wrong
  for one that mentions it twice (the second occurrence kept referencing
  the full, ungrouped frame). Not an exception — a visually wrong (but
  successfully "OK"-bucketed) stacked-bar height, caught only by reading
  the generated code, which is why `tests/validate_rendering.py`'s
  empty/NaN-artist check exists as a second, independent verification pass
  beyond "did it raise."
- **A temporal field only ever referenced through a `timeUnit`
  transform's own derived output.** `_collect_temporal_fields()`'s job is
  deciding which raw columns need `pd.to_datetime()` coercion up front. A
  field a top-level `transform` entry *produces* (its own `as` name) is
  never itself a raw date string needing coercion — but an encoding channel
  referencing that produced field with `type: "temporal"` (reading a
  `timeUnit: "month"` transform's own `month`-named output, itself already
  a plain int from `timeunit_expr()`'s cyclic-component handling) was
  incorrectly flagged as *also* needing coercion, generating a
  `pd.to_datetime()` call against a column that didn't exist yet (the
  transform that creates it runs later in the same statement list) — a
  `KeyError` at generated-code run time. Fixed by excluding any field
  matching a transform's own `as` output from the encoding-derived
  coercion list.
- **A filter predicate's own `timeUnit` applied to the wrong value.**
  `{field: "date", timeUnit: "year", range: [2006, 2007]}` (Vega-Lite's
  structured filter-predicate form, distinct from a bare expression string)
  needs to compare the *extracted year component*, not the raw
  `Timestamp`-valued field, against the numeric range — comparing a
  `Timestamp` to a plain `int` with `<=` raises `TypeError`. Fixed by
  routing a filter predicate's own `timeUnit` through the same
  `timeunit_expr()` helper the encoding/transform paths already use.
- **A binned channel silently dropping every *other* groupby field.**
  `_prepare_binned()` (the code path for a binned position channel) only
  grouped by the bin's own two output columns (`<field>_bin_start`/`_end`),
  ignoring any *other* encoding channel with a field but no aggregate of
  its own — e.g. `color: {field: "Major Genre"}` alongside a binned `x` and
  an aggregated `y`. Grouping by `(bin_start, bin_end)` alone silently
  dropped the `"Major Genre"` column from the aggregated result entirely,
  so the later per-color-group draw loop's own `.groupby("Major Genre")`
  raised `KeyError`. Fixed by collecting every other fielded, non-aggregate
  channel into the groupby key list too, mirroring the equivalent
  collection `_prepare_aggregated()` (the *un*-binned aggregate path)
  already did correctly.

## v2: new marks, and the gap between "renders" and "renders correctly"

v1's own verification (`validate_examples.py`'s OK/skip/fail split, plus
`validate_rendering.py`'s empty/NaN-artist check) only catches "did this
throw" and "did it draw literally nothing" — it can't catch "drew
*something*, but wrong." A visual sweep of v1's own showcase renders found
real instances of the latter: bars a fraction of a pixel wide, sitting off
in a corner of an otherwise-empty-looking plot. Two systemic root causes,
both fixed in v2:

- **Bar/tick mark orientation silently defaulted wrong.** Vega-Lite infers
  whether a bar is vertical or horizontal from which of `x`/`y` is the
  *continuous* channel. The v1 check only trusted an explicit `type:
  "quantitative"` tag (`x_def.get("type") == "quantitative"`) — missing the
  common case where quantitative is *implied* instead
  (`x: {aggregate: "sum", field: "people"}`, a 1D aggregate bar chart with
  no `type` key at all, and no `y` channel either). Every such chart
  silently drew as a zero-height *vertical* bar parked at an enormous x
  position, rather than the horizontal bar it should be — invisible, not
  just misoriented. Worse: even a properly `type`-tagged channel lost that
  signal after `prepare.py`'s own aggregate rewrite cleared `aggregate` to
  `None` on the rewritten encoding (needed so `marks.py` never has to know
  aggregation happened at all) — so a check running on the *post-rewrite*
  encoding, as orientation inference does, saw neither an explicit `type`
  nor the `aggregate` key that would have implied one.

  Fixed with a new `scales.py` function, `effective_type()`, that also
  recognizes an `aggregate`/`bin`/`timeUnit`-implied type (a *cyclic*
  `timeUnit` like `"month"` implies `quantitative`, not `temporal` --
  `timeunit_expr()` reduces it to a plain int, not a real date); `
  is_quantitative()` (used everywhere orientation is decided: `bar`/`tick`/
  `errorbar`/`boxplot`) now calls it instead of a bare `== "quantitative"`
  check. And every `prepare.py` rewrite site that clears `aggregate`/`bin`/
  `timeUnit` now also bakes the *pre-rewrite* effective type in as an
  explicit `type` on the rewritten encoding (`_rewritten_type()`), so a
  later `is_quantitative()` call downstream still sees it.
- **A bar's own width assumed every position axis is ordinal.** A flat
  `width=0.8` (matplotlib's own default, paired with `align='center'`) is
  correct for an integer-spaced ordinal position, but a *continuous*
  position — a binned histogram axis, or (rarer, but real) a plain
  quantitative field used directly as a bar's position — needs a real,
  data-derived width instead: `0.8` next to a 0–4000-range axis is a
  barely-visible sliver. Fixed in `_render_bar()` by deriving the width
  from the position channel's own `x2`/`y2` companion (the bin's exact
  span) when one is present, drawn with `align='edge'` instead of the
  ordinal case's default centered alignment; otherwise a data-proportional
  heuristic (`range / (n_unique - 1) * 0.6`, computed once at runtime over
  the whole un-grouped frame). This is gated on `is_quantitative()`
  specifically, not merely "the channel isn't confirmed ordinal" — an
  *untyped categorical* field used as a bar's position (equally common,
  and indistinguishable from "untyped quantitative" without loading real
  data) must still get the flat `0.8` default; the first version of this
  fix instead tried `.max()`/`.min()` arithmetic on what turned out to be a
  string column, a new regression traded for the one it fixed.

New marks, all added the same way v1's did — hand-built against matplotlib
primitives, no shared grammar-of-graphics layer to lean on:

- **`rect`** (`_render_rect()`): the dominant real-world shape is a
  heatmap (categorical or binned `x`/`y`, a continuous `color` aggregate)
  — one `matplotlib.patches.Rectangle` per row via `df.iterrows()` (row-at-
  a-time, the same tradeoff `expr.py` already makes, since a heatmap's own
  row count is never large enough for the vectorization to matter), sized
  from the position channel's own bin companion when present or a full
  unit-width ordinal cell otherwise, with a `Normalize`+colormap pair and
  `plt.colorbar()` for the continuous `color` case. A `rect` with a field
  on only *one* axis (a min/max extent band drawn behind another layer, not
  a grid at all) is handled as a structurally different case —
  `axhspan`/`axvspan` (matplotlib's own purpose-built "span the Axes' full
  current width/height" primitives) rather than trying to force a
  position-less axis through the same per-row-Rectangle machinery, which
  has no corner to derive from there. `Rectangle` patches, unlike
  `bar`/`scatter`/`plot`, never participate in matplotlib's own autoscale;
  the grid case sets the Axes view explicitly from the data's own extent
  (safe since a heatmap is essentially always the sole occupant of its
  Axes), the band case relies on `axhspan`/`axvspan`'s own span-the-current-
  view behavior instead so it never clobbers a range another, layered mark
  already set correctly.
- **`boxplot`** (`_render_boxplot()`): native `ax.boxplot()` computes
  quartiles/whiskers from raw per-group data directly — one call for the
  whole mark (not one per group), `positions=` and `patch_artist=True` +
  a `set_facecolor()` pass giving each box its own categorical-palette
  color. Vega-Lite's own default extent (1.5× IQR) is already matplotlib's
  own default `whis=1.5`; `extent: "min-max"` maps to `whis=(0, 100)`
  (a percentile range that happens to select the true min/max).
- **`arc`** (`_render_arc()`): `ax.pie()` from `theta` (wedge size) and
  `color` (category, mapped through the same categorical palette every
  other grouped mark uses); `innerRadius` → a donut via
  `wedgeprops=dict(width=0.5)`. A `radius`-encoded field (varying each
  wedge's own radius — a polar bar chart, not a pie) is a materially
  different visualization this doesn't attempt.
- **`errorbar`/`errorband`** (`_render_errorbar()`/`_render_errorband()`,
  sharing `_error_extent_stmts()`): the common real-world shape has no
  explicit `x2`/`y2` error channels at all — Vega-Lite computes a per-group
  mean ± extent from the raw data implicitly. `_error_extent_stmts()`
  groups by the non-value position channel and computes mean/stdev/count/
  quartiles all at once via one named-aggregation `.agg()` call (simpler
  than branching the groupby itself per extent type), then derives
  `__lo`/`__hi` columns from whichever extent the mark specifies
  (`stdev`/`stderr`/`iqr`/`ci`, default `stderr`). `"ci"` uses the same
  normal-theory approximation (`mean ± 1.96 * stdev/sqrt(n)`) `vl2ggplot`'s
  own docs already justify making for the identical reason: no simple
  one-line pandas equivalent to a real bootstrap. `errorbar` draws via
  `ax.errorbar(..., fmt='o')` (with `capsize` when the mark's own `ticks`
  property is set); `errorband` via `fill_between`/`fill_betweenx`
  (orientation-dependent), sorted by position first since an unsorted band
  self-intersects visually.

A few smaller correctness fixes came out of the same pass:

- `_color_source()`'s categorical-vs-continuous classification had the
  identical "no explicit `type`" gap as bar orientation — a continuous
  `color: {aggregate: "mean", field: ...}` with no `type` (a common
  heatmap shape) was being treated as a categorical *grouping* field
  instead. Now routed through `is_quantitative()` too.
- `ax.text()` calls never participate in matplotlib's own autoscale/data-
  limit tracking. A panel containing *only* text marks (a column of
  category labels next to a bar panel in a `hconcat` — a real,
  not-uncommon small-multiples idiom, e.g. a population-pyramid's middle
  age-label column) kept the Axes' untouched default `[0, 1]` view, with
  every label rendered entirely off-screen. Fixed via
  `ax.update_datalim(...)` + `ax.autoscale_view()` (which *extends* the
  view rather than replacing it, so it never clobbers a range another mark
  layered on the same Axes already set correctly) — gated on both
  positions being confirmed numeric first (`_position_is_numeric_safe()`),
  since an ambiguously-typed channel can, at runtime, turn out to hold
  genuinely non-numeric data (`text` labeling an image-URL column, seen in
  the corpus) that `update_datalim` can't handle.
- `bin: "binned"` (Vega-Lite's "this data is already pre-binned, don't
  re-bin it" convention — the field itself already holds the bin start,
  its own `x2`/`y2` companion the bin end) was previously falling into the
  ordinary `bin: true`/`{maxbins: ...}` re-binning path, running
  `np.histogram_bin_edges`/`pd.cut` over already-binned data into a
  different, wrong set of edges. Now excluded from `prepare.py`'s own
  `bin_channels` detection so it passes through untouched.

## v2.1: grouped bars, conditional color, nested fields, and a shared runtime module

A closer look specifically requested double-checking grouped/dodged bar
charts, hunting further "renders but is a code error" bugs, checking
whether every `color` encoding in a spec actually reaches the generated
code, and adding the same kind of shared runtime support module `vl2d3`/
`vl2ggplot` already have. Each turned up a real, fixable gap:

- **`xOffset`/`yOffset` (grouped/dodged bar and tick charts) were silently
  ignored entirely.** A spec like `x: {field: "category"}, xOffset: {field:
  "group"}, color: {field: "group"}` — the standard grouped-bar-chart
  shape — drew every sub-group's bar at the *identical* category position,
  overdrawing each other so only the last-drawn group was visible. Fixed
  in `_render_bar()`/`_render_tick()`: the offset field's own distinct
  values become a runtime loop (count only known once the real data
  loads, same reasoning as the color/detail grouping loop), each
  sub-group's position shifted and its width divided by the group count.
  Two things this exposed along the way:
  - The offset field is almost always an untyped string column (Vega-Lite
    infers `nominal`); the dodge shift's own arithmetic (`position +
    offset`) needs a real integer position, not a raw string, to add to --
    handled by generalizing the `rect`-only "force nominal when
    ambiguous" helper (renamed `_force_nominal_if_ambiguous()`) to bar's
    own category channel too, specifically only when a dodge is present
    (the *non*-dodged case is left alone -- it already works today by
    relying on matplotlib's own native string-category handling for a
    plain `ax.bar(strings, ...)` call, so forcing ordinal unconditionally
    there would be a change with no compensating benefit).
  - `stack.py`'s own `plan_stacking()` didn't know `xOffset`/`yOffset`
    existed, so a grouped-bar spec (color-grouped *and* offset) got
    *both* implicit stacking *and* the new dodge shift applied -- doubly
    wrong. Vega-Lite's own rule is that an offset channel means dodge,
    never stack, regardless of whether `color`/`detail` also groups the
    same mark; `plan_stacking()` now bails out whenever one is present.
  - Neither `xOffset`/`yOffset` field was in `prepare.py`'s own
    `_ALL_CHANNELS` list, so it didn't survive an implicit aggregate's own
    `groupby(...).agg(...)` the way `color`/`detail` already did --
    `KeyError` once the mark tried to group by it downstream. Added
    alongside `theta`/`radius` (added for `arc` a session earlier for the
    identical reason).
- **`color.condition` (a computed per-row color, not a fixed one) was
  silently collapsed to a single flat color.** A candlestick chart's own
  up/down color (`color: {condition: {test: "datum.open < datum.close",
  value: "#06982d"}, value: "#ae1325"}`) — real, fairly common Vega-Lite
  usage — checked `"value" in color_def` *before* ever looking at
  `condition`, and the condition's own sibling `value` key means that
  check always matched, so every row got the same fallback color
  regardless of the actual per-row test. Fixed in `_color_source()`: a
  `test`-keyed condition is now translated (via `expr.py`'s own
  `translate_expr()`) into a `.apply(lambda row: ..., axis=1)` statement
  producing a real per-row color array, returned in the exact same
  `(group_field, fixed_color_expr)` shape every caller already expects --
  matplotlib's own `bar`/`scatter`/`vlines`/`hlines` all already accept
  either a single color or one per element, so no call site needed to
  change to use it. Two follow-on fixes this needed:
  - A condition's own `test` can reference a field that isn't part of
    *this* mark's own encoding at all (a null/invalid-data check
    referencing a field the mark's own aggregate groupby doesn't
    preserve) -- `row[field]` raised `KeyError` once that field genuinely
    wasn't a column any more post-aggregation. The condition's own
    translated expression now runs its row lookups through
    `row.get(field)` instead (`_soften_row_lookups()`), returning `None`
    instead of raising -- which a `pd.isna(...)`-wrapped null check (the
    common real shape) then correctly treats as "missing."
  - A caller whose own matplotlib call can't take a color array at all
    (`plot()`/`fill_between()` for `line`/`area` -- a line has exactly one
    color for its whole path; a per-row `axvline()`/`axhline()` loop,
    where the array would need per-iteration indexing `_color_source()`
    has no way to thread through) passes `allow_row_array=False` and gets
    the condition's own flat base `value` instead, same as an ordinary
    `color.value` with no condition at all.
- **Nested and escaped-dot field references (`"record.low"`,
  `"source\\.reco"`) now resolve.** Both ultimately need the same thing:
  a flat pandas column named exactly `record.low`/`source.reco`. `data.py`
  now flattens any nested-object value in a loaded record into dotted
  keys (`_flatten_record()` for inline `values`; a `pd.read_json()` ->
  `pd.json_normalize()` round-trip for `url`-loaded JSON) -- keeping the
  *original* nested key too (not just its flattened children), since a
  Vega expression can check a whole sub-object's own presence
  (`datum.options != null`, testing for a row that lacks the key
  entirely) as well as reach into one of its scalar fields. Separately,
  `translator.py` now unescapes every `field` value's own `\.` (a single
  recursive walk of the whole spec tree, mirroring
  `_rewrite_encoding_facet_shorthand()`'s identical one-time-rewrite
  pattern) before translation ever begins -- since after flattening, an
  escaped literal dot and a real nested path both resolve to the
  identical flat column name, unescaping is the only remaining difference
  to handle. `data.format.property` (a JSON envelope where `values`
  itself isn't already the bare records array -- `{hits: {hits: [...]}}`,
  `{type: "FeatureCollection", features: [...]}`, both real corpus shapes)
  is unwrapped the same way, via a small dot-path `_dig()` helper.
- **A `type: "quantitative"` field's raw JSON value can itself be a
  string** (`"p": "0.14"`, not `0.14` -- a real export-style data shape in
  this corpus). Vega-Lite coerces this implicitly from the declared type;
  this translator previously didn't, so any downstream arithmetic (an
  implicit aggregate, `stack.py`'s own `cumsum()`, a bare `-`/`+` in a
  `calculate` expression) failed outright on the string dtype instead of
  computing on numbers. Fixed with `_collect_quantitative_fields()` +
  `render_quantitative_coercion()` (`pd.to_numeric(errors='coerce')`),
  mirroring `_collect_temporal_fields()`'s identical existing
  `pd.to_datetime()` coercion for `temporal` fields -- including the same
  "don't coerce a field a transform itself produces before that transform
  has run" exclusion, generalized into a single shared
  `_derived_field_names()` both coercion collectors call (which also
  fixed a latent version of the identical bug for `aggregate`/`window`/
  `joinaggregate`'s own `as` output, previously only checked at each
  transform's own top level, missing that those three keep `as` nested
  one level down inside their own list).
- **Two matplotlib-specific "renders, but is a code error" bugs**, found
  by actually running the corpus's `ignore_unsupported` build and reading
  the tracebacks rather than any static check: a CSS function-syntax color
  (`"rgb(167, 165, 156)"`, valid CSS, real corpus usage) has no matplotlib
  parser at all (only hex codes, named colors, and matplotlib's own
  `(r, g, b)` *tuple* of 0-1 floats) -- `format_color_value()` now converts
  it; and a mark-level gradient fill definition (`{gradient: "linear",
  stops: [...]}`, a dict where a color string was expected) crashed
  matplotlib's own color parser outright -- `_mark_color_value()` now
  approximates it with the gradient's own last stop as a flat color
  (matplotlib has no true gradient-fill primitive without much more
  involved clipping/`imshow` machinery this project doesn't attempt).
- **Two temporal-construction bugs.** The `monthdate`/`quartermonth`
  combined `timeUnit`s reconstruct a real date at a fixed placeholder year
  (`pd.Timestamp(<placeholder>, month, day)`) -- 1900 (not a leap year)
  raised `day is out of range for month` for any real February 29th in the
  data; changed to 2000 (a leap year). And a rule mark's own `datum:
  {"year": 2006}` (Vega-Lite's `DateTime`-object literal shorthand) was
  handed to matplotlib as a raw Python dict (`channel_value_expr()` just
  literal-renders whatever `datum` holds) -- matplotlib's date axis can't
  plot a dict at all. `encoding.py` now recognizes the `DateTime`-object
  shape (every key a real `DateTime` field name) and builds a real
  `pd.Timestamp(...)` instead, filling in `1` for whichever of year/month/
  day the literal itself doesn't specify (`pd.Timestamp` requires all
  three; Vega's own object allows a partial one).
- **A filter predicate's own `range` with a `null` bound** (`{field: "y",
  range: [null, 2019]}`, Vega-Lite's own "unbounded in that direction"
  convention, meaning `<= 2019`) raised `TypeError: '<=' not supported
  between instances of 'NoneType' and 'int'` from a chained `lo <= x <=
  hi` comparison that assumed both bounds were always real numbers. Now
  built as separate `>=`/`<=` clauses, one per bound that's actually given.
- **`window`/`joinaggregate`/`fold`** (all three previously "documented
  gap, out of v1/v2 scope") are now implemented. `joinaggregate` and
  `fold` both have a clean single-call pandas equivalent
  (`groupby(...).transform(...)`; `DataFrame.melt()`) and are generated
  inline, no shared helper needed. `window` doesn't: the combination of an
  optional partition (`groupby`), order (`sort`), and a frame bound
  *relative to the current row* (`frame: [-15, 15]` for a rolling window,
  `frame: [null, 0]` for a running/cumulative one, `frame: [null, null]`
  or omitted for the whole partition) is genuinely awkward to re-derive
  correctly inline every time -- exactly the kind of complexity that
  justified `vl2ggplot`'s own `vl_pivot()` as a real shared function
  rather than inline R. `runtime.py`'s new `vl_window()` plays the
  identical role for this project (see "Shared runtime helpers" in
  `README.md`); it covers `row_number`/`rank`/`dense_rank`/`count`/`sum`/
  `mean`/`min`/`max`/`distinct` (every op the corpus's own window-transform
  specs actually use), and documents (rather than silently mishandling)
  the ops it doesn't (`lag`/`lead`/`first_value`/`last_value`/... fall
  back to the row's own field value unchanged).
- **Two attempted fixes were reverted after they caused regressions**,
  worth recording so they aren't re-attempted the same way: JS's unary `+`
  (`+datum.year`, a string-to-number coercion idiom) and its own string-
  concatenation cousin (`('+' ) + datum.amount`, string + number ->
  string in JS) both need distinguishing a *unary*/string-concat `+` from
  an ordinary *binary* numeric `+` using only a regex over already-
  rewritten text, with no real type information available at translation
  time. The first attempt's lookbehind (checking only the single
  character immediately before `+`) matched a genuine binary `+` too
  whenever it was preceded by whitespace (`row['a'] + row['b']`, the
  overwhelmingly common shape) rather than only the intended unary case,
  silently corrupting two previously-correct specs' own generated code
  into a `SyntaxError` to fix a single narrow one. Left unattempted rather
  than risk the same trade a second time; both remain among the small
  residual failure set.

## Corpus validation methodology

Like `vl2d3`/`vl2ggplot` (and unlike `vl2altair`/`vl2vlapi`, which validate
near-100% against the same corpus), `vl2matplotlib` targets a structurally
different, hand-built drawing model with its own documented gaps, so a
plain pass/fail over the corpus wouldn't distinguish "this is a real bug"
from "this spec uses a feature this project has decided not to implement
yet." `tests/validate_examples.py` instead buckets every spec in
`vega-lite-example-specs/` three ways:

- **OK** — translated and executed without error.
- **Skipped** — translation raised an `"Unsupported: ..."` error (a
  documented scope boundary, see the feature table in `README.md`).
- **Failed** — anything else. A real bug, worth investigating.

At the time of writing: **472/633 OK, 154/633 skipped, 7/633 failed** (v1
launched at 368/249/16; v2 closed the gap to 439/177/17 — see "v2: new
marks, and the gap between 'renders' and 'renders correctly'" above; v2.1
closed it further — see "v2.1: grouped bars, conditional color, nested
fields, and a shared runtime module" above). `tests/validate_rendering.py`
runs the same corpus a second way: for every spec that translates *and*
executes cleanly, it introspects the resulting `Figure`'s own `Axes`
children (`ax.patches`/`ax.lines`/`ax.collections`/`ax.texts`) for two
failure shapes an exception-only check can't catch — a script that runs
without error but draws nothing at all, and one that draws only NaN-valued
(off-screen) geometry. Neither occurred: **0/472 OK renders are empty or
all-NaN**. Note that this check, by construction, cannot catch the *other*
class of "renders but is wrong" bug v2/v2.1 fixed (a technically-non-empty,
non-NaN bar that's still a barely-visible sliver, or one drawn at the
wrong position, or the right position but the wrong flat color) — those
were only found by actually looking at rendered output, not by any
automated check in this harness.
