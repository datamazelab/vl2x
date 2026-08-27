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
  constructor(includeSourcePaths = false) {
    this.lines = [];
    this.counts = new Map();
    this.includeSourcePaths = includeSourcePaths;
  }

  newVar(hint) {
    const n = (this.counts.get(hint) || 0) + 1;
    this.counts.set(hint, n);
    return n === 1 ? hint : `${hint}${n}`;
  }

  // `path` is a dotted/bracketed JSON path into the *original* spec (e.g.
  // "encoding.x", "transform[1]") identifying which part of the input this
  // one generated statement came from -- emitted as a comment directly
  // above it (opt-in via `includeSourcePaths`, off by default).
  addStmt(line, path) {
    if (this.includeSourcePaths && path) this.lines.push(`// from: ${path}`);
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
function renderData(data, emitter, hint, path) {
  if (data === null || data === undefined) return null;
  const keys = Object.keys(data);
  if (keys.length === 1 && keys[0] === 'values') {
    const varName = emitter.newVar(hint);
    emitter.addStmt(`const ${varName} = ${formatValue(data.values)};`, path);
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

function applyRemaining(chain, spec, consumed, emitter, hint, path = '') {
  for (const key of Object.keys(spec)) {
    if (consumed.has(key) || key === '$schema') continue;

    if (key === 'encoding') {
      // A zero-argument `.encode()` call is a no-op in vega-lite (an empty
      // `encoding: {}` is valid) but is mishandled by vega-lite-api itself,
      // which returns `undefined` rather than `this` -- so skip the call
      // entirely rather than emit one that would break the chain.
      const args = renderEncodeArgs(spec.encoding);
      if (args.length) {
        const encPath = Object.keys(spec.encoding).map(k => `${path}encoding.${k}`).join(', ');
        chain.call('encode', args, encPath);
      }
    } else if (key === 'transform') {
      if (spec.transform.length) {
        const tPath = spec.transform.map((_, i) => `${path}transform[${i}]`).join(', ');
        chain.call('transform', spec.transform.map(t => formatValue(t)), tPath);
      }
    } else if (key === 'params') {
      if (spec.params.length) {
        const pPath = spec.params.map((_, i) => `${path}params[${i}]`).join(', ');
        chain.call('params', spec.params.map(p => formatValue(p)), pPath);
      }
    } else if (key === 'selection') {
      const names = Object.keys(spec.selection);
      const params = names.map(name => legacySelectionToParam(name, spec.selection[name]));
      if (params.length) {
        const sPath = names.map(n => `${path}selection.${n}`).join(', ');
        chain.call('params', params.map(p => formatValue(p)), sPath);
      }
    } else if (key === 'data') {
      const rendered = renderData(spec.data, emitter, `${hint}Data`, `${path}data`);
      if (rendered !== null) chain.call('data', [rendered], `${path}data`);
    } else {
      chain.call(METHOD_RENAME[key] || key, [formatValue(spec[key])], `${path}${key}`);
    }
  }
}

// A composition child's own rendered expression can start with its own
// leading `// from: ...` comment (when it has a labeled `basePath`, e.g. a
// unit view's own "mark" step) -- splicing that directly after an opening
// `(`/`vl.layer(` on the same line would put real code (the child's own
// mark/encode chain) inside that same comment's reach until the next
// newline. Still syntactically valid JS either way (the child's own code
// picks back up on its own next line, inside the still-open call), but
// confusing to read -- indenting the child onto its own fresh line avoids
// the appearance of a broken argument list.
function indentBlock(text) {
  return text
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
}

function wrapChildExpr(childExpr, includeSourcePaths) {
  if (!includeSourcePaths) return `(${childExpr})`;
  return `(\n${indentBlock(childExpr)}\n)`;
}

function joinChildArgs(children, includeSourcePaths) {
  if (!includeSourcePaths) return children.join(', ');
  return `\n${children.map(indentBlock).join(',\n')}\n`;
}

function translateUnit(spec, emitter, hint, path = '') {
  const chain = new Chain(`vl.mark(${formatValue(spec.mark)})`, {
    basePath: path ? `${path}mark` : undefined,
    includeSourcePaths: emitter.includeSourcePaths,
  });
  applyRemaining(chain, spec, new Set(['mark']), emitter, hint, path);
  return chain.toString();
}

function translateLayer(spec, emitter, hint, path = '') {
  const childHint = hint === 'chart' ? 'layer' : hint;
  const children = spec.layer.map(
    (child, i) => translateSpec(child, emitter, `${childHint}${i + 1}`, `${path}layer[${i}].`)
  );
  const chain = new Chain(`vl.layer(${joinChildArgs(children, emitter.includeSourcePaths)})`, {
    basePath: path ? `${path}layer` : undefined,
    includeSourcePaths: emitter.includeSourcePaths,
  });
  applyRemaining(chain, spec, new Set(['layer']), emitter, hint, path);
  return chain.toString();
}

function translateMulti(spec, emitter, hint, key, fn, path = '') {
  const childHint = hint === 'chart' ? key : hint;
  const children = spec[key].map(
    (child, i) => translateSpec(child, emitter, `${childHint}${i + 1}`, `${path}${key}[${i}].`)
  );
  const chain = new Chain(`vl.${fn}(${joinChildArgs(children, emitter.includeSourcePaths)})`, {
    basePath: path ? `${path}${key}` : undefined,
    includeSourcePaths: emitter.includeSourcePaths,
  });
  applyRemaining(chain, spec, new Set([key]), emitter, hint, path);
  return chain.toString();
}

function translateFacet(spec, emitter, hint, path = '') {
  const childHint = hint === 'chart' ? 'view' : `${hint}View`;
  const childExpr = translateSpec(spec.spec, emitter, childHint, `${path}spec.`);
  const chain = new Chain(
    `${wrapChildExpr(childExpr, emitter.includeSourcePaths)}.facet(${formatValue(spec.facet)})`,
    {basePath: path ? `${path}facet` : undefined, includeSourcePaths: emitter.includeSourcePaths}
  );
  applyRemaining(chain, spec, new Set(['facet', 'spec']), emitter, hint, path);
  return chain.toString();
}

function translateRepeat(spec, emitter, hint, path = '') {
  const childHint = hint === 'chart' ? 'view' : `${hint}View`;
  const childExpr = translateSpec(spec.spec, emitter, childHint, `${path}spec.`);
  const chain = new Chain(
    `${wrapChildExpr(childExpr, emitter.includeSourcePaths)}.repeat(${formatValue(spec.repeat)})`,
    {basePath: path ? `${path}repeat` : undefined, includeSourcePaths: emitter.includeSourcePaths}
  );
  applyRemaining(chain, spec, new Set(['repeat', 'spec']), emitter, hint, path);
  return chain.toString();
}

export function translateSpec(spec, emitter, hint = 'chart', path = '') {
  const rest = {...spec};
  delete rest.$schema;

  if ('layer' in rest) return translateLayer(rest, emitter, hint, path);
  if ('facet' in rest && 'spec' in rest) return translateFacet(rest, emitter, hint, path);
  if ('repeat' in rest && 'spec' in rest) return translateRepeat(rest, emitter, hint, path);
  if ('hconcat' in rest) return translateMulti(rest, emitter, hint, 'hconcat', 'hconcat', path);
  if ('vconcat' in rest) return translateMulti(rest, emitter, hint, 'vconcat', 'vconcat', path);
  if ('concat' in rest) return translateMulti(rest, emitter, hint, 'concat', 'concat', path);
  return translateUnit(rest, emitter, hint, path);
}

// `includeSourcePaths` (default `false`): when `true`, each generated
// statement/chain-step is preceded by a `// from: <json path>` comment
// naming the part of the *input* spec it was translated from (e.g.
// `// from: encoding.x`, `// from: transform[0]`) -- useful for tracing
// generated code back to the spec that produced it, at the cost of a much
// noisier script (every chain is forced one step per line so the comments
// have somewhere to go).
export function specToCode(spec, {chartVar = 'chart', includeSourcePaths = false} = {}) {
  const emitter = new Emitter(includeSourcePaths);
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
    const chain = new Chain(`(${expr})`, {includeSourcePaths});
    chain.call('datasets', [`{${pairs.join(', ')}}`], 'datasets');
    expr = chain.toString();
  }

  // A provenance header: this file is machine-generated from a Vega-Lite
  // spec, not hand-written -- re-run the translator (with the same
  // arguments shown here) after the source spec changes, rather than
  // hand-editing this output and losing that round-trip.
  const headerComment =
    `// Generated by vl2vlapi.vegaLiteToVlApiCode(spec, {chartVar: ${JSON.stringify(chartVar)}, ` +
    `includeSourcePaths: ${includeSourcePaths}})`;
  const lines = [headerComment, "import * as vl from 'vega-lite-api';", ''];
  lines.push(...emitter.lines);
  if (emitter.lines.length) lines.push('');
  lines.push(`const ${chartVar} = ${expr};`);
  lines.push('');
  lines.push(`export default ${chartVar};`);
  lines.push('');
  return lines.join('\n');
}
