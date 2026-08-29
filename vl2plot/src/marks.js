// Per-mark Observable Plot codegen: `Plot.<fn>(<dataVar>, <options>)`, with
// `<options>` optionally wrapped in a `Plot.binX`/`groupX`/`stackY`/etc.
// transform (see `prepare.js`/`stack.js`) -- unlike every other sibling's
// own marks.* module, this one builds a plain JS *options object* per mark
// (Plot itself does all the actual scale/legend/axis work), so most of this
// module is "which VL channel maps to which Plot channel name for this
// mark type," not real drawing logic.

import {formatValue} from './literals.js';
import {channelValue, effectiveType, isQuantitative, hasField} from './encoding.js';
import {applyTimeUnits, planTransform} from './prepare.js';
import {planStack} from './stack.js';

// A channel value ready to splice into a Plot options object -- a bare
// field-name/literal expression already rendered as JS source by
// `channelValue()`, or `undefined` (omit the key entirely) when the VL
// channel is absent.
function val(def) {
  const v = channelValue(def);
  return v === null ? undefined : v;
}

// Assembles `{key: valueCode, ...}` pairs (skipping any `undefined` value)
// into Plot options-object JS source.
function objectSource(pairs, indent = 2) {
  const entries = pairs.filter(([, v]) => v !== undefined);
  if (!entries.length) return '{}';
  const pad = '  '.repeat(indent);
  const closePad = '  '.repeat(indent - 1);
  const lines = entries.map(([k, v]) => `${pad}${k}: ${v},`);
  return `{\n${lines.join('\n')}\n${closePad}}`;
}

// VL's plain `color` channel maps to a different Plot channel name
// depending on mark type -- `stroke` for line-like marks (the mark has no
// fill at all), `fill` for area-like ones. `point` specifically defaults to
// an unfilled ring (`stroke`) unless `mark.filled` is explicitly `true`,
// matching Vega-Lite's own default; `circle`/`square` are always filled.
function colorChannelName(markType, markProps) {
  if (markType === 'line' || markType === 'rule' || markType === 'tick') return 'stroke';
  if (markType === 'point') return markProps.filled ? 'fill' : 'stroke';
  return 'fill';
}

function orientation(encoding) {
  const x = encoding.x || {};
  const y = encoding.y || {};
  return isQuantitative(x) && !isQuantitative(y) ? 'horizontal' : 'vertical';
}

// Wraps `optionsSrc` (already-rendered JS source for the mark's own options
// object) in this mark's own bin/group transform (from `prepare.js`) and/or
// implicit stack transform (from `stack.js`), innermost (bin/group) first
// -- matches the composition order verified empirically (`Plot.stackY(Plot.
// groupX(outputs, options))`).
function wrapTransforms(optionsSrc, transformPlan, stackPlan) {
  let src = optionsSrc;
  if (transformPlan) {
    src = `Plot.${transformPlan.fn}(${formatValue(transformPlan.outputs)}, ${src})`;
  }
  if (stackPlan) {
    src = stackPlan.offset
      ? `Plot.${stackPlan.fn}(${formatValue({offset: stackPlan.offset})}, ${src})`
      : `Plot.${stackPlan.fn}(${src})`;
  }
  return src;
}

// Shared per-mark preamble: timeUnit derivation (data statements + a
// rewritten encoding with plain field names only) and orientation.
function prepareMark(encoding, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc} = applyTimeUnits(encoding, dataVar, ignoreUnsupported);
  return {statements, encoding: enc, orient: orientation(enc)};
}

function commonChannels(encoding, markType, markProps) {
  const colorDef = encoding.color || encoding.fill || encoding.stroke;
  const colorCh = colorChannelName(markType, markProps);
  const tooltipDef = Array.isArray(encoding.tooltip) ? encoding.tooltip[0] : encoding.tooltip;
  return [
    [colorCh, val(colorDef)],
    ['opacity', val(encoding.opacity)],
    ['z', val(encoding.detail)],
    ['title', val(tooltipDef)],
  ];
}

function renderDot(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const markType = markProps.type;
  const shapeDef = encoding.shape;
  const pairs = [
    ['x', val(enc.x)],
    ['y', val(enc.y)],
    ...commonChannels(enc, markType, markProps),
    ['r', val(enc.size)],
    ['symbol', val(shapeDef)],
  ];
  const transformPlan = planTransform(enc, ignoreUnsupported);
  const optionsSrc = objectSource(pairs);
  const wrapped = wrapTransforms(optionsSrc, transformPlan, null);
  return {statements, markExpr: `Plot.dot(${dataVar}, ${wrapped})`};
}

function renderBar(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc, orient} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const valueCh = orient === 'horizontal' ? 'x' : 'y';
  const catCh = orient === 'horizontal' ? 'y' : 'x';
  const catCompanionCh = `${catCh}2`;
  const valueCompanionCh = `${valueCh}2`;
  // A companion on the *category* channel itself (e.g. `x`/`x2` on a
  // vertical bar) means the category axis is really a continuous bin
  // interval (a histogram over pre-computed bin edges), not an ordinal
  // band -- Plot's own equivalent is `x1`/`x2` (a genuine interval),
  // distinct from the ordinary `x`/`x2` companion pair. A companion on the
  // *value* channel (e.g. `y`/`y2` on a vertical bar) instead means an
  // explicit value range (a floating bar from an explicit lo to hi).
  const hasCatCompanion = hasField(enc[catCompanionCh]) || (enc[catCompanionCh] && 'value' in enc[catCompanionCh]);
  const pairs = hasCatCompanion
    ? [
        [`${catCh}1`, val(enc[catCh])],
        [catCompanionCh, val(enc[catCompanionCh])],
        [valueCh, val(enc[valueCh])],
        ...commonChannels(enc, 'bar', markProps),
      ]
    : [
        [catCh, val(enc[catCh])],
        [valueCh, val(enc[valueCh])],
        [valueCompanionCh, val(enc[valueCompanionCh])],
        ...commonChannels(enc, 'bar', markProps),
      ];
  const transformPlan = planTransform(enc, ignoreUnsupported);
  // Plot's `groupX`/`groupY` transforms always treat their own axis as
  // ordinal/band, even when the grouping keys happen to be numbers -- that
  // conflicts outright with a continuous bin-interval category axis
  // (`x1`/`x2` above), which needs a real continuous (here `log`) scale.
  // No native Plot transform covers "pre-aggregate a count per continuous
  // bin" cleanly, so this specific combination is a documented v1 gap
  // rather than a silent (and wrong) scale-conflict crash.
  if (hasCatCompanion && transformPlan) {
    if (ignoreUnsupported) {
      return {statements, markExpr: null};
    }
    throw new Error('Unsupported: an aggregated value on a bar with a continuous bin-interval category axis is not yet supported by vl2plot');
  }
  const stackPlan = planStack('bar', enc, orient);
  const optionsSrc = objectSource(pairs);
  const wrapped = wrapTransforms(optionsSrc, transformPlan, stackPlan);
  const fn = orient === 'horizontal' ? 'barX' : 'barY';
  return {statements, markExpr: `Plot.${fn}(${dataVar}, ${wrapped})`};
}

function renderLineOrArea(isArea) {
  return function render(encoding, markProps, dataVar, ignoreUnsupported) {
    const {statements, encoding: enc, orient} = prepareMark(encoding, dataVar, ignoreUnsupported);
    const domainCh = orient === 'horizontal' ? 'y' : 'x';
    const valueCh = orient === 'horizontal' ? 'x' : 'y';
    const companionCh = `${valueCh}2`;
    const orderField = hasField(encoding.order) ? encoding.order.field : (hasField(enc[domainCh]) ? enc[domainCh].field : null);
    const pairs = [
      [domainCh, val(enc[domainCh])],
      isArea && enc[companionCh] ? [`${valueCh}1`, val(enc[companionCh])] : null,
      isArea && enc[companionCh] ? [`${valueCh}2`, val(enc[valueCh])] : [valueCh, val(enc[valueCh])],
      ...commonChannels(enc, isArea ? 'area' : 'line', markProps),
      !isArea ? ['strokeWidth', val(enc.size)] : null,
      orderField ? ['sort', formatValue(orderField)] : null,
    ].filter(Boolean);
    const stackPlan = planStack(isArea ? 'area' : 'line', enc, orient);
    const optionsSrc = objectSource(pairs);
    const wrapped = wrapTransforms(optionsSrc, null, stackPlan);
    const fn = isArea ? (orient === 'horizontal' ? 'areaX' : 'areaY') : 'line';
    return {statements, markExpr: `Plot.${fn}(${dataVar}, ${wrapped})`};
  };
}

function renderRule(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc} = prepareMark(encoding, dataVar, ignoreUnsupported);
  // A rule spans the *entire* opposite axis unless a companion x2/y2 gives
  // it a finite extent (matching Vega-Lite's own rule semantics): a rule
  // with only `x` given draws a full-height vertical line at that x;
  // with both x/x2 (or y/y2) it's a finite horizontal/vertical segment.
  const hasX = hasField(enc.x) || (enc.x && 'value' in enc.x);
  const hasY = hasField(enc.y) || (enc.y && 'value' in enc.y);
  const fn = hasY && !hasX ? 'ruleY' : 'ruleX';
  const primaryCh = fn === 'ruleY' ? 'y' : 'x';
  const otherCh = primaryCh === 'x' ? 'y' : 'x';
  const otherCompanionCh = `${otherCh}2`;
  const pairs = [
    [primaryCh, val(enc[primaryCh])],
    [otherCh, val(enc[otherCh])],
    [otherCompanionCh, val(enc[otherCompanionCh])],
    ...commonChannels(enc, 'rule', markProps),
    ['strokeWidth', val(markProps.strokeWidth != null ? {value: markProps.strokeWidth} : encoding.size)],
  ];
  const transformPlan = planTransform(enc, ignoreUnsupported);
  const optionsSrc = objectSource(pairs);
  const wrapped = wrapTransforms(optionsSrc, transformPlan, null);
  return {statements, markExpr: `Plot.${fn}(${dataVar}, ${wrapped})`};
}

function renderTick(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc, orient} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const valueCh = orient === 'horizontal' ? 'x' : 'y';
  const catCh = valueCh === 'x' ? 'y' : 'x';
  const fn = valueCh === 'x' ? 'tickX' : 'tickY';
  const pairs = [
    [valueCh, val(enc[valueCh])],
    [catCh, val(enc[catCh])],
    ...commonChannels(enc, 'tick', markProps),
  ];
  const transformPlan = planTransform(enc, ignoreUnsupported);
  const optionsSrc = objectSource(pairs);
  const wrapped = wrapTransforms(optionsSrc, transformPlan, null);
  return {statements, markExpr: `Plot.${fn}(${dataVar}, ${wrapped})`};
}

function renderText(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const pairs = [
    ['x', val(enc.x)],
    ['y', val(enc.y)],
    ['text', val(enc.text)],
    ...commonChannels(enc, 'text', markProps),
  ];
  const transformPlan = planTransform(enc, ignoreUnsupported);
  const optionsSrc = objectSource(pairs);
  const wrapped = wrapTransforms(optionsSrc, transformPlan, null);
  return {statements, markExpr: `Plot.text(${dataVar}, ${wrapped})`};
}

function renderRect(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc} = prepareMark(encoding, dataVar, ignoreUnsupported);
  // Both axes ordinal, neither with a companion range (x2/y2) -- the
  // classic full-grid heatmap shape -- uses `Plot.cell` (one discrete cell
  // per (x, y) combination); anything with a real numeric span on either
  // axis uses `Plot.rect` (x1/x2/y1/y2 range rectangles, e.g. a binned
  // histogram-as-rect or a Gantt-style timeline).
  const isCell = !enc.x2 && !enc.y2 && effectiveType(enc.x) !== 'quantitative' && effectiveType(enc.y) !== 'quantitative';
  const pairs = isCell
    ? [
        ['x', val(enc.x)],
        ['y', val(enc.y)],
        ...commonChannels(enc, 'rect', markProps),
      ]
    : [
        enc.x2 ? ['x1', val(enc.x)] : ['x', val(enc.x)],
        enc.x2 ? ['x2', val(enc.x2)] : null,
        enc.y2 ? ['y1', val(enc.y)] : ['y', val(enc.y)],
        enc.y2 ? ['y2', val(enc.y2)] : null,
        ...commonChannels(enc, 'rect', markProps),
      ].filter(Boolean);
  const transformPlan = planTransform(enc, ignoreUnsupported);
  const optionsSrc = objectSource(pairs);
  const wrapped = wrapTransforms(optionsSrc, transformPlan, null);
  return {statements, markExpr: `Plot.${isCell ? 'cell' : 'rect'}(${dataVar}, ${wrapped})`};
}

function renderBoxplot(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc, orient} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const valueCh = orient === 'horizontal' ? 'x' : 'y';
  const catCh = valueCh === 'x' ? 'y' : 'x';
  const fn = valueCh === 'x' ? 'boxX' : 'boxY';
  const pairs = [
    [valueCh, val(enc[valueCh])],
    [catCh, val(enc[catCh])],
    ...commonChannels(enc, 'boxplot', markProps),
  ];
  const optionsSrc = objectSource(pairs);
  return {statements, markExpr: `Plot.${fn}(${dataVar}, ${optionsSrc})`};
}

const RENDERERS = {
  point: renderDot,
  circle: renderDot,
  square: renderDot,
  bar: renderBar,
  line: renderLineOrArea(false),
  area: renderLineOrArea(true),
  rule: renderRule,
  tick: renderTick,
  text: renderText,
  rect: renderRect,
  boxplot: renderBoxplot,
};

export function renderMark(mark, encoding, dataVar, ignoreUnsupported = false) {
  const markType = typeof mark === 'string' ? mark : mark.type;
  const markProps = typeof mark === 'string' ? {} : mark;
  const renderer = RENDERERS[markType];
  if (!renderer) {
    if (ignoreUnsupported) {
      return {statements: [`// vl2plot: unsupported mark type "${markType}", skipped (--ignore-unsupported)`], markExpr: null};
    }
    throw new Error(`Unsupported mark type: "${markType}"`);
  }
  return renderer(encoding, {...markProps, type: markType}, dataVar, ignoreUnsupported);
}
