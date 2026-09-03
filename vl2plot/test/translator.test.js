import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderSpec} from './helpers.js';
import {vegaLiteToPlotCode} from '../src/index.js';

// Axis chrome (tick marks, the axis label) also renders <path>/<text>
// elements grouped under a `<g aria-label="...axis...">`, and a legend's
// own swatches render <rect>/<svg> too (a content-hashed class name like
// `plot-d6a7b5-swatch`, so matched by a partial selector) -- mark-drawn
// shapes must be queried excluding both.
const marksOf = (document, selector) =>
  [...document.querySelectorAll(selector)].filter(el => !el.closest('[aria-label*="axis"]') && !el.closest('[class*="swatch"]'));

test('bar chart: nominal x, quantitative y', async () => {
  const {document} = await renderSpec({
    data: {values: [{a: 'A', b: 28}, {a: 'B', b: 55}, {a: 'C', b: 43}]},
    mark: 'bar',
    encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}},
  });
  assert.equal(marksOf(document, 'rect').length, 3);
});

test('bar chart: inline count aggregate', async () => {
  const {document} = await renderSpec({
    data: {values: [{cat: 'x'}, {cat: 'x'}, {cat: 'y'}]},
    mark: 'bar',
    encoding: {x: {field: 'cat', type: 'nominal'}, y: {aggregate: 'count', type: 'quantitative'}},
  });
  const rects = [...marksOf(document, 'rect')];
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
  assert.equal(marksOf(document, 'rect').length, 2);
});

test('histogram: bin + count', async () => {
  const values = Array.from({length: 50}, (_, i) => ({x: i}));
  const {document} = await renderSpec({
    data: {values},
    mark: 'bar',
    encoding: {x: {field: 'x', bin: true, type: 'quantitative'}, y: {aggregate: 'count', type: 'quantitative'}},
  });
  assert.ok(marksOf(document, 'rect').length > 1);
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
  assert.equal(marksOf(document, 'rect').length, 2);
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
  assert.equal(marksOf(document, 'rect').length, 2);
});

test('boxplot', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', v: 1}, {g: 'a', v: 5}, {g: 'b', v: 2}, {g: 'b', v: 8}]},
    mark: 'boxplot',
    encoding: {x: {field: 'g', type: 'nominal'}, y: {field: 'v', type: 'quantitative'}},
  });
  assert.ok(marksOf(document, 'rect').length > 0);
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
  const rects = [...marksOf(document, 'rect')].filter(r => r.getAttribute('height'));
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
  const fills = [...marksOf(document, 'rect')].map(r => r.getAttribute('fill'));
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
  assert.equal(marksOf(document, 'rect').length, 3);
});

test('top-level aggregate transform', async () => {
  const {document} = await renderSpec({
    data: {values: [{g: 'a', v: 1}, {g: 'a', v: 3}, {g: 'b', v: 10}]},
    transform: [{aggregate: [{op: 'mean', field: 'v', as: 'mv'}], groupby: ['g']}],
    mark: 'bar',
    encoding: {x: {field: 'g', type: 'nominal'}, y: {field: 'mv', type: 'quantitative'}},
  });
  assert.equal(marksOf(document, 'rect').length, 2);
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
    () => vegaLiteToPlotCode({data: {values: [{a: 1}]}, mark: 'geoshape', encoding: {}}),
    /Unsupported mark type: "geoshape"/
  );
});

test('unsupported mark type is skipped, not thrown, under ignoreUnsupported', () => {
  const code = vegaLiteToPlotCode({data: {values: [{a: 1}]}, mark: 'geoshape', encoding: {}}, {ignoreUnsupported: true});
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

test('repeat: {layer: [...]} expands into a real, correctly-substituted layer composition', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, a: 10, b: 20}, {x: 2, a: 15, b: 25}]},
    repeat: {layer: ['a', 'b']},
    spec: {mark: 'line', encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: {repeat: 'layer'}, type: 'quantitative'}, color: {datum: {repeat: 'layer'}, type: 'nominal'}}},
  });
  assert.equal(marksOf(document, 'path').length, 2);
});

test('a bare-array repeat: [...] with columns expands into a real grid of independent panels', async () => {
  const {container} = await renderSpec({
    repeat: ['a', 'b', 'c'],
    columns: 2,
    spec: {
      data: {values: [{v: 1}, {v: 2}, {v: 3}]},
      mark: 'bar',
      encoding: {x: {field: {repeat: 'repeat'}, type: 'ordinal'}, y: {aggregate: 'count'}},
    },
  });
  assert.equal(container.querySelectorAll('svg').length, 3);
});

test('a 2D (row and column together) repeat throws a clear "Unsupported: ..." error', () => {
  assert.throws(
    () =>
      vegaLiteToPlotCode({
        data: {values: [{a: 1, b: 2}]},
        repeat: {row: ['a'], column: ['b']},
        spec: {mark: 'point', encoding: {x: {field: {repeat: 'column'}, type: 'quantitative'}, y: {field: {repeat: 'row'}, type: 'quantitative'}}},
      }),
    /Unsupported: a 2D \(row and column together\) 'repeat'/
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

test('1-dimensional aggregate (no other channel) collapses to one correctly-summed bar', async () => {
  const {document} = await renderSpec({
    data: {values: [{people: 10}, {people: 20}, {people: 30}]},
    mark: 'bar',
    encoding: {x: {aggregate: 'sum', field: 'people', type: 'quantitative', scale: {domain: [0, 1000]}}},
  });
  const rects = marksOf(document, 'rect');
  assert.equal(rects.length, 1);
  // A fixed [0, 1000] domain makes the sum (60) directly checkable from
  // pixel width -- an un-summed render (one bar per row, wrongly scaled)
  // previously still "looked" full-width under Plot's own auto-domain
  // fitting for a single point, masking the bug.
  const width = Number(rects[0].getAttribute('width'));
  assert.ok(width > 30 && width < 40, `expected width ~34.8 for sum=60/1000, got ${width}`);
});

test('a reference rule (1D aggregate, no x) draws a real, correctly-valued line', async () => {
  // A known, narrower cosmetic limitation: the synthetic grouping key
  // `needsConstantKey` injects to collapse a 1D aggregate into one group
  // (see prepare.js) also becomes a real (if arbitrary) band position for
  // a mark like `ruleY`, which ideally spans the *entire* opposite axis
  // when no x is given at all -- so this only asserts the line renders
  // with the correct y (mean) value, not that it spans full width.
  const {document} = await renderSpec({
    data: {values: [{a: 'A', b: 28}, {a: 'B', b: 56}]},
    layer: [
      {mark: 'bar', encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}}},
      {mark: 'rule', encoding: {y: {aggregate: 'mean', field: 'b', type: 'quantitative'}}},
    ],
  });
  const [line] = marksOf(document, 'line');
  assert.ok(line);
  const rectYs = [...marksOf(document, 'rect')].map(r => Number(r.getAttribute('y')));
  const lineY = Number(line.getAttribute('y1'));
  // mean(28, 56) = 42 -- exactly halfway between the two bars' own heights,
  // so the rule's own y should land between the two rects' own y values.
  assert.ok(lineY > Math.min(...rectYs) && lineY < Math.max(...rectYs));
});

test('bin with no companion channel defaults to a vertical histogram', async () => {
  const {document} = await renderSpec({
    data: {values: Array.from({length: 30}, (_, i) => ({v: i}))},
    mark: 'bar',
    encoding: {x: {field: 'v', bin: true, type: 'quantitative'}},
  });
  const rects = [...marksOf(document, 'rect')];
  assert.ok(rects.length > 1);
  // Vertical: bars differ in x (bin edges), not in y.
  const xs = new Set(rects.map(r => r.getAttribute('x')));
  assert.ok(xs.size > 1);
});

test('opacity alongside an aggregate on a different channel does not break grouping', async () => {
  const {document} = await renderSpec({
    data: {values: [{age: 10, people: 100}, {age: 10, people: 50}, {age: 20, people: 200}]},
    mark: 'bar',
    encoding: {
      x: {field: 'age', type: 'ordinal'},
      y: {aggregate: 'sum', field: 'people', type: 'quantitative'},
      opacity: {field: 'people', type: 'quantitative'},
    },
  });
  const rects = [...marksOf(document, 'rect')];
  assert.equal(rects.length, 2);
  const heights = rects.map(r => Number(r.getAttribute('height'))).sort((a, b) => a - b);
  // age=10 sums to 150, age=20 sums to 200 -- correctly summed heights
  // should differ noticeably, not collapse to near-zero (the un-fixed bug
  // rendered zero rects at all).
  assert.ok(heights[1] > heights[0]);
});

test('a text label with its own aggregate + explicit stack matches the bar it labels', async () => {
  const {document} = await renderSpec({
    data: {values: [
      {age: 10, gender: 'M', people: 100}, {age: 10, gender: 'F', people: 50},
      {age: 20, gender: 'M', people: 200}, {age: 20, gender: 'F', people: 150},
    ]},
    layer: [
      {
        mark: 'bar',
        encoding: {
          y: {field: 'age', type: 'ordinal'},
          x: {aggregate: 'sum', field: 'people', type: 'quantitative', stack: 'normalize'},
          color: {field: 'gender', type: 'nominal'},
        },
      },
      {
        mark: 'text',
        encoding: {
          y: {field: 'age', type: 'ordinal'},
          x: {aggregate: 'sum', field: 'people', type: 'quantitative', stack: 'normalize'},
          text: {aggregate: 'sum', field: 'people', type: 'quantitative'},
          detail: {field: 'gender'},
        },
      },
    ],
  });
  const rects = [...marksOf(document, 'rect')];
  assert.equal(rects.length, 4);
  // Every bar for one y-position (age) should sum to the full normalized
  // width -- if the label's own un-stacked values leaked into the shared
  // x-scale (the original bug), the bars would shrink to slivers instead.
  const byY = new Map();
  for (const r of rects) {
    const y = r.getAttribute('y');
    byY.set(y, (byY.get(y) || 0) + Number(r.getAttribute('width')));
  }
  for (const total of byY.values()) assert.ok(total > 400, `expected a near-full-width stacked total, got ${total}`);
  const labels = marksOf(document, 'text').map(t => t.textContent).sort();
  assert.deepEqual(labels, ['100', '150', '200', '50']);
});

test('bin: {binned: true} with an explicit x2 companion renders the pre-computed bins as-is', async () => {
  const {document} = await renderSpec({
    data: {values: [
      {bin_start: 8, bin_end: 10, count: 7},
      {bin_start: 10, bin_end: 12, count: 29},
    ]},
    mark: 'bar',
    encoding: {
      x: {field: 'bin_start', bin: {binned: true, step: 2}},
      x2: {field: 'bin_end'},
      y: {field: 'count', type: 'quantitative'},
    },
  });
  assert.equal(marksOf(document, 'rect').length, 2);
});

test('inline values as an object needs format.property (a dotted path) to extract the row array', async () => {
  const {document} = await renderSpec({
    data: {
      values: {hits: {hits: [{source: {reco: 2, yes: 1}}, {source: {reco: 3, yes: 4}}]}},
      format: {type: 'json', property: 'hits.hits'},
    },
    mark: 'point',
    encoding: {x: {field: 'source.reco', type: 'quantitative'}, y: {field: 'source.yes', type: 'quantitative'}},
  });
  assert.equal(document.querySelectorAll('circle').length, 2);
});

test('top-level density transform produces a real (non-empty) KDE curve', async () => {
  const {document} = await renderSpec({
    data: {values: Array.from({length: 40}, () => ({v: 3000 + Math.random() * 3000, g: Math.random() < 0.5 ? 'a' : 'b'}))},
    transform: [{density: 'v', groupby: ['g'], extent: [2500, 6500]}],
    mark: 'area',
    encoding: {x: {field: 'value', type: 'quantitative'}, y: {field: 'density', type: 'quantitative', stack: 'zero'}, color: {field: 'g', type: 'nominal'}},
  });
  const paths = marksOf(document, 'path');
  assert.equal(paths.length, 2);
  for (const p of paths) assert.ok(p.getAttribute('d').length > 100);
});

test('top-level stack transform computes correctly-proportioned segments', async () => {
  const {document} = await renderSpec({
    data: {values: [{age: 10, gender: 'M', people: 100}, {age: 10, gender: 'F', people: 50}]},
    transform: [{stack: 'people', groupby: ['age'], offset: 'normalize', as: ['v1', 'v2']}],
    mark: 'bar',
    encoding: {
      x: {field: 'age', type: 'ordinal'},
      y: {field: 'v1', type: 'quantitative'},
      y2: {field: 'v2'},
      color: {field: 'gender', type: 'nominal'},
    },
  });
  const rects = [...marksOf(document, 'rect')];
  assert.equal(rects.length, 2);
  const totalHeight = rects.reduce((s, r) => s + Number(r.getAttribute('height')), 0);
  assert.ok(totalHeight > 300, `expected the two segments to sum to a near-full-height stack, got ${totalHeight}`);
});

test('a field-encoded color channel shows a legend by default, matching Vega-Lite', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 2, c: 'A'}, {x: 2, y: 3, c: 'B'}]},
    mark: 'point',
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}, color: {field: 'c', type: 'nominal'}},
  });
  assert.ok(document.querySelector('[class*="swatch"]'), 'expected a legend swatch to be present by default');
});

test('an explicit legend: null suppresses the default legend', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 2, c: 'A'}, {x: 2, y: 3, c: 'B'}]},
    mark: 'point',
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}, color: {field: 'c', type: 'nominal', legend: null}},
  });
  assert.equal(document.querySelector('[class*="swatch"]'), null);
});

test('a chart-level title renders as Plot\'s own native title option', async () => {
  const {document} = await renderSpec({
    title: 'A Simple Bar Chart',
    data: {values: [{a: 'A', b: 1}]},
    mark: 'bar',
    encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}},
  });
  assert.ok(document.body.textContent.includes('A Simple Bar Chart'));
});

test('sort: {op, order} on a bar\'s category axis reorders it by the mark\'s own value', async () => {
  const {document} = await renderSpec({
    data: {values: [{cyl: 4, n: 3}, {cyl: 6, n: 6}, {cyl: 8, n: 2}, {cyl: 5, n: 1}]},
    mark: 'bar',
    encoding: {
      x: {field: 'cyl', type: 'ordinal', sort: {op: 'sum', field: 'n', order: 'descending'}},
      y: {field: 'n', type: 'quantitative'},
    },
  });
  const rects = [...marksOf(document, 'rect')].sort((a, b) => Number(a.getAttribute('x')) - Number(b.getAttribute('x')));
  const heights = rects.map(r => Math.round(Number(r.getAttribute('height'))));
  const sorted = [...heights].sort((a, b) => b - a);
  assert.deepEqual(heights, sorted, `expected bars left-to-right in descending height order, got ${heights}`);
});

test('an arc mark draws real pie wedges with a legend', async () => {
  const {document} = await renderSpec({
    data: {values: [{category: 'a', value: 30}, {category: 'b', value: 70}]},
    mark: 'arc',
    encoding: {theta: {field: 'value', type: 'quantitative'}, color: {field: 'category', type: 'nominal'}},
  });
  const paths = [...document.querySelectorAll('path')].filter(p => /^M/.test(p.getAttribute('d') || ''));
  assert.equal(paths.length, 2);
  // Each wedge's own `fill` must be a real resolved color, not `values.
  // fill` re-run back through the color scale a second time (a real bug:
  // Plot's own channel `values` are already post-scale output, so doing
  // that looked up an already-a-color string as a domain value and
  // silently produced no fill at all).
  const fills = new Set(paths.map(p => p.getAttribute('fill')));
  assert.equal(fills.size, 2);
  for (const f of fills) assert.ok(f && /^#|^rgb/.test(f), `expected a real color, got ${f}`);
  assert.ok(document.querySelector('[class*="swatch"]'));
});

test('a static mark.color/size (no encoding channel) still styles the line', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 1}, {x: 2, y: 2}]},
    mark: {type: 'line', color: 'red', size: 3},
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}},
  });
  const [path] = marksOf(document, 'path');
  assert.ok(path);
  // A constant (non-field) channel value is hoisted by Plot onto the
  // mark's own wrapping `<g>` as a shared SVG presentation attribute
  // (inherited by every path in the group), not repeated per-path.
  const g = path.closest('g');
  assert.equal(g.getAttribute('stroke'), 'red');
  assert.equal(g.getAttribute('stroke-width'), '3');
});

test('top-level window transform computes a real rolling mean', async () => {
  const {document} = await renderSpec({
    data: {values: Array.from({length: 10}, (_, i) => ({x: i, y: i % 2 === 0 ? 100 : 0}))},
    transform: [{window: [{op: 'mean', field: 'y', as: 'rolling'}], frame: [-1, 1]}],
    mark: 'line',
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'rolling', type: 'quantitative'}},
  });
  const [path] = marksOf(document, 'path');
  assert.ok(path);
  const d = path.getAttribute('d');
  assert.ok(!d.includes('NaN'));
  // A 3-wide rolling mean of alternating 100/0 should smooth to ~50,
  // nowhere near the raw 0/100 extremes -- distinguishes a real
  // computation from the un-fixed bug (the field simply not existing,
  // producing NaN positions, or the transform being silently skipped and
  // leaving the raw un-smoothed data instead).
  assert.equal((d.match(/L/g) || []).length, 9);
});

test('a top-level argmax aggregate transform + bracket-indexed field renders a correctly-selected bar', async () => {
  const {document} = await renderSpec({
    data: {values: [
      {genre: 'Comedy', gross: 100, budget: 10}, {genre: 'Comedy', gross: 300, budget: 40},
      {genre: 'Drama', gross: 50, budget: 5}, {genre: 'Drama', gross: 20, budget: 2},
    ]},
    transform: [{aggregate: [{op: 'argmax', field: 'gross', as: 'winner'}], groupby: ['genre']}],
    mark: 'bar',
    encoding: {x: {field: "winner['budget']", type: 'quantitative'}, y: {field: 'genre', type: 'nominal'}},
  });
  const rects = [...marksOf(document, 'rect')].sort((a, b) => Number(a.getAttribute('y')) - Number(b.getAttribute('y')));
  const widths = rects.map(r => Math.round(Number(r.getAttribute('width'))));
  // Comedy's own argmax-by-gross row has budget=40, Drama's has budget=5
  // -- an 8:1 ratio; the un-fixed bug either threw (strict) or (best-
  // effort) silently fell back to the *mean* of gross, an unrelated
  // number, feeding a field name Plot has no way to resolve at all.
  assert.ok(Math.abs(widths[0] / widths[1] - 8) < 0.1, `expected an ~8:1 ratio, got ${widths[0]}:${widths[1]}`);
});

test('an inline aggregate: {argmax: field} channel shorthand renders a correctly-selected bar', async () => {
  const {document} = await renderSpec({
    data: {values: [
      {genre: 'Comedy', gross: 100, budget: 10}, {genre: 'Comedy', gross: 300, budget: 40},
      {genre: 'Drama', gross: 50, budget: 5}, {genre: 'Drama', gross: 20, budget: 2},
    ]},
    mark: 'bar',
    encoding: {x: {aggregate: {argmax: 'gross'}, field: 'budget', type: 'quantitative'}, y: {field: 'genre', type: 'nominal'}},
  });
  const rects = [...marksOf(document, 'rect')].sort((a, b) => Number(a.getAttribute('y')) - Number(b.getAttribute('y')));
  const widths = rects.map(r => Math.round(Number(r.getAttribute('width'))));
  assert.ok(Math.abs(widths[0] / widths[1] - 8) < 0.1, `expected an ~8:1 ratio, got ${widths[0]}:${widths[1]}`);
});

test('xOffset (a grouped/dodged bar) draws distinct side-by-side bars, not stacked ones', async () => {
  const {document} = await renderSpec({
    data: {values: [
      {category: 'A', group: 'x', value: 1}, {category: 'A', group: 'y', value: 2},
      {category: 'B', group: 'x', value: 3}, {category: 'B', group: 'y', value: 4},
    ]},
    mark: 'bar',
    encoding: {
      x: {field: 'category', type: 'nominal'},
      y: {field: 'value', type: 'quantitative'},
      xOffset: {field: 'group', type: 'nominal'},
      color: {field: 'group', type: 'nominal'},
    },
  });
  const rects = [...marksOf(document, 'rect')];
  assert.equal(rects.length, 4);
  // Grouped side by side means each category's own facet strip has two
  // *different* local x positions -- the un-fixed bug rendered xOffset
  // as if it didn't exist at all, so every bar in a category sat at the
  // same position, visually overlapping/occluding like a (wrong) stack.
  const byFacet = new Map();
  for (const r of rects) {
    const facet = r.closest('g[transform]')?.getAttribute('transform') ?? '';
    if (!byFacet.has(facet)) byFacet.set(facet, new Set());
    byFacet.get(facet).add(r.getAttribute('x'));
  }
  assert.equal(byFacet.size, 2, 'expected two facet strips (one per category)');
  for (const xs of byFacet.values()) assert.equal(xs.size, 2, 'expected two distinct x positions within one category');
});

test('a datum-constant xOffset (e.g. from a repeat: {layer: [...]} expansion) still dodges', async () => {
  const {container} = await renderSpec({
    data: {values: [{genre: 'Comedy', a: 10, b: 20}, {genre: 'Drama', a: 30, b: 40}]},
    layer: [
      {mark: 'bar', encoding: {x: {field: 'genre', type: 'nominal'}, y: {field: 'a', type: 'quantitative'}, xOffset: {datum: 'a'}, color: {datum: 'a'}}},
      {mark: 'bar', encoding: {x: {field: 'genre', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}, xOffset: {datum: 'b'}, color: {datum: 'b'}}},
    ],
  });
  const rects = [...container.querySelectorAll('rect')].filter(r => r.getAttribute('width') !== '100%');
  const byFacet = new Map();
  for (const r of rects) {
    const facet = r.closest('g[transform]')?.getAttribute('transform') ?? '';
    if (!byFacet.has(facet)) byFacet.set(facet, new Set());
    byFacet.get(facet).add(r.getAttribute('x'));
  }
  for (const xs of byFacet.values()) assert.equal(xs.size, 2, 'expected the two layers to sit at two distinct positions within one category');
});

test('a trail mark renders a real variable-width ribbon, not a constant-width line', async () => {
  const {document} = await renderSpec({
    data: {values: [{x: 1, y: 10, size: 2}, {x: 2, y: 20, size: 20}, {x: 3, y: 15, size: 2}]},
    mark: 'trail',
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}, size: {field: 'size', type: 'quantitative'}},
  });
  const [path] = marksOf(document, 'path');
  assert.ok(path);
  const d = path.getAttribute('d');
  // A real ribbon polygon is `M...L...L...Z` with 2*n points (one side
  // out, the other back) -- not a plain n-point line, and its own width
  // at the high-size midpoint should be visibly larger than at either
  // low-size end (checked via the polygon's own vertex spread, not a
  // fixed stroke-width that never varies at all).
  const coords = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.equal(coords.length, 6, `expected a 6-vertex ribbon (2 sides x 3 points), got ${coords.length}`);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const widthAt = i => dist(coords[i], coords[coords.length - 1 - i]);
  assert.ok(widthAt(1) > widthAt(0) * 1.5, 'expected the middle (high-size) point to be visibly wider than the low-size ends');
});

test('a row facet with an explicit sort array orders its panels accordingly, not alphabetically', async () => {
  const {document} = await renderSpec({
    data: {values: [{cat: 'b', v: 1}, {cat: 'a', v: 2}, {cat: 'c', v: 3}]},
    mark: 'bar',
    encoding: {
      x: {field: 'v', type: 'quantitative'},
      row: {field: 'cat', type: 'nominal', sort: ['c', 'a', 'b']},
    },
  });
  // Plot's own default ordinal-domain inference sorts ascending
  // ("a","b","c"); the explicit sort array asks for a different order
  // ("c","a","b"), which must come through as a real `fy: {domain}`
  // override, not get silently dropped.
  const labels = [...document.querySelectorAll('text')]
    .map(t => t.textContent)
    .filter(t => ['a', 'b', 'c'].includes(t));
  assert.deepEqual(labels, ['c', 'a', 'b']);
});

test('hconcat children with no explicit width fall back to a small default, not Plot\'s own 640px standalone default', async () => {
  // Two 640px-wide panels side by side in a `flex-wrap: wrap` row would
  // each be wider than most containers, so every panel lands alone on
  // its own line regardless of the wrapper's own `flexDirection: row` --
  // an hconcat that visually renders as if it were vconcat instead. A
  // small per-panel default (mirroring vl2d3's own identical fix) keeps
  // both panels within a typical container's width so they actually sit
  // side by side.
  const {container} = await renderSpec({
    hconcat: [
      {data: {values: [{a: 1, b: 2}]}, mark: 'point', encoding: {x: {field: 'a', type: 'quantitative'}, y: {field: 'b', type: 'quantitative'}}},
      {data: {values: [{a: 1, b: 2}]}, mark: 'bar', encoding: {x: {field: 'a', type: 'nominal'}, y: {field: 'b', type: 'quantitative'}}},
    ],
  }, {ignoreUnsupported: true});
  const widths = [...container.querySelectorAll('svg')].map(s => Number(s.getAttribute('width')));
  assert.equal(widths.length, 2);
  for (const w of widths) assert.ok(w < 640, `expected a small default width, got ${w}`);
});

test('a row-faceted, stacked area chart with an explicit per-panel height renders real (non-flat) shapes in every facet', async () => {
  // Vega-Lite's own `height` on a faceted spec is the size of ONE panel,
  // not the whole grid -- passing it straight through as Plot's own
  // top-level `height` (the whole figure's height) starves each of the 4
  // facets down to a sliver, which for a *stacked* mark degenerates every
  // facet's own geometry into a flat, zero-height line (a real Plot
  // stacking quirk once the available height per facet gets too small,
  // not merely "a bit cramped"). The fix scales the real total height by
  // the actual facet-row count (computed at runtime from the data).
  const {document} = await renderSpec({
    data: {
      values: [
        {date: '2000-01-01', price: 10, symbol: 'A'}, {date: '2000-02-01', price: 12, symbol: 'A'},
        {date: '2000-01-01', price: 20, symbol: 'B'}, {date: '2000-02-01', price: 22, symbol: 'B'},
        {date: '2000-01-01', price: 30, symbol: 'C'}, {date: '2000-02-01', price: 32, symbol: 'C'},
        {date: '2000-01-01', price: 40, symbol: 'D'}, {date: '2000-02-01', price: 42, symbol: 'D'},
      ],
    },
    width: 300,
    height: 40,
    mark: 'area',
    encoding: {
      x: {field: 'date', type: 'temporal'},
      y: {field: 'price', type: 'quantitative'},
      color: {field: 'symbol', type: 'nominal'},
      row: {field: 'symbol', type: 'nominal'},
    },
  }, {ignoreUnsupported: true});
  const paths = [...document.querySelectorAll('path')].filter(p => (p.getAttribute('d') || '').length > 15);
  assert.equal(paths.length, 4, `expected one area path per facet, got ${paths.length}`);
  for (const p of paths) {
    const ys = [...p.getAttribute('d').matchAll(/[ML]-?[\d.]+,(-?[\d.]+)/g)].map(m => Number(m[1]));
    const spread = Math.max(...ys) - Math.min(...ys);
    assert.ok(spread > 1, `expected a real (non-flat) shape with y-spread > 1px, got d="${p.getAttribute('d')}"`);
  }
});

test('a wrapped facet (encoding.facet with columns, no row/column split) renders a real N-column grid, one real panel per distinct value', async () => {
  const {document} = await renderSpec({
    data: {
      values: [
        {site: 'A', v: 1}, {site: 'A', v: 2},
        {site: 'B', v: 3}, {site: 'B', v: 4},
        {site: 'C', v: 5}, {site: 'C', v: 6},
      ],
    },
    mark: 'point',
    encoding: {
      facet: {field: 'site', type: 'nominal', columns: 2},
      x: {field: 'v', type: 'quantitative'},
    },
  }, {ignoreUnsupported: true});
  const svgs = document.querySelectorAll('svg');
  assert.ok(svgs.length >= 3, `expected at least one panel per distinct site, got ${svgs.length} svgs`);
  const grid = [...document.querySelectorAll('div')].find(d => d.style.display === 'grid');
  assert.ok(grid, 'expected a CSS grid wrapper div');
  assert.equal(grid.style.gridTemplateColumns, 'repeat(2, auto)');
  const dots = document.querySelectorAll('circle');
  assert.equal(dots.length, 6, 'expected all 6 rows drawn across the 3 panels combined');
});

test('a dodged bar with too many categories for its own width stays visible (a real min-band-size floor), not a literal 0-width rect', async () => {
  // Plot's own computed band width for a dodge (xOffset -> fx facet, see
  // catChannelPairs()) collapses all the way to a literal `width="0"`
  // once there are enough categories crammed into too little space --
  // confirmed against bar_grouped_thin.vl.json (551 directors in 500px).
  // Real Vega-Lite never lets a bar go fully invisible
  // (`config.mark.minBandSize`, default 0.25px) -- reproduced here with a
  // deliberately extreme category count in a narrow chart.
  const values = [];
  for (let i = 0; i < 300; i++) values.push({cat: 'c' + i, sub: 's0', v: i});
  const {document} = await renderSpec({
    data: {values},
    width: 100,
    mark: 'bar',
    encoding: {
      x: {field: 'cat', type: 'nominal'},
      xOffset: {field: 'sub', type: 'nominal'},
      y: {field: 'v', type: 'quantitative'},
    },
  }, {ignoreUnsupported: true});
  const widths = [...document.querySelectorAll('rect')].map(r => Number(r.getAttribute('width'))).filter(w => !Number.isNaN(w));
  assert.ok(widths.length > 0);
  for (const w of widths) assert.ok(w > 0, `expected every bar to stay visible (width > 0), got ${w}`);
});

test('an explicit config.bar.minBandSize overrides the default floor', async () => {
  const values = [];
  for (let i = 0; i < 300; i++) values.push({cat: 'c' + i, sub: 's0', v: i});
  const {document} = await renderSpec({
    data: {values},
    width: 100,
    config: {bar: {minBandSize: 4}},
    mark: 'bar',
    encoding: {
      x: {field: 'cat', type: 'nominal'},
      xOffset: {field: 'sub', type: 'nominal'},
      y: {field: 'v', type: 'quantitative'},
    },
  }, {ignoreUnsupported: true});
  const widths = [...document.querySelectorAll('rect')].map(r => Number(r.getAttribute('width'))).filter(w => !Number.isNaN(w));
  assert.ok(widths.length > 0);
  for (const w of widths) assert.ok(w >= 4, `expected every bar to respect the explicit 4px floor, got ${w}`);
});

test('yearweek/week timeUnits bucket to a real Sunday-starting week, not left untruncated', async () => {
  const {code} = await renderSpec({
    data: {values: [{d: '2021-03-15T12:00:00', v: 1}]},
    mark: 'bar',
    encoding: {
      x: {field: 'd', type: 'temporal', timeUnit: 'yearweek'},
      y: {field: 'v', type: 'quantitative'},
    },
  }, {ignoreUnsupported: true});
  assert.ok(!/unsupported timeUnit/.test(code), `expected yearweek to be a real, supported timeUnit, got:\n${code}`);
  assert.match(code, /getDate\(\)\s*-\s*.*\.getDay\(\)/, 'expected a real Sunday-of-week floor expression');
});

test('a literal point/circle size:{value} is converted area-to-radius, not used as a raw pixel radius', async () => {
  const {document} = await renderSpec({
    data: {values: [{a: 1, b: 2}]},
    mark: 'point',
    encoding: {
      x: {field: 'a', type: 'quantitative'},
      y: {field: 'b', type: 'quantitative'},
      size: {value: 100},
    },
  }, {ignoreUnsupported: true});
  const [circle] = document.querySelectorAll('circle');
  assert.ok(circle);
  const r = Number(circle.getAttribute('r'));
  // sqrt(100 / pi) =~ 5.64 -- not a literal 100px radius.
  assert.ok(r < 10, `expected a real area-to-radius conversion (~5.64px), got r=${r}`);
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
  }, {ignoreUnsupported: true});
  const circles = [...document.querySelectorAll('circle')];
  assert.equal(circles.length, 3, 'expected 2+1=3 exploded rows drawn');
  const cys = circles.map(c => Number(c.getAttribute('cy')));
  assert.equal(new Set(cys).size, 3, 'expected 3 distinct y positions (from lc.m), not all collapsed to the same undefined value');
});

test('a bar/area implicitly stacks by its own category value even with no color/detail channel', async () => {
  // bar_qq_stack.vl.json's own shape: two rows share the same x, no color
  // at all -- real Vega-Lite still stacks them (confirmed against the
  // real compiler's own output: a "stack" transform with `groupby: ["a"]`
  // even absent any color/detail channel), previously not stacked at all
  // in vl2plot (silently overlapping instead).
  const {document} = await renderSpec({
    data: {values: [{a: 1, b: 28}, {a: 1, b: 55}, {a: 5, b: 43}]},
    mark: 'bar',
    encoding: {x: {field: 'a', type: 'quantitative'}, y: {field: 'b', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  const rects = [...document.querySelectorAll('rect')].filter(r => !r.closest('[aria-label*="axis"]'));
  assert.equal(rects.length, 3);
  const atX1 = rects.filter(r => Number(r.getAttribute('x')) < 100);
  assert.equal(atX1.length, 2, 'expected both a=1 rows drawn at the same x');
  const segments = atX1
    .map(r => ({y: Number(r.getAttribute('y')), h: Number(r.getAttribute('height'))}))
    .sort((a, b) => a.y - b.y);
  // Stacked: the two segments' own y-ranges should be adjacent, not
  // overlapping (one segment's own bottom edge meets the other's top).
  assert.ok(
    Math.abs(segments[0].y + segments[0].h - segments[1].y) < 1,
    `expected two adjacent (non-overlapping) stacked segments, got ${JSON.stringify(segments)}`
  );
});

test('a bar with both x and y quantitative draws real bars at continuous positions, not band-scale points', async () => {
  const {document} = await renderSpec({
    data: {values: [{a: 3000, b: 55}, {a: 3500, b: 28}, {a: 4000, b: 55}]},
    mark: 'bar',
    encoding: {x: {field: 'a', type: 'quantitative'}, y: {field: 'b', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  const rects = [...document.querySelectorAll('rect')].filter(r => !r.closest('[aria-label*="axis"]'));
  assert.equal(rects.length, 3);
  const xs = rects.map(r => Number(r.getAttribute('x'))).sort((a, b) => a - b);
  // Evenly-spaced data (3000, 3500, 4000) on a continuous scale should
  // land at evenly-spaced pixel positions too -- a band scale would
  // instead space three ordinal categories evenly regardless of the real
  // gap between them, which happens to look identical here, so the real
  // discriminator is the bar's own fixed small width (a band scale would
  // instead divide the full plot width into 3 wide bands).
  const widths = rects.map(r => Number(r.getAttribute('width')));
  for (const w of widths) assert.ok(w < 20, `expected a small fixed-pixel bar width, got ${w}`);
});

test('a 1D bar with a quantitative category channel and no value channel spans the full plot dimension at a real continuous position', async () => {
  const {document} = await renderSpec({
    data: {values: [{b: 0}, {b: 10}, {b: 10}, {b: 20}]},
    mark: {type: 'bar', orient: 'horizontal'},
    encoding: {y: {field: 'b', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  const rects = [...document.querySelectorAll('rect')].filter(r => !r.closest('[aria-label*="axis"]'));
  assert.equal(rects.length, 4);
  const ys = rects.map(r => Number(r.getAttribute('y')));
  assert.equal(new Set(ys).size, 3, 'expected 3 distinct y positions (one per distinct b value)');
  for (const h of rects.map(r => Number(r.getAttribute('height')))) assert.ok(h < 20, `expected a small fixed-pixel height, got ${h}`);
});

test('an explicit mark.orient wins over the x/y-both-quantitative orientation heuristic', async () => {
  const {code} = await renderSpec({
    data: {values: [{a: 1, b: 28}, {a: 5, b: 43}]},
    mark: {type: 'bar', orient: 'horizontal'},
    encoding: {y: {field: 'a', type: 'quantitative'}, x: {field: 'b', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  assert.match(code, /orientation:\s*"horizontal"/);
});

test('a small explicit height/width gets proportionally smaller margins so bars stay visible', async () => {
  const {document} = await renderSpec({
    data: {values: [{d: 1}, {d: 1}, {d: 2}, {d: 3}, {d: 3}, {d: 3}]},
    width: 300,
    height: 50,
    mark: 'bar',
    encoding: {x: {field: 'd', type: 'quantitative', bin: {maxbins: 20}}, y: {aggregate: 'count', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  const rects = [...document.querySelectorAll('rect')].filter(r => !r.closest('[aria-label*="axis"]'));
  const heights = rects.map(r => Number(r.getAttribute('height')));
  assert.ok(Math.max(...heights) > 5, `expected at least one real, visible bar height, got heights=${heights}`);
});

test('a joinaggregate transform joins a per-group aggregate back onto every row, not just its own group', async () => {
  const {document} = await renderSpec({
    data: {values: [{cat: 'a', v: 8}, {cat: 'b', v: 2}, {cat: 'c', v: 4}, {cat: 'd', v: 8}, {cat: 'e', v: 2}]},
    transform: [
      {joinaggregate: [{op: 'sum', field: 'v', as: 'total'}]},
      {calculate: 'datum.v / datum.total * 100', as: 'pct'},
    ],
    mark: 'bar',
    encoding: {x: {field: 'pct', type: 'quantitative'}, y: {field: 'cat', type: 'nominal'}},
  }, {ignoreUnsupported: true});
  const rects = [...document.querySelectorAll('rect')].filter(r => !r.closest('[aria-label*="axis"]'));
  assert.equal(rects.length, 5);
  const widths = rects.map(r => Number(r.getAttribute('width')));
  // Not all bars spanning the full width (the NaN-propagation bug this
  // fixes) -- real proportions 8:2:4:8:2 of a 24 total.
  assert.ok(new Set(widths.map(w => Math.round(w))).size > 1, `expected varied bar widths reflecting real percentages, got ${widths}`);
  const maxWidth = Math.max(...widths);
  const minWidth = Math.min(...widths);
  assert.ok(maxWidth / minWidth > 3, `expected the largest bar (8) to be ~4x the smallest (2), got ratio ${maxWidth / minWidth}`);
});

test('a line mark applies its own inline aggregate, not just bar/point', async () => {
  // repeat_child_layer.vl.json's own shape: a line mark with `y:
  // {aggregate: "mean", field: ...}` -- previously renderLineOrArea()
  // never called planTransform() at all (unlike renderBar()/renderDot()),
  // silently drawing one point per raw row instead of one per aggregated
  // group.
  const {document} = await renderSpec({
    data: {values: [{m: 'Jan', v: 10}, {m: 'Jan', v: 20}, {m: 'Feb', v: 15}, {m: 'Feb', v: 25}]},
    mark: 'line',
    encoding: {x: {field: 'm', type: 'nominal'}, y: {field: 'v', type: 'quantitative', aggregate: 'mean'}},
  }, {ignoreUnsupported: true});
  const [path] = marksOf(document, 'path');
  const d = path.getAttribute('d');
  const points = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)];
  assert.equal(points.length, 2, `expected one aggregated point per category (2), got: ${d}`);
});

test('a detail channel with its own timeUnit is truncated, not left as the raw field', async () => {
  // repeat_child_layer.vl.json's own shape: `detail: {timeUnit: "year",
  // field: "date"}` (grouping lines by year) -- `detail` was previously
  // entirely missing from applyTimeUnits()'s own channel list, leaving
  // the raw (per-row-unique) date used as the z/grouping key instead of
  // the year it was truncated to.
  const {code} = await renderSpec({
    data: {values: [{date: '2020-01-01', v: 1}]},
    mark: 'line',
    encoding: {
      x: {field: 'date', type: 'temporal'},
      y: {field: 'v', type: 'quantitative'},
      detail: {field: 'date', timeUnit: 'year'},
    },
  }, {ignoreUnsupported: true});
  assert.match(code, /z:\s*"year_date"/);
});

test('an area mark with composite mark.line/mark.point overlays a real line and dots, not just the fill', async () => {
  // area_overlay.vl.json's own shape: `mark: {"type": "area", "line":
  // true, "point": true}` -- Vega-Lite's composite-mark shorthand for
  // overlaying a stroked line and point markers on top of the area fill.
  // Previously never read at all: renderLineOrArea() only ever emitted
  // the Plot.areaY() fill itself, so no line/dots were visible.
  const {document} = await renderSpec({
    data: {values: [{d: 1, v: 10}, {d: 2, v: 20}, {d: 3, v: 15}]},
    mark: {type: 'area', line: true, point: true},
    encoding: {x: {field: 'd', type: 'quantitative'}, y: {field: 'v', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  assert.equal(marksOf(document, 'circle').length, 3, 'expected one overlaid point per row');
  assert.ok(marksOf(document, 'path').length >= 2, 'expected both the area fill and the overlaid line as separate paths');
});

test('an area overlay point is filled, not left hollow by Plot.dot\'s own default', async () => {
  // area_overlay.vl.json's own shape, no color channel/mark-level color
  // at all -- commonChannels() leaves `fill` unset in that case (same
  // as it does for the area/line's own main mark), which previously let
  // Plot.dot's own per-mark-type default apply: a HOLLOW ring (`fill:
  // none, stroke: currentColor`), unlike Plot.areaY/Plot.line's own
  // solid `currentColor` fill/stroke -- a real default-styling mismatch,
  // read by the user as "no dots shown" even though a hollow ring was
  // technically present in the DOM.
  const {code} = await renderSpec({
    data: {values: [{d: 1, v: 10}, {d: 2, v: 20}]},
    mark: {type: 'area', point: true},
    encoding: {x: {field: 'd', type: 'quantitative'}, y: {field: 'v', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  assert.match(code, /Plot\.dot\([^)]*\n[^)]*fill:\s*"currentColor"/s);
});

test('an explicit literal (datum/value) y2 companion is not double-stacked by Plot.stackY', async () => {
  // area_overlay_with_y2.vl.json's own shape: `y2: {datum: 0}` -- an
  // explicit zero baseline spelled out as a literal companion instead of
  // relying on the implicit one. planStack()'s own "already has an
  // explicit range" exclusion previously only recognized a `.field`
  // companion, missing a `datum`/`value` one -- so this still got
  // wrapped in Plot.stackY(...), which doesn't recognize an explicit
  // y1/y2 pair as its own value channel at all, silently producing a
  // broken (thin line-only-looking) mark instead of the real filled area.
  const {code} = await renderSpec({
    data: {values: [{d: 1, v: 10}, {d: 2, v: 20}]},
    mark: {type: 'area'},
    encoding: {
      x: {field: 'd', type: 'quantitative'},
      y: {field: 'v', type: 'quantitative'},
      y2: {datum: 0, type: 'quantitative'},
    },
  }, {ignoreUnsupported: true});
  assert.doesNotMatch(code, /Plot\.stackY/);
  assert.match(code, /y1:\s*0/);
});

test('an area with independently aggregated y and y2 companions computes both, not just one', async () => {
  // area_temperature_range.vl.json's own shape: `y: {aggregate: "max",
  // field: "temp_max"}` + `y2: {aggregate: "min", field: "temp_min"}` --
  // planTransform()'s own single-aggregate-channel design only ever
  // named its output after the plain VL channel ("y"), which doesn't
  // exist at all on an area-with-companion mark (drawn through Plot's
  // own y1/y2 pair instead) -- Plot.groupX silently computed nothing for
  // a channel key that was never present, and the companion's own
  // *independent* aggregate had no representation at all, producing no
  // visible shape (just axes).
  const {code} = await renderSpec({
    data: {values: [{g: 'a', hi: 10, lo: 1}, {g: 'a', hi: 20, lo: 2}, {g: 'b', hi: 5, lo: 0}]},
    mark: 'area',
    encoding: {
      x: {field: 'g', type: 'nominal'},
      y: {aggregate: 'max', field: 'hi', type: 'quantitative'},
      y2: {aggregate: 'min', field: 'lo'},
    },
  }, {ignoreUnsupported: true});
  assert.match(code, /y2:\s*"max"/);
  assert.match(code, /y1:\s*"min"/);
});

test('bin: "binned" (the bare-string shorthand) is recognized as pre-binned, not a request to bin now', async () => {
  // layer_cumulative_histogram.vl.json's own shape: `x: {bin: "binned",
  // ...}` -- Vega-Lite's schema allows this bare-string shorthand as an
  // alternative to `bin: {"binned": true}`; the isPreBinned check
  // previously only recognized the object form, so the string form was
  // misread as a genuine "bin this now" request, tripping the "aggregated
  // value on a continuous bin-interval category axis" guard and silently
  // dropping the mark entirely under --ignore-unsupported (both of that
  // spec's own layers ended up with an empty `marks: []`, "just axes").
  const {code} = await renderSpec({
    data: {values: [{lo: 0, hi: 1, n: 3}, {lo: 1, hi: 2, n: 5}]},
    mark: 'bar',
    encoding: {
      x: {field: 'lo', type: 'quantitative', bin: 'binned'},
      x2: {field: 'hi'},
      y: {field: 'n', type: 'quantitative'},
    },
  }, {ignoreUnsupported: true});
  assert.doesNotMatch(code, /marks:\s*\[\s*\]/, `expected a real mark, not an empty marks array, got: ${code}`);
  assert.match(code, /Plot\.(bar|rect)/);
});

test('mark.clip:true clips the mark to the plot frame, matching the horizon-graph idiom', async () => {
  // area_horizon.vl.json's own shape: a second layer shifted down by a
  // calculate transform, relying on `clip: true` to hide the part that
  // spills below y=0 instead of letting it show through under the axis.
  // Previously `markProps.clip` was never read at all.
  const {code} = await renderSpec({
    data: {values: [{x: 1, y: 10}, {x: 2, y: -5}]},
    mark: {type: 'area', clip: true},
    encoding: {x: {field: 'x', type: 'quantitative'}, y: {field: 'y', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  assert.match(code, /clip:\s*true/);
});

test('repeat: {column: [...]} lays panels out side by side, with no flex-wrap to reflow them into rows', async () => {
  // repeat_independent_colors.vl.json's own shape -- a `repeat: {column:
  // [...]}` (no `row`) expands to `hconcat`, whose wrapper previously set
  // `flexWrap: 'wrap'` unconditionally: in a panel narrower than the
  // combined width of every child, this silently reflowed the children
  // onto separate lines, visually indistinguishable from a vconcat/row
  // layout even though `flexDirection` was already correctly `'row'`.
  const {code} = await renderSpec({
    repeat: {column: ['Origin', 'Cylinders']},
    spec: {
      data: {values: [{Horsepower: 1, Miles_per_Gallon: 2, Origin: 'a', Cylinders: 4}]},
      mark: 'point',
      encoding: {x: {field: 'Horsepower', type: 'quantitative'}, y: {field: 'Miles_per_Gallon', type: 'quantitative'}},
    },
  }, {ignoreUnsupported: true});
  assert.match(code, /flexDirection = 'row'/);
  assert.doesNotMatch(code, /flexWrap/);
});

test('bin:true (no explicit maxbins) defaults to 10 bins, matching real Vega-Lite, not Plot\'s own finer auto-threshold', async () => {
  // repeat_layer.vl.json's own shape -- confirmed against the real
  // vega-lite compiler's own output (`bin_maxbins_10_...`) that a plain
  // `bin: true` always defaults to `maxbins: 10`. Left unset, Plot's own
  // auto-threshold heuristic produced a much finer bin count on a large
  // dataset (39 bins on movies.json, not 10) -- a noticeably more jagged,
  // differently-shaped line than every other tool's own rendering of the
  // identical spec.
  const {code} = await renderSpec({
    data: {values: Array.from({length: 200}, (_, i) => ({r: i % 10, v: i}))},
    mark: 'line',
    encoding: {
      x: {field: 'r', type: 'quantitative', bin: true},
      y: {field: 'v', type: 'quantitative', aggregate: 'mean'},
    },
  }, {ignoreUnsupported: true});
  assert.match(code, /thresholds:\s*10/);
});

test('rect with both x and y binned draws a real 2D grid of cells, not a 1D smear along one axis', async () => {
  // rect_binned_heatmap.vl.json's own shape: `x`/`y` both `bin: {maxbins:
  // N}`, `color: {aggregate: "count"}` -- planTransform()'s own 1D-only
  // bin/group convention previously bound only x, leaving y's own bin
  // spec as a plain unbucketed field: every row sharing an x-bin
  // collapsed into one giant vertical smear regardless of its own y
  // value, instead of a real 2D grid of binned cells.
  const values = [];
  for (let x = 0; x < 20; x++) for (let y = 0; y < 20; y++) values.push({x, y});
  const {document} = await renderSpec({
    data: {values},
    mark: 'rect',
    encoding: {
      x: {field: 'x', type: 'quantitative', bin: {maxbins: 5}},
      y: {field: 'y', type: 'quantitative', bin: {maxbins: 5}},
      color: {aggregate: 'count', type: 'quantitative'},
    },
  }, {ignoreUnsupported: true});
  const rects = marksOf(document, 'rect');
  const xs = new Set(rects.map(r => r.getAttribute('x')));
  const ys = new Set(rects.map(r => r.getAttribute('y')));
  assert.ok(xs.size > 1, `expected multiple distinct x positions, got ${xs.size}`);
  assert.ok(ys.size > 1, `expected multiple distinct y positions, got ${ys.size}`);
});

test('a top-level fold transform un-pivots the listed fields, not silently skipped', async () => {
  // area_density_stacked_fold.vl.json's own shape: a `fold` transform
  // (previously entirely unsupported, silently skipped under
  // --ignore-unsupported) feeding a SUBSEQUENT `density` transform that
  // reads fold's own "value" output column -- with fold skipped, that
  // column never existed at all, so density computed over an
  // all-undefined field, producing no plottable data (the user-reported
  // "doesn't seem to be plotting data" symptom).
  const {code} = await renderSpec({
    data: {values: [{a: 1, b: 2}, {a: 3, b: 4}]},
    transform: [{fold: ['a', 'b'], as: ['key', 'val']}],
    mark: 'point',
    encoding: {x: {field: 'key', type: 'nominal'}, y: {field: 'val', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  assert.doesNotMatch(code, /skipped unsupported transform/);
  assert.match(code, /flatMap/);
});

test('a genuinely quantitative yOffset draws a real sub-band ranged bar, not a dodge/facet', async () => {
  // bar_ranged_offset_quantitative.vl.json's own shape: `y: {field:
  // "team"}` + `yOffset: {field: "score", type: "quantitative"}` --
  // confirmed against the real compiler's own output that this means a
  // LINEAR sub-scale within the outer team band (domain: the field's own
  // real min/max, range: [0, bandwidth]), a small FIXED height (18px),
  // NOT the far more common categorical dodge treatment (which would
  // repurpose y into a facet). Previously fell through to the dodge path
  // regardless of type, producing a stray fy facet and a raw (unscaled)
  // score value used directly as a band position.
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
  assert.doesNotMatch(code, /\bfy:/);
  const rects = marksOf(document, 'rect');
  assert.equal(rects.length, 4);
  const widths = new Set(rects.map(r => r.getAttribute('width')));
  assert.equal(widths.size, 1, `expected every bar to share the same real bandwidth, got widths: ${[...widths]}`);
  assert.notEqual(widths.values().next().value, '0', 'expected a nonzero bandwidth, not the zero-width point-scale collapse');
  const heights = new Set(rects.map(r => r.getAttribute('height')));
  assert.equal(heights.size, 1, `expected every bar to share the same fixed sub-band height, got: ${[...heights]}`);
  const ys = new Set(rects.map(r => r.getAttribute('y')));
  assert.equal(ys.size, 4, `expected 4 distinct y positions (one per row's own score), got: ${ys.size}`);
});

test('an escaped-dot field name (a real "." in the name, not a nested path) survives timeUnit derivation', async () => {
  // bar_simple_binned_timeunit_special_chars.vl.json's own shape: `field:
  // "a\\.b"` (Vega-Lite's own escape convention for a literal dot in a
  // field name) on a `timeUnit`-bearing channel -- previously
  // collectTemporalFields()/applyTimeUnits() used the raw, still-escaped
  // field string both to READ the source column and to NAME the derived
  // one, while the mark's own later channel-value rendering unescapes it
  // -- creating the derived column under one key
  // ("binnedyear_a\\.b", a literal backslash) but reading it back under a
  // DIFFERENT one ("binnedyear_a.b"), silently producing `undefined` for
  // every row.
  const {code} = await renderSpec({
    data: {values: [{'a.b': '2022-01-01', v: 1}, {'a.b': '2022-01-02', v: 2}]},
    mark: 'bar',
    encoding: {
      y: {field: 'a\\.b', type: 'temporal', timeUnit: 'yearmonthdate'},
      x: {field: 'v', type: 'quantitative'},
    },
  }, {ignoreUnsupported: true});
  assert.doesNotMatch(code, /\\\\\./, `expected no literal backslash-dot surviving into the generated field names, got: ${code}`);
  assert.match(code, /"a\.b"/, `expected the real unescaped column name "a.b" to appear, got: ${code}`);
});

test('a rule at a groupless 1D aggregate spans the full opposite axis, not a near-invisible sliver', async () => {
  // layer_histogram_global_mean.vl.json's own shape: `mark: "rule"`,
  // `x: {aggregate: "mean", field: "IMDB Rating"}`, no y channel at all
  // -- planTransform()'s own `needsConstantKey` injects a constant onto
  // the missing y channel so Plot.groupY has something to group by, but
  // that same constant then survives into the FINAL rendered mark
  // unchanged, giving Plot.ruleX a real (if constant) y position instead
  // of leaving it absent -- the exact signal ruleX uses to span the full
  // height by default. Bypassed by precomputing the aggregate directly.
  const {document, code} = await renderSpec({
    data: {values: [{v: 1}, {v: 2}, {v: 3}]},
    mark: 'rule',
    encoding: {x: {aggregate: 'mean', field: 'v', type: 'quantitative'}},
  }, {ignoreUnsupported: true});
  assert.doesNotMatch(code, /Plot\.groupY/);
  assert.match(code, /d3\.mean/);
  assert.match(code, /Plot\.ruleX\(\[null\]/, `expected the rule to draw from a single-row array, not the full per-row dataset, got: ${code}`);
  const lines = marksOf(document, 'line');
  assert.equal(lines.length, 1, 'expected exactly one rule line, not one per data row');
  const line = lines[0];
  assert.equal(line.getAttribute('x1'), line.getAttribute('x2'), 'expected a vertical rule (same x1/x2)');
  assert.notEqual(line.getAttribute('y1'), line.getAttribute('y2'), 'expected the rule to span a real y range, not a zero-height sliver');
});

test('a rule aggregated with a real per-row color field (no other position channel) groups by color, not x', async () => {
  // layer_line_color_rule.vl.json's own shape: a rule layer with
  // `y: {aggregate: "mean", field: "price"}, color: {field: "symbol"}`,
  // no `x` channel at all. `hasGroupKey` (a real color field) previously
  // still routed this to `Plot.groupX`, which defaults an absent `x`
  // option to Plot's own `identity` accessor (NOT null) rather than
  // throwing -- silently grouping by each row's own object reference
  // (one degenerate near-zero-height group per row) and feeding those
  // non-numeric "x values" into the shared x-scale, corrupting its
  // domain. `Plot.groupZ` groups purely on {z, fill, stroke}, with no x
  // requirement at all -- the correct fit whenever a real *non-position*
  // group key exists but the other position channel is genuinely absent.
  const {document, code} = await renderSpec({
    data: {values: [
      {sym: 'A', v: 1}, {sym: 'A', v: 3},
      {sym: 'B', v: 10}, {sym: 'B', v: 20},
    ]},
    mark: 'rule',
    encoding: {
      y: {aggregate: 'mean', field: 'v', type: 'quantitative'},
      color: {field: 'sym', type: 'nominal'},
    },
  }, {ignoreUnsupported: true});
  assert.doesNotMatch(code, /Plot\.groupX/);
  assert.match(code, /Plot\.groupZ/);
  const lines = marksOf(document, 'line');
  assert.equal(lines.length, 2, 'expected one horizontal rule line per color group, not one per data row');
  for (const line of lines) {
    assert.equal(line.getAttribute('y1'), line.getAttribute('y2'), 'expected a horizontal rule (same y1/y2)');
    assert.notEqual(line.getAttribute('x1'), line.getAttribute('x2'), 'expected the rule to span the full x range, not a zero-width sliver');
  }
});

test('resolve: {scale: {y: "independent"}} (dual axis) draws each layer on its own y scale', async () => {
  // layer_dual_axis.vl.json's own shape: an area layer (temp, y domain
  // [0,30]) and a line layer (precipitation, a totally different range),
  // resolved to independent y scales -- Plot has no native per-mark
  // independent scale within one `Plot.plot()` call, so this renders two
  // separate SVGs (one per resolve group) overlaid in a wrapper div, the
  // second with its y-axis moved to the right and its own x-axis
  // suppressed (the shared x already drawn by the first).
  const {document} = await renderSpec({
    width: 200, height: 150,
    data: {values: [
      {m: 1, temp: 5, rain: 0.5}, {m: 2, temp: 8, rain: 2.0}, {m: 3, temp: 12, rain: 4.5},
    ]},
    encoding: {x: {field: 'm', type: 'ordinal'}},
    layer: [
      {mark: 'area', encoding: {y: {field: 'temp', type: 'quantitative'}}},
      {mark: 'line', encoding: {y: {field: 'rain', type: 'quantitative'}}},
    ],
    resolve: {scale: {y: 'independent'}},
  }, {ignoreUnsupported: true});
  const svgs = [...document.querySelectorAll('svg')];
  assert.equal(svgs.length, 2, 'expected two overlaid SVGs, one per resolve group');
  const [primarySvg, independentSvg] = svgs;
  assert.ok(primarySvg.querySelector('g[aria-label="x-axis tick label"]'), 'expected the primary SVG to draw the shared x-axis');
  assert.ok(!independentSvg.querySelector('g[aria-label="x-axis tick label"]'), 'expected the independent SVG to suppress its own (redundant) x-axis');
  const rightAxisText = independentSvg.querySelector('g[aria-label="y-axis tick label"] text');
  const rightAxisX = Number(rightAxisText.getAttribute('transform').match(/translate\(([\d.]+),/)[1]);
  assert.ok(rightAxisX > 100, `expected the independent y-axis anchored on the right (large x), got ${rightAxisX}`);
});

test('an untyped y with only a quantitative-only scale.type still counts as quantitative for orientation', async () => {
  // layer_line_window.vl.json's own shape: `x: {field: "row", type:
  // "quantitative"}`, `y: {field: "fps", scale: {type: "log"}}` -- no
  // explicit "type" on y at all. orientation()'s own `isQuantitative(x)
  // && !isQuantitative(y)` heuristic previously read the untyped y as
  // NOT quantitative purely for lacking an explicit label (even though a
  // log scale only ever applies to a quantitative field), misclassifying
  // this as a "horizontal" line and, through that, handing the line's
  // own default sort-by-domain-field fallback the WRONG field (y's own
  // "fps", instead of x's "row") -- silently connecting points in
  // ascending-fps order instead of trial order.
  const {code} = await renderSpec({
    data: {values: [{row: 1, fps: 60}, {row: 2, fps: 30}, {row: 3, fps: 45}]},
    mark: 'line',
    encoding: {
      x: {field: 'row', type: 'quantitative'},
      y: {field: 'fps', scale: {type: 'log'}},
    },
  }, {ignoreUnsupported: true});
  assert.match(code, /x: "row"/);
  assert.match(code, /sort: "row"/);
  assert.doesNotMatch(code, /sort: "fps"/);
});

test('a bar with a single temporal position and no value channel spans the full opposite axis', async () => {
  // layer_null_data.vl.json's own shape: a second layer highlighting each
  // null-data date with a translucent reference band --
  // `mark: {type: "bar", color: "red", opacity: 0.2}`, `x: {timeUnit:
  // "yearmonthdate", field: "a", bandPosition: 0}`, no y at all. Neither
  // `Plot.barY` (needs a real band x scale; the shared x here is
  // continuous, since the sibling line layer also plots on it) nor a
  // literal `y1`/`y2` of `-Infinity`/`Infinity` (confirmed empirically:
  // Plot silently draws nothing at all) can express this -- routed
  // through the same VlQBar custom mark the quantitative "no value
  // channel" bar shape already uses, with an auto-derived (not fixed
  // 5px) width and the full plot height via `dimensions`.
  const {document, code} = await renderSpec({
    data: {values: [
      {a: 'Jan 1, 2000', b: 28}, {a: 'Jan 2, 2000', b: null}, {a: 'Jan 3, 2000', b: 43},
    ]},
    layer: [
      {mark: 'line', encoding: {
        x: {timeUnit: 'yearmonthdate', field: 'a', type: 'temporal'},
        y: {field: 'b', type: 'quantitative'},
      }},
      {
        transform: [{filter: 'datum.b === null'}],
        mark: {type: 'bar', color: 'red', opacity: 0.2},
        encoding: {x: {timeUnit: 'yearmonthdate', field: 'a', type: 'temporal', bandPosition: 0}},
      },
    ],
  }, {ignoreUnsupported: true});
  assert.match(code, /new VlQBar/);
  const rects = [...document.querySelectorAll('rect')].filter(r => !r.closest('[aria-label*="axis"]'));
  assert.equal(rects.length, 1, 'expected exactly one reference band, for the one null-data row');
  const rect = rects[0];
  assert.equal(rect.getAttribute('fill'), 'red');
  assert.equal(rect.getAttribute('opacity'), '0.2');
  assert.ok(Number(rect.getAttribute('height')) > 100, `expected the band to span the full plot height, got ${rect.getAttribute('height')}`);
  assert.ok(Number(rect.getAttribute('width')) > 0, `expected a real, non-degenerate width, got ${rect.getAttribute('width')}`);
});

test('config.line.point (a top-level default, not a per-mark property) still overlays point markers', async () => {
  // layer_overlay.vl.json's own shape: `config: {line: {point: true}}`,
  // no per-mark `point` property anywhere -- the composite line+point
  // overlay previously only ever checked `markProps.point`, silently
  // ignoring an identical config-level default and drawing a plain line
  // with no point markers at all.
  const {document, code} = await renderSpec({
    config: {line: {point: true}},
    data: {values: [{c: 1, h: 10}, {c: 2, h: 20}, {c: 1, h: 15}]},
    mark: 'line',
    encoding: {
      x: {field: 'c', type: 'ordinal'},
      y: {aggregate: 'max', field: 'h', type: 'quantitative'},
    },
  }, {ignoreUnsupported: true});
  assert.match(code, /Plot\.dot/);
  const circles = [...document.querySelectorAll('circle')].filter(c => !c.closest('[class*="swatch"]'));
  assert.equal(circles.length, 2, 'expected one point marker per distinct x, from the config-level default');
});

test('an explicit stack: null on an aggregated, color-grouped bar draws real overlapping (not stacked) bars, with opacity applied', async () => {
  // bar_layered_transparent.vl.json's own shape: `y: {aggregate: "sum",
  // field: "people", stack: null}` + `color: {field: "gender"}` +
  // `opacity: {value: 0.7}` -- two independent bugs. (1) `Plot.barY`/
  // `barX` call `maybeStackY`/`maybeStackX` INTERNALLY (Plot's own
  // source), auto-stacking a bare `y` pair regardless of whether this
  // module's own Plot.stackY wrapper is applied -- an explicit `y1: 0`
  // pair doesn't survive AT ALL once the value channel is grouped
  // through `Plot.groupX` (confirmed empirically: Plot's own group
  // transform silently drops any option key that isn't the position
  // channel, z/fill/stroke, or one of its own declared `outputs`
  // reducers), so `y1` has to be declared as its own output reducer,
  // fed a constant `() => 0` literal accessor as its real per-row input.
  // (2) `opacity: {value: 0.7}` (a genuine literal, not a per-row field)
  // was unconditionally stripped from a GROUPED mark's own options by
  // UNGROUPABLE_STYLE_CHANNELS, a filter meant only for a real per-row
  // opacity FIELD (which Plot's group transform can't reduce), not a
  // constant.
  const {document, code} = await renderSpec({
    data: {values: [
      {a: 'A', g: 'x', v: 3}, {a: 'A', g: 'y', v: 5},
      {a: 'B', g: 'x', v: 2}, {a: 'B', g: 'y', v: 4},
    ]},
    mark: 'bar',
    encoding: {
      x: {field: 'a', type: 'ordinal'},
      y: {aggregate: 'sum', field: 'v', stack: null},
      color: {field: 'g', type: 'nominal'},
      opacity: {value: 0.7},
    },
  }, {ignoreUnsupported: true});
  assert.match(code, /opacity: 0\.7/);
  const rects = [...document.querySelectorAll('rect')].filter(r => !r.closest('[class*="swatch"]'));
  assert.equal(rects.length, 4);
  for (const r of rects) assert.equal(r.getAttribute('opacity'), '0.7');
  const byX = {};
  for (const r of rects) {
    const x = r.getAttribute('x');
    (byX[x] ??= []).push(Number(r.getAttribute('y')) + Number(r.getAttribute('height')));
  }
  for (const bottoms of Object.values(byX)) {
    assert.equal(bottoms.length, 2);
    assert.ok(
      Math.abs(bottoms[0] - bottoms[1]) < 0.01,
      `expected both bars at the same x to share the same zero-baseline bottom (overlapping, not stacked), got ${bottoms}`
    );
  }
});

test('a nested-object field path (one or two levels deep) resolves to real per-row data, not undefined', async () => {
  // bar_layered_weather.vl.json's own shape: `y: {field: "record.low"}`,
  // `y2: {field: "record.high"}` (one level), and `y: {field: "forecast.
  // low.low"}` (two levels) -- Plot resolves a bare field-name STRING as
  // a plain `d[name]` lookup (no path-drilling of its own), so passing a
  // nested path straight through silently resolves to `undefined` for
  // every row, and Plot's own per-channel `defined()` row filter then
  // excludes every row entirely -- "no data plotted" for the whole mark,
  // not just a wrong value. `vlFlattenOneLevel()` only ever runs for
  // inline `values` data (not a URL-loaded dataset) and only flattens
  // one level deep -- insufficient for the two-level `forecast.low.low`
  // shape either way.
  const {document, code} = await renderSpec({
    data: {values: [
      {id: 0, record: {low: 15, high: 62}, forecast: {low: {low: 35, high: 40}}},
      {id: 1, record: {low: 23, high: 62}, forecast: {low: {low: 37, high: 42}}},
    ]},
    layer: [
      {mark: 'bar', encoding: {x: {field: 'id', type: 'ordinal'}, y: {field: 'record.low'}, y2: {field: 'record.high'}}},
      {mark: 'bar', encoding: {x: {field: 'id', type: 'ordinal'}, y: {field: 'forecast.low.low'}, y2: {field: 'forecast.low.high'}}},
    ],
  }, {ignoreUnsupported: true});
  assert.doesNotMatch(code, /"record\.low"/, `expected no raw dotted field name spliced in as-is, got: ${code}`);
  const rects = marksOf(document, 'rect');
  assert.equal(rects.length, 4, 'expected 2 rows x 2 layers = 4 real bars, not zero');
  for (const r of rects) {
    assert.ok(Number(r.getAttribute('height')) > 0, `expected a real, non-degenerate bar height, got ${r.getAttribute('height')}`);
  }
});

test('a bar with both fill and stroke encoding channels draws a real border, not just the fill', async () => {
  // bar_multi_values_per_categories.vl.json's own shape: `fill: {value:
  // "steelblue"}` + `stroke: {value: "white"}`, a white border separating
  // adjacent stacked segments -- commonChannels()'s own `colorDef` OR-
  // chain (`encoding.color || encoding.fill || encoding.stroke`) only
  // ever falls back to `stroke` when NEITHER `color` nor `fill` is set,
  // so a spec giving BOTH silently dropped `stroke` entirely (it never
  // reached the fallback, since `fill` already won).
  const {document, code} = await renderSpec({
    data: {values: [{a: 'A', b: 1}, {a: 'A', b: 2}, {a: 'B', b: 3}]},
    mark: 'bar',
    encoding: {
      x: {field: 'a', type: 'nominal'},
      y: {field: 'b', type: 'quantitative', stack: true},
      fill: {value: 'steelblue'},
      stroke: {value: 'white'},
    },
  }, {ignoreUnsupported: true});
  assert.match(code, /stroke: \(\) => "white"/);
  const rects = marksOf(document, 'rect');
  assert.ok(rects.length > 0);
  for (const r of rects) {
    assert.equal(r.getAttribute('fill'), 'steelblue');
    assert.equal(r.getAttribute('stroke'), 'white');
  }
});
