#!/usr/bin/env node
// Batch-run vl2d3 over every spec in vega-lite-example-specs/, writing
// generated code (or an error message) per example plus a status summary.
import {readFileSync, writeFileSync, mkdirSync, readdirSync} from 'fs';
import {fileURLToPath} from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const {vegaLiteToD3Code} = await import(path.join(REPO, 'vl2d3/src/index.js'));

const SPECS_DIR = path.join(REPO, 'vega-lite-example-specs');
const OUT_DIR = path.join(REPO, 'showcase/examples');

const files = readdirSync(SPECS_DIR).filter(f => f.endsWith('.vl.json')).sort();
const statuses = {};

for (let i = 0; i < files.length; i++) {
  const name = files[i].slice(0, -'.vl.json'.length);
  const outDir = path.join(OUT_DIR, name);
  mkdirSync(outDir, {recursive: true});
  try {
    const spec = JSON.parse(readFileSync(path.join(SPECS_DIR, files[i]), 'utf8'));
    const code = vegaLiteToD3Code(spec);
    writeFileSync(path.join(outDir, 'd3.js'), code);
    statuses[name] = {ok: true};
  } catch (e) {
    const msg = String(e.message || e).split('\n')[0];
    writeFileSync(path.join(outDir, 'd3.js'), `// Translation failed:\n// ${msg}\n`);
    statuses[name] = {ok: false, error: msg};
  }
  if ((i + 1) % 50 === 0) console.error(`d3: ${i + 1}/${files.length}`);
}

writeFileSync(path.join(REPO, 'showcase/status_d3.json'), JSON.stringify(statuses, null, 2));
const ok = Object.values(statuses).filter(s => s.ok).length;
console.log(`d3: ${ok}/${files.length} ok`);
