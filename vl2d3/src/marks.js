// Generate the D3 "join" code that actually draws a mark, given already-
// resolved scales (see scales.js) and the (prepare.js-rewritten) encoding.

import {formatValue} from './literals.js';

const DEFAULT_FILL = 'steelblue';
const DEFAULT_STROKE = 'steelblue';

// A handful of mark properties (interpolate, tension, strokeWidth, ...) can
// be bound to a signal/param via `{"expr": "..."}` instead of a literal --
// that requires live parameter binding this project doesn't implement (see
// the "params" scope note in translator.js), so fail clearly rather than
// silently splicing "[object Object]" into the generated source -- unless
// `ignoreUnsupported` is set, in which case the given `fallback` is used in
// place of the bound expression.
function simpleMarkProp(value, fallback, propName, ignoreUnsupported = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'object') {
    if (ignoreUnsupported) return fallback;
    throw new Error(`Unsupported: mark property "${propName}" is bound to an expression/signal, not a literal value`);
  }
  return value;
}

// An inline comment to append next to a value simpleMarkProp() above fell
// back on -- '' (no comment) whenever the mark prop wasn't actually bound
// to an expression/signal at all (the ordinary case).
function markPropNote(value, propName, ignoreUnsupported) {
  if (!ignoreUnsupported || typeof value !== 'object' || value === null) return '';
  return ` /* vl2d3: mark property "${propName}" is bound to an expression/signal, using the default instead (--ignore-unsupported) */`;
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

// Same idea as accessor(), but folds in a dodged/grouped position offset
// (xOffset/yOffset) when this channel has one and scales.js built a
// sub-band scale for it (see resolveOffsetScale()) -- centers the mark
// within its own offset sub-band instead of at the shared outer-band
// position every group would otherwise sit on top of. Falls back to the
// plain accessor() whenever there's no such offset (the common case), so
// callers can use this in place of accessor() uniformly for x/y.
function dodgeAwareAccessor(encoding, scales, channel) {
  const def = encoding[channel];
  const base = accessor(def, scales, channel);
  if (base === null || !def || !('field' in def)) return base;
  const offsetChannel = channel === 'x' ? 'xOffset' : 'yOffset';
  const offsetDef = encoding[offsetChannel];
  const offsetScale = scales[offsetChannel];
  if (!offsetDef || !offsetDef.field || !offsetScale) return base;
  const withOffset = `${base} + ${offsetScale.varName}(d[${JSON.stringify(offsetDef.field)}]) + ${offsetScale.varName}.bandwidth() / 2`;
  return offsetScale.conditional ? `(${offsetScale.varName} ? (${withOffset}) : (${base}))` : withOffset;
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

const SKIP_COMMENT = reason => `// vl2d3: mark not drawn (${reason}, --ignore-unsupported)`;

// Marks with no renderer of their own get approximated by the nearest
// supported one when `ignoreUnsupported` is set, rather than refusing to
// render at all:
//  - `rect`/`errorbar`/`errorband` with an x2/y2 range -> drawn as a bar
//    (renderBar already handles the ranged-box case); without a range,
//    falls through to a point per row (still shows the underlying data,
//    just not the summary/band shape).
//  - `boxplot` -> a tick/strip per row (raw values, not the quartile
//    summary -- computing quantiles isn't implemented).
//  - `trail` -> a plain line (drops the width-by-`size` encoding).
//  - `square`/anything else unrecognized -> a point.
function renderApproximateMark(type, encoding, scales, dims, dataVar, markProps, ignoreUnsupported) {
  const note = asType => `// vl2d3: unsupported mark type "${type}", drawing as "${asType}" instead (--ignore-unsupported)`;
  if ((type === 'rect' || type === 'errorbar' || type === 'errorband') && (encoding.x2 || encoding.y2)) {
    return note('bar') + '\n' + renderBar(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
  }
  if (type === 'boxplot' && (scales.x || scales.y)) {
    return note('tick') + '\n' + renderTick(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
  }
  if (type === 'trail') {
    return note('line') + '\n' + renderLine(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
  }
  return note('point') + '\n' + renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
}

export function renderMark(mark, encoding, scales, dims, dataVar, ignoreUnsupported = false) {
  const type = typeof mark === 'string' ? mark : mark.type;
  const markProps = typeof mark === 'string' ? {} : mark;
  switch (type) {
    case 'bar':
      return renderBar(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'rect':
      // A genuine box on both axes (e.g. prepare.js's 2D-bin heatmap case)
      // is fully well-defined, not an approximation -- draw it the same
      // way "bar" draws its own x2/y2 range, without needing
      // ignoreUnsupported. Requires all four corners to be plain field
      // references (not a `datum`/`value`/param-bound box, which renderBar
      // doesn't resolve): anything narrower is still only handled as a
      // best-effort approximation, via the default case below.
      if (encoding.x2 && encoding.y2 && encoding.x.field && encoding.x2.field && encoding.y.field && encoding.y2.field) {
        return renderBar(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
      }
      if (ignoreUnsupported) {
        return renderApproximateMark(type, encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
      }
      throw new Error('Unsupported mark type: "rect" (expected an x2/y2 range on both axes)');
    case 'point':
    case 'circle':
    case 'square':
      return renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'line':
      return renderLine(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'area':
      return renderArea(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'rule':
      return renderRule(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'tick':
      return renderTick(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'text':
      return renderText(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'arc':
      return renderArc(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    default:
      if (ignoreUnsupported) {
        return renderApproximateMark(type, encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
      }
      throw new Error(`Unsupported mark type: "${type}"`);
  }
}

// A temporal position channel resolves to a continuous d3.scaleTime, not a
// scaleBand, so it has no .bandwidth() to size a bar against even though
// Vega-Lite still draws one bar per distinct timeUnit bucket (e.g. one per
// month) at this width. There's no fixed band step to ask the scale for, so
// this derives one from the data instead: the (average) pixel gap between
// each distinct scaled x-position actually present, shrunk to leave a
// visible gap between adjacent bars -- approximating what scaleBand's own
// bandwidth() would give if the axis were banded.
function temporalBarWidthDecl(varName, scaleVarName, dataVar, field) {
  return (
    `const ${varName} = (() => {\n` +
    `  const xs = Array.from(new Set(${dataVar}.map(d => ${scaleVarName}(d[${JSON.stringify(field)}])))).sort((a, b) => a - b);\n` +
    `  return xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) * 0.7 : 20;\n` +
    `})();`
  );
}

// Same idea as temporalBarWidthDecl(), for a position channel whose scale
// kind (banded vs. continuous) itself isn't known until the data has
// loaded (scales.js's "ambiguous" case -- a bare `{field: ...}` with no
// type, and thus no way to tell nominal from quantitative ahead of time):
// checks the SAME runtime `scale.isNominalVar` flag the scale declaration
// itself used, so the two stay in sync.
function ambiguousBarWidthDecl(varName, scale, dataVar, field) {
  const isNom = scale.isNominalVar;
  return (
    `const ${varName} = ${isNom} ? ${scale.varName}.bandwidth() : (() => {\n` +
    `  const xs = Array.from(new Set(${dataVar}.map(d => ${scale.varName}(d[${JSON.stringify(field)}])))).sort((a, b) => a - b);\n` +
    `  return xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) * 0.7 : 20;\n` +
    `})();`
  );
}

function renderBar(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const {x, y} = scales;
  const xBand = x && x.kind === 'band';
  const yBand = y && y.kind === 'band';
  const xTemporalBar = !xBand && x && encoding.x && encoding.x.type === 'temporal';
  const yTemporalBar = !yBand && y && encoding.y && encoding.y.type === 'temporal';
  const xAmbiguous = x && x.kind === 'ambiguous';
  const yAmbiguous = y && y.kind === 'ambiguous';
  const fill = fillExpr(encoding, scales);
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];
  // Both variable names are plain (not field-derived) since the whole
  // block below is wrapped in `{ }` whenever either is declared (see
  // `needsWidthBlock` at the end of this function) -- own lexical scope,
  // so a chart with more than one bar layer needing this (e.g. two
  // temporal-axis bar layers, or two histogram layers sharing a bin field
  // name) can't collide on a `const` already declared by a sibling layer's
  // generated code in the same enclosing function scope.
  const xBarWidthVar = 'barWidth';
  const yBarWidthVar = 'barWidth';
  // Dodged/grouped bars where the outer axis's band-vs-continuous shape
  // itself isn't known until runtime (scales.js's "ambiguous" case --
  // resolveOffsetScale() made the offset scale itself conditional on the
  // same flag): the offset scale is `null` whenever the outer scale turned
  // out continuous, so the fallback (non-dodged) width/position logic
  // still needs computing as a backstop, exactly as if there were no
  // xOffset at all.
  const xOffsetAmbiguous = xAmbiguous && encoding.xOffset && scales.xOffset && scales.xOffset.conditional;
  const yOffsetAmbiguous = yAmbiguous && encoding.yOffset && scales.yOffset && scales.yOffset.conditional;
  let needsWidthBlock = false;
  if (xTemporalBar && !yBand && encoding.y && encoding.y.type !== 'temporal') {
    lines.push(temporalBarWidthDecl(xBarWidthVar, 'x', dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (yTemporalBar && !xBand && encoding.x && encoding.x.type !== 'temporal') {
    lines.push(temporalBarWidthDecl(yBarWidthVar, 'y', dataVar, encoding.y.field));
    needsWidthBlock = true;
  } else if (xOffsetAmbiguous && !yBand && encoding.y && encoding.y.type !== 'temporal') {
    lines.push(ambiguousBarWidthDecl(xBarWidthVar, x, dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (yOffsetAmbiguous && !xBand && encoding.x && encoding.x.type !== 'temporal') {
    lines.push(ambiguousBarWidthDecl(yBarWidthVar, y, dataVar, encoding.y.field));
    needsWidthBlock = true;
  } else if (xAmbiguous && !yBand && encoding.y && encoding.y.type !== 'temporal') {
    lines.push(ambiguousBarWidthDecl(xBarWidthVar, x, dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (yAmbiguous && !xBand && encoding.x && encoding.x.type !== 'temporal') {
    lines.push(ambiguousBarWidthDecl(yBarWidthVar, y, dataVar, encoding.y.field));
    needsWidthBlock = true;
  }
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`  .attr("fill", ${fill})`);
  lines.push(`  .selectAll("rect")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("rect")`);
  if (rowDependent) lines.push(`    .attr("fill", d => ${fill})`);

  if (xTemporalBar && !yBand && encoding.y && encoding.y.type !== 'temporal') {
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - ${xBarWidthVar} / 2)`);
    lines.push(`    .attr("width", ${xBarWidthVar})`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yTemporalBar && !xBand && encoding.x && encoding.x.type !== 'temporal') {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) - ${yBarWidthVar} / 2)`);
    lines.push(`    .attr("height", ${yBarWidthVar})`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (xOffsetAmbiguous && !yBand && encoding.y && encoding.y.type !== 'temporal') {
    // Same dodge as the plain-band branch below, except the outer scale's
    // band-ness (and so whether `xOffset` ended up a real scale or `null`)
    // isn't known until runtime -- fall back to the same centered-bar
    // positioning the no-offset ambiguous case uses whenever it didn't.
    lines.push(`    .attr("x", d => xOffset ? x(d[${JSON.stringify(encoding.x.field)}]) + xOffset(d[${JSON.stringify(encoding.xOffset.field)}]) : x(d[${JSON.stringify(encoding.x.field)}]) - (${x.isNominalVar} ? 0 : ${xBarWidthVar} / 2))`);
    lines.push(`    .attr("width", xOffset ? xOffset.bandwidth() : ${xBarWidthVar})`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yOffsetAmbiguous && !xBand && encoding.x && encoding.x.type !== 'temporal') {
    lines.push(`    .attr("y", d => yOffset ? y(d[${JSON.stringify(encoding.y.field)}]) + yOffset(d[${JSON.stringify(encoding.yOffset.field)}]) : y(d[${JSON.stringify(encoding.y.field)}]) - (${y.isNominalVar} ? 0 : ${yBarWidthVar} / 2))`);
    lines.push(`    .attr("height", yOffset ? yOffset.bandwidth() : ${yBarWidthVar})`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (xAmbiguous && !yBand && encoding.y && encoding.y.type !== 'temporal') {
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - (${x.isNominalVar} ? 0 : ${xBarWidthVar} / 2))`);
    lines.push(`    .attr("width", ${xBarWidthVar})`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yAmbiguous && !xBand && encoding.x && encoding.x.type !== 'temporal') {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) - (${y.isNominalVar} ? 0 : ${yBarWidthVar} / 2))`);
    lines.push(`    .attr("height", ${yBarWidthVar})`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (xBand && !yBand && encoding.y && encoding.xOffset && scales.xOffset) {
    // Dodged/grouped bars: an inner band scale (see scales.js's
    // resolveOffsetScale) slices the outer category band into one
    // sub-position per distinct offset-group value, so each group's bar
    // sits side-by-side within its category instead of all overlapping.
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) + xOffset(d[${JSON.stringify(encoding.xOffset.field)}]))`);
    lines.push(`    .attr("width", xOffset.bandwidth())`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yBand && !xBand && encoding.x && encoding.yOffset && scales.yOffset) {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) + yOffset(d[${JSON.stringify(encoding.yOffset.field)}]))`);
    lines.push(`    .attr("height", yOffset.bandwidth())`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (xBand && !yBand && encoding.y) {
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
    lines.push(`    .attr("width", x.bandwidth())`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yBand && !xBand && encoding.x) {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    lines.push(`    .attr("height", y.bandwidth())`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if ((xBand && !yBand) || (yBand && !xBand)) {
    // A band axis but no companion value axis at all (no x2/y2, no
    // aggregate, nothing to size a bar's length by) -- one point per row
    // along the band axis is still a rendered chart, even without a bar
    // shape to draw.
    return (
      `// vl2d3: unsupported bar orientation (band axis with no value channel), drawing a point per row instead (--ignore-unsupported)\n` +
      renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported)
    );
  } else if (encoding.x2 && encoding.y2) {
    // A genuine 2D box on both axes -- e.g. prepare.js's 2D-bin case (each
    // row is one heatmap cell, with its own x and y bin edges), or any
    // other spec giving an explicit range on both channels at once.
    lines.push(`    .attr("x", d => Math.min(x(d[${JSON.stringify(encoding.x.field)}]), x(d[${JSON.stringify(encoding.x2.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(d[${JSON.stringify(encoding.x2.field)}]) - x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("y", d => Math.min(y(d[${JSON.stringify(encoding.y.field)}]), y(d[${JSON.stringify(encoding.y2.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(d[${JSON.stringify(encoding.y2.field)}]) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (encoding.x2 && !encoding.y2) {
    lines.push(`    .attr("x", d => Math.min(x(d[${JSON.stringify(encoding.x.field)}]), x(d[${JSON.stringify(encoding.x2.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(d[${JSON.stringify(encoding.x2.field)}]) - x(d[${JSON.stringify(encoding.x.field)}])))`);
    // This layer child may have no y of its own at all (e.g. a shared
    // reference band spanning the full plot height) -- fall back to the
    // plot's own top/bottom extent rather than assuming `encoding.y` exists.
    if (encoding.y) {
      lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
      lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
    } else {
      lines.push(`    .attr("y", ${dims.marginTopExpr})`);
      lines.push(`    .attr("height", ${dims.heightMinusBottomExpr} - ${dims.marginTopExpr})`);
    }
  } else if (encoding.y2 && !encoding.x2) {
    lines.push(`    .attr("y", d => Math.min(y(d[${JSON.stringify(encoding.y.field)}]), y(d[${JSON.stringify(encoding.y2.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(d[${JSON.stringify(encoding.y2.field)}]) - y(d[${JSON.stringify(encoding.y.field)}])))`);
    // Same fallback as above, for a shared reference band with no x of its own.
    if (encoding.x) {
      lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
      lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
    } else {
      lines.push(`    .attr("x", ${dims.marginLeftExpr})`);
      lines.push(`    .attr("width", ${dims.widthMinusRightExpr} - ${dims.marginLeftExpr})`);
    }
  } else if (ignoreUnsupported) {
    // Neither axis is a band and there's no x2/y2 range -- e.g. two plain
    // quantitative axes with nothing to size a box against. A point per row
    // at least shows where the data is, rather than nothing.
    return (
      `// vl2d3: unsupported bar orientation (no band axis or x2/y2 range), drawing a point per row instead (--ignore-unsupported)\n` +
      renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported)
    );
  } else {
    throw new Error(
      'Unsupported bar orientation: expected one ordinal/band position channel and one quantitative, ' +
        'or a quantitative range via x2/y2'
    );
  }
  appendTitle(lines, '    ', encoding);
  if (needsWidthBlock) {
    return '{\n' + lines.map(l => l.replace(/^/gm, '  ')).join('\n') + '\n}';
  }
  return lines.join('\n');
}

// prepare.js's 2D-bin case gives x/x2 (and y/y2) as a bin's two edges, not
// a single center -- a "rect" mark wants the box itself (see renderBar's
// own x2-and-y2 branch), but a point-ish mark has no width/height to fill,
// so it centers on the bin instead: the midpoint between the two edges.
function binCenterAccessor(encoding, scales, channel) {
  const channel2 = `${channel}2`;
  if (!encoding[channel2]) return null;
  const scale = scales[channel];
  const lo = `${scale.varName}(d[${JSON.stringify(encoding[channel].field)}])`;
  const hi = `${scale.varName}(d[${JSON.stringify(encoding[channel2].field)}])`;
  return `(${lo} + ${hi}) / 2`;
}

function renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const {x, y, size} = scales;
  // A 1D strip/dot plot (only one of x/y given) centers points on the
  // missing axis rather than requiring both; with neither given, every
  // point is centered on both (all overlapping) rather than refusing to
  // render at all.
  const cx = x ? binCenterAccessor(encoding, scales, 'x') ?? dodgeAwareAccessor(encoding, scales, 'x') : dims.centerXExpr;
  const cy = y ? binCenterAccessor(encoding, scales, 'y') ?? dodgeAwareAccessor(encoding, scales, 'y') : dims.centerYExpr;
  const r =
    size && encoding.size
      ? `size(d[${JSON.stringify(encoding.size.field)}])`
      : formatValue(markProps.size ? Math.sqrt(simpleMarkProp(markProps.size, 9, 'size', ignoreUnsupported) / Math.PI) : 3) +
        markPropNote(markProps.size, 'size', ignoreUnsupported);
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

function renderLine(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const {x, y} = scales;
  if ((!x || !y) && !ignoreUnsupported) throw new Error('"line" mark requires both x and y encodings');
  if (!x && !y) return SKIP_COMMENT('"line" mark has neither x nor y encoding');
  const singleAxisNote = !x || !y ? `// vl2d3: "line" mark missing ${!x ? 'x' : 'y'} encoding, centering on that axis instead (--ignore-unsupported)\n` : '';
  const cx = x ? accessor(encoding.x, scales, 'x') : dims.centerXExpr;
  const cy = y ? accessor(encoding.y, scales, 'y') : dims.centerYExpr;
  const sortField = x ? encoding.x.field : encoding.y.field;
  const groupField = seriesGroupField(encoding);
  const lines = [];

  if (groupField) {
    const stroke = encoding.color ? `color(key)` : JSON.stringify(DEFAULT_STROKE);
    lines.push(`svg.append("g")`);
    lines.push(`    .attr("fill", "none")`);
    lines.push(`    .attr("stroke-width", ${formatValue(simpleMarkProp(markProps.strokeWidth, 1.5, 'strokeWidth', ignoreUnsupported))}${markPropNote(markProps.strokeWidth, 'strokeWidth', ignoreUnsupported)})`);
    lines.push(`  .selectAll("path")`);
    lines.push(`  .data(d3.group(${dataVar}, d => d[${JSON.stringify(groupField)}]))`);
    lines.push(`  .join("path")`);
    lines.push(`    .attr("stroke", ([key]) => ${stroke})`);
    lines.push(
      `    .attr("d", ([, rows]) => d3.line().x(d => ${cx}).y(d => ${cy})` +
        `(rows.slice().sort((a, b) => d3.ascending(a[${JSON.stringify(sortField)}], b[${JSON.stringify(sortField)}]))));`
    );
  } else {
    const stroke = markProps.stroke ? formatValue(markProps.stroke) : JSON.stringify(DEFAULT_STROKE);
    lines.push(`svg.append("path")`);
    lines.push(`    .attr("fill", "none")`);
    lines.push(`    .attr("stroke", ${stroke})`);
    lines.push(`    .attr("stroke-width", ${formatValue(simpleMarkProp(markProps.strokeWidth, 1.5, 'strokeWidth', ignoreUnsupported))}${markPropNote(markProps.strokeWidth, 'strokeWidth', ignoreUnsupported)})`);
    lines.push(
      `    .attr("d", d3.line().x(d => ${cx}).y(d => ${cy})` +
        `(${dataVar}.slice().sort((a, b) => d3.ascending(a[${JSON.stringify(sortField)}], b[${JSON.stringify(sortField)}]))));`
    );
  }
  return singleAxisNote + lines.join('\n');
}

function renderArea(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const {x, y} = scales;
  if ((!x || !y) && !ignoreUnsupported) throw new Error('"area" mark requires both x and y encodings');
  if (!x && !y) return SKIP_COMMENT('"area" mark has neither x nor y encoding');
  const singleAxisNote = !x || !y ? `// vl2d3: "area" mark missing ${!x ? 'x' : 'y'} encoding, centering on that axis instead (--ignore-unsupported)\n` : '';
  const cx = x ? accessor(encoding.x, scales, 'x') : dims.centerXExpr;
  const y1 = y ? accessor(encoding.y, scales, 'y') : dims.centerYExpr;
  const y0 = encoding.y2 ? `y(d[${JSON.stringify(encoding.y2.field)}])` : y ? 'y(0)' : dims.centerYExpr;
  const groupField = seriesGroupField(encoding);
  const sortField = x ? encoding.x.field : encoding.y.field;
  const sortFieldJson = JSON.stringify(sortField);
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
        `(rows.slice().sort((a, b) => d3.ascending(a[${sortFieldJson}], b[${sortFieldJson}]))));`
    );
  } else {
    lines.push(`svg.append("path")`);
    lines.push(`    .attr("fill", ${fill})`);
    lines.push(
      `    .attr("d", d3.area().x(d => ${cx}).y0(d => ${y0}).y1(d => ${y1})` +
        `(${dataVar}.slice().sort((a, b) => d3.ascending(a[${sortFieldJson}], b[${sortFieldJson}]))));`
    );
  }
  return singleAxisNote + lines.join('\n');
}

function renderRule(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
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
  } else if (ignoreUnsupported) {
    return SKIP_COMMENT('"rule" mark has neither x nor y encoding');
  } else {
    throw new Error('"rule" mark requires an x and/or y encoding');
  }
  return lines.join('\n');
}

function renderTick(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const {x, y} = scales;
  if (!x && !y) {
    if (ignoreUnsupported) return SKIP_COMMENT('"tick"/"boxplot" mark has neither x nor y encoding');
    throw new Error('"tick" mark requires an x and/or y encoding');
  }
  const stroke = fillExpr(encoding, scales, 'black');
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`    .attr("stroke", ${stroke})`);
  lines.push(`  .selectAll("line")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("line")`);
  if (rowDependent) lines.push(`    .attr("stroke", d => ${stroke})`);

  // `x`/`y` (the shared scale) can exist from a *sibling* layer child even
  // when this child has no encoding of its own for that channel -- check
  // this child's own encoding, not just the scale, before referencing its field.
  const xField = encoding.x && JSON.stringify(encoding.x.field);
  const yField = encoding.y && JSON.stringify(encoding.y.field);
  const TICK_HALF = 10; // half-length used along an axis with no scale (1D strip plots)

  if (x && y && xField && yField) {
    // A dodged/grouped offset on x narrows the tick to its own sub-band
    // (and re-centers it there via dodgeAwareAccessor()) instead of every
    // group's tick sitting on top of the shared category position.
    const xOffsetScale = scales.xOffset;
    const centerX = dodgeAwareAccessor(encoding, scales, 'x');
    const plainHalf = x.kind === 'band' ? 'x.bandwidth() / 2' : '4';
    const half =
      xOffsetScale && encoding.xOffset && encoding.xOffset.field
        ? xOffsetScale.conditional
          ? `(${xOffsetScale.varName} ? ${xOffsetScale.varName}.bandwidth() / 2 : ${plainHalf})`
          : `${xOffsetScale.varName}.bandwidth() / 2`
        : plainHalf;
    lines.push(`    .attr("x1", d => ${centerX} - ${half})`);
    lines.push(`    .attr("x2", d => ${centerX} + ${half})`);
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

function renderText(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  if (!encoding.text) {
    if (ignoreUnsupported) return SKIP_COMMENT('"text" mark has no text encoding');
    throw new Error('"text" mark requires a text encoding');
  }
  const cx = encoding.x ? dodgeAwareAccessor(encoding, scales, 'x') : dims.centerXExpr;
  const cy = encoding.y ? dodgeAwareAccessor(encoding, scales, 'y') : dims.centerYExpr;
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

function renderArc(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  if (!encoding.theta && !ignoreUnsupported) throw new Error('"arc" mark requires a theta encoding');
  // With no theta value to size wedges by, equal-sized slices (one per row)
  // is still a meaningful sacrifice -- a plain "count of rows" pie.
  const pieValue = encoding.theta
    ? `d => d[${JSON.stringify(encoding.theta.field)}]`
    : '() => 1 /* vl2d3: no theta encoding, using equal-sized slices (--ignore-unsupported) */';
  const fill = encoding.color ? `d => color(d.data[${JSON.stringify(encoding.color.field)}])` : `() => ${JSON.stringify(DEFAULT_FILL)}`;
  const lines = [];
  lines.push(`{`);
  lines.push(`  const radius = Math.min(${dims.innerWidthExpr}, ${dims.innerHeightExpr}) / 2;`);
  lines.push(`  const pie = d3.pie().value(${pieValue}).sort(null);`);
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
