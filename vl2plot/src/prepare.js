// Turn Vega-Lite's *implicit* per-channel `aggregate`/`bin`/`timeUnit` into
// (a) data-array statements (for `timeUnit`, which needs a real derived
// field before Plot ever sees the data) and (b) a Plot transform-wrapper
// choice (`Plot.binX`/`binY`/`groupX`/`groupY`) marks.js applies around the
// mark's own already-built options object -- unlike `vl2d3`'s own
// prepare.js (which has to hand-roll the actual grouping/binning via
// `d3.rollup`/`d3.bin`), Plot's own transform functions already do that
// work; this module's job is just deciding *which* one applies and what its
// own `outputs` object should be. Confirmed empirically: `Plot.groupX`/
// `binX` already group by every *other* field-valued channel present in the
// same options object automatically (not just the transform's own named
// axis), matching Vega-Lite's own "every non-aggregate fielded channel is
// an implicit groupby key" semantics for free.

import {isSupportedTimeUnit, timeUnitExpr, isCyclicTimeUnit} from './timeunit.js';
import {isSupportedAggregateOp, plotReducer} from './aggops.js';
import {effectiveType, unescapeFieldName} from './encoding.js';

const POSITION_CHANNELS = ['x', 'y'];
// Every channel Plot's own `groupX`/`groupY` transform can pick up as an
// implicit grouping key (see the module docstring) -- consulted only to
// detect the *degenerate* case where none of them apply at all (see
// `needsConstantKey` below).
const GROUP_KEY_CHANNELS = ['x', 'y', 'color', 'fill', 'stroke', 'opacity', 'size', 'symbol', 'detail'];
// Every channel a mark's own options object can carry a `field` on --
// consulted when deciding whether a channel participates in an implicit
// groupby (see `hasField()` below).
// `detail` (e.g. `detail: {timeUnit: "year", field: "date"}`, a common
// "one line per year" idiom -- repeat_child_layer.vl.json's own shape)
// was previously missing here entirely: it maps onto Plot's own `z`
// channel (marks.js's `commonChannels()`), which still needs its own
// timeUnit applied exactly the same way any other channel's does, but
// silently kept the raw, untruncated field instead -- confirmed
// empirically to leave `z` grouping by the exact (per-row-unique)
// timestamp rather than by year, effectively grouping nothing at all.
const ALL_CHANNELS = ['x', 'y', 'x2', 'y2', 'color', 'fill', 'stroke', 'opacity', 'size', 'symbol', 'r', 'text', 'title', 'detail'];

function fieldRef(rowVar, field) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field) ? `${rowVar}.${field}` : `${rowVar}[${JSON.stringify(field)}]`;
}

// Collects every field that needs `Date` coercion before this mark's own
// channels (or a `timeUnit` deriving from it) can use it -- an explicit
// `type: "temporal"` channel, or a channel whose own `timeUnit` implies
// temporal (a *combined* unit like `yearmonth`; a single cyclic one like
// `month` reduces to a plain number instead, no Date needed as an
// intermediate -- `timeUnitExpr()` still expects a real Date as *input*
// though, so cyclic units need coercion too, just not temporal *output*).
export function collectTemporalFields(encoding) {
  const fields = [];
  for (const ch of ALL_CHANNELS) {
    const def = encoding[ch];
    if (!def || typeof def !== 'object' || typeof def.field !== 'string') continue;
    // Unescaped here (Vega-Lite's own `\.`-means-a-literal-dot convention,
    // e.g. `"a\\.b"` naming the real column "a.b", not a nested "a"->"b"
    // path) -- `renderTemporalCoercion()` (data.js) uses this list's own
    // strings directly as BOTH the read key and the new Date column's own
    // key, so a still-escaped field here reads a column that doesn't
    // exist (`d["a\\.b"]` when the real key is "a.b"), silently coercing
    // to `Invalid Date` for every row (bar_simple_binned_timeunit_
    // special_chars.vl.json's own shape).
    if (def.type === 'temporal' || def.timeUnit) fields.push(unescapeFieldName(def.field));
  }
  return fields;
}

function hasField(def) {
  return def && typeof def === 'object' && typeof def.field === 'string';
}

// Rewrites every `timeUnit`-bearing channel into a plain `field` pointing
// at a newly derived column, returning `{statements, encoding}` --
// `encoding` has every `timeUnit` key stripped (each channel's `field` now
// names the derived output instead), so nothing downstream (`marks.js`,
// `scales.js`) ever needs to know `timeUnit` was involved at all.
export function applyTimeUnits(encoding, dataVar, ignoreUnsupported = false) {
  const statements = [];
  const rewritten = {...encoding};
  const assigns = [];
  for (const ch of ALL_CHANNELS) {
    const def = encoding[ch];
    if (!hasField(def) || !def.timeUnit) continue;
    const unit = def.timeUnit;
    if (!isSupportedTimeUnit(unit)) {
      if (ignoreUnsupported) {
        // Left as the raw (uncoerced) field -- better than dropping the
        // channel outright.
        continue;
      }
      throw new Error(`Unsupported timeUnit: "${JSON.stringify(unit)}"`);
    }
    const unitName = typeof unit === 'object' ? unit.unit : unit;
    // Unescaped for the same reason collectTemporalFields() is, just
    // above -- collectTemporalFields()'s own output (what
    // renderTemporalCoercion() actually creates the coerced Date column
    // under) is ALREADY the real unescaped name, so reading `def.field`
    // here as-is (still escaped) would look up a column that was never
    // created under that exact (backslash-containing) key at all.
    const sourceField = unescapeFieldName(def.field);
    const outField = `${unitName}_${sourceField}`;
    const expr = timeUnitExpr(unit, fieldRef('d', sourceField), ignoreUnsupported);
    assigns.push(`${JSON.stringify(outField)}: ${expr}`);
    const impliedType = isCyclicTimeUnit(unit) ? (def.type && def.type !== 'temporal' ? def.type : 'ordinal') : 'temporal';
    rewritten[ch] = {...def, field: outField, timeUnit: undefined, type: def.type || impliedType};
  }
  if (assigns.length) {
    statements.push(`${dataVar} = ${dataVar}.map(d => ({...d, ${assigns.join(', ')}}));`);
  }
  return {statements, encoding: rewritten};
}

// Decides whether this mark's own (already timeUnit-rewritten) encoding
// needs a `Plot.binX`/`binY`/`groupX`/`groupY` wrapper -- returns `null`
// when no channel carries an inline `bin`/`aggregate` at all (the common
// case), or `{fn, outputs}` otherwise (`fn` is Plot's own transform
// function name; `outputs` is the object its own first argument expects,
// e.g. `{y: "count"}`). Only one axis is ever binned/grouped in Vega-Lite's
// own model (the *other* position channel, plus every additional
// field-valued channel, become implicit groupby keys) -- `x` is preferred
// when both somehow carry `bin`/`aggregate` (a genuinely rare/malformed
// shape), matching this project's own "pick the more common orientation and
// move on" convention elsewhere.
export function planTransform(encoding, ignoreUnsupported = false) {
  let binChannel = null;
  let aggChannel = null;
  for (const ch of POSITION_CHANNELS) {
    const def = encoding[ch];
    if (!def || typeof def !== 'object') continue;
    // `bin: {"binned": true}` OR the equivalent bare-string shorthand
    // `bin: "binned"` (Vega-Lite's own schema allows either -- confirmed
    // against layer_cumulative_histogram.vl.json's own `x: {bin:
    // "binned", ...}`) is Vega-Lite's signal that the field *already
    // holds* the bin boundary (typically alongside an explicit `x2`
    // companion for the other edge) -- the opposite of a request to bin
    // it now, so this deliberately does NOT count as `binChannel` here
    // (a real corpus spec paired this with `x2`, hitting `marks.js`'s own
    // "aggregated value on a continuous bin-interval axis" guard for an
    // aggregate that was never actually being requested). Missing the
    // bare-string form entirely previously misread it as a genuine
    // bin-now request, tripping that exact guard and silently dropping
    // the mark outright under `--ignore-unsupported` (both of this
    // spec's own layers ended up with an empty `marks: []`).
    const isPreBinned = def.bin === 'binned' || (def.bin && typeof def.bin === 'object' && def.bin.binned === true);
    if (def.bin && !isPreBinned) binChannel = binChannel || ch;
    else if (def.aggregate != null) aggChannel = aggChannel || ch;
  }

  if (binChannel) {
    const other = binChannel === 'x' ? 'y' : 'x';
    const otherDef = encoding[other];
    const outputs = {};
    if (otherDef && otherDef.aggregate != null) {
      outputs[other] = plotReducer(otherDef.aggregate, ignoreUnsupported);
    } else {
      outputs[other] = 'count';
    }
    // `Plot.binX`/`binY` accept bin-shaping options (`thresholds`, ...)
    // merged into the same first (`outputs`) argument as the reducers --
    // `bin: {"maxbins": N}`'s closest equivalent is an approximate target
    // bin *count*, which is exactly what Plot's own `thresholds` accepts
    // as a bare number (a precise bin *width*, `bin: {"step": N}`, has no
    // matching Plot option and is left to Plot's own default heuristic).
    // Vega-Lite's own default (`bin: true`, or `bin: {}` with no explicit
    // `maxbins`/`step`) is a fixed `maxbins: 10` -- confirmed against the
    // real compiler's own output for repeat_layer.vl.json (`bin_maxbins_
    // 10_...`, an un-overridden `bin: true`). Left unset, Plot's own
    // auto-threshold heuristic (Sturges/Scott-ish, driven by the data's
    // own size/spread) previously produced a MUCH finer bin count on a
    // large dataset (39 bins on this same spec's ~3000-row movies
    // dataset, not 10) -- a noticeably more jagged, differently-shaped
    // line than every other tool's own 10-bin rendering of the identical
    // spec (the user-reported "doesn't look like the same line plot as
    // the others" symptom).
    const binDef = encoding[binChannel].bin;
    if (binDef && typeof binDef === 'object' && typeof binDef.maxbins === 'number') {
      outputs.thresholds = binDef.maxbins;
    } else if (!(binDef && typeof binDef === 'object' && typeof binDef.step === 'number')) {
      outputs.thresholds = 10;
    }
    return augmentWithTextAggregate({fn: binChannel === 'x' ? 'binX' : 'binY', outputs}, encoding, ignoreUnsupported);
  }

  if (aggChannel) {
    const def = encoding[aggChannel];
    const op = def.aggregate;
    if (op !== 'count' && !isSupportedAggregateOp(op)) {
      if (!ignoreUnsupported) throw new Error(`Unsupported aggregate op: "${op}"`);
    }
    const outputs = {[aggChannel]: plotReducer(op, ignoreUnsupported)};
    // Unlike `binX`/`binY` (named after the axis *being binned*), `groupX`/
    // `groupY` are named after the *grouping key* axis -- the OTHER
    // channel from the one carrying the aggregate (confirmed empirically:
    // `groupX` groups rows by their x value and computes the aggregate
    // output, typically onto y; picking the transform by the aggregate's
    // own channel name, as this used to, silently produced the wrong
    // grouping -- e.g. every row its own bar -- without ever throwing).
    const groupKeyCh = aggChannel === 'x' ? 'y' : 'x';
    // Vega-Lite's genuinely 1-dimensional aggregate -- only the one
    // channel being aggregated is given at all, no other position/color/
    // detail channel to group by (e.g. a single summary bar: `{"x":
    // {"aggregate": "sum", "field": "people"}}`, no `y` at all). Without
    // *some* other channel present, Plot's own group transform has no
    // grouping key to work with at all and silently falls back to each
    // row's own array index -- one "group" per row, not one combined
    // total (confirmed empirically: produced N separate, wrongly-scaled
    // bars instead of a single summed one, without ever throwing). A
    // constant on the missing axis gives every row the same key, which
    // collapses them into the single group Vega-Lite's own semantics call
    // for here.
    //
    // A literal `value`-bound channel (e.g. layer_histogram_global_mean
    // .vl.json's own rule layer: `color: {value: "red"}, size: {value:
    // 5}`, no `y` at all) does NOT count as a usable group key here,
    // despite every row trivially sharing that identical constant --
    // confirmed empirically that Plot's own group transform, given
    // nothing else at all to group by, still falls back to one group
    // PER ROW (the same degenerate case the comment above already
    // describes), silently drawing NO visible rule/mark whatsoever
    // rather than throwing. Only a real per-row FIELD value (which Plot
    // can actually key groups by) counts.
    const hasPositionGroupKey = hasField(encoding[groupKeyCh]);
    // `Plot.groupX`/`groupY` ALSO always group on {z, fill, stroke} first
    // (confirmed from Plot's own source, `transforms/group.js`: both are
    // thin wrappers around a shared `groupn(x, y, ...)` that groups on
    // z/fill/stroke before ever looking at x/y), but they each REQUIRE
    // their own named position option to be present at all -- `options.x
    // == null` throws `"missing channel: x"` at call time (same for y).
    // A rule layer with a real per-row color field but genuinely NO other
    // position channel at all (e.g. layer_line_color_rule.vl.json's own
    // rule layer: `y: {field: "price", aggregate: "mean"}, color: {field:
    // "symbol"}`, no `x` whatsoever) would crash `Plot.groupX` outright --
    // confirmed empirically. `Plot.groupZ` groups purely on {z, fill,
    // stroke} with no x/y requirement, the correct fit here.
    const hasNonPositionGroupKey = GROUP_KEY_CHANNELS.some(ch => ch !== 'x' && ch !== 'y' && ch !== aggChannel && hasField(encoding[ch]));
    let fn, needsConstantKey;
    if (hasPositionGroupKey) {
      fn = aggChannel === 'x' ? 'groupY' : 'groupX';
      needsConstantKey = null;
    } else if (hasNonPositionGroupKey) {
      fn = 'groupZ';
      needsConstantKey = null;
    } else {
      fn = aggChannel === 'x' ? 'groupY' : 'groupX';
      needsConstantKey = groupKeyCh;
    }
    return augmentWithTextAggregate({fn, outputs, needsConstantKey}, encoding, ignoreUnsupported);
  }

  return null;
}

// A `text` channel with its own independent `aggregate` (e.g. a bar
// chart's own label repeating the same summary value alongside its own
// value channel: `{"x": {"aggregate": "sum", "field": "people"}, "text":
// {"aggregate": "sum", "field": "people"}}`) needs its own reducer entry
// in the SAME group/bin transform's `outputs` object, riding along on
// whichever groupby key the position channel(s) already established.
// Left out of `outputs`, Plot's own group/bin transforms would otherwise
// treat the still-raw `text` field (see `marks.js`'s own pairs, which
// keep it as a plain field reference so there's something for this
// reducer to actually read) as an *additional* implicit groupby key --
// every other field-valued channel becomes one, per the module docstring
// -- silently breaking the whole aggregation the same way an unhandled
// `opacity`/`size` channel does (see `marks.js`'s own
// `UNGROUPABLE_STYLE_CHANNELS`); confirmed empirically on a real corpus
// spec (`stacked_bar_h_normalized_labeled`).
function augmentWithTextAggregate(plan, encoding, ignoreUnsupported) {
  const textDef = encoding.text;
  if (!textDef || typeof textDef !== 'object' || textDef.aggregate == null) return plan;
  const op = textDef.aggregate;
  if (op !== 'count' && !isSupportedAggregateOp(op) && !ignoreUnsupported) {
    throw new Error(`Unsupported aggregate op: "${op}"`);
  }
  return {...plan, outputs: {...plan.outputs, text: plotReducer(op, ignoreUnsupported)}};
}
