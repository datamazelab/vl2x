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
import {formatValue} from './literals.js';

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
  if ('density' in t) {
    return renderDensityTransform(t, dataVar);
  }
  if ('window' in t) {
    const unsupportedOp = t.window.map(w => w.op).find(op => !isSupportedWindowOp(op));
    if (unsupportedOp && !ignoreUnsupported) {
      throw new Error(`Unsupported window op: "${unsupportedOp}"`);
    }
    if (!unsupportedOp) return renderWindowTransform(t, dataVar);
    // At least one requested op has no implementation here at all (e.g.
    // percent_rank/cume_dist/ntile/first_value -- percentile/selection ops
    // with no simple direct equivalent) -- skip the whole step exactly like
    // any other wholly-unsupported transform, rather than partially
    // computing only the ops that _are_ implemented (which would silently
    // produce a data shape the rest of the chart doesn't actually expect).
    return [`// vl2d3: skipped unsupported window op "${unsupportedOp}" (--ignore-unsupported)`];
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

// Vega-Lite's `density` transform: a kernel density estimate of one field,
// replacing the data with (by default) `value`/`density` sample points
// tracing the estimated curve -- optionally one curve per `groupby` group.
// D3 has no built-in KDE, so this generates a real (Gaussian-kernel) one
// inline: genuinely supported, not an approximation, though (like
// vl2ggplot's stats::density()-based version) not guaranteed bit-for-bit
// identical to Vega's own KDE implementation.
//   - `bandwidth` maps to a fixed kernel bandwidth; omitted, a Silverman's-
//     rule-of-thumb automatic bandwidth is computed per group, mirroring
//     both Vega-Lite's and R's `density()`'s own automatic-bandwidth ideas.
//   - `extent` fixes the sample range; omitted, each group's own data
//     min/max is used.
//   - `steps` sets the number of evenly-spaced sample points (default 200,
//     Vega-Lite's own default).
//   - `counts: true` rescales the curve so its area equals the sample
//     count instead of integrating to 1 (Vega-Lite's own definition).
function renderDensityTransform(t, dataVar) {
  const field = JSON.stringify(t.density);
  const asNames = Array.isArray(t.as) && t.as.length === 2 ? t.as : ['value', 'density'];
  const valueField = JSON.stringify(asNames[0]);
  const densityField = JSON.stringify(asNames[1]);
  const steps = Number.isInteger(t.steps) ? t.steps : 200;
  const bandwidthExpr =
    t.bandwidth != null
      ? formatValue(t.bandwidth)
      : `(() => {\n` +
        `      const n = values.length;\n` +
        `      const mean = d3.mean(values);\n` +
        `      const std = Math.sqrt(d3.sum(values, v => (v - mean) ** 2) / Math.max(n - 1, 1));\n` +
        `      const sorted = values.slice().sort(d3.ascending);\n` +
        `      const iqr = d3.quantile(sorted, 0.75) - d3.quantile(sorted, 0.25);\n` +
        `      const sigma = Math.min(std, iqr / 1.34) || std || 1;\n` +
        // R's default `bw.nrd0` (Silverman's rule of thumb, the same
        // default vl2ggplot's stats::density(bw = "nrd0") call uses) --
        // 0.9x this sigma/n^(1/5) term, not the wider 1.06x "nrd"/Scott's-
        // rule variant (that coefficient under-resolves the peaks here).
        `      return (0.9 * sigma * Math.pow(n, -0.2)) || 1;\n` +
        `    })()`;
  const extentExpr = Array.isArray(t.extent) ? `[${formatValue(t.extent[0])}, ${formatValue(t.extent[1])}]` : `d3.extent(values)`;
  const countsMultiplier = t.counts ? ' * values.length' : '';

  // The body of a `rows => [...]` reducer computing the KDE sample points
  // for one group's (or the whole dataset's) rows.
  const kdeReducer =
    `rows => {\n` +
    `    const values = rows.map(d => d[${field}]).filter(v => v != null && !Number.isNaN(v));\n` +
    `    const bandwidth = ${bandwidthExpr};\n` +
    `    const [lo, hi] = ${extentExpr};\n` +
    `    const kernel = x => Math.exp(-0.5 * (x / bandwidth) ** 2) / (bandwidth * Math.sqrt(2 * Math.PI));\n` +
    `    return d3.range(${steps}).map(i => {\n` +
    `      const v = lo + (i * (hi - lo)) / (${steps} - 1);\n` +
    `      return {${valueField}: v, ${densityField}: d3.mean(values, x => kernel(v - x))${countsMultiplier}};\n` +
    `    });\n` +
    `  }`;

  if (!t.groupby || t.groupby.length === 0) {
    return [`${dataVar} = (${kdeReducer})(${dataVar});`];
  }

  const groupFields = t.groupby.map(f => JSON.stringify(f));
  const keyExpr = `d => JSON.stringify([${groupFields.map(f => `d[${f}]`).join(', ')}])`;
  const groupAssigns = t.groupby.map((f, i) => `${JSON.stringify(f)}: keyVals[${i}]`).join(', ');
  return [
    `${dataVar} = Array.from(` +
      `d3.rollup(${dataVar}, ${kdeReducer}, ${keyExpr}), ` +
      `([key, points]) => { const keyVals = JSON.parse(key); return points.map(p => ({...p, ${groupAssigns}})); }` +
      `).flat();`,
  ];
}

// Vega-Lite's `window` transform: SQL-window-function-style per-row derived
// fields, computed within `groupby` partitions ordered by `sort`. Supports:
//   - row_number/rank/dense_rank (purely positional, based on partition
//     order) and lag/lead (an earlier/later row's own value, `param` rows
//     away, defaulting to 1).
//   - sum/mean/average/count/min/max/median (a `frame`-bounded aggregate:
//     omitted/`[null, null]` -- Vega-Lite's own default -- is a
//     whole-partition aggregate broadcast to every row; `[null, 0]` is a
//     running/cumulative aggregate from the partition's start through the
//     current row; any other numeric bound is a genuine sliding window
//     `frame[0]` rows before to `frame[1]` rows after the current one).
// Percentile/selection ops with no simple direct equivalent (percent_rank,
// cume_dist, ntile, first_value/last_value/nth_value) aren't supported.
const WINDOW_POSITIONAL_OPS = ['row_number', 'rank', 'dense_rank', 'lag', 'lead'];
const WINDOW_AGGREGATE_OPS = ['sum', 'mean', 'average', 'count', 'min', 'max', 'median'];

function isSupportedWindowOp(op) {
  return WINDOW_POSITIONAL_OPS.includes(op) || WINDOW_AGGREGATE_OPS.includes(op);
}

// The rows this frame covers, as a JS slice expression over `rows` (already
// sorted into partition order), evaluated fresh for each row index `i`.
function windowFrameSliceExpr(frame) {
  const wholePartition = !frame || (frame[0] == null && frame[1] == null);
  if (wholePartition) return 'rows';
  const cumulative = frame[0] == null && frame[1] === 0;
  if (cumulative) return 'rows.slice(0, i + 1)';
  const lo = frame[0] == null ? '0' : `Math.max(0, i + (${formatValue(frame[0])}))`;
  const hi = frame[1] == null ? 'n' : `Math.min(n, i + (${formatValue(frame[1])}) + 1)`;
  return `rows.slice(${lo}, ${hi})`;
}

function windowAggregateExpr(op, field, frame) {
  const sliceExpr = windowFrameSliceExpr(frame);
  if (op === 'count') return `(${sliceExpr}).length`;
  const acc = `r => r[${JSON.stringify(field)}]`;
  const fn = {sum: 'sum', mean: 'mean', average: 'mean', min: 'min', max: 'max', median: 'median'}[op];
  return `d3.${fn}(${sliceExpr}, ${acc})`;
}

function renderWindowTransform(t, dataVar) {
  const groupby = t.groupby || [];
  const sortSpec = t.sort || [];
  const ops = t.window.map(w => w.op);

  const keyExpr =
    groupby.length > 0 ? `d => JSON.stringify([${groupby.map(f => `d[${JSON.stringify(f)}]`).join(', ')}])` : `d => 0`;

  const hasSort = sortSpec.length > 0;
  const cmpExpr = sortSpec
    .map(s => {
      const f = JSON.stringify(s.field);
      return s.order === 'descending'
        ? `(b[${f}] > a[${f}] ? 1 : b[${f}] < a[${f}] ? -1 : 0)`
        : `(a[${f}] > b[${f}] ? 1 : a[${f}] < b[${f}] ? -1 : 0)`;
    })
    .join(' || ');

  const needsTies = ops.includes('rank') || ops.includes('dense_rank');

  const lines = [];
  if (hasSort) {
    lines.push(`const cmp = (a, b) => ${cmpExpr};`);
    lines.push(`rows = rows.slice().sort(cmp);`);
  }
  lines.push(`const n = rows.length;`);
  if (needsTies) {
    if (hasSort) {
      // SQL RANK()/DENSE_RANK() semantics: a new "tie group" starts
      // wherever consecutive sorted rows differ under `cmp`; dense_rank
      // is that group's 1-based ordinal, rank is the 1-based position of
      // that group's *first* row (so tied rows share a rank, and the next
      // distinct value's rank skips past however many rows tied).
      lines.push(`let tieGroup = 0;`);
      lines.push(`const tieIds = rows.map((d, i) => { if (i > 0 && cmp(rows[i - 1], d) !== 0) tieGroup++; return tieGroup; });`);
    } else {
      // No `sort` given at all -- Vega-Lite's own window transform then
      // ranks rows in their existing (partition) order, each one strictly
      // after the last, never tied with a sibling (there's no sort key to
      // compare them by in the first place) -- e.g. a Wilkinson dot plot's
      // `{"groupby": ["x"], "window": [{"op": "rank", "as": "id"}]}` with
      // no `sort` relies on this to stack same-x points 1, 2, 3, ... rather
      // than every one of them landing on rank 1 (all "tied").
      lines.push(`const tieIds = rows.map((d, i) => i);`);
    }
  }

  const assigns = t.window.map(w => {
    const asName = JSON.stringify(w.as);
    let expr;
    if (w.op === 'row_number') {
      expr = 'i + 1';
    } else if (w.op === 'rank') {
      expr = 'tieIds.indexOf(tieIds[i]) + 1';
    } else if (w.op === 'dense_rank') {
      expr = 'tieIds[i] + 1';
    } else if (w.op === 'lag' || w.op === 'lead') {
      const param = w.param != null ? w.param : 1;
      const offset = w.op === 'lag' ? `i - ${param}` : `i + ${param}`;
      expr = `(rows[${offset}] ? rows[${offset}][${JSON.stringify(w.field)}] : null)`;
    } else {
      expr = windowAggregateExpr(w.op, w.field, t.frame);
    }
    return `${asName}: ${expr}`;
  });
  lines.push(`return rows.map((d, i) => ({...d, ${assigns.join(', ')}}));`);

  return [`${dataVar} = Array.from(d3.group(${dataVar}, ${keyExpr}).values()).flatMap(rows => {\n  ${lines.join('\n  ')}\n});`];
}
