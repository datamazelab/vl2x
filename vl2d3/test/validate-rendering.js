// Ad-hoc validation harness (not part of the unit test suite): unlike
// validate-examples.js (which runs in *strict* mode and only checks whether
// the generated code throws), this runs every example spec the way the
// showcase actually does -- `{ignoreUnsupported: true}` -- and additionally
// inspects the rendered SVG's own geometry, not just whether execution
// completed without throwing.
//
// The gap this closes: a D3 selection given a NaN coordinate (e.g. an
// encoding accessor reading a field that doesn't exist on the row, because
// some unsupported upstream transform was silently skipped) doesn't throw
// at all -- it just produces a shape with invalid attributes (jsdom/browsers
// log a console error and refuse to display it, but the JS execution
// "succeeds"). That previously showed up in the showcase as a false "D3 ✅"
// badge next to an empty chart. This script flags exactly that pattern:
// translate+execute succeeded, but every drawn shape (or some of them) has
// non-finite geometry, or -- a related but distinct smell -- no shapes were
// drawn at all despite the chart having real, non-empty data to plot.
//
// Usage: node test/validate-rendering.js /path/to/specs/dir [/path/to/vega-datasets] [limit]

import {readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream} from 'fs';
import {join, basename, extname} from 'path';
import {createServer} from 'http';
import {JSDOM} from 'jsdom';
import {vegaLiteToD3Code} from '../src/index.js';

const specsDir = process.argv[2];
const datasetsDir = process.argv[3];
const limit = process.argv[4] ? parseInt(process.argv[4], 10) : undefined;

if (!specsDir) {
  console.error('Usage: node test/validate-rendering.js /path/to/specs/dir [/path/to/vega-datasets/data] [limit]');
  process.exit(1);
}

let baseURL = 'http://example.test/';
let server = null;
if (datasetsDir) {
  const mime = {'.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.png': 'image/png'};
  server = createServer((req, res) => {
    const path = join(datasetsDir, decodeURIComponent(req.url.replace(/^\/data\//, '')));
    if (!existsSync(path)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {'Content-Type': mime[extname(path)] || 'application/octet-stream'});
    createReadStream(path).pipe(res);
  });
  await new Promise(resolve => server.listen(0, resolve));
  baseURL = `http://localhost:${server.address().port}/`;
}

const scratchDir = new URL('.scratch-rendering/', import.meta.url);
mkdirSync(scratchDir, {recursive: true});

let files = readdirSync(specsDir).filter(f => f.endsWith('.vl.json'));
files.sort();
if (limit) files = files.slice(0, limit);

// Attributes checked per shape tag -- any non-finite (NaN, or missing where
// a numeric value is required) value on one of these makes the shape
// "broken": present in the DOM, but not actually visible/correctly placed.
const GEOMETRY_ATTRS = {
  rect: ['x', 'y', 'width', 'height'],
  circle: ['cx', 'cy', 'r'],
  line: ['x1', 'y1', 'x2', 'y2'],
  text: ['x', 'y'],
};

function isBadNumericAttr(el, attr) {
  const v = el.getAttribute(attr);
  if (v === null) return false; // absent is a separate (rarer) concern, not checked here
  return !Number.isFinite(Number(v));
}

// `path`'s `d` attribute isn't a single number -- just check for the
// literal substring a NaN coordinate serializes to (matches how this bug
// class was originally spotted: a browser console error reading exactly
// `<path> attribute d: Expected number, "MNaN,NaN...`).
function pathHasNaN(el) {
  const d = el.getAttribute('d');
  return typeof d === 'string' && d.includes('NaN');
}

function inspectRendering(node) {
  const shapeCounts = {};
  let brokenCount = 0;
  const brokenTags = new Set();
  for (const tag of [...Object.keys(GEOMETRY_ATTRS), 'path']) {
    const els = [...node.querySelectorAll(tag)];
    if (els.length === 0) continue;
    shapeCounts[tag] = els.length;
    for (const el of els) {
      const broken = tag === 'path' ? pathHasNaN(el) : GEOMETRY_ATTRS[tag].some(attr => isBadNumericAttr(el, attr));
      if (broken) {
        brokenCount++;
        brokenTags.add(tag);
      }
    }
  }
  const totalShapes = Object.values(shapeCounts).reduce((a, b) => a + b, 0);
  return {shapeCounts, totalShapes, brokenCount, brokenTags: [...brokenTags]};
}

let ok = 0;
const nanDetected = [];
const zeroShapes = [];
const skipped = [];
const failed = [];

for (const [idx, file] of files.entries()) {
  if (process.env.VL2D3_VERBOSE) console.error(`[${idx + 1}/${files.length}] ${file}`);
  const path = join(specsDir, file);
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    continue;
  }

  let code;
  try {
    code = vegaLiteToD3Code(spec, {ignoreUnsupported: true});
  } catch (e) {
    // Everything not gated by ignoreUnsupported (bare-array data with no
    // schema info at all, a handful of never-approximated shapes) still
    // throws here -- rare, but worth its own bucket.
    (e.message.startsWith('Unsupported') ? skipped : failed).push({file, stage: 'TRANSLATE', message: e.message});
    continue;
  }

  const tmpPath = new URL(`t-${basename(file, '.vl.json')}.mjs`, scratchDir);
  writeFileSync(tmpPath, code);

  try {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', {url: baseURL});
    const mod = await import(tmpPath.href + `?t=${Date.now()}`);
    const node = await mod.default(dom.window.document.body, {baseURL});
    const target = node || dom.window.document.body;
    const {shapeCounts, totalShapes, brokenCount, brokenTags} = inspectRendering(target);

    if (brokenCount > 0) {
      nanDetected.push({file, shapeCounts, brokenCount, brokenTags});
    } else if (totalShapes === 0) {
      zeroShapes.push({file, code});
    } else {
      ok++;
    }
  } catch (e) {
    const isFetchFailure = /Failed to parse URL from|fetch failed|ENOTFOUND|ECONNREFUSED/.test(e.message);
    if (isFetchFailure) continue; // harness limitation (no data server reachable), not a bug
    (e.message.startsWith('Unsupported') ? skipped : failed).push({file, stage: 'EXEC', message: e.message});
  }
}

console.log(`OK (renders with real, finite-geometry shapes): ${ok}/${files.length}`);
console.log(`NaN/invalid geometry detected: ${nanDetected.length}/${files.length}`);
console.log(`Zero shapes drawn (translated+executed, but nothing to show): ${zeroShapes.length}/${files.length}`);
console.log(`Skipped (documented unsupported features): ${skipped.length}/${files.length}`);
console.log(`Failed (unexpected -- threw something other than "Unsupported: ..."): ${failed.length}/${files.length}`);

console.log('\n=== Files with NaN/invalid shape geometry ===');
for (const {file, shapeCounts, brokenCount, brokenTags} of nanDetected) {
  console.log(`  ${file}: ${brokenCount} broken shape(s) among ${JSON.stringify(shapeCounts)}, tags=${brokenTags.join(',')}`);
}

console.log('\n=== Files with zero shapes drawn ===');
for (const {file} of zeroShapes) {
  console.log(`  ${file}`);
}

console.log('\n=== Unexpected failures ===');
for (const {file, stage, message} of failed) {
  console.log(`  ${file} [${stage}]: ${message}`);
}

const detailPath = new URL('validate-rendering-failures.txt', import.meta.url);
const detail = [
  ...nanDetected.map(r => `===== ${r.file} [NaN geometry: ${r.brokenCount} shape(s), tags=${r.brokenTags.join(',')}] =====\n`),
  ...zeroShapes.map(r => `===== ${r.file} [zero shapes] =====\n${r.code}\n`),
].join('\n');
writeFileSync(detailPath, detail);
console.log(`\nDetails written to ${detailPath.pathname}`);

if (server) server.close();
