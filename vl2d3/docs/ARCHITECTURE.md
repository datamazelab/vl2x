# Architecture and design notes

This document explains *how* `vl2d3` translates a Vega-Lite spec into D3
code, why its design differs so much from its siblings
[`vl2altair`](../../vl2altair) and [`vl2vlapi`](../../vl2vlapi), and the bugs
that real execution against a large spec corpus caught along the way. For
usage, see [`../README.md`](../README.md).

## Why this couldn't be a mechanical translation

`vl2altair` and `vl2vlapi` both target libraries that *are* Vega-Lite
wrappers — Altair and vega-lite-api both ultimately produce a real
Vega-Lite spec and hand it to the genuine Vega-Lite compiler. That means
almost every property in those two projects maps onto a method of the same
(or a documented-alias) name, and the target library does all the actual
semantic work: resolving scale domains, inferring aggregate/bin behavior,
laying out composite views.

D3 has none of that. There is no `d3.mark("bar")`, no implicit "if this
channel has `aggregate: 'mean'`, group and summarize the data for me."
`vl2d3` has to implement each of those pieces itself:

1. Turn Vega-Lite's *declarative, implicit* data pipeline into *explicit*
   JS statements that actually reshape the data (`prepare.js`, `transforms.js`).
2. Infer and construct the right D3 scale for each encoding channel, since
   there's no `alt.X(...)`/`vl.x(...)` object that already knows how
   (`scales.js`).
3. Generate the actual SVG-drawing code per mark type, since D3 has marks
   only in the sense of "here's how you'd draw a rect/circle/path yourself"
   (`marks.js`).

This is why the project's scope is deliberately narrower than its siblings
and why its validation methodology is different (see the bottom of this
document) — it's closer to writing a small compiler backend than a calling-
convention translator.

## The aggregate/bin/timeUnit pipeline (`prepare.js`)

This is the piece with no equivalent at all in `vl2altair`/`vl2vlapi` (their
target libraries handle it natively). Vega-Lite lets `aggregate`, `bin`, and
`timeUnit` be declared *inline on an encoding channel* — e.g.
`{"y": {"aggregate": "mean", "field": "Rating", "type": "quantitative"}}` —
and expects the renderer to group/summarize/derive accordingly before
drawing. `prepare.js` turns those declarations into explicit `data = ...`
statements (using `d3.rollup`/`d3.bin`) and returns a *rewritten* encoding
whose channels reference plain output fields on the transformed data — so
`scales.js` and `marks.js` never need to know aggregate/bin/timeUnit exist
at all; they just see a flat array of rows and field names.

Handled cases:

- 0–2 "groupby" channels (plain fields, or `timeUnit`-derived fields) plus
  any number of aggregate value channels, combined via a single
  `d3.rollup(data, rows => ({...aggregates}), keyFn1, [keyFn2])` pass,
  flattened back into a row array.
- Exactly one **binned** channel with at most one aggregate value channel
  and no other groupby channels (the histogram case) — implemented via
  `d3.bin().value(...)`, which conveniently already groups rows into bins,
  so the aggregate for each bin is computed directly over `bin` (the row
  array for that bin) rather than needing a separate grouping step.
- `timeUnit` with no aggregate at all — a plain per-row `.map()` deriving
  the truncated field (`timeunit.js` maps the unit name to a `Date`-mutation
  expression).

Anything past that (binning combined with other groupby channels, more than
two groupby channels, an unsupported aggregate op) throws a clear
`Unsupported: ...` error naming exactly what isn't handled, rather than
emitting code that computes something silently wrong. A visualization tool
that renders confidently incorrect numbers is worse than one that refuses.

## Row-dependent color: a bug class found only by executing the output

A `fillExpr()`/`accessor()` helper in `marks.js` can return either a
constant (`"steelblue"`) or a per-row expression (`color(d["field"])`,
referencing the row variable `d`). Several mark renderers originally placed
this at the wrong scope: e.g. `svg.append("g").attr("fill", fill)` — fine
when `fill` is a constant (SVG's `fill` is an inheritable presentation
attribute, so children pick it up), but silently wrong when it's a
per-row expression, since there's no `d` in scope on the `<g>` itself. The
generated code wasn't a translate-time error — it only failed at *render*
time (`ReferenceError: d is not defined`), and only for specs with a
`color` encoding on `bar`/`point`/`rule`/`tick`/`text`/`area` marks.

This is exactly the kind of bug that inspecting generated source doesn't
catch — the code *looks* plausible; it only breaks when actually executed
with a color-encoded spec. It was caught by the corpus validation harness
(below), not by hand-written unit tests. The fix (`hasRowDependentColor()`
in `marks.js`) makes every mark renderer place a row-dependent fill/stroke
on the joined-element selection (`d => fill`) instead of the enclosing `<g>`,
and only use the `<g>`-level constant form when the value is truly constant.

## Shared runtime helpers vs. inlining

Most transforms (`filter`, `calculate`, `aggregate`, `bin`, `fold`, ...)
compile to a short, self-explanatory inline statement — there's no real
maintenance cost to re-deriving that logic at every call site, and doing so
keeps the generated code fully self-contained (nothing to import beyond
`d3` itself). `pivot` (fold's inverse: spreading rows into columns, with
duplicate-cell aggregation and a possibly-limited, stably-ordered column
set) is the first transform substantial enough that the calculus flips: its
naive inline expansion is a genuine multi-step algorithm, not a one-liner,
and re-deriving it inline on every call site would be easy to get subtly
wrong in a way unit tests on one or two specs wouldn't catch.

`src/runtime.js` holds exactly these — real, independently-readable
exported functions, imported by name only when a spec's translated
transform actually needs one (see `RUNTIME_EXPORTS` in `translator.js`).
The tradeoff this accepts: the generated code is no longer *fully*
self-contained (a real file dependency, not just a bare-specifier `d3`
import resolved by a bundler/CDN import map) — mitigated by treating
`runtime.js` as something a plain copy of accompanies the generated file
wherever it's written, the same way `d3.js`/`ggplot.R` already sit next to
`index.html` in each showcase example directory, rather than trying to
publish it as an installable package a generated file could reference by
name.

## Composing dodge and stack on the same mark

A dodged field (`xOffset`/`yOffset`) and a stacked one (`color`/`detail`
driving an implicit `stack`) can both be present on the same `bar`/`area`
mark — dodge picks the sub-band, stack fills it (`planStacking()` in
`stack.js`). The one exception: when the dodge field and the stack field are
the *same* field, that's plain dodging with no stacking at all (dodging
already fully expresses that one dimension) — `planStacking()` nulls out the
stack-group channel in that case rather than trying to stack a group of one.

Stacking a mix of positive and negative values (e.g. a population-pyramid-
style diverging bar chart) can't use a single running cumulative sum — each
new sign's segment would continue from wherever the *other* sign's
accumulator last left off, instead of starting fresh at 0.
`renderStackingStatements()` maintains two separate running totals
(`{pos: 0, neg: 0}`) for the default zero-baseline mode, routing each row's
own `y0`/`y1` through whichever accumulator matches its own value's sign.
`normalize`/`center` modes keep a single running total (their own
after-the-fact rescale already treats the whole stack as one span,
regardless of individual signs).

## Other bugs corpus validation caught

A representative sample, because each says something about where static
reading of the generator would have missed the problem:

- **Field names spliced directly into JS identifiers.** A histogram's bin
  array was named `` `${field}Bins` `` — for a field like `"IMDB Rating"`
  (a space in it, extremely common in real datasets), this produced `const
  IMDB RatingBins = ...`, a syntax error. Fixed by a proper identifier
  sanitizer (`toIdentifier()` in `prepare.js`) that also folds in the
  `dataVar`, incidentally fixing a second bug (two layer children binning
  the same field name collided on the same variable name).
- **Nested `layer`-within-`layer`.** Vega-Lite allows a layer *child* to
  itself be a layer composition. The translator originally flattened only
  one level, so a mark-less nested-layer child reached `isBarOrArea(mark)`
  with `mark === undefined` and crashed on `mark.type`. Fixed with a
  recursive `flattenLayers()` that applies `mergeDown` at each nesting
  level.
- **`timeUnit`/date-function field coercion was too narrow.** Temporal
  fields need coercion from JSON strings into real `Date` objects before
  anything else runs. The initial version only looked for encoding channels
  with an explicit `"type": "temporal"` — missing (a) channels where
  `timeUnit` is present but `type` is omitted (Vega-Lite infers temporal in
  that case), and (b) fields referenced by a bare `year(datum.X)`-style call
  inside a `calculate` transform, which implies the same coercion need but
  isn't named by any encoding channel at all. Both are now detected
  (`collectTemporalFields()` in `translator.js`, plus
  `extractDateFunctionFields()` in `expr.js`).
- **`timeUnit` as an object, not just a string.** Vega-Lite allows
  `{"unit": "year", "step": 2}` (binned time units), not only a bare unit
  string. `timeunit.js`'s normalizer now accepts either form (the `step` is
  dropped — only the base unit is honored — rather than crashing on
  `unit.startsWith is not a function`).
- **A non-array `scale.domain`.** Vega-Lite supports several domain
  *reference* forms beyond a literal array (`{"unionWith": [...]}`, a
  selection-driven domain, ...). The original code passed whatever object
  was there straight through as if it were an array, producing e.g.
  `d3.scaleOrdinal({unionWith: [5, 6]}, [...])` — which fails at render time
  with the unhelpful `_ is not iterable`. Only a plain-array domain is
  supported now; anything else throws a clear, named error instead
  (`explicitDomainCode()` in `scales.js`).
- **A mark-level literal color config was never read at all.** Every mark
  renderer computed its own hardcoded fallback color (`"steelblue"`,
  `"black"`) whenever `encoding.color` was absent, completely ignoring a
  mark-level `"mark": {"type": "rule", "stroke": "firebrick"}`-style
  property (present on ~40 corpus specs) — every one of those rendered in
  the wrong color with no error at all, since a hardcoded fallback is
  always "valid" output. `markColorFallback()` in `marks.js` now checks the
  mark's own `stroke`/`fill`/generic `color` property before falling back
  to the hardcoded default.
- **A `bar` mark with two quantitative (non-band) position channels drew
  points, not bars.** A Q-Q-style bar chart (both `x` and `y` quantitative,
  no ordinal/band axis, no `x2`/`y2` range) fell all the way through
  `renderBar()`'s orientation dispatch to the same "draw a point per row"
  fallback used for genuinely unsupported shapes — but Vega-Lite renders
  real bars here, a fixed-width (`config.bar.continuousBandSize`, 5px)
  column per row from the y-zero baseline. Now a first-class case, not an
  approximation.
- **A `timeUnit`-bucketed filter compared the wrong shape.** `{"field":
  "date", "timeUnit": "year", "equal": 2006}` is Vega-Lite's standard
  filter-by-year idiom — comparing just the extracted *year number* to
  `2006`, not the field's own `year`-truncated *Date* to it (a Date vs. a
  bare number is never meaningfully equal). The initial `timeUnit`-aware
  filter support bucketed the field into a Date unconditionally regardless
  of the comparison value's shape, silently filtering out every row
  whenever the value was a plain scalar rather than a `DateTime` object.
  `timeUnitComponentExpr()` in `timeunit.js` now extracts the bare
  component number (year/month/date/hours/minutes/seconds/quarter) for
  exactly this case, used only when the comparison value isn't a
  `DateTime` object.
- **An escaped field name (`"a\\.b"`, a literal dot in a flat column name)
  was never actually unescaped.** Vega-Lite's own field-path convention
  uses a leading backslash to mean "this dot isn't a nested-path separator"
  — every accessor in this codebase reads `field` directly as a literal
  object-property key, so the escaping needs undoing *somewhere* before
  that happens; nothing did, so `d[JSON.stringify(field)]` looked up a
  property that only existed with a literal backslash still in its name
  (never present in the real, loaded data). `unescapeEncodingFields()` in
  `translator.js` does this once, up front, for every channel's `field`,
  before any accessor call site ever sees it.
- **Mark properties bound to an expression.** A property like
  `"strokeWidth": {"expr": "strokeWidth"}` (binding it to a `param`) isn't a
  literal — splicing it directly into a template literal produced the text
  `[object Object]` unquoted in the generated source (a syntax error:
  `[object Object]` parses as an array literal containing two adjacent
  identifiers). `simpleMarkProp()` in `marks.js` now detects an
  object-valued mark property and throws a clear "bound to an
  expression/signal" error instead.
- **A "tick" mark always drew a horizontal dash, regardless of which axis was
  the continuous one.** Vega-Lite draws a tick *perpendicular* to whichever
  channel is continuous (a vertical dash pinned to an x position, spanning
  within a discrete y band — the more common shape — or a horizontal dash the
  other way around when y is continuous and x is the discrete one). The
  original code always produced the horizontal shape, silently transposing
  every chart of the (more common) other kind — a bug invisible from reading
  the generator (it produces a plausible-looking tick either way) and only
  caught by actually looking at the rendered geometry. `renderTick()` in
  `marks.js` now checks each channel's own `type` to pick the orientation.
- **`mark.invalid: null`/`false` (as opposed to the default `"filter"`) was
  silently ignored.** Vega-Lite's default drops/gaps invalid position values
  on a line/area's own path; explicitly asking for `null`/`false` instead
  means "use the value as-is," which for a continuous position resolves to a
  literal 0 (a dip to the baseline, not a gap or a dropped row) — a
  deliberately out-of-scope case originally, until a spec exercising it
  showed the gap. `renderInvalidZeroFill()` in `translator.js` coerces those
  fields to 0 upstream of drawing instead of leaving them to become `NaN`
  path coordinates.

## Corpus validation methodology

Because `vl2d3` targets a fundamentally lower-level toolkit with a
deliberately smaller feature set, a plain pass/fail count against the
633-spec corpus (as used by `vl2altair`/`vl2vlapi`) wouldn't be meaningful —
most specs legitimately use something out of scope for a v1. So
`test/validate-examples.js` buckets every spec into one of three outcomes:

1. **OK** — translate, execute (against jsdom), no error.
2. **Skipped** — translation or execution raised one of this project's own
   `Unsupported: ...`/`"... mark type: ..."`/`"... transform type: ..."`
   errors. An intentional scope boundary, not a bug.
3. **Failed** — anything else. By construction, every failure in this
   bucket is either a real bug or an undocumented gap worth documenting —
   there's no third option, which is what makes this bucketing useful for
   iterating: each run's failure list is a checklist of foreign code to
   read rather than skimming pass/fail.

To exercise `url`-sourced data specs faithfully (about a third of the
corpus), the harness spins up a small local HTTP server over a
[vega-datasets](https://github.com/vega/vega-datasets) checkout and passes
its address as `options.baseURL` to the generated `chart()` function — this
is also why the generated code resolves relative data URLs via `new
URL(url, options.baseURL ?? import.meta.url)` rather than just handing the
relative string straight to `d3.json`/`d3.csv` (which requires an absolute
URL outside a browser document context).

At the time of writing: 408/633 OK, 225/633 skipped, 0/633 failed. A
companion harness, `test/validate-rendering.js`, runs the full corpus a
second time under `--ignore-unsupported` and additionally inspects the
*rendered SVG geometry* of every drawn shape (not just whether
translation+execution threw) — the gap it closes: a D3 selection given a
`NaN` coordinate (e.g. an accessor reading a field some silently-skipped
upstream transform never produced) doesn't throw at all, it just draws an
invalid shape a browser quietly refuses to display, which showed up as a
false "OK" against the plain execute-without-throwing bar. At the time of
writing: 609/633 render with real, finite geometry, 5/633 have at least one
`NaN`-geometry shape, 4/633 execute but draw nothing, 15/633 fail outright.
Every bug described above was found through one of these two harnesses —
none were caught by reading the generator code or by the hand-written unit
suite, which is the whole reason they exist.
