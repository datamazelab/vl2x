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
import {isSupportedTimeUnit, timeUnitExpr, isCyclicTimeUnit} from './timeunit.js';

// True position channels (as opposed to `color`/`size`/etc, which also
// live in POSITION_LIKE below purely so prepare.js drives their aggregate
// grouping too) -- kept a continuous time scale even for a cyclic timeUnit,
// since a band/point x/y axis of raw Date values (with no per-channel tick
// re-formatting) would just show ugly, un-labeled ticks. Only a
// *non*-positional channel's field `type` is downgraded to "ordinal" for a
// cyclic timeUnit below (see timeUnitFieldType()) -- exactly where
// Vega-Lite's own default scale-type inference switches from time to
// ordinal/discrete for such a field (e.g. line_quarter_legend.vl.json's
// `color` channel gets 4 discrete Q1-Q4 swatches, not a blue gradient, and
// needs `type: "ordinal"` here so both resolveColorScale() and
// seriesGroupField() (scales.js/marks.js) treat it as the discrete,
// line-splitting field it actually is instead of a non-groupable continuum).
const TRUE_POSITION_CHANNELS = ['x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'theta', 'theta2', 'radius', 'radius2'];

// An explicit non-"temporal" type (e.g. a deliberate "nominal" override) is
// always respected as-is; otherwise (no type given, or the field's own
// "temporal" type -- which doesn't by itself pin the *scale* to continuous
// time in real Vega-Lite either) the cyclic-timeUnit-on-a-non-positional-
// channel downgrade above applies.
function timeUnitFieldType(channel, def) {
  if (def.type && def.type !== 'temporal') return def.type;
  return !TRUE_POSITION_CHANNELS.includes(channel) && isCyclicTimeUnit(def.timeUnit) ? 'ordinal' : 'temporal';
}

// Sets `rewritten[channel]`'s `type` (via timeUnitFieldType() above) and
// removes the now-consumed `timeUnit`, same as every other timeUnit-derived
// channel -- but when the ordinal downgrade actually applied, also keeps
// the original timeUnit name around under `ordinalTimeUnit` (a normal
// field would never have this property) so a later ordinal-domain
// consumer -- currently just the color legend, translator.js -- can still
// format its (real Date-valued) domain entries as "Q1"/"Q2"/... instead of
// a raw `Date.toString()`, without needing to separately re-derive
// "was this cyclic" from a `type: "ordinal"` field that could just as
// easily be a genuinely nominal string field instead.
function applyTimeUnitType(rewritten, channel, def) {
  const type = timeUnitFieldType(channel, def);
  rewritten[channel].type = type;
  if (type === 'ordinal' && def.timeUnit) rewritten[channel].ordinalTimeUnit = def.timeUnit;
  delete rewritten[channel].timeUnit;
}

// Turn an arbitrary field name (which may contain spaces, punctuation, or
// start with a digit) into a valid, dataVar-scoped-unique JS identifier for
// use as a `const` variable name (as opposed to a data *key*, which is
// always accessed via `d["..."]` bracket notation and never needs this).
function toIdentifier(dataVar, field, suffix) {
  const safe = String(field).replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
  return `${dataVar}_${safe}_${suffix}`;
}

const POSITION_LIKE = [
  'x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'theta', 'theta2', 'radius', 'radius2',
  'color', 'size', 'opacity', 'detail', 'order', 'text', 'tooltip',
];

function channelEntries(encoding) {
  return Object.keys(encoding)
    .filter(k => POSITION_LIKE.includes(k))
    .map(k => [k, encoding[k]])
    .filter(([, def]) => def && typeof def === 'object' && !Array.isArray(def) && ('field' in def || def.aggregate === 'count'));
}

export function prepareEncoding(encoding, dataVar, ignoreUnsupported = false) {
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
    // A single bin-only channel (no timeUnit-only channel alongside it, no
    // aggregate anywhere) gets *real* binning via d3.bin() -- both the
    // bin's start and end edges, exactly like the top-level `bin`
    // transform already computes (transforms.js) -- rather than the
    // identity passthrough below, which used to leave the field entirely
    // un-binned (every row keeping its own exact raw value: no two rows
    // ever landing in "the same bin" at all, and a bar/rect mark drawing
    // one wildly-varying zero-baseline bar per row instead of a clean
    // per-bin box). Emitting a companion `${outField}_end` field (as a
    // real `${channel}2`) also lets marks.js draw the box at the bin's
    // own exact width, instead of guessing one from the gaps between
    // whichever distinct values happen to occur.
    if (binChannels.length === 1 && timeUnitOnlyChannels.length === 0) {
      const [channel, def] = binChannels[0];
      const thresholds = typeof def.bin === 'object' && def.bin.maxbins ? def.bin.maxbins : 20;
      const outField = outFieldName(def.field, 'bin');
      const outField2 = `${outField}_end`;
      statements.push(
        `${dataVar} = d3.bin().value(d => d[${JSON.stringify(def.field)}]).thresholds(${thresholds})(${dataVar})` +
          `.flatMap(bin => bin.map(d => ({...d, ${JSON.stringify(outField)}: bin.x0, ${JSON.stringify(outField2)}: bin.x1})));`
      );
      rewritten[channel] = {...def, field: outField};
      if (!def.type) rewritten[channel].type = 'quantitative';
      delete rewritten[channel].bin;
      // Marks a real bin box (as opposed to any other x2/y2-range shape,
      // e.g. an explicit `stack` transform's output) -- marks.js's
      // x2/y2-only bar dispatch uses this to add Vega-Lite's default
      // `config.bar.binSpacing` gap between adjacent bins, which a plain
      // touching-edges box shouldn't get.
      rewritten[channel].binned = true;
      rewritten[`${channel}2`] = {field: outField2, type: 'quantitative'};
      return {statements, encoding: rewritten};
    }

    // Map-only case: timeUnit and/or bin derive a new field per row, no
    // grouping/summarizing. Bin-plus-timeUnit-together is a rare enough
    // combination that it keeps the old identity-passthrough
    // approximation (binMapExpr()) rather than the real binning above.
    const mapEntries = [];
    for (const [channel, def] of [...timeUnitOnlyChannels, ...binChannels]) {
      if (def.bin) {
        const outField = outFieldName(def.field, 'bin');
        mapEntries.push([channel, def, outField, binMapExpr(def.field)]);
      } else {
        if (!isSupportedTimeUnit(def.timeUnit) && !ignoreUnsupported) {
          throw new Error(`Unsupported timeUnit: "${def.timeUnit}"`);
        }
        const outField = outFieldName(def.field, def.timeUnit);
        mapEntries.push([channel, def, outField, timeUnitExpr(def.timeUnit, `d[${JSON.stringify(def.field)}]`, ignoreUnsupported)]);
      }
    }
    const assigns = mapEntries.map(([, , outField, expr]) => `${JSON.stringify(outField)}: ${expr}`);
    statements.push(`${dataVar} = ${dataVar}.map(d => ({...d, ${assigns.join(', ')}}));`);
    for (const [channel, def, outField] of mapEntries) {
      rewritten[channel] = {...def, field: outField};
      delete rewritten[channel].bin;
      // A timeUnit-derived field is a real Date object; a bin-derived one is
      // numeric (quantitative) -- Vega-Lite infers `type` the same way when
      // it's not given explicitly, so only fill it in when absent.
      if (def.timeUnit) applyTimeUnitType(rewritten, channel, def);
      else rewritten[channel].type = def.type || 'quantitative';
    }
    return {statements, encoding: rewritten};
  }

  // A genuine 2D histogram/heatmap: both x and y are binned, with a
  // `count` aggregate elsewhere (size, for a binned scatter, or color, for
  // a rect/tile heatmap) -- a real, well-defined shape (bin each axis
  // independently, then count rows per (xBin, yBin) cell), not the "extra
  // groupby channel(s) to drop" conflict below.
  const xyBinChannels = binChannels.filter(([ch]) => ch === 'x' || ch === 'y');
  const is2DBin =
    xyBinChannels.length === 2 &&
    binChannels.length === 2 &&
    aggChannels.length > 0 &&
    aggChannels.every(([, def]) => def.aggregate === 'count');
  if (is2DBin) {
    return prepare2DHistogram(xyBinChannels, aggChannels, dataVar, rewritten);
  }

  // From here on, at least one channel aggregates -- the data is being
  // summarized down to one row per group (or a single row if there's no
  // grouping channel at all).
  if (binChannels.length > 1) {
    if (!ignoreUnsupported) {
      throw new Error('Unsupported: binning more than one channel (outside the 2D-histogram case above) is not yet supported');
    }
    // Keep just the first binned channel and drop every other groupby
    // channel -- a plain histogram of that one field, rather than nothing.
    binChannels.length = 1;
    plainGroupChannels.length = 0;
    timeUnitOnlyChannels.length = 0;
  }

  if (binChannels.length === 1) {
    // 1 binned channel plus up to 2 extra plain/timeUnit groupby channels
    // (e.g. stacked_area_binned.vl.json's `color: {field: "Major Genre"}`
    // alongside its own `x: {bin: true, ...}`) -- same "0-2 groupby
    // channels" scope prepareHistogram()'s own non-binned sibling below
    // allows, now honored here too instead of silently dropped.
    let histogramGroupChannels = [...plainGroupChannels, ...timeUnitOnlyChannels];
    if (histogramGroupChannels.length > 2) {
      if (!ignoreUnsupported) {
        throw new Error('Unsupported: binning combined with more than 2 additional groupby channels is not yet supported');
      }
      histogramGroupChannels = histogramGroupChannels.slice(0, 2);
    }
    return prepareHistogram(binChannels[0], aggChannels, dataVar, rewritten, ignoreUnsupported, histogramGroupChannels);
  }

  let groupChannels = [...plainGroupChannels, ...timeUnitOnlyChannels];
  // Two different channels (e.g. `xOffset` and `color`) commonly reference
  // the exact same source field -- Vega-Lite's own convention for a
  // dodged/grouped chart, where the offset and the legend are the same
  // grouping. Grouping by it twice would both waste one of the "0-2
  // groupby channels" budget below on a redundant dimension and (since
  // d3.rollup's per-dimension key functions are keyed by *value*, not
  // channel) produce the exact same partition either way -- so only the
  // first channel referencing a given (field, timeUnit) pair actually
  // drives the rollup; every later duplicate is left with its original,
  // still-correct `field` reference below (the rollup's output column for
  // a plain groupby channel keeps the same field name it started with).
  const seenGroupKeys = new Set();
  groupChannels = groupChannels.filter(([, def]) => {
    const key = `${def.field} ${def.timeUnit || ''}`;
    if (seenGroupKeys.has(key)) return false;
    seenGroupKeys.add(key);
    return true;
  });
  if (groupChannels.length > 2) {
    if (!ignoreUnsupported) {
      throw new Error('Unsupported: aggregating grouped by more than 2 fields is not yet supported');
    }
    // Drop every groupby channel past the first two rather than refusing.
    groupChannels = groupChannels.slice(0, 2);
  }

  if (!ignoreUnsupported) {
    for (const [channel, def] of aggChannels) {
      if (def.aggregate !== 'count' && !isSupportedAggregateOp(def.aggregate)) {
        throw new Error(`Unsupported aggregate op: "${def.aggregate}"`);
      }
    }
  }

  const keyExprFor = def =>
    def.timeUnit ? timeUnitExpr(def.timeUnit, `d[${JSON.stringify(def.field)}]`, ignoreUnsupported) : `d[${JSON.stringify(def.field)}]`;

  const valueAssigns = aggChannels.map(([channel, def]) => {
    const outField = def.aggregate === 'count' ? 'count' : outFieldName(def.field, def.aggregate);
    const accessor = def.field ? `d => d[${JSON.stringify(def.field)}]` : undefined;
    return {channel, def, outField, code: aggregateExpr(def.aggregate, 'rows', accessor, ignoreUnsupported)};
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
    if (def.timeUnit) applyTimeUnitType(rewritten, channel, def);
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
    if (def1.timeUnit) applyTimeUnitType(rewritten, channel1, def1);
    rewritten[channel2] = {...def2, field: outField2};
    if (def2.timeUnit) applyTimeUnitType(rewritten, channel2, def2);
  }

  for (const {channel, def, outField} of valueAssigns) {
    rewritten[channel] = {...def, field: outField};
    delete rewritten[channel].aggregate;
    // Marks a genuinely *computed* value (as opposed to a bare position
    // field) -- marks.js's "only one of x/y present" bar dispatch uses this
    // to tell apart a real 1D aggregate (wants a zero-baseline bar) from a
    // bare, un-aggregated position (wants a reference-band/tick instead;
    // see the mirrored `aggregated` flag in vl2ggplot's plan_layer_data()).
    rewritten[channel].aggregated = true;
    // An aggregate's output is always numeric (sum/mean/count/...), whether
    // or not the *source* field had an explicit type -- fill this in when
    // missing so scales.js never sees an aggregated field with no type and
    // mistakes it for one of nominal-or-quantitative "ambiguous, need to
    // check the data at runtime" (see resolvePositionScale()).
    if (!rewritten[channel].type) rewritten[channel].type = 'quantitative';
  }

  return {statements, encoding: rewritten};
}

// A genuine 2D histogram: bin `x` and `y` independently, then count rows
// per (xBin, yBin) cell -- nesting d3.bin() (each x-bin's own row array
// gets binned again by y) does exactly this in one pass. The output row
// carries both bin edges per axis (`x`/`x2` and `y`/`y2`) so a "rect" mark
// can draw the real cell box; a "circle"/"point" mark instead centers
// itself between an axis's own edge pair (see marks.js), so no separate
// "center" field is needed here.
function prepare2DHistogram(xyBinChannels, aggChannels, dataVar, rewritten) {
  const [xEntry, yEntry] = xyBinChannels[0][0] === 'x' ? xyBinChannels : [xyBinChannels[1], xyBinChannels[0]];
  const [, xDef] = xEntry;
  const [, yDef] = yEntry;
  const xField = xDef.field;
  const yField = yDef.field;
  const xThresholds = typeof xDef.bin === 'object' && xDef.bin.maxbins ? xDef.bin.maxbins : 20;
  const yThresholds = typeof yDef.bin === 'object' && yDef.bin.maxbins ? yDef.bin.maxbins : 20;

  const outX0 = outFieldName(xField, 'bin0');
  const outX1 = outFieldName(xField, 'bin1');
  const outY0 = outFieldName(yField, 'bin0');
  const outY1 = outFieldName(yField, 'bin1');

  const statements = [
    `${dataVar} = d3.bin().value(d => d[${JSON.stringify(xField)}]).thresholds(${xThresholds})(${dataVar})` +
      `.flatMap(xBin => d3.bin().value(d => d[${JSON.stringify(yField)}]).thresholds(${yThresholds})(xBin)` +
      `.filter(yBin => yBin.length > 0)` +
      `.map(yBin => ({` +
      `${JSON.stringify(outX0)}: xBin.x0, ${JSON.stringify(outX1)}: xBin.x1, ` +
      `${JSON.stringify(outY0)}: yBin.x0, ${JSON.stringify(outY1)}: yBin.x1, ` +
      `count: yBin.length})));`,
  ];

  rewritten.x = {field: outX0, type: 'quantitative'};
  rewritten.x2 = {field: outX1, type: 'quantitative'};
  rewritten.y = {field: outY0, type: 'quantitative'};
  rewritten.y2 = {field: outY1, type: 'quantitative'};
  for (const [channel] of aggChannels) {
    rewritten[channel] = {field: 'count', type: 'quantitative'};
  }

  return {statements, encoding: rewritten};
}

function prepareHistogram([channel, def], aggChannels, dataVar, rewritten, ignoreUnsupported = false, groupChannels = []) {
  const statements = [];
  const field = def.field;
  const thresholds = typeof def.bin === 'object' && def.bin.maxbins ? def.bin.maxbins : 20;
  const binsVar = toIdentifier(dataVar, field, 'bins');
  statements.push(
    `const ${binsVar} = d3.bin().value(d => d[${JSON.stringify(field)}]).thresholds(${thresholds})(${dataVar});`
  );

  const outField0 = outFieldName(field, 'bin0');
  const outField1 = outFieldName(field, 'bin1');

  if (groupChannels.length === 0) {
    const valueAssigns = aggChannels.map(([, adef]) => {
      const outField = adef.aggregate === 'count' ? 'count' : outFieldName(adef.field, adef.aggregate);
      const accessor = adef.field ? `d => d[${JSON.stringify(adef.field)}]` : undefined;
      return {outField, code: aggregateExpr(adef.aggregate, 'bin', accessor, ignoreUnsupported)};
    });
    const valueObjectCode = valueAssigns.map(v => `${JSON.stringify(v.outField)}: ${v.code}`).join(', ');
    statements.push(
      `${dataVar} = ${binsVar}.map(bin => ({${JSON.stringify(outField0)}: bin.x0, ${JSON.stringify(outField1)}: bin.x1, ${valueObjectCode}}));`
    );
  } else {
    // 1-2 extra plain/timeUnit groupby channels alongside the bin (e.g.
    // stacked_area_binned.vl.json's own `color: {field: "Major Genre"}`,
    // stacking each rating bin by genre) -- each bin's own member rows are
    // further grouped by those channel(s), same nested-rollup shape the
    // plain (non-binned) N-groupby-channel aggregate path below uses,
    // just run once per bin instead of once over the whole dataset.
    // Previously any extra groupby channel here was simply dropped
    // (documented as unsupported), which silently collapsed every bin's
    // sub-groups into one combined row -- a stacked/grouped chart with
    // only one (wrong-totaled) series instead of one per group.
    const valueAssigns = aggChannels.map(([, adef]) => {
      const outField = adef.aggregate === 'count' ? 'count' : outFieldName(adef.field, adef.aggregate);
      const accessor = adef.field ? `d => d[${JSON.stringify(adef.field)}]` : undefined;
      return {outField, code: aggregateExpr(adef.aggregate, 'rows', accessor, ignoreUnsupported)};
    });
    const valueObjectCode = `{${valueAssigns.map(v => `${JSON.stringify(v.outField)}: ${v.code}`).join(', ')}}`;
    const keyExprFor = gdef =>
      gdef.timeUnit ? timeUnitExpr(gdef.timeUnit, `d[${JSON.stringify(gdef.field)}]`, ignoreUnsupported) : `d[${JSON.stringify(gdef.field)}]`;

    if (groupChannels.length === 1) {
      const [gChannel, gDef] = groupChannels[0];
      const gOutField = gDef.timeUnit ? outFieldName(gDef.field, gDef.timeUnit) : gDef.field;
      statements.push(
        `${dataVar} = ${binsVar}.flatMap(bin => Array.from(` +
          `d3.rollup(bin, rows => (${valueObjectCode}), d => ${keyExprFor(gDef)}), ` +
          `([key, vals]) => ({${JSON.stringify(outField0)}: bin.x0, ${JSON.stringify(outField1)}: bin.x1, ${JSON.stringify(gOutField)}: key, ...vals})));`
      );
      rewritten[gChannel] = {...gDef, field: gOutField};
      if (gDef.timeUnit) applyTimeUnitType(rewritten, gChannel, gDef);
    } else {
      const [[gChannel1, gDef1], [gChannel2, gDef2]] = groupChannels;
      const gOutField1 = gDef1.timeUnit ? outFieldName(gDef1.field, gDef1.timeUnit) : gDef1.field;
      const gOutField2 = gDef2.timeUnit ? outFieldName(gDef2.field, gDef2.timeUnit) : gDef2.field;
      statements.push(
        `${dataVar} = ${binsVar}.flatMap(bin => Array.from(` +
          `d3.rollup(bin, rows => (${valueObjectCode}), d => ${keyExprFor(gDef1)}, d => ${keyExprFor(gDef2)}), ` +
          `([k1, inner]) => Array.from(inner, ([k2, vals]) => ` +
          `({${JSON.stringify(outField0)}: bin.x0, ${JSON.stringify(outField1)}: bin.x1, ${JSON.stringify(gOutField1)}: k1, ${JSON.stringify(gOutField2)}: k2, ...vals}))).flat());`
      );
      rewritten[gChannel1] = {...gDef1, field: gOutField1};
      if (gDef1.timeUnit) applyTimeUnitType(rewritten, gChannel1, gDef1);
      rewritten[gChannel2] = {...gDef2, field: gOutField2};
      if (gDef2.timeUnit) applyTimeUnitType(rewritten, gChannel2, gDef2);
    }
  }

  rewritten[channel] = {...def, field: outField0};
  delete rewritten[channel].bin;
  rewritten[channel].binned = true;
  rewritten[`${channel}2`] = {field: outField1, type: 'quantitative'};
  for (const [aChannel, adef] of aggChannels) {
    const outField = adef.aggregate === 'count' ? 'count' : outFieldName(adef.field, adef.aggregate);
    rewritten[aChannel] = {...adef, field: outField};
    delete rewritten[aChannel].aggregate;
    if (!rewritten[aChannel].type) rewritten[aChannel].type = 'quantitative';
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
