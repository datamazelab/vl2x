# Architecture and design notes

This document explains *how* `vl2plot` translates a Vega-Lite spec into
[Observable Plot](https://observablehq.com/plot/) code, why its design sits
between its siblings [`vl2d3`](../../vl2d3) (hand-built, no
grammar-of-graphics layer) and [`vl2altair`](../../vl2altair)/
[`vl2vlapi`](../../vl2vlapi) (mechanical, same-grammar targets), and the
bugs that real execution against a large spec corpus caught along the way.
For usage, see [`../README.md`](../README.md).

## Where Plot sits between its siblings

`vl2altair`/`vl2vlapi` target libraries that already understand Vega-Lite's
own grammar (both compile to a real Vega-Lite spec), so translation is
mostly a mechanical property-to-method mapping. `vl2d3` targets a library
with *no* grammar-of-graphics layer at all, so it has to hand-build scale
inference, axis rendering, and per-mark SVG drawing from scratch.

Observable Plot **is** a grammar-of-graphics layer — `Plot.plot({marks, x,
y, color, facet, ...})` already infers scales, draws legends and axes, and
lays out facets — so this project needs none of `vl2d3`'s own `scales.js`
scale-inference machinery or hand-built facet grid. What Plot *doesn't*
share with Vega-Lite is the data-pipeline shape: Vega-Lite's `aggregate`/
`bin`/`timeUnit` are inline encoding-channel properties, while Plot
expresses the same ideas as composable *transform wrapper functions*
(`Plot.binX`, `Plot.groupX`, `Plot.stackY`, ...) wrapping a mark's own
options object. Translating between those two shapes (`prepare.js`,
`stack.js`) is this project's own equivalent of `vl2d3`'s `prepare.js` — but
considerably thinner, since Plot's own transforms already implement the
actual grouping/binning/stacking math. No hand-rolled `d3.rollup`/`d3.bin`/
cumulative-sum appears anywhere in this project's own mark codegen.

## The `Plot.binX`/`Plot.groupX` pipeline (`prepare.js`)

Vega-Lite lets `aggregate`/`bin` be declared inline on an encoding channel
— e.g. `{"y": {"aggregate": "count"}}` alongside a plain `{"x": {"field":
"cat"}}` — and expects the renderer to group/summarize accordingly.
`prepare.js`'s `planTransform()` looks at the two position channels and
picks one of `Plot.binX`/`Plot.binY`/`Plot.groupX`/`Plot.groupY`, wrapping
the mark's own already-built options object: `Plot.groupY({y: "count"},
{x: "cat"})`. Plot's own transform then groups by *every other
field-valued channel present in the same options object automatically*
(not just its own named axis) — confirmed empirically, and it matches
Vega-Lite's own "every non-aggregate fielded channel is an implicit groupby
key" semantics for free, so this module's only real job is picking the
right wrapper function and its `outputs` object.

**The naming asymmetry that caused a real, silent bug.** `Plot.binX`/
`Plot.binY` are named after the axis *being binned* — `binX` bins the `x`
channel's own values into buckets. `Plot.groupX`/`Plot.groupY` are named
the opposite way: after the *grouping key* axis, not the aggregate's own
output axis. For `{"x": {"field": "cat"}, "y": {"aggregate": "count"}}` —
a plain vertical bar count — `x` is the grouping key and `y` carries the
aggregate, so the correct call is `Plot.groupX({y: "count"}, {x: "cat"})`,
**not** `Plot.groupY`. An early version of `planTransform()` picked the
function by the aggregate's own channel name (`aggChannel === 'x' ?
'groupX' : 'groupY'`) — the same pattern that's correct for `binX`/`binY`
— which is backwards for `group`. The bug didn't crash: `Plot.groupY`
still ran, just grouped by the wrong axis, silently drawing one bar per
*row* instead of one per category (extra, wrong-width, wrong-height bars).
It was caught only once the unit test suite asserted on actual rendered
bar *counts*, not just "did it throw" — exactly the gap
`test/validate-rendering.js` (see below) exists to close for the full
corpus too. The fix: `fn: aggChannel === 'x' ? 'groupY' : 'groupX'` (the
group function is named after the *other* channel from the one carrying
the aggregate).

## Bars with a continuous bin-interval category axis

A bar's category channel can itself carry a companion (`x`/`x2` on a
vertical bar) meaning the category axis is a continuous bin interval, not
an ordinal band — e.g. a log-scaled histogram whose bin edges were computed
by an upstream `calculate` transform (`{"x": {"field": "x1", "scale":
{"type": "log"}}, "x2": {"field": "x2"}}`). This is a genuinely different
shape from Vega-Lite's *other* `x2` use (a floating bar's explicit value
range, e.g. `{"y": {"field": "lo"}, "y2": {"field": "hi"}}`), and Plot has
a distinct idiom for each: `x`/`x2` (ordinary bar, companion on the *value*
axis) vs. `x1`/`x2` (a genuine continuous interval on the *category* axis).
`marks.js`'s `renderBar()` distinguishes them by which channel the
companion is paired with (`${catCh}2` vs. `${valueCh}2`) and emits `x1`/
`x2` for the former — passing a companion straight through as `x`/`x2`
regardless of which axis it belonged to (an earlier draft's behavior) left
Plot inferring an ordinal `band` scale for what was actually a continuous
axis, which then conflicted outright with an explicit `scale: {type:
"log"}` override ("scale incompatible with channel: log !== band"). One
combination remains a documented gap rather than a deeper fix: an
*aggregated* value (`{"y": {"aggregate": "count"}}`) on a bar whose
category axis is a continuous bin interval can't use `Plot.groupY` either
— `group` transforms always treat their own axis as ordinal by design, so
grouping on a continuous `x1`/`x2` pair hits the same log-vs-band conflict
one level up. No native Plot transform "pre-aggregates a count per
continuous bin" cleanly, so this specific combination throws a clear
"Unsupported: ..." instead.

## Stacking (`stack.js`)

Vega-Lite's implicit per-mark stacking (a `bar`/`area` colored by `color`/
`detail`) maps directly onto `Plot.stackX`/`Plot.stackY`'s own native
`offset` option (`"normalize"` for VL's `stack: "normalize"`, `"center"`
for `"center"`, the function's own default for plain `zero`-mode
stacking) — no hand-computed cumulative sum anywhere, unlike every other
sibling's own stack module. `planStack()` in `stack.js` just decides
*whether* stacking applies (excluded when `xOffset`/`yOffset` — dodging —
is present on the same mark, or when the would-be grouping channel is
itself quantitative rather than discrete) and which `offset` value to pass.

## Faceting

Vega-Lite's `facet` maps directly onto Plot's own native top-level `facet:
{data, x, y}` option: every mark whose own `data` argument is that *same
array reference* is automatically faceted by Plot itself, with shared/
consistent scales and axis labeling handled for free — no hand-built facet
grid, unlike `vl2d3`'s own approach. `translateFacet()` only needs one
shared `dataVar` from `translateUnit()` and the row/column field names.

This only works cleanly for a **plain-unit facet template** — one where the
one shared data array is unambiguous. Two shapes fall outside that: a
*layered* facet template (each layer would need to share the facet's own
data variable, not attempted in v1) and a *nested* facet (two-dimensional
faceting spelled as `facet: {row: ...}, spec: {facet: {column: ...}, spec:
{...}}}` rather than a single facet with both `row` and `column` given
together) — Plot has no second faceting dimension to hand a nested facet's
own inner split to. Both throw a clear `"Unsupported: ..."` error in strict
mode; under `ignoreUnsupported`, the layered case renders unfaceted (one
combined panel) and the nested case renders only the inner facet.

## `repeat`: why the best-effort fallback is "render nothing," not "try anyway"

Every other unsupported composition in this project's `ignoreUnsupported`
fallback path renders *something* useful. `repeat` doesn't, for two
concrete reasons discovered while validating against the full corpus:

1. A repeated channel reference (`{"field": {"repeat": "layer"}}`) has no
   real field name without actual repeat expansion — `channelValue()`
   correctly returns `null` for it (channel omitted), but Plot's own mark
   validation can require that channel outright (`Plot.line` needs a `y`),
   throwing `"missing channel value: y"` at *execution* time rather than
   degrading gracefully.
2. The repeated template's own `data`/`transform` live on the *outer*
   `repeat` node, not on `node.spec` — naively recursing into `node.spec`
   alone (an earlier draft's behavior) silently drops them, so even the
   *data loading* breaks, independent of the channel-reference problem
   above.

Given neither failure mode is something a JS accessor can gracefully no-op
around, and actually fixing both would mean implementing real repeat
expansion (a deliberately out-of-v1-scope feature), the fallback renders an
explicit empty panel (`Plot.plot({marks: []})`) instead — honest about the
gap, and guaranteed not to crash.

## Color schemes (`scales.js`)

Vega-Lite and Plot both ultimately name color schemes after
[d3-scale-chromatic](https://d3js.org/d3-scale-chromatic)'s own
interpolators/schemes, so the large majority of scheme names need no
translation. Two things do:

- **`category20`/`category20b`/`category20c`** — Vega-Lite's own default
  categorical schemes at higher domain cardinalities — were dropped from
  d3-scale-chromatic years ago (`d3.schemeCategory20` doesn't exist past
  d3 v4) and have no Plot-recognized scheme name at all. Their fixed
  20-color palettes are a stable, well-known constant, though, so these are
  threaded through as an explicit literal `range` array instead of a
  `scheme` name.
- **Anything else Plot doesn't recognize** (an obscure or misspelled scheme
  name) is checked against an explicit allowlist of every scheme name Plot
  itself accepts (`PLOT_KNOWN_SCHEMES`) *before* being spliced into
  generated code — passing an unrecognized name through unchecked doesn't
  fail until the generated code actually executes `Plot.plot()` ("unknown
  ... scheme: ..."), which is a worse failure mode than catching it at
  translation time. Strict mode throws a clear `"Unsupported: ..."`;
  `ignoreUnsupported` drops the scheme override and lets Plot fall back to
  its own default instead.

## Scale-type overrides that conflict with a mark's own requirements

A handful of Vega-Lite spec authors set an explicit `scale: {type:
"point"}` on a bar/tick mark's own category axis — real Vega tolerates
this (and silently ignores it, since a mark with width always needs a real
`band` scale there), but Plot's own scale-conflict validation doesn't:
passing an explicit `"point"` through for that channel throws ("scale
incompatible with channel: point !== band") instead of the chart just
rendering with Plot's own correct default. `buildScaleOptions()` mirrors
Vega's own tolerant behavior by suppressing exactly this one override
(bar/tick mark, `x` or `y` channel, `scale.type === "point"`) — every other
mark/channel/type combination still passes an explicit override through
unchanged.

## Vega expression translation (`expr.js`)

Adapted from `vl2d3`'s own `expr.js` — the same token-level rewrite
approach (not a full parser), since Vega expressions are close enough to
JavaScript for the common cases (arithmetic, comparisons, ternaries) that a
handful of targeted rewrites covers the practical surface: `datum` → the
row variable, `Math.*` renames, date-component accessors
(`year(datum.x)` → `(d.x).getFullYear()`), and function-call rewrites for
things JS spells differently (`length(x)` → `(x).length`, `substring(...)`
→ `String(...).substring(...)` — coerced through `String()` since this
project's CSV loading uses `d3.autoType`, which can turn a field Vega's own
loader kept as a string, e.g. a zero-padded zip code, into a number
instead — `indexof(...)` → `(...).indexOf(...)`, `format(value, spec)` →
`d3.format(spec)(value)`, `isValid(x)` → a null/NaN check, `if(cond, a, b)`
→ a real ternary). All of these share one `findCall()` helper that locates
a top-level `name(...)` call by balanced-paren scanning (needed since Vega,
unlike JS, tolerates whitespace between a function name and its own
opening paren, e.g. `indexof (x, y)` — `findCall()`'s own regex accounts
for that explicitly, and returns the call's true starting position rather
than assuming it's exactly `name.length` characters before the paren, so
the whitespace doesn't get silently absorbed into the replacement text).
Anything not covered by one of these rewrites (custom Vega functions,
`datetime()`, the `vlSelectionTest` family, ...) passes through as literal
(invalid-in-plain-JS) text, which throws a clear `ReferenceError` at
chart-render time rather than silently miscalculating.

## Generated-code contract

Every generated module exports one function:

```js
export default async function chart(container, options = {}) { ... }
```

deliberately the same shape as `vl2d3`'s own generated code (not just "call
`Plot.plot` and return it"), specifically so the showcase integration
(`showcase_build/run_plot.mjs`, the `example.html.j2` Plot panel) is close
to a mechanical copy of the existing D3 panel — same `container.
ownerDocument` → `Plot.plot({document: ...})` pattern (confirmed
empirically to behave identically under jsdom and in a real browser), same
`options.baseURL` threading into `data.js`'s `d3.csv`/`d3.json` calls.

## A silent-correctness sweep, and what it found

The bugs above were caught by the corpus harnesses (which only check "did
it throw") or by a handful of hand-written unit assertions. A follow-up
pass specifically hunted for the harder class of bug those two methods
both miss: code that translates and executes without error but draws the
*wrong* thing, or nothing at all. That meant checking real showcase output
image-by-image against the ground-truth Vega-Lite render, plus writing a
sweep that renders every showcase example and flags any Plot panel with no
mark-drawn shapes beyond axis chrome. It surfaced several real,
previously-undetected bugs, all fixed:

- **A genuinely 1-dimensional aggregate had no grouping key at all.**
  `{"x": {"aggregate": "sum", "field": "people"}}` with no `y` at all (a
  single summary bar) fed `Plot.groupY({x: "sum"}, {x: "people"})` — with
  no *other* channel present, Plot's own group transform has nothing to
  group by and silently falls back to each row's own array index, drawing
  one wrongly-scaled bar per row instead of one correctly-summed bar.
  `prepare.js`'s `needsConstantKey` now detects this (no channel among
  `GROUP_KEY_CHANNELS` besides the one being aggregated) and `marks.js`
  injects a literal constant (`y: 1`) onto the missing axis, collapsing
  every row into the one group intended. The same missing-key case affects
  a rule mark's own reference-line pattern (`{"y": {"aggregate": "mean",
  ...}}`, no `x`) — injecting the constant onto `x` there works fine for
  *grouping* purposes without breaking `ruleY`'s own "no x means span the
  full axis" rendering, since the constant is dropped from what's actually
  visually positioned (`ruleY` never reads an `x` channel for its own
  drawing).
- **A binned position channel with no companion decided orientation
  wrong.** `orientation()` treated `{"x": {"field": ..., "bin": ...}}`
  with no `y` the same as a plain aggregate with no `y` (both "only x
  looks quantitative" cases) — but Vega-Lite's own convention is the
  opposite of what that heuristic picked: a *binned* x with no y is an
  implicit histogram (missing channel becomes `count`, drawn as **vertical**
  bars, x = bin edges), while a plain (non-bin) aggregate with no y is a
  single **horizontal** summary bar. `orientation()` now special-cases
  `bin` explicitly before falling back to the quantitative-based heuristic.
- **A per-row "styling" channel silently broke the group transform it rode
  along in.** `{"x": {"field": "age"}, "y": {"aggregate": "sum", "field":
  "people"}, "opacity": {"field": "people"}}` fed `Plot.groupX({y: "sum"},
  {x: "age", y: "people", opacity: "people"})` — since `opacity` is a
  field-valued channel too, Plot's own group transform treats it as an
  *additional* implicit groupby key (see the module docstring above), and
  with `opacity` varying per row, grouping by `(age, opacity)` together
  made almost every row its own singleton group — the render came back
  completely empty, not just missing the opacity encoding. The same shape
  breaks a `text` mark's own un-reduced label field the same way. There's
  no single correct per-group value for a continuous, non-aggregated
  channel like this anyway (Vega-Lite's own semantics are ambiguous here
  too), so `marks.js`'s `UNGROUPABLE_STYLE_CHANNELS` (`opacity`, `r`,
  `symbol`, `title`) now drops these from the options object whenever a
  bin/group transform wraps the mark, rather than leaving them in to
  silently corrupt the whole grouping.
- **A `text` channel with its own explicit `aggregate` needed its own
  reducer, not just a pass-through field.** A labeled stacked-bar chart's
  text layer (`{"text": {"aggregate": "sum", "field": "people"}}`
  alongside `{"x": {"aggregate": "sum", ...}}`) hit exactly the
  `opacity`-shaped bug above: `text` differs per row, becoming an
  unwanted extra implicit groupby key. Unlike `opacity` (dropped
  entirely, no faithful per-group value exists), `text` here has a
  well-defined one — its own declared aggregate — so `prepare.js`'s
  `augmentWithTextAggregate()` adds a second reducer entry to the same
  `outputs` object (`{x: "sum", text: "sum"}`) instead of dropping the
  channel.
- **A `text` label overlaid on a stacked bar/area needs to stack too, on
  the very same normalized scale.** Vega-Lite lets any mark's own value
  channel carry an explicit `"stack": "normalize"`, not just bar/area's
  own *implicit* auto-stacking — a label spec had exactly this
  (`{"x": {"aggregate": "sum", ..., "stack": "normalize", "bandPosition":
  0.5}}`). Left unstacked, the label mark's own raw (un-normalized) sum
  values leaked into the **same shared x-scale** the bar mark's own
  properly-normalized `[0, 1]` values live on, since Plot shares one scale
  per channel across every mark in a `Plot.plot()` call by default — the
  shared domain widened to fit both, shrinking the bar's own normalized
  bars down to slivers. `stack.js` now has an `EXPLICIT_STACK_MARKS` set
  (currently just `text`) that stacks only when `stack` is explicitly set
  (never implicitly, unlike bar/area) — and Plot's own `stackX`/`Plot.text`
  combination turns out to center the label within its own segment
  automatically, matching `bandPosition: 0.5`'s intent for free.
- **`bin: {"binned": true}` means "already binned," not "please bin
  this."** Vega-Lite's own signal that a field already holds real bin
  boundaries (typically paired with an explicit `x2` companion for the
  other edge, e.g. pre-computed `bin_start`/`bin_end` columns) was being
  treated as an ordinary bin request, triggering `Plot.binX` needlessly.
  `planTransform()` now checks `def.bin.binned === true` and skips
  `binChannel` detection entirely for that case, leaving the already-real
  x1/x2 values untouched.
- **Inline `values` given as an object, not an array, needs `format.
  property` — and that property name is a dotted *path*, not a literal
  key.** A GeoJSON-shaped `{"type": "FeatureCollection", "features":
  [...]}` (`format.property: "features"`) or an Elasticsearch-shaped
  `{"hits": {"hits": [...]}}` (`format.property: "hits.hits"`) both need
  extracting before any mark sees real rows — unimplemented before, this
  data source fell through to the generic "no url, no values array"
  unsupported-data-source fallback, rendering an empty dataset. `data.js`
  now handles an object-shaped `values` by walking `format.property`'s own
  dotted path (`?.["hits"]?.["hits"]`, not a single bracket lookup on the
  literal string `"hits.hits"`). Rows loaded this way (and every other
  inline-`values` row) are also now flattened one level deep into dotted
  keys (`vlFlattenOneLevel()`, a new `runtime.js` helper) — Vega-Lite
  treats a nested-object field reference like `"properties.variety"` as
  an already-flat field name, not a path to traverse, so a
  GeoJSON-`properties`-shaped row needs this to resolve any such
  reference at all.
- **The top-level `stack` and `density` transforms are now implemented**,
  not just documented gaps — both needed a real, non-trivial computation
  (`stack`: a cumulative running sum per `groupby` group, honoring `sort`
  and `offset`; `density`: an actual Gaussian-kernel KDE, adapted from
  `vl2d3`'s own from-scratch implementation, not an approximation) with no
  single native Plot *data-array* transform equivalent (Plot's own
  `stackY`/`stackX` are *mark*-level wrappers, not something that can
  produce two new named output fields on the data itself the way the
  top-level transform's own `as: [v1, v2]` requires). Both now live as
  real exported functions in the new `src/runtime.js` (mirroring `vl2d3`'s
  own "shared runtime helper" convention exactly), imported by name only
  when a spec actually needs one.
- **`planStack()` didn't exclude a value channel with its own explicit
  companion.** Vega-Lite's own stacking rule skips a channel that already
  has an explicit `x2`/`y2` range (e.g. one computed by the `stack`
  transform above, or a manually authored lo/hi range) — automatically
  stacking on top of it would discard that explicit range and substitute
  a wrong one. `planStack()` now checks for this and returns `null`.

## A second correctness pass: legends, arc/pie, faceting, repeat, window

A follow-up review — spot-checking real showcase output against known
problem specs from other siblings' own bug reports, plus a systematic
look for "renders, but not what Vega-Lite would draw" — found a further
batch of real bugs and gaps, all fixed:

- **No chart ever showed a legend.** Vega-Lite shows a legend by default
  for any field-encoded legendable channel (`color`, `opacity`, `size`,
  `shape`) unless explicitly turned off — Plot has no equivalent default
  of its own: *every* mark renders with no legend at all unless `legend:
  true` is set explicitly on that channel's own top-level scale options,
  confirmed by testing a plain `Plot.dot(...)` with a `fill` channel and
  no explicit legend option. `scales.js`'s `buildScaleOptions()` now
  defaults `legend: true` for exactly those four channels whenever the
  spec gives them a real field (not just a static value) and doesn't
  explicitly disable it — this is a broad, previously-invisible-in-every-
  single-chart gap, not a narrow one.
- **A legend's own gradient swatch crashes under jsdom without the
  optional `canvas` package.** A *continuous* (not categorical) color
  legend renders as a gradient ramp, which Plot draws via an offscreen
  `<canvas>` — jsdom's own `getContext()` returns `null` without the
  optional native `canvas` npm package installed, and Plot then throws
  setting `ctx.fillStyle`. This only ever surfaced once legends were
  actually enabled (above); a real browser (what the showcase's own live
  viewers use) has no such limitation at all, so `canvas` is now a
  `devDependency` purely so this project's own *test/validation*
  environment can exercise the exact same code path a real browser
  would, rather than a production requirement.
- **A legend's own swatch geometry isn't real absolute pixel positions,
  and its own `<rect>`s got miscounted as chart marks.** A swatch
  commonly sizes itself with a relative `width="100%" height="100%"`
  inside its own small nested `<svg>` (`Number("100%")` is `NaN`) — the
  same false-positive-NaN class `<text>`'s own `transform`-based
  positioning already required a special case for (see below), needing
  the identical treatment (`validate-rendering.js`'s own geometry check,
  and the unit suite's own `marksOf()` helper, both now also exclude
  anything inside a `[class*="swatch"]` container).
- **`sort: {"op": ..., "field": ..., "order": ...}` on a position channel
  did nothing at all.** Only a plain `sort: "descending"` string or an
  explicit array were handled; a full sort-spec object (Vega-Lite's own
  "reorder this axis by an aggregate of some field" form, e.g. "put the
  most common category first") silently fell through to no-op, leaving
  the axis in first-appearance order. Maps onto Plot's own mark-level
  `sort: {[categoryChannel]: "-valueChannel"}` option (confirmed
  empirically — a bare `sort: "-y"` at the top of a mark's own options
  object does *not* work; it must be nested under the channel key being
  reordered) — only handled when the sort spec's own `field` is absent
  (an op like `"count"` needs none) or matches the channel already
  carrying the mark's own value, the overwhelmingly common real pattern;
  sorting by an unrelated third field would need a synthetic hidden
  channel, not attempted.
- **A chart-level `title` was dropped entirely.** Never threaded through
  at all — `panelSize()` now also extracts `title`/`subtitle` (a bare
  string or a `{"text": ..., "subtitle": ...}` object) and
  `buildPlotCallSource()` passes them straight through to Plot's own
  matching top-level options.
- **A static `mark: {"color": ..., "opacity": ..., "size": ...}` property
  (as opposed to an `encoding` channel) was dropped for every mark except
  `rule` (which already had its own `strokeWidth` fallback).** A mark
  relying solely on its own constant styling — no color/opacity/size
  *field* at all, a common real pattern for e.g. a single-series
  reference line drawn in a fixed color — silently rendered in Plot's own
  default styling instead. `commonChannels()` now falls back to
  `markProps.color`/`opacity` when the matching encoding channel is
  absent (an encoding channel still always wins when both are present,
  matching Vega-Lite's own rule); `renderLineOrArea()` gained the same
  fallback for `strokeWidth` (from `markProps.strokeWidth` *or*
  `markProps.size`, Vega-Lite's own line-width alias) that `renderRule()`
  already had.
- **A literal `value`/`datum` string that happens to coincide with a real
  column name got read as that column, not the constant it was meant to
  be.** Plot's own "does this look like a CSS color" disambiguation
  between a literal string and a column-name accessor keeps applying even
  *inside* an explicit `{value: "..."}` wrapper — confirmed empirically
  across three separate reproductions, including with the channel's
  scale-participation entirely turned off. A `color: {"datum": {"repeat":
  "layer"}}`-style repeated categorical label (e.g. `"a"`, coincidentally
  also a real field name in that exact row) silently read that column's
  own per-row *values* instead, splitting one line into as many broken
  one-point segments as there were distinct values — not a crash, and easy
  to miss without checking the actual segment count. `channelValue()` now
  renders any string `value`/`datum` as a function accessor (`() =>
  "literal"`) instead of a bare string spliced into the options object —
  Plot never applies its own string-vs-column heuristic to a function's
  *return* value, so this is unconditionally safe (including for a
  literal that does happen to look like a valid CSS color).
- **Observable Plot has no built-in arc/pie mark at all** (confirmed
  absent from its own mark index) — `VlArc` (`runtime.js`) is a real one,
  not an approximation, built on `d3.pie()`/`d3.arc()` (the same
  primitives `vl2d3`'s own hand-built arc renderer uses) but implemented
  as a genuine Plot `Mark` subclass rather than raw post-hoc SVG
  injection, specifically so its own `fill` channel still participates in
  Plot's shared color scale *and legend* resolution like any built-in
  mark's channel would. One non-obvious pitfall building it: a custom
  Mark's own `values` object (received by `render()`) already holds
  *post-scale* output for a `{scale: "color"}`-declared channel (a final
  color string, e.g. `"#4269d0"`), not the raw domain value — calling
  `scales.color(...)` on it a second time looks up an already-a-color
  string as if it were a domain value, silently resolving to no fill at
  all (not a crash). v1 scope: a plain quantitative `theta` (Vega-Lite's
  own implicit per-mark stacking, matching `d3.pie()`'s own default
  ordering), `color`, an optional `tooltip`, `order` (reorders the
  wedges before construction, honored by `d3.pie()`'s natural array
  order), `mark.innerRadius`/`outerRadius` (donut vs. pie), and an
  explicit `theta.scale.range` override (a truncated/rotated circle, via
  `d3.pie()`'s own `startAngle`/`endAngle`). A *non-quantitative* `theta`
  (equal-sized wedges per category) or a per-row-varying `radius` channel
  are real gaps, not attempted — both need genuine additional scale
  machinery this v1 doesn't have yet.
- **`row`/`column` as plain *encoding* channels (not a `facet: {...},
  spec: {...}` composition) were silently dropped entirely.** Vega-Lite
  lets `row`/`column` appear directly in `encoding` on any unit or layer
  view (shared across every layer for the layer case) as a more common-
  in-practice alternative spelling of faceting to the explicit
  composition form — confirmed as the root cause behind a real corpus
  spec (`trellis_bar`) rendering as an overlaid mess (every age × gender
  combination layered on one shared set of axes) instead of a trellis:
  `row`/`column` aren't real mark channels at all, so the field was
  dropped with no error. `extractEncodingFacet()` now normalizes this
  shape into the exact node `translateFacet()` itself already expects
  before `translateNode()`'s own dispatch, reusing all of its existing
  logic (including its own `ignoreUnsupported` fallbacks for a layered
  template) rather than duplicating any of it.
- **`repeat` unconditionally rendered an empty panel, even for the
  common, cleanly-expandable shapes.** Re-examined after the `row`/
  `column` facet fix above suggested the same "expand into an equivalent
  ordinary composition" approach would work here too: `repeat: {layer:
  [...]}` (repeat *as layers* sharing one panel) now expands into a plain
  `layer: [...]`; `repeat: {row: [...]}` / a bare array shorthand
  `repeat: [...]` (Vega-Lite's own default meaning for the array form —
  confirmed via a real corpus spec pairing it with a sibling top-level
  `columns: N`, wrapping it into a genuine grid rather than one long row)
  expand into `vconcat`/`concat`. Each of `translateFacet()`'s/
  `translateMulti()`'s own existing machinery (merge-down, per-child
  fallbacks, ...) is reused by construction. The one shape still not
  attempted: `row` *and* `column` together (a genuine 2D grid, e.g. a
  scatterplot matrix) — each cell would need its own *pair* of
  substituted fields, not just one single-axis substitution pass.
- **The top-level `window` transform is now implemented**, not just a
  documented gap — a real SQL-window-function-style computation
  (`row_number`/`rank`/`dense_rank`/`lag`/`lead`, and a `frame`-bounded
  `sum`/`mean`/`count`/`min`/`max`/`median`/`distinct`), adapted from
  `vl2d3`'s own proven implementation but rewritten self-contained (no
  `d3` dependency needed at all, unlike `vl2d3`'s own `d3.group`/`d3.sum`-
  based version) as `vlWindow()` in `runtime.js`. Fixes a real corpus
  spec (`layer_line_rolling_mean_point_raw`, a 30-day rolling mean
  overlaid on raw daily values) that previously rendered only the raw-
  value points, with the rolling-mean line silently absent (referencing a
  field the skipped transform never computed).
## `argmin`/`argmax`: a row lookup, not a value reducer

A user report that one spec (`bar_argmax_transform`) "doesn't work" led to
finding the same underlying gap in two genuinely different places once
checked against the rest of the corpus:

- **The top-level `transform: [{"aggregate": [{"op": "argmax", ...}]}]`
  form.** Unlike every other aggregate op (which reduces a group of rows to
  a single *value*), `argmax`/`argmin` reduce to the whole matching *row* --
  neither `aggops.js`'s `D3_OPS` table nor `plotReducer()` had an entry for
  either, so under `ignoreUnsupported` this silently fell back to a `mean`
  of the compared field instead (a real, different number, not an error) —
  and the encoding channel referencing the result doesn't even read a
  plain field to begin with: Vega-Lite's own convention for reading one of
  the winning row's *other* fields is bracket-index syntax on the
  aggregate's own output name, e.g. `argmax_US_Gross['Production
  Budget']` — a string no accessor in this project could resolve as
  anything but `undefined` regardless of what the aggregate itself
  produced. Fixed with two pieces, both adapted from `vl2d3`'s own proven
  solution to the identical problem: `D3_OPS.argmax`/`argmin` (a real
  `rows.reduce(...)` row lookup, not a value reduction) in `aggops.js`,
  and a generic `parseBracketFieldPath()`/`flattenBracketFields()` pass in
  `translator.js` that flattens any bracket-indexed encoding field into a
  real plain field (a `.map()` statement over the data) before any mark/
  scale code ever sees the channel. Scoped to bracket-index segments only
  (`['key']`/`[0]`) — a bare dot-path (`record.low`) is already handled by
  `data.js`'s own `vlFlattenOneLevel()` at data-load time instead, so
  parsing it here too would only be redundant.
- **The *inline* `aggregate: {"argmax": sortField}` channel shorthand.**
  A completely different, simpler shape found by checking every other
  corpus spec using `argmax`/`argmin` at all (5 more, none of them using
  the transform-array form above) — here the channel's own sibling
  `field` property names which of the winning row's *existing* columns to
  read directly, no bracket-index string or new field name involved at
  all. Still unsupported by the same root gap: Plot's own `groupX`/`binX`
  transforms have no "pick one whole row per group" reducer concept
  either. Resolved by pre-materializing a real one-row-per-group array in
  plain JS (`vlArgAggregate()`, `runtime.js`) *before* the mark ever runs,
  rather than attempting to express it as a Plot transform at all —
  mirroring the bracket-field fix's own "flatten before any mark/scale
  code sees it" approach. One real corpus spec
  (`layer_line_co2_concentration.vl.json`) combines this with a plain
  string aggregate (`"aggregate": "max"`) on the *same* comparison field
  in the *same* mark (labeling both endpoints of each decade's own curve)
  — once the data is reduced to one row per group, every aggregate-
  bearing channel on that mark already holds exactly its own reduced
  value (an aggregate over a single-row group always equals that row's
  own value), so `stripResolvedAggregates()` simplifies all of them to a
  plain field read together, not just the `argmax`/`argmin` ones. This
  assumes every aggregated channel on the mark shares the same underlying
  reduction — true for every real corpus spec found, not a general
  solution for an unrelated aggregate op mixed in on some other field.
- **A `tooltip` array (multiple fields shown together in one tooltip) only
  ever read its own first element.** Found while checking
  `argmin_spaces.vl.json` (an `argmin` result referenced only inside a
  3-field `tooltip` array) — this project's own tooltip handling has never
  supported Vega-Lite's multi-field `tooltip: [...]` form at all, a
  distinct, pre-existing gap unrelated to `argmin`/`argmax` specifically
  (Plot's own single `title` channel takes one string per row, and no
  multi-field composition into one tooltip string has been implemented
  yet). Left as a known limitation rather than expanded into its own fix
  here — the chart's own core visual encoding (in that spec, three points
  positioned by `aggregate: "min"`) renders correctly regardless, since a
  tooltip is supplementary hover text, not a positional/color channel.

## `xOffset`/`yOffset`: grouped/dodged bars had no position of their own at all

A user report that two grouped-bar specs rendered "stacked instead of
grouped" led to discovering a much bigger, previously invisible gap:
`xOffset`/`yOffset` (Vega-Lite's own channel for a dodged/grouped
position — most commonly a grouped bar chart's own sub-category) was
never rendered as a real Plot channel *at all*. `stack.js` already knew
to skip its own auto-stacking when one was present (dodging and stacking
are mutually exclusive for the same color-grouped mark), but nothing
ever gave the offset channel's own value anywhere to go — every bar in
the same category sat at the exact same position, visually overlapping
(reading as a stack, since one bar occludes the next) even though the
values themselves were never summed. 36 corpus specs reference
`xOffset`/`yOffset` in some form; checking every one individually (not
just the two originally reported) found this affected every single mark
type capable of using it: `bar`, `point`/`circle`/`square`, `tick`, and
`boxplot`.

Plot has no native "sub-band within a band" position concept of its own
— its own documented recipe for a grouped bar chart (confirmed
empirically) repurposes its *faceting* system instead: the outer
category channel becomes `fx`/`fy` (one facet "strip" per category
value, with small padding so adjacent groups read as one combined axis
rather than visually separate panels) and the offset channel's own value
becomes the real position *within* that facet strip. `marks.js`'s new
`catChannelPairs()` builds this `fx`+`x` (or `fy`+`y`) pair wherever a
plain `[catCh, val(enc[catCh])]` pair used to go unconditionally, applied
consistently across every dodge-capable mark's own renderer;
`translator.js`'s `collectScaleOptions()` adds the matching top-level
`fx`/`fy` scale options (carried over from the original category
channel's own scale settings) and hides the now-repurposed position
channel's own axis (Vega-Lite's own grouped bar shows no separate tick
per sub-category — a color legend already identifies it).

The offset channel is itself commonly a `datum` constant rather than a
`field` — e.g. `bar_grouped_repeated.vl.json`'s own `repeat`-substituted
layers, each drawing at its own fixed offset, side by side with its
sibling layer's bars at a different one (confirmed this composes
correctly with the `repeat: {layer: [...]}` expansion from the
correctness pass above: each layer's own `collectScaleOptions()` call
computes the *same* `fx` options, derived from the shared, inherited `x`
channel, so they merge cleanly across layers the same way any other
per-layer scale option already does). `catChannelPairs()`'s own
`isRealChannel()` check accepts either shape.

Verifying this properly took more than the usual "does it render, does
it throw" checks: a d3.rollup-based JS reduction, an `Unsupported: ...`
skip, and a genuinely correct dodge all "execute without error" and
"draw non-zero shapes" identically, so neither of this project's own two
corpus harnesses could distinguish a real fix from the original silent
bug (both report the exact same OK/skip/fail counts before and after).
Confirming this actually worked meant rendering every one of the 36
corpus specs and checking, *within each individual facet strip*
specifically (not globally across the whole SVG, where multiple facets
legitimately reusing the same small set of relative sub-positions would
otherwise look suspicious), that sibling bars/marks sharing one category
actually sit at distinct positions rather than one shared one. One
example (`bar_grouped_thin.vl.json`, 551 tiny facets in a 500px-wide
chart, one xOffset-based sub-bar per movie title within each director's
own strip) is inherently too dense to distinguish visually at that
width — a genuine "too much data for the given width" problem the real
Vega-Lite renderer has too, not a translation defect — confirmed correct
regardless by isolating one prolific director's own subset of rows and
checking their own bars landed at 23 different positions, matching 23
distinct movie titles.

## `trail`: a variable-width line, which neither Plot nor D3 has natively

Vega-Lite's `trail` mark draws a line whose stroke thickness varies per
point according to a `size` channel (`trail_color.vl.json`: stock price
over time, one trail per symbol, line width keyed to price). Plot has no
native mark for this — every one of Plot's own line-ish marks (`line`,
`lineY`, `link`) draws a single-width stroke; there is no `strokeWidth`
channel that varies continuously along a path the way SVG itself has no
notion of a "tapered stroke" either. So this was a hard "no mark exists for
this at all" gap, the same category as `arc`/pie (see above), not a
mistranslation.

The fix, `VlTrail` in `runtime.js`, is a second custom `Plot.Mark`
subclass alongside `VlArc`, but instead of delegating to a d3 shape
generator (`d3.arc()`), it computes the ribbon geometry by hand: for each
point on the line, estimate a local tangent direction from its neighbors
(a central difference — `next.{x,y} - prev.{x,y}`, with the first/last
point clamped to a one-sided difference), rotate that tangent 90° to get
the perpendicular unit normal, and offset the point by that normal in each
direction by the point's own half-width (`size`/2, already resolved to a
real pixel radius by Plot's own `r`-scale — see the resolved-channel-value
note under the `arc` section above, which applies identically here: a
channel declared `{value, scale: 'r'}` arrives in `render()` as a real
pixel value, not a raw domain value, so no second scale application is
needed or correct). The two offset sequences (one "left" side walking the
points forward, one "right" side walking them backward) are concatenated
into a single closed SVG path (`M...L...L...Z`) — a real filled polygon
whose width visibly narrows and widens along its own length, not a stroked
line with a uniform width.

One correctness detail: **the ribbon polygon has to be built by grouping
points into their own line group first (by `stroke`/color) and sorting
each group along `x` before computing tangents** — Plot hands `render()`
the full `index` array in the mark's own (arbitrary) row order, and a
tangent computed between two rows from *different* symbols, or between two
out-of-order timestamps of the same symbol, produces a self-intersecting
mess rather than a clean ribbon. This mirrors a general pattern worth
remembering for any future custom multi-point Mark: Plot's per-channel
`values.x[i]`/`values.y[i]` arrays are only really an ordered "path" if you
sort them yourself; nothing about the Mark API guarantees row order
corresponds to any meaningful drawing order.

Verified by hand-computing the raw SVG path's own vertex coordinates for
`trail_color.vl.json` (inline synthetic data substituted for
`stocks.csv`): the perpendicular offset distance at each of one symbol's
three points came out proportional to that point's own `price` value
(≈4.86px at price 10, ≈6.9px at price 20, ≈6.07px at price 15) — a real
variable width, not a fixed one. Confirmed further via a translator unit
test (`'a trail mark renders a real variable-width ribbon, not a
constant-width line'`) that inspects the generated path's own 6 vertices
(2 sides × 3 points) and checks the middle (high-size) point's own width
is visibly larger than either low-size end's.

D3's own trail rendering (a separate tool, `vl2d3`) still draws a
fixed-width line — the user's report that "line thickness is fixed in d3
(should be variable)" is a real bug, but in `vl2d3`, not `vl2plot`; out of
this project's own scope.

## A facet's own `sort` was silently dropped

`translateFacet()` built Plot's own `facet: {data, x, y}` option purely
from the `row`/`column` field *names* (`trellis_area_sort_array.vl.json`:
`row: {field: "symbol", sort: ["MSFT", "AAPL", "IBM", "AMZN"]}`) — it never
looked at anything else on that facet field def, including its own `sort`.
Plot's facet panels are governed by real scales of their own (`fx`/`fy`,
configurable identically to any other Plot scale), and Plot's own default
ordinal-domain inference for those scales is ascending natural order (so a
`symbol` facet came out `AAPL, AMZN, IBM, MSFT` — alphabetical — regardless
of the spec's own requested `MSFT, AAPL, IBM, AMZN` order). This is a
silent-correctness bug in the same family documented above: it neither
throws nor renders empty, so neither validation harness's own OK/skip/fail
counts moved from fixing it — confirmed instead by rendering the spec both
before and after the fix and reading off the actual `<text>` facet-strip
labels in DOM order.

The fix reuses `buildScaleOptions()` — already the one place that turns an
encoding channel's own `sort: [...]` into a Plot `domain: [...]` override
for its own `x`/`y`/`color` scale — and calls it a second time on
`facetDef.row`/`facetDef.column` (or `facetDef` itself, for the
single-field wrapped-facet-operator shape with no `row`/`column` split),
targeting Plot's `fy`/`fx` scale channels instead. The resulting
`{fx: {...}}`/`{fy: {...}}` fragment is merged into the same
`scaleOptions` object already passed to `buildPlotCallSource()`, so any
other scale-shaped override on a facet field def (a reversed sort order,
an explicit domain, a suppressed axis) now threads through the identical
path any other channel's scale options already use — not just the one
`sort` case that prompted the fix.

## `hconcat`: side-by-side panels rendering as if stacked

`hconcat_weather.vl.json`'s two panels (a bar chart, a binned scatterplot,
neither with its own `width`/`height`) came out looking vertically
stacked despite `translateMulti()`'s own wrapper already being built
correctly (`flexDirection: 'row'`, matching `hconcat`'s "col" direction).
The wrapper itself wasn't the bug: each *child* `Plot.plot({...})` call had
no `width`/`height` override at all, so each one fell through to Plot's
own bare default sizing (640px wide, sized for a single standalone chart
filling its own container). Two 640px-wide flex items plus a gap is wider
than almost any real container the showcase (or any embedding page) gives
a two-up composition; with `flexWrap: 'wrap'` already set (so a `concat`
with a real `columns` count still wraps predictably), each panel — already
wider than the container on its own — ends up alone on its own line. The
net visual effect is indistinguishable from a `vconcat`, even though
`flexDirection: row` was correct the whole time. Neither validation
harness's own counts moved (a silently-oversized-but-still-real render,
the same category as the facet-sort and grouped-bar bugs above);
confirmed instead by inspecting the actual rendered `<svg>` elements'
`width` attributes directly.

The fix, in `translateMulti()`: any child of an `hconcat`/`vconcat`/
`concat` composition that doesn't specify its own `width`/`height` AND
isn't itself a further composition (a nested `facet`/`hconcat`/`vconcat`/
`concat`/`repeat`, whose own sizing is handled by that path instead) now
gets an explicit `width: 200, height: 200` default before translation —
mirroring `vl2d3`'s own identical fix for the identical bug (a smaller,
closer-to-Vega-Lite's-own-default-view-size default for a composed panel,
as opposed to a standalone chart's much larger default). This is
purely a default-value fix, not a new code path: a child spec with its own
explicit `width`/`height` is left untouched.

## The facet-sort fix's own regression: a reordered `fy` domain collapsed stacking

The facet-sort fix above (a custom `fy`/`fx` scale `domain` override) turned
out to have a real regression of its own, caught only by actually
rendering the real corpus spec (`trellis_area_sort_array.vl.json`) rather
than a synthetic small-data unit test: a row-faceted, color-grouped
**stacked** area (`Plot.stackY`) degenerated into a flat, zero-height
shape in *every* facet once the `fy` domain was reordered away from
Plot's own default ascending order -- confirmed by isolating the exact
combination in a standalone Plot script (no vl2plot involved at all):
`facet: {data, y: "symbol"}` plus a reordered `fy: {domain: [...]}`
plus `Plot.stackY({fill: "symbol", ...})`, with no explicit `fy` channel
on the mark itself, silently produces the flat degenerate shape; adding
`fy: "symbol"` directly onto the mark's own options (redundant with the
top-level facet when the domain isn't reordered) fixes it. Plot's own
"auto-facet a mark whose data is the same array reference as facet.data"
heuristic apparently doesn't feed a stack transform's own per-facet
grouping correctly once the `fy` scale's domain has been overridden away
from what it would otherwise infer.

The fix (`commonChannels()`, `marks.js`, threaded down via
`translateFacet()`'s own `facetChannels` context) makes every mark drawn
inside `translateFacet()` explicitly carry its own `fx`/`fy` channel
matching the facet, unconditionally -- not just when a reordering is
present, since it's a no-op either way when the domain isn't reordered
(confirmed empirically) and this sidesteps needing to special-case
exactly which Plot-internal condition triggers the bug.

## A facet's own `width`/`height` sizes ONE panel, not the whole grid

A second, larger-blast-radius bug found while chasing the same spec: even
after the stacking regression above was fixed, the chart still rendered
empty. Vega-Lite's own `width`/`height` on a faceted spec is the size of
ONE panel -- `trellis_area_sort_array.vl.json`'s own `"height": 40` means
each of its 4 symbol panels is 40px tall. Plot's own top-level `width`/
`height` instead size the ENTIRE faceted figure. Passing 40 straight
through as if it already meant the whole figure starves each of the 4
rows down to ~10px once Plot's own internal facet-row division applies --
confirmed to be exactly enough to tip a *stacked* area's own per-facet
geometry into the same flat, zero-height degenerate shape the fix above
addresses for a totally unrelated reason (this time a genuine "not enough
real pixels available" case, not a scale-domain quirk).

Fixed in `translateFacet()`: the real total figure height/width is
computed at *runtime* (`new Set(data.map(d => d[rowField])).size`, since a
URL-sourced dataset's own distinct-row-value count isn't known at code-
generation time) and multiplied against the per-panel number before it's
spliced into `buildPlotCallSource()`'s own `width`/`height` lines (which
already just interpolate whatever expression they're given verbatim, so a
runtime variable name works exactly like a literal number would). Not
handled: a `{"step": n}`-shaped per-category panel size (`panelSize()`
only ever resolves a plain number) -- a narrower, separate gap.

## A wrapped facet (`encoding.facet`, no `row`/`column` split) had no grid at all

`encoding.facet: {field, columns: N}` (e.g. `trellis_barley.vl.json`'s own
`columns: 2` across 8 `site` panels) -- a *wrapped* facet, as opposed to a
`row`/`column` split -- wasn't even recognized as a facet by
`extractEncodingFacet()` at all (it only ever looked at `row`/`column`,
missing this third, `encoding.facet`-as-its-own-channel spelling
entirely), so the whole `facet` channel was silently dropped and every
panel rendered combined into one. Once recognized, there's still no Plot
equivalent to wrap N panels per row from a single field -- Plot's own
faceting is a strict 2-axis grid (`fx` times `fy`, confirmed absent any
`wrap` option in Plot's own `facet.js` source), never "wrap N panels per
row from one field's own distinct values."

Rendered instead as N genuinely independent `Plot.plot()` calls (one per
distinct facet value, each titled with that real value, each drawing only
that value's own filtered rows), arranged in a real CSS grid with the
requested (or, absent one, single-row) column count --
`translateWrappedFacet()`, the same "independent panels in a wrapper div"
strategy `hconcat`/`vconcat` already use for their own unsupported-
composition fallback. Distinct values are only knowable once the data has
loaded (a URL-sourced dataset, the common case), so grouping and sorting
both happen at runtime; an aggregate-op sort (`sort: {op, field}`, e.g.
trellis_barley's own `{op: "median", field: "yield"}` -- order panels by
each site's own median yield) is computed via a new runtime helper,
`vlFacetSortValues()`. Known, documented gaps: each panel computes its own
LOCAL x/y/color scale domain rather than one shared across every panel
the way Vega-Lite's own default facet behavior would; a `{"step": n}`-
shaped panel size isn't handled.

## A dodged bar's own band can round all the way down to zero, not just "thin"

`bar_grouped_thin.vl.json` (551 directors, each with its own `xOffset`-
dodged sub-bars, in a 500px-wide chart) rendered nothing visible at all --
confirmed via direct DOM inspection that every single `<rect>` had a
literal `width="0"`, not merely a hard-to-see sub-pixel value. Reproduced
independently of vl2plot entirely with a plain Plot script at the same
facet density: Plot's own band-width computation for a dodge (`xOffset`
turned into a real `fx` facet, see the dodge/facet section above) rounds
all the way to a hard zero once there's not enough width to go around,
confirmed via the raw `rect.outerHTML` (`width="0"`, not a rounded-off
tiny decimal). Real Vega-Lite never lets this happen --
`config.mark.minBandSize`/`config.bar.minBandSize` (default **0.25px**,
confirmed against the real compiler's own output for this exact spec:
`"width": {"signal": "max(0.25, bandwidth('xOffset'))"}`) clamps a bar's
own band size to always stay visible, a floor Plot has no equivalent of.

Plot has no hook to apply a clamp *during* its own render (no custom
`className`-scoped fixup point, no override of the internal bandwidth
computation), so the fix is a DOM fix-up applied immediately after the
enclosing `Plot.plot({...})` call returns: `renderBar()` (`marks.js`)
detects a dodge is active, assigns the mark a unique `className` (spliced
in as one of the mark's own *pre-transform* options -- confirmed
empirically that Plot reads `className` off there, not off whatever a
`Plot.groupX`/`stackY` transform wrapper's own return value happens to
carry, and that Plot applies it to the mark's enclosing `<g>`, not to each
individual `<rect>`), and returns a `postFixups` entry describing the
clamp needed. `translateStandalone()` wraps the whole `Plot.plot({...})`
expression in a self-invoking function (`wrapWithPostFixups()`) that
captures the node, calls the new `vlApplyMinBandSize()` runtime helper
(widens/heightens any too-small `<rect>`, re-centering it on its own
original midpoint so the fix-up only ever changes size, never apparent
position), and returns it -- self-contained, with no dependency on
whatever variable name the eventual caller assigns the expression to.
`config.mark.minBandSize`/`config.bar.minBandSize` needed `root.config`
threading into `ctx` for the first time in this project (previously
`config` wasn't read anywhere at all); only this one config value is
wired through so far, and only for `bar` -- a `tick` mark has the
identical real Vega-Lite default but isn't handled here, a documented
narrower gap. Not threaded through `translateFacet()`/`translateMulti()`
either (only the plain standalone-unit path) -- neither of the two
reported specs needs it there, so it wasn't attempted.

## `week`/`yearweek` timeUnits were simply missing

Both were entirely absent from `timeunit.js`'s own bucketing table --
any spec using either (`bar_grouped_timeunit_yearweek.vl.json`) fell
through to the generic "unsupported timeUnit, left untruncated" fallback
under `--ignore-unsupported`, silently drawing one bar per exact
timestamp instead of one per week. Added following the same convention
every other entry in this table already uses (plain local-time `Date`
getters, no `d3` dependency): `yearweek` (monotonic -- includes "year")
floors to that week's own real Sunday (`getDate() - getDay()`, which
correctly rolls over a month/year boundary on its own, since the `Date`
constructor always normalizes an out-of-range day-of-month rather than
throwing); `week` (cyclic -- collapses every year down to the same ~52
Sunday-starting buckets, mirroring `month`/`quarter`'s own existing
reference-year convention) reuses the exact `dayofyear` formula already in
this same table to find which Sunday-numbered week a date falls in, then
reconstructs the equivalent date within the shared reference year.
Verified correct in isolation against plain, directly-constructed `Date`
objects (no string-parsing ambiguity): two dates in the same relative week
across different years both collapse to the identical reference-year
bucket for `week`; `yearweek` of a known Monday resolves to the correct
preceding Sunday, real year preserved.

**A separate, pre-existing, and considerably larger bug surfaced while
verifying this against the real corpus spec**, not fixed here: a bare
date-only ISO string (`"1970-01-01"`, extremely common in real datasets,
including the `cars.json` dataset this exact spec's own filter and
`xOffset` grouping depend on) parses in JS as **UTC midnight**, but every
`timeUnit` bucketing formula in this file (this one included) reads it
back via **local**-time `Date` getters (`getFullYear()`/`getMonth()`/
`getDate()`/`getDay()`). On any machine whose own local timezone has a
negative UTC offset (confirmed on the machine used for this session: UTC
-5), that mismatch shifts the *apparent* local date backward by one full
day -- confirmed directly: `new Date("1970-01-01").getFullYear()` reads
back as `1969`, not `1970`. For a `year`/`yearmonth`/etc. bucket this is
usually invisible (the same off-by-one shift lands in the same bucket
almost always), but for a spec whose own filter/grouping logic happens to
land right on a year boundary (as this one's `range: [1970, 1971]` year
filter does), the shift silently moves entire years' worth of rows into
the wrong bucket or out of the filter's own range entirely -- confirmed
by tracing this exact spec's own real data through the pipeline by hand:
the two facet groups the chart actually drew turned out to correspond to
model years 1971 and 1972 shifted backward into what looked like 1970 and
1971, not the real 1970/1971 data the spec asked for at all. This affects
every cyclic/local-getter timeUnit in this file, not just the two added
here, and needs a fix at the `data.js` date-coercion layer (parsing a
date-only string as local midnight instead of relying on the `Date`
constructor's own UTC-for-date-only/local-for-datetime split) -- out of
scope for this pass, called out here so it isn't mistaken for a `week`/
`yearweek`-specific defect.

## Validation methodology

Like `vl2d3`, `vl2plot` targets a lower-level toolkit than `vl2altair`/
`vl2vlapi` (which validate against ~99% of the corpus by translating into
another library for the *same* grammar), so results are bucketed three
ways rather than a plain pass/fail:

- **OK** — translated and rendered without error.
- **Skipped** — the spec uses a feature this project has explicitly decided
  not to implement yet (an `"Unsupported: ..."` error at translate time).
  Expected, not a bug.
- **Failed** — anything else. A real bug.

At the time of writing (`test/validate-examples.js`, strict mode): **500/633
OK, 133/633 skipped, 0/633 failed**.

A second, stricter harness (`test/validate-rendering.js`) runs the same
corpus the way the showcase actually does — `{ignoreUnsupported: true}` —
and additionally inspects the *rendered SVG geometry* of every result, not
just whether execution threw. This is the harness that would have caught
the `groupX`/`groupY` bug above directly (extra/wrong-count `<rect>`
elements, not a crash) — though it took a real showcase-image review, not
this harness alone, to catch the *other* silent-correctness bugs the
section above describes (a group transform that renders a plausible-looking
but numerically wrong result, or one broken mark that still leaves a
plausible chart, doesn't always look empty): **590/633 render with real,
finite-geometry shapes**, 0/633 have `NaN`-positioned geometry, 39/633
execute but draw nothing (almost entirely the documented mark/composition
gaps under best-effort mode — e.g. an unsupported mark type is simply
omitted from `marks: [...]`, leaving valid-but-empty output), and 4/633
fail outright — each a narrow, out-of-scope combination: two different
live-selection filter/lookup params (`data('brush_store')`, `{"and":
["index.date", {"param": "index"}]}`), TopoJSON/GeoJSON `format`-typed
data (loaded as a topology object, not a row array — geo support
generally is a documented v1 gap), and one call to `quantileUniform()`, a
niche statistical function specific to QQ-plot specs.

One SVG-geometry-check detail worth noting for anyone extending
`validate-rendering.js`: unlike `vl2d3`'s own hand-rolled D3 code (which
sets bare numeric `x`/`y` attributes on `<text>`), Plot *always* positions
every `<text>` element (axis tick labels as much as a `Plot.text` mark)
via a `transform="translate(cx,cy)"` attribute plus a small relative
`y="0.32em"`-style offset — checking `x`/`y` attributes directly against
Plot output produces a wall of false-positive "NaN" detections (`Number
("0.32em")` is `NaN`); the geometry check for `<text>` inspects the
`transform` attribute's own translate coordinates instead.

The showcase build (`showcase_build/run_plot.mjs`, `{ignoreUnsupported:
true, includeSourcePaths: true}`, matching every other sibling's own
showcase-generation options) reports **629/633 ok** — the same 4 narrow
failures above.
