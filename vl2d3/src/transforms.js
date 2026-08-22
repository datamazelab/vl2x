// Render the top-level Vega-Lite `transform` array as a sequence of
// `data = ...` statements. This is separate from prepare.js (which handles
// aggregate/bin/timeUnit declared *inline on an encoding channel*) because
// the top-level transform forms are fully explicit (e.g. an aggregate
// transform always lists its own `groupby` fields), so they don't need the
// same channel-inference logic.
//
// Supported: filter, calculate, aggregate, bin. Anything else throws a
// clear "unsupported" error naming the transform, rather than silently
// dropping it -- unless `ignoreUnsupported` is set, in which case an
// unsupported transform *type* is skipped entirely (the data continues
// through the pipeline without whatever that step would have done), rather
// than aborting the whole chart over one step it can't perform.

import {filterToExpr, translateExpr} from './expr.js';
import {isSupportedAggregateOp, aggregateExpr} from './aggops.js';
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
    const [as0, as1] = Array.isArray(t.as) ? t.as : [t.as, `${t.as}2`];
    const field = JSON.stringify(t.field);
    return [
      `${dataVar} = d3.bin().value(d => d[${field}]).thresholds(${thresholds})(${dataVar})` +
        `.flatMap(bin => bin.map(d => ({...d, ${JSON.stringify(as0)}: bin.x0, ${JSON.stringify(as1)}: bin.x1})));`,
    ];
  }
  if ('aggregate' in t) {
    if (!ignoreUnsupported) {
      for (const {op} of t.aggregate) {
        if (op !== 'count' && !isSupportedAggregateOp(op)) {
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
  const kind = Object.keys(t)[0];
  if (ignoreUnsupported) {
    // Skip this one step -- the rest of the transform pipeline (and the
    // chart as a whole) still runs on whatever data shape existed before it,
    // rather than the entire chart failing over one step it can't perform.
    return [`// vl2d3: skipped unsupported transform type "${kind}" (--ignore-unsupported)`];
  }
  throw new Error(`Unsupported transform type: "${kind}"`);
}
