import {writeFileSync, mkdirSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {vegaLiteToD3Code} from '../src/index.js';

mkdirSync(new URL('.scratch/', import.meta.url), {recursive: true});
let counter = 0;

// Translate a spec, exec the generated code against a fresh jsdom document,
// and return {svg, document, code}.
export async function renderSpec(spec, options) {
  const code = vegaLiteToD3Code(spec);
  const path = new URL(`.scratch/t${counter++}.mjs`, import.meta.url);
  writeFileSync(path, code);
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const mod = await import(path.href + `?t=${Date.now()}`);
  const container = dom.window.document.body;
  const svg = await mod.default(container, options);
  return {svg, document: dom.window.document, code};
}
