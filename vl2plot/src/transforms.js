// Render the top-level Vega-Lite `transform` array as a sequence of
// `data = ...` statements, operating on a plain materialized JS array --
// separate from `prepare.js` (which handles `aggregate`/`bin`/`timeUnit`
// declared *inline on an encoding channel*, routed through a Plot
// transform-wrapper function instead) because the top-level forms are fully
// explicit (an aggregate transform always lists its own `groupby` fields),
// so they need no channel-inference logic, just a direct translation.
//
// v1 scope: filter, calculate, aggregate, joinaggregate, bin, timeUnit,
// flatten, stack, density, window. Anything else throws a clear
// "unsupported" error naming the transform, unless `ignoreUnsupported` is
// set, in which case the step is skipped entirely.

import {filterToExpr, translateExpr} from './expr.js';
import {isSupportedD3AggregateOp, aggregateExpr} from './aggops.js';
import {isSupportedTimeUnit, timeUnitExpr} from './timeunit.js';

// A fresh intermediate variable name per `joinaggregate` step -- needs one
// (unlike every other transform in this file, which reassigns `dataVar` in
// a single self-contained statement) since the per-group aggregate map has
// to be computed once and then looked up once per row, not recomputed
// per-row (an O(n^2) rollup-inside-a-map would still be *correct*, just
// needlessly slow on a real corpus-sized dataset). An ever-incrementing
// counter guarantees a distinct name even if `joinaggregate` appears more
// than once in the same spec's own transform pipeline.
let joinAggregateCounter = 0;

// Mirrors `vlWindow()`'s own supported-op set (see `runtime.js`) --
// percentile/selection ops with no simple direct equivalent (percent_rank,
// cume_dist, ntile, first_value/last_value/nth_value) aren't supported.
const WINDOW_OPS = new Set(['row_number', 'rank', 'dense_rank', 'lag', 'lead', 'sum', 'mean', 'average', 'count', 'min', 'max', 'median', 'distinct']);
function isSupportedWindowOp(op) {
  return WINDOW_OPS.has(op);
}

export function renderTransforms(transformList, dataVar, ignoreUnsupported = false) {
  const statements = [];
  for (const t of transformList) {
    statements.push(...renderOne(t, dataVar, ignoreUnsupported));
  }
  return statements;
}

function renderOne(t, dataVar, ignoreUnsupported) {
  if ('filter' in t) {
    return [`${dataVar} = ${dataVar}.filter(d => ${filterToExpr(t.filter, 'd', ignoreUnsupported)});`];
  }
  if ('calculate' in t) {
    return [`${dataVar} = ${dataVar}.map(d => ({...d, ${JSON.stringify(t.as)}: (${translateExpr(t.calculate)})}));`];
  }
  if ('timeUnit' in t) {
    if (!isSupportedTimeUnit(t.timeUnit) && !ignoreUnsupported) {
      throw new Error(`Unsupported timeUnit: "${t.timeUnit}"`);
    }
    const expr = timeUnitExpr(t.timeUnit, `d[${JSON.stringify(t.field)}]`, ignoreUnsupported);
    return [`${dataVar} = ${dataVar}.map(d => ({...d, ${JSON.stringify(t.as)}: ${expr}}));`];
  }
  if ('bin' in t) {
    const thresholds = typeof t.bin === 'object' && t.bin.maxbins ? t.bin.maxbins : 20;
    // Vega-Lite's own naming convention for a top-level `bin` transform's
    // second (upper) boundary field, when `as` is a single string rather
    // than an explicit 2-element array, is `<as>_end` -- matching a later
    // transform step in the same pipeline that commonly already references
    // it by that name (e.g. a subsequent `aggregate` transform's own
    // `groupby: ["bin_x", "bin_x_end"]`).
    const [as0, as1] = Array.isArray(t.as) ? t.as : [t.as, `${t.as}_end`];
    const field = JSON.stringify(t.field);
    return [
      `${dataVar} = d3.bin().value(d => d[${field}]).thresholds(${thresholds})(${dataVar})` +
        `.flatMap(bin => bin.map(d => ({...d, ${JSON.stringify(as0)}: bin.x0, ${JSON.stringify(as1)}: bin.x1})));`,
    ];
  }
  if ('aggregate' in t) {
    if (!ignoreUnsupported) {
      for (const {op} of t.aggregate) {
        if (op !== 'count' && !isSupportedD3AggregateOp(op)) {
          throw new Error(`Unsupported aggregate op: "${op}"`);
        }
      }
    }
    const groupby = t.groupby || [];
    const valueAssigns = t.aggregate.map(({op, field, as}) => {
      const accessor = field ? `d => d[${JSON.stringify(field)}]` : undefined;
      return `${JSON.stringify(as)}: ${aggregateExpr(op, 'rows', accessor, ignoreUnsupported)}`;
    });
    const groupbyAssigns = groupby.map(f => `${JSON.stringify(f)}: rows[0][${JSON.stringify(f)}]`);
    const reducer = `rows => ({${[...groupbyAssigns, ...valueAssigns].join(', ')}})`;
    if (groupby.length === 0) {
      return [`${dataVar} = [(${reducer})(${dataVar})];`];
    }
    const keyExpr = `d => JSON.stringify([${groupby.map(f => `d[${JSON.stringify(f)}]`).join(', ')}])`;
    return [`${dataVar} = Array.from(d3.rollup(${dataVar}, ${reducer}, ${keyExpr}).values());`];
  }
  if ('flatten' in t) {
    return [`${dataVar} = vlFlatten(${dataVar}, {fields: ${JSON.stringify(t.flatten)}, as: ${JSON.stringify(t.as)}});`];
  }
  if ('joinaggregate' in t) {
    // Like the top-level `aggregate` transform just above -- same
    // groupby/op/field/as shape -- but JOINS the per-group aggregate back
    // onto every ORIGINAL row instead of collapsing to one row per group
    // (`bar_percent_of_total.vl.json`'s own shape: every activity's own
    // row keeps its own identity, gaining a new `TotalTime` column that's
    // the SAME value -- the grand total -- across every row, empty
    // `groupby` meaning one single global group). Previously entirely
    // unsupported, silently skipped under `--ignore-unsupported` -- every
    // downstream reference to the never-created `as` column (this spec's
    // own `datum.Time/datum.TotalTime * 100`) evaluated to `NaN`, which
    // then propagated silently through Plot's own scale/stack machinery
    // into a visually-plausible-looking but completely wrong chart (every
    // bar spanning the full domain width, indistinguishable from an
    // accidental 100%-normalized stack, though unrelated to the stack
    // offset itself).
    if (!ignoreUnsupported) {
      for (const {op} of t.joinaggregate) {
        if (op !== 'count' && !isSupportedD3AggregateOp(op)) {
          throw new Error(`Unsupported aggregate op: "${op}"`);
        }
      }
    }
    const groupby = t.groupby || [];
    const valueAssigns = t.joinaggregate.map(({op, field, as}) => {
      const accessor = field ? `d => d[${JSON.stringify(field)}]` : undefined;
      return `${JSON.stringify(as)}: ${aggregateExpr(op, 'rows', accessor, ignoreUnsupported)}`;
    });
    const reducer = `rows => ({${valueAssigns.join(', ')}})`;
    const keyFn = groupby.length
      ? `d => JSON.stringify([${groupby.map(f => `d[${JSON.stringify(f)}]`).join(', ')}])`
      : `() => 0`;
    const mapVar = `__joinagg${++joinAggregateCounter}`;
    return [
      `const ${mapVar} = d3.rollup(${dataVar}, ${reducer}, ${keyFn});`,
      `${dataVar} = ${dataVar}.map(d => ({...d, ...${mapVar}.get((${keyFn})(d))}));`,
    ];
  }
  if ('stack' in t) {
    const opts = {
      field: JSON.stringify(t.stack),
      groupby: JSON.stringify(t.groupby || []),
      sort: JSON.stringify(t.sort || []),
      offset: JSON.stringify(t.offset || 'zero'),
      as: JSON.stringify(t.as),
    };
    return [`${dataVar} = vlStack(${dataVar}, {field: ${opts.field}, groupby: ${opts.groupby}, sort: ${opts.sort}, offset: ${opts.offset}, as: ${opts.as}});`];
  }
  if ('density' in t) {
    const asNames = Array.isArray(t.as) && t.as.length === 2 ? t.as : ['value', 'density'];
    const opts = {
      field: JSON.stringify(t.density),
      groupby: JSON.stringify(t.groupby || []),
      extent: Array.isArray(t.extent) ? JSON.stringify(t.extent) : 'null',
      bandwidth: t.bandwidth != null ? JSON.stringify(t.bandwidth) : 'null',
      steps: Number.isInteger(t.steps) ? t.steps : 200,
      counts: t.counts ? 'true' : 'false',
      as: JSON.stringify(asNames),
    };
    return [
      `${dataVar} = vlDensity(${dataVar}, {field: ${opts.field}, groupby: ${opts.groupby}, extent: ${opts.extent}, ` +
        `bandwidth: ${opts.bandwidth}, steps: ${opts.steps}, counts: ${opts.counts}, as: ${opts.as}});`,
    ];
  }
  if ('window' in t) {
    const unsupportedOp = t.window.map(w => w.op).find(op => !isSupportedWindowOp(op));
    if (unsupportedOp && !ignoreUnsupported) {
      throw new Error(`Unsupported window op: "${unsupportedOp}"`);
    }
    if (unsupportedOp) {
      return [`// vl2plot: skipped unsupported window op "${unsupportedOp}" (--ignore-unsupported)`];
    }
    const opts = {
      window: JSON.stringify(t.window),
      groupby: JSON.stringify(t.groupby || []),
      sort: JSON.stringify(t.sort || []),
      frame: Array.isArray(t.frame) ? JSON.stringify(t.frame) : 'null',
    };
    return [`${dataVar} = vlWindow(${dataVar}, {window: ${opts.window}, groupby: ${opts.groupby}, sort: ${opts.sort}, frame: ${opts.frame}});`];
  }
  const key = Object.keys(t)[0] || '<unknown>';
  if (ignoreUnsupported) {
    return [`// vl2plot: skipped unsupported transform type "${key}" (--ignore-unsupported)`];
  }
  throw new Error(`Unsupported transform type: "${key}"`);
}
