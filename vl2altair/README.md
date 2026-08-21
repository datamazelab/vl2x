# vl2altair

Translate a [Vega-Lite](https://vega.github.io/vega-lite/) JSON specification into
runnable [Altair](https://altair-viz.github.io/) Python code.

Give it a spec (as a Python `dict`, e.g. loaded from a `.vl.json` file) and it
returns a standalone Python script string that builds the equivalent chart
with `alt.Chart`, `.mark_*()`, `.encode()`, `.transform_*()`, etc.

```python
import json
from vl2altair import vegalite_to_altair_code

spec = json.load(open("chart.vl.json"))
print(vegalite_to_altair_code(spec))
```

```python
import altair as alt

source = {"values": [{"a": "A", "b": 28}, {"a": "B", "b": 55}]}
chart = alt.Chart(source)
chart = chart.mark_bar()
chart = chart.encode(
    x=alt.X(field="a", type="nominal"),
    y=alt.Y(field="b", type="quantitative"),
)

chart
```

## Install

This is a plain Python package with no required third-party dependencies to
*generate* code. To *run* the generated code you'll need `altair` installed;
if [`black`](https://pypi.org/project/black/) is installed, output is
auto-formatted with it (falls back to a built-in pretty-printer otherwise).

```bash
pip install altair black  # black is optional but recommended
```

Then use `vl2altair` from this repo directly (e.g. add the repo root to
`PYTHONPATH`, or `pip install -e .` once packaged).

## Usage

### As a library

```python
from vl2altair import vegalite_to_altair_code

code = vegalite_to_altair_code(spec)                     # spec: dict
code = vegalite_to_altair_code(spec, chart_var="my_chart") # rename the output variable
code = vegalite_to_altair_code(spec, format_with_black=False) # skip black
```

The returned string is a complete script: it ends with a bare `chart`
expression, so `exec()`-ing it in a namespace binds `ns["chart"]` to a live
Altair chart object, and running it directly (or in a notebook) displays the
chart.

### From the command line

```bash
python -m vl2altair chart.vl.json                # print to stdout
python -m vl2altair chart.vl.json -o chart.py     # write to a file
cat chart.vl.json | python -m vl2altair           # read from stdin
python -m vl2altair chart.vl.json --no-black      # skip black formatting
```

## What it supports

`vl2altair` covers the full Vega-Lite composition model and the common
per-view properties:

| Vega-Lite feature | Altair output |
|---|---|
| Single view (`mark` + `encoding`) | `alt.Chart(data).mark_x().encode(...)` |
| `layer` | shared `data`/`encoding`/`transform` pushed into each child, combined with `alt.layer(...)` |
| `facet` operator (`facet`/`spec`) | `child.facet(row=..., column=...)` / `child.facet(facet=...)` |
| `repeat` operator (`repeat`/`spec`) | `child.repeat(row=..., column=..., layer=...)` |
| `concat`, `hconcat`, `vconcat` | `alt.concat(...)`, `alt.hconcat(...)`, `alt.vconcat(...)` |
| All 17 mark types | `mark_bar`, `mark_point`, `mark_line`, `mark_arc`, `mark_boxplot`, etc. |
| Every encoding channel, incl. list-valued (`tooltip`, `detail`, `order`) | `alt.X`, `alt.Color`, `alt.Tooltip`, ... wrapper classes |
| All 19 transform types (`filter`, `calculate`, `aggregate`, `bin`, `timeUnit`, `fold`, `joinaggregate`, `stack`, `impute`, `pivot`, `quantile`, `regression`, `loess`, `sample`, `density`, `extent`, `window`, `lookup`, `flatten`) | the matching `.transform_*()` method |
| `params` / legacy `selection` | `alt.selection_point`/`alt.selection_interval`/`alt.param` + `.add_params(...)` |
| `resolve` | `.resolve_scale()`, `.resolve_axis()`, `.resolve_legend()` |
| `projection` | `.project(...)` |
| `config` | `.configure(...)` |
| `width`, `height`, `title`, `name`, `description`, and any other leftover top-level property | `.properties(...)` |
| Inline `values` data | hoisted to a named Python variable |
| Top-level named `datasets` | hoisted once, referenced by every view that uses that name |
| `url` / generator (`sequence`, `graticule`, `sphere`) data | hoisted to a variable and passed through as-is |

Deeply nested schema objects that Vega-Lite defines as plain JSON (`scale`,
`axis`, `legend`, `bin`, `sort`, `header`, `condition`, ...) are passed through
as native Python dict/list literals rather than reconstructed as their own
Altair wrapper classes (e.g. `alt.Scale(...)`). Altair accepts plain dicts
anywhere it accepts one of these schema objects, so this keeps the generator
simple and fully general without needing a hand-written mapping for every
nested schema type in Vega-Lite — see [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
for the reasoning.

## Known limitations

A handful of very new/draft Vega-Lite features aren't representable at all
with the currently-released Altair (because Altair's own schema validation
rejects them, not because of anything `vl2altair` does):

- Nesting a `facet` operator inside another facet's `spec` (facet-of-facet).
- Object-form parameterized aggregate ops (e.g. `{"aggregate": {"exponential": 0.5}}`).
- A `"filter"` key on an individual encoding channel definition (conditionally-omitted tooltips).

These affect 5 of the 633 real-world example specs bundled with Vega-Lite
that were used to validate this project during development (see
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the validation methodology).
Everything else — 628/633 — round-trips through generated code that executes
and reproduces the original spec.

## Testing

```bash
python -m pytest ../tests/test_translator.py -v
```

`../tests/validate_examples.py` is a standalone (non-pytest) harness that runs
the translator over a directory of `*.vl.json` files, execs the generated
code, and reports failures grouped by root cause. It expects a local
checkout of the [vega-lite](https://github.com/vega/vega-lite) repo's
`examples/specs` directory (used during development, not vendored in this
repo) — point `SPECS_DIR` in the script at your own checkout to reuse it.

## Project layout

This package's tests and design docs live at the top of the repo (alongside
its JavaScript sibling, [`vl2vlapi/`](../vl2vlapi)) rather than nested under
`vl2altair/`:

```
vl2altair/
    __init__.py     public API: vegalite_to_altair_code()
    translator.py   recursive spec walker (the core of the project)
    encoding.py     encoding channel -> alt.X/alt.Color/... rendering
    transforms.py   transform dict -> .transform_*() method rendering
    params.py       params/selection -> alt.selection_point/alt.param rendering
    calls.py        safe call/kwarg rendering (handles reserved-word keys)
    literals.py     JSON value -> Python literal source pretty-printer
    cli.py          `python -m vl2altair` entry point
tests/
    test_translator.py     pytest suite
    validate_examples.py   corpus-validation harness (see above)
docs/
    ARCHITECTURE.md         design notes and internals
```
