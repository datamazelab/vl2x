import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderSpec} from './helpers.js';

// Axis chrome (the domain path, tick lines) also renders <path>/<line>
// elements, so mark-drawn shapes must be queried excluding those.
const marksOf = (document, selector) =>
  [...document.querySelectorAll(selector)].filter(el => !el.classList.contains('domain') && !el.closest('.tick'));

test('bar chart: nominal x, quantitative y', async () => {
  const {document} = await renderSpec({
    data: {values: [{a: 'A', b: 28}, {a: 'B', b: 55}, {a: 'C', b: 43}]},
    mark: 'bar',
    encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}},
  });
  assert.equal(document.querySelectorAll('rect').length, 3);
  assert.equal(document.querySelectorAll('.tick').length > 0, true);
});

test('bar chart: inline count aggregate', async () => {
  const {document} = await renderSpec({
    data: {values: [{cat: 'x'}, {cat: 'x'}, {cat: 'y'}]},
    mark: 'bar',
    encoding: {
      x: {field: 'cat', type: 'nominal'},
      y: {aggregate: 'count', type: 'quantitative'},
    },
  });
  const rects = [...document.querySelectorAll('rect')];
  assert.equal(rects.length, 2);
  // Two rows of cat "x" should produce a taller bar than the single "y" row.
  const heights = rects.map(r => Number(r.getAttribute('height'))).sort((a, b) => a - b);
  assert.ok(heights[1] > heights[0]);
});

test('bar chart: inline mean aggregate grouped by one field', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', v: 1}, {g: 'a', v: 3}, {g: 'b', v: 10}]},
    mark: 'bar',
    encoding: {
      x: {field: 'g', type: 'nominal'},
      y: {field: 'v', aggregate: 'mean', type: 'quantitative'},
    },
  });
  assert.equal(document.querySelectorAll('rect').length, 2);
});

test('histogram: bin + count', async () => {
  const values = Array.from({length: 50}, (_, i) => ({x: i}));
  const {document} = await renderSpec({
    data: {values},
    mark: 'bar',
    encoding: {
      x: {field: 'x', bin: true, type: 'quantitative'},
      y: {aggregate: 'count', type: 'quantitative'},
    },
  });
  assert.ok(document.querySelectorAll('rect').length > 1);
});

test('scatter plot with color', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 2, c: 'A'}, {x: 2, y: 3, c: 'B'}, {x: 3, y: 1, c: 'A'}]},
    mark: 'point',
    encoding: {
      x: {field: 'x', type: 'quantitative'},
      y: {field: 'y', type: 'quantitative'},
      color: {field: 'c', type: 'nominal'},
    },
  });
  const circles = [...document.querySelectorAll('circle')];
  assert.equal(circles.length, 3);
  const fills = new Set(circles.map(c => c.getAttribute('fill')));
  assert.equal(fills.size, 2);
  // legend swatches
  assert.equal(document.querySelectorAll('rect').length, 2);
});

test('single-series line chart', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 2}, {x: 2, y: 3}, {x: 3, y: 1}]},
    mark: 'line',
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}},
  });
  assert.equal(marksOf(document, 'path').length, 1);
});

test('multi-series line chart grouped by color', async () => {
  const {document} = await renderSpec({
    data: {
      values: [
        {x: 1, y: 2, s: 'A'}, {x: 2, y: 3, s: 'A'},
        {x: 1, y: 5, s: 'B'}, {x: 2, y: 4, s: 'B'},
      ],
    },
    mark: 'line',
    encoding: {
      x: {field: 'x', type: 'quantitative'},
      y: {field: 'y', type: 'quantitative'},
      color: {field: 's', type: 'nominal'},
    },
  });
  assert.equal(marksOf(document, 'path').length, 2);
});

test('area chart', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 2}, {x: 2, y: 3}, {x: 3, y: 1}]},
    mark: 'area',
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}},
  });
  assert.equal(marksOf(document, 'path').length, 1);
});

test('arc (pie) chart', async () => {
  const {document} = await renderSpec({
    data: {values: [{cat: 'a', v: 10}, {cat: 'b', v: 20}, {cat: 'c', v: 30}]},
    mark: 'arc',
    encoding: {theta: {field: 'v', type: 'quantitative'}, color: {field: 'cat', type: 'nominal'}},
  });
  assert.equal(document.querySelectorAll('path').length, 3);
});

test('rule mark (reference line)', async () => {
  const {document} = await renderSpec({
    data: {values: [{y: 5}]},
    mark: 'rule',
    encoding: {y: {field: 'y', type: 'quantitative'}},
  });
  assert.equal(marksOf(document, 'line').length, 1);
});

test('text mark', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 1, label: 'hi'}]},
    mark: 'text',
    encoding: {
      x: {field: 'x', type: 'quantitative'},
      y: {field: 'y', type: 'quantitative'},
      text: {field: 'label', type: 'nominal'},
    },
  });
  const text = [...document.querySelectorAll('text')].find(t => t.textContent === 'hi');
  assert.ok(text);
});

test('filter transform', async () => {
  const {document} = await renderSpec({
    data: {values: [{a: 'A', b: 1}, {a: 'B', b: 2}, {a: 'C', b: 3}]},
    transform: [{filter: 'datum.b > 1'}],
    mark: 'bar',
    encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}},
  });
  assert.equal(document.querySelectorAll('rect').length, 2);
});

test('calculate transform', async () => {
  const {document, code} = await renderSpec({
    data: {values: [{a: 'A', b: 2}]},
    transform: [{calculate: 'datum.b * 10', as: 'b10'}],
    mark: 'bar',
    encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b10', type: 'quantitative'}},
  });
  assert.match(code, /b \* 10/);
  assert.equal(document.querySelectorAll('rect').length, 1);
});

test('top-level aggregate transform', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', v: 1}, {g: 'a', v: 3}, {g: 'b', v: 10}]},
    transform: [{aggregate: [{op: 'sum', field: 'v', as: 'total'}], groupby: ['g']}],
    mark: 'bar',
    encoding: {x: {field: 'g', type: 'nominal'}, y: {field: 'total', type: 'quantitative'}},
  });
  assert.equal(document.querySelectorAll('rect').length, 2);
});

test('pivot transform', async () => {
  const {document, code} = await renderSpec({
    data: {
      values: [
        {date: '2020-01-01', symbol: 'A', price: 1},
        {date: '2020-01-01', symbol: 'B', price: 2},
        {date: '2020-01-02', symbol: 'A', price: 3},
        {date: '2020-01-02', symbol: 'B', price: 4},
      ],
    },
    transform: [{pivot: 'symbol', value: 'price', groupby: ['date']}],
    mark: 'line',
    encoding: {x: {field: 'date', type: 'nominal'}, y: {field: 'A', type: 'quantitative'}},
  });
  assert.match(code, /from "\.\/vl2d3-runtime\.js"/);
  assert.match(code, /vlPivot\(/);
  assert.equal(marksOf(document, 'path').length, 1);
});

test('layered bar + rule sharing scales', async () => {
  const {document} = await renderSpec({
    data: {values: [{a: 'A', b: 10}, {a: 'B', b: 20}]},
    layer: [
      {mark: 'bar', encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}}},
      {mark: 'rule', encoding: {y: {field: 'b', type: 'quantitative', aggregate: 'mean'}}},
    ],
  });
  assert.equal(document.querySelectorAll('rect').length, 2);
  assert.equal(marksOf(document, 'line').length, 1);
});

test('temporal x-axis', async () => {
  const {document} = await renderSpec({
    data: {values: [{d: '2020-01-01', v: 1}, {d: '2021-01-01', v: 2}]},
    mark: 'line',
    encoding: {x: {field: 'd', type: 'temporal'}, y: {field: 'v', type: 'quantitative'}},
  });
  assert.equal(marksOf(document, 'path').length, 1);
});

test('a trail mark renders a real variable-width ribbon, not a constant-width line', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 10, size: 2}, {x: 2, y: 20, size: 20}, {x: 3, y: 15, size: 2}]},
    mark: 'trail',
    encoding: {
      x: {field: 'x', type: 'quantitative'},
      y: {field: 'y', type: 'quantitative'},
      size: {field: 'size', type: 'quantitative'},
    },
  });
  const [path] = marksOf(document, 'path');
  assert.ok(path);
  const d = path.getAttribute('d');
  // A real ribbon (vlTrailPath, runtime.js) draws one closed sub-path per
  // consecutive point pair -- "M...L...A...L...A...Z" repeated -- not a
  // single constant-width stroked line; 3 points means 2 segments, so 2
  // "Z" (closePath) commands.
  assert.equal((d.match(/Z/g) || []).length, 2, `expected 2 closed ribbon segments (3 points), got: ${d}`);
  // The middle point's own size (20) is far larger than either
  // neighbor's (2), so the ribbon's own perpendicular half-width there --
  // read directly off the arc radius vega-scenegraph's own algorithm
  // emits at each point -- should be visibly larger too.
  const radii = [...d.matchAll(/A([\d.]+),\1/g)].map(m => Number(m[1]));
  assert.ok(radii.length >= 3, `expected at least 3 arc radii, got: ${d}`);
  assert.ok(Math.max(...radii) > Math.min(...radii) * 2, 'expected the middle (large-size) point to have a visibly larger radius than the small-size ends');
});

test('a faceted, stacked bar chart computes its shared domain from the stacked total, not raw per-row values', async () => {
  const {vegaLiteToD3Code} = await import('../src/index.js');
  // A raw "yield" reading (1-10) has nothing to do with a bar's own real
  // length once every row for a given (variety, site) collapses into one
  // summed value, further summed again across every site sharing that
  // variety (the real stacked total) -- confirmed against
  // trellis_stacked_bar.vl.json to previously produce a shared domain
  // based on individual readings, making every bar run far past it
  // (visually indistinguishable from an accidental "normalize" stack).
  const code = vegaLiteToD3Code(
    {
      facet: {field: 'year', type: 'nominal'},
      spec: {
        data: {values: []},
        mark: 'bar',
        encoding: {
          x: {field: 'yield', type: 'quantitative', aggregate: 'sum'},
          y: {field: 'variety', type: 'nominal'},
          color: {field: 'site', type: 'nominal'},
        },
      },
    },
    {ignoreUnsupported: true}
  );
  assert.match(code, /d3\.rollup\(facetData, rows => d3\.sum\(rows, d => d\["yield"\]\)/, 'expected the shared domain to aggregate via the same rollup used for the real per-panel stacking, not a raw min/max over "yield"');
  assert.doesNotMatch(code, /__facetXDomain = \[Math\.min\(0, d3\.min\(facetData, d => d\["yield"\]\)/, 'expected the naive raw-field domain NOT to be used once the channel has its own aggregate');
});

test('the "flatten" transform explodes an array field into rows, with dotted-path access to its own sub-fields', async () => {
  const {document} = await renderSpec({
    data: {values: [{id: 'a', lc: [{t: 1, m: 10}, {t: 2, m: 20}]}, {id: 'b', lc: [{t: 1, m: 5}]}]},
    transform: [{flatten: ['lc']}],
    mark: 'point',
    encoding: {
      x: {field: 'lc.t', type: 'quantitative'},
      y: {field: 'lc.m', type: 'quantitative'},
    },
  });
  const circles = [...document.querySelectorAll('circle')];
  assert.equal(circles.length, 3, 'expected 2+1=3 exploded rows drawn');
  const cys = circles.map(c => Number(c.getAttribute('cy')));
  assert.equal(new Set(cys).size, 3, 'expected 3 distinct y positions (from lc.m), not all collapsed to the same undefined value');
});

test('a bar with both x and y quantitative and an explicit orient stacks and orients correctly', async () => {
  // bar_qq_stack_horizontal.vl.json's own shape: mark.orient explicit
  // "horizontal", x AND y both quantitative, two rows sharing the same
  // category value (needing implicit stacking, no color channel at all).
  // Previously: (1) stacking picked y (the real category) as the value
  // channel regardless of orient, backwards; (2) even after fixing that,
  // the category axis (y) fell through to a zero-baseline treatment
  // instead of a small fixed-height reference band, drawing one giant
  // bar per row instead of a normal-height one.
  const {document} = await renderSpec({
    data: {values: [{a: 1, b: 28}, {a: 1, b: 55}, {a: 5, b: 43}]},
    mark: {type: 'bar', orient: 'horizontal'},
    encoding: {y: {field: 'a', type: 'quantitative'}, x: {field: 'b', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  const rects = marksOf(document, 'rect');
  assert.equal(rects.length, 3);
  const heights = rects.map(r => Number(r.getAttribute('height')));
  for (const h of heights) assert.ok(h < 20, `expected a small fixed-pixel height (horizontal bar), got ${h}`);
  const byY = new Map();
  for (const r of rects) {
    const y = Math.round(Number(r.getAttribute('y')));
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push(r);
  }
  const atA1 = [...byY.values()].find(group => group.length === 2);
  assert.ok(atA1, `expected two rows sharing the same y (a=1, stacked), got y groups: ${[...byY.keys()]}`);
  const segs = atA1.map(r => ({x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width'))})).sort((a, b) => a.x - b.x);
  assert.ok(Math.abs(segs[0].x + segs[0].w - segs[1].x) < 1, `expected two adjacent (stacked) segments along x, got ${JSON.stringify(segs)}`);
});

test('a datum-only color channel on an ungrouped line mark uses the shared color scale, not a hardcoded default', async () => {
  // repeat_layer.vl.json's own shape (after repeat-expansion): a `layer`
  // of two line marks, each with `color: {datum: "..."}` (a per-layer
  // constant, no field to group rows by) -- seriesGroupField() correctly
  // returns null for this (nothing to group), landing in renderLine()'s
  // ungrouped branch, but that branch previously only ever consulted
  // markProps (mark-level static style), never the encoding channel's
  // own datum -- every layer silently drew with the identical default
  // "steelblue" stroke despite each having a real, distinct entry in the
  // shared color scale's own domain.
  const {code} = await renderSpec({
    data: {values: [{x: 1, y: 2}]},
    layer: [
      {mark: 'line', encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}, color: {datum: 'A', type: 'nominal'}}},
      {mark: 'line', encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}, color: {datum: 'B', type: 'nominal'}}},
    ],
  }, {ignoreUnsupported: true});
  const strokes = [...code.matchAll(/\.attr\("stroke",\s*(color\([^)]*\))\)/g)].map(m => m[1]);
  assert.equal(strokes.length, 2, `expected both lines to use the shared color scale, got: ${code}`);
  assert.notEqual(strokes[0], strokes[1], `expected the two layers to resolve to different color(...) calls, got: ${strokes}`);
});

test("a line mark's own detail channel splits series that share a color group, not just color alone", async () => {
  // repeat_child_layer.vl.json's own shape: `color: {field: "location"}`
  // + `detail: {field: "year"}` on the same line layer -- previously the
  // draw loop only ever grouped by seriesGroupField()'s own pick (color,
  // when present), so every year's worth of rows for one location got
  // drawn as one path, sorted only by the domain axis, zigzagging
  // backwards between years instead of drawing one smooth line per
  // (location, year) pair.
  const {document} = await renderSpec({
    data: {values: [
      {loc: 'A', year: 2020, m: 1, v: 1}, {loc: 'A', year: 2020, m: 2, v: 2},
      {loc: 'A', year: 2021, m: 1, v: 10}, {loc: 'A', year: 2021, m: 2, v: 20},
      {loc: 'B', year: 2020, m: 1, v: 5}, {loc: 'B', year: 2020, m: 2, v: 6},
    ]},
    mark: 'line',
    encoding: {
      x: {field: 'm', type: 'ordinal'},
      y: {field: 'v', type: 'quantitative'},
      color: {field: 'loc', type: 'nominal'},
      detail: {field: 'year', type: 'nominal'},
    },
  }, {ignoreUnsupported: true});
  const paths = marksOf(document, 'path');
  assert.equal(paths.length, 3, `expected 3 separate lines (A/2020, A/2021, B/2020), got ${paths.length}`);
});

test('a genuinely quantitative yOffset draws a real sub-band ranged bar, not a heatmap cell', async () => {
  // bar_ranged_offset_quantitative.vl.json's own shape: `y: {field:
  // "team"}` + `yOffset: {field: "score", type: "quantitative"}` on a
  // bar mark whose OTHER axis (x: quarter) is also a plain band --
  // previously this matched the "both axes are bands, no offset"
  // heatmap-cell branch first, drawing one solid bandwidth-by-bandwidth
  // box per (quarter, team) pair and completely ignoring the offset.
  // Confirmed against the real compiler's own output: the offset channel
  // gets a LINEAR sub-scale within the outer team band (domain: the
  // field's own real min/max, range [0, bandwidth]), a small FIXED
  // height, not a value-driven zero-baseline length.
  const {document, code} = await renderSpec({
    data: {values: [
      {quarter: 'Q1', team: 'A', score: 12}, {quarter: 'Q2', team: 'A', score: 18},
      {quarter: 'Q1', team: 'B', score: 8}, {quarter: 'Q2', team: 'B', score: 14},
    ]},
    mark: 'bar',
    encoding: {
      x: {field: 'quarter', type: 'ordinal'},
      y: {field: 'team', type: 'nominal'},
      yOffset: {field: 'score', type: 'quantitative'},
      color: {field: 'team', type: 'nominal'},
    },
  }, {ignoreUnsupported: true});
  assert.match(code, /d3\.scaleLinear\(d3\.extent/);
  // Excludes the 10x10 legend swatch rects (marksOf()'s own swatch
  // filter has nothing to match against here -- vl2d3's legend rects
  // carry no distinguishing class of their own).
  const rects = marksOf(document, 'rect').filter(r => r.getAttribute('height') !== '10');
  assert.equal(rects.length, 4);
  const widths = new Set(rects.map(r => r.getAttribute('width')));
  assert.equal(widths.size, 1, `expected every bar to share the same real bandwidth, got: ${[...widths]}`);
  const heights = new Set(rects.map(r => r.getAttribute('height')));
  assert.equal(heights.size, 1, `expected every bar to share the same fixed sub-band height, got: ${[...heights]}`);
  const ys = new Set(rects.map(r => r.getAttribute('y')));
  assert.equal(ys.size, 4, `expected 4 distinct y positions (one per row's own score), got: ${ys.size}`);
});

test('facet throws a clear, named error', async () => {
  const {vegaLiteToD3Code} = await import('../src/index.js');
  assert.throws(
    () => vegaLiteToD3Code({facet: {field: 'a', type: 'nominal'}, spec: {mark: 'bar', encoding: {}}}),
    /facet.*not yet supported/
  );
});
