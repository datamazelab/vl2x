// Recursive-ish translation of a Vega-Lite spec into a standalone D3
// chart-drawing function.
//
// Scope: single unit views, and `layer` (children rendered on shared
// scales/axes). `facet`, `repeat`, `concat`, `hconcat`, `vconcat` throw a
// clear "not supported" error -- D3 has no small-multiples primitive of its
// own, and faithfully reproducing Vega-Lite's layout/resolve semantics by
// hand is a substantially larger project than a single-view renderer.
//
// Passing `{ignoreUnsupported: true}` relaxes this (and every other
// "Unsupported: ..." check throughout the pipeline) into a best-effort
// fallback instead -- each child view still renders independently (losing
// shared-scale alignment), a facet/repeat becomes a simple grid of
// independently-rendered panels, geographic encoding is drawn as a plain
// unprojected x/y scatter, and so on. Default is off (current strict
// behavior): a chart that renders something is only better than one that
// refuses when the caller has actually asked for that tradeoff.

import {renderDataLoad, renderTemporalCoercion} from './data.js';
import {renderTransforms} from './transforms.js';
import {prepareEncoding} from './prepare.js';
import {planStacking, renderStackingStatements, applyStackingToEncoding} from './stack.js';
import {
  resolvePositionScale,
  resolveColorScale,
  resolveSizeScale,
  resolveOpacityScale,
  resolveShapeScale,
  resolveRadiusScale,
  resolveOffsetScale,
  sharedChannelDomainExpr,
} from './scales.js';
import {renderMark} from './marks.js';
import {formatValue} from './literals.js';
import {extractDateFunctionFields} from './expr.js';
import {timeUnitExpr, isSupportedTimeUnit, cyclicLabelExpr} from './timeunit.js';

// Every function name runtime.js exports, in preference order for the
// generated `import {...} from "./vl2d3-runtime.js"` line -- see
// specToCode()'s conditional-import logic below.
const RUNTIME_EXPORTS = ['vlPivot'];

const UNSUPPORTED_COMPOSITIONS = ['facet', 'repeat', 'concat', 'hconcat', 'vconcat'];
const GEO_CHANNELS = ['longitude', 'latitude', 'longitude2', 'latitude2'];

// Resolve top-level `datasets: {name: [...rows]}` reusable named datasets --
// any `data: {name: "...", ...}` reference anywhere in the tree (the root
// view or any layer/concat child) is replaced with that dataset's rows as
// if they'd been inlined directly (`data: {values: [...rows], ...rest}`).
function resolveDatasetRefs(node, datasets) {
  if (!node || typeof node !== 'object') return node;
  const result = {...node};
  if (result.data && typeof result.data === 'object' && result.data.name && result.data.name in datasets) {
    const {name, ...rest} = result.data;
    result.data = {values: datasets[name], ...rest};
  }
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) {
    if (Array.isArray(result[key])) {
      result[key] = result[key].map(child => resolveDatasetRefs(child, datasets));
    }
  }
  if (result.spec) result.spec = resolveDatasetRefs(result.spec, datasets);
  return result;
}

function mergeDown(child, wrapper) {
  const merged = {...child};
  if (!merged.data && wrapper.data) merged.data = wrapper.data;
  if (wrapper.transform) merged.transform = [...wrapper.transform, ...(merged.transform || [])];
  if (wrapper.encoding) {
    // A per-CHANNEL merge, not a per-channel-KEY replace: a layer/facet
    // wrapper's own shared channel definition (e.g. wheat_wages.vl.json's
    // shared `x: {type: "quantitative", axis: {...}}`) commonly leaves a
    // child layer to declare only the *field* for that same channel (e.g.
    // just `x: {field: "year"}`) -- a flat `{...wrapper.encoding,
    // ...child.encoding}` would let the child's own `x` object wholesale
    // *replace* the wrapper's, discarding its "type" (and anything else)
    // entirely, silently leaving that channel with no explicit type at
    // all (falling into scales.js's own "ambiguous, check at runtime"
    // fallback -- and, worse, that fallback's own domain computation
    // doesn't union multiple layers' differently-named fields the way the
    // non-ambiguous branches do, e.g. facet_bullet.vl.json's own six
    // `ranges[N]`/`measures[N]`/`markers[0]`-keyed layers sharing one `x`).
    // Each overlapping channel is deep-merged instead, one level down
    // (child's own properties still win over the wrapper's on conflict).
    const channels = new Set([...Object.keys(wrapper.encoding), ...Object.keys(merged.encoding || {})]);
    const mergedEncoding = {};
    for (const ch of channels) {
      const wrapperDef = wrapper.encoding[ch];
      const childDef = merged.encoding && merged.encoding[ch];
      mergedEncoding[ch] =
        wrapperDef && typeof wrapperDef === 'object' && childDef && typeof childDef === 'object'
          ? {...wrapperDef, ...childDef}
          : childDef !== undefined
            ? childDef
            : wrapperDef;
    }
    merged.encoding = mergedEncoding;
  }
  return merged;
}

// Fields that need to be coerced from raw JSON strings/numbers into real JS
// `Date` objects before anything else runs. A channel implies a temporal
// field either by explicit `type: "temporal"` or, per Vega-Lite's own type
// inference, by having a `timeUnit` at all (even with no explicit type) --
// and a top-level `timeUnit` transform's source field needs the same
// treatment, even though it isn't named in any encoding channel.
function collectTemporalFields(encoding, transformList = []) {
  const fromEncoding = Object.values(encoding)
    .filter(def => def && typeof def === 'object' && def.field && (def.type === 'temporal' || def.timeUnit))
    .map(def => def.field);
  const fromTimeUnitTransforms = transformList.filter(t => 'timeUnit' in t).map(t => t.field);
  const fromCalculateExprs = transformList.filter(t => 'calculate' in t).flatMap(t => extractDateFunctionFields(t.calculate));
  return [...new Set([...fromEncoding, ...fromTimeUnitTransforms, ...fromCalculateExprs])];
}

function isBarOrArea(mark) {
  const type = typeof mark === 'string' ? mark : mark && mark.type;
  return type === 'bar' || type === 'area';
}

// A top-level `params` entry can bind a mark/encoding property to a live,
// interactive value (`{"bind": {"input": "range", ...}}`) -- this project
// has no interactivity to speak of, so the only thing worth reproducing is
// its *static default* (`value`), which is what every mark/encoding
// property bound via `{"expr": "<param name>"}` actually shows on first
// render anyway. A derived param (`{"expr": "otherParam / 2"}`, e.g. a
// bullet chart's own `innerBarSize`) is resolved the same way, substituting
// each already-resolved param's numeric value into the expression text and
// evaluating the (now-plain-arithmetic) result -- params later in the array
// commonly depend on ones earlier in it, never the reverse, so a single
// left-to-right pass is enough.
function resolveStaticParams(params = []) {
  const values = new Map();
  for (const p of params) {
    if (!p || !p.name) continue;
    if (typeof p.value === 'number') {
      values.set(p.name, p.value);
    } else if (typeof p.expr === 'string') {
      const resolved = evalSimpleParamExpr(p.expr, values);
      if (resolved !== null) values.set(p.name, resolved);
    }
  }
  return values;
}

// Substitutes every already-resolved param name in `expr` with its numeric
// value, then evaluates the result -- but only if what's left is safe,
// plain arithmetic (a whitelist of digits/operators/parens/whitespace, no
// identifiers at all): this deliberately refuses anything referencing an
// unresolved param, a signal, or a Vega expression function, returning
// `null` for the caller to fall back on rather than guessing.
function evalSimpleParamExpr(expr, paramValues) {
  let substituted = expr;
  for (const [name, value] of paramValues) {
    substituted = substituted.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${value})`);
  }
  if (!/^[\d\s+\-*/().]+$/.test(substituted)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${substituted});`)();
    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// Resolves any mark property bound to a *static* param (`{"expr": "<param
// name or simple arithmetic over param names>"}`) into the literal number
// it would show on first render -- everything downstream (simpleMarkProp()
// et al.) already handles a plain literal, so this needs no further
// plumbing once the substitution happens here, up front. A prop already a
// plain literal, or bound to something evalSimpleParamExpr() can't resolve
// (a live signal expression, a non-arithmetic string), passes through
// unchanged for that existing "unsupported, fall back to a default" path
// to handle as before.
function resolveMarkPropExprs(markProps, paramValues) {
  if (paramValues.size === 0) return markProps;
  const resolved = {...markProps};
  for (const key of Object.keys(resolved)) {
    const value = resolved[key];
    if (value && typeof value === 'object' && typeof value.expr === 'string') {
      const num = evalSimpleParamExpr(value.expr, paramValues);
      if (num !== null) resolved[key] = num;
    }
  }
  return resolved;
}

// Vega-Lite's default handling of a null/undefined/NaN value on a
// continuous (quantitative/temporal) channel is to *filter the whole row
// out* before any other transform runs (`mark.invalid` -- or, more
// commonly, `config.mark.invalid` -- default: `"filter"`), which is why a
// single bad row in real-world data doesn't normally break a line/area
// path or a bar/point's position into `NaN`. This project only reproduces
// that *default* case (`"filter"`, or the property absent entirely) --
// the other documented modes (`"show"`, `null`, `"break-paths-*"`, which
// keep/re-route invalid values instead of dropping their row) are a
// deliberately narrower, less common feature this doesn't attempt to
// match, so a spec that explicitly asks for one of those still behaves as
// before (own risk of `NaN` output, same as always).
const INVALID_FILTER_CHANNELS = ['x', 'y', 'x2', 'y2', 'theta', 'theta2', 'radius', 'radius2', 'color', 'size', 'opacity'];

function invalidHandlingMode(root, mark) {
  const markProps = typeof mark === 'string' ? {} : mark || {};
  if ('invalid' in markProps) return markProps.invalid;
  if (root.config && root.config.mark && 'invalid' in root.config.mark) return root.config.mark.invalid;
  return 'filter';
}

// Field names a top-level `transform` array *produces* (calculate/
// timeUnit/bin/aggregate/window/density's own `as`) rather than reads from
// the raw loaded data -- an encoding channel naming one of these can't be
// invalid-filtered against the raw, pre-transform rows (the field doesn't
// exist there yet at all, which previously filtered out *every* row: see
// collectInvalidFilterFields()'s own doc comment).
function collectProducedFields(transformList = []) {
  const produced = new Set();
  for (const t of transformList) {
    if ((t.calculate !== undefined || t.timeUnit !== undefined) && t.as) produced.add(t.as);
    if (t.bin) {
      // A single-string `as`'s second (end) output field is `<as>_end`,
      // not `<as>2` -- see transforms.js's own render_bin_transform for the
      // same fix (and the past bug it documents: this mismatch silently
      // left `<as>_end` unrecognized as produced, which mattered nothing
      // until collectInvalidFilterFields() started trusting it too).
      (Array.isArray(t.as) ? t.as : [t.as, `${t.as}_end`]).forEach(a => produced.add(a));
    }
    if (t.aggregate) {
      for (const a of t.aggregate) if (a.as) produced.add(a.as);
    }
    if (t.window) {
      for (const w of t.window) if (w.as) produced.add(w.as);
    }
    if (t.joinaggregate) {
      for (const a of t.joinaggregate) if (a.as) produced.add(a.as);
    }
    if (t.density) {
      (Array.isArray(t.as) && t.as.length === 2 ? t.as : ['value', 'density']).forEach(a => produced.add(a));
    }
    if (t.fold) {
      const [keyName, valueName] = Array.isArray(t.as) ? t.as : ['key', 'value'];
      produced.add(keyName);
      produced.add(valueName);
    }
    if (t.stack) {
      const [as0, as1] = Array.isArray(t.as) ? t.as : [`${t.stack}_start`, `${t.stack}_end`];
      produced.add(as0);
      produced.add(as1);
    }
  }
  return produced;
}

// `pivot`'s own output column names are the *distinct runtime values* of
// its key field -- genuinely unknowable at code-generation time, unlike
// every other transform above (whose output names are static, spec-declared
// strings). An invalid-value filter injected on the strength of a channel's
// own field name (collectInvalidFilterFields()) can't tell a pivot-produced
// field apart from a raw one in that case, and filtering the *raw*,
// pre-pivot rows on a column that doesn't exist there yet (`undefined !=
// null` is false) would silently drop every row before the pivot ever
// runs -- so this disables that filter entirely whenever a pivot is
// anywhere in the pipeline, the same "can't tell, so don't touch anything"
// call R's transform_produced_fields() makes for the identical reason.
function hasDynamicProducedFields(transformList = []) {
  return transformList.some(t => t.pivot !== undefined);
}

// A top-level `extent` transform (`{extent: field, param: name}`) computes
// the [min, max] of `field` and exposes it under `param` for later
// expressions to reference (e.g. a rule mark's `value: {expr:
// "scale('x', b_extent[0])"}}`) -- not a data-pipeline step at all (no
// dataVar reshaping), so it's collected here rather than handled inside
// renderTransforms(), and resolved directly at the point of use (see
// resolveValueExpr() in marks.js) rather than through a separately
// pre-declared runtime variable (avoids a redeclaration clash across
// sibling layer children, which -- like any other top-level transform --
// each independently re-run their own copy of via mergeDown()).
function collectExtentParams(transformList = []) {
  const params = {};
  for (const t of transformList || []) {
    if (t.extent && t.param) params[t.param] = t.extent;
  }
  return params;
}

// Fields to null/NaN-filter a view's raw data on, before any other
// transform runs -- every continuous-typed position/color/size/opacity
// channel's own source `field` (whether or not it's also aggregated/
// binned/timeUnit'd inline on the channel: the *source* field is what can
// hold an invalid value, and an aggregate already skips non-finite inputs
// on its own, so filtering the row upstream too is never wrong, just
// occasionally redundant) -- excluding any field a top-level `transform`
// produces rather than one the raw data actually has (see
// collectProducedFields()).
// A "line"/"area" mark's own position channels (the ones its d3.line()/
// d3.area() path generator walks) are deliberately excluded from the
// upfront row-drop filter below -- real Vega-Lite's "filter" default
// doesn't drop an invalid row from a *continuous* mark's data at all, it
// breaks the drawn path into separate segments at that point instead (e.g.
// line_skip_invalid_mid_cap_square.vl.json's own two disconnected
// segments, with the lone valid point *between* two invalid neighbors
// left entirely undrawn -- a single point can't form a segment on its
// own). Dropping the row here instead would silently reconnect the path
// straight across the gap, one vertex short. renderLine()/renderArea()
// (marks.js) handle the actual gap themselves, via a `.defined()` clause
// on the very same fields -- every *other* channel (color/size/opacity)
// still gets its row dropped upfront as before, since an invalid value
// there has no equivalent "break the path" meaning.
function pathContinuityChannels(mark) {
  const markType = typeof mark === 'string' ? mark : mark && mark.type;
  if (markType === 'line') return ['x', 'y'];
  if (markType === 'area') return ['x', 'y', 'x2', 'y2'];
  return [];
}

// The mirror-image restriction of collectInvalidFilterFields()'s own
// excludeChannels: gathers *only* a line/area's path-continuity channels'
// own fields (pathContinuityChannels()), for renderInvalidZeroFill() to
// coerce to 0 -- used instead of collectInvalidFilterFields() whenever
// invalidHandlingMode() isn't the default `"filter"`, since those are then
// the only channels whose invalid values still need any handling at all
// (every other channel keeps going through the ordinary upfront row-drop
// filter regardless of this mark-level mode -- Vega-Lite's `mark.invalid`
// only ever changes line/area's own *path* continuity, never a color/size/
// opacity channel's unrelated row-drop behavior).
function collectInvalidZeroFillFields(encoding, transformList, continuityChannels) {
  if (hasDynamicProducedFields(transformList)) return [];
  const produced = collectProducedFields(transformList);
  const fields = new Set();
  for (const ch of continuityChannels) {
    const def = encoding[ch];
    if (!def || typeof def !== 'object' || !def.field || !(def.type === 'quantitative' || def.type === 'temporal' || def.type === undefined)) continue;
    if (/[[\].]/.test(def.field) || produced.has(def.field)) continue;
    fields.add(def.field);
  }
  return [...fields];
}

function collectInvalidFilterFields(encoding, transformList, excludeChannels = []) {
  if (hasDynamicProducedFields(transformList)) return [];
  const produced = collectProducedFields(transformList);
  const fields = new Set();
  for (const ch of INVALID_FILTER_CHANNELS) {
    if (excludeChannels.includes(ch)) continue;
    const def = encoding[ch];
    // An explicitly nominal/ordinal field is skipped (a real category value
    // has no "invalid" numeric reading to speak of) -- but a field with NO
    // type at all (resolved "ambiguous" at runtime, scales.js) still gets
    // filtered here: `d[field] != null && !Number.isNaN(d[field])` never
    // drops a genuine string/category value (Number.isNaN() only flags the
    // actual NaN value), so this is safe regardless of which way the
    // ambiguous field ultimately resolves, and is exactly what an
    // approximated/fallback mark (e.g. an unsupported "errorband" drawn as
    // a plain point, marks.js) needs: its accessor has no aggregate of its
    // own to already skip a null/missing raw value the way build_layer_*
    // aggregation paths do.
    if (!def || typeof def !== 'object' || !def.field || !(def.type === 'quantitative' || def.type === 'temporal' || def.type === undefined)) continue;
    // A bracket-indexed field path (`argmax_x['y']`, or a bare numeric
    // index into a genuine array-valued raw column like a bullet chart's
    // `ranges[2]`, see parseBracketFieldPath()) is never itself a real,
    // literal property key on any row -- `d["ranges[2]"]` (the naive
    // lookup renderInvalidFilter() below would otherwise emit) is simply
    // `undefined` on every row, regardless of whether the base is a
    // produced field or a genuine raw one, so this always filtered every
    // row out before flattenBracketFields() ever got a chance to run and
    // create the real flattened field this filter would need to target
    // instead. Skipped entirely here (same as a produced field) rather
    // than attempting a nested-access filter expression of its own --
    // flattenBracketFields()'s own `== null ? null : ...` chain already
    // produces `null` (not a crash) for a genuinely missing/short array,
    // so the one gap this leaves is a real `NaN`/non-array value at that
    // exact index slipping through unfiltered, not a broken chart.
    const bracketBase = !def.__wasEscaped && parseBracketFieldPath(def.field)?.base;
    if (bracketBase || produced.has(def.field)) continue;
    fields.add(def.field);
  }
  return [...fields];
}

// Vega-Lite escapes a literal special character inside a field NAME (most
// commonly `.`, to distinguish "a.b" the column from a nested-path access
// into column "a"'s "b" property) with a leading backslash. Every mark/
// scale accessor in this codebase reads a channel's `field` directly as an
// object-property key, so that escaping must be undone before use -- the
// real property name in the loaded data has no backslash in it at all.
function unescapeFieldPath(field) {
  return typeof field === 'string' ? field.replace(/\\(.)/g, '$1') : field;
}

function unescapeEncodingFields(encoding) {
  const rewritten = {...encoding};
  for (const ch of Object.keys(encoding)) {
    const def = encoding[ch];
    if (def && typeof def === 'object' && typeof def.field === 'string' && def.field.includes('\\')) {
      // `__wasEscaped` (an internal marker, never read anywhere except
      // parseBracketFieldPath()'s own caller below) records that this
      // field's dot(s) were deliberately backslash-escaped in the source
      // spec -- meaning "a literal flat column name", NOT nested-object
      // access -- a distinction this unescape step's own output (a plain
      // string with the backslash already stripped) can no longer convey
      // on its own: "a.b" alone is ambiguous between an escaped
      // "a\\.b" (this case) and a genuinely-nested, never-escaped "a.b"
      // (bar_layered_weather.vl.json's own "record.low", e.g.) by the time
      // flattenBracketFields() gets to it.
      rewritten[ch] = {...def, field: unescapeFieldPath(def.field), __wasEscaped: true};
    }
  }
  return rewritten;
}

// A Vega-Lite field name is normally a plain (possibly dotted/escaped)
// property path, but a compound aggregate result (`argmin`/`argmax`, which
// stores the *whole matching row* under its `as` name) is instead
// referenced with bracket-index syntax into that nested object, e.g.
// `argmax_US_Gross['Production Budget']`. Every mark/scale accessor in
// this codebase turns a channel's `field` into a single `d[JSON.stringify(field)]`
// property read, which can't express that nested lookup -- so rather than
// teach every one of those call sites a general field-path parser, detect
// this one shape up front and flatten it into an ordinary new top-level
// field before any of them ever see it.
function parseBracketFieldPath(field) {
  // A bracket-indexed field path is either a string key (a compound
  // aggregate result, e.g. `argmax_US_Gross['Production Budget']`) or a
  // bare numeric index (a genuine array-valued column, e.g. a bullet
  // chart's `ranges[2]`) -- both resolve the same way at access time
  // (`arr[2]` and `arr["2"]` are equivalent in JS), so both are parsed
  // here rather than only the string-key shape. An *unescaped* `.` is
  // Vega-Lite's other nested-access convention -- reading a sub-property
  // of an object-valued column (e.g. bar_layered_weather.vl.json's own
  // "record.low", reading `datum.record.low` out of a `{"record": {"low":
  // ..., "high": ...}}`-shaped row) -- as opposed to a literal dot *within*
  // one flat column name, which must be backslash-escaped
  // ("record\\.low", handled separately by unescapeFieldPath() /
  // unescapeEncodingFields()); this regex's charset has no backslash in it
  // at all, so an escaped field never matches here and falls through to
  // that other handling untouched. Both `.identifier` and `[key]` segments
  // can freely mix (`"a.b[0].c"`), sharing one `keys` list either way --
  // flattenBracketFields() (below) doesn't care which syntax produced a
  // given key, just how to look it up.
  const m = /^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*|\[(?:'[^']*'|"[^"]*"|-?\d+)\])+)$/.exec(String(field));
  if (!m) return null;
  const keys = [...m[2].matchAll(/\.([A-Za-z_$][\w$]*)|\[(?:'([^']*)'|"([^"]*)"|(-?\d+))\]/g)].map(km =>
    km[1] !== undefined ? km[1] : km[4] !== undefined ? Number(km[4]) : km[2] ?? km[3]
  );
  return {base: m[1], keys};
}

function flattenBracketFields(encoding, dataVar) {
  const statements = [];
  const rewritten = {...encoding};
  for (const ch of Object.keys(encoding)) {
    const def = encoding[ch];
    if (!def || typeof def !== 'object' || !def.field || def.__wasEscaped) continue;
    const parsed = parseBracketFieldPath(def.field);
    if (!parsed) continue;
    const flatField = `${parsed.base}__${parsed.keys.map(k => String(k).replace(/[^A-Za-z0-9_]/g, '_')).join('__')}`;
    let expr = `d[${JSON.stringify(parsed.base)}]`;
    for (const k of parsed.keys) expr = `(${expr} == null ? null : ${expr}[${JSON.stringify(k)}])`;
    statements.push(`${dataVar} = ${dataVar}.map(d => ({...d, ${JSON.stringify(flatField)}: ${expr}}));`);
    rewritten[ch] = {...def, field: flatField};
  }
  return {statements, encoding: rewritten};
}

function renderInvalidFilter(dataVar, fields) {
  if (fields.length === 0) return [];
  const cond = fields.map(f => `d[${JSON.stringify(f)}] != null && !Number.isNaN(d[${JSON.stringify(f)}])`).join(' && ');
  return [`${dataVar} = ${dataVar}.filter(d => ${cond});`];
}

// `mark.invalid` (or `config.mark.invalid`) explicitly set to `null`/`false`
// (as opposed to the default `"filter"`) asks Vega-Lite to neither drop the
// row nor break a line/area path at it -- the invalid value is used as-is,
// which for a continuous position channel resolves to 0 (e.g.
// area_invalid_null.vl.json's own null `y` values, each drawn as a literal
// zero rather than a gap or a dropped row: a "V" dipping to the baseline at
// that x, not a break in the shape). marks.js's own `.defined()` clause
// (positionDefinedClause()) only ever applies to whatever's still in
// `dataVar` at draw time, so coercing the invalid values to 0 here, upstream
// of that, produces the right shape with no changes needed on the marks.js
// side at all -- there's simply nothing left to be "undefined" about by then.
function renderInvalidZeroFill(dataVar, fields) {
  if (fields.length === 0) return [];
  const assigns = fields.map(f => `${JSON.stringify(f)}: (d[${JSON.stringify(f)}] == null || Number.isNaN(d[${JSON.stringify(f)}])) ? 0 : d[${JSON.stringify(f)}]`).join(', ');
  return [`${dataVar} = ${dataVar}.map(d => ({ ...d, ${assigns} }));`];
}

// Vega-Lite allows a `layer` entry to itself be a nested layer composition
// (a layer of layers) -- flatten this recursively into a single list of
// unit-view specs, applying `mergeDown` at each level so shared
// data/transform/encoding still reach the innermost unit views correctly.
function flattenLayers(node, wrapper) {
  const merged = mergeDown(node, wrapper);
  if ('layer' in merged) {
    const {layer, ...rest} = merged;
    return layer.flatMap(child => flattenLayers(child, rest));
  }
  return [merged];
}

// Build the body (everything between the function signature and its
// closing brace) of a single-view-or-layer chart function, as an array of
// already-indented lines ending in `return svg.node();`.
function buildUnitOrLayerBody(root, ignoreUnsupported, dataParam = null) {
  const children = flattenLayers(root, {});
  const paramValues = resolveStaticParams(root.params);

  const lines = [];
  const b = s => lines.push('  ' + s);

  // The spec's own top-level `width`/`height` (a plain number, e.g. area_
  // horizon.vl.json's own `"width": 300, "height": 50`) is this chart
  // function's own DEFAULT size, not just the generic 640x400 fallback --
  // an explicit `options.width`/`.height` from the caller still always
  // wins (the same override precedence a facet/concat panel's own size
  // already has, see buildRuntimeFacetPanels()/buildPanelFunction()), but
  // previously only those panel-building paths ever threaded a spec's own
  // size in at all; a plain standalone/layer chart function baked in the
  // generic 640x400 regardless, silently ignoring its own spec's size
  // whenever the caller didn't *also* separately know to pass it back in.
  const defaultWidth = typeof root.width === 'number' ? root.width : 640;
  const defaultHeight = typeof root.height === 'number' ? root.height : 400;
  b(`const width = options.width ?? ${formatValue(defaultWidth)};`);
  b(`const height = options.height ?? ${formatValue(defaultHeight)};`);
  // The generic 20/20/30/50 default margins alone can exceed a small
  // explicit height/width outright (e.g. area_horizon.vl.json's own
  // `"height": 50` -- exactly consumed by the default 20+30 top+bottom
  // margin, leaving a *zero*-height clip-path/plot area that silently
  // clips every mark to nothing) -- scaled down proportionally the same
  // way a small facet panel's own default margins already are
  // (buildRuntimeFacetPanels()/buildPanelFunction()), rather than only
  // ever applying to those panel-building paths.
  const defaultMarginTop = defaultHeight <= 50 ? Math.max(1, Math.round(defaultHeight * 0.3)) : 20;
  const defaultMarginBottom = defaultHeight <= 50 ? Math.max(1, Math.round(defaultHeight * 0.4)) : 30;
  const defaultMarginLeft = defaultWidth <= 80 ? Math.max(1, Math.round(defaultWidth * 0.3)) : 50;
  const defaultMarginRight = defaultWidth <= 80 ? Math.max(1, Math.round(defaultWidth * 0.1)) : 20;
  b(`const marginTop = options.marginTop ?? ${formatValue(defaultMarginTop)};`);
  b(`const marginRight = options.marginRight ?? ${formatValue(defaultMarginRight)};`);
  b(`const marginBottom = options.marginBottom ?? ${formatValue(defaultMarginBottom)};`);
  b(`const marginLeft = options.marginLeft ?? ${formatValue(defaultMarginLeft)};`);
  lines.push('');

  // Clamped (not bare `height - marginBottom` / `width - marginRight`):
  // a facet's own per-panel `width`/`height` (buildRuntimeFacetPanels)
  // can be small enough -- e.g. trellis_area_seattle's 25px-tall row
  // strips -- that the default 20/30px top/bottom margins alone exceed
  // it. Unclamped, `height - marginBottom` then comes out *less* than
  // `marginTop`, silently reversing the y-scale's own range order (low
  // values now map to the smaller pixel coordinate, at the top) and
  // flipping the whole plot upside down. Clamping keeps the range
  // degenerate (a single point) in that extreme case rather than
  // inverted -- a squashed plot, not a mirrored one.
  const dims = {
    xRangeExpr: '[marginLeft, Math.max(marginLeft, width - marginRight)]',
    yRangeExpr: '[Math.max(marginTop, height - marginBottom), marginTop]',
    innerWidthExpr: '(width - marginLeft - marginRight)',
    innerHeightExpr: '(height - marginTop - marginBottom)',
    centerXExpr: 'width / 2',
    centerYExpr: 'height / 2',
    marginTopExpr: 'marginTop',
    marginLeftExpr: 'marginLeft',
    heightMinusBottomExpr: 'Math.max(marginTop, height - marginBottom)',
    widthMinusRightExpr: 'Math.max(marginLeft, width - marginRight)',
  };

  // -- per-child data preparation --
  const prepared = children.map((child, i) => {
    let encodingIn = unescapeEncodingFields(child.encoding || {});
    const geoChannel = GEO_CHANNELS.find(k => k in encodingIn);
    if (geoChannel) {
      if (!ignoreUnsupported) {
        throw new Error(
          `Unsupported: geographic encoding ("${geoChannel}") is not yet supported by vl2d3 -- ` +
            'no map projection support'
        );
      }
      // No map projection -- plot longitude/latitude directly as a plain
      // quantitative x/y scatter instead (an unprojected, but still
      // spatially-ordered, approximation), unless the view already has its
      // own x/y (kept as-is then).
      encodingIn = {...encodingIn};
      if (!encodingIn.x && encodingIn.longitude) encodingIn.x = {field: encodingIn.longitude.field, type: 'quantitative'};
      if (!encodingIn.y && encodingIn.latitude) encodingIn.y = {field: encodingIn.latitude.field, type: 'quantitative'};
      for (const k of GEO_CHANNELS) delete encodingIn[k];
      b(`// vl2d3: unsupported geographic encoding ("${geoChannel}"), plotting longitude/latitude as an unprojected quantitative x/y scatter instead (--ignore-unsupported)`);
    }

    const dataVar = `data${i + 1}`;
    if (dataParam && !child.data) {
      // Rows for this panel are already loaded, wrapper-transformed, and
      // split down to this one facet value's own subset by the runtime
      // facet orchestrator (see buildRuntimeFacetPanels()) -- no separate
      // load of this panel's own copy needed (or, for a URL source,
      // possible at all: the distinct facet values themselves are only
      // knowable once that shared load has actually happened). Applies to
      // every layer child lacking its own `data` (not just the first,
      // `i === 0`) -- a multi-layer facet template (e.g.
      // facet_bullet.vl.json's own 6-layer bullet-chart spec, none of
      // whose layers declare their own `data`) previously left every
      // layer *after* the first with an empty dataset instead (the
      // `renderDataLoad(undefined, ...)` fallback in the `else` branch
      // below), rendering only that one layer.
      b(`let ${dataVar} = ${dataParam};`);
    } else {
      const {statements: loadStmts} = renderDataLoad(child.data, dataVar, ignoreUnsupported);
      loadStmts.forEach(b);
    }

    if (invalidHandlingMode(root, child.mark) === 'filter') {
      renderInvalidFilter(dataVar, collectInvalidFilterFields(encodingIn, child.transform, pathContinuityChannels(child.mark))).forEach(b);
    } else {
      renderInvalidZeroFill(dataVar, collectInvalidZeroFillFields(encodingIn, child.transform, pathContinuityChannels(child.mark))).forEach(b);
    }

    const temporalFields = collectTemporalFields(encodingIn, child.transform || []);
    renderTemporalCoercion(dataVar, temporalFields).forEach(b);

    if (child.transform) renderTransforms(child.transform, dataVar, ignoreUnsupported).forEach(b);

    const {statements: bracketStmts, encoding: encodingAfterBracket} = flattenBracketFields(encodingIn, dataVar);
    bracketStmts.forEach(b);
    // A bracket/nested-path field (`ranges[2]`, `record.low`, ...) couldn't
    // be invalid-filtered above -- the raw field lookup collectInvalidFilterFields()
    // would have built is meaningless before flattenBracketFields() has
    // even run -- so it's filtered now instead, against the real flat
    // field flattening just produced, using the exact same channel-type/
    // path-continuity rules (a null/NaN nested value doesn't crash on its
    // own -- flattenBracketFields()'s own `== null ? null : ...` chain
    // already produces a plain `null` -- but left through unfiltered, it
    // still reaches a scale as `NaN`, e.g. bar_layered_weather.vl.json's
    // own sparse `forecast.*` fields on days with no forecast yet).
    if (invalidHandlingMode(root, child.mark) === 'filter') {
      const flattenedChannels = Object.keys(encodingIn).filter(
        ch => encodingIn[ch] !== encodingAfterBracket[ch] && encodingAfterBracket[ch] && encodingAfterBracket[ch].field
      );
      const flattenedEncoding = Object.fromEntries(flattenedChannels.map(ch => [ch, encodingAfterBracket[ch]]));
      renderInvalidFilter(
        dataVar,
        collectInvalidFilterFields(flattenedEncoding, child.transform, pathContinuityChannels(child.mark))
      ).forEach(b);
    }
    encodingIn = encodingAfterBracket;

    const {statements: prepStmts, encoding: encodingAfterPrep} = prepareEncoding(encodingIn, dataVar, ignoreUnsupported);
    prepStmts.forEach(b);

    let encoding = encodingAfterPrep;
    const stackPlan = planStacking(child.mark, encoding);
    if (stackPlan) {
      renderStackingStatements(dataVar, stackPlan).forEach(b);
      encoding = applyStackingToEncoding(encoding, stackPlan);
    }

    return {dataVar, encoding, originalEncoding: encodingIn, mark: child.mark, stackPlan, extentParams: collectExtentParams(child.transform)};
  });
  lines.push('');

  const allDataExpr = prepared.length > 1 ? `[${prepared.map(p => `...${p.dataVar}`).join(', ')}]` : prepared[0].dataVar;

  // -- shared scales --
  const scales = {};

  for (const channel of ['x', 'y']) {
    // `.find(d => d && (d.field || d.datum !== undefined))`, not `.find(Boolean)`: the first layer
    // declaring this channel at all commonly binds it to a literal
    // `{"value": ...}` instead of a real field (e.g.
    // layer_ranged_dot.vl.json's own line layer, `color: {"value":
    // "#db646f"}`) while a *later* layer needs a real scale for the same
    // channel (that same spec's point layer, `color: {"field": "year",
    // ...}`) -- `.find(Boolean)` would grab the first (valueless) def,
    // hit the `'value' in def` check below, and skip building a scale for
    // the whole chart, silently leaving the later layer's own real field
    // unscaled (its raw field value spliced in as a color/size/etc
    // literal instead).
    const def = prepared.map(p => p.encoding[channel]).find(d => d && (d.field || d.datum !== undefined));
    if (!def || 'value' in def) continue;
    // Layers sharing this scale can each declare the channel against a
    // *different* source field (e.g. a reference-band layer's own `x:
    // {field: "start"}` sharing an axis with the main series' `x: {field:
    // "year"}`) -- applying one layer's field name across every layer's
    // combined rows (the plain `dataVar: allDataExpr` path below) would
    // silently find `undefined` for every row except that one layer's own,
    // extent-ing over only its range rather than the true union. Detected
    // generally (not just "do the field names differ"): whenever more than
    // one prepared child actually declares this channel with a field, each
    // is mapped down to its own values *before* combining, so the
    // resulting domain always spans every layer correctly regardless of
    // whether their field names happen to match.
    const declaringChildren = prepared.filter(p => p.encoding[channel] && p.encoding[channel].field);
    // A stacked child's own field is the stack *top* -- for zero/normalize
    // stacking that alone still bounds the domain correctly (the baseline
    // never goes below 0, already covered by zeroBaseline below), but a
    // "center" stack's baseline can be more negative than any row's own
    // top, so that child's stack-baseline field needs unioning in too, or
    // the low end of a streamgraph gets silently clipped.
    const valuesExprsFor = p => {
      const stack = p.stackPlan && p.stackPlan.posChannel === channel ? p.stackPlan : null;
      if (stack) {
        return [
          `${p.dataVar}.map(d => d[${JSON.stringify(`${stack.valueField}_stack0`)}])`,
          `${p.dataVar}.map(d => d[${JSON.stringify(`${stack.valueField}_stack1`)}])`,
        ];
      }
      const exprs = [`${p.dataVar}.map(d => d[${JSON.stringify(p.encoding[channel].field)}])`];
      // A companion `${channel}2` range (e.g.
      // stacked_bar_population_transform.vl.json's own explicit top-level
      // `stack` *transform*, `y: {field: "v1"}` + `y2: {field: "v2"}` --
      // distinct from planStacking()'s own *implicit* per-mark stacking,
      // excluded above, but just as real a range) needs unioning into the
      // domain too, whenever it has its own field -- otherwise the domain
      // only ever sees this channel's own (start) values, silently
      // clipping off whichever end of the range v2 alone reaches further
      // than v1 ever does (e.g. a normalized [0, 1] stack's own top edge).
      const companionDef = p.encoding[`${channel}2`];
      if (companionDef && companionDef.field) {
        exprs.push(`${p.dataVar}.map(d => d[${JSON.stringify(companionDef.field)}])`);
      }
      return exprs;
    };
    const needsCombining =
      declaringChildren.length > 1 ||
      declaringChildren.some(p => (p.stackPlan && p.stackPlan.posChannel === channel) || (p.encoding[`${channel}2`] && p.encoding[`${channel}2`].field));
    const combinedValuesExpr = needsCombining
      ? `[].concat(${declaringChildren.flatMap(valuesExprsFor).join(', ')})`
      : null;
    // Whether *this* channel is some bar/area layer's own zero-anchored
    // VALUE axis -- per-channel (not one flag shared across x and y), and
    // only counting a layer where this is actually that layer's value
    // axis (matching renderArea's own "xIsValue/yIsValue/horizontal"
    // orientation convention, marks.js: y is the value axis unless x is
    // quantitative and y isn't) with no explicit x2/y2 companion range of
    // its own already (wheat_wages.vl.json's own binned `x`/`x2` bar
    // layer, e.g., already has a real range on x -- forcing 0 into x's
    // shared domain too, on the strength of that same layer's bar mark,
    // squeezed the whole 1565-1820 chart into a sliver at the domain's
    // far end instead of the bin edges alone bounding it. Naively
    // excluding x from EVERY bar/area layer whenever it lacks its own
    // x2/y2 -- rather than checking which axis is the value one -- would
    // in turn wrongly exclude a plain, un-ranged area/bar's actual value
    // axis too, e.g. this same spec's `area`-marked wages layer, which has
    // no y2 either but still needs its own zero baseline).
    const zeroBaseline = prepared.some(p => {
      if (!isBarOrArea(p.mark) || !p.encoding[channel] || p.encoding[`${channel}2`]) return false;
      const xIsValue = p.encoding.x && p.encoding.x.type === 'quantitative';
      const yIsValue = p.encoding.y && p.encoding.y.type === 'quantitative';
      const valueChannel = xIsValue && !yIsValue ? 'x' : 'y';
      return channel === valueChannel;
    });
    // A temporal field standing in as a bar/area's own *category* axis
    // (dodged/binned bars, one per distinct date) rather than its value
    // axis -- padded so the first/last bar isn't centered flush on the
    // domain's own edge and clipped (see paddedTemporalDomain in scales.js).
    // Not needed when this channel already has its own x2/y2 companion (a
    // real bin/box range already positions the bar without any center-based
    // estimate to straddle past the edge). Checked independently of
    // `zeroBaseline` above (that flag is only ever true for the OTHER,
    // quantitative channel in this exact shape -- a temporal channel can
    // never itself be zero-baselined, so `zeroBaseline && def.type ===
    // "temporal"` can never be true and this padding could never actually
    // fire -- confirmed via bar_binned_yearmonth_grouped.vl.json's own
    // dodged bars getting clipped at both domain edges with no padding at
    // all).
    const categoryPadding =
      def.type === 'temporal' &&
      !prepared.some(p => p.encoding[`${channel}2`]) &&
      prepared.some(p => {
        if (!isBarOrArea(p.mark) || !p.encoding[channel]) return false;
        const otherChannel = channel === 'x' ? 'y' : 'x';
        return p.encoding[otherChannel] && p.encoding[otherChannel].type === 'quantitative';
      });
    const scale = resolvePositionScale(channel, def, {
      dataVar: allDataExpr,
      rangeExpr: dims[`${channel}RangeExpr`],
      zeroBaseline: zeroBaseline && def.type === 'quantitative',
      ignoreUnsupported,
      combinedValuesExpr,
      categoryPadding,
    });
    b(scale.decl);
    scales[channel] = scale;
  }
  for (const [channel, resolver] of [
    ['color', resolveColorScale],
    ['size', resolveSizeScale],
    ['opacity', resolveOpacityScale],
    ['shape', resolveShapeScale],
    ['radius', resolveRadiusScale],
  ]) {
    // `.find(d => d && (d.field || d.datum !== undefined))`, not `.find(Boolean)`: the first layer
    // declaring this channel at all commonly binds it to a literal
    // `{"value": ...}` instead of a real field (e.g.
    // layer_ranged_dot.vl.json's own line layer, `color: {"value":
    // "#db646f"}`) while a *later* layer needs a real scale for the same
    // channel (that same spec's point layer, `color: {"field": "year",
    // ...}`) -- `.find(Boolean)` would grab the first (valueless) def,
    // hit the `'value' in def` check below, and skip building a scale for
    // the whole chart, silently leaving the later layer's own real field
    // unscaled (its raw field value spliced in as a color/size/etc
    // literal instead).
    // `fill`/`stroke` (e.g. bar_grouped_custom_color_domain.vl.json's own
    // `fill: {field: "group", scale: {domain: [...]}}`) are Vega-Lite's
    // own more specific alternatives to the generic `color` channel --
    // same shared "color" scale either way (marks.js's fillExpr() already
    // falls back to `encoding.fill` the same way), just building it from
    // whichever of the three a layer actually declares.
    const def =
      channel === 'color'
        ? prepared.map(p => p.encoding.color || p.encoding.fill || p.encoding.stroke).find(d => d && (d.field || d.datum !== undefined))
        : prepared.map(p => p.encoding[channel]).find(d => d && (d.field || d.datum !== undefined));
    // `"scale": null` is Vega-Lite's own "use the raw field value directly
    // as the visual channel value, no mapping at all" escape hatch (e.g. a
    // `color` field that already holds real CSS color strings). Building no
    // scale at all here (leaving `scales[channel]` unset) makes
    // accessor()/fillExpr() in marks.js fall back to their own existing
    // "no scale resolved for this channel" case -- a bare field reference --
    // which is exactly this behavior, with no separate code path needed.
    if (!def || 'value' in def || def.scale === null) continue;
    // A `datum`-only def (no `field` at all, e.g. bar_grouped_repeated.vl
    // .json's own per-repeated-layer `color: {datum: {"repeat": "layer"}}`,
    // substituted to a literal constant per layer) has no column for the
    // resolver's own domain-from-data logic to read -- each layer's own
    // literal value is already known at this point, so the domain is built
    // directly from every layer sharing this channel's own `datum` instead.
    const effectiveDef =
      def.field === undefined && def.datum !== undefined
        ? {
            ...def,
            scale: {
              ...def.scale,
              domain: [
                ...new Set(
                  prepared
                    .map(p => (channel === 'color' ? p.encoding.color || p.encoding.fill || p.encoding.stroke : p.encoding[channel]))
                    .filter(d => d && d.datum !== undefined)
                    .map(d => d.datum)
                ),
              ],
            },
          }
        : def;
    // `config.scale.invalid.<channel>.value` (e.g.
    // bar_invalid_color_show_override.vl.json) overrides what a null raw
    // value maps to for this channel -- only reachable when
    // `config.mark.invalid` is "show" (the default "filter" drops that row
    // before any scale sees it, making this a harmless no-op either way).
    const invalidOverride = root.config && root.config.scale && root.config.scale.invalid && root.config.scale.invalid[channel]
      ? root.config.scale.invalid[channel].value
      : undefined;
    const scale = resolver(effectiveDef, {
      dataVar: allDataExpr,
      ignoreUnsupported,
      invalidOverride,
      rangeExpr: `Math.min(${dims.innerWidthExpr}, ${dims.innerHeightExpr}) / 2`,
    });
    b(scale.decl);
    scales[channel] = scale;
  }
  // A dodged/grouped position offset only has a band to nest inside when
  // its own position channel (x for xOffset, y for yOffset) resolved to a
  // real band scale -- otherwise there's no bandwidth to sub-divide, so it's
  // left unhandled (dropped, same as before this offset support existed).
  for (const [offsetChannel, posChannel] of [['xOffset', 'x'], ['yOffset', 'y']]) {
    const def = prepared.map(p => p.encoding[offsetChannel]).find(Boolean);
    const outerScale = scales[posChannel];
    // A quantitative xOffset/yOffset is Vega-Lite's *other* use of this
    // channel -- per-row jitter by a continuous value, added directly as a
    // pixel nudge -- not the dodge/grouped-band case resolveOffsetScale()
    // builds for; there's no finite "distinct group" domain to band over
    // (every row can have its own value), so this is left unhandled
    // (dropped, same as before this offset support existed) rather than
    // building a degenerate one-slot-per-row scale.
    if (!def || 'value' in def || def.type === 'quantitative' || !outerScale || (outerScale.kind !== 'band' && outerScale.kind !== 'ambiguous')) continue;
    // A DEFAULT floor of 1px (not just an explicit `config.bar.minBandSize`
    // override, see resolveOffsetScale()'s own comment) even with no config
    // at all -- with enough distinct offset values sharing one outer band
    // (e.g. bar_grouped_thin.vl.json's own ~3000 movie titles), the
    // *natural* dodge sub-band shrinks to a small fraction of a device
    // pixel, which real Vega-Lite's own canvas renderer still shows
    // (sub-pixel coverage antialiasing draws *something*) but this
    // project's SVG output renders as fully, literally invisible --
    // clamping to a minimum of 1 keeps every group's own bar visible here
    // too, at the cost of legitimately overflowing past its own outer
    // band's slot in this extreme-cardinality case (matching, not
    // worsening, what real Vega-Lite's own rendering looks like there).
    const minBandSize =
      root.config && root.config.bar && typeof root.config.bar.minBandSize === 'number' ? root.config.bar.minBandSize : 1;
    // A `datum`-only offset def (no `field`, e.g. bar_grouped_repeated.vl
    // .json's own per-repeated-layer `xOffset: {datum: {"repeat":
    // "layer"}}`) has no column to derive a domain from -- built directly
    // from every layer's own literal `datum` instead, same as the shared
    // color/size/opacity/shape/radius loop just above.
    const explicitDatumDomain =
      def.field === undefined && def.datum !== undefined
        ? [...new Set(prepared.map(p => p.encoding[offsetChannel]).filter(d => d && d.datum !== undefined).map(d => d.datum))]
        : undefined;
    const scale = resolveOffsetScale(offsetChannel, def, {dataVar: allDataExpr, outerScale, minBandSize, explicitDomain: explicitDatumDomain});
    b(scale.decl);
    scales[offsetChannel] = scale;
  }
  lines.push('');

  // -- svg root --
  b('const svg = d3.select(container).append("svg")');
  b('    .attr("width", width)');
  b('    .attr("height", height)');
  b('    .attr("viewBox", [0, 0, width, height])');
  b('    .attr("style", "max-width: 100%; height: auto;");');
  lines.push('');

  if (root.title) {
    const titleText = typeof root.title === 'string' ? root.title : root.title.text;
    b('svg.append("text")');
    b(`    .attr("x", width / 2)`);
    b(`    .attr("y", marginTop / 2)`);
    b(`    .attr("text-anchor", "middle")`);
    b(`    .attr("font-size", "14px")`);
    b(`    .attr("font-weight", "bold")`);
    b(`    .text(${formatValue(titleText)});`);
    lines.push('');
  }

  // -- axes --
  const xDef = prepared.map(p => p.encoding.x).find(Boolean);
  const yDef = prepared.map(p => p.encoding.y).find(Boolean);
  const xLabelDef = prepared.map(p => p.originalEncoding.x).find(Boolean);
  const yLabelDef = prepared.map(p => p.originalEncoding.y).find(Boolean);
  if (scales.x && !(xDef && xDef.axis === null)) {
    b('svg.append("g")');
    b('    .attr("transform", `translate(0,${height - marginBottom})`)');
    b('    .call(d3.axisBottom(x));');
    const label = xLabelDef && (xLabelDef.title || xLabelDef.field);
    if (label) {
      b('svg.append("text")');
      b('    .attr("x", width - marginRight)');
      b('    .attr("y", height - marginBottom - 6)');
      b('    .attr("text-anchor", "end")');
      b('    .attr("font-size", "11px")');
      b(`    .text(${formatValue(label)});`);
    }
    lines.push('');
  }
  if (scales.y && !(yDef && yDef.axis === null)) {
    b('svg.append("g")');
    b('    .attr("transform", `translate(${marginLeft},0)`)');
    b('    .call(d3.axisLeft(y));');
    const label = yLabelDef && (yLabelDef.title || yLabelDef.field);
    if (label) {
      b('svg.append("text")');
      b('    .attr("x", 6)');
      b('    .attr("y", marginTop - 6)');
      b('    .attr("font-size", "11px")');
      b(`    .text(${formatValue(label)});`);
    }
    lines.push('');
  }

  // -- marks --
  for (const p of prepared) {
    const markType = typeof p.mark === 'string' ? p.mark : p.mark.type;
    // `config.<markType>` (e.g. area_horizon.vl.json's own `config: {area:
    // {interpolate: "monotone"}}`) supplies a *default* for any mark
    // property this specific mark doesn't itself override -- merged in
    // underneath the mark's own explicit properties (which always win),
    // and applied even when the mark was given as a bare type string (no
    // object at all) -- always normalized to an object below so a
    // config-only property (no per-mark override anywhere) still reaches
    // markProps rather than being silently dropped by renderMark()'s own
    // "a string mark has no properties at all" shortcut.
    const configDefaults = (root.config && root.config[markType]) || {};
    const mark =
      typeof p.mark === 'string'
        ? {type: p.mark, ...configDefaults}
        : {...configDefaults, ...p.mark, ...resolveMarkPropExprs(p.mark, paramValues)};
    let markCode = renderMark(mark, p.encoding, scales, dims, p.dataVar, ignoreUnsupported, p.extentParams);
    if (!/[;}]\s*$/.test(markCode)) markCode += ';';
    lines.push(markCode.replace(/^/gm, '  '));
    lines.push('');
  }

  // -- basic categorical color legend --
  // `legend: null` (e.g. concat_population_pyramid.vl.json's own Female/Male
  // bar layers, which already show gender via the panel titles) is Vega-
  // Lite's explicit opt-out for a channel that would otherwise get one.
  const colorLegendDef = prepared.map(p => p.encoding.color || p.encoding.fill || p.encoding.stroke).find(Boolean);
  if (scales.color && scales.color.kind === 'ordinal' && !(colorLegendDef && colorLegendDef.legend === null)) {
    // A cyclic-timeUnit color channel (prepare.js's `ordinalTimeUnit`, e.g.
    // line_quarter_legend.vl.json's `color: {timeUnit: "quarter", ...}`)
    // still holds real Date values, not display-ready strings -- shown as
    // "Q1"/"Jan"/etc (cyclicLabelExpr(), timeunit.js) instead of a raw
    // `Date.toString()`, matching Vega-Lite's own legend labels.
    const colorDef = colorLegendDef;
    const labelExpr = colorDef && colorDef.ordinalTimeUnit ? cyclicLabelExpr(colorDef.ordinalTimeUnit, 'd') : null;
    b('{');
    b('  const legend = svg.append("g").attr("transform", `translate(${width - marginRight - 100},${marginTop})`);');
    b('  const entries = color.domain();');
    b('  const rows = legend.selectAll("g").data(entries).join("g")');
    b('      .attr("transform", (d, i) => `translate(0,${i * 16})`);');
    b('  rows.append("rect").attr("width", 10).attr("height", 10).attr("fill", d => color(d));');
    b(`  rows.append("text").attr("x", 14).attr("y", 9).attr("font-size", "10px").text(d => ${labelExpr || 'd'});`);
    b('}');
    lines.push('');
  }

  b('return svg.node();');
  return lines;
}

function buildFunction(fnName, bodyLines, prefix = '', extraParams = []) {
  const params = ['container', 'options = {}', ...extraParams].join(', ');
  return [`${prefix}async function ${fnName}(${params}) {`, ...bodyLines, '}', ''];
}

// Recursively substitute a `{"repeat": "row"|"column"|"repeat"}` value
// (Vega-Lite's placeholder for "the field name currently being repeated")
// anywhere it appears in a repeated child spec, with the literal field name
// for this particular repetition.
function substituteRepeatPlaceholders(node, values) {
  if (Array.isArray(node)) return node.map(n => substituteRepeatPlaceholders(n, values));
  if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    if (keys.length === 1 && keys[0] === 'repeat' && typeof node.repeat === 'string' && node.repeat in values) {
      return values[node.repeat];
    }
    const out = {};
    for (const k of keys) out[k] = substituteRepeatPlaceholders(node[k], values);
    return out;
  }
  return node;
}

// Reduce a top-level composition (concat/hconcat/vconcat/repeat/facet) down
// to a flat list of independent child unit-or-layer specs plus a rough
// layout direction, so each can be rendered by its own
// buildUnitOrLayerBody() call and mounted side by side -- a real sacrifice
// (no shared/aligned scales across panels, and facet/repeat need the
// distinct grouping values knowable *now*, at code-generation time) but
// still a rendered chart rather than none at all.
function getCompositionChildren(root, compositionKey) {
  const wrapper = {data: root.data, transform: root.transform, encoding: root.encoding};

  if (compositionKey === 'hconcat') return {children: root.hconcat.map(c => mergeDown(c, wrapper)), direction: 'row'};
  if (compositionKey === 'vconcat') return {children: root.vconcat.map(c => mergeDown(c, wrapper)), direction: 'column'};
  if (compositionKey === 'concat') return {children: root.concat.map(c => mergeDown(c, wrapper)), direction: 'wrap'};

  if (compositionKey === 'repeat') {
    const rep = root.repeat;
    if (Array.isArray(rep)) {
      const children = rep.map(v => mergeDown(substituteRepeatPlaceholders(root.spec, {repeat: v}), wrapper));
      return {children, direction: 'wrap'};
    }
    const rows = rep.row || [null];
    const cols = rep.column || [null];
    const children = [];
    for (const r of rows) {
      for (const c of cols) {
        children.push(mergeDown(substituteRepeatPlaceholders(root.spec, {row: r, column: c}), wrapper));
      }
    }
    const direction = rep.row && rep.column ? 'grid' : rep.row ? 'column' : 'row';
    return {children, direction};
  }

  // facet
  const facetDef = root.facet;
  const dataValues = (root.spec && root.spec.data && root.spec.data.values) || (root.data && root.data.values);
  if (facetDef && facetDef.field && Array.isArray(dataValues)) {
    const distinct = [...new Set(dataValues.map(d => d[facetDef.field]))];
    const children = distinct.map(v =>
      mergeDown(
        {
          ...root.spec,
          transform: [...(root.spec.transform || []), {filter: `datum[${JSON.stringify(facetDef.field)}] === ${JSON.stringify(v)}`}],
          title: root.spec.title || String(v),
        },
        wrapper
      )
    );
    return {children, direction: 'wrap'};
  }
  // Can't determine the distinct facet values at generation time (data is
  // URL-sourced, or this is a row/column facet mapping) -- fall back to one
  // combined view of all the data, ignoring the facet split entirely.
  return {
    children: [mergeDown(root.spec, wrapper)],
    direction: 'row',
    note: 'unsupported facet (distinct facet values not known at code-generation time), rendering one combined view of all the data instead',
  };
}

// Vega-Lite's `facet` operator has two equivalent shapes: a flat single
// field (`facet: {field, ...}`, faceting a wrapped grid) or a row/column
// mapping (`facet: {row: {field, ...}}` and/or `{column: {field, ...}}`,
// laying panels out in that one direction) -- normalized here to a single
// field def plus a layout direction, or null if the shape doesn't resolve
// to a single facetable field at all (e.g. a `facet: {row, column}` 2D
// grid, or a malformed spec) -- callers fall back to the generic (fully
// unsupported) composition handling in that case.
function normalizeFacetDef(facetDef) {
  if (!facetDef) return null;
  if (facetDef.field) return {def: facetDef, direction: 'wrap'};
  // Both row AND column at once (trellis_row_column.vl.json's own shape) --
  // a real two-dimensional grid, not just a single-dimension strip. Kept
  // distinct from the single-axis cases below (each wants its own row def
  // as `def`, not a {row, column} pair) since buildRuntimeFacetPanels()
  // needs to know up front which shape it's building.
  if (facetDef.row && facetDef.row.field && facetDef.column && facetDef.column.field) {
    return {def: {row: facetDef.row, column: facetDef.column}, direction: 'grid'};
  }
  if (facetDef.row && facetDef.row.field && !facetDef.column) return {def: facetDef.row, direction: 'column'};
  if (facetDef.column && facetDef.column.field && !facetDef.row) return {def: facetDef.column, direction: 'row'};
  return null;
}

// A genuine, *runtime* facet split -- unlike getCompositionChildren()'s own
// facet handling (which needs the distinct facet values already knowable
// at code-generation time, from an inline `values` array, and only
// understands the flat `facet: {field}` shape), this works for any data
// source (including a URL, fetched only once the generated function
// actually runs) and both facet shapes, at the cost of a documented
// simplification: every panel shares one generic text header (the raw or
// timeUnit'd facet value) rather than Vega-Lite's own fully templated
// header (labelExpr, format, title, ...).
// A `{"step": N}` per-category width/height (e.g. facet_grid_bar.vl.json's
// own `"height": {"step": 8}`, one thin 8px-per-category row strip per
// panel) -- unlike a plain pixel number, this has no fixed value at all
// until the *panel's own* band-scale channel's distinct-value count is
// known, which (for a runtime-split facet panel) only happens once that
// panel's own rows have actually been filtered out -- so this returns
// `const` statements to emit *inside* the per-panel loop (right before
// invoking the template, referencing that iteration's own rows variable)
// alongside the object-literal fragment (e.g. `"height: __panelHeight,
// ...(__panelHeight < 50 ? {...} : {})"`) to splice into panelOptionsExpr,
// rather than a static value computable once up front the way a plain
// number already is.
function stepPanelDimsCode(templateEncoding, sizeSpecSource, rowsVar) {
  const statements = [];
  const fragments = [];
  const axes = [
    {prop: 'width', channel: 'x', varName: '__panelWidth', marginA: 'marginLeft', marginB: 'marginRight', factorA: 0.3, factorB: 0.1},
    {prop: 'height', channel: 'y', varName: '__panelHeight', marginA: 'marginTop', marginB: 'marginBottom', factorA: 0.3, factorB: 0.4},
  ];
  for (const {prop, channel, varName, marginA, marginB, factorA, factorB} of axes) {
    const sizeSpec = sizeSpecSource[prop];
    if (!sizeSpec || typeof sizeSpec !== 'object' || typeof sizeSpec.step !== 'number') continue;
    const channelDef = templateEncoding && templateEncoding[channel];
    if (!channelDef || !channelDef.field) continue;
    statements.push(
      `const ${varName} = ${formatValue(sizeSpec.step)} * new d3.InternSet(${rowsVar}.map(d => d[${JSON.stringify(channelDef.field)}])).size;`
    );
    fragments.push(
      `${prop}: ${varName}, ...(${varName} < 50 ? {${marginA}: Math.max(1, Math.round(${varName} * ${formatValue(factorA)})), ${marginB}: Math.max(1, Math.round(${varName} * ${formatValue(factorB)}))} : {})`
    );
  }
  return {statements, fragments};
}

function buildRuntimeFacetPanels(root, facetInfo, fnName, ignoreUnsupported, prefix = '') {
  const {def: facetDef, direction} = facetInfo;
  if (direction === 'grid') return buildRuntimeFacetGrid(root, facetDef, fnName, ignoreUnsupported, prefix);
  const lines = [];

  // The shared per-panel template: one real function, called once per
  // distinct facet value below with that value's own pre-filtered rows --
  // not a separate statically-generated copy per value (which would need
  // knowing the values in advance, the very thing a URL data source rules
  // out). Own encoding merges down from the facet wrapper the same way any
  // other composition's children do; wrapper `transform` is deliberately
  // NOT re-merged in here (already applied once, up front, to the shared
  // data below -- reapplying it per panel would run it again on top of its
  // own prior output).
  const templateSpec = {...root.spec};
  if (root.encoding) templateSpec.encoding = {...root.encoding, ...(templateSpec.encoding || {})};

  // color/size/opacity are data-driven scales -- built fresh inside the
  // template function from whatever data it's called with. Called with
  // only one panel's own rows, that would compute a domain from just THAT
  // panel's own distinct values (e.g. a `row: {field: "gender"}` facet's
  // "Female" panel only ever seeing "Female"), mapping it to the same first
  // scale output in every panel regardless of which value it actually is.
  // Instead, thread in a domain already computed from the full, unsplit
  // facet data as an extra parameter, so every panel's scale agrees on the
  // same value -> output mapping (see sharedChannelDomainExpr in scales.js
  // and its `__vl2dRawExpr` marker, read by explicitDomainCode()).
  //
  // x/y are included too -- Vega-Lite's own *default* facet behavior is a
  // SHARED position scale across every panel (matching axes so panels stay
  // visually comparable), only becoming independent per panel when
  // `resolve: {scale: {x/y: "independent"}}` explicitly says so (e.g.
  // bar_grouped_facet_independent_scale_fixed_width.vl.json's own `x:
  // "independent"` -- deliberately leaving `y` OFF that list, so y stays
  // shared). Restricted to quantitative/temporal defs: an ordinal/nominal
  // or type-ambiguous position channel's own scale KIND (band vs point, or
  // -- for the ambiguous case -- band vs continuous at all) is decided at
  // a different point in resolvePositionScale() that doesn't consult this
  // injected domain, so sharing wouldn't actually take effect for those
  // (a separate gap, not attempted here).
  const resolveScale = (root.resolve && root.resolve.scale) || {};
  const templateMark = typeof templateSpec.mark === 'string' ? templateSpec.mark : templateSpec.mark && templateSpec.mark.type;
  const positionValueChannel = (() => {
    const enc = templateSpec.encoding || {};
    const xIsValue = enc.x && enc.x.type === 'quantitative';
    const yIsValue = enc.y && enc.y.type === 'quantitative';
    return xIsValue && !yIsValue ? 'x' : 'y';
  })();
  const sharedDomainChannels = ['color', 'shape', 'size', 'opacity', 'x', 'y'].filter(ch => {
    const def = templateSpec.encoding && templateSpec.encoding[ch];
    if (!def || !def.field || (def.scale && def.scale.domain !== undefined)) return false;
    if (ch === 'x' || ch === 'y') {
      if (def.type !== 'quantitative' && def.type !== 'temporal') return false;
      if (resolveScale[ch] === 'independent') return false;
    }
    return true;
  });
  const sharedDomainVars = {};
  const sharedDomainDefs = {};
  const sharedDomainZeroBaseline = {};
  for (const ch of sharedDomainChannels) {
    const varName = `__facet${ch[0].toUpperCase()}${ch.slice(1)}Domain`;
    sharedDomainVars[ch] = varName;
    const def = templateSpec.encoding[ch];
    sharedDomainDefs[ch] = def;
    if ((ch === 'x' || ch === 'y') && isBarOrArea(templateMark) && !templateSpec.encoding[`${ch}2`] && ch === positionValueChannel) {
      sharedDomainZeroBaseline[ch] = true;
    }
    templateSpec.encoding = {
      ...templateSpec.encoding,
      [ch]: {...def, scale: {...(def.scale || {}), domain: {__vl2dRawExpr: varName}}},
    };
  }

  const templateName = `${fnName}_facetTemplate`;
  lines.push(
    ...buildFunction(templateName, buildUnitOrLayerBody(templateSpec, ignoreUnsupported, '__facetRows'), '', [
      '__facetRows',
      ...sharedDomainChannels.map(ch => sharedDomainVars[ch]),
    ])
  );

  const body = [];
  const b = s => body.push('  ' + s);
  b(
    `// vl2d3: unsupported top-level composition "facet", splitting the shared data by facet value at ` +
      `runtime instead of code-generation time -- each panel shows a plain text header (the raw/timeUnit'd ` +
      `facet value), not Vega-Lite's own fully templated header (--ignore-unsupported)`
  );
  const {statements: loadStmts} = renderDataLoad(root.data, 'facetData', ignoreUnsupported);
  loadStmts.forEach(b);

  const wrapperTransform = root.transform || [];
  const transformTemporalFields = collectTemporalFields({}, wrapperTransform);
  const facetIsTemporal = Boolean(facetDef.timeUnit) || facetDef.type === 'temporal';
  // A shared x/y domain computed from `facetData` (sharedDomainChannels
  // above) needs that channel's own field already coerced to a real Date
  // -- unlike a channel referenced by the wrapper's own transform (already
  // covered by transformTemporalFields) or the facet field itself, a plain
  // `x: {field: "date", type: "temporal"}` with no wrapper-transform
  // reference wouldn't otherwise be coerced until *inside* the per-panel
  // template function, well after this shared domain is computed --
  // `d3.extent()` over still-raw date strings/numbers gives a lexicographic
  // (wrong) extent instead of a real chronological one, which then feeds
  // an Invalid-Date/NaN position into every panel's own scale.
  const sharedTemporalFields = sharedDomainChannels
    .filter(ch => (ch === 'x' || ch === 'y') && sharedDomainDefs[ch].type === 'temporal')
    .map(ch => sharedDomainDefs[ch].field);
  const temporalFields = [
    ...new Set([...transformTemporalFields, ...(facetIsTemporal ? [facetDef.field] : []), ...sharedTemporalFields]),
  ];
  renderTemporalCoercion('facetData', temporalFields).forEach(b);
  if (wrapperTransform.length) renderTransforms(wrapperTransform, 'facetData', ignoreUnsupported).forEach(b);

  for (const ch of sharedDomainChannels) {
    b(`const ${sharedDomainVars[ch]} = ${sharedChannelDomainExpr(ch, sharedDomainDefs[ch], 'facetData', sharedDomainZeroBaseline[ch])};`);
  }

  const keyExpr = facetDef.timeUnit
    ? timeUnitExpr(facetDef.timeUnit, `d[${JSON.stringify(facetDef.field)}]`, ignoreUnsupported)
    : `d[${JSON.stringify(facetDef.field)}]`;
  b(`facetData = facetData.map(d => ({...d, "__facetKey": ${keyExpr}}));`);
  b(`const __facetGroups = Array.from(d3.group(facetData, d => d["__facetKey"]), ([key, rows]) => ({key, rows}));`);
  // An explicit `sort: {field: ...}` orders panels by that field's value
  // (e.g. a precomputed "display order" column) rather than the facet
  // key's own natural order -- any row within a group carries the same
  // value for it, so the first row is as good as any to sort by.
  if (facetDef.sort && typeof facetDef.sort === 'object' && facetDef.sort.field) {
    const sortField = facetDef.sort.field;
    b(
      `__facetGroups.sort((a, b) => d3.ascending(a.rows[0][${JSON.stringify(sortField)}], b.rows[0][${JSON.stringify(sortField)}]));`
    );
  } else if (facetDef.sort === 'descending') {
    b(`__facetGroups.sort((a, b) => d3.descending(a.key, b.key));`);
  } else {
    b(`__facetGroups.sort((a, b) => d3.ascending(a.key, b.key));`);
  }

  const flexStyle =
    direction === 'column' ? 'flex-direction: column;' : direction === 'row' ? 'flex-direction: row;' : 'flex-wrap: wrap;';
  // Each panel gets its own width/height from the per-view spec (e.g.
  // trellis_area_seattle's `spec: {width: 800, height: 25}`, one thin
  // strip per facet value) when given, rather than every panel silently
  // falling back to the same default 640x400 the outer chart itself would.
  // A `{"step": n}` per-category size (rather than a fixed pixel size,
  // e.g. facet_grid_bar.vl.json's own `"height": {"step": 8}`) is handled
  // by stepPanelDimsCode() below instead -- its own value isn't knowable
  // until each panel's own rows (and so its own band-scale category count)
  // exist, unlike a plain pixel number.
  const panelDims = [];
  if (typeof root.spec.width === 'number') panelDims.push(`width: ${formatValue(root.spec.width)}`);
  if (typeof root.spec.height === 'number') panelDims.push(`height: ${formatValue(root.spec.height)}`);
  // A small explicit per-panel height (e.g. trellis_area_seattle's 25px-
  // tall row strips) can be smaller than the chart function's own DEFAULT
  // top+bottom margins (20+30) combined -- left at their defaults, the
  // clamp in buildUnitOrLayerBody's own dims.yRangeExpr (which stops the
  // y-scale's range from *inverting*, flipping the plot upside down when
  // the margins alone exceed the height) would otherwise squash the panel
  // down to a single-pixel sliver instead. Scaling the margins down
  // proportionally to the given height keeps a usable plot area without
  // reintroducing the inversion; not an attempt at Vega-Lite's own exact
  // per-axis-config margin sizing (out of scope here, same simplification
  // this project already makes everywhere else).
  if (typeof root.spec.height === 'number' && root.spec.height < 50) {
    panelDims.push(`marginTop: ${Math.max(1, Math.round(root.spec.height * 0.3))}`);
    panelDims.push(`marginBottom: ${Math.max(1, Math.round(root.spec.height * 0.4))}`);
  }
  if (typeof root.spec.width === 'number' && root.spec.width < 80) {
    panelDims.push(`marginLeft: ${Math.max(1, Math.round(root.spec.width * 0.3))}`);
    panelDims.push(`marginRight: ${Math.max(1, Math.round(root.spec.width * 0.1))}`);
  }
  const {statements: stepDimStmts, fragments: stepDimFragments} = stepPanelDimsCode(templateSpec.encoding, root.spec, 'rows');
  const panelOptionsExpr = panelDims.length > 0 || stepDimFragments.length > 0 ? `{...options, ${[...panelDims, ...stepDimFragments].join(', ')}}` : 'options';
  b(`const doc = container.ownerDocument;`);
  b(`const wrap = doc.createElement("div");`);
  b(`wrap.style.cssText = "display: flex; ${flexStyle} gap: 4px;";`);
  b(`container.appendChild(wrap);`);
  b(`for (const {key, rows} of __facetGroups) {`);
  b(`  const panelWrap = doc.createElement("div");`);
  b(`  wrap.appendChild(panelWrap);`);
  b(`  const label = doc.createElement("div");`);
  b(`  label.style.cssText = "font-size: 11px; font-family: sans-serif;";`);
  // A temporal/timeUnit'd key is a real Date -- its default toString() is
  // long and not what a reader wants as a small multiples' panel title, so
  // it gets a plain calendar/clock format instead (a fixed, reasonable
  // choice, not Vega-Lite's own fully templated header/labelExpr).
  const labelExpr = facetIsTemporal
    ? `key instanceof Date ? d3.timeFormat(${facetDef.timeUnit && String(facetDef.timeUnit).match(/hours|minutes|seconds/) ? '"%-I:%M %p"' : '"%b %-d, %Y"'})(key) : String(key)`
    : 'String(key)';
  b(`  label.textContent = ${labelExpr};`);
  b(`  panelWrap.appendChild(label);`);
  b(`  const panel = doc.createElement("div");`);
  b(`  panelWrap.appendChild(panel);`);
  stepDimStmts.forEach(s => b(`  ${s}`));
  const domainArgs = sharedDomainChannels.map(ch => sharedDomainVars[ch]);
  b(`  await ${templateName}(panel, ${panelOptionsExpr}, rows${domainArgs.length ? ', ' + domainArgs.join(', ') : ''});`);
  b(`}`);

  lines.push(...buildFunction(fnName, body, prefix));
  return lines;
}

// A true two-dimensional facet grid (both `row` and `column` given at
// once, e.g. trellis_row_column.vl.json) -- normalizeFacetDef() only
// recognizes a *single* axis for buildRuntimeFacetPanels()'s own flex-strip
// layout above, so a spec giving both used to fall through unrecognized
// entirely (silently rendered as one plain, unfaceted panel with every
// row overlaid together -- not just a layout gap, but a materially wrong
// chart). Mirrors that function's own shared-scale-domain and per-panel
// dims handling, but groups by (row key, column key) pairs and lays the
// result out as a real CSS grid: one blank corner cell, one column-label
// row across the top, one row-label column down the left, and one panel
// per actual (row, column) combination present in the data (a combination
// with no rows at all is left blank rather than calling the template on
// empty data, which several mark renderers -- e.g. d3.extent() -- assume
// never happens). Custom `sort` (a `{field: ...}` sort-by-another-column
// form specifically) isn't supported for either axis here -- only ascending/
// descending by the facet value itself -- a narrower feature than the
// single-axis case above; no example in this project's own test suite
// needs more.
function buildRuntimeFacetGrid(root, facetDef, fnName, ignoreUnsupported, prefix = '') {
  const {row: rowDef, column: colDef} = facetDef;
  const lines = [];

  const templateSpec = {...root.spec};
  if (root.encoding) templateSpec.encoding = {...root.encoding, ...(templateSpec.encoding || {})};

  // See buildRuntimeFacetPanels()'s identical (and more fully commented)
  // block for why x/y are included -- Vega-Lite's own default facet-grid
  // behavior is a shared position scale across every panel too, unless
  // `resolve: {scale: {x/y: "independent"}}` says otherwise.
  const resolveScale = (root.resolve && root.resolve.scale) || {};
  const templateMark = typeof templateSpec.mark === 'string' ? templateSpec.mark : templateSpec.mark && templateSpec.mark.type;
  const positionValueChannel = (() => {
    const enc = templateSpec.encoding || {};
    const xIsValue = enc.x && enc.x.type === 'quantitative';
    const yIsValue = enc.y && enc.y.type === 'quantitative';
    return xIsValue && !yIsValue ? 'x' : 'y';
  })();
  const sharedDomainChannels = ['color', 'shape', 'size', 'opacity', 'x', 'y'].filter(ch => {
    const def = templateSpec.encoding && templateSpec.encoding[ch];
    if (!def || !def.field || (def.scale && def.scale.domain !== undefined)) return false;
    if (ch === 'x' || ch === 'y') {
      if (def.type !== 'quantitative' && def.type !== 'temporal') return false;
      if (resolveScale[ch] === 'independent') return false;
    }
    return true;
  });
  const sharedDomainVars = {};
  const sharedDomainDefs = {};
  const sharedDomainZeroBaseline = {};
  for (const ch of sharedDomainChannels) {
    const varName = `__facet${ch[0].toUpperCase()}${ch.slice(1)}Domain`;
    sharedDomainVars[ch] = varName;
    const def = templateSpec.encoding[ch];
    sharedDomainDefs[ch] = def;
    if ((ch === 'x' || ch === 'y') && isBarOrArea(templateMark) && !templateSpec.encoding[`${ch}2`] && ch === positionValueChannel) {
      sharedDomainZeroBaseline[ch] = true;
    }
    templateSpec.encoding = {
      ...templateSpec.encoding,
      [ch]: {...def, scale: {...(def.scale || {}), domain: {__vl2dRawExpr: varName}}},
    };
  }

  const templateName = `${fnName}_facetTemplate`;
  lines.push(
    ...buildFunction(templateName, buildUnitOrLayerBody(templateSpec, ignoreUnsupported, '__facetRows'), '', [
      '__facetRows',
      ...sharedDomainChannels.map(ch => sharedDomainVars[ch]),
    ])
  );

  const body = [];
  const b = s => body.push('  ' + s);
  b(
    `// vl2d3: unsupported top-level composition "facet", splitting the shared data by facet value at ` +
      `runtime instead of code-generation time -- each panel shows a plain text header (the raw/timeUnit'd ` +
      `facet value), not Vega-Lite's own fully templated header (--ignore-unsupported)`
  );
  const {statements: loadStmts} = renderDataLoad(root.data, 'facetData', ignoreUnsupported);
  loadStmts.forEach(b);

  const wrapperTransform = root.transform || [];
  const transformTemporalFields = collectTemporalFields({}, wrapperTransform);
  const rowIsTemporal = Boolean(rowDef.timeUnit) || rowDef.type === 'temporal';
  const colIsTemporal = Boolean(colDef.timeUnit) || colDef.type === 'temporal';
  // See buildRuntimeFacetPanels()'s identical comment -- a shared x/y
  // domain needs that channel's own temporal field already coerced before
  // it's computed from facetData.
  const sharedTemporalFields = sharedDomainChannels
    .filter(ch => (ch === 'x' || ch === 'y') && sharedDomainDefs[ch].type === 'temporal')
    .map(ch => sharedDomainDefs[ch].field);
  const temporalFields = [
    ...new Set([
      ...transformTemporalFields,
      ...(rowIsTemporal ? [rowDef.field] : []),
      ...(colIsTemporal ? [colDef.field] : []),
      ...sharedTemporalFields,
    ]),
  ];
  renderTemporalCoercion('facetData', temporalFields).forEach(b);
  if (wrapperTransform.length) renderTransforms(wrapperTransform, 'facetData', ignoreUnsupported).forEach(b);

  for (const ch of sharedDomainChannels) {
    b(`const ${sharedDomainVars[ch]} = ${sharedChannelDomainExpr(ch, sharedDomainDefs[ch], 'facetData', sharedDomainZeroBaseline[ch])};`);
  }

  const rowKeyExpr = rowDef.timeUnit
    ? timeUnitExpr(rowDef.timeUnit, `d[${JSON.stringify(rowDef.field)}]`, ignoreUnsupported)
    : `d[${JSON.stringify(rowDef.field)}]`;
  const colKeyExpr = colDef.timeUnit
    ? timeUnitExpr(colDef.timeUnit, `d[${JSON.stringify(colDef.field)}]`, ignoreUnsupported)
    : `d[${JSON.stringify(colDef.field)}]`;
  b(`facetData = facetData.map(d => ({...d, "__facetRowKey": ${rowKeyExpr}, "__facetColKey": ${colKeyExpr}}));`);
  b(`const __facetRowValues = Array.from(new Set(facetData.map(d => d["__facetRowKey"])));`);
  b(`const __facetColValues = Array.from(new Set(facetData.map(d => d["__facetColKey"])));`);
  b(`__facetRowValues.sort((a, b) => ${rowDef.sort === 'descending' ? 'd3.descending(a, b)' : 'd3.ascending(a, b)'});`);
  b(`__facetColValues.sort((a, b) => ${colDef.sort === 'descending' ? 'd3.descending(a, b)' : 'd3.ascending(a, b)'});`);

  const panelDims = [];
  if (typeof root.spec.width === 'number') panelDims.push(`width: ${formatValue(root.spec.width)}`);
  if (typeof root.spec.height === 'number') panelDims.push(`height: ${formatValue(root.spec.height)}`);
  if (typeof root.spec.height === 'number' && root.spec.height < 50) {
    panelDims.push(`marginTop: ${Math.max(1, Math.round(root.spec.height * 0.3))}`);
    panelDims.push(`marginBottom: ${Math.max(1, Math.round(root.spec.height * 0.4))}`);
  }
  if (typeof root.spec.width === 'number' && root.spec.width < 80) {
    panelDims.push(`marginLeft: ${Math.max(1, Math.round(root.spec.width * 0.3))}`);
    panelDims.push(`marginRight: ${Math.max(1, Math.round(root.spec.width * 0.1))}`);
  }
  // `{"step": n}` case (e.g. facet_grid_bar.vl.json's own `"width": 60,
  // "height": {"step": 8}`) -- see stepPanelDimsCode()'s own doc comment.
  const {statements: stepDimStmts, fragments: stepDimFragments} = stepPanelDimsCode(templateSpec.encoding, root.spec, '__cellRows');
  const panelOptionsExpr =
    panelDims.length > 0 || stepDimFragments.length > 0 ? `{...options, ${[...panelDims, ...stepDimFragments].join(', ')}}` : 'options';

  const rowLabelExpr = rowIsTemporal
    ? `rowKey instanceof Date ? d3.timeFormat(${rowDef.timeUnit && String(rowDef.timeUnit).match(/hours|minutes|seconds/) ? '"%-I:%M %p"' : '"%b %-d, %Y"'})(rowKey) : String(rowKey)`
    : 'String(rowKey)';
  const colLabelExpr = colIsTemporal
    ? `colKey instanceof Date ? d3.timeFormat(${colDef.timeUnit && String(colDef.timeUnit).match(/hours|minutes|seconds/) ? '"%-I:%M %p"' : '"%b %-d, %Y"'})(colKey) : String(colKey)`
    : 'String(colKey)';

  b(`const doc = container.ownerDocument;`);
  b(`const grid = doc.createElement("div");`);
  b(
    `grid.style.cssText = "display: grid; grid-template-columns: auto repeat(" + __facetColValues.length + ", auto); gap: 4px; align-items: center;";`
  );
  b(`container.appendChild(grid);`);
  b(`grid.appendChild(doc.createElement("div"));`);
  b(`for (const colKey of __facetColValues) {`);
  b(`  const colLabel = doc.createElement("div");`);
  b(`  colLabel.style.cssText = "font-size: 11px; font-family: sans-serif; text-align: center;";`);
  b(`  colLabel.textContent = ${colLabelExpr};`);
  b(`  grid.appendChild(colLabel);`);
  b(`}`);
  const domainArgs = sharedDomainChannels.map(ch => sharedDomainVars[ch]);
  b(`for (const rowKey of __facetRowValues) {`);
  b(`  const rowLabel = doc.createElement("div");`);
  b(`  rowLabel.style.cssText = "font-size: 11px; font-family: sans-serif; writing-mode: vertical-rl; text-align: center;";`);
  b(`  rowLabel.textContent = ${rowLabelExpr};`);
  b(`  grid.appendChild(rowLabel);`);
  b(`  for (const colKey of __facetColValues) {`);
  b(`    const panel = doc.createElement("div");`);
  b(`    grid.appendChild(panel);`);
  b(`    const __cellRows = facetData.filter(d => d["__facetRowKey"] === rowKey && d["__facetColKey"] === colKey);`);
  stepDimStmts.forEach(s => b(`    ${s}`));
  b(
    `    if (__cellRows.length > 0) await ${templateName}(panel, ${panelOptionsExpr}, __cellRows${domainArgs.length ? ', ' + domainArgs.join(', ') : ''});`
  );
  b(`  }`);
  b(`}`);

  lines.push(...buildFunction(fnName, body, prefix));
  return lines;
}

// Build one panel's drawing function, named `fnName` -- either a plain
// unit/layer chart, or (recursively, since a concat/vconcat/hconcat/repeat
// child can itself be another composition, e.g. a repeat nested inside a
// vconcat) a further grid of sub-panels. Returns the array of lines
// defining (but not exporting) that function.
function buildPanelFunction(spec, fnName, ignoreUnsupported, prefix = '') {
  const compositionKey = UNSUPPORTED_COMPOSITIONS.find(key => key in spec);
  // `repeat: {layer: [...]}` (as opposed to `repeat: {row/column: [...]}`,
  // or the flat-array form) repeats its one template spec as several
  // LAYERS of one shared view -- sharing x/y scales, differentiated only
  // by whatever channel(s) the template itself binds to `{"repeat":
  // "layer"}` (e.g. bar_grouped_repeated.vl.json's own `xOffset`/`color`,
  // both `{"datum": {"repeat": "layer"}}`) -- not several independent
  // panels the way every other composition here falls back to. Rewritten
  // into an equivalent *native* `layer: [...]` spec (one substituted copy
  // of the template per repeated value) and handed to
  // buildUnitOrLayerBody() directly, the same properly-shared-scales path
  // an ordinary `layer` composition already takes -- previously fell
  // through to the generic "independent panels" fallback below, which
  // doesn't even know `{"repeat": "layer"}` is a placeholder needing
  // substitution at all (produces a broken literal object key, `d[{"repeat":
  // "layer"}]`, and only ever one single, un-repeated panel).
  if (compositionKey === 'repeat' && spec.repeat && Array.isArray(spec.repeat.layer)) {
    const layerSpec = {
      data: spec.data,
      transform: spec.transform,
      layer: spec.repeat.layer.map(v => substituteRepeatPlaceholders(spec.spec, {layer: v})),
    };
    return buildFunction(fnName, buildUnitOrLayerBody(layerSpec, ignoreUnsupported), prefix);
  }
  if (!compositionKey) {
    // A plain unit spec's `encoding.row`/`.column`/`.facet` is Vega-Lite's
    // own shorthand for a facet operator (equivalent to wrapping this same
    // spec in `{"facet": {...}, "spec": {...without those channels...}}`)
    // -- recognized here (rather than only the explicit `facet` key) so a
    // spec written either way gets the same runtime facet split, instead
    // of this shorthand form silently having its row/column channel
    // ignored (no POSITION_LIKE entry for it at all, see prepare.js) and
    // every facet's rows rendered combined into one incorrect panel.
    const encoding = spec.encoding || {};
    const facetInfo = normalizeFacetDef({row: encoding.row, column: encoding.column, ...encoding.facet});
    if (facetInfo) {
      const templateEncoding = {...encoding};
      delete templateEncoding.row;
      delete templateEncoding.column;
      delete templateEncoding.facet;
      const templateSpec = {...spec, encoding: templateEncoding};
      delete templateSpec.data;
      delete templateSpec.transform;
      const facetRoot = {data: spec.data, transform: spec.transform, spec: templateSpec, resolve: spec.resolve};
      return buildRuntimeFacetPanels(facetRoot, facetInfo, fnName, ignoreUnsupported, prefix);
    }
    return buildFunction(fnName, buildUnitOrLayerBody(spec, ignoreUnsupported), prefix);
  }

  if (compositionKey === 'facet') {
    const facetInfo = normalizeFacetDef(spec.facet);
    // The template built below is rendered via buildUnitOrLayerBody()
    // directly, not the general (self-recursing) buildPanelFunction() --
    // it only knows how to inject pre-split rows into a *plain*
    // unit-or-layer spec, so a facet-within-facet (spec.spec itself being
    // another composition) falls through to the generic per-composition
    // handling below instead of being misrendered as one.
    const templateIsPlain = !UNSUPPORTED_COMPOSITIONS.some(key => key in spec.spec);
    if (facetInfo && templateIsPlain) return buildRuntimeFacetPanels(spec, facetInfo, fnName, ignoreUnsupported, prefix);
  }

  const {children, direction, note} = getCompositionChildren(spec, compositionKey);
  const lines = [];
  const childNames = children.map((_, i) => `${fnName}_p${i + 1}`);
  children.forEach((child, i) => {
    lines.push(...buildPanelFunction(child, childNames[i], ignoreUnsupported));
  });

  const flexStyle = direction === 'column' ? 'flex-direction: column;' : 'flex-direction: row;';
  // `columns` (only meaningful for a plain "concat", not hconcat/vconcat
  // which are already fixed to one row/column) forces a hard wrap every N
  // children regardless of the container's own width -- a flexbox's own
  // width-triggered `flex-wrap` can't express that (e.g. it would happily
  // fit 3 narrow panels on one row where the spec calls for 2 + 1), so a
  // CSS grid with an explicit column count is used instead whenever it's
  // given.
  const columns = compositionKey === 'concat' && typeof spec.columns === 'number' ? spec.columns : null;
  const gap = typeof spec.spacing === 'number' ? spec.spacing : 12;
  const wrapperBody = [];
  const b = s => wrapperBody.push('  ' + s);
  b(
    `// vl2d3: unsupported top-level composition "${compositionKey}", rendering each panel independently ` +
      `(no shared/aligned scales across panels) (--ignore-unsupported)`
  );
  if (note) b(`// vl2d3: ${note} (--ignore-unsupported)`);
  // `container.ownerDocument` (not the bare global `document`) works
  // whether or not this module happens to run somewhere `document` is a
  // global (a real browser page always has one; a plain Node/test context
  // run against jsdom doesn't unless it's explicitly exposed globally).
  b(`const doc = container.ownerDocument;`);
  b(`const wrap = doc.createElement("div");`);
  if (columns) {
    b(`wrap.style.cssText = "display: grid; grid-template-columns: repeat(${columns}, auto); gap: ${gap}px;";`);
  } else {
    b(`wrap.style.cssText = "display: flex; ${flexStyle} flex-wrap: wrap; gap: ${gap}px;";`);
  }
  b(`container.appendChild(wrap);`);
  children.forEach((child, i) => {
    // Each panel's own `width`/`height` (a plain number, e.g. a
    // concat_bar_scales_discretize.vl.json-style child with none at all)
    // is threaded into its own invocation the same way a facet panel's
    // is (buildRuntimeFacetPanels()'s own identical panelDims) -- the
    // generated child function itself only ever falls back to a bare
    // `options.width ?? 640`, with no way to see its own originating
    // spec's width/height unless the caller passes it in explicitly.
    // Absent an explicit size, concat/hconcat/vconcat children default to
    // a much smaller size than a standalone chart's own 640x400 (closer
    // to Vega-Lite's own default view size) -- previously every panel
    // silently inherited the *outer* chart's own `options` unchanged,
    // rendering each one at the full default size regardless of how many
    // panels needed to fit side by side.
    const panelDims = [];
    panelDims.push(`width: ${typeof child.width === 'number' ? formatValue(child.width) : 200}`);
    panelDims.push(`height: ${typeof child.height === 'number' ? formatValue(child.height) : 200}`);
    const childWidth = typeof child.width === 'number' ? child.width : 200;
    const childHeight = typeof child.height === 'number' ? child.height : 200;
    if (childHeight < 50) {
      panelDims.push(`marginTop: ${Math.max(1, Math.round(childHeight * 0.3))}`);
      panelDims.push(`marginBottom: ${Math.max(1, Math.round(childHeight * 0.4))}`);
    }
    if (childWidth < 80) {
      panelDims.push(`marginLeft: ${Math.max(1, Math.round(childWidth * 0.3))}`);
      panelDims.push(`marginRight: ${Math.max(1, Math.round(childWidth * 0.1))}`);
    }
    const childOptionsExpr = `{...options, ${panelDims.join(', ')}}`;
    b(`{`);
    b(`  const panel = doc.createElement("div");`);
    b(`  wrap.appendChild(panel);`);
    b(`  await ${childNames[i]}(panel, ${childOptionsExpr});`);
    b(`}`);
  });
  b('return wrap;');

  lines.push(...buildFunction(fnName, wrapperBody, prefix));
  return lines;
}

export function specToCode(spec, options = {}) {
  const {ignoreUnsupported = false} = options;
  let root = {...spec};
  delete root.$schema;
  if (root.datasets) {
    root = resolveDatasetRefs(root, root.datasets);
    delete root.datasets;
  }

  const compositionKey = UNSUPPORTED_COMPOSITIONS.find(key => key in root);
  // `repeat: {layer: [...]}` is a genuine, complete translation (rewritten
  // into a native `layer: [...]` composition with properly shared scales,
  // see buildPanelFunction()) rather than the "independent panels, no
  // shared scales" sacrifice every other composition here falls back to --
  // so it's exempted from the strict-mode refusal the same way a plain
  // `layer` composition already is (UNSUPPORTED_COMPOSITIONS never listed
  // "layer" itself either).
  const isSupportedRepeatLayer = compositionKey === 'repeat' && root.repeat && Array.isArray(root.repeat.layer);
  if (compositionKey && !ignoreUnsupported && !isSupportedRepeatLayer) {
    throw new Error(
      `Unsupported top-level composition: "${compositionKey}" is not yet supported by vl2d3 ` +
        '(single view and layer are supported)'
    );
  }

  const bodyLines = buildPanelFunction(root, 'chart', ignoreUnsupported, 'export default ');

  // A shared-runtime helper (see runtime.js) is only referenced by name in
  // the generated body -- rather than thread a "which helpers were used"
  // value through every render function that might need one, just check
  // for each known helper's call syntax in the finished text and import
  // only the ones actually present.
  const bodyText = bodyLines.join('\n');
  const neededRuntimeExports = RUNTIME_EXPORTS.filter(name => bodyText.includes(`${name}(`));

  const lines = ['import * as d3 from "d3";'];
  if (neededRuntimeExports.length > 0) {
    lines.push(`import {${neededRuntimeExports.join(', ')}} from "./vl2d3-runtime.js";`);
  }
  lines.push('', ...bodyLines);

  return lines.join('\n');
}
