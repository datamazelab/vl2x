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

// A fresh CSS class name per dodged bar mark needing a min-band-size
// fix-up (renderBar()'s own `postFixups`) -- only needs to be unique
// within one generated file's own output; an ever-incrementing counter
// across the whole process guarantees that trivially, with no reset
// needed between separate specToCode() calls.
let barFixupCounter = 0;

// A channel value ready to splice into a Plot options object -- a bare
// field-name/literal expression already rendered as JS source by
// `channelValue()`, or `undefined` (omit the key entirely) when the VL
// channel is absent.
function val(def) {
  const v = channelValue(def);
  return v === null ? undefined : v;
}

function isRealChannel(def) {
  return def && typeof def === 'object' && (typeof def.field === 'string' || 'value' in def || 'datum' in def);
}

// Vega-Lite's `xOffset`/`yOffset` (a "dodged"/grouped position -- a
// grouped bar chart's own sub-category, most commonly) has no native Plot
// position concept of its own. Plot's own documented recipe for a
// grouped bar chart repurposes its faceting system for exactly this
// instead (confirmed empirically): the outer category channel becomes
// `fx`/`fy` (one facet "strip" per category value, with near-zero padding
// so adjacent groups read as one combined axis rather than visually
// separate panels -- see `translator.js`'s own `collectScaleOptions()`,
// which adds that padding and hides the inner axis whenever it sees a
// real `xOffset`/`yOffset`), and the offset channel's own value becomes
// the real position *within* that facet strip. The offset channel is
// itself commonly a `datum` constant rather than a `field` (e.g.
// `bar_grouped_repeated.vl.json`'s own `repeat`-substituted layers, each
// drawing at its own fixed offset, side by side with its sibling layer's
// bars at a different one) -- `isRealChannel()` accepts either shape.
// Returns `[[catKey, catValue], subPair?]`, ready to splice in exactly
// where a plain `[catCh, val(enc[catCh])]` pair used to go
// unconditionally -- the second entry is present only when genuinely
// dodged.
function catChannelPairs(enc, catCh) {
  const offsetCh = `${catCh}Offset`;
  if (!isRealChannel(enc[offsetCh])) return [[catCh, val(enc[catCh])]];
  const facetCh = catCh === 'x' ? 'fx' : 'fy';
  return [
    [facetCh, val(enc[catCh])],
    [catCh, val(enc[offsetCh])],
  ];
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
  // A *binned* position channel with no companion channel at all is
  // Vega-Lite's implicit histogram shorthand (the missing channel becomes
  // `{"aggregate": "count"}`) -- always drawn with the bin edges on the
  // conventional distribution axis (x, vertical bars), regardless of which
  // single channel the spec actually wrote out -- unlike a plain (non-bin)
  // 1-dimensional aggregate summary (e.g. `bar_1d`'s "sum of a field"),
  // which Vega-Lite's own convention draws as a single *horizontal* bar
  // (the `isQuantitative(x) && !isQuantitative(y)` fallback below already
  // gets that case right).
  if (x.bin && !encoding.y) return 'vertical';
  if (y.bin && !encoding.x) return 'horizontal';
  return isQuantitative(x) && !isQuantitative(y) ? 'horizontal' : 'vertical';
}

// Splices `channel: 1,` in as the options object's own first entry --
// used only for `transformPlan.needsConstantKey` (see `prepare.js`): a
// genuinely 1-dimensional aggregate has no other channel for `groupX`/
// `groupY` to group by at all, and without one Plot silently falls back to
// each row's own array index as an implicit key (one "group" per row,
// not the single combined total Vega-Lite's own semantics call for) --
// giving every row the same constant value on the missing axis forces
// them into the one group intended here.
function injectConstantChannel(optionsSrc, channel, indent = 2) {
  const pad = '  '.repeat(indent);
  const line = `${pad}${channel}: 1,\n`;
  if (optionsSrc === '{}') return `{\n${line}${'  '.repeat(indent - 1)}}`;
  return optionsSrc.replace('{\n', `{\n${line}`);
}

// Per-row "styling" channels (as opposed to a real groupby identity like
// `color`/`fill`/`stroke`/`detail`) that have no single well-defined value
// once a `Plot.binX`/`groupX` transform has collapsed many rows into one --
// this project doesn't (yet) apply an explicit reducer to carry one through
// (matching VL's own real ambiguity here: a continuous, non-aggregated
// channel alongside an aggregate on a *different* channel has no single
// correct per-group value either). Left in as a raw per-row field
// reference, one of these breaks the *whole* group transform outright
// (confirmed empirically: `Plot.groupX({y: "sum"}, {x: "age", y: "people",
// opacity: "people"})` -- a real generated shape -- rendered zero shapes,
// not merely a wrong or missing opacity), since Plot's own group/bin
// transforms treat every extra field-valued channel as an *additional*
// implicit groupby key (see `prepare.js`'s own module docstring): with
// `opacity` varying per row, grouping (age, opacity) together made almost
// every row its own singleton group instead of one bar per age.
const UNGROUPABLE_STYLE_CHANNELS = new Set(['opacity', 'r', 'symbol', 'title']);

// Builds the mark's own options-object JS source from `pairs` and wraps it
// in this mark's own bin/group transform (from `prepare.js`) and/or
// implicit stack transform (from `stack.js`), innermost (bin/group) first
// -- matches the composition order verified empirically (`Plot.stackY(Plot.
// groupX(outputs, options))`).
function wrapTransforms(pairs, transformPlan, stackPlan, indent = 2) {
  const filteredPairs = transformPlan ? pairs.filter(([k]) => !UNGROUPABLE_STYLE_CHANNELS.has(k)) : pairs;
  let src = objectSource(filteredPairs, indent);
  if (transformPlan) {
    if (transformPlan.needsConstantKey) {
      src = injectConstantChannel(src, transformPlan.needsConstantKey, indent);
    }
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

// Vega-Lite's `sort: {"op": ..., "field": ..., "order": ...}` form (sort
// an ordinal position channel's own domain by an aggregate of some field,
// e.g. "put the tallest bar first") -- as opposed to the simpler `sort:
// "descending"` / an explicit array (handled in `scales.js`'s own scale-
// level `reverse`/`domain`). Maps onto Plot's own mark-level `sort:
// {[catCh]: "-otherCh"}` option (a leading "-" reverses), which can only
// reference an *already-encoded* channel name, not an arbitrary raw field
// -- so this only fires when the sort spec's own `field` is absent (an
// op like `"count"` needs none) or matches the value channel's own field,
// the overwhelmingly common real case ("sort by the bar's own value").
function sortMarkOption(encoding, catCh, valueCh) {
  const catDef = encoding[catCh];
  const sortSpec = catDef && typeof catDef === 'object' ? catDef.sort : null;
  if (!sortSpec || typeof sortSpec !== 'object' || Array.isArray(sortSpec)) return undefined;
  const valueDef = encoding[valueCh];
  const matchesValueChannel = !sortSpec.field || (valueDef && valueDef.field === sortSpec.field);
  if (!matchesValueChannel) return undefined;
  const sign = sortSpec.order === 'descending' ? '-' : '';
  return formatValue({[catCh]: `${sign}${valueCh}`});
}

function commonChannels(encoding, markType, markProps) {
  const colorDef = encoding.color || encoding.fill || encoding.stroke;
  const colorCh = colorChannelName(markType, markProps);
  const tooltipDef = Array.isArray(encoding.tooltip) ? encoding.tooltip[0] : encoding.tooltip;
  // A static `mark: {"color": "red", "opacity": 0.3}`-style property (as
  // opposed to a field/value *encoding* channel) sets every instance of
  // the mark to that one constant -- distinct from, and independent of,
  // any `encoding.color`/`encoding.opacity` (an encoding channel always
  // takes precedence when both are present, matching Vega-Lite's own
  // rule). Left unhandled entirely, a mark relying solely on its own
  // static style (a common real pattern -- no color/opacity *field* at
  // all) silently rendered with Plot's own default styling instead.
  const colorValue = val(colorDef) ?? (typeof markProps.color === 'string' ? formatValue(markProps.color) : undefined);
  const opacityValue = val(encoding.opacity) ?? (typeof markProps.opacity === 'number' ? formatValue(markProps.opacity) : undefined);
  // An explicit `fx`/`fy` channel on the mark itself, matching the facet
  // this mark's own view is nested inside (threaded down from
  // translateFacet() via renderMark()'s own `facetChannels` param, spliced
  // onto `markProps` as `__facetChannels`) -- NOT redundant with the
  // top-level `facet: {data, x, y}` option already set on the `Plot.plot()`
  // call. Plot auto-facets a mark whose own data is the exact same array
  // reference as `facet.data`, which normally makes this unnecessary, but
  // that heuristic turns out not to be robust for a STACKED mark once the
  // facet's own scale has an explicit, non-default-ordered `domain` (e.g.
  // a facet field's own `sort: [...]`, see translateFacet()'s own comment)
  // -- confirmed empirically to silently degenerate every facet's own
  // stack into a flat, zero-height shape otherwise. Always setting it
  // (not just when a reordering is actually present) costs nothing when
  // the domain isn't reordered -- confirmed to produce identical output
  // either way -- so it's unconditional rather than only kicking in for
  // the one case that exposed the bug.
  const facetChannels = markProps.__facetChannels;
  return [
    [colorCh, colorValue],
    ['opacity', opacityValue],
    ['z', val(encoding.detail)],
    ['title', val(tooltipDef)],
    ...(facetChannels && facetChannels.x ? [['fx', JSON.stringify(facetChannels.x)]] : []),
    ...(facetChannels && facetChannels.y ? [['fy', JSON.stringify(facetChannels.y)]] : []),
  ];
}

function renderDot(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const markType = markProps.type;
  const shapeDef = encoding.shape;
  // Vega-Lite's own `size` on a point/circle/square mark is always an
  // AREA (in square points), never a raw radius -- converted to a real
  // pixel radius via `sqrt(area / pi)` for a *field*-driven size too, but
  // that conversion happens through Plot's own `r` scale (a sqrt scale by
  // default, matching Plot's own area-correct convention for radius), so
  // `val(enc.size)` alone is already correct there. A *literal*
  // `size: {"value": N}` bypasses Plot's own scale machinery entirely,
  // though (a constant channel value is used as a raw pixel radius
  // as-is, Plot's own documented behavior for any visual channel given a
  // bare constant) -- so a literal size value needs this exact same
  // area-to-radius conversion applied by hand here instead, or it's
  // splices straight through as a literal PIXEL RADIUS instead of an
  // area (confirmed against vconcat_flatten.vl.json's own `size: {value:
  // 100}`: a 100px-radius circle -- gigantic -- instead of the ~5.6px
  // real Vega-Lite draws for the same area).
  const sizeValue = isRealChannel(enc.size) && enc.size.field ? val(enc.size) : 'value' in (enc.size || {}) ? formatValue(Math.sqrt(enc.size.value / Math.PI)) : val(enc.size);
  const pairs = [
    ...catChannelPairs(enc, 'x'),
    ...catChannelPairs(enc, 'y'),
    ...commonChannels(enc, markType, markProps),
    ['r', sizeValue],
    ['symbol', val(shapeDef)],
  ];
  const transformPlan = planTransform(enc, ignoreUnsupported);
  const wrapped = wrapTransforms(pairs, transformPlan, null);
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
        ...catChannelPairs(enc, catCh),
        [valueCh, val(enc[valueCh])],
        [valueCompanionCh, val(enc[valueCompanionCh])],
        ['sort', sortMarkOption(enc, catCh, valueCh)],
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
  const wrapped = wrapTransforms(pairs, transformPlan, stackPlan);
  const fn = orient === 'horizontal' ? 'barX' : 'barY';
  // A dodged/grouped bar's own sub-band (xOffset/yOffset, turned into a
  // real Plot `fx`/`fy` facet -- see catChannelPairs()) can end up so
  // narrow (many categories sharing little total width, e.g.
  // bar_grouped_thin.vl.json's own 551 directors in a 500px chart) that
  // Plot's own computed band width rounds all the way down to a literal
  // `width="0"` -- confirmed empirically, not merely "very thin." Real
  // Vega-Lite never lets this happen: `config.mark.minBandSize`/
  // `config.bar.minBandSize` (default 0.25px) clamps a bar's own band
  // size to always stay visible (confirmed against the real compiler's
  // own output: `"width": {"signal": "max(0.25, bandwidth('xOffset'))"}`).
  // Plot has no equivalent clamp of its own and no hook to apply one
  // *during* its own render, so this mark gets a unique `className` here
  // and the actual widening happens as a DOM fix-up immediately after the
  // enclosing `Plot.plot()` call returns (see buildPlotCallSource() in
  // translator.js, which wraps the whole call in an IIFE precisely so it
  // has a `node` reference to fix up before returning it) -- only when a
  // dodge is actually active on the category channel; an un-dodged bar's
  // own band is governed by the *facet*-level `x`/`y` scale directly
  // (already a real, visible band even at high cardinality, since it's
  // never split further by an offset scale) and was never observed to
  // collapse to zero the same way.
  const offsetCh = `${catCh}Offset`;
  if (isRealChannel(enc[offsetCh])) {
    const config = markProps.__config || {};
    const minSize = (config.bar && config.bar.minBandSize) ?? (config.mark && config.mark.minBandSize) ?? 0.25;
    const className = `vl2plotBar${++barFixupCounter}`;
    // `className` is threaded in as one of `pairs` (rather than spliced
    // onto the outer `wrapped` result via object-spread) so it survives a
    // `Plot.groupX`/`stackY`-wrapped mark too -- confirmed empirically
    // that Plot reads `className` off the mark's own PRE-transform
    // options object (whatever's passed as `Plot.groupX(outputs, HERE)`),
    // not off whatever a transform function's own return value happens to
    // carry; spreading over the transformed result silently dropped it
    // instead of erroring, the kind of bug easy to miss without directly
    // checking the rendered DOM (Plot applies `className` to the mark's
    // own enclosing `<g>`, not to each individual `<rect>`).
    const wrappedWithClass = wrapTransforms([...pairs, ['className', JSON.stringify(className)]], transformPlan, stackPlan);
    return {
      statements,
      markExpr: `Plot.${fn}(${dataVar}, ${wrappedWithClass})`,
      postFixups: [{className, dimension: orient === 'horizontal' ? 'height' : 'width', minSize}],
    };
  }
  return {statements, markExpr: `Plot.${fn}(${dataVar}, ${wrapped})`};
}

function renderLineOrArea(isArea) {
  return function render(encoding, markProps, dataVar, ignoreUnsupported) {
    const {statements, encoding: enc, orient} = prepareMark(encoding, dataVar, ignoreUnsupported);
    const domainCh = orient === 'horizontal' ? 'y' : 'x';
    const valueCh = orient === 'horizontal' ? 'x' : 'y';
    const companionCh = `${valueCh}2`;
    const orderField = hasField(encoding.order) ? encoding.order.field : (hasField(enc[domainCh]) ? enc[domainCh].field : null);
    // A static `mark: {"size": 3}` (VL's own line-width alias for a
    // "line" mark) or `{"strokeWidth": 3}` is this project's own
    // markProps fallback pattern (see `commonChannels()`'s own comment,
    // and `renderRule()`'s identical fallback below) -- an encoding-
    // channel `size` still takes precedence when present.
    const staticStrokeWidth = markProps.strokeWidth ?? markProps.size;
    const strokeWidthValue = val(enc.size) ?? (staticStrokeWidth != null ? formatValue(staticStrokeWidth) : undefined);
    const pairs = [
      [domainCh, val(enc[domainCh])],
      isArea && enc[companionCh] ? [`${valueCh}1`, val(enc[companionCh])] : null,
      isArea && enc[companionCh] ? [`${valueCh}2`, val(enc[valueCh])] : [valueCh, val(enc[valueCh])],
      ...commonChannels(enc, isArea ? 'area' : 'line', markProps),
      !isArea ? ['strokeWidth', strokeWidthValue] : null,
      orderField ? ['sort', formatValue(orderField)] : null,
    ].filter(Boolean);
    const stackPlan = planStack(isArea ? 'area' : 'line', enc, orient);
    const wrapped = wrapTransforms(pairs, null, stackPlan);
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
  const wrapped = wrapTransforms(pairs, transformPlan, null);
  return {statements, markExpr: `Plot.${fn}(${dataVar}, ${wrapped})`};
}

function renderTick(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc, orient} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const valueCh = orient === 'horizontal' ? 'x' : 'y';
  const catCh = valueCh === 'x' ? 'y' : 'x';
  const fn = valueCh === 'x' ? 'tickX' : 'tickY';
  const pairs = [
    [valueCh, val(enc[valueCh])],
    ...catChannelPairs(enc, catCh),
    ...commonChannels(enc, 'tick', markProps),
  ];
  const transformPlan = planTransform(enc, ignoreUnsupported);
  const wrapped = wrapTransforms(pairs, transformPlan, null);
  return {statements, markExpr: `Plot.${fn}(${dataVar}, ${wrapped})`};
}

function renderText(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc, orient} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const pairs = [
    ['x', val(enc.x)],
    ['y', val(enc.y)],
    ['text', val(enc.text)],
    ...commonChannels(enc, 'text', markProps),
  ];
  const transformPlan = planTransform(enc, ignoreUnsupported);
  // Unlike bar/area (auto-stacked whenever a color/detail group is
  // present, `stack.js`'s own "implicit" case), a text label only stacks
  // when the spec *explicitly* asks for it -- typically a value label
  // overlaid on an already-stacked bar/area, sharing its own stacked
  // position (e.g. `"x": {"aggregate": "sum", ..., "stack":
  // "normalize"}`) so the label lands within its own segment instead of
  // at the raw (unstacked) aggregate value on a totally different scale
  // (confirmed empirically: without this, the label mark's own un-stacked
  // "x" values leaked into the *shared* x-scale's domain, silently
  // shrinking the bar mark's own normalized-to-[0,1] bars to slivers).
  const stackPlan = planStack('text', enc, orient);
  const wrapped = wrapTransforms(pairs, transformPlan, stackPlan);
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
  const wrapped = wrapTransforms(pairs, transformPlan, null);
  return {statements, markExpr: `Plot.${isCell ? 'cell' : 'rect'}(${dataVar}, ${wrapped})`};
}

function renderBoxplot(encoding, markProps, dataVar, ignoreUnsupported) {
  const {statements, encoding: enc, orient} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const valueCh = orient === 'horizontal' ? 'x' : 'y';
  const catCh = valueCh === 'x' ? 'y' : 'x';
  const fn = valueCh === 'x' ? 'boxX' : 'boxY';
  const pairs = [
    [valueCh, val(enc[valueCh])],
    ...catChannelPairs(enc, catCh),
    ...commonChannels(enc, 'boxplot', markProps),
  ];
  const optionsSrc = objectSource(pairs);
  return {statements, markExpr: `Plot.${fn}(${dataVar}, ${optionsSrc})`};
}

// Plot has no native arc/pie mark at all -- `VlArc` (see `runtime.js`) is
// a real one built on `d3.pie()`/`d3.arc()`, wrapped as a genuine Plot
// `Mark` subclass so its own `fill` channel still gets Plot's shared
// color scale *and legend* for free. v1 scope: a plain quantitative
// `theta` (implicit stacking, matching Vega-Lite's own default for this
// mark) with `color` and an optional `tooltip`; `order` reorders the
// wedges (VL's own stacking order); `mark.innerRadius`/`outerRadius`
// (donut vs. pie) and an explicit `theta.scale.range` override (a
// truncated/rotated circle) both pass through directly. A *non*-
// quantitative `theta` (equal-sized wedges per category, a wind-rose-
// style chart) or a per-row-varying `radius` channel are real gaps, not
// attempted here -- both need genuine additional scale machinery this
// v1 doesn't have yet.
function renderArc(encoding, markProps, dataVar, ignoreUnsupported) {
  if (!hasField(encoding.theta)) {
    if (ignoreUnsupported) {
      return {statements: [`// vl2plot: unsupported arc mark without a theta encoding, skipped (--ignore-unsupported)`], markExpr: null};
    }
    throw new Error('Unsupported: an "arc" mark with no theta *encoding* channel (e.g. a mark-level theta bound to a param expression instead) is not yet supported by vl2plot');
  }
  if (hasField(encoding.radius)) {
    if (ignoreUnsupported) {
      return {statements: [`// vl2plot: unsupported arc mark with a per-row "radius" channel, skipped (--ignore-unsupported)`], markExpr: null};
    }
    throw new Error('Unsupported: an "arc" mark with its own "radius" channel is not yet supported by vl2plot');
  }
  const {statements, encoding: enc} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const orderField = hasField(enc.order) ? enc.order.field : null;
  const orderStatements = orderField
    ? [
        `${dataVar} = ${dataVar}.slice().sort((a, b) => ` +
          `(a[${JSON.stringify(orderField)}] < b[${JSON.stringify(orderField)}] ? -1 : a[${JSON.stringify(orderField)}] > b[${JSON.stringify(orderField)}] ? 1 : 0));`,
      ]
    : [];
  const colorDef = enc.color || enc.fill;
  const tooltipDef = Array.isArray(enc.tooltip) ? enc.tooltip[0] : enc.tooltip;
  const rangeOverride = enc.theta.scale && Array.isArray(enc.theta.scale.range) ? enc.theta.scale.range : null;
  const pairs = [
    ['theta', val(enc.theta)],
    colorDef ? ['fill', val(colorDef)] : null,
    tooltipDef ? ['title', val(tooltipDef)] : null,
    rangeOverride ? ['startAngle', formatValue(rangeOverride[0])] : null,
    rangeOverride ? ['endAngle', formatValue(rangeOverride[1])] : null,
    typeof markProps.innerRadius === 'number' ? ['innerRadius', formatValue(markProps.innerRadius)] : null,
    typeof markProps.outerRadius === 'number' ? ['outerRadius', formatValue(markProps.outerRadius)] : null,
  ].filter(Boolean);
  const optionsSrc = objectSource(pairs);
  return {statements: [...statements, ...orderStatements], markExpr: `new VlArc(${dataVar}, ${optionsSrc})`};
}

// Plot has no built-in mark with a *variable*-width line at all (an SVG
// `<path stroke-width>` is one constant for the whole path) -- `VlTrail`
// (`runtime.js`) is a real one, building the actual tapered-ribbon polygon
// directly rather than approximating it with a constant-width line.
function renderTrail(encoding, markProps, dataVar, ignoreUnsupported) {
  if (!hasField(encoding.x) || !hasField(encoding.y)) {
    if (ignoreUnsupported) {
      return {statements: [`// vl2plot: unsupported trail mark without both x and y field encodings, skipped (--ignore-unsupported)`], markExpr: null};
    }
    throw new Error('"trail" mark requires both x and y field encodings');
  }
  const {statements, encoding: enc} = prepareMark(encoding, dataVar, ignoreUnsupported);
  const colorDef = enc.color || enc.stroke;
  const tooltipDef = Array.isArray(enc.tooltip) ? enc.tooltip[0] : enc.tooltip;
  const pairs = [
    ['x', val(enc.x)],
    ['y', val(enc.y)],
    ['size', val(enc.size)],
    colorDef ? ['stroke', val(colorDef)] : null,
    tooltipDef ? ['title', val(tooltipDef)] : null,
  ].filter(Boolean);
  const optionsSrc = objectSource(pairs);
  return {statements, markExpr: `new VlTrail(${dataVar}, ${optionsSrc})`};
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
  arc: renderArc,
  trail: renderTrail,
};

export function renderMark(mark, encoding, dataVar, ignoreUnsupported = false, facetChannels, config) {
  const markType = typeof mark === 'string' ? mark : mark.type;
  const markProps = typeof mark === 'string' ? {} : mark;
  const renderer = RENDERERS[markType];
  if (!renderer) {
    if (ignoreUnsupported) {
      return {statements: [`// vl2plot: unsupported mark type "${markType}", skipped (--ignore-unsupported)`], markExpr: null};
    }
    throw new Error(`Unsupported mark type: "${markType}"`);
  }
  // Spliced onto `markProps` (rather than added as its own positional
  // parameter to every renderer) so every existing renderer function
  // that already forwards `markProps` into commonChannels() picks this up
  // for free, with no signature change needed anywhere else -- see
  // commonChannels()'s own comment for why this needs to exist at all.
  return renderer(encoding, {...markProps, type: markType, __facetChannels: facetChannels, __config: config}, dataVar, ignoreUnsupported);
}
