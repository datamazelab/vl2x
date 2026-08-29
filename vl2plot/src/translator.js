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

// Translates one unit view (a real `mark`, not a further composition):
// returns `{statements, dataVar, markExpr, scaleOptions}`.
function translateUnit(node, ctx, path) {
  const dataVar = newVar(`${ctx.hint}Data`);
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

  const encoding = node.encoding || {};
  const {statements: markStmts, markExpr} = renderMark(node.mark, encoding, dataVar, ctx.ignoreUnsupported);
  statements.push(...markStmts);
  if (markExpr) {
    const channels = ['mark', ...Object.keys(encoding).map(ch => `encoding.${ch}`)];
    statements.push(...sourceComment(`${path}${channels.join(', ')}`, ctx.includeSourcePaths));
  }

  const markType = typeof node.mark === 'string' ? node.mark : node.mark && node.mark.type;
  return {statements, dataVar, markExpr, scaleOptions: collectScaleOptions(encoding, markType, ctx.ignoreUnsupported)};
}

// Translates a `layer` composition (or a plain unit view, treated as a
// trivial one-mark "layer") into one shared `Plot.plot()`'s worth of marks.
function translateLayerOrUnit(node, ctx, path) {
  if (!('layer' in node)) {
    const {statements, markExpr, scaleOptions} = translateUnit(node, ctx, path);
    return {statements, markExprs: markExpr ? [markExpr] : [], scaleOptions};
  }
  const statements = [];
  const markExprs = [];
  let scaleOptions = {};
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
  });
  return {statements, markExprs, scaleOptions};
}

function panelSize(node) {
  const w = typeof node.width === 'number' ? node.width : null;
  const h = typeof node.height === 'number' ? node.height : null;
  return {w, h};
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

function translateFacet(node, ctx, path) {
  const facetDef = node.facet;
  if (!facetDef || typeof facetDef !== 'object') {
    if (ctx.ignoreUnsupported) return translateStandalone({...node, facet: undefined}, ctx, path);
    throw new Error('Unsupported: facet composition requires a facet field/row/column definition');
  }
  const rowField = facetDef.row && facetDef.row.field;
  const colField = facetDef.column && facetDef.column.field;
  const plainField = !rowField && !colField ? facetDef.field : null;

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

  const unit = translateUnit(merged, ctx, `${path}spec.`);
  const facet = {dataVar: unit.dataVar, x: colField || plainField, y: rowField};
  const plotSrc = buildPlotCallSource(unit.markExpr ? [unit.markExpr] : [], unit.scaleOptions, size, facet, 1);
  return {statements: unit.statements, plotSrc};
}

function translateStandalone(node, ctx, path) {
  const sub = translateLayerOrUnit(node, ctx, path);
  const plotSrc = buildPlotCallSource(sub.markExprs, sub.scaleOptions, panelSize(node), null, 1);
  return {statements: sub.statements, plotSrc};
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
function translateNode(node, ctx, path) {
  if ('facet' in node) {
    return translateFacet(node, ctx, path);
  }
  if ('hconcat' in node || 'vconcat' in node || 'concat' in node) {
    const key = 'hconcat' in node ? 'hconcat' : 'vconcat' in node ? 'vconcat' : 'concat';
    const {statements, wrapperVar} = translateMulti(node, ctx, key, path);
    return {statements: [...statements], plotSrc: wrapperVar, isWrapper: true};
  }
  if ('repeat' in node) {
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
        statements: [`// vl2plot: 'repeat' composition is not yet supported, rendering an empty panel (--ignore-unsupported)`],
        plotSrc: `Plot.plot({document: container.ownerDocument, marks: []})`,
      };
    }
    throw new Error("Unsupported top-level composition: 'repeat' is not yet supported by vl2plot");
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
  const ctx = {ignoreUnsupported, includeSourcePaths, hint: 'chart'};
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

  const header = [
    `// Generated by vl2plot.vegaLiteToPlotCode(spec, {ignoreUnsupported: ${ignoreUnsupported}, ` +
      `includeSourcePaths: ${includeSourcePaths}})`,
    'import * as Plot from "@observablehq/plot";',
  ];
  if (needsD3) header.push('import * as d3 from "d3";');

  return [...header, '', ...bodyLines].join('\n');
}
