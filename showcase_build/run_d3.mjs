#!/usr/bin/env node
// Batch-run vl2d3 over every spec in vega-lite-example-specs/, writing
// generated code (or an error message) per example plus a status summary.
//
// "ok" here means both translation AND execution succeeded (the generated
// chart(container, options) function actually ran against jsdom without
// throwing) -- translation alone isn't a reliable signal that the code
// renders: a spec can translate cleanly and still throw at runtime (bad
// generated references, data that fails to load, ...), which previously
// showed up on the site as a "D3 ✅" badge next to a live error-box.
import {readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, createReadStream} from 'fs';
import {join, basename, extname} from 'path';
import {createServer} from 'http';
import {fileURLToPath} from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const {vegaLiteToD3Code} = await import(path.join(REPO, 'vl2d3/src/index.js'));
const {JSDOM} = await import(path.join(REPO, 'vl2d3/node_modules/jsdom/lib/api.js'));

const SPECS_DIR = path.join(REPO, 'vega-lite-example-specs');
const OUT_DIR = path.join(REPO, 'showcase/examples');
const DATA_DIR = path.join(REPO, 'showcase/data');
// Under vl2d3/ (not showcase_build/) so bare `import * as d3 from "d3"` in
// the generated code resolves via vl2d3's own node_modules/d3 -- Node's ESM
// resolver walks up from the importing file's own directory, and
// showcase_build/ has no node_modules of its own. Named ".scratch" (already
// gitignored, same as vl2d3/test/.scratch) rather than introducing a new
// ignore pattern.
const SCRATCH_DIR = path.join(REPO, 'vl2d3/.scratch');
mkdirSync(SCRATCH_DIR, {recursive: true});

// A tiny static server over showcase/data/ so the generated code's
// `d3.json`/`d3.csv`/`d3.tsv` calls (and any relative "data/xyz.png" image
// mark reference) can actually be fetched by jsdom, the same way a real
// page load resolves them against showcase/data/ (see example.html.j2's
// vega-embed loader baseURL / D3 panel's baseURL option).
const mime = {'.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.png': 'image/png'};
const server = createServer((req, res) => {
  const p = join(DATA_DIR, decodeURIComponent(req.url.replace(/^\/data\//, '')));
  if (!existsSync(p)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {'Content-Type': mime[extname(p)] || 'application/octet-stream'});
  createReadStream(p).pipe(res);
});
await new Promise(resolve => server.listen(0, resolve));
const baseURL = `http://localhost:${server.address().port}/`;

const files = readdirSync(SPECS_DIR).filter(f => f.endsWith('.vl.json')).sort();
const statuses = {};

for (let i = 0; i < files.length; i++) {
  const name = files[i].slice(0, -'.vl.json'.length);
  const outDir = path.join(OUT_DIR, name);
  mkdirSync(outDir, {recursive: true});

  let code;
  try {
    const spec = JSON.parse(readFileSync(path.join(SPECS_DIR, files[i]), 'utf8'));
    code = vegaLiteToD3Code(spec, {ignoreUnsupported: true});
    writeFileSync(path.join(outDir, 'd3.js'), code);
  } catch (e) {
    const msg = String(e.message || e).split('\n')[0];
    writeFileSync(path.join(outDir, 'd3.js'), `// Translation failed:\n// ${msg}\n`);
    statuses[name] = {ok: false, translated: false, error: msg};
    continue;
  }

  const tmpPath = path.join(SCRATCH_DIR, `t-${name}.mjs`);
  writeFileSync(tmpPath, code);
  try {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', {url: baseURL});
    const mod = await import(`file://${tmpPath}?t=${Date.now()}`);
    // The module runs in Node's realm (not jsdom's window), so d3-fetch's
    // csv/json/tsv resolve relative URLs against Node's process CWD, not
    // `baseURL` -- pass it explicitly as the fetch base, same as
    // vl2d3/test/validate-examples.js.
    await mod.default(dom.window.document.body, {baseURL});
    statuses[name] = {ok: true, translated: true};
  } catch (e) {
    const msg = String(e.message || e).split('\n')[0];
    // `translated: true` -- the code file has real (not "translation
    // failed") code worth displaying, even though it throws at runtime;
    // `ok: false` so the site's badge doesn't claim success it can't back up.
    statuses[name] = {ok: false, translated: true, error: `Rendered code threw at runtime: ${msg}`};
  }

  if ((i + 1) % 50 === 0) console.error(`d3: ${i + 1}/${files.length}`);
}

server.close();
writeFileSync(path.join(REPO, 'showcase/status_d3.json'), JSON.stringify(statuses, null, 2));
const ok = Object.values(statuses).filter(s => s.ok).length;
console.log(`d3: ${ok}/${files.length} ok`);
