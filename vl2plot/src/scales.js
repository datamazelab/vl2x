// Build the *top-level* Plot scale option object (`Plot.plot({x: {...}, y:
// {...}, color: {...}, ...})`) for one encoding channel's own `scale`
// sub-object -- unlike every other sibling (which has to infer a scale more
// or less from scratch), Observable Plot already infers a correct scale
// type/domain/range from the mark data alone, so this module only ever
// needs to emit an override for a property the spec *explicitly* set that
// Plot wouldn't have picked on its own (an explicit `domain`, a custom
// `range`, a named `scheme`, a non-default scale `type`, reversing the
// scale, or hiding it entirely) -- returning `null` (nothing to override)
// is the common case for a plain, unadorned encoding channel.

import {formatValue} from './literals.js';

// Vega-Lite scale `type` names Plot spells identically -- both borrow this
// vocabulary from d3-scale, so most of it needs no translation at all.
const SCALE_TYPE_PASSTHROUGH = new Set([
  'linear', 'pow', 'sqrt', 'log', 'symlog', 'ordinal', 'point', 'band',
  'threshold', 'quantile', 'quantize', 'sequential', 'diverging', 'identity',
]);

const SCALE_TYPE_MAP = {
  utc: 'utc',
  time: 'time',
  // Vega-Lite's own `"quantize"`/`"quantile"`/`"threshold"` etc. already
  // match Plot's own names (see SCALE_TYPE_PASSTHROUGH above); "point"/
  // "band" (ordinal position) likewise.
};

// Vega-Lite categorical/sequential/diverging scheme names -> Plot's own
// (both ultimately name d3-scale-chromatic interpolators/schemes, so the
// large majority are identical strings already; this only needs entries
// for the handful that are spelled differently).
const SCHEME_MAP = {
  redyellowgreen: 'rdylgn',
  redyellowblue: 'rdylbu',
  blueorange: 'PuOr', // Plot's closest named diverging equivalent
  redblue: 'rdbu',
  redgrey: 'rdgy',
  purplegreen: 'prgn',
  brownbluegreen: 'brbg',
  spectral: 'spectral',
  tableau10: 'tableau10',
  tableau20: 'tableau10', // Plot has no direct 20-color Tableau scheme
};

// D3's old `category20`/`category20b`/`category20c` schemes (Vega-Lite's own
// default categorical schemes at 11-20 domain values) were dropped from
// d3-scale-chromatic years ago and have no Plot-recognized scheme name --
// but their fixed 20-color palettes are a stable, well-known constant, so
// these are threaded through as an explicit literal `range` array instead
// of a `scheme` name (see `mapScheme()` below).
const LEGACY_CATEGORY_RANGES = {
  category20: ['#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896', '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7', '#bcbd22', '#dbdb8d', '#17becf', '#9edae5'],
  category20b: ['#393b79', '#5254a3', '#6b6ecf', '#9c9ede', '#637939', '#8ca252', '#b5cf6b', '#cedb9c', '#8c6d31', '#bd9e39', '#e7ba52', '#e7cb94', '#843c39', '#ad494a', '#d6616b', '#e7969c', '#7b4173', '#a55194', '#ce6dbd', '#de9ed6'],
  category20c: ['#3182bd', '#6baed6', '#9ecae1', '#c6dbef', '#e6550d', '#fd8d3c', '#fdae6b', '#fdd0a2', '#31a354', '#74c476', '#a1d99b', '#c7e9c0', '#756bb1', '#9e9ac8', '#bcbddc', '#dadaeb', '#636363', '#969696', '#bdbdbd', '#d9d9d9'],
};

// Every scheme name Plot itself recognizes (d3-scale-chromatic's own
// categorical/diverging/sequential/cyclical names, lowercased) -- passing
// an unrecognized name through verbatim doesn't fail until the generated
// code actually *executes* Plot.plot() ("unknown ... scheme: ..."), so
// this is checked up front instead.
const PLOT_KNOWN_SCHEMES = new Set([
  // categorical
  'accent', 'category10', 'dark2', 'observable10', 'paired', 'pastel1', 'pastel2', 'set1', 'set2', 'set3', 'tableau10',
  // diverging
  'brbg', 'prgn', 'piyg', 'puor', 'rdbu', 'rdgy', 'rdylbu', 'rdylgn', 'spectral', 'burd', 'buylrd',
  // sequential, single-hue
  'blues', 'greens', 'greys', 'oranges', 'purples', 'reds',
  // sequential, multi-hue
  'turbo', 'viridis', 'magma', 'inferno', 'plasma', 'cividis', 'warm', 'cool', 'cubehelixdefault',
  'bugn', 'bupu', 'gnbu', 'orrd', 'pubu', 'pubugn', 'purd', 'rdpu', 'ylgn', 'ylgnbu', 'ylorbr', 'ylorrd',
  // cyclical
  'rainbow', 'sinebow',
]);

// Returns `{scheme}` or `{range}` (mutually exclusive, ready to spread into
// the caller's `out` options object) for a Vega-Lite scheme name/object.
// `ignoreUnsupported` governs what happens for a scheme name neither this
// project nor Plot itself recognizes: dropped silently (falls back to
// Plot's own default scheme) in best-effort mode, or a clear "Unsupported:
// ..." in strict mode -- either way, no more letting Plot's own runtime
// error surface as an unexplained crash.
function mapScheme(scheme, ignoreUnsupported) {
  const name = typeof scheme === 'object' ? scheme.name : scheme;
  if (typeof name !== 'string') return {};
  const lower = name.toLowerCase();
  if (LEGACY_CATEGORY_RANGES[lower]) return {range: LEGACY_CATEGORY_RANGES[lower]};
  const mapped = SCHEME_MAP[lower] || lower;
  if (PLOT_KNOWN_SCHEMES.has(mapped)) return {scheme: mapped};
  if (ignoreUnsupported) return {};
  throw new Error(`Unsupported: color scheme "${name}" is not recognized by Plot`);
}

function mapScaleType(type) {
  if (SCALE_TYPE_PASSTHROUGH.has(type)) return type;
  return SCALE_TYPE_MAP[type] || null;
}

// `def` is the Vega-Lite encoding channel definition (its own `scale`
// sub-object, `sort`, and `type` are all consulted). `ctx.channel` (Plot's
// own top-level scale key: "x"/"y"/"color"/"opacity"/"r"/"symbol") and
// `ctx.markType` are consulted only to suppress a `type` override Plot
// would reject outright for that specific mark/channel pairing (see the
// `point`-on-a-bar-category-axis comment below). Returns a plain JS object
// (not yet stringified) of Plot scale options to merge in, or `null` when
// there's nothing to override.
export function buildScaleOptions(def, ctx = {}) {
  if (!def || typeof def !== 'object') return null;
  const scale = def.scale;
  const out = {};

  if (scale && typeof scale === 'object') {
    if (scale.type) {
      // Vega-Lite tolerates (and silently ignores) a `"point"` scale-type
      // override on a bar/tick mark's own category axis -- real Vega
      // itself always needs a `band` scale there for a mark with width, so
      // an explicit `"point"` override would only conflict with Plot's own
      // hard requirement. Every other mark/channel/type combination passes
      // through unchanged.
      const isBarCategoryAxis = (ctx.markType === 'bar' || ctx.markType === 'tick') && (ctx.channel === 'x' || ctx.channel === 'y');
      if (!(isBarCategoryAxis && scale.type === 'point')) {
        const mapped = mapScaleType(scale.type);
        if (mapped) out.type = mapped;
      }
    }
    if (Array.isArray(scale.domain)) out.domain = scale.domain;
    if (Array.isArray(scale.range)) out.range = scale.range;
    if (scale.scheme) {
      Object.assign(out, mapScheme(scale.scheme, ctx.ignoreUnsupported));
    }
    if (scale.reverse === true) out.reverse = true;
    if (scale.domainMid !== undefined) out.domainMid = scale.domainMid;
    // `nice: false` -- Vega-Lite's own default is `nice: true` for a
    // continuous scale, which Plot's own default already matches, so only
    // an explicit `false` needs to be threaded through.
    if (scale.nice === false) out.nice = false;
  }

  // `sort: "descending"`/an explicit array -- meaningful for an ordinal
  // position/color channel's own domain order. `sort: null` (Vega-Lite's
  // own "keep the data's natural order" request) is handled by
  // `prepare.js` at the data-array level instead (Plot's own ordinal scale
  // always sorts its inferred domain, so a `null` sort needs an *explicit*
  // domain array threaded through here to actually preserve row order --
  // see `prepare.js`'s own `explicitOrdinalDomainExpr()`).
  if (def.sort === 'descending') out.reverse = true;
  else if (Array.isArray(def.sort)) out.domain = def.sort;

  if (def.axis === null || def.axis === false) out.axis = null;
  if (def.legend === null || def.legend === false) out.legend = null;

  return Object.keys(out).length ? out : null;
}

// Renders a `{x: {...}, y: {...}, ...}` fragment (as JS source, ready to
// merge into `Plot.plot({...})`'s own top-level options object) from a map
// of Plot scale-channel-name -> options-object (as produced by
// `buildScaleOptions()` above, already filtered to non-null entries by the
// caller).
export function renderScaleBlock(scaleOptionsByChannel, indent = 1) {
  const pad = '  '.repeat(indent);
  const lines = Object.entries(scaleOptionsByChannel).map(
    ([channel, opts]) => `${pad}${channel}: ${formatValue(opts, indent)},`
  );
  return lines;
}
