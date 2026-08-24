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
// field access (`scaleVar(d["field"])`), a raw field access (no scale
// resolved for this channel, e.g. `text`), or -- see
// conditionalAccessorExpr() -- a `condition` (evaluated per-row, falling
// back to this same def's own base field/value, or `noBaseFallback`, when
// the condition doesn't match).
function accessor(def, scales, channel, noBaseFallback = 'undefined', ignoreUnsupported = false) {
  if (!def) return null;
  if (def.condition) return conditionalAccessorExpr(def, scales, channel, noBaseFallback, ignoreUnsupported);
  if ('value' in def) return formatValue(def.value);
  const scale = scales[channel];
  const field = `d[${JSON.stringify(def.field)}]`;
  return scale ? `${scale.varName}(${field})` : field;
}

// `encoding.<channel>.condition` (e.g. bar_grouped_thin.vl.json's own
// `color: {condition: {test: "datum['IMDB Rating'] === null || ...",
// value: "#aaa"}}`, with no base field/value at all outside the
// condition) -- a per-row ternary, evaluating each condition's own `test`
// (the same JS-like expression language filter transforms already use) in
// priority order, falling through to this def's own base field/value (a
// condition can also just override a plain encoded channel for special-
// cased rows) or, if there isn't one, `noBaseFallback` (a caller-supplied
// JS expression string -- typically the mark's own default color, since a
// bare "condition-only, no base" channel def otherwise has nothing else to
// fall back on). A `test` bound to a param/selection (an object, e.g.
// `{"param": "brush"}`) rather than a plain string expression has no
// static value to resolve -- same "Unsupported: ..." (or, under
// ignoreUnsupported, "treat as never met") handling filterToExpr() already
// gives an equivalent filter predicate (expr.js), just inverted (a filter
// defaults an unresolvable predicate to "keep the row"; a condition
// defaults it to "doesn't apply", falling through to the next condition or
// base value instead).
function conditionalAccessorExpr(def, scales, channel, noBaseFallback, ignoreUnsupported = false) {
  const conditions = Array.isArray(def.condition) ? def.condition : [def.condition];
  const hasBase = def.field !== undefined || 'value' in def;
  let expr = hasBase ? accessor({field: def.field, value: def.value}, scales, channel) : noBaseFallback;
  for (let i = conditions.length - 1; i >= 0; i--) {
    const c = conditions[i];
    if (c.test === undefined) continue;
    // A *string* test can still reference a live param (e.g.
    // param_search_input.vl.json's own `search_input`, bound to a search
    // box, used inside `test(regexp(search_input,'i'), datum.Name)`) --
    // `regexp(...)`/`test(...)` are Vega expression-language builtins
    // translateExpr() doesn't implement (it has no way to distinguish
    // "genuinely undefined identifier" from "valid JS" in general), and
    // would otherwise reach the generated code as bare, unresolvable
    // identifiers, throwing a ReferenceError at *render* time instead of
    // translation time.
    const isUnresolvableVegaExpr = typeof c.test === 'string' && /\b(?:regexp|test)\s*\(/.test(c.test);
    let testExpr;
    if (typeof c.test === 'string' && !isUnresolvableVegaExpr) {
      testExpr = translateExpr(c.test, 'd');
    } else if (ignoreUnsupported) {
      testExpr = `false /* vl2d3: unsupported condition "test" bound to a param/selection or unimplemented expression function, treating as not met (--ignore-unsupported) */`;
    } else {
      throw new Error('Unsupported: a condition\'s "test" is bound to a param/selection, not a static expression');
    }
    const valueExpr = c.field !== undefined ? accessor({field: c.field, type: c.type, scale: c.scale}, scales, channel) : formatValue(c.value);
    expr = `(${testExpr}) ? (${valueExpr}) : (${expr})`;
  }
  return expr;
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
function dodgeAwareAccessor(encoding, scales, channel, ignoreUnsupported = false) {
  const def = encoding[channel];
  const base = accessor(def, scales, channel, 'undefined', ignoreUnsupported);
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

function fillExpr(encoding, scales, fallback = DEFAULT_FILL, ignoreUnsupported = false) {
  if (encoding.color) return accessor(encoding.color, scales, 'color', JSON.stringify(fallback), ignoreUnsupported);
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

function opacityAttr(encoding, scales, ignoreUnsupported = false) {
  if (!encoding.opacity) return null;
  return accessor(encoding.opacity, scales, 'opacity', '1', ignoreUnsupported);
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
//  - `rect` with an x2/y2 range -> drawn as a bar (renderBar already
//    handles the ranged-box case); without a range, falls through to a
//    point per row (still shows the underlying data, just not the
//    summary/band shape). `errorbar`/`errorband`/`boxplot` have their own
//    real renderers (renderErrorbar/renderErrorband/renderBoxplot) and
//    never reach this function at all.
//  - `trail` -> a plain line (drops the width-by-`size` encoding).
//  - `square`/anything else unrecognized -> a point.
function renderApproximateMark(type, encoding, scales, dims, dataVar, markProps, ignoreUnsupported) {
  const note = asType => `// vl2d3: unsupported mark type "${type}", drawing as "${asType}" instead (--ignore-unsupported)`;
  if (type === 'rect' && (encoding.x2 || encoding.y2)) {
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

  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', DEFAULT_FILL), ignoreUnsupported);
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

// The (lower, upper) bound expressions for an errorbar/errorband's
// `extent` -- computed from per-group summary stats already in scope
// (`mean`/`stdev`/`stderr`/`q1`/`q3`, see renderErrorbar()). "ci" uses a
// normal approximation (mean +/- 1.96*stderr) rather than Vega-Lite's own
// bootstrapped resample of the raw values -- a reasonable, deterministic
// stand-in, in keeping with this project's existing approach to other
// statistical marks (e.g. renderBoxplot's own min-max/IQR-multiple
// whiskers, never a full kernel-density-equivalent computation).
function errorExtentBounds(extent) {
  if (extent === 'stdev') return {lower: 'mean - stdev', upper: 'mean + stdev'};
  if (extent === 'ci') return {lower: 'mean - 1.96 * stderr', upper: 'mean + 1.96 * stderr'};
  if (extent === 'iqr') return {lower: 'q1', upper: 'q3'};
  return {lower: 'mean - stderr', upper: 'mean + stderr'}; // "stderr" -- Vega-Lite's own default extent.
}

// An "errorbar" mark with no explicit x2/y2 range (see renderApproximateMark
// for the already-ranged case, e.g. a pre-aggregated spec giving explicit
// lower/upper fields) is, like "boxplot", one of Vega-Lite's composite
// marks: it collapses each distinct category down to a summary interval
// (mean +/- some extent, computed from the *raw* per-row values) rather
// than drawing one shape per row. Same grouping idiom as renderBoxplot
// (distinct category/color/offset fields, deduplicated by field), but a
// much simpler shape to draw: a single rule from the lower to the upper
// bound, with small end ticks only when the mark opts into them
// (`mark.ticks`) -- Vega-Lite's own default appearance has none.
function renderErrorbar(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const xIsValue = encoding.x && encoding.x.type === 'quantitative';
  const yIsValue = encoding.y && encoding.y.type === 'quantitative';
  if (!xIsValue && !yIsValue) {
    if (ignoreUnsupported) {
      return (
        `// vl2d3: unsupported "errorbar" orientation (no quantitative x or y encoding), drawing a point per row instead (--ignore-unsupported)\n` +
        renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported)
      );
    }
    throw new Error('"errorbar" mark requires a quantitative x or y encoding');
  }
  const valueChannel = yIsValue ? 'y' : 'x';
  const catChannel = valueChannel === 'y' ? 'x' : 'y';
  const valueField = encoding[valueChannel].field;
  const catDef = encoding[catChannel];
  const offsetChannel = catChannel === 'x' ? 'xOffset' : 'yOffset';

  const {lower, upper} = errorExtentBounds(markProps.extent);

  const groupFields = [];
  for (const ch of [catChannel, 'color', offsetChannel]) {
    const def = encoding[ch];
    if (def && def.field && !groupFields.includes(def.field)) groupFields.push(def.field);
  }
  const keyExpr = groupFields.length
    ? `JSON.stringify([${groupFields.map(f => `d[${JSON.stringify(f)}]`).join(', ')}])`
    : '0';

  const statsVar = 'errStats';
  const lines = [];
  lines.push(
    `const ${statsVar} = Array.from(d3.group(${dataVar}, d => ${keyExpr}), ([, rows]) => {\n` +
      `  const values = rows.map(d => d[${JSON.stringify(valueField)}]).filter(v => v != null);\n` +
      `  const sorted = values.slice().sort(d3.ascending);\n` +
      `  const mean = d3.mean(values);\n` +
      `  const stdev = d3.deviation(values) ?? 0;\n` +
      `  const stderr = stdev / Math.sqrt(values.length);\n` +
      `  const q1 = d3.quantile(sorted, 0.25), q3 = d3.quantile(sorted, 0.75);\n` +
      `  return {...rows[0], lower: ${lower}, upper: ${upper}};\n` +
      `});`
  );

  const catCenter = catDef
    ? dodgeAwareAccessor(encoding, scales, catChannel)
    : catChannel === 'x'
      ? dims.centerXExpr
      : dims.centerYExpr;

  const stroke = encoding.color
    ? accessor(encoding.color, scales, 'color', formatValue(markColorFallback(markProps, 'stroke', 'black')), ignoreUnsupported)
    : formatValue(markColorFallback(markProps, 'stroke', 'black'));
  const rowDependent = hasRowDependentColor(encoding);

  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`    .attr("stroke", ${stroke})`);
  lines.push(`  .selectAll("line")`);
  lines.push(`  .data(${statsVar})`);
  lines.push(`  .join("line")`);
  if (rowDependent) lines.push(`    .attr("stroke", d => ${stroke})`);
  if (valueChannel === 'x') {
    lines.push(`    .attr("x1", d => x(d.lower))`);
    lines.push(`    .attr("x2", d => x(d.upper))`);
    lines.push(`    .attr("y1", d => ${catCenter})`);
    lines.push(`    .attr("y2", d => ${catCenter})`);
  } else {
    lines.push(`    .attr("y1", d => y(d.lower))`);
    lines.push(`    .attr("y2", d => y(d.upper))`);
    lines.push(`    .attr("x1", d => ${catCenter})`);
    lines.push(`    .attr("x2", d => ${catCenter})`);
  }

  // End ticks are opt-in (`mark.ticks`, a boolean or a styling object with
  // its own `color`) -- Vega-Lite's own default errorbar has none.
  if (markProps.ticks) {
    const ticksProps = typeof markProps.ticks === 'object' ? markProps.ticks : {};
    const tickStroke = ticksProps.color ? formatValue(ticksProps.color) : stroke;
    const tickHalf = 4;
    lines.push(`svg.append("g")`);
    if (!rowDependent || ticksProps.color) lines.push(`    .attr("stroke", ${tickStroke})`);
    lines.push(`  .selectAll("line")`);
    lines.push(`  .data(${statsVar}.flatMap(d => [{...d, __v: d.lower}, {...d, __v: d.upper}]))`);
    lines.push(`  .join("line")`);
    if (rowDependent && !ticksProps.color) lines.push(`    .attr("stroke", d => ${stroke})`);
    if (valueChannel === 'x') {
      lines.push(`    .attr("x1", d => x(d.__v))`);
      lines.push(`    .attr("x2", d => x(d.__v))`);
      lines.push(`    .attr("y1", d => ${catCenter} - ${tickHalf})`);
      lines.push(`    .attr("y2", d => ${catCenter} + ${tickHalf})`);
    } else {
      lines.push(`    .attr("y1", d => y(d.__v))`);
      lines.push(`    .attr("y2", d => y(d.__v))`);
      lines.push(`    .attr("x1", d => ${catCenter} - ${tickHalf})`);
      lines.push(`    .attr("x2", d => ${catCenter} + ${tickHalf})`);
    }
  }

  return '{\n' + lines.join('\n').replace(/^/gm, '  ') + '\n}';
}

// A pre-aggregated errorbar (one row per category already, no per-row
// summarizing needed) gives its interval directly via `xError`/`xError2`
// (or the y equivalents) instead of a real `x2`/`y2` range -- `xError`
// alone is a symmetric +/- offset from the base value; `xError` +
// `xError2` together are both offsets *added* to the base value (Vega-Lite
// semantics: `xError2` is not itself the lower bound, it's the signed
// offset to it -- mirrors error_bounds() in vl2ggplot's geoms.R). No
// grouping/stats computation needed here at all, unlike renderErrorbar()'s
// raw-values case -- just a rule per existing row.
function renderErrorbarFromError(encoding, scales, dims, dataVar, markProps, errChannel, ignoreUnsupported = false) {
  const catChannel = errChannel === 'x' ? 'y' : 'x';
  const baseField = JSON.stringify(encoding[errChannel].field);
  const errField = JSON.stringify(encoding[`${errChannel}Error`].field);
  const err2Def = encoding[`${errChannel}Error2`];
  const lowerExpr = err2Def
    ? `${errChannel}(d[${baseField}] + d[${JSON.stringify(err2Def.field)}])`
    : `${errChannel}(d[${baseField}] - d[${errField}])`;
  const upperExpr = `${errChannel}(d[${baseField}] + d[${errField}])`;

  const catDef = encoding[catChannel];
  const catCenter = catDef
    ? dodgeAwareAccessor(encoding, scales, catChannel)
    : catChannel === 'x'
      ? dims.centerXExpr
      : dims.centerYExpr;

  const stroke = encoding.color
    ? accessor(encoding.color, scales, 'color', formatValue(markColorFallback(markProps, 'stroke', 'black')), ignoreUnsupported)
    : formatValue(markColorFallback(markProps, 'stroke', 'black'));
  const rowDependent = hasRowDependentColor(encoding);

  const lines = [];
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`    .attr("stroke", ${stroke})`);
  lines.push(`  .selectAll("line")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("line")`);
  if (rowDependent) lines.push(`    .attr("stroke", d => ${stroke})`);
  if (errChannel === 'x') {
    lines.push(`    .attr("x1", d => ${lowerExpr})`);
    lines.push(`    .attr("x2", d => ${upperExpr})`);
    lines.push(`    .attr("y1", d => ${catCenter})`);
    lines.push(`    .attr("y2", d => ${catCenter})`);
  } else {
    lines.push(`    .attr("y1", d => ${lowerExpr})`);
    lines.push(`    .attr("y2", d => ${upperExpr})`);
    lines.push(`    .attr("x1", d => ${catCenter})`);
    lines.push(`    .attr("x2", d => ${catCenter})`);
  }

  if (markProps.ticks) {
    const ticksProps = typeof markProps.ticks === 'object' ? markProps.ticks : {};
    const tickStroke = ticksProps.color ? formatValue(ticksProps.color) : stroke;
    const tickHalf = 4;
    lines.push(`svg.append("g")`);
    if (!rowDependent || ticksProps.color) lines.push(`    .attr("stroke", ${tickStroke})`);
    lines.push(`  .selectAll("line")`);
    lines.push(`  .data(${dataVar}.flatMap(d => [d, d]))`);
    lines.push(`  .join("line")`);
    if (rowDependent && !ticksProps.color) lines.push(`    .attr("stroke", d => ${stroke})`);
    if (errChannel === 'x') {
      lines.push(`    .attr("x1", (d, i) => i % 2 === 0 ? ${lowerExpr} : ${upperExpr})`);
      lines.push(`    .attr("x2", (d, i) => i % 2 === 0 ? ${lowerExpr} : ${upperExpr})`);
      lines.push(`    .attr("y1", d => ${catCenter} - ${tickHalf})`);
      lines.push(`    .attr("y2", d => ${catCenter} + ${tickHalf})`);
    } else {
      lines.push(`    .attr("y1", (d, i) => i % 2 === 0 ? ${lowerExpr} : ${upperExpr})`);
      lines.push(`    .attr("y2", (d, i) => i % 2 === 0 ? ${lowerExpr} : ${upperExpr})`);
      lines.push(`    .attr("x1", d => ${catCenter} - ${tickHalf})`);
      lines.push(`    .attr("x2", d => ${catCenter} + ${tickHalf})`);
    }
  }

  return lines.join('\n');
}

// An "errorband" is errorbar's filled-area sibling: same per-group summary
// stat (mean +/- extent, see errorExtentBounds()), but instead of one rule
// per category, a single continuous band connecting every distinct
// along-axis value's own (lower, upper) pair -- so unlike renderErrorbar
// (whose category axis is normally nominal/banded), this one is normally
// continuous or temporal (one point per distinct x, not one box per
// category), the same shape renderArea() draws for a real "area" mark.
// With no along-axis field at all (e.g. a scatterplot's shared 1D
// reference band), there's nothing to connect, so it falls back to a
// single full-width/height rect instead -- the band equivalent of
// renderBoxplot's own "no category channel" case.
function renderErrorband(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const xIsValue = encoding.x && encoding.x.type === 'quantitative';
  const yIsValue = encoding.y && encoding.y.type === 'quantitative';
  if (!xIsValue && !yIsValue) {
    if (ignoreUnsupported) {
      return `// vl2d3: unsupported "errorband" orientation (no quantitative x or y encoding), skipping (--ignore-unsupported)`;
    }
    throw new Error('"errorband" mark requires a quantitative x or y encoding');
  }
  const valueChannel = yIsValue ? 'y' : 'x';
  const catChannel = valueChannel === 'y' ? 'x' : 'y';
  const valueField = encoding[valueChannel].field;
  const catDef = encoding[catChannel];

  const {lower, upper} = errorExtentBounds(markProps.extent);
  const statBody =
    `const values = ${'{{DATA}}'}.map(d => d[${JSON.stringify(valueField)}]).filter(v => v != null);\n` +
    `  const sorted = values.slice().sort(d3.ascending);\n` +
    `  const mean = d3.mean(values);\n` +
    `  const stdev = d3.deviation(values) ?? 0;\n` +
    `  const stderr = stdev / Math.sqrt(values.length);\n` +
    `  const q1 = d3.quantile(sorted, 0.25), q3 = d3.quantile(sorted, 0.75);\n`;

  const bandVar = 'errBand';
  const lines = [];
  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', DEFAULT_FILL), ignoreUnsupported);
  const bandOpacity = markProps.opacity !== undefined ? formatValue(markProps.opacity) : '0.3';

  if (catDef && catDef.field) {
    const catField = JSON.stringify(catDef.field);
    lines.push(
      `const ${bandVar} = Array.from(d3.group(${dataVar}, d => d[${catField}]), ([, rows]) => {\n` +
        `  ${statBody.replace('{{DATA}}', 'rows')}` +
        `  return {...rows[0], lower: ${lower}, upper: ${upper}};\n` +
        `}).sort((a, b) => d3.ascending(a[${catField}], b[${catField}]));`
    );
    const catAccessor = `${catChannel}(d[${catField}])`;
    lines.push(`svg.append("path")`);
    lines.push(`    .attr("fill", ${fill})`);
    lines.push(`    .attr("fill-opacity", ${bandOpacity})`);
    if (valueChannel === 'y') {
      lines.push(`    .attr("d", d3.area().x(d => ${catAccessor}).y0(d => y(d.lower)).y1(d => y(d.upper))(${bandVar}))`);
    } else {
      lines.push(`    .attr("d", d3.area().y(d => ${catAccessor}).x0(d => x(d.lower)).x1(d => x(d.upper))(${bandVar}))`);
    }
    // `borders` (boolean, or a styling object) draws the band's own two
    // edges as separate outline strokes -- Vega-Lite's real behavior,
    // distinct from just stroking the filled area (which would also draw
    // a stroke across the two connecting ends).
    if (markProps.borders) {
      const bordersProps = typeof markProps.borders === 'object' ? markProps.borders : {};
      const borderStroke = bordersProps.color ? formatValue(bordersProps.color) : fill;
      const borderOpacity = bordersProps.opacity !== undefined ? formatValue(bordersProps.opacity) : '1';
      const dashArray = bordersProps.strokeDash ? `\n    .attr("stroke-dasharray", ${formatValue(bordersProps.strokeDash.join(','))})` : '';
      for (const bound of ['lower', 'upper']) {
        lines.push(`svg.append("path")`);
        lines.push(`    .attr("fill", "none")`);
        lines.push(`    .attr("stroke", ${borderStroke})`);
        lines.push(`    .attr("stroke-opacity", ${borderOpacity})${dashArray}`);
        if (valueChannel === 'y') {
          lines.push(`    .attr("d", d3.line().x(d => ${catAccessor}).y(d => y(d.${bound}))(${bandVar}))`);
        } else {
          lines.push(`    .attr("d", d3.line().y(d => ${catAccessor}).x(d => x(d.${bound}))(${bandVar}))`);
        }
      }
    }
  } else {
    lines.push(`const ${bandVar} = (() => {\n  ${statBody.replace('{{DATA}}', dataVar)}  return {lower: ${lower}, upper: ${upper}};\n})();`);
    lines.push(`svg.append("rect")`);
    lines.push(`    .attr("fill", ${fill})`);
    lines.push(`    .attr("fill-opacity", ${bandOpacity})`);
    if (valueChannel === 'y') {
      lines.push(`    .attr("x", ${dims.marginLeftExpr})`);
      lines.push(`    .attr("width", ${dims.widthMinusRightExpr} - ${dims.marginLeftExpr})`);
      lines.push(`    .attr("y", y(${bandVar}.upper))`);
      lines.push(`    .attr("height", Math.abs(y(${bandVar}.lower) - y(${bandVar}.upper)))`);
    } else {
      lines.push(`    .attr("y", ${dims.marginTopExpr})`);
      lines.push(`    .attr("height", ${dims.heightMinusBottomExpr} - ${dims.marginTopExpr})`);
      lines.push(`    .attr("x", x(${bandVar}.lower))`);
      lines.push(`    .attr("width", Math.abs(x(${bandVar}.upper) - x(${bandVar}.lower)))`);
    }
  }

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
    case 'errorbar': {
      // A pre-aggregated spec already gives an explicit lower/upper range
      // -- either a real x2/y2 (draw that box/range directly, the same
      // well-defined shape "bar"/"rect" use for their own x2/y2 case), or
      // xError/xError2 (a signed offset from the base value, rather than
      // an absolute bound -- renderErrorbarFromError() below) -- either
      // way, no need to re-derive the interval from raw per-row values.
      const errChannel = encoding.xError ? 'x' : encoding.yError ? 'y' : null;
      if (errChannel) {
        return renderErrorbarFromError(encoding, scales, dims, dataVar, markProps, errChannel, ignoreUnsupported);
      }
      if (encoding.x2 || encoding.y2) {
        return renderBar(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
      }
      return renderErrorbar(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
    }
    case 'errorband':
      // A pre-aggregated errorband already gives an explicit y2/x2 lower
      // bound -- renderArea() already draws exactly that shape (it treats
      // y2 as the band's own baseline instead of a zero baseline), so no
      // need for errorband's own stat computation at all.
      if (encoding.x2 || encoding.y2) {
        return renderArea(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
      }
      return renderErrorband(encoding, scales, dims, dataVar, markProps, ignoreUnsupported);
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

// The companion (non-value) axis's own span for a bar with only one
// position channel at all (no x2/y2, no band on the other axis) -- an
// explicit numeric `mark.size` (already resolved from any static-param
// expr by resolveMarkPropExprs(), translator.js) is a real, deliberate
// fixed thickness (e.g. a bullet chart's own stacked range/measure bars,
// each a different literal `size` centered on the same row), taking
// priority over the full-plot-height/width default this project otherwise
// uses when nothing says otherwise (verified against real Vega-Lite output
// for bar_1d/bar_1d_default_size, which have no `size` at all).
function fixedOrFullSpan(markProps, dims, axis) {
  const size = markProps.size;
  if (typeof size === 'number') {
    const center = axis === 'y' ? dims.centerYExpr : dims.centerXExpr;
    return {pos: `${center} - ${size / 2}`, extent: formatValue(size)};
  }
  return axis === 'y'
    ? {pos: dims.marginTopExpr, extent: `${dims.heightMinusBottomExpr} - ${dims.marginTopExpr}`}
    : {pos: dims.marginLeftExpr, extent: `${dims.widthMinusRightExpr} - ${dims.marginLeftExpr}`};
}

function renderBar(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const {x, y} = scales;
  const xBand = x && x.kind === 'band';
  const yBand = y && y.kind === 'band';
  const xTemporalBar = !xBand && x && encoding.x && encoding.x.type === 'temporal';
  const yTemporalBar = !yBand && y && encoding.y && encoding.y.type === 'temporal';
  const xAmbiguous = x && x.kind === 'ambiguous';
  const yAmbiguous = y && y.kind === 'ambiguous';
  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', DEFAULT_FILL), ignoreUnsupported);
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
  } else if (encoding.x2 && yAmbiguous) {
    // The companion (non-value) axis for an x2-ranged bar (most commonly a
    // stacked bar, e.g. bar_diverging_stack_population_pyramid.vl.json's
    // own un-typed `age` field) whose own band-vs-continuous shape isn't
    // known until the data loads -- needed here (unlike the plain
    // `yAmbiguous && !encoding.x2` case just above, whose OWN render
    // branch handles the width itself) because x2's presence means y is
    // *always* the position/category axis, never a value -- the render
    // branch below needs this same reference-band width regardless of
    // which way `isNominalVar` resolves.
    lines.push(ambiguousBarWidthDecl(yBarWidthVar, y, dataVar, encoding.y.field));
    needsWidthBlock = true;
  } else if (encoding.y2 && xAmbiguous) {
    lines.push(ambiguousBarWidthDecl(xBarWidthVar, x, dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (encoding.x && !encoding.y && !encoding.x2 && markProps.orient === 'vertical') {
    // An explicit `mark.orient` that *conflicts* with the one position
    // channel actually given (e.g. bar_1d_dimension_only.vl.json's own
    // `orient: "horizontal"` with only `y` set -- the y-only mirror of
    // this branch, just below) means that channel is deliberately being
    // used as the discrete/category axis, not a value -- Vega-Lite draws
    // a thin reference-band tick at each row's own position instead of a
    // zero-baseline bar (every OTHER lone-position-channel bar/rect this
    // project's example corpus has, with no such override, gets the
    // zero-baseline treatment in the final `else if (encoding.x &&
    // !encoding.y)` branch further down instead).
    lines.push(temporalBarWidthDecl(xBarWidthVar, 'x', dataVar, encoding.x.field));
    needsWidthBlock = true;
  } else if (encoding.y && !encoding.x && !encoding.y2 && markProps.orient === 'horizontal') {
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
    // `mark.xOffset`/`x2Offset`/`yOffset`/`y2Offset` (a plain pixel number,
    // not an encoding channel -- e.g. bar_heatlane.vl.json's own `"xOffset":
    // 2, "x2Offset": -2`, insetting each box 2px on both sides to form a
    // visible gap between adjacent lanes) shift that one edge's own scaled
    // pixel position directly, same as Vega-Lite's own semantics for them.
    const xOffsetPx = simpleMarkProp(markProps.xOffset, 0, 'xOffset', ignoreUnsupported);
    const x2OffsetPx = simpleMarkProp(markProps.x2Offset, 0, 'x2Offset', ignoreUnsupported);
    const yOffsetPx = simpleMarkProp(markProps.yOffset, 0, 'yOffset', ignoreUnsupported);
    const y2OffsetPx = simpleMarkProp(markProps.y2Offset, 0, 'y2Offset', ignoreUnsupported);
    const xExpr = xOffsetPx ? `(x(d[${JSON.stringify(encoding.x.field)}]) + ${formatValue(xOffsetPx)})` : `x(d[${JSON.stringify(encoding.x.field)}])`;
    const x2Expr = x2OffsetPx ? `(x(d[${JSON.stringify(encoding.x2.field)}]) + ${formatValue(x2OffsetPx)})` : `x(d[${JSON.stringify(encoding.x2.field)}])`;
    const yExpr = yOffsetPx ? `(y(d[${JSON.stringify(encoding.y.field)}]) + ${formatValue(yOffsetPx)})` : `y(d[${JSON.stringify(encoding.y.field)}])`;
    const y2Expr = y2OffsetPx ? `(y(d[${JSON.stringify(encoding.y2.field)}]) + ${formatValue(y2OffsetPx)})` : `y(d[${JSON.stringify(encoding.y2.field)}])`;
    lines.push(`    .attr("x", d => Math.min(${xExpr}, ${x2Expr}))`);
    lines.push(`    .attr("width", d => Math.abs(${x2Expr} - ${xExpr}))`);
    lines.push(`    .attr("y", d => Math.min(${yExpr}, ${y2Expr}))`);
    lines.push(`    .attr("height", d => Math.abs(${y2Expr} - ${yExpr}))`);
    if (markProps.cornerRadius) {
      lines.push(`    .attr("rx", ${formatValue(simpleMarkProp(markProps.cornerRadius, 0, 'cornerRadius', ignoreUnsupported))})`);
    }
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
      // the data has loaded (e.g. bar_diverging_stack_population_pyramid
      // .vl.json's own un-typed `age` field, a stacked bar's category
      // axis) -- checked at runtime via the same `isNominalVar` flag the
      // scale declaration itself used. `x2`'s presence means y is *never*
      // a value axis here (x already carries the full stacked range), so
      // even the "resolved continuous" case is a reference-band position
      // (yBarWidthVar, from the matching width-decl branch above) centered
      // on the row's own y value -- NOT `Math.min(y(0), ...)` (that
      // zero-baseline math previously drew one giant bar per row, from
      // pixel-y(0) all the way out to the row's own y position, instead of
      // a normal-height row).
      lines.push(
        `    .attr("y", d => ${y.isNominalVar} ? y(d[${JSON.stringify(encoding.y.field)}]) : y(d[${JSON.stringify(encoding.y.field)}]) - ${yBarWidthVar} / 2)`
      );
      lines.push(`    .attr("height", d => ${y.isNominalVar} ? y.bandwidth() : ${yBarWidthVar})`);
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
      // `mark.size` (e.g. bar_layered_weather.vl.json's own several
      // differently-sized floating-bar layers, 20px/12px/3px, all sharing
      // one ordinal `id` band) narrows the bar to a fixed width centered
      // within its band, same as any other explicit mark size -- the full
      // `x.bandwidth()` is only the fallback for no explicit size at all.
      const sizeValue = simpleMarkProp(markProps.size, undefined, 'size', ignoreUnsupported);
      if (typeof sizeValue === 'number') {
        lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) + (x.bandwidth() - ${formatValue(sizeValue)}) / 2)`);
        lines.push(`    .attr("width", ${formatValue(sizeValue)})`);
      } else {
        lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
        lines.push(`    .attr("width", x.bandwidth())`);
      }
    } else if (encoding.x && xAmbiguous) {
      // Same reasoning as the `encoding.x2 && yAmbiguous` branch above,
      // transposed -- `y2`'s presence means x is never a value axis here,
      // so the "resolved continuous" case also gets the computed
      // reference-band width (xBarWidthVar, from the matching width-decl
      // branch above), not a fixed guess.
      lines.push(
        `    .attr("x", d => ${x.isNominalVar} ? x(d[${JSON.stringify(encoding.x.field)}]) : x(d[${JSON.stringify(encoding.x.field)}]) - ${xBarWidthVar} / 2)`
      );
      lines.push(`    .attr("width", d => ${x.isNominalVar} ? x.bandwidth() : ${xBarWidthVar})`);
    } else if (encoding.x) {
      // `x` here is only ever the *other*, non-stacked/ranged axis (`y2`
      // already carries the real value range) -- a plain quantitative field
      // standing in for a discrete category (e.g.
      // bar_invalid_color_show_override.vl.json's `x: {field: "a", type:
      // "quantitative"}`, values 1/2/3, with `y`/color doing the actual
      // stacking), not a magnitude of its own. Vega-Lite's own
      // `config.bar.continuousBandSize` (5px) fixed-width bar centered at
      // each row's x position -- same convention the plain `encoding.x &&
      // encoding.y` branch above uses -- not a zero-baseline-to-value bar
      // (which drew one enormous, overlapping bar per row, spanning from
      // x=0 out to each row's own x, instead of a normal-width column).
      lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - 2.5)`);
      lines.push(`    .attr("width", 5)`);
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
  } else if (encoding.x && !encoding.y && markProps.orient === 'vertical') {
    // `mark.orient` explicitly conflicts with the one position channel
    // given (see the identical-condition width-decl branch above) -- `x`
    // is deliberately the discrete/category axis here, not a value, so a
    // thin reference-band tick is drawn at each row's own x position
    // instead of a zero-baseline bar (e.g. bar_1d_dimension_only.vl.json's
    // own y-only mirror of this, `orient: "horizontal"`).
    const ySpan = fixedOrFullSpan(markProps, dims, 'y');
    lines.push(`    .attr("x", d => x(d[${JSON.stringify(encoding.x.field)}]) - ${xBarWidthVar} / 2)`);
    lines.push(`    .attr("width", ${xBarWidthVar})`);
    lines.push(`    .attr("y", ${ySpan.pos})`);
    lines.push(`    .attr("height", ${ySpan.extent})`);
  } else if (encoding.y && !encoding.x && markProps.orient === 'horizontal') {
    const xSpan = fixedOrFullSpan(markProps, dims, 'x');
    lines.push(`    .attr("y", d => y(d[${JSON.stringify(encoding.y.field)}]) - ${yBarWidthVar} / 2)`);
    lines.push(`    .attr("height", ${yBarWidthVar})`);
    lines.push(`    .attr("x", ${xSpan.pos})`);
    lines.push(`    .attr("width", ${xSpan.extent})`);
  } else if (encoding.x && !encoding.y) {
    // A single quantitative position channel and nothing else at all (a
    // "1D bar" -- e.g. a lone dataset-wide aggregate with no groupby, or
    // facet_bullet.vl.json's own un-aggregated `ranges[N]`/`measures[N]`
    // fields) -- Vega-Lite still draws a real bar: zero baseline to the
    // value, along the one axis it has, whether or not that value came
    // from an inline `aggregate` (every other spec shape reaching this
    // branch already resolved to a real x2/temporal/band/ambiguous/
    // orient-conflict case earlier, so a plain, un-aggregated quantitative
    // x here is never a "reference band" instead -- it's just a
    // magnitude, same as an aggregated one). The companion axis span is
    // `mark.size` when given (see fixedOrFullSpan()), else the full plot
    // height (no companion axis is drawn at all in that case, so there's
    // nothing to center a smaller band against).
    const ySpan = fixedOrFullSpan(markProps, dims, 'y');
    lines.push(`    .attr("x", d => Math.min(x(0), x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("width", d => Math.abs(x(0) - x(d[${JSON.stringify(encoding.x.field)}])))`);
    lines.push(`    .attr("y", ${ySpan.pos})`);
    lines.push(`    .attr("height", ${ySpan.extent})`);
  } else if (encoding.y && !encoding.x) {
    const xSpan = fixedOrFullSpan(markProps, dims, 'x');
    lines.push(`    .attr("y", d => Math.min(y(0), y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("height", d => Math.abs(y(0) - y(d[${JSON.stringify(encoding.y.field)}])))`);
    lines.push(`    .attr("x", ${xSpan.pos})`);
    lines.push(`    .attr("width", ${xSpan.extent})`);
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
  const barOpacity = opacityAttr(encoding, scales, ignoreUnsupported);
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

// Vega-Lite's own named shape values, for a `shape` channel bound to a
// literal constant (`{"value": "square"}`) rather than a data field -- no
// scale involved (resolveShapeScale/scales.shape only exists for the
// data-driven case), so this maps the name directly to a d3-shape symbol
// type. Falls back to a circle for any name with no close d3-shape
// equivalent, same as SHAPE_SYMBOLS' own approximations in scales.js.
const NAMED_SHAPE_SYMBOLS = {
  circle: 'd3.symbolCircle',
  square: 'd3.symbolSquare',
  cross: 'd3.symbolCross',
  diamond: 'd3.symbolDiamond',
  triangle: 'd3.symbolTriangle',
  'triangle-up': 'd3.symbolTriangle',
  'triangle-down': 'd3.symbolTriangle2',
  'triangle-right': 'd3.symbolTriangle',
  'triangle-left': 'd3.symbolTriangle',
  arrow: 'd3.symbolTriangle',
  wedge: 'd3.symbolWye',
  stroke: 'd3.symbolCircle',
};

function renderPoint(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const {x, y, size, shape} = scales;
  // A 1D strip/dot plot (only one of x/y given) centers points on the
  // missing axis rather than requiring both; with neither given, every
  // point is centered on both (all overlapping) rather than refusing to
  // render at all.
  const cx = x ? binCenterAccessor(encoding, scales, 'x') ?? dodgeAwareAccessor(encoding, scales, 'x') : dims.centerXExpr;
  const cy = y ? binCenterAccessor(encoding, scales, 'y') ?? dodgeAwareAccessor(encoding, scales, 'y') : dims.centerYExpr;
  // `encoding.size` can be a real field (needs the shared `size` scale) or
  // a literal `{"value": ...}` (e.g. layer_ranged_dot.vl.json's own point
  // layer, `size: {"value": 100}`) -- the latter never gets a scale built
  // for it at all (nothing to scale), so it's converted with the exact
  // same area->radius formula the mark-level `markProps.size` fallback
  // uses just below, rather than silently falling all the way through to
  // that fallback (which only ever looks at *mark*-level `size`, with no
  // way to see an *encoding* channel's own literal value) and defaulting
  // to the generic radius-3 constant instead.
  const r =
    size && encoding.size && encoding.size.field
      ? `Math.sqrt(size(d[${JSON.stringify(encoding.size.field)}]) / Math.PI)`
      : encoding.size && 'value' in encoding.size
        ? formatValue(Math.sqrt(encoding.size.value / Math.PI))
        : formatValue(markProps.size ? Math.sqrt(simpleMarkProp(markProps.size, 9, 'size', ignoreUnsupported) / Math.PI) : 3) +
          markPropNote(markProps.size, 'size', ignoreUnsupported);
  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', DEFAULT_FILL), ignoreUnsupported);
  const opacity = opacityAttr(encoding, scales, ignoreUnsupported);
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];

  // A literal SVG path string (e.g. a custom star shape) has no simple
  // d3-shape equivalent -- rather than approximate it as some other symbol
  // (misleading), it's left to the plain-circle fallback below, same as
  // any other genuinely unsupported shape form.
  const constShapeName =
    encoding.shape && 'value' in encoding.shape && typeof encoding.shape.value === 'string' && encoding.shape.value in NAMED_SHAPE_SYMBOLS
      ? encoding.shape.value
      : null;

  if (encoding.shape && shape && shape.isRawPaths) {
    // A literal per-category SVG path (isotype_bar_chart.vl.json's own
    // pictograms) -- unlike the d3.symbol() case below, this *is* already
    // a real `d` attribute value, just scaled up from its own small
    // (roughly -2..2 unit) coordinate space; `r / 3` is a rough visual
    // match to that d3.symbol() branch's own pi*r^2-area sizing, not an
    // attempt at Vega-Lite's own exact custom-path scale factor.
    const symLines = [];
    symLines.push(`svg.append("g")`);
    if (!rowDependent) symLines.push(`  .attr("fill", ${fill})`);
    symLines.push(`  .attr("fill-opacity", ${markProps.filled === false ? 0 : 0.8})`);
    symLines.push(`  .selectAll("path")`);
    symLines.push(`  .data(${dataVar})`);
    symLines.push(`  .join("path")`);
    if (rowDependent) symLines.push(`    .attr("fill", d => ${fill})`);
    symLines.push(
      `    .attr("transform", d => "translate(" + (${cx}) + "," + (${cy}) + ") scale(" + (${r} / 3) + ")")`
    );
    symLines.push(`    .attr("d", d => shape(d[${JSON.stringify(encoding.shape.field)}]))`);
    if (opacity) symLines.push(`    .attr("opacity", d => ${opacity})`);
    appendTitle(symLines, '    ', encoding);
    return symLines.join('\n');
  }

  if ((encoding.shape && shape) || constShapeName) {
    // A distinct marker shape per category (not just a plain circle) --
    // SVG has no built-in "draw this shape" primitive, so this needs
    // d3-shape's own symbol *path* generator instead of a <circle>. Its
    // `.size()` is an area (px^2), not a radius, so it's derived from the
    // same `r` this mark would otherwise use as a circle's own radius
    // (pi*r^2), keeping the two visually comparable regardless of which
    // one a given row ends up using.
    const symbolVar = 'pointSymbol';
    const symLines = [];
    const symbolType = constShapeName
      ? NAMED_SHAPE_SYMBOLS[constShapeName]
      : `d => shape(d[${JSON.stringify(encoding.shape.field)}])`;
    symLines.push(`const ${symbolVar} = d3.symbol().type(${symbolType}).size(d => Math.PI * Math.pow(${r}, 2));`);
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
  // Whichever of color/detail actually has a real field, not just
  // whichever is truthy -- a literal `color: {"value": ...}` (e.g.
  // layer_ranged_dot.vl.json's own line layer, colored by a fixed literal
  // but still split into one line per `detail: {"field": "country"}`) is
  // just as truthy as a real field-bound channel, and `color || detail`
  // would pick it first, finding no `.field` on it and treating the whole
  // series as one single ungrouped line instead.
  const detail = (encoding.color && encoding.color.field ? encoding.color : null) || encoding.detail;
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
  // dodgeAwareAccessor(), not the bare accessor() -- a line/detail-grouped
  // series against a nominal/ordinal companion axis (e.g.
  // layer_ranged_dot.vl.json's own `y: {field: "country"}` band scale,
  // shared with a sibling point layer that already centers itself via this
  // same helper) needs to land on the *center* of its band, not the raw
  // band-start edge d3.scaleBand() itself returns -- otherwise the line
  // and the marks it's meant to connect end up visibly offset from each
  // other vertically.
  const cx = x ? dodgeAwareAccessor(encoding, scales, 'x') : dims.centerXExpr;
  const cy = y ? dodgeAwareAccessor(encoding, scales, 'y') : dims.centerYExpr;
  const sortField = x ? encoding.x.field : encoding.y.field;
  const groupField = seriesGroupField(encoding);
  // The row-drop filter for x/y is deliberately skipped upstream for a
  // "line" mark (see pathContinuityChannels(), translator.js) -- an
  // invalid row is still IN `dataVar` here, and needs this `.defined()`
  // clause so d3.line() breaks the path there instead of interpolating
  // straight through a `NaN` coordinate (or, worse, silently reconnecting
  // across the gap the way filtering the row out entirely would).
  const definedClause = positionDefinedClause(encoding, ['x', 'y']);
  const curve = curveClause(markProps, ignoreUnsupported);
  const lines = [];

  if (groupField) {
    // A real `color` field (as opposed to a fixed `encoding.color.value`,
    // e.g. layer_ranged_dot.vl.json's own line layer -- colored by a
    // literal but still split into one line per `detail: {"field":
    // "country"}`, see seriesGroupField()) uses the shared `color` scale,
    // keyed by this group's own key; a literal color value is used
    // directly instead of falling through to markColorFallback()'s
    // mark-property-only check, which has no way to see an *encoding*
    // channel's own literal value at all.
    const stroke =
      encoding.color && encoding.color.field
        ? 'color(key)'
        : encoding.color && 'value' in encoding.color
          ? formatValue(encoding.color.value)
          : JSON.stringify(markColorFallback(markProps, 'stroke', DEFAULT_STROKE));
    lines.push(`svg.append("g")`);
    lines.push(`    .attr("fill", "none")`);
    lines.push(`    .attr("stroke-width", ${formatValue(simpleMarkProp(markProps.strokeWidth, 1.5, 'strokeWidth', ignoreUnsupported))}${markPropNote(markProps.strokeWidth, 'strokeWidth', ignoreUnsupported)})`);
    lines.push(`  .selectAll("path")`);
    lines.push(`  .data(d3.group(${dataVar}, d => d[${JSON.stringify(groupField)}]))`);
    lines.push(`  .join("path")`);
    lines.push(`    .attr("stroke", ([key]) => ${stroke})`);
    lines.push(
      `    .attr("d", ([, rows]) => d3.line()${definedClause}${curve}.x(d => ${cx}).y(d => ${cy})` +
        `(rows.slice().sort((a, b) => d3.ascending(a[${JSON.stringify(sortField)}], b[${JSON.stringify(sortField)}]))));`
    );
  } else {
    const stroke = JSON.stringify(markColorFallback(markProps, 'stroke', DEFAULT_STROKE));
    lines.push(`svg.append("path")`);
    lines.push(`    .attr("fill", "none")`);
    lines.push(`    .attr("stroke", ${stroke})`);
    lines.push(`    .attr("stroke-width", ${formatValue(simpleMarkProp(markProps.strokeWidth, 1.5, 'strokeWidth', ignoreUnsupported))}${markPropNote(markProps.strokeWidth, 'strokeWidth', ignoreUnsupported)})`);
    lines.push(
      `    .attr("d", d3.line()${definedClause}${curve}.x(d => ${cx}).y(d => ${cy})` +
        `(${dataVar}.slice().sort((a, b) => d3.ascending(a[${JSON.stringify(sortField)}], b[${JSON.stringify(sortField)}]))));`
    );
  }
  return singleAxisNote + lines.join('\n');
}

// A `.defined(d => ...)` clause (with a leading "." so it splices directly
// into a d3.line()/d3.area() chain) checking every one of `channels`' own
// source fields for null/NaN -- "" (no clause at all) when none of them
// have a plain field reference to check (e.g. every position channel here
// is a literal `value`, never invalid). Mirrors renderInvalidFilter()'s own
// condition shape (translator.js) exactly, since this is checking for the
// precise rows that filter deliberately left in `dataVar` instead of
// dropping outright, for this mark's own x/y (or x/y/x2/y2) fields only.
// Vega-Lite's `interpolate` mark property -> the equivalent d3-shape curve
// factory. "monotone"/"basis"/"cardinal" each have separate X- and
// Y-oriented d3 variants (curveMonotoneX vs curveMonotoneY, ...) -- this
// project always draws along a horizontal-ish x axis (renderArea() itself
// picks x as the "along" axis unless the chart is explicitly flipped, see
// its own `horizontal` check), so the X variant is used uniformly rather
// than threading orientation through here too; a spec that flips a line
// mark's own along-axis to y is rare enough not to warrant it.
const CURVE_FOR_INTERPOLATE = {
  linear: 'curveLinear',
  'linear-closed': 'curveLinearClosed',
  step: 'curveStep',
  'step-before': 'curveStepBefore',
  'step-after': 'curveStepAfter',
  basis: 'curveBasis',
  'basis-open': 'curveBasisOpen',
  'basis-closed': 'curveBasisClosed',
  cardinal: 'curveCardinal',
  'cardinal-open': 'curveCardinalOpen',
  'cardinal-closed': 'curveCardinalClosed',
  bundle: 'curveBundle',
  monotone: 'curveMonotoneX',
  natural: 'curveNatural',
};

// A `.curve(d3.curveXxx)` clause (leading "." so it splices directly into
// a d3.line()/d3.area() chain) for `markProps.interpolate`, or "" (d3's own
// default curveLinear) when absent/unrecognized/not a literal.
function curveClause(markProps, ignoreUnsupported = false) {
  const interpolate = simpleMarkProp(markProps.interpolate, undefined, 'interpolate', ignoreUnsupported);
  const curve = interpolate && CURVE_FOR_INTERPOLATE[interpolate];
  return curve ? `.curve(d3.${curve})` : '';
}

function positionDefinedClause(encoding, channels) {
  const conds = channels
    .map(ch => encoding[ch])
    .filter(def => def && def.field)
    .map(def => `d[${JSON.stringify(def.field)}] != null && !Number.isNaN(d[${JSON.stringify(def.field)}])`);
  return conds.length ? `.defined(d => ${conds.join(' && ')})` : '';
}

function renderArea(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false) {
  const {x, y} = scales;
  if ((!x || !y) && !ignoreUnsupported) throw new Error('"area" mark requires both x and y encodings');
  if (!x && !y) return SKIP_COMMENT('"area" mark has neither x nor y encoding');
  const singleAxisNote = !x || !y ? `// vl2d3: "area" mark missing ${!x ? 'x' : 'y'} encoding, centering on that axis instead (--ignore-unsupported)\n` : '';

  // Vega-Lite orients an area by which axis is the *value* one -- almost
  // always y (the standard chart, baseline-to-value running vertically),
  // but flipped to x whenever x is quantitative and y is not (e.g.
  // area_vertical.vl.json's own shape: a temporal/ordinal "along" axis on
  // y instead of the usual x, baseline-to-value running horizontally).
  const xIsValue = encoding.x && encoding.x.type === 'quantitative';
  const yIsValue = encoding.y && encoding.y.type === 'quantitative';
  const horizontal = xIsValue && !yIsValue;
  const alongChannel = horizontal ? 'y' : 'x';
  const valueChannel = horizontal ? 'x' : 'y';
  const alongScale = scales[alongChannel];
  const valueScale = scales[valueChannel];
  const alongFallback = alongChannel === 'x' ? dims.centerXExpr : dims.centerYExpr;
  const valueFallback = valueChannel === 'x' ? dims.centerXExpr : dims.centerYExpr;

  const alongPos = alongScale ? accessor(encoding[alongChannel], scales, alongChannel, 'undefined', ignoreUnsupported) : alongFallback;
  const valueTop = valueScale ? accessor(encoding[valueChannel], scales, valueChannel, 'undefined', ignoreUnsupported) : valueFallback;
  // The baseline (`y2`/`x2`, whichever is the value channel's own
  // companion): a plain field reference is the common case, but it can
  // also be a literal `datum` (e.g. area_overlay_with_y2.vl.json's
  // `"y2": {"datum": 0}`) -- previously read only `.field`, silently
  // producing `d[undefined]` (NaN) for the datum form and never actually
  // reaching the zero baseline.
  const value2Def = encoding[`${valueChannel}2`];
  const valueBase = value2Def
    ? value2Def.field
      ? `${valueChannel}(d[${JSON.stringify(value2Def.field)}])`
      : value2Def.datum !== undefined
        ? `${valueChannel}(${formatValue(value2Def.datum)})`
        : `${valueChannel}(0)`
    : valueScale
      ? `${valueChannel}(0)`
      : valueFallback;

  const groupField = seriesGroupField(encoding);
  const sortField = encoding[alongChannel] ? encoding[alongChannel].field : encoding[valueChannel].field;
  const sortFieldJson = JSON.stringify(sortField);
  const lines = [];
  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', DEFAULT_FILL), ignoreUnsupported);

  // Same reasoning as renderLine()'s own `definedClause` -- x2/y2's own
  // field (not a fixed `datum`/implicit-0 baseline, which is never
  // invalid) is included too, since a broken baseline is just as much a
  // path gap as a broken top edge.
  const definedClause = positionDefinedClause(encoding, [alongChannel, valueChannel, `${valueChannel}2`]);
  const curve = curveClause(markProps, ignoreUnsupported);
  const areaCall = horizontal
    ? `d3.area()${definedClause}${curve}.y(d => ${alongPos}).x0(d => ${valueBase}).x1(d => ${valueTop})`
    : `d3.area()${definedClause}${curve}.x(d => ${alongPos}).y0(d => ${valueBase}).y1(d => ${valueTop})`;

  if (groupField) {
    lines.push(`svg.append("g")`);
    lines.push(`    .attr("fill-opacity", 0.7)`);
    lines.push(`  .selectAll("path")`);
    lines.push(`  .data(d3.group(${dataVar}, d => d[${JSON.stringify(groupField)}]))`);
    lines.push(`  .join("path")`);
    lines.push(`    .attr("fill", ([key]) => ${encoding.color && encoding.color.field ? 'color(key)' : fill})`);
    lines.push(
      `    .attr("d", ([, rows]) => ${areaCall}` +
        `(rows.slice().sort((a, b) => d3.ascending(a[${sortFieldJson}], b[${sortFieldJson}]))));`
    );
  } else {
    lines.push(`svg.append("path")`);
    lines.push(`    .attr("fill", ${fill})`);
    lines.push(
      `    .attr("d", ${areaCall}` +
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

// A channel definition merged down from a layer/facet wrapper's own shared
// encoding (mergeDown(), translator.js) can be a plain truthy object with
// no actual content at all -- e.g. wheat_wages.vl.json's own wrapper-level
// `y: {type: "quantitative", axis: {...}}`, inherited into a `rule` layer
// that only ever declares its own `x` -- so a bare `encoding.y` truthiness
// check alone can't tell "this channel is genuinely being used" apart from
// "this channel merely inherited the wrapper's type/axis/scale metadata,
// with nothing this mark could actually draw from". Only a real `field`/
// `datum`/`value` makes a channel meaningful for rule's own x-vs-y-vs-both
// shape dispatch below.
function hasChannelContent(def) {
  return Boolean(def) && (def.field !== undefined || def.datum !== undefined || 'value' in def);
}

function renderRule(encoding, scales, dims, dataVar, markProps, ignoreUnsupported = false, extentParams = {}) {
  const {x, y} = scales;
  const hasX = hasChannelContent(encoding.x);
  const hasY = hasChannelContent(encoding.y);
  const stroke = fillExpr(encoding, scales, markColorFallback(markProps, 'stroke', 'black'), ignoreUnsupported);
  const rowDependent = hasRowDependentColor(encoding);
  const lines = [];
  lines.push(`svg.append("g")`);
  if (!rowDependent) lines.push(`    .attr("stroke", ${stroke})`);
  lines.push(`  .selectAll("line")`);
  lines.push(`  .data(${dataVar})`);
  lines.push(`  .join("line")`);
  if (rowDependent) lines.push(`    .attr("stroke", d => ${stroke})`);
  if (hasX && encoding.x2) {
    lines.push(`    .attr("x1", d => x(d[${JSON.stringify(encoding.x.field)}]))`);
    lines.push(`    .attr("x2", d => x(d[${JSON.stringify(encoding.x2.field)}]))`);
    lines.push(`    .attr("y1", d => ${hasY ? dodgeAwareAccessor(encoding, scales, 'y') : dims.marginTopExpr})`);
    lines.push(`    .attr("y2", d => ${hasY ? dodgeAwareAccessor(encoding, scales, 'y') : dims.heightMinusBottomExpr})`);
  } else if (hasY && encoding.y2) {
    lines.push(`    .attr("y1", d => y(d[${JSON.stringify(encoding.y.field)}]))`);
    lines.push(`    .attr("y2", d => y(d[${JSON.stringify(encoding.y2.field)}]))`);
    lines.push(`    .attr("x1", d => ${hasX ? dodgeAwareAccessor(encoding, scales, 'x') : dims.marginLeftExpr})`);
    lines.push(`    .attr("x2", d => ${hasX ? dodgeAwareAccessor(encoding, scales, 'x') : dims.widthMinusRightExpr})`);
  } else if (hasX && !hasY) {
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
  } else if (hasY && !hasX) {
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
  const stroke = fillExpr(encoding, scales, markColorFallback(markProps, 'stroke', 'black'), ignoreUnsupported);
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
  // Half-length used along an axis with no scale at all (1D strip plots) --
  // an explicit numeric `mark.size` (already resolved from any static-param
  // expr, translator.js's resolveMarkPropExprs()) overrides the arbitrary
  // 10px default, matching bar_bullet_expr_bind.vl.json's own tick layer.
  const TICK_HALF = typeof markProps.size === 'number' ? markProps.size / 2 : 10;

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
  // hasChannelContent (not bare truthiness): a layer/facet wrapper's own
  // shared `x`/`y` (type/scale/axis, no field) can merge down into a text
  // layer that never declares that channel itself (e.g.
  // bar_layered_weather.vl.json's own day-label layer, encoding = `{text:
  // {field: "day"}}` only) -- a bare-truthy check would treat that
  // leftover wrapper metadata as "this channel has real content",
  // producing `d[undefined]` instead of falling through to the mark-level
  // `y: -5`-style literal pixel constant below (Vega-Lite's own "no
  // encoding, just a fixed mark position" shorthand) or the centered
  // fallback.
  const cx = hasChannelContent(encoding.x)
    ? dodgeAwareAccessor(encoding, scales, 'x')
    : typeof markProps.x === 'number'
      ? formatValue(markProps.x)
      : dims.centerXExpr;
  const cy = hasChannelContent(encoding.y)
    ? dodgeAwareAccessor(encoding, scales, 'y')
    : typeof markProps.y === 'number'
      ? formatValue(markProps.y)
      : dims.centerYExpr;
  const textField = encoding.text
    ? rawField(encoding.text) || formatValue(encoding.text.value)
    : formatValue(Array.isArray(markProps.text) ? markProps.text.join('\n') : markProps.text);
  const fill = fillExpr(encoding, scales, markColorFallback(markProps, 'fill', 'black'), ignoreUnsupported);
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
  // A *binned* theta (e.g. arc_radial_histogram.vl.json's own `theta:
  // {"bin": true, "field": "IMDB Rating"}`, prepare.js already having
  // rewritten this into a real `theta`/`theta2` bin-edge pair the same way
  // it does for a bar's own x/x2) is a genuine angular *range* per row, not
  // a value for d3.pie() to auto-partition into 360 degrees' worth of
  // proportional slices -- that's a fundamentally different shape (equal
  // angular slots sized by count/theta-*value*) from this one (each row's
  // own angular position/width fixed by where its bin edges fall along the
  // theta *domain*, count encoded via radius instead). Built directly via
  // d3.arc()'s own startAngle/endAngle accessors instead of through
  // d3.pie() at all -- an explicit linear angle scale maps the full
  // bin-edge domain onto one full turn (0 to 2*PI).
  if (encoding.theta2) {
    const theta0Field = encoding.theta.field;
    const theta1Field = encoding.theta2.field;
    const fill = encoding.color && encoding.color.field ? `d => color(d[${JSON.stringify(encoding.color.field)}])` : `() => ${JSON.stringify(DEFAULT_FILL)}`;
    const outerRadiusExpr =
      scales.radius && encoding.radius && encoding.radius.field ? `d => radius(d[${JSON.stringify(encoding.radius.field)}])` : 'plotRadius';
    const lines = [];
    lines.push(`{`);
    lines.push(`  const plotRadius = Math.min(${dims.innerWidthExpr}, ${dims.innerHeightExpr}) / 2;`);
    lines.push(
      `  const angle = d3.scaleLinear([d3.min(${dataVar}, d => d[${JSON.stringify(theta0Field)}]), d3.max(${dataVar}, d => d[${JSON.stringify(theta1Field)}])], [0, 2 * Math.PI]);`
    );
    lines.push(
      `  const arcGen = d3.arc().innerRadius(0).outerRadius(${outerRadiusExpr}).startAngle(d => angle(d[${JSON.stringify(theta0Field)}])).endAngle(d => angle(d[${JSON.stringify(theta1Field)}]));`
    );
    lines.push(`  svg.append("g")`);
    lines.push(`      .attr("transform", \`translate(\${${dims.centerXExpr}},\${${dims.centerYExpr}})\`)`);
    lines.push(`    .selectAll("path")`);
    lines.push(`    .data(${dataVar})`);
    lines.push(`    .join("path")`);
    lines.push(`      .attr("d", arcGen)`);
    lines.push(`      .attr("fill", ${fill});`);
    lines.push(`}`);
    return lines.join('\n');
  }
  // An ordinal/nominal theta (e.g. arc_ordinal_theta.vl.json's own
  // `theta: {"field": "dir", "type": "ordinal"}`, a wind-rose chart) means
  // "one equal-angle slot per category", exactly like having no theta
  // value to size wedges by at all -- its own raw field value (a
  // direction NAME, not a number) is meaningless as d3.pie()'s own numeric
  // `.value()`, and previously produced NaN angles (every wedge collapsing
  // to zero size, drawing nothing). Only a genuinely quantitative theta
  // sizes wedges by its own value.
  const thetaIsQuantitative = encoding.theta && encoding.theta.type === 'quantitative';
  const pieValue =
    encoding.theta && thetaIsQuantitative
      ? `d => d[${JSON.stringify(encoding.theta.field)}]`
      : '() => 1' +
        (encoding.theta
          ? ' /* vl2d3: non-quantitative theta, using equal-sized slices */'
          : ' /* vl2d3: no theta encoding, using equal-sized slices (--ignore-unsupported) */');
  const fill = encoding.color && encoding.color.field ? `d => color(d.data[${JSON.stringify(encoding.color.field)}])` : `() => ${JSON.stringify(DEFAULT_FILL)}`;
  const lines = [];
  lines.push(`{`);
  // `plotRadius`, not `radius` -- the shared `radius` *scale* (when a
  // `radius` encoding channel resolved one, resolveRadiusScale() in
  // scales.js) is already declared under that exact name one scope out;
  // shadowing it with a same-named local here would make
  // `outerRadiusExpr`'s own `radius(d.data[field])` call try to invoke
  // this plain number as a function instead.
  lines.push(`  const plotRadius = Math.min(${dims.innerWidthExpr}, ${dims.innerHeightExpr}) / 2;`);
  lines.push(`  const pie = d3.pie().value(${pieValue}).sort(null);`);
  // `radius` encoding (e.g. arc_ordinal_theta.vl.json's own
  // `radius: {"field": "strength", "type": "quantitative"}`) varies each
  // wedge's own outer radius by its value via the shared `radius` scale
  // instead of every wedge sharing the mark's own full plot radius --
  // unlike theta (which d3.pie() itself reads directly off each datum),
  // d3.arc()'s outerRadius needs a plain per-datum accessor function.
  const outerRadiusExpr = scales.radius && encoding.radius && encoding.radius.field ? `d => radius(d.data[${JSON.stringify(encoding.radius.field)}])` : 'plotRadius';
  lines.push(`  const arcGen = d3.arc().innerRadius(0).outerRadius(${outerRadiusExpr});`);
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
