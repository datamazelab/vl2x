// Render the top-level Vega-Lite `transform` array as a sequence of
// `data = ...` statements. This is separate from prepare.js (which handles
// aggregate/bin/timeUnit declared *inline on an encoding channel*) because
// the top-level transform forms are fully explicit (e.g. an aggregate
// transform always lists its own `groupby` fields), so they don't need the
// same channel-inference logic.
//
// Supported: filter, calculate, aggregate, bin. Anything else throws a
// clear "unsupported" error naming the transform, rather than silently
// dropping it.

import {filterToExpr, translateExpr} from './expr.js';
import {isSupportedAggregateOp, aggregateExpr} from './aggops.js';
import {isSupportedTimeUnit, timeUnitExpr} from './timeunit.js';

export function renderTransforms(transformList, dataVar) {
  const statements = [];
  for (const t of transformList) {
    statements.push(...renderOne(t, dataVar));
  }
  return statements;
}

function renderOne(t, dataVar) {
  if ('filter' in t) {
    return [`${dataVar} = ${dataVar}.filter(d => ${filterToExpr(t.filter)});`];
  }
  if ('calculate' in t) {
    return [`${dataVar} = ${dataVar}.map(d => ({...d, ${JSON.stringify(t.as)}: (${translateExpr(t.calculate)})}));`];
  }
  if ('timeUnit' in t) {
    if (!isSupportedTimeUnit(t.timeUnit)) throw new Error(`Unsupported timeUnit: "${t.timeUnit}"`);
    const expr = timeUnitExpr(t.timeUnit, `d[${JSON.stringify(t.field)}]`);
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
    for (const {op} of t.aggregate) {
      if (op !== 'count' && !isSupportedAggregateOp(op)) {
        throw new Error(`Unsupported aggregate op: "${op}"`);
      }
    }
    const groupby = t.groupby || [];
    const valueAssigns = t.aggregate.map(({op, field, as}) => {
      const accessor = field ? `d => d[${JSON.stringify(field)}]` : undefined;
      return `${JSON.stringify(as)}: ${aggregateExpr(op, 'rows', accessor)}`;
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
  throw new Error(`Unsupported transform type: "${kind}"`);
}
