// Shared runtime helpers for GENERATED D3 code -- functions substantial
// enough that re-deriving them inline in every generated chart.js would be
// error-prone and hard to keep consistent are defined once here instead; a
// spec's generated code imports only the ones its translated transforms
// actually need (see RUNTIME_EXPORTS in transforms.js and the conditional
// import line in translator.js's specToCode()).
//
// This is not published as its own package -- a plain copy of this file is
// placed alongside every generated chart.js (see showcase_build/run_d3.mjs
// and vl2d3's own test harnesses), since each is written to a freshly
// created, otherwise-standalone-looking output directory. Keep exports
// here dependency-free (no `d3.*` calls) so a plain copy always works
// wherever the generated code that imports it ends up.

// Vega-Lite's `pivot` transform: for each distinct `groupby` combination,
// spread the distinct values of `field` out into their own columns, each
// holding the `op`-aggregated `value` of the matching rows. `op` defaults
// to "sum" (Vega-Lite's own default) -- rows that share both the same
// groupby combination *and* the same pivoted value combine under it via
// `op` rather than the later one silently overwriting the earlier. `limit`
// (default 0 = unlimited) keeps only the first N distinct pivoted values in
// sorted order, matching Vega-Lite's own documented bounded-pivot behavior.
export function vlPivot(rows, {field, value, groupby = [], op = 'sum', limit = 0}) {
  let pivotKeys = Array.from(new Set(rows.map(d => d[field]))).sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  if (limit > 0) pivotKeys = pivotKeys.slice(0, limit);
  const pivotKeySet = new Set(pivotKeys);

  const groupKeyOf = d => JSON.stringify(groupby.map(g => d[g]));
  const groups = new Map();
  for (const d of rows) {
    if (!pivotKeySet.has(d[field])) continue;
    const key = groupKeyOf(d);
    if (!groups.has(key)) {
      const base = {};
      for (const g of groupby) base[g] = d[g];
      for (const c of pivotKeys) base[c] = [];
      groups.set(key, base);
    }
    groups.get(key)[d[field]].push(d[value]);
  }

  const combine =
    {
      sum: vs => vs.reduce((a, b) => a + b, 0),
      mean: vs => vs.reduce((a, b) => a + b, 0) / vs.length,
      average: vs => vs.reduce((a, b) => a + b, 0) / vs.length,
      count: vs => vs.length,
      min: vs => Math.min(...vs),
      max: vs => Math.max(...vs),
      median: vs => {
        const s = [...vs].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      },
    }[op] || (vs => vs.reduce((a, b) => a + b, 0));

  return Array.from(groups.values()).map(row => {
    const out = {};
    for (const g of groupby) out[g] = row[g];
    for (const c of pivotKeys) out[c] = row[c].length ? combine(row[c]) : null;
    return out;
  });
}
