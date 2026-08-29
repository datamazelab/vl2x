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

// Auto-stacked whenever a color/detail group is present, with no explicit
// `stack` setting needed -- Vega-Lite's own implicit-stacking convention
// for these two mark types specifically.
const IMPLICIT_STACK_MARKS = new Set(['bar', 'area']);
// Any other mark (currently just `text`, a value label overlaid on an
// already-stacked bar/area) only stacks when the spec *explicitly* sets
// `stack` on its own value channel -- there's no Vega-Lite convention for
// auto-stacking these, but an explicit `stack` still needs to be honored
// (typically so the label lands within its own segment, matching the
// bar/area it's layered over, rather than at the raw unstacked value).
const EXPLICIT_STACK_MARKS = new Set(['text']);

// Returns Plot's own stack function name (`"stackY"`/`"stackX"`) and
// `offset` option, or `null` when this mark/encoding doesn't stack at all.
// `orientation` is `"horizontal"`/`"vertical"` (from `marks.js`'s own
// orientation inference).
export function planStack(markType, encoding, orientation) {
  const implicit = IMPLICIT_STACK_MARKS.has(markType);
  if (!implicit && !EXPLICIT_STACK_MARKS.has(markType)) return null;
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

  // A value channel with its own explicit companion (`y2` on a vertical
  // bar/area) already has an explicit range -- Vega-Lite's own stacking
  // rule excludes exactly this case (e.g. a value range computed by an
  // upstream top-level `stack`/`window` transform, or just a manually
  // authored lo/hi range): automatically stacking on top of it would
  // silently discard that explicit range and substitute a wrong one.
  const companionDef = encoding[`${valueChannel}2`];
  if (companionDef && typeof companionDef === 'object' && typeof companionDef.field === 'string') return null;

  const stackSetting = valueDef.stack;
  if (!implicit && stackSetting === undefined) return null;
  if (stackSetting === false || stackSetting === null) return null;
  const offset = stackSetting === 'normalize' || stackSetting === 'center' ? stackSetting : null;

  return {fn: valueChannel === 'x' ? 'stackX' : 'stackY', offset};
}
