# vl2plot

Translate a [Vega-Lite](https://vega.github.io/vega-lite/) JSON specification into
standalone [Observable Plot](https://observablehq.com/plot/) chart-drawing JavaScript code.

Give it a spec (a plain JS object, e.g. from `JSON.parse`) and it returns a
complete ES module string that renders the equivalent chart into a
container element by building one `Plot.plot({...})` call.

```js
import {readFileSync} from 'fs';
import {vegaLiteToPlotCode} from './src/index.js';

const spec = JSON.parse(readFileSync('chart.vl.json', 'utf8'));
console.log(vegaLiteToPlotCode(spec));
```

```js
import * as Plot from "@observablehq/plot";

export default async function chart(container, options = {}) {
  let chartData = [{a: "A", b: 28}, {a: "B", b: 55}, {a: "C", b: 43}];
  const node = Plot.plot({
    document: container.ownerDocument,
    marks: [
      Plot.barY(chartData, {
        x: "a",
        y: "b",
      }),
    ],
  });
  container.appendChild(node);
  return node;
}
```

## Why this project is different from its siblings

[`vl2altair`](../vl2altair) and [`vl2vlapi`](../vl2vlapi) translate Vega-Lite
into another library that *already understands Vega-Lite's grammar*, so
those translators are mostly mechanical. [`vl2d3`](../vl2d3) sits at the
other extreme: D3 has no grammar-of-graphics layer at all, so it has to
hand-build scale inference, axis rendering, and per-mark SVG drawing from
scratch.

Observable Plot lands in between. It **is** a grammar-of-graphics layer —
`Plot.plot({marks, x, y, color, facet, ...})` already infers scales, draws
legends, and lays out facets — so `vl2plot` doesn't need `vl2d3`'s own
hand-rolled `scales.js`/facet-grid machinery at all. What Plot doesn't share
with Vega-Lite is the *data-pipeline* shape: Vega-Lite's inline
`aggregate`/`bin`/`timeUnit` are encoding-channel properties, while Plot
expresses the same ideas as composable *transform wrapper functions*
(`Plot.binX`, `Plot.groupX`, `Plot.stackY`, ...) that wrap a mark's own
options object. That translation — picking the right wrapper, its output
channel names, and its composition order — is `vl2plot`'s own equivalent of
`vl2d3`'s `prepare.js`, just considerably thinner, since Plot's own
transforms already implement the actual grouping/binning/stacking math (no
hand-rolled `d3.rollup`/`d3.bin`/cumulative-sum needed anywhere in this
project). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full
design writeup, including a subtle asymmetry worth knowing up front:
`Plot.binX`/`Plot.groupX` are named after the axis *being binned* or the
*grouping key* respectively — not symmetrically, so picking the wrong one
for a given channel silently draws the wrong shapes rather than throwing
(see the "silent-miscount" note in ARCHITECTURE.md).

## Install

This package has no required dependencies to *generate* code — `src/` is
plain ESM with no imports beyond itself. To *run* the generated code you
need `@observablehq/plot` (and, when the spec's data pipeline needs it, `d3`)
installed alongside it.

```bash
npm install
```

installs the `devDependencies` (`@observablehq/plot`, `d3`, `jsdom`) used by
the test suite; a consumer of the *generated* code only needs
`@observablehq/plot` itself (plus `d3` when the generated file imports it).

## Usage

### As a library

```js
import {vegaLiteToPlotCode} from './src/index.js';

const code = vegaLiteToPlotCode(spec); // spec: plain object
const code = vegaLiteToPlotCode(spec, {ignoreUnsupported: true}); // best-effort fallback (see below)
const code = vegaLiteToPlotCode(spec, {includeSourcePaths: true}); // annotate each block with its source
```

`includeSourcePaths` (default `false`): precedes each generated block of
statements with a `// from: <json path>` comment naming the part of the
input spec it came from — useful for tracing generated code back to the
spec, at the cost of a noisier script.

The returned string is a complete ES module exporting a single async
function, `chart(container, options)` — deliberately the same
generated-code contract as [`vl2d3`](../vl2d3):

```js
import chart from './generated-chart.js';

await chart(document.getElementById('my-chart'));
// or with a data baseURL override:
await chart(el, {baseURL: 'https://example.com/data/'});
```

`options.baseURL` resolves any relative `data: {"url": "..."}` reference in
the spec — without it, the generated module resolves relative URLs against
its own location (`import.meta.url`).

### From the command line

```bash
node bin/cli.js chart.vl.json                     # print to stdout
node bin/cli.js chart.vl.json -o chart.js          # write to a file
node bin/cli.js chart.vl.json --ignore-unsupported # best-effort fallback (see below)
node bin/cli.js chart.vl.json --include-source-paths
cat chart.vl.json | node bin/cli.js                # read from stdin
```

## `ignoreUnsupported`: best-effort rendering instead of a clean refusal

By default, an unsupported feature throws a clear `"Unsupported: ..."`
error — nothing renders, and the message says exactly what wasn't handled.
Passing `{ignoreUnsupported: true}` (or `--ignore-unsupported` on the CLI)
relaxes that into a best-effort fallback instead:

- An unsupported mark type, transform type, or filter predicate shape is
  skipped (dropped from the output, or the whole mark omitted) rather than
  aborting the whole chart.
- An unrecognized color scheme name falls back to Plot's own default scheme
  instead of failing at chart-render time.
- `facet`-within-`facet` (two-dimensional faceting spelled as a nested
  template) renders only the inner facet.
- A layered spec's own `facet` renders unfaceted (one combined panel).
- `repeat` renders an empty panel rather than attempting a broken
  best-effort substitution (see ARCHITECTURE.md for why this is safer than
  it sounds).

This is always an explicit opt-in — the default stays exactly as strict as
without the flag. See `src/translator.js`'s module docstring and
`src/marks.js` for the full list of fallbacks.

## What it supports

| Vega-Lite feature | Support |
|---|---|
| Single unit view (`mark` + `encoding`) | ✅ |
| `layer` (including nested layer-of-layers) | ✅ — one shared `Plot.plot()`, one `marks` array |
| `hconcat`, `vconcat`, `concat` | ✅ — independent `Plot.plot()` calls in a flex/grid wrapper (Plot has no native multi-plot layout) |
| `facet` (single-dimension, plain-unit template) | ✅ — Plot's own native `facet: {data, x, y}` option, no hand-built grid |
| `facet` (nested facet-within-facet, or faceting a layered template) | ❌ |
| `repeat` | ❌ |
| Marks: `point`/`circle`/`square`, `bar`, `line`, `area`, `rule`, `tick`, `text`, `rect`/`cell`, `boxplot` | ✅ |
| Marks: `arc`, `trail`, `errorbar`, `errorband`, `geoshape`, `image` | ❌ |
| `x`/`y`/`x2`/`y2` (including a continuous bin-interval category axis, e.g. a log-scaled histogram) | ✅ |
| `color` (categorical and continuous), `size`, `opacity`, `shape` | ✅ — Plot's own scale type inference handles both categorical and continuous color without a hand-rolled dual path |
| `detail` (→ Plot's own `z` channel), `order` (→ Plot's own `sort` mark option), `tooltip` (→ Plot's own `title` channel, a real native tooltip) | ✅ |
| Inline `aggregate`/`bin`/`timeUnit` on an encoding channel | ✅ — routed through `Plot.binX`/`Plot.groupX` (etc.) wrapper calls |
| Implicit per-mark `stack` (`bar`/`area` colored by `color`/`detail`) | ✅ — Plot's own native `offset: "normalize"/"center"` |
| Top-level `transform`: `filter`, `calculate`, `aggregate`, `bin`, `timeUnit` | ✅ |
| Top-level `transform`: `window`, `joinaggregate`, `fold`, `pivot`, `lookup`, `density`, `flatten`, `sort`, `impute`, `stack` | ❌ |
| Vega expression strings (`filter`/`calculate`) | ⚠️ best-effort: `datum` → row var, `Math.*` functions, date-component extraction, `length()`/`substring()`/`indexof()`/`format()`/`isValid()`/`if()`; anything else passes through as literal text and fails loudly at chart-render time rather than silently miscalculating |
| `params`/`selection` (live interactivity) | ❌ |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the reasoning behind
each of these boundaries.

## Known limitations

Like `vl2d3`, `vl2plot` targets a lower-level toolkit than
`vl2altair`/`vl2vlapi` (which validate against ~99% of the corpus by
translating into another library for the *same* grammar), so its validation
harness (`test/validate-examples.js`) buckets results three ways instead of
a plain pass/fail:

- **OK** — translated and rendered without error.
- **Skipped** — the spec uses a feature this project has explicitly decided
  not to implement yet. Expected, not a bug.
- **Failed** — anything else. A real bug.

At the time of writing: **458/633 OK, 175/633 skipped (documented
boundaries above), 0/633 failed**. A second, stricter harness
(`test/validate-rendering.js`) additionally inspects the *rendered SVG
geometry* of every `--ignore-unsupported` run (not just whether
translation+execution threw): **562/633 render with real, finite-geometry
shapes** (0/633 have `NaN`-positioned geometry, 68/633 execute but draw
nothing — almost entirely the documented mark/composition gaps above under
best-effort mode — 3/633 fail outright, each a narrow, out-of-scope
combination: live-selection filter params, TopoJSON/GeoJSON `format`-typed
data, and one niche statistical expression function). See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full methodology.

One design choice worth calling out explicitly:

- **No live interactivity.** `params`/`selection` aren't implemented at all
  (not even a static-default-branch approximation) — a spec that leans on
  them for its core content (a brush filter, an interactive legend) won't
  reflect that behavior.

## Testing

```bash
npm test
```

runs the unit suite (`node --test test/translator.test.js`), which executes
every generated chart against [jsdom](https://github.com/jsdom/jsdom) and
asserts on the resulting SVG structure (mark counts, grouped series, axis
presence, ...).

`test/validate-examples.js` and `test/validate-rendering.js` are standalone
harnesses that run the translator over a directory of `*.vl.json` files —
see "Known limitations" above for what each one checks:

```bash
node test/validate-examples.js /path/to/vega-lite/examples/specs /path/to/showcase
node test/validate-rendering.js /path/to/vega-lite/examples/specs /path/to/showcase
```

Both directories are external/sibling checkouts used during development,
not vendored in this package — the second argument (a local static-file
root for `url`-sourced data, matching this repo's own `showcase/data/`
convention) is optional; without it, `url`-sourced examples fail their
`fetch()` and are excluded from the count rather than counted as failures.

## Project layout

```
src/
    index.js        public API: vegaLiteToPlotCode()
    translator.js     orchestrator: dispatches on layer/unit/hconcat/vconcat/
                       concat/facet, wires data loading -> transforms ->
                       marks -> scale options together, emits the final
                       `export default async function chart(container, options)`
    prepare.js         inline encoding aggregate/bin/timeUnit -> Plot.binX/
                        Plot.groupX (etc.) wrapper-call decisions
    marks.js            per-mark-type Plot.xyz(data, {...}) codegen dispatch
    encoding.js          shared channel-value/type-inference helpers
    scales.js             VL scale type/domain/range/scheme -> Plot's own
                           top-level scale options object
    stack.js               VL implicit stacking -> Plot.stackX/stackY's own
                            native `offset` option
    transforms.js            top-level `transform` array -> data-processing
                              statements
    aggops.js                 aggregate op -> Plot reducer name mapping
                              (plus the d3-rollup-based path top-level
                              `transform: [{aggregate: ...}]` needs)
    timeunit.js                timeUnit name -> Date-derived field expression
    expr.js                     best-effort Vega-expression-string -> JS
                                 translation
    data.js                      data-loading code (inline values / url fetch)
    literals.js                   JSON value -> JavaScript literal source
                                   pretty-printer
bin/
    cli.js           command-line entry point
test/
    translator.test.js     node:test unit suite (jsdom-executed)
    validate-examples.js   corpus-validation harness (see above)
    validate-rendering.js  rendered-geometry inspection harness (see above)
docs/
    ARCHITECTURE.md         design notes and internals
```
