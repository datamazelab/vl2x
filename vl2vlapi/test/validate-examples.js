// Ad-hoc validation harness (not part of the unit test suite): run the
// translator over a directory of real-world *.vl.json example specs,
// execute the generated code, and try to compile the result with the real
// vega-lite compiler. Reports failures grouped by root cause.
//
// Usage: node test/validate-examples.js /path/to/specs/dir [limit]

import {readdirSync, readFileSync, writeFileSync, mkdirSync} from 'fs';
import {join, basename} from 'path';
import * as vegaLite from 'vega-lite';
import {vegaLiteToVegaLiteApiCode} from '../src/index.js';

const specsDir = process.argv[2];
const limit = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;

if (!specsDir) {
  console.error('Usage: node test/validate-examples.js /path/to/specs/dir [limit]');
  process.exit(1);
}

mkdirSync(new URL('.scratch/', import.meta.url), {recursive: true});
const scratchDir = new URL('.scratch/', import.meta.url);

let files = readdirSync(specsDir).filter(f => f.endsWith('.vl.json'));
files.sort();
if (limit) files = files.slice(0, limit);

const failures = [];
let ok = 0;

for (const file of files) {
  const path = join(specsDir, file);
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    continue;
  }

  let code;
  try {
    code = vegaLiteToVegaLiteApiCode(spec);
  } catch (e) {
    failures.push({file, stage: 'TRANSLATE', message: e.message, code: ''});
    continue;
  }

  const tmpPath = new URL(`t-${basename(file, '.vl.json')}.mjs`, scratchDir);
  writeFileSync(tmpPath, code);

  try {
    const mod = await import(tmpPath.href + `?t=${Date.now()}`);
    const obj = mod.default.toObject();
    vegaLite.compile({'$schema': spec['$schema'], ...obj});
    ok++;
  } catch (e) {
    failures.push({file, stage: 'EXEC/COMPILE', message: e.message, code});
  }
}

console.log(`OK: ${ok}/${files.length}`);
console.log(`Failures: ${failures.length}`);

const counts = new Map();
for (const f of failures) {
  counts.set(f.message, (counts.get(f.message) || 0) + 1);
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log('\nTop failure reasons:');
for (const [msg, count] of sorted.slice(0, 25)) {
  console.log(`  [${String(count).padStart(3)}] ${msg}`);
}

const detailPath = new URL('validate-failures.txt', import.meta.url);
const detail = failures
  .map(f => `===== ${f.file} [${f.stage}] =====\n${f.message}\n${f.code}\n`)
  .join('\n');
writeFileSync(detailPath, detail);
console.log(`\nFull details written to ${detailPath.pathname}`);
