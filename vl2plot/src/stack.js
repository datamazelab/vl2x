// Vega-Lite implicitly stacks a `bar`/`area` mark's own value channel when a
// `color`/`detail` channel also groups it (unless stacking is explicitly
// turned off) -- Plot already has this exact behavior built into
// `Plot.stackY`/`Plot.stackX`, including Vega-Lite's own three offset
// modes (`Plot.stackY({offset: "normalize"|"center"}, ...)`, default zero
// otherwise), so this module only ever needs to decide *whether* to wrap a
// mark's own options in one of those two transform functions -- no
// hand-computed cumulative sum needed at all, unlike every other sibling's
// own stack.js/stack.py.

import {isQuantitative} from './encoding.js';

const STACKABLE_MARKS = new Set(['bar', 'area']);

// Returns Plot's own stack function name (`"stackY"`/`"stackX"`) and
// `offset` option, or `null` when this mark/encoding doesn't implicitly
// stack at all. `orientation` is `"horizontal"`/`"vertical"` (from
// `marks.js`'s own bar/area orientation inference).
export function planStack(markType, encoding, orientation) {
  if (!STACKABLE_MARKS.has(markType)) return null;
  // A dodge (`xOffset`/`yOffset`) is a mutually-exclusive alternative to
  // stacking for the same color-grouped mark -- Vega-Lite dodges side by
  // side rather than stacking when an offset channel is present.
  if (encoding.xOffset || encoding.yOffset) return null;

  const valueChannel = orientation === 'horizontal' ? 'x' : 'y';
  const groupChannel = ['color', 'fill', 'stroke', 'detail'].find(
    ch => encoding[ch] && typeof encoding[ch] === 'object' && typeof encoding[ch].field === 'string' && !isQuantitative(encoding[ch])
  );
  if (!groupChannel) return null;

  const valueDef = encoding[valueChannel];
  if (!valueDef || typeof valueDef !== 'object' || !valueDef.field) return null;

  const stackSetting = valueDef.stack;
  if (stackSetting === false || stackSetting === null) return null;
  const offset = stackSetting === 'normalize' || stackSetting === 'center' ? stackSetting : null;

  return {fn: valueChannel === 'x' ? 'stackX' : 'stackY', offset};
}
