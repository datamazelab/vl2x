// Translate a Vega-Lite JSON specification into vega-lite-api JavaScript
// source code.
//
//   import {vegaLiteToVegaLiteApiCode} from 'vl2vlapi';
//   const code = vegaLiteToVegaLiteApiCode(spec);

export {specToCode as vegaLiteToVegaLiteApiCode} from './translator.js';
