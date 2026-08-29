// Map a Vega-Lite aggregate op name to one of Observable Plot's own built-in
// reducer *names* (a plain string Plot.groupX/Plot.binX/etc accept directly
// as an output-channel value, e.g. `Plot.groupX({y: "mean"}, {x: "a", y: "b"})`)
// -- unlike `vl2d3`'s own aggops.js (which has to hand-write a d3-array
// expression for every op, since D3 has no built-in "reduce this group of
// rows" concept at all), Plot already ships nearly this exact vocabulary of
// reducers, so this module is a thin rename table rather than real
// translation work.

// Plot's own documented reducer names (Plot.groupX/binX/etc's own output
// channel shorthand). Percentiles are Plot's own "p25"/"p50"/"p75"/...
// convention (any 2-digit percentile is valid; only the ones Vega-Lite's
// own aggregate op vocabulary names directly are mapped below).
const OPS = {
  count: 'count',
  sum: 'sum',
  mean: 'mean',
  average: 'mean',
  median: 'median',
  min: 'min',
  max: 'max',
  mode: 'mode',
  variance: 'variance',
  stdev: 'deviation',
  distinct: 'distinct',
  q1: 'p25',
  q3: 'p75',
};

export function isSupportedAggregateOp(op) {
  return op in OPS;
}

// Returns Plot's own reducer name for `op`, or (under `ignoreUnsupported`) a
// reasonable numeric stand-in ("mean") with an explanatory comment appended
// by the caller -- ops with no Plot-native equivalent at all (variancep,
// stdevp, sum2, argmin/argmax -- a *row* lookup, not a value reducer Plot's
// own group/bin transforms have any way to express inline -- valid/missing,
// ci0/ci1) fall back the same way `vl2d3`'s own aggregateExpr() does. The
// top-level `transform: [{"aggregate": ...}]` form (aggregateExpr() below)
// is a separate code path operating on a materialized array, and does
// support argmin/argmax there.
export function plotReducer(op, ignoreUnsupported = false) {
  const reducer = OPS[op];
  if (reducer) return reducer;
  if (ignoreUnsupported) return 'mean';
  throw new Error(`Unsupported aggregate op: "${op}" (supported: ${Object.keys(OPS).join(', ')})`);
}

// For a top-level `transform: [{"aggregate": [...]}]` step (as opposed to
// an inline per-channel `aggregate`, handled by `plotReducer()` above via a
// Plot transform wrapper): this runs entirely at the *data* level, before
// any mark/Plot.plot() involvement at all, so it needs a real d3-array
// expression the same way `vl2d3`'s own aggops.js does -- there's no Plot
// call to hand a reducer *name* to here.
const D3_OPS = {
  count: rows => `${rows}.length`,
  sum: (rows, acc) => `d3.sum(${rows}, ${acc})`,
  mean: (rows, acc) => `d3.mean(${rows}, ${acc})`,
  average: (rows, acc) => `d3.mean(${rows}, ${acc})`,
  median: (rows, acc) => `d3.median(${rows}, ${acc})`,
  min: (rows, acc) => `d3.min(${rows}, ${acc})`,
  max: (rows, acc) => `d3.max(${rows}, ${acc})`,
  variance: (rows, acc) => `d3.variance(${rows}, ${acc})`,
  variancep: (rows, acc) => `d3.variance(${rows}, ${acc})`,
  stdev: (rows, acc) => `d3.deviation(${rows}, ${acc})`,
  stdevp: (rows, acc) => `d3.deviation(${rows}, ${acc})`,
  sum2: (rows, acc) => `d3.sum(${rows}, ${acc})`,
  q1: (rows, acc) => `d3.quantile(${rows}, 0.25, ${acc})`,
  q3: (rows, acc) => `d3.quantile(${rows}, 0.75, ${acc})`,
  distinct: (rows, acc) => `new Set(${rows}.map(${acc})).size`,
  valid: (rows, acc) => `${rows}.map(${acc}).filter(v => v != null && !Number.isNaN(v)).length`,
  missing: (rows, acc) => `${rows}.map(${acc}).filter(v => v == null || Number.isNaN(v)).length`,
  // Unlike every other op above (which reduces to a single *value*),
  // argmax/argmin return the whole matching *row* -- the row whose own
  // field the accessor reads is greatest/least within the group. A
  // downstream encoding channel then references one of that row's own
  // other fields via Vega-Lite's own bracket-index convention (e.g.
  // `argmax_US_Gross['Production Budget']`), flattened into a real plain
  // field by `flattenBracketFields()` in translator.js before any mark/
  // scale code ever sees it.
  argmax: (rows, acc) => `${rows}.reduce((best, r) => (best === null || (${acc})(r) > (${acc})(best)) ? r : best, null)`,
  argmin: (rows, acc) => `${rows}.reduce((best, r) => (best === null || (${acc})(r) < (${acc})(best)) ? r : best, null)`,
};

export function isSupportedD3AggregateOp(op) {
  return op in D3_OPS;
}

export function aggregateExpr(op, rowsExpr, fieldAccessorExpr, ignoreUnsupported = false) {
  const fn = D3_OPS[op];
  if (!fn) {
    if (ignoreUnsupported) {
      return `${D3_OPS.mean(rowsExpr, fieldAccessorExpr)} /* vl2plot: unsupported aggregate op "${op}", using mean instead (--ignore-unsupported) */`;
    }
    throw new Error(`Unsupported aggregate op: "${op}" (supported: ${Object.keys(D3_OPS).join(', ')})`);
  }
  return op === 'count' ? fn(rowsExpr) : fn(rowsExpr, fieldAccessorExpr);
}
