# vl2vlapi

Translate a [Vega-Lite](https://vega.github.io/vega-lite/) JSON specification into
runnable [vega-lite-api](https://github.com/vega/vega-lite-api) JavaScript code.

Give it a spec (a plain JS object, e.g. from `JSON.parse`) and it returns a
standalone JavaScript module string that builds the equivalent chart with
`vl.mark(...)`, `.data(...)`, `.encode(...)`, `.transform(...)`, etc.

```js
import {readFileSync} from 'fs';
import {vegaLiteToVegaLiteApiCode} from './src/index.js';

const spec = JSON.parse(readFileSync('chart.vl.json', 'utf8'));
console.log(vegaLiteToVegaLiteApiCode(spec));
```

```js
import * as vl from 'vega-lite-api';

const chartData = [{a: "A", b: 28}, {a: "B", b: 55}];

const chart = vl.mark("bar")
  .data(chartData)
  .encode(vl.x({field: "a", type: "nominal"}), vl.y({field: "b", type: "quantitative"}));

export default chart;
```

## Install

This package has no required dependencies to *generate* code — `src/` is
plain ESM with no imports beyond itself. To *run* the generated code you
need `vega-lite-api` (and, to render or compile it, `vega` and `vega-lite`)
installed alongside it.

```bash
npm install
```

installs the `devDependencies` (`vega`, `vega-lite`, `vega-lite-api`) used by
the test suite; a consumer of the *generated* code only needs `vega-lite-api`
itself (plus `vega`/`vega-lite` if they intend to render, per
[vega-lite-api's own README](https://github.com/vega/vega-lite-api#readme)).

## Usage

### As a library

```js
import {vegaLiteToVegaLiteApiCode} from './src/index.js';

const code = vegaLiteToVegaLiteApiCode(spec);                   // spec: plain object
const code = vegaLiteToVegaLiteApiCode(spec, {chartVar: 'plot'}); // rename the output variable
```

The returned string is a complete ES module: it declares `const chart = ...`
and `export default chart`, so `import`-ing it (or `eval`-ing it in a
namespace) gives you a live `vega-lite-api` chart object whose `.toObject()`/
`.toSpec()` reproduces the original spec, and whose `.render()`/`.toView()`
render it.

### From the command line

```bash
node bin/cli.js chart.vl.json                # print to stdout
node bin/cli.js chart.vl.json -o chart.js     # write to a file
cat chart.vl.json | node bin/cli.js           # read from stdin
```

## What it supports

`vl2vlapi` covers the full Vega-Lite composition model and the common
per-view properties:

| Vega-Lite feature | vega-lite-api output |
|---|---|
| Single view (`mark` + `encoding`) | `vl.mark(<mark value>).data(...).encode(...)` |
| `layer` | `vl.layer(child1, child2, ...)`, shared properties attached directly to the layer wrapper |
| `facet` operator (`facet`/`spec`) | `child.facet(<facet value>)` |
| `repeat` operator (`repeat`/`spec`) | `child.repeat(<repeat value>)` |
| `concat`, `hconcat`, `vconcat` | `vl.concat(...)`, `vl.hconcat(...)`, `vl.vconcat(...)` |
| Every mark type | `vl.mark("bar")` / `vl.mark({type: "point", filled: true})` — the mark value passed through as-is |
| Every encoding channel, incl. list-valued (`tooltip`, `detail`, `order`) | `vl.x(...)`, `vl.color(...)`, `vl.tooltip([...])`, ... |
| All transform types (`filter`, `calculate`, `aggregate`, `bin`, `timeUnit`, `fold`, `joinaggregate`, `stack`, `impute`, `pivot`, `quantile`, `regression`, `loess`, `sample`, `density`, `window`, `lookup`, `flatten`) | `.transform(<raw transform object>, ...)` |
| `params` / legacy `selection` | `.params(<raw param object>, ...)` |
| `resolve`, `config` | `.resolve(...)`, `.config(...)` — passed straight through |
| `projection` | `.project(...)` (vega-lite-api's own rename of the JSON key) |
| `width`, `height`, `title`, `name`, `description`, and any other property | `.<key>(<value>)` — every top-level property maps to a method of the same name |
| Inline `values` data | hoisted to a named `const` variable |
| Top-level named `datasets` | hoisted once, referenced by every view that uses that name |

Nearly every value — nested `scale`/`axis`/`legend`/`bin`/`sort`/`condition`
objects, whole transform/param definitions, even entire `data` objects — is
passed through as a plain JavaScript object/array literal rather than being
reconstructed via dedicated builder calls. `vega-lite-api`'s generated
methods store whatever they're given and serialize it generically, so this
keeps the generator simple and fully general without a hand-written mapping
for every nested schema type — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for why, and for the couple of
places (`encoding`, `projection`) that do need special handling.

## Known limitations

Nesting a `facet` operator inside another facet's `spec` (facet-of-facet) is
not representable: `vega-lite-api` deliberately doesn't generate a `.facet()`
method on an already-faceted chart (confirmed by tracing its code
generator), mirroring an unreleased Vega-Lite schema feature. This affects 3
of the 633 real-world example specs bundled with Vega-Lite that were used to
validate this project during development (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the validation
methodology). Everything else — 630/633 — round-trips through generated code
that executes and compiles to a valid Vega spec.

## Testing

```bash
npm test
```

runs the unit suite (`node --test test/translator.test.js`).
`test/validate-examples.js` is a standalone harness that runs the translator
over a directory of `*.vl.json` files, execs the generated code, and
compiles the result with the real `vega-lite` compiler, reporting failures
grouped by root cause:

```bash
node test/validate-examples.js /path/to/vega-lite/examples/specs
```

It expects a local checkout of the
[vega-lite](https://github.com/vega/vega-lite) repo's `examples/specs`
directory (used during development, not vendored in this package).

## Project layout

```
src/
    index.js        public API: vegaLiteToVegaLiteApiCode()
    translator.js    recursive spec walker (the core of the project)
    encoding.js      encoding channel -> vl.x/vl.color/... rendering
    calls.js         fluent-chain and call-expression rendering with line wrapping
    literals.js      JSON value -> JavaScript literal source pretty-printer
bin/
    cli.js           command-line entry point
test/
    translator.test.js     node:test unit suite
    validate-examples.js   corpus-validation harness (see above)
docs/
    ARCHITECTURE.md         design notes and internals
```
