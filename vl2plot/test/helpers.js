import {writeFileSync, mkdirSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {vegaLiteToPlotCode} from '../src/index.js';

const scratchDir = new URL('.scratch/', import.meta.url);
mkdirSync(scratchDir, {recursive: true});
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
