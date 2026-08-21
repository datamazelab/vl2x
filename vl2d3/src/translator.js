// Recursive-ish translation of a Vega-Lite spec into a standalone D3
// chart-drawing function.
//
// Scope: single unit views, and `layer` (children rendered on shared
// scales/axes). `facet`, `repeat`, `concat`, `hconcat`, `vconcat` throw a
// clear "not supported" error -- D3 has no small-multiples primitive of its
// own, and faithfully reproducing Vega-Lite's layout/resolve semantics by
// hand is a substantially larger project than a single-view renderer.

import {renderDataLoad, renderTemporalCoercion} from './data.js';
import {renderTransforms} from './transforms.js';
import {prepareEncoding} from './prepare.js';
import {resolvePositionScale, resolveColorScale, resolveSizeScale, resolveOpacityScale} from './scales.js';
import {renderMark} from './marks.js';
import {formatValue} from './literals.js';
import {extractDateFunctionFields} from './expr.js';

const UNSUPPORTED_COMPOSITIONS = ['facet', 'repeat', 'concat', 'hconcat', 'vconcat'];

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

export function specToCode(spec) {
  const root = {...spec};
  delete root.$schema;

  for (const key of UNSUPPORTED_COMPOSITIONS) {
    if (key in root) {
      throw new Error(
        `Unsupported top-level composition: "${key}" is not yet supported by vl2d3 ` +
          '(single view and layer are supported)'
      );
    }
  }

  const children = flattenLayers(root, {});

  const lines = [];
  lines.push('import * as d3 from "d3";', '');
  lines.push('export default async function chart(container, options = {}) {');
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
    const geoChannel = ['longitude', 'latitude', 'longitude2', 'latitude2'].find(k => child.encoding && k in child.encoding);
    if (geoChannel) {
      throw new Error(
        `Unsupported: geographic encoding ("${geoChannel}") is not yet supported by vl2d3 -- ` +
          'no map projection support'
      );
    }

    const dataVar = `data${i + 1}`;
    const {statements: loadStmts, isAsync} = renderDataLoad(child.data, dataVar);
    loadStmts.forEach(b);

    const temporalFields = collectTemporalFields(child.encoding || {}, child.transform || []);
    renderTemporalCoercion(dataVar, temporalFields).forEach(b);

    if (child.transform) renderTransforms(child.transform, dataVar).forEach(b);

    const {statements: prepStmts, encoding} = prepareEncoding(child.encoding || {}, dataVar);
    prepStmts.forEach(b);

    return {dataVar, encoding, originalEncoding: child.encoding || {}, mark: child.mark};
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
    });
    b(scale.decl);
    scales[channel] = scale;
  }
  for (const [channel, resolver] of [['color', resolveColorScale], ['size', resolveSizeScale], ['opacity', resolveOpacityScale]]) {
    const def = prepared.map(p => p.encoding[channel]).find(Boolean);
    if (!def || 'value' in def) continue;
    const scale = resolver(def, {dataVar: allDataExpr});
    b(scale.decl);
    scales[channel] = scale;
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
    let markCode = renderMark(p.mark, p.encoding, scales, dims, p.dataVar);
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
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
