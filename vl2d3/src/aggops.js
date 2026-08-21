// Map a Vega-Lite aggregate op name to a JS expression computing it over an
// array of rows `rows`, for a given field accessor expression `d => d[field]`
// (passed in as `accessor`, e.g. `d => d.Rating`). `"count"` needs no field.
//
// Only the common statistical ops are supported; op-specific/percentile ops
// that d3-array doesn't ship a direct equivalent for (argmin/argmax, ci0/ci1,
// q1/q3, missing/valid/distinct) throw a clear error at translate time
// rather than silently emitting wrong numbers.

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
};

export function isSupportedAggregateOp(op) {
  return op in OPS;
}

export function aggregateExpr(op, rowsExpr, fieldAccessorExpr) {
  const fn = OPS[op];
  if (!fn) {
    throw new Error(
      `Unsupported aggregate op: "${op}" (supported: ${Object.keys(OPS).join(', ')})`
    );
  }
  return op === 'count' ? fn(rowsExpr) : fn(rowsExpr, fieldAccessorExpr);
}
