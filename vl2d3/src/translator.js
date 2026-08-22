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

const UNSUPPORTED_COMPOSITIONS = ['facet', 'repeat', 'concat', 'hconcat', 'vconcat'];
const GEO_CHANNELS = ['longitude', 'latitude', 'longitude2', 'latitude2'];

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
    let encodingIn = child.encoding || {};
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

    const temporalFields = collectTemporalFields(encodingIn, child.transform || []);
    renderTemporalCoercion(dataVar, temporalFields).forEach(b);

    if (child.transform) renderTransforms(child.transform, dataVar, ignoreUnsupported).forEach(b);

    const {statements: prepStmts, encoding} = prepareEncoding(encodingIn, dataVar, ignoreUnsupported);
    prepStmts.forEach(b);

    return {dataVar, encoding, originalEncoding: encodingIn, mark: child.mark};
  });
  lines.push('');

  const allDataExpr = prepared.length > 1 ? `[${prepared.map(p => `...${p.dataVar}`).join(', ')}]` : prepared[0].dataVar;

  // -- shared scales --
  const scales = {};
  const zeroBaseline = prepared.some(p => isBarOrArea(p.mark));

  for (const channel of ['x', 'y']) {
    const def = prepared.map(p => p.encoding[channel]).find(Boolean);
    if (!def || 'value' in def) continue;
    const scale = resolvePositionScale(channel, def, {
      dataVar: allDataExpr,
      rangeExpr: dims[`${channel}RangeExpr`],
      zeroBaseline: zeroBaseline && def.type === 'quantitative',
      ignoreUnsupported,
    });
    b(scale.decl);
    scales[channel] = scale;
  }
  for (const [channel, resolver] of [['color', resolveColorScale], ['size', resolveSizeScale], ['opacity', resolveOpacityScale]]) {
    const def = prepared.map(p => p.encoding[channel]).find(Boolean);
    if (!def || 'value' in def) continue;
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
    let markCode = renderMark(p.mark, p.encoding, scales, dims, p.dataVar, ignoreUnsupported);
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
  const root = {...spec};
  delete root.$schema;

  const compositionKey = UNSUPPORTED_COMPOSITIONS.find(key => key in root);
  if (compositionKey && !ignoreUnsupported) {
    throw new Error(
      `Unsupported top-level composition: "${compositionKey}" is not yet supported by vl2d3 ` +
        '(single view and layer are supported)'
    );
  }

  const lines = ['import * as d3 from "d3";', ''];
  lines.push(...buildPanelFunction(root, 'chart', ignoreUnsupported, 'export default '));

  return lines.join('\n');
}
