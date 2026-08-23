// Generate the D3 "join" code that actually draws a mark, given already-
// resolved scales (see scales.js) and the (prepare.js-rewritten) encoding.

import {formatValue} from './literals.js';
import {translateExpr} from './expr.js';

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

// d3.scaleBand()(value) returns the band's own *start* edge, not its
// center -- exactly what a bar/rect mark wants (it's drawing the whole
// band as a box), but wrong for any single-point mark (point/circle/tick/
// rule/text) positioned against a nominal/ordinal companion axis, which
// wants to land in the middle of its category the way Vega-Lite itself
// does. `kind === 'ambiguous'` mirrors this at runtime via the same
// `isNominalVar` flag the scale declaration itself used, since whether
// this axis turned out banded at all isn't known until the data loads.
function bandCenterOffset(scale) {
  if (!scale) return '';
  if (scale.kind === 'band') return ` + ${scale.varName}.bandwidth() / 2`;
  if (scale.kind === 'ambiguous') return ` + (${scale.isNominalVar} ? ${scale.varName}.bandwidth() / 2 : 0)`;
  return '';
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
  // No dodge -- still needs to land on the CENTER of a band position, not
  // its left/top edge (see bandCenterOffset()).
  if (!offsetDef || !offsetDef.field || !offsetScale) return `${base}${bandCenterOffset(scales[channel])}`;
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

// A mark-level literal color (`"mark": {"type": "rule", "stroke":
// "firebrick"}`, or the generic `color` property Vega-Lite accepts on any
// mark) should win over this mark-type's own hardcoded default -- but
// still loses to an actual `encoding.color` channel (fillExpr() above
// already gives that priority, since this only ever supplies its
// `fallback` argument). `kind` is whichever SVG attribute this mark
// renderer sets from color ("fill" or "stroke") -- checked first since
// it's the more specific property, falling back to the mark-type-agnostic
// `color` before the hardcoded default.
function markColorFallback(markProps, kind, defaultColor) {
  return markProps[kind] ?? markProps.color ?? defaultColor;
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
  if (type === 'trail') {
    return note('line') + '\n' + renderLine(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
  }
  return note('point') + '\n' + renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
}

// A "boxplot" mark is Vega-Lite's own composite -- unlike every other mark
// type here, it doesn't draw one shape per input row; it first collapses
// each distinct category (x/y's nominal channel, further split by `color`/
// `xOffset`/`yOffset` when given -- distinct fields only, since a spec
// commonly reuses the same field for the category and the color/dodge, as
// `color`/`xOffset` on the same field does in a grouped boxplot) down to
// its own five-number summary (Tukey's: q1/median/q3 plus the whisker
// bounds and outliers, computed the same way `stat_boxplot()` does),
// *then* draws a box + whiskers + outlier points per group. That grouping
// step has no equivalent anywhere else in this file, so it's generated as
// its own runtime block (an IIFE-free `d3.group()` + summarize pass,
// mirroring the inline aggregation prepare.js emits for a plain
// aggregate) rather than reusing any other mark's row-by-row `.data(dataVar)`
// join directly.
function renderBoxplot(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const xIsValue = encoding.x && encoding.x.type === 'quantitative';
  const yIsValue = encoding.y && encoding.y.type === 'quantitative';
  if (!xIsValue && !yIsValue) {
    if (ignoreUnsupported) {
      return (
        `// vl2d3: unsupported "boxplot" orientation (no quantitative x or y encoding), drawing a point per row instead (--ignore-unsupported)\n` +
        renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported)
      );
    }
    throw new Error('"boxplot" mark requires a quantitative x or y encoding');
  }
  // Vega-Lite's own default orientation when (unusually) both axes look
  // quantitative is vertical (the value axis is y).
  const valueChannel = yIsValue ? 'y' : 'x';
  const catChannel = valueChannel === 'y' ? 'x' : 'y';
  const valueField = encoding[valueChannel].field;
  const catDef = encoding[catChannel];
  const catScale = scales[catChannel];
  const offsetChannel = catChannel === 'x' ? 'xOffset' : 'yOffset';
  const offsetDef = encoding[offsetChannel];
  const offsetScale = scales[offsetChannel];

  // `extent` (mark-level): "min-max" widens the whisker fence to +/-
  // Infinity * IQR, i.e. the whiskers always reach the true min/max and no
  // point is ever an outlier -- otherwise a bare number is the IQR
  // multiplier (Vega-Lite's own default: 1.5, matching Tukey's rule and
  // ggplot2/stat_boxplot's own `coef` default).
  const extent = markProps.extent;
  const coef = extent === 'min-max' ? 'Infinity' : formatValue(typeof extent === 'number' ? extent : 1.5);

  // Every non-quantitative channel that could split the data into distinct
  // boxes -- deduplicated by field, since `color`/`xOffset` commonly name
  // the very same field as the category axis itself (a grouped boxplot's
  // usual shape) and shouldn't be grouped by twice.
  const groupFields = [];
  for (const ch of [catChannel, 'color', offsetChannel]) {
    const def = encoding[ch];
    if (def && def.field && !groupFields.includes(def.field)) groupFields.push(def.field);
  }
  const keyExpr = groupFields.length
    ? `JSON.stringify([${groupFields.map(f => `d[${JSON.stringify(f)}]`).join(', ')}])`
    : '0'; // No groupby channel at all -- a single shared 1D box.

  const boxVar = 'boxStats';
  const lines = [];
  lines.push(
    `const ${boxVar} = Array.from(d3.group(${dataVar}, d => ${keyExpr}), ([, rows]) => {\n` +
      `  const values = rows.map(d => d[${JSON.stringify(valueField)}]).filter(v => v != null).sort(d3.ascending);\n` +
      `  const q1 = d3.quantile(values, 0.25), median = d3.quantile(values, 0.5), q3 = d3.quantile(values, 0.75);\n` +
      `  const iqr = q3 - q1;\n` +
      `  const lowerFence = q1 - ${coef} * iqr, upperFence = q3 + ${coef} * iqr;\n` +
      `  const within = values.filter(v => v >= lowerFence && v <= upperFence);\n` +
      `  return {\n` +
      `    ...rows[0],\n` +
      `    q1, median, q3,\n` +
      `    whiskerLow: within.length ? within[0] : q1,\n` +
      `    whiskerHigh: within.length ? within[within.length - 1] : q3,\n` +
      `    outliers: values.filter(v => v < lowerFence || v > upperFence),\n` +
      `  };\n` +
      `});`
  );

  // Position along the category axis: the center of its band (dodged into
  // an offset sub-band when present) -- boxStats rows still carry the
  // original category/offset/color field values via the `...rows[0]`
  // spread above, so the same field-based accessors every other mark uses
  // work unchanged. With no category channel at all (a plain 1D boxplot),
  // there's nothing to position against but the plot's own center.
  const catCenter = catDef
    ? dodgeAwareAccessor(encoding, scales, catChannel)
    : catChannel === 'x'
      ? dims.centerXExpr
      : dims.centerYExpr;
  const sizeProp = markProps.size;
  const boxWidthExpr =
    sizeProp !== undefined
      ? formatValue(sizeProp)
      : offsetDef && offsetDef.field && offsetScale
        ? offsetScale.conditional
          ? `(${offsetScale.varName} ? ${offsetScale.varName}.bandwidth() : 14)`
          : `${offsetScale.varName}.bandwidth()`
        : catScale && catScale.kind === 'band'
          ? `Math.min(${catScale.varName}.bandwidth(), 14)`
          : '14';

  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', DEFAULT_FILL));
  const stroke = markColorFallback(markProps, 'stroke', 'black');
  // Vega-Lite's own boxplot defaults: a white median tick, and outlier
  // points in the mark's base color (not the box's own per-category fill,
  // which is `config.boxplot.color`-driven fill -- but this project has no
  // general `config.<mark>` passthrough, matching every other mark here).
  const medianColor = 'white';
  const outlierFill = markColorFallback(markProps, 'color', DEFAULT_FILL);
  const valueScaleVar = valueChannel;
  const outlierData = `${boxVar}.flatMap(d => d.outliers.map(v => ({...d, ${JSON.stringify(valueField)}: v})))`;

  lines.push(`svg.append("g")`);
  lines.push(`    .attr("stroke", ${JSON.stringify(stroke)})`);
  lines.push(`  .selectAll("line")`);
  lines.push(`  .data(${boxVar})`);
  lines.push(`  .join("line")`);
  if (valueChannel === 'y') {
    lines.push(`    .attr("x1", d => ${catCenter})`);
    lines.push(`    .attr("x2", d => ${catCenter})`);
    lines.push(`    .attr("y1", d => ${valueScaleVar}(d.whiskerLow))`);
    lines.push(`    .attr("y2", d => ${valueScaleVar}(d.whiskerHigh))`);
  } else {
    lines.push(`    .attr("y1", d => ${catCenter})`);
    lines.push(`    .attr("y2", d => ${catCenter})`);
    lines.push(`    .attr("x1", d => ${valueScaleVar}(d.whiskerLow))`);
    lines.push(`    .attr("x2", d => ${valueScaleVar}(d.whiskerHigh))`);
  }

  const rowDependent = hasRowDependentColor(encoding);
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`    .attr("fill", ${fill})`);
  lines.push(`  .selectAll("rect")`);
  lines.push(`  .data(${boxVar})`);
  lines.push(`  .join("rect")`);
  if (rowDependent) lines.push(`    .attr("fill", d => ${fill})`);
  if (valueChannel === 'y') {
    lines.push(`    .attr("x", d => ${catCenter} - (${boxWidthExpr}) / 2)`);
    lines.push(`    .attr("width", d => ${boxWidthExpr})`);
    lines.push(`    .attr("y", d => Math.min(y(d.q1), y(d.q3)))`);
    lines.push(`    .attr("height", d => Math.abs(y(d.q3) - y(d.q1)))`);
  } else {
    lines.push(`    .attr("y", d => ${catCenter} - (${boxWidthExpr}) / 2)`);
    lines.push(`    .attr("height", d => ${boxWidthExpr})`);
    lines.push(`    .attr("x", d => Math.min(x(d.q1), x(d.q3)))`);
    lines.push(`    .attr("width", d => Math.abs(x(d.q3) - x(d.q1)))`);
  }

  lines.push(`svg.append("g")`);
  lines.push(`    .attr("stroke", ${JSON.stringify(medianColor)})`);
  lines.push(`  .selectAll("line")`);
  lines.push(`  .data(${boxVar})`);
  lines.push(`  .join("line")`);
  if (valueChannel === 'y') {
    lines.push(`    .attr("x1", d => ${catCenter} - (${boxWidthExpr}) / 2)`);
    lines.push(`    .attr("x2", d => ${catCenter} + (${boxWidthExpr}) / 2)`);
    lines.push(`    .attr("y1", d => y(d.median))`);
    lines.push(`    .attr("y2", d => y(d.median))`);
  } else {
    lines.push(`    .attr("y1", d => ${catCenter} - (${boxWidthExpr}) / 2)`);
    lines.push(`    .attr("y2", d => ${catCenter} + (${boxWidthExpr}) / 2)`);
    lines.push(`    .attr("x1", d => x(d.median))`);
    lines.push(`    .attr("x2", d => x(d.median))`);
  }

  lines.push(`svg.append("g")`);
  lines.push(`    .attr("fill", ${JSON.stringify(outlierFill)})`);
  lines.push(`    .attr("fill-opacity", 0.8)`);
  lines.push(`  .selectAll("circle")`);
  lines.push(`  .data(${outlierData})`);
  lines.push(`  .join("circle")`);
  if (valueChannel === 'y') {
    lines.push(`    .attr("cx", d => ${catCenter})`);
    lines.push(`    .attr("cy", d => y(d[${JSON.stringify(valueField)}]))`);
  } else {
    lines.push(`    .attr("cy", d => ${catCenter})`);
    lines.push(`    .attr("cx", d => x(d[${JSON.stringify(valueField)}]))`);
  }
  lines.push(`    .attr("r", 3)`);

  return '{\n' + lines.join('\n').replace(/^/gm, '  ') + '\n}';
}

export function renderMark(mark, encoding, scales, dims, dataVar, ignoreUnsupported = false, extentParams = {}) {
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
      // The other equally well-defined "rect" shapes: a plain calendar-
      // heatmap/grid cell -- both x and y are band (ordinal/nominal, or
      // binned-quantitative) scales with no x2/y2 range at all, so a full
      // bandwidth-by-bandwidth box at each (x, y) pair is exactly what's
      // wanted (renderBar's `xBand && yBand` branch); or the same shape but
      // with both axes left as *continuous* temporal scales instead of
      // banded (e.g. `type: "temporal"` + `timeUnit` with an explicit
      // `bandPosition`, rather than `type: "ordinal"` + `timeUnit`) --
      // renderBar's own per-axis "temporal bar width" estimate, applied to
      // both axes at once, gives the same grid.
      if (scales.x && scales.y && !encoding.x2 && !encoding.y2) {
        const bothBand = scales.x.kind === 'band' && scales.y.kind === 'band';
        const bothTemporal =
          scales.x.kind === 'continuous' && scales.y.kind === 'continuous' &&
          encoding.x.type === 'temporal' && encoding.y.type === 'temporal';
        if (bothBand || bothTemporal) {
          return renderBar(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
        }
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
      return renderRule(encoding, scales, dims, dataVar, markProps, ignoreUnsupported, extentParams);
    case 'tick':
      return renderTick(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'text':
      return renderText(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'arc':
      return renderArc(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    case 'boxplot':
      return renderBoxplot(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
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
  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', DEFAULT_FILL));
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
  // A "rect" grid whose axes are both left as continuous temporal scales
  // (rather than banded) instead of one bar-shaped value axis: neither
  // axis has a real bandwidth to size a box against, so both need their
  // own estimated width (same idea as xTemporalBar/yTemporalBar below,
  // just applied to both axes at once, hence its own distinct pair of
  // `const` names -- xBarWidthVar/yBarWidthVar are the same identifier and
  // would collide with each other if declared side by side).
  const xyBothTemporalBand = xTemporalBar && yTemporalBar && !encoding.x2 && !encoding.y2;
  let needsWidthBlock = false;
  if (xyBothTemporalBand) {
    lines.push(temporalBarWidthDecl('xBarWidth2', 'x', dataVar, encoding.x.field));
    lines.push(temporalBarWidthDecl('yBarWidth2', 'y', dataVar, encoding.y.field));
    needsWidthBlock = true;
  } else if (xTemporalBar && !encoding.y && !encoding.y2) {
    // A temporal x with *no* companion axis at all (e.g. a "1D bar" with
    // only a bare, un-aggregated temporal field -- one row per date, no
    // value to size a bar's length by): "zero baseline to the value" (the
    // generic 1D-value-bar fallback further below) is meaningless on a
    // date axis (`x(0)` means the 1970 epoch, producing one enormous bar
    // spanning from there to each date instead of a real per-date mark),
    // so this instead draws the same full-height thin tick per distinct
    // date the reference-band case uses elsewhere in this file.
    lines.push(temporalBarWidthDecl(xBarWidthVar, 'x', dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (yTemporalBar && !encoding.x && !encoding.x2) {
    lines.push(temporalBarWidthDecl(yBarWidthVar, 'y', dataVar, encoding.y.field));
    needsWidthBlock = true;
  } else if (xTemporalBar && encoding.xOffset && encoding.xOffset.field && !yBand && encoding.y && encoding.y.type !== 'temporal' && !encoding.y2) {
    // A dodged/grouped bar over a *continuous* temporal x (e.g. binned by
    // month, one bar per symbol within each month) -- there's no real
    // band scale to derive an inner sub-band from (scales.js's
    // resolveOffsetScale only ever builds one for a genuinely banded
    // outer scale), so this estimates the outer bar's own width the same
    // way any other temporal bar does, then slices *that* width into one
    // sub-band per distinct offset value with a plain scaleBand of its own.
    lines.push(temporalBarWidthDecl(xBarWidthVar, 'x', dataVar, encoding.x.field));
    lines.push(
      `const xOffsetSub = d3.scaleBand(Array.from(new Set(${dataVar}.map(d => d[${JSON.stringify(encoding.xOffset.field)}]))).sort((a, b) => d3.ascending(a, b)), [0, ${xBarWidthVar}]).padding(0.05);`
    );
    needsWidthBlock = true;
  } else if (yTemporalBar && encoding.yOffset && encoding.yOffset.field && !xBand && encoding.x && encoding.x.type !== 'temporal' && !encoding.x2) {
    lines.push(temporalBarWidthDecl(yBarWidthVar, 'y', dataVar, encoding.y.field));
    lines.push(
      `const yOffsetSub = d3.scaleBand(Array.from(new Set(${dataVar}.map(d => d[${JSON.stringify(encoding.yOffset.field)}]))).sort((a, b) => d3.ascending(a, b)), [0, ${yBarWidthVar}]).padding(0.05);`
    );
    needsWidthBlock = true;
  } else if (xTemporalBar && !yBand && encoding.y && encoding.y.type !== 'temporal' && !encoding.y2) {
    lines.push(temporalBarWidthDecl(xBarWidthVar, 'x', dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (yTemporalBar && !xBand && encoding.x && encoding.x.type !== 'temporal' && !encoding.x2) {
    lines.push(temporalBarWidthDecl(yBarWidthVar, 'y', dataVar, encoding.y.field));
    needsWidthBlock = true;
  } else if (xOffsetAmbiguous && !yBand && encoding.y && encoding.y.type !== 'temporal' && !encoding.y2) {
    lines.push(ambiguousBarWidthDecl(xBarWidthVar, x, dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (yOffsetAmbiguous && !xBand && encoding.x && encoding.x.type !== 'temporal' && !encoding.x2) {
    lines.push(ambiguousBarWidthDecl(yBarWidthVar, y, dataVar, encoding.y.field));
    needsWidthBlock = true;
  } else if (xAmbiguous && !yBand && encoding.y && encoding.y.type !== 'temporal' && !encoding.y2) {
    lines.push(ambiguousBarWidthDecl(xBarWidthVar, x, dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (yAmbiguous && !xBand && encoding.x && encoding.x.type !== 'temporal' && !encoding.x2) {
    lines.push(ambiguousBarWidthDecl(yBarWidthVar, y, dataVar, encoding.y.field));
    needsWidthBlock = true;
  } else if (encoding.x && !encoding.y && !encoding.x.aggregated && !encoding.x2) {
    // A bare, un-aggregated quantitative x with no companion axis at all
    // (e.g. one raw row per distinct value, no groupby/aggregate) -- unlike
    // the aggregated case, there's no single dataset-wide value to draw a
    // zero-baseline bar to, so this instead needs a per-distinct-value
    // reference-band width (same derivation as the temporal bar width case
    // above, which already works for a plain continuous scale, not just a
    // temporal one).
    lines.push(temporalBarWidthDecl(xBarWidthVar, 'x', dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (encoding.y && !encoding.x && !encoding.y.aggregated && !encoding.y2) {
    lines.push(temporalBarWidthDecl(yBarWidthVar, 'y', dataVar, encoding.y.field));
    needsWidthBlock = true;
  }
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`  .attr("fill", ${fill})`);
  lines.push(`  .selectAll("rect")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("rect")`);
  if (rowDependent) lines.push(`    .attr("fill", d => ${fill})`);

  if (xyBothTemporalBand) {
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - xBarWidth2 / 2)`);
    lines.push(`    .attr("width", xBarWidth2)`);
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) - yBarWidth2 / 2)`);
    lines.push(`    .attr("height", yBarWidth2)`);
  } else if (xTemporalBar && !encoding.y && !encoding.y2) {
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - ${xBarWidthVar} / 2)`);
    lines.push(`    .attr("width", ${xBarWidthVar})`);
    lines.push(`    .attr("y", ${dims.marginTopExpr})`);
    lines.push(`    .attr("height", ${dims.heightMinusBottomExpr} - ${dims.marginTopExpr})`);
  } else if (yTemporalBar && !encoding.x && !encoding.x2) {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) - ${yBarWidthVar} / 2)`);
    lines.push(`    .attr("height", ${yBarWidthVar})`);
    lines.push(`    .attr("x", ${dims.marginLeftExpr})`);
    lines.push(`    .attr("width", ${dims.widthMinusRightExpr} - ${dims.marginLeftExpr})`);
  } else if (xTemporalBar && encoding.xOffset && encoding.xOffset.field && !yBand && encoding.y && encoding.y.type !== 'temporal' && !encoding.y2) {
    lines.push(
      `    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - ${xBarWidthVar} / 2 + xOffsetSub(d[${JSON.stringify(encoding.xOffset.field)}]))`
    );
    lines.push(`    .attr("width", xOffsetSub.bandwidth())`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yTemporalBar && encoding.yOffset && encoding.yOffset.field && !xBand && encoding.x && encoding.x.type !== 'temporal' && !encoding.x2) {
    lines.push(
      `    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) - ${yBarWidthVar} / 2 + yOffsetSub(d[${JSON.stringify(encoding.yOffset.field)}]))`
    );
    lines.push(`    .attr("height", yOffsetSub.bandwidth())`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (xTemporalBar && !yBand && encoding.y && encoding.y.type !== 'temporal' && !encoding.y2) {
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - ${xBarWidthVar} / 2)`);
    lines.push(`    .attr("width", ${xBarWidthVar})`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yTemporalBar && !xBand && encoding.x && encoding.x.type !== 'temporal' && !encoding.x2) {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) - ${yBarWidthVar} / 2)`);
    lines.push(`    .attr("height", ${yBarWidthVar})`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (xOffsetAmbiguous && !yBand && encoding.y && encoding.y.type !== 'temporal' && !encoding.y2) {
    // Same dodge as the plain-band branch below, except the outer scale's
    // band-ness (and so whether `xOffset` ended up a real scale or `null`)
    // isn't known until runtime -- fall back to the same centered-bar
    // positioning the no-offset ambiguous case uses whenever it didn't.
    lines.push(`    .attr("x", d => xOffset ? x(d[${JSON.stringify(encoding.x.field)}]) + xOffset(d[${JSON.stringify(encoding.xOffset.field)}]) : x(d[${JSON.stringify(encoding.x.field)}]) - (${x.isNominalVar} ? 0 : ${xBarWidthVar} / 2))`);
    lines.push(`    .attr("width", xOffset ? xOffset.bandwidth() : ${xBarWidthVar})`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yOffsetAmbiguous && !xBand && encoding.x && encoding.x.type !== 'temporal' && !encoding.x2) {
    lines.push(`    .attr("y", d => yOffset ? y(d[${JSON.stringify(encoding.y.field)}]) + yOffset(d[${JSON.stringify(encoding.yOffset.field)}]) : y(d[${JSON.stringify(encoding.y.field)}]) - (${y.isNominalVar} ? 0 : ${yBarWidthVar} / 2))`);
    lines.push(`    .attr("height", yOffset ? yOffset.bandwidth() : ${yBarWidthVar})`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (xAmbiguous && !yBand && encoding.y && encoding.y.type !== 'temporal' && !encoding.y2) {
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - (${x.isNominalVar} ? 0 : ${xBarWidthVar} / 2))`);
    lines.push(`    .attr("width", ${xBarWidthVar})`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yAmbiguous && !xBand && encoding.x && encoding.x.type !== 'temporal' && !encoding.x2) {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) - (${y.isNominalVar} ? 0 : ${yBarWidthVar} / 2))`);
    lines.push(`    .attr("height", ${yBarWidthVar})`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (xBand && yBand && !encoding.x2 && !encoding.y2) {
    // Both axes are bands with no value/range channel at all -- a
    // heatmap/grid cell: a full bandwidth-by-bandwidth box at each (x, y)
    // category pair (as opposed to every other branch here, which sizes a
    // bar's length from a zero baseline along one axis).
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
    lines.push(`    .attr("width", x.bandwidth())`);
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    lines.push(`    .attr("height", y.bandwidth())`);
  } else if (xBand && !yBand && encoding.y && !encoding.y2 && encoding.xOffset && scales.xOffset) {
    // Dodged/grouped bars: an inner band scale (see scales.js's
    // resolveOffsetScale) slices the outer category band into one
    // sub-position per distinct offset-group value, so each group's bar
    // sits side-by-side within its category instead of all overlapping.
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) + xOffset(d[${JSON.stringify(encoding.xOffset.field)}]))`);
    lines.push(`    .attr("width", xOffset.bandwidth())`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yBand && !xBand && encoding.x && !encoding.x2 && encoding.yOffset && scales.yOffset) {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) + yOffset(d[${JSON.stringify(encoding.yOffset.field)}]))`);
    lines.push(`    .attr("height", yOffset.bandwidth())`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (xBand && !yBand && encoding.y && !encoding.y2) {
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
    lines.push(`    .attr("width", x.bandwidth())`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (yBand && !xBand && encoding.x && !encoding.x2) {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    lines.push(`    .attr("height", y.bandwidth())`);
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
  } else if (!encoding.x2 && !encoding.y2 && ((xBand && !yBand) || (yBand && !xBand))) {
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
    if (encoding.x.binned) {
      // Vega-Lite's default `config.bar.binSpacing` (1px) leaves a small
      // gap between adjacent bins -- without it, a fine-grained bin scale
      // (many narrow bins) renders as one visually solid touching block.
      lines.push(
        `    .attr("x", d => Math.min(x(d[${JSON.stringify(encoding.x.field)}]), x(d[${JSON.stringify(encoding.x2.field)}])) + 0.5)`
      );
      lines.push(
        `    .attr("width", d => Math.max(0, Math.abs(x(d[${JSON.stringify(encoding.x2.field)}]) - x(d[${JSON.stringify(encoding.x.field)}])) - 1))`
      );
    } else {
      lines.push(`    .attr("x", d => Math.min(x(d[${JSON.stringify(encoding.x.field)}]), x(d[${JSON.stringify(encoding.x2.field)}])))`);
      lines.push(`    .attr("width", d => Math.abs(x(d[${JSON.stringify(encoding.x2.field)}]) - x(d[${JSON.stringify(encoding.x.field)}])))`);
    }
    // This layer child may have no y of its own at all (e.g. a shared
    // reference band spanning the full plot height) -- fall back to the
    // plot's own top/bottom extent rather than assuming `encoding.y` exists.
    // A *band* y (e.g. a horizontal boxplot-from-primitives' shared
    // categorical y, inherited from the layer wrapper) has no zero baseline
    // to speak of -- position/size the box directly against its own band
    // instead of calling y(0) (meaningless for a non-numeric domain).
    if (encoding.y && yBand) {
      lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
      lines.push(`    .attr("height", y.bandwidth())`);
    } else if (encoding.y && yAmbiguous) {
      // A companion axis whose band-vs-continuous shape isn't known until
      // the data has loaded (e.g. a stacked bar chart whose category field
      // has no explicit "type") -- checked at runtime via the same
      // `isNominalVar` flag the scale declaration itself used.
      lines.push(
        `    .attr("y", d => ${y.isNominalVar} ? y(d[${JSON.stringify(encoding.y.field)}]) : Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`
      );
      lines.push(
        `    .attr("height", d => ${y.isNominalVar} ? y.bandwidth() : Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`
      );
    } else if (encoding.y) {
      lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
      lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
    } else {
      lines.push(`    .attr("y", ${dims.marginTopExpr})`);
      lines.push(`    .attr("height", ${dims.heightMinusBottomExpr} - ${dims.marginTopExpr})`);
    }
  } else if (encoding.y2 && !encoding.x2) {
    if (encoding.y.binned) {
      lines.push(
        `    .attr("y", d => Math.min(y(d[${JSON.stringify(encoding.y.field)}]), y(d[${JSON.stringify(encoding.y2.field)}])) + 0.5)`
      );
      lines.push(
        `    .attr("height", d => Math.max(0, Math.abs(y(d[${JSON.stringify(encoding.y2.field)}]) - y(d[${JSON.stringify(encoding.y.field)}])) - 1))`
      );
    } else {
      lines.push(`    .attr("y", d => Math.min(y(d[${JSON.stringify(encoding.y.field)}]), y(d[${JSON.stringify(encoding.y2.field)}])))`);
      lines.push(`    .attr("height", d => Math.abs(y(d[${JSON.stringify(encoding.y2.field)}]) - y(d[${JSON.stringify(encoding.y.field)}])))`);
    }
    // Same fallback as above, for a shared reference band with no x of its own.
    if (encoding.x && xBand) {
      lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
      lines.push(`    .attr("width", x.bandwidth())`);
    } else if (encoding.x && xAmbiguous) {
      lines.push(
        `    .attr("x", d => ${x.isNominalVar} ? x(d[${JSON.stringify(encoding.x.field)}]) : Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`
      );
      lines.push(
        `    .attr("width", d => ${x.isNominalVar} ? x.bandwidth() : Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`
      );
    } else if (encoding.x) {
      lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
      lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
    } else {
      lines.push(`    .attr("x", ${dims.marginLeftExpr})`);
      lines.push(`    .attr("width", ${dims.widthMinusRightExpr} - ${dims.marginLeftExpr})`);
    }
  } else if (encoding.x && encoding.y) {
    // Both position channels are continuous (no band/ordinal axis, no
    // temporal axis, no x2/y2 range) -- e.g. a Q-Q-style bar chart with two
    // quantitative fields. Vega-Lite still draws real bars here: a
    // fixed-width bar per row at the x position, from the y-zero baseline
    // up to the row's y value, using its own `config.bar.continuousBandSize`
    // default (5px) since there's no data-driven band width to derive one
    // from on either axis.
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - 2.5)`);
    lines.push(`    .attr("width", 5)`);
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
  } else if (encoding.x && !encoding.y && encoding.x.aggregated) {
    // A single quantitative position channel and nothing else at all (a
    // "1D bar" -- e.g. a lone dataset-wide aggregate with no groupby) --
    // Vega-Lite still draws a real bar: zero baseline to the value, along
    // the one axis it has, spanning the full plot height on the other (no
    // companion axis is drawn at all, so there's nothing to center against).
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("y", ${dims.marginTopExpr})`);
    lines.push(`    .attr("height", ${dims.heightMinusBottomExpr} - ${dims.marginTopExpr})`);
  } else if (encoding.x && !encoding.y) {
    // A bare, un-aggregated quantitative x (see the width-decl branch
    // above): a thin reference band centered on each row's own value,
    // rather than a zero-baseline bar, spanning the full plot height.
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - ${xBarWidthVar} / 2)`);
    lines.push(`    .attr("width", ${xBarWidthVar})`);
    lines.push(`    .attr("y", ${dims.marginTopExpr})`);
    lines.push(`    .attr("height", ${dims.heightMinusBottomExpr} - ${dims.marginTopExpr})`);
  } else if (encoding.y && !encoding.x && encoding.y.aggregated) {
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("x", ${dims.marginLeftExpr})`);
    lines.push(`    .attr("width", ${dims.widthMinusRightExpr} - ${dims.marginLeftExpr})`);
  } else if (encoding.y && !encoding.x) {
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) - ${yBarWidthVar} / 2)`);
    lines.push(`    .attr("height", ${yBarWidthVar})`);
    lines.push(`    .attr("x", ${dims.marginLeftExpr})`);
    lines.push(`    .attr("width", ${dims.widthMinusRightExpr} - ${dims.marginLeftExpr})`);
  } else if (ignoreUnsupported) {
    // Neither x nor y at all (e.g. a band axis with no value channel and
    // no x2/y2) -- a point per row at least shows where the data is,
    // rather than nothing.
    return (
      `// vl2d3: unsupported bar orientation (band axis with no value channel), drawing a point per row instead (--ignore-unsupported)\n` +
      renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported)
    );
  } else {
    throw new Error('Unsupported bar orientation: expected at least one x or y position channel');
  }
  const barOpacity = opacityAttr(encoding, scales);
  if (barOpacity) lines.push(`    .attr("opacity", d => ${barOpacity})`);
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
  const {x, y, size, shape} = scales;
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
  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', DEFAULT_FILL));
  const opacity = opacityAttr(encoding, scales);
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];

  if (encoding.shape && shape) {
    // A distinct marker shape per category (not just a plain circle) --
    // SVG has no built-in "draw this shape" primitive, so this needs
    // d3-shape's own symbol *path* generator instead of a <circle>. Its
    // `.size()` is an area (px^2), not a radius, so it's derived from the
    // same `r` this mark would otherwise use as a circle's own radius
    // (pi*r^2), keeping the two visually comparable regardless of which
    // one a given row ends up using.
    const symbolVar = 'pointSymbol';
    const symLines = [];
    symLines.push(
      `const ${symbolVar} = d3.symbol().type(d => shape(d[${JSON.stringify(encoding.shape.field)}])).size(d => Math.PI * Math.pow(${r}, 2));`
    );
    symLines.push(`svg.append("g")`);
    if (!rowDependent) symLines.push(`  .attr("fill", ${fill})`);
    symLines.push(`  .attr("fill-opacity", ${markProps.filled === false ? 0 : 0.8})`);
    symLines.push(`  .selectAll("path")`);
    symLines.push(`  .data(${dataVar})`);
    symLines.push(`  .join("path")`);
    if (rowDependent) symLines.push(`    .attr("fill", d => ${fill})`);
    symLines.push(`    .attr("transform", d => "translate(" + (${cx}) + "," + (${cy}) + ")")`);
    symLines.push(`    .attr("d", ${symbolVar})`);
    if (opacity) symLines.push(`    .attr("opacity", d => ${opacity})`);
    appendTitle(symLines, '    ', encoding);
    return '{\n' + symLines.join('\n').replace(/^/gm, '  ') + '\n}';
  }

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
    const stroke = encoding.color ? `color(key)` : JSON.stringify(markColorFallback(markProps, 'stroke', DEFAULT_STROKE));
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
    const stroke = JSON.stringify(markColorFallback(markProps, 'stroke', DEFAULT_STROKE));
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
  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', DEFAULT_FILL));

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

// A rule mark's x/y channel commonly has no `field` at all -- just a
// constant `value` (a fixed reference line position), sometimes itself
// computed via `{"expr": "..."}` rather than given as a literal. The
// common real-world shape for that expr is `scale('x', <inner>)`: Vega's
// own idiom for converting a *data-space* value into the pixel space a
// mark's raw position property expects (needed because such a value
// channel bypasses the normal field->scale encoding pipeline entirely) --
// translated here into an actual call to this chart's own x/y scale
// function, which already does exactly that. `<inner>` commonly indexes
// into an `extent` transform's param array (`b_extent[0]`) -- resolved
// directly at each reference (see collectExtentParams() in translator.js)
// rather than through a separately pre-declared runtime variable, sidestepping
// any redeclaration clash across sibling layer children (each of which
// independently re-runs its own copy of the same top-level transform).
const SCALE_CALL_RE = /^scale\(\s*['"]([xy])['"]\s*,\s*(.+)\)$/;

// Vega-Lite's own "DateTime object" shorthand for a literal temporal
// constant (e.g. `{"datum": {"year": 2006}}`, as opposed to a real field
// reference) -- unlike a plain scalar `datum`, this needs converting into
// an actual JS Date before it can be handed to a temporal scale.
function isDateTimeObject(datum) {
  return datum && typeof datum === 'object' && !Array.isArray(datum);
}

function datumToJsExpr(datum) {
  if (!isDateTimeObject(datum)) return formatValue(datum);
  const {year = 2012, quarter, month = 1, date = 1, hours = 0, minutes = 0, seconds = 0, milliseconds = 0} = datum;
  const monthIndex = quarter !== undefined ? (quarter - 1) * 3 : month - 1;
  return `new Date(${year}, ${monthIndex}, ${date}, ${hours}, ${minutes}, ${seconds}, ${milliseconds})`;
}

// `datum` binds a channel to a literal *data-space* constant that still
// goes through the normal field->scale pipeline (unlike `value`, which is
// a literal *visual/pixel-space* constant that bypasses scaling entirely)
// -- so resolving it is just "run this literal through the axis's own
// scale function", the same idiom `resolveValueChannelExpr`'s `scale(...)`
// signal form already uses for expr-bound constants.
function resolveDatumChannelExpr(def, axisChannel) {
  return `${axisChannel}(${datumToJsExpr(def.datum)})`;
}

function resolveValueChannelExpr(def, dataVar, extentParams, ignoreUnsupported) {
  if (def.value === null || def.value === undefined) {
    if (ignoreUnsupported) return '0 /* vl2d3: unsupported value-channel shape (no field/value), using 0 (--ignore-unsupported) */';
    throw new Error('Unsupported: channel has neither a field nor a value');
  }
  if (typeof def.value !== 'object' || !('expr' in def.value)) {
    return formatValue(def.value);
  }
  const m = SCALE_CALL_RE.exec(def.value.expr.trim());
  if (!m) return translateExpr(def.value.expr);
  const [, axisChannel, inner] = m;
  const rewrittenInner = inner.replace(/\b([A-Za-z_$][\w$]*)\[(\d+)\]/g, (whole, name, idx) => {
    const sourceField = extentParams[name];
    return sourceField === undefined ? whole : `d3.extent(${dataVar}, d => d[${JSON.stringify(sourceField)}])[${idx}]`;
  });
  return `${axisChannel}(${rewrittenInner})`;
}

function renderRule(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false, extentParams = {}) {
  const {x, y} = scales;
  const stroke = fillExpr(encoding, scales, markColorFallback(markProps, 'stroke', 'black'));
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
    lines.push(`    .attr("y1", d => ${y ? dodgeAwareAccessor(encoding, scales, 'y') : dims.marginTopExpr})`);
    lines.push(`    .attr("y2", d => ${y ? dodgeAwareAccessor(encoding, scales, 'y') : dims.heightMinusBottomExpr})`);
  } else if (encoding.y && encoding.y2) {
    lines.push(`    .attr("y1", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    lines.push(`    .attr("y2", d => y(d[${JSON.stringify(encoding.y2.field)}]))`);
    lines.push(`    .attr("x1", d => ${x ? dodgeAwareAccessor(encoding, scales, 'x') : dims.marginLeftExpr})`);
    lines.push(`    .attr("x2", d => ${x ? dodgeAwareAccessor(encoding, scales, 'x') : dims.widthMinusRightExpr})`);
  } else if (encoding.x && !encoding.y) {
    if (encoding.x.field) {
      lines.push(`    .attr("x1", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
      lines.push(`    .attr("x2", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
    } else if (encoding.x.datum !== undefined) {
      const constExpr = resolveDatumChannelExpr(encoding.x, 'x');
      lines.push(`    .attr("x1", ${constExpr})`);
      lines.push(`    .attr("x2", ${constExpr})`);
    } else {
      const constExpr = resolveValueChannelExpr(encoding.x, dataVar, extentParams, ignoreUnsupported);
      lines.push(`    .attr("x1", ${constExpr})`);
      lines.push(`    .attr("x2", ${constExpr})`);
    }
    lines.push(`    .attr("y1", ${dims.marginTopExpr})`);
    lines.push(`    .attr("y2", ${dims.heightMinusBottomExpr})`);
  } else if (encoding.y && !encoding.x) {
    if (encoding.y.field) {
      lines.push(`    .attr("y1", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
      lines.push(`    .attr("y2", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    } else if (encoding.y.datum !== undefined) {
      const constExpr = resolveDatumChannelExpr(encoding.y, 'y');
      lines.push(`    .attr("y1", ${constExpr})`);
      lines.push(`    .attr("y2", ${constExpr})`);
    } else {
      const constExpr = resolveValueChannelExpr(encoding.y, dataVar, extentParams, ignoreUnsupported);
      lines.push(`    .attr("y1", ${constExpr})`);
      lines.push(`    .attr("y2", ${constExpr})`);
    }
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
  const stroke = fillExpr(encoding, scales, markColorFallback(markProps, 'stroke', 'black'));
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
    const centerY = dodgeAwareAccessor(encoding, scales, 'y');
    lines.push(`    .attr("x1", d => ${centerX} - ${half})`);
    lines.push(`    .attr("x2", d => ${centerX} + ${half})`);
    lines.push(`    .attr("y1", d => ${centerY})`);
    lines.push(`    .attr("y2", d => ${centerY})`);
  } else if (x && !y) {
    // 1D strip plot along x: short vertical ticks centered on the plot.
    const centerX2 = dodgeAwareAccessor(encoding, scales, 'x');
    lines.push(`    .attr("x1", d => ${centerX2})`);
    lines.push(`    .attr("x2", d => ${centerX2})`);
    lines.push(`    .attr("y1", ${dims.centerYExpr} - ${TICK_HALF})`);
    lines.push(`    .attr("y2", ${dims.centerYExpr} + ${TICK_HALF})`);
  } else {
    // 1D strip plot along y: short horizontal ticks centered on the plot.
    const centerY2 = dodgeAwareAccessor(encoding, scales, 'y');
    lines.push(`    .attr("y1", d => ${centerY2})`);
    lines.push(`    .attr("y2", d => ${centerY2})`);
    lines.push(`    .attr("x1", ${dims.centerXExpr} - ${TICK_HALF})`);
    lines.push(`    .attr("x2", ${dims.centerXExpr} + ${TICK_HALF})`);
  }
  return lines.join('\n');
}

function renderText(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  // A `text` mark's label is usually an encoding channel, but Vega-Lite
  // also allows a literal constant directly on the mark definition (a
  // string, or an array of strings meaning multiple lines) -- no encoding
  // at all in that case.
  if (!encoding.text && markProps.text === undefined) {
    if (ignoreUnsupported) return SKIP_COMMENT('"text" mark has no text encoding');
    throw new Error('"text" mark requires a text encoding');
  }
  if (!encoding.text && !ignoreUnsupported) {
    throw new Error('Unsupported: a "text" mark with a literal mark-level "text" (not an encoding) is not yet supported by vl2d3');
  }
  const cx = encoding.x ? dodgeAwareAccessor(encoding, scales, 'x') : dims.centerXExpr;
  const cy = encoding.y ? dodgeAwareAccessor(encoding, scales, 'y') : dims.centerYExpr;
  const textField = encoding.text
    ? rawField(encoding.text) || formatValue(encoding.text.value)
    : formatValue(Array.isArray(markProps.text) ? markProps.text.join('\n') : markProps.text);
  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', 'black'));
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
