// Render the top-level Vega-Lite `transform` array as a sequence of
// `data = ...` statements, operating on a plain materialized JS array --
// separate from `prepare.js` (which handles `aggregate`/`bin`/`timeUnit`
// declared *inline on an encoding channel*, routed through a Plot
// transform-wrapper function instead) because the top-level forms are fully
// explicit (an aggregate transform always lists its own `groupby` fields),
// so they need no channel-inference logic, just a direct translation.
//
// v1 scope: filter, calculate, aggregate, bin, timeUnit, stack, density.
// Anything else throws a clear "unsupported" error naming the transform,
// unless `ignoreUnsupported` is set, in which case the step is skipped
// entirely.

import {filterToExpr, translateExpr} from './expr.js';
import {isSupportedD3AggregateOp, aggregateExpr} from './aggops.js';
import {isSupportedTimeUnit, timeUnitExpr} from './timeunit.js';

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
  const key = Object.keys(t)[0] || '<unknown>';
  if (ignoreUnsupported) {
    return [`// vl2plot: skipped unsupported transform type "${key}" (--ignore-unsupported)`];
  }
  throw new Error(`Unsupported transform type: "${key}"`);
}
