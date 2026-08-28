# Architecture and design notes

This document explains *how* `vl2vlapi` translates a Vega-Lite spec into
`vega-lite-api` code, and why its design ended up much simpler than its
sibling project [`vl2altair`](../../vl2altair) (Vega-Lite → Python/Altair) —
the two libraries look similar on the surface, but `vega-lite-api`'s code
generator gives it a much more uniform, generic call surface than Altair's,
which changes the whole shape of the translator. For usage, see
[`../README.md`](../README.md).

## Why this could be simpler than the Python version

Before writing any translator code, `vega-lite-api`'s own build-time code
generator (`api/generate/method.js` in its source repo) was read directly,
and its output was verified empirically against the real, built library
(not just inferred from reading the generator). Two facts fell out of that
that shaped the whole design:

1. **Every generated property setter is a plain, generic store-and-serialize
   method.** For a property not overridden by an explicit "extension"
   (`ext`) or "pass-through" (`pass`) definition, the generator emits a
   method that does `set(obj, propName, value)` and nothing else — no type
   coercion, no validation. Serialization (`toObject()`) walks whatever's
   stored generically, recursing into plain objects and arrays without
   requiring them to be special builder instances. This was confirmed by
   calling `vl.tooltip([{field: 'a', ...}, {field: 'b', ...}])` and
   `.transform({filter: '...'})`/`.params({name: ..., select: {...}})` with
   **raw plain object/array literals instead of nested builder calls**, and
   getting exactly the expected serialized output.

2. **Vega-Lite itself doesn't require data to be hoisted to a shared
   ancestor for composition to work.** Altair's `_combine_subchart_data`
   uses object *identity* (`is`, not `==`) to decide whether to hoist
   matching `data` up to a layer/facet/concat parent, and its `.facet()`
   raises an error if that hoist doesn't happen — which is why `vl2altair`
   has to carefully thread the *same* Python object through every child that
   should share data. `vega-lite-api` and the real Vega-Lite compiler have
   no such requirement (verified with `vegaLite.compile()` directly): a
   facet's `data` can live only inside its `spec` child, layer children can
   each carry a full copy of identical data, and everything still compiles.

Together, these mean the translator doesn't need Python's "merge shared
wrapper properties down into every child" step (`_merge_down` in
`vl2altair`) at all. Every Vega-Lite JSON property — wherever it appears,
at a unit view or at a composition wrapper — maps onto a call at *exactly*
that same level, because the target library resolves the inheritance
itself at Vega-Lite compile time, not at spec-construction time.

## Pipeline

`vegaLiteToVegaLiteApiCode(spec)` (in `translator.js`):

1. Strips `$schema`.
2. Hoists any top-level `datasets` mapping into `const` variables
   (`hoistDatasets`), tracked for the final `.datasets({...})` call.
3. Calls `translateSpec(spec, emitter, 'chart')`, which recursively
   dispatches on the spec's shape and returns a JS expression string.
4. Wraps the result in an `import * as vl from 'vega-lite-api';` header,
   any hoisted `const` declarations, and a trailing
   `const chart = ...; export default chart;`.

## Composition dispatch

`translateSpec` checks, in order: `layer`, `facet`+`spec`, `repeat`+`spec`,
`hconcat`, `vconcat`, `concat`, else a unit view (`mark`/`encoding`). Each
composition kind translates its children **independently** (no merging, per
above) and combines them with the matching constructor —
`vl.layer(c1, c2, ...)`, `child.facet(<raw facet value>)`,
`child.repeat(<raw repeat value>)`, `vl.hconcat(...)`, etc. — then hands the
result plus the *original* spec's remaining top-level keys to
`applyRemaining`.

`applyRemaining` is the one function that handles every "extra" property at
any level (unit view or composition wrapper) and is almost embarrassingly
simple:

```js
for (const key of Object.keys(spec)) {
  if (consumed.has(key)) continue;
  // a handful of special cases (below)...
  else chain.call(METHOD_RENAME[key] || key, [formatValue(spec[key])]);
}
```

That generic `else` branch — call a method with the *same name as the JSON
key*, passing the parsed value through `formatValue` unchanged — is what
handles `width`, `height`, `title`, `name`, `description`, `resolve`,
`config`, `autosize`, `background`, `padding`, `view`, `usermeta`, `align`,
`bounds`, `center`, `spacing`, `columns`, and anything else Vega-Lite adds to
its schema in the future, with zero code changes. This is the JS analogue
of `vl2altair`'s `.properties(**leftover)` catch-all, except here there's no
need for a catch-all at all: every property already gets its own method.

### The exceptions

Only a few keys need special handling, and each was found by reasoning
about the generator's source and then confirmed by running real code:

- **`encoding`** → `.encode(vl.x(...), vl.y(...), ...)`. This is the one
  place a plain object genuinely doesn't work: `.encode()`'s merge logic
  needs each argument to know its own channel name (`x`, `color`, ...),
  which only a `vl.<channel>(...)` builder instance provides — a bare
  `{field: ..., type: ...}` object has no way to say which channel it
  belongs to. `encoding.js`'s `renderChannel` builds
  `vl.<channelKey>(<raw channel-def literal>)` for exactly this reason,
  where `channelKey` is just the JSON key verbatim (`x`, `xOffset`,
  `fillOpacity`, ...) — `vega-lite-api` exports one constructor per
  `FacetedEncoding` property, named identically.
- **`transform`, `params`** → `.transform(t1, t2, ...)` / `.params(p1, ...)`,
  each argument a raw object literal (see point 1 above) — but **skipped
  entirely when the array is empty**. `vl.mark(...).encode()` (zero
  arguments) was found during corpus validation to return `undefined`
  rather than `this` — a real quirk in `vega-lite-api`'s
  `generateAccretiveObjectProperty` codegen, not a Vega-Lite semantic — so
  an empty `encoding: {}`/`transform: []`/`params: []` (all valid,
  if unusual, Vega-Lite) is simply not chained on at all rather than
  emitting a call known to break.
- **`selection`** (legacy, pre-`params` Vega-Lite) → converted to the
  modern `{name, select: {type, ...}}` shape and folded into the same
  `.params(...)` handling as `params`.
- **`data`** → `.data(<value>)`, with one readability nicety: bare
  `{values: [...]}` data (no other keys) is hoisted into a `const`
  variable first. This is a style choice, not a correctness requirement
  (see point 2 above) — there's no Python-style object-identity cache
  needed here, since nothing downstream cares whether two `.data(...)`
  calls received the *same* object or merely an equal one.
- **`projection` → `.project(...)`**. `vega-lite-api` explicitly renames
  this one JSON property (its `ext` definition sets `projection: null` and
  defines `project` instead, presumably to avoid colliding with the
  separate `vl.projection(...)` *constructor* function). This was the
  first real bug caught by corpus validation: calling the generic
  `.projection(value)` (matching the JSON key literally) failed on every
  geo-related example with `"...projection is not a function"`.
  `METHOD_RENAME` in `translator.js` is the (one-entry) table that handles
  this; `encoding`/`encode` is the only other such rename, and it already
  gets bespoke handling for the channel-wrapping reason above.

## Why raw literals work almost everywhere

`vega-lite-api`'s runtime (`static/__util__.js` in its source) stores each
object's properties in an internal `[Data]` slot. `assign()` — used by any
constructor whose factory spec has no `arg` definition (true of every
encoding-channel constructor) — does `Object.assign(target[Data], source)`
for each plain-object argument, storing nested values (whatever's under
`scale`, `axis`, `bin`, `condition`, ...) completely unprocessed. Later,
`toObject()`'s generic walker (`recurse()`) serializes any value: if it has
its own `.toObject` method (a builder instance) it's called; otherwise the
value is walked as a plain object/array. A raw literal never has a
`.toObject` method, so it always falls into the generic path — which
produces the exact same output a builder instance would, just without
needing one. This was verified directly (see point 1 above) rather than
assumed from reading the source, since the interaction between `assign`,
`set`, `merge`, and `annotate` across several files is intricate enough that
static reading alone left real doubt.

Transform and parameter builder *functions* (`vl.filter()`, `vl.bin()`,
`vl.selectPoint()`, ...) exist and are the more "official"/documented way to
build these objects, and the actual generated code intentionally doesn't
use them — passing raw object literals directly to `.transform(...)` and
`.params(...)` is simpler, requires no per-transform-type argument table
(unlike `vl2altair`, which needs one to route `as`/`from` to their Altair
alias parameter names), and was confirmed to produce identical output.

## Provenance header and source-path annotations

Every generated file opens with a `// Generated by vl2vlapi.vegaLiteToVegaLiteApiCode(spec, ...)`
comment showing the exact call that produced it.
`includeSourcePaths: true` (default `false`) goes further, labeling each
piece of the *output* with the JSON path in the *input* spec it came from
(e.g. `// from: encoding.x, encoding.y`, `// from: layer[0].mark`) — but
getting there took more than just adding a comment string, because unlike
`vl2altair`'s one-statement-per-operation output, everything here is one
fluent *expression* (`vl.mark(...).encode(...).transform(...)`), built by
`Chain` (`calls.js`). A `// ...` comment can't share a line with anything
after it, so a labeled `Chain` step forces the whole chain into its
one-step-per-line rendering (already the fallback for a chain too long for
one line) rather than ever risking a comment silently swallowing the rest
of a line that happened to still fit.

Composition children were the one place this needed real care. `vl.layer(
child1, child2)`'s children are plain comma-joined *arguments*, not
separate statements — and a child chain that itself starts with its own
labeled `basePath` (e.g. `layer[0]`'s own "mark" step) begins with `// from:
layer[0].mark\nvl.mark(...)`. Splicing that straight after `vl.layer(` or a
previous argument's trailing `, ` put real code on the same line as a
comment reaching for the rest of it — still parses (the comment only eats
that one line; the child's own code continues normally starting the next
line, comments being pure whitespace to the parser), but reads as though
the argument list is broken. `joinChildArgs()`/`wrapChildExpr()` (only
active when `includeSourcePaths` is on) put each child argument on its own
indented line instead, so nothing ever follows a `//` on the line it starts.

## Corpus validation methodology

`test/validate-examples.js` was pointed at a shallow clone of the
[vega-lite](https://github.com/vega/vega-lite) repo's `examples/specs/`
directory (633 files at the time of writing — the same corpus
`vl2altair`'s validation script uses). For each spec it:

1. Runs the translator to produce JavaScript source.
2. Writes it to a scratch `.mjs` file and `import()`s it (so `vega-lite-api`
   resolves normally through `node_modules`).
3. Calls `.toObject()` on the resulting chart and feeds it to the real
   `vegaLite.compile()`.

Any exception at any step is a failure. This is what caught both real bugs
described above (`projection`/`project`, and the zero-argument `.encode()`
quirk) — both were invisible from reading the generator's source alone,
and both would have been missed by hand-written unit tests that only cover
cases the author already thought to test. The result at the time of writing
was **630/633 passing**; see the README's *Known limitations* section for
the remaining 3 (all a single root cause: unsupported facet-of-facet
nesting).

`test/translator.test.js` is the checked-in, fast-running `node:test` suite
that covers the same feature areas with small, hand-written specs, so
regressions are caught without needing the external corpus.
