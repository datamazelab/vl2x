// Render the code that loads/produces the initial `data` array, plus a
// statement to coerce any temporal-typed fields (referenced by the spec's
// encodings) from strings into real JS `Date` objects, since D3 time
// scales and the timeUnit helpers both expect that.

import {formatValue} from './literals.js';

export function renderDataLoad(data, dataVar, ignoreUnsupported = false) {
  if (data && Array.isArray(data.values)) {
    return {statements: [`let ${dataVar} = ${formatValue(data.values)};`], isAsync: false};
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
  if (ignoreUnsupported) {
    // Nothing to load (no `values`, no `url`) -- an empty dataset still
    // lets the rest of the chart (axes, other layers) render instead of
    // aborting entirely.
    return {
      statements: [
        `// vl2d3: unsupported data source (expected inline "values" or a "url"), using an empty dataset (--ignore-unsupported)`,
        `let ${dataVar} = [];`,
      ],
      isAsync: false,
    };
  }
  throw new Error('Unsupported data source: expected inline "values" or a "url"');
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
