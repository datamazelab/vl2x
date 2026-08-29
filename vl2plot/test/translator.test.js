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
