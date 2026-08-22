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
import {resolvePositionScale, resolveColorScale, resolveSizeScale, resolveOpacityScale, resolveOffsetScale} from './scales.js';
import {renderMark} from './marks.js';
import {formatValue} from './literals.js';
import {extractDateFunctionFields} from './expr.js';

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
  if (wrapper.encoding) merged.encoding = {...wrapper.encoding, ...(merged.encoding || {})};
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
      (Array.isArray(t.as) ? t.as : [t.as, `${t.as}2`]).forEach(a => produced.add(a));
    }
    if (t.aggregate) {
      for (const a of t.aggregate) if (a.as) produced.add(a.as);
    }
    if (t.window) {
      for (const w of t.window) if (w.as) produced.add(w.as);
    }
    if (t.density) {
      (Array.isArray(t.as) && t.as.length === 2 ? t.as : ['value', 'density']).forEach(a => produced.add(a));
    }
  }
  return produced;
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
function collectInvalidFilterFields(encoding, transformList) {
  const produced = collectProducedFields(transformList);
  const fields = new Set();
  for (const ch of INVALID_FILTER_CHANNELS) {
    const def = encoding[ch];
    if (!def || typeof def !== 'object' || !def.field || !(def.type === 'quantitative' || def.type === 'temporal')) continue;
    // A bracket-indexed compound-aggregate reference (`argmax_x['y']`) reads
    // out of a *produced* field (its base), even though the whole string
    // isn't itself a key `collectProducedFields` ever added -- same "doesn't
    // exist on the raw, pre-transform rows" trap as a plain produced field.
    const bracketBase = parseBracketFieldPath(def.field)?.base;
    if (produced.has(def.field) || (bracketBase && produced.has(bracketBase))) continue;
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
      rewritten[ch] = {...def, field: unescapeFieldPath(def.field)};
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
  const m = /^([A-Za-z_$][\w$]*)((?:\[(?:'[^']*'|"[^"]*")\])+)$/.exec(String(field));
  if (!m) return null;
  const keys = [...m[2].matchAll(/\[(?:'([^']*)'|"([^"]*)")\]/g)].map(km => km[1] ?? km[2]);
  return {base: m[1], keys};
}

function flattenBracketFields(encoding, dataVar) {
  const statements = [];
  const rewritten = {...encoding};
  for (const ch of Object.keys(encoding)) {
    const def = encoding[ch];
    if (!def || typeof def !== 'object' || !def.field) continue;
    const parsed = parseBracketFieldPath(def.field);
    if (!parsed) continue;
    const flatField = `${parsed.base}__${parsed.keys.map(k => k.replace(/[^A-Za-z0-9_]/g, '_')).join('__')}`;
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
function buildUnitOrLayerBody(root, ignoreUnsupported) {
  const children = flattenLayers(root, {});

  const lines = [];
  const b = s => lines.push('  ' + s);

  b('const width = options.width ?? 640;');
  b('const height = options.height ?? 400;');
  b('const marginTop = options.marginTop ?? 20;');
  b('const marginRight = options.marginRight ?? 20;');
  b('const marginBottom = options.marginBottom ?? 30;');
  b('const marginLeft = options.marginLeft ?? 50;');
  lines.push('');

  const dims = {
    xRangeExpr: '[marginLeft, width - marginRight]',
    yRangeExpr: '[height - marginBottom, marginTop]',
    innerWidthExpr: '(width - marginLeft - marginRight)',
    innerHeightExpr: '(height - marginTop - marginBottom)',
    centerXExpr: 'width / 2',
    centerYExpr: 'height / 2',
    marginTopExpr: 'marginTop',
    marginLeftExpr: 'marginLeft',
    heightMinusBottomExpr: 'height - marginBottom',
    widthMinusRightExpr: 'width - marginRight',
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
    const {statements: loadStmts} = renderDataLoad(child.data, dataVar, ignoreUnsupported);
    loadStmts.forEach(b);

    if (invalidHandlingMode(root, child.mark) === 'filter') {
      renderInvalidFilter(dataVar, collectInvalidFilterFields(encodingIn, child.transform)).forEach(b);
    }

    const temporalFields = collectTemporalFields(encodingIn, child.transform || []);
    renderTemporalCoercion(dataVar, temporalFields).forEach(b);

    if (child.transform) renderTransforms(child.transform, dataVar, ignoreUnsupported).forEach(b);

    const {statements: bracketStmts, encoding: encodingAfterBracket} = flattenBracketFields(encodingIn, dataVar);
    bracketStmts.forEach(b);
    encodingIn = encodingAfterBracket;

    const {statements: prepStmts, encoding} = prepareEncoding(encodingIn, dataVar, ignoreUnsupported);
    prepStmts.forEach(b);

    return {dataVar, encoding, originalEncoding: encodingIn, mark: child.mark, extentParams: collectExtentParams(child.transform)};
  });
  lines.push('');

  const allDataExpr = prepared.length > 1 ? `[${prepared.map(p => `...${p.dataVar}`).join(', ')}]` : prepared[0].dataVar;

  // -- shared scales --
  const scales = {};
  const zeroBaseline = prepared.some(p => isBarOrArea(p.mark));

  for (const channel of ['x', 'y']) {
    const def = prepared.map(p => p.encoding[channel]).find(Boolean);
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
    const combinedValuesExpr =
      declaringChildren.length > 1
        ? `[].concat(${declaringChildren.map(p => `${p.dataVar}.map(d => d[${JSON.stringify(p.encoding[channel].field)}])`).join(', ')})`
        : null;
    const scale = resolvePositionScale(channel, def, {
      dataVar: allDataExpr,
      rangeExpr: dims[`${channel}RangeExpr`],
      zeroBaseline: zeroBaseline && def.type === 'quantitative',
      ignoreUnsupported,
      combinedValuesExpr,
    });
    b(scale.decl);
    scales[channel] = scale;
  }
  for (const [channel, resolver] of [['color', resolveColorScale], ['size', resolveSizeScale], ['opacity', resolveOpacityScale]]) {
    const def = prepared.map(p => p.encoding[channel]).find(Boolean);
    // `"scale": null` is Vega-Lite's own "use the raw field value directly
    // as the visual channel value, no mapping at all" escape hatch (e.g. a
    // `color` field that already holds real CSS color strings). Building no
    // scale at all here (leaving `scales[channel]` unset) makes
    // accessor()/fillExpr() in marks.js fall back to their own existing
    // "no scale resolved for this channel" case -- a bare field reference --
    // which is exactly this behavior, with no separate code path needed.
    if (!def || 'value' in def || def.scale === null) continue;
    const scale = resolver(def, {dataVar: allDataExpr, ignoreUnsupported});
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
    const scale = resolveOffsetScale(offsetChannel, def, {dataVar: allDataExpr, outerScale});
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
    let markCode = renderMark(p.mark, p.encoding, scales, dims, p.dataVar, ignoreUnsupported, p.extentParams);
    if (!/[;}]\s*$/.test(markCode)) markCode += ';';
    lines.push(markCode.replace(/^/gm, '  '));
    lines.push('');
  }

  // -- basic categorical color legend --
  if (scales.color && scales.color.kind === 'ordinal') {
    b('{');
    b('  const legend = svg.append("g").attr("transform", `translate(${width - marginRight - 100},${marginTop})`);');
    b('  const entries = color.domain();');
    b('  const rows = legend.selectAll("g").data(entries).join("g")');
    b('      .attr("transform", (d, i) => `translate(0,${i * 16})`);');
    b('  rows.append("rect").attr("width", 10).attr("height", 10).attr("fill", d => color(d));');
    b('  rows.append("text").attr("x", 14).attr("y", 9).attr("font-size", "10px").text(d => d);');
    b('}');
    lines.push('');
  }

  b('return svg.node();');
  return lines;
}

function buildFunction(fnName, bodyLines, prefix = '') {
  return [`${prefix}async function ${fnName}(container, options = {}) {`, ...bodyLines, '}', ''];
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

// Build one panel's drawing function, named `fnName` -- either a plain
// unit/layer chart, or (recursively, since a concat/vconcat/hconcat/repeat
// child can itself be another composition, e.g. a repeat nested inside a
// vconcat) a further grid of sub-panels. Returns the array of lines
// defining (but not exporting) that function.
function buildPanelFunction(spec, fnName, ignoreUnsupported, prefix = '') {
  const compositionKey = UNSUPPORTED_COMPOSITIONS.find(key => key in spec);
  if (!compositionKey) {
    return buildFunction(fnName, buildUnitOrLayerBody(spec, ignoreUnsupported), prefix);
  }

  const {children, direction, note} = getCompositionChildren(spec, compositionKey);
  const lines = [];
  const childNames = children.map((_, i) => `${fnName}_p${i + 1}`);
  children.forEach((child, i) => {
    lines.push(...buildPanelFunction(child, childNames[i], ignoreUnsupported));
  });

  const flexStyle = direction === 'column' ? 'flex-direction: column;' : 'flex-wrap: wrap;';
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
  b(`wrap.style.cssText = "display: flex; ${flexStyle} gap: 12px;";`);
  b(`container.appendChild(wrap);`);
  for (const childName of childNames) {
    b(`{`);
    b(`  const panel = doc.createElement("div");`);
    b(`  wrap.appendChild(panel);`);
    b(`  await ${childName}(panel, options);`);
    b(`}`);
  }
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
  if (compositionKey && !ignoreUnsupported) {
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
