// Resolve a Vega-Lite encoding channel definition (already rewritten by
// prepare.js so `aggregate`/`bin`/`timeUnit` are gone and `field` just names
// a plain column) into a D3 scale declaration.

import {formatValue} from './literals.js';

const SCHEME_ORDINAL = {
  tableau10: 'schemeTableau10',
  category10: 'schemeCategory10',
  accent: 'schemeAccent',
  dark2: 'schemeDark2',
  paired: 'schemePaired',
  set1: 'schemeSet1',
  set2: 'schemeSet2',
  set3: 'schemeSet3',
};

const SCHEME_SEQUENTIAL = {
  blues: 'interpolateBlues',
  greens: 'interpolateGreens',
  greys: 'interpolateGreys',
  oranges: 'interpolateOranges',
  purples: 'interpolatePurples',
  reds: 'interpolateReds',
  viridis: 'interpolateViridis',
  inferno: 'interpolateInferno',
  magma: 'interpolateMagma',
  plasma: 'interpolatePlasma',
  turbo: 'interpolateTurbo',
  warm: 'interpolateWarm',
  cool: 'interpolateCool',
  rainbow: 'interpolateRainbow',
};

// Vega-Lite's own "DateTime object" shorthand for a literal temporal
// constant (e.g. `{"hours": 0}`), as opposed to a real field reference --
// duplicated from marks.js's identical helper (kept local rather than
// imported to avoid a cross-module dependency for two small functions).
function isDateTimeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function datumToJsExpr(datum) {
  if (!isDateTimeObject(datum)) return formatValue(datum);
  const {year = 2012, quarter, month = 1, date = 1, hours = 0, minutes = 0, seconds = 0, milliseconds = 0} = datum;
  const monthIndex = quarter !== undefined ? (quarter - 1) * 3 : month - 1;
  return `new Date(${year}, ${monthIndex}, ${date}, ${hours}, ${minutes}, ${seconds}, ${milliseconds})`;
}

// Vega-Lite's `scale.domain` is usually a plain array, but can also be one
// of several special reference forms (`"unionWith"`, a `DateTime` object
// domain, a `"param"`-driven domain, `"domainMin"/"domainMax"` siblings,
// ...). Only the plain-array form is supported; anything else throws
// rather than being silently (and incorrectly) treated as a literal array.
// For a temporal/timeUnit'd channel, each array element may itself be a
// DateTime-object shorthand (e.g. `[{"hours": 0}, {"hours": 24}]`) rather
// than a literal -- formatValue() alone would serialize that as a plain JS
// object, meaningless as a time scale's domain, so those elements go
// through the same datum->Date conversion a `datum`-bound channel value
// uses instead.
function explicitDomainCode(def, ignoreUnsupported = false) {
  const domain = def.scale && def.scale.domain;
  if (domain === undefined) return null;
  // A facet template function's own color/size/opacity scale can't compute
  // its domain from its own (per-panel-only) data var -- see
  // buildRuntimeFacetPanels() in translator.js, which threads in a domain
  // already computed from the full, unsplit facet data as an extra
  // parameter and marks it this way rather than as a literal array.
  if (domain && typeof domain === 'object' && !Array.isArray(domain) && typeof domain.__vl2dRawExpr === 'string') {
    return domain.__vl2dRawExpr;
  }
  if (!Array.isArray(domain)) {
    // Falling back to `null` here means the caller's own `?? domainFromData(...)`
    // auto-computes a domain from the data instead -- already the normal
    // path when no explicit domain is given at all.
    if (ignoreUnsupported) return null;
    throw new Error(`Unsupported scale domain form: ${JSON.stringify(domain)} (only a plain array is supported)`);
  }
  if ((def.type === 'temporal' || def.timeUnit) && domain.some(isDateTimeObject)) {
    return `[${domain.map(datumToJsExpr).join(', ')}]`;
  }
  return formatValue(domain);
}

// A trailing comment to append to a scale declaration when
// explicitDomainCode() above silently fell back to an auto-computed domain
// -- `null` (no comment) for every other case, including "no domain was
// given at all" (the ordinary, unremarkable path).
function domainFallbackNote(def, ignoreUnsupported) {
  const domain = def.scale && def.scale.domain;
  if (domain && typeof domain === 'object' && !Array.isArray(domain) && typeof domain.__vl2dRawExpr === 'string') return '';
  if (!ignoreUnsupported || domain === undefined || Array.isArray(domain)) return '';
  return ` // vl2d3: unsupported scale domain form ${JSON.stringify(domain)}, using an auto-computed domain instead (--ignore-unsupported)`;
}

function domainFromData(dataVar, field, isTemporal) {
  const acc = `d => d[${JSON.stringify(field)}]`;
  return `d3.extent(${dataVar}, ${acc})`;
}

// A temporal field used as a bar/area mark's own category axis (e.g. one
// bar per binned year-month, dodged by another field) with no explicit
// x2/y2 range of its own: a plain `d3.extent()` domain puts the very first
// and last distinct dates exactly at the domain's edges, so a bar centered
// on either of those (this file's own bar-width estimate straddles the
// scaled position by half a step either way) hangs off the plot's edge and
// gets clipped. Vega-Lite avoids this by treating a discretized temporal
// field as a real band-like axis; the closest equivalent here (still a
// continuous scaleTime, so existing per-mark bar-width math keeps working
// unchanged) is padding the domain by half the (uniform) step on each side.
function paddedTemporalDomainFromData(dataVar, field) {
  return (
    `(() => { const xs = Array.from(new Set(${dataVar}.map(d => +d[${JSON.stringify(field)}]))).sort((a, b) => a - b); ` +
    `const step = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) : 0; ` +
    `return [new Date(xs[0] - step / 2), new Date(xs[xs.length - 1] + step / 2)]; })()`
  );
}

function paddedTemporalDomain(valuesExpr) {
  return (
    `(() => { const xs = Array.from(new Set((${valuesExpr}).map(v => +v))).sort((a, b) => a - b); ` +
    `const step = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) : 0; ` +
    `return [new Date(xs[0] - step / 2), new Date(xs[xs.length - 1] + step / 2)]; })()`
  );
}

function zeroDomainFromData(dataVar, field) {
  const acc = `d => d[${JSON.stringify(field)}]`;
  return `[Math.min(0, d3.min(${dataVar}, ${acc})), Math.max(0, d3.max(${dataVar}, ${acc}))]`;
}

// An explicit sort array is commonly *partial* -- Vega-Lite still shows
// every distinct value, appending whichever ones aren't named (in
// ascending order) after the named ones, rather than dropping them. Since
// the full set of distinct values isn't known until the data has loaded,
// this is computed at runtime: the named values (that actually occur in
// the data) in their given order, followed by the rest sorted ascending.
function sortArrayDomainExpr(base, sort) {
  const sortJson = JSON.stringify(sort);
  return (
    `(() => { const vals = ${base}; const named = ${sortJson}.filter(v => vals.includes(v)); ` +
    `const rest = vals.filter(v => !${sortJson}.includes(v)).sort((a, b) => d3.ascending(a, b)); ` +
    `return [...named, ...rest]; })()`
  );
}

function ordinalDomainFromData(dataVar, field, sort) {
  const acc = `d => d[${JSON.stringify(field)}]`;
  // `d3.InternSet` (not the built-in `Set`) so a Date-valued ordinal domain
  // (a cyclic-timeUnit channel, e.g. line_quarter_legend.vl.json's `color:
  // {timeUnit: "quarter", ...}` -- see prepare.js's timeUnitFieldType())
  // still dedupes by real value (InternSet keys off `.valueOf()`) instead
  // of by object reference, which a plain `Set` would treat as all-distinct
  // even for two rows sharing the exact same quarter -- string/number
  // domains behave identically either way.
  const base = `Array.from(new d3.InternSet(${dataVar}.map(${acc})))`;
  if (sort === 'descending') return `${base}.sort((a, b) => d3.descending(a, b))`;
  if (sort === null || sort === false) return base;
  if (Array.isArray(sort)) return sortArrayDomainExpr(base, sort);
  return `${base}.sort((a, b) => d3.ascending(a, b))`;
}

// Same three domain shapes as above, but over an already-flat array of
// values (`valuesExpr`, e.g. a `[].concat(...)` combining each layer's own
// field lookup individually) rather than a single (dataVar, field) pair --
// needed when a shared scale's channel is declared with a *different*
// source field per layer (e.g. a reference-band layer's `x: {field:
// "start"}` sharing an axis with the main series' `x: {field: "year"}`):
// one common field name applied uniformly across every layer's rows would
// silently find nothing (`undefined`) for every layer except whichever one
// happened to supply that exact field name, extent-ing over only that
// layer's own range instead of the true union.
function extentDomain(valuesExpr) {
  return `d3.extent(${valuesExpr})`;
}

function zeroExtentDomain(valuesExpr) {
  return `[Math.min(0, d3.min(${valuesExpr})), Math.max(0, d3.max(${valuesExpr}))]`;
}

function ordinalExtentDomain(valuesExpr, sort) {
  const base = `Array.from(new d3.InternSet(${valuesExpr}))`;
  if (sort === 'descending') return `${base}.sort((a, b) => d3.descending(a, b))`;
  if (sort === null || sort === false) return base;
  if (Array.isArray(sort)) return sortArrayDomainExpr(base, sort);
  return `${base}.sort((a, b) => d3.ascending(a, b))`;
}

// Resolve the position scale for `x` or `y`. `zeroBaseline` should be true
// when this is the "value" axis of a bar/area mark (Vega-Lite's default of
// including zero in that case).
export function resolvePositionScale(channel, def, {dataVar, rangeExpr, zeroBaseline, ignoreUnsupported = false, combinedValuesExpr = null, categoryPadding = false}) {
  const varName = channel;
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const scaleType = def.scale && def.scale.type;

  if (def.type === 'temporal') {
    const domain =
      explicitDomain ??
      (categoryPadding
        ? combinedValuesExpr
          ? paddedTemporalDomain(combinedValuesExpr)
          : paddedTemporalDomainFromData(dataVar, field)
        : combinedValuesExpr
          ? extentDomain(combinedValuesExpr)
          : domainFromData(dataVar, field));
    return {
      varName,
      decl: `const ${varName} = d3.scaleTime(${domain}, ${rangeExpr});${domainNote}`,
      kind: 'continuous',
    };
  }

  if (def.type === 'ordinal' || def.type === 'nominal') {
    const domain = explicitDomain ?? (combinedValuesExpr ? ordinalExtentDomain(combinedValuesExpr, def.sort) : ordinalDomainFromData(dataVar, field, def.sort));
    const isBand = scaleType !== 'point';
    const ctor = isBand ? 'scaleBand' : 'scalePoint';
    const padding = isBand ? '.padding(0.1)' : '.padding(0.5)';
    return {
      varName,
      decl: `const ${varName} = d3.${ctor}(${domain}, ${rangeExpr})${padding};${domainNote}`,
      kind: isBand ? 'band' : 'point',
    };
  }

  // No explicit type given, and (since prepare.js always fills in `type`
  // for any aggregate/bin/timeUnit-derived channel by this point) no
  // aggregate/bin/timeUnit either -- a bare `{field: "..."}` -- and no
  // `scale.type` either (a scale type like "log"/"pow" would only make
  // sense for a quantitative field, a strong enough hint to treat it as
  // quantitative below instead of ambiguous). Real Vega-Lite resolves this
  // by inspecting the actual loaded data (a string column -> nominal, a
  // numeric column -> quantitative); this translator can't do that at
  // code-generation time (the data isn't fetched yet), so -- unless
  // `ignoreUnsupported` is off, in which case this fails clearly rather
  // than silently guessing "quantitative", which is wrong whenever the
  // field turns out to hold strings (the common case: an unlabeled
  // categorical column) -- the generated code itself performs the check
  // once the data has actually loaded, picking a banded or continuous scale
  // accordingly.
  if (!def.type && !scaleType) {
    if (!ignoreUnsupported) {
      throw new Error(
        `Unsupported: field "${field}" has no explicit "type" and none can be inferred without the data ` +
          '(add an explicit "type" to this encoding channel)'
      );
    }
    const isNominalVar = `${varName}IsNominal`;
    const fieldJson = JSON.stringify(field);
    const domain = zeroBaseline ? zeroDomainFromData(dataVar, field) : domainFromData(dataVar, field);
    const decl =
      `const ${isNominalVar} = ${dataVar}.some(d => typeof d[${fieldJson}] === "string"); ` +
      `// vl2d3: unsupported ambiguous field type (no "type" given), choosing a band or continuous scale at runtime from the actual data (--ignore-unsupported)\n` +
      `const ${varName} = ${isNominalVar}\n` +
      `  ? d3.scaleBand(Array.from(new Set(${dataVar}.map(d => d[${fieldJson}]))), ${rangeExpr}).padding(0.1)\n` +
      `  : d3.scaleLinear(${domain}, ${rangeExpr}).nice();`;
    return {varName, decl, kind: 'ambiguous', isNominalVar};
  }

  // quantitative (default)
  const domain =
    explicitDomain ??
    (combinedValuesExpr
      ? zeroBaseline
        ? zeroExtentDomain(combinedValuesExpr)
        : extentDomain(combinedValuesExpr)
      : zeroBaseline
        ? zeroDomainFromData(dataVar, field)
        : domainFromData(dataVar, field));
  const ctor = {log: 'scaleLog', pow: 'scalePow', sqrt: 'scaleSqrt', symlog: 'scaleSymlog'}[scaleType] || 'scaleLinear';
  const nice = explicitDomain ? '' : '.nice()';
  // `sort: "descending"` on an aggregated *quantitative* channel isn't a
  // request to reorder rows (there's nothing ordinal to reorder here) --
  // it's Vega-Lite's own documented way to mirror a bar's growth direction,
  // e.g. concat_population_pyramid.vl.json's "Female" panel (`x: {aggregate:
  // "sum", field: "people", sort: "descending"}`) grows its bars right-to-
  // left instead of the default left-to-right, which is what actually forms
  // the pyramid shape when placed next to a normal (left-to-right) "Male"
  // panel. Reversing the *range* (not the domain) achieves that mirroring
  // without touching the zero-baseline math anywhere else that reads this
  // scale.
  const range = def.sort === 'descending' ? `(${rangeExpr}).slice().reverse()` : rangeExpr;
  return {
    varName,
    decl: `const ${varName} = d3.${ctor}(${domain}, ${range})${nice};${domainNote}`,
    kind: 'continuous',
  };
}

// The "auto-computed domain" a color/shape/size/opacity scale would build
// for itself from `dataVar` -- exposed standalone so a facet template
// function (whose own data var only ever holds one panel's rows, see
// buildRuntimeFacetPanels() in translator.js) can compute the SAME domain
// once from the full, unsplit data instead, keeping a consistent
// value->color/shape/size/opacity mapping across every panel. Shape is
// always ordinal (a fixed array of symbol types, never a continuous
// interpolation), same as color's own non-quantitative/temporal case --
// matters most exactly when the facet's own row/column field *is* the
// shape field too (e.g. trellis_row_column.vl.json's `column: {field:
// "Origin"}` alongside `shape: {field: "Origin"}`): every panel's own data
// then has only ONE distinct Origin value, which an unshared domain would
// map to the same first symbol type in every column regardless of which
// Origin it actually is.
export function sharedChannelDomainExpr(channel, def, dataVar) {
  if ((channel === 'color' || channel === 'shape') && def.type !== 'quantitative' && def.type !== 'temporal') {
    return ordinalDomainFromData(dataVar, def.field, def.sort);
  }
  return domainFromData(dataVar, def.field);
}

// `config.scale.invalid.<channel>.value` (e.g. bar_invalid_color_show_override.vl.json's
// own `{"color": {"value": "red"}}`) overrides what a null/invalid raw
// value maps to for this channel, *instead of* whatever the real scale
// would otherwise produce for it -- only reachable at all when
// `config.mark.invalid` is "show" (this project's usual "filter" default
// drops that row entirely, long before any scale ever sees it). Wrapping
// the constructor here, in one place, means every caller elsewhere in this
// project that already just calls `color(v)`/`size(v)`/`opacity(v)`
// benefits automatically, with no changes needed at any of those call sites.
function scaleDecl(varName, scaleExpr, domainNote, invalidOverride) {
  if (invalidOverride === undefined) {
    return `const ${varName} = ${scaleExpr};${domainNote}`;
  }
  // `Object.assign` (not a bare arrow function) so the wrapper keeps every
  // one of the real scale's own methods too (`.domain()`, `.range()`, ...) --
  // this project's own legend code, e.g., still calls `color.domain()`
  // directly, which a plain `v => ...` replacement would have no such
  // method for at all.
  return (
    `const ${varName} = (() => { const __scale = ${scaleExpr}; ` +
    `return Object.assign(v => (v == null ? ${formatValue(invalidOverride)} : __scale(v)), __scale); })();${domainNote}`
  );
}

const DISCRETIZING_SCALE_CTORS = {quantize: 'scaleQuantize', quantile: 'scaleQuantile', threshold: 'scaleThreshold'};

// Vega-Lite's "discretizing" scale types (quantize/quantile/threshold) --
// each buckets a continuous domain into a *fixed, small* set of discrete
// output values, unlike the smoothly-interpolating scaleSequential/
// scaleSqrt/scaleLinear this project otherwise builds for a quantitative
// channel. Not just a cosmetic difference: passing one of these scale
// types' own `range` straight through to scaleSqrt/scaleLinear (as if it
// were an ordinary 2-endpoint continuous range) is actively wrong whenever
// `range` has more than 2 stops (e.g. concat_bar_scales_discretize.vl
// .json's own `size: {scale: {type: "quantile", range: [80, 160, 240,
// 320, 400]}}` -- scaleSqrt/scaleLinear DO accept a multi-stop range, but
// interpret it as smooth piecewise interpolation across the *whole* domain
// rather than quantile bucketing, so a `b` value anywhere in the upper
// part of its own range gets sqrt-mapped near that trailing 400 -- a
// circle 400px in radius, not a modest discrete size step). Returns null
// for any other (or absent) scale type, so callers fall through to their
// own existing continuous-scale branch unchanged.
function discretizingScaleExpr(def, dataVar, {defaultRange, interpolator} = {}) {
  const scaleType = def.scale && def.scale.type;
  const ctor = DISCRETIZING_SCALE_CTORS[scaleType];
  if (!ctor) return null;
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, true);
  let domain;
  if (scaleType === 'quantile') {
    // scaleQuantile's own "domain" is the full sample of raw values (used
    // to compute equal-COUNT quantile break points from their actual
    // distribution), not a plain [min, max] pair the way every other
    // scale here takes it.
    domain = explicitDomain ?? `${dataVar}.map(d => d[${JSON.stringify(field)}])`;
  } else if (scaleType === 'threshold') {
    // No sensible auto-computed default exists for a threshold scale's
    // own break points (that's the whole point of giving them explicitly);
    // an empty array degrades to "every value maps to the first range
    // entry" rather than crashing outright.
    domain = explicitDomain ?? '[]';
  } else {
    domain = explicitDomain ?? domainFromData(dataVar, field);
  }
  let range;
  if (def.scale.range) {
    range = formatValue(def.scale.range);
  } else if (interpolator) {
    // No explicit range -- sample 4 discrete stops from the named
    // interpolator instead (Vega-Lite's own default class count for a
    // scheme-only discretizing scale).
    const scheme = def.scale.scheme && SCHEME_SEQUENTIAL[def.scale.scheme];
    range = `d3.quantize(d3.${scheme || interpolator}, 4)`;
  } else {
    range = defaultRange;
  }
  return `d3.${ctor}(${domain}, ${range})`;
}

export function resolveColorScale(def, {dataVar, ignoreUnsupported = false, invalidOverride} = {}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const scheme = def.scale && def.scale.scheme;

  if (def.type === 'quantitative' || def.type === 'temporal') {
    const discretized = discretizingScaleExpr(def, dataVar, {interpolator: 'interpolateBlues'});
    if (discretized) {
      return {varName: 'color', decl: scaleDecl('color', discretized, domainNote, invalidOverride), kind: 'discretizing'};
    }
    const domain = explicitDomain ?? domainFromData(dataVar, field);
    const interp = SCHEME_SEQUENTIAL[scheme] || 'interpolateBlues';
    return {
      varName: 'color',
      decl: scaleDecl('color', `d3.scaleSequential(${domain}, d3.${interp})`, domainNote, invalidOverride),
      kind: 'sequential',
    };
  }
  const domain = explicitDomain ?? ordinalDomainFromData(dataVar, field, def.sort);
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : `d3.${SCHEME_ORDINAL[scheme] || 'schemeTableau10'}`;
  return {
    varName: 'color',
    decl: scaleDecl('color', `d3.scaleOrdinal(${domain}, ${range})`, domainNote, invalidOverride),
    kind: 'ordinal',
  };
}

// Vega-Lite's own default shape palette, in order -- an ordinal scale maps
// each distinct value of the `shape` field onto one of these, the same way
// `color` maps onto a color palette. d3-shape's built-in symbol types don't
// cover every Vega-Lite shape name 1:1 (no separate down/left/right-facing
// triangle, no "arrow"/"wedge"/"triangle" aliases) -- close visual
// equivalents stand in for those.
const SHAPE_SYMBOLS = [
  'd3.symbolCircle',
  'd3.symbolSquare',
  'd3.symbolCross',
  'd3.symbolDiamond',
  'd3.symbolTriangle',
  'd3.symbolTriangle2',
  'd3.symbolStar',
  'd3.symbolWye',
];

export function resolveShapeScale(def, {dataVar, ignoreUnsupported = false}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const domain = explicitDomain ?? ordinalDomainFromData(dataVar, field, def.sort);
  // An explicit `scale.range` overrides the default symbol palette -- most
  // often a set of literal SVG path strings per category (e.g.
  // isotype_bar_chart.vl.json's own person/cattle/pig/sheep silhouettes),
  // Vega-Lite's own "custom path shape" convention. `isRawPaths` (detected
  // by every range value starting with an SVG path's own "M"/"m" moveto
  // command) tells renderPoint (marks.js) to use each row's own resolved
  // value directly as the mark's `d` attribute instead of running it
  // through d3.symbol() (which only knows its own fixed built-in symbol
  // *types*, not an arbitrary path string).
  const explicitRange = def.scale && Array.isArray(def.scale.range) ? def.scale.range : null;
  const isRawPaths = Boolean(explicitRange) && explicitRange.every(v => typeof v === 'string' && /^\s*[Mm]/.test(v));
  const rangeExpr = explicitRange ? formatValue(explicitRange) : `[${SHAPE_SYMBOLS.join(', ')}]`;
  return {
    varName: 'shape',
    decl: `const shape = d3.scaleOrdinal(${domain}, ${rangeExpr});${domainNote}`,
    kind: 'ordinal',
    isRawPaths,
  };
}

export function resolveSizeScale(def, {dataVar, ignoreUnsupported = false, invalidOverride} = {}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const discretized = discretizingScaleExpr(def, dataVar, {defaultRange: '[2, 20]'});
  if (discretized) {
    return {varName: 'size', decl: scaleDecl('size', discretized, domainNote, invalidOverride), kind: 'discretizing'};
  }
  const domain = explicitDomain ?? domainFromData(dataVar, field);
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : '[2, 20]';
  return {
    varName: 'size',
    decl: scaleDecl('size', `d3.scaleSqrt(${domain}, ${range})`, domainNote, invalidOverride),
    kind: 'continuous',
  };
}

// An "arc" mark's own `radius` encoding (e.g. arc_ordinal_theta.vl.json's
// own `radius: {field: "strength", type: "quantitative"}`, a wind-rose
// chart) -- Vega-Lite's own default scale type for radius is "sqrt" (area,
// not length, is what a reader perceives from a wedge's radius, same
// reasoning as the "size" channel's own sqrt default just above), and its
// default range is `[0, <the mark's own full plot radius>]` -- `rangeExpr`
// is that fallback, threaded in by the caller (translator.js, which has
// the `dims` geometry this module otherwise never needs) since it can't be
// a fixed literal the way size's `[2, 20]` is.
export function resolveRadiusScale(def, {dataVar, rangeExpr, ignoreUnsupported = false, invalidOverride} = {}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const domain = explicitDomain ?? zeroDomainFromData(dataVar, field);
  const scaleType = def.scale && def.scale.type;
  const ctor = {linear: 'scaleLinear', pow: 'scalePow', symlog: 'scaleSymlog'}[scaleType] || 'scaleSqrt';
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : `[0, ${rangeExpr}]`;
  return {
    varName: 'radius',
    decl: scaleDecl('radius', `d3.${ctor}(${domain}, ${range})`, domainNote, invalidOverride),
    kind: 'continuous',
  };
}

export function resolveOpacityScale(def, {dataVar, ignoreUnsupported = false, invalidOverride} = {}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const discretized = discretizingScaleExpr(def, dataVar, {defaultRange: '[0.1, 1]'});
  if (discretized) {
    return {varName: 'opacity', decl: scaleDecl('opacity', discretized, domainNote, invalidOverride), kind: 'discretizing'};
  }
  const domain = explicitDomain ?? domainFromData(dataVar, field);
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : '[0.1, 1]';
  return {
    varName: 'opacity',
    decl: scaleDecl('opacity', `d3.scaleLinear(${domain}, ${range})`, domainNote, invalidOverride),
    kind: 'continuous',
  };
}

// A dodged/grouped position offset (`xOffset`/`yOffset`): a sub-band scale
// nested inside the outer position scale's own band, mapping each distinct
// offset-group value to a slice of that band -- the classic D3 "grouped bar
// chart" recipe (an inner scaleBand ranged over `[0, outer.bandwidth()]`).
// The outer position channel must have resolved to a band scale for this to
// mean anything; when it's an "ambiguous" scale (scales.js's runtime
// nominal-vs-quantitative check -- the common case, since a bare
// `{field: "category"}` with no explicit type is what most real xOffset
// specs pair it with), whether the outer scale is *actually* banded isn't
// known until the data has loaded either, so this scale itself becomes
// conditional on that same runtime flag (`null` when the outer scale
// turned out continuous -- callers must handle that, see marks.js).
export function resolveOffsetScale(channel, def, {dataVar, outerScale}) {
  const varName = channel; // "xOffset" or "yOffset"
  const domain = ordinalDomainFromData(dataVar, def.field, def.sort);
  const bandScaleExpr = `d3.scaleBand(${domain}, [0, ${outerScale.varName}.bandwidth()]).padding(0.05)`;
  if (outerScale.kind === 'ambiguous') {
    return {
      varName,
      decl: `const ${varName} = ${outerScale.isNominalVar} ? ${bandScaleExpr} : null;`,
      kind: 'band',
      conditional: true,
    };
  }
  return {
    varName,
    decl: `const ${varName} = ${bandScaleExpr};`,
    kind: 'band',
    conditional: false,
  };
}
