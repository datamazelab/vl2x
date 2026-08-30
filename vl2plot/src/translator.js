// Translate a Vega-Lite spec into a standalone Observable Plot
// chart-drawing function.
//
// Scope (v1): unit views, `layer` (one shared `Plot.plot()`, all marks
// combined), `hconcat`/`vconcat`/`concat` (independent `Plot.plot()` calls
// appended into a flex-container wrapper node -- Plot has no native
// multi-plot layout of its own), and `facet` (mapped directly onto Plot's
// own native `facet: {data, x, y}` top-level option -- no hand-built grid
// needed at all). `repeat` throws a clear "not supported" error in strict
// mode; under `ignoreUnsupported` it falls back to rendering the template
// once, unsubstituted, the same "best effort, not a crash" convention every
// other unsupported shape in this project already uses.

import {renderDataLoad, renderTemporalCoercion} from './data.js';
import {renderTransforms} from './transforms.js';
import {renderMark} from './marks.js';
import {extractDateFunctionFields} from './expr.js';
import {collectTemporalFields as collectEncodingTemporalFields} from './prepare.js';
import {buildScaleOptions, renderScaleBlock} from './scales.js';
import {formatValue} from './literals.js';

const UNSUPPORTED_COMPOSITIONS = ['repeat'];

// Resolve top-level `datasets: {name: [...rows]}` reusable named datasets --
// any `data: {name: "...", ...}` reference anywhere in the tree is replaced
// with that dataset's rows inlined directly, mirroring `vl2d3`'s own
// identical helper.
function resolveDatasetRefs(node, datasets) {
  if (!node || typeof node !== 'object') return node;
  const result = {...node};
  if (result.data && typeof result.data === 'object' && result.data.name && result.data.name in datasets) {
    const {name, ...rest} = result.data;
    result.data = {values: datasets[name], ...rest};
  }
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) {
    if (Array.isArray(result[key])) result[key] = result[key].map(child => resolveDatasetRefs(child, datasets));
  }
  if (result.spec) result.spec = resolveDatasetRefs(result.spec, datasets);
  return result;
}

// A child's own `data`/`transform`/`encoding` inherit the wrapper's when
// absent -- `encoding` is merged per-*channel* (not a flat object replace),
// so a child overriding just one property of a channel the wrapper already
// fully specified (e.g. the wrapper's own `x: {type: "quantitative", axis:
// {...}}`, a child adding just `field`) doesn't silently discard the rest.
// Mirrors `vl2d3`'s own `mergeDown()`.
function mergeDown(child, wrapper) {
  const merged = {...child};
  if (!merged.data && wrapper.data) merged.data = wrapper.data;
  if (wrapper.transform) merged.transform = [...wrapper.transform, ...(merged.transform || [])];
  if (wrapper.encoding) {
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

function collectTemporalFields(encoding, transformList = []) {
  const fromEncoding = collectEncodingTemporalFields(encoding || {});
  const fromTimeUnitTransforms = transformList.filter(t => 'timeUnit' in t).map(t => t.field);
  const fromCalc = transformList.filter(t => 'calculate' in t).flatMap(t => extractDateFunctionFields(t.calculate));
  return [...new Set([...fromEncoding, ...fromTimeUnitTransforms, ...fromCalc])];
}

// Plot's own top-level scale-channel name for each Vega-Lite encoding
// channel that can carry a `scale` -- `fill`/`stroke` both feed Plot's one
// shared `color` scale (there's no separate "fill scale"/"stroke scale"
// the way there is in Vega-Lite, since `marks.js` always picks exactly one
// of the two per mark).
const SCALE_CHANNEL_MAP = {x: 'x', y: 'y', color: 'color', fill: 'color', stroke: 'color', opacity: 'opacity', size: 'r', shape: 'symbol'};

// A raw SVG path string ("M1.7 -1.7h-0.8...") used as a `shape` scale's own
// `range` entry (a custom marker shape) -- valid in Vega-Lite/Vega, but
// Plot's own `symbol` channel only accepts a small set of named symbol
// types (or a d3.symbol-shaped `{draw}` implementation object), not a raw
// path string -- passing one through verbatim throws at render time
// ("invalid symbol: ..."), so this is treated as a documented v1 gap
// instead.
const SVG_PATH_RE = /^[Mm][\d\-.\s]/;

function isRealChannel(def) {
  return def && typeof def === 'object' && (typeof def.field === 'string' || 'value' in def || 'datum' in def);
}

// A genuine `xOffset`/`yOffset` (a "dodged"/grouped position) means the
// base category channel (`x` for `xOffset`) has been repurposed as
// Plot's own `fx` (facet-x) instead -- see `marks.js`'s own
// `catChannelPairs()`, which builds the matching `fx`+`x` mark channel
// pair this needs to line up with (Plot's own documented recipe for a
// grouped bar chart, confirmed empirically).
const DODGE_OFFSET_TO_FACET = {xOffset: {facet: 'fx', base: 'x'}, yOffset: {facet: 'fy', base: 'y'}};

function collectScaleOptions(encoding, markType, ignoreUnsupported) {
  const out = {};
  for (const [ch, scaleCh] of Object.entries(SCALE_CHANNEL_MAP)) {
    const def = encoding[ch];
    if (scaleCh === 'symbol' && def && def.scale && Array.isArray(def.scale.range) && def.scale.range.some(v => typeof v === 'string' && SVG_PATH_RE.test(v))) {
      if (ignoreUnsupported) continue;
      throw new Error("Unsupported: a shape scale range of custom SVG path strings is not yet supported by vl2plot (Plot's symbol channel only accepts named symbol types)");
    }
    const opts = buildScaleOptions(def, {channel: scaleCh, markType, ignoreUnsupported});
    if (opts) out[scaleCh] = {...(out[scaleCh] || {}), ...opts};
  }

  for (const [offsetCh, {facet, base}] of Object.entries(DODGE_OFFSET_TO_FACET)) {
    if (!isRealChannel(encoding[offsetCh])) continue;
    // `padding: 0.1` (a small gap between groups, not between every bar
    // within one) keeps adjacent groups reading as one combined axis
    // rather than visually separate facet panels; the repurposed
    // within-facet position channel gets its own axis hidden entirely --
    // Vega-Lite's own grouped bar shows no separate tick per sub-
    // category (its own color legend already identifies it), and
    // whatever scale options the loop above already derived from
    // `encoding[base]` (the *original* category channel) no longer
    // apply to it now that it positions by the offset channel instead.
    out[facet] = {padding: 0.1, ...(buildScaleOptions(encoding[base], {channel: facet, markType, ignoreUnsupported}) || {})};
    out[base] = {axis: null};
  }

  return out;
}

function mergeScaleOptions(a, b) {
  const out = {...a};
  for (const [k, v] of Object.entries(b)) out[k] = {...(out[k] || {}), ...v};
  return out;
}

let varCounts;
function newVar(hint) {
  varCounts[hint] = (varCounts[hint] || 0) + 1;
  return varCounts[hint] === 1 ? hint : `${hint}${varCounts[hint]}`;
}

function sourceComment(path, includeSourcePaths) {
  return includeSourcePaths && path ? [`// from: ${path}`] : [];
}

// Vega-Lite's own bracket-index convention for referencing a nested
// property of a compound *top-level* `aggregate` result -- `argmin`/
// `argmax` store the whole matching *row* under their own `as` name, and
// a downstream encoding channel then reads one of that row's own other
// fields via e.g. `argmax_US_Gross['Production Budget']` (adapted from
// `vl2d3`'s own identical helper). Scoped to bracket-index segments only
// (`['key']`/`[0]`) -- a bare dot-path (`record.low`, a nested object-
// valued column) is already handled by `data.js`'s own
// `vlFlattenOneLevel()` at data-load time instead, so parsing it here too
// would just be redundant, not wrong, but there's no reason to.
function parseBracketFieldPath(field) {
  const m = /^([A-Za-z_$][\w$]*)((?:\[(?:'[^']*'|"[^"]*"|-?\d+)\])+)$/.exec(String(field));
  if (!m) return null;
  const keys = [...m[2].matchAll(/\[(?:'([^']*)'|"([^"]*)"|(-?\d+))\]/g)].map(km => (km[3] !== undefined ? Number(km[3]) : km[1] ?? km[2]));
  return {base: m[1], keys};
}

// Flattens every bracket-indexed encoding field into a real plain field
// (via a `.map()` statement over `dataVar`) before any mark/scale code
// ever sees the channel -- none of them can express a nested property
// read from a single `field` string.
function flattenBracketFields(encoding, dataVar) {
  const statements = [];
  const rewritten = {...encoding};
  for (const ch of Object.keys(encoding)) {
    const def = encoding[ch];
    if (!def || typeof def !== 'object' || typeof def.field !== 'string') continue;
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

// Vega-Lite's own *inline* `aggregate: {"argmax": sortField}` / `{"argmin":
// sortField}` channel shorthand -- distinct from (and much simpler than)
// the bracket-index form above: rather than storing the whole winning row
// under a new field, this shorthand's own sibling `field` property names
// which of that winning row's *existing* columns to read directly, so no
// rewriting of any field name is needed at all, only a real reduction of
// the data itself. Plot's own group/bin transforms have no "pick one
// whole row per group" reducer concept, so (mirroring `flattenBracketFields`
// above) this is pre-materialized as a real one-row-per-group array in
// plain JS via `vlArgAggregate()` (`runtime.js`) rather than attempted as
// a Plot transform. Every real corpus spec using this shorthand only ever
// compares by one shared field per mark (confirmed by inspection) even
// across several output channels (e.g. both `y` and `text` reading two
// different fields off the *same* argmin-selected row) -- detecting one
// such channel is enough to resolve the whole mark's own plan; a second,
// differently-compared one on the same mark isn't attempted (only the
// first found is honored).
function planArgAggregate(encoding) {
  let compareField = null;
  let mode = null;
  for (const ch of Object.keys(encoding)) {
    const agg = encoding[ch] && typeof encoding[ch] === 'object' ? encoding[ch].aggregate : null;
    if (agg && typeof agg === 'object') {
      if (typeof agg.argmax === 'string') {
        compareField = agg.argmax;
        mode = 'max';
        break;
      }
      if (typeof agg.argmin === 'string') {
        compareField = agg.argmin;
        mode = 'min';
        break;
      }
    }
  }
  if (!compareField) return null;
  // Every other plain-field channel (no aggregate of its own) is an
  // implicit groupby key, the same "every non-aggregate fielded channel"
  // rule this project's own `prepare.js` already applies for a plain
  // inline aggregate.
  const groupby = [];
  for (const ch of Object.keys(encoding)) {
    const def = encoding[ch];
    if (def && typeof def === 'object' && typeof def.field === 'string' && def.aggregate == null) {
      groupby.push(def.field);
    }
  }
  return {compareField, mode, groupby};
}

// Once the mark's own data has been reduced to one winning row per group,
// every aggregate-bearing channel on it (the argmax/argmin-shorthand ones,
// *and* a plain string aggregate like `"min"`/`"max"` sharing the same
// comparison field, e.g. `layer_line_co2_concentration.vl.json`'s own `x:
// {"aggregate": "max", "field": "scaled_date"}` alongside `y`'s own
// `argmax` on that identical field) already holds exactly the reduced
// value it asked for -- an aggregate over a single-row group always
// equals that row's own value, so every one of them is simplified to a
// plain field read. This assumes every aggregated channel on the mark
// shares the *same* underlying reduction (true for every real corpus spec
// found); a different, unrelated aggregate op on some other field
// wouldn't be resolved correctly by this and isn't attempted.
function stripResolvedAggregates(encoding) {
  const rewritten = {...encoding};
  for (const ch of Object.keys(encoding)) {
    const def = encoding[ch];
    if (def && typeof def === 'object' && def.aggregate != null) {
      const {aggregate, ...rest} = def;
      rewritten[ch] = rest;
    }
  }
  return rewritten;
}

// Translates one unit view (a real `mark`, not a further composition):
// returns `{statements, dataVar, markExpr, scaleOptions}`.
function translateUnit(node, ctx, path) {
  let dataVar = newVar(`${ctx.hint}Data`);
  const statements = [];
  const {statements: loadStmts} = renderDataLoad(node.data, dataVar, ctx.ignoreUnsupported);
  statements.push(...sourceComment(`${path}data`, ctx.includeSourcePaths), ...loadStmts);

  const temporalFields = collectTemporalFields(node.encoding, node.transform);
  statements.push(...renderTemporalCoercion(dataVar, temporalFields));

  if (node.transform && node.transform.length) {
    const transformStmts = renderTransforms(node.transform, dataVar, ctx.ignoreUnsupported);
    if (transformStmts.length) {
      statements.push(...sourceComment(`${path}transform`, ctx.includeSourcePaths), ...transformStmts);
    }
  }

  let encoding = node.encoding || {};
  const argPlan = planArgAggregate(encoding);
  if (argPlan) {
    const reducedVar = newVar(`${ctx.hint}Reduced`);
    statements.push(
      `let ${reducedVar} = vlArgAggregate(${dataVar}, {compareField: ${JSON.stringify(argPlan.compareField)}, ` +
        `mode: ${JSON.stringify(argPlan.mode)}, groupby: ${JSON.stringify(argPlan.groupby)}});`
    );
    dataVar = reducedVar;
    encoding = stripResolvedAggregates(encoding);
  }

  const {statements: bracketStmts, encoding: flattenedEncoding} = flattenBracketFields(encoding, dataVar);
  statements.push(...bracketStmts);
  encoding = flattenedEncoding;
  const {statements: markStmts, markExpr, postFixups} = renderMark(node.mark, encoding, dataVar, ctx.ignoreUnsupported, ctx.facetChannels, ctx.config);
  statements.push(...markStmts);
  if (markExpr) {
    const channels = ['mark', ...Object.keys(encoding).map(ch => `encoding.${ch}`)];
    statements.push(...sourceComment(`${path}${channels.join(', ')}`, ctx.includeSourcePaths));
  }

  const markType = typeof node.mark === 'string' ? node.mark : node.mark && node.mark.type;
  return {statements, dataVar, markExpr, postFixups, scaleOptions: collectScaleOptions(encoding, markType, ctx.ignoreUnsupported)};
}

// Translates a `layer` composition (or a plain unit view, treated as a
// trivial one-mark "layer") into one shared `Plot.plot()`'s worth of marks.
function translateLayerOrUnit(node, ctx, path) {
  if (!('layer' in node)) {
    const {statements, markExpr, scaleOptions, postFixups} = translateUnit(node, ctx, path);
    return {statements, markExprs: markExpr ? [markExpr] : [], scaleOptions, postFixups: postFixups || []};
  }
  const statements = [];
  const markExprs = [];
  let scaleOptions = {};
  const postFixups = [];
  node.layer.forEach((child, i) => {
    const merged = mergeDown(child, node);
    const childPath = `${path}layer[${i}].`;
    if (UNSUPPORTED_COMPOSITIONS.some(key => key in merged) || ['hconcat', 'vconcat', 'concat', 'facet'].some(key => key in merged)) {
      if (ctx.ignoreUnsupported) {
        statements.push(`// vl2plot: a nested composition inside 'layer' is not yet supported, skipped (--ignore-unsupported)`);
        return;
      }
      throw new Error(`Unsupported: a nested composition inside 'layer' is not yet supported by vl2plot`);
    }
    const sub = translateLayerOrUnit(merged, ctx, childPath);
    statements.push(...sub.statements);
    markExprs.push(...sub.markExprs);
    scaleOptions = mergeScaleOptions(scaleOptions, sub.scaleOptions);
    postFixups.push(...(sub.postFixups || []));
  });
  return {statements, markExprs, scaleOptions, postFixups};
}

function panelSize(node) {
  const w = typeof node.width === 'number' ? node.width : null;
  const h = typeof node.height === 'number' ? node.height : null;
  // A chart `title` can be a bare string or `{"text": ..., "subtitle":
  // ...}` -- matches `build_site.py`'s own identical extraction for the
  // page's own description field. Plot's own top-level `title` option
  // renders it directly above the plot; `subtitle` maps onto Plot's own
  // matching option the same way.
  const titleDef = node.title;
  const title = typeof titleDef === 'string' ? titleDef : titleDef && typeof titleDef === 'object' ? titleDef.text : null;
  const subtitle = titleDef && typeof titleDef === 'object' ? titleDef.subtitle : null;
  return {w, h, title: Array.isArray(title) ? title.join(' ') : title, subtitle: Array.isArray(subtitle) ? subtitle.join(' ') : subtitle};
}

// Renders `Plot.plot({...})` source text (indented `indent` levels) from an
// already-built list of mark-expression strings and merged scale options.
// `facet`, when given, is `{dataVar, x, y}` -- `dataVar` is spliced in as a
// bare identifier (a real variable reference, not a JS-literal-rendered
// string), `x`/`y` (field names) as quoted strings.
function buildPlotCallSource(markExprs, scaleOptions, size, facet, indent) {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  const lines = ['Plot.plot({', `${inner}document: container.ownerDocument,`];
  if (size.title) lines.push(`${inner}title: ${formatValue(size.title)},`);
  if (size.subtitle) lines.push(`${inner}subtitle: ${formatValue(size.subtitle)},`);
  if (size.w) lines.push(`${inner}width: ${size.w},`);
  if (size.h) lines.push(`${inner}height: ${size.h},`);
  if (facet) {
    const facetInner = '  '.repeat(indent + 2);
    const facetLines = [`${inner}facet: {`, `${facetInner}data: ${facet.dataVar},`];
    if (facet.x) facetLines.push(`${facetInner}x: ${JSON.stringify(facet.x)},`);
    if (facet.y) facetLines.push(`${facetInner}y: ${JSON.stringify(facet.y)},`);
    facetLines.push(`${inner}},`);
    lines.push(...facetLines);
  }
  lines.push(...renderScaleBlock(scaleOptions, indent + 1));
  lines.push(`${inner}marks: [`);
  for (const m of markExprs) lines.push(`${inner}  ${m},`);
  lines.push(`${inner}],`, `${pad}})`);
  return lines.join('\n');
}

// A *wrapped* facet -- `encoding.facet: {field, columns: N}`, no `row`/
// `column` split (e.g. trellis_barley.vl.json's own `columns: 2` across 8
// `site` panels) -- has no equivalent in Plot's own faceting at all: Plot
// only ever supports a strict 2-axis grid (`fx` times `fy`, one real scale
// each), never "wrap N panels per row from a single field." Rendered
// instead as N genuinely independent `Plot.plot()` calls (one per
// distinct facet value, each titled with that real value, each drawing
// only that value's own filtered rows), arranged in a real CSS grid with
// the requested (or, absent one, a single-row) column count -- the same
// "independent panels in a wrapper div" strategy `hconcat`/`vconcat`
// already use for their own unsupported-composition fallback, just with
// the group membership only knowable once the data has actually loaded
// (a URL-sourced dataset, the common case) rather than at code-generation
// time.
//
// Known gaps, left undone rather than half-faked: each panel computes its
// own LOCAL x/y/color scale domain from only that panel's own rows, not a
// domain shared across every panel the way Vega-Lite's own default facet
// behavior would (matching `buildRuntimeFacetPanels()`'s own identical,
// separately-documented gap in `vl2d3`); a `{"step": n}`-shaped per-
// category panel size isn't handled (only a plain pixel number is).
function translateWrappedFacet(node, facetDef, ctx, path) {
  const field = facetDef.field;
  const template = {...node.spec};
  const merged = mergeDown(template, {data: node.data, transform: node.transform});
  const size = panelSize(node.spec);

  // A wrapped facet's own template being itself further composed (layered,
  // or facet-within-facet) needs each independent per-value panel to
  // repeat that same inner composition, which the single shared markExpr
  // this function builds can't express -- not attempted in v1, matching
  // the identical restriction the row/column facet case (translateFacet)
  // already has for its own template.
  if (merged.facet || merged.layer) {
    if (ctx.ignoreUnsupported) {
      const sub = translateLayerOrUnit(merged, ctx, `${path}spec.`);
      const plotSrc = buildPlotCallSource(sub.markExprs, sub.scaleOptions, size, null, 1);
      return {
        statements: [`// vl2plot: a wrapped facet's own template can't itself be layered/faceted yet, rendering it unfaceted (--ignore-unsupported)`, ...sub.statements],
        plotSrc,
      };
    }
    throw new Error("Unsupported: a wrapped facet's own template can't itself be layered or further-faceted");
  }

  const unit = translateUnit(merged, ctx, `${path}spec.`);
  // An unsupported mark inside the facet's own template (e.g. `geoshape`)
  // renders no mark at all (renderMark()'s own --ignore-unsupported skip)
  // -- an empty *real* Plot.plot() node here, matching the fallback every
  // other "nothing to draw" case in this file already returns, not a bare
  // `null` (which would blow up the caller's own unconditional
  // `container.appendChild(...)`).
  if (!unit.markExpr) {
    return {statements: unit.statements, plotSrc: `Plot.plot({document: container.ownerDocument, marks: []})`};
  }

  const statements = [...unit.statements];

  // Every distinct value of the facet field, in the order its own panel
  // should actually be drawn -- an explicit array is used as-is (filtered
  // down to values actually present, in case the array names more than
  // the data has); an aggregate-op sort (`{op, field}`, e.g. by each
  // group's own median of some other field) or a plain ascending/
  // descending request is computed at runtime instead (vlFacetSortValues,
  // runtime.js), since neither is knowable from the spec text alone.
  const orderVar = newVar('facetOrder');
  if (Array.isArray(facetDef.sort)) {
    statements.push(
      `const ${orderVar} = ${JSON.stringify(facetDef.sort)}.filter(v => new Set(${unit.dataVar}.map(d => d[${JSON.stringify(field)}])).has(v));`
    );
  } else if (facetDef.sort && typeof facetDef.sort === 'object' && facetDef.sort.field) {
    const order = facetDef.sort.order === 'descending' ? 'descending' : 'ascending';
    statements.push(
      `const ${orderVar} = vlFacetSortValues(${unit.dataVar}, {groupField: ${JSON.stringify(field)}, ` +
        `sortField: ${JSON.stringify(facetDef.sort.field)}, op: ${JSON.stringify(facetDef.sort.op || 'mean')}, order: ${JSON.stringify(order)}});`
    );
  } else {
    const order = facetDef.sort === 'descending' ? 'descending' : 'ascending';
    statements.push(`const ${orderVar} = vlFacetSortValues(${unit.dataVar}, {groupField: ${JSON.stringify(field)}, order: ${JSON.stringify(order)}});`);
  }

  const columnsVar = newVar('facetCols');
  // Absent an explicit `columns`, Vega-Lite's own real behavior wraps
  // based on the available container width at render time -- a genuinely
  // dynamic layout decision Plot has no equivalent hook for either;
  // falling back to one single row (every value's own column count) is
  // at least deterministic and matches this project's own existing
  // simplification for a `row`/`column`-less facet.
  statements.push(`const ${columnsVar} = ${typeof facetDef.columns === 'number' ? facetDef.columns : `${orderVar}.length`};`);

  // Not self-appended to `container` here -- matching `translateMulti()`'s
  // own identical wrapper-node convention, attaching a wrapper to whatever
  // element it actually belongs under (the page's own top-level container,
  // *or* a specific cell of some further-enclosing `hconcat`/`vconcat`
  // this facet is itself nested inside) is always the caller's own
  // responsibility -- see `isWrapper` below.
  const wrapperVar = newVar('facetWrap');
  statements.push(
    `const ${wrapperVar} = container.ownerDocument.createElement('div');`,
    `${wrapperVar}.style.display = 'grid';`,
    `${wrapperVar}.style.gridTemplateColumns = \`repeat(\${${columnsVar}}, auto)\`;`,
    `${wrapperVar}.style.gap = '1em';`
  );

  // `unit.markExpr` was built against the SHARED `unit.dataVar` (the full,
  // unfiltered dataset) -- swapped here for a per-iteration filtered
  // variable via a plain identifier substitution, safe and unambiguous
  // since `newVar()` always mints a fresh name never reused anywhere else
  // in the generated file.
  const groupDataVar = newVar('facetGroupData');
  const markExprForGroup = unit.markExpr.split(unit.dataVar).join(groupDataVar);
  const pad = '  ';
  const inner = '    ';
  statements.push(`for (const __facetValue of ${orderVar}) {`);
  statements.push(`${pad}const ${groupDataVar} = ${unit.dataVar}.filter(d => d[${JSON.stringify(field)}] === __facetValue);`);
  statements.push(`${pad}const groupNode = Plot.plot({`, `${inner}document: container.ownerDocument,`, `${inner}title: String(__facetValue),`);
  if (typeof size.w === 'number') statements.push(`${inner}width: ${size.w},`);
  if (typeof size.h === 'number') statements.push(`${inner}height: ${size.h},`);
  statements.push(...renderScaleBlock(unit.scaleOptions, 2));
  statements.push(`${inner}marks: [`, `${inner}  ${markExprForGroup},`, `${inner}],`, `${pad}});`);
  statements.push(`${pad}${wrapperVar}.appendChild(groupNode);`);
  statements.push(`}`);

  return {statements, plotSrc: wrapperVar, isWrapper: true};
}

function translateFacet(node, ctx, path) {
  const facetDef = node.facet;
  if (!facetDef || typeof facetDef !== 'object') {
    if (ctx.ignoreUnsupported) return translateStandalone({...node, facet: undefined}, ctx, path);
    throw new Error('Unsupported: facet composition requires a facet field/row/column definition');
  }
  const rowField = facetDef.row && facetDef.row.field;
  const colField = facetDef.column && facetDef.column.field;
  const plainField = !rowField && !colField ? facetDef.field : null;
  if (plainField) return translateWrappedFacet(node, facetDef, ctx, path);

  // `sort` (and any other scale-shaped override) on a `row`/`column`/plain
  // facet field def -- e.g. an explicit `sort: [...]` array requesting a
  // specific panel order other than Plot's own default ascending-natural
  // order for an inferred ordinal domain. Plot's facet panels are governed
  // by real `fx`/`fy` scales, configurable the identical way any other
  // scale is (`buildScaleOptions()` already turns `sort` into a `domain`
  // override), so this reuses that same helper rather than a bespoke path.
  const facetScaleOptions = {};
  if (colField) {
    const opts = buildScaleOptions(facetDef.column, {channel: 'fx', ignoreUnsupported: ctx.ignoreUnsupported});
    if (opts) facetScaleOptions.fx = opts;
  } else if (plainField) {
    const opts = buildScaleOptions(facetDef, {channel: 'fx', ignoreUnsupported: ctx.ignoreUnsupported});
    if (opts) facetScaleOptions.fx = opts;
  }
  if (rowField) {
    const opts = buildScaleOptions(facetDef.row, {channel: 'fy', ignoreUnsupported: ctx.ignoreUnsupported});
    if (opts) facetScaleOptions.fy = opts;
  }

  const template = {...node.spec};
  const merged = mergeDown(template, {data: node.data, transform: node.transform});
  const size = panelSize(node.spec);

  // A facet *inside* a facet's own template (two-dimensional faceting
  // spelled as a nested `facet`/`spec` pair rather than a single facet with
  // both `row` and `column`) needs each mark to be re-faceted along a
  // second axis, which Plot's own single `facet: {data, x, y}` option
  // doesn't support directly -- not attempted in v1.
  if (merged.facet) {
    if (ctx.ignoreUnsupported) {
      const inner = translateFacet(merged, ctx, `${path}spec.`);
      return {
        statements: [`// vl2plot: nested faceting is not yet supported, rendering only the inner facet (--ignore-unsupported)`, ...inner.statements],
        plotSrc: inner.plotSrc,
      };
    }
    throw new Error('Unsupported: nested facet composition (facet within facet) is not yet supported by vl2plot');
  }

  // Plot's own top-level `facet: {data, x, y}` needs ONE shared data
  // variable every mark's own draw call also reads from (Plot auto-facets
  // any mark whose data is that *same* array reference) -- only
  // straightforward when the template is a plain unit view (by far the
  // common case for a faceted spec); a layered template would need each
  // layer's own mark sharing that one data variable too, not attempted in
  // v1.
  if (merged.layer) {
    if (ctx.ignoreUnsupported) {
      const sub = translateLayerOrUnit(merged, ctx, `${path}spec.`);
      const plotSrc = buildPlotCallSource(sub.markExprs, sub.scaleOptions, size, null, 1);
      return {
        statements: [`// vl2plot: faceting a layered template is not yet supported, rendering it unfaceted (--ignore-unsupported)`, ...sub.statements],
        plotSrc,
      };
    }
    throw new Error('Unsupported: faceting a layered spec template is not yet supported by vl2plot');
  }

  // Threaded down into renderMark()/commonChannels() so the mark itself
  // carries an explicit `fx`/`fy` channel matching this facet, rather than
  // relying solely on Plot's own "auto-facet a mark whose data is the
  // exact same array reference as facet.data" heuristic. That heuristic
  // alone turns out not to be robust: an explicit, non-default-ordered
  // `fx`/`fy` scale domain (see facetScaleOptions above, e.g. a facet
  // field's own `sort: [...]`) silently breaks Plot's own per-facet
  // stack computation for a stacked mark -- confirmed empirically (a
  // `Plot.stackY` grouped by a color field, faceted by a *different*
  // field, with a reordered `fy.domain`, degenerates to a flat
  // zero-height shape in every facet) -- while an explicit `fy: "field"`
  // channel on the mark itself sidesteps it entirely. Always setting it
  // costs nothing when the domain isn't reordered (identical output,
  // confirmed empirically too), so it's unconditional here rather than
  // only kicking in when a reordering is actually present.
  const facetChannelsCtx = {x: colField || plainField, y: rowField};
  const unit = translateUnit(merged, {...ctx, facetChannels: facetChannelsCtx}, `${path}spec.`);
  const facet = {dataVar: unit.dataVar, x: colField || plainField, y: rowField};
  const scaleOptions = {...unit.scaleOptions, ...facetScaleOptions};

  // Vega-Lite's own `width`/`height` on a faceted spec sizes ONE PANEL,
  // not the whole faceted grid -- but Plot's own top-level `width`/
  // `height` options size the entire faceted figure. Passing a per-panel
  // number straight through (as if it already meant the whole figure)
  // starves every row/column down to a sliver of its real share once
  // there's more than one of them -- confirmed empirically to degenerate
  // a stacked area's own per-facet geometry into a flat, zero-height line
  // once the real available height per row drops far enough below what
  // the mark's own margins need (a silent-correctness bug: it still
  // "renders," just as an invisible flat line). The actual distinct-value
  // COUNT for a row/column facet isn't knowable at code-generation time
  // for a URL-sourced dataset (the common case), so the real total figure
  // size is computed here at RUNTIME instead of baked in as a literal --
  // `size.h`/`size.w` (a plain number) get spliced as a raw expression,
  // not a literal, into `buildPlotCallSource()`'s own `width`/`height`
  // lines (which already just interpolate `size.w`/`size.h` directly, no
  // change needed there). A `{"step": n}`-shaped per-category size isn't
  // handled here (`panelSize()` only ever resolves a plain number; that
  // shape needs its own per-panel *category count* first, a separate,
  // narrower gap left undone).
  const sizeStmts = [];
  let adjustedSize = size;
  if (rowField && size.h != null) {
    const rowCountVar = newVar('facetRowCount');
    sizeStmts.push(`const ${rowCountVar} = new Set(${unit.dataVar}.map(d => d[${JSON.stringify(rowField)}])).size;`);
    adjustedSize = {...adjustedSize, h: `${size.h} * ${rowCountVar}`};
  }
  if (colField && size.w != null) {
    const colCountVar = newVar('facetColCount');
    sizeStmts.push(`const ${colCountVar} = new Set(${unit.dataVar}.map(d => d[${JSON.stringify(colField)}])).size;`);
    adjustedSize = {...adjustedSize, w: `${size.w} * ${colCountVar}`};
  }

  const plotSrc = buildPlotCallSource(unit.markExpr ? [unit.markExpr] : [], scaleOptions, adjustedSize, facet, 1);
  return {statements: [...unit.statements, ...sizeStmts], plotSrc};
}

function translateStandalone(node, ctx, path) {
  const sub = translateLayerOrUnit(node, ctx, path);
  let plotSrc = buildPlotCallSource(sub.markExprs, sub.scaleOptions, panelSize(node), null, 1);
  plotSrc = wrapWithPostFixups(plotSrc, sub.postFixups);
  return {statements: sub.statements, plotSrc};
}

// A bar mark's own min-band-size fix-up (renderBar()'s own `postFixups`,
// marks.js) has to run AFTER the enclosing `Plot.plot({...})` call has
// actually returned a real node -- there's no hook to run code *during*
// Plot's own render, and by the time `plotSrc` here is just a plain
// expression string, nothing yet has a variable name to apply a fix-up
// to. Wrapping the whole expression in a self-invoking function sidesteps
// needing one: it captures the node in its own local variable, applies
// every pending fix-up, and returns the (mutated in place) node -- self-
// contained, with no dependency on whatever variable name the *caller*
// eventually assigns this same expression to.
function wrapWithPostFixups(plotSrc, postFixups) {
  if (!postFixups || !postFixups.length) return plotSrc;
  const calls = postFixups.map(f => `vlApplyMinBandSize(__node, ${JSON.stringify(f)});`).join(' ');
  return `(() => { const __node = ${plotSrc}; ${calls} return __node; })()`;
}

function translateMulti(node, ctx, key, path) {
  const children = node[key];
  const direction = key === 'vconcat' ? 'row' : key === 'hconcat' ? 'col' : 'grid';
  const columns = typeof node.columns === 'number' ? node.columns : (direction === 'row' ? 1 : children.length);
  const flexDirection = direction === 'row' ? 'column' : 'row';

  const statements = [];
  const wrapperVar = newVar('wrapper');
  statements.push(`const ${wrapperVar} = container.ownerDocument.createElement('div');`);
  if (direction === 'grid') {
    statements.push(`${wrapperVar}.style.display = 'grid';`, `${wrapperVar}.style.gridTemplateColumns = 'repeat(${columns}, auto)';`, `${wrapperVar}.style.gap = '1em';`);
  } else {
    statements.push(`${wrapperVar}.style.display = 'flex';`, `${wrapperVar}.style.flexDirection = '${flexDirection}';`, `${wrapperVar}.style.flexWrap = 'wrap';`, `${wrapperVar}.style.gap = '1em';`);
  }

  children.forEach((child, i) => {
    const merged = mergeDown(child, {data: node.data, transform: node.transform});
    // Absent an explicit `width`/`height`, a plain unit/layer child would
    // otherwise fall through to Plot's own bare default (640x~400,
    // sized for a single standalone chart) -- with N of those side by
    // side in a `flex-wrap: wrap` row, each individual panel is already
    // wider than most containers, so every panel ends up alone on its
    // own line regardless of the `flexDirection: row` set above: an
    // hconcat visually renders as if it were stacked vertically, not a
    // translation bug in the flex direction itself but an oversized
    // per-child default fighting it. Mirrors `vl2d3`'s own identical
    // fix for the same composition (a smaller, closer-to-Vega-Lite's-
    // own-default panel size) -- skipped for a child that's itself a
    // further composition (its own nested facet/concat/etc. sizing is
    // handled by that path instead, not this one).
    const isNestedComposition = ['facet', 'hconcat', 'vconcat', 'concat', 'repeat'].some(k => k in merged);
    if (!isNestedComposition) {
      if (typeof merged.width !== 'number') merged.width = 200;
      if (typeof merged.height !== 'number') merged.height = 200;
    }
    const childPath = `${path}${key}[${i}].`;
    const childCtx = {...ctx, hint: `${ctx.hint}${i + 1}`};
    const {statements: childStmts, plotSrc} = translateNode(merged, childCtx, childPath);
    statements.push(...childStmts);
    const nodeVar = newVar(`${ctx.hint}Node${i + 1}`);
    statements.push(`const ${nodeVar} = ${plotSrc};`, `${wrapperVar}.appendChild(${nodeVar});`);
  });

  return {statements, wrapperVar};
}

// Central dispatch for any node that might itself be a further composition
// -- returns `{statements, plotSrc}` for a single-plot node, or
// `{statements, wrapperVar}` for a multi-plot (concat-family) one. Callers
// that always expect a single node (facet's own template, a layer child)
// check which shape they got back.
// Vega-Lite lets `row`/`column` appear as plain *encoding* channels on any
// unit or layer view (shared across every layer, for the layer case) --
// an alternative, more common-in-practice spelling of faceting to the
// explicit `facet: {...}, spec: {...}` composition `translateFacet()`
// already handles. Left unrecognized (as `row`/`column` aren't real mark
// channels at all), the field was silently dropped entirely: every row's
// own bars/points all drew *layered* on one shared set of axes instead of
// split into separate panels -- confirmed as the root cause behind a real
// corpus spec (`trellis_bar`) rendering as an overlaid mess instead of a
// trellis. Normalizes into the exact node shape `translateFacet()` itself
// expects, so this reuses all of its own logic (including its
// `ignoreUnsupported` fallbacks for a layered template) rather than
// duplicating any of it.
function extractEncodingFacet(node) {
  const encoding = node.encoding;
  if (!encoding || typeof encoding !== 'object') return null;
  const {row, column, facet, ...restEncoding} = encoding;
  if (!row && !column && !facet) return null;
  // `encoding.facet: {field, columns, sort}` (a *wrapped* facet spelled as
  // its own encoding channel, e.g. trellis_barley.vl.json) is a distinct
  // third spelling from `row`/`column`-as-encoding-channels -- and from
  // the *other* meaning of a bare top-level `node.facet` (the `{"facet":
  // {...}, "spec": {...}}` composition operator this same function's
  // caller already dispatches on separately). `row`/`column` win if
  // somehow present alongside it (an unusual, likely-invalid combination);
  // otherwise `facet`'s own def is used as-is (translateFacet() already
  // knows how to read a plain `{field, columns, sort}` shape, since that's
  // exactly `node.facet`'s own shape for the "wrapped" case too).
  const facetDef = row || column ? {} : facet || {};
  if (row) facetDef.row = row;
  if (column) facetDef.column = column;
  const {data, transform, ...specRest} = node;
  return {facet: facetDef, data, transform, spec: {...specRest, encoding: restEncoding}};
}

// Replaces every `{"repeat": repeatKey}` token (Vega-Lite's own repeated-
// field placeholder, appearing wherever a `field`/`datum` value would
// otherwise go) found anywhere in `node` with the literal `value` for
// this one repetition -- a plain recursive structural walk, since the
// token can appear at any depth (an `encoding` channel's own `field`, a
// `color`'s own `datum`, ...).
function substituteRepeatToken(node, repeatKey, value) {
  if (Array.isArray(node)) return node.map(n => substituteRepeatToken(n, repeatKey, value));
  if (node && typeof node === 'object') {
    if (typeof node.repeat === 'string' && node.repeat === repeatKey && Object.keys(node).length === 1) {
      return value;
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substituteRepeatToken(v, repeatKey, value);
    return out;
  }
  return node;
}

// Vega-Lite's `repeat` composition, expanded into the equivalent ordinary
// composition it already boils down to for each of its own three shapes:
// `repeat: {layer: [...]}` (repeat *as layers* sharing one panel) becomes
// a plain `layer: [...]`; `repeat: {row: [...]}` / a bare array shorthand
// `repeat: [...]` (Vega-Lite's own default meaning for the array form,
// equivalent to `column`) becomes `vconcat`/`hconcat`. Returns `null` for
// the one shape not attempted -- `row` *and* `column` together (a genuine
// 2D grid, e.g. a scatterplot matrix -- each cell would need its own
// *pair* of substituted fields, not just one substitution pass). Reuses
// every one of `translateFacet()`/`translateMulti()`'s own existing
// logic (merge-down, per-child `ignoreUnsupported` fallbacks, ...)
// entirely by construction, rather than duplicating any of it.
function expandRepeat(node) {
  const repeatDef = node.repeat;
  const {data, transform, spec, columns} = node;
  if (Array.isArray(repeatDef)) {
    // The bare-array shorthand's own substitution token is spelled
    // `{"repeat": "repeat"}` (not `{"repeat": "column"}`) -- and, unlike
    // the `row`/`column` object forms (whose own grid shape is already
    // implied by having two separate axes), commonly pairs with a
    // sibling top-level `columns: N` wrapping it into a real grid rather
    // than one long row -- `concat` (not `hconcat`) is `translateMulti()`'s
    // own "honor `columns`, wrap into a grid" composition kind.
    return {data, transform, columns, concat: repeatDef.map(value => substituteRepeatToken(spec, 'repeat', value))};
  }
  if (!repeatDef || typeof repeatDef !== 'object') return null;
  if (Array.isArray(repeatDef.layer)) {
    return {data, transform, layer: repeatDef.layer.map(value => substituteRepeatToken(spec, 'layer', value))};
  }
  if (Array.isArray(repeatDef.row) && !Array.isArray(repeatDef.column)) {
    return {data, transform, vconcat: repeatDef.row.map(value => substituteRepeatToken(spec, 'row', value))};
  }
  if (Array.isArray(repeatDef.column) && !Array.isArray(repeatDef.row)) {
    return {data, transform, hconcat: repeatDef.column.map(value => substituteRepeatToken(spec, 'column', value))};
  }
  return null;
}

function translateNode(node, ctx, path) {
  if ('facet' in node) {
    return translateFacet(node, ctx, path);
  }
  const encodingFacet = extractEncodingFacet(node);
  if (encodingFacet) {
    return translateFacet(encodingFacet, ctx, path);
  }
  if ('hconcat' in node || 'vconcat' in node || 'concat' in node) {
    const key = 'hconcat' in node ? 'hconcat' : 'vconcat' in node ? 'vconcat' : 'concat';
    const {statements, wrapperVar} = translateMulti(node, ctx, key, path);
    return {statements: [...statements], plotSrc: wrapperVar, isWrapper: true};
  }
  if ('repeat' in node) {
    const expanded = expandRepeat(node);
    if (expanded) return translateNode(expanded, ctx, path);
    // The one repeat shape not expanded above: `row` *and* `column`
    // together (a genuine 2D grid, e.g. a scatterplot matrix -- each cell
    // needs its own *pair* of substituted fields, a real nested-loop
    // shape `expandRepeat()` doesn't attempt).
    if (ctx.ignoreUnsupported) {
      // Rendering the template unsubstituted (rather than a clean skip) was
      // tried first, but is worse than doing nothing: the repeated channel
      // reference (`{field: {repeat: "layer"}}`) has no real field name to
      // fall back to, and the template's own `data`/`transform` live on
      // the *outer* repeat node, not `node.spec` -- so the "best effort"
      // render was routinely an empty dataset feeding a mark missing a
      // required channel, which throws at execution time rather than
      // degrading gracefully. An explicitly empty panel is honest about
      // the gap and never crashes.
      return {
        statements: [`// vl2plot: a 2D (row+column) 'repeat' is not yet supported, rendering an empty panel (--ignore-unsupported)`],
        plotSrc: `Plot.plot({document: container.ownerDocument, marks: []})`,
      };
    }
    throw new Error("Unsupported: a 2D (row and column together) 'repeat' is not yet supported by vl2plot");
  }
  return translateStandalone(node, ctx, path);
}

export function specToCode(spec, options = {}) {
  const {ignoreUnsupported = false, includeSourcePaths = false} = options;
  let root = {...spec};
  delete root.$schema;
  if (root.datasets) {
    root = resolveDatasetRefs(root, root.datasets);
    delete root.datasets;
  }

  varCounts = {};
  const ctx = {ignoreUnsupported, includeSourcePaths, hint: 'chart', config: root.config || {}};
  const {statements, plotSrc, isWrapper} = translateNode(root, ctx, '');

  const bodyLines = [];
  bodyLines.push('export default async function chart(container, options = {}) {');
  for (const s of statements) bodyLines.push(`  ${s}`);
  if (isWrapper) {
    bodyLines.push(`  container.appendChild(${plotSrc});`, `  return ${plotSrc};`);
  } else {
    const nodeVar = 'node';
    bodyLines.push(`  const ${nodeVar} = ${plotSrc};`, `  container.appendChild(${nodeVar});`, `  return ${nodeVar};`);
  }
  bodyLines.push('}');

  const bodyText = bodyLines.join('\n');
  const needsD3 = /\bd3\.\w+\(/.test(bodyText);
  const runtimeHelpers = ['vlStack', 'vlFlattenOneLevel', 'vlFlatten', 'vlDensity', 'VlArc', 'VlTrail', 'vlWindow', 'vlArgAggregate', 'vlFacetSortValues', 'vlApplyMinBandSize'].filter(name =>
    new RegExp(`\\b${name}\\(`).test(bodyText)
  );

  const header = [
    `// Generated by vl2plot.vegaLiteToPlotCode(spec, {ignoreUnsupported: ${ignoreUnsupported}, ` +
      `includeSourcePaths: ${includeSourcePaths}})`,
    'import * as Plot from "@observablehq/plot";',
  ];
  if (needsD3) header.push('import * as d3 from "d3";');
  if (runtimeHelpers.length) header.push(`import {${runtimeHelpers.join(', ')}} from "./vl2plot-runtime.js";`);

  return [...header, '', ...bodyLines].join('\n');
}
