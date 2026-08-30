// Vega-Lite implicitly stacks a `bar`/`area` mark's own value channel
// whenever it's grouped by ANYTHING else that could put more than one row
// at the same category position -- not just a `color`/`detail` channel
// (this project's own earlier, incomplete understanding), but the mark's
// own CATEGORY position channel too, regardless of whether a color/detail
// channel is present at all. Confirmed against the real compiler's own
// output for bar_qq_stack.vl.json (`x`/`y` both quantitative, no color at
// all, two rows sharing the same `x: "a"` value): its own generated
// `"stack"` transform still has `groupby: ["a"]` -- Vega-Lite always
// implicitly stacks a bar/area's own value channel, grouped by every
// OTHER channel that distinguishes rows, whether that's color/detail or
// just the category position itself. Plot already has this exact
// behavior built into `Plot.stackY`/`Plot.stackX` (confirmed empirically:
// `Plot.stackY({x: "a", y: "b"})`, no color/detail channel at all, still
// groups and stacks by `x`'s own value), including Vega-Lite's own three
// offset modes (`Plot.stackY({offset: "normalize"|"center"}, ...)`,
// default zero otherwise), so this module only ever needs to decide
// *whether* to wrap a mark's own options in one of those two transform
// functions at all -- no hand-computed cumulative sum, and no groupby key
// of its own to compute, since Plot's own transform already groups by
// every field-valued channel in the same options object automatically.
//
// For the ordinary "one row per category" case (by far the most common
// shape in practice) this is a complete no-op -- each category's own
// group has exactly one row, so "stacking" it trivially reduces to
// `[0, value]`, identical to not stacking at all -- so always applying it
// (once the mark/value-channel qualifies at all) is safe, not just
// correct for the genuinely-repeated-category case.

// Auto-stacked whenever this mark type qualifies at all -- Vega-Lite's own
// implicit-stacking convention for these two mark types specifically (no
// color/detail channel required, see the module docstring above).
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
