// Translate a Vega-Lite JSON specification into a standalone Observable
// Plot chart-drawing function.
//
//   import {vegaLiteToPlotCode} from 'vl2plot';
//   const code = vegaLiteToPlotCode(spec);

export {specToCode as vegaLiteToPlotCode} from './translator.js';
