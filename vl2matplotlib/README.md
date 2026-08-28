# vl2matplotlib

Translate a [Vega-Lite](https://vega.github.io/vega-lite/) JSON specification
into standalone Python/[matplotlib](https://matplotlib.org/) source code.

Give it a parsed spec (a Python dict, e.g. from `json.load()`) and it
returns a complete Python script string — data loading, `pandas` transforms,
and the `matplotlib` drawing calls included — that builds the equivalent
chart.

```python
import json
from vl2matplotlib import vegalite_to_matplotlib_code

spec = json.load(open("chart.vl.json"))
print(vegalite_to_matplotlib_code(spec))
```

```python
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np

fig, ax = plt.subplots(figsize=(6.0, 4.0))
chart_data = pd.DataFrame([
    {'a': 'A', 'b': 28}, {'a': 'B', 'b': 55}, {'a': 'C', 'b': 43},
])
__x_cats_chart_data = sorted(chart_data['a'].dropna().unique().tolist(), key=str)
chart_data['__x_pos'] = pd.Categorical(chart_data['a'], categories=__x_cats_chart_data).codes.astype(float)
ax.bar(chart_data['__x_pos'], chart_data['b'], width=0.8, bottom=0, color='#4C78A8', alpha=1.0)
ax.set_xticks(range(len(__x_cats_chart_data)))
ax.set_xticklabels(__x_cats_chart_data)

fig
```

## Why this project is different from its siblings

[`vl2altair`](../vl2altair) and [`vl2vlapi`](../vl2vlapi) translate Vega-Lite
into another library that *already understands Vega-Lite's grammar*, so
those translators are mostly mechanical. [`vl2ggplot`](../vl2ggplot) targets
a *different* grammar-of-graphics with its own vocabulary, but a
grammar-of-graphics all the same — a lot of Vega-Lite's model still maps
onto it fairly directly.

matplotlib has neither: no encoding channels, no automatic scale/legend
inference, no notion of a mark or a facet. `vl2matplotlib` is architecturally
closest to [`vl2d3`](../vl2d3) as a result — it has to build scale
inference, mark drawing, legends, and stacking entirely by hand, the same
reason `vl2d3`'s own scope is deliberately narrower than `vl2altair`'s. The
one thing that's easier here than in D3: **pandas** gives this translator
dplyr-grade `groupby`/`agg` for free, closer to `vl2ggplot`'s situation than
`vl2d3`'s own hand-rolled `d3.rollup()` reductions — so the data-pipeline
half of this translator (implicit per-channel `aggregate`/`bin`/`timeUnit`,
top-level `transform`) is broader than `vl2d3`'s *original* scope, while the
mark/composition/scale half stays just as hand-built. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design decisions that
came out of that.

**Visual style**: matplotlib's own clean defaults, not a pixel-hunt
recreation of Vega-Lite's theme (light gridlines, spines trimmed to
bottom+left, `#4C78A8` — Vega-Lite's own default mark color, already close
to matplotlib's default `C0` blue — as the default mark fill).

## Install

No install step — this package has no dependencies beyond `pandas`,
`numpy`, and `matplotlib` to *generate and run* the code (`black` is an
optional dependency, used only to pretty-print the generated source if
it's installed). Like `vl2altair`, there's no `setup.py`/`pyproject.toml`;
import it via `sys.path`/`PYTHONPATH` from a checkout of this repo.

## Usage

```python
from vl2matplotlib import vegalite_to_matplotlib_code

code = vegalite_to_matplotlib_code(spec)                                  # chart_var defaults to "fig"
code = vegalite_to_matplotlib_code(spec, chart_var="chart")               # rename the output variable
code = vegalite_to_matplotlib_code(spec, ignore_unsupported=True)         # best-effort fallback (see below)
code = vegalite_to_matplotlib_code(spec, include_source_paths=True)       # annotate each statement with its source
code = vegalite_to_matplotlib_code(spec, format_with_black=False)         # skip black formatting even if installed
```

`include_source_paths` (default `False`): precedes each generated statement
(or block of statements) with a `# from: <json path>` comment naming the
part of the input spec it came from (e.g. `# from: mark, encoding.x`,
`# from: layer[0].transform`) — useful for tracing generated code back to
the spec, at the cost of a noisier script.

The returned string is a complete, standalone Python script (not a live
figure object) — imports at the top, then `pandas`-based data-loading/
transform statements, then the `matplotlib` drawing calls, ending in a bare
reference to the figure variable so `exec()`-ing the script both builds
*and*, in the returned namespace, exposes the finished `Figure`:

```python
ns = {}
exec(code, ns)
ns["fig"].savefig("chart.png")
```

There's also a CLI, mirroring `vl2altair`'s own:

```bash
python -m vl2matplotlib spec.vl.json -o chart.py
python -m vl2matplotlib spec.vl.json --ignore-unsupported --include-source-paths
cat spec.vl.json | python -m vl2matplotlib > chart.py
```

## `ignore_unsupported`: best-effort rendering instead of a clean refusal

By default, an unsupported feature raises a clear `ValueError("Unsupported:
...")` — nothing renders, and the message says exactly what wasn't handled.
Passing `ignore_unsupported=True` relaxes that into a best-effort fallback
instead:

- A nested layer-of-layers, or a composition (`facet`/`hconcat`/`vconcat`/
  `concat`/`repeat`) nested inside another composition's own child, is
  skipped (a `# vl2matplotlib: ...` comment in its place) rather than
  aborting the whole chart.
- An unsupported mark type, transform type, aggregate op, or `timeUnit` is
  skipped in place, rather than refusing the whole spec over one step.
- An unsupported `filter` predicate shape keeps every row (a permissive
  no-op) instead of refusing.
- An unresolved named-dataset reference, or a data source with none of
  `values`/`url`/`name`, becomes an empty `pd.DataFrame()` instead of
  refusing.
- A facet's own `row`/`column` (two-way facet grid) form falls back to
  treating the facet as unfaceted (one panel, `facet_def = None`) rather
  than refusing.

This is always an explicit opt-in — the default stays exactly as strict as
without the argument. See `translator.py`'s and each module's own
`ignore_unsupported` branches for the full list of fallbacks.

## What it supports

| Vega-Lite feature | Support |
|---|---|
| Single unit view (`mark` + `encoding`) | ✅ |
| `layer` (shared `Axes`, incl. wrapper-level data/transform inherited by children) | ✅ — including nested layer-of-layers |
| `facet` operator (single field, row *or* column), `encoding.facet`/`.row`/`.column` shorthand | ✅ → a `plt.subplots()` grid, one filtered draw per panel |
| Two-way `facet: {row, column}` grid | ❌ |
| `concat`, `hconcat`, `vconcat` | ✅ → `plt.subplots()`, panel count known at translation time from the spec's own array length |
| `repeat` | ❌ |
| Marks: `bar`, `point`, `circle`, `square`, `line`, `area`, `rule`, `tick`, `text`, `rect`, `boxplot`, `arc`, `errorbar`, `errorband` | ✅ |
| Marks: `trail`, `geoshape`, `image` | ❌ |
| `rect` | ✅ → a heatmap grid (categorical/binned x+y, continuous `color`, one `Rectangle` per row + colorbar), or a reference band spanning the full opposite axis (`axhspan`/`axvspan`) when only one of x/y has a field |
| `boxplot` | ✅ → native `ax.boxplot()`, one box per category; `extent: "min-max"` → `whis=(0, 100)`, the default (1.5×IQR) already matches matplotlib's own default |
| `arc` | ✅ → `ax.pie()` (`theta` size, `color` category, `innerRadius` → donut); a `radius`-encoded field (a polar bar chart, not a pie) is out of scope |
| `errorbar`/`errorband` | ✅ → implicit per-group mean ± extent (`stdev`/`stderr`/`iqr`/`ci`, default `stderr`) computed via `pandas.groupby(...).agg(...)`, matching `vl2ggplot`'s own normal-theory `"ci"` approximation (not a real bootstrap) |
| `x`/`y`/`x2`/`y2` (bar/rect ranges, rule/area baselines) | ✅ — a bar/rect's own thickness along a continuous position axis is data-derived (the bin span, or a proportional heuristic), not a flat default meant only for the ordinal case |
| `xOffset`/`yOffset` (grouped/dodged bar and tick charts) | ✅ → N side-by-side sub-bars/ticks per category, shifted and narrowed at generated-code run time (the group count is only known once the real data loads); mutually exclusive with implicit stacking, matching Vega-Lite's own dodge-not-stack precedence |
| `color`: categorical (one draw call per group + `label=`, `ax.legend()` for free), continuous (`Normalize` + colormap, `scheme` mapped to a matplotlib colormap name, `plt.colorbar()`), and `condition` (a computed per-row color array, e.g. a candlestick's up/down color) | ✅ |
| `size`, `opacity`, `detail` (grouping only), basic `shape` (point marker lookup) | ✅ |
| `order` (line/area point sequencing), `tooltip` (no-op — static image) | ✅ / n/a |
| `x`/`y` scales: linear, temporal, log; ordinal/nominal via integer position + relabeled ticks | ✅ |
| `pow`/`sqrt`/`symlog` custom scales | ❌ |
| Inline `aggregate`/`bin`/`timeUnit` on an encoding channel | ✅ — routed through `pandas.DataFrame.groupby(...).agg(...)`, genuinely N-way (not capped) |
| 2D binning (two channels each with their own `bin`), `bin: "binned"` (pre-binned data) | ✅ `binned` / ❌ 2D |
| Top-level `transform`: `filter`, `calculate`, `aggregate`, `bin`, `timeUnit`, `window`, `joinaggregate`, `fold` | ✅ — `window` via the shared `vl2matplotlib.runtime.vl_window()` helper (see "Shared runtime helpers" below); `joinaggregate` → `groupby(...).transform(...)`; `fold` → `DataFrame.melt()` |
| Top-level `transform`: `pivot`, `lookup`, `stack`, `flatten`, `impute`, `density` | ❌ |
| Aggregate ops: `count`, `sum`, `mean`/`average`, `median`, `min`, `max`, `stdev`/`stdevp`, `variance`/`variancep`, `q1`/`q3`, `ci0`/`ci1`, `distinct`, `valid`, `missing` | ✅ |
| Aggregate ops: `argmin`/`argmax` | ❌ |
| Window ops: `row_number`, `rank`, `dense_rank`, `count`, `sum`, `mean`/`average`, `min`, `max`, `distinct` | ✅ |
| Window ops: `lag`/`lead`/`first_value`/`last_value`/`percent_rank`/`cume_dist`/`ntile`, `median`/`stdev`/`variance`/`q1`/`q3`/`ci0`/`ci1` | ❌ — falls back to the row's own field value unchanged, a documented simplification |
| Implicit per-mark zero-baseline stacking (`bar`/`area` grouped by `color`/`detail`) | ✅ — `normalize`/`center` modes ❌ |
| Vega expression strings (`filter`/`calculate`/a `color.condition`'s own `test`) | ⚠️ best-effort: `datum` → `row[...]`, ternary (incl. nested inside a function call) and `if(cond, a, b)`, `&&`/`\|\|`/`===`/`!==`/`!`, common `Math.*` and bare math functions, `toString`/`isValid`/`length`/`substring`, `== None`/`!= None` → `pd.isna`/`pd.notna` (not a bare `==`, which a `NaN` value fails silently), date-component extraction; anything else (incl. JS's unary `+` string-to-number coercion) passes through as literal text and fails loudly at generated-code run time |
| A `DateTime` literal `datum` (`{"datum": {"year": 2006}}`, e.g. a rule mark's reference line) | ✅ → a real `pd.Timestamp` |
| CSS `rgb(...)`/`rgba(...)` function-syntax color values | ✅ → a matplotlib `(r, g, b[, a])` float tuple |
| A gradient fill (`{gradient: "linear", stops: [...]}`) | ✅ → the gradient's own last stop, as a flat color (matplotlib has no built-in true gradient fill) |
| `params`/`selection` (interactivity) | ❌ a static image has nothing to bind to |
| Nested/dot-path (`"a.b"`) and escaped-literal-dot (`"a\\.b"`) field references, `data.format.property` (a JSON envelope's own record-array path) | ✅ |
| A `type: "quantitative"` field whose raw JSON values are strings (`"0.14"`, not `0.14`) | ✅ → coerced via `pd.to_numeric()`, mirroring the same coercion `temporal` fields already get |
| Data formats: inline `values` (incl. a bare scalar array's implicit `{"data": v}` record wrap), CSV/TSV/JSON via `url` | ✅ |
| Data formats: embedded CSV/TSV text, TopoJSON | ❌ |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the reasoning behind
each of these boundaries.

## Known limitations

Like `vl2d3`/`vl2ggplot` (and unlike `vl2altair`/`vl2vlapi`, which translate
into another library for the *same* grammar and validate near-100%),
`vl2matplotlib` targets a structurally different, hand-built drawing model
with its own gaps, so `tests/validate_examples.py` buckets results three
ways instead of a plain pass/fail:

- **OK** — translated and executed correctly.
- **Skipped** — the spec uses a feature this project has explicitly decided
  not to implement yet (an `"Unsupported: ..."` error). Expected, not a bug.
- **Failed** — anything else. A real bug.

At the time of writing: **472/633 OK, 154/633 skipped (documented
boundaries above), 7/633 failed** against the corpus's real-world example
specs (v1 launched at 368/249/16; v2 added `rect`/`boxplot`/`arc`/
`errorbar`/`errorband` and fixed a bar/tick mark-orientation inference gap
that silently produced invisible zero-height bars; this pass added
`xOffset`/`yOffset` grouped-bar dodging, `color.condition`, nested-field
flattening, `window`/`joinaggregate`/`fold`, and several more "renders, but
the wrong thing" correctness fixes — see "v2: fixing marks that render but
plot nothing" and "v2.1: grouped bars, conditional color, and a shared
runtime module" below). The 7 residual failures are each their own narrow
gap: a `param`/selection-bound literal or expression value used where a
plain scalar is expected (3, incl. one requiring array-indexing into a
bound signal), an embedded-CSV-format data source (1), geographic
(`longitude`/`latitude`) positioning without map projection support (1),
JS's unary `+` string-to-number coercion (1, deliberately not attempted —
see "v2.1" below for why), and a JS string-concatenation `+` operator
mixing a string and a number (1, matplotlib's own `waterfall_chart`
equivalent needs it, `expr.py` doesn't attempt it for the same "too easy to
misfire on an unrelated numeric `+`" reason as the unary case). See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full list.

A second harness, `tests/validate_rendering.py`, additionally executes
every OK spec's generated code and introspects the resulting `Figure`'s own
`Axes` children (`ax.patches`/`ax.lines`/`ax.collections`/`ax.texts`) to
catch a script that "succeeds" but silently draws nothing, or draws only
NaN-valued geometry: **0/472 OK renders are empty or all-NaN**.

## Shared runtime helpers

Most generated code only needs the standard `matplotlib`/`pandas`/`numpy`
imports — but `window` (a transform whose own frame/sort/partition
semantics genuinely don't reduce to a single clean pandas one-liner the way
`joinaggregate`/`fold` do) is implemented once, as a real importable
function, in `runtime.py` (`vl_window()`), the same role `vl2ggplot`'s own
`R/runtime.R` (`vl_pivot()`, `vl_truthy()`) and `vl2d3`'s shared JS runtime
module play for their own translators. A generated script only imports
`from vl2matplotlib.runtime import vl_window` when it actually calls it —
`translator.py`'s own `Emitter` auto-detects a `vl_*(` call in any
statement it adds (the same mechanism that already conditionally imports
`math`) and threads the matching import into the header, so a script that
never needs it never imports it. Unlike `vl2d3`'s equivalent (a plain file
with no install step), this "runtime" is just the `vl2matplotlib` package
itself — a generated script already assumes it's running somewhere
`vl2matplotlib` is importable (that's how its own
`vegalite_to_matplotlib_code()` produced it in the first place), so no
separate distribution mechanism is needed.

## v2: fixing marks that render but plot nothing

v1's own `validate_rendering.py` check (draws *something*, no NaN) doesn't
catch every way a chart can be visually wrong — it doesn't (and can't,
without a `matplotlib.testing`-style pixel comparison) tell "correct" from
"a bar so mis-sized or mis-positioned it's practically invisible." A closer
look at v1's own showcase renders turned up exactly that: bars a fraction
of a pixel wide, sitting off in a corner of an otherwise-empty-looking
plot. Two root causes, both now fixed:

- **Bar/tick mark *orientation* silently defaulted wrong.** Vega-Lite
  infers whether a bar is vertical or horizontal from which of `x`/`y` is
  the continuous channel — but the check only trusted an *explicit*
  `type: "quantitative"` tag, missing the common case where that's implied
  instead (`x: {aggregate: "sum", field: "people"}`, no `type` at all — a
  1D aggregate bar chart). Every such chart silently drew as a
  zero-height *vertical* bar parked at an enormous x position instead of
  the horizontal bar it should be — invisible, not just misoriented. Fixed
  via a shared `effective_type()`/`is_quantitative()` (`scales.py`) that
  also recognizes an `aggregate`/`bin`/`timeUnit`-implied type, used
  everywhere orientation is decided (`marks.py`'s bar/tick/errorbar/
  boxplot renderers) — including re-deriving it *after* `prepare.py`'s own
  aggregate rewrite, which had been silently erasing the very
  `aggregate` key that inference depended on.
- **A bar's own width assumed every position axis is ordinal.** A flat
  `width=0.8` is right for an integer-spaced category axis, but a
  *continuous* position (a binned histogram, or a plain quantitative field
  used as a bar's position) needs a real, data-derived width instead —
  `0.8` next to a 0–4000 axis range is a sliver. Fixed by deriving the
  width from the bin's own span (its `x2`/`y2` companion) when binned, or
  a data-proportional heuristic otherwise — gated on `is_quantitative()`
  specifically (not just "isn't ordinal"), since an untyped *categorical*
  string field used as a bar's position (also common, and not caught by an
  explicit ordinal check) must still get the flat `0.8` default rather than
  attempting numeric arithmetic on string data.

A few smaller correctness fixes came out of the same pass: a continuous
`color` field with no explicit `type` was being misclassified as a
categorical *grouping* field (any `aggregate`/`bin`-implied quantitative
color, e.g. a heatmap's own `color: {aggregate: "mean", field: ...}`, has
this same "no explicit type" shape); `ax.text()` calls (a `text` mark, or a
`rect`'s reference-band form) never participated in matplotlib's own
autoscale/data-limit tracking, so a panel containing *only* text (a column
of category labels next to a bar panel, a common small-multiples idiom)
rendered its labels entirely off-screen against the Axes' untouched
default `[0, 1]` view.

## Testing

```bash
python3 -m pytest tests/test_translator.py
```

runs the unit suite, which translates each hand-written spec, `exec()`s the
generated code, and asserts on the resulting `Figure`/`Axes` state.

`tests/validate_examples.py` and `tests/validate_rendering.py` are
standalone harnesses that run the translator over a directory of
`*.vl.json` files:

```bash
python3 tests/validate_examples.py /path/to/vega-lite/examples/specs /path/to/vega-datasets
python3 tests/validate_rendering.py /path/to/vega-lite/examples/specs /path/to/vega-datasets
```

Both directories are external checkouts used during development, not
vendored in this package. The harness `chdir()`s into the second
(`vega-datasets`) directory so the generated code's relative `data/*.csv`/
`.json` URLs resolve via normal file I/O — it's optional; without it,
`url`-sourced examples fail to load and are counted as failures rather than
excluded.

## Project layout

```
literals.py      JSON value -> Python literal source pretty-printer,
                  plus sanitize_identifier() for derived pandas
                  named-aggregation keyword-argument names
expr.py           best-effort Vega-expression-string -> Python translation
                  (row[...] field references, ternary/if(), &&/||/===/!==,
                  Math.*/bare math functions, toString/isValid/length/
                  substring, null-comparison -> pd.isna()/pd.notna(),
                  date-component functions)
aggops.py          aggregate op -> pandas .agg()/.groupby().agg() expression
timeunit.py         timeUnit -> a cyclic single-component .dt-style
                     expression, or a combined pd.Timestamp(...) expression
data.py              data loading: inline values (incl. the bare-scalar-array
                      -> {"data": v} implicit-record wrap, nested-object ->
                      dotted-column flattening, data.format.property
                      envelope unwrapping) -> pd.DataFrame, url ->
                      pd.read_csv/read_json, temporal/quantitative coercion
scales.py             linear/temporal/log scale inference; ordinal/nominal
                       position -> integer index + relabeled ticks
encoding.py            thin per-channel field/value/datum resolution
                        helpers, incl. a DateTime-literal datum (e.g.
                        {"year": 2006}) -> pd.Timestamp(...)
prepare.py              inline per-channel aggregate/bin/timeUnit ->
                         pandas groupby(...).agg(...) planning
transforms.py            top-level `transform` array -> pandas statements,
                         incl. window (-> runtime.py's vl_window()),
                         joinaggregate (-> groupby(...).transform(...)),
                         fold (-> DataFrame.melt())
stack.py                  implicit per-mark zero-baseline stacking
runtime.py                 shared helpers a spec's generated code calls by
                            name (vl_window()) when a transform's own logic
                            is complex enough that re-deriving it inline
                            every time would be error-prone -- see "Shared
                            runtime helpers" above
marks.py                   per-mark-type Axes-drawing codegen, incl. the
                            shared "one draw call per group + label=" loop
                            color/detail grouping uses, xOffset/yOffset
                            grouped-bar dodging, and color.condition's own
                            per-row color array
translator.py               Emitter (incl. its own conditional
                             `from vl2matplotlib.runtime import ...`
                             detection), recursive spec walker (unit/layer/
                             facet/concat/hconcat/vconcat dispatch), public
                             API (spec_to_code())
cli.py, __main__.py           command-line entry point
tests/
    test_translator.py          unit suite
    validate_examples.py        corpus-validation harness (see above)
    validate_rendering.py       rendering-validation harness (see above)
docs/
    ARCHITECTURE.md              design notes and internals
```
