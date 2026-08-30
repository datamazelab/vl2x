import {vegaLiteToD3Code} from './src/index.js';
import {readFileSync} from 'fs';
const spec = JSON.parse(readFileSync('../vega-lite-example-specs/bar_qq_stack_horizontal.vl.json', 'utf8'));
console.log(vegaLiteToD3Code(spec, {ignoreUnsupported: true}));
