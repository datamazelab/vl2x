// Render the code that loads/produces the initial `data` array, plus a
// statement to coerce any temporal-typed fields (referenced by the spec's
// encodings) from strings into real JS `Date` objects, since D3 time
// scales and the timeUnit helpers both expect that.

import {formatValue} from './literals.js';

// Vega-Lite's own convention for inline `values`: an array of *primitive*
// values (not row objects) is ingested as if each were `{"data": value}` --
// e.g. `"values": [1, 2, 3]` means one row per number, each with a single
// field named "data" (matching vl2ggplot's render_inline_values(), which
// already does the same wrapping).
function wrapPrimitiveValues(values) {
  if (values.length === 0 || (values[0] !== null && typeof values[0] === 'object' && !Array.isArray(values[0]))) {
    return values;
  }
  return values.map(v => ({data: v}));
}

export function renderDataLoad(data, dataVar, ignoreUnsupported = false) {
  if (data && Array.isArray(data.values)) {
    return {statements: [`let ${dataVar} = ${formatValue(wrapPrimitiveValues(data.values))};`], isAsync: false};
  }
  if (data && typeof data.url === 'string') {
    const format = (data.format && data.format.type) || guessFormatFromUrl(data.url);
    const loader = {csv: 'csv', tsv: 'tsv', json: 'json'}[format] || 'json';
    const parseNumbers = loader === 'json' ? '' : ', d3.autoType';
    // Resolved against `options.baseURL` if given, else the module's own
    // location -- a relative "data/xyz.csv" URL has no inherent meaning on
    // its own (unlike in a browser page, this code doesn't have a
    // surrounding document location to resolve against by default).
    const urlExpr = `new URL(${formatValue(data.url)}, options.baseURL ?? import.meta.url)`;
    return {
      statements: [`let ${dataVar} = await d3.${loader}(${urlExpr}${parseNumbers});`],
      isAsync: true,
    };
  }
  if (data && data.sequence && typeof data.sequence === 'object') {
    // A `sequence` data generator produces its own rows outright (no
    // fetch/parse involved) -- one row per step from `start` (inclusive) to
    // `stop` (exclusive), each holding just the sequence value under `as`
    // (Vega-Lite's own default field name, "data", when `as` is omitted).
    const {start, stop, step = 1, as = 'data'} = data.sequence;
    return {
      statements: [`let ${dataVar} = d3.range(${formatValue(start)}, ${formatValue(stop)}, ${formatValue(step)}).map(v => ({${JSON.stringify(as)}: v}));`],
      isAsync: false,
    };
  }
  if (ignoreUnsupported) {
    // Nothing to load (no `values`, no `url`, no `sequence`) -- an empty
    // dataset still lets the rest of the chart (axes, other layers) render
    // instead of aborting entirely.
    return {
      statements: [
        `// vl2d3: unsupported data source (expected inline "values" or a "url"), using an empty dataset (--ignore-unsupported)`,
        `let ${dataVar} = [];`,
      ],
      isAsync: false,
    };
  }
  throw new Error('Unsupported data source: expected inline "values", a "url", or a "sequence" generator');
}

function guessFormatFromUrl(url) {
  const ext = url.split('.').pop().split(/[?#]/)[0];
  return ['csv', 'tsv', 'json'].includes(ext) ? ext : 'json';
}

export function renderTemporalCoercion(dataVar, temporalFields) {
  if (!temporalFields.length) return [];
  const assigns = temporalFields.map(f => `${JSON.stringify(f)}: new Date(d[${JSON.stringify(f)}])`);
  return [`${dataVar} = ${dataVar}.map(d => ({...d, ${assigns.join(', ')}}));`];
}
