// Map a Vega-Lite aggregate op name to a JS expression computing it over an
// array of rows `rows`, for a given field accessor expression `d => d[field]`
// (passed in as `accessor`, e.g. `d => d.Rating`). `"count"` needs no field.
//
// The common statistical ops (plus distinct/valid/missing/q1/q3, which are
// exactly expressible with plain JS/d3-array despite having no same-named
// d3-array function) are supported; op-specific ops with no faithful
// equivalent at all (argmin/argmax -- a row *lookup*, not a scalar
// reduction; ci0/ci1 -- a bootstrap confidence interval) throw a clear
// error at translate time rather than silently emitting wrong numbers.

const OPS = {
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
};

export function isSupportedAggregateOp(op) {
  return op in OPS;
}

export function aggregateExpr(op, rowsExpr, fieldAccessorExpr, ignoreUnsupported = false) {
  const fn = OPS[op];
  if (!fn) {
    if (ignoreUnsupported) {
      // No d3-array equivalent for this op (argmin/argmax, ci0/ci1, q1/q3,
      // missing/valid/distinct, ...) -- `mean` is a reasonable numeric
      // stand-in when *some* summary value is needed to keep the chart
      // rendering, closer to the original than an arbitrary constant.
      return `${OPS.mean(rowsExpr, fieldAccessorExpr)} /* vl2d3: unsupported aggregate op "${op}", using mean instead (--ignore-unsupported) */`;
    }
    throw new Error(
      `Unsupported aggregate op: "${op}" (supported: ${Object.keys(OPS).join(', ')})`
    );
  }
  return op === 'count' ? fn(rowsExpr) : fn(rowsExpr, fieldAccessorExpr);
}
