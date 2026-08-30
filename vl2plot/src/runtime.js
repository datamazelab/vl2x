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
      // `values.fill` is already resolved to final color strings by Plot's
      // own channel machinery (a `{scale: "color"}` channel's own values
      // array holds post-scale output, not raw domain values) -- applying
      // `scales.color(...)` again here would look up an already-a-color
      // string as if it were a domain value, silently resolving to
      // nothing (confirmed empirically: every wedge rendered with no fill
      // at all, not a crash).
      .attr('fill', values.fill ? d => values.fill[d.data] : '#4269d1');
    if (values.title) paths.append('title').text(d => values.title[d.data]);
    return g.node();
  }
}

// The line connecting a `trail` mark's own row-ordered points at *variable
// width* (its own `size` channel, one line-thickness value per point) --
// Plot has no built-in mark like this at all (a plain SVG `<path
// stroke-width>` is a single constant for the whole path, no way to vary
// it along the length), so `VlTrail` builds the actual tapered ribbon
// shape directly: a closed polygon offsetting each point perpendicular to
// its own local tangent direction by that point's own half-width, one
// filled path per color group (Plot's own `x`/`y`/`r` (size) scales
// already resolve `values.x`/`values.y`/`values.size` to real pixel
// coordinates/radii by the time `render()` sees them, the same way
// `VlArc` above found for its own `theta`/`fill`).
function trailRibbonPath(pts) {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) {
    const {x, y, r} = pts[0];
    return `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`;
  }
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    // Perpendicular to the local tangent (a central-difference estimate,
    // not a true mitered join -- a good enough approximation for the
    // gentle curvature a real trail chart's own data ever has).
    const px = -dy / len;
    const py = dx / len;
    const r = pts[i].r;
    left.push([pts[i].x + px * r, pts[i].y + py * r]);
    right.push([pts[i].x - px * r, pts[i].y - py * r]);
  }
  const commands = [`M${left[0][0]},${left[0][1]}`];
  for (const [x, y] of left.slice(1)) commands.push(`L${x},${y}`);
  for (const [x, y] of right.slice().reverse()) commands.push(`L${x},${y}`);
  commands.push('Z');
  return commands.join('');
}

export class VlTrail extends Plot.Mark {
  constructor(data, options = {}) {
    const {x, y, size, stroke, title, defaultSize = 1.5} = options;
    const channels = {x: {value: x, scale: 'x'}, y: {value: y, scale: 'y'}};
    if (size != null) channels.size = {value: size, scale: 'r'};
    if (stroke != null) channels.stroke = {value: stroke, scale: 'color'};
    if (title != null) channels.title = {value: title, optional: true};
    super(data, channels, options, {ariaLabel: 'trail'});
    this.defaultSize = defaultSize;
  }
  render(index, scales, values, dimensions, context) {
    const groups = new Map();
    for (const i of index) {
      const key = values.stroke ? values.stroke[i] : '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    const g = d3.select(context.document.createElementNS('http://www.w3.org/2000/svg', 'g'));
    for (const idxs of groups.values()) {
      // Row order alone isn't reliable (matches `line`'s own "sort by the
      // domain field" convention elsewhere) -- pixel-x already reflects
      // that domain order faithfully for any monotonic (quantitative or
      // temporal) x-scale, without needing the raw field value at all.
      idxs.sort((a, b) => values.x[a] - values.x[b]);
      const pts = idxs.map(i => ({x: values.x[i], y: values.y[i], r: values.size ? values.size[i] : this.defaultSize}));
      const fill = values.stroke ? values.stroke[idxs[0]] : 'currentColor';
      const path = g.append('path').attr('d', trailRibbonPath(pts)).attr('fill', fill);
      if (values.title) path.append('title').text(values.title[idxs[0]]);
    }
    return g.node();
  }
}

// Vega-Lite's own "bar with two quantitative position channels" shape
// (e.g. `bar_qq_stack.vl.json`: `x`/`y` both `type: "quantitative"`, no
// nominal/ordinal category axis at all) -- Plot's own `Plot.barY`/`barX`
// hard-require a genuine band scale for their own category channel
// (confirmed empirically: passing an explicit `{type: "linear"}` override
// throws `"scale incompatible with channel: linear !== band"` outright),
// so neither can express this at all. Real Vega-Lite instead centers each
// bar on a real CONTINUOUS position (`xc`/`yc": {scale: "x"/"y", field:
// ...}` in its own compiled Vega output) with a small FIXED PIXEL width
// (`config.bar.continuousBandSize`, default 5px) regardless of the real
// data-space gap between values -- this mark ports that behavior
// directly: `pos` resolves through a real continuous `x`/`y` scale (a
// pixel coordinate by the time `render()` sees it, the same as any other
// channel scaled this way -- see `VlArc`'s own note on already-resolved
// channel values), and `valueStart`/`valueEnd` (already resolved through
// the OTHER axis's own scale, including whatever type it's configured
// with -- `pow`, `log`, whatever `bar_q_qpow.vl.json` itself asks for)
// bound the bar's own length; `width` is a plain constant pixel value,
// never scaled. `valueStart`/`valueEnd` are both optional -- a 1D bar with
// NO value channel at all (`bar_1d_dimension_only.vl.json`'s own shape:
// only a quantitative `y` given, no `x`) has nothing to bound the bar's
// own length by at all; real Vega-Lite's own compiled output for exactly
// this case spans the mark's own full plot width/height instead
// (`"x": {"field": {"group": "width"}}, "x2": {"value": 0}` -- ported
// directly here too via `dimensions`, the one thing `render()` receives
// that a per-row channel value can't express).
export class VlQBar extends Plot.Mark {
  constructor(data, options = {}) {
    const {pos, valueStart, valueEnd, fill, title, orientation = 'vertical', width = 5} = options;
    const posScale = orientation === 'vertical' ? 'x' : 'y';
    const valueScale = orientation === 'vertical' ? 'y' : 'x';
    const channels = {pos: {value: pos, scale: posScale}};
    if (valueStart != null) channels.valueStart = {value: valueStart, scale: valueScale};
    if (valueEnd != null) channels.valueEnd = {value: valueEnd, scale: valueScale};
    if (fill != null) channels.fill = {value: fill, scale: 'color'};
    if (title != null) channels.title = {value: title, optional: true};
    super(data, channels, options, {ariaLabel: 'bar'});
    this.width = width;
    this.orientation = orientation;
  }
  render(index, scales, values, dimensions, context) {
    const g = d3.select(context.document.createElementNS('http://www.w3.org/2000/svg', 'g'));
    const halfWidth = this.width / 2;
    const hasValue = values.valueStart != null;
    const fullLo = this.orientation === 'vertical' ? dimensions.marginTop : dimensions.marginLeft;
    const fullHi = this.orientation === 'vertical' ? dimensions.height - dimensions.marginBottom : dimensions.width - dimensions.marginRight;
    for (const i of index) {
      const p = values.pos[i];
      const lo = hasValue ? Math.min(values.valueStart[i], values.valueEnd[i]) : fullLo;
      const len = hasValue ? Math.abs(values.valueEnd[i] - values.valueStart[i]) : fullHi - fullLo;
      const fill = values.fill ? values.fill[i] : 'currentColor';
      const rect =
        this.orientation === 'vertical'
          ? g.append('rect').attr('x', p - halfWidth).attr('y', lo).attr('width', this.width).attr('height', len)
          : g.append('rect').attr('x', lo).attr('y', p - halfWidth).attr('width', len).attr('height', this.width);
      rect.attr('fill', fill);
      if (values.title) rect.append('title').text(values.title[i]);
    }
    return g.node();
  }
}

// Vega-Lite's `xOffset`/`yOffset` with a genuinely QUANTITATIVE field (not
// the far more common categorical "dodge" case, see catChannelPairs() in
// marks.js) is a real, distinct shape -- confirmed against the real
// compiler's own output for bar_ranged_offset_quantitative.vl.json: the
// offset channel gets its own LINEAR scale (domain: the field's own real
// min/max, NOT forced through zero; range: `[0, bandwidth(outer-category-
// scale)]`), and the bar's own position on that axis is `outerBand(cat) +
// offsetScale(value)`, with a small FIXED thickness (confirmed empirically
// against the real compiler's own resolved output: exactly 18px,
// regardless of the outer band's own size) rather than a value-driven
// zero-baseline length. The OTHER position channel (`x`, in that same
// spec) is a completely ordinary band category, unaffected by any of
// this. Needs a custom mark because Plot has no "sub-position within a
// band via a second, nested scale" concept of its own; the outer
// category's own scale is still Plot's real 'x'/'y' band scale (declared
// with an explicit `{type: 'band'}` at the top-level Plot.plot() options
// specifically so it exposes a real, resolvable `.bandwidth()` inside
// this mark's own render() -- confirmed empirically that Plot infers a
// zero-width 'point' scale instead, silently, whenever nothing else on
// the plot establishes band-ness).
export class VlOffsetBar extends Plot.Mark {
  constructor(data, options = {}) {
    const {plainCh, plainCat, offsetCh, offsetCat, offsetValue, offsetDomain, fill, title, size = 18} = options;
    const channels = {
      plainCat: {value: plainCat, scale: plainCh},
      offsetCat: {value: offsetCat, scale: offsetCh},
      offsetValue: {value: offsetValue},
    };
    if (fill != null) channels.fill = {value: fill, scale: 'color'};
    if (title != null) channels.title = {value: title, optional: true};
    super(data, channels, options, {ariaLabel: 'bar'});
    this.plainCh = plainCh;
    this.offsetCh = offsetCh;
    this.offsetDomain = offsetDomain;
    this.size = size;
  }
  render(index, scales, values, dimensions, context) {
    const g = d3.select(context.document.createElementNS('http://www.w3.org/2000/svg', 'g'));
    const plainBandwidth = typeof scales[this.plainCh].bandwidth === 'function' ? scales[this.plainCh].bandwidth() : 0;
    const outerBandwidth = typeof scales[this.offsetCh].bandwidth === 'function' ? scales[this.offsetCh].bandwidth() : 0;
    const [lo, hi] = this.offsetDomain;
    const span = hi - lo || 1;
    const thickness = Math.min(this.size, outerBandwidth || this.size);
    for (const i of index) {
      const plainStart = values.plainCat[i];
      const outerStart = values.offsetCat[i];
      const subPos = ((values.offsetValue[i] - lo) / span) * outerBandwidth;
      const fill = values.fill ? values.fill[i] : 'currentColor';
      const rect =
        this.plainCh === 'x'
          ? g
              .append('rect')
              .attr('x', plainStart)
              .attr('width', plainBandwidth)
              .attr('y', outerStart + subPos)
              .attr('height', thickness)
          : g
              .append('rect')
              .attr('y', plainStart)
              .attr('height', plainBandwidth)
              .attr('x', outerStart + subPos)
              .attr('width', thickness);
      rect.attr('fill', fill);
      if (values.title) rect.append('title').text(values.title[i]);
    }
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

// Vega-Lite's `flatten` transform: explodes each row into N rows, one per
// element of the named array field(s) (multiple fields are zipped
// together by index, per VL's own documented behavior; a row whose
// array(s) don't reach length N gets `undefined` for the shorter one(s)
// past their own end) -- every other, non-flattened field is copied
// through unchanged onto each new row. A row with no array at all in any
// listed field (length 0) passes through as a single unchanged row rather
// than disappearing.
//
// Unlike `vlFlattenOneLevel()` above (a completely different feature this
// shares a name with only by English-language coincidence, not a Vega-
// Lite one -- that one runs once, up front, on freshly-loaded data, to
// make an *already*-nested object field's own sub-properties reachable by
// a plain dotted key) this is the real `"flatten": [...]` transform verb:
// an ARRAY field explodes into rows, and each new row's own copy of that
// field becomes one array ELEMENT (typically itself a nested object,
// e.g. vconcat_flatten.vl.json's own `"lc": [{"time":1,"mag":18.5}, ...]`
// exploding into one row per `{time, mag}` pair) -- not a flat scalar.
// Downstream encoding channels referencing a dotted path into that
// per-row object (`"lc.time"`) need it flattened into a real key the
// exact same way `vlFlattenOneLevel()` already does for ordinary nested
// data, so that exact same one-level dotted-key expansion is applied
// directly to each newly exploded row here, rather than requiring a
// second, separate flattening pass over the whole (now much larger)
// result afterward.
export function vlFlatten(data, {fields, as}) {
  const outNames = Array.isArray(as) && as.length === fields.length ? as : fields;
  const out = [];
  for (const row of data) {
    const n = Math.max(0, ...fields.map(f => (Array.isArray(row[f]) ? row[f].length : 0)));
    if (n === 0) {
      out.push(row);
      continue;
    }
    for (let i = 0; i < n; i++) {
      const newRow = {...row};
      fields.forEach((f, j) => {
        newRow[outNames[j]] = Array.isArray(row[f]) ? row[f][i] : undefined;
      });
      for (const name of outNames) {
        const v = newRow[name];
        if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
          for (const [k2, v2] of Object.entries(v)) newRow[`${name}.${k2}`] = v2;
        }
      }
      out.push(newRow);
    }
  }
  return out;
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

// Vega-Lite's `window` transform: SQL-window-function-style per-row
// derived fields, computed within `groupby` partitions ordered by `sort`.
// Self-contained (unlike `vl2d3`'s own equivalent, adapted from here,
// which builds on `d3.group`/`d3.sum`/etc. -- Plot's own dependency on
// `d3` already covers this project's needs elsewhere, but this doesn't
// need it at all). Supports:
//   - `row_number`/`rank`/`dense_rank` (purely positional, based on
//     partition order) and `lag`/`lead` (an earlier/later row's own
//     value, `param` rows away, defaulting to 1).
//   - `sum`/`mean`/`average`/`count`/`min`/`max`/`median`/`distinct` (a
//     `frame`-bounded aggregate: omitted/`[null, null]` -- Vega-Lite's own
//     default -- is a whole-partition aggregate broadcast to every row;
//     `[null, 0]` is a running/cumulative aggregate from the partition's
//     start through the current row; any other numeric bound is a genuine
//     sliding window `frame[0]` rows before to `frame[1]` rows after the
//     current one).
// Percentile/selection ops with no simple direct equivalent
// (percent_rank, cume_dist, ntile, first_value/last_value/nth_value)
// aren't supported.
function windowFrameSlice(rows, i, frame) {
  const n = rows.length;
  const wholePartition = !frame || (frame[0] == null && frame[1] == null);
  if (wholePartition) return rows;
  const cumulative = frame[0] == null && frame[1] === 0;
  if (cumulative) return rows.slice(0, i + 1);
  const lo = frame[0] == null ? 0 : Math.max(0, i + frame[0]);
  const hi = frame[1] == null ? n : Math.min(n, i + frame[1] + 1);
  return rows.slice(lo, hi);
}

function windowAggregate(op, field, rows, i, frame) {
  const slice = windowFrameSlice(rows, i, frame);
  if (op === 'count') return slice.length;
  if (op === 'distinct') return new Set(slice.map(r => r[field])).size;
  const values = slice.map(r => r[field]).filter(v => v != null && !Number.isNaN(v));
  if (!values.length) return null;
  if (op === 'sum') return values.reduce((a, b) => a + b, 0);
  if (op === 'mean' || op === 'average') return values.reduce((a, b) => a + b, 0) / values.length;
  if (op === 'min') return Math.min(...values);
  if (op === 'max') return Math.max(...values);
  if (op === 'median') {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return null;
}

export function vlWindow(data, {window, groupby = [], sort = [], frame = null}) {
  const keyOf = groupby.length ? d => JSON.stringify(groupby.map(g => d[g])) : () => '';
  const groups = new Map();
  for (const d of data) {
    const k = keyOf(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const cmp = sort.length
    ? (a, b) => {
        for (const {field, order} of sort) {
          const av = a[field];
          const bv = b[field];
          if (av < bv) return order === 'descending' ? 1 : -1;
          if (av > bv) return order === 'descending' ? -1 : 1;
        }
        return 0;
      }
    : null;
  const needsTies = window.some(w => w.op === 'rank' || w.op === 'dense_rank');

  const out = [];
  for (let rows of groups.values()) {
    if (cmp) rows = rows.slice().sort(cmp);
    const n = rows.length;
    let tieIds = null;
    if (needsTies) {
      if (cmp) {
        // SQL RANK()/DENSE_RANK() semantics: a new "tie group" starts
        // wherever consecutive sorted rows differ under `cmp`; dense_rank
        // is that group's 1-based ordinal, rank is the 1-based position
        // of that group's *first* row (so tied rows share a rank, and the
        // next distinct value's rank skips past however many rows tied).
        let tieGroup = 0;
        tieIds = rows.map((d, i) => {
          if (i > 0 && cmp(rows[i - 1], d) !== 0) tieGroup++;
          return tieGroup;
        });
      } else {
        // No `sort` given at all -- Vega-Lite's own window transform then
        // ranks rows in their existing (partition) order, each one
        // strictly after the last, never tied with a sibling.
        tieIds = rows.map((d, i) => i);
      }
    }
    for (let i = 0; i < n; i++) {
      const assigns = {};
      for (const w of window) {
        let value;
        if (w.op === 'row_number') value = i + 1;
        else if (w.op === 'rank') value = tieIds.indexOf(tieIds[i]) + 1;
        else if (w.op === 'dense_rank') value = tieIds[i] + 1;
        else if (w.op === 'lag' || w.op === 'lead') {
          const param = w.param != null ? w.param : 1;
          const offset = w.op === 'lag' ? i - param : i + param;
          value = rows[offset] ? rows[offset][w.field] : null;
        } else {
          value = windowAggregate(w.op, w.field, rows, i, frame);
        }
        assigns[w.as] = value;
      }
      out.push({...rows[i], ...assigns});
    }
  }
  return out;
}

// Vega-Lite's inline `aggregate: {"argmax": field}`/`{"argmin": field}`
// encoding-channel shorthand: within each `groupby` partition, keeps only
// the one row where `compareField` is greatest (`mode: "max"`) or least
// (`mode: "min"`) -- every other aggregate-bearing channel on the same
// mark then reads one of that winning row's own (already real) fields
// directly (see `translator.js`'s own `planArgAggregate()`/
// `stripResolvedAggregates()`, which strip the `aggregate` property back
// off once this has run, since a single-row group's own aggregate of
// anything is just that row's own value).
export function vlArgAggregate(data, {compareField, mode, groupby = []}) {
  const keyOf = groupby.length ? d => JSON.stringify(groupby.map(g => d[g])) : () => '';
  const groups = new Map();
  for (const d of data) {
    const k = keyOf(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const better = mode === 'min' ? (a, b) => a < b : (a, b) => a > b;
  const out = [];
  for (const rows of groups.values()) {
    let best = rows[0];
    for (const r of rows) {
      if (better(r[compareField], best[compareField])) best = r;
    }
    out.push(best);
  }
  return out;
}

// A wrapped facet's own distinct values, in the order its panels should
// actually be drawn -- `groupField`'s own distinct values, sorted either
// by their own natural value (no `sortField`, e.g. a plain `sort:
// "descending"`/absent sort) or by an aggregate reduced from `sortField`
// within each group (a `sort: {op, field}` def, e.g. trellis_barley.vl
// .json's own `sort: {op: "median", field: "yield"}` -- one site's own
// panels ordered by that site's own median yield, not by the site name
// itself). Used by a wrapped `encoding.facet` (no `row`/`column` split) --
// Plot has no native "wrap N panels per row from one field" facet mode of
// its own (only a strict 2-axis `fx` x `fy` grid), so that case is
// rendered as N independent `Plot.plot()` calls instead (translator.js),
// one per value this function returns, laid out in a real CSS grid.
export function vlFacetSortValues(rows, {groupField, sortField, op = 'mean', order = 'ascending'}) {
  const groups = new Map();
  for (const r of rows) {
    const k = r[groupField];
    if (!groups.has(k)) groups.set(k, sortField !== undefined ? [] : k);
    if (sortField !== undefined) groups.get(k).push(r[sortField]);
  }
  const reduce =
    {
      count: vs => vs.length,
      sum: vs => vs.reduce((a, b) => a + b, 0),
      mean: vs => vs.reduce((a, b) => a + b, 0) / vs.length,
      average: vs => vs.reduce((a, b) => a + b, 0) / vs.length,
      median: vs => {
        const s = [...vs].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      },
      min: vs => Math.min(...vs),
      max: vs => Math.max(...vs),
    }[op] || (vs => vs.reduce((a, b) => a + b, 0) / vs.length);
  const entries = Array.from(groups, ([key, vs]) => [key, sortField !== undefined ? reduce(vs) : key]);
  entries.sort((a, b) => (a[1] > b[1] ? 1 : a[1] < b[1] ? -1 : 0));
  if (order === 'descending') entries.reverse();
  return entries.map(([key]) => key);
}

// Vega-Lite's `config.mark.minBandSize`/`config.<mark-type>.minBandSize`
// (default 0.25px): a bar/tick's own band-scale-computed width/height is
// clamped to never go BELOW this minimum, keeping it visible even when an
// extreme category count leaves each one an almost-zero-width sliver
// (confirmed against the real compiler's own output for
// bar_grouped_thin.vl.json: `"width": {"signal": "max(0.25,
// bandwidth('xOffset'))"}`). Plot has no equivalent clamp of its own --
// confirmed empirically that a `Plot.barY` mark whose own dodge/offset
// scale computes a sub-pixel bandwidth renders a literal `width="0"`, not
// a barely-visible sliver -- so this widens (or heightens) every
// already-rendered `<rect>` matching `className` back up to `minSize`,
// re-centering it on its own original midpoint (the same center-
// preserving clamp the real compiler's own `spacingAndSizeOffset` logic
// applies) so the fix-up never shifts a bar's own apparent position, only
// its size.
export function vlApplyMinBandSize(node, {className, dimension, minSize}) {
  const posAttr = dimension === 'width' ? 'x' : 'y';
  // Plot renders `className` onto the mark's own enclosing `<g>` (e.g.
  // `<g aria-label="bar" class="...">`), not onto each individual
  // `<rect>` -- confirmed empirically.
  for (const rect of node.querySelectorAll(`g.${className} rect`)) {
    const size = Number(rect.getAttribute(dimension));
    if (!(size < minSize)) continue;
    const pos = Number(rect.getAttribute(posAttr));
    rect.setAttribute(dimension, String(minSize));
    rect.setAttribute(posAttr, String(pos - (minSize - size) / 2));
  }
  return node;
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
