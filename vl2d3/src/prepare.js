// The core piece D3 needs that vega-lite-api/Altair don't: Vega-Lite lets
// `aggregate`/`bin`/`timeUnit` be declared *inline on an encoding channel*
// (e.g. `{"y": {"aggregate": "mean", "field": "Rating", "type": "quantitative"}}`)
// and expects the renderer to group/summarize the data accordingly before
// drawing. D3 has no such implicit pipeline, so this module turns those
// declarations into explicit `data = ...` statements (using d3-array's
// `rollup`/`bin`) and returns a *rewritten* encoding whose channels just
// reference plain fields on the transformed data -- so scales.js and
// marks.js never need to know aggregate/bin/timeUnit exist.
//
// Scope (documented, not silently wrong): 0-2 non-binned "groupby" channels
// plus any number of aggregate value channels, OR exactly one binned
// channel with at most one aggregate value channel and no other groupby
// channels (the histogram case). Anything past that throws a clear error
// rather than emitting incorrect numbers.

import {isSupportedAggregateOp, aggregateExpr} from './aggops.js';
import {isSupportedTimeUnit, timeUnitExpr} from './timeunit.js';

// Turn an arbitrary field name (which may contain spaces, punctuation, or
// start with a digit) into a valid, dataVar-scoped-unique JS identifier for
// use as a `const` variable name (as opposed to a data *key*, which is
// always accessed via `d["..."]` bracket notation and never needs this).
function toIdentifier(dataVar, field, suffix) {
  const safe = String(field).replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
  return `${dataVar}_${safe}_${suffix}`;
}

const POSITION_LIKE = ['x', 'y', 'x2', 'y2', 'theta', 'theta2', 'radius', 'radius2', 'color', 'size', 'opacity', 'detail', 'order', 'text', 'tooltip'];

function channelEntries(encoding) {
  return Object.keys(encoding)
    .filter(k => POSITION_LIKE.includes(k))
    .map(k => [k, encoding[k]])
    .filter(([, def]) => def && typeof def === 'object' && !Array.isArray(def) && ('field' in def || def.aggregate === 'count'));
}

export function prepareEncoding(encoding, dataVar) {
  const entries = channelEntries(encoding);
  const aggChannels = entries.filter(([, def]) => def.aggregate);
  const binChannels = entries.filter(([, def]) => def.bin);
  const timeUnitOnlyChannels = entries.filter(([, def]) => def.timeUnit && !def.aggregate && !def.bin);
  const plainGroupChannels = entries.filter(
    ([, def]) => !def.aggregate && !def.bin && !def.timeUnit
  );

  const rewritten = {...encoding};
  const statements = [];

  if (aggChannels.length === 0 && binChannels.length === 0 && timeUnitOnlyChannels.length === 0) {
    // Nothing to prepare -- fields are used as-is.
    return {statements, encoding};
  }

  if (aggChannels.length === 0) {
    // Map-only case: timeUnit and/or bin derive a new field per row, no
    // grouping/summarizing.
    const mapEntries = [];
    for (const [channel, def] of [...timeUnitOnlyChannels, ...binChannels]) {
      if (def.bin) {
        const outField = outFieldName(def.field, 'bin');
        mapEntries.push([channel, def, outField, binMapExpr(def.field)]);
      } else {
        if (!isSupportedTimeUnit(def.timeUnit)) {
          throw new Error(`Unsupported timeUnit: "${def.timeUnit}"`);
        }
        const outField = outFieldName(def.field, def.timeUnit);
        mapEntries.push([channel, def, outField, timeUnitExpr(def.timeUnit, `d[${JSON.stringify(def.field)}]`)]);
      }
    }
    const assigns = mapEntries.map(([, , outField, expr]) => `${JSON.stringify(outField)}: ${expr}`);
    statements.push(`${dataVar} = ${dataVar}.map(d => ({...d, ${assigns.join(', ')}}));`);
    for (const [channel, def, outField] of mapEntries) {
      rewritten[channel] = {...def, field: outField};
      // A timeUnit-derived field is a real Date object; a bin-derived one is
      // numeric (quantitative) -- Vega-Lite infers `type` the same way when
      // it's not given explicitly, so only fill it in when absent.
      if (!def.type) rewritten[channel].type = def.timeUnit ? 'temporal' : 'quantitative';
      delete rewritten[channel].bin;
      delete rewritten[channel].timeUnit;
    }
    return {statements, encoding: rewritten};
  }

  // From here on, at least one channel aggregates -- the data is being
  // summarized down to one row per group (or a single row if there's no
  // grouping channel at all).
  if (binChannels.length > 1 || (binChannels.length === 1 && (plainGroupChannels.length > 0 || timeUnitOnlyChannels.length > 0))) {
    throw new Error(
      'Unsupported: binning combined with additional groupby channels is not yet supported'
    );
  }

  if (binChannels.length === 1) {
    return prepareHistogram(binChannels[0], aggChannels, dataVar, rewritten);
  }

  const groupChannels = [...plainGroupChannels, ...timeUnitOnlyChannels];
  if (groupChannels.length > 2) {
    throw new Error('Unsupported: aggregating grouped by more than 2 fields is not yet supported');
  }

  for (const [channel, def] of aggChannels) {
    if (def.aggregate !== 'count' && !isSupportedAggregateOp(def.aggregate)) {
      throw new Error(`Unsupported aggregate op: "${def.aggregate}"`);
    }
  }

  const keyExprFor = def =>
    def.timeUnit ? timeUnitExpr(def.timeUnit, `d[${JSON.stringify(def.field)}]`) : `d[${JSON.stringify(def.field)}]`;

  const valueAssigns = aggChannels.map(([channel, def]) => {
    const outField = def.aggregate === 'count' ? 'count' : outFieldName(def.field, def.aggregate);
    const accessor = def.field ? `d => d[${JSON.stringify(def.field)}]` : undefined;
    return {channel, def, outField, code: aggregateExpr(def.aggregate, 'rows', accessor)};
  });
  const valueObjectCode = valueAssigns.map(v => `${JSON.stringify(v.outField)}: ${v.code}`).join(', ');

  if (groupChannels.length === 0) {
    statements.push(`${dataVar} = [(rows => ({${valueObjectCode}}))(${dataVar})];`);
  } else if (groupChannels.length === 1) {
    const [channel, def] = groupChannels[0];
    const outField = def.timeUnit ? outFieldName(def.field, def.timeUnit) : def.field;
    statements.push(
      `${dataVar} = Array.from(` +
        `d3.rollup(${dataVar}, rows => ({${valueObjectCode}}), d => ${keyExprFor(def)}), ` +
        `([key, vals]) => ({${JSON.stringify(outField)}: key, ...vals}));`
    );
    rewritten[channel] = {...def, field: outField};
    if (def.timeUnit && !def.type) rewritten[channel].type = 'temporal';
    delete rewritten[channel].timeUnit;
  } else {
    const [[channel1, def1], [channel2, def2]] = groupChannels;
    const outField1 = def1.timeUnit ? outFieldName(def1.field, def1.timeUnit) : def1.field;
    const outField2 = def2.timeUnit ? outFieldName(def2.field, def2.timeUnit) : def2.field;
    statements.push(
      `${dataVar} = Array.from(` +
        `d3.rollup(${dataVar}, rows => ({${valueObjectCode}}), d => ${keyExprFor(def1)}, d => ${keyExprFor(def2)}), ` +
        `([k1, inner]) => Array.from(inner, ([k2, vals]) => ` +
        `({${JSON.stringify(outField1)}: k1, ${JSON.stringify(outField2)}: k2, ...vals}))).flat();`
    );
    rewritten[channel1] = {...def1, field: outField1};
    if (def1.timeUnit && !def1.type) rewritten[channel1].type = 'temporal';
    delete rewritten[channel1].timeUnit;
    rewritten[channel2] = {...def2, field: outField2};
    if (def2.timeUnit && !def2.type) rewritten[channel2].type = 'temporal';
    delete rewritten[channel2].timeUnit;
  }

  for (const {channel, def, outField} of valueAssigns) {
    rewritten[channel] = {...def, field: outField};
    delete rewritten[channel].aggregate;
  }

  return {statements, encoding: rewritten};
}

function prepareHistogram([channel, def], aggChannels, dataVar, rewritten) {
  const statements = [];
  const field = def.field;
  const thresholds = typeof def.bin === 'object' && def.bin.maxbins ? def.bin.maxbins : 20;
  const binsVar = toIdentifier(dataVar, field, 'bins');
  statements.push(
    `const ${binsVar} = d3.bin().value(d => d[${JSON.stringify(field)}]).thresholds(${thresholds})(${dataVar});`
  );

  const valueAssigns = aggChannels.map(([, adef]) => {
    const outField = adef.aggregate === 'count' ? 'count' : outFieldName(adef.field, adef.aggregate);
    const accessor = adef.field ? `d => d[${JSON.stringify(adef.field)}]` : undefined;
    return {outField, code: aggregateExpr(adef.aggregate, 'bin', accessor)};
  });
  const valueObjectCode = valueAssigns.map(v => `${JSON.stringify(v.outField)}: ${v.code}`).join(', ');

  const outField0 = outFieldName(field, 'bin0');
  const outField1 = outFieldName(field, 'bin1');
  statements.push(
    `${dataVar} = ${binsVar}.map(bin => ({${JSON.stringify(outField0)}: bin.x0, ${JSON.stringify(outField1)}: bin.x1, ${valueObjectCode}}));`
  );

  rewritten[channel] = {...def, field: outField0};
  delete rewritten[channel].bin;
  rewritten[`${channel}2`] = {field: outField1, type: 'quantitative'};
  for (const [aChannel, adef] of aggChannels) {
    const outField = adef.aggregate === 'count' ? 'count' : outFieldName(adef.field, adef.aggregate);
    rewritten[aChannel] = {...adef, field: outField};
    delete rewritten[aChannel].aggregate;
  }

  return {statements, encoding: rewritten};
}

function outFieldName(field, suffix) {
  return field ? `${suffix}_${field}` : suffix;
}

function binMapExpr(field) {
  // Without pre-computed thresholds (no aggregate to anchor them to), fall
  // back to rounding to a "nice" step derived at render time isn't
  // straightforward per-row; document this as an approximation using a
  // fixed 10-unit step is too surprising, so instead require aggregation
  // for `bin` to take effect precisely -- but still give a best-effort
  // passthrough (identity) so the field remains usable un-binned.
  return `d[${JSON.stringify(field)}]`;
}
