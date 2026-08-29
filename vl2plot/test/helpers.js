import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {vegaLiteToPlotCode} from '../src/index.js';

const scratchDir = new URL('.scratch/', import.meta.url);
mkdirSync(scratchDir, {recursive: true});
// Generated code that uses the shared runtime helper module (see
// src/runtime.js) imports it via the relative specifier
// "./vl2plot-runtime.js" -- needs a plain copy alongside every generated
// file this harness writes and then dynamically imports.
writeFileSync(new URL('vl2plot-runtime.js', scratchDir), readFileSync(new URL('../src/runtime.js', import.meta.url)));
let counter = 0;

// Translate a spec, exec the generated code against a fresh jsdom
// container, and return {node, document, code}.
export async function renderSpec(spec, options) {
  const code = vegaLiteToPlotCode(spec, options);
  const path = new URL(`.scratch/t${counter++}.mjs`, import.meta.url);
  writeFileSync(path, code);
  const dom = new JSDOM('<!DOCTYPE html><body><div id="c"></div></body>');
  const mod = await import(path.href + `?t=${Date.now()}`);
  const container = dom.window.document.getElementById('c');
  const node = await mod.default(container, {});
  return {node, document: dom.window.document, container, code};
}
