import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdirSync} from 'node:fs';
import {vegaLiteToVegaLiteApiCode} from '../src/index.js';

mkdirSync(new URL('.scratch/', import.meta.url), {recursive: true});
let counter = 0;

// Translate a spec, exec the generated code, and return the resulting chart
// object's `.toObject()` (the plain Vega-Lite JSON it represents).
async function run(spec) {
  const code = vegaLiteToVegaLiteApiCode(spec);
  const path = new URL(`.scratch/t${counter++}.mjs`, import.meta.url);
  writeFileSync(path, code);
  const mod = await import(path.href + `?t=${Date.now()}`);
  return {obj: mod.default.toObject(), code};
}

test('simple bar chart', async () => {
  const spec = {
    data: {values: [{a: 'A', b: 28}, {a: 'B', b: 55}]},
    mark: 'bar',
    encoding: {
      x: {field: 'a', type: 'nominal'},
      y: {field: 'b', type: 'quantitative'},
    },
  };
  const {obj} = await run(spec);
  assert.deepEqual(obj.mark, {type: 'bar'});
  assert.deepEqual(obj.encoding.x, {field: 'a', type: 'nominal'});
  assert.deepEqual(obj.encoding.y, {field: 'b', type: 'quantitative'});
  assert.deepEqual(obj.data.values, spec.data.values);
});

test('scatter with color and tooltip list', async () => {
  const spec = {
    data: {url: 'data/cars.json'},
    mark: 'point',
    encoding: {
      x: {field: 'Horsepower', type: 'quantitative'},
      y: {field: 'Miles_per_Gallon', type: 'quantitative'},
      color: {field: 'Origin', type: 'nominal'},
      tooltip: [
        {field: 'Name', type: 'nominal'},
        {field: 'Horsepower', type: 'quantitative'},
      ],
    },
  };
  const {obj} = await run(spec);
  assert.deepEqual(obj.data, {url: 'data/cars.json'});
  assert.deepEqual(obj.encoding.color, {field: 'Origin', type: 'nominal'});
  assert.deepEqual(obj.encoding.tooltip, spec.encoding.tooltip);
});

test('transform filter/calculate/aggregate, including reserved-word-like keys', async () => {
  const spec = {
    data: {url: 'data/movies.json'},
    transform: [
      {filter: 'datum.IMDB_Rating > 5'},
      {calculate: 'datum.Rating / 2', as: 'HalfRating'},
      {aggregate: [{op: 'mean', field: 'HalfRating', as: 'MeanHalf'}], groupby: ['Major_Genre']},
    ],
    mark: 'bar',
    encoding: {
      x: {field: 'Major_Genre', type: 'nominal'},
      y: {field: 'MeanHalf', type: 'quantitative'},
    },
  };
  const {obj} = await run(spec);
  assert.deepEqual(obj.transform, spec.transform);
});

test('layered chart with shared encoding stays at the layer level', async () => {
  const spec = {
    data: {values: [{x: 1, y: 2}, {x: 2, y: 3}]},
    encoding: {x: {field: 'x', type: 'quantitative'}},
    layer: [
      {mark: 'line', encoding: {y: {field: 'y', type: 'quantitative'}}},
      {mark: 'point', encoding: {y: {field: 'y', type: 'quantitative'}}},
    ],
  };
  const {obj} = await run(spec);
  assert.equal(obj.layer.length, 2);
  assert.deepEqual(obj.layer[0].mark, {type: 'line'});
  assert.deepEqual(obj.layer[1].mark, {type: 'point'});
  assert.deepEqual(obj.encoding.x, {field: 'x', type: 'quantitative'});
  assert.deepEqual(obj.data.values, spec.data.values);
  // Each child keeps only its own encoding (y); the shared x channel and
  // the data live at the layer level, not duplicated into each child --
  // unlike some other translators, no merging is needed here, since
  // vega-lite itself resolves the inheritance at compile time.
  assert.deepEqual(obj.layer[0].encoding, {y: {field: 'y', type: 'quantitative'}});
  assert.equal(obj.layer[0].data, undefined);
});

test('faceted chart', async () => {
  const spec = {
    data: {url: 'data/cars.json'},
    facet: {column: {field: 'Origin', type: 'nominal'}},
    spec: {
      mark: 'point',
      encoding: {
        x: {field: 'Horsepower', type: 'quantitative'},
        y: {field: 'Miles_per_Gallon', type: 'quantitative'},
      },
    },
  };
  const {obj} = await run(spec);
  assert.deepEqual(obj.facet, {column: {field: 'Origin', type: 'nominal'}});
  assert.deepEqual(obj.data, {url: 'data/cars.json'});
  assert.equal(obj.spec.data, undefined);
});

test('hconcat', async () => {
  const spec = {
    data: {values: [{a: 1}]},
    hconcat: [
      {mark: 'bar', encoding: {x: {field: 'a', type: 'quantitative'}}},
      {mark: 'point', encoding: {x: {field: 'a', type: 'quantitative'}}},
    ],
  };
  const {obj} = await run(spec);
  assert.equal(obj.hconcat.length, 2);
  assert.deepEqual(obj.hconcat[0].mark, {type: 'bar'});
  assert.deepEqual(obj.hconcat[1].mark, {type: 'point'});
});

test('selection param and condition', async () => {
  const spec = {
    data: {values: [{a: 'A', b: 1}]},
    params: [{name: 'select', select: 'point'}],
    mark: 'bar',
    encoding: {
      x: {field: 'a', type: 'nominal'},
      y: {field: 'b', type: 'quantitative'},
      color: {
        condition: {param: 'select', field: 'a', type: 'nominal'},
        value: 'grey',
      },
    },
  };
  const {obj} = await run(spec);
  assert.equal(obj.params[0].name, 'select');
  assert.equal(obj.params[0].select, 'point');
  assert.deepEqual(obj.encoding.color.condition, {param: 'select', field: 'a', type: 'nominal'});
  assert.equal(obj.encoding.color.value, 'grey');
});

test('config, projection, and properties', async () => {
  const spec = {
    data: {values: [{a: 1}]},
    mark: 'bar',
    width: 300,
    height: 200,
    title: 'My Chart',
    encoding: {x: {field: 'a', type: 'quantitative'}},
    config: {axis: {grid: false}},
    projection: {type: 'albersUsa'},
  };
  const {obj} = await run(spec);
  assert.equal(obj.width, 300);
  assert.equal(obj.height, 200);
  assert.equal(obj.title, 'My Chart');
  assert.deepEqual(obj.config.axis, {grid: false});
  assert.deepEqual(obj.projection, {type: 'albersUsa'});
});

test('empty encoding/transform/params do not break the chain', async () => {
  const spec = {
    data: {values: [{a: 1}]},
    mark: 'point',
    encoding: {},
    transform: [],
  };
  const {obj} = await run(spec);
  assert.deepEqual(obj.mark, {type: 'point'});
});

test('named datasets are hoisted once', async () => {
  const spec = {
    datasets: {mydata: [{a: 1}, {a: 2}]},
    hconcat: [
      {data: {name: 'mydata'}, mark: 'bar', encoding: {x: {field: 'a', type: 'quantitative'}}},
      {data: {name: 'mydata'}, mark: 'point', encoding: {x: {field: 'a', type: 'quantitative'}}},
    ],
  };
  const {obj, code} = await run(spec);
  const occurrences = code.split('[{a: 1}, {a: 2}]').length - 1;
  assert.equal(occurrences, 1, 'dataset literal should appear exactly once in generated source');
  assert.equal(obj.hconcat.length, 2);
  assert.deepEqual(obj.datasets.mydata, [{a: 1}, {a: 2}]);
});
