// Generate the D3 "join" code that actually draws a mark, given already-
// resolved scales (see scales.js) and the (prepare.js-rewritten) encoding.

import {formatValue} from './literals.js';

const DEFAULT_FILL = 'steelblue';
const DEFAULT_STROKE = 'steelblue';

// A handful of mark properties (interpolate, tension, strokeWidth, ...) can
// be bound to a signal/param via `{"expr": "..."}` instead of a literal --
// that requires live parameter binding this project doesn't implement (see
// the "params" scope note in translator.js), so fail clearly rather than
// silently splicing "[object Object]" into the generated source.
function simpleMarkProp(value, fallback, propName) {
  if (value === undefined) return fallback;
  if (typeof value === 'object') {
    throw new Error(`Unsupported: mark property "${propName}" is bound to an expression/signal, not a literal value`);
  }
  return value;
}

// A channel definition resolves to one of: a literal `value`, a scaled
// field access (`scaleVar(d["field"])`), or a raw field access (no scale
// resolved for this channel, e.g. `text`).
function accessor(def, scales, channel) {
  if (!def) return null;
  if ('value' in def) return formatValue(def.value);
  const scale = scales[channel];
  const field = `d[${JSON.stringify(def.field)}]`;
  return scale ? `${scale.varName}(${field})` : field;
}

function rawField(def) {
  return def && def.field ? `d[${JSON.stringify(def.field)}]` : null;
}

function fillExpr(encoding, scales, fallback = DEFAULT_FILL) {
  if (encoding.color) return accessor(encoding.color, scales, 'color');
  return JSON.stringify(fallback);
}

// Whether `fillExpr(encoding, ...)` produces a per-row expression
// (references `d`) rather than a constant -- callers need to know this to
// decide whether the fill/stroke belongs on the enclosing <g> (a constant,
// inherited by SVG's cascade) or on each joined element (an accessor
// function, since there's no per-row `d` in scope at the <g> level).
function hasRowDependentColor(encoding) {
  return Boolean(encoding.color);
}

function opacityAttr(encoding, scales) {
  if (!encoding.opacity) return null;
  return accessor(encoding.opacity, scales, 'opacity');
}

function tooltipTitle(encoding) {
  const t = encoding.tooltip;
  if (!t) return null;
  const defs = Array.isArray(t) ? t : [t];
  const parts = defs.filter(d => d.field).map(d => `${d.title || d.field}: \${d[${JSON.stringify(d.field)}]}`);
  return parts.length ? '`' + parts.join('\\n') + '`' : null;
}

function appendTitle(lines, indent, encoding) {
  const title = tooltipTitle(encoding);
  if (title) lines.push(`${indent}.each(function(d) { d3.select(this).append("title").text(${title}); })`);
}

export function renderMark(mark, encoding, scales, dims, dataVar) {
  const type = typeof mark === 'string' ? mark : mark.type;
  const markProps = typeof mark === 'string' ? {} : mark;
  switch (type) {
    case 'bar':
      return renderBar(encoding, scales, dims, dataVar, markProps);
    case 'point':
    case 'circle':
      return renderPoint(encoding, scales, dims, dataVar, markProps);
    case 'line':
      return renderLine(encoding, scales, dims, dataVar, markProps);
    case 'area':
      return renderArea(encoding, scales, dims, dataVar, markProps);
    case 'rule':
      return renderRule(encoding, scales, dims, dataVar, markProps);
    case 'tick':
      return renderTick(encoding, scales, dims, dataVar, markProps);
    case 'text':
      return renderText(encoding, scales, dims, dataVar, markProps);
    case 'arc':
      return renderArc(encoding, scales, dims, dataVar, markProps);
    default:
      throw new Error(`Unsupported mark type: "${type}"`);
  }
}

function renderBar(encoding, scales, dims, dataVar, markProps) {
  const {x, y} = scales;
  const xBand = x && x.kind === 'band';
  const yBand = y && y.kind === 'band';
  const fill = fillExpr(encoding, scales);
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`  .attr("fill", ${fill})`);
  lines.push(`  .selectAll("rect")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("rect")`);
  if (rowDependent) lines.push(`    .attr("fill", d => ${fill})`);

  if (xBand && !yBand) {
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
    lines.push(`    .attr("width", x.bandwidth())`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yBand && !xBand) {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    lines.push(`    .attr("height", y.bandwidth())`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (encoding.x2 && !encoding.y2) {
    lines.push(`    .attr("x", d => Math.min(x(d[${JSON.stringify(encoding.x.field)}]), x(d[${JSON.stringify(encoding.x2.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(d[${JSON.stringify(encoding.x2.field)}]) - x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (encoding.y2 && !encoding.x2) {
    lines.push(`    .attr("y", d => Math.min(y(d[${JSON.stringify(encoding.y.field)}]), y(d[${JSON.stringify(encoding.y2.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(d[${JSON.stringify(encoding.y2.field)}]) - y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else {
    throw new Error(
      'Unsupported bar orientation: expected one ordinal/band position channel and one quantitative, ' +
        'or a quantitative range via x2/y2'
    );
  }
  appendTitle(lines, '    ', encoding);
  return lines.join('\n');
}

function renderPoint(encoding, scales, dims, dataVar, markProps) {
  const {x, y, size} = scales;
  // A 1D strip/dot plot (only one of x/y given) centers points on the
  // missing axis rather than requiring both; with neither given, every
  // point is centered on both (all overlapping) rather than refusing to
  // render at all.
  const cx = x ? accessor(encoding.x, scales, 'x') : dims.centerXExpr;
  const cy = y ? accessor(encoding.y, scales, 'y') : dims.centerYExpr;
  const r = size
    ? `size(d[${JSON.stringify(encoding.size.field)}])`
    : formatValue(markProps.size ? Math.sqrt(simpleMarkProp(markProps.size, 9, "size") / Math.PI) : 3);
  const fill = fillExpr(encoding, scales);
  const opacity = opacityAttr(encoding, scales);
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`  .attr("fill", ${fill})`);
  lines.push(`  .attr("fill-opacity", ${markProps.filled === false ? 0 : 0.8})`);
  lines.push(`  .selectAll("circle")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("circle")`);
  if (rowDependent) lines.push(`    .attr("fill", d => ${fill})`);
  lines.push(`    .attr("cx", d => ${cx})`);
  lines.push(`    .attr("cy", d => ${cy})`);
  lines.push(`    .attr("r", d => ${r})`);
  if (opacity) lines.push(`    .attr("opacity", d => ${opacity})`);
  appendTitle(lines, '    ', encoding);
  return lines.join('\n');
}

function seriesGroupField(encoding) {
  const detail = encoding.color || encoding.detail;
  if (!detail || !detail.field) return null;
  // Vega-Lite defaults a field with no explicit `type` to nominal, so an
  // absent type is groupable too -- only an explicit quantitative/temporal
  // type rules it out.
  return detail.type === 'quantitative' || detail.type === 'temporal' ? null : detail.field;
}

function renderLine(encoding, scales, dims, dataVar, markProps) {
  const {x, y} = scales;
  if (!x || !y) throw new Error('"line" mark requires both x and y encodings');
  const cx = accessor(encoding.x, scales, 'x');
  const cy = accessor(encoding.y, scales, 'y');
  const groupField = seriesGroupField(encoding);
  const lines = [];

  if (groupField) {
    const stroke = encoding.color ? `color(key)` : JSON.stringify(DEFAULT_STROKE);
    lines.push(`svg.append("g")`);
    lines.push(`    .attr("fill", "none")`);
    lines.push(`    .attr("stroke-width", ${formatValue(simpleMarkProp(markProps.strokeWidth, 1.5, "strokeWidth"))})`);
    lines.push(`  .selectAll("path")`);
    lines.push(`  .data(d3.group(${dataVar}, d => d[${JSON.stringify(groupField)}]))`);
    lines.push(`  .join("path")`);
    lines.push(`    .attr("stroke", ([key]) => ${stroke})`);
    lines.push(
      `    .attr("d", ([, rows]) => d3.line().x(d => ${cx}).y(d => ${cy})` +
        `(rows.slice().sort((a, b) => d3.ascending(a[${JSON.stringify(encoding.x.field)}], b[${JSON.stringify(encoding.x.field)}]))));`
    );
  } else {
    const stroke = markProps.stroke ? formatValue(markProps.stroke) : JSON.stringify(DEFAULT_STROKE);
    lines.push(`svg.append("path")`);
    lines.push(`    .attr("fill", "none")`);
    lines.push(`    .attr("stroke", ${stroke})`);
    lines.push(`    .attr("stroke-width", ${formatValue(simpleMarkProp(markProps.strokeWidth, 1.5, "strokeWidth"))})`);
    lines.push(
      `    .attr("d", d3.line().x(d => ${cx}).y(d => ${cy})` +
        `(${dataVar}.slice().sort((a, b) => d3.ascending(a[${JSON.stringify(encoding.x.field)}], b[${JSON.stringify(encoding.x.field)}]))));`
    );
  }
  return lines.join('\n');
}

function renderArea(encoding, scales, dims, dataVar, markProps) {
  const {x, y} = scales;
  if (!x || !y) throw new Error('"area" mark requires both x and y encodings');
  const cx = accessor(encoding.x, scales, 'x');
  const y1 = accessor(encoding.y, scales, 'y');
  const y0 = encoding.y2 ? `y(d[${JSON.stringify(encoding.y2.field)}])` : 'y(0)';
  const groupField = seriesGroupField(encoding);
  const xField = JSON.stringify(encoding.x.field);
  const lines = [];
  const fill = fillExpr(encoding, scales);

  if (groupField) {
    lines.push(`svg.append("g")`);
    lines.push(`    .attr("fill-opacity", 0.7)`);
    lines.push(`  .selectAll("path")`);
    lines.push(`  .data(d3.group(${dataVar}, d => d[${JSON.stringify(groupField)}]))`);
    lines.push(`  .join("path")`);
    lines.push(`    .attr("fill", ([key]) => ${encoding.color ? 'color(key)' : fill})`);
    lines.push(
      `    .attr("d", ([, rows]) => d3.area().x(d => ${cx}).y0(d => ${y0}).y1(d => ${y1})` +
        `(rows.slice().sort((a, b) => d3.ascending(a[${xField}], b[${xField}]))));`
    );
  } else {
    lines.push(`svg.append("path")`);
    lines.push(`    .attr("fill", ${fill})`);
    lines.push(
      `    .attr("d", d3.area().x(d => ${cx}).y0(d => ${y0}).y1(d => ${y1})` +
        `(${dataVar}.slice().sort((a, b) => d3.ascending(a[${xField}], b[${xField}]))));`
    );
  }
  return lines.join('\n');
}

function renderRule(encoding, scales, dims, dataVar) {
  const {x, y} = scales;
  const stroke = fillExpr(encoding, scales, 'black');
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`    .attr("stroke", ${stroke})`);
  lines.push(`  .selectAll("line")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("line")`);
  if (rowDependent) lines.push(`    .attr("stroke", d => ${stroke})`);
  if (encoding.x && encoding.x2) {
    lines.push(`    .attr("x1", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
    lines.push(`    .attr("x2", d => x(d[${JSON.stringify(encoding.x2.field)}]))`);
    lines.push(`    .attr("y1", d => ${y ? accessor(encoding.y, scales, 'y') : dims.marginTopExpr})`);
    lines.push(`    .attr("y2", d => ${y ? accessor(encoding.y, scales, 'y') : dims.heightMinusBottomExpr})`);
  } else if (encoding.y && encoding.y2) {
    lines.push(`    .attr("y1", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    lines.push(`    .attr("y2", d => y(d[${JSON.stringify(encoding.y2.field)}]))`);
    lines.push(`    .attr("x1", d => ${x ? accessor(encoding.x, scales, 'x') : dims.marginLeftExpr})`);
    lines.push(`    .attr("x2", d => ${x ? accessor(encoding.x, scales, 'x') : dims.widthMinusRightExpr})`);
  } else if (encoding.x && !encoding.y) {
    lines.push(`    .attr("x1", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
    lines.push(`    .attr("x2", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
    lines.push(`    .attr("y1", ${dims.marginTopExpr})`);
    lines.push(`    .attr("y2", ${dims.heightMinusBottomExpr})`);
  } else if (encoding.y && !encoding.x) {
    lines.push(`    .attr("y1", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    lines.push(`    .attr("y2", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    lines.push(`    .attr("x1", ${dims.marginLeftExpr})`);
    lines.push(`    .attr("x2", ${dims.widthMinusRightExpr})`);
  } else {
    throw new Error('"rule" mark requires an x and/or y encoding');
  }
  return lines.join('\n');
}

function renderTick(encoding, scales, dims, dataVar) {
  const {x, y} = scales;
  if (!x && !y) throw new Error('"tick" mark requires an x and/or y encoding');
  const xBand = x && (x.kind === 'band' || x.kind === 'point');
  const stroke = fillExpr(encoding, scales, 'black');
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`    .attr("stroke", ${stroke})`);
  lines.push(`  .selectAll("line")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("line")`);
  if (rowDependent) lines.push(`    .attr("stroke", d => ${stroke})`);

  const xField = x && JSON.stringify(encoding.x.field);
  const yField = y && JSON.stringify(encoding.y.field);
  const TICK_HALF = 10; // half-length used along an axis with no scale (1D strip plots)

  if (x && y) {
    const half = x.kind === 'band' ? 'x.bandwidth() / 2' : '4';
    lines.push(`    .attr("x1", d => x(d[${xField}]) - ${half})`);
    lines.push(`    .attr("x2", d => x(d[${xField}]) + ${half})`);
    lines.push(`    .attr("y1", d => y(d[${yField}]))`);
    lines.push(`    .attr("y2", d => y(d[${yField}]))`);
  } else if (x && !y) {
    // 1D strip plot along x: short vertical ticks centered on the plot.
    lines.push(`    .attr("x1", d => x(d[${xField}]))`);
    lines.push(`    .attr("x2", d => x(d[${xField}]))`);
    lines.push(`    .attr("y1", ${dims.centerYExpr} - ${TICK_HALF})`);
    lines.push(`    .attr("y2", ${dims.centerYExpr} + ${TICK_HALF})`);
  } else {
    // 1D strip plot along y: short horizontal ticks centered on the plot.
    lines.push(`    .attr("y1", d => y(d[${yField}]))`);
    lines.push(`    .attr("y2", d => y(d[${yField}]))`);
    lines.push(`    .attr("x1", ${dims.centerXExpr} - ${TICK_HALF})`);
    lines.push(`    .attr("x2", ${dims.centerXExpr} + ${TICK_HALF})`);
  }
  return lines.join('\n');
}

function renderText(encoding, scales, dims, dataVar) {
  if (!encoding.text) throw new Error('"text" mark requires a text encoding');
  const cx = encoding.x ? accessor(encoding.x, scales, 'x') : dims.centerXExpr;
  const cy = encoding.y ? accessor(encoding.y, scales, 'y') : dims.centerYExpr;
  const textField = rawField(encoding.text) || formatValue(encoding.text.value);
  const fill = fillExpr(encoding, scales, 'black');
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];
  lines.push(`svg.append("g")`);
  lines.push(`    .attr("text-anchor", "middle")`);
  if (!rowDependent) lines.push(`    .attr("fill", ${fill})`);
  lines.push(`  .selectAll("text")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("text")`);
  if (rowDependent) lines.push(`    .attr("fill", d => ${fill})`);
  lines.push(`    .attr("x", d => ${cx})`);
  lines.push(`    .attr("y", d => ${cy})`);
  lines.push(`    .attr("dy", "0.32em")`);
  lines.push(`    .text(d => ${textField})`);
  return lines.join('\n');
}

function renderArc(encoding, scales, dims, dataVar) {
  if (!encoding.theta) throw new Error('"arc" mark requires a theta encoding');
  const valueField = JSON.stringify(encoding.theta.field);
  const fill = encoding.color ? `d => color(d.data[${JSON.stringify(encoding.color.field)}])` : `() => ${JSON.stringify(DEFAULT_FILL)}`;
  const lines = [];
  lines.push(`{`);
  lines.push(`  const radius = Math.min(${dims.innerWidthExpr}, ${dims.innerHeightExpr}) / 2;`);
  lines.push(`  const pie = d3.pie().value(d => d[${valueField}]).sort(null);`);
  lines.push(`  const arcGen = d3.arc().innerRadius(0).outerRadius(radius);`);
  lines.push(`  svg.append("g")`);
  lines.push(`      .attr("transform", \`translate(\${${dims.centerXExpr}},\${${dims.centerYExpr}})\`)`);
  lines.push(`    .selectAll("path")`);
  lines.push(`    .data(pie(${dataVar}))`);
  lines.push(`    .join("path")`);
  lines.push(`      .attr("d", arcGen)`);
  lines.push(`      .attr("fill", ${fill});`);
  lines.push(`}`);
  return lines.join('\n');
}
