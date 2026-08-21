#!/usr/bin/env node
// Render a real Vega-Lite SVG thumbnail for every spec (the actual Vega-Lite
// runtime, not any of the 4 translators) -- used as the gallery thumbnail on
// the landing page, mirroring how vega.github.io/vega-lite/examples/ works.
import {readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
// vega/vega-lite are already installed transitively under vl2vlapi (a
// dependency of vega-lite-api) -- reuse that install rather than adding a
// second copy.
const NM = path.join(REPO, 'vl2vlapi', 'node_modules');
const vega = await import(path.join(NM, 'vega', 'build', 'vega.module.js'));
const vegaLite = await import(path.join(NM, 'vega-lite', 'build', 'index.js'));

const SPECS_DIR = path.join(REPO, 'vega-lite-example-specs');
const DATA_DIR = path.join(REPO, 'showcase', 'data');
const OUT_DIR = path.join(REPO, 'showcase', 'thumbs');
mkdirSync(OUT_DIR, {recursive: true});

function localLoader() {
  const loader = vega.loader();
  const base = loader.load.bind(loader);
  loader.load = (uri, opts) => {
    if (typeof uri === 'string' && !/^https?:\/\//.test(uri)) {
      const fname = uri.replace(/^data\//, '');
      const local = path.join(DATA_DIR, fname);
      if (existsSync(local)) return base('file://' + local, opts);
    }
    return base(uri, opts);
  };
  return loader;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

const files = readdirSync(SPECS_DIR).filter(f => f.endsWith('.vl.json')).sort();
const statuses = {};

for (let i = 0; i < files.length; i++) {
  const name = files[i].slice(0, -'.vl.json'.length);
  try {
    const spec = JSON.parse(readFileSync(path.join(SPECS_DIR, files[i]), 'utf8'));
    const vgSpec = vegaLite.compile(spec, {}).spec;
    const runtime = vega.parse(vgSpec);
    const view = new vega.View(runtime, {renderer: 'none'})
      .loader(localLoader())
      .logLevel(vega.None)
      .initialize();
    const svg = await withTimeout(view.toSVG(), 15000);
    writeFileSync(path.join(OUT_DIR, `${name}.svg`), svg);
    view.finalize();
    statuses[name] = {ok: true};
  } catch (e) {
    statuses[name] = {ok: false, error: String(e.message || e).split('\n')[0]};
  }
  if ((i + 1) % 50 === 0) console.error(`thumbs: ${i + 1}/${files.length}`);
}

writeFileSync(path.join(REPO, 'showcase', 'status_thumbs.json'), JSON.stringify(statuses, null, 2));
const ok = Object.values(statuses).filter(s => s.ok).length;
console.log(`thumbs: ${ok}/${files.length} ok`);
