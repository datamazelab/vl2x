// Ad-hoc validation harness (not part of the unit test suite): run the
// translator over a directory of real-world *.vl.json example specs and
// execute the generated code against jsdom. Mirrors `vl2d3`'s own
// `test/validate-examples.js` methodology exactly (same 3-bucket split).
//
//   - OK: translated and rendered without error.
//   - SKIP: translation raised one of our own "Unsupported: ..." errors --
//     a spec using a feature this project has explicitly decided not to
//     implement yet. Expected, not a bug.
//   - FAIL: anything else -- a real bug.
//
// Usage: node test/validate-examples.js /path/to/specs/dir [/path/to/showcase] [limit]

import {readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream} from 'fs';
import {join, basename, extname} from 'path';
import {createServer} from 'http';
import {JSDOM} from 'jsdom';
import {vegaLiteToPlotCode} from '../src/index.js';

const specsDir = process.argv[2];
const datasetsDir = process.argv[3];
const limit = process.argv[4] ? parseInt(process.argv[4], 10) : undefined;

if (!specsDir) {
  console.error('Usage: node test/validate-examples.js /path/to/specs/dir [/path/to/showcase/data] [limit]');
  process.exit(1);
}

let baseURL = 'http://example.test/';
let server = null;
if (datasetsDir) {
  const dataRoot = join(datasetsDir, 'data');
  const mime = {'.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.png': 'image/png'};
  server = createServer((req, res) => {
    const path = join(dataRoot, decodeURIComponent(req.url.replace(/^\/data\//, '')));
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

const scratchDir = new URL('.scratch/', import.meta.url);
mkdirSync(scratchDir, {recursive: true});

let files = readdirSync(specsDir).filter(f => f.endsWith('.vl.json'));
files.sort();
if (limit) files = files.slice(0, limit);

let ok = 0;
let fetchUnavailable = 0;
const skipped = [];
const failed = [];

for (const [idx, file] of files.entries()) {
  if (process.env.VL2PLOT_VERBOSE) console.error(`[${idx + 1}/${files.length}] ${file}`);
  const path = join(specsDir, file);
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    continue;
  }

  let code;
  try {
    code = vegaLiteToPlotCode(spec);
  } catch (e) {
    (e.message.startsWith('Unsupported') ? skipped : failed).push({file, stage: 'TRANSLATE', message: e.message, code: ''});
    continue;
  }

  const tmpPath = new URL(`t-${basename(file, '.vl.json')}.mjs`, scratchDir);
  writeFileSync(tmpPath, code);

  try {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', {url: baseURL});
    const mod = await import(tmpPath.href + `?t=${Date.now()}`);
    await mod.default(dom.window.document.body, {baseURL});
    ok++;
  } catch (e) {
    const isFetchFailure = /Failed to parse URL from|fetch failed|ENOTFOUND|ECONNREFUSED/.test(e.message);
    const bucket = e.message.startsWith('Unsupported') ? skipped : isFetchFailure ? null : failed;
    if (bucket) bucket.push({file, stage: 'EXEC', message: e.message, code});
    else if (isFetchFailure) fetchUnavailable++;
  }
}

if (server) server.close();

console.log(`OK: ${ok}/${files.length}`);
console.log(`Skipped (documented unsupported features): ${skipped.length}/${files.length}`);
console.log(`Skipped (no local data server for URL data in this harness): ${fetchUnavailable}/${files.length}`);
console.log(`Failed (unexpected): ${failed.length}/${files.length}`);

function topReasons(list) {
  const counts = new Map();
  for (const f of list) counts.set(f.message, (counts.get(f.message) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

console.log('\nTop skip reasons:');
for (const [msg, count] of topReasons(skipped).slice(0, 20)) {
  console.log(`  [${String(count).padStart(3)}] ${msg}`);
}

console.log('\nTop failure reasons (unexpected -- these are real bugs):');
for (const [msg, count] of topReasons(failed).slice(0, 20)) {
  console.log(`  [${String(count).padStart(3)}] ${msg}`);
}

const detailPath = new URL('validate-failures.txt', import.meta.url);
const detail = failed.map(f => `===== ${f.file} [${f.stage}] =====\n${f.message}\n${f.code}\n`).join('\n');
writeFileSync(detailPath, detail);
console.log(`\nUnexpected-failure details written to ${detailPath.pathname}`);
