# vl2d3

Translate a [Vega-Lite](https://vega.github.io/vega-lite/) JSON specification into
standalone [D3](https://d3js.org/) chart-drawing JavaScript code.

Give it a spec (a plain JS object, e.g. from `JSON.parse`) and it returns a
complete ES module string — scales, axes, and mark-drawing code included —
that renders the equivalent chart into a container element.

```js
import {readFileSync} from 'fs';
import {vegaLiteToD3Code} from './src/index.js';

const spec = JSON.parse(readFileSync('chart.vl.json', 'utf8'));
console.log(vegaLiteToD3Code(spec));
```

```js
import * as d3 from "d3";

export default async function chart(container, options = {}) {
  const width = options.width ?? 640;
  const height = options.height ?? 400;
  // ...margins...

  let data1 = [{a: "A", b: 28}, {a: "B", b: 55}, {a: "C", b: 43}];

  const x = d3.scaleBand(Array.from(new Set(data1.map(d => d["a"]))).sort((a, b) => d3.ascending(a, b)), [marginLeft, width - marginRight]).padding(0.1);
  const y = d3.scaleLinear([Math.min(0, d3.min(data1, d => d["b"])), Math.max(0, d3.max(data1, d => d["b"]))], [height - marginBottom, marginTop]).nice();

  const svg = d3.select(container).append("svg")/* ... */;
  // ...axes...

  svg.append("g")
    .attr("fill", "steelblue")
    .selectAll("rect")
    .data(data1)
    .join("rect")
      .attr("x", d => x(d["a"]))
      .attr("width", x.bandwidth())
      .attr("y", d => Math.min(y(0), y(d["b"])))
      .attr("height", d => Math.abs(y(0) - y(d["b"])));

  return svg.node();
}
```

## Why this project is different from its siblings

[`vl2altair`](../vl2altair) and [`vl2vlapi`](../vl2vlapi) translate Vega-Lite
into another library that *already understands Vega-Lite's grammar* (Altair
and vega-lite-api both compile down to real Vega-Lite specs), so those
translators are mostly mechanical: map a JSON key to the right method call
and let the target library do the actual rendering.

D3 has no grammar-of-graphics layer at all — there's no `d3.mark("bar")`.
`vl2d3` has to implement the semantics itself: infer and build the right
scale for each encoding channel, draw the right SVG shapes for each mark
type with the right attributes, and — the part with no equivalent in the
other two projects — turn Vega-Lite's *implicit* data pipeline
(`aggregate`/`bin`/`timeUnit` declared inline on an encoding channel, e.g.
`{"y": {"aggregate": "mean", "field": "Rating"}}`) into explicit
`d3.rollup`/`d3.bin` data-transformation statements that run before anything
is drawn. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how that
pipeline works.

Because of this, `vl2d3`'s scope is deliberately narrower than its siblings'
— see *What it supports* below — and its validation methodology is
different too (see *Known limitations*): a hand-built renderer can't
reasonably aim for near-100% coverage of a grammar with far more expressive
power than the toolkit it targets, so failures are separated into
"unsupported by design" vs. "an actual bug."

## Install

This package has no required dependencies to *generate* code — `src/` is
plain ESM with no imports beyond itself. To *run* the generated code you
need `d3` installed alongside it.

```bash
npm install
```

installs the `devDependencies` (`d3`, `jsdom`) used by the test suite; a
consumer of the *generated* code only needs `d3` itself.

## Usage

### As a library

```js
import {vegaLiteToD3Code} from './src/index.js';

const code = vegaLiteToD3Code(spec); // spec: plain object
```

The returned string is a complete ES module exporting a single async
function, `chart(container, options)`:

```js
import chart from './generated-chart.js';

await chart(document.getElementById('my-chart'));
// or with overrides:
await chart(el, {width: 800, height: 500, baseURL: 'https://example.com/data/'});
```

`options.width`/`height`/`marginTop`/`marginRight`/`marginBottom`/`marginLeft`
override the chart's default dimensions. `options.baseURL` resolves any
relative `data: {"url": "..."}` reference in the spec — without it, the
generated module resolves relative URLs against its own location
(`import.meta.url`), which matters in a plain Node/test context but rarely
in a browser page (where a relative URL already resolves against the
page's own location the same way a normal `<script>`-loaded fetch would).

### From the command line

```bash
node bin/cli.js chart.vl.json                # print to stdout
node bin/cli.js chart.vl.json -o chart.js     # write to a file
cat chart.vl.json | node bin/cli.js           # read from stdin
```

## What it supports

| Vega-Lite feature | Support |
|---|---|
| Single unit view (`mark` + `encoding`) | ✅ |
| `layer` (including nested layer-of-layers) | ✅ — children rendered on shared scales/axes |
| `facet`, `repeat`, `concat`, `hconcat`, `vconcat` | ❌ throws a clear "not yet supported" error |
| Marks: `bar`, `point`, `circle`, `line`, `area`, `rule`, `tick`, `text`, `arc` | ✅ |
| Marks: `rect`, `boxplot`, `errorbar`, `errorband`, `geoshape`, `image`, `trail` | ❌ |
| `x`/`y` scales: linear, time, band, point, log/pow/sqrt | ✅ (inferred from field type + mark) |
| `color`: ordinal (with a basic swatch legend) and sequential/continuous | ✅ |
| `size`, `opacity` | ✅ (quantitative only) |
| Multi-series `line`/`area` grouped by `color`/`detail` | ✅ |
| 1D strip/dot plots (only one of x/y given) | ✅ |
| Inline `aggregate`/`bin`/`timeUnit` on an encoding channel | ✅ (0–2 groupby fields; one binned channel as a histogram) — see limitations |
| Top-level `transform`: `filter`, `calculate`, `aggregate`, `bin`, `timeUnit` | ✅ |
| Top-level `transform`: `window`, `joinaggregate`, `lookup`, `impute`, `pivot`, `fold`, `flatten`, `quantile`, `regression`, `loess`, `density`, `sample`, `stack`, `sort`, `extent` | ❌ |
| `params`/`selection` (interactivity, conditional encodings as *static* values) | ⚠️ a `condition`/`param` reference passes through as a literal object (so the generated code is valid and the "default" branch renders), but there's no live selection/binding behavior |
| Geographic encoding (`longitude`/`latitude`) or `projection`-driven marks | ❌ no map projection support |
| Vega expression strings (`filter`/`calculate`) | ⚠️ best-effort: `datum` → row var, common `Math.*` functions, date-component extraction (`year()`, `month()`, ...); anything else (custom Vega functions, `datetime()`, string helpers like `toString`/`isValid`/`length`) passes through as literal text and fails loudly at chart-render time rather than silently miscalculating |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the reasoning behind
each of these boundaries, and exactly how the aggregate/bin/timeUnit
pipeline is implemented.

## Known limitations

Unlike `vl2altair`/`vl2vlapi` (which validate against ~99% of the same
633-spec corpus, since they translate into another library for the *same*
grammar), `vl2d3` targets a lower-level toolkit with a deliberately smaller
v1 feature set, so its validation harness (`test/validate-examples.js`)
buckets results three ways instead of a plain pass/fail:

- **OK** — translated and rendered correctly.
- **Skipped** — the spec uses a feature this project has explicitly decided
  not to implement yet (an "Unsupported: ..." error at translate time).
  Expected, not a bug.
- **Failed** — anything else. A real bug.

At the time of writing: **291/633 OK, 339/633 skipped (documented
boundaries above), 3/633 failed** (residual edge cases, each combining
several unusual features at once — e.g. pre-binned `"bin": "binned"` data
combined with cross-layer channel inheritance and a `zindex` axis option;
diminishing returns to chase further for a v1). See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full methodology.

Two design choices worth calling out explicitly:

- **No auto-stacking.** Vega-Lite automatically stacks `bar`/`area` marks
  when a `color`/`detail` channel is present and the value channel isn't
  explicitly unstacked. `vl2d3` does not implement this — a
  color-by-category bar/area chart renders as overlapping series on shared
  scales, not a stacked one. Implementing Vega-Lite-compatible stacking
  correctly is a project-sized feature on its own.
- **No live interactivity.** `params`/`selection` don't create any bound
  DOM event handlers, sliders, or brushes — a static-value `condition`
  reference still renders (using its default branch), but nothing responds
  to user input.

## Testing

```bash
npm test
```

runs the unit suite (`node --test test/translator.test.js`), which executes
every generated chart against [jsdom](https://github.com/jsdom/jsdom) and
asserts on the resulting SVG structure (mark counts, grouped series, axis
presence, ...).

`test/validate-examples.js` is a standalone harness that runs the
translator over a directory of `*.vl.json` files, executes the generated
code against jsdom (with a real local HTTP server so `url`-sourced data
actually loads), and reports OK/Skipped/Failed counts grouped by reason:

```bash
node test/validate-examples.js /path/to/vega-lite/examples/specs /path/to/vega-datasets/data
```

Both directories are external checkouts used during development, not
vendored in this package — the second (`vega-datasets`) argument is
optional; without it, `url`-sourced examples fail their `fetch()` and are
excluded from the count rather than counted as failures.

## Project layout

```
src/
    index.js        public API: vegaLiteToD3Code()
    translator.js    orchestrator: dispatches on layer/unit, flattens nested
                      layers, wires data loading -> transforms -> prepare ->
                      scales -> axes -> marks together
    prepare.js       inline encoding aggregate/bin/timeUnit -> explicit
                      d3.rollup/d3.bin statements + a rewritten encoding
                      (the piece with no equivalent in vl2altair/vl2vlapi)
    scales.js        encoding channel -> scale declaration (type inference,
                      domain/range computation)
    marks.js         per-mark-type D3 "join" code generation
    transforms.js    top-level `transform` array -> data-processing statements
    data.js          data-loading code (inline values / url fetch)
    expr.js          best-effort Vega-expression-string -> JS translation
    aggops.js        aggregate op -> d3-array function mapping
    timeunit.js      timeUnit name -> Date-truncation expression mapping
    literals.js      JSON value -> JavaScript literal source pretty-printer
    calls.js         fluent-call/chain rendering with line wrapping
bin/
    cli.js           command-line entry point
test/
    translator.test.js     node:test unit suite (jsdom-executed)
    validate-examples.js   corpus-validation harness (see above)
docs/
    ARCHITECTURE.md         design notes and internals
```
