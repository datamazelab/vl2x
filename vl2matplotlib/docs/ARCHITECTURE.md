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

## v2.2: `repeat`, and closing out the mark-orientation/ambiguous-type bug class

Prompted by a direct list of still-broken showcase examples and a request
to prioritize fixes by how often each *class* of error actually occurs
across the corpus's own `ignore_unsupported` build (not just the strict-
mode OK/skip/fail counts) — collecting and bucketing every distinct error
message across all 633 specs' generated code turned up one dominant,
previously entirely-unimplemented gap, plus several smaller instances of
the exact "ambiguous-type field" bug class v2/v2.1 already fixed in other
call sites.

- **`repeat` went from "documented gap, crash-prone fallback" to a real
  implementation.** The v1-era `ignore_unsupported` fallback ("render the
  template once") never substituted the template's own `{"repeat":
  "column"}`-style placeholder fields at all -- every downstream use of
  that field (a `data_var[field]` lookup, a dict used as a `groupby()` key,
  ...) received a literal Python `dict` instead of a real field name,
  `TypeError: unhashable type: 'dict'` (23 of the corpus's ~86 pre-existing
  showcase failures, the single largest bucket by far). Implemented
  properly instead: `_substitute_repeat_refs()` recursively replaces every
  `{"repeat": "row"|"column"|"layer"|"repeat"}` placeholder (found as a
  `field`/`datum` value at any depth -- `"repeat"` itself is the
  placeholder name a plain-array `repeat: [...]` form uses, matching its
  own top-level key) with the real value for one panel/layer, and
  `translate_repeat()` builds either a `plt.subplots()` grid (the `{row,
  column}`/plain-array forms -- panel *count* is known at translation time
  straight from the spec's own `repeat` array, unlike `facet`'s data-
  dependent count, so this unrolls the same way `hconcat`/`vconcat`/
  `concat` already do) or N layers sharing one `Axes` (`repeat: {layer:
  [...]}`, since Vega-Lite's own semantics for that form is "layer, not
  grid"). One extra fix the `layer` form needed: `color: {datum: {"repeat":
  "layer"}}` (the common real shape -- each layer's color literally *is*
  its own repeat value, e.g. the string `"US Gross"`) isn't a color at all
  once substituted, so every layer fell back to the same default color;
  `translate_repeat()` now detects this specific shape and assigns each
  layer a distinct palette color by index instead (the translate-time
  equivalent of the runtime `__i % 10` palette indexing color/detail
  grouping already uses elsewhere, valid here specifically because a
  `repeat`-as-layer's own layer count, unlike a genuine data-driven
  grouping, is already fully known at translation time).
- **Two more call sites hit the identical "ambiguous-type field" bug
  v2/v2.1 already fixed for `rect`/bar-dodge.** `ax.text()` has no
  matplotlib-native fallback for a raw string position the way `bar()`/
  `scatter()` do (confirmed directly: a bare `ax.text('A', 5, ...)` raises
  `ConversionError` on its own) -- surfaced by a layered bar+text chart
  where the bar layer's own `xOffset` dodge already coerced the shared
  category field to an ordinal integer position while the text layer,
  never having gone through that same forcing, still passed the raw string
  straight through, breaking the shared `Axes`. `_render_text()` now always
  forces an ambiguous position channel nominal (unconditionally, unlike
  `_render_bar()`/`_render_tick()`'s identical fix, which only needs it
  when a dodge is actually present since untyped-string bar/tick positions
  otherwise already work by relying on matplotlib's own native handling).
  Separately, the *temporal* case of the same bug: a `binned`-prefixed
  combined `timeUnit` (see below) used as a bar's category axis fell into
  the existing quantitative-heuristic width branch's fallback (a bare
  `0.8`), which is ~0.8 *days* wide next to month-scale gaps between bars
  -- an invisible hairline, not a real bar -- and `xOffset`'s own dodge
  shift tried adding that same bare float directly to a `pd.Timestamp`
  column, `TypeError: unsupported operand type(s) for +: 'DatetimeArray'
  and 'float'`. Both fixed by extending the existing per-category-axis
  width heuristic to recognize a `temporal` `scale_type()` (its own
  `.max() - .min()` naturally produces a `pd.Timedelta` via Timestamp
  subtraction rather than a plain float -- matplotlib's own `bar()`/
  `barh()` already accept either for `width=` on a date axis, so only the
  single-category fallback literal needed to differ, `pd.Timedelta(days=1)`
  instead of `0.8`).
- **`timeUnit`'s own `"binned"` and `"utc"` prefixes** (`binnedyearmonth`,
  `binnedutcyearmonthdate`, ...) were entirely unrecognized -- not even
  reaching `is_supported_timeunit()`'s own lookup table at all, since the
  prefixed name itself was never a key in it. Fixed with
  `_normalize_unit_name()`: a `binned`-prefixed `timeUnit` needs no
  re-derivation logic different from its own non-binned counterpart (the
  *value* driving the extraction expression is already at that granularity
  either way, the same reasoning `prepare.py`'s own `bin: "binned"`
  handling for a plain numeric bin already established); `utc` is simply
  ignored, since this project has no timezone-aware handling at all,
  local-naive throughout. This alone fixed most of a 5-spec skip bucket
  outright; the one still-failing case in it (`time_parse_binnedutc_
  with_escaped_field`) turned out to have an unrelated, narrower problem
  the `timeUnit` gap had been incidentally masking -- a field name that is
  itself a SQL-expression-shaped string, not a real translation bug.
- **The two-way-facet `ignore_unsupported` fallback rendered an empty
  chart.** `translate_facet()`'s own "unsupported facet shape, render the
  template unsplit" path (`facet: {row: {...}, column: {...}}`, a two-way
  grid this project doesn't build -- a documented gap) merged the child
  spec against a wrapper with `data`/`transform` both explicitly `None`,
  discarding the *already-loaded-and-transformed* `data_var` from earlier
  in the very same function and leaving the child to load its own (usually
  entirely absent, since facet children typically inherit data from the
  facet wrapper) data instead -- silently producing `pd.DataFrame()`. Fixed
  by threading `data_param=data_var` through instead, reusing the same
  already-prepared frame every real (single-field) facet panel already
  does.

## v2.3: normalized/centered stacking, value-based color mapping, and N-way binning

Prompted by a direct list of six specific showcase examples reported as
visually wrong despite translating and executing without error — a
different failure shape than v2.2's, since every one of these bugs
produced code that ran cleanly but drew the *wrong picture*, so none of
them showed up in the strict-mode OK/skip/fail counts or
`validate_rendering.py`'s empty/NaN check. Found and verified the same way:
generating each spec's code, reading it, and visually comparing rendered
PNGs before and after.

- **`stack: "normalize"`/`"center"` were silently treated as plain
  zero-baseline stacking.** `stack.py`'s `plan_stacking()`/
  `render_stacking_statements()` previously implemented only the
  zero-baseline `cumsum()` case — a `stack: "normalize"` chart (each
  category's stack rescaled to sum to 1.0) rendered as an ordinary,
  un-normalized stack instead (`stacked_bar_normalize`,
  `stacked_area_normalize`). Both new modes are now real: `normalize`
  divides each value by `groupby(category)[field].transform('sum')` before
  cumulative-summing; `center` cumulative-sums and then shifts by half the
  category's own total, producing a streamgraph straddling zero.
- **Categorical colors ignored `color.scale.range`/`.scheme`/`.domain`
  entirely.** Every color-grouping call site — bar/tick dodge, boxplot,
  `arc`/pie, the generic groupby-and-draw loop in `_grouped_or_single()` —
  built its palette from a hardcoded `plt.get_cmap('tab10').colors`
  regardless of what the spec itself specified
  (`stacked_bar_normalize`'s own `color.scale.range: ["#675193",
  "#ca8861"]` was silently discarded, always rendering default tab10
  blue/orange instead). The renamed `_categorical_color_lookup()` now
  honors an explicit `range` list, a named `scheme` (mapped via a new
  `_CATEGORICAL_SCHEME_MAP` to the closest matplotlib qualitative colormap
  — `category10`→`tab10`, `category20`→`tab20`, `tableau10`/`tableau20`,
  `accent`→`Accent`, `dark2`→`Dark2`, `paired`→`Paired`,
  `pastel1`/`pastel2`, `set1`/`set2`/`set3`), and — when a spec gives
  *both* `scale.domain` and `scale.range` of equal length — builds a
  literal `domain[i] → range[i]` **value** map instead of an
  index-ordered palette matched by draw/row order.
- **`arc`'s own `order` channel was entirely unhandled.** That
  domain/range value-vs-index distinction matters concretely for
  `arc_pie_pyramid`: its data rows arrive in one order but its
  `order: {field: "order"}` channel specifies a *different* intended wedge
  sequence, and its `color.scale` gives both `domain` and `range` — so a
  naive index-based palette (matched to raw row order) would have painted
  the wrong category the wrong color even after the palette itself
  respected `range`. `_render_arc()` now sorts by the `order` field's
  values before drawing when present, and (via the value-map fix above)
  looks up each wedge's color by its own category value rather than by
  position in the draw sequence.
- **Only one bin channel was ever supported.** `_prepare_binned()` raised/
  truncated when more than one encoding channel carried a `bin` — a chart
  binning *both* `x` and `y` (`circle_binned`, a 2D histogram) got real
  binning on one axis and raw, ungrouped values on the other, so the
  second axis showed many thin unbinned points instead of a binned grid.
  Rewritten to loop over every bin channel, each getting its own
  uniquely-named `__edges_<field>` variable (so two different binned
  fields don't clobber each other's edge variable), then grouping by the
  *union* of every channel's own bin-start/bin-end columns before the
  final aggregate.
- **`bin: {"binned": true, "step": N}` (the object-form spelling of
  "already binned") wasn't recognized** — only the bare string `"binned"`
  was, from an earlier session's fix — so `bar_binned_data`'s
  already-binned `bin_start`/`bin_end` data got *re-binned* via
  `np.histogram_bin_edges`'s default bucket count, producing entirely
  wrong intervals. The new `_is_pre_binned()` helper recognizes both
  spellings; `prepare_encoding()`'s bin-channel filter now calls it
  instead of comparing directly against the string.
- **`longitude`/`latitude` encoding channels weren't recognized as
  position channels at all** (only `x`/`y` were) — so
  `point_angle_windvector` fell through `position_column()`'s "no field at
  all" fallback on both axes, putting every one of its ~600 rows at the
  literal same `(0, 0)` position: visually a single dot, not a wind-vector
  field. Fixed with a translate-time spec rewrite, `_fallback_geo_position()`
  (wired into `translate_top()` right after `_unescape_field_refs()`),
  that recursively renames `encoding.longitude`→`encoding.x` and
  `encoding.latitude`→`encoding.y` in place wherever `x`/`y` aren't
  already present, at any nesting depth — matching `vl2ggplot`'s own
  documented "plot as a plain unprojected x/y scatter" fallback for the
  identical gap. (This does not attempt real map projection; a `geoshape`
  mark using one, e.g. `geo_circle`, remains a separate, still-unsupported
  failure.)
- **A many-category legend could cover the entire plot.** Found purely by
  visual inspection, after the two fixes above already made
  `stacked_area_normalize`'s underlying stacking math and generated code
  provably correct — the rendered PNG still looked blank. Cause: a plain
  `ax.legend(title=...)` with no explicit location lets matplotlib choose
  its own "best fit" spot *inside* the Axes; with 14 category entries on a
  compact (3.1×2.1in) figure, that auto-placed box happened to sit
  directly on top of the plotted area it was meant to label. A new shared
  `_legend_stmt()` helper replaces every `.legend(title=...)` call site (5
  of them, across bar dodge, tick dodge, boxplot, `arc`, and the generic
  groupby loop) with one that places the legend outside the Axes
  (`bbox_to_anchor=(1.02, 1), loc='upper left', borderaxespad=0`).

Net effect on the strict-mode corpus: **504/633 OK, 121/633 skipped,
8/633 failed** (up from v2.2's 496/129/8 — the 2D-binning fix alone moved
8 specs from skip to OK; the rest of this pass's fixes change *how* an
already-OK spec renders, not whether it counts as OK, so most don't move
the bucket counts at all). The showcase's own best-effort build stayed
flat at **578/633** (down 1 from v2.2's 579, noise-level — these fixes are
"renders correctly" corrections, not "doesn't crash" ones, so a shift in
the best-effort count isn't the metric that matters for this pass; the
six originally-reported issues and the legend bug were all confirmed fixed
by direct visual re-inspection of the rendered PNGs instead).

## v2.4: two new transforms, per-panel/child color sharing, and hconcat/vconcat sizing

Another visual-QA-driven round, prompted by a second list of eight
specific showcase examples still rendering wrong. Each was found and
verified the same way as v2.3's own pass: generating the spec's code,
reading it, and comparing rendered PNGs against the corpus's own real
Vega-Lite reference thumbnails (`showcase/thumbs_png/`, rendered via the
actual Vega runtime — the one genuinely authoritative source available for
"what should this look like").

- **A bar mark with only its category channel encoded drew zero-length,
  invisible bars.** `bar_1d_dimension_only.vl.json`'s own shape: `mark:
  {type: "bar", orient: "horizontal"}`, only `y` given, no `x`/`x2` at
  all. Vega-Lite still draws one bar per row in this case, each spanning
  the *entire* plot area along the missing axis — there's no data to size
  it by — not a zero-width sliver. `_render_bar()`'s own `top_expr`
  previously fell back to a bare `"0"` when the value channel had no
  field; now, when *both* the field and its `x2`/`y2` companion are
  missing, it draws at `width=1`/`height=1` under a blended transform
  (`ax.get_yaxis_transform()`/`get_xaxis_transform()`, data coordinates on
  the category axis, axes-fraction `[0, 1]` on the missing value axis) —
  matplotlib's own documented way to mean "fill the whole axes" when
  there's no real data scale to size against.
- **An ordinal field's own categories always sorted lexicographically,
  even when the field is numeric.** Every category-list `sorted(...)` call
  in this project (`position_column()`'s own ordinal branch, a facet's
  `__facet_vals`, a dodge's `__dodge_cats`, `_grouped_or_single()`'s
  `__groups`, `translate_facet()`'s `cats_var`) used a flat `key=str`,
  which sorts numeric categories as strings (`1, 10, 11, 12, 2, 3, ...`)
  instead of numerically — surfaced by `selection_layer_bar_month.vl.
  json`'s own `timeUnit: "month"` x-axis (a cyclic timeUnit reduces to a
  plain int 1-12, see v2.2's own `_normalize_unit_name()`), which
  rendered its 12 months in that same broken lexicographic order instead
  of calendar order. Fixed with one shared `ORDINAL_SORT_KEY` (`scales.py`)
  — numbers sort numerically among themselves, strings lexically among
  themselves, numbers before strings — used at all five call sites.
- **The `density` transform (a kernel density estimate) was entirely
  unimplemented**, so any spec using it (`area_density.vl.json` and its
  `_facet`/`_stacked`/`_stacked_fold` siblings) skipped the transform
  outright and then crashed with `KeyError` the moment an encoding channel
  referenced the (never-created) `value`/`density` output columns. A real
  Gaussian-kernel KDE is now computed via a new `vl_density()` runtime
  helper (`runtime.py`) — pandas/numpy have no built-in density-estimation
  convenience the way R's `stats::density()` does, so this is a genuine
  KDE computed inline, not an approximation, mirroring `vl2ggplot`'s own
  `stats::density()`-based version and `vl2d3`'s hand-rolled D3 one
  (bandwidth defaults to Silverman's rule of thumb / R's `bw.nrd0`,
  matching both siblings). A second, unrelated bug the same investigation
  turned up: `_derived_field_names()` (`translator.py`) — the "don't
  coerce a column before the transform that creates it has run" guard
  every transform type already gets — never accounted for `density`'s own
  *default* `as` (`["value", "density"]`, used whenever a spec omits `as`
  entirely, the overwhelmingly common case); now defaulted there too.
- **The `pivot` transform (`fold`'s inverse) was entirely unimplemented**
  too, a real, if less common, corpus gap (`line_color_halo.vl.json`'s
  own workaround-shaped `pivot: "symbol", value: "price", groupby:
  ["date"]`, used to turn one long stock-price table into one column per
  ticker so `repeat: {layer: [...]}` could plot each as its own line).
  Implemented via a new `vl_pivot()` runtime helper, mirroring `vl2d3`'s
  own `vlPivot()`/`vl2ggplot`'s own `vl_pivot()` (real per-group
  bookkeeping: collect duplicates per pivot key, aggregate them — default
  `op: "sum"`, Vega-Lite's own default — keep a stable, possibly
  `limit`-truncated column ordering). Exposed the identical "coerced
  before the transform creates it" bug class as `density` above, but with
  no fixed default `as` to special-case around — a `pivot`'s own output
  *column names* are literally the runtime values of its pivot field,
  unknowable at translation time at all. Fixed more generally instead:
  `render_temporal_coercion()`/`render_quantitative_coercion()` (`data.py`)
  now guard every coercion statement on the column actually existing yet
  (`if field in df.columns: ...`), a no-op instead of a `KeyError` for any
  field that isn't there yet regardless of *why* — covering `pivot`'s
  dynamic columns without needing to know their names in advance.
- **`sequence_line_fold.vl.json` had two separate, unrelated bugs.** Its
  own `data: {sequence: {start, stop, step, as}}` generator (a synthetic
  numeric sequence, no corpus spec had exercised before) wasn't a
  recognized data source shape at all, falling through to an empty
  `pd.DataFrame()`; added to `data.py`'s `render_data_load()` via a direct
  `np.arange()` call, matching Vega-Lite's own half-open, step-based
  range semantics exactly. Separately, its `calculate: "sin(datum.x)"`
  expression used Vega's *bare* (non-`Math.`-prefixed) trig functions
  (`sin`, `cos`, `tan`, ...), which `expr.py`'s own `_BARE_MATH_FUNCS`/
  `_MATH_FUNCS` tables never mapped at all (only `ceil`/`floor`/`round`/
  `sqrt`/`log`/`exp` were) — translated through completely unchanged into
  a bare `sin(...)` Python call with no `sin` in scope, `NameError`. Both
  tables now also cover `sin`/`cos`/`tan`/`asin`/`acos`/`atan`/`atan2`/
  `sinh`/`cosh`/`tanh`/`log2`/`log10`/`hypot`/`trunc`, all routed through
  `math.*`.
- **Every categorical color assignment indexed a palette by *local* draw
  order, not by the field's real domain** — invisible for a plain,
  ungrouped chart (the local order *is* the real order there), but wrong
  the moment the same call site runs on a data slice that's only a
  *subset* of the field's true domain: a facet panel already filtered to
  one category (`trellis_bar.vl.json`'s own `row: {field: "gender"},
  color: {field: "gender"}` — the Male panel's only locally-visible
  category is "Male," so it always lands on `range[0]`, the *same* color
  a Female panel's own single value also gets). Fixed for facet panels via
  `_share_color_domain()` (`translator.py`): when a panel's own `color`
  reads the same field the facet itself splits on, the facet's already-
  computed full-domain variable (`__facet_vals`, built from the
  *pre-split* data) is threaded into the color scale as a new internal-
  only `_domain_expr` convention `_categorical_color_lookup()` checks
  first — every panel then builds an identical `value -> color` map at
  runtime instead of reassigning colors per panel. A *second*, related
  case: `concat`/`hconcat`/`vconcat` siblings that each filter down to one
  distinct value of the *same* color field via their own `transform`
  (`concat_population_pyramid.vl.json`'s own Female/Male panels, each
  `{filter: {field: "gender", equal: "Female"|"Male"}}`) — here the shared
  domain values are literal strings already sitting right there in the
  spec, so `_share_categorical_color_domain()` builds a real, static
  `scale.domain` directly at translation time instead (no runtime
  plumbing needed), which `_categorical_color_lookup()`'s existing
  domain-and-range "map" kind already handles.
- **`repeat`'s plain-array form ignored its own top-level `columns`
  entirely**, always laying every repeat value out in a single row
  regardless (`repeat_histogram.vl.json`'s own 4-field repeat with
  `"columns": 2`, meant to land as a 2x2 grid, rendered as 1x4).
  `translate_repeat()` now computes `nrows`/`ncols` from `columns` for
  this form exactly the way `concat`'s own grid direction already does
  (`-(-n // columns), columns`) — the dict-shaped `{row: [...], column:
  [...]}` form, which specifies its own grid dimensions directly, is
  unaffected.
- **A *continuous* `color` field on a `point`/`circle`/`square` mark was
  silently ignored, always drawing the flat default color.**
  `_color_source()` deliberately excludes a continuous color field (by
  design — see its own docstring), expecting a caller to handle that case
  itself via `_continuous_color_setup()`; `_render_rect()` already did,
  but `_render_point()` never did at all (`point_angle_windvector.vl.
  json`'s own `color: {field: "dir", type: "quantitative", scale:
  {scheme: "rainbow"}}`, entirely dropped). Fixed by giving `_render_point()`
  its own continuous-color branch, using `scatter()`'s native `c=`/`cmap=`/
  `norm=` kwargs directly (a real per-point colormap lookup, vectorized,
  no `df.iterrows()` loop needed) instead of `_render_rect()`'s per-row
  `cmap(norm(row[field]))` expression, which `scatter()` doesn't need.
- **`color.legend: null` was never honored anywhere** — every categorical
  color grouping call site (5 of them) always drew a legend regardless,
  and the two continuous-color colorbar call sites (`rect`, and the new
  `point` branch above) always drew a colorbar. A real, common cause of a
  chart looking cluttered/wrong: `concat_population_pyramid.vl.json`'s own
  Female/Male panels each explicitly set `color.legend: null` (the
  panel's own title already says which gender it is), but still rendered
  a redundant one-entry legend eating a third of each panel's width. Fixed
  with one shared `_legend_hidden()` check (`marks.py`), gating every
  `_legend_stmt()` call and both colorbar statements.
- **`concat`/`hconcat`/`vconcat` children all got the same shared panel
  size regardless of their own explicit `width`/`height`.** A real,
  common "small multiples with one narrow label column" shape
  (`concat_population_pyramid.vl.json`'s own middle age-label panel,
  `"width": 20` sandwiched between two full-width bar panels) rendered
  every panel at an identical width instead. `translate_multi()` now
  passes `gridspec_kw={'width_ratios': [...]}` (`hconcat`) or
  `{'height_ratios': [...]}` (`vconcat`) — matplotlib's own documented way
  to give `subplots()` unequal panel sizes — computed from each child's
  own `_panel_size()`. Scoped to a plain single row/column, not a general
  multi-row/column `concat` grid, where a per-cell size would need both
  ratios reconciled across every row *and* column sharing a track, a
  bigger change than this narrower, much more common case.
- **A continuous *value*-axis `sort: "descending"` was never honored on
  any position channel**, needed for the other half of
  `concat_population_pyramid.vl.json`'s own population-pyramid mirroring
  trick: the Female panel's `x: {aggregate: "sum", field: "people", ...,
  sort: "descending"}` is meant to make its bars grow leftward instead of
  rightward, mirroring the Male panel outward from a shared center.
  `_axis_setup_stmts()` now calls `ax.invert_<channel>axis()` for a
  `sort: "descending"` continuous (non-ordinal) position channel; also
  newly called at all for a bar mark's own *value* channel in the first
  place (`_render_bar()` only ever set up the *category* channel's axis
  before), which incidentally also fixed a bar's value-axis `title` never
  rendering (`x: {..., title: "population"}` was silently dropped too).

Net effect on the strict-mode corpus: **512/633 OK, 113/633 skipped,
8/633 failed** (up from v2.3's 504/121/8 — `density`/`pivot` support
alone moved 8 specs from skip to OK; the rest of this pass, like v2.3's
own, mostly changes *how* an already-non-crashing spec renders rather
than whether it counts as OK). The residual 8 failures are unchanged in
substance from v2.3's own list — see the feature table above for the
current, precise list. The showcase's own best-effort build went from
578/633 to **586/633** over this pass. A visual re-inspection of all eight
originally-reported examples plus `concat_population_pyramid.vl.json`
(compared directly against its real Vega-Lite reference render in
`showcase/thumbs_png/`) confirmed every one fixed.

## v2.5: text color, size/log scales, a new `trail` mark, and two more transforms

A third visual-QA-driven round, prompted by a third list of six specific
showcase examples still rendering wrong (one of them, `parallel_coordinate.
vl.json`, also reported broken for `vl2ggplot`/`vl2d3` — out of scope for
this module, tracked separately). Same methodology as v2.3/v2.4: generate,
read the code, compare rendered PNGs against ground truth.

- **A `text` mark's own `color` field was dropped entirely** — every label
  always drew in matplotlib's own default black, regardless of the spec
  (`text_scatterplot_colored.vl.json`'s own `color: {field: "Origin"}`).
  `_render_text()` draws via one `zip()` loop, not `_grouped_or_single()`'s
  one-call-per-group idiom every other mark's own color support is built
  on, so it never had a way to *use* `_categorical_color_lookup()`'s
  `_domain_expr` convention (see v2.4's own facet/concat color-sharing
  entry) until now — reused here too, pointed at the field's own local
  sorted unique values, plus `_continuous_color_setup()` for a quantitative
  `color` field.
- **A `size`-encoded `point`/`circle`/`square` marker used the raw field
  value directly as matplotlib's own `s=` (marker *area* in points^2)** —
  harmless for a field that happens to already sit in a plausible pixel
  range, but `circle_bubble_health_income.vl.json`'s own `size: {field:
  "population"}` (tens of millions) rendered as one solid black rectangle
  covering the entire plot. A new `_size_scale_expr()` rescales into a
  fixed, reasonable area range (`scale.range`/`.rangeMin`/`.rangeMax`
  win when given, else `[20, 1000]`) via a square-root interpolation
  (matching `vl2d3`'s own `d3.scaleSqrt()`-based size scale — area should
  grow linearly with the data value, the standard perceptually-fair
  bubble-chart convention). The same investigation surfaced a second,
  unrelated, entirely-missing feature in the same spec: `scale: {type:
  "log"}` had been recognized by `scale_type()` since this module's own
  introduction but never actually wired to `ax.set_xscale`/`set_yscale` —
  every log-scale spec silently rendered on a plain linear axis instead.
  Both gated the same underlying "raw value density" symptom in this one
  spec; fixing only one would have left it visually broken.
- **`mark: {type: "line", point: true}` never drew the point overlay**
  (`line_bump.vl.json`). `mark_props` already captured every mark-object
  key besides `type` — `point` specifically was just never consulted;
  `_render_line_or_area()` now adds `marker='o'` to the `ax.plot()` call
  when it's truthy.
- **The `trail` mark (a line whose own *width* varies along its length
  with a `size` field) was entirely unimplemented** — a documented v1
  scope gap, silently skipped under `ignore_unsupported` and drawing
  nothing (`trail_color.vl.json`'s own per-symbol stock-price trail,
  thicker where `price` is higher). matplotlib's `ax.plot()` has no
  per-segment-width line primitive at all; implemented instead via
  `matplotlib.collections.LineCollection` (one segment per consecutive
  point pair, each with its own linewidth — the standard matplotlib
  variable-width-line recipe), conditionally imported the same way
  `math`/the runtime module are. Two more bugs surfaced by exercising this
  new mark against the rest of the corpus (not the originally-reported
  spec, but two others `ignore_unsupported` had been silently masking by
  skipping the mark outright): `circle_natural_disasters.vl.json`/
  `point_shape_custom.vl.json` hit the exact same "translation-time
  variable name embeds `data_var` as a substring, so `.replace(data_var,
  rows)` inside a groupby loop corrupts the name" bug class `_render_bar()`'s
  own `width_var` already had a documented fix for — `_render_point()`'s
  own `size_expr` (from the new `_size_scale_expr()` above) needed the
  identical `.loc[rows.index]`-based fix; `trail_comet.vl.json` needed an
  ordinal-forcing fix for an ambiguous nominal position channel (the same
  class `_render_bar()`/`_render_tick()`/`_render_rect()` already have),
  since `LineCollection` needs real numeric coordinates.
- **Two more transforms**: `quantile` (empirical quantiles of a field,
  sampled at evenly-spaced probabilities — a new `vl_quantile()` runtime
  helper) and Vega's `quantileUniform`/`quantileNormal` expression
  functions (the inverse CDF of a Uniform/Normal distribution, most often
  paired with `quantile`'s own output for a Q-Q plot,
  `point_quantile_quantile.vl.json`'s own shape) — `quantileNormal` routes
  through the standard library's `statistics.NormalDist().inv_cdf()`, no
  new dependency needed, conditionally imported like `math`/`LineCollection`.
- **`fold` dropped the fields it folded**, unlike real Vega-Lite (which
  keeps *every* original field on each output row, including the ones
  just folded) — invisible until a later transform read one of those
  fields back by name (`trail_comet.vl.json`'s own `calculate:
  "datum['1932'] - datum['1931']"`, straight after folding exactly
  `"1931"`/`"1932"`), which a plain `melt(id_vars=<everything except the
  folded fields>)` can't produce at all (a column can't simultaneously be
  an id_var and a value_var). Confirmed against both sibling
  implementations for the correct semantics — `vl2d3`'s own
  `renderFoldTransform()` (`{...d, key: f, value: d[f]}`, spreading the
  *whole* original row) and `vl2ggplot`'s own `render_fold_transform()`
  (`.d <- var_name; .d[[key]] <- .f; ...`) both already do this — fixed by
  melting only the non-folded columns (`ignore_index=False`, preserving
  the original row index) and rejoining the folded fields' own original
  values back by that same index afterward. A related, second bug in the
  same investigation: `vl_pivot()`'s own output columns kept whatever raw
  dtype the pivot field itself had (e.g. real ints `1931`/`1932`), but a
  later transform referring to one of those columns always does so via a
  *string* literal (Vega-Lite's own pivot always names a column the way a
  JS object key would — implicitly stringified regardless of the source
  field's dtype) — `vl_pivot()` now always coerces its own new column
  names to `str()`.
- **`toNumber(...)`** (Vega's own explicit, unambiguous string-to-number
  coercion — distinct from the bare unary `+` this project deliberately
  still doesn't translate, see v2.1's own reasoning for why that one stays
  out) now maps directly to Python's `float`.

`parallel_coordinate.vl.json` (the sixth reported example) was
investigated but *not* fixed: its own layered "manually construct axes"
technique (explicitly named as such in the spec's own description) mixes
a data-driven position channel (a `line` layer's own `y: {field:
"norm_val"}`, normalized to `[0, 1]`) with sibling layers positioned via a
literal *pixel*-space `y: {value: 0|150|300}` meant to align with that
same normalized range only because Vega-Lite's real renderer maps a `[0,
1]` domain onto the view's own full pixel height. This project's `value`
channel handling (correct and load-bearing everywhere else in the corpus)
treats every `value` as a literal *data*-coordinate position; reconciling
the two coordinate spaces across independently-rendered sibling layers
sharing one `Axes` would need new, layer-composition-level machinery, not
a targeted fix. Confirmed harmless in isolation (transforms execute
cleanly, no exception) but visually flattened (the shared Axes'
autoscale stretches to fit the pixel-space values 0-300, squeezing the
real `[0, 1]`-range line data down to an imperceptible sliver) — left as a
known, narrower gap rather than a risky, speculative general heuristic.

Net effect on the strict-mode corpus: **515/633 OK, 110/633 skipped,
8/633 failed** (up from v2.4's 512/113/8 — `quantile` support moved
`point_quantile_quantile.vl.json` and the `trail` mark implementation
moved `trail_color.vl.json`/`trail_comet.vl.json` from skip to OK; the
rest of this pass, like v2.3/v2.4's own, mostly changes *how* an
already-non-crashing spec renders). The residual 8 failures are unchanged
in substance — see the feature table above for the current, precise list.
5 new regression tests cover the newly-implemented/fixed behavior
(`test_text_mark_color_field_colors_each_label`,
`test_point_size_field_scales_into_a_reasonable_area_range`,
`test_line_point_marker_draws_at_each_data_point`,
`test_quantile_transform_produces_probability_value_pairs`,
`test_fold_transform_keeps_the_original_folded_fields`), plus
`test_trail_mark_draws_a_variable_width_line` from the mark's own
implementation above.

## v2.6: window semantics, orientation, dodge+stack, and disabled color scales

A fourth visual-QA-driven round, prompted by a fourth list of specific
showcase examples (fourteen named, several more found investigating them).

- **JS string-concatenation `+` and unary `+`** (`waterfall_chart.vl.
  json`'s own `"(cond ? '+' : '') + datum.amount"`, `wheat_wages.vl.
  json`'s own `"+datum.year + 5"`) -- both previously left untranslated on
  purpose (see v2.1's own reasoning: a bare `+` is genuinely ambiguous
  between string concat and numeric addition). Implemented for the two
  *unambiguous* sub-cases instead of the fully general (unsafe) one: a
  binary `+` where one side is provably a string (a literal, or a ternary
  whose both branches are), and a unary `+` in an unambiguous *unary*
  syntactic position (start of expression, right after an operator/`(`/
  `,`), applied only to the single following `row[...]` or `(...)`
  operand it binds to.
- **A `window` transform with no `frame` given at all used the whole
  partition**, not a running/cumulative total -- an earlier, unverified
  assumption (`waterfall_chart.vl.json`'s own `window: [{op: "sum", ...}]`
  repeated the *grand total* on every bar instead of each one's own
  cumulative sum). Vega-Lite's real default frame is `[null, 0]`
  (cumulative up to the current row); `vl_window()` now matches. Also
  implemented: `lag`/`lead` (a single `.shift()`, previously a
  documented no-op), and `rank`/`dense_rank` now break ties using the
  *full* `sort` order (every field, not just the first) --
  `window_rank.vl.json`'s own two teams tied on `point` needed `diff` to
  rank correctly.
- **The top-level `stack` transform** (an *explicit* version of
  `stack.py`'s own implicit per-mark stacking, producing real `as`
  columns instead of being inferred from the mark's encoding --
  `stacked_bar_population_transform.vl.json`'s own shape) was entirely
  unimplemented; added via a new `vl_stack()` runtime helper sharing the
  same zero/normalize/center math. Exposed two more real, general bugs in
  the process: `_render_aggregate()`/`_render_joinaggregate()` sanitized
  an `as` name for pandas' own keyword-arg syntax but never renamed the
  column back to the spec's own literal name afterward (`rect_mosaic_
  simple.vl.json`'s own `as: "count_*"` produced a column actually named
  `count__`, so a later `stack: "count_*"` couldn't find it) -- fixed by
  renaming back (aggregate) or simply not sanitizing at all where the
  original bracket-assignment code never needed a valid identifier in the
  first place (joinaggregate).
- **A layer child's own explicit `data` still inherited the wrapper's
  top-level `transform`**, crashing the moment that transform referenced
  a field the child's own (different) dataset doesn't have
  (`wheat_wages.vl.json`'s own monarchs.json layers, siblings of the
  main wheat/wages ones, sharing the wrapper's `calculate: "+datum.year +
  5"`). `_merge_down()` now only merges the wrapper's transform into a
  child that also inherits the wrapper's *data*.
- **`_force_nominal_if_ambiguous()` inside `_render_rect()` forced a span
  channel's own numeric field ordinal even when it had a real `x2`/`y2`
  companion** -- a `field`+companion pair is a genuine numeric span (bin
  edges, a start/end range) almost always, never a categorical label pair;
  forcing it ordinal turned `wheat_wages.vl.json`'s own monarchs' reign
  timeline into one absurdly wide rectangle per row (a tiny ordinal code
  subtracted from a real four-digit year). Now skipped whenever a
  companion field is present.
- **A categorical `color` field on `rect`'s own single-axis span shape
  (`axvspan`/`axhspan`) was never wired up at all** -- `_color_source()`
  only ever returns a *group field name* for this case (there's no
  per-group draw loop the way other marks have; `rect`'s span shape draws
  via one shared `df.iterrows()` loop), so every span silently fell back
  to the same flat default color (`layer_falkensee.vl.json`'s own Nazi-
  Rule/GDR background bands, meant to be two different colors). Fixed via
  a per-row `value -> color` map, the same `_domain_expr` convention
  `_render_text()`'s own color support already established.
- **`mark: {invalid: null}` (keep null rows instead of filtering them)
  silently shrank the visible domain-axis range** -- `fill_between()`'s
  own internal NaN-masking excludes a null-value row from its bounding
  box entirely, cropping the x-axis to only the *valid* rows' own extent
  (`area_invalid_null.vl.json`'s own edge rows, `x: -1, y: null` / `x: 10,
  y: null`, vanished from the visible range instead of showing as a gap
  within a -1..10 domain). Fixed by explicitly extending the domain
  axis's own limits to the full column's range whenever `invalid: null`
  is set.
- **An area/line mark's own orientation was always assumed vertical** (x =
  domain, y = value) -- wrong whenever x is the quantitative *value*
  channel and y is the domain one instead (`area_vertical.vl.json`'s own
  `x: {aggregate: "sum", ...}, y: {timeUnit: "year", ...}`, an area chart
  running sideways). Affects which field rows are sorted by before
  drawing (wrong axis -> a scrambled zigzag instead of a smooth curve) and,
  for `area` specifically, `fill_betweenx()` vs `fill_between()` (not
  interchangeable). Detecting this needed more than a plain
  `is_quantitative()` check on both channels: a bare *single* `timeUnit`
  like `"year"` reduces to a plain int (this project's own cyclic-timeUnit
  convention), which reads as quantitative too by the time `marks.py` ever
  sees it (`prepare.py` already rewrote it into a flat column with `type:
  "quantitative"` baked in for orientation-inference purposes elsewhere).
  A new internal-only `_was_timeunit` marker survives that rewrite so
  `_render_line_or_area()` can still tell a genuine value channel apart
  from a domain one that merely reads as quantitative too.
- **A grouped (`xOffset`) bar mark's own `color`, when it named a
  *different* field than the dodge channel, was silently dropped** --
  color/stacking were only ever wired up when `color` happened to share
  the *same* field as `xOffset` (the far more common "grouped, not also
  stacked" shape); a genuinely different color field
  (`bar_grouped_stacked.vl.json`'s own dodge-by-Origin, color/stack-by-
  year) fell back to a flat default color with every color's own bar
  drawn *unstacked*, fully overlapping at the identical dodge position
  (only the tallest visible). Fixed by stacking within each dodge slot
  (`groupby(category).cumsum()`, the same formula `stack.py`'s own
  zero-baseline mode uses) whenever `color` names a real, different,
  non-quantitative field.
- **A *continuous* `color` field on a `bar` mark was dropped entirely** --
  `_render_bar()` never had a continuous-color branch of its own the way
  `rect`/`point` do (`bar_invalid_color_show_override.vl.json`'s own
  `color: {field: "c", type: "quantitative"}`). A second, related bug in
  the same spec: `plan_stacking()`'s own group-channel detection never
  checked `is_quantitative()`, so a continuous color/opacity field was
  wrongly treated as a categorical *grouping* field, silently stacking
  bars that were never meant to stack at all. Both fixed: `_render_bar()`
  gained a continuous-color branch (`ax.bar()`'s own `color=` accepts a
  per-bar array, unlike a single value), and `plan_stacking()` now
  excludes a quantitative field from its group-channel search.
- **`color.scale: null` (Vega-Lite's "disable scale" convention -- the
  field's own raw values *are* literal CSS colors already, not categories
  to map through a palette) was indistinguishable from `scale` being
  absent entirely**, both falling through to the same default categorical
  palette (`bar_color_disabled_scale.vl.json`'s own `color: {field:
  "color", scale: null}`, a column of `"red"`/`"green"`/`"blue"` strings,
  silently reassigned arbitrary tab10 colors instead). `_categorical_
  color_lookup()` now returns a new `"raw"` kind (the group key's own
  string value, used directly) whenever `scale` is explicitly `null`,
  handled at all five of its own call sites.
- **The `shape` encoding channel was entirely unimplemented** -- every
  point mark drew as matplotlib's own default circle regardless of the
  spec. A fixed `{value: ...}` now picks one marker for every point
  (`point_color_shape_constant.vl.json`); a field-based `shape` grouping
  by the *same* field `color` already does now assigns a different marker
  symbol per category too (`point_color_with_shape.vl.json`'s own
  `shape`/`color` both keyed to `Species`) via a `_DEFAULT_SHAPE_ORDER`
  ->matplotlib-marker mapping, respecting an explicit `scale.range` of
  shape names when given. A `shape` field independently grouping by a
  *different* field than `color` isn't attempted (a documented, narrower
  gap -- not exercised by the reported specs).
- **`parallel_coordinate.vl.json`** (reported alongside these, also
  broken for `vl2ggplot`/`vl2d3`) was investigated but not fixed -- see
  v2.5's own entry for the full diagnosis (a pixel-space-vs-data-space
  coordinate mismatch across layers), unchanged this round.

Net effect on the strict-mode corpus: **522/633 OK, 105/633 skipped,
6/633 failed** (up from v2.5's 515/110/8 -- the `stack` transform and the
`trail`/mosaic fixes moved several specs from skip/fail to OK; two of the
previous round's 8 failures, `waterfall_chart.vl.json` and `wheat_wages.
vl.json`, are now fixed outright). 8 new regression tests cover this
round's fixes.

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

At the time of writing: **522/633 OK, 105/633 skipped, 6/633 failed** (v1
launched at 368/249/16; v2 closed the gap to 439/177/17 — see "v2: new
marks, and the gap between 'renders' and 'renders correctly'" above; v2.1
reached 472/154/17 — see "v2.1: grouped bars, conditional color, nested
fields, and a shared runtime module" above; v2.2 reached 496/129/8,
headlined by a working `repeat` operator — see "v2.2: `repeat`, and
closing out the mark-orientation/ambiguous-type bug class" above; v2.3
reached 504/121/8 — see "v2.3: normalized/centered stacking, value-based
color mapping, and N-way binning" above; v2.4 reached 512/113/8 — see
"v2.4: two new transforms, per-panel/child color sharing, and hconcat/
vconcat sizing" above; v2.5 reached 515/110/8 — see "v2.5: text color,
size/log scales, a new `trail` mark, and two more transforms" above; v2.6
reached 522/105/6 — see "v2.6: window semantics, orientation, dodge+stack,
and disabled color scales" above, and fixed two of v2.5's own residual 8
failures outright, `waterfall_chart.vl.json`/`wheat_wages.vl.json`). The
showcase's own best-effort (`ignore_unsupported=True`) build — exercising
every fallback path, a wider sample than this strict-mode check — went
from 547/633 to 579/633 over v2.2, to 578/633 over v2.3 (noise-level;
v2.3's fixes mostly changed *how* an already-non-crashing spec renders,
not whether it crashed), to 586/633 over v2.4 (the `density`/`pivot`
transform support this time genuinely turning prior crashes into clean
renders), to 588/633 over v2.5 (the `quantile` transform and new `trail`
mark again genuinely turning prior crashes/skips into clean renders), then
to **594/633** over v2.6 (the `stack` transform and the mosaic/aggregate-
naming fixes it exposed). `tests/validate_rendering.py` runs the same
corpus a
second way: for every spec that translates *and* executes cleanly, it
introspects the resulting `Figure`'s own `Axes` children
(`ax.patches`/`ax.lines`/`ax.collections`/`ax.texts`) for two failure
shapes an exception-only check can't catch — a script that runs without
error but draws nothing at all, and one that draws only NaN-valued
(off-screen) geometry. Neither occurred: **0/522 OK renders are empty or
all-NaN** (note this check can't catch `parallel_coordinate.vl.json`'s
own subtler failure — v2.5's own section above — since its line data is
technically non-empty and non-NaN, just visually flattened to a sliver
by a separate, unfixed layered-coordinate-space issue). Note that this
check, by construction, cannot catch the *other* class of "renders but is
wrong" bug v2 through
v2.6 fixed (a technically-non-empty, non-NaN bar that's still a
barely-visible sliver, one drawn at the wrong position, one overdrawing
another rather than sitting side by side, the right position but the
wrong flat color, a stack that isn't actually normalized, or a correct
chart hidden behind its own legend) —
those were only found by actually looking at rendered output (or, in
v2.2's case, by directly collecting and bucketing the showcase's own real
error messages), not by any automated check in this harness.
