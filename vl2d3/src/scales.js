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

// Vega-Lite's `scale.domain` is usually a plain array, but can also be one
// of several special reference forms (`"unionWith"`, a `DateTime` object
// domain, a `"param"`-driven domain, `"domainMin"/"domainMax"` siblings,
// ...). Only the plain-array form is supported; anything else throws
// rather than being silently (and incorrectly) treated as a literal array.
function explicitDomainCode(def, ignoreUnsupported = false) {
  const domain = def.scale && def.scale.domain;
  if (domain === undefined) return null;
  if (!Array.isArray(domain)) {
    // Falling back to `null` here means the caller's own `?? domainFromData(...)`
    // auto-computes a domain from the data instead -- already the normal
    // path when no explicit domain is given at all.
    if (ignoreUnsupported) return null;
    throw new Error(`Unsupported scale domain form: ${JSON.stringify(domain)} (only a plain array is supported)`);
  }
  return formatValue(domain);
}

// A trailing comment to append to a scale declaration when
// explicitDomainCode() above silently fell back to an auto-computed domain
// -- `null` (no comment) for every other case, including "no domain was
// given at all" (the ordinary, unremarkable path).
function domainFallbackNote(def, ignoreUnsupported) {
  const domain = def.scale && def.scale.domain;
  if (!ignoreUnsupported || domain === undefined || Array.isArray(domain)) return '';
  return ` // vl2d3: unsupported scale domain form ${JSON.stringify(domain)}, using an auto-computed domain instead (--ignore-unsupported)`;
}

function domainFromData(dataVar, field, isTemporal) {
  const acc = `d => d[${JSON.stringify(field)}]`;
  return `d3.extent(${dataVar}, ${acc})`;
}

function zeroDomainFromData(dataVar, field) {
  const acc = `d => d[${JSON.stringify(field)}]`;
  return `[Math.min(0, d3.min(${dataVar}, ${acc})), Math.max(0, d3.max(${dataVar}, ${acc}))]`;
}

function ordinalDomainFromData(dataVar, field, sort) {
  const acc = `d => d[${JSON.stringify(field)}]`;
  const base = `Array.from(new Set(${dataVar}.map(${acc})))`;
  if (sort === 'descending') return `${base}.sort((a, b) => d3.descending(a, b))`;
  if (sort === null || sort === false) return base;
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
  const base = `Array.from(new Set(${valuesExpr}))`;
  if (sort === 'descending') return `${base}.sort((a, b) => d3.descending(a, b))`;
  if (sort === null || sort === false) return base;
  return `${base}.sort((a, b) => d3.ascending(a, b))`;
}

// Resolve the position scale for `x` or `y`. `zeroBaseline` should be true
// when this is the "value" axis of a bar/area mark (Vega-Lite's default of
// including zero in that case).
export function resolvePositionScale(channel, def, {dataVar, rangeExpr, zeroBaseline, ignoreUnsupported = false, combinedValuesExpr = null}) {
  const varName = channel;
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const scaleType = def.scale && def.scale.type;

  if (def.type === 'temporal') {
    const domain = explicitDomain ?? (combinedValuesExpr ? extentDomain(combinedValuesExpr) : domainFromData(dataVar, field));
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
  return {
    varName,
    decl: `const ${varName} = d3.${ctor}(${domain}, ${rangeExpr})${nice};${domainNote}`,
    kind: 'continuous',
  };
}

export function resolveColorScale(def, {dataVar, ignoreUnsupported = false}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const scheme = def.scale && def.scale.scheme;

  if (def.type === 'quantitative' || def.type === 'temporal') {
    const domain = explicitDomain ?? domainFromData(dataVar, field);
    const interp = SCHEME_SEQUENTIAL[scheme] || 'interpolateBlues';
    return {
      varName: 'color',
      decl: `const color = d3.scaleSequential(${domain}, d3.${interp});${domainNote}`,
      kind: 'sequential',
    };
  }
  const domain = explicitDomain ?? ordinalDomainFromData(dataVar, field, def.sort);
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : `d3.${SCHEME_ORDINAL[scheme] || 'schemeTableau10'}`;
  return {
    varName: 'color',
    decl: `const color = d3.scaleOrdinal(${domain}, ${range});${domainNote}`,
    kind: 'ordinal',
  };
}

export function resolveSizeScale(def, {dataVar, ignoreUnsupported = false}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const domain = explicitDomain ?? domainFromData(dataVar, field);
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : '[2, 20]';
  return {
    varName: 'size',
    decl: `const size = d3.scaleSqrt(${domain}, ${range});${domainNote}`,
    kind: 'continuous',
  };
}

export function resolveOpacityScale(def, {dataVar, ignoreUnsupported = false}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def, ignoreUnsupported);
  const domainNote = domainFallbackNote(def, ignoreUnsupported);
  const domain = explicitDomain ?? domainFromData(dataVar, field);
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : '[0.1, 1]';
  return {
    varName: 'opacity',
    decl: `const opacity = d3.scaleLinear(${domain}, ${range});${domainNote}`,
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
