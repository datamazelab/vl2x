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

test('facet throws a clear, named error', async () => {
  const {vegaLiteToD3Code} = await import('../src/index.js');
  assert.throws(
    () => vegaLiteToD3Code({facet: {field: 'a', type: 'nominal'}, spec: {mark: 'bar', encoding: {}}}),
    /facet.*not yet supported/
  );
});
