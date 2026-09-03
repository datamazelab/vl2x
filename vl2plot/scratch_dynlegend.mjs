import {vegaLiteToPlotCode} from './src/index.js';
import fs from 'node:fs';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import http from 'node:http';

const spec = JSON.parse(fs.readFileSync('../vega-lite-example-specs/dynamic_color_legend.vl.json', 'utf8'));
const code = vegaLiteToPlotCode(spec, {ignoreUnsupported: true});
fs.writeFileSync('./scratch_dynlegend_chart.mjs', code);

const dataRoot = path.resolve('../showcase');
const server = http.createServer((req, res) => {
  const filePath = path.join(dataRoot, decodeURIComponent(req.url));
  fs.readFile(filePath, (err, data) => { if (err) { res.statusCode = 404; res.end('nf'); return; } res.end(data); });
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: `http://localhost:${port}/`});
global.window = dom.window;
global.document = dom.window.document;

const {default: chart} = await import('./scratch_dynlegend_chart.mjs');
const container = dom.window.document.createElement('div');
await chart(container, {baseURL: `http://localhost:${port}/`});
const circles = [...container.querySelectorAll('circle')].filter(c => !c.closest('[class*="swatch"]'));
console.log('circles:', circles.length);
circles.slice(0,5).forEach(c => console.log('r:', c.getAttribute('r'), 'stroke:', c.getAttribute('stroke')));
