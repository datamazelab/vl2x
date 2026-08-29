// Shared helpers for a transform (or, below, a whole mark type) whose
// logic is substantial enough that re-deriving it inline in every
// generated file would be error-prone -- mirrors `vl2d3`'s own
// `runtime.js` role exactly. Imported by name -- `import {vlStack} from
// "./vl2plot-runtime.js"` -- only when a spec actually needs it (see
// `translator.js`'s `specToCode()`).

import * as Plot from '@observablehq/plot';
import * as d3 from 'd3';

// Observable Plot has no built-in arc/pie mark at all (confirmed absent
// from its own mark index) -- this is a real one, not an approximation,
// built directly on `d3.pie()`/`d3.arc()` (the same primitives `vl2d3`'s
// own hand-built arc renderer uses) but wrapped as a genuine Plot `Mark`
// subclass rather than raw post-hoc SVG injection, specifically so it
// still gets Plot's own color-scale *and legend* resolution for free (a
// `fill` channel declared with `scale: "color"` here participates in
// exactly the same shared color scale/legend every other mark's own
// `fill`/`color` channel does).
//   - `theta` sizes each wedge (Vega-Lite's own implicit per-mark
//     `stack: true` on `theta` -- every arc mark stacks by default, so
//     this needs no separate stack step, just d3.pie()'s own running
//     partition of the input array in order).
//   - `fill` colors each wedge (omitted: a single default color).
//   - `innerRadius`/`outerRadius` (VL mark properties, not encoding
//     channels) -- `innerRadius > 0` makes a donut; `outerRadius`
//     defaults to half the smaller plot dimension.
//   - `startAngle`/`endAngle` (radians) override the default full circle
//     (0 to 2*PI) -- Vega-Lite's own equivalent is an explicit
//     `theta.scale.range` override.
//   - Row order in `data` determines stacking order (sort the data
//     array by an `order` field, if any, *before* constructing this mark
//     -- see `marks.js`'s own `renderArc()`).
export class VlArc extends Plot.Mark {
  constructor(data, options = {}) {
    const {theta, fill, title, innerRadius = 0, outerRadius = null, startAngle = 0, endAngle = 2 * Math.PI} = options;
    const channels = {theta: {value: theta, scale: null}};
    if (fill != null) channels.fill = {value: fill, scale: 'color'};
    if (title != null) channels.title = {value: title, optional: true};
    super(data, channels, options, {ariaLabel: 'arc'});
    this.innerRadius = innerRadius;
    this.outerRadius = outerRadius;
    this.startAngle = startAngle;
    this.endAngle = endAngle;
  }
  render(index, scales, values, dimensions, context) {
    const {width, height, marginTop = 0, marginRight = 0, marginBottom = 0, marginLeft = 0} = dimensions;
    const plotWidth = width - marginLeft - marginRight;
    const plotHeight = height - marginTop - marginBottom;
    const cx = marginLeft + plotWidth / 2;
    const cy = marginTop + plotHeight / 2;
    const outerRadius = this.outerRadius ?? Math.min(plotWidth, plotHeight) / 2;
    const pie = d3.pie().value(i => values.theta[i]).sort(null).startAngle(this.startAngle).endAngle(this.endAngle);
    const arcs = pie(index);
    const arcGen = d3.arc().innerRadius(this.innerRadius).outerRadius(outerRadius);
    const g = d3.select(context.document.createElementNS('http://www.w3.org/2000/svg', 'g')).attr('transform', `translate(${cx},${cy})`);
    const paths = g
      .selectAll('path')
      .data(arcs)
      .join('path')
      .attr('d', arcGen)
      .attr('fill', values.fill ? d => scales.color(values.fill[d.data]) : '#4269d1');
    if (values.title) paths.append('title').text(d => values.title[d.data]);
    return g.node();
  }
}

// Vega-Lite's *explicit* stack transform: given a value `field` and a
// `groupby` field list, computes a cumulative running sum of `field`
// within each group (ordered by `sort`, a list of `{field, order}`),
// writing the running total *before* and *after* each row as two new
// fields (`as`, either `[v1Field, v2Field]` or a single string implying
// `${as}2` for the second). This is the explicit, transform-array form of
// the exact same math Vega-Lite applies *implicitly* to a color/detail-
// grouped bar/area's own value channel -- unlike that implicit case
// (handled natively by `Plot.stackY`/`Plot.stackX`'s own `offset` option,
// see `stack.js`), the explicit transform form needs its own real
// cumulative-sum computation, since its output feeds two new *named*
// fields on the data itself rather than a mark-level wrapper.
// Vega-Lite treats a nested-object field reference like `"properties.
// variety"` as a plain (already-flat) field name, not a path to traverse --
// this flattens every row one level deep into real dotted keys so such a
// reference resolves as an ordinary property lookup (e.g. a GeoJSON-shaped
// `{"properties": {"variety": "x", ...}}` row gains a top-level
// `"properties.variety"` key alongside its own nested `properties` object,
// which is left in place too in case something else reads it directly).
export function vlFlattenOneLevel(data) {
  return data.map(row => {
    const out = {...row};
    for (const [k, v] of Object.entries(row)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2;
      }
    }
    return out;
  });
}

// Vega-Lite's `density` transform: a kernel density estimate of one
// field, replacing the data with (by default) `value`/`density` sample
// points tracing the estimated curve -- optionally one curve per
// `groupby` group. Plot has no built-in KDE, so this is a real
// (Gaussian-kernel) one, adapted from `vl2d3`'s own equivalent: genuinely
// supported, not an approximation, though (like every from-scratch KDE)
// not guaranteed bit-for-bit identical to Vega's own.
//   - `bandwidth` fixes the kernel bandwidth; omitted, a Silverman's-
//     rule-of-thumb automatic bandwidth is computed per group (R's default
//     `bw.nrd0`, the same one `vl2ggplot`'s own `stats::density()` call
//     uses).
//   - `extent` fixes the sample range; omitted, each group's own data
//     min/max is used.
//   - `steps` sets the number of evenly-spaced sample points (default
//     200, Vega-Lite's own default).
//   - `counts: true` rescales the curve so its area equals the sample
//     count instead of integrating to 1 (Vega-Lite's own definition).
function quantile(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function kdeOneGroup(rows, {field, extent, bandwidth, steps, counts, valueField, densityField}) {
  const values = rows.map(d => d[field]).filter(v => v != null && !Number.isNaN(v));
  const n = values.length;
  let bw = bandwidth;
  if (bw == null) {
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n - 1, 1));
    const sorted = values.slice().sort((a, b) => a - b);
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
    const sigma = Math.min(std, iqr / 1.34) || std || 1;
    bw = 0.9 * sigma * Math.pow(n, -0.2) || 1;
  }
  const [lo, hi] = extent || [Math.min(...values), Math.max(...values)];
  const kernel = x => Math.exp(-0.5 * (x / bw) ** 2) / (bw * Math.sqrt(2 * Math.PI));
  const mult = counts ? n : 1;
  const points = [];
  for (let i = 0; i < steps; i++) {
    const v = lo + (i * (hi - lo)) / (steps - 1);
    const density = (values.reduce((s, x) => s + kernel(v - x), 0) / n) * mult;
    points.push({[valueField]: v, [densityField]: density});
  }
  return points;
}

export function vlDensity(data, {field, groupby = [], extent = null, bandwidth = null, steps = 200, counts = false, as = ['value', 'density']}) {
  const [valueField, densityField] = as;
  const opts = {field, extent, bandwidth, steps, counts, valueField, densityField};
  if (!groupby.length) return kdeOneGroup(data, opts);

  const groups = new Map();
  for (const d of data) {
    const key = JSON.stringify(groupby.map(g => d[g]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const out = [];
  for (const [key, rows] of groups) {
    const keyVals = JSON.parse(key);
    const groupAssigns = {};
    groupby.forEach((g, i) => {
      groupAssigns[g] = keyVals[i];
    });
    for (const p of kdeOneGroup(rows, opts)) out.push({...p, ...groupAssigns});
  }
  return out;
}

export function vlStack(data, {field, groupby = [], sort = [], offset = 'zero', as}) {
  const [v1Field, v2Field] = Array.isArray(as) ? as : [as, `${as}2`];
  const keyOf = d => JSON.stringify(groupby.map(g => d[g]));

  const groups = new Map();
  for (const d of data) {
    const k = keyOf(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }

  const cmp = (a, b) => {
    for (const {field: f, order} of sort) {
      const av = a[f];
      const bv = b[f];
      if (av < bv) return order === 'descending' ? 1 : -1;
      if (av > bv) return order === 'descending' ? -1 : 1;
    }
    return 0;
  };

  const out = [];
  for (const rows of groups.values()) {
    const ordered = sort.length ? [...rows].sort(cmp) : rows;
    const total = ordered.reduce((s, d) => s + (+d[field] || 0), 0);
    let running = 0;
    for (const d of ordered) {
      const v = +d[field] || 0;
      let v1 = running;
      let v2 = running + v;
      running = v2;
      if (offset === 'normalize' && total !== 0) {
        v1 /= total;
        v2 /= total;
      } else if (offset === 'center') {
        v1 -= total / 2;
        v2 -= total / 2;
      }
      out.push({...d, [v1Field]: v1, [v2Field]: v2});
    }
  }
  return out;
}
