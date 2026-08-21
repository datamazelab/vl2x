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

test('facet throws a clear, named error', async () => {
  const {vegaLiteToD3Code} = await import('../src/index.js');
  assert.throws(
    () => vegaLiteToD3Code({facet: {field: 'a', type: 'nominal'}, spec: {mark: 'bar', encoding: {}}}),
    /facet.*not yet supported/
  );
});
