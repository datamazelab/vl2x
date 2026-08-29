#!/usr/bin/env node
import {readFileSync, writeFileSync} from 'fs';
import {argv, exit, stdin, stdout} from 'process';
import {vegaLiteToPlotCode} from '../src/index.js';

function parseArgs(args) {
  const opts = {spec: null, output: null, ignoreUnsupported: false, includeSourcePaths: false};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') opts.output = args[++i];
    else if (a === '--ignore-unsupported') opts.ignoreUnsupported = true;
    else if (a === '--include-source-paths') opts.includeSourcePaths = true;
    else if (!a.startsWith('-')) opts.spec = a;
  }
  return opts;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  const raw = opts.spec ? readFileSync(opts.spec, 'utf8') : await readStdin();
  const spec = JSON.parse(raw);
  const code = vegaLiteToPlotCode(spec, {ignoreUnsupported: opts.ignoreUnsupported, includeSourcePaths: opts.includeSourcePaths});
  if (opts.output) {
    writeFileSync(opts.output, code);
  } else {
    stdout.write(code);
  }
}

main().catch(err => {
  console.error(err.message);
  exit(1);
});
