// Recursive translation of a Vega-Lite spec (plain object) into
// vega-lite-api JavaScript source.
//
// Unlike a language whose visualization wrapper library (e.g. Python's
// Altair) needs a hand-built class per nested schema type, vega-lite-api's
// code generator gives nearly every chart/channel/transform property a
// plain `.key(value)` setter method that stores whatever it's given
// verbatim (see README/ARCHITECTURE notes). That means almost every
// Vega-Lite JSON property maps 1:1 onto a method of the exact same name,
// with the parsed JSON value passed straight through as the argument --
// no merging shared properties down into composition children, no
// per-transform-type argument tables, no reserved-word renaming. The only
// property that genuinely needs special handling is `encoding`, because
// `.encode(...)` needs each argument to know its own channel name (that's
// what `vl.x(...)`/`vl.color(...)`/etc. provide).

import {formatValue} from './literals.js';
import {Chain} from './calls.js';
import {renderEncodeArgs} from './encoding.js';

const STRUCTURAL_KEYS = new Set([
  'layer', 'facet', 'spec', 'repeat', 'hconcat', 'vconcat', 'concat',
  'datasets', '$schema',
]);

class Emitter {
  constructor() {
    this.lines = [];
    this.counts = new Map();
  }

  newVar(hint) {
    const n = (this.counts.get(hint) || 0) + 1;
    this.counts.set(hint, n);
    return n === 1 ? hint : `${hint}${n}`;
  }

  addStmt(line) {
    this.lines.push(line);
  }
}

function sanitizeIdentifier(name, fallback) {
  return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : fallback;
}

function hoistDatasets(datasets, emitter) {
  const refs = {};
  for (const name of Object.keys(datasets)) {
    const varName = emitter.newVar(sanitizeIdentifier(name, 'dataset'));
    emitter.addStmt(`const ${varName} = ${formatValue(datasets[name])};`);
    refs[name] = varName;
  }
  return refs;
}

// Render the argument to `.data(...)`. Bare `{values: [...]}` data is
// hoisted into a `const` variable (purely for readability -- unlike some
// wrapper libraries, vega-lite-api requires no particular object identity
// for data to be shared or recognized correctly, so this is a style choice,
// not a correctness requirement).
function renderData(data, emitter, hint) {
  if (data === null || data === undefined) return null;
  const keys = Object.keys(data);
  if (keys.length === 1 && keys[0] === 'values') {
    const varName = emitter.newVar(hint);
    emitter.addStmt(`const ${varName} = ${formatValue(data.values)};`);
    return varName;
  }
  return formatValue(data);
}

// vega-lite-api renames a couple of JSON properties to avoid ambiguity with
// the constructor-style shortcuts of the same name (`mark`, `encoding`):
// `projection` -> `.project(...)`, `encoding` -> `.encode(...)` (the latter
// already gets its own dedicated handling below since it needs channel
// wrapping too).
const METHOD_RENAME = {projection: 'project'};

function legacySelectionToParam(name, def) {
  const {type, ...rest} = def;
  const select = {type: type || 'single', ...rest};
  return {name, select};
}

function applyRemaining(chain, spec, consumed, emitter, hint) {
  for (const key of Object.keys(spec)) {
    if (consumed.has(key) || key === '$schema') continue;

    if (key === 'encoding') {
      // A zero-argument `.encode()` call is a no-op in vega-lite (an empty
      // `encoding: {}` is valid) but is mishandled by vega-lite-api itself,
      // which returns `undefined` rather than `this` -- so skip the call
      // entirely rather than emit one that would break the chain.
      const args = renderEncodeArgs(spec.encoding);
      if (args.length) chain.call('encode', args);
    } else if (key === 'transform') {
      if (spec.transform.length) chain.call('transform', spec.transform.map(t => formatValue(t)));
    } else if (key === 'params') {
      if (spec.params.length) chain.call('params', spec.params.map(p => formatValue(p)));
    } else if (key === 'selection') {
      const params = Object.keys(spec.selection).map(
        name => legacySelectionToParam(name, spec.selection[name])
      );
      if (params.length) chain.call('params', params.map(p => formatValue(p)));
    } else if (key === 'data') {
      const rendered = renderData(spec.data, emitter, `${hint}Data`);
      if (rendered !== null) chain.call('data', [rendered]);
    } else {
      chain.call(METHOD_RENAME[key] || key, [formatValue(spec[key])]);
    }
  }
}

function translateUnit(spec, emitter, hint) {
  const chain = new Chain(`vl.mark(${formatValue(spec.mark)})`);
  applyRemaining(chain, spec, new Set(['mark']), emitter, hint);
  return chain.toString();
}

function translateLayer(spec, emitter, hint) {
  const childHint = hint === 'chart' ? 'layer' : hint;
  const children = spec.layer.map((child, i) => translateSpec(child, emitter, `${childHint}${i + 1}`));
  const chain = new Chain(`vl.layer(${children.join(', ')})`);
  applyRemaining(chain, spec, new Set(['layer']), emitter, hint);
  return chain.toString();
}

function translateMulti(spec, emitter, hint, key, fn) {
  const childHint = hint === 'chart' ? key : hint;
  const children = spec[key].map((child, i) => translateSpec(child, emitter, `${childHint}${i + 1}`));
  const chain = new Chain(`vl.${fn}(${children.join(', ')})`);
  applyRemaining(chain, spec, new Set([key]), emitter, hint);
  return chain.toString();
}

function translateFacet(spec, emitter, hint) {
  const childHint = hint === 'chart' ? 'view' : `${hint}View`;
  const childExpr = translateSpec(spec.spec, emitter, childHint);
  const chain = new Chain(`(${childExpr}).facet(${formatValue(spec.facet)})`);
  applyRemaining(chain, spec, new Set(['facet', 'spec']), emitter, hint);
  return chain.toString();
}

function translateRepeat(spec, emitter, hint) {
  const childHint = hint === 'chart' ? 'view' : `${hint}View`;
  const childExpr = translateSpec(spec.spec, emitter, childHint);
  const chain = new Chain(`(${childExpr}).repeat(${formatValue(spec.repeat)})`);
  applyRemaining(chain, spec, new Set(['repeat', 'spec']), emitter, hint);
  return chain.toString();
}

export function translateSpec(spec, emitter, hint = 'chart') {
  const rest = {...spec};
  delete rest.$schema;

  if ('layer' in rest) return translateLayer(rest, emitter, hint);
  if ('facet' in rest && 'spec' in rest) return translateFacet(rest, emitter, hint);
  if ('repeat' in rest && 'spec' in rest) return translateRepeat(rest, emitter, hint);
  if ('hconcat' in rest) return translateMulti(rest, emitter, hint, 'hconcat', 'hconcat');
  if ('vconcat' in rest) return translateMulti(rest, emitter, hint, 'vconcat', 'vconcat');
  if ('concat' in rest) return translateMulti(rest, emitter, hint, 'concat', 'concat');
  return translateUnit(rest, emitter, hint);
}

export function specToCode(spec, {chartVar = 'chart'} = {}) {
  const emitter = new Emitter();
  const root = {...spec};
  delete root.$schema;
  const datasets = root.datasets;
  delete root.datasets;

  let datasetRefs = null;
  if (datasets && Object.keys(datasets).length) {
    datasetRefs = hoistDatasets(datasets, emitter);
  }

  let expr = translateSpec(root, emitter, chartVar);
  if (datasetRefs) {
    // Build the `.datasets({...})` argument by hand: its values must be raw
    // identifier tokens (the hoisted `const` variables), not JSON literals,
    // so `formatValue` (which only knows how to render JSON-shaped data)
    // doesn't apply here.
    const pairs = Object.entries(datasetRefs).map(
      ([name, varName]) => `${JSON.stringify(name)}: ${varName}`
    );
    const chain = new Chain(`(${expr})`);
    chain.call('datasets', [`{${pairs.join(', ')}}`]);
    expr = chain.toString();
  }

  const lines = ["import * as vl from 'vega-lite-api';", ''];
  lines.push(...emitter.lines);
  if (emitter.lines.length) lines.push('');
  lines.push(`const ${chartVar} = ${expr};`);
  lines.push('');
  lines.push(`export default ${chartVar};`);
  lines.push('');
  return lines.join('\n');
}
