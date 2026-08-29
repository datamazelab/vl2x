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

At the time of writing (`test/validate-examples.js`, strict mode): **458/633
OK, 175/633 skipped, 0/633 failed**.

A second, stricter harness (`test/validate-rendering.js`) runs the same
corpus the way the showcase actually does — `{ignoreUnsupported: true}` —
and additionally inspects the *rendered SVG geometry* of every result, not
just whether execution threw. This is the harness that would have caught
the `groupX`/`groupY` bug above directly (extra/wrong-count `<rect>`
elements, not a crash): **562/633 render with real, finite-geometry
shapes**, 0/633 have `NaN`-positioned geometry, 68/633 execute but draw
nothing (almost entirely the documented mark/composition gaps under
best-effort mode — e.g. an unsupported mark type is simply omitted from
`marks: [...]`, leaving valid-but-empty output), and 3/633 fail outright —
each a narrow, out-of-scope combination: a live-selection filter param
(`{"and": ["index.date", {"param": "index"}]}`), TopoJSON/GeoJSON
`format`-typed data (`{"format": {"type": "topojson", ...}}`, loaded as a
topology object, not a row array — geo support generally is a documented
v1 gap), and one call to `quantileUniform()`, a niche statistical function
specific to QQ-plot specs.

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
showcase-generation options) reports **630/633 ok** — the same 3 narrow
failures above.
