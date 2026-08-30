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
| `repeat` (`{row, column}`, a plain array, and `{layer: [...]}`) | ✅ → a `plt.subplots()` grid (row/column/plain-array forms) or N shared-`Axes` layers (`layer` form, each a distinct palette color) |
| Marks: `bar`, `point`, `circle`, `square`, `line`, `area`, `rule`, `tick`, `text`, `rect`, `boxplot`, `arc`, `errorbar`, `errorband` | ✅ |
| Marks: `trail`, `geoshape`, `image` | ❌ |
| `rect` | ✅ → a heatmap grid (categorical/binned x+y, continuous `color`, one `Rectangle` per row + colorbar), or a reference band spanning the full opposite axis (`axhspan`/`axvspan`) when only one of x/y has a field |
| `boxplot` | ✅ → native `ax.boxplot()`, one box per category; `extent: "min-max"` → `whis=(0, 100)`, the default (1.5×IQR) already matches matplotlib's own default |
| `arc` | ✅ → `ax.pie()` (`theta` size, `color` category, `innerRadius` → donut); a `radius`-encoded field (a polar bar chart, not a pie) is out of scope |
| `errorbar`/`errorband` | ✅ → implicit per-group mean ± extent (`stdev`/`stderr`/`iqr`/`ci`, default `stderr`) computed via `pandas.groupby(...).agg(...)`, matching `vl2ggplot`'s own normal-theory `"ci"` approximation (not a real bootstrap) |
| `x`/`y`/`x2`/`y2` (bar/rect ranges, rule/area baselines) | ✅ — a bar/rect's own thickness along a continuous position axis is data-derived (the bin span, or a proportional heuristic), not a flat default meant only for the ordinal case |
| `xOffset`/`yOffset` (grouped/dodged bar and tick charts) | ✅ → N side-by-side sub-bars/ticks per category, shifted and narrowed at generated-code run time (the group count is only known once the real data loads) over an ordinal *or* temporal category axis (a `pd.Timedelta`-valued shift/width for the latter); mutually exclusive with implicit stacking, matching Vega-Lite's own dodge-not-stack precedence |
| `color`: categorical (one draw call per group + `label=`, `ax.legend()` for free), continuous (`Normalize` + colormap, `scheme` mapped to a matplotlib colormap name, `plt.colorbar()`), and `condition` (a computed per-row color array, e.g. a candlestick's up/down color) | ✅ |
| `size`, `opacity`, `detail` (grouping only), basic `shape` (point marker lookup) | ✅ |
| `order` (line/area point sequencing), `tooltip` (no-op — static image) | ✅ / n/a |
| `x`/`y` scales: linear, temporal, log; ordinal/nominal via integer position + relabeled ticks | ✅ |
| `pow`/`sqrt`/`symlog` custom scales | ❌ |
| Inline `aggregate`/`bin`/`timeUnit` on an encoding channel | ✅ — routed through `pandas.DataFrame.groupby(...).agg(...)`, genuinely N-way (not capped) |
| 2D binning (two channels each with their own `bin`), `bin: "binned"` (pre-binned data) | ✅ `binned` / ❌ 2D |
| `timeUnit`: `"binned" + <combined unit>` (e.g. `binnedyearmonth`), `"utc" + <unit>` (an already-pre-binned or UTC-flagged field) | ✅ → the `binned`/`utc` prefix is stripped and the base unit's own expression used (no separate timezone handling) |
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
| `params`/`selection` interactivity (actually reacting to a click/brush/slider at view time) | ❌ a static image has nothing to bind to |
| A top-level bound `param`'s own default `value`, and a mark property/`encoding.<channel>.datum` given as `{"expr": "..."}` (a slider-bound constant, not live interactivity) | ✅ — resolved once to a real Python literal at translate time; a name in the expression that isn't a known param (almost always a live selection reference, e.g. `sel.field`) resolves like JS's own falsy `undefined`, so a `... \|\| fallback` idiom still resolves to a sane constant |
| A bracket-indexed field (`"field": "ranges[2]"`, one element of a row's own array-valued column) | ✅ — materialized as a real column of that exact name right after data load |
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

At the time of writing: **525/633 OK, 105/633 skipped (documented
boundaries above), 3/633 failed** against the corpus's real-world example
specs (v1 launched at 368/249/16; v2 reached 439/177/17 — new marks, and
fixing marks that silently rendered nothing; v2.1 reached 472/154/17 —
grouped bars, conditional color, nested fields, a shared runtime module;
v2.2 reached 496/129/8, headlined by a working `repeat` operator — see
"v2.2: `repeat`, and closing out the mark-orientation/ambiguous-type bug
class" below; v2.3 reached 504/121/8 — see "v2.3: normalized/centered
stacking, value-based color mapping, and N-way binning" below; v2.4
reached 512/113/8 — see "v2.4: two new transforms, per-panel/child color
sharing, and hconcat/vconcat sizing" below; v2.5 reached 515/110/8 — see
"v2.5: text color, size/log scales, a new `trail` mark, and two more
transforms" below; v2.6 reached 522/105/6 — see "v2.6: window semantics,
orientation, dodge+stack, and disabled color scales" below, which also
fixed two of v2.5's own residual failures outright, the JS-`+` ones; this
pass reached 525/105/3 — see "v2.7: bound `params`, static `{"expr": ...}`
resolution, and bracket-indexed fields" below, which fixed the 3
`param`/selection failures outright). The residual failures are each their
own narrow gap: an embedded-CSV-format data source (1), a
`geoshape`-with-projection map (1, distinct from the plain-scatter
`longitude`/`latitude` fallback added in v2.3 — see below), and a field
name that is itself a SQL-expression-shaped string (1). See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full list, and for
the showcase's own best-effort (`ignore_unsupported=True`) build — a wider
sample than this strict-mode corpus check, since it also exercises every
fallback path — **598/633** render without error.

A second harness, `tests/validate_rendering.py`, additionally executes
every OK spec's generated code and introspects the resulting `Figure`'s own
`Axes` children (`ax.patches`/`ax.lines`/`ax.collections`/`ax.texts`) to
catch a script that "succeeds" but silently draws nothing, or draws only
NaN-valued geometry: **0/525 OK renders are empty or all-NaN**.

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

A follow-up pass (v2.1) added `xOffset`/`yOffset` grouped-bar dodging,
`color.condition` (a candlestick chart's own up/down color), nested/
escaped-dot field flattening, and `window`/`joinaggregate`/`fold`; the most
recent pass (v2.2) implemented a real `repeat` operator (previously a
crash-prone "render the template once, unsubstituted" fallback), closed
out the "ambiguous-type field" bug class for two more call sites
(`ax.text()`'s own position, and `xOffset`'s dodge-shift arithmetic on a
*temporal* axis), and normalized `timeUnit`'s own `binned`/`utc` prefixes
down to their base unit. See `docs/ARCHITECTURE.md`'s own "v2.1"/"v2.2"
sections for the full list.

## v2.3: normalized/centered stacking, value-based color mapping, and N-way binning

A round of visual-QA-driven fixes — each one found by rendering the
showcase's own PNGs and looking at them, not by an automated check, since
every one of these bugs produced code that ran without error but drew the
*wrong picture*:

- **`stack: "normalize"`/`"center"` were silently treated as plain
  zero-baseline stacking.** `stack.py` previously implemented only the
  zero-baseline `cumsum()` case; a `"normalize"` chart (each category's
  stack rescaled to sum to 1.0) or `"center"` chart (a streamgraph
  straddling zero) rendered as an ordinary un-normalized stack instead.
  Both new modes are now real: `normalize` divides each value by its own
  category's `groupby(...).transform('sum')` before cumulative-summing;
  `center` cumulative-sums and then shifts by half the category's total.
- **Categorical colors ignored `color.scale.range`/`.scheme`/`.domain`
  entirely.** Every color-grouping call site (bar/tick dodge, boxplot,
  `arc`/pie, the generic groupby-and-draw loop) was hardcoded to
  `tab10`, regardless of what the spec asked for. `_categorical_color_lookup()`
  now honors an explicit `range` list, a named `scheme` (mapped to the
  closest matplotlib qualitative colormap — `category10`→`tab10`,
  `category20`→`tab20`, `set1`/`set2`/`set3`, `accent`, `dark2`, `paired`,
  `pastel1`/`pastel2`, `tableau10`/`tableau20`), and — when a spec gives
  *both* `scale.domain` and `scale.range` — builds a `domain[i]→range[i]`
  **value** mapping rather than an index-ordered palette. That distinction
  matters whenever an `order` channel reorders draw sequence independent of
  a category's fixed domain position; `arc`'s own `order: {field: ...}` is
  now honored (a `sort_values()` before drawing) for exactly this reason.
- **Only one bin channel was ever supported.** `_prepare_binned()` hard-capped
  at a single bin channel and silently dropped/truncated a second — a chart
  binning *both* `x` and `y` (a 2D histogram) got real binning on one axis
  and raw, ungrouped values on the other. Generalized to loop over all bin
  channels, each with its own uniquely-named `__edges_<field>` variable,
  grouped by the union of every channel's bin-start/bin-end columns.
- **`bin: {"binned": true, "step": N}` (the object-form spelling of
  "already binned") wasn't recognized** — only the bare string `"binned"`
  was — so already-binned data got re-binned with `np.histogram_bin_edges`'
  default bucket count, producing entirely wrong intervals. `_is_pre_binned()`
  now recognizes both spellings.
- **`longitude`/`latitude` encoding channels weren't recognized as position
  channels at all** (only `x`/`y` were), so every row fell through to the
  "no field given" literal-`0` fallback — every point landed on the same
  `(0, 0)` spot, visually a single dot. A translate-time spec rewrite
  (`_fallback_geo_position()`) now renames `longitude`→`x`/`latitude`→`y`
  in place whenever `x`/`y` aren't already given, matching `vl2ggplot`'s own
  documented "plot as a plain unprojected x/y scatter" fallback for the
  identical gap. (A `geoshape` mark *with* an actual map projection is a
  separate, still-unsupported gap — see `geo_circle` above.)
- **A legend with many categories could cover the entire plot.** A plain
  `ax.legend(title=...)` with no location lets matplotlib choose a
  "best fit" spot *inside* the Axes; for a legend with a dozen-plus entries
  on a small figure, that box can end up sitting directly on top of the
  data it's supposed to label (found on `stacked_area_normalize`, a
  14-category chart whose underlying stacking math was already correct —
  the chart just looked blank because its own legend filled the panel). A
  shared `_legend_stmt()` helper now places every generated legend outside
  the Axes (`bbox_to_anchor=(1.02, 1), loc='upper left'`).

## v2.4: two new transforms, per-panel/child color sharing, and hconcat/vconcat sizing

Another visual-QA-driven round, prompted by a second list of eight
specific showcase examples still rendering wrong:

- **A bar mark with only its category channel encoded** (no `x`/`x2` at
  all) now fills the whole plot along the missing axis, instead of
  drawing a zero-length invisible bar.
- **An ordinal field's own categories always sorted lexicographically**,
  even when numeric (`1, 10, 11, 12, 2, ...` instead of calendar/numeric
  order) — a shared `ORDINAL_SORT_KEY` fixes this everywhere a category
  list gets sorted.
- **Two new transforms**: `density` (a real Gaussian-kernel KDE, via a new
  `vl_density()` runtime helper) and `pivot` (`fold`'s inverse, via a new
  `vl_pivot()` helper) — both previously unimplemented, "Unsupported
  transform type" gaps. A related fix: `data.py`'s own coercion
  statements now guard on the column actually existing yet, so a field
  read before the transform that creates it has run is a no-op instead of
  a `KeyError` (matters most for `pivot`, whose own output column names
  are runtime-only, unknowable at translation time).
- **A new `data: {sequence: {...}}` generator** (a synthetic numeric
  range) and Vega's *bare* (non-`Math.`-prefixed) trig functions
  (`sin`/`cos`/`tan`/...) in `calculate`/`filter` expressions, neither
  previously recognized at all.
- **Categorical color assignment indexed a palette by local draw order,
  not the field's real domain** — silently wrong the moment a facet panel
  or concat/hconcat/vconcat child only ever sees a filtered *subset* of
  the field's true values (every panel's own single category landing on
  the same first palette color). Fixed for facet panels via a shared
  runtime domain; fixed for concat/hconcat/vconcat siblings that each
  filter on a literal value of the shared field via a real, static domain
  built at translation time.
- **`repeat`'s plain-array form ignored its own top-level `columns`**,
  always laying every value out in one row regardless.
- **A *continuous* `color` field on `point`/`circle`/`square`** was
  silently ignored (always the flat default color) — now uses
  `scatter()`'s native `c=`/`cmap=`/`norm=` kwargs, mirroring `rect`'s
  existing continuous-color support.
- **`color.legend: null` was never honored anywhere** — every categorical
  legend and continuous colorbar now respects it.
- **`concat`/`hconcat`/`vconcat` children ignored their own explicit
  `width`/`height`**, always sharing one uniform panel size — now uses
  `gridspec_kw`'s `width_ratios`/`height_ratios` for a plain row/column.
- **A continuous value-axis `sort: "descending"`** now inverts that axis
  (`ax.invert_xaxis()`/`invert_yaxis()`), needed for mirrored charts like
  population pyramids; also fixed a bar mark's own value-axis `title`
  never rendering at all.

## v2.5: text color, size/log scales, a new `trail` mark, and two more transforms

A third visual-QA-driven round, prompted by a third list of six specific
showcase examples:

- **A `text` mark's own `color` field was dropped entirely**, always
  drawing in matplotlib's own default black — fixed via the same
  `_domain_expr` value-map convention v2.4's own facet/concat color
  sharing introduced.
- **A `size`-encoded point/circle/square marker used the raw field value
  directly as matplotlib's own marker *area*** — harmless for a field
  already in a plausible pixel range, but a raw population-in-the-tens-
  of-millions field rendered as one solid black rectangle covering the
  whole plot. Rescaled into a fixed, reasonable area range via a
  square-root interpolation (area grows linearly with the data value, the
  standard bubble-chart convention). Separately, `scale: {type: "log"}`
  had been recognized internally since this module's own introduction but
  never actually applied (`ax.set_xscale`/`set_yscale` was never called)
  — both fixed together, since the same spec needed both.
- **`mark: {type: "line", point: true}` never drew the point overlay** —
  `mark_props` already captured it, just never consulted; now adds
  `marker='o'` to the line's own `ax.plot()` call.
- **The `trail` mark (a line whose own *width* varies with a `size`
  field) was entirely unimplemented** — a documented v1 scope gap.
  Implemented via `matplotlib.collections.LineCollection` (one segment
  per consecutive point pair, each with its own linewidth), conditionally
  imported like `math`/the runtime module.
- **Two more transforms**: `quantile` (empirical quantiles, sampled at
  evenly-spaced probabilities — a Q-Q plot's own data source) and Vega's
  `quantileUniform`/`quantileNormal` expression functions (the inverse
  CDF of a Uniform/Normal distribution, routed through the standard
  library's `statistics.NormalDist`, no new dependency).
- **`fold` dropped the fields it folded**, unlike real Vega-Lite (which
  keeps every original field on each output row, folded ones included) —
  invisible until a later transform read one of those fields back by
  name. Confirmed against both `vl2d3`'s and `vl2ggplot`'s own (correct)
  fold semantics and fixed to match. A related fix: `vl_pivot()`'s own
  output columns now always coerce their names to `str()`, matching how a
  later transform would refer to them regardless of the pivot field's own
  dtype.
- **`toNumber(...)`**, Vega's own explicit (and unambiguous, unlike a bare
  unary `+`) string-to-number coercion, now maps to Python's `float`.

The sixth reported example, `parallel_coordinate.vl.json`, was
investigated but not fixed: its own layered "manually construct axes"
technique mixes a data-driven `[0, 1]`-normalized position channel with
sibling layers positioned via a literal *pixel*-space value, which only
align in real Vega-Lite's own renderer. Reconciling the two coordinate
spaces across independently-rendered sibling layers sharing one `Axes`
would need new, layer-composition-level machinery — left as a known,
narrower gap rather than a risky general heuristic. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)'s own "v2.5" section for
the full diagnosis.

## v2.6: window semantics, orientation, dodge+stack, and disabled color scales

A fourth visual-QA-driven round, prompted by a fourth list of specific
showcase examples:

- **JS string-concatenation `+` and unary `+`** are now translated for
  their two *unambiguous* sub-cases (a binary `+` where one side is
  provably a string; a unary `+` in an unambiguous unary syntactic
  position) — previously left untouched entirely, since a bare `+` is
  genuinely ambiguous in the fully general case.
- **A `window` transform with no `frame` given used the whole partition**,
  not a running/cumulative total — Vega-Lite's real default is `[null,
  0]` (cumulative); fixed, along with `lag`/`lead` (previously a no-op)
  and `rank`/`dense_rank` now breaking ties using the *full* `sort` order
  instead of just the first field.
- **The top-level `stack` transform** (an explicit version of this
  project's own implicit per-mark stacking) was entirely unimplemented —
  added via a new `vl_stack()` runtime helper. Exposed a real,
  general bug along the way: an aggregate/joinaggregate's own sanitized
  `as` name (needed only for pandas' keyword-arg syntax) was never
  renamed back to the spec's own literal name afterward, so a later
  transform referencing it by that name couldn't find it.
- **A layer child's own explicit `data` still inherited the wrapper's
  top-level `transform`**, crashing when that transform referenced a
  field the child's different dataset doesn't have — now only merged
  into a child that also inherits the wrapper's data.
- **A `rect` span's own numeric field was forced ordinal even with a real
  `x2`/`y2` companion**, turning a start/end timeline into one absurdly
  wide rectangle per row; and **a categorical `color` on that same
  single-axis span shape was never wired up at all**, always drawing the
  flat default color — both fixed.
- **`mark: {invalid: null}` silently shrank the visible domain-axis
  range** when the *other* channel's null values excluded a row from
  matplotlib's own internal bounding-box computation — fixed by
  explicitly extending the domain axis to the field's own full range.
- **An area/line mark's own orientation was always assumed vertical** —
  wrong when x is the quantitative value channel and y is the domain one
  instead, affecting both draw-order sorting and (for `area`)
  `fill_betweenx()` vs `fill_between()`.
- **A grouped (`xOffset`) bar's own `color`, when it named a different
  field than the dodge channel, was silently dropped** — now stacks
  within each dodge slot by that color field, matching Vega-Lite's real
  "grouped and stacked at once" behavior.
- **A *continuous* `color` field on a `bar` mark was dropped entirely** —
  `bar` never had a continuous-color branch the way `rect`/`point` do;
  fixed, along with a related bug where `plan_stacking()` treated a
  continuous color/opacity field as a categorical grouping field.
- **`color.scale: null`** (Vega-Lite's "disable scale" convention — the
  field's own raw values are literal colors already) was indistinguishable
  from `scale` being absent, both defaulting to the categorical palette —
  now returns the raw value directly.
- **The `shape` encoding channel was entirely unimplemented** — every
  point drew as the default circle regardless of the spec. A fixed value
  now picks one marker for every point; a field grouping by the same
  field `color` already does now assigns a different marker per category
  too (an independently-grouping `shape` field isn't attempted — a
  documented, narrower gap).

`parallel_coordinate.vl.json` (reported alongside these) remains
unfixed — see v2.5's own entry above for the diagnosis, unchanged this
round.

## v2.7: bound `params`, static `{"expr": ...}` resolution, and bracket-indexed fields

Top-level `params` and any value bound via `{"expr": "..."}` were entirely
unhandled before this round — a slider-bound param's own default `value`
was never read at all, and a mark-level property or `encoding.<channel>.
datum` given as `{"expr": "..."}` was spliced straight through as a raw
Python `dict` literal wherever matplotlib expected a plain scalar,
crashing the moment it was actually used (`bar_bullet_expr_bind.vl.json`,
`param_expr.vl.json`, `rule_params.vl.json` — all three of v2.6's own
residual `param`/selection failures).

- **`_resolve_top_level_params()`** (`translator.py`) resolves every
  top-level `params` array entry into a real Python value up front — a
  bound `value` directly, or an `expr`-only entry (e.g. `bar_bullet_
  expr_bind.vl.json`'s own `"innerBarSize": {"expr": "height/2"}`,
  derived from an earlier param) via the new static evaluator below,
  resolved strictly in the array's own declaration order so a later param
  can reference an earlier one. A live *selection* param (`"select":
  {...}`, no static default) is deliberately left unresolved rather than
  guessed at.
- **`resolve_static_expr()`** (`expr.py`) evaluates a Vega expression
  string to a concrete Python value once, reusing the existing
  JS-to-Python `translate_expr()` rewriter but evaluating the result
  through a custom namespace (`_JSUndefined`/`_ExprEnv`) where any name
  that ISN'T a known, resolved param — almost always a live selection
  reference, e.g. `param_expr.vl.json`'s own `sel.Miles_per_Gallon * 10
  || 75` — behaves like JS's own `undefined` (every arithmetic op and
  attribute access propagates it, and it's falsy), so a real Vega
  expression's own `... || fallback` idiom resolves to the fallback
  exactly the way a live Vega-Lite render does with nothing selected,
  rather than raising `NameError`/`TypeError`.
- **`_resolve_param_expr_shapes()`** (`translator.py`) walks the whole spec
  tree once (mirroring `_unescape_field_refs()`'s identical traversal) and
  replaces any dict shaped as exactly `{"expr": S}` — wherever it appears,
  a mark-level property or an encoding channel's own `datum` alike — with
  its own resolved literal value in place, so every existing renderer
  downstream sees a plain scalar exactly the way it already handles a
  literal `value`, no renderer-side changes needed at all for most of
  them. One renderer-side fix was still needed: `_render_point()` only
  ever read `encoding.size`, never a mark-level `mark.size` — silently
  falling back to matplotlib's own default marker size (36) regardless of
  what a resolved `{"expr": ...}` size property actually said. Fixed
  alongside (matching how `_opacity_value()` already read `mark_props`
  correctly).
- **Bracket-indexed field access** (`"field": "ranges[2]"`, Vega-Lite's
  own bullet-chart idiom for reading one specific element of a row's own
  array-valued column — distinct from a nested-object dotted path, and
  from an `aggregate` transform's own bracket-indexed row lookup) had no
  real pandas column of that literal name to find, raising a bare
  `KeyError`. `_collect_bracket_index_fields()`/
  `render_bracket_field_materialization()` (`translator.py`) pre-compute a
  real column of that exact name (via `.apply(lambda v: v[i])`) right
  after data load, so every existing `field`-reading code path downstream
  works unchanged.

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
