import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderSpec} from './helpers.js';
import {vegaLiteToPlotCode} from '../src/index.js';

// Axis chrome (tick marks, the axis label) also renders <path>/<text>
// elements grouped under a `<g aria-label="...axis...">`, so mark-drawn
// shapes must be queried excluding those.
const marksOf = (document, selector) => [...document.querySelectorAll(selector)].filter(el => !el.closest('[aria-label*="axis"]'));

test('bar chart: nominal x, quantitative y', async () => {
  const {document} = await renderSpec({
    data: {values: [{a: 'A', b: 28}, {a: 'B', b: 55}, {a: 'C', b: 43}]},
    mark: 'bar',
    encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}},
  });
  assert.equal(document.querySelectorAll('rect').length, 3);
});

test('bar chart: inline count aggregate', async () => {
  const {document} = await renderSpec({
    data: {values: [{cat: 'x'}, {cat: 'x'}, {cat: 'y'}]},
    mark: 'bar',
    encoding: {x: {field: 'cat', type: 'nominal'}, y: {aggregate: 'count', type: 'quantitative'}},
  });
  const rects = [...document.querySelectorAll('rect')];
  assert.equal(rects.length, 2);
  const heights = rects.map(r => Number(r.getAttribute('height'))).sort((a, b) => a - b);
  assert.ok(heights[1] > heights[0]);
});

test('bar chart: inline mean aggregate grouped by one field', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', v: 1}, {g: 'a', v: 3}, {g: 'b', v: 10}]},
    mark: 'bar',
    encoding: {x: {field: 'g', type: 'nominal'}, y: {field: 'v', aggregate: 'mean', type: 'quantitative'}},
  });
  assert.equal(document.querySelectorAll('rect').length, 2);
});

test('histogram: bin + count', async () => {
  const values = Array.from({length: 50}, (_, i) => ({x: i}));
  const {document} = await renderSpec({
    data: {values},
    mark: 'bar',
    encoding: {x: {field: 'x', bin: true, type: 'quantitative'}, y: {aggregate: 'count', type: 'quantitative'}},
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
  const dots = [...document.querySelectorAll('circle')];
  assert.equal(dots.length, 3);
  const fills = new Set(dots.map(c => c.getAttribute('fill') || c.getAttribute('stroke')));
  assert.equal(fills.size, 2);
});

test('line chart is sorted by its own domain field, not data-array order', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 3, y: 4}, {x: 1, y: 3}, {x: 2, y: 1}]},
    mark: 'line',
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}},
  });
  const [path] = marksOf(document, 'path');
  assert.ok(path);
  // Three points -> two line segments in the path's own "d" attribute.
  const d = path.getAttribute('d');
  assert.equal((d.match(/L/g) || []).length, 2);
});

test('area chart', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 3}, {x: 2, y: 1}]},
    mark: 'area',
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}},
  });
  assert.ok(document.querySelector('path'));
});

test('layered bar + rule (mean line)', async () => {
  const {document} = await renderSpec({
    data: {values: [{a: 'A', b: 28}, {a: 'B', b: 55}]},
    layer: [
      {mark: 'bar', encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}}},
      {mark: 'rule', encoding: {y: {aggregate: 'mean', field: 'b', type: 'quantitative'}}},
    ],
  });
  assert.equal(document.querySelectorAll('rect').length, 2);
  assert.ok(document.querySelectorAll('line').length > 0);
});

test('hconcat renders an independent Plot.plot() per child', async () => {
  const {container} = await renderSpec({
    hconcat: [
      {data: {values: [{a: 'A', b: 1}]}, mark: 'bar', encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}}},
      {data: {values: [{a: 'B', b: 2}]}, mark: 'bar', encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}}},
    ],
  });
  assert.equal(container.querySelectorAll('svg').length, 2);
});

test('facet: native Plot facet, one panel per distinct field value', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'x', a: 'A', b: 1}, {g: 'y', a: 'B', b: 2}]},
    facet: {field: 'g', type: 'nominal'},
    spec: {mark: 'bar', encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}}},
  });
  assert.equal(document.querySelectorAll('rect').length, 2);
});

test('boxplot', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', v: 1}, {g: 'a', v: 5}, {g: 'b', v: 2}, {g: 'b', v: 8}]},
    mark: 'boxplot',
    encoding: {x: {field: 'g', type: 'nominal'}, y: {field: 'v', type: 'quantitative'}},
  });
  assert.ok(document.querySelectorAll('rect').length > 0);
});

test('detail (z) channel groups lines without a visual encoding', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 1, g: 'a'}, {x: 2, y: 2, g: 'a'}, {x: 1, y: 3, g: 'b'}, {x: 2, y: 1, g: 'b'}]},
    mark: 'line',
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}, detail: {field: 'g'}},
  });
  assert.equal(marksOf(document, 'path').length, 2);
});

test('stack: normalize offset produces full-height stacked bars', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', c: 'x', v: 1}, {g: 'a', c: 'y', v: 2}, {g: 'b', c: 'x', v: 3}, {g: 'b', c: 'y', v: 4}]},
    mark: 'bar',
    encoding: {
      x: {field: 'g', type: 'nominal'},
      y: {field: 'v', type: 'quantitative', stack: 'normalize'},
      color: {field: 'c', type: 'nominal'},
    },
  });
  const rects = [...document.querySelectorAll('rect')].filter(r => r.getAttribute('height'));
  const byX = new Map();
  for (const r of rects) {
    const x = r.getAttribute('x');
    byX.set(x, (byX.get(x) || 0) + Number(r.getAttribute('height')));
  }
  const totals = [...byX.values()];
  assert.ok(totals.every(h => Math.abs(h - totals[0]) < 1e-6));
});

test('custom color range overrides the default categorical scheme', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', v: 1}, {g: 'b', v: 2}]},
    mark: 'bar',
    encoding: {
      x: {field: 'g', type: 'nominal'},
      y: {field: 'v', type: 'quantitative'},
      color: {field: 'g', type: 'nominal', scale: {range: ['#ff0000', '#00ff00']}},
    },
  });
  const fills = [...document.querySelectorAll('rect')].map(r => r.getAttribute('fill'));
  assert.ok(fills.includes('#ff0000') || fills.includes('rgb(255, 0, 0)'));
});

test('legacy category20 scheme falls back to a literal 20-color range instead of throwing', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', v: 1}, {g: 'b', v: 2}, {g: 'c', v: 3}]},
    mark: 'bar',
    encoding: {
      x: {field: 'g', type: 'nominal'},
      y: {field: 'v', type: 'quantitative'},
      color: {field: 'g', type: 'nominal', scale: {scheme: 'category20b'}},
    },
  });
  assert.equal(document.querySelectorAll('rect').length, 3);
});

test('top-level aggregate transform', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', v: 1}, {g: 'a', v: 3}, {g: 'b', v: 10}]},
    transform: [{aggregate: [{op: 'mean', field: 'v', as: 'mv'}], groupby: ['g']}],
    mark: 'bar',
    encoding: {x: {field: 'g', type: 'nominal'}, y: {field: 'mv', type: 'quantitative'}},
  });
  assert.equal(document.querySelectorAll('rect').length, 2);
});

test('filter + calculate transform', async () => {
  const {document} = await renderSpec({
    data: {values: [{a: 1}, {a: 2}, {a: 3}]},
    transform: [{filter: 'datum.a > 1'}, {calculate: 'datum.a * 2', as: 'b'}],
    mark: 'point',
    encoding: {x: {field: 'a', type: 'quantitative'}, y: {field: 'b', type: 'quantitative'}},
  });
  assert.equal(document.querySelectorAll('circle').length, 2);
});

test('a bar with a companion x2 (interval bin) renders x1/x2, not an ordinal band', async () => {
  const code = vegaLiteToPlotCode({
    data: {values: [{lo: 1, hi: 5, v: 3}]},
    mark: 'bar',
    encoding: {
      x: {field: 'lo', type: 'quantitative'},
      x2: {field: 'hi'},
      y: {field: 'v', type: 'quantitative'},
    },
  });
  assert.match(code, /x1:\s*"lo"/);
  assert.match(code, /x2:\s*"hi"/);
});

test('unsupported mark type throws a clear "Unsupported: ..." error by default', () => {
  assert.throws(
    () => vegaLiteToPlotCode({data: {values: [{a: 1}]}, mark: 'arc', encoding: {theta: {field: 'a', type: 'quantitative'}}}),
    /Unsupported mark type: "arc"/
  );
});

test('unsupported mark type is skipped, not thrown, under ignoreUnsupported', () => {
  const code = vegaLiteToPlotCode(
    {data: {values: [{a: 1}]}, mark: 'arc', encoding: {theta: {field: 'a', type: 'quantitative'}}},
    {ignoreUnsupported: true}
  );
  assert.match(code, /unsupported mark type/);
});

test('nested facet (facet within facet) throws a clear "Unsupported: ..." error', () => {
  assert.throws(
    () =>
      vegaLiteToPlotCode({
        data: {values: [{r: 'p', c: 'x', a: 'A', b: 1}]},
        facet: {row: {field: 'r'}},
        spec: {facet: {column: {field: 'c'}}, spec: {mark: 'point', encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}}}},
      }),
    /Unsupported: nested facet composition/
  );
});

test('repeat composition throws a clear "Unsupported: ..." error', () => {
  assert.throws(
    () =>
      vegaLiteToPlotCode({
        data: {values: [{a: 1, b: 2}]},
        repeat: {layer: ['a', 'b']},
        spec: {mark: 'point', encoding: {x: {field: {repeat: 'layer'}, type: 'quantitative'}}},
      }),
    /Unsupported top-level composition: 'repeat'/
  );
});

test('substring() Vega expression coerces to a string first', async () => {
  const {document} = await renderSpec({
    data: {values: [{zip: '01001'}, {zip: '10001'}]},
    transform: [{calculate: 'substring(datum.zip, 0, 1)', as: 'digit'}],
    mark: 'point',
    encoding: {x: {field: 'digit', type: 'nominal'}, y: {value: 1}},
  });
  assert.equal(document.querySelectorAll('circle').length, 2);
});
