// Translate a Vega-Lite `encoding` object into `vl.<channel>(...)` expressions.
//
// Every encoding channel constructor in vega-lite-api (`vl.x`, `vl.color`,
// `vl.tooltip`, ...) takes its raw Vega-Lite channel-definition object
// directly as a single argument and stores it verbatim -- including when
// that "definition" is itself an array (as for `detail`/`tooltip`/`order`,
// which may hold a list of field definitions). So unlike a from-scratch
// wrapper, no per-channel-property method chaining is needed here: the
// parsed JSON value can be hand straight to `formatValue`.

import {formatValue} from './literals.js';

export function renderChannel(key, value) {
  return `vl.${key}(${formatValue(value)})`;
}

export function renderEncodeArgs(encoding) {
  return Object.keys(encoding).map(key => renderChannel(key, encoding[key]));
}
