# Architecture and design notes

This document explains *how* `vl2altair` translates a Vega-Lite spec into
Altair code, and the reasoning behind a few choices that aren't obvious from
reading the modules in isolation. For usage, see [`../vl2altair/README.md`](../vl2altair/README.md).

## Pipeline

`vegalite_to_altair_code(spec)` (in `translator.py`) does, in order:

1. Strip `$schema`.
2. Hoist any top-level `datasets` mapping into Python variables (`_hoist_datasets`),
   recording `name -> variable` in `Emitter.dataset_vars`.
3. Call `translate_spec(spec, emitter, "chart")`, which recursively dispatches
   on the spec's shape (see below) and returns the name of the Python variable
   holding the resulting chart.
4. Join `emitter.lines` (one statement per operation) with an `import altair
   as alt` header and a trailing bare `chart` expression, then optionally run
   it through `black`.

The generator deliberately emits **one statement per chart-building
operation** (`chart = chart.mark_bar()`, then `chart = chart.encode(...)`,
then `chart = chart.transform_filter(...)`, ...) rather than one long chained
expression. This trades a small amount of terseness for code that's trivial
to generate correctly (no line-wrapping logic across an arbitrarily long
chain) and easy for a human to read, diff, or edit afterwards.

## Composition dispatch

`translate_spec` checks, in order: `layer`, `facet`+`spec`, `repeat`+`spec`,
`hconcat`, `vconcat`, `concat`, else a unit view (`mark`/`encoding`). Each
composition kind has its own `_translate_*` function, but they share two
pieces of machinery:

- **`_merge_down(child, wrapper, merge_encoding)`** pushes the wrapper's
  `data` and `transform` down into a composition child that doesn't define
  its own (and, only for `layer`, per-key-merges `encoding` too, since
  `encoding` is only a valid property on the *layer* wrapper among all the
  composition types — confirmed against the Vega-Lite JSON schema's
  `TopLevelLayerSpec`/`TopLevelFacetSpec`/`TopLevelConcatSpec`/etc.
  `properties` lists). This lets every child be translated as if it were a
  fully independent spec, which keeps `_translate_unit` simple.
- **`_apply_common(varname, spec, emitter, consumed)`** handles everything
  that can appear at *any* level (unit or composition wrapper) after the
  structural keys are consumed: `transform`, `params`/legacy `selection` (via
  `.add_params()`), `resolve` (`.resolve_scale/axis/legend()`), `projection`
  (`.project()`), `config` (`.configure()`), and finally routes **any
  remaining key** through a single generic `.properties(**leftover)` call.

  That last part matters: Altair's `Chart.properties()` is implemented as
  `setattr(copy, key, val)` for each kwarg (see
  `altair/vegalite/v6/api.py`, `TopLevelMixin.properties`) — it isn't a
  fixed allowlist of `width`/`height`/`title`. That means `vl2altair` doesn't
  need to special-case every one of `width`, `height`, `title`, `name`,
  `description`, `autosize`, `background`, `padding`, `usermeta`, `bounds`,
  `spacing`, `align`, `center`, `columns`, `view`, ... — anything not already
  consumed by a more specific handler just falls through to `.properties()`
  and Altair accepts it generically.

## Why raw dicts for nested schema objects

Vega-Lite's JSON keys for a field/channel definition (`field`, `type`,
`aggregate`, `bin`, `scale`, `axis`, `legend`, `sort`, `condition`, `format`,
...) are **the same names** Altair's generated wrapper classes (`alt.X`,
`alt.Color`, ...) use as constructor keyword arguments — Altair's
`to_dict()`/`from_dict()` round-trip depends on this. And for anything
*nested* inside one of those (a `scale` dict, an `axis` dict, a `condition`
dict, ...), Altair's schema wrapper classes accept a plain `dict` in place of
the matching wrapper class (e.g. `alt.X(scale={"zero": False})` works exactly
like `alt.X(scale=alt.Scale(zero=False))`), because the underlying
`SchemaBase.to_dict()` just serializes whatever's stored, recursing into
nested `SchemaBase` instances but passing plain dicts/lists through
unchanged.

That means `vl2altair` only needs to build the **top-level** wrapper call for
each encoding channel (`alt.X(**kwargs)`) and can leave every nested value —
`scale`, `axis`, `legend`, `bin`, `sort`, `header`, `condition`, `format`,
repeat/datum refs like `{"repeat": "row"}` — as the literal Python
dict/list it already is (rendered by `literals.py`). This is what makes the
translator *general*: it doesn't need a hand-written mapping for every one of
Vega-Lite's dozens of nested schema types (`Scale`, `Axis`, `Legend`,
`BinParams`, `SortField`, `Header`, ...) to stay correct — new
properties added to any of those nested objects in a future Vega-Lite
version are passed through automatically.

## Reserved-word keys (`as`, `from`)

Two Vega-Lite JSON field names are Python keywords: `as` (used in several
transforms) and `from` (used in `lookup`). `transforms.py`'s table renames
these to Altair's own documented aliases (`as_`, `from_`) before rendering
named keyword arguments — Altair's `transform_calculate`/`transform_bin`/
`transform_lookup`/etc. methods accept exactly these aliases.

For any *other* dict being rendered as a call's keyword arguments (mark
properties, encoding channel properties, `config`, `projection`, ...),
`calls.py`'s `render_kwargs` defensively splits keys into "safe" (valid
Python identifier, not a keyword) rendered as `name=value`, and "unsafe"
(anything else) collected into a trailing `**{...}` dict-unpack. This is a
belt-and-suspenders fallback — none of the currently-known non-transform
schema keys hit it in practice — but it means an unexpected key can never
produce a `SyntaxError` in generated code.

## Data hoisting and object identity

Every dict-shaped `data` value is hoisted into its own Python variable (even
a simple `{"url": "..."}`), and repeated `_render_data` calls for the *same*
dict object (checked by `id()`, cached in `Emitter._data_var_cache`) reuse the
same variable rather than re-rendering the literal.

This isn't just cosmetic deduplication — it's required for correctness.
Altair automatically hoists identical `data` up to the shared parent when
combining layer/facet/concat children (`_combine_subchart_data` in
`altair/vegalite/v6/api.py`), and that function's identity check is
`c.data is subdata`, **not** `c.data == subdata`. Since `_merge_down` shares
(rather than deep-copies) a wrapper's `data` dict across its children, two
children that both inherit the same wrapper `data` will hold the *same*
Python dict object all the way through — as long as the generated code also
renders that shared object into a single variable reused by every child,
rather than two textually-identical-but-distinct dict literals. Without this,
Altair silently fails to hoist the data, and calling `.facet()` on the
result raises `"Facet charts require data to be specified at the top
level"` even though the spec is perfectly valid. This was caught by the
corpus validation described below, not by inspection.

## Corpus validation methodology

During development, `tests/validate_examples.py` was pointed at the 633
`*.vl.json` files in a local checkout of the
[vega-lite](https://github.com/vega/vega-lite) repo's `examples/specs/`
directory — the same specs Vega-Lite's own test suite and example gallery
use. For each one it:

1. Runs the translator to produce Python source.
2. `exec()`s that source in a fresh namespace.
3. Calls `.to_dict()` on the resulting chart (which runs Altair's own JSON
   schema validation).

Any exception at either step is a failure. This isn't a pytest suite (it's
too slow and depends on an external checkout) — it was the primary debugging
tool for finding real bugs (like the data-identity issue above) that
hand-written unit tests wouldn't have surfaced, since those tend to only
cover cases the author already thought of. The result at the time of writing
was 628/633 passing; see the README's *Known limitations* section for the
remaining 5.

`tests/test_translator.py` is the checked-in, fast-running pytest suite that
covers the same feature areas with small, hand-written specs, so regressions
are caught without needing the external corpus.
