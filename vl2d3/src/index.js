// Translate a Vega-Lite JSON specification into a standalone D3
// chart-drawing function.
//
//   import {vegaLiteToD3Code} from 'vl2d3';
//   const code = vegaLiteToD3Code(spec);

export {specToCode as vegaLiteToD3Code} from './translator.js';
