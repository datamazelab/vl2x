# vl2ggplot

Translate a [Vega-Lite](https://vega.github.io/vega-lite/) JSON specification into
standalone [ggplot2](https://ggplot2.tidyverse.org/) R code.

Give it a parsed spec (an R list, e.g. from `jsonlite::fromJSON(..., simplifyVector = FALSE)`)
and it returns a complete R script string — data loading, `dplyr` transforms,
and the `ggplot()` call included — that builds the equivalent chart.

```r
library(vl2ggplot)

spec <- jsonlite::fromJSON("chart.vl.json", simplifyVector = FALSE)
cat(vegalite_to_ggplot(spec))
```

```r
library(ggplot2)

chart_data <- data.frame(
  a = c("A", "B", "C"),
  b = c(28, 55, 43),
  stringsAsFactors = FALSE,
  check.names = FALSE
)
chart <- ggplot2::ggplot(chart_data)
chart <- chart + ggplot2::geom_col(mapping = ggplot2::aes(x = factor(a), y = b))

chart
```

## Why this project is different from its siblings

[`vl2altair`](../vl2altair) and [`vl2vlapi`](../vl2vlapi) translate Vega-Lite
into another library that *already understands Vega-Lite's grammar* (both
compile down to a real Vega-Lite spec), so those translators are mostly
mechanical. [`vl2d3`](../vl2d3) targets a toolkit with no grammar-of-graphics
layer at all, so it has to implement scale inference, mark drawing, and data
aggregation entirely by hand — its scope is deliberately narrow as a result.

`vl2ggplot` sits in between: ggplot2 *is* a grammar-of-graphics
implementation in its own right (arguably the one Vega-Lite's own design was
inspired by), so a lot of Vega-Lite's model maps directly onto it —
`stat_count`/`stat_summary`/`stat_summary_bin`/`geom_histogram` cover most of
Vega-Lite's inline `aggregate`/`bin` encoding shorthand natively, and
`facet_wrap`/`facet_grid` map directly onto the `facet` operator. But it's a
*different* grammar-of-graphics, with its own vocabulary, defaults, and
gaps (no first-class error-bar-from-raw-data support the way Vega-Lite's
mark-level `extent` has, no notion of Vega-Lite's inline aggregate shorthand,
R's own atomic-vector-vs-list distinction with no JS/Python equivalent), so
this is real translation work, not a pure calling-convention mapping. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design decisions that
came out of that, and the validation methodology below for how its
real-world coverage compares to its siblings.

## Install

This package has no required dependencies to *generate* code beyond
`jsonlite` (only used by callers to parse a spec into the plain-list form
`vegalite_to_ggplot()` expects). To *run* the generated code you need
`ggplot2`, `dplyr`, and `patchwork` installed (`scales` too, for a handful of
scale helpers) — the versions this package was developed against are listed
in `DESCRIPTION`'s `Suggests:` field, used by the test suite.

```r
# from this directory
install.packages(c("jsonlite", "ggplot2", "dplyr", "patchwork", "scales", "testthat"))
```

There's no CRAN/package-repository install yet — install the package itself
from a local checkout:

```bash
R CMD INSTALL .
```

## Usage

```r
library(vl2ggplot)

spec <- jsonlite::fromJSON("chart.vl.json", simplifyVector = FALSE)
code <- vegalite_to_ggplot(spec)                    # variable name defaults to "chart"
code <- vegalite_to_ggplot(spec, chart_var = "plot") # rename the output variable
```

The returned string is a complete, standalone R script (not a live plot
object) — `library(ggplot2)` at the top, then data-loading/`dplyr`
statements, then the `ggplot()` + layer calls, ending in a bare reference to
the chart variable so `source()`-ing the script (or `eval(parse(text =
code))`) both builds *and* prints/returns the plot:

```r
eval(parse(text = code))                 # builds and prints the chart
plot_obj <- eval(parse(text = code))     # capture the ggplot object itself
```

`jsonlite::fromJSON(..., simplifyVector = FALSE)` is required (not the
default `simplifyVector = TRUE`) — the translator expects Vega-Lite objects
as plain named R lists and arrays as plain R lists, matching JSON's own
structure one-to-one; jsonlite's default auto-simplification into data
frames/vectors would change that shape under it.

There's no command-line entry point (unlike `vl2d3`/`vl2vlapi`'s
`bin/cli.js`) — call `vegalite_to_ggplot()` directly from R.

## What it supports

| Vega-Lite feature | Support |
|---|---|
| Single unit view (`mark` + `encoding`) | ✅ |
| `layer` (incl. shared wrapper-level encoding/data/transform inherited by children) | ✅ — nested layer-of-layers ❌ |
| `facet` operator, encoding-level `facet`/`row`/`column` | ✅ → `facet_wrap()`/`facet_grid()` |
| `repeat` operator | ✅ (field substitution into each repeated view) |
| `concat`, `hconcat`, `vconcat` | ✅ → `patchwork::wrap_plots()` |
| Marks: `bar`, `point`, `circle`, `square`, `line`, `area`, `rule`, `tick`, `text`, `arc`, `boxplot`, `errorbar`, `errorband`, `trail` | ✅ |
| Marks: `geoshape`, `image` | ❌ |
| 1D strip/dot/bar plots (only one of x/y given) | ✅ — constant `""`/fixed-param fallback |
| Inline `aggregate`/`bin`/`timeUnit` on an encoding channel | ✅ — routed through native `stat_count`/`stat_summary`/`stat_summary_bin`/`geom_histogram` where possible, explicit `dplyr::group_by()`+`summarise()` otherwise (0–2 groupby fields) |
| Mark-level `extent` / `xError`/`yError`/`xError2`/`yError2` channels (error bars/bands) | ✅ — arithmetic bounds from Error channels, or an implicit mean±stderr/stdev/ci/iqr `dplyr` summary when no explicit channel is given |
| Top-level `transform`: `filter`, `calculate`, `aggregate`, `bin`, `timeUnit` | ✅ |
| Top-level `transform`: `window`, `joinaggregate`, `lookup`, `impute`, `pivot`, `fold`, `flatten`, `quantile`, `regression`, `loess`, `density`, `sample`, `stack`, `sort`, `extent` | ❌ |
| `x`/`y` scales: linear, date, discrete (with `sort`/`reverse`), log/pow/sqrt (via ggplot2's `trans`) | ✅ |
| `color`/`size`/`opacity` scales: explicit `range`, `domain`, viridis/ColorBrewer `scheme` | ✅ — `quantile`/`quantize`/`threshold` (discretizing) scale types ❌ |
| `xOffset`/`yOffset` (dodged/grouped position) | ❌ no `position = "dodge"` equivalent generated |
| Geographic encoding (`longitude`/`latitude`) or `projection`-driven marks | ❌ no map projection support |
| `params`/`selection` (interactivity) | ❌ a static plot has nothing to bind to; a `condition`'s default branch is not specially handled either |
| Vega expression strings (`filter`/`calculate`) | ⚠️ best-effort: `datum` → bare column reference, ternary and `if(cond, a, b)` → `ifelse()`, string concatenation (`+`) → `paste0()`, `%` → `%%`, common `Math.*` functions, date-component extraction; anything else passes through as literal text and fails loudly at generated-code run time |
| Nested/dot-path (`"a.b"`) and bracket-indexed (`"a[0]"`) field references | ❌ clear "Unsupported" error rather than silently referencing the wrong column |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the reasoning behind
each of these boundaries, and how the aggregate/error-extent planning works.

## Known limitations

Like `vl2d3` (and unlike `vl2altair`/`vl2vlapi`, which translate into
another library for the *same* grammar and validate near-100%), `vl2ggplot`
targets a structurally different grammar-of-graphics with its own gaps, so
`tests/validate_examples.R` buckets results three ways instead of a plain
pass/fail:

- **OK** — translated and executed correctly.
- **Skipped** — the spec uses a feature this project has explicitly decided
  not to implement yet (an `"Unsupported: ..."` error). Expected, not a bug.
- **Failed** — anything else. A real bug.

At the time of writing: **410/633 OK, 219/633 skipped (documented boundaries
above), 4/633 failed** against the corpus's real-world example specs (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full methodology and
what those 4 residual failures combine).

Two design choices worth calling out explicitly:

- **No auto-stacking, no dodging.** Like `vl2d3`, `vl2ggplot` does not
  implement Vega-Lite's automatic bar/area stacking or `xOffset`/`yOffset`
  dodged grouping — ggplot2 has its own `position` system for this
  (`position_stack()`/`position_dodge()`), but mapping Vega-Lite's stacking
  rules onto it correctly is a project-sized feature on its own.
- **`extent`/error-channel handling is a documented simplification.**
  Vega-Lite's default confidence-interval extent uses a bootstrap; this
  project's `ci` extent uses a normal-theory approximation
  (`mean ± 1.96 * sd/sqrt(n)`) instead, since a real bootstrap has no simple
  one-line `dplyr` equivalent. Numerically close for reasonably-sized
  samples, not identical.

## Testing

```r
testthat::test_dir("tests/testthat", package = "vl2ggplot")
```

runs the unit suite (`tests/testthat/test-translator.R`), which translates
each spec, evaluates the generated code, and asserts on the resulting
`ggplot_build()` data (row counts, generated-code shape, error cases).

`tests/validate_examples.R` is a standalone harness that runs the translator
over a directory of `*.vl.json` files, evaluates the generated code, and
reports OK/Skipped/Failed counts grouped by reason:

```bash
Rscript tests/validate_examples.R /path/to/vega-lite/examples/specs /path/to/vega-datasets
```

Both directories are external checkouts used during development, not
vendored in this package. The harness `setwd()`s into the second
(`vega-datasets`) directory so the generated code's relative `data/*.csv`/
`.json` URLs resolve via normal R file I/O — it's optional; without it,
`url`-sourced examples fail to load and are counted as failures rather than
excluded.

## Project layout

```
R/
    literals.R      JSON value -> R literal source pretty-printer
                     (atomic c(...) vs. list(...), name/string quoting)
    timeunit.R       timeUnit name -> Date/POSIXct-truncation expression mapping
    aggops.R         aggregate op -> dplyr::summarise()/stat_summary(fun=)
                      expression mapping
    expr.R           best-effort Vega-expression-string -> R translation
                      (field references, ternary/if(), string concat, modulo,
                      date-component functions)
    data.R           data-loading code (inline values incl. embedded CSV/TSV
                      text, url fetch, temporal-field Date coercion)
    encoding.R       encoding channel -> ggplot2 aes()/fixed-param rendering
    geoms.R          mark type -> geom_*() call, incl. rule/error-bar/
                      error-band geometry dispatch
    scales.R         encoding scale properties -> scale_*() calls
    facet.R          facet operator/channels -> facet_wrap()/facet_grid()
    transforms.R     top-level `transform` array -> dplyr pipeline statements;
                      inline aggregate/bin/timeUnit -> native ggplot2 stat vs.
                      explicit dplyr::group_by()+summarise() planning; error-
                      extent (mean +/- stdev/stderr/ci/iqr) computation
    translator.R     recursive spec walker: layer/facet/repeat/concat
                      dispatch, layer-encoding inheritance, public API
                      (vegalite_to_ggplot())
tests/
    testthat.R                  testthat runner entry point
    testthat/test-translator.R  unit suite
    validate_examples.R         corpus-validation harness (see above)
docs/
    ARCHITECTURE.md              design notes and internals
```
