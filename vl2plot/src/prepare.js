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
import {effectiveType} from './encoding.js';

const POSITION_CHANNELS = ['x', 'y'];
// Every channel a mark's own options object can carry a `field` on --
// consulted when deciding whether a channel participates in an implicit
// groupby (see `hasField()` below).
const ALL_CHANNELS = ['x', 'y', 'x2', 'y2', 'color', 'fill', 'stroke', 'opacity', 'size', 'symbol', 'r', 'text', 'title'];

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
    if (def.type === 'temporal' || def.timeUnit) fields.push(def.field);
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
    const outField = `${unitName}_${def.field}`;
    const expr = timeUnitExpr(unit, fieldRef('d', def.field), ignoreUnsupported);
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
    if (def.bin) binChannel = binChannel || ch;
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
    return {fn: binChannel === 'x' ? 'binX' : 'binY', outputs};
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
    return {fn: aggChannel === 'x' ? 'groupY' : 'groupX', outputs};
  }

  return null;
}
